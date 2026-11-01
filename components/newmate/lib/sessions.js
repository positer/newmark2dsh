import { newMateContext } from '../../../lib/newmate-context.js';
import { SESSION_BUDGET, SESSION_HARD, SESSION_SUMMARY_MAX, SESSION_TITLE_MAX } from './session-refresh.js';

/**
 * NewMate's session tools: the companion managing its OWN conversations without a person in the
 * loop.
 *
 * The gap these close: NewMate's conversations ("对话") could only be created by a person pressing
 * a button or by the proactive-attention heuristic, and once a session was archived it was read-only
 * forever. So a companion that had been talking for a month could neither start a clean session of
 * its own accord nor look back into the ones it had closed - and "自主刷新对话 session" was a thing
 * only the page could do.
 *
 * Four tools, one invariant:
 *
 *   list     read-only discovery, so an id a model hands out is one the store can vouch for;
 *   read     read-only transcript of one session, bounded and reporting what it dropped;
 *   refresh  the handoff: declare the summary, and the runtime performs the switch AFTER this turn's
 *            reply is stored;
 *   resume   bring an archived session back as the current one, likewise after this turn's reply.
 *
 * THE INVARIANT: a session never changes under a running turn. Both writes are SCHEDULED onto the
 * task and applied once the reply has a home, because rotating mid-run is how an answer ends up in a
 * session the page is no longer showing. The model chooses the summary and the title (content); the
 * session that is refreshed comes from the run's own context (identity), never from an argument -
 * the same rule the conversation tools follow.
 *
 * These are session-level tools of the companion, not DSH-session tools, and not "request-bound":
 * an autonomous check-in may refresh a session precisely because nobody is there to ask.
 */

/** The four names, in the order the persona introduces them. */
export const SESSION_TOOLS = Object.freeze([
  'newmate_session_list',
  'newmate_session_read',
  'newmate_session_refresh',
  'newmate_session_resume',
]);

const MAX_LIST_SESSIONS = 50;
const DEFAULT_LIST_SESSIONS = 10;
const MAX_READ_MESSAGES = 40;
const DEFAULT_READ_MESSAGES = 12;
const MAX_READ_CHARS = 8000;
const MAX_MESSAGE_CHARS = 800;
const MAX_SESSION_ID_CHARS = 100;
const MAX_REASON_CHARS = 200;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bound = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback);

/**
 * Create the bridge. `services.sessions` returns the component (`createNewMate`), read lazily so a
 * host that has not finished mounting refuses by name instead of failing to register.
 */
export function createSessionBridge({ services, now = Date.now, log = () => {} }) {
  const sessions = () => { try { return services?.sessions?.(); } catch { return undefined; } };
  const refuse = (code, error) => ({ ok: false, code, error });
  const failed = (error) => refuse(error?.code || 'session_failed', String(error?.message || error));
  const sessionIdOf = (value) => { const id = text(value); return id && id.length <= MAX_SESSION_ID_CHARS ? id : ''; };

  async function list(args = {}) {
    const service = sessions();
    if (typeof service?.sessionList !== 'function') return refuse('sessions_unavailable', 'NewMate\'s own session store is not reachable; no session can be listed');
    const limit = bound(args.limit, 1, MAX_LIST_SESSIONS, DEFAULT_LIST_SESSIONS);
    try { return await service.sessionList({ limit }); } catch (error) { return failed(error); }
  }

  async function read(args = {}) {
    const service = sessions();
    if (typeof service?.sessionRead !== 'function') return refuse('sessions_unavailable', 'NewMate\'s own session store is not reachable; no session can be read');
    const sessionId = sessionIdOf(args.sessionId);
    if (!sessionId) return refuse('invalid_session', 'sessionId must be a non-empty id from newmate_session_list');
    const limit = bound(args.limit, 1, MAX_READ_MESSAGES, DEFAULT_READ_MESSAGES);
    const maxChars = bound(args.maxChars, 200, MAX_READ_CHARS, MAX_READ_CHARS);
    try { return await service.sessionRead({ sessionId, limit, maxChars, maxMessageChars: MAX_MESSAGE_CHARS }); } catch (error) { return failed(error); }
  }

  async function refresh(args = {}) {
    const service = sessions();
    if (typeof service?.sessionRefresh !== 'function') return refuse('sessions_unavailable', 'NewMate\'s own session store is not reachable; no session can be handed off');
    const summary = text(args.summary);
    if (!summary) return refuse('summary_required', 'a handoff needs a summary: write what the next session must know');
    if (summary.length > SESSION_SUMMARY_MAX) return refuse('summary_too_long', 'summary must be at most ' + SESSION_SUMMARY_MAX + ' characters (got ' + summary.length + '); carry what matters, not the transcript');
    const title = text(args.title);
    if (title.length > SESSION_TITLE_MAX) return refuse('title_too_long', 'title must be at most ' + SESSION_TITLE_MAX + ' characters');
    const reason = text(args.reason);
    if (reason.length > MAX_REASON_CHARS) return refuse('reason_too_long', 'reason must be at most ' + MAX_REASON_CHARS + ' characters');
    if (!newMateContext()?.session?.id) return refuse('no_session_context', 'this call is not bound to one of NewMate\'s sessions; a session is handed off from inside its own run');
    try { return await service.sessionRefresh({ summary, title, reason }); } catch (error) { return failed(error); }
  }

  async function resume(args = {}) {
    const service = sessions();
    if (typeof service?.sessionResume !== 'function') return refuse('sessions_unavailable', 'NewMate\'s own session store is not reachable; no session can be resumed');
    const sessionId = sessionIdOf(args.sessionId);
    if (!sessionId) return refuse('invalid_session', 'sessionId must be a non-empty id from newmate_session_list');
    try { return await service.sessionResume({ sessionId }); } catch (error) { return failed(error); }
  }

  const definitions = [
    {
      name: 'newmate_session_list',
      description: '列出你自己的对话会话（NewMate 的「对话」，不是 DSH 会话）：id、标题、是否当前、是否归档、创建/更新时间、消息条数与字符数、以及它是否由上一个会话交接而来。只读，不会打开或改写任何会话；最新更新的在前，page 会写明总数与省略数。需要 id 时先看这份清单，不要自己编造会话 id——编造的 id 一定读不到。',
      parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_SESSIONS, description: '返回条数，默认 ' + DEFAULT_LIST_SESSIONS + '；超出部分省略并在 total/truncated 里写明。' } }, additionalProperties: false },
      execute: (args) => list(args),
    },
    {
      name: 'newmate_session_read',
      description: '读取某一个会话的近期正文（只有你和用户的文本，不含思考与工具调用），有界并自报 dropped。用它回看已归档的会话、确认以前说过什么；只读，不会切换或续写该会话。要看「这个会话是从哪交接来的」，结果里的 handoff 就是交接摘要。',
      parameters: { type: 'object', properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: MAX_SESSION_ID_CHARS, description: '来自 newmate_session_list 的会话 id。' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_READ_MESSAGES, description: '最多返回的条数，默认 ' + DEFAULT_READ_MESSAGES + '。' },
        maxChars: { type: 'integer', minimum: 200, maximum: MAX_READ_CHARS, description: '总字符预算，默认 ' + MAX_READ_CHARS + '。' },
      }, required: ['sessionId'], additionalProperties: false },
      execute: (args) => read(args),
    },
    {
      name: 'newmate_session_refresh',
      description: '交接刷新：把你现在所在的会话交给一个全新的会话，并写一段交接摘要。适用于这个会话已经很长（达到软预算 ' + SESSION_BUDGET.messages + ' 条消息或 ' + SESSION_BUDGET.chars + ' 字符）、话题已经换了、或你要在无人看着时继续推进同一件事。summary 必填（≤' + SESSION_SUMMARY_MAX + ' 字符）：写清目标、已经完成什么、还没完成与下一步、关键事实与出处；不要复述全文。本轮回复写入后才会真的切换——当前会话归档但完整保留，可用 newmate_session_read 回看；新会话开局就带着这段摘要。会话太短（不足 4 条）拒绝 session_too_short，超上限拒绝 session_limit。刷新的是你自己这个会话，不接受用参数指定别的会话。',
      parameters: { type: 'object', properties: {
        summary: { type: 'string', minLength: 1, maxLength: SESSION_SUMMARY_MAX, description: '交接摘要：下一个会话必须知道的事。' },
        title: { type: 'string', maxLength: SESSION_TITLE_MAX, description: '新会话的标题，默认取摘要开头。' },
        reason: { type: 'string', maxLength: MAX_REASON_CHARS, description: '为什么要交接（例如 会话过长 / 换话题 / 继续无人推进的长期事项），记在交接记录里。' },
      }, required: ['summary'], additionalProperties: false },
      execute: (args) => refresh(args),
    },
    {
      name: 'newmate_session_resume',
      description: '把一个已归档的会话恢复为当前会话，接着它继续聊。同样在本轮回复写入后生效：当前会话会被归档（完整保留、仍可读），被指定的会话重新成为当前会话，它原来的消息重新进入你的近期上下文。想不起来是哪个会话时先用 newmate_session_list。',
      parameters: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: MAX_SESSION_ID_CHARS, description: '来自 newmate_session_list、且不是当前会话的 id。' } }, required: ['sessionId'], additionalProperties: false },
      execute: (args) => resume(args),
    },
  ];

  return { definitions, list, read, refresh, resume, tools: SESSION_TOOLS };
}
