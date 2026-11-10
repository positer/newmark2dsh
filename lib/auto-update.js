/**
 * The startup auto-update: check once per process, install silently, never restart.
 *
 * ## What the switch promises, exactly
 *
 * The user asked for a switch that makes the bundle update itself **without being asked again**:
 * 自动在启动时检查最新并静默更新，不主动重启，等待用户重启完成更新，不通知，全程静默. Every
 * clause is a rule below, and the rules exist because each of them is easy to get wrong in a way
 * that looks helpful.
 *
 * | Clause | Rule here |
 * |---|---|
 * | 启动时检查 | Once per PROCESS, not per page load and not per row re-apply. The loader re-applies this row whenever its config is written, and an update that re-ran on every config write would be a background poller nobody asked for. The receipt's `pid` is the guard. |
 * | 静默更新 | Nothing is returned to a page, pushed to a conversation, or written to a message. The only artefact is the receipt in `<root>/core/auto-update.json`, which the config page reads when the user opens it. |
 * | 不主动重启 | This module never imports the restart helper. An install is a staged install; the process keeps running on the version it started with. |
 * | 等待用户重启完成更新 | The next start reads the version that was installed, so the update completes where the user chose to restart. A staged version is not installed twice: the install compares the version ON DISK with npm, not the version in memory. |
 * | 不通知 | No dialog, no toast, no proactive message. Errors do not become notices either; they go to the failure log the project already keeps, and to this receipt. |
 *
 * ## Why "installed" and "running" are two different numbers
 *
 * The version on disk is what the next process will load; the version in memory is what is
 * executing now. Comparing npm against the RUNNING version would install the same tarball on
 * every restart until the user happened to restart, and comparing npm against the INSTALLED one
 * is what makes "install once, wait for the restart" true. So the check is
 * `installed < npm latest`, the install is attempted only then, and a process whose disk copy
 * is already current says `awaiting_restart` rather than doing anything.
 *
 * ## Failure is quiet but not invisible
 *
 * A check that could not reach npm is a normal offline start, not a failure of the user's
 * machine: it is written to the receipt (`outcome: 'check_failed'`) and nowhere else. An install
 * that was ATTEMPTED and did not land IS a failure, so it is recorded through the project's own
 * failure log as well — the rule 所有失败行为都在 .Newmark 保存 applies to this row too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareVersions, latestCore } from './core-update.js';

/** The receipt's file name, under the core's own directory beside `restart/`. */
export const AUTO_UPDATE_STATE_FILE = 'auto-update.json';

/** How long boot is allowed to finish before the check starts. */
export const AUTO_UPDATE_DELAY_MS = 3000;

/** The receipt's path for a given shared root. Derived, never written down. */
export function autoUpdateStatePath(root) {
  return path.join(root, 'core', AUTO_UPDATE_STATE_FILE);
}

/**
 * Read the receipt, answering `{}` for every way it can be missing.
 *
 * A corrupt or absent receipt is not a reason to skip an update: "I have never checked" and "I
 * cannot read where I wrote the last answer" are the same decision, and both mean check.
 */
export function readAutoUpdateState(root) {
  try {
    const state = JSON.parse(fs.readFileSync(autoUpdateStatePath(root), 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/**
 * Write the receipt atomically, and never throw.
 *
 * The temporary-then-rename shape is the one `lib/durable-state.js` uses, for the same reason:
 * a half-written receipt would be read as a check that happened and would then suppress the
 * next one. A receipt that cannot be written is reported in the return value and dropped —
 * making a silent startup feature throw because a disk is read-only would be the loudest
 * possible failure of a quiet feature.
 */
export function writeAutoUpdateState(root, state) {
  const file = autoUpdateStatePath(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...state }, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, path: file, error: String(error?.message ?? error) };
  }
}

/**
 * The decision, as a pure function, so the rules can be measured without a network or a disk.
 *
 * `reason` is one word per outcome and every word is a different answer the user could later ask
 * about: `disabled` (the switch is off), `version_unreadable` (a version that is not x.y.z),
 * `installed_ahead` (a local build newer than npm, never downgraded), `installed_current` (nothing
 * to do, and nothing was waiting), `awaiting_restart` (the disk is current, the process is not —
 * the update is already staged), `update_available` (act).
 */
export function planAutoUpdate({ enabled, installedVersion, runningVersion, latest }) {
  if (enabled !== true) return { act: false, reason: 'disabled' };
  const order = compareVersions(installedVersion, latest);
  if (order === null) return { act: false, reason: 'version_unreadable' };
  if (order > 0) return { act: false, reason: 'installed_ahead' };
  if (order === 0) {
    const running = compareVersions(runningVersion, latest);
    const staged = running !== null && running < 0;
    return { act: false, reason: staged ? 'awaiting_restart' : 'installed_current' };
  }
  return { act: true, reason: 'update_available', from: String(installedVersion), to: String(latest) };
}

/**
 * One startup pass: at most one network check and at most one install.
 *
 * Every collaborator is injected (`readLatest`, `install`, `now`, `pid`) so the whole decision
 * table is reachable from a gate with no registry, no profile and no clock. `record` is the
 * failure log; it is called only for an install that was attempted, never for a check that
 * could not run.
 */
export async function runAutoUpdate({
  root,
  enabled,
  installedVersion,
  runningVersion,
  readLatest = latestCore,
  install,
  record,
  pid = process.pid,
  now = () => new Date().toISOString(),
}) {
  // Off: no network call, no receipt rewrite. An "off" start must not erase the receipt that
  // says why the last enabled one did what it did.
  if (enabled !== true) return { ok: true, acted: false, reason: 'disabled' };

  const previous = readAutoUpdateState(root);
  if (previous.pid === pid) {
    return { ok: true, acted: false, reason: 'checked_in_this_process', state: previous };
  }

  const base = {
    pid,
    checkedAt: now(),
    running: runningVersion || null,
    installed: installedVersion || null,
  };

  let latest;
  try {
    latest = await readLatest();
  } catch (error) {
    const state = { ...base, outcome: 'check_failed', detail: String(error?.message ?? error) };
    writeAutoUpdateState(root, state);
    return { ok: false, acted: false, reason: 'check_failed', detail: state.detail, state };
  }

  const plan = planAutoUpdate({ enabled: true, installedVersion, runningVersion, latest: latest.latest });
  if (!plan.act) {
    const state = { ...base, latest: String(latest.latest), outcome: plan.reason };
    writeAutoUpdateState(root, state);
    return { ok: true, acted: false, reason: plan.reason, state };
  }

  try {
    const change = await install({ tarball: latest.tarball, registry: latest.registry });
    // `applied` and `restart-required` both mean the tarball is on disk and this process was not
    // restarted. Either way the update is staged, and `pendingRestart` says so from the versions
    // rather than from the plugin manager's own wording.
    const application = String(change?.application ?? '');
    const landed = application === 'applied' || application === 'restart-required';
    const state = {
      ...base,
      latest: String(latest.latest),
      from: plan.from,
      to: plan.to,
      application,
      outcome: landed ? 'installed' : 'install_refused',
      pendingRestart: compareVersions(runningVersion, plan.to) === -1,
    };
    writeAutoUpdateState(root, state);
    if (!landed) {
      record?.({
        code: 'auto_update_refused',
        message: `the startup auto-update from ${plan.from} to ${plan.to} did not land: application=${application || 'none'}`,
        fields: { from: plan.from, to: plan.to, application },
      });
    }
    return { ok: landed, acted: true, reason: state.outcome, state };
  } catch (error) {
    const detail = String(error?.message ?? error);
    const state = { ...base, latest: String(latest.latest), from: plan.from, to: plan.to, outcome: 'install_failed', detail };
    writeAutoUpdateState(root, state);
    record?.({
      code: 'auto_update_failed',
      message: `the startup auto-update from ${plan.from} to ${plan.to} failed: ${detail}`,
      fields: { from: plan.from, to: plan.to },
    });
    return { ok: false, acted: true, reason: 'install_failed', detail, state };
  }
}
