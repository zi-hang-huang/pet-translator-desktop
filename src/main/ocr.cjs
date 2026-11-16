/**
 * 截图 OCR：把图片变成文字。
 *
 * 后端是随程序一起打包的 Tesseract（tesseract.js，纯 WebAssembly），
 * 语言模型（英文 + 简体中文）放在同目录的 `tessdata/` 里。整条链路
 * **不联网、不装系统语言包、不需要 API Key、不出本机**。
 *
 * 为什么从 Windows.Media.Ocr 换过来：
 *   Windows 自带引擎只有「系统里装了对应 OCR 语言包」才能识别该语言，
 *   而在 Windows 11 上装这些语言包会卡在「组件存储待处理事务」里，
 *   命令返回成功、实际永远装不上（实测：add-capability 状态停在 InstallPending，
 *   DISM /checkhealth 报「可以修复组件存储」）。自带模型彻底断掉这个外部依赖，
 *   换任何一台 Windows 都能直接用。
 *
 * 性能：tesseract.js 的 worker 跑在 worker_threads 里，不阻塞 Electron 主进程；
 * 常驻一个 worker（首次创建约 0.5~2s），之后单次识别约 150~350ms。
 *
 * 放大：截图按物理像素裁剪，屏幕小字往往只有十几像素高，Tesseract 对小字
 * 识别很差。这里用 Electron 自带的 nativeImage 把短边偏小的图放大 2~3 倍再识别
 * —— 实测真实 18px 中文不放大错 3~4 个字，放大 2 倍后接近全对；放大 3~4 倍反而
 * 退化。且不引入任何原生图像库（sharp / canvas 都不用，免去 Electron 重编译）。
 *
 * 对外接口与旧实现完全一致：recognizeFile / status / warmUp / dispose。
 */

const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { readFileSync, writeFileSync, unlinkSync, existsSync } = require("node:fs");

/** 语言模型目录：和本文件同级，打包时随 src 一起进 resources/app。 */
const TESSDATA_DIR = join(__dirname, "tessdata");

/** 一个中英混合引擎同时处理中英文，省去按内容切引擎的判断。 */
const LANGS = "chi_sim+eng";

/** 引擎 OEM：1 = 仅 LSTM（我们的语言包就是 LSTM 模型），最快也最准。 */
const OEM = 1;

/** 单次识别的上限：正常 150~350ms，留足余量防止大图意外卡死。 */
const RECOGNIZE_TIMEOUT_MS = 30000;

/** 首次创建 worker（解压语言模型）的上限。 */
const CREATE_TIMEOUT_MS = 30000;

/** nativeImage 只在 Electron 里存在；纯 node 下（如跑基准脚本）没有，做降级。 */
let nativeImage;
try {
  nativeImage = require("electron").nativeImage;
} catch {
  nativeImage = undefined;
}

const state = {
  /** @type {any} */ worker: undefined,
  /** 正在创建 worker 的 promise（单飞，避免并发重复创建）。 */
  /** @type {Promise<any> | null} */ creating: null,
  /** 单次识别的串行闸门：worker 一次只处理一条。 */
  /** @type {Promise<any>} */ queue: Promise.resolve(),
  /**
   * 解压后语言模型的缓存目录。实测 tesseract.js 在 Node/Electron 下不会真把解压结果
   * 写盘（无持久 fs 缓存适配器），所以它目前只是「不影响正确性的占位参数」，留着是为了
   * 将来 tesseract.js 支持持久缓存时能直接用上。默认放临时目录，别污染用户配置目录。
   */
  cachePath: join(tmpdir(), "pet-tr-ocr-cache"),
  disposed: false,
  /** 最近一次失败的技术细节，供面板诊断。 */
  lastError: "",
};

/**
 * 可选初始化：注入缓存目录（等 tesseract.js 将来支持持久缓存时，放 userData 下更规整）。
 * @param {{cachePath?: string}} [options]
 */
function init(options) {
  if (options && typeof options.cachePath === "string" && options.cachePath !== "") {
    state.cachePath = options.cachePath;
  }
}

/**
 * 把一张图放大到适合 OCR 的尺寸。
 *
 * 屏幕小字的短边常常只有十几像素，Tesseract 直接认会崩。策略（倍数都是实测调出来的）：
 *   短边 < 120px（就几个字）→ 放大 3 倍
 *   短边 < 700px（常见选区）→ 放大 2 倍（真实 18px 字不放大错 3~4 个，2x 后近乎全对；3~4x 反而退化）
 * 再给放大后的总像素设个上限，避免整屏超大选区把内存撑爆。
 *
 * @param {string} imagePath
 * @returns {Buffer} 可直接交给 recognizer 的 PNG（或无法放大时的原始字节）
 */
function prepareImage(imagePath) {
  const raw = readFileSync(imagePath);
  if (nativeImage === undefined) return raw;

  let image;
  try {
    image = nativeImage.createFromPath(imagePath);
  } catch {
    return raw;
  }
  if (image.isEmpty()) return raw;

  const { width, height } = image.getSize();
  if (width < 2 || height < 2) return raw;

  const minSide = Math.min(width, height);
  let scale = 1;
  if (minSide < 120) scale = 3;      // 极小选区（就几个字）→ 放大更多
  else if (minSide < 700) scale = 2; // 常见屏幕选区 → 2x 是实测最优（18px 字放大后近乎全对）

  // 总像素上限约 1200 万（放大后），超了就回退到能放下的大小
  const MAX_PIXELS = 12_000_000;
  if (width * height * scale * scale > MAX_PIXELS) {
    const fit = Math.sqrt(MAX_PIXELS / (width * height));
    scale = Math.max(1, Math.min(scale, fit));
  }
  if (scale <= 1.01) return raw;

  try {
    const big = image.resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      quality: "best",
    });
    return big.toPNG();
  } catch {
    return raw;
  }
}

/**
 * 创建常驻 worker（单飞 + 幂等）。
 * @returns {Promise<any>}
 */
function ensureWorker() {
  if (state.worker !== undefined) return Promise.resolve(state.worker);
  if (state.creating !== null) return state.creating;

  state.creating = (async () => {
    let createWorker;
    try {
      ({ createWorker } = require("tesseract.js"));
    } catch (error) {
      state.creating = null;
      throw new Error("tesseract.js 未安装：" + String(error?.message ?? error));
    }

    const created = createWorker(LANGS, OEM, {
      langPath: TESSDATA_DIR,
      cachePath: state.cachePath,
      gzip: true,
      // 静默：识别进度、内部告警都不往控制台刷屏
      logger: () => {},
      errorHandler: () => {},
    });

    const worker = await withTimeout(created, CREATE_TIMEOUT_MS, "OCR 引擎启动超时");
    if (state.disposed) {
      try {
        await worker.terminate();
      } catch {
        // 已经退了
      }
      throw new Error("OCR 引擎已释放");
    }
    state.worker = worker;
    // 页面分割模式 6 =「当成一整块均匀排版的文字」。截图框选基本都是一小块文字，
    // 这个模式实测最稳：不会像 PSM 3 那样在框选边缘漏行，也不会像 11/12 那样把
    // 一长句切成碎片。必须先 setParameters 再识别。
    try {
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
    } catch {
      // 设不上就退回默认模式，不影响识别
    }
    state.creating = null;
    state.lastError = "";
    return worker;
  })().catch((error) => {
    state.creating = null;
    state.lastError = String(error?.message ?? error);
    throw error;
  });

  return state.creating;
}

/**
 * 给一个 promise 套上超时。
 * @template T @param {Promise<T>} promise @param {number} ms @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 串行化：worker 一次只处理一条识别。
 * @template T @param {() => Promise<T>} task @returns {Promise<T>}
 */
function serialized(task) {
  const run = state.queue.then(task, task);
  state.queue = run.catch(() => {});
  return run;
}

/**
 * 清理文本。
 *
 * 两个必须处理的脏数据：
 *  1. Tesseract 识别中文时会在每个汉字之间插空格（"文 件 编 辑"），直接显示既难看又浪费
 *     翻译的 token。这里只删「两个 CJK 字符之间」的空格；拉丁词与中文交界处的空格
 *     （"使用 PyTorch"）保留，否则英文单词会粘到中文上。
 *  2. Tesseract 会吐空行。截图翻译不需要保留版式，空行一律丢掉。
 */
const CJK_RANGES = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef";
const CJK_SPACE_RE = new RegExp(`(?<=[${CJK_RANGES}])[ \\t]+(?=[${CJK_RANGES}])`, "g");

function tidy(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(CJK_SPACE_RE, "").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * 识别一张图片。
 *
 * 永不抛错：调用方（热键 / 面板）不该被 OCR 细节炸到。失败就把错误码和
 * 人话理由放进返回值。
 *
 * @param {string} imagePath - 本地图片绝对路径（png 为主）
 * @returns {Promise<{ok: boolean, text: string, lines: number, ms: number, lang: string, reason?: string, detail?: string}>}
 */
async function recognizeFile(imagePath) {
  return serialized(async () => {
    const started = Date.now();
    let tempPath;
    try {
      const worker = await ensureWorker();

      const prepared = prepareImage(imagePath);
      tempPath = join(tmpdir(), `pet-tr-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
      writeFileSync(tempPath, prepared);

      const result = await withTimeout(worker.recognize(tempPath), RECOGNIZE_TIMEOUT_MS, "OCR 识别超时");
      const text = tidy(result?.data?.text);
      const lines = text === "" ? 0 : text.split("\n").filter((line) => line.trim() !== "").length;

      return {
        ok: text !== "",
        text,
        lines,
        ms: Date.now() - started,
        lang: LANGS,
        reason: text === "" ? "ocr-failed" : undefined,
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      // worker 挂了就清掉，下一次识别会重新创建
      if (state.worker !== undefined && /terminate|worker|abort/i.test(message)) {
        state.worker = undefined;
      }
      return {
        ok: false,
        text: "",
        lines: 0,
        ms: Date.now() - started,
        lang: LANGS,
        reason: "engine-missing",
        detail: message,
      };
    } finally {
      if (tempPath !== undefined && existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // 删不掉就交给临时目录自己清
        }
      }
    }
  });
}

/**
 * 当前 OCR 能力（面板用来提示）。自带模型永远可用，所以只要 worker 起得来就是 ok。
 * @returns {Promise<{ok: boolean, langs: string[], detail?: string}>}
 */
async function status() {
  try {
    await ensureWorker();
    return { ok: true, langs: LANGS.split("+") };
  } catch (error) {
    return { ok: false, langs: [], detail: String(error?.message ?? error) };
  }
}

/** App 启动时预热 OCR 引擎（后台创建 worker，别等第一次截图才现起）。 */
function warmUp() {
  if (state.disposed) return;
  ensureWorker().catch(() => {
    // 起不来就等第一次真正识别时再试
  });
}

/** 退出时收尾。 */
function dispose() {
  state.disposed = true;
  const worker = state.worker;
  state.worker = undefined;
  state.creating = null;
  try {
    worker?.terminate?.();
  } catch {
    // 已经退了
  }
}

module.exports = { init, recognizeFile, status, warmUp, dispose };
