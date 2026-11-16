/**
 * 截图框选：抓一块屏幕区域，交给 OCR。
 *
 * 流程：
 *   1. 先抓屏（此时还没铺窗口，所以抓到的画面里不会出现自己的遮罩）
 *   2. 铺一个占满该屏幕的全屏透明窗口，把截图当背景、调暗、让用户拖一个框
 *   3. 拿到选框（CSS px），按「截图实际像素 ÷ 视口实际尺寸」逐轴换算成物理像素裁剪
 *   4. 存成临时 png，返回路径
 *
 * 为什么不再用 display.scaleFactor 换算（曾经导致「框选的图偏上」）：
 *   Windows 上按 display.bounds 建的无边框窗口，高度会被系统**夹到工作区**
 *   （1440×900 的屏，任务栏占 48px，窗口实际只有 1440×852，innerHeight=852）。
 *   可 desktopCapturer 仍按 display.size×scaleFactor 抓到 2880×1800 的整屏图。
 *   于是「每 CSS 像素 = 多少物理像素」在纵向其实是 1800/852 = 2.11，不是 2；
 *   仍按 2 去裁，就会越往下框、裁到的内容越偏上。
 *   现在改为**直接量出来**：cropScaleX = imageW / viewW、cropScaleY = imageH / viewH，
 *   无论窗口被夹成多大、有没有被拉伸，裁剪都和用户看到的画面严丝合缝。
 *   另外建窗后强制 setBounds 到整屏，保证用户能框到最底部（任务栏那一条）。
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
  capture: /** @type {{ dataUrl: string, scaleFactor: number, imageWidth: number, imageHeight: number, viewWidth: number, viewHeight: number, bounds: Electron.Rectangle } | null} */ (null),
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
  const size = source.thumbnail.getSize();
  return {
    dataUrl: source.thumbnail.toDataURL(),
    scaleFactor: display.scaleFactor,
    // 截图的**实际**像素尺寸 —— 裁剪时以它为准，不再假设等于 size×scaleFactor
    imageWidth: size.width,
    imageHeight: size.height,
    viewWidth: 0,
    viewHeight: 0,
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
        // Windows 会把无边框窗口高度夹到工作区（任务栏那一截上不去）。
        // 建好后强行 setBounds 到整屏，让用户能框到最底部；截不到的部分反正也裁不到。
        try {
          window.setBounds({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
          });
        } catch {
          // 个别环境不让改，保持原样也能工作（靠下面的实测映射照样对得齐）
        }
        window.show();
        window.focus();
      });
      window.webContents.on("did-finish-load", async () => {
        // 把**视口实际尺寸**量出来交给主进程：裁剪比例 = 图像尺寸 / 视口尺寸。
        // 不能假设它等于 display.scaleFactor（见文件头注释），必须实测。
        let viewWidth = display.bounds.width;
        let viewHeight = display.bounds.height;
        try {
          const measured = await window.webContents.executeJavaScript(
            "({ w: window.innerWidth, h: window.innerHeight })",
          );
          if (Number(measured?.w) > 0) viewWidth = Number(measured.w);
          if (Number(measured?.h) > 0) viewHeight = Number(measured.h);
        } catch {
          // 量不到就用 bounds 兜底
        }
        capture.viewWidth = viewWidth;
        capture.viewHeight = viewHeight;

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

  const image = nativeImage.createFromDataURL(capture.dataUrl);
  if (image.isEmpty()) {
    settle({ ok: false, reason: "empty-image" });
    return { ok: false, reason: "empty-image" };
  }
  const size = image.getSize();

  // 每 CSS 像素对应的物理像素，**逐轴实测**：图像实际尺寸 ÷ 视口实际尺寸。
  // 优先在裁剪这一瞬间现场量一次 innerWidth/Height（setBounds 之后才准），
  // 量不到再退回 did-finish-load 时的值，最后才退回显示尺寸。
  let viewW = Number(capture.viewWidth) > 0 ? Number(capture.viewWidth) : capture.bounds.width;
  let viewH = Number(capture.viewHeight) > 0 ? Number(capture.viewHeight) : capture.bounds.height;
  try {
    const live = await state.window?.webContents?.executeJavaScript(
      "({ w: window.innerWidth, h: window.innerHeight })",
    );
    if (Number(live?.w) > 0 && Number(live?.h) > 0) {
      viewW = Number(live.w);
      viewH = Number(live.h);
    }
  } catch {
    // 窗口已经在收，用之前量到的值
  }
  const scaleX = size.width / viewW;
  const scaleY = size.height / viewH;

  const cropX = Math.max(0, Math.round(Number(rect?.x) * scaleX));
  const cropY = Math.max(0, Math.round(Number(rect?.y) * scaleY));
  const cropW = Math.round(width * scaleX);
  const cropH = Math.round(height * scaleY);

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
