/**
 * 球窗口：一个无边框、透明、置顶的小窗，里面只有一个球。
 *
 * 面板已经拆到独立窗口（panel-window.cjs），所以这里只管球：
 * 尺寸、位置、拖动、缩放、置顶、鼠标穿透、右键菜单。
 *
 * 两条不变量：
 *  1. **透明窗口画不到自己边界之外** —— 球四周留一圈给投影，留白靠穿透处理。
 *  2. **球的位置只有一个真值：state.circle**。窗口位置、缩放、拖动全部由它推导，
 *     所以开关面板、改缩放都不会让球漂移。
 */

const { app, BrowserWindow, Menu, screen } = require("electron");
const { join } = require("node:path");
const store = require("./store.cjs");
const { collapsedLayout, clamp } = require("./panel-geometry.cjs");

/** 缩放 1.0 时的球直径（DIP），与 DESIGN.md 一致。 */
const BASE_SIZE = 96;

/** 球四周的留白比例：0.22 × 96 ≈ 21px，刚好装下按比例缩放的投影。 */
const PAD_RATIO = 0.22;

const MIN_SCALE = 0.6;
const MAX_SCALE = 1.8;

/** @param {number} s @returns {number} */
function ballSize(s) {
  return Math.round(BASE_SIZE * s);
}

/** @param {number} s @returns {number} */
function padding(s) {
  return Math.max(6, Math.round(ballSize(s) * PAD_RATIO));
}

/** @param {unknown} value @returns {number} */
function normalizeScale(value) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(number * 100) / 100));
}

/**
 * 把球圆夹进最近一块屏幕的工作区。
 * @param {{x: number, y: number}} circle @param {number} size
 * @returns {{circle: {x: number, y: number}, workArea: Electron.Rectangle}}
 */
function clampCircle(circle, size) {
  const probe = { x: Math.round(circle.x + size / 2), y: Math.round(circle.y + size / 2) };
  const { workArea } = screen.getDisplayNearestPoint(probe);
  return {
    circle: {
      x: Math.round(clamp(circle.x, workArea.x, workArea.x + workArea.width - size)),
      y: Math.round(clamp(circle.y, workArea.y, workArea.y + workArea.height - size)),
    },
    workArea,
  };
}

/** @param {number} size @returns {{x: number, y: number}} */
function defaultCircle(size) {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - size - 24, y: workArea.y + workArea.height - size - 24 };
}

const state = {
  /** @type {BrowserWindow | undefined} */
  window: undefined,
  /** 球圆的屏幕坐标（左上角）。一切几何的真值。 */
  circle: { x: 0, y: 0 },
  /** 窗口最后被要求放在哪。拖动拿它当原点，不读 getPosition()。 */
  origin: { x: 0, y: 0 },
  scale: 1,
  pinned: true,
  /** @type {{originX: number, originY: number, fromX: number, fromY: number} | null} */
  drag: null,
  ignoring: false,
  ballState: "idle",
  quitting: false,
  /** 右键菜单里的「打开面板」钩子，由 index.cjs 注入。 */
  panelToggle: /** @type {(() => void) | null} */ (null),
  panelOpen: /** @type {(() => boolean) | null} */ (null),
  /** 置顶变化时通知外面（面板窗口要跟着）。 */
  pinnedHook: /** @type {((pinned: boolean) => void) | null} */ (null),
};

/** @returns {number} */
function currentBallSize() {
  return ballSize(state.scale);
}

/** 按当前状态重算窗口尺寸/位置，并把留白与直径推给渲染进程。 */
function relayout() {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;

  const size = currentBallSize();
  const pad = padding(state.scale);

  const clamped = clampCircle(state.circle, size);
  state.circle = clamped.circle;

  const layout = collapsedLayout(state.circle, size, pad);
  window.setBounds(layout.window);
  state.origin = { x: layout.window.x, y: layout.window.y };

  // 窗口被夹回工作区时球实际动了：把真值同步回去
  state.circle = {
    x: layout.window.x + pad,
    y: layout.window.y + pad,
  };

  window.webContents.send("ball:layout", { pad, ballWidth: size });
}

/** 创建球窗口（幂等）。@returns {BrowserWindow} */
function create() {
  if (state.window !== undefined && !state.window.isDestroyed()) return state.window;

  const saved = store.read();
  state.scale = normalizeScale(saved.scale);
  state.pinned = saved.pinned !== false;
  state.circle =
    typeof saved.x === "number" && typeof saved.y === "number"
      ? clampCircle({ x: saved.x, y: saved.y }, currentBallSize()).circle
      : defaultCircle(currentBallSize());

  const size = currentBallSize();
  const pad = padding(state.scale);
  const origin = collapsedLayout(state.circle, size, pad).window;

  const window = new BrowserWindow({
    x: origin.x,
    y: origin.y,
    width: size + pad * 2,
    height: size + pad * 2,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: state.pinned,
    focusable: true,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "ball.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  applyPinned(state.pinned);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.loadFile(join(__dirname, "..", "ui", "index.html"));

  window.once("ready-to-show", () => window.showInactive());
  window.webContents.on("did-finish-load", () => relayout());

  window.on("close", (event) => {
    if (!state.quitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    state.window = undefined;
  });

  state.window = window;
  relayout();
  return window;
}

/** @param {boolean} pinned */
function applyPinned(pinned) {
  state.pinned = pinned;
  const window = state.window;
  if (window !== undefined && !window.isDestroyed()) {
    window.setAlwaysOnTop(pinned, "screen-saver");
    window.setVisibleOnAllWorkspaces(pinned, { visibleOnFullScreen: true });
  }
  store.write({ pinned });
  state.pinnedHook?.(pinned);
}

/** @param {(pinned: boolean) => void} hook */
function setPinnedHook(hook) {
  state.pinnedHook = hook;
}

/**
 * 缩放，保持球心不动。
 * @param {number} next @param {{persist?: boolean}} [options]
 * @returns {number}
 */
function applyScale(next, options = {}) {
  const scale = normalizeScale(next);
  const window = state.window;
  if (window === undefined || window.isDestroyed()) {
    state.scale = scale;
    return scale;
  }
  const centerX = state.circle.x + currentBallSize() / 2;
  const centerY = state.circle.y + currentBallSize() / 2;

  state.scale = scale;
  const size = currentBallSize();
  state.circle = { x: Math.round(centerX - size / 2), y: Math.round(centerY - size / 2) };

  relayout();
  window.webContents.send("ball:scale", scale);
  if (options.persist !== false) store.write({ scale, x: state.circle.x, y: state.circle.y });
  return scale;
}

/**
 * 拖动开始。
 * @param {number} screenX @param {number} screenY
 */
function dragStart(screenX, screenY) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  // 用「上次要求的位置」，不读 getPosition()：非整数缩放下系统回报的位置
  // 和请求值能差 1 DIP，一旦回流就会被下一次拖动继承，越拖越偏。
  const origin = state.origin;
  state.drag = { originX: origin.x, originY: origin.y, fromX: screenX, fromY: screenY };
}

/**
 * 拖动中。
 *
 * **必须用 setBounds 连尺寸一起给，不能用 setPosition。** 只改位置时，
 * 非整数缩放下 Windows 每次都要按 DPI 重算窗口矩形，宽度会比上次多 1 DIP；
 * 拖动是按帧调用的，于是表现成「按住鼠标球就一直变大」。
 *
 * @param {number} screenX @param {number} screenY
 */
function dragMove(screenX, screenY) {
  const window = state.window;
  const drag = state.drag;
  if (window === undefined || window.isDestroyed() || drag === null) return;

  const size = currentBallSize();
  const pad = padding(state.scale);
  const target = clampCircle(
    {
      x: drag.originX + Math.round(screenX - drag.fromX) + pad,
      y: drag.originY + Math.round(screenY - drag.fromY) + pad,
    },
    size,
  );
  state.circle = target.circle;
  const side = size + pad * 2;
  state.origin = { x: target.circle.x - pad, y: target.circle.y - pad };
  window.setBounds({
    x: state.origin.x,
    y: state.origin.y,
    width: side,
    height: side,
  });
}

/** 拖动结束：落盘。 */
function dragEnd() {
  state.drag = null;
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  store.write({ x: state.circle.x, y: state.circle.y });
}

/** @param {boolean} ignore */
function setPassThrough(ignore) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  if (state.ignoring === ignore) return;
  state.ignoring = ignore;
  window.setIgnoreMouseEvents(ignore, { forward: true });
}

/** @param {"idle" | "listening" | "busy" | "error"} next */
function setState(next) {
  state.ballState = next;
  const window = state.window;
  if (window !== undefined && !window.isDestroyed()) window.webContents.send("ball:state", next);
}

/** 把外观（球色 / 眼睛开关）推给球窗口。 */
function pushLook() {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  const saved = store.read();
  window.webContents.send("ball:look", {
    ballColor: saved.ballColor,
    eyesFollow: saved.eyesFollow === true,
  });
}

/**
 * 注入「打开/收起面板」的钩子 —— 右键菜单要用，但球模块不该依赖面板模块。
 * @param {{toggle: () => void, isOpen: () => boolean}} hooks
 */
function setPanelHooks(hooks) {
  state.panelToggle = hooks.toggle;
  state.panelOpen = hooks.isOpen;
}

/** 球上的右键菜单。 */
function showContextMenu() {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;

  const scales = [0.6, 0.8, 1, 1.2, 1.5, 1.8];
  const menu = Menu.buildFromTemplate([
    {
      label: state.panelOpen?.() === true ? "收起面板" : "打开面板",
      click: () => state.panelToggle?.(),
    },
    { type: "separator" },
    {
      label: "缩放",
      submenu: scales.map((value) => ({
        label: `${value.toFixed(1)}x`,
        type: "radio",
        checked: Math.abs(state.scale - value) < 0.001,
        click: () => applyScale(value),
      })),
    },
    {
      label: "常驻置顶",
      type: "checkbox",
      checked: state.pinned,
      click: (item) => applyPinned(item.checked),
    },
    { type: "separator" },
    { label: "隐藏球", click: () => window.hide() },
    { label: "退出", click: () => app.quit() },
  ]);
  menu.popup({ window });
}

/** @returns {boolean} */
function isVisible() {
  return state.window !== undefined && !state.window.isDestroyed() && state.window.isVisible();
}

/** 显示（不抢焦点）。 */
function show() {
  create().showInactive();
}

/** 隐藏。 */
function hide() {
  if (state.window !== undefined && !state.window.isDestroyed()) state.window.hide();
}

/** @returns {boolean} 切换后是否可见 */
function toggle() {
  if (isVisible()) {
    hide();
    return false;
  }
  show();
  return true;
}

/** @returns {object} 日志 / 自测用。 */
function snapshot() {
  const window = state.window;
  const alive = window !== undefined && !window.isDestroyed();
  return {
    scale: state.scale,
    ballSize: currentBallSize(),
    padding: padding(state.scale),
    circle: { ...state.circle },
    bounds: alive ? window.getBounds() : null,
    visible: alive ? window.isVisible() : false,
    alwaysOnTop: alive ? window.isAlwaysOnTop() : false,
    pinned: state.pinned,
    passThrough: state.ignoring,
    ballState: state.ballState,
  };
}

/** 允许真正关闭。 */
function allowClose() {
  state.quitting = true;
}

module.exports = {
  create,
  show,
  hide,
  toggle,
  isVisible,
  applyScale,
  applyPinned,
  normalizeScale,
  relayout,
  dragStart,
  dragMove,
  dragEnd,
  setPassThrough,
  setState,
  setPanelHooks,
  setPinnedHook,
  pushLook,
  showContextMenu,
  snapshot,
  allowClose,
  MIN_SCALE,
  MAX_SCALE,
  getWindow: () => state.window,
};
