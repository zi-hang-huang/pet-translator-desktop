/**
 * 自测：面板右下角拖拽改尺寸。
 *
 *     electron scripts/selftest-resize.cjs
 *
 * 验的是「拖右下角」在几何上必须成立的四件事：
 *   1. 左上角钉住 —— 用户往下右拖，面板就该往右下长，不能整体挪走
 *   2. 尺寸有上下限 —— 拖成 0 或拖成 5000 都得被夹回可用区间
 *   3. 长大了不能把右下角顶出屏幕 —— 顶出去就再也够不着抓手了
 *   4. 记住 —— 关闭再打开还是那个尺寸
 *
 * 用独立 userData，不碰真实设置。
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { app, screen } = require("electron");

const SANDBOX = path.join(os.tmpdir(), `pet-tr-selftest-resize-${process.pid}`);
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

const panel = require("../src/main/panel-window.cjs");
const store = require("../src/main/store.cjs");

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
/** @param {string} name @param {boolean} pass @param {unknown} detail */
const check = (name, pass, detail) => results.push({ name, pass, detail });

app.whenReady().then(async () => {
  try {
    const workArea = screen.getPrimaryDisplay().workArea;
    // 摆在屏幕中间，四面都有空间，免得初始化就被夹取干扰
    store.write({
      panelX: Math.round(workArea.x + workArea.width / 2),
      panelY: Math.round(workArea.y + workArea.height / 2),
      panelWidth: 340,
      panelHeight: 470,
    });

    panel.show();
    await wait(400);

    const start = panel.snapshot();
    check("初始尺寸 340×470", start.body.width === 340 && start.body.height === 470, start.body);

    // ── 1. 变大：左上角钉住（前提是放得下）─────────────────────────────
    // 先把面板挪到屏幕左上角附近，向下右长不会越界，这样才谈得上"钉住"
    panel.dragStart(0, 0);
    panel.dragMove(-99999, -99999);
    panel.dragEnd();
    await wait(150);
    const before = panel.snapshot().bounds;
    panel.resize(500, 600);
    await wait(200);
    const grown = panel.snapshot();
    check(
      "变大后尺寸生效",
      grown.body.width === 500 && grown.body.height === 600,
      { body: grown.body, workArea },
    );
    check(
      "放得下时变大不动左上角",
      grown.bounds.x === before.x && grown.bounds.y === before.y,
      { before, after: grown.bounds },
    );
    check(
      "窗口整体 = 本体 + 两圈留白",
      grown.bounds.width === 500 + 64 && grown.bounds.height === 600 + 64,
      grown.bounds,
    );

    // ── 2. 下限：拖到负数也夹回最小值 ──────────────────────────────────
    panel.resize(-100, -50);
    await wait(150);
    const tiny = panel.snapshot();
    check(
      "拖到负数会被夹到下限",
      tiny.body.width === panel.MIN_PANEL_WIDTH && tiny.body.height === panel.MIN_PANEL_HEIGHT,
      tiny.body,
    );

    // ── 3. 上限：夹到「设计上限」与「屏幕装得下」两者的较小值 ──────────
    panel.resize(99999, 99999);
    await wait(150);
    const huge = panel.snapshot();
    const expectW = Math.min(panel.MAX_PANEL_WIDTH, workArea.width - 64);
    const expectH = Math.min(panel.MAX_PANEL_HEIGHT, workArea.height - 64);
    check(
      "拖到超大会被夹到可用上限",
      huge.body.width === expectW && huge.body.height === expectH,
      { body: huge.body, expected: { width: expectW, height: expectH }, workArea },
    );

    // ── 4. 长大了不能把右下角抓手顶出屏幕 ──────────────────────────────
    // 先把窗口贴到屏幕右下角，再放大，看是否被拉回来。
    // 断言口径是**面板本体**（不含透明投影留白）—— 留白本来就允许越界。
    panel.dragStart(0, 0);
    panel.dragMove(99999, 99999);
    panel.dragEnd();
    await wait(150);
    panel.resize(panel.MAX_PANEL_WIDTH, panel.MAX_PANEL_HEIGHT);
    await wait(200);
    const corner = panel.snapshot();
    const bodyX = corner.bounds.x + 32;
    const bodyY = corner.bounds.y + 32;
    const bodyRight = bodyX + corner.body.width;
    const bodyBottom = bodyY + corner.body.height;
    check(
      "放大后面板本体不越出工作区",
      bodyX >= workArea.x &&
        bodyY >= workArea.y &&
        bodyRight <= workArea.x + workArea.width &&
        bodyBottom <= workArea.y + workArea.height,
      { body: { x: bodyX, y: bodyY, right: bodyRight, bottom: bodyBottom }, workArea },
    );
    check(
      "右下角抓手留在屏幕内（留了余量）",
      bodyRight <= workArea.x + workArea.width - 8 &&
        bodyBottom <= workArea.y + workArea.height - 8,
      { bodyRight, bodyBottom, workArea },
    );

    // ── 5. 落盘 + 关掉再开还是那个尺寸 ─────────────────────────────────
    panel.resize(420, 520);
    await wait(200);
    const saved = store.read();
    check(
      "尺寸已落盘",
      saved.panelWidth === 420 && saved.panelHeight === 520,
      { panelWidth: saved.panelWidth, panelHeight: saved.panelHeight },
    );

    panel.hide();
    await wait(200);
    panel.show();
    await wait(350);
    const reopened = panel.snapshot();
    check(
      "重新打开保持尺寸",
      reopened.body.width === 420 && reopened.body.height === 520,
      reopened.body,
    );

    // ── 6. 非法输入不能把面板搞没 ──────────────────────────────────────
    panel.resize(Number.NaN, Number.NaN);
    await wait(150);
    const fallback = panel.snapshot();
    check(
      "NaN 回落到默认尺寸",
      fallback.body.width === panel.PANEL_WIDTH && fallback.body.height === panel.PANEL_HEIGHT,
      fallback.body,
    );
  } catch (error) {
    check("未抛异常", false, String(error && error.stack ? error.stack : error));
  }

  const ok = results.every((item) => item.pass);
  console.log("[selftest-resize] " + JSON.stringify({ ok, results }));

  panel.allowClose();
  panel.destroy();
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  app.quit();
});
