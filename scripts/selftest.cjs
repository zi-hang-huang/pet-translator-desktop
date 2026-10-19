/**
 * 自测：不靠人手，直接驱动主进程的几何与拖动路径。
 *
 *     electron scripts/selftest.cjs
 *
 * 上半场是**纯函数**的几何断言（panel-geometry 不依赖 Electron，答案唯一）；
 * 下半场是真实窗口的拖动/落盘/夹取。
 *
 * 不验的部分：鼠标穿透、托盘交互、renderer 里的指针手势 —— 那三样只能人眼/人手验。
 *
 * 注意：以 `electron scripts/selftest.cjs` 启动时，app 没有 package.json 里的 name，
 * userData 落到 `%APPDATA%\Electron`。所以这个测试**永远不会动你真实球的位置和缩放**。
 */

const { app } = require("electron");
const ball = require("../src/main/ball-window.cjs");
const store = require("../src/main/store.cjs");
const { collapsedLayout, clampWindow, clampPanelWindow, defaultPanelPosition } = require("../src/main/panel-geometry.cjs");
const panel = require("../src/main/panel-window.cjs");

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
/** @param {string} name @param {boolean} pass @param {unknown} detail */
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** 常见 1080p 工作区（去掉任务栏）。 */
const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

/**
 * @param {{x: number, y: number}} circle
 * @param {{width: number, height: number}} [panel]
 * @returns {any}
 */
function layoutFor(circle, panel = { width: 340, height: 440 }) {
  return computeLayout({
    ballCircle: circle,
    ballSize: 96,
    padding: 21,
    panel,
    workArea: SCREEN,
    gap: 16,
    margin: 26,
  });
}

/** 纯函数几何断言。 */
function geometryChecks() {
  // ── 1. 球窗口：就是那圈方框 ──────────────────────────────────────
  const collapsed = collapsedLayout({ x: 300, y: 200 }, 96, 21);
  check(
    "球窗几何",
    collapsed.window.width === 138 && collapsed.window.x === 279 && collapsed.ball.x === 0,
    collapsed,
  );

  // ── 2. 夹取：窗口不出工作区 ──────────────────────────────────────
  const screenRect = { x: 0, y: 0, width: 1920, height: 1040 };
  const clamped = clampWindow({ x: -500, y: 2000 }, { width: 404, height: 534 }, screenRect);
  check(
    "窗口不越界",
    clamped.x === 0 && clamped.y === 1040 - 534,
    clamped,
  );

  // ── 2b. 面板本体能贴到屏幕边（留白允许跑出屏幕） ──────────────────
  const screenA = { x: 0, y: 0, width: 1920, height: 1080 };
  const body = { width: 340, height: 470 };
  const flushLeft = clampPanelWindow({ x: -3000, y: 300 }, body, screenA, 32);
  check("面板能贴左边", flushLeft.x + 32 === 0 && flushLeft.y === 300, flushLeft);
  const flushTop = clampPanelWindow({ x: 400, y: -3000 }, body, screenA, 32);
  check("面板能贴顶边", flushTop.y + 32 === 0, flushTop);
  const flushRight = clampPanelWindow({ x: 9000, y: 300 }, body, screenA, 32);
  check("面板能贴右边", flushRight.x + 32 + 340 === 1920, flushRight);

  // ── 3. 面板默认落在球右边 ────────────────────────────────────────
  const ballCircle = { x: 400, y: 400 };
  const windowSize = { width: 404, height: 534 };
  const right = defaultPanelPosition({
    ballCircle,
    ballSize: 96,
    windowSize,
    workArea: screenRect,
    gap: 16,
    margin: 32,
  });
  check("面板默认在右", right.side === "right", right);
  // 面板本体（去掉留白）应该贴在球的右侧 16px 处
  check(
    "面板与球间隙正确",
    right.x + 32 === ballCircle.x + 96 + 16,
    { panelBodyX: right.x + 32, expected: ballCircle.x + 96 + 16 },
  );

  // ── 4. 贴右边缘时翻到左边 ────────────────────────────────────────
  const left = defaultPanelPosition({
    ballCircle: { x: 1800, y: 400 },
    ballSize: 96,
    windowSize,
    workArea: screenRect,
    gap: 16,
    margin: 32,
  });
  check("贴边翻到左侧", left.side === "left", left);

  // ── 5. 两边都放不下：居中，且仍在工作区里 ────────────────────────
  const center = defaultPanelPosition({
    ballCircle: { x: 700, y: 400 },
    ballSize: 96,
    windowSize: { width: 1400, height: 534 },
    workArea: screenRect,
    gap: 16,
    margin: 32,
  });
  check(
    "放不下就居中",
    center.side === "center" && center.x >= 0 && center.x + 1400 <= 1920,
    center,
  );
}
app.whenReady().then(async () => {
  geometryChecks();

  // 先把球摆到屏幕中间再试拖动：从右下角往右下拖会被工作区边界夹住，
  // 那验的是夹取逻辑，不是位移换算。
  store.write({ x: 300, y: 300, scale: 1 });

  ball.create();
  await wait(800);

  const before = ball.snapshot().bounds;

  // ── 6/7. 正常拖动 + 落盘 ────────────────────────────────────────────
  ball.dragStart(500, 500);
  ball.dragMove(560, 540);
  await wait(80);
  const during = ball.snapshot().bounds;
  check("拖动位移", during.x === before.x + 60 && during.y === before.y + 40, { before, during });

  ball.dragEnd();
  await wait(80);
  const saved = store.read();
  check("松手落盘", saved.x === during.x + 21 && saved.y === during.y + 21, { x: saved.x, y: saved.y });

  // ── 8. 往屏幕外拖会被夹回来 ────────────────────────────────────────
  ball.dragStart(100, 100);
  ball.dragMove(-9000, -9000);
  await wait(80);
  const clamped = ball.snapshot();
  ball.dragEnd();
  await wait(60);
  // 夹的是**球圆**，不是窗口：窗口还带着 21px 透明留白，可能落在负坐标上
  check(
    "越界夹取",
    clamped.circle.x >= 0 && clamped.circle.y >= 0 && clamped.bounds.x === clamped.circle.x - 21,
    { circle: clamped.circle, bounds: clamped.bounds },
  );

  // ── 9. 拖完再发 move 不应该继续移动 ────────────────────────────────
  const parked = ball.snapshot().bounds;
  ball.dragMove(parked.x + 300, parked.y + 300);
  await wait(60);
  const afterStray = ball.snapshot().bounds;
  check("松手后无残留", afterStray.x === parked.x && afterStray.y === parked.y, { parked, afterStray });

  // ── 10. 面板是独立窗口：开它不动球 ──────────────────────────────────
  const beforeOpen = ball.snapshot();
  const ballWindow = ball.getWindow();
  const ballBoundsBefore = ballWindow.getBounds();

  panel.show({ anchored: { circle: beforeOpen.circle, ballSize: beforeOpen.ballSize } });
  await wait(400);
  const opened = ball.snapshot();
  const panelSnap = panel.snapshot();

  check("面板能打开", panel.isVisible(), panelSnap);
  check(
    "开面板不动球",
    ballWindow.getBounds().x === ballBoundsBefore.x &&
      ballWindow.getBounds().y === ballBoundsBefore.y &&
      ballWindow.getBounds().width === ballBoundsBefore.width,
    { before: ballBoundsBefore, after: ballWindow.getBounds() },
  );

  // ── 11. 拖面板：只动面板，球原地 ────────────────────────────────────
  const panelBefore = panel.snapshot().bounds;
  panel.dragStart(500, 500);
  panel.dragMove(560, 540);
  await wait(80);
  const panelMoved = panel.snapshot().bounds;
  panel.dragEnd();
  const ballAfterPanelDrag = ballWindow.getBounds();

  check(
    "拖面板不动球",
    panelMoved.x === panelBefore.x + 60 &&
      panelMoved.y === panelBefore.y + 40 &&
      ballAfterPanelDrag.x === ballBoundsBefore.x,
    { panelBefore, panelMoved, ballAfterPanelDrag },
  );

  // ── 11b. 面板位置要落盘，重新打开不能回原位 ────────────────────────
  const savedPanel = store.read();
  check(
    "面板位置已落盘",
    savedPanel.panelX === panelMoved.x && savedPanel.panelY === panelMoved.y,
    { saved: { x: savedPanel.panelX, y: savedPanel.panelY }, expected: panelMoved },
  );

  panel.hide();
  await wait(120);
  panel.show();
  await wait(250);
  const reopened = panel.snapshot().bounds;
  check(
    "再开面板不回原位",
    reopened.x === panelMoved.x && reopened.y === panelMoved.y,
    { reopened, expected: panelMoved },
  );

  // ── 12. 收起面板：球还是没动 ────────────────────────────────────────
  panel.hide();
  await wait(120);
  const closed = ball.snapshot();
  check(
    "收面板不动球",
    panel.isVisible() === false &&
      closed.bounds.width === beforeOpen.bounds.width &&
      closed.circle.x === beforeOpen.circle.x &&
      closed.circle.y === beforeOpen.circle.y,
    { bounds: closed.bounds, circle: closed.circle },
  );

  const ok = results.every((item) => item.pass);
  console.log("[selftest] " + JSON.stringify({ ok, results }));

  // 面板窗口会拦 close（那是"收起"而不是"关闭"），退出前必须先放行
  panel.allowClose();
  panel.destroy();
  ball.allowClose();
  app.quit();
});
