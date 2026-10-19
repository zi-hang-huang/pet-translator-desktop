/**
 * 方案 A：页面代理引擎。
 *
 * 它做的事就是「一个手很快的人在 DeepSeek 网页上打字」：
 * 把提示词填进输入框、点发送、盯着最后一条消息直到不再变长，然后把文字拿回来。
 *
 * 为什么不自己发 API 请求（方案 B）：网页版那条 completion 接口前面挂着 PoW
 * （DeepSeekHashV1，实现在官方的 sha3 wasm 里），自己实现要跟着前端一起变；
 * 而页面代理的签名、PoW、风控、模型切换全部由页面自己负责 —— 我们一行都不猜。
 *
 * 代价是慢（几秒）且必须串行。串行在调用方（主进程的 translating 锁）保证。
 */

const deepseek = require("../main/deepseek-window.cjs");
const scripts = require("./page-scripts.cjs");

/** 轮询间隔。 */
const POLL_MS = 240;

/** 从发送到「最后一条消息出现」的等待上限。 */
const APPEAR_TIMEOUT_MS = 45_000;

/**
 * 文本连续多少次轮询不变就算写完（240ms × 10 ≈ 2.4 秒）。
 *
 * 这个数不能小。曾经是 6（1.4 秒），而且还有一条"generating === false 就提前收"
 * 的加速分支 —— 结果把回复截断成 1~2 个字：流式输出的块间隔偶尔超过半秒，
 * 被当成"写完了"。更糟的是页面其实还在生成，下一次发送就点到了"停止"，
 * 于是那条消息永远发不出去。**不要为了快两秒去猜生成结束。**
 */
const STABLE_POLLS = 10;

/** 整体上限。 */
const HARD_TIMEOUT_MS = 120_000;

/**
 * 会话超过这么多条消息就开新对话。
 *
 * 一个来回 = 2 条（提问 + 回复），所以 30 条约等于 15 次翻译之后换一个会话。
 * 换的理由有两个，见 translate() 里的注释。
 */
const SESSION_MAX_MESSAGES = 30;

/** 两次翻译之间的最小间隔。连续猛翻会被网页版限流，回复会退化成一两个字。 */
const MIN_INTERVAL_MS = 1500;

/** 上一次翻译结束的时刻。 */
let lastFinishedAt = 0;

/** @param {number} ms @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} code - 给 UI 判断用的错误码。
 * @param {string} message - 给人看的一句话。
 * @returns {Error}
 */
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 拼提示词。
 * @param {string} text @param {string} target
 * @returns {string}
 */
function promptFor(text, target) {
  const rule =
    target === "zh" ? "翻成简体中文"
      : target === "en" ? "翻成英文"
        : target === "ja" ? "翻成日文"
          : "自动判断：原文是中文就翻成英文，否则翻成中文";

  return [
    `你是翻译工具。把 <text> 里的内容${rule}。`,
    "规则：",
    "1. 只输出译文，不要解释、不要加引号、不要包在代码块里；",
    "2. 保留原文的换行、段落和列表结构；",
    "3. 专有名词、公式、代码、URL 原样保留。",
    "<text>",
    text,
    "</text>",
  ].join("\n");
}

/**
 * 等页面把输入框挂出来。
 *
 * `loadURL` 的 promise 只代表「文档加载完」，SPA 还要再跑一会儿才渲染聊天界面。
 * 早期版本在这里直接诊断，结果 Vite/React 一挂载慢一点就误报「页面找不到输入框」。
 *
 * 登录页没有输入框，所以未登录时只等 4 秒就放弃，别让用户干等 20 秒。
 * @returns {Promise<any>} 最后一次诊断结果。
 */
async function waitForComposer() {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < 20_000) {
    last = await deepseek.run(scripts.diagnose());
    if (last?.signedIn === true && last?.hasComposer === true) return last;
    const limit = last?.signedIn === false ? 4000 : 20_000;
    if (Date.now() - started > limit) break;
    await wait(400);
  }
  return last;
}

/**
 * 等聊天页稳定下来再动手。
 *
 * 打开一个已有历史的会话时，消息是**异步渲染**的：页面 `did-finish-load`
 * 之后还要过一会儿才把气泡铺出来。如果这时候读到的条数是 0，基线就错了，
 * 后面会把「自己的提问气泡」当成助手回复 —— 表现出来就是「译文=原文」。
 *
 * 判据：连续 3 次轮询条数不变；如果这是个会话地址（`/a/chat/s/…`），
 * 还要求条数 > 0 —— 会话页必然有历史，读到 0 只能是还没渲染完。
 *
 * @param {boolean} expectHistory - 是否等了历史页。
 * @param {() => boolean} [shouldAbort] - 用户是否按了取消。
 * @returns {Promise<number>} 稳定后的消息条数。
 */
async function waitForChatSettled(expectHistory, shouldAbort) {
  const started = Date.now();
  let last = -1;
  let stable = 0;

  while (Date.now() - started < 10_000) {
    if (typeof shouldAbort === "function" && shouldAbort()) throw fail("aborted", "已取消");
    const snapshot = await deepseek.run(scripts.read());
    const count = Number(snapshot?.count ?? 0);
    if (count === last) stable += 1;
    else {
      stable = 0;
      last = count;
    }
    const ready = stable >= 2 && Date.now() - started > 1000 && (!expectHistory || count > 0);
    if (ready) break;
    await wait(320);
  }
  return Math.max(last, 0);
}

/**
 * 等最后一条消息写完。
 * @param {number} beforeCount - 发送前的消息条数（只作辅助信号）。
 * @param {string} beforeText - 发送前最后一条消息的正文。
 * @param {string} prompt - 我们刚发出去的提示词，用来识别「这条还是我自己的气泡」。
 * @param {() => boolean} [shouldAbort] - 用户是否按了取消。
 * @returns {Promise<string>} 回复正文。
 */
async function waitForReply(beforeCount, beforeText, prompt, shouldAbort) {
  const started = Date.now();
  let last = "";
  let stable = 0;
  let polls = 0;
  /** 提示词开头的固定串：用户气泡里一定有它，助手的回复里不该有。 */
  const echoMarker = prompt.slice(0, 12);

  while (Date.now() - started < HARD_TIMEOUT_MS) {
    await wait(POLL_MS);

    // 用户按了 Esc：立刻放手，别让他对着「翻译中」干等
    if (typeof shouldAbort === "function" && shouldAbort()) throw fail("aborted", "已取消");

    const snapshot = await deepseek.run(scripts.read());
    const count = Number(snapshot?.count ?? 0);
    const text = String(snapshot?.text ?? "").trim();

    // 每 ~2 秒留一行观测：卡住时能看出是"条数不对""文本一直在变"还是"generating 骗人"
    polls += 1;
    if (polls % 8 === 0) {
      console.log(
        `[pet-tr] poll #${polls} count=${count}/${beforeCount} len=${text.length} stable=${stable} generating=${String(snapshot?.generating)}`,
      );
    }

    if (text === "") continue;
    // 还是上一轮的回复
    if (text === beforeText) continue;
    // 我们自己的提问气泡
    if (text.includes(echoMarker)) continue;

    // 两个信号满足任意一个就算"新回复已经出现"，别只看条数：
    // 会话变长后 DeepSeek 会虚拟化消息列表（旧消息卸载出 DOM），
    // 条数**不再**按 +2 增长 —— 只信条数的话，多翻几次之后就永远等不到。
    const countGrew = count > beforeCount;
    const textChanged = text !== beforeText;
    if (!countGrew && !textChanged) continue;

    if (text === last) stable += 1;
    else {
      stable = 0;
      last = text;
    }

    // 写完的信号只有一个：文本连续 STABLE_POLLS 次不变。
    // 曾经还有一条 `generating === false` 的加速分支，但那个信号是假的 ——
    // DeepSeek 的"停止生成"按钮没有 aria-label/title，检测永远是 false，
    // 于是每次都在半秒后误判完成。删掉，宁可多等两秒。
    if (stable >= STABLE_POLLS) break;

    // 兜底：有些会话里新旧两条回复的正文可能一模一样（比如连着翻同一句），
    // 那就只看"已经等了很久 + 文本不为空"，别死等。
    if (Date.now() - started > APPEAR_TIMEOUT_MS) break;
  }

  if (last === "") throw fail("empty-reply", "等到了回复节点，但里面是空的");
  return last;
}

/**
 * 翻一段文字。
 * @param {string} text - 原文。
 * @param {{target?: string, onProgress?: (stage: string) => void}} [options]
 * @returns {Promise<{text: string, provider: string, ms: number}>}
 */
async function translate(text, options = {}) {
  const started = Date.now();
  const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  // 连续猛翻会被网页版限流（实测：连着十几次之后回复会变成一两个字）。
  // 两次翻译之间至少隔 1.5 秒，成本可以忽略，能挡掉大部分"手快"引发的降级。
  const sinceLast = Date.now() - lastFinishedAt;
  if (sinceLast < MIN_INTERVAL_MS) await wait(MIN_INTERVAL_MS - sinceLast);

  progress("open");
  await deepseek.open();

  progress("diagnose");
  const diagnosis = await waitForComposer();
  if (diagnosis?.signedIn !== true) {
    throw fail("need-login", "需要登录 DeepSeek：点面板里的「打开 DeepSeek 窗口」登录一次");
  }
  if (diagnosis?.hasComposer !== true) {
    throw fail("no-composer", "页面上找不到输入框，DeepSeek 可能改版了（跑 scripts/probe-deepseek.cjs 看看）");
  }

  progress("fill");
  const prompt = promptFor(text, options.target ?? "auto");
  const filled = await deepseek.run(scripts.fill(prompt));
  if (filled?.ok !== true) {
    throw fail("fill-failed", `填字失败：${filled?.reason ?? "未知原因"}`);
  }

  // 基线必须在页面稳定之后取，否则历史还没渲染完会读到 0
  const expectHistory = String(diagnosis?.href ?? "").includes("/a/chat/s/");
  let baseline = await waitForChatSettled(expectHistory, options.shouldAbort);

  // 会话太长就换一个新的。两个原因：
  //   1. 页面上消息越多越慢，虚拟化之后连"条数"都不再可靠；
  //   2. 上下文里堆着之前几十段译文，会串味（模型会参考上一轮的语气和术语）。
  // 翻译本来就不需要上下文，换掉零损失；代价是历史里多一个会话。
  if (baseline >= SESSION_MAX_MESSAGES) {
    console.log(`[pet-tr] 会话已有 ${baseline} 条消息，开新对话（避免越翻越慢、上下文串味）`);
    await deepseek.reset();
    const fresh = await waitForComposer();
    if (fresh?.hasComposer !== true) {
      throw fail("no-composer", "开新对话后找不到输入框，DeepSeek 可能改版了");
    }
    baseline = 0;
  }

  const baselineText = String((await deepseek.run(scripts.read()))?.text ?? "").trim();
  console.log(
    `[pet-tr] deepseek · ${String(diagnosis?.href ?? "?")} · messages=${baseline} · last=${baselineText.length}字 · send=${String(diagnosis?.sendButton?.how ?? "?")}`,
  );

  progress("send");
  const sent = await deepseek.run(scripts.send());

  // 「发出去了没有」的判据是**页面上出现了新消息**，不是 send() 的返回值。
  // 新开对话时页面要先建会话再清空输入框，可能比我们的 320ms 慢半拍 ——
  // 那种情况 send() 会报"没清空"，但消息其实已经发出去了。
  await wait(700);
  let visible = await deepseek.run(scripts.read());
  const grew = () =>
    Number(visible?.count ?? 0) > baseline || String(visible?.text ?? "").trim() !== baselineText;

  if (!grew()) {
    await wait(1800);
    visible = await deepseek.run(scripts.read());
  }
  if (!grew()) {
    throw fail("send-failed", `消息没有发出去（${sent?.how ?? "?"}，输入框剩 ${sent?.remaining ?? "?"} 字）`);
  }
  console.log(`[pet-tr] sent via ${String(sent?.how ?? "?")} · count ${baseline} → ${String(visible?.count ?? "?")}`);

  progress("wait");
  const reply = await waitForReply(baseline, baselineText, prompt, options.shouldAbort);

  // 明显不合理的短回复：多半是被限流截断了，不要当成译文显示。
  // 判据故意保守（长原文 + 回复短得离谱），短句翻译不会被误伤。
  const tooShort = text.length >= 40 && reply.length <= Math.max(6, Math.round(text.length * 0.04));
  if (tooShort) {
    throw fail(
      "short-reply",
      `DeepSeek 只回了 ${reply.length} 个字（原文 ${text.length} 字），像是被限流截断了。等十几秒再试`,
    );
  }

  const ms = Date.now() - started;
  console.log(`[pet-tr] translated ${text.length} → ${reply.length} chars in ${ms}ms`);
  lastFinishedAt = Date.now();
  return { text: reply, provider: "deepseek-web", ms };
}

/**
 * 后端状态，给面板的状态灯用。
 * @returns {{status: "off" | "ok" | "warn" | "bad", detail: string, url: string}}
 */
function status() {
  return deepseek.status();
}

/** 清空翻译会话（回到新对话）。 */
async function resetConversation() {
  await deepseek.reset();
}

/** 打开网页窗口，让人去登录 / 过验证。 */
function showWindow() {
  deepseek.show();
}

/** 退出时收尾。 */
function dispose() {
  deepseek.destroy();
}

module.exports = {
  translate,
  status,
  resetConversation,
  showWindow,
  dispose,
  id: "deepseek-web",
  label: "DeepSeek 网页版",
  note: "页面代理 · 会留会话记录",
};
