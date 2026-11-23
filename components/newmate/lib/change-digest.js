import path from 'node:path';
import fs from 'node:fs';

/**
 * THE CHANGE BRIEF: read the overview of what changed, summarise it, then let the model speak.
 *
 * The user's instruction for a proactive check-in is one sequence, and this module is its first two
 * steps:
 *
 *   1. 通读概览可信工作区的文件变动 — survey the workspaces the host has registered as trusted and
 *      describe what changed, as an overview rather than as one number;
 *   2. 再整理总结 — turn that survey into a reading order a person would use: which projects, which
 *      directories, which kinds of file, how long ago;
 *   3. 最后根据所有可较快获取的信息生成回复提醒 — the third step belongs to the model, which receives
 *      this brief plus the runtime's quick facts and writes the sentence (see the check-in prompt in
 *      component.js).
 *
 * WHY THIS IS METADATA AND NOT FILE CONTENT. The monitor's own rule is that it never reads a file, and
 * the user's requirement for the check-in is an OVERVIEW. So the survey carries the file's name, its
 * kind, its modification time and its size — four facts that are cheap, bounded and cannot leak a
 * document into a prompt. A file's bytes never enter here, which is also why "通读" cannot mean "read
 * every changed file": that would copy someone's work into a model request on a schedule.
 *
 * WHAT WAS MEASURED, AND WHY THE SHAPE IS THIS ONE. The one-liner the monitor used to hand over
 * ("新增 3、删除 0、改动 2 …") is enough to SCORE a change but not enough to speak about it: a model
 * reading it knows that three files appeared and nothing about which part of the project moved. The
 * brief adds the two things that answer that without touching content — a directory roll-up (where it
 * moved) and a kind roll-up (docs / code / config / tests / assets / data), both computed from the
 * complete change list, not from the sample the prompt shows.
 *
 * BOUNDS ARE STATED, NOT SILENT. A workspace with 900 changed files must not be described as a
 * 60-file one: every list reports how many it left out (`truncated`), and the rendered summary is
 * capped in characters with the same accounting, so a short brief never reads as a small change.
 */

export const DIGEST_VERSION = 1;

export const DIGEST_DEFAULTS = Object.freeze({
  /** File names carried into the stored digest, across all workspaces. */
  maxFiles: 60,
  /** Directory roll-up rows kept per workspace (the roll-up itself is computed over every change). */
  maxDirs: 10,
  maxWorkspaces: 8,
  /** Characters the rendered brief may occupy in a prompt. */
  maxChars: 1600,
  /** File names printed in the brief (the rest are counted, not dropped silently). */
  maxFileNames: 8,
  /**
   * A digest older than this is background, not news: the proactive contract forbids wording that the
   * delivery time can falsify ("刚刚"/"现在"), and a two-day-old survey must not be read as this hour's
   * work. Two hours is long enough that a missed pass or a quiet evening does not erase the survey,
   * and short enough that "recent" still means the same day.
   */
  maxAgeMs: 2 * 60 * 60000,
});

const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.tex']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.py', '.cs', '.java', '.kt', '.kts', '.rs', '.go', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.rb', '.php', '.sh', '.ps1', '.sql', '.html', '.css', '.scss', '.less', '.lua', '.dart', '.gradle']);
const CONFIG_EXT = new Set(['.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.plist', '.properties', '.lock']);
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.mp4', '.mov', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.pdf']);
const DATA_EXT = new Set(['.csv', '.tsv', '.parquet', '.db', '.sqlite', '.sqlite3', '.log', '.jsonl', '.ndjson', '.xlsx', '.xls', '.docx', '.pptx']);
const DOC_NAMES = /^(?:readme|changelog|overview|contributing|license|notice|agents|claude|taste)(?:\.[a-z]+)?$/i;
const TEST_NAME = /(?:^|[\\/])(?:tests?|specs?|__tests__)(?:[\\/]|$)|\.(?:test|spec)\.[^.]+$/i;

const KINDS = Object.freeze(['docs', 'code', 'config', 'test', 'asset', 'data', 'other']);
export const DIGEST_KINDS = KINDS;

/** Which family a changed path belongs to. Names and extensions only - never the file itself. */
export function classifyPath(name) {
  const value = String(name || '');
  const base = path.posix.basename(value.replace(/\\/g, '/'));
  const extension = path.posix.extname(base).toLowerCase();
  if (TEST_NAME.test(value)) return 'test';
  if (DOC_NAMES.test(base)) return 'docs';
  if (DOC_EXT.has(extension)) return 'docs';
  if (CODE_EXT.has(extension)) return 'code';
  if (CONFIG_EXT.has(extension)) return 'config';
  if (ASSET_EXT.has(extension)) return 'asset';
  if (DATA_EXT.has(extension)) return 'data';
  return 'other';
}

/** The directory the overview groups by: the changed file's own directory, workspace-relative. */
export function directoryOf(name) {
  const normalised = String(name || '').replace(/\\/g, '/');
  const index = normalised.lastIndexOf('/');
  return index < 0 ? '.' : normalised.slice(0, index);
}

const safeSize = (root, name) => {
  try {
    const stat = fs.statSync(path.join(root, name));
    return stat.isFile() ? Number(stat.size) || 0 : null;
  } catch { return null; }
};

const newestFirst = (a, b) => (Number(b?.mtime) || 0) - (Number(a?.mtime) || 0) || String(a?.name || '').localeCompare(String(b?.name || ''));

/**
 * One survey pass over the change sets the monitor produced.
 *
 * @param perWorkspace  the monitor's per-workspace entries, each with `root`, its counts and the
 *                      complete `changes` list (`{name, kind: 'add'|'change'|'remove', mtime}`)
 * @param at            the survey instant
 * @param stat          size reader, injectable so the survey is testable without a filesystem
 */
export function surveyChanges(perWorkspace = [], { at = Date.now(), stat = safeSize, limits = {} } = {}) {
  const bound = { ...DIGEST_DEFAULTS, ...limits };
  const workspaces = [];
  const totals = { files: 0, added: 0, removed: 0, changed: 0, bytes: 0, byKind: Object.fromEntries(KINDS.map((kind) => [kind, 0])), workspaces: 0 };
  let carried = 0;
  let omittedFiles = 0;
  let omittedDirs = 0;
  let omittedWorkspaces = 0;
  const entries = Array.isArray(perWorkspace) ? perWorkspace : [];
  for (const [index, entry] of entries.entries()) {
    if (index >= bound.maxWorkspaces) { omittedWorkspaces += 1; continue; }
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    const root = String(entry?.root || '');
    if (!root) continue;
    const ordered = [...changes].sort(newestFirst);
    const files = [];
    for (const change of ordered) {
      if (carried >= bound.maxFiles) { omittedFiles += 1; continue; }
      carried += 1;
      const kind = classifyPath(change.name);
      const bytes = change.kind === 'remove' ? null : stat(root, String(change.name));
      files.push({ name: String(change.name), change: change.kind === 'remove' ? 'remove' : change.kind === 'add' ? 'add' : 'change', kind, at: Number(change.mtime) || 0, bytes: typeof bytes === 'number' ? bytes : null });
    }
    // The roll-up is computed over EVERY change in this workspace, including the ones the sample had
    // to drop: "where did it move" is the question the overview answers, and a truncated sample would
    // give a truncated map of the project.
    const directories = new Map();
    const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    let newest = 0;
    for (const change of changes) {
      const name = String(change?.name || '');
      if (!name) continue;
      const kind = classifyPath(name);
      byKind[kind] += 1;
      totals.byKind[kind] += 1;
      const directory = directoryOf(name);
      const row = directories.get(directory) || { directory, added: 0, removed: 0, changed: 0, kinds: {} };
      if (change.kind === 'remove') row.removed += 1; else if (change.kind === 'add') row.added += 1; else row.changed += 1;
      row.kinds[kind] = (row.kinds[kind] || 0) + 1;
      directories.set(directory, row);
      const mtime = Number(change?.mtime) || 0;
      if (mtime > newest) newest = mtime;
    }
    const dirs = [...directories.values()].sort((a, b) => (b.added + b.changed + b.removed) - (a.added + a.changed + a.removed) || a.directory.localeCompare(b.directory));
    const keptDirs = dirs.slice(0, bound.maxDirs);
    omittedDirs += Math.max(0, dirs.length - keptDirs.length);
    const added = Number(entry.added) || 0;
    const removed = Number(entry.removed) || 0;
    const changed = Number(entry.changed) || 0;
    const bytes = files.reduce((sum, file) => sum + (typeof file.bytes === 'number' ? file.bytes : 0), 0);
    totals.added += added; totals.removed += removed; totals.changed += changed; totals.bytes += bytes; totals.workspaces += 1;
    workspaces.push({
      root,
      name: path.basename(root) || root,
      added, removed, changed,
      countDelta: Math.round(Number(entry.countDelta) || 0),
      timeDelta: Math.max(0, Number(entry.timeDelta) || 0),
      dsh: Number(entry.dsh?.added || 0) + Number(entry.dsh?.removed || 0) + Number(entry.dsh?.changed || 0),
      user: Number(entry.user?.added || 0) + Number(entry.user?.removed || 0) + Number(entry.user?.changed || 0),
      dshWeight: Number.isFinite(entry.dshWeight) ? entry.dshWeight : undefined,
      first: entry.first === true,
      // A workspace whose walk shape changed is a BASELINE: its counts are not a change to the files.
      rebased: entry.rebased === true,
      newestAt: newest,
      byKind,
      dirs: keptDirs,
      files,
      omittedFiles: Math.max(0, changes.length - files.length),
      // What the walk actually reached. A snapshot that stopped at a directory or file cap is a
      // PARTIAL view, and the brief has to carry that: "新增 0" over an unwalked tree is the sentence
      // that told the user their own repository had not changed (measured 2026-11-23).
      coverage: entry.coverage || null,
    });
    totals.files += changes.length;
  }
  return {
    version: DIGEST_VERSION,
    at,
    workspaces,
    totals,
    truncated: { workspaces: omittedWorkspaces, files: omittedFiles, directories: omittedDirs },
  };
}

const KB = 1024;
const size = (bytes) => (typeof bytes !== 'number' ? '' : bytes >= KB * KB ? (bytes / (KB * KB)).toFixed(1) + ' MB' : bytes >= KB ? (bytes / KB).toFixed(1) + ' KB' : bytes + ' B');
const ago = (ms) => {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 1) return '1 分钟内';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
};
const clock = (ms) => {
  const date = new Date(Number(ms) || 0);
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
};
const KIND_LABEL = Object.freeze({ docs: '文档', code: '代码', config: '配置', test: '测试', asset: '素材', data: '数据', other: '其他' });
const KIND_ORDER = Object.freeze(['code', 'docs', 'config', 'test', 'data', 'asset', 'other']);

const kindLine = (byKind) => KIND_ORDER.filter((kind) => byKind?.[kind]).map((kind) => (KIND_LABEL[kind] || kind) + ' ' + byKind[kind]).join('、');

/**
 * Turn one survey into the reading order a person would use.
 *
 * Deliberately prose-shaped and deterministic: same survey, same words. The model's own sentence is
 * the thing that varies; a summary that varied too would make "what did it think it saw" impossible to
 * check after the fact. Levels are dropped from the outside in when the character budget is tight, so
 * a short brief still states project, counts and kinds before it lists any file.
 */
export function summariseChanges(digest, { now = Date.now(), maxChars = DIGEST_DEFAULTS.maxChars, maxFileNames = DIGEST_DEFAULTS.maxFileNames } = {}) {
  const all = Array.isArray(digest?.workspaces) ? digest.workspaces : [];
  /**
   * Only the workspaces that actually moved are described. Measured 2026-11-23: a brief listed three
   * workspaces and two of them said "新增 0、删除 0、改动 0", which spends the character budget on
   * nothing and buries the one project that did change. When every workspace is quiet, one sentence
   * says so instead of N identical lines.
   */
  const moved = all.filter((entry) => !entry.first && !entry.rebased
    && (Number(entry.added) + Number(entry.removed) + Number(entry.changed) > 0 || (entry.files?.length || 0) > 0));
  const workspaces = moved;
  const quiet = all.length - moved.length;
  const rebaselined = all.filter((entry) => entry.rebased || entry.first).length;
  const partial = (entry) => Boolean(entry?.coverage && (entry.coverage.omittedDirectories || entry.coverage.omittedFiles));
  const at = Number(digest?.at) || now;
  const head = '可信工作区变动概览（扫描于 ' + clock(at) + '，距现在 ' + ago(now - at) + '；只含文件名/类型/修改时间/大小，不含文件内容）：';
  if (!workspaces.length) {
    return (head + '\n' + (all.length
      ? all.length + ' 个可信工作区本次都没有可描述的变动' + (rebaselined ? '（其中 ' + rebaselined + ' 个重新建立了基线——扫描参数变了，不计改动）' : '') + (all.some(partial) ? '；其中 ' + all.filter(partial).length + ' 个只做了部分遍历（可能是变化落在未被走访的目录里）' : '') + '。'
      : '本机暂无可对比的信任工作区。')).slice(0, maxChars);
  }
  const render = (level) => {
    const lines = [head];
    if (rebaselined) lines.push('（其中 ' + rebaselined + ' 个可信工作区本次重新建立了基线——扫描参数变了，它们的「新增/删除」不是文件的改动）');
    if (quiet - rebaselined > 0) lines.push('（另有 ' + (quiet - rebaselined) + ' 个可信工作区本次没有变动，未列出）');
    workspaces.forEach((entry, index) => {
      const facts = [];
      facts.push('新增 ' + entry.added + '、删除 ' + entry.removed + '、改动 ' + entry.changed);
      const kinds = kindLine(entry.byKind);
      if (kinds) facts.push('其中 ' + kinds);
      if (entry.dsh) facts.push('DSH 引起 ' + entry.dsh + ' 个（已按权重 ' + (entry.dshWeight ?? 0.1) + ' 降权）');
      if (entry.newestAt) facts.push('最新改动在 ' + ago(at - entry.newestAt));
      else if (entry.timeDelta) facts.push('最新修改时间前移 ' + Math.round(entry.timeDelta / 60000) + ' 分钟');
      const overflow = entry.omittedFiles ? '；另有 ' + entry.omittedFiles + ' 个未列出' : '';
      const partialText = partial(entry)
        ? '（这次只走了 ' + (entry.coverage.directories ?? '?') + ' 个目录、取样 ' + (entry.coverage.sampledFiles ?? '?') + ' 个文件，'
          + (entry.coverage.omittedDirectories ? '还有 ' + entry.coverage.omittedDirectories + ' 个目录没走' : '')
          + (entry.coverage.omittedFiles ? '、' + entry.coverage.omittedFiles + ' 个文件没取样' : '')
          + '：没列出的不代表没变）'
        : '';
      lines.push((index + 1) + ') ' + (entry.name || path.basename(String(entry.root || '')) || '工作区') + '：' + facts.join('；') + overflow + partialText);
      if (level >= 2 && entry.dirs?.length) {
        lines.push('   目录：' + entry.dirs.map((dir) => dir.directory + ' 新增 ' + dir.added + '、删除 ' + dir.removed + '、改动 ' + dir.changed + (Object.keys(dir.kinds || {}).length > 1 ? '（' + kindLine(dir.kinds) + '）' : '')).join('；'));
      }
      if (level >= 3 && entry.files?.length) {
        const names = entry.files.slice(0, maxFileNames).map((file) => {
          const label = file.change === 'add' ? '新增' : file.change === 'remove' ? '删除' : '改动';
          const bytes = size(file.bytes);
          return file.name + '（' + label + '，' + (file.at ? ago(now - file.at) : '时间未知') + (bytes ? '，' + bytes : '') + '）';
        });
        lines.push('   文件：' + names.join('、') + (entry.files.length > names.length ? ' 等 ' + entry.files.length + ' 个' : ''));
      }
    });
    return lines.join('\n');
  };
  for (const level of [3, 2, 1, 0]) {
    const text = render(level);
    if (text.length <= maxChars) return text;
  }
  return render(0).slice(0, Math.max(0, maxChars));
}

/**
 * The brief as a prompt block, with the one thing the model must not get wrong: how old it is.
 *
 * A survey from before the last monitor pass is background, and the proactive contract forbids
 * claiming it happened "just now". The block says the age in words AND carries `stale` so a caller
 * can decide not to use it at all.
 */
export function digestBlock(digest, { now = Date.now(), maxChars = DIGEST_DEFAULTS.maxChars, maxAgeMs = DIGEST_DEFAULTS.maxAgeMs } = {}) {
  if (!digest || !Array.isArray(digest.workspaces) || !digest.workspaces.length) return null;
  const at = Number(digest.at) || 0;
  const ageMs = Math.max(0, now - at);
  const stale = ageMs > maxAgeMs;
  const text = summariseChanges(digest, { now, maxChars });
  if (!text) return null;
  // `partial` is the flag a caller uses to decide how much weight the overview deserves: at least one
  // workspace was only partly walked, so "nothing in it" is not evidence of nothing.
  const partial = (digest.workspaces || []).some((entry) => entry?.coverage && (entry.coverage.omittedDirectories || entry.coverage.omittedFiles));
  return { text, chars: text.length, at, ageMs, stale, partial, workspaces: digest.workspaces.length, truncated: digest.truncated || null };
}
