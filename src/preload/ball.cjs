/**
 * 球窗口的预加载脚本。
 *
 * 面板拆成独立窗口之后，这里只剩下「球自己的事」：拖动、点击、缩放、
 * 鼠标穿透、状态、光标（眼睛跟随）、外观（球颜色 / 眼睛开关）。
 * 设置和翻译都在 panel.cjs 那边。
 */

const { contextBridge, ipcRenderer } = require("electron");

/** @param {string} channel @param {Function} handler @returns {() => void} */
function subscribe(channel, handler) {
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("petBall", {
  /** @returns {Promise<object>} 启动事实：尺寸、颜色、眼睛开关。 */
  info: () => ipcRenderer.invoke("ball:info"),

  /* —— 拖动 —— */
  /** @param {{x: number, y: number}} point */
  dragStart: (point) => ipcRenderer.send("ball:drag-start", point),
  /** @param {{x: number, y: number}} point */
  dragMove: (point) => ipcRenderer.send("ball:drag-move", point),
  dragEnd: () => ipcRenderer.send("ball:drag-end"),

  /* —— 菜单 / 穿透 / 点击 —— */
  contextMenu: () => ipcRenderer.send("ball:context-menu"),
  /** @param {boolean} ignore */
  passThrough: (ignore) => ipcRenderer.send("ball:pass-through", ignore),
  /** 单击球（未拖动）：主进程会执行「取词 → 翻译」。 */
  click: () => ipcRenderer.send("ball:click"),

  /* —— 主进程推来的消息 —— */
  onScale: (handler) => subscribe("ball:scale", handler),
  onState: (handler) => subscribe("ball:state", handler),
  onLayout: (handler) => subscribe("ball:layout", handler),
  onCursor: (handler) => subscribe("ball:cursor", handler),
  onLook: (handler) => subscribe("ball:look", handler),
});