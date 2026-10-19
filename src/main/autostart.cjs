/**
 * 开机自启。
 *
 * 默认是**关**的。开机自启是那种「装了不打招呼就常驻」的典型骚扰来源，
 * 所以它必须由用户显式打开，且随时能关。
 *
 * 只在打包版里真正生效：开发时 `process.execPath` 是 electron.exe，
 * 把那个写进启动项，用户下次开机就会看到一个空白的 Electron 窗口。
 */

const { app } = require("electron");
const store = require("./store.cjs");

/**
 * 把设置里的值应用到系统。
 * @returns {{enabled: boolean, applied: boolean, reason?: string}}
 */
function apply() {
  const enabled = store.read().launchAtLogin === true;

  if (!app.isPackaged) {
    // 开发期不碰注册表，只回一句"没应用"
    return { enabled, applied: false, reason: "开发模式不写启动项，打包后才生效" };
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // 不传 args：打包后 execPath 就是本程序，不需要额外参数
      path: process.execPath,
      args: [],
    });
    return { enabled, applied: true };
  } catch (error) {
    return { enabled, applied: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 改设置并立即应用。
 * @param {boolean} enabled
 * @returns {{enabled: boolean, applied: boolean, reason?: string}}
 */
function set(enabled) {
  store.write({ launchAtLogin: enabled === true });
  return apply();
}

/** @returns {{enabled: boolean, applied: boolean, packaged: boolean, reason?: string}} */
function status() {
  const result = apply();
  return { ...result, packaged: app.isPackaged === true };
}

module.exports = { apply, set, status };
