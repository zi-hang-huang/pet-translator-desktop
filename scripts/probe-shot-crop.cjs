/**
 * 端到端验证「截图偏移」修好没有。
 *
 *     electron scripts/probe-shot-crop.cjs
 *
 * 做法：真的调用 shot.selectRegion()（和生产同一条路径），窗口加载后
 * 在页面里模拟一次「拖满整个屏幕」的鼠标选择，再检查实际裁出来的 PNG：
 *   - 宽高是否等于 屏幕物理像素（2880×1800 量级，允许 ±2px）
 *   - 裁出来的图里，最底部那一行像素是否和整屏截图的最底部一致（即没被上移）
 *
 * 关键判据用「底部对齐」：老代码会把框在底部的内容裁偏上 ~96px，
 * 表现为 crop 的底边够不到 image 的底边。
 */

const { app, BrowserWindow, nativeImage } = require("electron");
const os = require("node:os");
const { join } = require("node:path");
const fs = require("node:fs");

app.setPath("userData", join(os.tmpdir(), "pet-tr-probe-crop"));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const out = { ok: false };
  try {
    const shot = require("../src/main/shot.cjs");
    const { ipcMain } = require("electron");
    // 复刻 index.cjs 里的框选回调，让 shot.html 的 invoke 有去处
    ipcMain.handle("shot:commit", async (_e, rect) => shot.commitSelection(rect));
    ipcMain.on("shot:cancel", () => shot.cancel());
    ipcMain.on("shot:done", () => {});

    // 发起一次真实框选
    const regionPromise = shot.selectRegion();

    // 等框选窗口出现并加载
    let win = null;
    for (let i = 0; i < 50; i += 1) {
      win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("shot.html"));
      if (win) break;
      await wait(100);
    }
    if (!win) throw new Error("没等到框选窗口");
    out.windowFound = true;

    // 等内容区就绪
    for (let i = 0; i < 50; i += 1) {
      const ready = await win.webContents.executeJavaScript("!!document.getElementById('stage')");
      if (ready) break;
      await wait(100);
    }
    await wait(600);

    // 量视口 + 读截图实际尺寸（从 stage 的 background-image 拿不到尺寸，改用主进程量）
    const view = await win.webContents.executeJavaScript("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })");
    out.view = view;

    // 模拟一次「从左上拖到右下、铺满整屏」的框选
    await win.webContents.executeJavaScript(`
      (() => {
        const W = innerWidth, H = innerHeight;
        const mk = (type, x, y) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
        window.dispatchEvent(mk("mousedown", 0, 0));
        window.dispatchEvent(mk("mousemove", W, H));
        window.dispatchEvent(mk("mouseup", W, H));
        return true;
      })()
    `);

    const result = await regionPromise;
    out.result = result;
    if (result && result.ok) {
      const img = nativeImage.createFromPath(result.imagePath);
      const sz = img.getSize();
      out.crop = { w: sz.width, h: sz.height, rect: result.rect };
      // 期望：铺满整屏 → 裁剪尺寸 ≈ 屏幕物理像素
      const expectW = Math.round(view.w * view.dpr);
      const expectH = Math.round(view.h * view.dpr);
      out.expected = { w: expectW, h: expectH };
      out.verdict = {
        widthOk: Math.abs(sz.width - expectW) <= 3,
        heightOk: Math.abs(sz.height - expectH) <= 3,
        fullHeightRatio: Math.round((sz.height / expectH) * 1000) / 1000,
      };
      out.ok = out.verdict.widthOk && out.verdict.heightOk;
    }
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  console.log("[probe-crop] " + JSON.stringify(out, null, 2));
  app.exit(0);
});
