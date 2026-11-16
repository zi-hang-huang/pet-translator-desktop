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
const history = require("./history.cjs");
const tray = require("./tray.cjs");
const hotkey = require("./hotkey.cjs");
const pickup = require("./pickup.cjs");
const ocr = require("./ocr.cjs");
const shot = require("./shot.cjs");
const autostart = require("./autostart.cjs");
const log = require("./log.cjs");
const { SCALES } = require("../shared/scales.cjs");
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
 *
 * 例外：`PET_TR_USERDATA` 环境变量可以临时改到这个目录之外，**只给冒烟/自测用**。
 * 单实例锁是按 userData 目录算的 —— 用户自己开着程序时，冒烟实例会被顶掉；
 * 有了这个开关，就能另起一套干净的 profile 跑截图，不打扰正在用的那只球。
 */
app.setPath(
  "userData",
  process.env.PET_TR_USERDATA || join(app.getPath("appData"), "pet-translator-desktop"),
);

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
  // 验收/截图用：PET_TR_FAKE_STATUS=offline / captcha / need-login / timeout / ok
  // 只从环境变量读，绝不落进设置，正式使用不受影响。
  const fake = process.env.PET_TR_FAKE_STATUS;
  if (typeof fake === "string" && fake !== "") {
    const table = {
      ok: { status: "ok", detail: "已登录", code: "ok" },
      off: { status: "off", detail: "网页后端未启动", code: "not-started" },
      offline: { status: "bad", detail: "网络已断开，检查一下网线/Wi-Fi，恢复后点重试", code: "offline" },
      timeout: { status: "bad", detail: "连接超时，DeepSeek 那边没响应，点重试或稍后再试", code: "timeout" },
      captcha: { status: "warn", detail: "需要完成人机验证", code: "captcha" },
      "need-login": { status: "warn", detail: "需要登录 DeepSeek", code: "need-login" },
    };
    if (table[fake] !== undefined) return table[fake];
  }
  if (typeof engine.status === "function") {
    try {
      return engine.status();
    } catch (error) {
      return { status: "bad", detail: String(error?.message ?? error), code: "unknown" };
    }
  }
  return { status: "off", detail: "", code: "not-started" };
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

/** 「翻完了」那张笑脸的回落定时器。下一次翻译必须能打断它，否则该忙的时候还在笑。 */
let celebrateTimer = null;

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

/** 截图翻译进行中（防止连按开两个框选窗口）。 */
let shooting = false;

/**
 * 截图 → 框选 → 翻译。两条下游：
 *   - 整图直翻（默认，shotMode="vision"）：把截到的**原图**直接交给 DeepSeek 网页版，
 *     让它看图读字再翻译。暗底/手写/表格/中英混排都吃得下，这是现在的默认。
 *   - 先 OCR 再翻（shotMode="ocr"）：本地 OCR 出字后走文字翻译。离线可用、不传图。
 * 两条都在框选成功后打开面板显示进度与结果，历史、朗读、错误态全部复用。
 */
async function shotAndTranslate() {
  if (shooting) return;
  if (picking || translating) return; // 正在干别的就别叠加
  shooting = true;
  ball.setState("listening");
  try {
    const selected = await shot.selectRegion();
    if (selected.ok !== true) {
      // 取消 / 超时 / 太小：都不算错误，静静回到待命，不打扰用户
      console.log(`[pet-tr] shot cancelled: ${selected.reason ?? "unknown"}`);
      ball.setState("idle");
      return;
    }

    const settings = store.read();
    const target = typeof settings.target === "string" ? settings.target : "auto";
    const mode = settings.shotMode === "ocr" ? "ocr" : "vision";
    const canVision = typeof engine.translateImage === "function";

    // ── 整图直翻 ──────────────────────────────────────────────────────
    if (mode === "vision" && canVision) {
      translating = true;
      abortRequested = false;
      clearTimeout(celebrateTimer);
      ball.setState("busy");
      openPanel();
      sendToPanel("translate:image-start", { target });
      try {
        const result = await engine.translateImage(selected.imagePath, {
          target,
          shouldAbort: () => abortRequested,
        });
        const sourceLabel = "（截图 · 整图直翻）";
        if (settings.historyEnabled !== false && typeof result?.text === "string" && result.text !== "") {
          history.add({ src: sourceLabel, out: result.text, target, ms: Number(result.ms) || 0 });
        }
        ball.setState("done");
        clearTimeout(celebrateTimer);
        celebrateTimer = setTimeout(() => ball.setState("idle"), 1600);
        pushEngineStatus();
        sendToPanel("translate:image-done", { source: sourceLabel, text: result.text, ms: result.ms });
      } catch (error) {
        clearTimeout(celebrateTimer);
        ball.setState("error");
        setTimeout(() => ball.setState("idle"), 1600);
        pushEngineStatus();
        sendToPanel("translate:image-failed", {
          code: error?.code ?? "unknown",
          detail: String(error?.message ?? error),
        });
      } finally {
        translating = false;
      }
      return;
    }

    // ── 先 OCR 再翻（降级 / 用户主动选的模式）───────────────────────────
    const recognized = await ocr.recognizeFile(selected.imagePath);
    if (recognized.ok !== true || recognized.text.trim() === "") {
      console.log(`[pet-tr] ocr failed: ${recognized.reason ?? "empty"} ${recognized.detail ?? ""}`);
      ball.setState("error");
      setTimeout(() => ball.setState("idle"), 1400);
      // 把失败具体原因推给面板，让用户看懂是「没装英文包」还是「这块没字」
      openPanel();
      sendToPanel("ocr:failed", {
        reason: recognized.reason ?? "empty",
        detail: recognized.detail ?? "",
        langs: [],
      });
      return;
    }

    ball.setState("idle");
    console.log(`[pet-tr] ocr ${recognized.text.length} chars in ${recognized.ms}ms (lang ${recognized.lang})`);
    openPanel();
    sendToPanel("translate:request", { text: recognized.text, source: "ocr" });
  } catch (error) {
    console.warn("pet-tr: shot failed:", String(error));
    ball.setState("error");
    setTimeout(() => ball.setState("idle"), 1400);
  } finally {
    shooting = false;
  }
}

/** 热键：截图翻译。 */
async function onShotHotkey() {
  await shotAndTranslate();
}

/**
 * 按当前设置（重新）注册全局热键。改键、开关热键都走它，保证只有一处逻辑。
 * 返回 `hotkey.status()`，面板据此更新显示。
 * @returns {{accelerator: string, ok: boolean, label: string, enabled: boolean}}
 */
function applyHotkey() {
  const settings = store.read();
  const enabled = settings.hotkeyEnabled !== false;
  const accelerator = typeof settings.hotkey === "string" ? settings.hotkey : "Control+Alt+T";
  if (!enabled) {
    // 关闭：显式传空串，hotkey.register 会当成「关」而不是「注册失败」
    hotkey.register("", onHotkey, "pick");
    console.log("[pet-tr] hotkey disabled by user");
    return hotkey.status("pick");
  }
  const registered = hotkey.register(accelerator, () => {
    onHotkey().catch((error) => console.warn("pet-tr: pickup failed:", String(error)));
  }, "pick");
  console.log(`[pet-tr] hotkey ${accelerator} -> ${registered ? "ok" : "REJECTED (已被占用)"}`);
  return hotkey.status("pick");
}

/**
 * 按当前设置（重新）注册**截图翻译**热键。和 applyHotkey 平行，互不影响。
 * @returns {{accelerator: string, ok: boolean, label: string, enabled: boolean}}
 */
function applyShotHotkey() {
  const settings = store.read();
  const enabled = settings.shotHotkeyEnabled !== false;
  const accelerator = typeof settings.shotHotkey === "string" ? settings.shotHotkey : "Ctrl+Alt+S";
  if (!enabled) {
    hotkey.register("", onShotHotkey, "shot");
    console.log("[pet-tr] shot hotkey disabled by user");
    return hotkey.status("shot");
  }
  const registered = hotkey.register(accelerator, () => {
    onShotHotkey().catch((error) => console.warn("pet-tr: shot failed:", String(error)));
  }, "shot");
  console.log(`[pet-tr] shot hotkey ${accelerator} -> ${registered ? "ok" : "REJECTED (已被占用)"}`);
  return hotkey.status("shot");
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
    // 上一轮的笑脸还没散场就又被按下翻译：先撤掉它的回落定时器，
    // 否则 1.6 秒后会把 busy 盖成 idle —— 正在转的眼睛会突然停下
    clearTimeout(celebrateTimer);
    ball.setState("busy");
    try {
      const result = await engine.translate(text, {
        target: payload?.target,
        shouldAbort: () => abortRequested,
      });
      // 翻译成功且历史开着才记。记失败不算错，history.add 自己会吞掉异常。
      if (store.read().historyEnabled !== false && typeof result?.text === "string" && result.text !== "") {
        history.add({ src: text, out: result.text, target: payload?.target ?? "auto", ms: Number(result.ms) || 0 });
      }
      ball.setState("done");
      clearTimeout(celebrateTimer);
      celebrateTimer = setTimeout(() => ball.setState("idle"), 1600);
      pushEngineStatus();
      return { ok: true, ...result };
    } catch (error) {
      clearTimeout(celebrateTimer);
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

  /* ── 热键改键 / 开关 ──────────────────────────────────────────────── */
  ipcMain.handle("settings:set-hotkey", (_event, accelerator, slotArg) => {
    // 槽位：pick（取词）/ shot（截图）。默认 pick，兼容老面板。
    const slot = slotArg === "shot" ? "shot" : "pick";
    const handler = slot === "shot"
      ? () => onShotHotkey().catch((error) => console.warn("pet-tr: shot failed:", String(error)))
      : () => onHotkey().catch((error) => console.warn("pet-tr: pickup failed:", String(error)));

    const wanted = typeof accelerator === "string" ? accelerator : "";
    // 先校验形状，别把乱七八糟的东西写进设置文件
    const check = hotkey.validate(wanted);
    if (!check.ok) {
      return { ok: false, reason: check.reason, status: hotkey.status(slot) };
    }
    const normalized = hotkey.normalize(wanted);
    if (normalized === "") return { ok: false, reason: "empty", status: hotkey.status(slot) };

    // 试注册：抢不到就直接说清楚，并把设置恢复成原来的（不影响正在用的热键）
    const previous = hotkey.status(slot);
    const registered = hotkey.register(normalized, handler, slot);
    if (!registered) {
      // 恢复旧热键
      if (previous.enabled && previous.accelerator !== "") {
        hotkey.register(previous.accelerator, handler, slot);
      } else {
        hotkey.register("", handler, slot);
      }
      return { ok: false, reason: "conflict", status: hotkey.status(slot) };
    }
    if (slot === "shot") store.write({ shotHotkey: normalized, shotHotkeyEnabled: true });
    else store.write({ hotkey: normalized, hotkeyEnabled: true });
    return { ok: true, status: hotkey.status(slot) };
  });

  ipcMain.handle("settings:set-hotkey-enabled", (_event, enabled, slotArg) => {
    const slot = slotArg === "shot" ? "shot" : "pick";
    const on = enabled === true;
    if (slot === "shot") {
      store.write({ shotHotkeyEnabled: on });
      applyShotHotkey();
    } else {
      store.write({ hotkeyEnabled: on });
      applyHotkey();
    }
    return { ok: true, status: hotkey.status(slot) };
  });

  /** 截图翻译模式："vision"（整图直翻）| "ocr"（先识别再翻）。 */
  ipcMain.handle("settings:set-shot-mode", (_event, mode) => {
    const next = mode === "ocr" ? "ocr" : "vision";
    store.write({ shotMode: next });
    return { ok: true, shotMode: next };
  });

  /* ── 截图框选窗口回调 ─────────────────────────────────────────────── */
  ipcMain.handle("shot:commit", async (_event, rect) => {
    return shot.commitSelection(rect);
  });
  ipcMain.on("shot:cancel", () => {
    shot.cancel();
  });
  ipcMain.on("shot:done", () => {
    // 渲染层在 commit 之后调用；commitSelection 已经结算并清理过，这里是幂等兜底
  });

  /* ── 从面板按钮也可发起截图翻译 ───────────────────────────────────── */
  ipcMain.on("shot:start", () => {
    shotAndTranslate();
  });

  /* ── OCR 能力查询（面板提示用） ───────────────────────────────────── */
  ipcMain.handle("ocr:status", async () => {
    return ocr.status();
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

  ipcMain.handle("settings:set-eyes-visible", (_event, enabled) => {
    store.write({ eyesVisible: enabled === true });
    ball.pushLook();
    return { enabled: enabled === true };
  });

  ipcMain.handle("settings:set-mouth-visible", (_event, enabled) => {
    store.write({ mouthVisible: enabled === true });
    ball.pushLook();
    return { enabled: enabled === true };
  });

  ipcMain.handle("settings:set-idle-gestures", (_event, enabled) => {
    store.write({ idleGestures: enabled === true });
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

  ipcMain.handle("settings:set-font-size", (_event, size) => {
    const raw = Number(size);
    // 夹到 10~28：再小看不清，再大一行放不下几个字
    const outFontSize = Number.isFinite(raw) ? Math.min(28, Math.max(10, Math.round(raw))) : 12;
    store.write({ outFontSize });
    return { outFontSize };
  });

  ipcMain.handle("settings:set-speech-rate", (_event, rate) => {
    const raw = Number(rate);
    const speechRate = Number.isFinite(raw) ? Math.min(2, Math.max(0.5, Math.round(raw * 10) / 10)) : 1;
    store.write({ speechRate });
    return { speechRate };
  });

  ipcMain.handle("settings:set-disable-gpu", (_event, enabled) => {
    store.write({ disableGpu: enabled === true });
    return { enabled: enabled === true, needsRestart: true };
  });

  ipcMain.handle("autostart:status", () => autostart.status());
  ipcMain.handle("autostart:set", (_event, enabled) => autostart.set(enabled === true));

  /* ── 本地历史 ─────────────────────────────────────────────────────── */
  ipcMain.handle("history:list", (_event, query) => {
    const all = history.read();
    return { entries: history.searchEntries(all, query), total: all.length, max: history.MAX_ENTRIES };
  });

  ipcMain.handle("history:remove", (_event, id) => {
    const entries = history.remove(id);
    return { ok: true, entries, total: entries.length };
  });

  ipcMain.handle("history:clear", () => {
    history.clear();
    return { ok: true, entries: [], total: 0 };
  });

  ipcMain.handle("settings:set-history-enabled", (_event, enabled) => {
    const on = enabled === true;
    store.write({ historyEnabled: on });
    // 关掉就立刻清空：用户关这个开关，意思就是「别留」，不是「以后别留」
    if (!on) history.clear();
    return { enabled: on };
  });

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
    scales: SCALES,
    panel: panel.bodySize(),
    engine: {
      id: engine.id,
      label: engine.label,
      status: engineStatus().status,
      detail: engineStatus().detail,
      code: engineStatus().code,
      footnote: `${engine.label} · ${engine.note ?? ""}`,
    },
    targets: TARGETS,
    maxSource: MAX_SOURCE,
    hotkey: hotkey.status(),
    hotkeyEnabled: store.read().hotkeyEnabled !== false,
    shotHotkey: hotkey.status("shot"),
    shotHotkeyEnabled: store.read().shotHotkeyEnabled !== false,
    shotMode: store.read().shotMode === "ocr" ? "ocr" : "vision",
    autostart: autostart.status(),
    panelOpen: panel.isVisible(),
    disableGpu: store.read().disableGpu === true,
    panelColor: store.read().panelColor,
    panelOpacity: store.read().panelOpacity,
    ballColor: store.read().ballColor,
    textColor: store.read().textColor,
    outFontSize: store.read().outFontSize,
    speechRate: store.read().speechRate,
    historyEnabled: store.read().historyEnabled !== false,
    eyesFollow: store.read().eyesFollow === true,
    eyesVisible: store.read().eyesVisible !== false,
    mouthVisible: store.read().mouthVisible !== false,
    idleGestures: store.read().idleGestures === true,
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

/** 五态轮播，用于肉眼验收动效。 */
function startDemo() {
  const states = ["idle", "listening", "busy", "done", "error"];
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

  // 打开历史抽屉（冒烟截图用）：走真实 DOM 点击路径
  if (process.env.PET_TR_HISTORY === "1") {
    const window = panel.getWindow();
    if (window !== undefined && !window.isDestroyed()) {
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-action="history"]').click()`,
      );
      await wait(600);
    }
  }

  const forced = process.env.PET_TR_STATE;
  if (
    forced === "idle" ||
    forced === "listening" ||
    forced === "busy" ||
    forced === "done" ||
    forced === "error"
  ) {
    ball.setState(forced);
    await wait(160);
  }
  const shot = process.env.PET_TR_SHOT ?? join(app.getPath("userData"), "smoke.png");
  // 验收用：在面板里跑一段任意 JS（异步 OK），把返回值打到 stdout。
  // 用来验证「改键」「开关」这类必须走真实渲染进程 + 真实 IPC 的交互。
  const evalCode = process.env.PET_TR_EVAL;
  if (typeof evalCode === "string" && evalCode !== "") {
    const window = panel.getWindow();
    if (window !== undefined && !window.isDestroyed()) {
      try {
        const value = await window.webContents.executeJavaScript(`(async () => { ${evalCode} })()`);
        console.log("[pet-tr-eval] " + JSON.stringify(value ?? null));
      } catch (error) {
        console.log("[pet-tr-eval] ERROR " + String(error));
      }
    }
  }
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
    // 第二次双击 exe：以前只把球 show 出来，用户毫无感知，会以为程序坏了。
    // 现在做三件事：球亮出来、面板（若开着）提到最前、并在面板上闪一条「已在运行」。
    ball.show();
    if (panel.isVisible()) {
      const window = panel.getWindow();
      if (window !== undefined && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.showInactive();
        window.moveTop();
        window.webContents.send("app:notice", {
          key: "already-running-" + Date.now(),
          text: "翻译球已经在运行了（就在这儿）",
          tone: "info",
        });
      }
    }
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

    // 改显示缩放 / 换分辨率 / 插拔屏幕：DIP 坐标在新缩放下的物理位置会变，
    // 不重算的话球会跑到屏幕外或者贴在边上回不来。
    screen.on("display-metrics-changed", () => {
      ball.relayout();
      panel.reclamp();
      console.log("[pet-tr] display metrics changed; layout reapplied");
    });
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
    // OCR 引擎同样预热：tesseract.js 首次会解压语言模型 + 创建 worker，约 0.5~2s。
    // 放在后台 warmUp，别等用户第一次截图才现起；之后同一进程内是热引擎，单次 150~350ms。
    // （实测 tesseract.js 在 Node/Electron 下不把解压模型落盘，故每次启动仍有一次冷启，
    //  这里传 cachePath 只为将来版本支持持久缓存时能直接用上，不影响正确性。）
    ocr.init({ cachePath: join(app.getPath("userData"), "ocr-cache") });
    ocr.warmUp();
    // 后台等引擎就绪后打一行日志：方便排障时确认 OCR 到底起没起来
    ocr.status().then((s) => {
      console.log(`[pet-tr] ocr ${s.ok ? "ready" : "FAILED"} · ${(s.langs || []).join("+") || "-"}${s.detail ? " · " + s.detail : ""}`);
    });

    // 开机自启：只在打包版里真正写启动项，开发模式只回一句"没应用"
    const autostartState = autostart.apply();
    console.log(
      `[pet-tr] autostart ${autostartState.enabled ? "on" : "off"} · applied=${autostartState.applied}${autostartState.reason ? " · " + autostartState.reason : ""}`,
    );

    // 全局热键。注册失败要能告诉用户，而不是按了没反应
    applyHotkey();
    applyShotHotkey();
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
    ocr.dispose();
    shot.dispose();
    engine.dispose?.();
  });
}
