/**
 * DeepSeek 网页结构探针。
 *
 *     electron scripts/probe-deepseek.cjs [--visible]
 *
 * 网页改版是这套方案唯一的长期风险。改版之后不要猜选择器 —— 先跑这个，
 * 它会用**正式代码里同一套选择器阶梯**去看页面：输入框找到没有、
 * 发送按钮会被认成谁、回复节点有几条。找到的那条路径会原样打出来，
 * 对着调 `src/engine/page-scripts.cjs` 就行，不用改别处。
 *
 * 关键细节：这里强制把 userData 指到 App 的目录，**和正式运行共用同一个
 * `persist:deepseek` 分区**。否则探针看到的是「未登录」，和实际状态对不上。
 */

const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const scripts = require("../src/engine/page-scripts.cjs");

/** 与 package.json 的 name 一致：App 的 userData 目录名。 */
const APP_NAME = "pet-translator-desktop";

// 必须在 ready 之前改，否则分区目录已经算好了
app.setPath("userData", join(app.getPath("appData"), APP_NAME));

/** 与正式代码共用同一个分区，登录态互通。 */
const PARTITION = "persist:deepseek";
const START_URL = "https://chat.deepseek.com/";

/**
 * 探针要探「App 实际会打开的那个页面」—— 包括记住的专用会话地址。
 * 直接读 settings.json，不引 store.cjs（它依赖 Electron ready）。
 * @returns {string}
 */
function startUrl() {
  try {
    const raw = require("node:fs").readFileSync(
      join(app.getPath("userData"), "settings.json"),
      "utf8",
    );
    const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (typeof config.sessionUrl === "string" && config.sessionUrl.includes("/a/chat/s/")) {
      return config.sessionUrl;
    }
  } catch {
    // 没配过就是首页
  }
  return START_URL;
}

const visible = process.argv.includes("--visible");

/** 等人在这个窗口里登录，然后再探一次。 */
const waitLogin = process.argv.includes("--wait-login");

/** 深挖输入框周围的按钮：发送按钮是哪个、长什么样、在什么位置。 */
const deep = process.argv.includes("--deep");

/**
 * 只读的深挖脚本：把输入框的 5 层祖先、每层里的可点元素全摊开。
 * 用途是判断题「发送按钮到底是哪一个」—— 光看 class 名字不敢确定。
 */
const DEEP_SCRIPT = String.raw`
(() => {
  const visible = (node) => node !== null && node !== undefined && node.offsetParent !== null;
  const composers = [...document.querySelectorAll("textarea")].filter(visible);
  const composer = composers.length === 0 ? null : composers[composers.length - 1];
  if (composer === null) return { error: "no-composer" };

  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
  };
  const info = (node) => ({
    tag: node.tagName.toLowerCase(),
    cls: String(node.className || "").slice(0, 70),
    aria: node.getAttribute("aria-label") || undefined,
    title: node.getAttribute("title") || undefined,
    testid: node.getAttribute("data-testid") || undefined,
    text: String(node.textContent || "").trim().slice(0, 24),
    disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true",
    box: box(node),
    html: String(node.innerHTML || "").replace(/\s+/g, " ").slice(0, 110),
  });

  const levels = [];
  let scope = composer;
  for (let level = 0; level < 5 && scope !== null; level += 1) {
    scope = scope.parentElement;
    if (scope === null) break;
    levels.push({
      level: level + 1,
      cls: String(scope.className || "").slice(0, 60),
      textareaCount: [...scope.querySelectorAll("textarea")].filter(visible).length,
      buttons: [...scope.querySelectorAll('button, [role="button"]')].filter(visible).map(info),
    });
  }
  return { composer: info(composer), levels };
})()
`;

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1120,
    height: 820,
    show: visible,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const errors = [];
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    if (code !== -3) errors.push({ code, description, url });
  });

  try {
    await window.loadURL(startUrl());
  } catch (error) {
    console.log("[probe] " + JSON.stringify({ ok: false, stage: "load", error: String(error) }));
    app.quit();
    return;
  }

  // SPA 首屏要等，历史消息还要再等一会儿才铺出来
  await wait(6000);

  // --wait-login：窗口摆在那儿等人登录，登录态出现后自动往下走
  if (waitLogin) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const probe = await window.webContents.executeJavaScript(scripts.diagnose(), true).catch(() => null);
      if (probe?.signedIn === true) break;
      await wait(2000);
    }
    await wait(2500); // 等聊天页把输入框挂上
  }

  try {
    const report = await window.webContents.executeJavaScript(scripts.diagnose(), true);
    const extra = deep ? await window.webContents.executeJavaScript(DEEP_SCRIPT, true) : undefined;
    console.log(
      "[probe] " +
        JSON.stringify(
          { ok: true, userData: app.getPath("userData"), errors, report, deep: extra },
          null,
          2,
        ),
    );
  } catch (error) {
    console.log("[probe] " + JSON.stringify({ ok: false, stage: "execute", error: String(error) }));
  }

  if (visible) await wait(1200);
  app.quit();
});
