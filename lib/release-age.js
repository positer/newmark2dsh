/**
 * The profile's pnpm release-age policy, and the one entry in it this package owns.
 *
 * ## What the policy is, and why it is the profile's business
 *
 * pnpm 11 enforces `minimumReleaseAge` (default 1440 minutes) on EVERY lockfile entry, not only on
 * the package being installed: a run prints "Verifying lockfile against supply-chain policies (N
 * entries)" and, when an entry is younger than the cutoff and no exclusion names it, exits with
 * `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. MEASURED 2026-11-19 on this machine: a copy of the
 * live profile with `--frozen-lockfile` failed on two entries — `newmark2dsh@0.3.84` (published
 * 8 h earlier) and `dsh-pighub@1.0.11` (16 h earlier) — and the DSH plugin manager runs exactly
 * that kind of frozen install, which is why a plugin published today can make every other
 * plugin's update and DSH's own update fail.
 *
 * The policy itself is the user's: this module never writes `minimumReleaseAge`, and never
 * changes how long the waiting period is.
 *
 * ## Why the exemption is a bare package name and not a version list
 *
 * pnpm adds exclusions by itself when it can resolve interactively, and it writes them as
 * `name@version` (several versions joined with `||`). That list is stale the moment the package
 * publishes again, and a stale list is exactly the state that broke the profile: the live
 * `pnpm-workspace.yaml` named `newmark2dsh@0.2.24 || 0.2.26 || 0.2.33 || 0.3.80 || 0.3.81 ||
 * 0.3.82` while 0.3.84 was installed. A bare `newmark2dsh` covers every version — including ones
 * not published yet — so it cannot go stale, and it is idempotent.
 *
 * ## Why it is this package's name and nothing else
 *
 * An exemption is profile-wide authority: whatever it names skips the waiting period. Writing
 * another package's name would be this bundle deciding that someone else's release may bypass a
 * policy the user set, which is the permission overflow this module exists to avoid. MEASURED
 * 2026-11-19: with only `newmark2dsh` exempted, a fresh `dsh-pighub@1.0.11` in the same lockfile
 * still fails the check and is named in the error — the exemption really is scoped to one package.
 *
 * ## Why this package repairs the profile at mount
 *
 * DSH installs with a frozen lockfile, so pnpm never gets the resolution step in which it would
 * add the exclusion itself; without a repair the profile stays broken until someone happens to
 * run pnpm in a terminal. The repair is idempotent (a correct file is not rewritten), atomic
 * (temporary file + rename), and reports a receipt either way.
 *
 * The module is split into a pure text function (`applySelfExemption`) and one file operation
 * (`ensureSelfExemption`), so the decision table can be measured with no disk, no profile and no
 * host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** The pnpm setting this module is allowed to touch. Nothing else in the file is edited. */
export const RELEASE_AGE_KEY = 'minimumReleaseAgeExclude';

/** The package whose versions this bundle may exempt: its own. */
export const SELF_PACKAGE = 'newmark2dsh';

/** The workspace manifest pnpm reads these settings from. */
export const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';

/**
 * The package name a spec names, with any version part removed.
 *
 * Handles the scoped form too (`@scope/name@1.2.3` → `@scope/name`), because a parser that
 * splits on the first `@` would read every scoped package as the empty name and then treat its
 * entries as ours — the one mistake in this file that could widen the exemption.
 */
export function packageNameOf(spec) {
  const text = String(spec ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (text === '') return '';
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * The exclusion list after this bundle's rule is applied, as data.
 *
 * Rule: exactly one bare `newmark2dsh` entry, every other package's entry kept verbatim and in
 * its original order. Version-pinned entries for this package are dropped — they are the stale
 * form, and keeping them alongside the bare name would leave the file saying two things.
 *
 * A bare entry that is already present keeps its position, so running this twice changes nothing.
 */
export function planSelfExemption(specs) {
  const kept = [];
  const removed = [];
  let bareSeen = false;
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (packageNameOf(spec) === SELF_PACKAGE) {
      if (spec === SELF_PACKAGE && !bareSeen) {
        bareSeen = true;
        kept.push(spec);
      } else {
        removed.push(spec);
      }
      continue;
    }
    kept.push(spec);
  }
  const added = bareSeen ? [] : [SELF_PACKAGE];
  const next = bareSeen ? kept : [...kept, SELF_PACKAGE];
  const changed = next.length !== specs.length || next.some((value, index) => value !== specs[index]);
  return { specs: next, added, removed, changed };
}

/** Split an inline flow list (`[a, b]`) into its items, without a YAML dependency. */
function inlineItems(value) {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter((item) => item !== '');
}

/**
 * The workspace manifest's text, with this bundle's entry ensured. Pure: text in, text out.
 *
 * Only the `minimumReleaseAgeExclude` block is rewritten. Every other line — `packages`,
 * `nodeLinker`, other settings, other packages' exclusions, comments — is copied through
 * byte-for-byte, because this module has no authority over any of it.
 */
export function applySelfExemption(text) {
  const source = String(text ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = source === '' || /\r?\n$/.test(source);
  const body = trailing ? source.replace(/\r?\n$/, '') : source;
  const lines = body === '' ? [] : body.split(/\r?\n/);

  const keyAt = lines.findIndex((line) => new RegExp('^' + RELEASE_AGE_KEY + '\\s*:').test(line));
  const current = [];
  let end = keyAt;

  if (keyAt !== -1) {
    const after = lines[keyAt].slice(lines[keyAt].indexOf(':') + 1).trim();
    if (after !== '') {
      current.push(...inlineItems(after));
    } else {
      end = keyAt;
      for (let at = keyAt + 1; at < lines.length; at += 1) {
        const item = /^\s*-\s+(.*)$/.exec(lines[at]);
        if (item === null) break;
        current.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        end = at;
      }
    }
  }

  // The rule always ends with one bare entry, so the block is never empty and a block that
  // already exists is always rewritten in place.
  const plan = planSelfExemption(current);
  const block = [RELEASE_AGE_KEY + ':', ...plan.specs.map((spec) => '  - ' + spec)];

  const next = keyAt === -1
    ? [...lines, ...(lines.length > 0 && lines[lines.length - 1].trim() !== '' ? [''] : []), ...block]
    : [...lines.slice(0, keyAt), ...block, ...lines.slice(end + 1)];

  const changed = next.length !== lines.length || next.some((line, index) => line !== lines[index]);
  const output = next.join(eol) + (trailing && next.length > 0 ? eol : '');
  return { text: changed ? output : source, changed, added: plan.added, removed: plan.removed, specs: plan.specs };
}

/** The manifest's path for a profile directory. Derived, never written down. */
export function workspaceManifestPath(profileDir) {
  return path.join(profileDir, WORKSPACE_MANIFEST);
}

/**
 * The profile this copy is installed into, from its own location.
 *
 * `<profile>/node_modules/newmark2dsh` is the profile; anything else (a source checkout, a linked
 * dev tree) has no profile to repair and says so rather than guessing at one of the several
 * profiles under the DSH home — repairing the wrong profile would be a write nobody asked for.
 */
export function locateProfileDir(packageDir) {
  const parent = path.dirname(String(packageDir ?? ''));
  if (path.basename(parent) !== 'node_modules') {
    return { ok: false, reason: 'not_installed_under_node_modules', packageDir: String(packageDir ?? '') };
  }
  return { ok: true, dir: path.dirname(parent), packageDir: String(packageDir ?? '') };
}

/**
 * Ensure the entry on disk. Answers a receipt for every outcome, and never throws.
 *
 * `no_workspace_file` is deliberately not repaired: creating a workspace manifest would assert a
 * workspace layout this bundle did not choose. A profile DSH built always has one.
 */
export async function ensureSelfExemption({ profileDir, now = () => new Date().toISOString() } = {}) {
  const at = now();
  if (typeof profileDir !== 'string' || profileDir.trim() === '') {
    return { ok: false, reason: 'profile_dir_missing', at };
  }
  const file = workspaceManifestPath(profileDir);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'no_workspace_file' : 'unreadable';
    return { ok: false, reason: code, path: file, at, detail: String(error?.message ?? error) };
  }

  const plan = applySelfExemption(source);
  if (!plan.changed) {
    return { ok: true, changed: false, path: file, specs: plan.specs, at };
  }

  try {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, plan.text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    return { ok: false, reason: 'write_failed', path: file, at, detail: String(error?.message ?? error) };
  }

  return { ok: true, changed: true, path: file, specs: plan.specs, added: plan.added, removed: plan.removed, at };
}
