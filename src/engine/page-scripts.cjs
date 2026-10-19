/**
 * 注入 DeepSeek 页面的 DOM 脚本。
 *
 * 全部是**字符串**，由主进程 `executeJavaScript` 执行。放在一个文件里的原因：
 * 页面一改版，坏掉的就是这几段；集中起来，修的时候只改这里、且能一眼看完。
 *
 * 选择器从站点自己的前端包里挖出来的（main.<hash>.js 的 i18n 表与组件代码）：
 *   - 输入框：`<textarea>`，中文 placeholder「给 DeepSeek 发送消息」
 *   - 消息节点：`.ds-message`，正文在内部的 `[class*="ds-markdown"]`
 *   - 生成中：出现「停止生成」按钮
 *
 * 但这里**不硬编码 placeholder 文案**（中英文界面不同），
 * 一律用「结构 + 兜底阶梯」找：找得到就用，找不到就报清楚缺什么。
 */

/** 找可见的输入框。DeepSeek 是 textarea，不是 contenteditable。 */
const FIND_COMPOSER = String.raw`
  const visible = (node) => node !== null && node !== undefined && node.offsetParent !== null;
  const composers = [...document.querySelectorAll("textarea")].filter(visible);
  const composer = composers.length === 0 ? null : composers[composers.length - 1];
`;

/** 找发送按钮：语义标签 → 设计系统结构 → 附近最后一个按钮。 */
const FIND_SEND = String.raw`
  const labelOf = (node) =>
    String(
      node.getAttribute("aria-label") ||
      node.getAttribute("title") ||
      node.getAttribute("data-testid") ||
      node.textContent ||
      "",
    );

  const clickable = (node) => node.disabled !== true && node.getAttribute("aria-disabled") !== "true";

  const classOf = (node) => String(node.className || "");

  /**
   * ① 明确的语义标签：中英文界面都覆盖。
   * ② 设计系统结构：DeepSeek 的发送键是「主按钮 + 圆形」（ds-button--primary + --circle）,
   *    旁边的附件/模式按钮是 --iconLabelPrimary，不会被 --primary 匹配到。
   * ③ 兜底：输入框附近最后一个可点按钮。
   * @returns {{node: Element | null, how: string}}
   */
  function findSendButton(composer) {
    const byLabel = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter(clickable)
      .filter((node) => /发送|send/i.test(labelOf(node)));
    if (byLabel.length > 0) return { node: byLabel[byLabel.length - 1], how: "label" };

    for (let level = 0; level < 4; level += 1) {
      let scope = composer;
      for (let step = 0; step <= level && scope !== null; step += 1) scope = scope.parentElement;
      if (scope === null) break;
      const primary = [...scope.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(clickable)
        .filter((node) => /ds-button--primary/.test(classOf(node)) && /--circle/.test(classOf(node)));
      if (primary.length > 0) return { node: primary[primary.length - 1], how: "primary-circle-" + level };
    }

    let scope = composer;
    for (let level = 0; level < 5 && scope !== null; level += 1) {
      scope = scope.parentElement;
      if (scope === null) break;
      const buttons = [...scope.querySelectorAll('button, [role="button"]')].filter(visible).filter(clickable);
      if (buttons.length >= 1) return { node: buttons[buttons.length - 1], how: "nearest-" + level };
    }
    return { node: null, how: "none" };
  }
`;

/** @returns {string} 诊断：页面在哪、有没有输入框、有几条消息、发送按钮会被认成谁。 */
function diagnose() {
  return String.raw`
    (() => {
      ${FIND_COMPOSER}
      ${FIND_SEND}
      const messages = [...document.querySelectorAll(".ds-message")];
      const body = String(document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 220);
      const found = composer === null ? { node: null, how: "no-composer" } : findSendButton(composer);
      return {
        href: location.href,
        signedIn: !location.href.includes("sign_in"),
        hasComposer: composer !== null,
        composerPlaceholder: composer === null ? "" : String(composer.placeholder ?? ""),
        composerCount: composers.length,
        sendButton: found.node === null ? null : { how: found.how, label: labelOf(found.node).slice(0, 40) },
        messageCount: messages.length,
        bodyHint: body,
      };
    })()
  `;
}

/**
 * 把文字塞进输入框。
 * 必须走原生 setter 再补一个 input 事件 —— React 受控组件只认这条路，
 * 直接赋 value 页面内部状态不会更新，按发送也没内容。
 * @param {string} text
 */
function fill(text) {
  return String.raw`
    (() => {
      ${FIND_COMPOSER}
      if (composer === null) return { ok: false, reason: "no-composer" };
      composer.focus();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      descriptor.set.call(composer, ${JSON.stringify(text)});
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true, length: composer.value.length };
    })()
  `;
}

/** @returns {string} 点发送。**点完还要看输入框有没有被清空**，没清就补一次回车。 */
function send() {
  return String.raw`
    (async () => {
      ${FIND_COMPOSER}
      ${FIND_SEND}
      if (composer === null) return { ok: false, reason: "no-composer" };

      const before = composer.value.length;
      const found = findSendButton(composer);
      let how = "none";
      let target = "";

      if (found.node !== null) {
        how = found.how;
        target = labelOf(found.node).slice(0, 40);
        found.node.click();
      }

      // 等页面把输入框清空 —— 清空才算真的发出去了。
      // 会话里已经有历史消息时，点按钮偶尔不生效（按钮未就绪 / 事件没挂上），
      // 这时候补一次回车，比让用户对着「翻译中…」等两分钟强。
      const settle = () => new Promise((resolve) => setTimeout(resolve, 320));
      await settle();
      if (composer.value.length === 0) return { ok: true, how, target, cleared: true };

      const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
      composer.dispatchEvent(new KeyboardEvent("keydown", init));
      composer.dispatchEvent(new KeyboardEvent("keyup", init));
      await settle();

      return {
        ok: composer.value.length === 0 || before === 0,
        how: found.node === null ? "enter" : how + "+enter",
        target,
        cleared: composer.value.length === 0,
        remaining: composer.value.length,
      };
    })()
  `;
}

/** @returns {string} 读最后一条消息的正文，以及是否还在生成。 */
function read() {
  return String.raw`
    (() => {
      const all = [...document.querySelectorAll(".ds-message")];
      // 滚到底：DeepSeek 的消息列表是虚拟化的，不在视口里的消息不渲染。
      // 不滚的话，会话一长就会读到"上一条"，然后一直等不到新回复。
      if (all.length > 0) {
        try {
          all[all.length - 1].scrollIntoView({ block: "end" });
        } catch {}
      }
      const messages = [...document.querySelectorAll(".ds-message")];
      const last = messages.length === 0 ? null : messages[messages.length - 1];
      let text = "";
      if (last !== null) {
        const markdown = last.querySelector('[class*="ds-markdown"]');
        text = String((markdown ?? last).innerText ?? "");
      }
      // 「停止生成」按钮在生成期间存在，作为辅助信号（不作为唯一依据）
      const generating = [...document.querySelectorAll('button, [role="button"]')].some((node) => {
        const label = String(node.getAttribute("aria-label") || node.getAttribute("title") || "");
        return /停止|stop/i.test(label);
      });
      return { count: messages.length, text, generating };
    })()
  `;
}

module.exports = { diagnose, fill, send, read };
