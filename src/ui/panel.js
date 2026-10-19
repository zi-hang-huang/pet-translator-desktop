/*
 * 面板窗口的行为。
 *
 * 面板是**独立窗口**：拖它只动它自己，球在别处待着不动。
 * 翻译、设置、DeepSeek 后端都在这个窗口里；球的颜色和眼睛归球窗口管
 * （这里只负责把设置存下来并通知主进程转发）。
 *
 * 命中判定用 elementFromPoint：body 是 pointer-events:none，只有 .panel 可点，
 * 所以窗口那 32px 留白（给投影用）不会挡住下层程序的点击。
 */

const api = window.petPanel;
const root = document.documentElement;

const panelEl = document.getElementById("panel");
const viewTranslate = document.getElementById("view-translate");
const viewSettings = document.getElementById("view-settings");
const headTranslate = document.getElementById("head-translate");
const headSettings = document.getElementById("head-settings");

const srcEl = document.getElementById("src");
const outEl = document.getElementById("out");
const srcLabel = document.getElementById("src-label");
const outLabel = document.getElementById("out-label");
const draftEl = document.getElementById("draft");
const goEl = document.getElementById("go");
const footEl = document.getElementById("foot");
const hintEl = document.getElementById("hint");
const lampEl = document.getElementById("lamp");
const lampSettingsEl = document.getElementById("lamp-settings");
const engineNameEl = document.getElementById("engine-name");
const engineDetailEl = document.getElementById("engine-detail");
const hotkeyValueEl = document.getElementById("hotkey-value");
const autostartEl = document.getElementById("autostart");
const autostartNoteEl = document.getElementById("autostart-note");
const disableGpuEl = document.getElementById("disable-gpu");
const panelColorEl = document.getElementById("panel-color");
const panelOpacityEl = document.getElementById("panel-opacity");
const panelOpacityValueEl = document.getElementById("panel-opacity-value");
const ballColorEl = document.getElementById("ball-color");
const textColorEl = document.getElementById("text-color");
const eyesFollowEl = document.getElementById("eyes-follow");

const targetTopEl = document.getElementById("target-top");
const targetSettingsEl = document.getElementById("target-settings");
const scaleEl = document.getElementById("scale");
const resizeGripEl = document.getElementById("resize-grip");

/** 提示文字的停留时长。 */
const HINT_MS = 1400;

/** 拖动位移小于这个值就算「点击」，不算拖。 */
const DRAG_THRESHOLD = 4;

/**
 * 改尺寸时，指针相对面板本体右下角的初始差值。
 *
 * 抓手有 22px 宽、贴在角上，按下点未必正好在角尖上。不记这个偏移的话，
 * 一按下面板就会「跳」一下 —— 尺寸瞬间变化一小截。记下来之后，拖动过程中
 * 尺寸 = 指针 - 偏移，和按下那一刻保持连续。
 */
let resizeGripOffset = null;

/** 穿透判定的节流间隔（ms）。 */
const PASS_THROUGH_INTERVAL = 24;

/** 设计稿默认值：等于默认值时不动令牌，保持原来的观感。 */
const DEFAULT_TEXT = "#e8ecf4";
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

const state = {
  view: "translate",
  target: "auto",
  targets: [],
  source: "",
  result: "",
  elapsed: 0,
  error: "",
  busy: false,
  busySince: 0,
  busySeconds: 0,
  maxSource: 4000,
  scale: 1,
  engine: null,
  hotkey: null,
  autostart: null,
  disableGpu: false,
  panelColor: "#161a22",
  panelOpacity: 100,
  ballColor: "#3a8dff",
  textColor: "#e8ecf4",
  eyesFollow: true,
  ignoring: false,
  lastPassCheck: 0,
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

/**
 * @param {number[]} a @param {number[]} b @param {number} t
 * @returns {number[]}
 */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}


/**
 * 面板底色的配套颜色（由 applyPanelLook 调用）。
 *
 * 几个内容块（原文 / 译文 / 输入框 / 下拉）以前用的是写死的
 * "白色 5% / 黑色 28%" 叠加层 —— 深色面板上没问题，面板一调浅就变成一团灰。
 *
 * 规则：**深底往上提亮，浅底往下压暗**（`away` 就是那个方向），
 * 强度按层级递增：原文 7% < 译文 11% < 输入框 16% < 下拉 20%。
 * 译文块额外掺一点球的颜色，和球呼应。
 *
 * @param {number[]} panelRgb - 面板底色。
 * @param {string} ballColor - 球的颜色（决定译文块的色调）。
 */
function applySurfaces(panelRgb, ballColor) {
  const away = luminance(panelRgb) > 0.5 ? BLACK : WHITE;

  /** @param {number} delta @returns {string} */
  const surface = (delta) => {
    const rgb = mix(panelRgb, away, delta);
    return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, 1)`;
  };

  const accent = mix(mix(panelRgb, away, 0.09), hexToRgb(ballColor), 0.12);
  const accentCss = `rgba(${Math.round(accent[0])}, ${Math.round(accent[1])}, ${Math.round(accent[2])}, 1)`;

  root.style.setProperty("--tr-src-bg", surface(0.07));
  root.style.setProperty("--tr-out-bg", accentCss);
  root.style.setProperty("--tr-input-bg", surface(0.16));
  root.style.setProperty("--tr-select-bg", surface(0.2));
  root.style.setProperty("--tr-input-border", `1px solid ${surface(0.26)}`);
  root.style.setProperty("--tr-divider", `1px solid ${surface(0.22)}`);
  root.style.setProperty("--tr-btn-ghost-border", `1px solid ${surface(0.28)}`);
}

/** @param {number[]} rgb @returns {number} */
function luminance(rgb) {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** 面板底色 + 不透明度。 */
function applyPanelLook(color, opacityPercent) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color ?? ""));
  const hex = match === null ? "161a22" : match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const alpha = Math.min(1, Math.max(0.55, (Number(opacityPercent) || 100) / 100));
  root.style.setProperty("--tr-panel-bg", `rgba(${r}, ${g}, ${b}, ${alpha})`);
  // 内容块、分割线、输入框描边都跟着面板底色走（面板色或球色变了都要重算）
  applySurfaces([r, g, b], state.ballColor);
}

/**
 * 文字颜色：派生强调 / 次级 / 弱化 / 控件四档，外加原文译文色。
 * 等于默认值时不写任何变量（设计稿那套是单独调过的）。
 */
function applyTextLook() {
  if (String(state.textColor).toLowerCase() === DEFAULT_TEXT) {
      for (const name of [
      "--tr-text",
      "--tr-text-strong",
      "--tr-text-soft",
      "--tr-text-muted",
      "--tr-text-control",
      "--tr-out-color",
      "--tr-src-color",
    ]) {
      root.style.removeProperty(name);
    }
    return;
  }

  // 用户要什么颜色就给什么颜色 —— 不再自动调整明度
  const background = hexToRgb(state.panelColor);
  const base = hexToRgb(state.textColor);

  root.style.setProperty("--tr-text", rgbToHex(base));
  root.style.setProperty("--tr-text-strong", rgbToHex(mix(base, WHITE, 0.25)));
  root.style.setProperty("--tr-text-soft", rgbToHex(mix(base, background, 0.3)));
  root.style.setProperty("--tr-text-muted", rgbToHex(mix(base, background, 0.55)));
  root.style.setProperty("--tr-text-control", rgbToHex(mix(base, background, 0.18)));
  root.style.setProperty("--tr-out-color", rgbToHex(base));
  root.style.setProperty("--tr-src-color", rgbToHex(mix(base, background, 0.35)));
}

/* ── 渲染 ─────────────────────────────────────────────────────────────── */

function render() {
  srcEl.textContent = state.source === "" ? "在任意程序里选中文字，按 Ctrl+Alt+T 就会直接翻译。" : state.source;
  srcEl.dataset.placeholder = state.source === "" ? "1" : "0";
  srcLabel.textContent = state.source === "" ? "原文" : `原文 · ${state.source.length} 字`;

  if (state.busy) {
    const seconds = state.busySeconds ?? 0;
    outEl.textContent = seconds >= 3 ? `翻译中… ${seconds}s` : "翻译中…";
    outEl.dataset.placeholder = "1";
    outEl.classList.remove("error");
  } else if (state.error !== "") {
    outEl.textContent = state.error;
    outEl.dataset.placeholder = "1";
    outEl.classList.add("error");
  } else if (state.result === "") {
    outEl.textContent = "译文会出现在这里，点它即可复制。";
    outEl.dataset.placeholder = "1";
    outEl.classList.remove("error");
  } else {
    outEl.textContent = state.result;
    outEl.dataset.placeholder = "0";
    outEl.classList.remove("error");
  }

  outLabel.textContent =
    state.busy ? "译文"
      : state.elapsed > 0 && state.result !== "" ? `译文 · ${state.elapsed.toFixed(1)} 秒`
        : "译文";

  goEl.disabled = state.busy;

  const engine = state.engine ?? { id: "?", label: "未知", status: "off" };
  for (const lamp of [lampEl, lampSettingsEl]) lamp.dataset.status = engine.status ?? "off";
  engineNameEl.textContent = engine.label ?? engine.id;
  engineDetailEl.textContent = engine.detail === "" || engine.detail === undefined ? "未启动" : engine.detail;

  if (state.hotkey !== null) {
    hotkeyValueEl.textContent = state.hotkey.ok
      ? state.hotkey.label
      : `${state.hotkey.label}（注册失败，被别的软件占了）`;
    hotkeyValueEl.style.color = state.hotkey.ok ? "" : "var(--tr-status-warn)";
  }

  disableGpuEl.checked = state.disableGpu === true;
  panelColorEl.value = state.panelColor;
  panelOpacityEl.value = String(state.panelOpacity);
  panelOpacityValueEl.textContent = `${state.panelOpacity}%`;
  ballColorEl.value = state.ballColor;
  textColorEl.value = state.textColor;
  eyesFollowEl.checked = state.eyesFollow === true;


  if (state.autostart !== null) {
    autostartEl.checked = state.autostart.enabled === true;
    const note = state.autostart.packaged === true ? "" : "开发模式不写启动项，打包成 exe 后才生效。";
    autostartNoteEl.textContent = note;
    autostartNoteEl.hidden = note === "";
  }

  if (state.error !== "") {
    footEl.textContent = "失败 · 点译文区可重试（Ctrl+Enter）";
  } else if (state.busy) {
    footEl.textContent = `翻译中 · ${state.busySeconds ?? 0}s · 串行 1/1`;
  } else {
    footEl.textContent = engine.footnote ?? `${engine.label} · 串行 1/1`;
  }

  root.dataset.view = state.view;
  viewTranslate.hidden = state.view !== "translate";
  viewSettings.hidden = state.view !== "settings";
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

let hintTimer = 0;
/** @param {string} text */
function flashHint(text) {
  hintEl.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hintEl.textContent = "Ctrl+Enter";
  }, HINT_MS);
}

/** @param {"translate" | "settings"} view */
function setView(view) {
  state.view = view;
  render();
}

/* ── 翻译 ─────────────────────────────────────────────────────────────── */

/** @param {object} result @returns {string} */
function describeError(result) {
  const code = result?.error ?? "unknown";
  if (code === "empty-text") return "没有可翻译的文字";
  if (code === "too-long") return `文本太长（上限 ${result.limit ?? state.maxSource} 字）`;
  if (code === "busy") return "上一次翻译还没结束";
  if (code === "engine") {
    if (result.code === "need-login") return "需要登录 DeepSeek：进设置 → 打开 DeepSeek 窗口，登录一次";
    if (result.code === "no-composer") return "DeepSeek 页面找不到输入框，可能改版了";
    if (result.code === "no-reply") return "消息发出去了，但页面没有回复（可能掉登录或触发风控）";
    if (result.code === "aborted") return "已取消";
    if (result.code === "short-reply") return result.detail ?? "回复异常短，可能被限流了，等十几秒再试";
    if (result.code === "send-failed") return result.detail ?? "消息没发出去，点译文区重试";
    return `翻译失败：${result.detail ?? "未知原因"}`;
  }
  if (code === "ipc") return `和主进程的连接断了（${result.detail ?? "未知原因"}），点译文区重试`;
  return `翻译失败（${code}）`;
}

/** 翻译中的秒表：让人看得出程序还活着。 */
let busyTimer = 0;

function startBusyTicker() {
  stopBusyTicker();
  busyTimer = window.setInterval(() => {
    if (!state.busy) {
      stopBusyTicker();
      return;
    }
    state.busySeconds = Math.max(0, Math.round((Date.now() - state.busySince) / 1000));
    render();
  }, 1000);
}

function stopBusyTicker() {
  if (busyTimer !== 0) {
    clearInterval(busyTimer);
    busyTimer = 0;
  }
}

/**
 * 翻一段文字。
 * `api.translate` 必须被 try/finally 包住：IPC 桥断掉时它会 reject，
 * 只在成功路径清 busy 的话，面板会永远停在「翻译中…」。
 * @param {string} text
 */
async function translate(text) {
  const source = String(text ?? "").trim();
  if (source === "") {
    flashHint("先输入或选中要翻译的文字");
    return;
  }
  if (source.length > state.maxSource) {
    state.error = `文本太长（上限 ${state.maxSource} 字）`;
    render();
    return;
  }
  if (state.busy) return;

  state.busy = true;
  state.error = "";
  state.source = source;
  state.result = "";
  state.elapsed = 0;
  state.busySince = Date.now();
  state.busySeconds = 0;
  startBusyTicker();
  render();

  let result;
  try {
    result = await api.translate({ text: source, target: state.target });
  } catch (failure) {
    result = { ok: false, error: "ipc", detail: String(failure?.message ?? failure) };
  } finally {
    state.busy = false;
    stopBusyTicker();
  }

  if (result?.ok !== true) {
    state.error = describeError(result);
    render();
    return;
  }
  state.result = result.text ?? "";
  state.elapsed = (Number(result.ms) || 0) / 1000;
  render();
}

/** 点「翻译」：优先翻输入框里的，其次重翻原文。 */
function submit() {
  const draft = draftEl.value.trim();
  if (draft !== "") {
    draftEl.value = "";
    translate(draft);
    return;
  }
  if (state.source !== "") {
    translate(state.source);
    return;
  }
  flashHint("先输入或选中要翻译的文字");
}

/** 点译文块：成功时复制，失败时重试。 */
async function onOutClick() {
  if (state.error !== "") {
    translate(state.source);
    return;
  }
  if (state.result === "" || state.busy) return;
  const ok = await api.copy(state.result);
  flashHint(ok ? "已复制" : "复制失败");
}

/* ── 控件 ─────────────────────────────────────────────────────────────── */

function fillTargets() {
  const options = state.targets.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    return option;
  });
  for (const select of [targetTopEl, targetSettingsEl]) {
    select.replaceChildren(...options.map((option) => option.cloneNode(true)));
    select.value = state.target;
  }
}

function fillScales() {
  const values = [0.6, 0.8, 1, 1.2, 1.5, 1.8];
  scaleEl.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value.toFixed(1)}x`;
      return option;
    }),
  );
  scaleEl.value = String(state.scale);
}

/** @param {string} value */
function setTarget(value) {
  state.target = value;
  targetTopEl.value = value;
  targetSettingsEl.value = value;
  if (state.result !== "" && !state.busy) translate(state.source);
}

targetTopEl.addEventListener("change", () => setTarget(targetTopEl.value));
targetSettingsEl.addEventListener("change", () => setTarget(targetSettingsEl.value));

scaleEl.addEventListener("change", () => api.setScale(Number(scaleEl.value)));

goEl.addEventListener("click", submit);
outEl.addEventListener("click", onOutClick);

draftEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit();
  }
});

/** 面板底 / 文字颜色的即时保存。 */
async function savePanelLook() {
  const result = await api.setPanelLook({
    color: panelColorEl.value,
    opacity: Number(panelOpacityEl.value),
  });
  state.panelColor = result?.color ?? panelColorEl.value;
  state.panelOpacity = Number(result?.opacity ?? panelOpacityEl.value);
  applyPanelLook(state.panelColor, state.panelOpacity);
  applyTextLook();
  render();
}

/** 球颜色 / 文字颜色。球颜色会由主进程转发给球窗口。 */
async function saveLook() {
  const result = await api.setLook({ ballColor: ballColorEl.value, textColor: textColorEl.value });
  state.ballColor = result?.ballColor ?? ballColorEl.value;
  state.textColor = result?.textColor ?? textColorEl.value;
  applyTextLook();
  render();
}

panelColorEl.addEventListener("input", savePanelLook);
panelOpacityEl.addEventListener("input", savePanelLook);
ballColorEl.addEventListener("input", saveLook);
textColorEl.addEventListener("input", saveLook);

eyesFollowEl.addEventListener("change", async () => {
  const result = await api.setEyesFollow(eyesFollowEl.checked);
  state.eyesFollow = result?.enabled === true;
  render();
});

disableGpuEl.addEventListener("change", async () => {
  const result = await api.setDisableGpu(disableGpuEl.checked);
  state.disableGpu = result?.enabled === true;
  render();
  flashHint("重启后生效");
});

autostartEl.addEventListener("change", async () => {
  const result = await api.setAutostart(autostartEl.checked);
  state.autostart = { ...(state.autostart ?? {}), ...result };
  render();
  if (result?.applied === false && result?.reason) flashHint(result.reason);
});

/* ── 动作 ─────────────────────────────────────────────────────────────── */

async function resetSession() {
  const result = await api.resetSession();
  if (result?.ok === true) {
    state.source = "";
    state.result = "";
    state.error = "";
    state.elapsed = 0;
    render();
    flashHint("已清空翻译会话");
    return;
  }
  flashHint(`清空失败：${result?.detail ?? "未知原因"}`);
}

panelEl.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (target === null) return;
  const action = target.getAttribute("data-action");
  if (action === "close") api.close();
  else if (action === "settings") setView("settings");
  else if (action === "back") setView("translate");
  else if (action === "login") {
    api.showDeepSeek();
    flashHint("已打开网页窗口，请在那里登录");
  } else if (action === "reset-session") resetSession();
});

// Esc：翻译中 = 取消；否则关面板
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.busy) {
    event.preventDefault();
    api.abort();
    flashHint("正在取消…");
    return;
  }
  event.preventDefault();
  api.close();
});

/* ── 拖动 ─────────────────────────────────────────────────────────────── */

/**
 * 标题栏是拖动把手。里面的按钮/下拉不参与。
 * @param {PointerEvent} event @param {Element} grip
 */
function beginDrag(event, grip) {
  if (event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null && target.closest("button, select, input, label")) return;
  event.preventDefault();
  state.drag = { fromX: event.screenX, fromY: event.screenY, moved: false };
  grip.setPointerCapture?.(event.pointerId);
  api.dragStart({ x: event.screenX, y: event.screenY });
}

/** @param {PointerEvent} event */
function moveDrag(event) {
  const drag = state.drag;
  if (drag === null) return;
  const dx = event.screenX - drag.fromX;
  const dy = event.screenY - drag.fromY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
  drag.moved = true;
  root.dataset.drag = "1";
  api.dragMove({ x: event.screenX, y: event.screenY });
}

/** @param {PointerEvent} event */
function endDrag(event) {
  if (state.drag === null) return;
  state.drag = null;
  delete root.dataset.drag;
  headTranslate.releasePointerCapture?.(event.pointerId);
  headSettings.releasePointerCapture?.(event.pointerId);
  api.dragEnd();
}

for (const head of [headTranslate, headSettings]) {
  head.addEventListener("pointerdown", (event) => beginDrag(event, head));
  head.addEventListener("pointermove", moveDrag);
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);
}

/* ── 右下角拖拽改尺寸 ─────────────────────────────────────────────────── */

/**
 * 面板本体当前的宽高（CSS px，不含 32px 投影留白）。
 * @returns {{width: number, height: number}}
 */
function bodySize() {
  const rect = panelEl.getBoundingClientRect();
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}

/** @param {PointerEvent} event */
function beginResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = panelEl.getBoundingClientRect();
  // 指针相对面板本体右下角的位置：拖动过程中保持不变，尺寸才不会跳
  resizeGripOffset = { x: event.clientX - rect.right, y: event.clientY - rect.bottom };
  resizeGripEl.setPointerCapture?.(event.pointerId);
  root.dataset.resizing = "1";
}

/** @param {PointerEvent} event */
function moveResize(event) {
  if (resizeGripOffset === null) return;
  event.preventDefault();
  const rect = panelEl.getBoundingClientRect();
  api.resize({
    width: Math.round(event.clientX - resizeGripOffset.x - rect.left),
    height: Math.round(event.clientY - resizeGripOffset.y - rect.top),
  });
}

/** @param {PointerEvent} event */
function endResize(event) {
  if (resizeGripOffset === null) return;
  resizeGripOffset = null;
  delete root.dataset.resizing;
  resizeGripEl.releasePointerCapture?.(event.pointerId);
}

resizeGripEl.addEventListener("pointerdown", beginResize);
resizeGripEl.addEventListener("pointermove", moveResize);
resizeGripEl.addEventListener("pointerup", endResize);
resizeGripEl.addEventListener("pointercancel", endResize);

/* ── 鼠标穿透 ─────────────────────────────────────────────────────────── */

/**
 * @param {number} clientX @param {number} clientY @returns {boolean}
 */
function isInteractive(clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  return element !== null && element !== document.documentElement && element !== document.body;
}

window.addEventListener("mousemove", (event) => {
  // 拖标题栏或拖右下角时都不能穿透：否则指针一离开可见元素，窗口就把鼠标事件转给下层了
  if (state.drag !== null || resizeGripOffset !== null) return;
  const now = performance.now();
  if (now - state.lastPassCheck < PASS_THROUGH_INTERVAL) return;
  state.lastPassCheck = now;
  const ignore = !isInteractive(event.clientX, event.clientY);
  if (ignore === state.ignoring) return;
  state.ignoring = ignore;
  api.passThrough(ignore);
});

window.addEventListener("mouseleave", () => {
  if (state.drag !== null || resizeGripOffset !== null || state.ignoring) return;
  state.ignoring = true;
  api.passThrough(true);
});

/* ── 主进程消息 ───────────────────────────────────────────────────────── */

api.onTranslateRequest((payload) => {
  const text = String(payload?.text ?? "").trim();
  if (text === "") return;
  setView("translate");
  translate(text);
});

api.onEngineStatus((status) => {
  if (status === null || status === undefined) return;
  state.engine = { ...(state.engine ?? {}), status: status.status, detail: status.detail };
  render();
});

/* ── 启动 ─────────────────────────────────────────────────────────────── */

api.info().then((info) => {
  if (typeof info?.scale === "number") state.scale = info.scale;
  if (typeof info?.maxSource === "number") state.maxSource = info.maxSource;
  if (Array.isArray(info?.targets) && info.targets.length > 0) state.targets = info.targets;
  if (info?.engine !== undefined) state.engine = info.engine;
  if (info?.hotkey !== undefined) state.hotkey = info.hotkey;
  if (info?.autostart !== undefined) state.autostart = info.autostart;
  if (info?.disableGpu !== undefined) state.disableGpu = info.disableGpu === true;
  if (typeof info?.panelColor === "string") state.panelColor = info.panelColor;
  if (typeof info?.panelOpacity === "number") state.panelOpacity = info.panelOpacity;
  if (typeof info?.ballColor === "string") state.ballColor = info.ballColor;
  if (typeof info?.textColor === "string") state.textColor = info.textColor;
  if (typeof info?.eyesFollow === "boolean") state.eyesFollow = info.eyesFollow;

  fillTargets();
  fillScales();
  applyPanelLook(state.panelColor, state.panelOpacity);
  applyTextLook();
  render();
  console.log(`[panel] ready engine=${state.engine?.id ?? "?"}`);
});
