/*
 * 朗读：包一层 Web Speech API（speechSynthesis）。
 *
 * 为什么单独一个文件：它有两块东西必须能单测 ——
 *   1. 「目标语言 → BCP-47 语言标签」的映射
 *   2. 「系统里有没有这个语言的语音包」的挑选逻辑
 * 这两块是纯函数，跟 DOM、跟 Electron 都无关，放在 ui 里也没法被 Node 直接 require，
 * 所以用 typeof 双出口（浏览器挂 window，Node 挂 module.exports），一份代码两处用。
 *
 * 已知平台坑（Windows）：Chromium 走系统 SAPI，**中文语音包默认常常没装**，
 * getVoices() 里只有 en-US。所以调用前必须先探测，没包就把按钮置灰，
 * 而不是点了没反应让用户以为坏了。
 */

/* eslint-disable no-var */

const PetSpeech = (function () {
  /** 目标语言 → 首选语言标签（按优先级）。 */
  const TARGET_LANG = {
    zh: ["zh-CN", "zh-TW", "zh-HK", "zh"],
    en: ["en-US", "en-GB", "en"],
    ja: ["ja-JP", "ja"],
  };

  /**
   * 粗判一段文字是什么语言。只用于「自动」档位下决定读哪种语音。
   * 判据很粗但够用：假名 → 日文；汉字 → 中文；其余当英文。
   * @param {string} text
   * @returns {"zh" | "ja" | "en"}
   */
  function detectLang(text) {
    const s = String(text ?? "");
    // 平假名 / 片假名：日文独有，先判，否则会被下面的汉字规则吃掉
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return "ja";
    if (/[\u4e00-\u9fff]/.test(s)) return "zh";
    return "en";
  }

  /**
   * 解析出一个目标语言档位应该用哪些语言标签。
   * @param {string} target - "auto" | "zh" | "en" | "ja"
   * @param {string} [text] - target=auto 时拿来判语言的正文
   * @returns {string[]}
   */
  function langCandidates(target, text) {
    const key = target === "auto" ? detectLang(text) : String(target ?? "");
    return TARGET_LANG[key] ?? TARGET_LANG.en;
  }

  /**
   * 从语音列表里挑一个能用的。
   * 先按完整标签精确匹配（zh-CN），再退到前缀匹配（任何 zh-*），最后 null。
   * @param {Array<{lang?: string, name?: string}>} voices
   * @param {string[]} candidates
   * @returns {{voice: any, lang: string} | null}
   */
  function pickVoice(voices, candidates) {
    if (!Array.isArray(voices) || voices.length === 0) return null;
    const norm = (value) => String(value ?? "").replace(/_/g, "-").toLowerCase();

    for (const want of candidates) {
      const target = norm(want);
      const exact = voices.find((voice) => norm(voice.lang) === target);
      if (exact !== undefined) return { voice: exact, lang: want };
    }
    for (const want of candidates) {
      const prefix = norm(want).split("-")[0];
      const loose = voices.find((voice) => norm(voice.lang).split("-")[0] === prefix);
      if (loose !== undefined) return { voice: loose, lang: want };
    }
    return null;
  }

  /**
   * 探测某个语言有没有语音包。
   * @param {Array<{lang?: string}>} voices
   * @param {string[]} candidates
   * @returns {boolean}
   */
  function hasVoiceFor(voices, candidates) {
    return pickVoice(voices, candidates) !== null;
  }

  /* ── 浏览器侧控制器（Node 里不存在 speechSynthesis，相关方法会安全降级） ── */

  /** @returns {boolean} */
  function supported() {
    return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
  }

  /**
   * 拿系统语音列表。Windows 上 getVoices() 首次常常返回空数组，
   * 真正的列表要等 voiceschanged 事件，所以这里等最多 800ms。
   * @returns {Promise<Array<{lang?: string, name?: string}>>}
   */
  function loadVoices() {
    return new Promise((resolve) => {
      if (!supported()) {
        resolve([]);
        return;
      }
      const synth = window.speechSynthesis;
      const now = synth.getVoices();
      if (now.length > 0) {
        resolve(now);
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        synth.removeEventListener?.("voiceschanged", finish);
        resolve(synth.getVoices());
      };
      synth.addEventListener?.("voiceschanged", finish);
      setTimeout(finish, 800);
    });
  }

  let currentUtterance = null;

  /**
   * 朗读一段文字。
   * @param {string} text
   * @param {{target?: string, rate?: number, onEnd?: () => void, onError?: (reason: string) => void}} [options]
   * @returns {{ok: boolean, reason?: string, lang?: string}}
   */
  function speak(text, options = {}) {
    if (!supported()) return { ok: false, reason: "unsupported" };
    const content = String(text ?? "").trim();
    if (content === "") return { ok: false, reason: "empty" };

    const synth = window.speechSynthesis;
    synth.cancel(); // 上一次没读完的先掐掉，否则会排队一直读下去

    const candidates = langCandidates(options.target ?? "auto", content);
    const picked = pickVoice(synth.getVoices(), candidates);
    // 没语音包时**仍然尝试用默认语音读**（英文包读中文至少不报错），
    // 但把 lang 告诉调用方，让它决定要不要提示「可能不准」。
    const utterance = new SpeechSynthesisUtterance(content);
    if (picked !== null) {
      utterance.voice = picked.voice;
      utterance.lang = picked.voice.lang ?? picked.lang;
    } else {
      utterance.lang = candidates[0];
    }
    const rate = Number(options.rate);
    utterance.rate = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;

    utterance.onend = () => {
      currentUtterance = null;
      options.onEnd?.();
    };
    utterance.onerror = (event) => {
      currentUtterance = null;
      options.onError?.(String(event?.error ?? "speech-error"));
    };

    currentUtterance = utterance;
    synth.speak(utterance);
    return { ok: true, lang: utterance.lang };
  }

  function stop() {
    if (!supported()) return;
    window.speechSynthesis.cancel();
    currentUtterance = null;
  }

  function isSpeaking() {
    return supported() && window.speechSynthesis.speaking;
  }

  return {
    // 纯函数（可单测）
    detectLang,
    langCandidates,
    pickVoice,
    hasVoiceFor,
    // 浏览器控制器
    supported,
    loadVoices,
    speak,
    stop,
    isSpeaking,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PetSpeech;
if (typeof window !== "undefined") window.PetSpeech = PetSpeech;
