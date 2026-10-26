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
 *   depth 3           - deep enough to see src/, enough to skip generated trees by name;
 *   maxDirectories 128, maxFiles 2048 - the cost is one lstat per file; 2048 every 30 min is cheap
 *     and covers an ordinary repository. Both caps are reported when hit.
 *   intervalMinutes 30 - the user's number.
 *   threshold 0.6     - one obvious edit session reaches it; a single stray file does not.
 *   weights .3/.5/.2  - names are the strongest signal of "real work", count the weakest (a build
 *     can add hundreds of files without any of them mattering).
 */
export const MONITOR_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  depth: 3,
  maxDirectories: 128,
  maxFiles: 2048,
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

/** The directories a workspace is walked through: bounded, deduplicated, ignoring known noise. */
export function enumerateDirectories(root, { depth = MONITOR_DEFAULTS.depth, maxDirectories = MONITOR_DEFAULTS.maxDirectories, readdir = fs.readdirSync } = {}) {
  const canonical = path.resolve(root);
  const directories = [];
  let omitted = 0;
  const queue = [{ directory: canonical, level: 0 }];
  while (queue.length) {
    const { directory, level } = queue.shift();
    if (directories.length >= maxDirectories) { omitted += 1; continue; }
    directories.push(directory);
    if (level >= depth) continue;
    let entries;
    try { entries = readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const name = nameOf(entry);
      if (!name || isIgnored(name)) continue;
      if (entry?.isSymbolicLink?.()) continue;
      if (!entry?.isDirectory?.()) continue;
      queue.push({ directory: path.join(directory, name), level: level + 1 });
    }
  }
  return { root: canonical, directories, omitted };
}

/**
 * Drop roots that live inside another root.
 *
 * Registered workspaces can nest (measured on this machine: "…/Files/Code" and
 * "…/Files/Code/Newmark Agent" are both registered). Scanning both counts the same files twice, and a
 * turn in the child would also mark the parent as DSH-active, which discounts the USER's own changes
 * there. The topmost root is kept and covers the child.
 */
export function dedupeRoots(roots = []) {
  const canonical = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    const resolved = path.resolve(root);
    if (!canonical.includes(resolved)) canonical.push(resolved);
  }
  return canonical
    .sort((a, b) => a.length - b.length)
    .filter((root, index, all) => !all.slice(0, index).some((parent) => root === parent || root.startsWith(parent + path.sep)));
}

/**
 * One workspace as the three quantities the user named: a file count, a name->mtime sample, and the
 * newest modification time. Contents are never read.
 *
 * @returns {{ root, at, count, files, maxMtime, truncated }}
 */
export function scanWorkspace(root, { at = Date.now(), depth = MONITOR_DEFAULTS.depth, maxDirectories = MONITOR_DEFAULTS.maxDirectories, maxFiles = MONITOR_DEFAULTS.maxFiles, readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  const plan = enumerateDirectories(root, { depth, maxDirectories, readdir });
  let count = 0;
  let maxMtime = 0;
  let files = 0;
  const sample = {};
  for (const directory of plan.directories) {
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
      let mtime;
      try { mtime = Number(stat(path.join(directory, name)).mtimeMs) || 0; } catch { mtime = 0; }
      files += 1;
      sample[path.relative(plan.root, path.join(directory, name)).split(path.sep).join('/')] = mtime;
      if (mtime > maxMtime) maxMtime = mtime;
    }
  }
  return { root: plan.root, at, count, files: sample, maxMtime, truncated: { directories: plan.omitted, files: Math.max(0, count - files) } };
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
      return `${path.basename(entry.root)}：新增 ${entry.added}、删除 ${entry.removed}、改动 ${entry.changed} 个文件${agent}，数量变化 ${Math.round(entry.countDelta)}，最新修改时间前移 ${Math.round(entry.timeDelta / 60000)} 分钟`;
    })
    .join('；');
}

/** Scan every root, diff against the previous snapshots and score the whole set. */
export function evaluateWorkspaces({ roots, previous = {}, settings = {}, at = Date.now(), windows = [] }) {
  const s = { ...MONITOR_DEFAULTS, ...settings };
  const snapshots = {};
  const perWorkspace = [];
  let score = 0;
  for (const root of (roots || []).slice(0, s.maxWorkspaces)) {
    const scanned = scanWorkspace(root, { at, depth: s.depth, maxDirectories: s.maxDirectories, maxFiles: s.maxFiles });
    const diff = diffSnapshots(previous[scanned.root], scanned);
    // Only windows recorded for THIS workspace can explain a change in it; a turn running in
    // another folder does not make this folder's edits the agent's.
    const attributed = attributeDiff(diff, (windows || []).filter((window) => window.root === scanned.root), s);
    const scored = scoreDiff(attributed.effective, s, s.intervalMinutes * 60000);
    snapshots[scanned.root] = scanned;
    perWorkspace.push({ root: scanned.root, first: diff.first, added: diff.added, removed: diff.removed, changed: diff.changed, user: attributed.user, dsh: attributed.dsh, dshWeight: attributed.weight, ...scored, names: diff.names, truncated: scanned.truncated });
    // The workspace set is scored by its STRONGEST workspace, not the sum: ten quiet repositories
    // should not add up to one noisy one, and the threshold is then about what changed, not how
    // many folders the user happens to have open.
    score = Math.max(score, scored.score);
  }
  return { at, score, snapshots, perWorkspace, description: describeDiff(perWorkspace) };
}
