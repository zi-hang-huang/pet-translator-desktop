/**
 * 本地翻译历史。
 *
 * **单独一个文件，不塞进 settings.json**：历史会长（上限 200 条），而 settings 是
 * 几百字节的小文件，每次拖球/缩放都会同步写一次。把历史混进去，写盘就会跟着变重。
 *
 * 存盘策略和 store.cjs 一样用「临时文件 + rename」，防止断电留下半截 JSON。
 * 只存 `{src, out, target, ts, ms}` —— **不存页面 URL**，隐私上少一条线索。
 */

const { app } = require("electron");
const { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

/** 上限：FIFO 淘汰。再多也没人翻，还拖慢每次写盘。 */
const MAX_ENTRIES = 200;

/** 单条字段长度上限，防止一条超大文本把文件撑爆。 */
const MAX_FIELD = 4000;

/** @returns {string} 历史文件路径。 */
function historyPath() {
  return join(app.getPath("userData"), "history.json");
}

/**
 * 把任意输入规整成一条合法记录。非法就返回 null（调用方跳过）。
 * 这是纯函数，不碰磁盘，方便单测。
 * @param {any} raw
 * @returns {{id: string, src: string, out: string, target: string, ts: number, ms: number} | null}
 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const src = String(raw.src ?? "").slice(0, MAX_FIELD);
  const out = String(raw.out ?? "").slice(0, MAX_FIELD);
  if (src.trim() === "" || out.trim() === "") return null;
  const target = typeof raw.target === "string" ? raw.target : "auto";
  const ts = Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now();
  const ms = Number.isFinite(Number(raw.ms)) ? Math.max(0, Math.round(Number(raw.ms))) : 0;
  // id：时间戳 + 一小段内容哈希，够唯一、又不用引入 uuid 依赖
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : `${ts}-${hash(src + out)}`;
  return { id, src, out, target, ts, ms };
}

/**
 * 一个很短的字符串哈希（djb2 变体），只用来生成 id，不做安全用途。
 * @param {string} text
 * @returns {string}
 */
function hash(text) {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) {
    value = ((value << 5) + value + text.charCodeAt(index)) | 0;
  }
  return (value >>> 0).toString(36);
}

/**
 * 把新记录插到最前，并按上限截断。纯函数。
 * @param {Array<any>} entries - 现有记录（新的在前）
 * @param {any} entry - 要加的新记录
 * @param {number} [max]
 * @returns {Array<any>}
 */
function pushEntry(entries, entry, max = MAX_ENTRIES) {
  const list = Array.isArray(entries) ? entries.filter((item) => item !== null) : [];
  const normalized = normalizeEntry(entry);
  if (normalized === null) return list.slice(0, max);
  // 完全相同的一条（同一 id）重复加就提到最前，不重复堆两条
  const deduped = list.filter((item) => item.id !== normalized.id);
  return [normalized, ...deduped].slice(0, max);
}

/**
 * 按关键字过滤（在原文和译文里找），纯函数，大小写不敏感。
 * @param {Array<any>} entries
 * @param {string} query
 * @returns {Array<any>}
 */
function searchEntries(entries, query) {
  const keyword = String(query ?? "").trim().toLowerCase();
  const list = Array.isArray(entries) ? entries : [];
  if (keyword === "") return list;
  return list.filter(
    (item) =>
      String(item.src ?? "").toLowerCase().includes(keyword) ||
      String(item.out ?? "").toLowerCase().includes(keyword),
  );
}

/** @returns {Array<any>} 磁盘上的历史，坏文件按空处理。 */
function read() {
  try {
    if (!existsSync(historyPath())) return [];
    const text = readFileSync(historyPath(), "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeEntry).filter((item) => item !== null).slice(0, MAX_ENTRIES);
  } catch {
    // 文件坏了不该让整个 App 崩：当成空历史
    return [];
  }
}

/**
 * 整体写盘。
 * @param {Array<any>} entries
 * @returns {Array<any>} 实际落盘的记录
 */
function write(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter((item) => item !== null)
    .slice(0, MAX_ENTRIES);
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    const target = historyPath();
    const temporary = target + ".tmp";
    writeFileSync(temporary, JSON.stringify(list), "utf8");
    renameSync(temporary, target);
  } catch (error) {
    console.warn("pet-tr: history not saved:", String(error));
  }
  return list;
}

/**
 * 追加一条。
 * @param {{src: string, out: string, target?: string, ms?: number}} payload
 * @returns {Array<any>} 追加后的完整列表
 */
function add(payload) {
  const entry = normalizeEntry({ ...payload, ts: Date.now() });
  if (entry === null) return read();
  return write(pushEntry(read(), entry));
}

/**
 * 删一条（按 id）。
 * @param {string} id
 * @returns {Array<any>}
 */
function remove(id) {
  const key = String(id ?? "");
  return write(read().filter((item) => item.id !== key));
}

/** 清空。@returns {Array<any>} 恒为空数组。 */
function clear() {
  return write([]);
}

/** 导出给自测用。 */
module.exports = {
  MAX_ENTRIES,
  MAX_FIELD,
  historyPath,
  normalizeEntry,
  pushEntry,
  searchEntries,
  hash,
  read,
  write,
  add,
  remove,
  clear,
};
