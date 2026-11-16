/**
 * 全局热键（多槽位）。
 *
 * 现在有两件事各要一个热键：
 *   - `pick`：选中文字 → 直接翻译（Ctrl+Alt+T）
 *   - `shot`：框选屏幕 → OCR → 翻译（Ctrl+Alt+S）
 *
 * 所以按「槽位（slot）」分别管理，互不影响：改 `shot` 的键不会碰 `pick` 的。
 *
 * 「是否成功」必须报告出去：`Ctrl+Alt+T` 是常用组合，被别的软件占了的概率不低，
 * 而 `globalShortcut.register` 只是安静地返回 false —— 不告诉用户，他会以为
 * 程序坏了，按半天没反应。
 */

const { globalShortcut } = require("electron");

/** 每个槽位自己的状态。 */
const slots = {
  pick: { accelerator: "", ok: false, enabled: true, lastGood: "" },
  shot: { accelerator: "", ok: false, enabled: true, lastGood: "" },
};

/** 取某个槽位，未知的按 pick 处理（向后兼容老调用）。 */
function slotOf(name) {
  return slots[name] ?? slots.pick;
}

/**
 * 规整 Electron 加速键的写法：修饰键统一成 Control/Alt/Shift，主键大写。
 * 输入可以混着写（"ctrl+alt+t"、"Ctrl+Alt+T"），输出统一成 "Control+Alt+T"。
 * @param {string} raw @returns {string} 规整后的写法（无法识别时原样返回去掉空白）
 */
function normalize(raw) {
  const parts = String(raw ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return "";
  const mods = [];
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmdorctrl" || lower === "commandorcontrol") {
      if (!mods.includes("Control")) mods.push("Control");
    } else if (lower === "alt" || lower === "option") {
      if (!mods.includes("Alt")) mods.push("Alt");
    } else if (lower === "shift") {
      if (!mods.includes("Shift")) mods.push("Shift");
    } else if (lower === "super" || lower === "cmd" || lower === "meta" || lower === "win" || lower === "windows") {
      if (!mods.includes("Super")) mods.push("Super");
    } else {
      // 剩下的部分当主键：单个字母/数字/F1-F24 大写，其余（如 PrintScreen）原样
      key = /^[a-z]$/i.test(part) || /^f([1-9]|1[0-9]|2[0-4])$/i.test(part) ? part.toUpperCase() : part;
    }
  }
  if (key === "") return "";
  return [...mods, key].join("+");
}

/**
 * 判断一个加速键能不能拿来当热键。
 *
 * 拦三类：空 / 没有修饰键（单独的字母会吃掉全局输入）/ 只有修饰键没有主键。
 * 顺带挡掉和 `Ctrl+Alt+Delete` 这种系统保留组合撞车的（Windows 抢不到，注册必失败）。
 * @param {string} accelerator @returns {{ok: boolean, reason?: string}}
 */
function validate(accelerator) {
  const normalized = normalize(accelerator);
  if (normalized === "") return { ok: false, reason: "empty" };
  const parts = normalized.split("+");
  const hasModifier = parts.some((part) => ["Control", "Alt", "Shift", "Super"].includes(part));
  if (!hasModifier) return { ok: false, reason: "no-modifier" };
  if (parts.length < 2) return { ok: false, reason: "no-modifier" };
  // Windows 系统保留：Ctrl+Alt+Del 注册不上，提前给个准话
  if (normalized === "Control+Alt+Delete") return { ok: false, reason: "reserved" };
  return { ok: true };
}

/**
 * 注册（先释放该槽位旧的）。传空字符串表示「关闭该槽位热键」。
 * @param {string} accelerator - Electron 加速键写法，如 "Control+Alt+T"。空串 = 关闭。
 * @param {() => void} handler
 * @param {"pick" | "shot"} [slot] - 槽位，默认 pick（兼容原有调用）
 * @returns {boolean} 是否注册成功（关闭时恒为 true）。
 */
function register(accelerator, handler, slot = "pick") {
  const state = slotOf(slot);
  unregister(slot);
  const wanted = normalize(accelerator);
  if (wanted === "") {
    // 显式关闭：不注册，但记住这是「关」而不是「失败」
    state.accelerator = "";
    state.enabled = false;
    state.ok = true;
    return true;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(wanted, handler);
  } catch {
    ok = false;
  }
  state.accelerator = wanted;
  state.enabled = true;
  state.ok = ok;
  if (ok) state.lastGood = wanted;
  return ok;
}

/** 释放某个槽位的热键（不传则只释放 pick，保持老行为）。 */
function unregister(slot = "pick") {
  const state = slotOf(slot);
  if (state.accelerator === "") return;
  try {
    globalShortcut.unregister(state.accelerator);
  } catch {
    // 已经没了
  }
  state.ok = false;
}

/** Electron 的写法给用户看太啰嗦：Control+Alt+T → Ctrl+Alt+T。 */
function toLabel(accelerator) {
  return String(accelerator ?? "")
    .replace(/Control/g, "Ctrl")
    .replace(/Super/g, "Win");
}

/**
 * 某个槽位的状态。
 * @param {"pick" | "shot"} [slot]
 * @returns {{accelerator: string, ok: boolean, label: string, enabled: boolean, lastGood: string}}
 */
function status(slot = "pick") {
  const state = slotOf(slot);
  return {
    accelerator: state.accelerator,
    ok: state.ok,
    label: state.accelerator === "" ? "未设置" : toLabel(state.accelerator),
    enabled: state.enabled,
    lastGood: state.lastGood,
  };
}

/** 退出时全部释放。 */
function dispose() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // 已经在退出了
  }
  for (const state of Object.values(slots)) state.ok = false;
}

module.exports = { register, unregister, status, dispose, normalize, validate, toLabel };
