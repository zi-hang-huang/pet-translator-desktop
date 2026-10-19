/**
 * 托盘。
 *
 * 球没有任务栏按钮（`skipTaskbar`），托盘是它唯一的「正式入口」——
 * 关掉球、改缩放、退出，都得从这里走，所以托盘必须在球之后立刻建起来，
 * 且任何一项失败都不能连累球的显示。
 *
 * 菜单不预挂到 `setContextMenu`：Windows 上那样会在左键点击时直接弹菜单，
 * 和「点球显隐」的直觉冲突。这里改成自己 popUp，左右键行为一致。
 */

const { Menu, Tray, app, nativeImage } = require("electron");
const { join } = require("node:path");
const ball = require("./ball-window.cjs");

/** 面板的钩子，由 index.cjs 注入（托盘不该直接依赖面板模块）。 */
const hooks = {
  toggle: /** @type {(() => void) | null} */ (null),
  isOpen: /** @type {(() => boolean) | null} */ (null),
};

/**
 * @param {{togglePanel: () => void, panelOpen: () => boolean}} value
 */
function setPanelHooks(value) {
  hooks.toggle = value.togglePanel;
  hooks.isOpen = value.panelOpen;
}

/** 托盘图标目录。`assets/` 在项目根，比 `src/` 高两层。 */
const ICON_DIR = join(__dirname, "..", "..", "assets", "tray");

/** @type {Tray | undefined} */
let tray;

/**
 * @returns {import("electron").NativeImage} 32px 图标。
 * Windows 会按 DPI 自己挑尺寸；只给 16 在高 DPI 下会糊。
 */
function icon() {
  const image = nativeImage.createFromPath(join(ICON_DIR, "tray-32.png"));
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

/** 组装菜单（每次都重建，勾选状态才是当前值）。 */
function buildMenu() {
  const snap = ball.snapshot();
  const scales = [0.6, 0.8, 1, 1.2, 1.5, 1.8];
  return Menu.buildFromTemplate([
    {
      label: snap.visible ? "隐藏球" : "显示球",
      click: () => ball.toggle(),
    },
    {
      // 面板不再靠点球开关（点球现在是"取词并翻译"），给它一个明确入口
      label: hooks.isOpen?.() === true ? "收起面板" : "打开面板",
      click: () => hooks.toggle?.(),
    },
    {
      label: "常驻置顶",
      type: "checkbox",
      checked: snap.pinned,
      click: (item) => ball.applyPinned(item.checked),
    },
    {
      label: "缩放",
      submenu: scales.map((value) => ({
        label: `${value.toFixed(1)}x`,
        type: "radio",
        checked: Math.abs(snap.scale - value) < 0.001,
        click: () => ball.applyScale(value),
      })),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        ball.allowClose();
        app.quit();
      },
    },
  ]);
}

/**
 * 建托盘。失败时只记一条日志 —— 托盘没了球还能用，不该让应用起不来。
 * @returns {Tray | undefined}
 */
function create() {
  try {
    tray = new Tray(icon());
    tray.setToolTip("翻译球");
    tray.on("click", () => tray?.popUpContextMenu(buildMenu()));
    tray.on("right-click", () => tray?.popUpContextMenu(buildMenu()));
    return tray;
  } catch (error) {
    console.warn("pet-tr: tray unavailable:", String(error));
    return undefined;
  }
}

/** @returns {boolean} 托盘是否建起来了。 */
function exists() {
  return tray !== undefined && !tray.isDestroyed();
}

/** 销毁托盘（退出时调用）。 */
function destroy() {
  if (exists()) tray.destroy();
  tray = undefined;
}

module.exports = { create, exists, destroy, buildMenu, setPanelHooks };
