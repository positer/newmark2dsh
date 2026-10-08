/** Virtual-mode UI. The lease owns this process; native capture is read-only. */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from '../../../lib/root.js';
import { menuThemePath } from './desktop-menu-theme.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(os.tmpdir(), 'newmark2dsh-computer-use', 'pet');
let record = null;
let generation = 0;
let starting = null;
let lastError = '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop pet compilation timed out')); }, 30000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output || `Compiler exited ${code}`)); });
  });
}

/** Cache by source hash, so updates cannot launch a stale native executable. */
export async function compileDesktopPet() {
  const source = path.join(here, 'desktop-pet.cs');
  const menuSource = path.join(here, 'desktop-menu.cs');
  const vendor = path.resolve(here, '../vendor/webview2');
  const dlls = ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'];
  const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(menuSource));
  for(const name of dlls) digest.update(fs.readFileSync(path.join(vendor,name)));
  const hash = digest.digest('hex').slice(0, 20);
  const directory = path.join(root, 'bin', hash);
  const executable = path.join(directory, 'newmark-desktop-pet.exe');
  fs.mkdirSync(directory, { recursive: true });
  for(const name of dlls) if(!fs.existsSync(path.join(directory,name))) fs.copyFileSync(path.join(vendor,name),path.join(directory,name));
  if (!fs.existsSync(executable)) {
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const candidate = path.join(directory, `pet-${process.pid}-${crypto.randomBytes(4).toString('hex')}.exe`);
    try {
      await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', ...dlls.slice(0,2).map(name=>`/r:${path.join(directory,name)}`), `/out:${candidate}`, source, menuSource]);
      try { fs.renameSync(candidate, executable); } catch (error) { if (!fs.existsSync(executable)) throw error; }
    } finally { fs.rmSync(candidate, { force: true }); }
  }
  return executable;
}

export function desktopPetState() {
  let window = null;
  if (record) {
    try { window = JSON.parse(fs.readFileSync(path.join(record.directory, 'status.json'), 'utf8')); } catch { /* not ready yet */ }
  }
  const alive = !!record && record.child.exitCode === null && record.child.signalCode === null;
  return { kind: 'virtual-desktop-pet', running: alive && !!window, starting: !!starting, pid: alive ? record.child.pid : null, window, error: lastError || null };
}

export function desktopPetContract() {
  return {
    kind: 'virtual-desktop-pet', name: 'NewMate', platform: 'win32', click_through: 'transparent-pixels-only',
    bounds_source: 'pet-monitor', draggable: true, topmost: true,
    motion: { pet: 'damped-spring-squash-stretch', entrance: true, click: true, exit: true, viewer: 'reversible-smooth-proportional-zoom' },
    size_menu: { trigger: 'right-click', min:0.3, max:3, continuous:true, default:1, base_size_ratio:0.75, scope: 'shared-user-root', persistent: true, initial_size: 'last-selected-multiplier', renderer:'WebView2', appearance:'DSH Menu DOM and live ordered CSS', plugin_css_overrides:true, fallback:'native menu when DSH theme is unavailable' },
    outline: { source: 'image-alpha-silhouette', colors: ['#000000', '#ffffff', '#000000', '#ffffff'], cycle_ms: 3000, hidden_while_any_viewer_expanded: true },
    viewer: { read_only: true, input_forwarding: false, full_screen: 'monitor-containing-pet', close: ['pet-click', 'Escape'], capture: 'isolated-process/EnumDesktopWindows/PrintWindow', stale_frame_timeout_ms: 3000 },
    implicit_stop_paths: ['owner-process-exit'],
  };
}

export async function prepareDesktopPetTransfer(direction) {
  if(!record)throw new Error('Virtual takeover must start NewMate before transferring a window');
  const state=desktopPetState();
  if(!state.window)throw new Error('NewMate has not published its position');
  fs.writeFileSync(path.join(record.directory,'transfer-motion'),direction==='in'?'in':'out');
  const b=state.window.bounds,p=state.window.paint_bounds;
  return {x:b.x+p.x+p.width/2,y:b.y+p.y+p.height/2,petHandle:state.window.hwnd};
}

export async function stopDesktopPet(reason = 'lease_released') {
  const previous = record;
  releaseDesktopPet(reason);
  if (previous) for (let i = 0; i < 30 && previous.child.exitCode === null && previous.child.signalCode === null; i++) await sleep(100);
  return { ok: !previous || previous.child.exitCode !== null || previous.child.signalCode !== null };
}

export function releaseDesktopPet(reason = 'lease_released') {
  generation++;
  const previous = record;
  record = null;
  if (previous) {
    // Graceful close disposes capture first. The fallback targets the ChildProcess
    // object we created, never a process found by name or a recycled PID.
    try { fs.writeFileSync(path.join(previous.directory, 'stop'), reason); } catch { previous.child.kill(); }
    const timer = setTimeout(() => { if (previous.child.exitCode === null) previous.child.kill(); }, 1500);
    timer.unref();
    previous.child.once('exit', () => clearTimeout(timer));
  }
  return { ok: true, stopping: !!previous, reason };
}

export async function startDesktopPet({ ownerPid = process.pid, desktop = 'Default', userRoot } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported_platform' };
  if (record && record.desktop === desktop && desktopPetState().running) return { ok: true, already_running: true, ...desktopPetState() };
  if (starting && starting.desktop === desktop) return starting.promise;
  releaseDesktopPet('mode_changed');
  const epoch = generation;
  const pending = { desktop, promise: null };
  starting = pending;
  pending.promise = (async () => {
    let current;
    try {
      lastError = '';
      const executable = await compileDesktopPet();
      if (epoch !== generation) return { ok: true, skipped: true };
      const directory = fs.mkdtempSync(path.join(root, 'session-'));
      const configPath = path.join(directory, 'config.json');
      const settingsPath = path.join(resolveRoot({ root: userRoot }), 'computer-use', 'desktop-pet.json');
      fs.writeFileSync(configPath, JSON.stringify({ ownerPid, desktop, directory, settingsPath,
        menuThemePath:menuThemePath(resolveRoot({root:userRoot})),menuShellPath:path.join(here,'desktop-menu.html'),menuCachePath:path.join(root,'webview2-cache'),
        asset: path.resolve(here, '../assets/desktop-pet.png') }));
      const child = spawn(executable, [configPath], { windowsHide: true, stdio: 'ignore' });
      current = { child, directory, desktop };
      record = current;
      child.once('error', (error) => { if (epoch === generation) lastError = error.message; });
      child.once('exit', (code) => {
        if (record === current) {
          record = null;
          if (code) { try { lastError = fs.readFileSync(path.join(directory, 'error.json'), 'utf8'); } catch { lastError = `Pet exited ${code}`; } }
        }
        // These are only files created for this exact session, never user files.
        for (const name of ['config.json', 'status.json', 'status.json.tmp', 'menu.html', 'viewer.html', 'frame.png', 'frame.png.tmp', 'capture.json', 'capture.json.tmp', 'capture-error.json', 'capture-error.json.tmp', 'error.json', 'error.json.tmp', 'stop']) {
          try { fs.unlinkSync(path.join(directory, name)); } catch { }
        }
        try { fs.rmdirSync(directory); } catch { }
      });
      for (let i = 0; i < 100; i++) {
        if (epoch !== generation) return { ok: true, skipped: true };
        if (record !== current || child.exitCode !== null) throw new Error(lastError || 'Desktop pet exited during startup');
        if (desktopPetState().running) return { ok: true, ...desktopPetState() };
        await sleep(100);
      }
      throw new Error('Desktop pet did not publish a window within 10 seconds');
    } catch (error) {
      if (epoch === generation) { lastError = error.message; releaseDesktopPet('startup_failed'); }
      return { ok: false, error: error.message };
    } finally { if (starting === pending) starting = null; }
  })();
  return pending.promise;
}

process.once('exit', () => releaseDesktopPet('process_exit'));
