import fs from 'node:fs';

export const CORE_PACKAGE = 'newmark2dsh';
export const CORE_REGISTRY = 'https://registry.npmjs.org/';

/** Read only the authoritative latest tag; never select an older version. */
export async function latestCore(fetchImpl = globalThis.fetch) {
  const read = async url => {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`npm 官方源返回 HTTP ${response.status}`);
    const body = await response.text();
    if (!body.trim()) throw new Error('npm 官方源返回空响应，请稍后重试');
    try { return JSON.parse(body); }
    catch { throw new Error('npm 官方源返回非 JSON 响应，请稍后重试'); }
  };
  // The full packument can lag behind dist-tags. Never use its stale latest.
  const tags = await read(`${CORE_REGISTRY}-/package/${CORE_PACKAGE}/dist-tags`);
  const latest = tags.latest;
  if (!/^\d+\.\d+\.\d+$/.test(latest || '')) throw new Error('npm latest 版本信息无效');
  const manifest = await read(`${CORE_REGISTRY}${CORE_PACKAGE}/${latest}`);
  const tarball = `${CORE_REGISTRY}${CORE_PACKAGE}/-/${CORE_PACKAGE}-${latest}.tgz`;
  if (manifest?.name !== CORE_PACKAGE || manifest.version !== latest || manifest.dist?.tarball !== tarball) {
    throw new Error('npm latest 安装包信息不一致，已停止更新');
  }
  const current = coreVersion();
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error('无法读取当前安装的版本号，已停止更新');
  return { ok: true, current, latest, tarball, registry: CORE_REGISTRY };
}

/**
 * The version of the copy that is RUNNING.
 *
 * Read from this package's own manifest, which is the file the loader read to mount the row — so
 * "running" and "the version in this file" are the same fact rather than two that can drift. An
 * unreadable manifest answers the empty string instead of throwing: the caller is a startup
 * check that must stay silent, and a version nobody can read is a state to report, not a crash
 * to raise out of an effect.
 */
export function coreVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '';
  }
}

/**
 * Compare two `x.y.z` versions, numerically, field by field.
 *
 * Answers `1` when `a` is newer, `-1` when `b` is, `0` when they are the same, and
 * `null` when either is not three numeric fields. The null is the point: "cannot compare" is
 * not "equal" and it is certainly not "older", and every caller here treats it as a refusal
 * rather than as a licence to install something.
 */
export function compareVersions(a, b) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ''));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  for (let at = 0; at < 3; at += 1) {
    if (left[at] > right[at]) return 1;
    if (left[at] < right[at]) return -1;
  }
  return 0;
}
