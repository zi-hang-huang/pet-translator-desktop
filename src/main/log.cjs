/**
 * 文件日志。
 *
 * 打包版双击启动，没有控制台；出了问题用户只能说「卡住了」，我什么都看不到。
 * 这个模块把主进程的 console 抄一份到 `%APPDATA%\pet-translator-desktop\app.log`，
 * 出问题时让用户把这个文件发来就行。
 *
 * 用最简单的同步追加：日志量很小（一次翻译几行），异步反而会丢。
 * 超过 1MB 轮转一次，只留一份旧的 —— 够定位最近一次故障。
 */

const { app } = require("electron");
const { appendFileSync, mkdirSync, renameSync, statSync } = require("node:fs");
const { join } = require("node:path");

/** 单文件上限。超过就轮转成 app.log.1。 */
const MAX_BYTES = 1024 * 1024;

/** @type {string | null} */
let cachedPath = null;

/** @returns {string} */
function logPath() {
  if (cachedPath === null) cachedPath = join(app.getPath("userData"), "app.log");
  return cachedPath;
}

/** 轮转：只在超限时做一次 rename，不读不写内容。 */
function rotateIfNeeded() {
  try {
    const path = logPath();
    const stats = statSync(path);
    if (stats.size > MAX_BYTES) renameSync(path, path + ".1");
  } catch {
    // 文件还不存在，或正在被占用 —— 都不影响继续写
  }
}

/**
 * 把一个值转成一行文本。
 * @param {unknown} value
 * @returns {string}
 */
function format(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 追加一行。
 * @param {string} level @param {unknown[]} args
 */
function append(level, args) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    rotateIfNeeded();
    const time = new Date().toISOString().slice(11, 23);
    appendFileSync(logPath(), `${time} ${level} ${args.map(format).join(" ")}\n`, "utf8");
  } catch {
    // 日志写不进去不能影响主流程
  }
}

/** 接管 console（保留原有输出，控制台里照常能看）。 */
function install() {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => {
    original.log(...args);
    append("INFO ", args);
  };
  console.warn = (...args) => {
    original.warn(...args);
    append("WARN ", args);
  };
  console.error = (...args) => {
    original.error(...args);
    append("ERROR", args);
  };
}

module.exports = { install, logPath };
