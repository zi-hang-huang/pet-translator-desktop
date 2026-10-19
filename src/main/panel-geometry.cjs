/**
 * 窗口几何：球的方框、面板的默认落点、以及"别跑出工作区"。
 *
 * 纯函数，不碰 Electron —— 这些数最容易算错，也最容易用断言锁住。
 *
 * 面板和球现在是**两个独立窗口**，所以这里不再算"并集"，
 * 只负责：球窗该多大、面板第一次该放哪、坐标怎么夹回屏幕。
 */

/** @typedef {{x: number, y: number, width: number, height: number}} Rect */

/**
 * @param {number} value @param {number} low @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * 把一个矩形夹进工作区。
 * @param {{x: number, y: number}} position
 * @param {{width: number, height: number}} size
 * @param {Rect} workArea
 * @returns {{x: number, y: number}}
 */
function clampWindow(position, size, workArea) {
  return {
    x: Math.round(clamp(position.x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(position.y, workArea.y, workArea.y + workArea.height - size.height)),
  };
}

/**
 * 球窗口：只有球，窗口就是那圈方框。
 * @param {{x: number, y: number}} circle - 球圆的屏幕坐标。
 * @param {number} ballSize
 * @param {number} padding
 * @returns {{window: Rect, ball: {x: number, y: number, width: number, height: number}}}
 */
function collapsedLayout(circle, ballSize, padding) {
  const size = ballSize + padding * 2;
  return {
    window: {
      x: Math.round(circle.x - padding),
      y: Math.round(circle.y - padding),
      width: size,
      height: size,
    },
    ball: { x: 0, y: 0, width: size, height: size },
  };
}

/**
 * 面板第一次出现时放哪：优先球的右侧，放不下就左边，再放不下就居中。
 *
 * 注意返回的是**窗口**左上角（含投影留白），不是面板本体的位置。
 *
 * @param {object} input
 * @param {{x: number, y: number}} input.ballCircle
 * @param {number} input.ballSize
 * @param {{width: number, height: number}} input.windowSize - 面板窗口整体尺寸。
 * @param {Rect} input.workArea
 * @param {number} input.gap - 球圆与面板本体之间的间隙。
 * @param {number} input.margin - 面板窗口里给投影的留白。
 * @returns {{x: number, y: number, side: "right" | "left" | "center"}}
 */
function defaultPanelPosition(input) {
  const { ballCircle, ballSize, windowSize, workArea, gap, margin } = input;

  // 面板本体和球心竖直对齐（再夹进工作区）
  const bodyY = ballCircle.y + ballSize / 2 - (windowSize.height - margin * 2) / 2;
  const bodyRight = ballCircle.x + ballSize + gap;
  const bodyLeft = ballCircle.x - gap - (windowSize.width - margin * 2);

  const fitsRight = bodyRight + windowSize.width - margin <= workArea.x + workArea.width;
  const fitsLeft = bodyLeft - margin >= workArea.x;

  /** @type {"right" | "left" | "center"} */
  let side = "right";
  let x = bodyRight - margin;

  if (!fitsRight && fitsLeft) {
    side = "left";
    x = bodyLeft - margin;
  } else if (!fitsRight && !fitsLeft) {
    side = "center";
    x = ballCircle.x + ballSize / 2 - windowSize.width / 2;
  }

  // 按本体夹，不按窗口夹：留白允许跑到屏幕外，面板本体才能贴住边
  const clamped = clampPanelWindow(
    { x, y: bodyY - margin },
    { width: windowSize.width - margin * 2, height: windowSize.height - margin * 2 },
    workArea,
    margin,
  );
  return { x: clamped.x, y: clamped.y, side };
}

/**
 * 把**面板本体**夹进工作区（而不是整个窗口）。
 *
 * 为什么要分开：窗口外面还包着一圈给投影的留白（32px）。如果按窗口夹，
 * 面板本体就永远贴着屏幕边差 32px —— 用户的原话是"拖不到屏幕边"。
 * 留白是透明的，让它跑到屏幕外正合适（那边本来也看不见投影）。
 *
 * @param {{x: number, y: number}} position - 窗口左上角。
 * @param {{width: number, height: number}} panelSize - 面板本体尺寸。
 * @param {Rect} workArea
 * @param {number} margin - 窗口里给投影的留白。
 * @returns {{x: number, y: number}} 夹过之后的窗口左上角。
 */
function clampPanelWindow(position, panelSize, workArea, margin) {
  const bodyX = clamp(position.x + margin, workArea.x, workArea.x + workArea.width - panelSize.width);
  const bodyY = clamp(position.y + margin, workArea.y, workArea.y + workArea.height - panelSize.height);
  return { x: Math.round(bodyX - margin), y: Math.round(bodyY - margin) };
}

module.exports = { collapsedLayout, clampWindow, clampPanelWindow, defaultPanelPosition, clamp };
