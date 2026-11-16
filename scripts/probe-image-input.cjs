/**
 * 一次性探针：验证「能不能把一张本地 PNG 塞进 DeepSeek 网页的输入框」。
 *
 *     electron scripts/probe-image-input.cjs [--visible] [--image 路径]
 *
 * 为什么单独写：
 *   整图直翻的唯一技术风险就是「图进不去输入框」。先把这一步验证死，
 *   再动工程代码，免得写完一堆发现页面不吃合成文件。
 *
 * 关键设计：
 *   - **不碰正在运行的 App**。正式 App 占着 `persist:deepseek` 分区的锁。
 *     这里把分区目录复制到临时 userData，再用它开窗口 —— 登录 cookie 跟着
 *     复制过去，所以探针看到的仍是已登录状态，且和真 App 互不影响。
 *   - 注入走 Electron 主进程的官方能力：webContents.debugger 的
 *     DOM.setFileInputFiles。它等价于用户手动选文件，不依赖 isTrusted，
 *     React 也拦不住。
 *   - 验证分三层：① 页面里有没有 file input；② 设完之后 input.files 变了没；
 *     ③ 输入框区域有没有冒出图片预览（img / blob: / 缩略图节点）。
 */

const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const fs = require("node:fs");

const APP_NAME = "pet-translator-desktop";
const PARTITION = "persist:deepseek";
const START_URL = "https://chat.deepseek.com/";

const visible = process.argv.includes("--visible");
const imageIndex = process.argv.indexOf("--image");
const imagePath =
  imageIndex >= 0
    ? process.argv[imageIndex + 1]
    : join(__dirname, "_probe-test-image.png");

/** 临时 userData：装复制过来的分区。 */
const tempUserData = join(tmpdir(), `pet-tr-probe-${Date.now()}`);

/**
 * 把真 App 的分区复制到临时 userData。登录态（Cookies / Local Storage）都在里面。
 * @returns {{ok: boolean, copied: string[], note: string}}
 */
function cloneProfile() {
  const srcRoot = join(app.getPath("appData"), APP_NAME);
  const srcPart = join(srcRoot, "Partitions", "deepseek");
  const dstPart = join(tempUserData, "Partitions", "deepseek");
  const copied = [];
  try {
    fs.mkdirSync(join(tempUserData, "Partitions"), { recursive: true });
    if (fs.existsSync(srcPart)) {
      fs.cpSync(srcPart, dstPart, { recursive: true });
      copied.push("Partitions/deepseek");
    }
    // settings.json 里存着记住的会话地址，一并带上，尽量对齐真 App 打开的那页
    const srcSettings = join(srcRoot, "settings.json");
    if (fs.existsSync(srcSettings)) {
      fs.copyFileSync(srcSettings, join(tempUserData, "settings.json"));
      copied.push("settings.json");
    }
    return { ok: true, copied, note: "" };
  } catch (error) {
    return { ok: false, copied, note: String(error?.message ?? error) };
  }
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读记住的会话地址（复制过来的那份）。 */
function startUrl() {
  try {
    const raw = fs.readFileSync(join(tempUserData, "settings.json"), "utf8");
    const cfg = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (typeof cfg.sessionUrl === "string" && cfg.sessionUrl.includes("/a/chat/s/")) {
      return cfg.sessionUrl;
    }
  } catch {
    /* 没有就用首页 */
  }
  return START_URL;
}

/** 页面里扫描 file input，并把输入框附近的按钮也摊开（找上传按钮）。 */
const SCAN_INPUTS = String.raw`
(() => {
  const visible = (n) => n && n.offsetParent !== null;
  const inputs = [...document.querySelectorAll('input[type="file"]')].map((n) => {
    const r = n.getBoundingClientRect();
    return {
      accept: n.getAttribute("accept") || "",
      multiple: n.multiple === true,
      hidden: n.type === "file" && (n.offsetParent === null || r.width === 0),
      id: n.id || "",
      name: n.getAttribute("name") || "",
      filesCount: n.files ? n.files.length : -1,
      box: [Math.round(r.width), Math.round(r.height)],
      parentCls: String(n.parentElement && n.parentElement.className || "").slice(0, 60),
    };
  });
  const composers = [...document.querySelectorAll("textarea")].filter(visible);
  const composer = composers.length ? composers[composers.length - 1] : null;
  const buttons = [];
  if (composer) {
    let scope = composer;
    for (let i = 0; i < 4 && scope; i += 1) {
      scope = scope.parentElement;
      if (!scope) break;
      [...scope.querySelectorAll('button, [role="button"], label')].forEach((b) => {
        buttons.push({
          tag: b.tagName.toLowerCase(),
          cls: String(b.className || "").slice(0, 40),
          aria: b.getAttribute("aria-label") || "",
          title: b.getAttribute("title") || "",
          text: String(b.textContent || "").trim().slice(0, 12),
          box: [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)],
        });
      });
      if (buttons.length > 25) break;
    }
  }
  return { inputCount: inputs.length, inputs, hasComposer: composer !== null, buttons };
})()
`;

/** 点一下可能的「上传/附件」按钮（排除发送键），让隐藏的 file input 现形。 */
const CLICK_UPLOAD = String.raw`
(() => {
  const visible = (n) => n && n.offsetParent !== null;
  const composers = [...document.querySelectorAll("textarea")].filter(visible);
  const composer = composers.length ? composers[composers.length - 1] : null;
  if (!composer) return { clicked: false, reason: "no-composer" };
  let scope = composer;
  let best = null;
  for (let i = 0; i < 4 && scope; i += 1) {
    scope = scope.parentElement;
    if (!scope) break;
    const btns = [...scope.querySelectorAll('button, [role="button"], label')].filter(visible);
    for (const b of btns) {
      const label = String(b.getAttribute("aria-label") || b.getAttribute("title") || "") + " " + String(b.className || "");
      if (/upload|attach|file|image|图片|附件|上传/i.test(label)) { best = b; break; }
      // label[for] 直接绑到 file input 的，也算
      if (b.tagName.toLowerCase() === "label" && b.getAttribute("for")) { best = b; break; }
    }
    if (best) break;
  }
  if (best) {
    best.click();
    return { clicked: true, how: String(best.getAttribute("aria-label") || best.title || String(best.className || "").slice(0, 40)) };
  }
  return { clicked: false, reason: "no-upload-button-found" };
})()
`;

/** 设完文件后，看输入框区域有没有图片预览冒出来。 */
const SCAN_PREVIEW = String.raw`
(() => {
  const visible = (n) => n && n.offsetParent !== null;
  const composers = [...document.querySelectorAll("textarea")].filter(visible);
  const composer = composers.length ? composers[composers.length - 1] : null;
  let scope = composer;
  for (let i = 0; i < 4 && scope; i += 1) scope = scope && scope.parentElement;
  const root = scope || document;
  const imgs = [...root.querySelectorAll("img")].map((n) => ({
    src: String(n.src || "").slice(0, 50),
    blob: String(n.src || "").startsWith("blob:"),
    box: [Math.round(n.getBoundingClientRect().width), Math.round(n.getBoundingClientRect().height)],
  }));
  const files = [...document.querySelectorAll('input[type="file"]')].map((n) => ({
    filesCount: n.files ? n.files.length : -1,
    names: n.files ? [...n.files].map((f) => f.name) : [],
    sizes: n.files ? [...n.files].map((f) => f.size) : [],
  }));
  // 常见附件/预览容器
  const previewNodes = [...root.querySelectorAll('[class*="attach" i], [class*="preview" i], [class*="image" i], [class*="file" i]')]
    .map((n) => String(n.className || "").slice(0, 50))
    .slice(0, 12);
  return { imgs, files, previewNodes };
})()
`;

app.whenReady().then(async () => {
  const cloned = cloneProfile();
  app.setPath("userData", tempUserData);

  const out = { ok: false, step: "start", cloned, imagePath, imageExists: fs.existsSync(imagePath) };
  if (!out.imageExists) {
    console.log("[probe-image] " + JSON.stringify({ ...out, error: "测试图不存在" }));
    app.quit();
    return;
  }
  if (!cloned.ok) {
    console.log("[probe-image] " + JSON.stringify({ ...out, error: "复制分区失败：" + cloned.note }));
    app.quit();
    return;
  }

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

  const dbg = window.webContents.debugger;
  try {
    dbg.attach("1.3");
    out.debugger = "attached";
  } catch (error) {
    out.debugger = "attach-failed: " + String(error?.message ?? error);
  }

  try {
    out.step = "load";
    await window.loadURL(startUrl());
    await wait(6000);

    out.step = "scan-before";
    out.before = await window.webContents.executeJavaScript(SCAN_INPUTS, true);

    // 没有 file input 就先点上传按钮把它唤出来
    if (out.before.inputCount === 0) {
      out.step = "click-upload";
      out.click = await window.webContents.executeJavaScript(CLICK_UPLOAD, true);
      await wait(1200);
      out.afterClick = await window.webContents.executeJavaScript(SCAN_INPUTS, true);
    }

    const scan = out.afterClick || out.before;

    out.step = "set-file";
    if (scan.inputCount > 0) {
      const { root } = await dbg.sendCommand("DOM.getDocument", { depth: -1 });
      const { nodeId } = await dbg.sendCommand("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: 'input[type="file"]',
      });
      out.fileNodeId = nodeId;
      if (nodeId) {
        await dbg.sendCommand("DOM.setFileInputFiles", { files: [imagePath], nodeId });
        out.setFile = "ok";
      } else {
        out.setFile = "no-node-id";
      }
      await wait(1800);
      out.step = "scan-preview";
      out.preview = await window.webContents.executeJavaScript(SCAN_PREVIEW, true);
    } else {
      out.setFile = "skipped-no-input";
    }

    out.step = "screenshot";
    try {
      const img = await window.webContents.capturePage();
      const shotPath = join(__dirname, "_probe-image-result.png");
      fs.writeFileSync(shotPath, img.toPNG());
      out.screenshot = shotPath;
    } catch (error) {
      out.screenshotError = String(error?.message ?? error);
    }

    out.ok = true;
  } catch (error) {
    out.error = String(error?.message ?? error);
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      /* ignore */
    }
    if (visible) await wait(800);
    console.log("[probe-image] " + JSON.stringify(out, null, 2));
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    app.quit();
  }
});
