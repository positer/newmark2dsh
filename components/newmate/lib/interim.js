import { newMateContext } from '../../../lib/newmate-context.js';

/**
 * INTERIM REPLIES: what the companion says WHILE it is still working.
 *
 * The user's requirement (2026-11-24):「newMate新增中间回复，即在loop中途可以输出中间回复，并继续自行loop直到最终回复」.
 * Until now a run had exactly one visible output - the final answer - so a long turn (several tool
 * calls, a web search, a desktop action) looked like silence with a spinner. The runtime already
 * publishes the live loop (phase, current tool) to the page; this is the other half a person reads:
 * a sentence in the conversation, while the turn keeps running.
 *
 * FOUR DECISIONS THAT KEEP IT FROM BECOMING NOISE OR A LIE:
 *
 *   1. it is a PRIVATE tool of the companion (registered into the NewMate-only map), and it refuses
 *      outside a NewMate run, so a DSH agent cannot speak in NewMate's voice;
 *   2. it is allowed ONLY on a turn a person started. An autonomous check-in has one job - decide
 *      whether to speak at all - and an interim "I'm looking into it" there would be an unsolicited
 *      message plus a second one; a maintenance turn publishes nothing by design; a scheduled todo
 *      activation is the user's own item and its answer is the point.
 *   3. it is bounded per run (count, length, no immediate repetition), because a loop that narrates
 *      every step is worse than one that says nothing;
 *   4. it carries BOTH renderings (text for the page, plain for the bubble and WeChat), because a
 *      bubble that shows raw Markdown is exactly the defect reply-format.js already documents;
 *   5. it is NOT the reply. Its id is derived from the task id, never equal to it, which is what keeps
 *      the final answer the only thing `forwardReplies` (WeChat) will ever send, and the only message
 *      a todo activation can be settled by.
 */

export const NEWMATE_INTERIM_TOOL = 'newmate_progress';
export const INTERIM_MAX_CHARS = 240;
/** The plain rendering's own bound: it is what a bubble and a phone notification can show. */
export const INTERIM_PLAIN_MAX_CHARS = 120;
export const INTERIM_MAX_PER_RUN = 3;
export const INTERIM_MIN_GAP_MS = 4000;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The tool. It carries no policy of its own: the component decides whether this run may speak yet,
 * because only the component knows what kind of turn is in flight.
 */
export function interimDefinition({ services } = {}) {
  const mate = () => { try { return services?.mate?.(); } catch { return undefined; } };
  return {
    name: NEWMATE_INTERIM_TOOL,
    description: '在回答完成之前，先给用户一条中间回复：你已经看懂了什么、正在做什么、大概还要几步。之后继续自行工作，最终用正常的回复收尾。适合较长的任务（多次工具调用、查资料、操作界面）；一句话到两句话（≤' + INTERIM_MAX_CHARS + ' 字），说进展和下一步，不要复述将要做什么、不要道歉、不要罗列工具名。每一轮最多 ' + INTERIM_MAX_PER_RUN + ' 条，重复内容会被拒；用户自己发起的对话里才可用，主动检查轮与定时激活轮没有这个工具。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: INTERIM_MAX_CHARS, description: '这条中间回复的正文，一句到两句话，最多 ' + INTERIM_MAX_CHARS + ' 字。' },
        plain: { type: 'string', maxLength: INTERIM_PLAIN_MAX_CHARS, description: '同一句话的纯文本版：给桌宠气泡与微信 clawbot（单段、无 Markdown、无标题、无代码块，最多 ' + INTERIM_PLAIN_MAX_CHARS + ' 字）。不写就由正文自动转一份。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      if (!newMateContext()) return { ok: false, code: 'interim_outside_newmate', error: '中间回复只能在 NewMate 自己的回合里发；这不是一次 NewMate 运行' };
      const service = mate();
      if (typeof service?.interim !== 'function') return { ok: false, code: 'interim_unavailable', error: 'NewMate 没在运行，这次没有可发送的中间回复' };
      return service.interim({ text: text(args.text), plain: text(args.plain) });
    },
  };
}
