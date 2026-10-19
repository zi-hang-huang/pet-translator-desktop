/**
 * 翻译球 · 桌面独立版 —— 主进程入口。
 *
 * 进程里只有五件事：一只球窗口、一个托盘、一组 IPC、一个翻译引擎（M2 是占位实现）、
 * 以及将来接全局热键的位置（M4）。
 *
 * 单实例是硬要求：球常驻，重复启动会叠出两只球，两只球还都抢同一个热键。
 */

const { app, clipboard, ipcMain, screen } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const ball = require("./ball-window.cjs");
const panel = require("./panel-window.cjs");
const store = require("./store.cjs");
const tray = require("./tray.cjs");
const hotkey = require("./hotkey.cjs");
const pickup = require("./pickup.cjs");
const autostart = require("./autostart.cjs");
const log = require("./log.cjs");
const stubEngine = require("../engine/stub.cjs");
const webEngine = require("../engine/web-page.cjs");

// 默认走真的网页版引擎；`PET_TR_ENGINE=stub` 退回占位实现（调 UI 时用）
const engine = process.env.PET_TR_ENGINE === "stub" ? stubEngine : webEngine;

/** 单次翻译的字数上限。超过就分段，那是 M3 的事，这里先拒绝。 */
const MAX_SOURCE = 4000;

/** 目标语言。M3 会把「自动」换成真正的语言判定。 */
const TARGETS = [
  { id: "auto", label: "自动" },
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
];

const flags = new Set(process.argv.slice(1));
const SMOKE = flags.has("--smoke");
const DEMO = flags.has("--demo");
/** 取词链路自测：取词 → 等价于点球确认 → 等翻译 → 打事实。 */
const PICKUP_SELFTEST = flags.has("--pickup-selftest");

app.setAppUserModelId("com.pet.translator");

/**
 * 固定 userData 目录。
 *
 * Electron 默认用 `productName`（「翻译球」）当目录名，于是**打包版和开发版
 * 会各用一套 profile**：球的位置忘了、DeepSeek 的登录态也丢了 —— 用户升级一次
 * 就得重新扫码登录，很不讲道理。
 *
 * 这里钉死在开发期那个目录上，两边的设置、窗口位置、DeepSeek 分区共用一套。
 */
app.setPath("userData", join(app.getPath("appData"), "pet-translator-desktop"));

// 打包版没有控制台：把主进程日志同时写进 app.log，出问题时有东西可看。
// 放在 setPath 之后 —— 日志文件必须落在固定下来的那个 userData 里。
log.install();

// 少数显卡/远程桌面上透明窗口会变黑底或黑边。两个开关都认：
//   环境变量 PET_TR_NO_GPU=1（临时排查用）
//   设置里的「关闭硬件加速」（用户自己勾，重启生效）
// 必须在 ready 之前调用，之后调没用。
if (process.env.PET_TR_NO_GPU === "1" || store.read().disableGpu === true) {
  app.disableHardwareAcceleration();
  console.log("[pet-tr] hardware acceleration disabled");
}

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 引擎状态（占位引擎没有 status()）。 */
function engineStatus() {
  if (typeof engine.status === "function") {
    try {
      return engine.status();
    } catch (error) {
      return { status: "bad", detail: String(error?.message ?? error) };
    }
  }
  return { status: "off", detail: "" };
}

/** 把引擎状态推给面板，让状态灯跟着变。 */
function pushEngineStatus() {
  const window = ball.getWindow();
  if (window === undefined || window.isDestroyed()) return;
  window.webContents.send("engine:status", engineStatus());
}

/** 同一时刻只允许一次翻译：并发会让球和面板的状态互相踩。 */
let translating = false;

/** 用户按 Esc 取消翻译。网页后端有时会拖很久，必须能中断。 */
let abortRequested = false;

/** 取词进行中（防止连点开两次）。 */
let picking = false;

/** 往面板窗口推一条消息。 */
function sendToPanel(channel, payload) {
  const window = panel.getWindow();
  if (window === undefined || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/** 打开面板；没记住过位置就摆在球旁边。 */
function openPanel() {
  const snap = ball.snapshot();
  panel.show({ anchored: { circle: snap.circle, ballSize: snap.ballSize } });
}

/** 开合面板。 */
function togglePanel() {
  if (panel.isVisible()) panel.hide();
  else openPanel();
}

/** 往球窗口推一条消息。 */
function sendToBall(channel, payload) {
  const window = ball.getWindow();
  if (window === undefined || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/**
 * 取词 → 直接翻译。热键和点球走同一条路。
 *
 * **都不会打开面板**：面板只能从托盘菜单 / 右键菜单开。左键和热键只做翻译这一件事，
 * 免得"想翻一段"的时候跳出一个面板挡住你要看的东西。取不到选中文字时只红眼抖一下。
 */
async function pickAndTranslate() {
  if (picking) return; // 连按两下别开两次取词
  picking = true;
  ball.setState("listening");
  try {
    const result = await pickup.grabSelection();
    if (result.text === "") {
      console.log(`[pet-tr] pickup failed: ${result.reason ?? "unknown"}`);
      ball.setState("error");
      setTimeout(() => ball.setState("idle"), 1200);
      // 不弹面板：取不到就只抖一下，用户要面板可以走托盘/右键菜单
      return;
    }
    ball.setState("idle");
    console.log(`[pet-tr] picked ${result.text.length} chars in ${result.ms}ms`);
    openPanel();
    sendToPanel("translate:request", { text: result.text });
  } catch (error) {
    console.warn("pet-tr: pickup failed:", String(error));
    ball.setState("error");
    setTimeout(() => ball.setState("idle"), 1200);
  } finally {
    picking = false;
  }
}

/** 热键：取词并直接翻译。 */
async function onHotkey() {
  await pickAndTranslate();
}

/** 把渲染进程的控制台接出来，否则出错时只能看到一片空白窗口。 */
function forwardRendererLogs() {
  const window = ball.getWindow();
  if (window === undefined || window.isDestroyed()) return;
  window.webContents.on("console-message", (...args) => {
    const first = args[0];
    if (first !== null && typeof first === "object" && typeof first.message === "string") {
      console.log(`[renderer:${String(first.level)}] ${first.message}`);
      return;
    }
    console.log(`[renderer:${String(args[1])}] ${String(args[2])}`);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[renderer] did-fail-load ${String(code)} ${description}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] gone: ${JSON.stringify(details)}`);
  });
}

/** 注册渲染进程会用到的全部 IPC。 */
function wireIpc() {
  /* ── 拖动 ─────────────────────────────────────────────────────────── */
  ipcMain.on("ball:drag-start", (_event, point) => {
    ball.dragStart(Number(point?.x ?? 0), Number(point?.y ?? 0));
  });
  ipcMain.on("ball:drag-move", (_event, point) => {
    ball.dragMove(Number(point?.x ?? 0), Number(point?.y ?? 0));
  });
  ipcMain.on("ball:drag-end", () => ball.dragEnd());

  /* ── 缩放 ─────────────────────────────────────────────────────────── */
  ipcMain.on("ball:scale-set", (_event, value) => ball.applyScale(Number(value)));

  /* ── 面板与窗口 ───────────────────────────────────────────────────── */
  ipcMain.on("panel:close", () => panel.hide());
  ipcMain.on("panel:drag-start", (_event, point) => {
    panel.dragStart(Number(point?.x ?? 0), Number(point?.y ?? 0));
  });
  ipcMain.on("panel:drag-move", (_event, point) => {
    panel.dragMove(Number(point?.x ?? 0), Number(point?.y ?? 0));
  });
  ipcMain.on("panel:drag-end", () => panel.dragEnd());
  ipcMain.on("panel:resize", (_event, size) => {
    panel.resize(Number(size?.width), Number(size?.height));
  });
  ipcMain.on("panel:pass-through", (_event, ignore) => panel.setPassThrough(ignore === true));
  ipcMain.on("ball:context-menu", () => ball.showContextMenu());
  ipcMain.on("ball:pass-through", (_event, ignore) => ball.setPassThrough(ignore === true));

  // 单击球：只做一件事 —— 取词并翻译。不开面板、也不收面板
  ipcMain.on("ball:click", () => {
    pickAndTranslate();
  });

  /* ── 翻译 ─────────────────────────────────────────────────────────── */
  ipcMain.handle("engine:translate", async (_event, payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (text === "") return { ok: false, error: "empty-text" };
    if (text.length > MAX_SOURCE) return { ok: false, error: "too-long", limit: MAX_SOURCE };
    if (translating) return { ok: false, error: "busy" };

    translating = true;
    abortRequested = false;
    ball.setState("busy");
    try {
      const result = await engine.translate(text, {
        target: payload?.target,
        shouldAbort: () => abortRequested,
      });
      ball.setState("idle");
      pushEngineStatus();
      return { ok: true, ...result };
    } catch (error) {
      ball.setState("error");
      setTimeout(() => ball.setState("idle"), 1600);
      pushEngineStatus();
      return {
        ok: false,
        error: "engine",
        // 给 UI 判断用的机器可读码：need-login 时面板要引导去登录
        code: error?.code ?? "unknown",
        detail: String(error?.message ?? error),
      };
    } finally {
      translating = false;
    }
  });

  /* ── DeepSeek 网页后端 ─────────────────────────────────────────────── */
  ipcMain.on("engine:abort", () => {
    abortRequested = true;
    console.log("[pet-tr] abort requested by user");
  });

  ipcMain.handle("deepseek:status", () => engineStatus());

  ipcMain.on("deepseek:show", () => {
    engine.showWindow?.();
  });

  ipcMain.handle("deepseek:reset", async () => {
    try {
      await engine.resetConversation?.();
      pushEngineStatus();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: String(error?.message ?? error) };
    }
  });

  /* ── 开机自启 ─────────────────────────────────────────────────────── */
  ipcMain.handle("settings:set-look", (_event, look) => {
    const hex = (value, fallback) =>
      /^#[0-9a-fA-F]{6}$/.test(String(value ?? "")) ? String(value).toLowerCase() : fallback;
    const ballColor = hex(look?.ballColor, "#3a8dff");
    const textColor = hex(look?.textColor, "#e8ecf4");
    store.write({ ballColor, textColor });
    ball.pushLook();
    return { ballColor, textColor };
  });

  ipcMain.handle("settings:set-eyes-follow", (_event, enabled) => {
    store.write({ eyesFollow: enabled === true });
    ball.pushLook();
    return { enabled: enabled === true };
  });

  ipcMain.handle("settings:set-panel-look", (_event, look) => {
    const color = /^#[0-9a-fA-F]{6}$/.test(String(look?.color ?? "")) ? String(look.color) : "#161a22";
    const raw = Number(look?.opacity);
    const opacity = Number.isFinite(raw) ? Math.min(100, Math.max(55, Math.round(raw))) : 100;
    store.write({ panelColor: color, panelOpacity: opacity });
    return { color, opacity };
  });

  ipcMain.handle("settings:set-disable-gpu", (_event, enabled) => {
    store.write({ disableGpu: enabled === true });
    return { enabled: enabled === true, needsRestart: true };
  });

  ipcMain.handle("autostart:status", () => autostart.status());
  ipcMain.handle("autostart:set", (_event, enabled) => autostart.set(enabled === true));

  /* ── 杂项 ─────────────────────────────────────────────────────────── */
  ipcMain.handle("ball:copy", async (_event, text) => {
    // 这个版本的 clipboard 返回 Promise，不 await 的话写失败会静默
    await clipboard.writeText(String(text ?? ""));
    return true;
  });

  ipcMain.handle("ball:info", () => ({
    ...ball.snapshot(),
    min: ball.MIN_SCALE,
    max: ball.MAX_SCALE,
    panel: panel.bodySize(),
    engine: {
      id: engine.id,
      label: engine.label,
      status: engineStatus().status,
      detail: engineStatus().detail,
      footnote: `${engine.label} · ${engine.note ?? ""}`,
    },
    targets: TARGETS,
    maxSource: MAX_SOURCE,
    hotkey: hotkey.status(),
    autostart: autostart.status(),
    panelOpen: panel.isVisible(),
    disableGpu: store.read().disableGpu === true,
    panelColor: store.read().panelColor,
    panelOpacity: store.read().panelOpacity,
    ballColor: store.read().ballColor,
    textColor: store.read().textColor,
    eyesFollow: store.read().eyesFollow === true,
  }));
}

/**
 * 取词自测：先造出一个「选中了文字」的前台程序，再走完整链路。
 *
 *     PET_TR_ENGINE=stub electron . --pickup-selftest
 *
 * 它做的是：等一会儿（让外面把人手该做的准备做好）→ 按热键那条路径
 * （取词 → 直接翻译，一步到位）→ 等翻译 → 打一行 JSON 事实，然后退出。
 *
 * 「用手在别的程序里选中文字」这一步没法无人化，其余全走真实代码路径。
 */
async function runPickupSelftest() {
  const delay = Number(process.env.PET_TR_SELFTEST_DELAY ?? 8000);
  console.log(`[pickup-selftest] waiting ${delay}ms for a selection to exist…`);
  await wait(delay);

  const before = Date.now();
  await onHotkey();
  await wait(Number(process.env.PET_TR_SELFTEST_WAIT ?? 12000));

  const snapshot = ball.snapshot();
  console.log(
    "[pickup-selftest] " +
      JSON.stringify({
        ok: panel.isVisible(),
        ms: Date.now() - before,
        panelOpen: panel.isVisible(),
        ballState: snapshot.ballState,
      }),
  );
  ball.allowClose();
  app.quit();
}

/** 四态轮播，用于肉眼验收动效。 */
function startDemo() {
  const states = ["idle", "listening", "busy", "error"];
  let index = 0;
  setInterval(() => {
    index = (index + 1) % states.length;
    ball.setState(states[index]);
    console.log(`[pet-tr] demo state -> ${states[index]}`);
  }, 1600);
}

/** 冒烟：可选地展开面板/填字翻译/设状态 → 截图 → 打印事实快照 → 退出。 */
async function runSmoke() {
  await wait(1400);
  if (process.env.PET_TR_PANEL === "1") {
    openPanel();
    await wait(700);
  }
  // 切到设置视图（冒烟用）
  if (process.env.PET_TR_VIEW === "settings") {
    const window = panel.getWindow();
    if (window !== undefined && !window.isDestroyed()) {
      await window.webContents.executeJavaScript(
        `document.querySelector('#view-translate [data-action="settings"]').click()`,
      );
      await wait(300);
    }
  }
  // 端到端：把文字塞进输入框并点「翻译」，走的是渲染进程真实的点击路径
  /** @param {string} text */
  const typeAndSend = async (text) => {
    const window = panel.getWindow();
    if (window === undefined || window.isDestroyed()) return;
    await window.webContents.executeJavaScript(`
      (() => {
        const draft = document.getElementById("draft");
        draft.value = ${JSON.stringify(text)};
        draft.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("go").click();
        return draft.value;
      })()
    `);
    await wait(Number(process.env.PET_TR_WAIT_MS ?? 1600));
  };

  const autotype = process.env.PET_TR_AUTOTYPE;
  if (typeof autotype === "string" && autotype !== "") await typeAndSend(autotype);
  // 第二轮：验「连续翻译不串台」
  const autotype2 = process.env.PET_TR_AUTOTYPE2;
  if (typeof autotype2 === "string" && autotype2 !== "") await typeAndSend(autotype2);
  // 取词那一瞬的样子（冒烟截图用）
  if (process.env.PET_TR_ARMED === "1") {
    ball.setState("listening");
    await wait(400);
  }

  const forced = process.env.PET_TR_STATE;
  if (forced === "idle" || forced === "listening" || forced === "busy" || forced === "error") {
    ball.setState(forced);
    await wait(160);
  }
  const shot = process.env.PET_TR_SHOT ?? join(app.getPath("userData"), "smoke.png");
  try {
    const window = ball.getWindow();
    if (window !== undefined && !window.isDestroyed()) {
      const image = await window.webContents.capturePage();
      writeFileSync(shot, image.toPNG());
    }
    // 面板是独立窗口，得单独截一张
    if (panel.isVisible()) {
      const panelWindow = panel.getWindow();
      if (panelWindow !== undefined && !panelWindow.isDestroyed()) {
        const image = await panelWindow.webContents.capturePage();
        writeFileSync(shot.replace(/\.png$/i, "") + "-panel.png", image.toPNG());
      }
    }
  } catch (error) {
    console.warn("[pet-tr] capturePage failed:", String(error));
  }
  console.log(
    "[pet-tr-smoke] " +
      JSON.stringify({
        electron: process.versions.electron,
        tray: tray.exists(),
        settingsPath: store.settingsPath(),
        settings: store.read(),
        ball: ball.snapshot(),
        panel: panel.snapshot(),
        engine: engine.id,
        shot,
      }),
  );
  ball.allowClose();
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    ball.show();
    console.log("[pet-tr] second instance blocked; existing ball shown");
  });

  app.whenReady().then(async () => {
    console.log(`[pet-tr] ready · electron ${process.versions.electron} · engine ${engine.id}`);
    ball.create();
    // 右键菜单和托盘都要能开合面板，但球/托盘模块不该依赖面板模块 —— 用钩子注入
    ball.setPanelHooks({ toggle: togglePanel, isOpen: () => panel.isVisible() });
    tray.setPanelHooks({ togglePanel, panelOpen: () => panel.isVisible() });
    ball.setPinnedHook?.((pinned) => panel.applyPinned(pinned));
    forwardRendererLogs();
    tray.create();
    wireIpc();
    console.log(`[pet-tr] ball at ${JSON.stringify(ball.snapshot().circle)}`);

    // 状态灯每 8 秒对一次：网页后端会自己掉登录，不能只在动作时才更新
    if (typeof engine.status === "function") setInterval(pushEngineStatus, 8000).unref?.();

    // 光标位置：球的眼睛要看向鼠标。只在球可见时推，12.5Hz 足够顺。
    setInterval(() => {
      const window = ball.getWindow();
      if (window === undefined || window.isDestroyed() || !window.isVisible()) return;
      const point = screen.getCursorScreenPoint();
      window.webContents.send("ball:cursor", { x: point.x, y: point.y });
    }, 80);

    // 取词用的按键器现在就预热：它要加载 System.Windows.Forms，第一次要一两百毫秒
    pickup.warmUp();

    // 开机自启：只在打包版里真正写启动项，开发模式只回一句"没应用"
    const autostartState = autostart.apply();
    console.log(
      `[pet-tr] autostart ${autostartState.enabled ? "on" : "off"} · applied=${autostartState.applied}${autostartState.reason ? " · " + autostartState.reason : ""}`,
    );

    // 全局热键。注册失败要能告诉用户，而不是按了没反应
    const accelerator = typeof store.read().hotkey === "string" ? store.read().hotkey : "Control+Alt+T";
    const registered = hotkey.register(accelerator, () => {
      onHotkey().catch((error) => console.warn("pet-tr: pickup failed:", String(error)));
    });
    console.log(`[pet-tr] hotkey ${accelerator} -> ${registered ? "ok" : "REJECTED (已被占用)"}`);
    pushEngineStatus();

    // --deepseek-login：直接把网页窗口摆出来，让人扫码/输手机号
    if (flags.has("--deepseek-login")) engine.showWindow?.();

    if (DEMO) startDemo();
    if (SMOKE) await runSmoke();
    if (PICKUP_SELFTEST) {
      // 自测必须保证退出：上一版这里一个未捕获的拒绝就让进程挂死，
      // 外面用 -Wait 等它，结果是一个永远不消的窗口。
      const watchdog = setTimeout(() => {
        console.error("[pickup-selftest] watchdog fired, forcing quit");
        ball.allowClose();
        app.exit(2);
      }, 90_000);
      try {
        await runPickupSelftest();
      } catch (error) {
        console.error("[pickup-selftest] threw: " + String(error));
      } finally {
        clearTimeout(watchdog);
        ball.allowClose();
        app.quit();
      }
    }
  });

  // 球是常驻的：窗口全没了也不退出，托盘还在
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    ball.allowClose();
    panel.allowClose();
    panel.destroy();
    tray.destroy();
    hotkey.dispose();
    pickup.dispose();
    engine.dispose?.();
  });
}
