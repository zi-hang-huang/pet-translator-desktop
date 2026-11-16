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
const footNoteEl = document.getElementById("foot-note");
const modeButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll(".mode-btn")]);
const hintEl = document.getElementById("hint");
const lampEl = document.getElementById("lamp");
const lampSettingsEl = document.getElementById("lamp-settings");
const engineNameEl = document.getElementById("engine-name");
const engineDetailEl = document.getElementById("engine-detail");
const bannerEl = document.getElementById("banner");
const bannerTextEl = document.getElementById("banner-text");
const bannerActionEl = /** @type {HTMLButtonElement} */ (document.getElementById("banner-action"));
const bannerCloseEl = document.getElementById("banner-close");
const hotkeyValueEl = /** @type {HTMLButtonElement} */ (document.getElementById("hotkey-value"));
const hotkeyNoteEl = document.getElementById("hotkey-note");
const hotkeyEnabledEl = document.getElementById("hotkey-enabled");
const shotHotkeyValueEl = /** @type {HTMLButtonElement} */ (document.getElementById("shot-hotkey-value"));
const shotHotkeyNoteEl = document.getElementById("shot-hotkey-note");
const shotHotkeyEnabledEl = document.getElementById("shot-hotkey-enabled");
const shotStartEl = /** @type {HTMLButtonElement} */ (document.getElementById("shot-start"));
const autostartEl = document.getElementById("autostart");
const autostartNoteEl = document.getElementById("autostart-note");
const disableGpuEl = document.getElementById("disable-gpu");
const panelColorEl = document.getElementById("panel-color");
const panelOpacityEl = document.getElementById("panel-opacity");
const panelOpacityValueEl = document.getElementById("panel-opacity-value");
const ballColorEl = document.getElementById("ball-color");
const textColorEl = document.getElementById("text-color");
const outFontEl = document.getElementById("out-font");
const outFontValueEl = document.getElementById("out-font-value");
const presetsEl = document.getElementById("presets");
const eyesFollowEl = document.getElementById("eyes-follow");
const eyesVisibleEl = document.getElementById("eyes-visible");
const mouthVisibleEl = document.getElementById("mouth-visible");
const idleGesturesEl = document.getElementById("idle-gestures");

const targetTopEl = document.getElementById("target-top");
const targetSettingsEl = document.getElementById("target-settings");
const scaleEl = document.getElementById("scale");
const resizeGripEl = document.getElementById("resize-grip");
const speakEl = /** @type {HTMLButtonElement} */ (document.getElementById("speak"));
const speakSrcEl = /** @type {HTMLButtonElement} */ (document.getElementById("speak-src"));
const speechRateEl = /** @type {HTMLInputElement} */ (document.getElementById("speech-rate"));
const speechRateValueEl = document.getElementById("speech-rate-value");
const speechNoteEl = document.getElementById("speech-note");
const historyEnabledEl = /** @type {HTMLInputElement} */ (document.getElementById("history-enabled"));
const historyDrawerEl = document.getElementById("history-drawer");
const historyListEl = document.getElementById("history-list");
const historyCountEl = document.getElementById("history-count");
const historySearchEl = /** @type {HTMLInputElement} */ (document.getElementById("history-search"));
const historyClearEl = document.getElementById("history-clear");

/** 朗读模块（speech.js 先加载）。Node 环境下没有它，全部降级为不可用。 */
const speech = typeof window.PetSpeech !== "undefined" ? window.PetSpeech : null;

/** 提示文字的停留时长。 */
const HINT_MS = 1400;

/**
 * 翻译模式的存储键。
 *
 * 存 localStorage 就够了：它纯粹是面板自己的显示偏好，主进程不需要知道
 * （位置、尺寸那些才进 settings.json）。取不到就退回默认值，不影响功能。
 */
const MODE_KEY = "pet-panel-mode";

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
  /** 翻译模式：pick = 划词（只显示原文/译文），paste = 粘贴（只显示输入框/译文）。 */
  mode: /** @type {"pick" | "paste"} */ ("pick"),
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
  /** 可选档位（主进程给，跟右键菜单/托盘同一份）。 */
  scales: [0.6, 0.8, 1, 1.2, 1.5, 1.8],
  engine: null,
  hotkey: null,
  /** 热键是否启用。 */
  hotkeyEnabled: true,
  /** 截图翻译热键（独立于取词热键）。 */
  shotHotkey: null,
  shotHotkeyEnabled: true,
  /** 是否正在录制新热键（点一下按钮进入，按键后退出）。 */
  recordingHotkey: false,
  /** 正在录制的是哪个槽位："pick" | "shot"。 */
  recordingSlot: /** @type {"pick" | "shot"} */ ("pick"),
  autostart: null,
  disableGpu: false,
  panelColor: "#161a22",
  panelOpacity: 100,
  ballColor: "#3a8dff",
  textColor: "#e8ecf4",
  /** 译文字号（px）。只影响译文块，原文块保持小一号。 */
  outFontSize: 12,
  /** 朗读语速。 */
  speechRate: 1,
  /** 当前是否正在朗读（决定喇叭按钮显示 🔊 还是 ⏹）。 */
  speaking: false,
  /** 正在朗读的是哪一块："out"（译文）| "src"（原文）。共用一个语音通道。 */
  speakingWho: /** @type {null | "out" | "src"} */ (null),
  /** 系统里到底有没有对应语言的语音包（没包就置灰 + 提示）。 */
  speechReady: false,
  /** 是否记录本地历史。 */
  historyEnabled: true,
  eyesFollow: true,
  /** 是否显示眼睛 / 嘴（各自独立）。 */
  eyesVisible: true,
  mouthVisible: true,
  /** 待命时球自己玩（眨眼/张望/偷笑/打哈欠/睡着）。 */
  idleGestures: true,
  ignoring: false,
  lastPassCheck: 0,
  drag: /** @type {{fromX: number, fromY: number, moved: boolean} | null} */ (null),
  /**
   * 当前要显示的提示条：{ key, text, tone, action, actionLabel }，或 null。
   * key 用来记「这一条用户已经点过叉」，同一条不反复弹。
   */
  banner: /** @type {null | {key: string, text: string, tone: string, action?: string, actionLabel?: string}} */ (null),
  /** 用户关掉过哪些提示（按 key 记，避免每 8 秒推一次状态就重新弹）。 */
  dismissedBanners: /** @type {Set<string>} */ (new Set()),
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

/* ── 字号 ─────────────────────────────────────────────────────────────── */

/**
 * 应用译文字号。
 *
 * 只写一个 CSS 变量 `--tr-out-font`，`.out` 那条规则用它。为什么不放大原文：
 * 两段一样大就分不清哪段是自己刚选的内容，原文留小一号当「出处」看更清楚。
 * @param {number} size
 */
function applyOutFont(size) {
  const raw = Number(size);
  const value = Number.isFinite(raw) ? Math.min(28, Math.max(10, Math.round(raw))) : 12;
  state.outFontSize = value;
  root.style.setProperty("--tr-out-font", `${value}px`);
  outFontEl.value = String(value);
  outFontValueEl.textContent = `${value}px`;
}

/* ── 配色预设 ─────────────────────────────────────────────────────────── */

/**
 * 预设的配色组合。
 *
 * 每个预设同时定「面板底色 + 正文颜色 + 球颜色」——只换底色是最容易出事的改法：
 * 深色字压在深色底上直接看不见。三色成组才能保证任何预设都读得清。
 * 块与块的明暗关系由 applySurfaces() 负责（深底提亮、浅底压暗），这里只管给对颜色。
 */
const THEMES = [
  { id: "night", name: "午夜", panelColor: "#161a22", textColor: "#e8ecf4", ballColor: "#3a8dff" },
  { id: "ink", name: "墨黑", panelColor: "#0b0d12", textColor: "#cfd6e4", ballColor: "#4c9bff" },
  { id: "deep", name: "深海", panelColor: "#0f2233", textColor: "#d6e7f5", ballColor: "#2f9fd0" },
  { id: "paper", name: "纸白", panelColor: "#f7f5ef", textColor: "#2a2a2e", ballColor: "#c98b3e" },
  { id: "cream", name: "米黄", panelColor: "#f3ecd8", textColor: "#33302a", ballColor: "#a8762f" },
  { id: "lemon", name: "柠檬", panelColor: "#fcffeb", textColor: "#0040ff", ballColor: "#08dbf7" },
  { id: "mint", name: "薄荷", panelColor: "#e8f6ee", textColor: "#1d3a2f", ballColor: "#22b07d" },
  { id: "sky", name: "天空", panelColor: "#eaf1fb", textColor: "#1e2a3a", ballColor: "#3a8dff" },
  { id: "sakura", name: "樱粉", panelColor: "#fdeef3", textColor: "#4a2433", ballColor: "#ff86a8" },
];

/** @returns {string} 当前三个颜色正好等于哪个预设，没有就空串。 */
function activeThemeId() {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const theme = THEMES.find(
    (item) =>
      same(item.panelColor, state.panelColor) &&
      same(item.textColor, state.textColor) &&
      same(item.ballColor, state.ballColor),
  );
  return theme === undefined ? "" : theme.id;
}

/** 建色板：每个按钮自己就是预览（底色 = 面板色，文字 = 正文色）。 */
function buildPresets() {
  presetsEl.replaceChildren(
    ...THEMES.map((theme) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preset";
      button.dataset.preset = theme.id;
      button.title = `${theme.name} · ${theme.panelColor} / ${theme.textColor} / ${theme.ballColor}`;
      button.textContent = theme.name;
      button.style.background = theme.panelColor;
      button.style.color = theme.textColor;
      button.addEventListener("click", () => {
        void applyTheme(theme);
      });
      return button;
    }),
  );
}

/**
 * 套用预设。
 *
 * 三个颜色分别走已有的两个设置通道（面板底色 / 球色 + 正文色），所以预设本身
 * 不单独存：改完颜色选择器里的值就是当前配色，手调也能即时取消某预设的高亮。
 * @param {(typeof THEMES)[number]} theme
 */
async function applyTheme(theme) {
  const panel = await api.setPanelLook({ color: theme.panelColor, opacity: state.panelOpacity });
  const look = await api.setLook({ ballColor: theme.ballColor, textColor: theme.textColor });
  state.panelColor = panel?.color ?? theme.panelColor;
  state.ballColor = look?.ballColor ?? theme.ballColor;
  state.textColor = look?.textColor ?? theme.textColor;
  applyPanelLook(state.panelColor, state.panelOpacity);
  applyTextLook();
  render();
  flashHint(`配色 · ${theme.name}`);
}

/* ── 渲染 ─────────────────────────────────────────────────────────────── */

/**
 * 根据后端状态算出「该不该弹提示条、弹哪一条」。
 *
 * 这一版把三类必须让用户知道的事集中到一条提示条里，不再只靠右下角那盏小灯：
 *   1. 要人机验证（captcha）—— 必须点「去验证」
 *   2. 登录过期（need-login）—— 必须点「去登录」
 *   3. 网络断了（offline/dns/timeout…）—— 点「重试」
 * 其余状态（ok/off/loading）不弹，避免平时打扰。
 *
 * @param {any} engine
 * @returns {null | {key: string, text: string, tone: string, action?: string, actionLabel?: string}}
 */
function bannerFor(engine) {
  const code = String(engine?.code ?? "");
  if (code === "captcha") {
    return { key: "captcha", text: "DeepSeek 要人机验证了，点右边过一下验证", tone: "warn", action: "login", actionLabel: "去验证" };
  }
  if (engine?.status === "warn" && (code === "need-login" || String(engine?.detail ?? "").includes("需要登录"))) {
    return { key: "need-login", text: "DeepSeek 登录已过期", tone: "warn", action: "login", actionLabel: "去登录" };
  }
  if (code === "offline") {
    return { key: "offline", text: "网络已断开，检查网络后点重试", tone: "bad", action: "retry", actionLabel: "重试" };
  }
  if (code === "dns" || code === "name-not-resolved") {
    return { key: "dns", text: "域名解析失败，换个网络试试", tone: "bad", action: "retry", actionLabel: "重试" };
  }
  if (code === "timeout") {
    return { key: "timeout", text: "连接超时，DeepSeek 那边没响应", tone: "bad", action: "retry", actionLabel: "重试" };
  }
  if (engine?.status === "bad") {
    return { key: "bad-" + code, text: String(engine?.detail ?? "后端出问题了"), tone: "bad", action: "retry", actionLabel: "重试" };
  }
  return null;
}

function renderBanner() {
  const wanted = state.banner;
  if (wanted === null || state.dismissedBanners.has(wanted.key)) {
    bannerEl.hidden = true;
    return;
  }
  bannerEl.hidden = false;
  bannerEl.dataset.tone = wanted.tone;
  bannerTextEl.textContent = wanted.text;
  if (wanted.action !== undefined && wanted.actionLabel !== undefined) {
    bannerActionEl.hidden = false;
    bannerActionEl.textContent = wanted.actionLabel;
    bannerActionEl.dataset.action = wanted.action;
  } else {
    bannerActionEl.hidden = true;
    delete bannerActionEl.dataset.action;
  }
}

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

  // 喇叭：只有真有译文才露面；正在读就变成停止符号
  const canSpeak = state.result !== "" && !state.busy && speech !== null && speech.supported();
  speakEl.hidden = !canSpeak;
  if (canSpeak) {
    const outSpeaking = state.speaking && state.speakingWho === "out";
    speakEl.textContent = outSpeaking ? "⏹" : "🔊";
    speakEl.title = outSpeaking
      ? "停止朗读"
      : state.speechReady ? "朗读译文" : "朗读译文（系统可能没有该语言的语音包）";
    speakEl.dataset.unavailable = state.speechReady ? "0" : "1";
  }

  // 原文喇叭：有原文才露面。和译文共用一个语音通道，谁在读谁变停止符。
  const canSpeakSrc = state.source !== "" && !state.busy && speech !== null && speech.supported();
  speakSrcEl.hidden = !canSpeakSrc;
  if (canSpeakSrc) {
    const srcSpeaking = state.speaking && state.speakingWho === "src";
    speakSrcEl.textContent = srcSpeaking ? "⏹" : "🔊";
    speakSrcEl.title = srcSpeaking ? "停止朗读" : "朗读原文";
    speakSrcEl.dataset.unavailable = "0";
  }

  goEl.disabled = state.busy;

  const engine = state.engine ?? { id: "?", label: "未知", status: "off" };
  for (const lamp of [lampEl, lampSettingsEl]) lamp.dataset.status = engine.status ?? "off";
  engineNameEl.textContent = engine.label ?? engine.id;
  engineDetailEl.textContent = engine.detail === "" || engine.detail === undefined ? "未启动" : engine.detail;

  // 提示条跟着后端状态走。翻译本身失败时的提示用 flashHint/错误块，不占这条。
  state.banner = bannerFor(engine);
  renderBanner();

  if (state.hotkey !== null) {
    if (state.recordingHotkey && state.recordingSlot === "pick") {
      // 录制中：提示用户按键，别把旧值盖回去
    } else if (state.hotkeyEnabled === false) {
      hotkeyValueEl.textContent = "已关闭";
      hotkeyValueEl.style.color = "var(--tr-text-muted)";
      hotkeyValueEl.title = "热键已关闭，点一下开启并设置";
    } else {
      hotkeyValueEl.textContent = state.hotkey.ok
        ? state.hotkey.label
        : `${state.hotkey.label}（被占用）`;
      hotkeyValueEl.style.color = state.hotkey.ok ? "" : "var(--tr-status-warn)";
      hotkeyValueEl.title = "点击后按下新的快捷键";
    }
  }
  hotkeyEnabledEl.checked = state.hotkeyEnabled !== false;

  if (state.shotHotkey !== null) {
    if (state.recordingHotkey && state.recordingSlot === "shot") {
      // 录制中
    } else if (state.shotHotkeyEnabled === false) {
      shotHotkeyValueEl.textContent = "已关闭";
      shotHotkeyValueEl.style.color = "var(--tr-text-muted)";
      shotHotkeyValueEl.title = "热键已关闭，点一下开启并设置";
    } else {
      shotHotkeyValueEl.textContent = state.shotHotkey.ok
        ? state.shotHotkey.label
        : `${state.shotHotkey.label}（被占用）`;
      shotHotkeyValueEl.style.color = state.shotHotkey.ok ? "" : "var(--tr-status-warn)";
      shotHotkeyValueEl.title = "点击后按下新的快捷键";
    }
  }
  shotHotkeyEnabledEl.checked = state.shotHotkeyEnabled !== false;

  disableGpuEl.checked = state.disableGpu === true;
  panelColorEl.value = state.panelColor;
  panelOpacityEl.value = String(state.panelOpacity);
  panelOpacityValueEl.textContent = `${state.panelOpacity}%`;
  ballColorEl.value = state.ballColor;
  textColorEl.value = state.textColor;
  eyesFollowEl.checked = state.eyesFollow === true;
  eyesVisibleEl.checked = state.eyesVisible !== false;
  mouthVisibleEl.checked = state.mouthVisible !== false;
  idleGesturesEl.checked = state.idleGestures === true;


  if (state.autostart !== null) {
    autostartEl.checked = state.autostart.enabled === true;
    const note = state.autostart.packaged === true ? "" : "开发模式不写启动项，打包成 exe 后才生效。";
    autostartNoteEl.textContent = note;
    autostartNoteEl.hidden = note === "";
  }

  if (state.error !== "") {
    footNoteEl.textContent = "失败 · 点译文区可重试";
  } else if (state.busy) {
    footNoteEl.textContent = `翻译中 · ${state.busySeconds ?? 0}s · 串行 1/1`;
  } else {
    footNoteEl.textContent = engine.footnote ?? `${engine.label} · 串行 1/1`;
  }

  // 模式由 CSS 的 html[data-mode] 选择器驱动：改一个属性，两边的块就互斥显示
  root.dataset.mode = state.mode;
  for (const button of modeButtons) {
    button.setAttribute("aria-selected", button.dataset.mode === state.mode ? "true" : "false");
  }

  // 字号回显 + 预设高亮（手调过任一颜色就一个都不亮）
  outFontEl.value = String(state.outFontSize);
  outFontValueEl.textContent = `${state.outFontSize}px`;
  const themeId = activeThemeId();
  for (const button of presetsEl.children) {
    button.setAttribute("aria-pressed", button.dataset.preset === themeId ? "true" : "false");
  }

  root.dataset.view = state.view;
  viewTranslate.hidden = state.view !== "translate";
  viewSettings.hidden = state.view !== "settings";
}

/* ── 本地历史抽屉 ─────────────────────────────────────────────────────── */

/** 上次拉到的历史，供点击回填时按 id 取原文（DOM 里不塞整段文本）。 */
let historyCache = [];

/** 把时间戳变成「今天 14:05 / 昨天 / 03-12」这种能一眼看懂的样子。 */
function formatTime(ts) {
  const date = new Date(Number(ts) || 0);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, "0");
  if (sameDay) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 渲染历史列表。
 * @param {Array<any>} entries
 * @param {number} total
 */
function renderHistory(entries, total) {
  historyCountEl.textContent = total > 0 ? `${entries.length} / ${total} 条` : "";
  historyListEl.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = total === 0
      ? (state.historyEnabled ? "还没有翻译记录。翻一句就自动存这儿了。" : "历史记录已关闭。可在设置里重新打开。")
      : "没有匹配的记录。";
    historyListEl.append(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.dataset.id = entry.id;

    const src = document.createElement("div");
    src.className = "history-src";
    src.textContent = entry.src;

    const out = document.createElement("div");
    out.className = "history-out";
    out.textContent = entry.out;

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const time = document.createElement("span");
    time.textContent = formatTime(entry.ts);
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-del";
    del.dataset.historyDelete = entry.id;
    del.title = "删除这条";
    del.textContent = "✕";
    meta.append(time, spacer, del);

    item.append(src, out, meta);
    historyListEl.append(item);
  }
}

/** 拉一次历史并渲染。 */
async function refreshHistory() {
  try {
    const result = await api.historyList(historySearchEl.value);
    historyCache = Array.isArray(result?.entries) ? result.entries : [];
    renderHistory(historyCache, Number(result?.total) || 0);
  } catch (error) {
    historyListEl.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = `读取历史失败：${String(error?.message ?? error)}`;
    historyListEl.append(empty);
  }
}

/** 开/关抽屉。打开时每次都重新拉，保证跟刚才的翻译一致。 */
async function setHistoryOpen(open) {
  if (open) {
    await refreshHistory();
    historyDrawerEl.hidden = false;
    // 抽屉一开，把搜索框的键盘焦点给它，直接能搜
    historySearchEl.focus();
  } else {
    historyDrawerEl.hidden = true;
    historySearchEl.value = "";
  }
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

let hintTimer = 0;

/** 一次性提示条（主进程推来的 notice）的自动收掉定时器。 */
let noticeTimer = 0;

/** 提示行平时显示什么：两种模式的快捷键不一样。 */
function defaultHint() {
  return state.mode === "pick" ? "Ctrl+Alt+T 划词" : "Ctrl+Enter";
}

/** @param {string} text */
function flashHint(text) {
  hintEl.textContent = text;
  // 划词模式下按钮行整条隐藏，提示行看不见 —— 借底栏播一下，过一会儿还回去
  if (state.mode === "pick") footNoteEl.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hintEl.textContent = defaultHint();
    if (state.mode === "pick") render(); // 底栏换回引擎状态
  }, HINT_MS);
}

/** 把 KeyboardEvent 拼成 Electron 加速键写法（如 "Control+Alt+T"）。 */
/** @param {KeyboardEvent} event @returns {string} */
function eventToAccelerator(event) {
  const mods = [];
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");

  // 主键：优先 event.code（跟键盘布局无关），映射到 Electron 认的名字
  const code = event.code;
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  else if (code === "Enter") key = "Return";
  else if (code === "Escape") key = "Escape";
  else if (code === "Tab") key = "Tab";
  else if (code === "Backspace") key = "Backspace";
  else if (code === "Delete") key = "Delete";
  else if (code === "Insert") key = "Insert";
  else if (code === "Home") key = "Home";
  else if (code === "End") key = "End";
  else if (code === "PageUp") key = "PageUp";
  else if (code === "PageDown") key = "PageDown";
  else if (code === "ArrowUp") key = "Up";
  else if (code === "ArrowDown") key = "Down";
  else if (code === "ArrowLeft") key = "Left";
  else if (code === "ArrowRight") key = "Right";
  else if (code === "PrintScreen") key = "PrintScreen";
  else if (code === "Minus") key = "-";
  else if (code === "Equal") key = "=";
  else if (code === "Comma") key = ",";
  else if (code === "Period") key = ".";
  else if (code === "Slash") key = "/";
  else if (code === "Semicolon") key = ";";
  else if (code === "Quote") key = "'";
  else if (code === "BracketLeft") key = "[";
  else if (code === "BracketRight") key = "]";
  else if (code === "Backslash") key = "\\";
  else if (code === "Backquote") key = "`";
  else return ""; // 不认识的主键：返回空，让调用方提示"换个键"

  if (key === "") return "";
  return [...mods, key].join("+");
}

/** 进入 / 退出录制热键。@param {boolean} on @param {"pick" | "shot"} [slot] */
function setRecordingHotkey(on, slot = "pick") {
  state.recordingHotkey = on;
  state.recordingSlot = slot;
  const btn = slot === "shot" ? shotHotkeyValueEl : hotkeyValueEl;
  const note = slot === "shot" ? shotHotkeyNoteEl : hotkeyNoteEl;
  const fallbackLabel = slot === "shot" ? "Ctrl+Alt+S" : "Ctrl+Alt+T";
  const stored = slot === "shot" ? state.shotHotkey : state.hotkey;
  btn.dataset.recording = on ? "1" : "0";
  btn.textContent = on ? "按下新快捷键…" : stored?.label ?? fallbackLabel;
  btn.style.color = "";
  if (on) note.hidden = true;
}

/** 用户录完一个组合键，落地成设置。@param {string} accelerator @param {"pick" | "shot"} [slot] */
async function commitHotkey(accelerator, slot = "pick") {
  const note = slot === "shot" ? shotHotkeyNoteEl : hotkeyNoteEl;
  const result = await api.setHotkey(accelerator, slot);
  if (result?.status !== undefined) {
    if (slot === "shot") state.shotHotkey = result.status;
    else state.hotkey = result.status;
  }
  if (result?.ok === true) {
    note.hidden = false;
    note.textContent = "已改好，立刻生效。";
    note.dataset.tone = "ok";
  } else {
    note.hidden = false;
    note.dataset.tone = "warn";
    note.textContent =
      result?.reason === "conflict"
        ? "这个组合被别的软件占着，已经退回原来的键。换一个试试。"
        : result?.reason === "reserved"
          ? "Ctrl+Alt+Delete 是系统保留的，用不了。"
          : result?.reason === "no-modifier"
            ? "至少要带一个 Ctrl / Alt / Shift。"
            : "这个键用不了，换一个试试。";
  }
  setRecordingHotkey(false, slot);
  render();
}

// 点按钮：进入录制；录制中再点一下 = 取消。
hotkeyValueEl.addEventListener("click", () => {
  if (state.recordingHotkey && state.recordingSlot === "pick") {
    setRecordingHotkey(false, "pick");
    render();
    return;
  }
  setRecordingHotkey(true, "pick");
});

shotHotkeyValueEl.addEventListener("click", () => {
  if (state.recordingHotkey && state.recordingSlot === "shot") {
    setRecordingHotkey(false, "shot");
    render();
    return;
  }
  setRecordingHotkey(true, "shot");
});

// 录制时吃掉键盘事件：组合键直接落地，单独按 Esc 取消。
// 用捕获阶段，抢在其它快捷键处理之前。
document.addEventListener(
  "keydown",
  (event) => {
    if (!state.recordingHotkey) return;
    const slot = state.recordingSlot;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape" || event.code === "Esc") {
      setRecordingHotkey(false, slot);
      render();
      return;
    }
    const accelerator = eventToAccelerator(event);
    if (accelerator === "") return; // 只按了修饰键或未知键，等下一个
    // 只按了一个修饰键时 eventToAccelerator 会给出 "Control" 之类，过滤掉
    if (["Control", "Alt", "Shift", "Super"].includes(accelerator)) return;
    commitHotkey(accelerator, slot);
  },
  true,
);

hotkeyEnabledEl.addEventListener("change", async () => {
  const on = hotkeyEnabledEl.checked;
  const result = await api.setHotkeyEnabled(on, "pick");
  if (result?.status !== undefined) state.hotkey = result.status;
  state.hotkeyEnabled = on;
  if (on) {
    hotkeyNoteEl.hidden = false;
    hotkeyNoteEl.dataset.tone = "ok";
    hotkeyNoteEl.textContent = state.hotkey?.ok === false ? "已开启，但这个组合被占用了，换一个。" : "已开启。";
  } else {
    hotkeyNoteEl.hidden = false;
    hotkeyNoteEl.dataset.tone = "ok";
    hotkeyNoteEl.textContent = "已关闭，取词热键不再响应。";
  }
  render();
});

shotHotkeyEnabledEl.addEventListener("change", async () => {
  const on = shotHotkeyEnabledEl.checked;
  const result = await api.setHotkeyEnabled(on, "shot");
  if (result?.status !== undefined) state.shotHotkey = result.status;
  state.shotHotkeyEnabled = on;
  if (on) {
    shotHotkeyNoteEl.hidden = false;
    shotHotkeyNoteEl.dataset.tone = "ok";
    shotHotkeyNoteEl.textContent =
      state.shotHotkey?.ok === false ? "已开启，但这个组合被占用了，换一个。" : "已开启。";
  } else {
    shotHotkeyNoteEl.hidden = false;
    shotHotkeyNoteEl.dataset.tone = "ok";
    shotHotkeyNoteEl.textContent = "已关闭，截图热键不再响应。";
  }
  render();
});

// 面板里的「截图」按钮：和截图热键同一条路
shotStartEl?.addEventListener("click", () => {
  api.startShot();
});

/** @param {"translate" | "settings"} view */
function setView(view) {
  state.view = view;
  render();
}

/* ── 翻译模式 ─────────────────────────────────────────────────────────── */

/** @param {unknown} value @returns {"pick" | "paste"} */
function normalizeMode(value) {
  return value === "paste" ? "paste" : "pick";
}

/** @returns {"pick" | "paste"} */
function readStoredMode() {
  try {
    return normalizeMode(localStorage.getItem(MODE_KEY));
  } catch {
    // 存储被禁（隐私模式之类）：本次照常跑，只是记不住选择
    return "pick";
  }
}

/**
 * 切换翻译模式。
 *
 * 两种模式共用同一块面板、同一个翻译通道，区别只在**显示哪些块**：
 * 划词模式有原文块、没有粘贴框；粘贴模式有粘贴框、没有原文块。
 * @param {"pick" | "paste"} mode
 * @param {{silent?: boolean, focus?: boolean}} [options]
 */
function setMode(mode, options = {}) {
  const next = normalizeMode(mode);
  if (next === state.mode) return;
  state.mode = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    // 同上：存不下就算了，不影响本次使用
  }
  hintEl.textContent = defaultHint();
  render();
  if (next === "paste" && options.focus !== false) draftEl.focus();
  if (options.silent !== true) flashHint(next === "pick" ? "划词模式" : "粘贴模式");
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
    if (result.code === "captcha") return result.detail ?? "DeepSeek 要人机验证了：进设置 → 打开 DeepSeek 窗口过一下验证";
    if (result.code === "no-composer") return "DeepSeek 页面找不到输入框，可能改版了";
    if (result.code === "no-reply") return "消息发出去了，但页面没有回复（可能掉登录或触发风控）";
    if (result.code === "aborted") return "已取消";
    if (result.code === "short-reply") return result.detail ?? "回复异常短，可能被限流了，等十几秒再试";
    if (result.code === "send-failed") return result.detail ?? "消息没发出去，点译文区重试";
    // 加载失败：detail 已经是 describeLoadError 翻好的中文，直接用
    if (typeof result.detail === "string" && result.detail !== "") return result.detail;
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

  // 开始新一次翻译就把上一段朗读掐掉：不然译文已经换新的，喇叭还在念旧的
  if (state.speaking) {
    speech?.stop();
    state.speaking = false;
    state.speakingWho = null;
  }

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

/**
 * 点「翻译」/ Ctrl+Enter。
 *
 * 粘贴模式**不清空输入框**：原文块在粘贴模式下是隐藏的，清空了用户就看不到
 * 自己刚翻的是哪一段。划词模式里输入框看不见，清不清都无所谓，保持老行为。
 */
function submit() {
  const draft = draftEl.value.trim();
  if (state.mode === "paste" && draft !== "") {
    translate(draft);
    return;
  }
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

/**
 * 朗读 / 停止。
 *
 * 三个必须处理的现实情况：
 *   1. 正在读 → 再点一下停（不然长文读起来没法打断）
 *   2. 系统没语音包 → 仍然读（英文语音读中文不会崩），但要提示「发音可能不准」
 *   3. 原文用原文自身的文字判语言；译文按目标语言档位（「自动」时用译文文字判）
 *
 * 原文和译文共用一个语音通道（speechSynthesis 本身就只有一条），所以点哪块就
 * 把另一块正在读的掐掉，谁在读谁那个喇叭变 ⏹。
 *
 * @param {"out" | "src"} who
 */
function toggleSpeak(who = "out") {
  if (speech === null || !speech.supported()) {
    flashHint("这个环境不支持朗读");
    return;
  }
  // 同一块再点 = 停；换一块读 = 先停掉旧的再读新的
  if (state.speaking) {
    speech.stop();
    const wasSame = state.speakingWho === who;
    state.speaking = false;
    state.speakingWho = null;
    render();
    if (wasSame) return;
  }

  const text = who === "src" ? state.source : state.result;
  if (text === "") return;
  // 原文：按原文自身文字判断是什么语言；译文：按目标档位判（auto 时再看译文文字）
  const target = who === "src" ? "auto" : state.target;

  const voices = window.speechSynthesis.getVoices();
  const candidates = speech.langCandidates(target, text);
  const ready = speech.hasVoiceFor(voices, candidates);
  if (who === "out") state.speechReady = ready;

  const result = speech.speak(text, {
    target,
    rate: state.speechRate,
    onEnd: () => {
      state.speaking = false;
      state.speakingWho = null;
      render();
    },
    onError: (reason) => {
      state.speaking = false;
      state.speakingWho = null;
      render();
      flashHint(`朗读失败：${reason}`);
    },
  });
  if (result.ok !== true) {
    flashHint(result.reason === "empty" ? "没有可朗读的内容" : "朗读没启动起来");
    return;
  }
  state.speaking = true;
  state.speakingWho = who;
  render();
  if (!ready) flashHint("系统没装该语言的语音包，读音可能不准（设置 → 时间和语言 → 语音）");
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
  // 档位来自主进程（src/shared/scales.cjs），和右键菜单、托盘共用同一份，
  // 别在这儿再写死一遍。
  const values = state.scales;
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
speakEl.addEventListener("click", () => toggleSpeak("out"));
speakSrcEl.addEventListener("click", () => toggleSpeak("src"));

// 语速：拖动时本地生效，松手才落盘（跟字号一个套路，避免拖一次落几十次盘）
speechRateEl.addEventListener("input", () => {
  state.speechRate = Number(speechRateEl.value);
  speechRateValueEl.textContent = `${state.speechRate.toFixed(1)}x`;
});
speechRateEl.addEventListener("change", async () => {
  const result = await api.setSpeechRate(Number(speechRateEl.value));
  if (typeof result?.speechRate === "number") {
    state.speechRate = result.speechRate;
    speechRateEl.value = String(result.speechRate);
    speechRateValueEl.textContent = `${result.speechRate.toFixed(1)}x`;
  }
});

// 模式切换按钮。data-mode 就是目标模式，点谁切谁
for (const button of modeButtons) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

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

// 字号：拖动时先本地生效（不卡手），松手才落盘 —— 拖一次滑块会触发几十个 input
outFontEl.addEventListener("input", () => applyOutFont(Number(outFontEl.value)));
outFontEl.addEventListener("change", async () => {
  const result = await api.setFontSize(Number(outFontEl.value));
  if (typeof result?.outFontSize === "number") applyOutFont(result.outFontSize);
});

eyesFollowEl.addEventListener("change", async () => {
  const result = await api.setEyesFollow(eyesFollowEl.checked);
  state.eyesFollow = result?.enabled === true;
  render();
});

eyesVisibleEl.addEventListener("change", async () => {
  const result = await api.setEyesVisible(eyesVisibleEl.checked);
  state.eyesVisible = result?.enabled === true;
  render();
});

mouthVisibleEl.addEventListener("change", async () => {
  const result = await api.setMouthVisible(mouthVisibleEl.checked);
  state.mouthVisible = result?.enabled === true;
  render();
});

idleGesturesEl.addEventListener("change", async () => {
  const result = await api.setIdleGestures(idleGesturesEl.checked);
  state.idleGestures = result?.enabled === true;
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
    speech?.stop();
    state.speaking = false;
    state.speakingWho = null;
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
  if (action === "close") {
    // 关面板时把朗读一起停掉：否则窗口都没了声音还在念，很吓人
    speech?.stop();
    state.speaking = false;
    state.speakingWho = null;
    api.close();
  } else if (action === "settings") setView("settings");
  else if (action === "back") setView("translate");
  else if (action === "login") {
    api.showDeepSeek();
    flashHint("已打开网页窗口，请在那里登录");
  } else if (action === "reset-session") resetSession();
  else if (action === "history") setHistoryOpen(true);
  else if (action === "close-history") setHistoryOpen(false);
  else if (action === "retry") {
    // 断网/超时后点重试：先把这条提示压下去，再重新探一次后端状态。
    // 真实的重连由下一次翻译触发（open() 会重新 loadURL），这里只给即时反馈。
    if (state.banner !== null) state.dismissedBanners.add(state.banner.key);
    renderBanner();
    flashHint("正在重试…");
    api.engineStatus().then((status) => {
      if (status === null || status === undefined) return;
      state.engine = { ...(state.engine ?? {}), status: status.status, detail: status.detail, code: status.code };
      // 换了一轮，之前的「已忽略」清掉，让新的失败还能再弹出来
      state.dismissedBanners.clear();
      render();
    });
  }
});

// 提示条上的叉：记住这一条别再弹
bannerCloseEl.addEventListener("click", () => {
  if (state.banner !== null) state.dismissedBanners.add(state.banner.key);
  renderBanner();
});

/* ── 历史抽屉的交互 ───────────────────────────────────────────────────── */

// 点一条历史：回填原文 + 直接重译。
// 抽屉本身不关 —— 用户可能是想连着看几条，关了他还得再点开。
historyListEl.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target === null) return;

  const delId = target.closest("[data-history-delete]")?.getAttribute("data-history-delete");
  if (delId !== null && delId !== undefined) {
    event.stopPropagation();
    api.historyRemove(delId).then((result) => {
      renderHistory(result?.entries ?? [], Number(result?.total) || 0);
    });
    return;
  }

  const item = target.closest("[data-id]");
  if (item === null) return;
  const id = item.getAttribute("data-id");
  const entry = historyCache.find((row) => row.id === id);
  if (entry === undefined) return;
  // 回填就是「当成一次新的翻译请求」：切到划词模式显示原文，再翻一遍拿最新结果
  setMode("pick", { silent: true, focus: false });
  setHistoryOpen(false);
  translate(entry.src);
});

// 搜索：输入即过滤（本地已经在内存里，不用等网络）
historySearchEl.addEventListener("input", () => {
  refreshHistory();
});

// 清空：二次确认
historyClearEl.addEventListener("click", async () => {
  const ok = window.confirm("清空全部翻译历史？这条操作没法撤销。");
  if (!ok) return;
  const result = await api.historyClear();
  renderHistory(result?.entries ?? [], 0);
  flashHint("历史已清空");
});

// 设置里的历史开关
historyEnabledEl.addEventListener("change", async () => {
  const result = await api.setHistoryEnabled(historyEnabledEl.checked);
  state.historyEnabled = result?.enabled === true;
  if (!state.historyEnabled) {
    flashHint("已关闭历史记录，并清空了已有记录");
  }
  render();
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
  // 热键取到词了 → 一定是划词场景。用户可能正停在粘贴模式，这里顺手切回来，
  // 否则原文块被隐藏，面板上只剩译文、看起来像丢了东西
  setMode("pick", { silent: true, focus: false });
  setView("translate");
  translate(text);
});

api.onEngineStatus((status) => {
  if (status === null || status === undefined) return;
  state.engine = {
    ...(state.engine ?? {}),
    status: status.status,
    detail: status.detail,
    code: status.code,
  };
  render();
});

// 主进程主动弹的提示（比如第二次双击 exe 时告诉你「已经在运行了」）。
// 这是一次性的，只闪一下：不写进 state.banner，免得被下一次 render 冲掉或反过来粘住。
api.onNotice((notice) => {
  if (notice === null || notice === undefined) return;
  const text = String(notice.text ?? "");
  if (text === "") return;
  bannerEl.hidden = false;
  bannerEl.dataset.tone = String(notice.tone ?? "info");
  bannerTextEl.textContent = text;
  bannerActionEl.hidden = true;
  delete bannerActionEl.dataset.action;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    // 到点收掉，并把控制权还给「按后端状态自动决定的提示条」
    render();
  }, 2600);
});

// OCR 失败（框选没字 / 引擎没起来）：用错误块说清楚，别让用户以为程序坏了。
api.onOcrFailed((payload) => {
  const reason = String(payload?.reason ?? "");
  let message;
  if (reason === "engine-missing") {
    message = "本地 OCR 引擎没能启动。请重启程序再试；如果反复出现，把日志（%APPDATA%\\pet-translator-desktop\\app.log）发给开发者。";
  } else if (reason === "ocr-failed") {
    message = "这块区域没识别出文字。可能是字太小、对比度太低，或者根本没有文字。框小一点、只框文字本身再试。";
  } else {
    message = "这块区域没识别出文字，换一块再试试。";
  }
  if (typeof setError === "function") setError(message);
  else flashHint(message);
});

/* ── 启动 ─────────────────────────────────────────────────────────────── */

api.info().then((info) => {
  if (typeof info?.scale === "number") state.scale = info.scale;
  if (Array.isArray(info?.scales) && info.scales.length > 0) state.scales = info.scales;
  if (typeof info?.maxSource === "number") state.maxSource = info.maxSource;
  if (Array.isArray(info?.targets) && info.targets.length > 0) state.targets = info.targets;
  if (info?.engine !== undefined) state.engine = info.engine;
  if (info?.hotkey !== undefined) state.hotkey = info.hotkey;
  if (typeof info?.hotkeyEnabled === "boolean") state.hotkeyEnabled = info.hotkeyEnabled;
  if (info?.shotHotkey !== undefined) state.shotHotkey = info.shotHotkey;
  if (typeof info?.shotHotkeyEnabled === "boolean") state.shotHotkeyEnabled = info.shotHotkeyEnabled;
  if (info?.autostart !== undefined) state.autostart = info.autostart;
  if (info?.disableGpu !== undefined) state.disableGpu = info.disableGpu === true;
  if (typeof info?.panelColor === "string") state.panelColor = info.panelColor;
  if (typeof info?.panelOpacity === "number") state.panelOpacity = info.panelOpacity;
  if (typeof info?.ballColor === "string") state.ballColor = info.ballColor;
  if (typeof info?.textColor === "string") state.textColor = info.textColor;
  if (typeof info?.outFontSize === "number") applyOutFont(info.outFontSize);
  if (typeof info?.speechRate === "number") {
    state.speechRate = info.speechRate;
    speechRateEl.value = String(info.speechRate);
    speechRateValueEl.textContent = `${info.speechRate.toFixed(1)}x`;
  }
  if (typeof info?.historyEnabled === "boolean") {
    state.historyEnabled = info.historyEnabled;
    historyEnabledEl.checked = info.historyEnabled;
  }
  if (typeof info?.eyesFollow === "boolean") state.eyesFollow = info.eyesFollow;
  if (typeof info?.eyesVisible === "boolean") state.eyesVisible = info.eyesVisible;
  if (typeof info?.mouthVisible === "boolean") state.mouthVisible = info.mouthVisible;
  if (typeof info?.idleGestures === "boolean") state.idleGestures = info.idleGestures;

  // 上次选的模式：先落属性再首次渲染，避免界面先闪一下另一种布局
  state.mode = readStoredMode();
  root.dataset.mode = state.mode;
  hintEl.textContent = defaultHint();

  fillTargets();
  fillScales();
  buildPresets();
  applyPanelLook(state.panelColor, state.panelOpacity);
  applyTextLook();
  render();

  // 语音包探测：Windows 上语音包经常没装，先探明白，好决定要不要提示用户。
  // 这里**只判「有没有任何语音包」**，不判具体语言 —— 启动时还没有译文，
  // 拿空文本去判语言会一律判成英文，说反话。具体语言是否齐全，点朗读时才判。
  if (speech !== null && speech.supported()) {
    speech.loadVoices().then((voices) => {
      state.speechReady = voices.length > 0;
      if (voices.length === 0) {
        speechNoteEl.hidden = false;
        speechNoteEl.textContent = "系统里一个语音包都没有，朗读会没声音。Windows：设置 → 时间和语言 → 语音 → 添加语音。";
      } else {
        speechNoteEl.hidden = true;
      }
      render();
    });
  }

  console.log(`[panel] ready engine=${state.engine?.id ?? "?"}`);
});
