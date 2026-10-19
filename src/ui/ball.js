/*
 * 球窗口的行为。
 *
 * 面板已经拆成独立窗口，所以这里只剩「球」：
 * 拖动、单击（取词→翻译）、右键菜单、鼠标穿透、
 * 球体颜色、眼睛跟随鼠标。
 *
 * 位置永远由主进程推下来（`ball:layout`）—— 窗口多大、留白多少，它说了算。
 */

const api = window.petBall;
const root = document.documentElement;
const stage = document.getElementById("stage");
const ballEl = document.getElementById("ball");
const eyeEls = [...document.querySelectorAll(".eye")];

/** 拖动位移小于这个值就算「点击」。 */
const DRAG_THRESHOLD = 4;

/** 穿透判定的节流间隔（ms）。 */
const PASS_THROUGH_INTERVAL = 24;

/** 设计稿默认球色：等于它时不覆盖令牌（原渐变的高光不是简单变白）。 */
const DEFAULT_BALL = "#3a8dff";
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

const state = {
  scale: 1,
  eyesFollow: true,
  ballColor: DEFAULT_BALL,
  ignoring: false,
  lastPassCheck: 0,
  /** 最近一次的光标屏幕坐标（眼睛跟随用）。 */
  cursor: null,
  drag: /** @type {{fromX: number, fromY: number, moved: boolean} | null} */ (null),
};

/* ── 颜色 ─────────────────────────────────────────────────────────────── */

/** @param {string} hex @returns {number[]} */
function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""));
  if (match === null) return [0, 0, 0];
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** @param {number[]} rgb @returns {string} */
function rgbToHex(rgb) {
  const part = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/** @param {number[]} a @param {number[]} b @param {number} t @returns {number[]} */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 球色：高光往白混 45%，暗部往黑混 42%。
 * 默认值不覆盖 —— 设计稿那三档不是等比算出来的。
 */
function applyBallLook() {
  if (String(state.ballColor).toLowerCase() === DEFAULT_BALL) {
    for (const name of ["--tr-ball-highlight", "--tr-ball-body", "--tr-ball-shadow"]) {
      root.style.removeProperty(name);
    }
    return;
  }
  const base = hexToRgb(state.ballColor);
  root.style.setProperty("--tr-ball-highlight", rgbToHex(mix(base, WHITE, 0.45)));
  root.style.setProperty("--tr-ball-body", rgbToHex(base));
  root.style.setProperty("--tr-ball-shadow", rgbToHex(mix(base, BLACK, 0.42)));
}

/* ── 眼睛 ─────────────────────────────────────────────────────────────── */

/** 把眼睛挪回中间。 */
function resetEyes() {
  for (const eye of eyeEls) eye.style.transform = "";
}

/**
 * 朝光标方向偏一点。
 * 位移取球直径的 6%，外部按距离饱和（2 个球直径之外就是满偏），
 * 近了按比例收 —— 否则鼠标贴着球时眼珠会瞬移到边缘。
 */
function updateEyes() {
  if (state.cursor === null || state.eyesFollow !== true) return;
  const rect = ballEl.getBoundingClientRect();
  if (rect.width === 0) return;

  const centerX = window.screenX + rect.left + rect.width / 2;
  const centerY = window.screenY + rect.top + rect.height / 2;
  const dx = state.cursor.x - centerX;
  const dy = state.cursor.y - centerY;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) {
    resetEyes();
    return;
  }

  const reach = Math.max(140, rect.width * 2);
  const strength = Math.min(1, distance / reach);
  const max = rect.width * 0.06;
  const offsetX = (dx / distance) * max * strength;
  const offsetY = (dy / distance) * max * strength;
  for (const eye of eyeEls) {
    eye.style.transform = `translate(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px)`;
  }
}

/* ── 拖动 / 点击 ───────────────────────────────────────────────────────── */

/** @param {PointerEvent} event */
function beginDrag(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  if (state.ignoring) {
    state.ignoring = false;
    api.passThrough(false);
  }
  state.drag = { fromX: event.screenX, fromY: event.screenY, moved: false };
  ballEl.setPointerCapture?.(event.pointerId);
  api.dragStart({ x: event.screenX, y: event.screenY });
}

/** @param {PointerEvent} event */
function moveDrag(event) {
  const drag = state.drag;
  if (drag === null) return;
  const dx = event.screenX - drag.fromX;
  const dy = event.screenY - drag.fromY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
  if (!drag.moved) {
    drag.moved = true;
    root.dataset.drag = "1";
  }
  api.dragMove({ x: event.screenX, y: event.screenY });
}

/** @param {PointerEvent} event */
function endDrag(event) {
  const drag = state.drag;
  if (drag === null) return;
  state.drag = null;
  delete root.dataset.drag;
  ballEl.releasePointerCapture?.(event.pointerId);
  api.dragEnd();
  if (!drag.moved) api.click();
}

ballEl.addEventListener("pointerdown", beginDrag);
ballEl.addEventListener("pointermove", moveDrag);
ballEl.addEventListener("pointerup", endDrag);
ballEl.addEventListener("pointercancel", endDrag);

ballEl.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  api.contextMenu();
});

/* ── 鼠标穿透 ─────────────────────────────────────────────────────────── */

/**
 * @param {number} clientX @param {number} clientY @returns {boolean}
 */
function isInteractive(clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  return element !== null && element !== document.documentElement && element !== document.body;
}

window.addEventListener("mousemove", (event) => {
  if (state.drag !== null) return;
  const now = performance.now();
  if (now - state.lastPassCheck < PASS_THROUGH_INTERVAL) return;
  state.lastPassCheck = now;
  const ignore = !isInteractive(event.clientX, event.clientY);
  if (ignore === state.ignoring) return;
  state.ignoring = ignore;
  api.passThrough(ignore);
});

window.addEventListener("mouseleave", () => {
  if (state.drag !== null || state.ignoring) return;
  state.ignoring = true;
  api.passThrough(true);
});

/* ── 主进程消息 ───────────────────────────────────────────────────────── */

/** 布局：留白与球直径。阴影按直径等比，所以球缩小时也不会被窗口切出黑边。 */
api.onLayout((layout) => {
  const pad = Number(layout?.pad ?? 21);
  root.style.setProperty("--ball-pad", `${pad}px`);
  const ballWidth = Number(layout?.ballWidth ?? 0);
  if (ballWidth > 0) root.style.setProperty("--ball-size", `${Math.max(1, ballWidth)}px`);
  // 尺寸变了，眼睛的偏移基准也变了
  updateEyes();
});

api.onState((next) => {
  if (root.dataset.state !== next) root.dataset.state = next;
});

api.onScale((scale) => {
  state.scale = scale;
});

api.onLook((look) => {
  if (typeof look?.ballColor === "string") state.ballColor = look.ballColor;
  if (typeof look?.eyesFollow === "boolean") {
    state.eyesFollow = look.eyesFollow;
    if (!state.eyesFollow) resetEyes();
  }
  applyBallLook();
  updateEyes();
});

api.onCursor((point) => {
  if (point === null || point === undefined) return;
  state.cursor = point;
  updateEyes();
});

/* ── 启动 ─────────────────────────────────────────────────────────────── */

api.info().then((info) => {
  if (typeof info?.ballColor === "string") state.ballColor = info.ballColor;
  if (typeof info?.eyesFollow === "boolean") state.eyesFollow = info.eyesFollow;
  applyBallLook();
  console.log(`[ball] ready scale=${String(info?.scale ?? "?")} eyes=${String(state.eyesFollow)}`);
});
