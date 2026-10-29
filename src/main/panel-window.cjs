/**
 * 面板窗口。
 *
 * 和球是**两个独立窗口**：拖面板只动面板，球原地待着；反过来也一样。
 * 这就是「解耦」的实现方式 —— 同一个窗口里做不到，因为窗口是一个矩形。
 *
 * 窗口比面板本体大一圈（`MARGIN`），那一圈是给投影的。给少了会被窗口边缘
 * 硬切，看起来就是面板外面一圈黑边 —— 这个坑在球身上已经踩过一次。
 */

const { BrowserWindow, screen } = require("electron");
const { join } = require("node:path");
const store = require("./store.cjs");
const { clampPanelWindow, defaultPanelPosition } = require("./panel-geometry.cjs");

/** 面板本体的默认尺寸（CSS px）。实际尺寸存在 store 里，可以被拖动改。 */
const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 470;

/** 拖动右下角时允许的尺寸区间。 */
const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 760;
const MIN_PANEL_HEIGHT = 320;
const MAX_PANEL_HEIGHT = 900;

/** 四周给投影的留白。阴影是 `0 10px 22px`，向下占 32px。 */
const MARGIN = 32;

/**
 * 右下角抓手到屏幕右/下边缘要留的余量。
 * 抓手画在本体右下角，本体正好贴边时抓手中心压在屏幕边上，鼠标很难点到，
 * 所以真的贴边前先停一下。
 */
const GRIP_CLEARANCE = 12;

/** 球圆与面板本体之间的视觉间隙。 */
const GAP = 16;

/**
 * 把任意输入夹成合法的面板尺寸。
 * @param {unknown} width @param {unknown} height
 * @returns {{width: number, height: number}}
 */
function normalizePanelSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  const clampOne = (value, min, max, fallback) =>
    Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
  return {
    width: clampOne(w, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, PANEL_WIDTH),
    height: clampOne(h, MIN_PANEL_HEIGHT, MAX_PANEL_HEIGHT, PANEL_HEIGHT),
  };
}


const state = {
  /** @type {BrowserWindow | undefined} */
  window: undefined,
  /** 是否被人为收起（托盘/✕）。 */
  visible: false,
  /** 当前面板本体尺寸（CSS px）。create() 时从 store 读，之后由 resize 改。 */
  size: { width: PANEL_WIDTH, height: PANEL_HEIGHT },
  /** 窗口最后被要求放在哪。拖动/落点都拿它当原点，不读 getPosition()。 */
  origin: { x: 0, y: 0 },
  /** @type {{originX: number, originY: number, fromX: number, fromY: number} | null} */
  drag: null,
  ignoring: false,
  quitting: false,
};

/** @returns {{width: number, height: number}} 窗口整体尺寸。 */
function windowSize() {
  return { width: state.size.width + MARGIN * 2, height: state.size.height + MARGIN * 2 };
}

/** @returns {{width: number, height: number}} 面板本体尺寸（夹取以它为准）。 */
function bodySize() {
  return { width: state.size.width, height: state.size.height };
}

/**
 * 建窗口（幂等）。
 * @returns {BrowserWindow}
 */
function create() {
  if (state.window !== undefined && !state.window.isDestroyed()) return state.window;

  const saved = store.read();
  // 上次拖着调过的大小优先；没存过就用默认 340×470
  state.size = normalizePanelSize(saved.panelWidth, saved.panelHeight);
  const size = windowSize();

  // 落点：记住过就回原位，没有就摆在球旁边
  let position;
  if (typeof saved.panelX === "number" && typeof saved.panelY === "number") {
    position = clampPanelWindow(
      { x: saved.panelX, y: saved.panelY },
      bodySize(),
      screen.getDisplayNearestPoint({ x: saved.panelX, y: saved.panelY }).workArea,
      MARGIN,
    );
  } else {
    const primary = screen.getPrimaryDisplay().workArea;
    position = clampPanelWindow(
      { x: Math.round(primary.x + (primary.width - state.size.width) / 2) - MARGIN, y: 120 },
      bodySize(),
      primary,
      MARGIN,
    );
  }

  const window = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false, // 系统投影会沿方形窗口画一圈
    alwaysOnTop: saved.pinned !== false,
    focusable: true,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "panel.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  window.loadFile(join(__dirname, "..", "ui", "panel.html"));

  // 面板窗口的控制台也接出来：它出错时界面上只剩静态 HTML，很容易看漏
  window.webContents.on("console-message", (...args) => {
    const first = args[0];
    if (first !== null && typeof first === "object" && typeof first.message === "string") {
      console.log(`[panel-renderer:${String(first.level)}] ${first.message}`);
      return;
    }
    console.log(`[panel-renderer:${String(args[1])}] ${String(args[2])}`);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[panel-renderer] did-fail-load ${String(code)} ${description}`);
  });
  window.setAlwaysOnTop(saved.pinned !== false, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  window.once("ready-to-show", () => {
    if (state.visible) window.showInactive();
  });

  window.on("close", (event) => {
    if (!state.quitting) {
      event.preventDefault();
      hide();
    }
  });

  window.on("closed", () => {
    state.window = undefined;
    state.visible = false;
  });

  state.window = window;
  state.origin = { x: position.x, y: position.y };
  return window;
}

/**
 * 第一次出现在球旁边（球在哪，面板就落在它旁边）。
 * @param {{x: number, y: number}} ballCircle
 * @param {number} ballSize
 */
function placeBesideBall(ballCircle, ballSize) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;

  const size = windowSize();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(ballCircle.x + ballSize / 2),
    y: Math.round(ballCircle.y + ballSize / 2),
  });
  const placement = defaultPanelPosition({
    ballCircle,
    ballSize,
    windowSize: size,
    workArea: display.workArea,
    gap: GAP,
    margin: MARGIN,
  });
  // 连尺寸一起给：只改位置在非整数缩放下会让窗口每帧涨 1 DIP（见 dragMove 注释）
  state.origin = { x: placement.x, y: placement.y };
  window.setBounds({
    x: placement.x,
    y: placement.y,
    width: size.width,
    height: size.height,
  });
  store.write({ panelX: placement.x, panelY: placement.y });
}

/**
 * 显示面板。
 * @param {{anchored?: {circle: {x: number, y: number}, ballSize: number}}} [options]
 *   anchored：没有记忆位置时，按球的位置摆。
 */
function show(options = {}) {
  const window = create();
  state.visible = true;

  const saved = store.read();
  if (typeof saved.panelX !== "number" && options.anchored !== undefined) {
    placeBesideBall(options.anchored.circle, options.anchored.ballSize);
  }

  window.showInactive();
}

/** 收起面板。 */
function hide() {
  state.visible = false;
  if (state.window !== undefined && !state.window.isDestroyed()) state.window.hide();
}

/** @returns {boolean} */
function isVisible() {
  return state.visible && state.window !== undefined && !state.window.isDestroyed();
}

/**
 * 拖动开始。
 * @param {number} screenX @param {number} screenY
 */
function dragStart(screenX, screenY) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  const origin = state.origin;
  state.drag = { originX: origin.x, originY: origin.y, fromX: screenX, fromY: screenY };
}

/**
 * 拖动中：窗口位置 = 原点 + 指针位移，夹进工作区。
 *
 * **必须用 setBounds 连尺寸一起给，不能用 setPosition。** 只改位置时，
 * 非整数缩放下 Windows 每次都要按 DPI 重算窗口矩形，宽高会比上次多 1 DIP，
 * 表现成「按住拖面板，它自己越来越大」。
 *
 * @param {number} screenX @param {number} screenY
 */
function dragMove(screenX, screenY) {
  const window = state.window;
  const drag = state.drag;
  if (window === undefined || window.isDestroyed() || drag === null) return;

  const size = windowSize();
  const target = {
    x: drag.originX + Math.round(screenX - drag.fromX),
    y: drag.originY + Math.round(screenY - drag.fromY),
  };
  const position = clampPanelWindow(
    target,
    bodySize(),
    screen.getDisplayNearestPoint({
      x: target.x + MARGIN + state.size.width / 2,
      y: target.y + MARGIN + state.size.height / 2,
    }).workArea,
    MARGIN,
  );
  state.origin = position;
  window.setBounds({ x: position.x, y: position.y, width: size.width, height: size.height });
}

/** 拖动结束：落盘。 */
function dragEnd() {
  state.drag = null;
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  store.write({ panelX: state.origin.x, panelY: state.origin.y });
}

/**
 * 改面板尺寸（拖右下角）。
 *
 * **左上角钉住**：拖右下角时用户的预期是"往右下长"，所以窗口位置不动、只改宽高。
 *
 * 两条边界规则，缺一条都会出事：
 *
 * 1. **尺寸先按工作区夹一次。** 屏幕只有 852 高时，整窗上限 760×900 根本装不下；
 *    不先夹，窗口就会比屏幕还大，右下角抓手永远够不着。
 * 2. **位置只回收、不主动移动。** 窗口右边越过工作区时往左收，但不该因为
 *    "整窗比屏幕高"就把它往上顶 —— 那会让面板在拖大时突然上跳。
 *
 * @param {number} width @param {number} height - 面板本体尺寸（不含投影留白）
 * @param {{persist?: boolean}} [options]
 * @returns {{width: number, height: number}} 夹取后的实际尺寸
 */
function resize(width, height, options = {}) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return bodySize();

  const x = state.origin.x;
  const y = state.origin.y;
  const workArea = screen.getDisplayNearestPoint({
    x: x + MARGIN + state.size.width / 2,
    y: y + MARGIN + state.size.height / 2,
  }).workArea;

  // 规则 1：本体加上两圈留白，不能超出工作区
  const maxBodyWidth = Math.max(MIN_PANEL_WIDTH, workArea.width - MARGIN * 2);
  const maxBodyHeight = Math.max(MIN_PANEL_HEIGHT, workArea.height - MARGIN * 2);
  const wanted = normalizePanelSize(width, height);
  state.size = {
    width: Math.min(wanted.width, maxBodyWidth),
    height: Math.min(wanted.height, maxBodyHeight),
  };

  const size = windowSize();
  // 规则 2：只往回收，不主动平移。
  // 回收的口径是**面板本体**，不是整窗：那圈 MARGIN 是透明投影留白，允许它跑出
  // 屏幕（贴边摆放时它本来就在外面）。按整窗夹会把贴边窗口硬推进来，表现为
  // 拖大时面板突然跳一下。
  //
  // 右侧/底部额外留 GRIP_CLEARANCE：抓手就在本体右下角，本体贴到屏幕边时
  // 抓手的中心点会落到屏幕外，用户抓起来很别扭。
  const maxWinRight = workArea.x + workArea.width - GRIP_CLEARANCE + MARGIN;
  const maxWinBottom = workArea.y + workArea.height - GRIP_CLEARANCE + MARGIN;
  const nextX = Math.max(workArea.x - MARGIN, Math.min(x, maxWinRight - size.width));
  const nextY = Math.max(workArea.y - MARGIN, Math.min(y, maxWinBottom - size.height));
  state.origin = { x: nextX, y: nextY };
  window.setBounds({ x: nextX, y: nextY, width: size.width, height: size.height });

  if (options.persist !== false) {
    store.write({
      panelWidth: state.size.width,
      panelHeight: state.size.height,
      panelX: nextX,
      panelY: nextY,
    });
  }
  return bodySize();
}

/**
 * 鼠标穿透：窗口那圈留白不该挡住下层程序。
 * @param {boolean} ignore
 */
function setPassThrough(ignore) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  if (state.ignoring === ignore) return;
  state.ignoring = ignore;
  window.setIgnoreMouseEvents(ignore, { forward: true });
}

/** @param {boolean} pinned */
function applyPinned(pinned) {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  window.setAlwaysOnTop(pinned, "screen-saver");
}

/** 允许真正关闭。 */
function allowClose() {
  state.quitting = true;
}

/** 销毁。 */
function destroy() {
  state.quitting = true;
  if (state.window !== undefined && !state.window.isDestroyed()) state.window.destroy();
  state.window = undefined;
  state.visible = false;
}

/**
 * 显示设置变了（改缩放、换分辨率、插拔屏幕）：按新工作区重新夹一次。
 *
 * 缩放一变，原来的 DIP 坐标在新缩放下的物理位置就变了，不重算会留在屏幕外。
 */
function reclamp() {
  const window = state.window;
  if (window === undefined || window.isDestroyed()) return;
  const size = windowSize();
  const position = clampPanelWindow(
    state.origin,
    bodySize(),
    screen.getDisplayNearestPoint({
      x: state.origin.x + MARGIN + state.size.width / 2,
      y: state.origin.y + MARGIN + state.size.height / 2,
    }).workArea,
    MARGIN,
  );
  state.origin = position;
  window.setBounds({ x: position.x, y: position.y, width: size.width, height: size.height });
}

/** @returns {object} 日志 / 自测用。 */
function snapshot() {
  const window = state.window;
  const alive = window !== undefined && !window.isDestroyed();
  return {
    visible: isVisible(),
    bounds: alive ? window.getBounds() : null,
    passThrough: state.ignoring,
    size: windowSize(),
    body: bodySize(),
  };
}

module.exports = {
  PANEL_WIDTH,
  PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_HEIGHT,
  MAX_PANEL_HEIGHT,
  MARGIN,
  GAP,
  create,
  show,
  hide,
  isVisible,
  dragStart,
  dragMove,
  dragEnd,
  resize,
  reclamp,
  normalizePanelSize,
  setPassThrough,
  applyPinned,
  allowClose,
  destroy,
  placeBesideBall,
  bodySize,
  snapshot,
  getWindow: () => state.window,
};
