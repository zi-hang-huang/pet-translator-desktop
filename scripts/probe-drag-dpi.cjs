/**
 * 临时探针 7：验修改后的拖动路径。
 *
 * 预期：连续 20 次拖动后，球窗口与面板窗口的宽高都必须保持不变
 * （修改前：每次 setPosition 让宽 +1 DIP）。
 *
 *   $env:F = "1.5"; & <electron> scripts\probe-dpi7.cjs
 */
const os = require("node:os");
const { join } = require("node:path");
const { app, screen } = require("electron");

const factor = process.env.F ?? "1.5";
app.commandLine.appendSwitch("force-device-scale-factor", factor);
app.setPath("userData", join(os.tmpdir(), "pet-tr-probe7", factor.replace(".", "_")));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ball = require("../src/main/ball-window.cjs");
  const panel = require("../src/main/panel-window.cjs");

  const ballWindow = ball.create();
  if (ballWindow.webContents.isLoading()) {
    await new Promise((r) => ballWindow.webContents.once("did-finish-load", r));
  }
  await wait(300);

  const start = ball.snapshot();
  console.log("[probe7] factor=" + factor + " displayScale=" + screen.getPrimaryDisplay().scaleFactor);
  console.log("[probe7] ball start " + JSON.stringify(start.bounds));

  // 球：一次 dragStart，然后 20 次 dragMove，每次 2px
  ball.dragStart(start.circle.x, start.circle.y);
  const ballW = [];
  for (let i = 1; i <= 20; i += 1) {
    ball.dragMove(start.circle.x + i * 2, start.circle.y + i * 2);
    if (i % 5 === 0) {
      await wait(40);
      ballW.push(ball.snapshot().bounds.width);
    }
  }
  ball.dragEnd();
  const ballEnd = ball.snapshot();
  console.log("[probe7] ball widths @5,10,15,20 = " + JSON.stringify(ballW));
  console.log("[probe7] ball end " + JSON.stringify(ballEnd.bounds));

  // 渲染层：球身尺寸是否还跟窗口走
  const renderer = await ballWindow.webContents.executeJavaScript(`(() => {
    const el = document.getElementById("ball");
    const cs = getComputedStyle(el);
    return { offsetW: el.offsetWidth, offsetH: el.offsetHeight,
             cssW: cs.width, cssH: cs.height,
             pad: getComputedStyle(document.documentElement).getPropertyValue("--ball-pad").trim(),
             innerW: window.innerWidth };
  })()`);
  console.log("[probe7] ball renderer " + JSON.stringify(renderer));

  // 面板：同样 20 次拖动
  panel.show({ anchored: { circle: ballEnd.circle, ballSize: ballEnd.ballSize } });
  await wait(250);
  const pStart = panel.snapshot();
  console.log("[probe7] panel start " + JSON.stringify(pStart.bounds));
  panel.dragStart(pStart.bounds.x, pStart.bounds.y);
  const panelW = [];
  for (let i = 1; i <= 20; i += 1) {
    panel.dragMove(pStart.bounds.x + i * 2, pStart.bounds.y + i * 2);
    if (i % 5 === 0) {
      await wait(40);
      panelW.push(panel.snapshot().bounds.width);
    }
  }
  panel.dragEnd();
  const pEnd = panel.snapshot();
  console.log("[probe7] panel widths @5,10,15,20 = " + JSON.stringify(panelW));
  console.log("[probe7] panel end " + JSON.stringify(pEnd.bounds));

  const verdict = {
    ballWidthDrift: ballEnd.bounds.width - start.bounds.width,
    panelWidthDrift: pEnd.bounds.width - pStart.bounds.width,
    ballRenderedW: renderer.offsetW,
    ballCssW: renderer.cssW,
  };
  console.log("[probe7] verdict " + JSON.stringify(verdict));

  ball.allowClose();
  panel.allowClose();
  panel.destroy?.();
  app.exit(0);
});
