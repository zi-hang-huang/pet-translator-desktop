/**
 * 占位引擎（M2）。
 *
 * 存在的唯一目的：让 UI 的整条链路先跑通 —— 忙碌态、耗时、复制、错误、状态灯，
 * 都能在没有后端的情况下验完。M3 用 `web-page.cjs` 顶掉它，UI 一行都不用改。
 *
 * 接口（M3 的真引擎必须同形）：
 *   translate(text, { target }) → { text, provider, ms }
 *   失败时抛错，错误信息会原样显示在面板上。
 */

/** 占位响应的延迟：故意留 600ms，好让「翻译中」的转圈能被看见。 */
const DELAY_MS = Number(process.env.PET_TR_STUB_MS ?? 600);

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} text - 原文。
 * @param {{target?: string}} options
 * @returns {Promise<{text: string, provider: string, ms: number}>}
 */
async function translate(text, options) {
  const started = Date.now();
  await wait(DELAY_MS);

  // 用一个环境变量就能让整条链路走失败分支，专供冒烟与演示
  if (process.env.PET_TR_ENGINE === "error") {
    throw new Error("占位引擎被要求失败（PET_TR_ENGINE=error）");
  }

  const target = options?.target ?? "auto";
  const label = target === "auto" ? "自动" : target;
  return {
    // 明确标注是占位，避免把回显误当成译文
    text: `〔占位翻译 · ${label}〕${text}`,
    provider: "stub",
    ms: Date.now() - started,
  };
}

module.exports = { translate, id: "stub", label: "占位引擎", note: "M3 接 DeepSeek 网页版" };
