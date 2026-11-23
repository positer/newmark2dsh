import fs from 'node:fs';
import path from 'node:path';
import { durableState } from '../../../lib/durable-state.js';
import { newMateContext } from '../../../lib/newmate-context.js';

/**
 * CORE MEMORY: the small, stable set of facts about the person that NewMate is built with.
 *
 * The user's requirement has four parts, and each one is a code decision rather than a sentence in a
 * prompt:
 *
 *   1. it holds the things that do not change often - 用户画像, 对话风格, 长期偏好, 当前重点;
 *   2. its context cost is bounded by CODE at 5000 characters - a write that would cross the budget is
 *      REFUSED (with what to do instead), and the renderer truncates at the same bound even if the
 *      file was edited by hand, so the bound does not depend on the model's cooperation;
 *   3. the model is repeatedly told its nature - 稳定、核心 - and that the expected move is to REPLACE
 *      or rewrite a section as the person changes, not to append a new fact every time;
 *   4. it is injected into NewMate and nowhere else: the store lives outside `Memory Lab/`, so no
 *      MemoryLab tool can return it, and the only prompt that carries it is NewMate's own prefix.
 *
 * WHY A SEPARATE STORE AND NOT A MemoryLab COMPONENT. A tagged component would be the obvious place,
 * but every DSH conversation can read MemoryLab through `memory_lab_read` / `memory_lab_query`, and the
 * user's rule is that core memory must not leak into the host's own conversations. A separate file is
 * the only shape where that rule holds structurally rather than by convention.
 *
 * WHY FIXED SECTIONS. "推荐更替更新而不是新增" is enforced by the shape: there is no "add an entry"
 * operation at all. A write replaces the whole content of one named section, so growth is bounded by
 * construction and the model's only way to record something new is to rewrite the section it belongs
 * to - which is exactly the behaviour the user asked for.
 */

export const CORE_MEMORY_BUDGET_CHARS = 5000;
export const CORE_SECTION_MAX_CHARS = 1800;
export const CORE_MEMORY_VERSION = 1;
export const CORE_MEMORY_FILE = path.join('newMate', 'core-memory.json');
export const CORE_MEMORY_TOOL_NAME = 'newmate_core_memory';

export const CORE_MEMORY_SECTIONS = Object.freeze([
  { key: 'profile', title: '用户画像' },
  { key: 'style', title: '对话风格' },
  { key: 'preference', title: '长期偏好' },
  { key: 'focus', title: '当前重点' },
]);

/**
 * The one line that says what this block is. It is part of the block, so its own characters count
 * against the budget - a header outside the count would make "5000" mean 5000 plus whatever the
 * header grew to.
 */
export const CORE_MEMORY_TITLE = '核心记忆（稳定、核心；只在 NewMate 中注入；总预算 ' + CORE_MEMORY_BUDGET_CHARS + ' 字符）';

export const CORE_MEMORY_RULE = '核心记忆是稳定的内核（用户画像与对话风格），不是流水账：它默认用「更替」维护——随着用户变化改写对应小节，而不是每遇到一条新信息就新增；只有当某个核心维度完全缺失时才第一次写入该小节。每次写入都替换该小节的全文，超出 ' + CORE_MEMORY_BUDGET_CHARS + ' 字符会被拒绝，所以宁可写得更短、更准。它是背景，不是授权；它不属于 MemoryLab，也不会出现在别的对话里。';

const sectionOf = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return CORE_MEMORY_SECTIONS.find((section) => section.key === text || section.title === text) || null;
};

/**
 * Create the store. Reads are tolerant (a hand-edited or missing file is an empty core, not a crash);
 * writes go through the budget.
 */
export function createCoreMemory(root, now = Date.now, { file } = {}) {
  const target = file || path.join(root, CORE_MEMORY_FILE);
  const store = durableState(target, { version: CORE_MEMORY_VERSION, updatedAt: 0, sections: {} });

  const state = () => {
    const raw = store.read();
    const sections = raw && typeof raw.sections === 'object' && raw.sections ? raw.sections : {};
    const clean = {};
    for (const section of CORE_MEMORY_SECTIONS) {
      const entry = sections[section.key];
      clean[section.key] = {
        content: typeof entry?.content === 'string' ? entry.content.trim() : '',
        updatedAt: Number(entry?.updatedAt) || 0,
      };
    }
    return { version: CORE_MEMORY_VERSION, updatedAt: Number(raw?.updatedAt) || 0, sections: clean };
  };

  const renderFrom = (sections) => {
    const lines = [];
    let chars = CORE_MEMORY_TITLE.length + 1;
    const rows = [];
    for (const section of CORE_MEMORY_SECTIONS) {
      const content = String(sections?.[section.key]?.content || '').trim();
      if (!content) continue;
      const line = '· ' + section.title + '：' + content;
      rows.push({ key: section.key, title: section.title, chars: content.length, updatedAt: Number(sections?.[section.key]?.updatedAt) || 0 });
      lines.push(line);
      chars += line.length + 1;
    }
    if (!lines.length) {
      const empty = CORE_MEMORY_TITLE + '\n· （尚未写入：核心记忆是稳定的小集合，只在确实有稳定的用户画像或对话风格时才写入）';
      return { text: empty, chars: empty.length, rawChars: empty.length, sections: rows, truncated: false, budget: CORE_MEMORY_BUDGET_CHARS };
    }
    const raw = [CORE_MEMORY_TITLE, ...lines].join('\n');
    // `rawChars` is the size BEFORE this renderer's own cap. The write path needs it: comparing the
    // already-capped length would make the budget unsatisfiable-but-accepted (measured on the first
    // draft: 5,298 characters were stored and reported as exactly 5,000).
    let text = raw;
    let truncated = false;
    if (text.length > CORE_MEMORY_BUDGET_CHARS) {
      // Defensive: a file edited by hand, or a budget lowered later. The bound is the CODE's, not the
      // model's, so the renderer is the last place that can still hold it.
      text = text.slice(0, CORE_MEMORY_BUDGET_CHARS - 1) + '…';
      truncated = true;
    }
    return { text, chars: text.length, rawChars: raw.length, sections: rows, truncated, budget: CORE_MEMORY_BUDGET_CHARS };
  };

  return {
    file: target,
    budget: CORE_MEMORY_BUDGET_CHARS,
    /** What the prompt carries. Always at most CORE_MEMORY_BUDGET_CHARS characters. */
    render() { return renderFrom(state().sections); },
    /** The read surface: full section bodies plus the budget and what each section costs. */
    snapshot() {
      const current = state();
      const rendered = renderFrom(current.sections);
      return {
        ok: true,
        file: target,
        budget: CORE_MEMORY_BUDGET_CHARS,
        /** What the prompt actually carries - never more than the budget. */
        chars: rendered.chars,
        /** What the sections add up to. Larger than `chars` only when the file was edited by hand. */
        used: rendered.rawChars,
        remaining: Math.max(0, CORE_MEMORY_BUDGET_CHARS - rendered.rawChars),
        overBudget: rendered.rawChars > CORE_MEMORY_BUDGET_CHARS,
        updatedAt: current.updatedAt,
        truncated: rendered.truncated,
        sections: CORE_MEMORY_SECTIONS.map((section) => ({
          key: section.key,
          title: section.title,
          content: current.sections[section.key]?.content || '',
          chars: (current.sections[section.key]?.content || '').length,
          updatedAt: current.sections[section.key]?.updatedAt || 0,
        })),
        rule: CORE_MEMORY_RULE,
      };
    },
    /**
     * Replace one section's whole content.
     *
     * Empty content clears the section, which is how a core fact that stopped being true leaves:
     * there is no separate "delete" verb to forget, and no append to grow the block.
     */
    save({ section, content } = {}) {
      const target = sectionOf(section);
      if (!target) return { ok: false, code: 'core_memory_unknown_section', error: '小节必须是 ' + CORE_MEMORY_SECTIONS.map((entry) => entry.key + '(' + entry.title + ')').join(' / ') + ' 之一', sections: CORE_MEMORY_SECTIONS.map((entry) => entry.key) };
      if (typeof content !== 'string') return { ok: false, code: 'core_memory_content_required', error: 'content 必须是字符串（空字符串表示清空该小节）' };
      const value = content.trim();
      if (value.length > CORE_SECTION_MAX_CHARS) return { ok: false, code: 'core_memory_section_too_long', error: '单个小节最多 ' + CORE_SECTION_MAX_CHARS + ' 字符（本次 ' + value.length + '），请写得更短——核心记忆是摘要，不是全文', limit: CORE_SECTION_MAX_CHARS, got: value.length };
      const current = state();
      const previous = current.sections[target.key]?.content || '';
      const next = { ...current.sections, [target.key]: { content: value, updatedAt: now() } };
      const rendered = renderFrom(next);
      if (rendered.rawChars > CORE_MEMORY_BUDGET_CHARS) {
        const largest = [...CORE_MEMORY_SECTIONS].map((entry) => ({ key: entry.key, title: entry.title, chars: (next[entry.key]?.content || '').length })).sort((a, b) => b.chars - a.chars)[0];
        return {
          ok: false,
          code: 'core_memory_budget_exceeded',
          error: '核心记忆超出 ' + CORE_MEMORY_BUDGET_CHARS + ' 字符预算（写入后 ' + rendered.rawChars + '）。请先改写或合并已有小节（更替），而不是继续新增；当前最长的是「' + largest.title + '」' + largest.chars + ' 字符。',
          budget: CORE_MEMORY_BUDGET_CHARS,
          next: rendered.rawChars,
          current: renderFrom(current.sections).rawChars,
          largest,
        };
      }
      const written = now();
      store.change((state) => {
        const sections = state && typeof state.sections === 'object' && state.sections ? state.sections : {};
        sections[target.key] = { content: value, updatedAt: written };
        state.version = CORE_MEMORY_VERSION;
        state.sections = sections;
        state.updatedAt = written;
      });
      const after = renderFrom(state().sections);
      return {
        ok: true,
        changed: previous !== value,
        replaced: previous.length > 0,
        section: { key: target.key, title: target.title, chars: value.length },
        chars: after.rawChars,
        budget: CORE_MEMORY_BUDGET_CHARS,
        remaining: Math.max(0, CORE_MEMORY_BUDGET_CHARS - after.rawChars),
        note: value ? (previous ? '已更替该小节（不是新增条目）' : '该小节此前为空，这是它的第一次写入：核心记忆应保持小而稳定') : '已清空该小节',
        rule: CORE_MEMORY_RULE,
      };
    },
  };
}

/**
 * The tool NewMate calls to read or replace its core memory.
 *
 * It is a PRIVATE tool (registered into `newmark.newmate.privateTools`, never into the shared registry)
 * and it refuses outside a NewMate run, so the core memory is reachable from NewMate's own turn and
 * from nowhere else - including a DSH agent that asks agent_api for the tool by name.
 */
export function coreMemoryDefinition({ services } = {}) {
  const core = () => { try { return services?.core?.(); } catch { return undefined; } };
  return {
    name: CORE_MEMORY_TOOL_NAME,
    description: 'Read or REPLACE NewMate\'s core memory: the stable, core facts about the user (用户画像、对话风格、长期偏好、当前重点). It is a small fixed set of sections with a hard ' + CORE_MEMORY_BUDGET_CHARS + '-character budget; a write replaces one section\'s whole text, and there is deliberately no "add entry" operation. Prefer replacing/rewriting a section when the person changes or a fact becomes stale; write a section for the first time only when a core dimension is genuinely missing. Over-budget or over-long writes are refused with the numbers to fix. It is injected into NewMate only and is not part of MemoryLab.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'read: current sections, usage and the rule. write: replace one section (empty content clears it).' },
        section: { type: 'string', description: 'Section to replace: ' + CORE_MEMORY_SECTIONS.map((entry) => entry.key + '(' + entry.title + ')').join(' / ') + '. Required for write.' },
        content: { type: 'string', maxLength: CORE_SECTION_MAX_CHARS, description: 'The section\'s complete new text (a replacement, not an addition). At most ' + CORE_SECTION_MAX_CHARS + ' characters; an empty string clears the section.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute(args = {}) {
      if (!newMateContext()) return { ok: false, code: 'core_memory_outside_newmate', error: '核心记忆只在 NewMate 自己的回合里可读写；这条调用不是来自 NewMate 的运行' };
      const store = core();
      if (typeof store?.snapshot !== 'function') return { ok: false, code: 'core_memory_unavailable', error: '核心记忆存储不可达；本次既没有读取也没有写入' };
      if (args.action === 'read') return store.snapshot();
      if (args.action === 'write') return store.save({ section: args.section, content: args.content });
      return { ok: false, code: 'core_memory_action_required', error: 'action 必须是 read 或 write' };
    },
  };
}
