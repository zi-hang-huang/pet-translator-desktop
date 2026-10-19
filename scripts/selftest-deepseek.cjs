/**
 * 自测：DeepSeek 网页窗口的「点开就该有页面」。
 *
 *     electron scripts/selftest-deepseek.cjs
 *
 * 背景：用户第一次装好之后，会先点「打开 DeepSeek 窗口」去登录 —— 那一步之前
 * 从来没翻译过。原来的 show() 只是 ensure() + window.show()，而 ensure() 只记
 * 地址不加载，于是弹出来的是一个**空白窗口**。本机之所以没发现，是因为我每次
 * 都先调 translate() → open() 把页面加载了一遍。
 *
 * 所以这里验的就是那条曾经漏掉的路径：**不翻译、直接 show，必须出页面**。
 *
 * 不依赖模块内部 state：只用对外接口 status() / getWindow()，因此测的是
 * 真实可观测行为，而不是实现细节。
 *
 * 用独立的 userData（沙盒），不会碰真实登录态。
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { app } = require("electron");

const SANDBOX = path.join(os.tmpdir(), `pet-tr-selftest-deepseek-${process.pid}`);
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

const deepseek = require("../src/main/deepseek-window.cjs");

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
/** @param {string} name @param {boolean} pass @param {unknown} detail */
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** 当前窗口的实际地址（不管加载到哪一步）。 */
function windowUrl() {
  const win = deepseek.getWindow();
  if (win === undefined || win.isDestroyed()) return "";
  const contents = win.webContents;
  return contents.isLoading() ? contents.getURL() || "about:blank" : contents.getURL();
}

/** 等到 status 不再是"还在加载"（或者超时）。 */
async function waitSettled(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = deepseek.status();
    if (s.detail !== "页面还在加载") return s;
    await wait(250);
  }
  return deepseek.status();
}

app.whenReady().then(async () => {
  try {
    // ── 1. 冷启动：直接 show（= 对方第一次点「打开 DeepSeek 窗口」）─────
    const before = deepseek.status();
    check("初始未加载", before.status === "off", before);

    deepseek.show();

    // 关键断言：显示之后窗口必须已经在导航（有地址、在加载），而不是空壳
    await wait(500);
    const shownUrl = windowUrl();
    check(
      "冷启动 show 后窗口在加载页面",
      shownUrl.startsWith("http"),
      { windowUrl: shownUrl, status: deepseek.status() },
    );

    const settled = await waitSettled(30000);
    check(
      "冷启动 show 后最终加载成功（不是空白/报错）",
      settled.status !== "bad" && settled.detail !== "页面还在加载",
      settled,
    );
    check(
      "加载完成的地址是 DeepSeek 站点",
      typeof settled.url === "string" && settled.url.includes("deepseek"),
      { url: settled.url, detail: settled.detail },
    );

    // ── 2. 已加载过再 show：不重新导航（不打断登录、不回首页）─────────
    const urlBefore = deepseek.status().url;
    deepseek.hide();
    await wait(300);
    deepseek.show();
    await wait(1200);
    const reused = deepseek.status();
    check(
      "已加载时 show 不重新导航",
      reused.url === urlBefore && reused.status === deepseek.status().status,
      { before: urlBefore, after: reused.url },
    );

    // ── 3. open() 的幂等性没被破坏 ────────────────────────────────────
    await deepseek.open();
    const afterOpen = deepseek.status();
    check(
      "open 仍然可用且已完成加载",
      afterOpen.status !== "bad" && afterOpen.detail !== "页面还在加载",
      afterOpen,
    );
  } catch (error) {
    check("未抛异常", false, String(error && error.stack ? error.stack : error));
  }

  const ok = results.every((item) => item.pass);
  console.log("[selftest-deepseek] " + JSON.stringify({ ok, results }));

  deepseek.destroy();
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  app.quit();
});
