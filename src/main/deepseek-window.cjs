/**
 * DeepSeek 网页窗口。
 *
 * 这是「方案 A 页面代理」的载体：一个长期存在的隐藏窗口，登录态存在独立的
 * `persist:` 分区里，和用户自己的浏览器互不干扰，也不碰任何凭据。
 *
 * 两个刻意的选择：
 *
 *  1. **不给它 preload。** 这是一个远程页面，往里塞 contextBridge 等于把接口
 *     暴露给第三方代码。所有操作都从主进程 `executeJavaScript` 注入，
 *     注入完就结束，页面自己拿不到任何额外能力。
 *  2. **窗口默认隐藏，需要时才露头。** 登录、验证码、环境异常这些必须本人处理的
 *     情况才 show()，平时它只在后台发请求。
 */

const { BrowserWindow } = require("electron");
const store = require("./store.cjs");

/** 独立分区：登录一次之后一直有效，与系统浏览器隔离。 */
const PARTITION = "persist:deepseek";

/** 站点根。登录后会自己跳到聊天页。 */
const START_URL = "https://chat.deepseek.com/";

/** 会话地址里的 id：/a/chat/s/<id>。 */
const SESSION_RE = /\/a\/chat\/s\/([A-Za-z0-9_-]+)/;

/** 登录页的路径特征。 */
const SIGN_IN_HINT = "sign_in";

/** 加载超时：超过这么久还没 load 成功就报网络问题。 */
const LOAD_TIMEOUT_MS = 30_000;

/** 单条页面脚本的超时。页面主线程被卡住时，executeJavaScript 永远不返回。 */
const SCRIPT_TIMEOUT_MS = 15_000;

const state = {
  /** @type {BrowserWindow | undefined} */
  window: undefined,
  /** 是否完成过一次加载。 */
  loaded: false,
  /** 最近一次已知的页面地址。 */
  url: "",
  /** 最近一次错误，给人看。 */
  lastError: "",
  /** 真退出：close 事件不再拦。 */
  quitting: false,
};

/**
 * 建窗口（或复用）。
 * @param {{visible?: boolean}} [options]
 * @returns {BrowserWindow}
 */
function ensure(options = {}) {
  if (state.window !== undefined && !state.window.isDestroyed()) {
    if (options.visible === true) state.window.showInactive();
    return state.window;
  }

  const window = new BrowserWindow({
    width: 1160,
    height: 840,
    show: false,
    title: "DeepSeek（翻译球的网页后端）",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 隐藏窗口会被 Chromium 降频，导致页面里 setTimeout 变成 1 分钟一次
      backgroundThrottling: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.webContents.on("did-navigate", (_event, url) => {
    rememberSession(url);
  });
  window.webContents.on("did-navigate-in-page", (_event, url) => {
    rememberSession(url);
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    // -3 是用户/我们主动打断，不算失败
    if (code === -3) return;
    state.lastError = `${description} (${code}) @ ${url}`;
    state.loaded = false;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    state.lastError = `页面进程退出：${details.reason}`;
    state.loaded = false;
  });

  // 用户点关闭 = 先收起来，翻译还要用
  window.on("close", (event) => {
    if (!state.quitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    state.window = undefined;
    state.loaded = false;
  });

  state.window = window;
  state.loaded = false;
  state.url = START_URL;
  if (options.visible === true) window.showInactive();
  return window;
}

/**
 * 记下当前页面地址；如果它是某个会话，就把会话地址存起来，下次启动直接回去。
 *
 * 这就是「固定专用会话」的实现：一次翻译之后 DeepSeek 会把地址变成
 * `/a/chat/s/<id>`，记住它，重启 App 还进同一个会话，而不是每开一次就新建一个。
 * @param {string} url
 */
function rememberSession(url) {
  state.url = url;
  const match = SESSION_RE.exec(url);
  if (match === null) return;
  const saved = store.read().sessionUrl;
  if (saved === url) return;
  store.write({ sessionUrl: url });
}

/**
 * 该加载哪个地址：记住的会话优先，否则站点首页（= 新对话）。
 * @returns {string}
 */
function targetUrl() {
  const saved = store.read().sessionUrl;
  return typeof saved === "string" && SESSION_RE.test(saved) ? saved : START_URL;
}

/**
 * 打开站点（已有页面就直接用当前页）。
 * @param {{visible?: boolean, reload?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function open(options = {}) {
  const window = ensure(options);
  if (state.loaded && options.reload !== true) return;

  const timeout = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`加载超时（${LOAD_TIMEOUT_MS / 1000}s）`)), LOAD_TIMEOUT_MS);
  });

  try {
    await Promise.race([window.loadURL(targetUrl()), timeout]);
    state.loaded = true;
    state.lastError = "";
    state.url = window.webContents.getURL();
  } catch (error) {
    state.lastError = String(error?.message ?? error);
    throw new Error(`打不开 DeepSeek 网页：${state.lastError}`);
  }
}

/**
 * 显示窗口（登录、验证码、排错用）。
 *
 * **必须先加载再显示。** 新装的用户第一件事就是点「打开 DeepSeek 窗口」去登录，
 * 那一步之前从来没翻译过 —— 如果只是 ensure() + show()，窗口是空的：ensure()
 * 只记地址、不发起导航。用户看到的就是一个空白页。
 *
 * 所以这里走 open({visible:true})：它负责 ensure + 发起导航 + 维护 loaded/
 * lastError/url 三件状态；窗口由它先 showInactive 出来，紧接着我们 focus。
 *
 * 加载失败不拦着窗口：用户至少能看到地址栏式的结果，status() 也会把原因带给
 * 面板。这里必须 catch，否则会变成 unhandled rejection 把主进程日志刷脏。
 */
function show() {
  const window = ensure({ visible: true });
  if (!state.loaded) {
    open({ visible: true }).catch((error) => {
      console.error(`[pet-tr] DeepSeek 窗口加载失败：${error?.message ?? error}`);
    });
  }
  window.show();
  window.focus();
}

/** 隐藏窗口。 */
function hide() {
  if (state.window !== undefined && !state.window.isDestroyed()) state.window.hide();
}

/**
 * 回到新对话（清空翻译会话）。
 * 同时把记住的会话地址抹掉，否则下次启动又会回到那个旧会话。
 * @returns {Promise<void>}
 */
async function resetConversation() {
  store.write({ sessionUrl: "" });
  await open({ reload: true });
}

/**
 * 在页面里跑一段脚本。失败统一包成带原因的 Error。
 *
 * **必须带超时**：`executeJavaScript` 在页面主线程被卡住（弹了原生对话框、
 * 页面在等某个网络响应、渲染进程假死）时**永远不会返回**，而它上游的每一层
 * await 都会跟着永远挂着 —— 表现就是面板一直停在「翻译中…」。
 * 这个坑是靠用户截图才发现的，不能再省。
 *
 * @param {string} source - 返回可序列化值的表达式。
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
async function run(source, options = {}) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) throw new Error("DeepSeek 窗口还没建起来");

  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`页面脚本超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  });

  try {
    return await Promise.race([window.webContents.executeJavaScript(source, true), timeout]);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes("页面脚本超时")) throw new Error(message);
    throw new Error(`页面脚本失败：${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判断当前状态，给面板上的状态灯用。
 * @returns {{status: "off" | "ok" | "warn" | "bad", detail: string, url: string}}
 */
function status() {
  if (state.window === undefined || state.window.isDestroyed()) {
    return { status: "off", detail: "网页后端未启动", url: "" };
  }
  if (state.lastError !== "") {
    return { status: "bad", detail: state.lastError, url: state.url };
  }
  const url = state.url || state.window.webContents.getURL();
  if (!state.loaded) return { status: "warn", detail: "页面还在加载", url };
  if (url.includes(SIGN_IN_HINT)) {
    return { status: "warn", detail: "需要登录 DeepSeek", url };
  }
  return { status: "ok", detail: "已登录", url };
}

/** @returns {boolean} 窗口是否还活着。 */
function alive() {
  return state.window !== undefined && !state.window.isDestroyed();
}

/** 标记为真退出。 */
function allowClose() {
  state.quitting = true;
}

/** 销毁（退出时）。 */
function destroy() {
  state.quitting = true;
  if (alive()) state.window.destroy();
  state.window = undefined;
}

module.exports = {
  PARTITION,
  START_URL,
  open,
  show,
  hide,
  reset: resetConversation,
  run,
  status,
  alive,
  allowClose,
  destroy,
  getWindow: () => state.window,
};
