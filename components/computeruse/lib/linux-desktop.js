// Linux X11 bridge. The helper owns kernel leases and a private X server; DISPLAY is never
// mutated in the DSH process. Native Wayland must not silently become physical input.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
let child;
let serial = 0;
const pending = new Map();
let diagnostics = '';
function start() {
  if (child) return;
  const env = { ...process.env, QT_QPA_PLATFORM: 'xcb' };
  // WSLg's Mesa driver otherwise falls back to llvmpipe when the Windows
  // bridge libraries are missing from the loader path. Respect driver overrides.
  if (fs.existsSync('/dev/dxg') && fs.existsSync('/usr/lib/wsl/lib/libd3d12.so')) {
    env.GALLIUM_DRIVER ??= 'd3d12';
    env.LD_LIBRARY_PATH = ['/usr/lib/wsl/lib', env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  const p = spawn('python3', [fileURLToPath(new URL('./linux-desktop.py', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'pipe'], env,
  });
  child = p;
  let buffer = '';
  p.stderr.on('data', chunk => {
    diagnostics = (diagnostics + chunk).slice(-4096);
    if (process.env.NEWMARK_LINUX_LOG) fs.appendFileSync(process.env.NEWMARK_LINUX_LOG, chunk);
  });
  p.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try {
        const reply = JSON.parse(line); const item = pending.get(reply.id);
        if (item) { pending.delete(reply.id); clearTimeout(item.timer); item.resolve(reply.result); }
      } catch { /* Native diagnostics belong on stderr, never in the model result. */ }
    }
  });
  const failed = error => {
    if (child === p) child = undefined;
    for (const [id, item] of pending) {
      if (item.process !== p) continue;
      clearTimeout(item.timer); item.reject(new Error(`${error}; ${diagnostics}`)); pending.delete(id);
    }
  };
  p.on('error', failed); p.on('exit', code => failed(`Linux desktop helper exited (${code})`));
}
export async function linuxDesktop(options) {
  if (!process.env.DISPLAY) return { ok: false, error_code: 'virtual_mode_unsupported',
    error: 'An X11 display is required. Native Wayland requires compositor/Portal integration.', fallback_to_real_delivery: false };
  start();
  const id = ++serial;
  // Do not serialize AbortSignal or host objects into the native protocol.
  const { signal, ...args } = options;
  if (signal?.aborted) return { ok: false, error_code: 'cancelled' };
  return await new Promise((resolve, reject) => {
    const processForRequest = child;
    const timer = setTimeout(() => {
      pending.delete(id);
      // Kill a stalled helper so a timed-out request cannot deliver input later.
      processForRequest.kill('SIGTERM'); reject(new Error('Linux desktop request timed out'));
    }, 75000);
    pending.set(id, { resolve, reject, timer, process: processForRequest });
    processForRequest.stdin.write(JSON.stringify({ id, options: args }) + '\n');
  });
}
export function stopLinuxDesktop() { const previous = child; child = undefined; previous?.stdin.end(); }
