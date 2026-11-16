/**
 * 截图 OCR：把图片变成文字。
 *
 * 后端是 Windows 自带的 Windows.Media.Ocr（不需要联网、不需要 API Key、
 * 不出本机）。真正干活的是常驻的 ocr-helper.ps1 —— 它保持一个进程和一个
 * 预热好的识别引擎，单次识别只要 50~150ms；每次现起 powershell 要 800ms+。
 *
 * 这里只负责三件事：拉起 helper、按协议收发一行 JSON、把失败翻译成人话。
 *
 * 协议细节（含为什么用 Base64 传文本）见 ocr-helper.ps1 顶部注释。
 */

const { spawn } = require("node:child_process");
const { join } = require("node:path");

/** 常驻 OCR 进程的脚本。 */
const HELPER_SCRIPT = join(__dirname, "ocr-helper.ps1");

/** 等 helper 回一句话的上限。首次识别可能因为解码大图慢一点。 */
const REPLY_TIMEOUT_MS = 8000;

/** helper 起不来时，识别请求排队等它 ready 的上限。 */
const READY_TIMEOUT_MS = 12000;

const state = {
  /** @type {import("node:child_process").ChildProcess | undefined} */
  helper: undefined,
  ready: false,
  /** 已安装的识别语言（helper 报上来的）。 */
  langs: /** @type {string[]} */ ([]),
  /** @type {((line: string) => void) | null} */
  reply: null,
  stdoutBuffer: "",
  stderrBuffer: "",
  /** 单次识别的串行闸门：helper 一次只处理一条命令。 */
  queue: Promise.resolve(),
};

/**
 * 拉起常驻 OCR 进程（幂等）。
 *
 * 和 pickup.cjs 的按键器一个套路：App 启动就预热，别等用户第一次按热键
 * 才现拉 —— 那一次会明显慢，而且 WinRT 首次激活本身就慢。
 */
function startHelper() {
  if (state.helper !== undefined && state.helper.exitCode === null) return state.helper;

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER_SCRIPT],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    state.stdoutBuffer += chunk;
    let index = state.stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = state.stdoutBuffer.slice(0, index).trim();
      state.stdoutBuffer = state.stdoutBuffer.slice(index + 1);
      if (line !== "") handleLine(line);
      index = state.stdoutBuffer.indexOf("\n");
    }
  });

  // helper 的 stderr 只用于诊断（比如某个语言包创建引擎失败）。留最近一小段。
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    state.stderrBuffer = (state.stderrBuffer + chunk).slice(-2000);
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
 * 处理 helper 吐回来的一行 JSON。
 * 只有 `ready` 和 `langs` 是主动上报；其余都是对某条命令的回复。
 * @param {string} line
 */
function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // 不是 JSON 就当噪声丢掉
  }

  if (message.kind === "ready") {
    state.ready = true;
    return;
  }
  if (message.kind === "langs") {
    state.langs = Array.isArray(message.langs) ? message.langs.map(String) : [];
    const reply = state.reply;
    state.reply = null;
    reply?.(line);
    return;
  }

  // ocr / unknown / 错误回复
  const reply = state.reply;
  state.reply = null;
  reply?.(line);
}

/**
 * 等 helper 变成 ready（如果还没 ready 就去拉它）。
 * @returns {Promise<boolean>}
 */
function ensureReady() {
  if (state.ready && state.helper !== undefined && state.helper.exitCode === null) {
    return Promise.resolve(true);
  }
  startHelper();
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.ready) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        clearInterval(timer);
        resolve(false);
      }
    }, 40);
  });
}

/**
 * 发一条命令并等回复（只等一行 JSON，解析后返回对象）。
 * @param {string} command
 * @returns {Promise<any>}
 */
function command(commandText) {
  return new Promise((resolve, reject) => {
    const child = state.helper;
    if (child === undefined || child.exitCode !== null) {
      reject(new Error("OCR 引擎没起来"));
      return;
    }
    const timer = setTimeout(() => {
      state.reply = null;
      reject(new Error("OCR 引擎没有回应"));
    }, REPLY_TIMEOUT_MS);

    state.reply = (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("OCR 回复无法解析"));
      }
    };
    child.stdin?.write(commandText + "\n");
  });
}

/**
 * 串行化：helper 一次只处理一条命令，并发发会被打乱配对的回复。
 * @template T @param {() => Promise<T>} task @returns {Promise<T>}
 */
function serialized(task) {
  const run = state.queue.then(task, task);
  // 吞掉链上的异常，避免一次失败让整条队列永久 rejected
  state.queue = run.catch(() => {});
  return run;
}

/**
 * 识别一张图片。
 *
 * 永不抛错：调用方（热键 / 面板）不该被 OCR 细节炸到。失败就把错误码和
 * 人话理由放进返回值。
 *
 * @param {string} imagePath - 本地 png 绝对路径
 * @returns {Promise<{ok: boolean, text: string, lines: number, ms: number, lang: string, reason?: string, detail?: string}>}
 */
async function recognizeFile(imagePath) {
  return serialized(async () => {
    const started = Date.now();
    const ready = await ensureReady();
    if (!ready) {
      return { ok: false, text: "", lines: 0, ms: Date.now() - started, lang: "", reason: "engine-missing", detail: state.stderrBuffer };
    }
    try {
      const reply = await command("ocr " + imagePath);
      if (reply?.ok !== true) {
        return {
          ok: false,
          text: "",
          lines: 0,
          ms: Number(reply?.ms) || Date.now() - started,
          lang: "",
          reason: reply?.error === "no-engine" ? "no-language-pack" : "ocr-failed",
          detail: String(reply?.error ?? ""),
        };
      }
      // 文本是 UTF-8 的 Base64（见 ocr-helper.ps1 顶部为何这样传）
      const text = reply.b64 ? Buffer.from(String(reply.b64), "base64").toString("utf8") : "";
      return {
        ok: true,
        text,
        lines: Number(reply.lines) || 0,
        ms: Number(reply.ms) || Date.now() - started,
        lang: String(reply.lang ?? ""),
      };
    } catch (error) {
      return { ok: false, text: "", lines: 0, ms: Date.now() - started, lang: "", reason: "helper-dead", detail: String(error?.message ?? error) };
    }
  });
}

/**
 * 当前 OCR 能力（面板用来提示「没装英文包」之类的）。
 * @returns {Promise<{ok: boolean, langs: string[]}>}
 */
async function status() {
  const ready = await ensureReady();
  if (!ready) return { ok: false, langs: [] };
  try {
    const reply = await serialized(() => command("langs"));
    const langs = Array.isArray(reply?.langs) ? reply.langs.map(String) : [];
    state.langs = langs;
    return { ok: true, langs };
  } catch {
    return { ok: false, langs: state.langs };
  }
}

/** App 启动时预热 OCR 引擎。 */
function warmUp() {
  try {
    startHelper();
  } catch {
    // 拉不起来就等第一次真正识别时再试
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

module.exports = { recognizeFile, status, warmUp, dispose };
