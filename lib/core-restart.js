import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./core-restart.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function probeDesktop() {
  if (process.platform !== 'win32') throw Error('完整重启辅助宿主当前仅支持 Windows 官方 DSH');
  const { stdout } = await execute(powershell, [...args, script, '-Mode', 'Probe', '-HostProcessId', String(process.pid)], { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export async function launchRestart(root, owner) {
  const folder = path.join(root, 'core', 'restart', crypto.randomUUID());
  fs.mkdirSync(folder, { recursive: true });
  // Copy out of the replaceable npm package so the helper survives host/package disposal.
  fs.copyFileSync(script, path.join(folder, 'restart.ps1'));
  const job = path.join(folder, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ owner }));
  // Windows PowerShell exits before executing -File with Node's DETACHED_PROCESS
  // console flags on this host. Start-Process provides a hidden independent process.
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const commandLine = [...args, `"${path.join(folder, 'restart.ps1')}"`, '-Mode', 'Run', '-JobFile', `"${job}"`].join(' ');
  const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${quote(powershell)} -ArgumentList ${quote(commandLine)} -WindowStyle Hidden -RedirectStandardOutput ${quote(path.join(folder, 'helper.stdout.log'))} -RedirectStandardError ${quote(path.join(folder, 'helper.stderr.log'))} -PassThru | Select-Object -ExpandProperty Id`;
  await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
  for (let i = 0; i < 150; i++) {
    const statusFile = path.join(folder, 'status.json');
    if (fs.existsSync(statusFile)) {
      let status;
      try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8').replace(/^\uFEFF/, '')); } catch { await pause(100); continue; }
      if (status.state === 'failed') throw Error(status.detail);
      if (status.state === 'ready') return { folder, commit: () => fs.writeFileSync(path.join(folder, 'go'), '') };
    }
    await pause(100);
  }
  throw Error('本机重启辅助程序未就绪，DSH 保持运行');
}

export function createRestartController(root, dependencies = {}) {
  const probe = dependencies.probe || probeDesktop;
  const launch = dependencies.launch || launchRestart;
  const installed = dependencies.installed || (() => JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  const now = dependencies.now || Date.now;
  const key = Symbol.for('newmark.core.restart');
  const states = globalThis[key] ||= new Map();
  if (!states.has(root)) states.set(root, { pending: null, starting: false });
  const state = states.get(root);
  return {
    async prepare(version) {
      if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('更新版本无效');
      if (state.starting) throw Error('DSH 正在重启');
      const owner = await probe();
      const ticket = crypto.randomUUID();
      state.pending = { ticket, version, owner, expires: now() + 30 * 60 * 1000 };
      return { ok: true, ticket };
    },
    async restart(ticket) {
      if (state.starting || !state.pending || state.pending.ticket !== ticket || now() > state.pending.expires) throw Error('重启请求已失效，请重新检查更新');
      if (installed() !== state.pending.version) throw Error('安装版本未通过核验，不执行重启');
      state.starting = true;
      try {
        const result = await launch(root, state.pending.owner);
        state.pending = null;
        let finished = false;
        return {
          folder: result.folder,
          commit() { if (!finished) { finished = true; result.commit(); } },
          cancel() { if (!finished) { finished = true; state.starting = false; } },
        };
      } catch (error) { state.starting = false; throw error; }
    },
  };
}
