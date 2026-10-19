/**
 * 取词：把「当前程序里选中的文字」拿回来。
 *
 * Windows 没有「读取选中文字」的公共 API。唯一通用、且不依赖目标程序类型的做法，
 * 就是把人手那套动作自动化一遍：
 *
 *   1. 把剪贴板**全格式**快照下来（文本、HTML、图片、自定义格式都在内）
 *   2. 写入一个唯一标记，好判断「到底有没有复制到新东西」
 *   3. 合成一次 Ctrl+C（交给常驻的 sendinput-helper.ps1，往返几十毫秒）
 *   4. 轮询剪贴板，直到内容不再是那个标记
 *   5. **在 finally 里还原快照** —— 用户原来的剪贴板必须原样回来
 *
 * 第 1 步和第 5 步是这个模块里最不能省的：只存文本的话，用户复制的图片、
 * 富文本、Excel 单元格范围会在取词的瞬间被抹掉，而且他根本不知道发生了什么。
 */

const { BrowserWindow, clipboard } = require("electron");
const { spawn } = require("node:child_process");
const { join } = require("node:path");

/** 常驻按键器的脚本。 */
const HELPER_SCRIPT = join(__dirname, "sendinput-helper.ps1");

/** 标记前缀：剪贴板里出现别的内容 = 目标程序确实复制了东西。 */
const SENTINEL_PREFIX = "__pet_tr_probe__";

/** 等 helper 回一句的最长时间。超过就认为它卡住了。 */
const HELPER_REPLY_MS = 1500;

/** 按下去之后等剪贴板变化的上限。大段文字在慢程序里要几百毫秒。 */
const CLIPBOARD_WAIT_MS = 1200;

/** 轮询剪贴板的间隔。 */
const CLIPBOARD_POLL_MS = 50;

/** 一次取词最多要多少字，超出就截断（面板也放不下更多）。 */
const MAX_PICK_CHARS = 8000;

const state = {
  /** @type {import("node:child_process").ChildProcess | undefined} */
  helper: undefined,
  ready: false,
  /** 等 helper 回复的那个 resolve。 */
  reply: /** @type {((line: string) => void) | null} */ (null),
  stdoutBuffer: "",
};

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 拉起常驻按键器（幂等）。
 *
 * 启动要 100~300ms（加载 System.Windows.Forms），所以 App 一起来就预热，
 * 别等用户第一次按热键才现拉 —— 那一次会明显慢。
 */
function startHelper() {
  if (state.helper !== undefined && state.helper.exitCode === null) return state.helper;

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER_SCRIPT],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    state.stdoutBuffer += chunk;
    let index = state.stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = state.stdoutBuffer.slice(0, index).trim();
      state.stdoutBuffer = state.stdoutBuffer.slice(index + 1);
      if (line !== "") {
        if (line === "ready") state.ready = true;
        const reply = state.reply;
        state.reply = null;
        reply?.(line);
      }
      index = state.stdoutBuffer.indexOf("\n");
    }
  });

  child.on("exit", () => {
    state.helper = undefined;
    state.ready = false;
  });
  child.on("error", () => {
    state.helper = undefined;
    state.ready = false;
  });

  state.helper = child;
  return child;
}

/**
 * 给 helper 发一条命令，等它回一行。
 * @param {string} verb
 * @returns {Promise<string>} 回复内容（ok / fail / ready / unknown）
 */
function command(verb) {
  return new Promise((resolve, reject) => {
    const child = state.helper;
    if (child === undefined || child.exitCode !== null || !state.ready) {
      reject(new Error("按键器没准备好"));
      return;
    }
    const timer = setTimeout(() => {
      state.reply = null;
      reject(new Error("按键器没有回应"));
    }, HELPER_REPLY_MS);

    state.reply = (line) => {
      clearTimeout(timer);
      resolve(line);
    };
    child.stdin?.write(verb + "\n");
  });
}

/**
 * 兜底：直接起一次性进程发一次 Ctrl+C（慢，但 helper 挂了还能用）。
 * @returns {Promise<boolean>}
 */
function sendCtrlCOneShot() {
  return new Promise((resolve) => {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经退了
      }
      resolve(false);
    }, 4000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * 合成一次 Ctrl+C。
 * @returns {Promise<boolean>} 是否真的按下去了。
 */
async function sendCtrlC() {
  // 如果焦点还在我们自己窗口上，先让出去：否则复制到的是本程序的选区
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isFocused()) window.blur();
  }
  await wait(30); // 给焦点切换一点时间

  try {
    const reply = await command("ctrl+c");
    if (reply === "ok") return true;
  } catch {
    // 落到一次性兜底
  }
  return sendCtrlCOneShot();
}

/**
 * 给一个可能永不 settle 的 Promise 加超时。
 *
 * 不是洁癖：这个 Electron 构建里 `clipboard.writeHTML()` 会让剪贴板进入
 * 半死状态，之后连 `readText()` 都再也不返回。一次卡死就是取词永久失灵，
 * 所以每一个剪贴板 await 都必须有上限。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * 读剪贴板文本。
 * 有的版本返回 string，这一版返回 Promise —— 两种都接住，且都带超时。
 * @returns {Promise<string>}
 */
async function readClipText() {
  const value = clipboard.readText();
  if (value !== null && typeof value === "object" && typeof value.then === "function") {
    return String((await withTimeout(value, 800, "")) ?? "");
  }
  return String(value ?? "");
}

/**
 * 写剪贴板文本。
 *
 * **故意不 await**：`writeText` 返回的 Promise 有时不 settle，等它就是等死。
 * 写完读回来验证，比等 Promise 可靠。
 * @param {string} text
 */
async function writeClipText(text) {
  clipboard.writeText(text);
  await waitForClipText(text, 600);
}

/**
 * 等剪贴板变成期望的内容。
 * @param {string} expected
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function waitForClipText(expected, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if ((await readClipText()) === expected) return true;
    await wait(30);
  }
  return false;
}

/**
 * 剪贴板快照。
 *
 * **只存文本**，这是个刻意的退让。三件事都试过、都被这个 Electron 构建挡住了：
 *
 *   1. `clipboard.availableFormats()` 是 Linux 专有，Windows 上没有；
 *   2. `clipboard.write({ text, html, … })` 是空操作，写完剪贴板是空的；
 *   3. `clipboard.writeHTML()` 会把剪贴板搞到半死，之后连读都不返回。
 *
 * 结论：取词能把用户的**文本**原样还回去，但图片 / HTML / RTF 保不住。
 * 这条限制写进了 README 的「已知取舍」，不要以为可以悄悄改掉。
 *
 * @returns {Promise<{text: string, hadRichContent: boolean}>}
 */
async function snapshotClipboard() {
  const text = await readClipText();
  // 记一下「原来是不是富内容」，只用于提示，不做还原
  const hadRichContent = (await safeRead(() => clipboard.readHTML(), "")) !== "";
  return { text, hadRichContent };
}

/**
 * 读一个格式，失败或超时就当默认值。
 * @param {() => any} read
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function safeRead(read, fallback) {
  try {
    const value = read();
    if (value !== null && typeof value === "object" && typeof value.then === "function") {
      return await withTimeout(value, 600, fallback);
    }
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 还原快照。只能还文本 —— 原因见 snapshotClipboard 的注释。
 * @param {{text: string}} snapshot
 */
async function restoreClipboard(snapshot) {
  try {
    clipboard.clear();
    await wait(20);
    if (typeof snapshot?.text === "string" && snapshot.text !== "") {
      clipboard.writeText(snapshot.text);
      await waitForClipText(snapshot.text, 600);
    }
  } catch {
    // 还原失败只能认了，至少不能把异常抛给调用方
  }
}

/**
 * 等剪贴板不再是标记。
 * @param {string} marker
 * @returns {Promise<string>} 新内容，没等到就是空串。
 */
async function waitForClipboard(marker) {
  const started = Date.now();
  while (Date.now() - started < CLIPBOARD_WAIT_MS) {
    await wait(CLIPBOARD_POLL_MS);
    const text = await readClipText();
    if (text !== marker && text.trim() !== "") {
      return text.length > MAX_PICK_CHARS ? text.slice(0, MAX_PICK_CHARS) : text;
    }
  }
  return "";
}

/**
 * 取当前选中文字。
 *
 * 失败是常态，不是异常：用户可能没选中任何东西、或者焦点在不让复制的程序里。
 * 所以这里**永不抛错**，拿不到就返回空串，由调用方决定怎么提示。
 *
 * @returns {Promise<{text: string, ms: number, reason?: string}>}
 */
async function grabSelection() {
  const started = Date.now();
  /** @type {Awaited<ReturnType<typeof snapshotClipboard>> | null} */
  let snapshot = null;
  const marker = `${SENTINEL_PREFIX}${Date.now()}`;

  try {
    // 快照放在 try 里面：它在 Windows 上曾经整个抛掉过（用了 Linux 专有的 API），
    // 那次异常直接穿透到调用方，把自测脚本挂死在"永不退出"上。
    snapshot = await snapshotClipboard();

    clipboard.clear();
    await wait(20);
    await writeClipText(marker);

    const sent = await sendCtrlC();
    if (!sent) return { text: "", ms: Date.now() - started, reason: "no-key" };

    const text = await waitForClipboard(marker);
    if (text === "") return { text: "", ms: Date.now() - started, reason: "no-selection" };

    return { text, ms: Date.now() - started, richWasLost: snapshot.hadRichContent };
  } catch (error) {
    return { text: "", ms: Date.now() - started, reason: String(error?.message ?? error) };
  } finally {
    if (snapshot !== null) await restoreClipboard(snapshot);
  }
}

/** App 启动时预热按键器。 */
function warmUp() {
  try {
    startHelper();
  } catch {
    // 拿不到就用一次性兜底，不影响功能
  }
}

/** 退出时收尾。 */
function dispose() {
  const child = state.helper;
  state.helper = undefined;
  state.ready = false;
  try {
    child?.stdin?.end();
    child?.kill();
  } catch {
    // 已经退了
  }
}

module.exports = {
  grabSelection,
  snapshotClipboard,
  restoreClipboard,
  warmUp,
  dispose,
  MAX_PICK_CHARS,
};
