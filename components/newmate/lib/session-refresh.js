/**
 * Session refresh: what NewMate's OWN conversation does when it has outgrown one session.
 *
 * A "session" here is one of NewMate's own threads ("对话") - the thing the page lists, the thing a
 * run's task is bound to. It is NOT a DSH conversation: those already have their own tools
 * (newmate_conversation_*), and conflating the two would let a companion that only manages its own
 * transcript claim it manages the host's sessions.
 *
 * ## Why a refresh is not a token problem
 *
 * Every run receives only the newest 12 messages of its session (6 on an autonomous check-in), so a
 * long session does not cost more tokens - it costs REACHABILITY. Past ~80 messages everything
 * before that window is unreachable for good: the page can still scroll it, the model never sees it
 * again. A refresh replaces "a transcript nobody can read to the end" with "a short session that
 * begins with what matters", and keeps the old transcript listable and readable.
 *
 * ## Two thresholds, two different deciders
 *
 *   SESSION_BUDGET  SOFT. Crossing it puts a request into the run prompt; the MODEL writes the
 *                   handoff through newmate_session_refresh, because deciding what matters is a
 *                   judgement. Not a hard refusal either: the run may finish what it started.
 *   SESSION_HARD    HARD. Crossing it while no turn is queued means nobody acted; the runtime then
 *                   performs a MECHANICAL handoff (a labelled digest of the newest turns). A session
 *                   must not grow without bound just because a model (or a user) never said stop.
 *
 * The mechanical summary is labelled `by:'budget'` everywhere it surfaces, so a runtime digest can
 * never be mistaken for the model's own handoff, and vice versa.
 *
 * Nothing in this module mutates state, dispatches a tool or calls a model: facts in, decision out.
 * That is what makes both thresholds testable without a fixture host.
 */

/** Soft budget. Crossing it asks for a handoff; the turn may still finish. */
export const SESSION_BUDGET = Object.freeze({ messages: 80, chars: 60000 });
/** Hard cap. Crossing it while idle means the runtime refreshes by itself. */
export const SESSION_HARD = Object.freeze({ messages: 240, chars: 180000 });
/** One handoff summary, in characters. Longer is a document, not a handoff. */
export const SESSION_SUMMARY_MAX = 2000;
/** One session title, in characters. */
export const SESSION_TITLE_MAX = 40;
/** A session with less than this cannot be handed off: there is nothing to carry. */
export const SESSION_MIN_REFRESH_MESSAGES = 4;
/** The mechanical digest: newest turns, each clipped, and a total it must respect. */
export const SESSION_DIGEST = Object.freeze({ messages: 24, perMessageChars: 300, chars: 2400 });

/** The thread object, archived or not. Never mutated. */
export function sessionOf(state, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : state?.activeThreadId;
  const list = Array.isArray(state?.threads) ? state.threads : [];
  return list.find((thread) => thread && thread.id === id);
}

/** Every stored message of one session, in storage order. */
export function sessionMessages(state, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : state?.activeThreadId;
  const list = Array.isArray(state?.messages) ? state.messages : [];
  return list.filter((message) => message && message.threadId === id);
}

/** How much text one message carries. A missing body is 0, not a NaN that poisons the sums. */
export function messageChars(message) {
  const body = typeof message?.text === 'string' ? message.text : '';
  return body.length;
}

/**
 * One session as facts: what a threshold, a listing and a prompt all read.
 *
 * `chars` counts the stored bodies, which is what has become unreachable; `handoffSummary` is the
 * carried text, so a caller can tell "a session with context" from "a session that says where it
 * came from".
 */
export function sessionFacts(state, sessionId) {
  const thread = sessionOf(state, sessionId);
  if (!thread) return null;
  const messages = sessionMessages(state, thread.id);
  let chars = 0, user = 0, assistant = 0, proactive = 0, newest = 0;
  for (const message of messages) {
    chars += messageChars(message);
    if (message.role === 'user') user += 1;
    else if (message.role === 'assistant') assistant += 1;
    if (message.proactive === true) proactive += 1;
    if (Number.isFinite(message.at) && message.at > newest) newest = message.at;
  }
  const carried = thread.carried && typeof thread.carried === 'object' ? thread.carried : null;
  return {
    sessionId: thread.id,
    title: typeof thread.title === 'string' ? thread.title : '',
    active: thread.id === state.activeThreadId,
    archived: thread.archived === true,
    created: Number.isFinite(thread.created) ? thread.created : 0,
    updated: Number.isFinite(thread.updated) ? thread.updated : 0,
    messages: messages.length,
    chars,
    user,
    assistant,
    proactive,
    newestMessageAt: newest || null,
    handoff: carried ? {
      from: typeof carried.from === 'string' ? carried.from : null,
      fromTitle: typeof carried.fromTitle === 'string' ? carried.fromTitle : null,
      at: Number.isFinite(carried.at) ? carried.at : null,
      by: carried.by === 'budget' ? 'budget' : 'self',
      reason: typeof carried.reason === 'string' ? carried.reason : '',
      summaryChars: typeof carried.summary === 'string' ? carried.summary.length : 0,
      summary: typeof carried.summary === 'string' ? carried.summary : '',
    } : null,
  };
}

/**
 * Which budget a session has passed, if any.
 *
 * The answer names the dimension that is FURTHER past its budget rather than the first one checked:
 * a session at 60,000 characters and 20 messages is a length problem, and saying "20 messages" would
 * make the notice look wrong to anyone comparing the numbers.
 */
export function budgetCode(facts, budget = SESSION_BUDGET) {
  if (!facts) return '';
  const byMessages = budget.messages > 0 ? facts.messages / budget.messages : 0;
  const byChars = budget.chars > 0 ? facts.chars / budget.chars : 0;
  if (byMessages < 1 && byChars < 1) return '';
  return byChars >= byMessages ? 'chars' : 'messages';
}

/** The soft threshold, as a decision the run prompt and the status surface both read. */
export function refreshDue(state, sessionId) {
  const facts = sessionFacts(state, sessionId);
  const code = budgetCode(facts, SESSION_BUDGET);
  return { due: code !== '', code, facts };
}

/** The hard cap, as a decision the idle tick reads. */
export function refreshForced(state, sessionId) {
  const facts = sessionFacts(state, sessionId);
  const code = budgetCode(facts, SESSION_HARD);
  return { forced: code !== '', code, facts };
}

/**
 * The mechanical handoff: the newest turns, clipped, in one labelled block.
 *
 * It is deliberately NOT written as prose. What it must do is make the old session reachable again,
 * and the cheapest honest way to do that is to carry the recent exchange verbatim (bounded) with a
 * header saying it is mechanical. A runtime that pretended to summarise would be inventing a
 * judgement it does not have.
 */
export function mechanicalSummary(messages, options = {}) {
  const limit = Number.isInteger(options.messages) ? options.messages : SESSION_DIGEST.messages;
  const perMessage = Number.isInteger(options.perMessageChars) ? options.perMessageChars : SESSION_DIGEST.perMessageChars;
  const total = Number.isInteger(options.chars) ? options.chars : SESSION_DIGEST.chars;
  const list = Array.isArray(messages) ? messages : [];
  const recent = list.slice(-limit);
  const lines = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    const who = message?.role === 'user' ? '用户' : 'NewMate';
    let body = typeof message?.text === 'string' ? message.text.replace(/\s+/g, ' ').trim() : '';
    if (!body) continue;
    if (body.length > perMessage) body = body.slice(0, perMessage) + '…';
    const line = '- ' + who + '：' + body;
    if (used + line.length > total && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  lines.reverse();
  const omitted = list.length - lines.length;
  const head = '（运行时机械交接：本会话由上一个会话在达到硬上限时自动开出，下面是最后 ' + lines.length + ' 条消息的原文摘要'
    + (omitted > 0 ? '，更早的 ' + omitted + ' 条未包含' : '') + '；不是模型写的总结。）';
  return head + (lines.length ? '\n' + lines.join('\n') : '');
}
