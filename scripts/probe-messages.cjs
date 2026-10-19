/**
 * 消息结构探针：把 `.ds-message` 逐个摊开，看我们到底读到了什么。
 *
 *     electron scripts/probe-messages.cjs
 *
 * 背景：`read()` 用 `last.querySelector('[class*="ds-markdown"]')` 取正文，
 * 结果有时只拿到 1 个字 —— 说明第一个匹配到的 `ds-markdown*` 是个很小的子元素
 * （比如引用角标 ds-markdown-cite），不是正文根节点。
 */

const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");

app.setPath("userData", join(app.getPath("appData"), "pet-translator-desktop"));

/** 与正式代码共用分区。 */
const PARTITION = "persist:deepseek";

/** 读 settings 里的会话地址（和 App 打开同一个页面）。 */
function startUrl() {
  try {
    const config = JSON.parse(
      readFileSync(join(app.getPath("userData"), "settings.json"), "utf8").replace(/^\uFEFF/, ""),
    );
    if (typeof config.sessionUrl === "string" && config.sessionUrl.includes("/a/chat/s/")) {
      return config.sessionUrl;
    }
  } catch {
    // 没配过就是首页
  }
  return "https://chat.deepseek.com/";
}

const SCRIPT = String.raw`
(() => {
  const short = (value, max = 46) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) + "…" : text;
  };
  const messages = [...document.querySelectorAll(".ds-message")];
  return {
    href: location.href,
    count: messages.length,
    items: messages.map((node, index) => {
      const marks = [...node.querySelectorAll('[class*="ds-markdown"]')];
      const first = marks[0] ?? null;
      return {
        index,
        cls: short(node.className, 70),
        textLen: String(node.innerText ?? "").trim().length,
        textHead: short(node.innerText, 40),
        markCount: marks.length,
        firstMarkCls: first === null ? null : short(first.className, 50),
        firstMarkLen: first === null ? 0 : String(first.innerText ?? "").trim().length,
        deepestMarkLen: marks.length === 0 ? 0 : Math.max(...marks.map((m) => String(m.innerText ?? "").trim().length)),
      };
    }),
  };
})()
`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });

  await window.loadURL(startUrl());
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const report = await window.webContents.executeJavaScript(SCRIPT, true);
  console.log("[probe-messages] " + JSON.stringify(report, null, 2));
  app.quit();
});
