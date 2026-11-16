/**
 * 验「生产代码」里的整图直翻：直接调 src/engine/web-page.translateImage()。
 *
 *     electron scripts/probe-image-engine.cjs [--image 路径]
 *
 * 和 probe-image-e2e.cjs 的区别：
 *   probe-image-e2e    自己写一遍注入+发送，验证“思路通不通”
 *   probe-image-engine 调**真正要发布的那段代码**，验证“实现对不对”
 *
 * 仍然复制分区到临时 userData，不碰正在运行的 App。
 */

const { app } = require("electron");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const fs = require("node:fs");

const APP_NAME = "pet-translator-desktop";
const tempUserData = join(tmpdir(), `pet-tr-probe-eng-${Date.now()}`);

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const imagePath = argOf("--image", join(__dirname, "_probe-test-image.png"));

/** 复制真 App 的分区（含登录态）到临时 userData。必须在 ready 之前定好路径。 */
function cloneInto() {
  const srcRoot = join(app.getPath("appData"), APP_NAME);
  fs.mkdirSync(join(tempUserData, "Partitions"), { recursive: true });
  const srcPart = join(srcRoot, "Partitions", "deepseek");
  if (fs.existsSync(srcPart)) {
    fs.cpSync(srcPart, join(tempUserData, "Partitions", "deepseek"), { recursive: true });
  }
  const srcSettings = join(srcRoot, "settings.json");
  if (fs.existsSync(srcSettings)) fs.copyFileSync(srcSettings, join(tempUserData, "settings.json"));
}

app.whenReady().then(async () => {
  cloneInto();
  app.setPath("userData", tempUserData);

  // require 必须在 setPath 之后：引擎内部依赖 app.getPath("userData")
  const engine = require("../src/engine/web-page.cjs");

  const out = { ok: false, imageExists: fs.existsSync(imagePath) };
  try {
    const started = Date.now();
    const result = await engine.translateImage(imagePath, { target: "zh" });
    out.ok = typeof result?.text === "string" && result.text.length > 0;
    out.ms = Date.now() - started;
    out.provider = result?.provider;
    out.reply = String(result?.text ?? "").slice(0, 400);
    out.replyLen = String(result?.text ?? "").length;
  } catch (error) {
    out.errorCode = error?.code ?? "unknown";
    out.error = String(error?.message ?? error);
  } finally {
    console.log("[probe-eng] " + JSON.stringify(out, null, 2));
    try {
      engine.dispose();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    app.quit();
  }
});
