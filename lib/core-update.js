import fs from 'node:fs';

export const CORE_PACKAGE = 'newmark2dsh';
export const CORE_REGISTRY = 'https://registry.npmjs.org/';

/** Read only the authoritative latest tag; never select an older version. */
export async function latestCore(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${CORE_REGISTRY}${CORE_PACKAGE}?newmark=${Date.now()}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`npm 官方源返回 HTTP ${response.status}`);
  const metadata = await response.json();
  const latest = metadata['dist-tags']?.latest;
  if (metadata.name !== CORE_PACKAGE || !/^\d+\.\d+\.\d+$/.test(latest || '')) throw new Error('npm latest 版本信息无效');
  const manifest = metadata.versions?.[latest];
  const tarball = `${CORE_REGISTRY}${CORE_PACKAGE}/-/${CORE_PACKAGE}-${latest}.tgz`;
  if (manifest?.name !== CORE_PACKAGE || manifest.version !== latest || manifest.dist?.tarball !== tarball) {
    throw new Error('npm latest 安装包信息不一致，已停止更新');
  }
  const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  return { ok: true, current, latest, tarball, registry: CORE_REGISTRY };
}
