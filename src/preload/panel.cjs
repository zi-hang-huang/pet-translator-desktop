/**
 * 面板窗口的预加载脚本。
 *
 * 翻译、设置、DeepSeek 后端都在这个窗口里；球窗口只剩外观。
 * 拖动消息走 `panel:drag-*` —— 和球的 `ball:drag-*` 分开，
 * 主进程才知道该挪哪个窗口。
 */

const { contextBridge, ipcRenderer } = require("electron");

/** @param {string} channel @param {Function} handler @returns {() => void} */
function subscribe(channel, handler) {
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("petPanel", {
  /** @returns {Promise<object>} 设置、语言、引擎状态、热键、自启…都在里面。 */
  info: () => ipcRenderer.invoke("ball:info"),

  /* ── 窗口拖动 / 穿透 / 关闭 ─────────────────────────────────────────── */
  /** @param {{x: number, y: number}} point */
  dragStart: (point) => ipcRenderer.send("panel:drag-start", point),
  /** @param {{x: number, y: number}} point */
  dragMove: (point) => ipcRenderer.send("panel:drag-move", point),
  dragEnd: () => ipcRenderer.send("panel:drag-end"),
  /** @param {boolean} ignore */
  passThrough: (ignore) => ipcRenderer.send("panel:pass-through", ignore),
  close: () => ipcRenderer.send("panel:close"),
  /**
   * 改面板尺寸（拖右下角）。传的是**本体尺寸**，不含四周投影留白。
   * @param {{width: number, height: number}} size
   */
  resize: (size) => ipcRenderer.send("panel:resize", size),

  /* ── 翻译与剪贴板 ───────────────────────────────────────────────────── */
  /**
   * @param {{text: string, target?: string}} payload
   * @returns {Promise<{ok: boolean, text?: string, ms?: number, error?: string, detail?: string}>}
   */
  translate: (payload) => ipcRenderer.invoke("engine:translate", payload),
  /** 取消正在进行的翻译（Esc）。 */
  abort: () => ipcRenderer.send("engine:abort"),
  /** @param {string} text @returns {Promise<boolean>} */
  copy: (text) => ipcRenderer.invoke("ball:copy", text),

  /* ── DeepSeek 网页后端 ─────────────────────────────────────────────── */
  showDeepSeek: () => ipcRenderer.send("deepseek:show"),
  /** @returns {Promise<{ok: boolean, detail?: string}>} */
  resetSession: () => ipcRenderer.invoke("deepseek:reset"),
  /** @returns {Promise<{status: string, detail: string, url?: string}>} */
  engineStatus: () => ipcRenderer.invoke("deepseek:status"),

  /* ── 设置 ───────────────────────────────────────────────────────────── */
  /** @param {number} scale - 绝对倍率。 */
  setScale: (scale) => ipcRenderer.send("ball:scale-set", scale),
  /** @returns {Promise<object>} */
  autostartStatus: () => ipcRenderer.invoke("autostart:status"),
  /** @param {boolean} enabled */
  setAutostart: (enabled) => ipcRenderer.invoke("autostart:set", enabled),
  /** @param {boolean} enabled */
  setDisableGpu: (enabled) => ipcRenderer.invoke("settings:set-disable-gpu", enabled),
  /** @param {{color: string, opacity: number}} look */
  setPanelLook: (look) => ipcRenderer.invoke("settings:set-panel-look", look),
  /** @param {{ballColor?: string, textColor?: string}} look */
  setLook: (look) => ipcRenderer.invoke("settings:set-look", look),
  /** @param {boolean} enabled */
  setEyesFollow: (enabled) => ipcRenderer.invoke("settings:set-eyes-follow", enabled),

  /* ── 主进程推来的消息 ───────────────────────────────────────────────── */
  /** 取到文字了，去翻译。@param {(payload: {text: string}) => void} handler */
  onTranslateRequest: (handler) => subscribe("translate:request", handler),
  /** @param {(status: {status: string, detail: string}) => void} handler */
  onEngineStatus: (handler) => subscribe("engine:status", handler),
});
