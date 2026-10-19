/**
 * 翻译探针：直接调引擎翻一段文字，把过程打出来。
 *
 *     electron scripts/probe-translate.cjs "要翻的文字"
 *     electron scripts/probe-translate.cjs --file 某文件.txt
 *
 * 和 `probe-deepseek.cjs` 的分工：
 *   probe-deepseek  看页面结构（输入框在不在、发送键是谁）
 *   probe-translate 看翻译过程（轮询看到了什么、卡在哪一步）
 *
 * 界面卡在「翻译中」时先跑这个，日志里那行 poll 会告诉你原因。
 */

const { app } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// 必须先钉 userData，再 require 引擎：否则这条探针用的是另一个 Electron profile，
// persist:deepseek 分区里没有登录态，一进门就 need-login。
app.setPath("userData", join(app.getPath("appData"), "pet-translator-desktop"));

const engine = require("../src/engine/web-page.cjs");

const argv = process.argv.slice(2);
const index = argv.indexOf("--file");
const repeatIndex = argv.indexOf("--repeat");
/** 连着翻几次。验「多翻几次就不出来」这类随会话变长而劣化的问题。 */
const repeat = repeatIndex >= 0 ? Math.max(1, Number(argv[repeatIndex + 1]) || 1) : 1;
const text =
  index >= 0
    ? readFileSync(argv[index + 1], "utf8").trim()
    : argv.find((item) => item !== "--file" && !item.endsWith(".txt") && !item.startsWith("--") && item !== String(repeat)) ?? "";

app.whenReady().then(async () => {
  if (text.trim() === "") {
    console.log("[probe-translate] 没给文字。用法：electron scripts/probe-translate.cjs \"要翻的文字\" [--repeat 4]");
    app.quit();
    return;
  }

  console.log(`[probe-translate] 输入 ${text.length} 字，重复 ${repeat} 次`);
  for (let round = 1; round <= repeat; round += 1) {
    const started = Date.now();
    try {
      const result = await engine.translate(text, { target: "auto" });
      console.log(
        "[probe-translate] " +
          JSON.stringify({
            round,
            ok: true,
            ms: result.ms,
            chars: result.text.length,
            head: result.text.slice(0, 40),
          }),
      );
    } catch (error) {
      console.log(
        "[probe-translate] " +
          JSON.stringify({
            round,
            ok: false,
            code: error?.code ?? "unknown",
            message: String(error?.message ?? error),
            totalMs: Date.now() - started,
          }),
      );
    }
  }

  engine.dispose();
  app.quit();
});
