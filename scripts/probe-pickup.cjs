/**
 * 取词探针：只跑 pickup，不开球窗口。
 *
 *     electron scripts/probe-pickup.cjs
 *
 * 用来把「取词」和「球的焦点问题」分开：
 *   这里有输出 → pickup 本身是好的，问题在窗口/焦点
 *   这里没输出 → pickup 内部有问题（按键器、剪贴板、时序）
 *
 * 跑之前请在任意程序里选中一段文字，然后稍等 —— 它等 2 秒后开始取。
 */

const { app, clipboard } = require("electron");
const pickup = require("../src/main/pickup.cjs");

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} value @returns {string} */
const head = (value) => JSON.stringify(String(value ?? "").slice(0, 60));

/** 这个版本的 clipboard 返回 Promise；文档写的是同步。两种都等。 */
async function clipText() {
  const value = clipboard.readText();
  return typeof value?.then === "function" ? await value : value;
}

app.whenReady().then(async () => {
  console.log(`[probe-pickup] 剪贴板（取词前）: ${head(await clipText())}`);
  pickup.warmUp();
  await wait(2000); // 给外面时间：选中文字、松手

  const result = await pickup.grabSelection();
  console.log(
    "[probe-pickup] " +
      JSON.stringify({
        ok: result.text !== "",
        chars: result.text.length,
        preview: result.text.slice(0, 50),
        reason: result.reason ?? null,
        ms: result.ms,
      }),
  );
  console.log(`[probe-pickup] 剪贴板（取词后）: ${head(await clipText())}`);

  pickup.dispose();
  app.quit();
});
