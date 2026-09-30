/**
 * Newmark MemoryLab — durable memory store for the DeepSeek Harness port.
 *
 * This module is the single source of truth for the Memory Lab on-disk contract.
 * It is pure Node ESM (`node:fs`, `node:path`, `node:crypto` only): no DSH import,
 * no TypeScript, no build step.
 *
 * The on-disk contract below is the REAL Newmark v2 store contract (verified
 * against `%USERPROFILE%\.Newmark\Memory Lab\index.json` and against the
 * reference implementation `MemoryLabManager` shipped in the archived Newmark
 * package, `dist/core/memoryLab.js` + `memoryLab.d.ts`).
 *
 * ROOT RESOLUTION (this `newmark-core` copy). The host half is handed Newmark's
 * own user root — `~/.Newmark`, see `index.js` `defaultRoot()` — and Newmark
 * keeps this store in the `Memory Lab` folder beside `config.json`, so the files
 * named below are the user's production memory. A store is therefore rooted at
 * `<configuredRoot>/Memory Lab`; `store.userRoot` keeps the configured root for
 * callers that log or display it, and `store.root` is the Memory Lab directory
 * itself. A configured root that already IS a Memory Lab — it carries an
 * `index.json`, or a `Memory Lab/index.json` below it, or a `Memory Lab` folder,
 * or a lab marker such as `components/`, `archive/`, `policy.jsonl`, or it is
 * literally named `Memory Lab` — is used as it is, so `config.root` may name
 * either shape and a fixture root keeps working. Everything lands in the
 * resolved directory:
 *
 *   <root>/index.json                                the normalized index
 *   <root>/components/<slug>.md                      kind: "file"   component core markdown
 *   <root>/components/<slug>/memory.md               kind: "folder" component core markdown
 *   <root>/archive/<slug>/<timestamp>-<rev>.md       archived prior revisions (verbatim)
 *   <root>/policy.jsonl                              append-only policy audit log
 *   <root>/index.json.bak                            previous good index
 *   <root>/index.json.corrupt                        quarantined unreadable index
 *
 * index.json shape (version 2), exactly as the real store writes it:
 *
 *   {
 *     "version": 2,
 *     "updatedAt": "<ISO8601>",                      the INDEX timestamp only
 *     "tags": { "#Tag": { parents, children, components, aliases } },
 *     "components": { "<slug>": { name, description, tags, tagPaths, path,
 *                                 coreMd, kind, createdAt, updatedAt,
 *                                 revision?, contentHash?, bytes? } },
 *     "preferredLanguage": "auto" | "en" | "zh"
 *   }
 *
 * Compatibility notes (each one is asserted by the gate):
 *   - Tag names keep exactly one leading `#`. Input with or without `#` is
 *     accepted and normalized to `#Name`; reindexing the real store renames
 *     nothing.
 *   - `tagPaths` keeps chains of length >= 1: `[["#数学"], ["#数学","#微分拓扑"]]`.
 *   - `components` is a plain object keyed by slug on disk (the in-memory index
 *     keeps it as an array; `writeIndex` serializes it and `normalizeIndex`
 *     reads both shapes).
 *   - `path` and `coreMd` are absolute, Windows-style paths as stored; a read
 *     never rewrites them, and a reindex preserves them while they still point
 *     inside `components/`.
 *   - `updatedAt` at the top level is the index timestamp; component timestamps
 *     are preserved verbatim by a reindex.
 *   - The module adds three clearly-named integrity fields the real store does
 *     not carry: per component `contentHash`/`bytes` (the reference manager also
 *     adds `revision` on its own reindex) and the top-level `relationshipVersion`.
 *     No real field is renamed, retyped or dropped.
 *
 * Invariants this module enforces:
 *   - Every mutation is atomic (`<file>.tmp` in the same directory + rename).
 *   - The previous good index.json is kept as `.bak` on every successful write.
 *   - An unreadable index.json recovers from `.bak` (bad file renamed `*.corrupt`);
 *     with no `.bak` it is reported as a structured error, never silently emptied.
 *   - Read paths never write, apart from that documented recovery.
 *   - `reindex()` is the single normalizer and is graph-idempotent.
 *
 * Documented normalizations (see the port report):
 *   - `tagPaths` legacy slash/arrow separators (`#A/B/C`, `A > B`) are still split
 *     into a chain; the reference's direction-word heuristics are not ported.
 *   - Bilingual synonyms fold ONLY among spellings that are actually observed in
 *     the index (`collectAliasGroups` semantics); the other spellings of a folded
 *     group are preserved in that node's `aliases`. A store that uses one spelling
 *     per group — like the real one — is therefore left byte-identical.
 *   - Archived markdown is stored verbatim (no YAML header), so an archive file's
 *     sha256 equals the archived revision's `contentHash`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** index.json schema version written by this module (the real store version). */
export const INDEX_VERSION = 2;

/** `preferredLanguage` written when the store does not carry one. */
export const DEFAULT_PREFERRED_LANGUAGE = 'auto';

/** Accepted `preferredLanguage` values. */
export const PREFERRED_LANGUAGES = Object.freeze(['auto', 'en', 'zh']);

/** File name of a `kind: "folder"` component's core markdown. */
export const FOLDER_CORE_FILENAME = 'memory.md';

/** Hard cap on the text scanned from one component during a query. */
export const MAX_COMPONENT_SCAN_CHARS = 64000;

/** `maxChars` clamp. */
export const MIN_MAX_CHARS = 1000;
export const MAX_MAX_CHARS = 48000;
export const DEFAULT_MAX_CHARS = 12000;

/** `limit` clamp. */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 12;
export const DEFAULT_LIMIT = 5;

/** Adaptive early stop: a score below this fraction of the best score is dropped. */
export const WEAK_MATCH_FLOOR = 0.35;

/** Excerpt window returned per match. */
export const EXCERPT_CHARS = 240;

/** A match is not started when fewer than this many excerpt characters remain. */
export const MIN_EXCERPT_BUDGET = 200;

/** Brand placed on plans produced by `prepareUpdate()`. */
export const PLAN_BRAND = 'memorylab-plan-v1';

/** Field weights used by the deterministic query score. */
export const FIELD_WEIGHTS = Object.freeze({ name: 12, tags: 9, description: 6, content: 2 });

/**
 * The tag-graph repairs that need a judgement the deterministic rebuild cannot
 * make. Each one is REVIEWED (reported with its evidence) and then, if the caller
 * decides so, APPLIED as a recorded decision — never applied by a rule.
 */
export const TAG_FINDING_KINDS = Object.freeze([
  /** A root tag the components that carry it already file under some other tag. */
  'false-root',
  /** Tags whose names are near-duplicates, near-synonyms or the same idea twice. */
  'synonym-candidate',
  /** One stored name that may be a chain the normalizer collapsed into a tag. */
  'single-tag-path',
  /** A parent -> child edge whose joined spelling exists: maybe one tag, not two. */
  'path-might-be-one-tag',
  /** A stored value today's rule does not reproduce (grandfathering, or drift). */
  'rule-not-reproducible',
]);

/** How many findings one review returns unless the caller asks for another window. */
export const DEFAULT_TAG_FINDING_LIMIT = 25;

/** Hard cap on `limit`, so a review can never dump an unbounded graph. */
export const MAX_TAG_FINDING_LIMIT = 200;

/**
 * The tag-graph decisions `applyTagDecisions()` accepts. `merge`, `reparent`,
 * `split` and `join` are the four repairs; `set-tags` and `unfold` exist so an
 * applied decision can be reversed exactly (see the `undo` in every receipt).
 */
export const TAG_DECISION_KINDS = Object.freeze(['merge', 'reparent', 'split', 'join', 'set-tags', 'unfold']);

/** The `action` every tag-graph decision batch records in `policy.jsonl`. */
export const TAG_EDIT_ACTION = 'TAG-EDIT';

/** Where a pre-change index snapshot is archived, beside the revision archives. */
export const TAG_ARCHIVE_DIR = '_tag-graph';

/**
 * Bilingual synonym table. Every group folds to ONE canonical tag; the other
 * spellings are preserved in that tag node's `aliases`. `options.language`
 * (`'zh'` | `'en'`) selects which spelling of a group is canonical.
 *
 * A group only ever folds the spellings that are actually present in the index
 * (matching the reference `collectAliasGroups`): a store that uses a single
 * spelling per group is never renamed.
 */
export const SYNONYM_GROUPS = Object.freeze([
  Object.freeze(['记忆', '记忆库', 'memory']),
  Object.freeze(['项目', 'project']),
  Object.freeze(['偏好', 'preference']),
  Object.freeze(['约定', 'convention']),
  Object.freeze(['工具', 'tool']),
  Object.freeze(['用户', 'user']),
  Object.freeze(['模型', 'model']),
  Object.freeze(['技能', 'skill', 'skills']),
  Object.freeze(['物理', 'physics']),
  Object.freeze(['数学', 'mathematics', 'math']),
  Object.freeze(['研究', 'research']),
  Object.freeze(['代码', 'code']),
  Object.freeze(['发布', 'release']),
  Object.freeze(['智能体', 'agent']),
]);

/** Structured error raised by every rejecting API of this module. */
export class MemoryLabStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryLabStoreError';
    this.code = code;
    this.details = details && typeof details === 'object' ? details : {};
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

// ---------------------------------------------------------------------------
// small deterministic helpers
// ---------------------------------------------------------------------------

/** Code-unit string order: locale independent, so rebuilds are byte-stable. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values) {
  return Array.from(new Set((values || []).filter((value) => typeof value === 'string' && value.length > 0))).sort(compareStrings);
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isoNow() {
  return new Date().toISOString();
}

/** Preserve a stored timestamp string byte-exactly; fall back to now. */
function isoOr(value, fallback) {
  if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) return value;
  return fallback;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when any path segment is `..`, i.e. an explicit traversal attempt. */
function hasEscapeSegment(value) {
  const text = String(value ?? '');
  if (!text) return false;
  return text.replace(/\\/g, '/').split('/').some((segment) => segment === '..');
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  } catch {
    /* fall through to a bounded spin */
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

/** `write to <file>.tmp in the same directory, then rename`. */
function writeFileAtomic(target, data) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmp, resolved);
      return resolved;
    } catch (error) {
      lastError = error;
      sleepSync(20 * (attempt + 1));
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* keep the original failure */
  }
  throw lastError;
}

/**
 * Normalize one tag spelling to exactly one leading `#`, with whitespace runs
 * collapsed to single hyphens. `'#AI-Agent'`, `'AI-Agent'` -> `'#AI-Agent'`.
 */
function normalizeTagName(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(/^#+/, '').trim();
  if (!text) return '';
  text = text
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!text) return '';
  return `#${text}`;
}

/** Comparison key of a tag: no `#`, lower case, spaces/underscores -> `-`. */
function tagComparisonKey(value) {
  return normalizeTagName(value).replace(/^#/, '').toLowerCase().replace(/[\s_]+/g, '-');
}

function comparisonKey(value) {
  return tagComparisonKey(value);
}

/** Split `"a, b，c"` into normalized `#Tag` names. */
function splitTagValue(value) {
  const text = String(value ?? '');
  if (!text.trim()) return [];
  return text
    .split(/[,，、;\n]+/)
    .map(normalizeTagName)
    .filter(Boolean);
}

/** Split legacy path spellings (`#A/B`, `A > B`, `A→B`) into a `#Tag` chain. */
function splitLegacyPath(name) {
  const text = String(name ?? '');
  if (!text.trim()) return [];
  const parts = text
    .split(/[/>→]+/)
    .map(normalizeTagName)
    .filter(Boolean);
  return parts.length ? parts : [normalizeTagName(text)].filter(Boolean);
}

/** Canonical latin key of a synonym group (used to fold spellings together). */
function synonymGroupKey(group) {
  return tagComparisonKey(group.find((name) => /^[a-z0-9][a-z0-9-]*$/i.test(name)) || group[0]);
}

const SYNONYM_GROUPS_BY_KEY = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    const key = synonymGroupKey(group);
    map.set(key, sortedUnique(group.map(normalizeTagName)));
  }
  return map;
})();

const SYNONYM_KEYS = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    const key = synonymGroupKey(group);
    for (const name of group) {
      map.set(tagComparisonKey(name), key);
      map.set(`#${tagComparisonKey(name)}`, key);
    }
  }
  return map;
})();

function synonymKey(name) {
  const key = tagComparisonKey(name);
  return SYNONYM_KEYS.get(key) || key;
}

function isCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value ?? ''));
}

/**
 * Deterministic slug: lower case, filesystem safe, hyphenated. CJK characters are
 * KEPT, so the real store's slugs (`用户专业方向与研究背景`,
 * `4维微分流形-exotic-r4-论文知识库`, `coding-agent-与代码生成`) reproduce from
 * their names. Falls back to a hash when nothing usable survives.
 */
export function slugify(name) {
  const raw = String(name ?? '').trim();
  const cleaned = raw
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._\-\u4e00-\u9fff]+/gi, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 120)
    .replace(/^[-._]+|[-._]+$/g, '');
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned;
  return `m-${sha256Hex(raw).slice(0, 16)}`;
}

/** A slug-shaped value: ASCII or CJK body, no traversal, bounded length. */
function slugLike(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[a-z0-9\u4e00-\u9fff][a-z0-9._\-\u4e00-\u9fff]*$/.test(value) &&
    !value.includes('..') &&
    value !== '.' &&
    value !== '..'
  );
}

function safeSlug(candidate) {
  if (slugLike(candidate)) return candidate;
  return slugify(candidate);
}

function fileExists(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readTextOrNull(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  const base = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return Math.max(min, Math.min(max, base));
}

/** In-memory components are an array; on disk they are keyed by slug. */
function componentList(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === 'object');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([slug, meta]) => {
      const entry = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
      entry.slug = typeof entry.slug === 'string' && entry.slug.trim() ? entry.slug : slug;
      return entry;
    });
  }
  return [];
}

/**
 * Query terms: English-like word tokens plus Chinese bigrams. Deterministic.
 */
function tokenizeQuery(text) {
  const lower = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const raw of lower.split(/[^\p{L}\p{N}_.+#-]+/u)) {
    const term = raw.replace(/^[.#]+/, '').replace(/[.#]+$/, '');
    if (term.length > 1) terms.add(term);
  }
  for (const match of lower.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = match[0];
    if (run.length >= 2) terms.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return Array.from(terms).sort(compareStrings);
}

function buildExcerpt(content, terms, max = EXCERPT_CHARS) {
  if (!content) return '';
  const lower = content.toLowerCase();
  let position = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (position < 0 || at < position)) position = at;
  }
  if (position < 0) {
    const head = content.slice(0, max);
    return content.length > max ? `${head}…` : head;
  }
  const start = Math.max(0, position - 60);
  const window = content.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${window}${start + max < content.length ? '…' : ''}`;
}

/** Score one component field-by-field; `#` counts matches, an exact hit doubles. */
function scoreComponent(fields, normalizedQuery, terms) {
  let score = 0;
  const matched = [];
  for (const field of ['name', 'tags', 'description', 'content']) {
    const value = fields[field];
    if (!value) continue;
    const exact = normalizedQuery.length > 1 && value.includes(normalizedQuery);
    let hits = 0;
    for (const term of terms) if (value.includes(term)) hits += 1;
    if (!exact && !hits) continue;
    score += (exact ? FIELD_WEIGHTS[field] * 2 : 0) + hits * FIELD_WEIGHTS[field];
    matched.push(field);
  }
  return { score, matched };
}

function notFoundError(selector) {
  return new MemoryLabStoreError('NOT_FOUND', `Memory component not found: ${selector}`, { selector });
}

/**
 * The shape of a tag name with every separator removed, so `#AI-Agent`,
 * `#ai agent` and `#AI_Agent` compare equal. The reviews use it to find names
 * that are near-duplicates; it never rewrites a name.
 */
function nameShape(value) {
  return String(value ?? '')
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s\-_.·/|+,，、;:]+/g, '');
}

/** Levenshtein distance, bounded: the review only tests whether it is <= 2. */
function editDistance(a, b, limit = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) >= limit) return limit;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...current) >= limit) return limit;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Whether a name survives the input parser as exactly one tag node.
 *
 * `splitLegacyPath()` splits `/`, `>` and `→`, and `splitTagValue()` splits the
 * comma family, so a name carrying any of them can never come back as one tag:
 * the next rebuild would split it again. `join` refuses such a target by name
 * rather than writing a name that silently becomes two tags.
 */
function survivesAsOneTag(name) {
  const text = String(name ?? '');
  if (!text || normalizeTagName(text) !== text) return false;
  if (/[/>,，、;\n|]/.test(text)) return false;
  const parts = splitLegacyPath(text);
  return parts.length === 1 && parts[0] === text;
}

function pathEscapeError(candidate, root) {
  return new MemoryLabStoreError('PATH_ESCAPE', `Path escapes the Memory Lab root: ${candidate}`, {
    candidate: String(candidate ?? ''),
    root,
  });
}

/** Raw-order-preserving map: known keys first in their original order, then the rest. */
function orderByOriginal(entries, originalOrder) {
  const byName = new Map((entries || []).map((entry) => [entry.slug, entry]));
  const out = [];
  for (const slug of originalOrder || []) {
    const entry = byName.get(slug);
    if (!entry) continue;
    byName.delete(slug);
    out.push(entry);
  }
  for (const slug of Array.from(byName.keys()).sort(compareStrings)) out.push(byName.get(slug));
  return out;
}

// ---------------------------------------------------------------------------
// root resolution
// ---------------------------------------------------------------------------

/** The folder Newmark itself keeps the store in, beside `config.json`. */
const LAB_DIR_NAME = 'Memory Lab';

/** Directories/files that identify a directory as a Memory Lab store. */
const LAB_MARKERS = Object.freeze(['components', 'archive', 'policy.jsonl']);

/**
 * Resolve the Memory Lab directory for a configured root.
 *
 * The host half passes Newmark's user root (`~/.Newmark`), where the store lives
 * in the `Memory Lab` folder. A root that already is a Memory Lab — every gate
 * fixture, and a deployment that points `config.root` straight at the folder —
 * is used unchanged, so no caller has to know which shape it holds. First match
 * wins:
 *
 *   1. `<root>/index.json`             the root is a Memory Lab
 *   2. `<root>/Memory Lab/index.json`  the root is the user root, store present
 *   3. `<root>/Memory Lab`             the store folder exists without an index
 *   4. a lab marker under `<root>`     an index-less Memory Lab (components/, …)
 *   5. root named `Memory Lab`         an empty folder that is one by name
 *   6. otherwise                       a fresh user root -> `<root>/Memory Lab`
 */
function resolveLabDir(root) {
  const configured = path.resolve(root);
  const nested = path.join(configured, LAB_DIR_NAME);
  if (fileExists(path.join(configured, 'index.json'))) return configured;
  if (fileExists(path.join(nested, 'index.json'))) return nested;
  if (fs.existsSync(nested)) return nested;
  if (LAB_MARKERS.some((marker) => fs.existsSync(path.join(configured, marker)))) return configured;
  if (path.basename(configured).toLowerCase() === LAB_DIR_NAME.toLowerCase()) return configured;
  return nested;
}

// ---------------------------------------------------------------------------
// MemoryLabStore
// ---------------------------------------------------------------------------

export class MemoryLabStore {
  /**
   * @param {string} root Newmark's user root (`~/.Newmark`) or a Memory Lab
   *        directory — see `resolveLabDir()`. Created lazily by mutations.
   * @param {{ language?: 'en'|'zh', preferredLanguage?: 'auto'|'en'|'zh', now?: () => string }} [options]
   *        `language` selects the preferred canonical tag in bilingual folding;
   *        `preferredLanguage` is the value persisted in index.json (`'auto'` by
   *        default, exactly like the real store).
   */
  constructor(root, options = {}) {
    if (typeof root !== 'string' || !root.trim()) {
      throw new MemoryLabStoreError('INVALID_ROOT', 'Memory Lab root must be a non-empty path string.');
    }
    this.userRoot = path.resolve(root.trim());
    this.root = resolveLabDir(this.userRoot);
    this.language = options && options.language === 'zh' ? 'zh' : 'en';
    const requested =
      options && options.preferredLanguage !== undefined && options.preferredLanguage !== null
        ? options.preferredLanguage
        : options && options.language !== undefined && options.language !== null
          ? options.language
          : DEFAULT_PREFERRED_LANGUAGE;
    this.preferredLanguage = PREFERRED_LANGUAGES.includes(String(requested)) ? String(requested) : DEFAULT_PREFERRED_LANGUAGE;
    this.indexPath = path.join(this.root, 'index.json');
    this.bakPath = `${this.indexPath}.bak`;
    this.componentsDir = path.join(this.root, 'components');
    this.archiveDir = path.join(this.root, 'archive');
    this.policyPath = path.join(this.root, 'policy.jsonl');
  }

  // -- layout ---------------------------------------------------------------

  /**
   * Create the directories and an empty index. Never rewrites an existing
   * index.json, so this is safe to call on a populated store.
   */
  ensureLayout() {
    const created = [];
    for (const dir of [this.root, this.componentsDir, this.archiveDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(dir);
      }
    }
    let indexCreated = false;
    if (!fs.existsSync(this.indexPath)) {
      this.writeIndex(this.emptyIndex(), { skipBackup: true });
      indexCreated = true;
    }
    return {
      ok: true,
      root: this.root,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      archiveDir: this.archiveDir,
      policyPath: this.policyPath,
      created,
      indexCreated,
    };
  }

  emptyIndex() {
    return {
      version: INDEX_VERSION,
      updatedAt: isoNow(),
      relationshipVersion: '',
      preferredLanguage: this.preferredLanguage,
      tags: {},
      components: [],
    };
  }

  /** `preferredLanguage` of a raw index, falling back to this store's setting. */
  preferredLanguageOf(rawIndex) {
    const value = rawIndex && typeof rawIndex === 'object' ? rawIndex.preferredLanguage : undefined;
    return PREFERRED_LANGUAGES.includes(String(value)) ? String(value) : this.preferredLanguage;
  }

  /**
   * Load the index for a mutation: an unreadable index is a hard error (before
   * anything touches the disk), otherwise the layout is created and the current
   * in-memory index returned.
   */
  openForWrite() {
    const loaded = this.loadIndex();
    if (!loaded.ok) throw new MemoryLabStoreError(loaded.error.code, loaded.error.message, loaded.error.details);
    this.ensureLayout();
    return loaded.status === 'missing' ? this.emptyIndex() : loaded.index;
  }

  instructions() {
    return [
      `Newmark Memory Lab durable memory. Root: ${this.root}`,
      'memory_lab_read inspects the index (tags, tagPaths, revisions) before deciding anything; memory_lab_read with a slug/name/path also returns that component core markdown.',
      'memory_lab_query is bounded task-relevant retrieval: prefer it over injecting the whole index.',
      'memory_lab_update creates or replaces a component; pass expectedUpdatedAt from the latest read so a stale write is rejected instead of overwriting newer memory.',
      'For small edits prefer contentAppend or oldText/newText over resending the whole body. memory_lab_delete forgets a component only when the user asks.',
      'memory_lab_reindex is the deterministic rebuild; memory_lab_tag_review reports the tag-graph repairs that need your judgement (near-synonyms, a false root, a collapsed or over-split path) and memory_lab_tag_apply records the decisions you make from it, reversibly.',
      'Tag names carry one leading "#"; a tag that stands alone still gets its own single-node tagPath. Express hierarchy with tagPaths, for example [["#研究","#论文"]].',
      'Every revision is archived under archive/<slug>/ and every mutation appends one policy.jsonl line (action, slug, reason, source, timestamps, archive path, content hash) — never memory content.',
      'Never inject index or component content into the system prompt; retrieve it through these tools only when needed.',
    ].join('\n');
  }

  // -- index IO -------------------------------------------------------------

  /**
   * Read index.json. Never writes, except the documented `.bak` recovery when the
   * index is genuinely unreadable. Returns `{ ok:false, error }` rather than
   * silently emptying a store whose index cannot be read.
   */
  loadIndex() {
    const warnings = [];
    if (!fs.existsSync(this.indexPath)) {
      return { ok: true, status: 'missing', index: this.emptyIndex(), warnings };
    }
    const raw = readTextOrNull(this.indexPath);
    if (raw === null) {
      return {
        ok: false,
        status: 'error',
        index: null,
        warnings,
        error: new MemoryLabStoreError('INDEX_UNREADABLE', `Memory Lab index.json could not be read: ${this.indexPath}`, {
          indexPath: this.indexPath,
        }).toJSON(),
      };
    }
    try {
      const parsed = JSON.parse(raw);
      const { index, warnings: normalizeWarnings } = this.normalizeIndex(parsed);
      return { ok: true, status: 'ok', index, warnings: [...warnings, ...normalizeWarnings] };
    } catch (error) {
      warnings.push(`index-unreadable:${error && error.code ? error.code : 'MALFORMED_JSON'}`);
    }

    // Recovery: a previous good index is preserved as `.bak`.
    const bakRaw = readTextOrNull(this.bakPath);
    if (bakRaw !== null) {
      try {
        const parsedBak = JSON.parse(bakRaw);
        const corruptPath = this.quarantineIndex();
        writeFileAtomic(this.indexPath, bakRaw);
        const { index, warnings: normalizeWarnings } = this.normalizeIndex(parsedBak);
        return {
          ok: true,
          status: 'recovered',
          index,
          warnings: [...warnings, `recovered-from:${path.basename(this.bakPath)}`, ...normalizeWarnings],
          recoveredFrom: this.bakPath,
          corruptPath,
        };
      } catch (error) {
        warnings.push(`bak-unusable:${error && error.message ? error.message : String(error)}`);
      }
    }

    return {
      ok: false,
      status: 'error',
      index: null,
      warnings,
      error: new MemoryLabStoreError(
        'INDEX_MALFORMED',
        `Memory Lab index.json is unreadable and no usable .bak exists: ${this.indexPath}`,
        { indexPath: this.indexPath, bakPath: this.bakPath, bytes: byteLength(raw) },
      ).toJSON(),
    };
  }

  /** Rename an unreadable index.json to `*.corrupt` (never delete evidence). */
  quarantineIndex() {
    let target = `${this.indexPath}.corrupt`;
    let counter = 1;
    while (fs.existsSync(target)) {
      counter += 1;
      target = `${this.indexPath}.corrupt.${counter}`;
    }
    fs.renameSync(this.indexPath, target);
    return target;
  }

  /**
   * The exact on-disk document: the real store's key order and field names, with
   * this module's integrity fields appended (`relationshipVersion` last, and
   * `revision`/`contentHash`/`bytes` after the real component fields).
   */
  indexDocument(index) {
    const tags = {};
    for (const [name, node] of Object.entries(index.tags || {})) {
      tags[name] = {
        parents: sortedUnique(node && node.parents),
        children: sortedUnique(node && node.children),
        components: sortedUnique(node && node.components),
        aliases: sortedUnique(node && node.aliases),
      };
    }
    const components = {};
    for (const component of componentList(index.components)) {
      const entry = {
        name: String(component.name ?? component.slug ?? ''),
        description: String(component.description ?? ''),
        tags: sortedUnique(component.tags),
        tagPaths: (component.tagPaths || []).map((chain) => chain.slice()),
        path: String(component.path ?? ''),
        coreMd: String(component.coreMd ?? component.path ?? ''),
        kind: component.kind === 'folder' ? 'folder' : 'file',
        createdAt: isoOr(component.createdAt, isoNow()),
        updatedAt: isoOr(component.updatedAt, isoNow()),
        revision: Math.max(1, Math.floor(Number(component.revision) || 1)),
        contentHash: typeof component.contentHash === 'string' ? component.contentHash : '',
        bytes: Number.isFinite(Number(component.bytes)) && Number(component.bytes) >= 0 ? Math.floor(Number(component.bytes)) : 0,
      };
      components[String(component.slug)] = entry;
    }
    return {
      version: INDEX_VERSION,
      updatedAt: isoOr(index.updatedAt, isoNow()),
      tags,
      components,
      preferredLanguage: PREFERRED_LANGUAGES.includes(String(index.preferredLanguage))
        ? String(index.preferredLanguage)
        : this.preferredLanguage,
      relationshipVersion: String(index.relationshipVersion || ''),
    };
  }

  /**
   * Atomically persist the index: previous good index -> `.bak`, payload ->
   * `index.json.tmp` -> `index.json`. The payload is `JSON.stringify(..., 2)`
   * with no trailing newline, byte-identical in shape to the real store.
   */
  writeIndex(index, options = {}) {
    const target = index && typeof index === 'object' ? index : this.emptyIndex();
    fs.mkdirSync(this.root, { recursive: true });
    target.version = INDEX_VERSION;
    target.updatedAt = isoNow();
    target.preferredLanguage = this.preferredLanguageOf(target);
    target.relationshipVersion = this.relationshipVersion(target);
    const payload = JSON.stringify(this.indexDocument(target), null, 2);
    if (!options.skipBackup && fs.existsSync(this.indexPath)) {
      const previous = readTextOrNull(this.indexPath);
      if (previous !== null) {
        try {
          JSON.parse(previous);
          writeFileAtomic(this.bakPath, previous);
        } catch {
          /* never overwrite a good .bak with an unreadable index */
        }
      }
    }
    writeFileAtomic(this.indexPath, payload);
    return target;
  }

  /** Deterministic hash over the tag graph and the component -> tag membership. */
  relationshipVersion(index) {
    const tags = Object.keys(index.tags || {})
      .sort(compareStrings)
      .map((name) => {
        const node = index.tags[name] || {};
        return [name, sortedUnique(node.aliases), sortedUnique(node.parents), sortedUnique(node.children), sortedUnique(node.components)];
      });
    const membership = componentList(index.components)
      .map((component) => [
        component.slug,
        sortedUnique(component.tags),
        (component.tagPaths || []).map((chain) => chain.slice()).sort((a, b) => compareStrings(a.join('\u0000'), b.join('\u0000'))),
      ])
      .sort((a, b) => compareStrings(a[0], b[0]));
    return sha256Hex(JSON.stringify({ tags, membership, version: INDEX_VERSION }));
  }

  // -- path containment -----------------------------------------------------

  /** Resolve a root-relative (or absolute-inside-root) path, rejecting escapes. */
  resolveInsideRoot(candidate) {
    const text = String(candidate ?? '').trim();
    if (!text) throw pathEscapeError(candidate, this.root);
    if (hasEscapeSegment(text)) throw pathEscapeError(text, this.root);
    const resolved = path.resolve(this.root, text);
    if (!isInside(this.root, resolved)) throw pathEscapeError(text, this.root);
    return resolved;
  }

  /**
   * Canonical absolute paths of a component: the container (`components/<slug>.md`
   * for `file`, `components/<slug>` for `folder`) and the core markdown file
   * (`components/<slug>.md` resp. `components/<slug>/memory.md`).
   */
  canonicalComponentPaths(slug, kind) {
    const container = kind === 'folder' ? path.join(this.componentsDir, slug) : path.join(this.componentsDir, `${slug}.md`);
    const core = kind === 'folder' ? path.join(container, FOLDER_CORE_FILENAME) : container;
    return { container, core };
  }

  /**
   * Keep a stored `path`/`coreMd` string verbatim while it still points inside
   * `components/`; otherwise use the canonical path. Mirrors the reference
   * `safeComponentPath()` while never rewriting a usable stored path.
   */
  preservedComponentPath(candidate, fallback) {
    const text = typeof candidate === 'string' ? candidate.trim() : '';
    if (!text) return fallback;
    if (hasEscapeSegment(text)) return fallback;
    const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(this.root, text);
    return isInside(this.componentsDir, resolved) ? text : fallback;
  }

  /** Absolute core markdown path of one indexed component. */
  resolveComponentFile(component) {
    const candidate = String((component && (component.coreMd || component.path)) || '').trim();
    if (!candidate) throw pathEscapeError(candidate, this.root);
    return this.resolveInsideRoot(candidate);
  }

  /** Absolute container path of one indexed component (file or folder). */
  resolveComponentContainer(component) {
    const kind = component && component.kind === 'folder' ? 'folder' : 'file';
    const candidate = kind === 'folder' ? String((component && component.path) || '').trim() : '';
    if (candidate) return this.resolveInsideRoot(candidate);
    return path.dirname(this.resolveComponentFile(component));
  }

  // -- normalization --------------------------------------------------------

  /**
   * Input-time fold table: every built-in synonym group maps onto ONE name — the
   * group member that already exists as a tag node, otherwise the
   * language-preferred spelling. This is what makes `tags: ['约定']` canonicalize
   * to `#convention` on a fresh store while an existing `#工具` keeps the spelling
   * the store already uses.
   */
  inputTagFold(rawIndex) {
    const primaries = new Map();
    const spellings = new Map();
    const remember = (map, key, name) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(name);
    };
    for (const node of this.rawTagNodes(rawIndex)) {
      const key = synonymKey(node.name);
      remember(primaries, key, node.name);
      remember(spellings, key, node.name);
      for (const alias of node.aliases) remember(spellings, key, alias);
    }
    const aliasIndex = new Map();
    const hints = new Map();
    for (const [key, group] of SYNONYM_GROUPS_BY_KEY) {
      const stored = sortedUnique(Array.from(primaries.get(key) || []));
      const pool = sortedUnique([...group, ...Array.from(spellings.get(key) || [])]);
      const canonical = stored.length
        ? stored.slice().sort((a, b) => a.length - b.length || compareStrings(a, b))[0]
        : this.chooseCanonicalTag(group, new Set(group));
      for (const name of pool) aliasIndex.set(comparisonKey(name), canonical);
      hints.set(key, { key, canonical, names: pool });
    }
    return { aliasIndex, hints };
  }

  /**
   * Alias groups observed in the index, folded with the built-in synonym table.
   *
   * A group only folds when at least TWO of its spellings are actually observed
   * (tag node key/name, a stored alias, a component tag or a tagPath node) — the
   * reference `collectAliasGroups` semantics. A store that uses one spelling per
   * group is therefore left untouched, with no invented aliases: the real store
   * keeps every one of its 91 tag names.
   */
  tagAliasGroups(rawIndex, options = {}) {
    /**
     * Spellings an applied `unfold` decision has taken back out of the fold
     * table. Without this the alias a `merge` wrote would be re-observed from the
     * stored node on every later rebuild, so undoing a merge would silently fail:
     * the restored spelling would canonicalise straight back into the merged tag.
     */
    const dropKeys = new Set((options.aliasDrops || []).map((name) => comparisonKey(name)));
    const dropped = (name) => dropKeys.has(comparisonKey(name));
    const observed = new Map();
    const add = (key, name) => {
      if (!key || !name || dropped(name)) return;
      if (!observed.has(key)) observed.set(key, new Set());
      observed.get(key).add(name);
    };
    for (const node of this.rawTagNodes(rawIndex)) {
      const own = sortedUnique([node.name, ...node.aliases]);
      if (!own.length) continue;
      const nodeKey = synonymKey(own[0]);
      for (const name of own) {
        add(nodeKey, name);
        add(synonymKey(name), name);
      }
    }
    for (const entry of this.rawComponentEntries(rawIndex)) {
      if (!entry || typeof entry !== 'object') continue;
      const names = sortedUnique([
        ...toArray(entry.tags).flatMap((value) => splitTagValue(value)).flatMap((name) => splitLegacyPath(name)),
        ...toArray(entry.tagPaths)
          .filter(Array.isArray)
          .flatMap((chain) => chain.flatMap((value) => splitLegacyPath(value))),
      ]);
      for (const name of names) add(synonymKey(name), name);
    }
    const aliasIndex = new Map();
    const canonicalByGroup = new Map();
    for (const [key, names] of observed) {
      const all = sortedUnique(Array.from(names));
      if (all.length < 2) continue;
      const pool = sortedUnique([...all, ...(SYNONYM_GROUPS_BY_KEY.get(key) || [])]).filter((name) => !dropped(name));
      if (pool.length < 2) continue;
      const canonical = this.chooseCanonicalTag(pool, new Set(all.filter((name) => !dropped(name))));
      canonicalByGroup.set(canonical, pool.filter((name) => name !== canonical));
      for (const name of pool) aliasIndex.set(comparisonKey(name), canonical);
    }
    for (const key of dropKeys) aliasIndex.delete(key);
    return { aliasIndex, canonicalByGroup };
  }

  /** Language-preferred canonical spelling of one synonym group. */
  chooseCanonicalTag(names, preferred) {
    const pick = (pool) => pool.slice().sort((a, b) => a.length - b.length || compareStrings(a, b))[0];
    const cjk = names.filter((name) => isCjk(name));
    const nonCjk = names.filter((name) => !isCjk(name));
    const pool = this.language === 'zh' ? cjk : nonCjk;
    const usable = pool.length ? pool : names;
    const preferredUsable = usable.filter((name) => preferred && preferred.has(name));
    const scoped = preferredUsable.length ? preferredUsable : usable;
    return pick(scoped) || names[0];
  }

  rawTagNodes(rawIndex) {
    const tags = rawIndex && typeof rawIndex === 'object' && rawIndex.tags && typeof rawIndex.tags === 'object' && !Array.isArray(rawIndex.tags) ? rawIndex.tags : {};
    const nodes = [];
    for (const [key, value] of Object.entries(tags)) {
      if (Array.isArray(value)) {
        // legacy tuple form: [name, parents, children, components]
        nodes.push({
          name: normalizeTagName(key),
          aliases: [],
          parents: value[1] || [],
          children: value[2] || [],
          components: value[3] || [],
        });
        continue;
      }
      nodes.push({
        name: normalizeTagName((value && value.name) || key),
        aliases: toArray(value && value.aliases).flatMap((alias) => splitTagValue(alias)).map(normalizeTagName).filter(Boolean),
        parents: toArray(value && value.parents),
        children: toArray(value && value.children),
        components: toArray(value && value.components),
      });
    }
    return nodes.filter((node) => node.name);
  }

  /**
   * Tags + paths -> normalized `#Tag` names and chains. Every chain keeps at
   * least one node: a standalone tag is a legitimate length-1 tagPath.
   */
  normalizeTagInput(rawTags, rawTagPaths) {
    const tags = new Set();
    const paths = new Map();
    const addChain = (chain) => {
      const clean = [];
      for (const node of chain) {
        if (!node) continue;
        if (clean.length && clean[clean.length - 1] === node) continue;
        clean.push(node);
      }
      if (!clean.length) return;
      for (const node of clean) tags.add(node);
      const key = clean.join('\u0000');
      if (!paths.has(key)) paths.set(key, clean);
    };
    for (const value of toArray(rawTagPaths)) {
      if (!Array.isArray(value)) continue;
      addChain(value.flatMap((entry) => splitLegacyPath(entry)));
    }
    for (const value of toArray(rawTags)) {
      for (const name of splitTagValue(value)) addChain(splitLegacyPath(name));
    }
    return {
      tags: sortedUnique(Array.from(tags)),
      tagPaths: Array.from(paths.values()).sort((a, b) => compareStrings(a.join('\u0000'), b.join('\u0000'))),
    };
  }

  /** Rewrite tags/tagPaths onto canonical names through the alias index. */
  canonicalizeTagInput(input, aliasIndex) {
    const canonical = (tag) => {
      const key = comparisonKey(tag);
      return aliasIndex.get(key) || tag;
    };
    const tags = new Set();
    const paths = new Map();
    for (const tag of input.tags || []) tags.add(canonical(tag));
    for (const chain of input.tagPaths || []) {
      const mapped = [];
      for (const node of chain) {
        const name = canonical(node);
        if (mapped.length && mapped[mapped.length - 1] === name) continue;
        mapped.push(name);
      }
      if (!mapped.length) continue;
      for (const node of mapped) tags.add(node);
      const key = mapped.join('\u0000');
      if (!paths.has(key)) paths.set(key, mapped);
    }
    return {
      tags: sortedUnique(Array.from(tags)),
      tagPaths: Array.from(paths.values()).sort((a, b) => compareStrings(a.join('\u0000'), b.join('\u0000'))),
    };
  }

  /** Detect a cycle/self edge introduced by a component's tagPaths. */
  assertAcyclicPaths(componentTagPaths) {
    const edges = new Map();
    const nodes = new Set();
    for (const chain of componentTagPaths || []) {
      for (const node of chain) nodes.add(node);
      for (let index = 1; index < chain.length; index += 1) {
        const parent = chain[index - 1];
        const child = chain[index];
        if (parent === child) {
          throw new MemoryLabStoreError('TAG_CYCLE', `Tag path repeats its own node: ${parent}`, { tagPath: chain });
        }
        if (!edges.has(parent)) edges.set(parent, new Set());
        edges.get(parent).add(child);
      }
    }
    const state = new Map();
    const visit = (node) => {
      const current = state.get(node);
      if (current === 'visiting') return true;
      if (current === 'done') return false;
      state.set(node, 'visiting');
      for (const child of edges.get(node) || []) if (visit(child)) return true;
      state.set(node, 'done');
      return false;
    };
    for (const node of nodes) {
      if (visit(node)) {
        throw new MemoryLabStoreError('TAG_CYCLE', `Tag paths contain a cycle through ${node}`, { tagPath: node });
      }
    }
  }

  /**
   * The single normalizer: rebuilds the tag dictionary from every component's
   * `tags` and `tagPaths`, folds observed synonyms to one language-preferred
   * canonical tag (alternatives kept as aliases), rewrites component
   * tags/tagPaths, drops tags nobody references and recomputes
   * `relationshipVersion`.
   *
   * Every tag that appears in a component's `tags` gets that component in the tag
   * node's `components` list — interior path nodes included, exactly like the real
   * store (where `#研究` is both an interior node of `["#研究","#论文"]` and a
   * member of `wu-yueliang-latest-hep-papers-2026-07`).
   *
   * Existing key order is preserved so that reindexing the real store reorders
   * nothing; new tags and components are appended in code-unit order.
   *
   * `options.aliasHints` adds the fold links an applied `merge` decided on;
   * `options.aliasDrops` removes the links an applied `unfold` decided against.
   * Both are per-call: nothing about them is stored outside the index they write.
   */
  normalizeIndex(rawIndex, options = {}) {
    const warnings = [];
    const raw = rawIndex && typeof rawIndex === 'object' && !Array.isArray(rawIndex) ? rawIndex : {};
    if (rawIndex !== undefined && rawIndex !== null && (typeof rawIndex !== 'object' || Array.isArray(rawIndex))) {
      throw new MemoryLabStoreError('INDEX_MALFORMED', 'Memory Lab index.json must be a JSON object.', {});
    }
    const componentsField = raw.components;
    if (componentsField !== undefined && componentsField !== null && typeof componentsField !== 'object') {
      throw new MemoryLabStoreError('INDEX_MALFORMED', 'Memory Lab index.json has a non-object "components" field.', {});
    }

    const { aliasIndex, canonicalByGroup } = this.tagAliasGroups(raw, {
      aliasDrops: options && Array.isArray(options.aliasDrops) ? options.aliasDrops : [],
    });
    // Fold hints carried by the update that produced this index (see prepareUpdate).
    for (const hint of options && Array.isArray(options.aliasHints) ? options.aliasHints : []) {
      if (!hint || typeof hint !== 'object' || !hint.canonical) continue;
      const names = sortedUnique([...toArray(hint.names), String(hint.canonical)]);
      for (const name of names) aliasIndex.set(comparisonKey(name), String(hint.canonical));
      canonicalByGroup.set(
        String(hint.canonical),
        sortedUnique([...(canonicalByGroup.get(String(hint.canonical)) || []), ...names.filter((name) => name !== String(hint.canonical))]),
      );
    }
    const tagOrder = [];
    for (const name of Object.keys(raw.tags && typeof raw.tags === 'object' && !Array.isArray(raw.tags) ? raw.tags : {})) {
      const normalized = normalizeTagName(name);
      if (normalized && !tagOrder.includes(normalized)) tagOrder.push(normalized);
    }

    const bySlug = new Map();
    const componentOrder = [];
    for (const rawEntry of this.rawComponentEntries(raw)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const rawSlug = typeof rawEntry.slug === 'string' && rawEntry.slug.trim() ? rawEntry.slug.trim() : '';
      const name = String(rawEntry.name === undefined || rawEntry.name === null ? rawSlug : rawEntry.name).trim();
      const slug = safeSlug(rawSlug || name);
      if (!slug) {
        warnings.push('skipped-component-without-usable-slug');
        continue;
      }
      const kind = rawEntry.kind === 'folder' ? 'folder' : 'file';
      const canonicalPaths = this.canonicalComponentPaths(slug, kind);
      const containerPath = this.preservedComponentPath(rawEntry.path, canonicalPaths.container);
      const coreCandidate =
        typeof rawEntry.coreMd === 'string' && rawEntry.coreMd.trim()
          ? rawEntry.coreMd
          : kind === 'file'
            ? rawEntry.path
            : canonicalPaths.core;
      const corePath = this.preservedComponentPath(coreCandidate, canonicalPaths.core);
      const tagInput = this.normalizeTagInput(toArray(rawEntry.tags), toArray(rawEntry.tagPaths));
      const canonicalTags = this.canonicalizeTagInput(tagInput, aliasIndex);
      const entry = {
        slug,
        name: name || slug,
        description: String(rawEntry.description === undefined || rawEntry.description === null ? '' : rawEntry.description).trim(),
        tags: canonicalTags.tags,
        tagPaths: canonicalTags.tagPaths,
        kind,
        path: containerPath,
        coreMd: corePath,
        revision: Math.max(1, Math.floor(Number(rawEntry.revision) || 1)),
        updatedAt: isoOr(rawEntry.updatedAt, isoNow()),
        createdAt: isoOr(rawEntry.createdAt, isoOr(rawEntry.updatedAt, isoNow())),
        contentHash: typeof rawEntry.contentHash === 'string' && /^[0-9a-f]{64}$/i.test(rawEntry.contentHash) ? rawEntry.contentHash.toLowerCase() : '',
        bytes: Number.isFinite(Number(rawEntry.bytes)) && Number(rawEntry.bytes) >= 0 ? Math.floor(Number(rawEntry.bytes)) : 0,
      };
      const previous = bySlug.get(slug);
      if (!previous) {
        bySlug.set(slug, entry);
        componentOrder.push(slug);
        continue;
      }
      warnings.push(`duplicate-component-slug:${slug}`);
      const newer =
        entry.revision > previous.revision ||
        (entry.revision === previous.revision && compareStrings(entry.updatedAt, previous.updatedAt) > 0);
      if (newer) bySlug.set(slug, entry);
    }

    const components = orderByOriginal(Array.from(bySlug.values()), componentOrder);
    const tags = {};
    const ensureTag = (name) => {
      if (!tags[name]) tags[name] = { name, aliases: [], parents: [], children: [], components: [] };
      return tags[name];
    };
    for (const component of components) {
      // Rule: every tag of the component is a member of that tag node — interior
      // path nodes are not excluded.
      for (const tag of component.tags) ensureTag(tag).components.push(component.slug);
      for (const chain of component.tagPaths) {
        for (const node of chain) ensureTag(node);
        for (let index = 1; index < chain.length; index += 1) {
          const parent = chain[index - 1];
          const child = chain[index];
          if (parent === child) continue;
          if (this.tagPathExists(tags, child, parent)) {
            warnings.push(`cyclic-tag-edge-skipped:${parent}->${child}`);
            continue;
          }
          ensureTag(parent).children.push(child);
          ensureTag(child).parents.push(parent);
        }
      }
    }

    const names = orderByOriginal(
      Object.keys(tags).map((name) => ({ slug: name })),
      tagOrder,
    ).map((entry) => entry.slug);
    const sortedTags = {};
    for (const name of names) {
      const node = tags[name];
      sortedTags[name] = {
        name,
        aliases: sortedUnique(canonicalByGroup.get(name) || []).filter((alias) => alias !== name),
        parents: sortedUnique(node.parents),
        children: sortedUnique(node.children),
        components: sortedUnique(node.components),
      };
    }

    const index = {
      version: INDEX_VERSION,
      updatedAt: isoOr(raw.updatedAt, isoNow()),
      relationshipVersion: '',
      preferredLanguage: this.preferredLanguageOf(raw),
      tags: sortedTags,
      components,
    };

    if (options.refreshContent) {
      for (const component of components) {
        const file = this.resolveComponentFile(component);
        const content = readTextOrNull(file);
        if (content === null) {
          warnings.push(`missing-core:${component.slug}`);
          continue;
        }
        component.contentHash = sha256Hex(content);
        component.bytes = byteLength(content);
      }
    }

    index.relationshipVersion = this.relationshipVersion(index);
    return { index, warnings: sortedUnique(warnings) };
  }

  rawComponentEntries(rawIndex) {
    const field = rawIndex && typeof rawIndex === 'object' ? rawIndex.components : undefined;
    return componentList(field);
  }

  tagPathExists(tags, from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const node = tags[from];
    if (!node) return false;
    return node.children.some((child) => this.tagPathExists(tags, child, target, seen));
  }

  // -- selectors ------------------------------------------------------------

  /**
   * Resolve `''`/slug/name/component-path to a slug; structured error otherwise.
   * `index` may be omitted, in which case the index is loaded from disk.
   */
  resolveSlug(selector, index) {
    const cleaned = String(selector === undefined || selector === null ? '' : selector).trim();
    if (!cleaned) return { slug: null, error: null };
    if (hasEscapeSegment(cleaned)) return { slug: null, error: pathEscapeError(cleaned, this.root).toJSON() };
    if (/[\\/]/.test(cleaned) || path.isAbsolute(cleaned)) {
      // A path-like selector must resolve inside the root or be rejected outright.
      if (!isInside(this.root, path.resolve(this.root, cleaned))) {
        return { slug: null, error: pathEscapeError(cleaned, this.root).toJSON() };
      }
    }
    const source = index && typeof index === 'object' && Array.isArray(index.components) ? index : this.loadIndex().index;
    const components = (source && source.components) || [];
    if (components.some((component) => component.slug === cleaned)) return { slug: cleaned, error: null };
    const slugged = safeSlug(cleaned);
    if (components.some((component) => component.slug === slugged)) return { slug: slugged, error: null };
    const lower = cleaned.toLowerCase();
    const byName = components.find((component) => String(component.name || '').toLowerCase() === lower);
    if (byName) return { slug: byName.slug, error: null };

    const candidates = new Set();
    for (const base of [this.root, this.componentsDir]) {
      const resolved = path.resolve(base, cleaned);
      if (isInside(this.root, resolved)) candidates.add(path.resolve(resolved));
    }
    for (const component of components) {
      let file = '';
      try {
        file = this.resolveComponentFile(component);
      } catch {
        continue;
      }
      if (candidates.has(path.resolve(file))) return { slug: component.slug, error: null };
      if (component.kind === 'folder' && candidates.has(path.dirname(path.resolve(file)))) return { slug: component.slug, error: null };
    }
    return { slug: null, error: notFoundError(cleaned).toJSON() };
  }

  findComponent(index, slug) {
    return componentList(index && index.components).find((component) => component.slug === slug) || null;
  }

  canonicalTag(name) {
    const { aliasIndex } = this.tagAliasGroups(this.loadIndex().index || {});
    const cleaned = normalizeTagName(name);
    return aliasIndex.get(comparisonKey(cleaned)) || cleaned;
  }

  // -- read -----------------------------------------------------------------

  /**
   * The read view of an index: the exact on-disk document — `components` as a
   * plain object keyed by slug, the real field names and order.
   *
   * The mutation paths iterate `components` as an array; a read must hand the
   * caller what `index.json` actually holds, so `Object.keys(read.index.components)`
   * are the component slugs and there is no shape in which an indexed component
   * can go missing between the disk and the caller.
   */
  persistedIndex(index) {
    return index && typeof index === 'object' ? this.indexDocument(index) : index;
  }

  /** Index inspection plus, for a selector, that component's core markdown. */
  read(selector = '') {
    const loaded = this.loadIndex();
    const base = {
      ok: true,
      root: this.root,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      archiveDir: this.archiveDir,
      policyPath: this.policyPath,
      instructions: this.instructions(),
      status: loaded.status,
      warnings: loaded.warnings,
      index: this.persistedIndex(loaded.index),
    };
    if (!loaded.ok) {
      return { ...base, ok: false, index: null, error: loaded.error };
    }
    const cleaned = String(selector === undefined || selector === null ? '' : selector).trim();
    if (!cleaned) return base;
    const resolved = this.resolveSlug(cleaned, loaded.index);
    if (resolved.error) return { ...base, ok: false, error: resolved.error };
    const component = this.findComponent(loaded.index, resolved.slug);
    if (!component) return { ...base, ok: false, error: notFoundError(cleaned).toJSON() };
    let file = '';
    try {
      file = this.resolveComponentFile(component);
    } catch (error) {
      return { ...base, ok: false, error: error.toJSON ? error.toJSON() : { code: 'PATH_ESCAPE', message: String(error) } };
    }
    const content = readTextOrNull(file);
    if (content === null) {
      return {
        ...base,
        ok: false,
        component,
        componentFile: file,
        error: new MemoryLabStoreError('COMPONENT_UNREADABLE', `Memory component file is missing or unreadable: ${component.coreMd || component.path}`, {
          slug: component.slug,
          path: component.path,
          coreMd: component.coreMd,
        }).toJSON(),
      };
    }
    return { ...base, component, componentFile: file, content };
  }

  /**
   * ONE object for the UI: the index plus every component core markdown. This is
   * the one-shot read the panel calls; it must not run on every interaction.
   */
  visualizationSnapshot() {
    const loaded = this.loadIndex();
    if (!loaded.ok) {
      return { ok: false, relationshipVersion: '', loadedAt: isoNow(), index: null, contents: {}, error: loaded.error };
    }
    const contents = {};
    for (const component of componentList(loaded.index.components)) {
      let content = '';
      try {
        content = readTextOrNull(this.resolveComponentFile(component));
      } catch {
        content = null;
      }
      contents[component.slug] = content === null ? '' : content;
    }
    return {
      ok: true,
      relationshipVersion: loaded.index.relationshipVersion,
      loadedAt: isoNow(),
      index: this.persistedIndex(loaded.index),
      contents,
    };
  }

  // -- query ----------------------------------------------------------------

  /**
   * Bounded retrieval. Deterministic score over name / tags / description /
   * content; at most `MAX_COMPONENT_SCAN_CHARS` of one component is scanned;
   * `maxChars` clamps to [1000, 48000]; `limit` clamps to [1, 12]; matches weaker
   * than `WEAK_MATCH_FLOOR` of the best score are dropped.
   */
  query(input = {}) {
    const text = String((input && input.query) === undefined || (input && input.query) === null ? '' : input.query).trim();
    if (!text) throw new MemoryLabStoreError('INVALID_QUERY', 'A Memory Lab query string is required.');
    const limit = clampInt(input && input.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
    const maxChars = clampInt(input && input.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);

    const loaded = this.loadIndex();
    if (!loaded.ok) throw new MemoryLabStoreError(loaded.error.code, loaded.error.message, loaded.error.details);
    const index = loaded.index;

    const normalizedQuery = text.toLowerCase();
    const terms = tokenizeQuery(text);
    const candidates = [];
    const seen = new Set();
    let scanned = 0;
    let scanCapped = false;
    const missingCore = [];

    for (const component of componentList(index.components)) {
      if (seen.has(component.slug)) continue;
      seen.add(component.slug);
      let raw = '';
      try {
        const content = readTextOrNull(this.resolveComponentFile(component));
        if (content === null) missingCore.push(component.slug);
        else raw = content;
      } catch {
        missingCore.push(component.slug);
      }
      const content = raw.slice(0, MAX_COMPONENT_SCAN_CHARS);
      scanned += content.length;
      if (raw.length > MAX_COMPONENT_SCAN_CHARS) scanCapped = true;
      const fields = {
        name: String(component.name || '').toLowerCase(),
        tags: [...sortedUnique(component.tags), ...(component.tagPaths || []).flat()].join(' ').toLowerCase(),
        description: String(component.description || '').toLowerCase(),
        content: content.toLowerCase(),
      };
      const { score, matched } = scoreComponent(fields, normalizedQuery, terms);
      if (score <= 0) continue;
      candidates.push({
        slug: component.slug,
        name: component.name,
        description: component.description,
        tags: sortedUnique(component.tags),
        score,
        matched,
        excerpt: buildExcerpt(content, terms),
        updatedAt: component.updatedAt,
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score || compareStrings(String(b.updatedAt || ''), String(a.updatedAt || '')) || compareStrings(a.slug, b.slug),
    );

    const best = candidates.length ? candidates[0].score : 0;
    const matches = [];
    const droppedByFloor = [];
    let usedChars = 0;
    let stopReason = null;

    for (let position = 0; position < candidates.length; position += 1) {
      const candidate = candidates[position];
      if (matches.length >= limit) {
        stopReason = stopReason || 'limit';
        break;
      }
      if (matches.length > 0 && candidate.score < best * WEAK_MATCH_FLOOR) {
        stopReason = stopReason || 'floor';
        for (let rest = position; rest < candidates.length; rest += 1) droppedByFloor.push(candidates[rest].slug);
        break;
      }
      const remaining = maxChars - usedChars;
      if (remaining < MIN_EXCERPT_BUDGET) {
        stopReason = stopReason || 'chars';
        break;
      }
      const excerpt = candidate.excerpt.slice(0, remaining);
      usedChars += excerpt.length;
      matches.push({ ...candidate, excerpt });
    }

    const stoppedEarly = stopReason !== null;
    const truncated = stoppedEarly || scanCapped;
    return {
      matches: matches.map((match) => ({
        slug: match.slug,
        name: match.name,
        description: match.description,
        tags: match.tags,
        score: match.score,
        matched: match.matched,
        excerpt: match.excerpt,
      })),
      scanned,
      truncated,
      budget: {
        query: text,
        terms,
        limit,
        maxChars,
        usedChars,
        remainingChars: Math.max(0, maxChars - usedChars),
        componentsConsidered: componentList(index.components).length,
        candidates: candidates.length,
        maxComponentScan: MAX_COMPONENT_SCAN_CHARS,
        scanCapped,
        stoppedEarly,
        stopReason,
        floor: WEAK_MATCH_FLOOR,
        droppedByFloor: sortedUnique(droppedByFloor),
        missingCore: sortedUnique(missingCore),
      },
    };
  }

  // -- prepare + write ------------------------------------------------------

  /**
   * Validate and normalize an update. Throws on invalid input. The returned plan
   * is branded and frozen; pass it to `update()`.
   */
  prepareUpdate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new MemoryLabStoreError('INVALID_INPUT', 'prepareUpdate expects a plain object.');
    }
    const loaded = this.loadIndex();
    if (!loaded.ok) throw new MemoryLabStoreError(loaded.error.code, loaded.error.message, loaded.error.details);
    const index = loaded.index;
    const warnings = [];

    // Newmark's selector is `component` (memoryLab.ts:303); `slug` is accepted too,
    // because this port's own callers and store tests use it.
    const selector = String(input.component ?? input.slug ?? '').trim();
    let existing = null;
    if (selector) {
      const resolved = this.resolveSlug(selector, index);
      if (resolved.error && resolved.error.code === 'PATH_ESCAPE') {
        throw new MemoryLabStoreError('PATH_ESCAPE', resolved.error.message, resolved.error.details);
      }
      if (resolved.slug) existing = this.findComponent(index, resolved.slug);
      else if (!(typeof input.name === 'string' && input.name.trim())) {
        throw new MemoryLabStoreError('NOT_FOUND', `Memory component not found: ${selector}`, { selector });
      } else warnings.push('slug-does-not-resolve-yet');
    }

    const rawName = input.name === undefined || input.name === null ? (existing ? existing.name : '') : String(input.name).trim();
    if (!rawName) throw new MemoryLabStoreError('INVALID_INPUT', 'Memory component name is required.');
    const slug = existing ? existing.slug : safeSlug(selector || rawName);
    if (existing && input.name !== undefined && safeSlug(rawName) !== existing.slug) {
      throw new MemoryLabStoreError(
        'RENAME_UNSUPPORTED',
        'Renaming a Memory Lab component is not supported by an update; create the new component then delete the old one.',
        { slug: existing.slug, requested: rawName },
      );
    }

    let kind = existing ? existing.kind : 'file';
    if (input.kind !== undefined && input.kind !== null) {
      if (input.kind !== 'file' && input.kind !== 'folder') {
        throw new MemoryLabStoreError('INVALID_KIND', 'Memory component kind must be "file" or "folder".', { kind: input.kind });
      }
      kind = input.kind;
    }

    const { aliasIndex } = this.tagAliasGroups(index);
    const fold = this.inputTagFold(index);
    const foldedAliasIndex = new Map(fold.aliasIndex);
    for (const [key, value] of aliasIndex) foldedAliasIndex.set(key, value);
    const aliasHints = [];
    let tags;
    let tagPaths;
    if (input.tags === undefined && input.tagPaths === undefined) {
      tags = existing ? existing.tags.slice() : [];
      tagPaths = existing ? existing.tagPaths.map((chain) => chain.slice()) : [];
    } else {
      if (input.tags !== undefined && !Array.isArray(input.tags)) {
        throw new MemoryLabStoreError('INVALID_INPUT', 'tags must be an array of tag names.');
      }
      if (input.tagPaths !== undefined && !Array.isArray(input.tagPaths)) {
        throw new MemoryLabStoreError('INVALID_INPUT', 'tagPaths must be an array of tag chains.');
      }
      const normalized = this.normalizeTagInput(input.tags || [], input.tagPaths || []);
      const canonical = this.canonicalizeTagInput(normalized, foldedAliasIndex);
      tags = canonical.tags;
      tagPaths = canonical.tagPaths;
      // Persist the synonym spellings of every group this input folded, so the
      // aliases survive later rebuilds (bilingual folding with aliases preserved).
      const seen = new Set();
      for (const spelling of normalized.tags) {
        const target = foldedAliasIndex.get(comparisonKey(spelling));
        if (!target || target === spelling || seen.has(target)) continue;
        seen.add(target);
        const hint = fold.hints.get(synonymKey(spelling));
        aliasHints.push(
          Object.freeze({
            key: hint ? hint.key : synonymKey(spelling),
            canonical: target,
            names: Object.freeze(sortedUnique([...(hint ? hint.names : []), spelling, target])),
          }),
        );
      }
    }
    this.assertAcyclicPaths(tagPaths);

    const hasContent = typeof input.content === 'string';
    const hasAppend = typeof input.contentAppend === 'string';
    const hasPatch = input.oldText !== undefined && input.oldText !== null;
    const provided = [hasContent, hasAppend, hasPatch].filter(Boolean).length;
    if (provided > 1) {
      throw new MemoryLabStoreError('INVALID_INPUT', 'Use only one of content, contentAppend, or oldText/newText per update.');
    }
    if (input.content !== undefined && !hasContent) {
      throw new MemoryLabStoreError('INVALID_INPUT', 'content must be a string.');
    }
    if (input.contentAppend !== undefined && !hasAppend) {
      throw new MemoryLabStoreError('INVALID_INPUT', 'contentAppend must be a string.');
    }
    if (input.replaceAll !== undefined && typeof input.replaceAll !== 'boolean') {
      throw new MemoryLabStoreError('INVALID_INPUT', 'replaceAll must be a boolean.');
    }

    const previousContent = existing ? this.readComponentContent(existing) : '';
    let content = previousContent;
    let mode = 'metadata';
    if (hasContent) {
      content = input.content;
      mode = 'replace';
    } else if (hasAppend) {
      content = `${previousContent}${input.contentAppend}`;
      mode = existing ? 'append' : 'replace';
    } else if (hasPatch) {
      const oldText = String(input.oldText);
      if (!oldText) throw new MemoryLabStoreError('INVALID_INPUT', 'oldText must not be empty.');
      if (typeof input.newText !== 'string') {
        throw new MemoryLabStoreError('INVALID_INPUT', 'newText must be a string when oldText is used.');
      }
      const occurrences = previousContent.split(oldText).length - 1;
      if (!occurrences) {
        throw new MemoryLabStoreError('OLD_TEXT_NOT_FOUND', 'oldText was not found in the Memory Lab component.', { slug });
      }
      if (occurrences > 1 && input.replaceAll !== true) {
        throw new MemoryLabStoreError(
          'OLD_TEXT_AMBIGUOUS',
          `oldText matched ${occurrences} places; pass replaceAll=true or a unique fragment.`,
          { slug, occurrences },
        );
      }
      content =
        input.replaceAll === true
          ? previousContent.split(oldText).join(input.newText)
          : previousContent.replace(oldText, input.newText);
      mode = 'patch';
    } else if (!existing) {
      throw new MemoryLabStoreError('CONTENT_REQUIRED', 'content is required when creating a Memory Lab component.');
    } else if (!content.trim()) {
      warnings.push('component-has-empty-content');
    }

    if (!existing && !content.trim()) {
      throw new MemoryLabStoreError('CONTENT_REQUIRED', 'content is required when creating a Memory Lab component.');
    }

    // Stored absolute paths survive an update; a kind change re-anchors them.
    const canonicalPaths = this.canonicalComponentPaths(slug, kind);
    const keepStored = existing && existing.kind === kind;
    const containerPath = keepStored ? this.preservedComponentPath(existing.path, canonicalPaths.container) : canonicalPaths.container;
    const corePath = keepStored
      ? this.preservedComponentPath(existing.coreMd || existing.path, canonicalPaths.core)
      : canonicalPaths.core;
    this.resolveInsideRoot(containerPath);
    this.resolveInsideRoot(corePath);

    const plan = Object.freeze({
      brand: PLAN_BRAND,
      operation: existing ? 'UPDATE' : 'ADD',
      slug,
      name: rawName,
      description: input.description === undefined || input.description === null
        ? (existing ? existing.description : '')
        : String(input.description).trim(),
      tags: Object.freeze(tags.slice()),
      tagPaths: Object.freeze(tagPaths.map((chain) => Object.freeze(chain.slice()))),
      aliasHints: Object.freeze(aliasHints.slice()),
      kind,
      content,
      mode,
      path: containerPath,
      coreMd: corePath,
      baseRevision: existing ? existing.revision : 0,
      expectedUpdatedAt:
        input.expectedUpdatedAt === undefined || input.expectedUpdatedAt === null
          ? (existing ? existing.updatedAt : '')
          : String(input.expectedUpdatedAt).trim(),
      reason: input.reason === undefined || input.reason === null ? '' : String(input.reason).trim(),
      source: input.source === undefined || input.source === null ? '' : String(input.source).trim(),
      contentHash: sha256Hex(content),
      bytes: byteLength(content),
      previousContentHash: existing ? existing.contentHash : '',
      warnings: Object.freeze(warnings.slice()),
    });
    return plan;
  }

  /** Apply a plan: atomic write, archive-before-replace, stale guard, audit line. */
  update(plan) {
    const prepared = this.ensurePlan(plan);
    const index = this.openForWrite();
    const existing = this.findComponent(index, prepared.slug);
    const action = existing ? 'UPDATE' : 'ADD';

    if (existing && prepared.expectedUpdatedAt && prepared.expectedUpdatedAt !== existing.updatedAt) {
      throw new MemoryLabStoreError(
        'STALE_WRITE',
        `Memory component changed since it was read: ${prepared.slug}`,
        { slug: prepared.slug, expectedUpdatedAt: prepared.expectedUpdatedAt, storedUpdatedAt: existing.updatedAt, action },
      );
    }

    const containerPath = prepared.path || this.canonicalComponentPaths(prepared.slug, prepared.kind).container;
    const file = this.resolveInsideRoot(prepared.coreMd || this.canonicalComponentPaths(prepared.slug, prepared.kind).core);
    this.resolveInsideRoot(containerPath);
    const now = isoNow();
    const warnings = prepared.warnings.slice();
    let archivePath = null;
    let previousContainer = null;

    if (existing) {
      const previousFile = this.resolveComponentFile(existing);
      const previousContent = readTextOrNull(previousFile);
      if (previousContent === null) {
        warnings.push(`missing-core:${existing.slug}`);
      } else {
        archivePath = this.archiveRevision(existing.slug, existing.revision, previousContent);
      }
      if (existing.kind !== prepared.kind) {
        previousContainer = existing.kind === 'folder' ? path.dirname(previousFile) : previousFile;
      }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, prepared.content);

    if (previousContainer && isInside(this.componentsDir, previousContainer) && fs.existsSync(previousContainer)) {
      fs.rmSync(previousContainer, { recursive: true, force: true });
    }

    const entry = {
      slug: prepared.slug,
      name: prepared.name,
      description: prepared.description,
      tags: prepared.tags.slice(),
      tagPaths: prepared.tagPaths.map((chain) => chain.slice()),
      kind: prepared.kind,
      path: containerPath,
      coreMd: file,
      revision: existing ? existing.revision + 1 : 1,
      updatedAt: now,
      createdAt: existing ? existing.createdAt : now,
      contentHash: sha256Hex(prepared.content),
      bytes: byteLength(prepared.content),
    };
    index.components = componentList(index.components).filter((component) => component.slug !== prepared.slug);
    index.components.push(entry);

    const { index: normalized, warnings: normalizeWarnings } = this.normalizeIndex(index, { aliasHints: prepared.aliasHints });
    this.writeIndex(normalized);
    warnings.push(...normalizeWarnings);

    const saved = this.findComponent(normalized, prepared.slug);
    const policy = this.appendPolicy({
      action,
      slug: prepared.slug,
      reason: prepared.reason || (existing ? 'Replace an existing durable memory revision.' : 'Create a durable memory component.'),
      source: prepared.source || 'memory_lab_update',
      revision: saved.revision,
      previousRevision: existing ? existing.revision : 0,
      updatedAt: saved.updatedAt,
      previousUpdatedAt: existing ? existing.updatedAt : '',
      contentHash: saved.contentHash,
      bytes: saved.bytes,
      previousContentHash: existing ? existing.contentHash : '',
      archivePath,
      relationshipVersion: normalized.relationshipVersion,
    });

    return {
      ok: true,
      action,
      slug: prepared.slug,
      revision: saved.revision,
      updatedAt: saved.updatedAt,
      archived: archivePath,
      component: saved,
      policyEventId: policy.id,
      warnings: sortedUnique(warnings),
      receipt: {
        operation: action === 'ADD' ? 'add' : 'update',
        completed: true,
        slug: prepared.slug,
        revision: saved.revision,
        indexPath: this.indexPath,
        componentFile: file,
        indexUpdatedAt: normalized.updatedAt,
        verifiedAt: isoNow(),
        relationshipVersion: normalized.relationshipVersion,
        contentHash: saved.contentHash,
        bytes: saved.bytes,
        archivePath,
        policyEventId: policy.id,
        warnings: sortedUnique(warnings),
      },
    };
  }

  /** Accept a branded plan, or normalize a raw input object for convenience. */
  ensurePlan(plan) {
    if (plan && typeof plan === 'object' && plan.brand === PLAN_BRAND && typeof plan.slug === 'string' && typeof plan.content === 'string') {
      return plan;
    }
    if (plan && typeof plan === 'object' && plan.brand === PLAN_BRAND) {
      throw new MemoryLabStoreError('INVALID_PLAN', 'The Memory Lab plan is incomplete.');
    }
    if (plan && typeof plan === 'object' && !Array.isArray(plan)) return this.prepareUpdate(plan);
    throw new MemoryLabStoreError('INVALID_PLAN', 'update() expects a plan from prepareUpdate().');
  }

  /** Delete one component: stale guard, archive final revision, rebuild. */
  delete(selector, options = {}) {
    const index = this.openForWrite();
    const resolved = this.resolveSlug(selector, index);
    if (resolved.error) throw new MemoryLabStoreError(resolved.error.code, resolved.error.message, resolved.error.details);
    if (!resolved.slug) throw notFoundError(selector);
    const existing = this.findComponent(index, resolved.slug);
    if (!existing) throw notFoundError(selector);

    const expected = options && options.expectedUpdatedAt ? String(options.expectedUpdatedAt).trim() : '';
    if (expected && expected !== existing.updatedAt) {
      throw new MemoryLabStoreError('STALE_WRITE', `Memory component changed since it was read: ${existing.slug}`, {
        slug: existing.slug,
        expectedUpdatedAt: expected,
        storedUpdatedAt: existing.updatedAt,
        action: 'DELETE',
      });
    }

    const file = this.resolveComponentFile(existing);
    const previousContent = readTextOrNull(file);
    const warnings = [];
    let archivePath = null;
    if (previousContent === null) warnings.push(`missing-core:${existing.slug}`);
    else archivePath = this.archiveRevision(existing.slug, existing.revision, previousContent);

    const container = existing.kind === 'folder' ? this.resolveComponentContainer(existing) : file;
    if (container && isInside(this.componentsDir, container) && fs.existsSync(container)) {
      fs.rmSync(container, { recursive: true, force: true });
    }

    index.components = componentList(index.components).filter((component) => component.slug !== existing.slug);
    const { index: normalized, warnings: normalizeWarnings } = this.normalizeIndex(index);
    this.writeIndex(normalized);
    warnings.push(...normalizeWarnings);

    const policy = this.appendPolicy({
      action: 'DELETE',
      slug: existing.slug,
      reason: (options && options.reason ? String(options.reason).trim() : '') || 'Remove obsolete durable memory.',
      source: (options && options.source ? String(options.source).trim() : '') || 'memory_lab_delete',
      revision: existing.revision,
      previousRevision: existing.revision,
      updatedAt: existing.updatedAt,
      previousUpdatedAt: existing.updatedAt,
      contentHash: existing.contentHash,
      bytes: existing.bytes,
      archivePath,
      relationshipVersion: normalized.relationshipVersion,
    });

    return {
      ok: true,
      action: 'DELETE',
      slug: existing.slug,
      archived: archivePath,
      policyEventId: policy.id,
      warnings: sortedUnique(warnings),
      receipt: {
        operation: 'delete',
        completed: true,
        slug: existing.slug,
        revision: existing.revision,
        indexPath: this.indexPath,
        componentFile: file,
        indexUpdatedAt: normalized.updatedAt,
        verifiedAt: isoNow(),
        relationshipVersion: normalized.relationshipVersion,
        contentHash: existing.contentHash,
        archivePath,
        policyEventId: policy.id,
        warnings: sortedUnique(warnings),
      },
    };
  }

  /**
   * The single normalizer entry point; graph-idempotent, and a no-op for a store
   * that already matches the real v2 contract (no tag is renamed, no tagPath is
   * dropped, `preferredLanguage` and every component timestamp survive).
   */
  reindex() {
    const current = this.openForWrite();
    const { index, warnings } = this.normalizeIndex(cloneJson(current), { refreshContent: true });
    this.writeIndex(index);
    const sorted = sortedUnique(warnings);
    return {
      ok: true,
      relationshipVersion: index.relationshipVersion,
      components: index.components.length,
      tags: Object.keys(index.tags).length,
      warnings: sorted,
      receipt: {
        operation: 'reindex',
        completed: true,
        indexPath: this.indexPath,
        indexUpdatedAt: index.updatedAt,
        verifiedAt: isoNow(),
        relationshipVersion: index.relationshipVersion,
        components: index.components.length,
        tags: Object.keys(index.tags).length,
        warnings: sorted,
      },
    };
  }

  // -- tag graph judgement --------------------------------------------------
  //
  // `reindex()` is a rule: it folds the spellings the built-in table names, keeps
  // every tagPath it was handed, and drops tags no component references. Three
  // things a tag graph needs are NOT rules and never can be:
  //
  //   * 假根父节点接续 — a root tag whose components are already filed under some
  //     other tag. Nothing in the data says whether that is wrong; only a reader of
  //     the memories can say.
  //   * 同义近义 tag 合并 — near-synonyms outside the built-in table (`#Harness`
  //     and `#Harness工程` are one idea to a reader and two tags to the fold table,
  //     which folds only the spellings it lists and only when two are observed).
  //   * 未被正确解析的 tag — a name the input parser collapsed into one tag
  //     (`AI Agent 协作` -> `#AI-Agent-协作`), or a `/` it split into a path that
  //     was really one tag (`CI/CD` -> `#CI` -> `#CD`). `splitLegacyPath()` has to
  //     decide at write time and cannot know which of the two it is looking at.
  //
  // So the judgement is the CALLER's, and the store's job is to put the facts in
  // front of it (`tagReview()`, read-only) and to record and reverse what it
  // decides (`applyTagDecisions()`). Nothing here rewrites a tag as a side effect
  // of a read, and nothing here invents a decision.

  /**
   * The tag graph as a review reads it: names in index order, each node with the
   * components that really carry it, and each component with its tagPaths.
   */
  tagGraphView(index) {
    const tags = index && index.tags && typeof index.tags === 'object' && !Array.isArray(index.tags) ? index.tags : {};
    const names = Object.keys(tags);
    const components = componentList(index && index.components);
    const bySlug = new Map(components.map((component) => [String(component.slug), component]));
    const membersOf = (name) => {
      const node = tags[name] || {};
      return sortedUnique(toArray(node.components)).filter((slug) => bySlug.has(slug));
    };
    return { tags, names, components, bySlug, membersOf };
  }

  /** Every tag name any component references, in tags or in a tagPath node. */
  referencedTagNames(index) {
    const referenced = new Set();
    for (const component of componentList(index && index.components)) {
      for (const name of this.normalizeTagInput(toArray(component.tags), toArray(component.tagPaths)).tags) referenced.add(name);
    }
    return referenced;
  }

  /** A finding: the facts, the question they raise, and the decisions that answer it. */
  tagFinding(id, kind, question, evidence, options) {
    return { id, kind, question, evidence, options };
  }

  /**
   * Why two tag names might be one tag. Facts, never a verdict.
   *
   * Only a NAME reason raises a candidate. Two tags sharing a component is normal
   * — a memory carries many tags — so on its own it raises nothing; it is reported
   * beside the candidate as the fact that decides whether the merge is worth it.
   */
  synonymReasons(a, b, membersA, membersB) {
    const reasons = [];
    const shapeA = nameShape(a);
    const shapeB = nameShape(b);
    if (shapeA && shapeA === shapeB) {
      reasons.push('the two names are identical once case and separators are removed');
    } else if (shapeA && shapeB && (shapeA.includes(shapeB) || shapeB.includes(shapeA))) {
      reasons.push('one name contains the other');
    } else {
      const distance = editDistance(shapeA, shapeB);
      // Character closeness is only evidence inside one script: a CJK name and a
      // latin one that differ by two characters are two unrelated names, and
      // treating them as near-duplicates merged whole graphs into one cluster.
      if (isCjk(a) === isCjk(b) && Math.min(shapeA.length, shapeB.length) >= 5 && distance <= 2) {
        reasons.push(`the names differ by ${distance} character(s)`);
      }
    }
    const shared = membersA.filter((slug) => membersB.includes(slug));
    if (!reasons.length && isCjk(a) !== isCjk(b)) {
      const union = sortedUnique([...membersA, ...membersB]).length;
      // Two memories have to use both tags, and together they have to account for
      // at least half of the union: one component carrying a CJK tag and a latin
      // one is the normal shape of a memory, not a duplicate spelling.
      if (shared.length >= 2 && union >= 2 && shared.length / union >= 0.5) {
        reasons.push('the components that use them are the same, in different scripts');
      }
    }
    return { reasons, shared };
  }

  /**
   * One review pass over the tag graph: the five finding kinds above, each with
   * the evidence needed to decide and the decision shapes that would apply it.
   *
   * READ-ONLY. It loads the index, folds nothing, writes nothing and creates no
   * directory: a review of a store that has never been written still writes
   * nothing (`loadIndex()` on a missing index returns the empty index in memory).
   */
  tagReview(options = {}) {
    const loaded = this.loadIndex();
    if (!loaded.ok) throw new MemoryLabStoreError(loaded.error.code, loaded.error.message, loaded.error.details);
    const index = loaded.index;
    const graph = this.tagGraphView(index);
    const unknown = sortedUnique(options && Array.isArray(options.kinds) ? options.kinds.map(String) : []).filter(
      (kind) => !TAG_FINDING_KINDS.includes(kind),
    );
    if (unknown.length) {
      throw new MemoryLabStoreError('UNKNOWN_FINDING_KIND', `Unknown tag review kind(s): ${unknown.join(', ')}`, {
        kinds: unknown,
        known: TAG_FINDING_KINDS.slice(),
      });
    }
    const wanted = options && Array.isArray(options.kinds) && options.kinds.length ? new Set(options.kinds.map(String)) : null;
    const wants = (kind) => !wanted || wanted.has(kind);
    const findings = [];
    const members = new Map(graph.names.map((name) => [name, graph.membersOf(name)]));
    const referenced = this.referencedTagNames(index);

    /* 1. false roots ------------------------------------------------------- */

    if (wants('false-root')) {
      for (const root of graph.names) {
        const node = graph.tags[root] || {};
        if (toArray(node.parents).length) continue;
        const own = members.get(root) || [];
        if (!own.length) continue; // an unreferenced node is finding 5, not this one
        const descendants = new Set();
        const walk = (name) => {
          for (const child of toArray((graph.tags[name] || {}).children)) {
            if (descendants.has(child)) continue;
            descendants.add(child);
            walk(child);
          }
        };
        walk(root);
        const support = new Map();
        const note = (parent, via) => {
          if (parent === root || descendants.has(parent)) return;
          if (!support.has(parent)) support.set(parent, new Set());
          support.get(parent).add(via);
        };
        for (const name of graph.names) {
          if (name === root) continue;
          const other = members.get(name) || [];
          const shared = other.filter((slug) => own.includes(slug));
          if (!shared.length || shared.length / own.length < 0.5) continue;
          const parents = toArray((graph.tags[name] || {}).parents);
          // A tag that is itself a root is a candidate parent too: two roots can be
          // two halves of one hierarchy (`#数学` beside `#研究`).
          for (const parent of parents.length ? parents : [name]) note(parent, name);
        }
        const candidates = Array.from(support.entries())
          .map(([tag, via]) => ({ tag, sharedComponents: own.slice(), supportingTags: sortedUnique(Array.from(via)) }))
          .sort((a, b) => b.supportingTags.length - a.supportingTags.length || compareStrings(a.tag, b.tag))
          .slice(0, 6);
        if (!candidates.length) continue;
        findings.push(
          this.tagFinding(
            `false-root:${root}`,
            'false-root',
            `Is ${root} a true root, or does it continue under one of the candidate parents?`,
            {
              tag: root,
              components: own,
              childTags: sortedUnique(toArray(node.children)),
              candidates,
              why: [
                `every component carrying ${root} also carries tags that already place them under ${candidates[0].tag}`,
                `${root} has no parent in any component tagPath, so a rebuild keeps it a root until something says otherwise`,
              ],
            },
            candidates.map((candidate) => ({ kind: 'reparent', tag: root, under: candidate.tag })),
          ),
        );
      }
    }

    /* 2. synonym candidates ------------------------------------------------ */

    if (wants('synonym-candidate')) {
      const pairs = new Map();
      for (let i = 0; i < graph.names.length; i += 1) {
        for (let j = i + 1; j < graph.names.length; j += 1) {
          const a = graph.names[i];
          const b = graph.names[j];
          const { reasons } = this.synonymReasons(a, b, members.get(a) || [], members.get(b) || []);
          if (!reasons.length) continue;
          pairs.set(`${a}\u0000${b}`, { a, b, reasons });
        }
      }
      // Group the pairs into clusters, so a stem used by six tags is one finding
      // with six members instead of fifteen pairwise ones.
      const parent = new Map(graph.names.map((name) => [name, name]));
      const find = (name) => {
        let current = name;
        while (parent.get(current) !== current) current = parent.get(current);
        return current;
      };
      for (const pair of pairs.values()) {
        const rootA = find(pair.a);
        const rootB = find(pair.b);
        if (rootA !== rootB) parent.set(rootA, rootB);
      }
      const clusters = new Map();
      for (const name of graph.names) {
        const key = find(name);
        if (!clusters.has(key)) clusters.set(key, []);
        clusters.get(key).push(name);
      }
      for (const cluster of clusters.values()) {
        if (cluster.length < 2) continue;
        const ranked = cluster
          .slice()
          .sort((a, b) => (members.get(b) || []).length - (members.get(a) || []).length || compareStrings(a, b));
        const membersOfCluster = ranked.map((tag) => ({
          tag,
          components: members.get(tag) || [],
          count: (members.get(tag) || []).length,
          aliases: sortedUnique(toArray((graph.tags[tag] || {}).aliases)),
          parents: sortedUnique(toArray((graph.tags[tag] || {}).parents)),
        }));
        const reasons = sortedUnique(
          Array.from(pairs.values())
            .filter((pair) => ranked.includes(pair.a) && ranked.includes(pair.b))
            .flatMap((pair) => pair.reasons.map((reason) => `${pair.a} / ${pair.b}: ${reason}`)),
        ).slice(0, 12);
        // What the deterministic fold would call this group if it ever saw it: the
        // language-preferred, shortest spelling. A merge into anything else lasts,
        // but a later plain rebuild moves the spelling here — the receipt says so.
        const stableInto = this.chooseCanonicalTag(ranked, new Set(ranked));
        findings.push(
          this.tagFinding(
            `synonym-candidate:${ranked.map((name) => name.replace(/^#/, '')).join('|').slice(0, 80)}`,
            'synonym-candidate',
            'Are these one tag? If so, which spelling is canonical, and is that decision worth the rewrite?',
            {
              tags: membersOfCluster,
              aliases: Object.fromEntries(membersOfCluster.map((entry) => [entry.tag, entry.aliases])),
              why: reasons,
              stableInto,
              stableIntoWhy:
                'the deterministic fold keeps the language-preferred shortest spelling of a group; a merge in another direction stays merged but the next plain reindex moves the spelling here',
            },
            [
              ...ranked.filter((name) => name !== stableInto).map((name) => ({ kind: 'merge', tags: [name], into: stableInto })),
              ...ranked
                .filter((name) => name !== ranked[0])
                .map((name) => ({ kind: 'merge', tags: ranked.filter((other) => other !== name), into: name })),
              { kind: 'none', note: 'leave them as separate tags' },
            ],
          ),
        );
      }
    }

    /* 3. one name that may be a chain -------------------------------------- */

    if (wants('single-tag-path')) {
      for (const name of graph.names) {
        const bare = name.replace(/^#/, '');
        const separators = ['/', '>', '→', ',', '，', '、', ';', '|', '::', '_'].filter((separator) => bare.includes(separator));
        const hyphenParts = bare.includes('-')
          ? bare
              .split('-')
              .filter(Boolean)
              .map((part) => ({ part: `#${part}`, isTag: Boolean(graph.tags[`#${part}`]) }))
          : [];
        let prefixTag = '';
        let remainder = '';
        for (const other of graph.names.slice().sort((a, b) => b.length - a.length || compareStrings(a, b))) {
          if (other === name) continue;
          const head = other.replace(/^#/, '');
          if (!head || bare.length <= head.length || !bare.startsWith(head)) continue;
          const tail = bare.slice(head.length);
          if (!isCjk(tail)) continue;
          prefixTag = other;
          remainder = tail;
          break;
        }
        const namedParts = hyphenParts.some((part) => part.isTag);
        if (!separators.length && !namedParts && !prefixTag) continue;
        const options = [];
        if (prefixTag) options.push({ kind: 'split', tag: name, into: [prefixTag, `#${remainder}`] });
        if (namedParts) options.push({ kind: 'split', tag: name, into: hyphenParts.map((part) => part.part) });
        options.push({ kind: 'none', note: 'keep the name as one tag' });
        findings.push(
          this.tagFinding(
            `single-tag-path:${name}`,
            'single-tag-path',
            `Is ${name} one tag, or a chain the parser collapsed into one name?`,
            {
              tag: name,
              components: members.get(name) || [],
              separators,
              parts: hyphenParts,
              prefixTag,
              remainder,
              parents: sortedUnique(toArray((graph.tags[name] || {}).parents)),
              why: [
                'a tag name cannot carry "/", ">" or ",": the input parser splits them, so a name holding one was written outside the parser',
                ...(prefixTag ? [`${name} starts with ${prefixTag}, which is already a tag of its own`] : []),
                ...(namedParts ? ['the hyphen-separated parts include names that are already tags'] : []),
                'the normalizer turns a space into a hyphen, so `A B` and `A-B` are the same stored name and only a reader can tell them apart',
              ],
            },
            options,
          ),
        );
      }
    }

    /* 4. a chain that may be one tag --------------------------------------- */

    if (wants('path-might-be-one-tag')) {
      for (const name of graph.names) {
        for (const child of sortedUnique(toArray((graph.tags[name] || {}).children))) {
          const bareParent = name.replace(/^#/, '');
          const bareChild = String(child).replace(/^#/, '');
          const joined = [`#${bareParent}${bareChild}`, `#${bareParent}-${bareChild}`].filter((candidate) => graph.tags[candidate]);
          if (!joined.length) continue;
          const own = sortedUnique([...(members.get(name) || []), ...(members.get(child) || [])]);
          findings.push(
            this.tagFinding(
              `path-might-be-one-tag:${name}>${child}`,
              'path-might-be-one-tag',
              `Is ${name} > ${child} a chain, or is it the single tag ${joined[0]}?`,
              {
                chain: [name, child],
                existingTags: joined,
                components: own,
                why: [
                  `${joined.join(' and ')} already exists as a tag, spelled exactly like the two nodes joined`,
                  'the input parser splits "/" and ">" into a chain, so a single tag written with one becomes two nodes',
                ],
              },
              [...joined.map((into) => ({ kind: 'join', path: [name, child], into })), { kind: 'none', note: 'keep the chain' }],
            ),
          );
        }
      }
    }

    /* 5. stored values today's rule does not reproduce --------------------- */

    if (wants('rule-not-reproducible')) {
      for (const name of graph.names) {
        if (referenced.has(name)) continue;
        findings.push(
          this.tagFinding(
            `rule-not-reproducible:tag:${name}`,
            'rule-not-reproducible',
            `${name} is indexed but no component references it: keep it, or let the rebuild drop it?`,
            {
              storedKind: 'tag',
              stored: name,
              rule: 'a rebuild builds the tag dictionary from the components it indexes',
              ruleYields: 'dropped',
              components: [],
              why: ['a deterministic rebuild drops every tag node no component references, so this node does not survive one'],
            },
            [
              {
                kind: 'none',
                note: 'informational: memory_lab_tag_apply cannot keep an unreferenced tag; a component would have to reference it',
              },
            ],
          ),
        );
      }
      for (const component of graph.components) {
        const slug = String(component.slug);
        const produced = slugify(String(component.name ?? slug));
        if (produced === slug) continue;
        findings.push(
          this.tagFinding(
            `rule-not-reproducible:slug:${slug}`,
            'rule-not-reproducible',
            `${slug} is stored under a slug today's rule does not produce from its name: keep it, or bring it back onto the rule?`,
            {
              storedKind: 'component-slug',
              stored: slug,
              name: String(component.name ?? ''),
              rule: 'slugify(name)',
              ruleYields: produced,
              components: [slug],
              why: [
                'a rebuild preserves a stored slug verbatim, so the divergence is grandfathered rather than repaired by a reindex',
                'renaming a component slug is not one of the decisions memory_lab_tag_apply accepts',
              ],
            },
            [{ kind: 'none', note: 'informational: every rebuild preserves the slug and no tag decision renames it' }],
          ),
        );
      }
    }

    /* the window ----------------------------------------------------------- */

    const limit = clampInt(options && options.limit, DEFAULT_TAG_FINDING_LIMIT, 1, MAX_TAG_FINDING_LIMIT);
    const offset = Math.max(0, Math.floor(Number(options && options.offset) || 0));
    const order = new Map(TAG_FINDING_KINDS.map((kind, index) => [kind, index]));
    findings.sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || compareStrings(a.id, b.id));
    const counts = {};
    for (const kind of TAG_FINDING_KINDS) counts[kind] = findings.filter((finding) => finding.kind === kind).length;
    const page = findings.slice(offset, offset + limit);
    return {
      ok: true,
      root: this.root,
      indexPath: this.indexPath,
      loadedAt: isoNow(),
      relationshipVersion: String(index.relationshipVersion || ''),
      counts: { tags: graph.names.length, components: graph.components.length, findings: findings.length, byKind: counts },
      findings: page,
      window: { offset, limit, returned: page.length, total: findings.length, omitted: Math.max(0, findings.length - offset - page.length) },
      warnings: sortedUnique(loaded.warnings),
      instructions: [
        'A review reports candidates and their evidence; it never rewrites a tag. Decide each finding yourself and pass the decisions you accept to memory_lab_tag_apply.',
        'A finding whose only option is {"kind":"none"} is informational: no apply decision can act on it.',
      ],
    };
  }

  /**
   * Apply the tag-graph decisions a caller made from a review.
   *
   * Everything a decision changes lives in `index.json` — the component markdown
   * files hold no tags — so this rewrites the components' `tags`/`tagPaths` in the
   * index, renormalizes and writes once. Before it writes it archives the current
   * `index.json` verbatim under `archive/<TAG_ARCHIVE_DIR>/`, and it appends one
   * `policy.jsonl` line carrying the decisions, every affected component's
   * previous tags/tagPaths, the archive path and an `undo` list that restores the
   * previous graph. Reversal is therefore mechanical, not a reconstruction.
   *
   * `dryRun` computes exactly the same answer and writes nothing.
   */
  applyTagDecisions(input = {}) {
    const decisions = Array.isArray(input && input.decisions) ? input.decisions : null;
    if (!decisions || !decisions.length) {
      throw new MemoryLabStoreError('INVALID_DECISION', 'applyTagDecisions() needs at least one decision.', {
        kinds: TAG_DECISION_KINDS.slice(),
      });
    }
    const dryRun = input && input.dryRun === true;
    const index = this.openForWrite();
    const expected = input && input.expectedRelationshipVersion ? String(input.expectedRelationshipVersion).trim() : '';
    if (expected && expected !== String(index.relationshipVersion || '')) {
      throw new MemoryLabStoreError('STALE_WRITE', 'The tag graph changed since it was reviewed.', {
        expectedRelationshipVersion: expected,
        storedRelationshipVersion: String(index.relationshipVersion || ''),
        action: TAG_EDIT_ACTION,
      });
    }

    const components = componentList(index.components);
    const bySlug = new Map(components.map((component) => [String(component.slug), component]));
    const nodeNames = new Set(Object.keys(index.tags || {}));
    const before = new Map();
    const remember = (component) => {
      const slug = String(component.slug);
      if (before.has(slug)) return;
      before.set(slug, {
        tags: sortedUnique(toArray(component.tags)),
        tagPaths: toArray(component.tagPaths)
          .filter(Array.isArray)
          .map((chain) => chain.map(String)),
      });
    };
    const name = (value) => normalizeTagName(value);
    const requireTag = (tag, field) => {
      const cleaned = name(tag);
      if (!cleaned) throw new MemoryLabStoreError('INVALID_DECISION', `${field} must name a tag.`, { field, value: String(tag) });
      if (!nodeNames.has(cleaned)) {
        throw new MemoryLabStoreError('NOT_FOUND', `Tag not found in the index: ${cleaned}`, { field, tag: cleaned });
      }
      return cleaned;
    };
    /**
     * Resolve a tag name that may currently be spelled as one of a node's aliases.
     *
     * A fold can move a group's surviving spelling to the language-preferred one on
     * the next read, so the name a receipt recorded can come back as an alias of the
     * node it named. Resolution keeps an `unfold` working across that move — without
     * it, undoing a merge into a longer spelling failed with NOT_FOUND.
     */
    const resolveNode = (tag) => {
      const cleaned = name(tag);
      if (!cleaned) return null;
      if (nodeNames.has(cleaned)) return cleaned;
      for (const candidate of nodeNames) {
        if (sortedUnique(toArray(((index.tags || {})[candidate] || {}).aliases)).includes(cleaned)) return candidate;
      }
      return null;
    };
    const descendantOf = (candidate, subject) => {
      const seen = new Set();
      const walk = (current) => {
        if (current === candidate) return true;
        if (seen.has(current)) return false;
        seen.add(current);
        const node = (index.tags || {})[current] || {};
        return toArray(node.children).some((child) => walk(child));
      };
      return walk(subject);
    };
    const writeTags = (component, tags, tagPaths) => {
      remember(component);
      const normalized = this.normalizeTagInput(sortedUnique(tags), tagPaths);
      component.tags = normalized.tags;
      component.tagPaths = normalized.tagPaths;
    };
    const rewrite = (component, mapTag) => {
      const tags = sortedUnique(toArray(component.tags).map(mapTag));
      const paths = [];
      for (const chain of toArray(component.tagPaths).filter(Array.isArray)) {
        const mapped = [];
        for (const node of chain) {
          const next = mapTag(String(node));
          if (mapped.length && mapped[mapped.length - 1] === next) continue;
          mapped.push(next);
        }
        if (mapped.length) paths.push(mapped);
      }
      return { tags, tagPaths: paths };
    };

    const applied = [];
    const skipped = [];
    const aliasHints = [];
    const aliasDrops = [];
    const warnings = [];

    for (const raw of decisions) {
      const decision = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
      const kind = decision ? String(decision.kind || '') : '';
      if (!decision || !TAG_DECISION_KINDS.includes(kind)) {
        throw new MemoryLabStoreError('UNKNOWN_DECISION', `Unknown tag decision: ${kind || '(none)'}`, {
          decision: raw,
          known: TAG_DECISION_KINDS.slice(),
        });
      }

      if (kind === 'merge') {
        const into = requireTag(decision.into, 'into');
        const from = sortedUnique(toArray(decision.tags).map((tag) => name(tag))).filter((tag) => tag && tag !== into);
        if (!from.length) throw new MemoryLabStoreError('INVALID_DECISION', 'merge needs the tags to fold away from.', { decision });
        for (const tag of from) requireTag(tag, 'tags');
        const keys = new Set(from.map((tag) => comparisonKey(tag)));
        const affected = [];
        for (const component of components) {
          const mentions = this.normalizeTagInput(toArray(component.tags), toArray(component.tagPaths)).tags.some((tag) =>
            keys.has(comparisonKey(tag)),
          );
          if (!mentions) continue;
          const { tags, tagPaths } = rewrite(component, (tag) => (keys.has(comparisonKey(tag)) ? into : tag));
          writeTags(component, tags, tagPaths);
          affected.push(String(component.slug));
        }
        if (!affected.length) {
          skipped.push({ kind, into, tags: from, why: 'no component carries those tags, so nothing changed' });
          continue;
        }
        const stableInto = this.chooseCanonicalTag(sortedUnique([into, ...from]), new Set(sortedUnique([into, ...from])));
        /**
         * A fold link is only recorded when the store's own spelling rule would keep
         * `into` as the group's name. The rule picks the language-preferred shortest
         * spelling on every read, so a link in the other direction would move the
         * group's name (and `relationshipVersion`) on the next rebuild, and would
         * re-spell the components that had used the canonical one — which no undo
         * could put back. Without the link the merge is a plain, exact rewrite.
         */
        const linked = stableInto === into;
        if (linked) aliasHints.push({ canonical: into, names: from });
        else {
          warnings.push(
            `merge-direction:${from.join('+')}->${into}: no fold link recorded, because the spelling rule would move this group to ${stableInto} on the next rebuild; the components are rewritten, and a later write using ${from.join('/')} starts a new tag`,
          );
        }
        applied.push({ kind, into, tags: from, linked, affected });
        continue;
      }

      if (kind === 'reparent') {
        const tag = requireTag(decision.tag, 'tag');
        const under = requireTag(decision.under, 'under');
        if (under === tag) throw new MemoryLabStoreError('TAG_CYCLE', `A tag cannot be its own parent: ${tag}`, { tag, under });
        if (descendantOf(tag, under)) {
          throw new MemoryLabStoreError('TAG_CYCLE', `${tag} is already inside ${under}; continuing ${under} under it would close a cycle.`, {
            tag,
            under,
          });
        }
        const affected = [];
        for (const component of components) {
          const state = this.normalizeTagInput(toArray(component.tags), toArray(component.tagPaths));
          if (!state.tags.includes(tag)) continue;
          // Every chain that STARTS at the root tag now starts at its parent; a
          // chain that already nests it deeper is left exactly as it is.
          const paths = [];
          for (const chain of state.tagPaths) {
            const mapped = chain[0] === tag ? [under, ...chain] : chain.slice();
            if (mapped.length) paths.push(mapped);
          }
          // A component can carry the tag without any chain through it; it then
          // needs the one chain that gives the tag its parent.
          if (!paths.some((chain) => chain.includes(tag))) paths.push([under, tag]);
          writeTags(component, state.tags, paths);
          affected.push(String(component.slug));
        }
        if (!affected.length) {
          skipped.push({ kind, tag, under, why: 'no component carries that tag, so nothing changed' });
          continue;
        }
        applied.push({ kind, tag, under, affected });
        continue;
      }

      if (kind === 'set-tags') {
        const slug = String(decision.slug || '').trim();
        const component = bySlug.get(slug) || components.find((entry) => String(entry.name || '') === slug);
        if (!component) throw new MemoryLabStoreError('NOT_FOUND', `Memory component not found: ${slug}`, { slug });
        const tags = toArray(decision.tags)
          .map((tag) => name(tag))
          .filter(Boolean);
        const tagPaths = toArray(decision.tagPaths)
          .filter(Array.isArray)
          .map((chain) => chain.map((node) => name(node)).filter(Boolean));
        // A restore reintroduces tag names the change it reverses had removed, so a
        // name that is not a node yet is allowed — and named, because it means this
        // call is creating one rather than restoring one.
        const fresh = sortedUnique([...tags, ...tagPaths.flat()]).filter((tag) => !nodeNames.has(tag));
        if (fresh.length) warnings.push(`set-tags:${component.slug}: reintroduces ${fresh.join(', ')}`);
        writeTags(component, tags, tagPaths);
        applied.push({ kind, slug: String(component.slug), reintroduced: fresh, affected: [String(component.slug)] });
        continue;
      }

      if (kind === 'split') {
        const tag = requireTag(decision.tag, 'tag');
        const into = sortedUnique(
          toArray(decision.into)
            .map((entry) => name(entry))
            .filter(Boolean),
        );
        if (into.length < 2) throw new MemoryLabStoreError('INVALID_DECISION', 'split needs at least two tag names to split into.', { decision });
        if (into.includes(tag)) throw new MemoryLabStoreError('INVALID_DECISION', `split cannot keep ${tag} as one of its own parts.`, { decision });
        const affected = [];
        for (const component of components) {
          const state = this.normalizeTagInput(toArray(component.tags), toArray(component.tagPaths));
          if (!state.tags.includes(tag)) continue;
          const tags = sortedUnique([...state.tags.filter((entry) => entry !== tag), ...into]);
          const tagPaths = state.tagPaths.map((chain) => chain.flatMap((node) => (node === tag ? into.slice() : [node])));
          writeTags(component, tags, tagPaths);
          affected.push(String(component.slug));
        }
        if (!affected.length) {
          skipped.push({ kind, tag, into, why: 'no component carries that tag, so nothing changed' });
          continue;
        }
        applied.push({ kind, tag, into, affected });
        continue;
      }

      if (kind === 'join') {
        const path = toArray(decision.path)
          .map((entry) => name(entry))
          .filter(Boolean);
        const into = name(decision.into);
        if (path.length < 2 || !into) {
          throw new MemoryLabStoreError('INVALID_DECISION', 'join needs a path of at least two tags and the single tag it is.', { decision });
        }
        if (!survivesAsOneTag(into)) {
          throw new MemoryLabStoreError(
            'UNREPRESENTABLE_TAG_NAME',
            `${into} cannot be one tag in this store: the input parser splits it, so a rebuild would turn it back into a chain. Name the tag without "/", ">", "→" or a comma.`,
            { into, path, rule: 'splitLegacyPath()/splitTagValue() run on every write and every rebuild' },
          );
        }
        for (const tag of path) requireTag(tag, 'path');
        if (path.includes(into)) throw new MemoryLabStoreError('INVALID_DECISION', `join cannot fold a chain into one of its own nodes (${into}).`, { decision });
        const affected = [];
        for (const component of components) {
          const state = this.normalizeTagInput(toArray(component.tags), toArray(component.tagPaths));
          let touched = false;
          const joinedPaths = [];
          for (const chain of state.tagPaths) {
            const mapped = [];
            for (let index = 0; index < chain.length; index += 1) {
              const matches = path.every((node, offset) => chain[index + offset] === node);
              if (matches) {
                mapped.push(into);
                index += path.length - 1;
                touched = true;
                continue;
              }
              mapped.push(chain[index]);
            }
            if (mapped.length) joinedPaths.push(mapped);
          }
          if (!touched) continue;
          /* The store materialises a single-node tagPath for every tag a component
           * declares, so the collapsed nodes also sit in paths of their own. They are
           * part of what this decision removes — unless the component still uses one
           * of them in another chain, which means it asserted that tag for real. */
          const stillChained = new Set(joinedPaths.filter((chain) => chain.length > 1).flat());
          const dropped = path.filter((node) => !stillChained.has(node));
          const tagPaths = joinedPaths.filter((chain) => !(chain.length === 1 && dropped.includes(chain[0])));
          const stillUsed = new Set(tagPaths.flat());
          const tags = sortedUnique([...state.tags.filter((entry) => stillUsed.has(entry) || !path.includes(entry)), into]);
          writeTags(component, tags, tagPaths);
          affected.push(String(component.slug));
        }
        if (!affected.length) {
          skipped.push({ kind, path, into, why: 'no component carries that chain, so nothing changed' });
          continue;
        }
        applied.push({ kind, path, into, affected });
        continue;
      }

      // unfold: take a merge's fold link back out of the fold table.
      const named = name(decision.canonical);
      const canonical = resolveNode(named);
      if (!canonical) {
        throw new MemoryLabStoreError('NOT_FOUND', `Tag not found in the index: ${named}`, { field: 'canonical', tag: named });
      }
      const aliases = sortedUnique([
        ...toArray(decision.aliases)
          .map((entry) => name(entry))
          .filter(Boolean),
        ...(canonical === named ? [] : [named]),
      ]);
      const stored = sortedUnique(toArray(((index.tags || {})[canonical] || {}).aliases));
      const present = aliases.filter((alias) => stored.includes(alias));
      if (!present.length) {
        skipped.push({ kind, canonical, aliases, why: 'the canonical tag does not carry those aliases, so nothing changed' });
        continue;
      }
      aliasDrops.push(...present);
      applied.push({ kind, canonical, aliases: present, affected: [] });
      warnings.push(
        `unfold:${canonical}<-${present.join('+')}: the fold link is gone and the spellings are separate tags again; the archived index is the only record that restores the link itself`,
      );
    }

    const changed = applied.some((entry) => entry.affected.length > 0 || entry.kind === 'unfold');
    if (!applied.length) {
      return {
        ok: true,
        action: TAG_EDIT_ACTION,
        applied: [],
        skipped,
        changed: false,
        dryRun,
        relationshipVersionBefore: String(index.relationshipVersion || ''),
        relationshipVersionAfter: String(index.relationshipVersion || ''),
        undo: [],
        warnings: sortedUnique(warnings),
        receipt: { operation: 'tag-apply', completed: true, changed: false, verifiedAt: isoNow(), decisions: 0 },
      };
    }

    const { index: normalized, warnings: normalizeWarnings } = this.normalizeIndex(cloneJson(index), {
      aliasHints,
      aliasDrops,
      refreshContent: !dryRun,
    });
    warnings.push(...normalizeWarnings);
    const affectedBefore = Array.from(before.entries()).map(([slug, state]) => ({ slug, before: state }));

    if (dryRun) {
      return {
        ok: true,
        action: TAG_EDIT_ACTION,
        applied,
        skipped,
        changed,
        dryRun: true,
        relationshipVersionBefore: String(index.relationshipVersion || ''),
        relationshipVersionAfter: String(normalized.relationshipVersion || ''),
        affected: affectedBefore,
        undo: this.tagUndo(before, applied),
        warnings: sortedUnique(warnings),
        receipt: { operation: 'tag-apply', completed: true, dryRun: true, changed, decisions: applied.length, verifiedAt: isoNow() },
      };
    }

    const archivePath = this.archiveIndexSnapshot();
    this.writeIndex(normalized);
    const undo = this.tagUndo(before, applied);
    const policy = this.appendPolicy({
      action: TAG_EDIT_ACTION,
      kinds: sortedUnique(applied.map((entry) => entry.kind)),
      slug: sortedUnique(applied.flatMap((entry) => entry.affected)).join(','),
      reason: input && input.reason ? String(input.reason).trim() : 'Apply reviewed tag-graph decisions.',
      source: input && input.source ? String(input.source).trim() : 'memory_lab_tag_apply',
      decisions: applied,
      skipped,
      affected: affectedBefore,
      undo,
      archivePath,
      relationshipVersion: normalized.relationshipVersion,
      previousRelationshipVersion: String(index.relationshipVersion || ''),
      warnings: sortedUnique(warnings),
    });

    return {
      ok: true,
      action: TAG_EDIT_ACTION,
      applied,
      skipped,
      changed,
      dryRun: false,
      relationshipVersionBefore: String(index.relationshipVersion || ''),
      relationshipVersionAfter: String(normalized.relationshipVersion || ''),
      tags: Object.keys(normalized.tags || {}).length,
      components: componentList(normalized.components).length,
      archived: archivePath,
      policyEventId: policy.id,
      undo,
      warnings: sortedUnique(warnings),
      receipt: {
        operation: 'tag-apply',
        completed: true,
        changed,
        decisions: applied.length,
        indexPath: this.indexPath,
        indexUpdatedAt: normalized.updatedAt,
        verifiedAt: isoNow(),
        relationshipVersion: normalized.relationshipVersion,
        previousRelationshipVersion: String(index.relationshipVersion || ''),
        archivePath,
        policyEventId: policy.id,
        warnings: sortedUnique(warnings),
      },
    };
  }

  /**
   * The decision list that restores the graph this call changed: one `set-tags`
   * per affected component with its exact previous tags/tagPaths, plus one
   * `unfold` per fold link the call created. Passing it back to
   * `applyTagDecisions()` returns `relationshipVersion` to its previous value.
   */
  tagUndo(before, applied) {
    const undo = [];
    for (const [slug, state] of before.entries()) {
      undo.push({ kind: 'set-tags', slug, tags: state.tags.slice(), tagPaths: state.tagPaths.map((chain) => chain.slice()) });
    }
    for (const entry of applied) {
      if (entry.kind !== 'merge' || entry.linked !== true) continue;
      undo.push({ kind: 'unfold', canonical: entry.into, aliases: entry.tags.slice() });
    }
    return undo;
  }

  /**
   * Archive the current `index.json` verbatim, as the reversible record of a
   * tag-graph edit. It lives beside the per-component revision archives
   * (`archive/<TAG_ARCHIVE_DIR>/`) and is the exact document that was on disk
   * before the edit — the graph's own prior revision.
   */
  archiveIndexSnapshot(label = 'pre-tag-edit') {
    if (!fs.existsSync(this.indexPath)) return null;
    const raw = readTextOrNull(this.indexPath);
    if (raw === null) return null;
    const directory = this.resolveInsideRoot(`archive/${TAG_ARCHIVE_DIR}`);
    fs.mkdirSync(directory, { recursive: true });
    const stamp = isoNow().replace(/[:.]/g, '-');
    let target = path.join(directory, `${stamp}-${label}.json`);
    let counter = 1;
    while (fs.existsSync(target)) {
      counter += 1;
      target = path.join(directory, `${stamp}-${label}-${counter}.json`);
    }
    if (!isInside(this.archiveDir, target)) throw pathEscapeError(target, this.root);
    writeFileAtomic(target, raw);
    return target;
  }

  // -- write side helpers ---------------------------------------------------

  readComponentContent(component) {
    const content = readTextOrNull(this.resolveComponentFile(component));
    return content === null ? '' : content;
  }

  /** Archive one prior revision verbatim under `<root>/archive/<slug>/`. */
  archiveRevision(slug, revision, content) {
    const directory = this.resolveInsideRoot(`archive/${slug}`);
    fs.mkdirSync(directory, { recursive: true });
    const stamp = isoNow().replace(/[:.]/g, '-');
    let target = path.join(directory, `${stamp}-${Math.max(1, Math.floor(Number(revision) || 1))}.md`);
    let counter = 1;
    while (fs.existsSync(target)) {
      counter += 1;
      target = path.join(directory, `${stamp}-${Math.max(1, Math.floor(Number(revision) || 1))}-${counter}.md`);
    }
    if (!isInside(this.archiveDir, target)) throw pathEscapeError(target, this.root);
    writeFileAtomic(target, content);
    return target;
  }

  /**
   * Append one append-only audit line. Records action, slug, reason, source,
   * revisions, ISO timestamps, the archive path and a content hash — never the
   * memory content itself.
   */
  appendPolicy(event) {
    fs.mkdirSync(this.root, { recursive: true });
    const record = { id: crypto.randomUUID(), at: isoNow(), ...event };
    fs.appendFileSync(this.policyPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /** The audit log as parsed records (read-only; never rewrites the file). */
  policyLog() {
    const raw = readTextOrNull(this.policyPath);
    if (!raw) return [];
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line, lineNumber) => {
        try {
          return JSON.parse(line);
        } catch {
          return { malformed: true, line: lineNumber + 1 };
        }
      });
  }

  // -- model-facing formatting ---------------------------------------------

  formatRead(result) {
    const payload = {
      ok: result.ok,
      root: result.root,
      indexPath: result.indexPath,
      componentsDir: result.componentsDir,
      instructions: result.instructions,
      index: result.index,
      component: result.component,
      content: result.content,
      error: result.error,
    };
    return `[memory_lab_read]\n${JSON.stringify(payload, null, 2)}`;
  }

  formatQuery(result) {
    return `[memory_lab_query]\n${JSON.stringify(result, null, 2)}`;
  }

  formatWrite(result) {
    return `[memory_lab_write]\n${JSON.stringify(result, null, 2)}`;
  }

  formatTagReview(result) {
    return `[memory_lab_tag_review]\n${JSON.stringify(result, null, 2)}`;
  }

  formatTagApply(result) {
    return `[memory_lab_tag_apply]\n${JSON.stringify(result, null, 2)}`;
  }
}

export default MemoryLabStore;
