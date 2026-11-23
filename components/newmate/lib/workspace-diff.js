import fs from 'node:fs';
import path from 'node:path';

/**
 * Snapshot-diff measurement of the workspaces, replacing the event watcher.
 *
 * The user's specification is five things, and this module is exactly those five:
 *
 *   1. compare once when NewMate starts;
 *   2. compare again every 30 minutes (configurable);
 *   3. compare file COUNT, file NAMES and the LATEST MODIFICATION TIME;
 *   4. accumulate a WEIGHTED score and, when it crosses a threshold, start ONE proactive response;
 *   5. the knobs live in the plugin settings.
 *
 * Everything that decides "is this worth a conversation" is a pure function here: a snapshot of one
 * workspace, the diff of two snapshots, the per-interval score, and the accumulator. The component
 * owns only persistence and the decision to enqueue; the schedule lives in the plugin row. That
 * split is what makes the algorithm testable without a clock or a filesystem.
 *
 * The snapshot is bounded in the same way the event watcher was: a depth-limited walk that skips
 * dependency trees, VCS internals and build output, a directory cap, and a file cap. Both caps
 * report what they dropped, so a short snapshot never reads as a small workspace.
 */

export const IGNORED_DIRECTORIES = Object.freeze([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', '.tox',
  '.gradle', '.idea', '.DS_Store', 'DerivedData', '.turbo', '.pnpm-store',
]);

/**
 * Defaults, and the reason each number is what it is.
 *
 * THE THREE VISIBILITY NUMBERS WERE RE-MEASURED AND RAISED ON 2026-11-23, because the old set silently
 * hid the user's main project:
 *
 *   depth 6            - a repository keeps its code at <project>/<pkg>/<lib>/<file>; the old depth 3
 *                        stopped one level above it, so "the code changed" could never be seen. Depth is
 *                        about SHAPE, not cost: the walk is bounded by the directory and file caps below,
 *                        and measured 2026-11-23 on a 90k-file repository, depth 5 and 6 cost the same
 *                        (648 ms vs 678 ms) - depth 6 is what makes <pkg>/components/<name>/<file>
 *                        visible at all;
 *   maxDirectories 512 - measured on this machine: "…/Files/Code" holds 557 directories at depth 3 and
 *                        the old 128-directory budget was spent, breadth-first, on the umbrella folder's
 *                        own loose files before reaching ANY project below it (429 directories dropped);
 *   maxFiles 4096      - one lstat per file; 4096 per workspace every 30 minutes is still cheap, and the
 *                        sample is what changes are DETECTED from, so a small sample is a blind spot
 *                        rather than a saving.
 *
 * Every cap is reported (truncated.directories / truncated.files) and now reaches the prompt too, because
 * "新增 0" printed over a tree that was never walked reads as "nothing happened" - which is exactly what
 * the user was told about their own repository.
 *
 *   intervalMinutes 30 - the user's number.
 *   threshold 0.6     - one obvious edit session reaches it; a single stray file does not.
 *   weights .3/.5/.2  - names are the strongest signal of "real work", count the weakest (a build
 *     can add hundreds of files without any of them mattering).
 */
export const MONITOR_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  depth: 6,
  maxDirectories: 512,
  maxFiles: 4096,
  /**
   * No single top-level folder may spend more than this share of the directory budget.
   *
   * Measured 2026-11-23 on "…/Newmark Agent": the repository keeps its archives under archive/ and its
   * code under Newmark2DSH/; the archive tree alone is thousands of directories and, ordered only by
   * recency, it consumed the whole budget before the walk reached packages/. A quarter of the budget per
   * top-level branch leaves room for the other branches, and the rest of the budget still goes to the
   * newest (see heatOf).
   */
  branchShare: 0.25,
  threshold: 0.6,
  countScale: 5,
  nameScale: 8,
  weightCount: 0.3,
  weightName: 0.5,
  weightTime: 0.2,
  maxWorkspaces: 8,
  // A change made WHILE a DSH turn was running in that workspace is almost certainly the agent
  // writing files, not the user. The user's instruction is to weight those far lower, so the
  // default multiplies them by 0.1: ten agent-written files count as one user-written file.
  dshWeight: 0.1,
  dshGraceMs: 90000,
});

const isIgnored = (name) => IGNORED_DIRECTORIES.includes(name);
const nameOf = (entry) => String(entry?.name ?? entry ?? '');
const lowerCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const samePath = (a, b) => lowerCase(path.resolve(a)) === lowerCase(path.resolve(b));
const insidePath = (child, parent) => {
  const inner = lowerCase(path.resolve(child));
  const outer = lowerCase(path.resolve(parent));
  return inner === outer || inner.startsWith(outer + path.sep);
};
/** A directory name as the snapshot spells it: workspace-relative, forward slashes, '.' for the root. */
const dirKey = (relative) => (relative ? relative.split(path.sep).join('/') : '.');

/**
 * The registered workspaces as SCAN PLANS: every workspace is kept, and a parent is told to skip the
 * subtrees that are themselves workspaces.
 *
 * This replaces "collapse the nested root into the parent" (dedupeRoots, removed 2026-11-23). The
 * collapse avoided counting the same files twice, which was right, but it paid for that with VISIBILITY:
 * the parent's walk has a directory budget and a depth, so the nested workspace - often the one the
 * person actually works in - was starved by its own parent. Measured on this machine: under "…/Files/Code",
 * "…/Files/Code/Newmark Agent" (64 sessions, the main repository) had ZERO files in the snapshot, and the
 * proactive brief printed "新增 0" for it. A carve-out keeps the double count away and gives each
 * workspace its own budget, which is what "monitor the trusted workspaces" has to mean.
 */
export function planWorkspaces(roots = []) {
  const unique = uniqueRoots(roots);
  return unique
    .map((root) => ({ root, skip: unique.filter((other) => !samePath(other, root) && insidePath(other, root)) }))
    .sort((a, b) => a.root.length - b.root.length || (a.root < b.root ? -1 : 1));
}

/** Exact duplicates and non-absolute paths only. Nesting is a carve-out decision, not a dedupe one. */
export function uniqueRoots(roots = []) {
  const canonical = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    const resolved = path.resolve(root);
    if (!canonical.some((known) => samePath(known, resolved))) canonical.push(resolved);
  }
  return canonical.sort();
}

/**
 * Per-directory recency, from the PREVIOUS snapshot: the newest mtime known in each directory.
 *
 * The walk's budget is finite, so the order it spends that budget in decides what can be seen at all.
 * Breadth-first order made that decision from the filesystem's own directory order - measured
 * 2026-11-23, which is why an edited repository could be invisible while a stale one was reported.
 * Recency is the only proxy that follows the work, and it is free: the previous name->mtime map is
 * already in the state file. A brand-new directory has no entry there, so its own mtime is used as a
 * fallback (a directory's mtime moves when entries are added, which is when new work starts).
 */
export function heatOf(previous) {
  const heat = new Map();
  for (const [name, mtime] of Object.entries(previous?.files || {})) {
    const sample = Number(mtime) || 0;
    const directory = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.';
    if ((heat.get(directory) || 0) < sample) heat.set(directory, sample);
  }
  return heat;
}

/**
 * The directories a workspace is walked through: bounded, NEVER inside a carved-out sibling workspace,
 * and spent newest-branch-first so a truncated walk still covers where the work is.
 */
export function enumerateDirectories(root, { depth = MONITOR_DEFAULTS.depth, maxDirectories = MONITOR_DEFAULTS.maxDirectories, branchShare = MONITOR_DEFAULTS.branchShare, readdir = fs.readdirSync, stat = fs.statSync, skip = [], heat = new Map() } = {}) {
  const canonical = path.resolve(root);
  const skipList = (skip || []).map((value) => path.resolve(value));
  const directories = [];
  let omitted = 0;
  let skipped = 0;
  const seen = new Set();
  // Fair share per top-level branch, so one big tree cannot spend the whole budget (measured: archive/
  // vs the code it belongs to).
  const share = Number.isFinite(branchShare) ? Math.min(Math.max(branchShare, 0), 1) : MONITOR_DEFAULTS.branchShare;
  const maxPerBranch = Math.max(8, Math.ceil(maxDirectories * share));
  const perBranch = new Map();
  // Two segments, not one: a project keeps its archive and its code under the SAME top-level folder
  // (…/Newmark2DSH/archive vs …/Newmark2DSH/packages), so a one-segment key would still let the archive
  // spend the code's share. Measured 2026-11-23: with one segment the repository's own packages/ never
  // entered the sample.
  const branchOf = (directory) => { const rel = path.relative(canonical, directory); return rel ? rel.split(path.sep).slice(0, 2).join('/') : ''; };
  const queue = [{ directory: canonical, level: 0, rank: Number.POSITIVE_INFINITY }];
  const rankOf = (directory) => {
    const known = heat.get(dirKey(path.relative(canonical, directory))) || 0;
    let own = 0;
    try { own = Number(stat(directory).mtimeMs) || 0; } catch { own = 0; }
    return Math.max(known, own);
  };
  while (queue.length) {
    // Newest branch first: the queue is small (bounded by the directory cap), so a linear scan for the
    // maximum is cheaper and more predictable than sorting it on every push.
    let best = 0;
    for (let index = 1; index < queue.length; index += 1) if (queue[index].rank > queue[best].rank) best = index;
    const { directory, level } = queue.splice(best, 1)[0];
    if (seen.has(directory)) continue;
    const branch = branchOf(directory);
    if (directories.length >= maxDirectories) { omitted += 1; continue; }
    if (branch && (perBranch.get(branch) || 0) >= maxPerBranch) { omitted += 1; continue; }
    seen.add(directory);
    if (branch) perBranch.set(branch, (perBranch.get(branch) || 0) + 1);
    directories.push(directory);
    if (level >= depth) continue;
    let entries;
    try { entries = readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const name = nameOf(entry);
      if (!name || isIgnored(name)) continue;
      if (entry?.isSymbolicLink?.()) continue;
      if (!entry?.isDirectory?.()) continue;
      const child = path.join(directory, name);
      if (skipList.some((excluded) => samePath(excluded, child))) { skipped += 1; continue; }
      queue.push({ directory: child, level: level + 1, rank: rankOf(child) });
    }
  }
  return { root: canonical, directories, omitted, skipped };
}

/**
 * One workspace as the three quantities the user named: a file count, a name->mtime sample, and the
 * newest modification time. Contents are never read.
 *
 * `coverage` is part of the answer, not a debug detail: a snapshot that walked 512 of 993 directories
 * and sampled 4,096 of 9,231 files is a PARTIAL view, and every reader downstream (the diff, the brief,
 * the panel) has to be able to say so.
 *
 * @returns {{ root, at, count, files, maxMtime, coverage, truncated }}
 */
export function scanWorkspace(root, { at = Date.now(), depth = MONITOR_DEFAULTS.depth, maxDirectories = MONITOR_DEFAULTS.maxDirectories, maxFiles = MONITOR_DEFAULTS.maxFiles, branchShare = MONITOR_DEFAULTS.branchShare, readdir = fs.readdirSync, stat = fs.statSync, skip = [], heat = new Map() } = {}) {
  const plan = enumerateDirectories(root, { depth, maxDirectories, branchShare, readdir, stat, skip, heat });
  let count = 0;
  let maxMtime = 0;
  let files = 0;
  const sample = {};
  /**
   * The FILE budget is shared the same way the directory budget is. Measured 2026-11-23: without this,
   * the archives branch filled the 4,096-file sample before the walk reached the code branch, so a file
   * that exists and is edited was still invisible. Fairness beats order here for the same reason.
   */
  const share = Number.isFinite(branchShare) ? Math.min(Math.max(branchShare, 0), 1) : MONITOR_DEFAULTS.branchShare;
  const maxFilesPerBranch = Math.max(64, Math.ceil(maxFiles * share));
  const perBranchFiles = new Map();
  const branchOf = (directory) => { const rel = path.relative(plan.root, directory); return rel ? rel.split(path.sep).slice(0, 2).join('/') : ''; };
  for (const directory of plan.directories) {
    const branch = branchOf(directory);
    let entries;
    try { entries = readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const name = nameOf(entry);
      if (!name) continue;
      if (entry?.isSymbolicLink?.()) continue;
      if (entry?.isDirectory?.()) continue;
      if (!entry?.isFile?.()) continue;
      count += 1;
      if (files >= maxFiles) continue;
      if (branch && (perBranchFiles.get(branch) || 0) >= maxFilesPerBranch) continue;
      let mtime;
      try { mtime = Number(stat(path.join(directory, name)).mtimeMs) || 0; } catch { mtime = 0; }
      files += 1;
      if (branch) perBranchFiles.set(branch, (perBranchFiles.get(branch) || 0) + 1);
      sample[path.relative(plan.root, path.join(directory, name)).split(path.sep).join('/')] = mtime;
      if (mtime > maxMtime) maxMtime = mtime;
    }
  }
  return {
    root: plan.root,
    at,
    count,
    files: sample,
    maxMtime,
    scanVersion: SCAN_VERSION,
    scanShape: { depth, maxDirectories, maxFiles, branchShare: share, skipped: plan.skipped },
    coverage: {
      directories: plan.directories.length,
      omittedDirectories: plan.omitted,
      skippedWorkspaces: plan.skipped,
      countedFiles: count,
      sampledFiles: files,
      omittedFiles: Math.max(0, count - files),
    },
    truncated: { directories: plan.omitted, files: Math.max(0, count - files), skipped: plan.skipped },
  };
}

/**
 * What changed between two snapshots of the same workspace: the three quantities, named.
 *
 * A name that appears or disappears is counted once; a name present in both with a different mtime
 * is counted as changed. `countDelta` is the absolute difference of the file counts, so an
 * add-and-delete pair that nets out still shows up through names.
 */
export function diffSnapshots(previous, next) {
  if (!previous) return { first: true, countDelta: 0, added: 0, removed: 0, changed: 0, names: [], timeDelta: 0 };
  const names = [];
  let added = 0, removed = 0, changed = 0;
  for (const [name, mtime] of Object.entries(next.files)) {
    if (!(name in previous.files)) { added += 1; if (names.length < 20) names.push('+' + name); continue; }
    if (Number(previous.files[name]) !== Number(mtime)) { changed += 1; if (names.length < 20) names.push('*' + name); }
  }
  for (const name of Object.keys(previous.files)) {
    if (!(name in next.files)) { removed += 1; if (names.length < 20) names.push('-' + name); }
  }
  const changes = [];
  for (const [name, mtime] of Object.entries(next.files)) {
    if (!(name in previous.files)) changes.push({ name, kind: 'add', mtime: Number(mtime) || 0 });
    else if (Number(previous.files[name]) !== Number(mtime)) changes.push({ name, kind: 'change', mtime: Number(mtime) || 0 });
  }
  for (const name of Object.keys(previous.files)) if (!(name in next.files)) changes.push({ name, kind: 'remove', mtime: 0 });
  return { first: false, countDelta: Math.abs(next.count - previous.count), added, removed, changed, names, changes, from: Number(previous.at) || 0, to: Number(next.at) || 0, timeDelta: Math.max(0, Number(next.maxMtime) - Number(previous.maxMtime)) };
}

/**
 * The weighted score of ONE interval, in [0,1].
 *
 * Each component is normalized before weighting, because the three live on incomparable scales:
 * a count of 5, a handful of names, and a timestamp delta in milliseconds. `timeDelta` is scaled by
 * the interval, so "the newest file moved forward by one whole interval" is 1.0.
 */
export function scoreDiff(diff, settings = {}, intervalMs = MONITOR_DEFAULTS.intervalMinutes * 60000) {
  const s = { ...MONITOR_DEFAULTS, ...settings };
  const weights = [s.weightCount, s.weightName, s.weightTime].map((w) => (Number.isFinite(w) && w >= 0 ? w : 0));
  const total = weights[0] + weights[1] + weights[2];
  const [wc, wn, wt] = total > 0 ? weights.map((w) => w / total) : [1 / 3, 1 / 3, 1 / 3];
  const countPart = Math.min(1, diff.countDelta / Math.max(1, s.countScale));
  const namePart = Math.min(1, (diff.added + diff.removed + diff.changed) / Math.max(1, s.nameScale));
  const timePart = diff.timeDelta > 0 ? Math.min(1, diff.timeDelta / Math.max(1, intervalMs)) : 0;
  return { score: wc * countPart + wn * namePart + wt * timePart, parts: { count: countPart, names: namePart, time: timePart }, weights: [wc, wn, wt], changedNames: diff.added + diff.removed + diff.changed, countDelta: diff.countDelta, timeDelta: diff.timeDelta };
}

/** Accumulate across intervals; fire when the threshold is reached, then reset. */
export function settle(accumulated, score, settings = {}) {
  const s = { ...MONITOR_DEFAULTS, ...settings };
  const next = Math.min(1, Math.max(0, Number(accumulated) || 0) + Math.max(0, score));
  if (next >= s.threshold) return { fire: true, accumulated: 0, at: next };
  return { fire: false, accumulated: next, at: next };
}

/**
 * Split a diff into "the agent did it" and "the user did it".
 *
 * The only evidence available without watching the file system is the file's own modification time,
 * so that is what this uses: a change whose mtime falls inside a window when a DSH turn was running
 * in that workspace (plus a grace period, because writes land as a turn winds down) is attributed to
 * DSH. Removals carry no mtime, so they are attributed by the coarse question "was an agent working
 * in this workspace at any point during this interval".
 *
 * The result is not a classification to show the user; it is the pair of counts the SCORE uses. DSH
 * changes are multiplied by \`dshWeight\` (default 0.1), which is the user's instruction: an agent
 * saving ten files during a turn must not look like a user editing a project.
 */
export function attributeDiff(diff, windows = [], settings = {}) {
  const s = { ...MONITOR_DEFAULTS, ...settings };
  const weight = Number.isFinite(s.dshWeight) ? Math.min(Math.max(s.dshWeight, 0), 1) : MONITOR_DEFAULTS.dshWeight;
  const grace = Number.isFinite(s.dshGraceMs) ? Math.max(0, s.dshGraceMs) : MONITOR_DEFAULTS.dshGraceMs;
  const inside = (time) => (windows || []).some((window) => time >= (Number(window.from) || 0) - grace && time <= (Number(window.to) || 0) + grace);
  const user = { added: 0, removed: 0, changed: 0 }, dsh = { added: 0, removed: 0, changed: 0 };
  const activeInInterval = (windows || []).some((window) => (Number(window.to) || 0) >= diff.from && (Number(window.from) || 0) <= diff.to);
  for (const change of diff.changes || []) {
    if (change.kind === 'remove') { (activeInInterval ? dsh : user).removed += 1; continue; }
    const bucket = inside(change.mtime) ? dsh : user;
    if (change.kind === 'add') bucket.added += 1; else bucket.changed += 1;
  }
  const dshCount = Math.abs(dsh.added - dsh.removed);
  const userCount = Math.max(0, (Number(diff.countDelta) || 0) - dshCount);
  const effective = {
    countDelta: userCount + weight * dshCount,
    added: user.added + weight * dsh.added,
    removed: user.removed + weight * dsh.removed,
    changed: user.changed + weight * dsh.changed,
    timeDelta: diff.timeDelta,
  };
  return { user, dsh, weight, effective, attributed: user.added + user.removed + user.changed + dsh.added + dsh.removed + dsh.changed };
}

/** Human-readable one-liner for the check-in prompt: facts, never a claim about content. */
export function describeDiff(perWorkspace) {
  const changed = perWorkspace.filter((entry) => entry.changedNames > 0 || entry.countDelta > 0 || entry.timeDelta > 0);
  if (!changed.length) return '';
  return changed
    .map((entry) => {
      const dsh = entry.dsh ? entry.dsh.added + entry.dsh.removed + entry.dsh.changed : 0;
      const agent = dsh ? `（其中 DSH 引起 ${dsh} 个，已按权重 ${entry.dshWeight ?? MONITOR_DEFAULTS.dshWeight} 降权）` : '';
      // A view that did not walk the whole tree says so here as well: this line is what the check-in
      // prompt used to show, and "新增 0" over an unwalked tree is the sentence that misled the user.
      const coverage = entry.coverage || {};
      const partial = coverage.omittedDirectories || coverage.omittedFiles
        ? `（概览是不完整的：只走了 ${coverage.directories ?? '?'} 个目录、取样 ${coverage.sampledFiles ?? '?'} 个文件）`
        : '';
      return `${path.basename(entry.root)}：新增 ${entry.added}、删除 ${entry.removed}、改动 ${entry.changed} 个文件${agent}，数量变化 ${Math.round(entry.countDelta)}，最新修改时间前移 ${Math.round(entry.timeDelta / 60000)} 分钟${partial}`;
    })
    .join('；');
}

/**
 * How many changed names one workspace hands to the digest.
 *
 * The SCORE needs counts; the brief needs names, because "three files changed" cannot be spoken about
 * and "src/a.js and docs/OVERVIEW.md changed" can. The list is bounded here so a workspace that
 * churns a thousand files does not put a thousand paths into the state file; the digest reports what
 * it did not carry.
 */
export const MAX_CHANGE_SAMPLE = 200;

/**
 * The snapshot's own shape version.
 *
 * A snapshot is only comparable with another snapshot taken under the SAME walk parameters. Measured
 * 2026-11-23, on the upgrade that introduced the carve-out: the first pass compared a new 7-workspace
 * sample against the old 3-workspace one and the brief announced "Code：新增 2998、删除 950" - none of
 * which was a change to the person's files, only to the window they were seen through. A sample whose
 * shape moved is a BASELINE, not a difference, and saying otherwise is the same class of lie as
 * "新增 0" over an unwalked tree. Bump SCAN_VERSION whenever the walk's meaning changes.
 */
export const SCAN_VERSION = 2;

/** Scan every root, diff against the previous snapshots and score the whole set. */
export function evaluateWorkspaces({ roots, previous = {}, settings = {}, at = Date.now(), windows = [] }) {
  const s = { ...MONITOR_DEFAULTS, ...settings };
  const snapshots = {};
  const perWorkspace = [];
  let score = 0;
  /**
   * Every registered workspace is scanned as ITSELF, and a parent skips the subtrees that are workspaces
   * of their own (planWorkspaces). The old shape dropped the nested roots instead, so the person's main
   * project was only ever seen through its parent's budget - measured 2026-11-23: zero files visible,
   * and a brief that said "新增 0".
   */
  for (const plan of planWorkspaces(roots || []).slice(0, s.maxWorkspaces)) {
    const root = plan.root;
    const prior = previous[plan.root];
    // The previous snapshot's per-directory recency decides which branches the budget reaches first.
    const scanned = scanWorkspace(root, { at, depth: s.depth, maxDirectories: s.maxDirectories, maxFiles: s.maxFiles, branchShare: s.branchShare, skip: plan.skip, heat: heatOf(prior) });
    /**
     * COMPARABLE OR NOT: a snapshot taken under a different walk shape (deeper, wider, a different
     * carve-out) is a BASELINE, not a difference. Measured 2026-11-23 on the upgrade that introduced the
     * carve-out: without this, the first pass compared a 7-workspace sample against the old 3-workspace
     * one and the brief announced "Code：新增 2998、删除 950" - a change to the window, not to the files.
     */
    const comparable = Boolean(prior) && prior.scanVersion === SCAN_VERSION
      && JSON.stringify(prior.scanShape || null) === JSON.stringify(scanned.scanShape);
    const rebased = Boolean(prior) && !comparable;
    const diff = comparable ? diffSnapshots(prior, scanned) : diffSnapshots(undefined, scanned);
    // Only windows recorded for THIS workspace can explain a change in it; a turn running in
    // another folder does not make this folder's edits the agent's.
    const attributed = attributeDiff(diff, (windows || []).filter((window) => window.root === scanned.root), s);
    const scored = scoreDiff(attributed.effective, s, s.intervalMinutes * 60000);
    snapshots[scanned.root] = scanned;
    perWorkspace.push({ root: scanned.root, first: diff.first, rebased, skipped: plan.skip.length, added: diff.added, removed: diff.removed, changed: diff.changed, user: attributed.user, dsh: attributed.dsh, dshWeight: attributed.weight, ...scored, names: diff.names, changes: (diff.changes || []).slice(0, MAX_CHANGE_SAMPLE), changesOmitted: Math.max(0, (diff.changes || []).length - MAX_CHANGE_SAMPLE), coverage: scanned.coverage, truncated: scanned.truncated });
    // The workspace set is scored by its STRONGEST workspace, not the sum: ten quiet repositories
    // should not add up to one noisy one, and the threshold is then about what changed, not how
    // many folders the user happens to have open.
    score = Math.max(score, scored.score);
  }
  return { at, score, snapshots, perWorkspace, description: describeDiff(perWorkspace) };
}
