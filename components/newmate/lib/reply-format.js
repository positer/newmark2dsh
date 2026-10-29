// One reply, two renderings: the page gets the rich version, the bubble (and anything that will
// speak for NewMate outside this UI, such as a WeChat clawbot bridge) gets plain text.
//
// Both are produced by the model in one envelope, because deriving the second from the first has
// already gone wrong twice: a Markdown list rendered as literal asterisks in a bubble, and a code
// fence shown as a wall of text. The local toPlain() stays as the fallback for a model that
// ignores the envelope - it must never be the primary path, only the safety net.
export const REPLY_PROTOCOL = '输出协议：最终只输出一个合法 JSON 对象，不要围栏、不要对象之外的任何文字。键：text = 给 NewMate 页面渲染的完整回复（可用 Markdown，自动轮次最多 400 字，对话轮次只写必要内容）；plain = 给桌宠气泡与外部渠道（微信 clawbot）的纯文本精简版（单段、无 Markdown、无标题、无代码块，最多 80 字，只给结论或下一步）；notify = 仅自动/主动轮次必填的布尔；topic = 可选话题标签。两版表达同一结论，不得互相矛盾。';

/** Strip the syntax a plain-text channel cannot render, then shorten. */
export function toPlain(text, limit = 80) {
  const value = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s+|>\s?)/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('；'), cut.lastIndexOf('. '));
  return (stop >= limit * 0.5 ? cut.slice(0, stop + 1) : cut) + '…';
}

/**
 * Read one run's answer into the two versions.
 *
 * The envelope is JSON with text/plain; anything else is treated as the rich version alone, so a
 * model that ignores the protocol still produces a displayable reply with a derived plain text.
 */
export function normalizeReply(raw, { automatic = false } = {}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { rich: '', plain: '', notify: undefined, topic: undefined, protocol: false };
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.text === 'string') {
        const rich = parsed.text.trim();
        const plain = typeof parsed.plain === 'string' && parsed.plain.trim() ? parsed.plain.trim() : toPlain(rich);
        return {
          rich,
          plain,
          notify: typeof parsed.notify === 'boolean' ? parsed.notify : undefined,
          topic: typeof parsed.topic === 'string' ? parsed.topic : undefined,
          protocol: true,
        };
      }
    } catch { /* not the envelope: fall through to the plain answer */ }
  }
  return { rich: value, plain: toPlain(value), notify: automatic ? undefined : undefined, topic: undefined, protocol: false };
}

/** The value a bubble or an external channel may show: plain if the run produced one. */
export const bubbleText = (message) => (message?.plain && String(message.plain).trim()) || toPlain(message?.text || '');
