/**
 * THE DSH CONVERSATIONS DIGEST: what the user was working on before this check-in.
 *
 * The user's requirement (2026-11-24):「主动对话的检查流程新增检查最近10条DSH本体对话并整理建议」.
 * The check-in already surveys the trusted workspaces (what changed on disk); this adds the other half
 * of "what is going on" - the recent DSH conversations themselves, so the model can notice work that
 * stopped halfway, a question left unanswered, or a conclusion that never landed, and turn one of them
 * into a concrete suggestion.
 *
 * THE SHAPE IS DELIBERATELY THIN. Ten conversations x two messages x 90 characters is a page of
 * context, not a transcript: titles and workspaces come from the host's own listing (metadata), and the
 * two newest conversational messages per session are quoted as a snippet. Reasoning blocks and tool
 * calls are never read (they are the bulk of the bytes and none of the meaning), whole bodies are never
 * carried, and a session whose read fails degrades to metadata instead of aborting the check-in.
 *
 * THE COST IS BOUNDED BY THE CALLER'S SEAM. `list` and `read` are the conversation bridge's own
 * methods - the same bounded, refusing, read-only ones the `newmate_conversation_*` tools use - so this
 * digest cannot open, resume or write a session, and it inherits their caps.
 */

export const DSH_DIGEST_DEFAULTS = Object.freeze({
  maxSessions: 10,
  excerptMessages: 2,
  excerptChars: 90,
  maxChars: 1100,
  /** Reading one transcript is the expensive half; a session that fails is metadata-only, not fatal. */
  readChars: 900,
});

const clip = (value, limit) => {
  const body = String(value ?? '').replace(/\s+/g, ' ').trim();
  return body.length <= limit ? body : body.slice(0, limit) + '…';
};

const age = (ms) => {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 1) return '1 分钟内';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
};

/**
 * Build the digest from the conversation bridge's own seams.
 *
 * @param seams.list  the bridge's `list`: `{limit}` -> `{ok, source, total, conversations:[…]}`
 * @param seams.read  the bridge's `read`: `{sessionId, limit, maxChars}` -> `{ok, messages:[…]}`
 */
export async function buildDshDigest({ list, read } = {}, { now = Date.now(), limits = {} } = {}) {
  const bound = { ...DSH_DIGEST_DEFAULTS, ...limits };
  if (typeof list !== 'function') return { ok: false, code: 'dsh_digest_unavailable', error: 'the host conversation listing is not reachable from this run', at: now, sessions: [], total: 0 };
  let page;
  try { page = await list({ limit: bound.maxSessions }); }
  catch (error) { return { ok: false, code: 'dsh_digest_failed', error: String(error?.message || error), at: now, sessions: [], total: 0 }; }
  if (!page || page.ok !== true) return { ok: false, code: page?.code || 'dsh_digest_unavailable', error: page?.error || 'the host conversation listing refused', at: now, sessions: [], total: 0 };
  const rows = (Array.isArray(page.conversations) ? page.conversations : []).filter((row) => row && row.sessionId && row.self !== true);
  const sessions = [];
  for (const row of rows.slice(0, bound.maxSessions)) {
    let excerpt = [];
    let excerptState = 'metadata-only';
    if (typeof read === 'function') {
      try {
        const transcript = await read({ sessionId: row.sessionId, limit: bound.excerptMessages * 2, maxChars: bound.readChars });
        if (transcript && transcript.ok === true && Array.isArray(transcript.messages) && transcript.messages.length) {
          excerpt = transcript.messages.slice(-bound.excerptMessages).map((message) => ({ role: message.role, text: clip(message.text, bound.excerptChars), at: Number(message.at) || 0 }));
          excerptState = 'quoted';
        }
      } catch { excerptState = 'read-failed'; }
    }
    const newest = excerpt.reduce((latest, message) => (message.at > latest ? message.at : latest), 0);
    sessions.push({
      sessionId: row.sessionId,
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      createdAt: Number(row.createdAt) || 0,
      at: newest || Number(row.createdAt) || 0,
      live: row.live === true,
      excerpt,
      excerptState,
    });
  }
  const total = Number(page.total) || sessions.length;
  return {
    ok: true,
    at: now,
    source: page.source || null,
    total,
    // The listing is newest-creation-first; the digest re-sorts by the newest thing that happened in
    // it, so "what was being worked on" leads.
    sessions: sessions.sort((a, b) => (b.at || 0) - (a.at || 0)),
    omitted: Math.max(0, total - sessions.length),
    limits: { maxSessions: bound.maxSessions, excerptMessages: bound.excerptMessages, excerptChars: bound.excerptChars },
  };
}

/**
 * The digest as the check-in prompt reads it: newest first, bounded, with what was dropped stated.
 *
 * The suggestion itself is the model's job (that is the step the user asked for); this text only gives
 * it the material and says what to look for, so the model is not asked to invent work that is not
 * there.
 */
export function summariseConversations(digest, { now = Date.now(), maxChars = DSH_DIGEST_DEFAULTS.maxChars } = {}) {
  if (!digest || digest.ok !== true) return '最近 DSH 对话：不可读（' + (digest?.code || 'unknown') + (digest?.error ? '：' + String(digest.error).slice(0, 80) : '') + '）。';
  if (!digest.sessions.length) return '最近 DSH 对话：本机没有可读的对话。';
  const head = '最近 DSH 本体对话（最新在前，共 ' + digest.total + ' 条' + (digest.omitted ? '，本次查看 ' + digest.sessions.length + ' 条' : '') + '；只取标题、工作区与最近两句的摘录，不是全文）：';
  const lines = [head];
  let chars = head.length;
  let shown = 0;
  for (const [index, session] of digest.sessions.entries()) {
    const parts = [];
    parts.push('「' + (session.title || '未命名') + '」');
    if (session.cwd) parts.push('工作区 ' + (session.cwd.split(/[\\/]/).pop() || session.cwd));
    parts.push(age(now - (session.at || now)));
    if (session.excerpt.length) {
      parts.push(session.excerpt.map((message) => (message.role === 'user' ? '用户「' : '你「') + message.text + '」').join(' → '));
    } else parts.push(session.excerptState === 'read-failed' ? '（这次没读到正文）' : '（没有可引用的最近正文）');
    const line = (index + 1) + ') ' + parts.join(' · ');
    /**
     * The budget is the budget: a row that does not fit is clipped (or dropped), and the count of what
     * was left out is printed. A summary that quietly runs 300 characters over its own cap is the same
     * class of defect as a sample that claims to be complete.
     */
    if (chars + line.length > maxChars) {
      const room = Math.max(40, maxChars - chars - 1);
      if (room > 40) lines.push(line.slice(0, room) + '…');
      lines.push('（其余 ' + (digest.sessions.length - shown) + ' 条未列出）');
      break;
    }
    lines.push(line);
    chars += line.length + 1;
    shown += 1;
  }
  return lines.join('\n');
}
