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
const mouthPathEl = document.getElementById("mouth-path");

/** 嘴的五种形状（viewBox 是 0 0 100 100，跟球同心）。
 *  顶点数一样才能靠 CSS 的 d 过渡平滑变形，所以全部写成「起点 + 一段二次曲线」。
 *  纵向放在 68–77：眼睛会跟着鼠标往下跑（最多 6% 球径），嘴留在 70 以下才不会被
 *  追到脸上的眼睛压住。 */
const MOUTHS = {
  idle: "M 43 74 Q 50 75 57 74",
  listening: "M 43 74 Q 50 77 57 74",
  busy: "M 44 74 Q 50 74 56 74",
  done: "M 40 71 Q 50 83 60 71",
  error: "M 43 77 Q 50 69 57 77",
};

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

/* ── 待命小动作 ───────────────────────────────────────────────────────── */

/**
 * 闲着没事时自己动一动 —— 这是"有生命感"和"一个圆球"的区别。
 *
 * 三条硬规矩：
 * 1. 只在 idle 播；一旦进入 busy/listening/done/error，立刻收手，且不会自己回来；
 * 2. 每个动作都是"播一段时间就撤"，不驻留（睡着除外）；
 * 3. 用户一动（鼠标扫过球、点击、拖动、开始翻译）就把计时清零，并叫醒。
 *
 * 权重是百分数，加起来 100；第三条是时长（ms）。
 */
const GESTURES = [
  ["blink", 25, 560],
  ["look", 25, 1700],
  ["curious", 20, 1300],
  ["giggle", 20, 950],
  ["yawn", 10, 1900],
];

/** 安静这么久就睡着（ms）。 */
const SLEEP_AFTER = 180_000;
/** 两次小动作之间的间隔（ms），随机取。 */
const GAP_MIN = 6_000;
const GAP_MAX = 14_000;
/** 状态轮询间隔：只做计时判断，500ms 足够。 */
const TICK_MS = 500;

/** 动作期间要改的嘴形（null = 用当前状态的默认嘴）。 */
const GESTURE_MOUTHS = {
  yawn: "M 41 72 Q 50 88 59 72",
  giggle: "M 40 72 Q 50 80 60 72",
  sleep: "M 44 75 Q 50 75 56 75",
};

const mood = {
  enabled: true,
  currentState: "idle",
  /** 正在播的动作名；""=没在播。 */
  current: "",
  asleep: false,
  lastActivity: performance.now(),
  /** 下一个动作最早什么时候播。 */
  nextAt: 0,
  endTimer: 0,
  tickTimer: 0,
};

/** @param {string} d */
function setMouth(d) {
  // 两处都写：属性给老引擎兜底，CSS 的 d 才吃 transition
  mouthPathEl.setAttribute("d", d);
  mouthPathEl.style.setProperty("d", d);
}

/** 恢复当前状态的默认表情。 */
function restoreFace() {
  const d = MOUTHS[mood.currentState];
  if (d !== undefined) setMouth(d);
}

function stopGesture() {
  clearTimeout(mood.endTimer);
  mood.endTimer = 0;
  if (mood.current === "") return;
  mood.current = "";
  delete root.dataset.gesture;
  restoreFace();
}

/** 用户有动静：叫醒、清零计时、推迟下一次小动作。 */
function wake() {
  mood.lastActivity = performance.now();
  if (mood.asleep) {
    mood.asleep = false;
    if (mood.current === "sleep") stopGesture();
  }
  scheduleNextGap();
}

function scheduleNextGap() {
  mood.nextAt = performance.now() + GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
}

function canGesture() {
  return (
    mood.enabled &&
    !mood.asleep &&
    mood.current === "" &&
    mood.currentState === "idle" &&
    state.drag === null &&
    // 系统里设了"减少动态效果"就不自作主张
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function pickGesture() {
  let roll = Math.random() * 100;
  for (const gesture of GESTURES) {
    roll -= gesture[1];
    if (roll <= 0) return gesture;
  }
  return GESTURES[0];
}

/** @param {string} name @param {number} duration */
function playGesture(name, duration) {
  stopGesture();
  mood.current = name;
  root.dataset.gesture = name;
  const mouth = GESTURE_MOUTHS[name];
  if (mouth !== undefined) setMouth(mouth);
  mood.endTimer = setTimeout(() => {
    stopGesture();
    scheduleNextGap();
  }, duration);
}

function fallAsleep() {
  stopGesture();
  mood.asleep = true;
  mood.current = "sleep";
  root.dataset.gesture = "sleep";
  setMouth(GESTURE_MOUTHS.sleep);
}

function tick() {
  if (!mood.enabled) return;
  if (mood.currentState !== "idle" || state.drag !== null) {
    // 干活的时候不算"闲着"，回来重新计时
    mood.lastActivity = performance.now();
    return;
  }
  if (mood.asleep) return;

  const now = performance.now();
  if (now - mood.lastActivity >= SLEEP_AFTER) {
    fallAsleep();
    return;
  }
  if (canGesture() && now >= mood.nextAt) {
    const [name, , duration] = pickGesture();
    playGesture(name, duration);
  }
}

/**
 * 预览模式：不等 6–14 秒的随机间隔，把五个动作连着播一遍（最后一个停着睡）。
 * 只用于"看一眼效果"，正式跑不启用。
 */
function runGestureDemo() {
  const order = ["blink", "look", "curious", "giggle", "yawn", "sleep"];
  let index = 0;
  setInterval(() => {
    const name = order[index % order.length];
    index += 1;
    if (name === "sleep") fallAsleep();
    else playGesture(name, 2000);
  }, 2400);
}

if (api.gestureDemo === true) {
  runGestureDemo();
} else {
  mood.tickTimer = setInterval(tick, TICK_MS);
  scheduleNextGap();
}

/* ── 拖动 / 点击 ───────────────────────────────────────────────────────── */

/** @param {PointerEvent} event */
function beginDrag(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  wake();
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
ballEl.addEventListener("pointerenter", wake);
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
  // 72px 以下算小尺寸：五官在这么小的球上会互相挤，CSS 里对应的降级在 data-size="s"
  if (ballWidth > 0) root.dataset.size = ballWidth < 72 ? "s" : "l";
  // 尺寸变了，眼睛的偏移基准也变了
  updateEyes();
});

api.onState((next) => {
  if (root.dataset.state !== next) root.dataset.state = next;
  mood.currentState = next;
  if (next !== "idle") {
    // 干活了：立刻收手，睡着也要醒 —— 但不能再自己播回来
    mood.asleep = false;
    stopGesture();
  }
  const mouth = MOUTHS[next];
  if (mouth !== undefined) setMouth(mouth);
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
  if (typeof look?.idleGestures === "boolean") {
    mood.enabled = look.idleGestures;
    if (!mood.enabled) {
      mood.asleep = false;
      stopGesture();
    } else {
      wake();
    }
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
  if (typeof info?.idleGestures === "boolean") mood.enabled = info.idleGestures;
  applyBallLook();
  console.log(
    `[ball] ready scale=${String(info?.scale ?? "?")} eyes=${String(state.eyesFollow)} gestures=${String(mood.enabled)}`,
  );
});
