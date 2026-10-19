/**
 * 设置持久化。
 *
 * 一个 JSON 文件，读写都是同步的 —— 文件才几百字节，调用的地方都是低频事件
 * （拖完手、松开拖拽把手、退出），没必要为了异步把调用点搞得到处是 await。
 *
 * 写盘用「临时文件 + rename」：直接覆写的话，断电或强杀进程会留下一个
 * 半截 JSON，下次启动位置就丢了。
 */

const { app } = require("electron");
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** 缺省值。`x`/`y` 为 null 表示「还没拖过，按屏幕右下角摆」。 */
const DEFAULTS = Object.freeze({
  /** 球窗口左上角，屏幕 DIP 坐标。 */
  x: null,
  y: null,
  /** 球直径相对基准的倍数，0.6 ~ 1.8。 */
  scale: 1,
  /** 是否常驻置顶（托盘菜单可切）。 */
  pinned: true,
  /** 全局取词热键（M4 用）。 */
  hotkey: "Ctrl+Alt+T",
  /** 目标语言（M3 用）。 */
  target: "auto",
  /** 复用的 DeepSeek 专用会话地址（空表示还没建，按新对话处理）。 */
  sessionUrl: "",
  /** 开机自启。默认关 —— 装完不打招呼就往启动项里写，是很讨厌的行为。 */
  launchAtLogin: false,
  /** 关掉硬件加速。透明窗口在某些显卡/远程桌面上会出黑边，这是唯一的兜底开关（重启生效）。 */
  disableGpu: false,
  /** 面板底色（十六进制）。默认就是设计稿那个深色。 */
  panelColor: "#161a22",
  /** 面板不透明度（百分比 55~100）。默认 100 = 完全不透明。 */
  panelOpacity: 100,
  /** 球的颜色。默认就是设计稿那个蓝；改了会按比例派生出高光和暗部。 */
  ballColor: "#3a8dff",
  /** 正文颜色。默认就是设计稿那个浅灰蓝；改了会派生出强调/次级/弱化三档。 */
  textColor: "#e8ecf4",
  /** 眼睛跟着鼠标看。 */
  eyesFollow: true,
  /**
   * 面板窗口的左上角（null = 还没拖过，第一次打开时按球的位置摆）。
   *
   * 这两个键**必须**在 DEFAULTS 里：`write()` 会丢掉不认识的键，
   * 少写一次就等于面板位置永远存不下来 —— 表现是"每次点球翻译，面板都跳回原位"。
   */
  panelX: null,
  panelY: null,
  /**
   * 面板本体尺寸（CSS px，不含四周投影留白）。null = 用默认 340×470。
   *
   * 和 panelX/panelY 一样**必须**列在 DEFAULTS 里：`write()` 会丢掉不认识的键，
   * 少写一次就等于拖出来的尺寸永远存不下来，下次开面板又变回 340×470。
   */
  panelWidth: null,
  panelHeight: null,
});

/** @returns {string} 设置文件路径。 */
function settingsPath() {
  return join(app.getPath("userData"), "settings.json");
}

/** @returns {Record<string, unknown>} 磁盘上的设置，缺字段用默认值补齐。 */
function read() {
  try {
    // 去掉 BOM：记事本、部分编辑器保存 UTF-8 会带 U+FEFF，JSON.parse 遇到它直接抛错，
    // 而我们的 catch 会把设置悄悄重置成默认值 —— 用户只会觉得「位置又忘了」。
    const text = readFileSync(settingsPath(), "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...raw };
  } catch {
    // 文件不存在、或上次写坏了：用默认值重来，不让启动失败
    return { ...DEFAULTS };
  }
}

/**
 * 合并写入若干字段。
 * 只保留 DEFAULTS 里认识的键：版本升级后删掉的字段不该继续躺在磁盘上。
 * @param {Record<string, unknown>} patch - 要改的字段。
 * @returns {Record<string, unknown>} 合并后的完整设置。
 */
function write(patch) {
  const merged = { ...read(), ...patch };
  const next = {};
  for (const key of Object.keys(DEFAULTS)) next[key] = merged[key];
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    const target = settingsPath();
    const temporary = target + ".tmp";
    writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    renameSync(temporary, target);
  } catch (error) {
    // 存不下不是致命错误，球的本次会话照常
    console.warn("pet-tr: settings not saved:", String(error));
  }
  return next;
}

/** @returns {Record<string, unknown>} 默认值（只读用途）。 */
function defaults() {
  return { ...DEFAULTS };
}

module.exports = { read, write, defaults, settingsPath };
