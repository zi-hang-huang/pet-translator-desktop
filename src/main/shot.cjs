/**
 * 截图框选：抓一块屏幕区域，交给 OCR。
 *
 * 流程：
 *   1. 先抓屏（此时还没铺窗口，所以抓到的画面里不会出现自己的遮罩）
 *   2. 铺一个占满该屏幕的全屏透明窗口，把截图当背景、调暗、让用户拖一个框
 *   3. 拿到选框（CSS px == DIP），按屏幕缩放比换算成物理像素裁剪
 *   4. 存成临时 png，返回路径
 *
 * 为什么自己抓屏、不用 clipboard.readImage：这个 Electron 构建里
 * `clipboard.readImage` 根本不存在（和 pickup.cjs 注释里那批剪贴板怪癖同源），
 * 所以「用户自己截图复制、再按热键」这条路走不通，只能由本模块自己截。
 */

const { BrowserWindow, desktopCapturer, nativeImage, screen } = require("electron");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { writeFileSync, unlinkSync, existsSync } = require("node:fs");

/** 截图窗口的预加载脚本。 */
const PRELOAD = join(__dirname, "..", "preload", "shot.cjs");

/** 一次框选最多等这么久（用户发呆也要有个上限）。 */
const SELECT_TIMEOUT_MS = 60000;

/** 选框任一边小于它，就当作误触，不当选区。 */
const MIN_SELECTION = 8;

const state = {
  /** @type {BrowserWindow | undefined} */
  window: undefined,
  /** 正在进行的框选（防重入）。 */
  busy: false,
  /** 本次要用的物理像素裁剪数据。 */
  capture: /** @type {{ dataUrl: string, scaleFactor: number, bounds: Electron.Rectangle } | null} */ (null),
  resolve: /** @type {((value: any) => void) | null} */ (null),
  tempPaths: /** @type {string[]} */ ([]),
};

/** 生成临时 png 路径并登记，退出时统一删。 */
function tempPath() {
  const path = join(tmpdir(), `pet-tr-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  state.tempPaths.push(path);
  return path;
}

/**
 * 抓一块屏幕（物理分辨率），返回 { dataUrl, scaleFactor, bounds }。
 * @param {Electron.Display} display
 */
async function captureDisplay(display) {
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  // 优先按 display_id 精确匹配；拿不到就退而求其次取第一块屏
  let source = sources.find((item) => String(item.display_id) === String(display.id));
  if (source === undefined) source = sources[0];
  if (source === undefined) throw new Error("抓不到屏幕画面");
  return {
    dataUrl: source.thumbnail.toDataURL(),
    scaleFactor: display.scaleFactor,
    bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
  };
}

/**
 * 打开一次框选。成功返回 { ok, imagePath, rect }；用户取消返回 { ok:false, reason:"cancel" }。
 * @returns {Promise<{ok: boolean, imagePath?: string, rect?: object, reason?: string}>}
 */
async function selectRegion() {
  if (state.busy) return { ok: false, reason: "busy" };
  state.busy = true;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  try {
    const capture = await captureDisplay(display);
    state.capture = capture;

    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    state.window = window;
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    return await new Promise((resolve) => {
      state.resolve = resolve;

      // 用户关窗口（Esc 由渲染层发 cancel）-> 取消
      window.on("closed", () => {
        if (state.resolve) {
          state.resolve = null;
          cleanup();
          resolve({ ok: false, reason: "cancel" });
        }
      });

      state.timer = setTimeout(() => {
        if (state.resolve) settle({ ok: false, reason: "timeout" });
      }, SELECT_TIMEOUT_MS);

      window.loadFile(join(__dirname, "..", "ui", "shot.html"));
      window.once("ready-to-show", () => {
        window.show();
        window.focus();
      });
      window.webContents.on("did-finish-load", () => {
        // 把截图和缩放比交给渲染层去铺背景
        window.webContents.send("shot:init", {
          dataUrl: capture.dataUrl,
          scaleFactor: capture.scaleFactor,
        });
      });
    });
  } catch (error) {
    cleanup();
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 渲染层报告选框（CSS px，相对窗口左上角）。主进程裁剪并落盘，然后结束本次框选。
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @returns {Promise<{ok: boolean, imagePath?: string, rect?: object, reason?: string}>}
 */
async function commitSelection(rect) {
  const capture = state.capture;
  if (capture === null) {
    settle({ ok: false, reason: "no-capture" });
    return { ok: false, reason: "no-capture" };
  }

  const width = Math.max(0, Math.round(Number(rect?.width) || 0));
  const height = Math.max(0, Math.round(Number(rect?.height) || 0));
  if (width < MIN_SELECTION || height < MIN_SELECTION) {
    settle({ ok: false, reason: "too-small" });
    return { ok: false, reason: "too-small" };
  }

  const scale = capture.scaleFactor;
  const cropX = Math.max(0, Math.round(Number(rect?.x) * scale));
  const cropY = Math.max(0, Math.round(Number(rect?.y) * scale));
  const cropW = Math.round(width * scale);
  const cropH = Math.round(height * scale);

  const image = nativeImage.createFromDataURL(capture.dataUrl);
  if (image.isEmpty()) {
    settle({ ok: false, reason: "empty-image" });
    return { ok: false, reason: "empty-image" };
  }

  const size = image.getSize();
  // 夹进图像边界，防止用户把框拖出屏幕导致 crop 抛错
  const boundedX = Math.min(cropX, Math.max(0, size.width - 1));
  const boundedY = Math.min(cropY, Math.max(0, size.height - 1));
  const boundedW = Math.max(1, Math.min(cropW, size.width - boundedX));
  const boundedH = Math.max(1, Math.min(cropH, size.height - boundedY));

  const cropped = image.crop({ x: boundedX, y: boundedY, width: boundedW, height: boundedH });
  const path = tempPath();
  writeFileSync(path, cropped.toPNG());

  const result = { ok: true, imagePath: path, rect: { x: boundedX, y: boundedY, width: boundedW, height: boundedH } };
  settle(result);
  return result;
}

/**
 * 结束本次框选：把结果交给等待中的 selectRegion 的 promise，然后（下一拍）清理窗口。
 *
 * 清理必须延后一个 tick：`shot:commit` 是个 ipc handle，如果在这里同步 destroy 窗口，
 * 回复还没发回渲染层 webContents 就没了，Electron 会报 "WebContents was destroyed"。
 * 等一拍让 IPC 回复先落地。
 * @param {object} value
 */
function settle(value) {
  const resolve = state.resolve;
  state.resolve = null;
  if (resolve) resolve(value);
  setTimeout(cleanup, 0);
}

/** 用户取消（Esc / 右键 / 窗口关闭）。 */
function cancel() {
  if (state.resolve) settle({ ok: false, reason: "cancel" });
}

/** 收掉窗口、清掉定时器、清掉临时图。 */
function cleanup() {
  const window = state.window;
  state.window = undefined;
  state.capture = null;
  state.resolve = null;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.busy = false;
  try {
    if (window !== undefined && !window.isDestroyed()) window.destroy();
  } catch {
    // 已经没了
  }
  // 删掉上一轮遗留的临时图（保留最新的那张给调用方用，所以删到只剩最后 1 张）
  try {
    while (state.tempPaths.length > 1) {
      const old = state.tempPaths.shift();
      if (old && existsSync(old)) unlinkSync(old);
    }
  } catch {
    // 删不掉就算了，系统临时目录会自己清
  }
}

/** 退出时清空全部临时图。 */
function dispose() {
  cleanup();
  try {
    for (const path of state.tempPaths) {
      if (existsSync(path)) unlinkSync(path);
    }
  } catch {
    // 忽略
  }
  state.tempPaths = [];
}

module.exports = { selectRegion, commitSelection, cancel, dispose };
