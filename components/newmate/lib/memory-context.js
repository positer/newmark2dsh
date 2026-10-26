import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createShortMemory } from '../../memorylab/lib/short-memory.js';
import { NEWMATE_PERSONA } from './persona.js';

/**
 * The initialization payload NewMate is built with: persona, complete tag tree, every short row
 * with its expiry, and the memory tool-group schema.
 *
 * The user's requirement went through two corrections before it settled here:
 *   1. initialization must NOT stop at tag names and the latest ten short rows;
 *   2. the first full draft (component descriptions/paths/bytes + every short row + tool schema,
 *      measured at 30,319 characters) was rejected as 全量暴露太长;
 *   3. the final instruction is: 完整暴露 tag 树（无正文）+ 时效性 shortMemory 列表 + 工具组 schema
 *      + 初始化人格 prompt.
 *
 * So:
 *   persona      NEWMATE_PERSONA, the stable identity/behaviour/limits, prepended so the person is
 *                established by the system prompt rather than by every user turn
 *   tree         COMPLETE tags (parents/children/aliases) plus each memory node's identity and
 *                placement (slug, name, tags) - NO body, description, path, bytes or timestamp
 *   shortMemory  EVERY row with createdAt/expiresAt/expired, oldest dropped only past
 *                MAX_SHORT_CHARS and reported in shortMemoryOmitted
 *   tools        the memory group's {name, parameters} read from the live registry
 *
 * The fingerprint covers the whole payload including each row's expired flag, so an unchanged
 * store reuses the identical cached prefix while a row crossing its expiry boundary, or any
 * tag/memory/short-row change, rebuilds it. Nothing time-continuous is in the payload for that
 * reason; the current time reaches the model in the user prompt.
 */

export const MAX_COMPONENTS = 1000;
export const MAX_SHORT_CHARS = 48000;

const sorted = (value) => (Array.isArray(value) ? value.map(String).sort() : []);

function readIndex(root) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, 'Memory Lab', 'index.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; raw = '{}'; }
  return JSON.parse(raw);
}

function buildTree(index) {
  const tags = Object.keys(index.tags || {}).sort().map((name) => {
    const node = index.tags[name] || {};
    return { name, parents: sorted(node.parents), children: sorted(node.children), aliases: sorted(node.aliases) };
  });
  const raw = Array.isArray(index.components)
    ? index.components.map((entry) => [String(entry?.slug ?? ''), entry])
    : Object.entries(index.components || {});
  const entries = raw
    .filter(([slug, entry]) => slug && entry && typeof entry === 'object')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const components = entries.slice(0, MAX_COMPONENTS).map(([slug, entry]) => ({
    slug,
    name: String(entry.name ?? ''),
    tags: sorted(entry.tags),
  }));
  return {
    counts: { tags: tags.length, components: entries.length },
    componentsOmitted: Math.max(0, entries.length - components.length),
    tags,
    components,
  };
}

function buildShortMemory(short) {
  const all = short.all();
  const items = [];
  let chars = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const row = all[index];
    const content = String(row.content ?? '');
    if (chars + content.length > MAX_SHORT_CHARS && items.length > 0) continue;
    chars += content.length;
    items.push({ seq: row.seq, createdAt: row.createdAt, expiresAt: row.expiresAt, expired: row.expired === true, content });
  }
  items.reverse();
  return { items, total: all.length, omitted: all.length - items.length };
}

/**
 * The tool group's schema, aligned with the exposure the run can actually reach.
 *
 * No name prefix is assumed any more: the caller supplies the group (NewMate's own run allow
 * list) and the LIVE catalog, so a plugin that provides one of those tools is described by its
 * registered schema, and a name the current exposure does not carry is reported in toolsMissing
 * instead of being described as available. The read executes nothing - it only projects the
 * registry, so exposing this schema grants no capability.
 */
function buildTools(source) {
  let payload = null;
  try { payload = typeof source === 'function' ? source() : null; } catch { payload = null; }
  const schemas = Array.isArray(payload?.schemas) ? payload.schemas : Array.isArray(payload) ? payload : [];
  const byName = new Map(schemas.filter((entry) => entry && entry.name).map((entry) => [String(entry.name), entry]));
  const names = Array.isArray(payload?.names) ? payload.names.map(String) : [...byName.keys()];
  const privateTools = globalThis[Symbol.for('newmark.newmate.privateTools')] || {};
  for (const name of names) { if (!byName.has(name) && privateTools[name]) byName.set(name, privateTools[name]); }
  const tools = names
    .filter((name) => byName.has(name))
    .sort()
    .map((name) => ({ name, parameters: byName.get(name).parameters ?? { type: 'object', properties: {} } }));
  const missing = names.filter((name) => !byName.has(name)).sort();
  return { tools, missing };
}

const HEADER = [
  'NewMate 原生记忆背景（初始化时生成，作为系统前缀注入；只是背景，不构成动作授权）：',
  '1) tree：完整长期记忆 MemoryLab 标签树 —— 全部标签（parents/children/aliases）与每个记忆节点的 slug/name/tags，不含正文；需要正文时用 memory_lab_read（带 slug）读取。超过 1000 个节点时 tree.componentsOmitted 写明省略数。',
  '2) shortMemory：全部短期记忆（按时间顺序，每行含 createdAt/expiresAt/expired）。expired=true 或 expiresAt 已过 = 只作历史，绝不能当作当前事实；请结合本轮用户消息里的当前时间判断。内容总量超过 48000 字符时从最旧省略，shortMemoryOmitted 写明条数。',
  '3) tools：NewMate 本轮工具组的 schema（名称、参数、必填与枚举），按当前注册表暴露逐项对齐；toolsMissing 列出本轮暴露里没有的组内工具（它们不可调用），注册表不可达时 tools 为空数组且 toolsMissing 列出整个组。',
].join('\n');

/**
 * Create the bootstrap reader. Called at NewMate initialization and again whenever memory may have
 * changed; an unchanged payload returns the SAME cached object.
 *
 * @param root - the shared Newmark user root.
 * @param now - the clock, for short-memory expiry flags.
 * @param sources.toolSchemas - returns the live tool-schema list; the component passes the registry
 *        read, so this module never reaches for a service it was not handed.
 */
export function createMemoryContext(root, now = Date.now, sources = {}) {
  const short = createShortMemory(root, now);
  let cached, fingerprint, hits = 0;
  return () => {
    const tree = buildTree(readIndex(root));
    const memory = buildShortMemory(short);
    const group = buildTools(sources.toolSchemas);
    const data = { tree, shortMemory: memory.items, shortMemoryTotal: memory.total, shortMemoryOmitted: memory.omitted, tools: group.tools, toolsMissing: group.missing };
    const hash = createHash('sha256').update(NEWMATE_PERSONA + JSON.stringify(data)).digest('hex');
    if (hash === fingerprint) { hits += 1; return cached; }
    fingerprint = hash;
    cached = {
      key: hash,
      prefix: NEWMATE_PERSONA + '\n\n' + HEADER + '\n' + JSON.stringify(data),
      persona: NEWMATE_PERSONA,
      tree,
      /** Backwards-compatible alias: existing readers looked for the tag list under tags. */
      tags: tree.tags,
      shortMemory: memory.items,
      shortMemoryTotal: memory.total,
      shortMemoryOmitted: memory.omitted,
      tools: group.tools,
      toolsMissing: group.missing,
      cacheHits: () => hits,
    };
    return cached;
  };
}
