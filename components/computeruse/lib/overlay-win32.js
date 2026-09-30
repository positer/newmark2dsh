/**
 * Newmark ComputerUse - the native, screen-wide takeover overlay (Windows).
 *
 * The takeover *lease* lives in ./win32.js. This module owns the visible half of it:
 * one borderless, topmost, click-through WinForms window whose bounds are the whole
 * virtual screen and whose only painted content is the frozen black/white marquee
 * running along the outer edge of the screen.
 *
 * Why it is native and not the DSH page's CSS ring: the ring in `client.js` is anchored
 * to the DSH window's viewport and its lease snapshot is taken at page load, so it wraps
 * the wrong rectangle and it can never clear itself. The reference implementation draws
 * the effect in its own WinForms window for exactly that reason - "the desktop overlay
 * cannot reuse CSS masks directly because it is a native WinForms edge-only overlay"
 * (docs/00-governance.md, finding F-2.14b; original source:
 * DESKTOP/src/tools/computerUse.ts, `startTakeoverOverlay`).
 *
 * Layout of this file
 *   1. constants, verified against the original source
 *   2. the C# Win32 helper, compiled with Add-Type behind a type guard
 *   3. the generated overlay script (one .ps1, hosted by a hidden powershell.exe)
 *   4. the lane scripts that start, probe and stop it
 *   5. the lifecycle: startOverlay / stopOverlay / overlayState / releaseOverlay
 *
 * Conventions copied from ./win32.js: no dependency beyond the Node builtins, C# inline
 * through Add-Type, every entry point guarded, and a structured error object - never a
 * throw - when something fails. It drives the *existing* PowerShell lanes
 * (`prepareLane` / `runInLane`) instead of owning a worker of its own; the overlay window
 * itself has to be a separate OS process because a WinForms message loop cannot run
 * inside the lane's request/response host.
 *
 * A leaked topmost click-through window is worse than no overlay at all, so every exit
 * path - `takeover_stop`, `stopAll()`, process exit - funnels into one
 * idempotent stopper, every host is identified by its command line rather than by a pid
 * alone, and the window additionally closes itself within ~1 s when its owning process
 * disappears.
 *
 * There is deliberately **no time limit** on the takeover overlay. A lease used to expire
 * after 120 s and take the window down with it; that path is gone, so stopping is the job
 * of an explicit `takeover_stop`. The one path that is *not* an explicit tool call is the
 * window's own 1 s owner-process watchdog: if the owning process dies, this topmost,
 * click-through, screen-wide window would otherwise cover the user's desktop with nothing
 * inside the app left to remove it. It is kept for exactly that reason and is reported in
 * `overlay_contract.implicit_stop_paths` so it is never a silent stop path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareLane, runInLane } from './win32.js';

/* ------------------------------------------------------------------ *
 * 1. constants (each one checked against DESKTOP/src/tools/computerUse.ts)
 * ------------------------------------------------------------------ */

/** The lane that carries the overlay's start/probe/stop scripts. */
export const OVERLAY_LANE = 'action';
/** Hard-coded four-stop palette of the original; incoming colour arguments were discarded. */
export const OVERLAY_COLORS = Object.freeze(['#000000', '#ffffff', '#000000', '#ffffff']);
/** Border thickness, in the overlay host's own (system-DPI-unaware) pixels. */
export const OVERLAY_WIDTH_PX = 2;
/** One full clockwise lap of the perimeter: the original's hard-coded `speed = 3` seconds. */
export const OVERLAY_CYCLE_MS = 3000;
/** Repaint tick of the marquee. */
export const OVERLAY_TIMER_INTERVAL_MS = 33;
/** Interpolated SolidBrush colours around the four-stop palette. */
export const OVERLAY_BRUSH_STEPS = 256;
/** How often the window checks that its owning process is still alive. */
export const OVERLAY_OWNER_WATCHDOG_MS = 1000;
/**
 * Lifetime of a *pulse* overlay. The original's `pulseTakeoverOverlay()` starts an
 * overlay for 2500 ms when a mutating action runs without a lease (F-2.14c). It is the
 * pulse's lifetime, not the marquee's period: the stroke laps the perimeter in 3000 ms.
 */
export const OVERLAY_PULSE_MS = 2500;

const OVERLAY_SCRIPT_PREFIX = 'newmark-cu-takeover-overlay-';
const OVERLAY_STATUS_PREFIX = 'newmark-cu-takeover-status-';
const OVERLAY_DIRECTORY_NAME = 'newmark2dsh-computer-use';
const OVERLAY_SUBDIRECTORY_NAME = 'overlay';
const OVERLAY_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Command-line shape of a live overlay host, as `Get-CimInstance Win32_Process` reports
 * it. A host is identified by this pattern and never by a pid alone, so a recycled pid
 * can never be killed by mistake.
 */
const OVERLAY_COMMAND_PATTERN = `(?i)-File\\s+"?[^"\\s]*${OVERLAY_SCRIPT_PREFIX}[^"\\s]*\\.ps1"?`;
const OVERLAY_LAUNCH_WAIT_MS = 6000;
const OVERLAY_LANE_TIMEOUT_MS = 25000;
const OVERLAY_PREPARE_TIMEOUT_MS = 30000;
const OVERLAY_SWEEP_WAIT_MS = 1500;
const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * 2. the C# helper, compiled with Add-Type behind a type guard
 * ------------------------------------------------------------------ */

/**
 * The P/Invoke class carries no `System.Drawing` dependency, so the lane can compile it
 * on its own for a read-only probe. The host compiles it together with the Form in a
 * *single* `Add-Type` call, because a second call cannot see the first call's types.
 *
 * The original also used `GetWindowLong`/`SetWindowLong`/`SetWindowPos` and the same
 * `HWND_TOPMOST` re-assert with `SWP_NOACTIVATE`. `GetWindowRect`, `IsWindowVisible` and
 * `WindowFromPoint` are added here so a probe can prove the covering rectangle and the
 * click-through property from a process that did not create the window.
 */
const OVERLAY_NATIVE_CLASS = `public static class NewmarkCuOverlayWin32 {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_LAYERED = 0x00080000;
  public const int WS_EX_TOPMOST = 0x00000008;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr ChildWindowFromPointEx(IntPtr hWndParent, POINT point, uint flags);

  public const uint CWP_SKIPINVISIBLE = 0x0001;
  public const uint CWP_SKIPDISABLED = 0x0002;
  public const uint CWP_SKIPTRANSPARENT = 0x0004;

  public static bool HasStyle(int exStyle, int style) { return (exStyle & style) == style; }

  public static string RectJson(IntPtr hWnd) {
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return "null";
    return "{\\"left\\":" + rect.Left + ",\\"top\\":" + rect.Top + ",\\"width\\":" + (rect.Right - rect.Left) + ",\\"height\\":" + (rect.Bottom - rect.Top) + "}";
  }

  /** Which window a real click at this screen point would reach; a WS_EX_TRANSPARENT overlay is skipped. */
  public static long HitTestAt(int x, int y) {
    POINT point;
    point.X = x;
    point.Y = y;
    return WindowFromPoint(point).ToInt64();
  }

  /**
   * The same hit test with the documented "skip WS_EX_TRANSPARENT" rule, which is the rule
   * that decides whether input reaches the window underneath the takeover.
   */
  public static long HitTestSkippingTransparent(int x, int y) {
    POINT point;
    point.X = x;
    point.Y = y;
    return ChildWindowFromPointEx(GetDesktopWindow(), point, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT).ToInt64();
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  public const uint CREATE_NO_WINDOW = 0x08000000;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(string lpApplicationName, System.Text.StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  /**
   * Start a detached, windowless process: no console window (so it cannot take the
   * foreground the way a freshly created console does) and no inherited handles (so it
   * cannot keep a lane pipe alive after the lane that spawned it is gone).
   */
  public static int SpawnHidden(string application, string arguments) {
    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    System.Text.StringBuilder commandLine = new System.Text.StringBuilder("\\"" + application + "\\" " + arguments);
    bool created = CreateProcess(application, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out process);
    if (!created) return 0;
    int pid = process.dwProcessId;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return pid;
  }
}`;

/**
 * The overlay window: opaque (nothing behind the ring is ever repainted), double
 * buffered, and shown without activation. `CreateParams` carries the extended styles the
 * reference sets with `SetWindowLong`, so the window is click-through, topmost and out of
 * the taskbar from its very first frame rather than from the first `Shown` event onward;
 * the `Shown` handler then re-asserts topmost exactly the way the reference does.
 *
 * `TopMost` is deliberately *not* set as a WinForms property. Measured on this desktop:
 * `Form.TopMost = true` activates the window, so the takeover would pull the foreground
 * away from whatever the operator is doing. `WS_EX_TOPMOST` here plus the reference's own
 * `SetWindowPos(HWND_TOPMOST, 鈥?| SWP_NOACTIVATE)` give the same topmost window without
 * the activation.
 */
const OVERLAY_FORM_CLASS = `public class NewmarkCuOverlayForm : Form {
  public NewmarkCuOverlayForm() {
    this.DoubleBuffered = true;
    this.SetStyle(ControlStyles.Opaque, true);
    this.SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    this.UpdateStyles();
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnPaintBackground(PaintEventArgs e) { }
  protected override CreateParams CreateParams {
    get {
      CreateParams parameters = base.CreateParams;
      parameters.ExStyle |= NewmarkCuOverlayWin32.WS_EX_TRANSPARENT | NewmarkCuOverlayWin32.WS_EX_TOOLWINDOW | NewmarkCuOverlayWin32.WS_EX_TOPMOST;
      return parameters;
    }
  }
}`;

const OVERLAY_NATIVE_CSHARP = ['using System;', 'using System.Runtime.InteropServices;', '', OVERLAY_NATIVE_CLASS].join('\n');
const OVERLAY_HOST_CSHARP = [
  'using System;',
  'using System.Drawing;',
  'using System.Runtime.InteropServices;',
  'using System.Windows.Forms;',
  '',
  OVERLAY_NATIVE_CLASS,
  '',
  OVERLAY_FORM_CLASS,
].join('\n');
/** The file the host writes when its C# will not compile, so the failure is not silent. */
const OVERLAY_COMPILE_ERROR_SUFFIX = '.compile-error.txt';

/* ------------------------------------------------------------------ *
 * 3. small guarded helpers
 * ------------------------------------------------------------------ */

/** Single-quote a value for PowerShell, doubling embedded quotes (same rule as win32.js). */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A structured failure raised from inside a lane script (same wire format as win32.js). */
function psError(code, message) {
  return `throw "newmark_cu_error::${code}::${message}"`;
}

/** Read a structured lane failure back out of a PowerShell error string. */
function parsePsError(output) {
  const text = String(output === null || output === undefined ? '' : output);
  const match = /newmark_cu_error::([a-z0-9_]+)::([\s\S]*)/i.exec(text);
  if (!match) return { code: 'lane_script_failed', message: text.trim() || 'The lane script failed.' };
  const message = match[2].split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || 'The lane script failed.';
  return { code: match[1].toLowerCase(), message };
}

/** Structured failure; `extra` is copied first so the core fields always win. */
function failure(action, code, message, extra = {}) {
  return { ...extra, ok: false, action, error_code: code, error: message };
}

function clampNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

/** The last line of lane output that parses as a JSON object. */
function lastJsonObject(output) {
  const lines = String(output === null || output === undefined ? '' : output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function nonce() {
  let value = '';
  try {
    value = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  } catch {
    value = String(Date.now() % 0xffffffff);
  }
  return `${Date.now().toString(16)}${value}`.slice(-16);
}

let prunedOverlayDirectory = false;
function overlayDirectory() {
  const directory = path.join(os.tmpdir(), OVERLAY_DIRECTORY_NAME, OVERLAY_SUBDIRECTORY_NAME);
  fs.mkdirSync(directory, { recursive: true });
  if (prunedOverlayDirectory) return directory;
  prunedOverlayDirectory = true;
  try {
    const cutoff = Date.now() - OVERLAY_STATUS_MAX_AGE_MS;
    for (const entry of fs.readdirSync(directory)) {
      const target = path.join(directory, entry);
      const stat = fs.statSync(target);
      if (stat.mtimeMs < cutoff) fs.rmSync(target, { force: true });
    }
  } catch { /* best effort */ }
  return directory;
}

/* ------------------------------------------------------------------ *
 * 4. the overlay host script
 * ------------------------------------------------------------------ */

/**
 * The generated `.ps1`. It is the original `startTakeoverOverlay` body with three
 * additions and no removals: it reports its own window back through a status file, it
 * closes itself when its duration elapses, and `ShowWithoutActivation` plus the
 * `SWP_NOACTIVATE` re-assert keep the takeover from stealing focus.
 */
function buildOverlayScript(options) {
  const colors = (options.colors || OVERLAY_COLORS).map(String);
  const host = OVERLAY_HOST_CSHARP.split('\n');
  const lines = [
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$script:statusPath = ${psQuote(options.statusPath)}`,
    '$script:compileError = \'\'',
    'try {',
    '  if (-not ("NewmarkCuOverlayWin32" -as [type]) -or -not ("NewmarkCuOverlayForm" -as [type])) {',
    '    Add-Type -ReferencedAssemblies @("System.Windows.Forms", "System.Drawing") -TypeDefinition @\'',
    ...host,
    '\'@',
    '  }',
    '} catch { $script:compileError = [string]$_ }',
    'if ($script:compileError -ne \'\') {',
    '  try { [System.IO.File]::WriteAllText(($script:statusPath + ".compile-error.txt"), $script:compileError, (New-Object System.Text.UTF8Encoding($false))) } catch { }',
    '  exit 1',
    '}',
    `$script:ownerPid = ${options.ownerPid}`,
    `$script:durationMs = ${options.durationMs}`,
    `$script:lifecycle = ${psQuote(options.lifecycle)}`,
    `$script:thick = ${options.widthPx}`,
    `$script:speedSeconds = ${(options.cycleMs / 1000).toFixed(3)}`,
    `$script:brushSteps = ${options.brushSteps}`,
    `$script:timerIntervalMs = ${options.timerIntervalMs}`,
    `$script:watchdogMs = ${options.watchdogMs}`,
    `$script:colorHex = @(${colors.map(psQuote).join(',')})`,
    '$script:closeReason = \'\'',
    '$script:topmostReasserted = $false',
    '$script:startedAt = (Get-Date).ToString(\'o\')',
    '$script:form = $null',
    '$script:stopwatch = $null',
    '$script:brushes = New-Object System.Collections.Generic.List[System.Drawing.SolidBrush]',
    '$script:colors = New-Object System.Collections.Generic.List[System.Drawing.Color]',
    '',
    'function Write-OverlayStatus {',
    '  param([string]$phase, [string]$closeReason)',
    '  try {',
    '    $hwnd = [int64]0',
    '    if ($script:form -ne $null -and $script:form.IsHandleCreated) { $hwnd = $script:form.Handle.ToInt64() }',
    '    $exStyle = 0',
    '    if ($hwnd -ne 0) { $exStyle = [NewmarkCuOverlayWin32]::GetWindowLong([IntPtr]::new([int64]$hwnd), [NewmarkCuOverlayWin32]::GWL_EXSTYLE) }',
    '    $clientWidth = 0; $clientHeight = 0',
    '    $boundsLeft = 0; $boundsTop = 0; $boundsWidth = 0; $boundsHeight = 0',
    '    if ($script:form -ne $null) {',
    '      $clientWidth = $script:form.ClientSize.Width; $clientHeight = $script:form.ClientSize.Height',
    '      $boundsLeft = $script:form.Bounds.Left; $boundsTop = $script:form.Bounds.Top',
    '      $boundsWidth = $script:form.Bounds.Width; $boundsHeight = $script:form.Bounds.Height',
    '    }',
    '    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '    $payload = [ordered]@{',
    '      phase = $phase',
    '      pid = $PID',
    '      session_id = (Get-Process -Id $PID).SessionId',
    '      sta = [System.Threading.Thread]::CurrentThread.ApartmentState.ToString()',
    '      owner_pid = $script:ownerPid',
    '      lifecycle = $script:lifecycle',
    '      duration_ms = $script:durationMs',
    '      started_at = $script:startedAt',
    '      closed_at = $(if ($phase -eq \'closed\') { (Get-Date).ToString(\'o\') } else { $null })',
    '      close_reason = $closeReason',
    '      hwnd = $hwnd',
    '      hwnd_hex = ("0x" + $hwnd.ToString("x"))',
    '      ex_style = $exStyle',
    '      ex_style_hex = ("0x" + $exStyle.ToString("x"))',
    '      ws_ex_transparent = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_TRANSPARENT)',
    '      ws_ex_toolwindow = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_TOOLWINDOW)',
    '      ws_ex_layered = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_LAYERED)',
    '      ws_ex_topmost = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_TOPMOST)',
    '      ws_ex_noactivate = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_NOACTIVATE)',
    '      transparency_key_used = $false',
    '      topmost_reasserted = $script:topmostReasserted',
    '      show_in_taskbar = $false',
    '      bounds = [ordered]@{ left = $boundsLeft; top = $boundsTop; width = $boundsWidth; height = $boundsHeight }',
    '      client = [ordered]@{ width = $clientWidth; height = $clientHeight }',
    '      virtual_screen = [ordered]@{ left = $screen.Left; top = $screen.Top; width = $screen.Width; height = $screen.Height }',
    '      bounds_equal_virtual_screen = (($boundsLeft -eq $screen.Left) -and ($boundsTop -eq $screen.Top) -and ($boundsWidth -eq $screen.Width) -and ($boundsHeight -eq $screen.Height))',
    '      border_width_px = $script:thick',
    '      brush_count = $script:brushes.Count',
    '      timer_interval_ms = $script:timerIntervalMs',
    '      cycle_ms = [int][Math]::Round($script:speedSeconds * 1000)',
    '      colors = $script:colorHex',
    '      fill_mode = "Winding"',
    '      region = "edge-only: top + right + bottom + left rectangles"',
    '      process_dpi_aware = $false',
    '      powershell = $PSVersionTable.PSVersion.ToString()',
    '    }',
    '    $json = $payload | ConvertTo-Json -Compress -Depth 8',
    '    $temp = $script:statusPath + ".tmp"',
    '    [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))',
    '    Move-Item -LiteralPath $temp -Destination $script:statusPath -Force',
    '  } catch { }',
    '}',
    '',
    'foreach ($hex in $script:colorHex) { $script:colors.Add([System.Drawing.ColorTranslator]::FromHtml($hex)) | Out-Null }',
    'for ($brushIndex = 0; $brushIndex -lt $script:brushSteps; $brushIndex++) {',
    '  $wrapped = (($brushIndex / [double]$script:brushSteps) * $script:colors.Count) % $script:colors.Count',
    '  $idx = [int][Math]::Floor($wrapped)',
    '  $next = ($idx + 1) % $script:colors.Count',
    '  $t = $wrapped - $idx',
    '  $a = $script:colors[$idx]',
    '  $b = $script:colors[$next]',
    '  $color = [System.Drawing.Color]::FromArgb([int][Math]::Round($a.A + (($b.A - $a.A) * $t)), [int][Math]::Round($a.R + (($b.R - $a.R) * $t)), [int][Math]::Round($a.G + (($b.G - $a.G) * $t)), [int][Math]::Round($a.B + (($b.B - $a.B) * $t)))',
    '  $script:brushes.Add((New-Object System.Drawing.SolidBrush($color))) | Out-Null',
    '}',
    '',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$script:form = New-Object NewmarkCuOverlayForm',
    '$script:form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$script:form.ShowInTaskbar = $false',
    // Deliberately not `$script:form.TopMost = $true`: that property activates the form
    // and would take the foreground away from the operator. The window is still topmost -
    // WS_EX_TOPMOST comes from CreateParams and the Shown handler re-asserts it with
    // SetWindowPos(HWND_TOPMOST, ... | SWP_NOACTIVATE), exactly as the reference does.
    '$script:form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    '$script:form.Bounds = [System.Drawing.Rectangle]::new($bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)',
    '$regionPath = New-Object System.Drawing.Drawing2D.GraphicsPath',
    '$regionPath.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding',
    '$regionPath.AddRectangle([System.Drawing.Rectangle]::new(0, 0, $bounds.Width, $script:thick))',
    '$regionPath.AddRectangle([System.Drawing.Rectangle]::new(($bounds.Width - $script:thick), 0, $script:thick, $bounds.Height))',
    '$regionPath.AddRectangle([System.Drawing.Rectangle]::new(0, ($bounds.Height - $script:thick), $bounds.Width, $script:thick))',
    '$regionPath.AddRectangle([System.Drawing.Rectangle]::new(0, 0, $script:thick, $bounds.Height))',
    '$script:form.Region = New-Object System.Drawing.Region($regionPath)',
    '$regionPath.Dispose()',
    '$script:form.BackColor = [System.Drawing.Color]::Black',
    '$script:stopwatch = [System.Diagnostics.Stopwatch]::StartNew()',
    '',
    '$script:form.Add_Shown({',
    '  $style = [NewmarkCuOverlayWin32]::GetWindowLong($script:form.Handle, [NewmarkCuOverlayWin32]::GWL_EXSTYLE)',
    '  [NewmarkCuOverlayWin32]::SetWindowLong($script:form.Handle, [NewmarkCuOverlayWin32]::GWL_EXSTYLE, $style -bor [NewmarkCuOverlayWin32]::WS_EX_TRANSPARENT -bor [NewmarkCuOverlayWin32]::WS_EX_TOOLWINDOW) | Out-Null',
    '  $script:topmostReasserted = [NewmarkCuOverlayWin32]::SetWindowPos($script:form.Handle, [NewmarkCuOverlayWin32]::HWND_TOPMOST, 0, 0, 0, 0, [NewmarkCuOverlayWin32]::SWP_NOMOVE -bor [NewmarkCuOverlayWin32]::SWP_NOSIZE -bor [NewmarkCuOverlayWin32]::SWP_NOACTIVATE -bor [NewmarkCuOverlayWin32]::SWP_SHOWWINDOW)',
    '  $script:form.Invalidate()',
    '  $script:form.Update()',
    '  Write-OverlayStatus \'shown\' \'\'',
    '})',
    '',
    '$script:form.Add_Paint({',
    '  param($sender, $e)',
    '  $w = [Math]::Max(1, $sender.ClientSize.Width)',
    '  $h = [Math]::Max(1, $sender.ClientSize.Height)',
    '  $target = $e.Graphics',
    '  $target.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed',
    '  $target.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '  $target.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '  $perimeter = [Math]::Max(1.0, (2.0 * $w) + (2.0 * $h))',
    '  $clockwiseOffset = (($script:stopwatch.Elapsed.TotalSeconds / $script:speedSeconds) * $perimeter) % $perimeter',
    '  $step = [Math]::Max(2.0, [double][Math]::Min(6, [Math]::Max(2, $script:thick * 2)))',
    '  for ($distance = 0.0; $distance -lt $perimeter; $distance += $step) {',
    '    $segment = [Math]::Min($step, $perimeter - $distance)',
    '    if ($segment -le 0) { continue }',
    '    $wrappedDistance = (($distance + ($segment / 2.0)) - $clockwiseOffset) % $perimeter',
    '    if ($wrappedDistance -lt 0) { $wrappedDistance += $perimeter }',
    '    $brushIndex = [int][Math]::Floor(($wrappedDistance / $perimeter) * $script:brushes.Count) % $script:brushes.Count',
    '    $brush = $script:brushes[$brushIndex]',
    '    if ($distance -lt $w) {',
    '      $x = [int][Math]::Floor($distance)',
    '      $rw = [int][Math]::Min($segment, $w - $x)',
    '      $target.FillRectangle($brush, $x, 0, $rw, $script:thick)',
    '    } elseif ($distance -lt ($w + $h)) {',
    '      $y = [int][Math]::Floor($distance - $w)',
    '      $rh = [int][Math]::Min($segment, $h - $y)',
    '      $target.FillRectangle($brush, $w - $script:thick, $y, $script:thick, $rh)',
    '    } elseif ($distance -lt ((2.0 * $w) + $h)) {',
    '      $x = [int][Math]::Ceiling($w - ($distance - ($w + $h)))',
    '      $rw = [int][Math]::Min($segment, [Math]::Max(1, $x))',
    '      $left = [Math]::Max(0, $x - $rw)',
    '      $target.FillRectangle($brush, [int]$left, $h - $script:thick, $rw, $script:thick)',
    '    } else {',
    '      $y = [int][Math]::Ceiling($h - ($distance - ((2.0 * $w) + $h)))',
    '      $rh = [int][Math]::Min($segment, [Math]::Max(1, $y))',
    '      $top = [Math]::Max(0, $y - $rh)',
    '      $target.FillRectangle($brush, 0, [int]$top, $script:thick, $rh)',
    '    }',
    '  }',
    '})',
    '',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = $script:timerIntervalMs',
    '$timer.Add_Tick({ $script:form.Invalidate() })',
    '$timer.Start()',
    '',
    '$ownerTimer = New-Object System.Windows.Forms.Timer',
    '$ownerTimer.Interval = $script:watchdogMs',
    '$ownerTimer.Add_Tick({',
    '  if ($script:ownerPid -le 0) { return }',
    '  $ownerAlive = $false',
    '  try { $ownerAlive = [bool](Get-Process -Id $script:ownerPid -ErrorAction SilentlyContinue) } catch { $ownerAlive = $false }',
    '  if (-not $ownerAlive) {',
    '    $script:closeReason = \'owner_gone\'',
    '    try { $ownerTimer.Stop() } catch { }',
    '    try { $timer.Stop() } catch { }',
    '    $script:form.Close()',
    '    [System.Windows.Forms.Application]::ExitThread()',
    '  }',
    '})',
    '$ownerTimer.Start()',
    '',
    'if ($script:durationMs -gt 0) {',
    '  $closeTimer = New-Object System.Windows.Forms.Timer',
    '  $closeTimer.Interval = $script:durationMs',
    '  $closeTimer.Add_Tick({',
    '    $script:closeReason = \'duration_elapsed\'',
    '    try { $closeTimer.Stop() } catch { }',
    '    try { $timer.Stop() } catch { }',
    '    $script:form.Close()',
    '    [System.Windows.Forms.Application]::ExitThread()',
    '  })',
    '  $closeTimer.Start()',
    '}',
    '',
    '$script:form.Add_FormClosed({',
    '  if ($script:closeReason -eq \'\') { $script:closeReason = \'form_closed\' }',
    '  Write-OverlayStatus \'closed\' $script:closeReason',
    '  foreach ($brush in $script:brushes) { try { $brush.Dispose() } catch { } }',
    '})',
    '',
    '$script:form.Show()',
    '[System.Windows.Forms.Application]::Run()',
    'try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch { }',
  ];
  return lines.join('\r\n');
}

/* ------------------------------------------------------------------ *
 * 5. the lane scripts
 * ------------------------------------------------------------------ */

/** The lane script that writes the host script, launches it hidden, and confirms its window. */
function buildStartLaneScript(options) {
  const scriptText = buildOverlayScript(options);
  const payload = Buffer.from(scriptText, 'utf8').toString('base64');
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$scriptPath = ${psQuote(options.scriptPath)}`,
    `$statusPath = ${psQuote(options.statusPath)}`,
    `$payload = ${psQuote(payload)}`,
    `$launchWaitMs = ${OVERLAY_LAUNCH_WAIT_MS}`,
    `$stalePattern = ${psQuote(OVERLAY_COMMAND_PATTERN)}`,
    '$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($payload))',
    '[System.IO.File]::WriteAllText($scriptPath, $text, (New-Object System.Text.UTF8Encoding($true)))',
    'if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue }',
    '$sweptStale = 0',
    '$selfPid = $PID',
    'try {',
    '  $stale = @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $selfPid -and $_.CommandLine -match $stalePattern })',
    '  foreach ($staleProcess in $stale) { try { Stop-Process -Id $staleProcess.ProcessId -Force -ErrorAction Stop; $sweptStale++ } catch { } }',
    '} catch { }',
    '$windowsPowerShell = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    'if (-not (Test-Path -LiteralPath $windowsPowerShell)) { $windowsPowerShell = "powershell.exe" }',
    '$quotedScriptPath = \'"\' + $scriptPath + \'"\'',
    '$arguments = "-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " + $quotedScriptPath',
    // The windowless, handle-free spawn is the one the overlay uses: a host whose console
    // window exists would take the foreground away from the operator for a moment, and a
    // host that inherited the lane's pipes would keep this process alive after the lane
    // died. Both are avoided by CREATE_NO_WINDOW with bInheritHandles = false.
    '$overlayPid = 0',
    '$spawnMethod = \'\'',
    'try {',
    '  if (-not ("NewmarkCuOverlayWin32" -as [type])) {',
    '    Add-Type -TypeDefinition @\'',
    ...OVERLAY_NATIVE_CSHARP.split('\n'),
    '\'@',
    '  }',
    '  $overlayPid = [int][NewmarkCuOverlayWin32]::SpawnHidden($windowsPowerShell, $arguments)',
    '  if ($overlayPid -gt 0) { $spawnMethod = "create-process-no-window-no-inherit" }',
    '} catch { $overlayPid = 0 }',
    'if ($overlayPid -le 0) {',
    '  $commandLine = \'"\' + $windowsPowerShell + \'" -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File \' + $quotedScriptPath',
    '  try {',
    '    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine } -ErrorAction Stop',
    '    if ([int]$created.ReturnValue -eq 0 -and [int]$created.ProcessId -gt 0) { $overlayPid = [int]$created.ProcessId; $spawnMethod = "wmi-win32-process-create" }',
    '  } catch { }',
    '}',
    'if ($overlayPid -le 0) {',
    '  try {',
    '    $started = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru',
    '    if ($started) { $overlayPid = [int]$started.Id; $spawnMethod = "start-process-hidden" }',
    '  } catch { }',
    '}',
    `if ($overlayPid -le 0) { ${psError('overlay_spawn_failed', 'The overlay host process could not be created.')} }`,
    '$deadline = [DateTime]::UtcNow.AddMilliseconds($launchWaitMs)',
    'while ([DateTime]::UtcNow -lt $deadline) {',
    '  if (Test-Path -LiteralPath $statusPath) { break }',
    '  if (-not (Get-Process -Id $overlayPid -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 50',
    '}',
    '$status = $null',
    'if (Test-Path -LiteralPath $statusPath) {',
    '  try { $status = [System.IO.File]::ReadAllText($statusPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $status = $null }',
    '}',
    'if ($status -eq $null) {',
    '  $compileError = \'\'',
    `  $compileErrorPath = $statusPath + ${psQuote(OVERLAY_COMPILE_ERROR_SUFFIX)}`,
    '  if (Test-Path -LiteralPath $compileErrorPath) { try { $compileError = [System.IO.File]::ReadAllText($compileErrorPath, [System.Text.Encoding]::UTF8) } catch { $compileError = \'\' } }',
    '  $alive = [bool](Get-Process -Id $overlayPid -ErrorAction SilentlyContinue)',
    '  if ($alive) { try { Stop-Process -Id $overlayPid -Force -ErrorAction SilentlyContinue } catch { } }',
    '  Write-Output (@{ ok = $false; error_code = "overlay_window_not_confirmed"; error = "The overlay host started but never reported a shown window; it was killed again."; pid = $overlayPid; spawn_method = $spawnMethod; swept_stale = $sweptStale; process_alive = $alive; compile_error = $compileError; script_path = $scriptPath } | ConvertTo-Json -Compress -Depth 6)',
    '} else {',
    '  Write-Output (@{ ok = $true; pid = $overlayPid; spawn_method = $spawnMethod; swept_stale = $sweptStale; status = $status } | ConvertTo-Json -Compress -Depth 8)',
    '}',
  ].join('\r\n');
}

/** The lane script that kills the recorded host and every other surviving overlay host. */
function buildStopLaneScript(options) {
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$recordedPid = ${Number(options.pid) || 0}`,
    `$scriptPath = ${psQuote(options.scriptPath || '')}`,
    `$statusPath = ${psQuote(options.statusPath || '')}`,
    `$sweepWaitMs = ${OVERLAY_SWEEP_WAIT_MS}`,
    `$stalePattern = ${psQuote(OVERLAY_COMMAND_PATTERN)}`,
    '$selfPid = $PID',
    '$killed = 0',
    '$swept = 0',
    '$recordedMatched = $false',
    '$targets = @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $selfPid -and $_.CommandLine -match $stalePattern })',
    'foreach ($target in $targets) {',
    '  if ([int]$target.ProcessId -eq $recordedPid) { $recordedMatched = $true }',
    '  $swept++',
    '  try { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }',
    '}',
    '$deadline = [DateTime]::UtcNow.AddMilliseconds($sweepWaitMs)',
    'while ([DateTime]::UtcNow -lt $deadline) {',
    '  $alive = @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $selfPid -and $_.CommandLine -match $stalePattern })',
    '  if ($alive.Count -eq 0) { break }',
    '  foreach ($target in $alive) { try { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop } catch { } }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    'if ($scriptPath -ne \'\') { try { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue } catch { } }',
    'if ($statusPath -ne \'\') { try { Remove-Item -LiteralPath ($statusPath + ".tmp") -Force -ErrorAction SilentlyContinue } catch { } }',
    'Write-Output (@{ ok = $true; killed = $killed; swept = $swept; recorded_pid = $recordedPid; recorded_pid_matched = $recordedMatched } | ConvertTo-Json -Compress)',
  ].join('\r\n');
}

/** The lane script that reads the live window back out of the desktop, independently. */
function buildProbeLaneScript(options) {
  const native = OVERLAY_NATIVE_CSHARP.split('\n');
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$hwndValue = ${Number(options.hwnd) || 0}`,
    'Add-Type -AssemblyName System.Windows.Forms',
    'if (-not ("NewmarkCuOverlayWin32" -as [type])) {',
    '  Add-Type -TypeDefinition @\'',
    ...native,
    '\'@',
    '}',
    '$hwnd = [IntPtr]::new([int64]$hwndValue)',
    '$exStyle = [NewmarkCuOverlayWin32]::GetWindowLong($hwnd, [NewmarkCuOverlayWin32]::GWL_EXSTYLE)',
    '$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    'Write-Output (@{',
    '  is_window = [NewmarkCuOverlayWin32]::IsWindow($hwnd)',
    '  visible = [NewmarkCuOverlayWin32]::IsWindowVisible($hwnd)',
    '  ex_style = $exStyle',
    '  ex_style_hex = ("0x" + $exStyle.ToString("x"))',
    '  ws_ex_transparent = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_TRANSPARENT)',
    '  ws_ex_toolwindow = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_TOOLWINDOW)',
    '  ws_ex_layered = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_LAYERED)',
    '  ws_ex_topmost = [NewmarkCuOverlayWin32]::HasStyle($exStyle, [NewmarkCuOverlayWin32]::WS_EX_TOPMOST)',
    '  rect = [NewmarkCuOverlayWin32]::RectJson($hwnd)',
    '  virtual_screen = @{ left = $screen.Left; top = $screen.Top; width = $screen.Width; height = $screen.Height }',
    '  foreground = [NewmarkCuOverlayWin32]::GetForegroundWindow().ToInt64()',
    '  hit_top_left = [NewmarkCuOverlayWin32]::HitTestAt(($screen.Left + 1), ($screen.Top + 1))',
    '  hit_top_right = [NewmarkCuOverlayWin32]::HitTestAt(($screen.Left + $screen.Width - 2), ($screen.Top + 1))',
    '  hit_bottom_left = [NewmarkCuOverlayWin32]::HitTestAt(($screen.Left + 1), ($screen.Top + $screen.Height - 2))',
    '  hit_bottom_right = [NewmarkCuOverlayWin32]::HitTestAt(($screen.Left + $screen.Width - 2), ($screen.Top + $screen.Height - 2))',
    '  reach_top_left = [NewmarkCuOverlayWin32]::HitTestSkippingTransparent(($screen.Left + 1), ($screen.Top + 1))',
    '  reach_top_right = [NewmarkCuOverlayWin32]::HitTestSkippingTransparent(($screen.Left + $screen.Width - 2), ($screen.Top + 1))',
    '  reach_bottom_left = [NewmarkCuOverlayWin32]::HitTestSkippingTransparent(($screen.Left + 1), ($screen.Top + $screen.Height - 2))',
    '  reach_bottom_right = [NewmarkCuOverlayWin32]::HitTestSkippingTransparent(($screen.Left + $screen.Width - 2), ($screen.Top + $screen.Height - 2))',
    '} | ConvertTo-Json -Compress -Depth 6)',
  ].join('\r\n');
}

/* ------------------------------------------------------------------ *
 * 6. the lifecycle
 * ------------------------------------------------------------------ */

const overlay = {
  lane: OVERLAY_LANE,
  epoch: 0,
  queue: Promise.resolve(),
  record: null,
  state: 'stopped',
  reason: 'never_started',
  lastError: null,
  lastStart: null,
  lastStop: null,
  lastWindow: null,
  starts: 0,
  stops: 0,
  swept: 0,
};

/** Serialise every overlay operation: a stop can never overtake the start it follows. */
function enqueue(task) {
  const run = overlay.queue.then(task, task);
  overlay.queue = run.then(() => undefined, () => undefined);
  return run;
}

function readStatusFile(statusPath) {
  if (!statusPath) return null;
  try {
    const stat = fs.statSync(statusPath);
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { value: parsed, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
  } catch {
    return null;
  }
}

function rememberWindow(statusPath) {
  const status = readStatusFile(statusPath);
  if (status && status.value) {
    overlay.lastWindow = { ...status.value, read_age_ms: status.ageMs };
  }
}

/** The overlay contract, as `mode_report` publishes it. */
export function overlayContractReport() {
  return {
    module: 'components/computeruse/lib/overlay-win32.js',
    mechanism: 'native-winforms-window',
    lane: OVERLAY_LANE,
    bounds_source: 'System.Windows.Forms.SystemInformation.VirtualScreen',
    covers: 'the entire virtual screen (every monitor), not the DSH window',
    region: 'edge-only GraphicsPath, FillMode Winding, four rectangles',
    extended_styles: ['WS_EX_TRANSPARENT', 'WS_EX_TOOLWINDOW'],
    extended_styles_deliberately_absent: ['WS_EX_LAYERED'],
    transparency_key: false,
    topmost: true,
    activation: 'ShowWithoutActivation, WS_EX_TOPMOST and SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE); the WinForms TopMost property is not used because it activates the window',
    taskbar_and_alt_tab: 'ShowInTaskbar=false plus WS_EX_TOOLWINDOW',
    colors: [...OVERLAY_COLORS],
    border_width_px: OVERLAY_WIDTH_PX,
    cycle_ms: OVERLAY_CYCLE_MS,
    timer_interval_ms: OVERLAY_TIMER_INTERVAL_MS,
    brush_count: OVERLAY_BRUSH_STEPS,
    owner_watchdog_ms: OVERLAY_OWNER_WATCHDOG_MS,
    pulse_ms: OVERLAY_PULSE_MS,
    lifecycle: ['owner-process-bound'],
    duration_bound_note: 'durationMs is the *pulse* lifetime only (pulseTakeoverOverlay); the takeover overlay itself is started with durationMs 0 and never expires on a clock',
    dpi: 'the host stays system-DPI-unaware, exactly like the original',
    stop_paths: ['takeover_stop', 'stopAll', 'process_exit', 'owner watchdog'],
    explicit_stop_paths: ['takeover_stop'],
    /**
     * The one stop path that is not an explicit tool call, kept on purpose.
     *
     * This window is topmost, click-through and covers every monitor. If the process that
     * owns it dies, nothing inside the app can reach it any more, so without this path the
     * user would be left with a screen-wide window they cannot dismiss. It is the single
     * non-explicit stop path that remains, and it fires only on owner death.
     */
    implicit_stop_paths: [
      {
        path: 'owner watchdog',
        trigger: 'owner-process-death',
        watchdog_ms: OVERLAY_OWNER_WATCHDOG_MS,
        reason: 'a topmost click-through window outliving its owner would cover the user screen with no in-app way to remove it',
      },
    ],
  };
}

/**
 * The overlay's current state, as `mode_report` reports it.
 *
 * `running` is what is believed to be on screen right now and `reason` always names why
 * it is not running, so a silent failure is impossible.
 */
export function overlayState() {
  const record = overlay.record;
  const state = {
    module: 'components/computeruse/lib/overlay-win32.js',
    lane: OVERLAY_LANE,
    state: overlay.state,
    running: false,
    stop_pending: false,
    reason: overlay.reason,
    pid: null,
    hwnd: null,
    owner_pid: null,
    owner_id: null,
    lifecycle: null,
    started_at: null,
    running_for_ms: null,
    duration_ms: 0,
    remaining_ms: null,
    process_alive: false,
    window: null,
    last_window: overlay.lastWindow,
    last_error: overlay.lastError,
    last_start: overlay.lastStart,
    last_stop: overlay.lastStop,
    start_count: overlay.starts,
    stop_count: overlay.stops,
    swept_stale_count: overlay.swept,
  };
  if (!record) return state;
  const alive = isProcessAlive(record.pid);
  const status = readStatusFile(record.statusPath);
  const runningFor = Math.max(0, Date.now() - record.startedAt);
  const expiresAt = record.durationMs > 0 ? record.startedAt + record.durationMs : 0;
  const durationElapsed = expiresAt > 0 && Date.now() >= expiresAt;
  const running = alive && !durationElapsed && overlay.state !== 'stopped';
  // A window that closed itself (its duration elapsed, or its owner disappeared) leaves
  // its own closing record behind, so the real reason survives even though no stop call ran.
  const lastWindow = !alive && status ? { ...status.value, read_age_ms: status.ageMs } : overlay.lastWindow;
  return {
    ...state,
    running,
    stop_pending: overlay.state === 'stopping',
    reason: running
      ? (overlay.state === 'starting' ? 'starting' : '')
      : (alive ? (durationElapsed ? 'duration_elapsed' : overlay.reason) : 'overlay_process_exited'),
    pid: record.pid,
    hwnd: status && status.value ? Number(status.value.hwnd) || null : null,
    owner_pid: record.ownerPid,
    owner_id: record.ownerId,
    lifecycle: record.lifecycle,
    started_at: new Date(record.startedAt).toISOString(),
    running_for_ms: runningFor,
    duration_ms: record.durationMs,
    remaining_ms: expiresAt > 0 ? Math.max(0, expiresAt - Date.now()) : null,
    process_alive: alive,
    window: status ? status.value : null,
    last_window: lastWindow,
    status_age_ms: status ? status.ageMs : null,
  };
}

/**
 * Start the takeover overlay. Idempotent: a second call while a window is already up - or
 * already starting - returns that window and creates nothing.
 *
 * `durationMs > 0` makes the window duration-bound (it closes itself, which is what a
 * pulse uses). `durationMs === 0` makes it owner-process-bound: it lives until it is
 * stopped or until the owning process disappears.
 */
export async function startOverlay(options = {}) {
  const action = String(options.action || 'takeover_overlay_start');
  const ownerPid = clampNumber(options.ownerPid === undefined ? process.pid : options.ownerPid, 0, 0x7fffffff, process.pid);
  const durationMs = clampNumber(options.durationMs, 0, 600000, 0);
  try {
    if (!IS_WINDOWS) {
      return failure(action, 'unsupported_platform', 'The Computer Use takeover overlay is Windows-only; no window was created.', {
        overlay: overlayState(),
        supported_platforms: ['win32'],
      });
    }
    const existing = overlayState();
    if (existing.running || existing.process_alive) {
      return {
        ok: true,
        action,
        started: false,
        already_running: true,
        reason: 'already_running',
        pid: existing.pid,
        hwnd: existing.hwnd,
        overlay: existing,
      };
    }
    const epoch = overlay.epoch;
    overlay.state = 'starting';
    overlay.reason = 'starting';
    const started = await enqueue(async () => {
      if (overlay.epoch !== epoch) {
        overlay.state = 'stopped';
        overlay.reason = 'stopped_while_starting';
        return { ok: true, action, started: false, skipped: true, reason: 'stopped_while_starting' };
      }
      // Re-checked inside the queue, because a start that is already in flight is only
      // visible here - this is what makes two rapid takeover_starts one window.
      const current = overlayState();
      if (current.running || current.process_alive) {
        return { ok: true, action, started: false, already_running: true, reason: 'already_running', pid: current.pid, hwnd: current.hwnd };
      }
      return await launchOverlay({ action, ownerPid, durationMs, ownerId: options.ownerId, colors: options.colors, epoch });
    });
    return { ...started, overlay: overlayState() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    overlay.state = overlay.record ? overlay.state : 'failed';
    overlay.lastError = { action, code: 'overlay_internal_error', error: message };
    overlay.reason = 'overlay_internal_error';
    return failure(action, 'overlay_internal_error', message, { overlay: overlayState() });
  }
}

async function launchOverlay({ action, ownerPid, durationMs, ownerId, colors, epoch }) {
  const directory = overlayDirectory();
  const tag = `${timestampName()}-${nonce()}`;
  const scriptPath = path.join(directory, `${OVERLAY_SCRIPT_PREFIX}${tag}.ps1`);
  const statusPath = path.join(directory, `${OVERLAY_STATUS_PREFIX}${tag}.json`);
  const prepared = await prepareLane(OVERLAY_LANE, OVERLAY_PREPARE_TIMEOUT_MS);
  if (!prepared || prepared.ready !== true) {
    overlay.state = 'failed';
    overlay.reason = 'overlay_lane_unavailable';
    overlay.lastError = { action, code: 'overlay_lane_unavailable', error: `The ${OVERLAY_LANE} lane is not ready.` };
    return failure(action, 'overlay_lane_unavailable', `The ${OVERLAY_LANE} lane is not ready, so no overlay window was created.`, {
      lane: OVERLAY_LANE,
      lane_ready: false,
      prepare: prepared || null,
      physical_delivery_used: false,
    });
  }
  const script = buildStartLaneScript({
    scriptPath,
    statusPath,
    ownerPid,
    durationMs,
    lifecycle: durationMs > 0 ? 'duration-bound' : 'owner-process-bound',
    colors,
    widthPx: OVERLAY_WIDTH_PX,
    cycleMs: OVERLAY_CYCLE_MS,
    timerIntervalMs: OVERLAY_TIMER_INTERVAL_MS,
    brushSteps: OVERLAY_BRUSH_STEPS,
    watchdogMs: OVERLAY_OWNER_WATCHDOG_MS,
  });
  const result = await runInLane(OVERLAY_LANE, script, OVERLAY_LANE_TIMEOUT_MS);
  if (!result || result.ok !== true) {
    const parsed = parsePsError(result ? result.output : '');
    cleanupOverlayFiles(scriptPath, statusPath);
    overlay.state = 'failed';
    overlay.reason = parsed.code;
    overlay.lastError = { action, code: parsed.code, error: parsed.message };
    return failure(action, parsed.code, parsed.message, {
      lane: OVERLAY_LANE,
      lane_output: result ? String(result.output).slice(0, 2000) : '',
      physical_delivery_used: false,
    });
  }
  const parsed = lastJsonObject(result.output);
  if (!parsed) {
    cleanupOverlayFiles(scriptPath, statusPath);
    overlay.state = 'failed';
    overlay.reason = 'overlay_launch_unreadable';
    overlay.lastError = { action, code: 'overlay_launch_unreadable', error: 'The lane launched the overlay host but returned no readable record.' };
    return failure(action, 'overlay_launch_unreadable', 'The lane launched the overlay host but returned no readable record.', {
      lane_output: String(result.output).slice(0, 2000),
      physical_delivery_used: false,
    });
  }
  if (parsed.ok !== true) {
    const code = String(parsed.error_code || 'overlay_launch_failed');
    const message = String(parsed.error || 'The overlay window was not confirmed.');
    cleanupOverlayFiles(scriptPath, statusPath);
    overlay.state = 'failed';
    overlay.reason = code;
    overlay.lastError = { action, code, error: message, compile_error: parsed.compile_error || undefined };
    return failure(action, code, message, {
      lane: OVERLAY_LANE,
      pid: Number(parsed.pid) || null,
      spawn_method: String(parsed.spawn_method || ''),
      process_alive_at_failure: parsed.process_alive === true,
      compile_error: parsed.compile_error ? String(parsed.compile_error).slice(0, 2000) : undefined,
      physical_delivery_used: false,
    });
  }
  if (!Number.isFinite(Number(parsed.pid)) || Number(parsed.pid) <= 0) {
    cleanupOverlayFiles(scriptPath, statusPath);
    overlay.state = 'failed';
    overlay.reason = 'overlay_launch_unreadable';
    overlay.lastError = { action, code: 'overlay_launch_unreadable', error: 'The lane launched the overlay host but returned no pid.' };
    return failure(action, 'overlay_launch_unreadable', 'The lane launched the overlay host but returned no readable pid.', {
      lane_output: String(result.output).slice(0, 2000),
      physical_delivery_used: false,
    });
  }
  const pid = Number(parsed.pid);
  const status = parsed.status && typeof parsed.status === 'object' ? parsed.status : null;
  const record = {
    pid,
    scriptPath,
    statusPath,
    ownerPid,
    ownerId: ownerId === undefined || ownerId === null ? null : String(ownerId),
    lifecycle: durationMs > 0 ? 'duration-bound' : 'owner-process-bound',
    durationMs,
    startedAt: Date.now(),
    spawnMethod: String(parsed.spawn_method || ''),
    sweptStale: Number(parsed.swept_stale) || 0,
  };
  overlay.swept += Number(parsed.swept_stale) || 0;
  overlay.starts += 1;
  overlay.record = record;
  overlay.lastError = null;
  if (status) overlay.lastWindow = { ...status, read_age_ms: 0 };
  // A stop that arrived while the window was being created wins: the fresh window is
  // killed immediately, so a queued stop can never resurrect one.
  if (overlay.epoch !== epoch) {
    const stopped = stopOverlaySync('stopped_while_starting');
    const skipped = { ok: true, action, started: true, stopped_immediately: true, reason: 'stopped_while_starting', pid };
    overlay.lastStart = { ...skipped, spawn_method: record.spawnMethod, swept_stale: record.sweptStale, hwnd: status ? status.hwnd : null, at: new Date().toISOString() };
    overlay.lastStop = stopped;
    return skipped;
  }
  overlay.state = 'running';
  overlay.reason = '';
  const started = {
    ok: true,
    action,
    started: true,
    already_running: false,
    reason: '',
    pid,
    hwnd: status ? Number(status.hwnd) || null : null,
    spawn_method: record.spawnMethod,
    swept_stale: record.sweptStale,
    lifecycle: record.lifecycle,
    duration_ms: durationMs,
    owner_pid: ownerPid,
    bounds_source: 'SystemInformation.VirtualScreen',
    window: status,
    click_through: status ? status.ws_ex_transparent === true : null,
    topmost: status ? status.ws_ex_topmost === true : null,
    layered: status ? status.ws_ex_layered === true : null,
    physical_delivery_used: false,
  };
  overlay.lastStart = {
    ...started,
    window: status ? { hwnd: status.hwnd, ex_style_hex: status.ex_style_hex, virtual_screen: status.virtual_screen, bounds: status.bounds } : null,
    at: new Date().toISOString(),
  };
  return started;
}

function cleanupOverlayFiles(scriptPath, statusPath) {
  const targets = [scriptPath, statusPath, statusPath ? `${statusPath}.tmp` : '', statusPath ? `${statusPath}${OVERLAY_COMPILE_ERROR_SUFFIX}` : ''];
  for (const target of targets) {
    if (!target) continue;
    try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Stop the takeover overlay. Idempotent: with nothing running it reports
 * `already_stopped` and touches neither the desktop nor the lane.
 */
export async function stopOverlay(options = {}) {
  const action = String(options.action || 'takeover_overlay_stop');
  const reason = String(options.reason || 'takeover_overlay_stop');
  try {
    overlay.epoch += 1;
    const pending = overlay.record;
    if (!IS_WINDOWS || !pending) {
      const cleared = stopOverlaySync(reason);
      overlay.lastStop = { ...cleared, at: new Date().toISOString() };
      return {
        ok: true,
        action,
        stopped: false,
        already_stopped: true,
        reason: IS_WINDOWS ? reason : 'unsupported_platform',
        note: IS_WINDOWS ? 'No overlay window was running.' : 'The Computer Use takeover overlay is Windows-only.',
        overlay: overlayState(),
        cleared,
      };
    }
    overlay.state = 'stopping';
    overlay.reason = reason;
    const stopped = await enqueue(async () => await killOverlay({ action, reason }));
    overlay.lastStop = { ...stopped, at: new Date().toISOString() };
    return { ...stopped, overlay: overlayState() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cleared = stopOverlaySync(reason);
    overlay.lastError = { action, code: 'overlay_internal_error', error: message };
    overlay.lastStop = { ok: false, error_code: 'overlay_internal_error', error: message, cleared, at: new Date().toISOString() };
    return failure(action, 'overlay_internal_error', message, { overlay: overlayState() });
  }
}

async function killOverlay({ action, reason }) {
  const record = overlay.record;
  if (!record) return { ok: true, action, stopped: false, already_stopped: true, reason };
  const script = buildStopLaneScript({ pid: record.pid, scriptPath: record.scriptPath, statusPath: record.statusPath });
  const result = await runInLane(OVERLAY_LANE, script, OVERLAY_LANE_TIMEOUT_MS);
  const parsed = result && result.ok === true ? lastJsonObject(result.output) : null;
  const killed = parsed ? Number(parsed.killed) || 0 : 0;
  const swept = parsed ? Number(parsed.swept) || 0 : 0;
  const recordedMatched = parsed ? parsed.recorded_pid_matched === true : false;
  const alive = isProcessAlive(record.pid);
  if (!parsed || alive) {
    // The lane could not finish the job (cooldown, timeout): kill it from here instead.
    const laneError = result && result.ok === false ? parsePsError(result.output) : null;
    const cleared = stopOverlaySync('lane_stop_failed');
    return {
      ok: !isProcessAlive(record.pid),
      action,
      stopped: true,
      already_stopped: false,
      reason,
      pid: record.pid,
      killed,
      swept_stale: swept,
      lane_used: false,
      fallback_synchronous_kill: true,
      warning: laneError ? `${laneError.code}: ${laneError.message}` : 'The lane did not confirm the kill; the host was terminated synchronously instead.',
      cleared,
      physical_delivery_used: false,
    };
  }
  rememberWindow(record.statusPath);
  overlay.record = null;
  overlay.state = 'stopped';
  overlay.stops += 1;
  return {
    ok: true,
    action,
    stopped: true,
    already_stopped: false,
    reason,
    pid: record.pid,
    killed,
    swept_stale: swept,
    recorded_pid_matched: recordedMatched,
    lane_used: true,
    fallback_synchronous_kill: false,
    physical_delivery_used: false,
  };
}

/**
 * The synchronous stopper. Used where async work cannot run - process exit, `stopAll()` -
 * and as the fallback when the lane is unavailable. It kills the recorded pid, clears the
 * files and bumps the epoch so nothing queued can bring the window back.
 */
export function stopOverlaySync(reason = 'synchronous_stop') {
  const record = overlay.record;
  overlay.epoch += 1;
  overlay.record = null;
  overlay.state = 'stopped';
  overlay.reason = String(reason);
  if (!record) return { ok: true, stopped: false, already_stopped: true, reason: String(reason), pid: null };
  let alive = isProcessAlive(record.pid);
  let killed = false;
  if (alive) {
    try {
      process.kill(record.pid, 'SIGKILL');
      killed = true;
    } catch { /* the window's own watchdog closes it instead */ }
  }
  rememberWindow(record.statusPath);
  cleanupOverlayFiles(record.scriptPath, record.statusPath);
  alive = isProcessAlive(record.pid);
  overlay.stops += 1;
  return {
    ok: !alive,
    stopped: true,
    already_stopped: false,
    reason: String(reason),
    pid: record.pid,
    killed,
    process_alive_after: alive,
    synchronous: true,
  };
}

/**
 * The lease hook: `win32.js` calls this whenever the takeover lease is released, so
 * `takeover_stop`, `stopAll()` and process exit all reach the window. There is no expiry
 * reason any more - the lease has no time limit. Terminal reasons stop synchronously,
 * because there is no event loop left to await in.
 */
export function releaseOverlay(reason = 'lease_released') {
  const mapped = {
    takeover_stop: 'takeover_stop',
    stop_all: 'stop_all',
    process_exit: 'process_exit',
  }[String(reason)] || String(reason);
  try {
    if (mapped === 'process_exit' || mapped === 'stop_all') {
      const stopped = stopOverlaySync(mapped);
      overlay.lastStop = { ...stopped, at: new Date().toISOString() };
      return stopped;
    }
    overlay.epoch += 1;
    if (!overlay.record) {
      overlay.state = 'stopped';
      overlay.reason = mapped;
      const cleared = stopOverlaySync(mapped);
      overlay.lastStop = { ...cleared, at: new Date().toISOString() };
      return cleared;
    }
    overlay.state = 'stopping';
    overlay.reason = mapped;
    void stopOverlay({ reason: mapped, action: 'takeover_overlay_release' });
    return { ok: true, stopping: true, reason: mapped, pid: overlay.record.pid };
  } catch (error) {
    return failure('takeover_overlay_release', 'overlay_release_failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Read the live window back out of the desktop through the lane, so the overlay's style
 * claims are checked by a process that did not create them. Read-only: nothing here moves
 * the cursor or posts input.
 */
export async function probeOverlayWindow(options = {}) {
  const action = String(options.action || 'takeover_overlay_probe');
  try {
    if (!IS_WINDOWS) return failure(action, 'unsupported_platform', 'The Computer Use takeover overlay is Windows-only.', { overlay: overlayState() });
    const record = overlay.record;
    const fallbackHwnd = overlayState().hwnd || 0;
    const hwnd = clampNumber(options.hwnd === undefined ? fallbackHwnd : options.hwnd, 0, Number.MAX_SAFE_INTEGER, 0);
    if (!hwnd) return failure(action, 'overlay_not_running', 'There is no overlay window to probe.', { overlay: overlayState() });
    const prepared = await prepareLane(OVERLAY_LANE, OVERLAY_PREPARE_TIMEOUT_MS);
    if (!prepared || prepared.ready !== true) {
      return failure(action, 'overlay_lane_unavailable', `The ${OVERLAY_LANE} lane is not ready.`, { overlay: overlayState() });
    }
    const result = await runInLane(OVERLAY_LANE, buildProbeLaneScript({ hwnd }), OVERLAY_LANE_TIMEOUT_MS);
    if (!result || result.ok !== true) {
      const parsed = parsePsError(result ? result.output : '');
      return failure(action, parsed.code, parsed.message, { overlay: overlayState() });
    }
    const probe = lastJsonObject(result.output);
    if (!probe) return failure(action, 'overlay_probe_unreadable', 'The lane probe returned no readable window record.', { lane_output: String(result.output).slice(0, 2000) });
    let rect = null;
    try {
      rect = typeof probe.rect === 'string' ? JSON.parse(probe.rect) : (probe.rect || null);
    } catch { rect = null; }
    const screen = probe.virtual_screen || {};
    const coversScreen = Boolean(rect) && Number(rect.left) <= Number(screen.left) && Number(rect.top) <= Number(screen.top)
      && Number(rect.width) >= Number(screen.width) && Number(rect.height) >= Number(screen.height);
    const hitTests = {
      top_left: Number(probe.hit_top_left) || 0,
      top_right: Number(probe.hit_top_right) || 0,
      bottom_left: Number(probe.hit_bottom_left) || 0,
      bottom_right: Number(probe.hit_bottom_right) || 0,
    };
    const reachTests = {
      top_left: Number(probe.reach_top_left) || 0,
      top_right: Number(probe.reach_top_right) || 0,
      bottom_left: Number(probe.reach_bottom_left) || 0,
      bottom_right: Number(probe.reach_bottom_right) || 0,
    };
    const reachesOverlay = Object.values(hitTests).some(value => value === Number(hwnd));
    const skippedEverywhere = Object.values(reachTests).every(value => value !== Number(hwnd));
    return {
      ok: true,
      action,
      hwnd: Number(hwnd),
      record_pid: record ? record.pid : null,
      probe: { ...probe, rect },
      covers_virtual_screen: coversScreen,
      click_through: probe.ws_ex_transparent === true,
      layered_absent: probe.ws_ex_layered !== true,
      in_taskbar: probe.ws_ex_toolwindow !== true,
      corner_hit_test: hitTests,
      corner_hit_test_reaches_overlay: reachesOverlay,
      corner_hit_test_skipping_transparent: reachTests,
      input_reaches_the_window_underneath: skippedEverywhere,
      physical_delivery_used: false,
      overlay: overlayState(),
    };
  } catch (error) {
    return failure(action, 'overlay_internal_error', error instanceof Error ? error.message : String(error), { overlay: overlayState() });
  }
}

/** A pulse indicator: a short, duration-bound overlay, only when nothing is running. */
export async function pulseOverlay(options = {}) {
  const existing = overlayState();
  if (existing.running || existing.process_alive) {
    return { ok: true, action: 'takeover_overlay_pulse', started: false, already_running: true, reason: 'already_running', overlay: existing };
  }
  return await startOverlay({ ...options, action: 'takeover_overlay_pulse', durationMs: OVERLAY_PULSE_MS });
}
