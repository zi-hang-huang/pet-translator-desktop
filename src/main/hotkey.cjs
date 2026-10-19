/**
 * 全局热键。
 *
 * 只做三件事：注册一个、报告是否成功、退出时释放。
 *
 * 「是否成功」必须报告出去：`Ctrl+Alt+T` 是常用组合，被别的软件占了的概率不低，
 * 而 `globalShortcut.register` 只是安静地返回 false —— 不告诉用户，他会以为
 * 程序坏了，按半天没反应。
 */

const { globalShortcut } = require("electron");

const state = {
  accelerator: "",
  ok: false,
};

/**
 * 注册（先释放旧的）。
 * @param {string} accelerator - Electron 加速键写法，如 "Control+Alt+T"。
 * @param {() => void} handler
 * @returns {boolean} 是否注册成功。
 */
function register(accelerator, handler) {
  unregister();
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, handler);
  } catch {
    ok = false;
  }
  state.accelerator = accelerator;
  state.ok = ok;
  return ok;
}

/** 释放当前热键。 */
function unregister() {
  if (state.accelerator === "") return;
  try {
    globalShortcut.unregister(state.accelerator);
  } catch {
    // 已经没了
  }
  state.ok = false;
}

/** @returns {{accelerator: string, ok: boolean, label: string}} */
function status() {
  return {
    accelerator: state.accelerator,
    ok: state.ok,
    // Electron 的写法给用户看太啰嗦
    label: state.accelerator.replace(/Control/g, "Ctrl"),
  };
}

/** 退出时全部释放。 */
function dispose() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // 已经在退出了
  }
  state.ok = false;
}

module.exports = { register, unregister, status, dispose };
