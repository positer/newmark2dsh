/**
 * Newmark ComputerUse - Win32 automation layer.
 *
 * A pure Node ESM module (node:child_process / node:fs / node:os / node:path / node:crypto
 * only, no DSH import, no TypeScript, no build step) that executes Windows desktop
 * automation by driving one persistent PowerShell worker per lane.
 *
 * Layout of this file
 *   1. constants, lanes, mode inventory, action tables
 *   2. small pure helpers (quoting, clamping, SendKeys normalisation, error shaping)
 *   3. the C# native helper compiled once per lane as NewmarkCuNative
 *   4. the persistent PowerShell host + the lane registry
 *   5. capture / observation (full via the window_capture lane, sparse via the sparse lane)
 *   6. UIA + window enumeration and target resolution
 *   7. real (physical) pointer and keyboard delivery, behind one reservation queue
 *   8. the virtual (posted-message) delivery path, delimited by the @virtual-mode markers
 *   9. sequence, the single-owner takeover lease (with the native screen-wide overlay it
 *      owns, ./overlay-win32.js), and the action dispatcher
 *
 * Retired experimental work from the local Computer Use laboratory, and every learned or
 * on-device model runtime, is intentionally absent: this module only ever drives Win32 and
 * UI Automation through the shipped Windows APIs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { overlayContractReport, overlayState, releaseOverlay, startOverlay } from './overlay-win32.js';

/* ------------------------------------------------------------------ *
 * 1. constants, lanes, mode inventory, action tables
 * ------------------------------------------------------------------ */

/** Exclusive takeover lease lifetime, bound at acquisition time. */
export const LEASE_TTL_MS = 120000;
/** Minimum spacing between two physical click/drag reservations. */
export const MIN_ACTION_INTERVAL_MS = 350;
/** Duration of one interpolated physical cursor curve. */
export const MOVE_CURVE_MS = 50;
/** Minimum spacing between two sparse observation samples (5 Hz ceiling). */
export const SPARSE_MIN_INTERVAL_MS = 200;
/** Upper bound for a single sparse observation wait. */
export const SPARSE_MAX_WAIT_MS = 5000;
/** Sparse digest geometry: 32 x 18 grayscale cells. */
export const SPARSE_DIGEST_WIDTH = 32;
export const SPARSE_DIGEST_HEIGHT = 18;
/** Sparse change thresholds, mirroring the coarse-change wake-up contract. */
export const SPARSE_CELL_THRESHOLD = 24;
export const SPARSE_STRONG_THRESHOLD = 64;

export const LANES = Object.freeze([
  'action',
  'uia',
  'windows',
  'uia_advisory',
  'windows_advisory',
  'window_capture',
  'sparse',
]);

/** The seven lane ids, in contract order. */
export function lanes() {
  return [...LANES];
}

/**
 * The mode inventory: four axes, exactly the ids the plugin contract names.
 * mouse       - how pointer events reach the system
 * observation - how much of the scene a single observation costs
 * lane        - which persistent worker executes the work
 * lease       - the two actions that own the exclusive takeover lease
 */
export const MODE_INVENTORY = Object.freeze({
  mouse: Object.freeze(['real', 'virtual']),
  observation: Object.freeze(['sparse', 'full']),
  lane: Object.freeze([...LANES]),
  lease: Object.freeze(['takeover_start', 'takeover_stop']),
});

export const DESKTOP_ACTIONS = Object.freeze([
  'observe', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'wait', 'takeover_start', 'takeover_stop',
]);

export const APP_ACTIONS = Object.freeze([
  'app_list', 'app_observe', 'app_activate', 'app_click', 'app_drag', 'app_scroll', 'app_type', 'app_key',
]);

/** sequence accepts mouse/key steps only (wait is the pacing step). */
export const SEQUENCE_STEP_ACTIONS = Object.freeze(['move', 'click', 'drag', 'scroll', 'type', 'key', 'wait']);

/** Every exported action, in one list. */
export const ALL_ACTIONS = Object.freeze([
  ...DESKTOP_ACTIONS, ...APP_ACTIONS, 'sequence', 'mode_report',
]);

/**
 * Lane routing: which persistent worker carries the PowerShell work of an action.
 * Empty array means the action is pure Node state and touches no lane.
 */
export const ACTION_LANES = Object.freeze({
  observe: Object.freeze(['window_capture', 'uia']),
  app_observe: Object.freeze(['window_capture', 'uia']),
  move: Object.freeze(['action']),
  click: Object.freeze(['action']),
  drag: Object.freeze(['action']),
  scroll: Object.freeze(['action']),
  type: Object.freeze(['action']),
  key: Object.freeze(['action']),
  wait: Object.freeze([]),
  takeover_start: Object.freeze([]),
  takeover_stop: Object.freeze([]),
  app_list: Object.freeze(['windows']),
  app_activate: Object.freeze(['action']),
  app_click: Object.freeze(['action']),
  app_drag: Object.freeze(['action']),
  app_scroll: Object.freeze(['action']),
  app_type: Object.freeze(['action']),
  app_key: Object.freeze(['action']),
  sequence: Object.freeze(['action', 'windows_advisory', 'uia_advisory']),
  mode_report: Object.freeze([]),
});

export function actionLanes(action) {
  const lanesForAction = ACTION_LANES[String(action || '').toLowerCase()];
  return lanesForAction ? [...lanesForAction] : [];
}

/** Cooldown after a timed-out lane is killed, so it cannot block another lane. */
const LANE_TIMEOUT_COOLDOWN_MS = 60000;
const ADVISORY_TIMEOUT_COOLDOWN_MS = 4000;
const ADVISORY_LANES = Object.freeze(['uia_advisory', 'windows_advisory']);

const DEFAULT_ACTION_TIMEOUT_MS = 20000;
const DEFAULT_INIT_TIMEOUT_MS = 25000;
const SEQUENCE_MAX_STEPS = 8;
const MAX_UIA_ELEMENTS = 160;
const MAX_APPLICATIONS = 200;

/* ------------------------------------------------------------------ *
 * 2. small pure helpers
 * ------------------------------------------------------------------ */

const IS_WINDOWS = process.platform === 'win32';

/** Single-quote a value for PowerShell, doubling embedded quotes. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A structured failure raised from inside a lane script. */
function psError(code, message) {
  return `throw "newmark_cu_error::${code}::${message}"`;
}

/** Read a structured lane failure back out of a PowerShell error string. */
function parsePsError(output) {
  const text = String(output === null || output === undefined ? '' : output);
  const match = /newmark_cu_error::([a-z0-9_]+)::([\s\S]*)/i.exec(text);
  if (!match) return { code: 'lane_script_failed', message: text.trim() || 'The lane script failed.' };
  const message = match[2]
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)[0] || 'The lane script failed.';
  return { code: match[1].toLowerCase(), message };
}

/** Structured refusal. `extra` fields are copied first so the core fields always win. */
function failure(action, code, message, extra = {}) {
  return { ...extra, ok: false, action, error_code: code, error: message };
}

function clampNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

function parseJsonArray(text) {
  const trimmed = String(text === null || text === undefined ? '' : text).trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch {
    return [];
  }
}

function parseJsonObject(text) {
  const trimmed = String(text === null || text === undefined ? '' : text).trim();
  if (!trimmed) return undefined;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

function bucket(value, size = 48) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric / size) : 0;
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)); });
}

function handleHex(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  return /[1-9a-f]/i.test(raw) ? raw.toUpperCase() : '';
}

function handleToInt(value) {
  const hex = handleHex(value);
  if (!hex) return 0;
  const numeric = Number.parseInt(hex, 16);
  return Number.isFinite(numeric) ? numeric : 0;
}

function unwrapHandle(value) {
  return `0x${handleToInt(value).toString(16).toUpperCase()}`;
}

function abortReason(signal) {
  if (!signal) return undefined;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason ? String(signal.reason) : 'Computer Use action was cancelled.');
}

function cancelledResult(action, signal, extra = {}) {
  const reason = abortReason(signal);
  return failure(action, 'cancelled', reason ? reason.message : 'Computer Use action was cancelled.', extra);
}

/* --- .NET SendKeys translation (invariant 6) ---------------------- */

const SEND_KEYS_ALIASES = {
  enter: 'ENTER', return: 'ENTER',
  esc: 'ESC', escape: 'ESC',
  backspace: 'BACKSPACE', bksp: 'BACKSPACE',
  delete: 'DELETE', del: 'DELETE',
  insert: 'INSERT', ins: 'INSERT',
  tab: 'TAB', space: 'SPACE',
  up: 'UP', arrowup: 'UP', 'arrow-up': 'UP',
  down: 'DOWN', arrowdown: 'DOWN', 'arrow-down': 'DOWN',
  left: 'LEFT', arrowleft: 'LEFT', 'arrow-left': 'LEFT',
  right: 'RIGHT', arrowright: 'RIGHT', 'arrow-right': 'RIGHT',
  home: 'HOME', end: 'END',
  pageup: 'PGUP', 'page-up': 'PGUP', pgup: 'PGUP',
  pagedown: 'PGDN', 'page-down': 'PGDN', pgdn: 'PGDN',
  plus: '+', minus: '-',
};

/**
 * Normalise a human key spelling into .NET SendKeys notation.
 * ctrl+l -> ^l, ctrl+shift+l -> ^+l, alt+f4 -> %{F4}, enter -> {ENTER}, ^s passes through.
 */
export function normalizeSendKeysKey(value) {
  const key = String(value === null || value === undefined ? '' : value).trim();
  if (!key) return undefined;
  const lower = key.toLowerCase();
  const singleAlias = SEND_KEYS_ALIASES[lower];
  if (singleAlias) return `{${singleAlias}}`;
  if (/^f(?:[1-9]|1[0-6])$/i.test(key)) return `{${key.toUpperCase()}}`;

  const parts = key.split('+').map(part => part.trim());
  if (parts.length > 1) {
    const modifiers = new Set();
    let validChord = true;
    for (const part of parts.slice(0, -1)) {
      const modifier = part.toLowerCase();
      if (modifier === 'ctrl' || modifier === 'control') modifiers.add('ctrl');
      else if (modifier === 'shift') modifiers.add('shift');
      else if (modifier === 'alt' || modifier === 'option') modifiers.add('alt');
      else { validChord = false; break; }
    }
    const baseKey = parts[parts.length - 1];
    if (validChord && modifiers.size > 0 && baseKey) {
      let base = baseKey;
      let shift = modifiers.has('shift');
      if (/^[A-Z]$/.test(base) && !shift) shift = true;
      if (/^[A-Za-z]$/.test(base)) base = base.toLowerCase();
      const alias = SEND_KEYS_ALIASES[base.toLowerCase()];
      if (alias) base = `{${alias}}`;
      else if (/^f(?:[1-9]|1[0-6])$/i.test(base)) base = `{${base.toUpperCase()}}`;
      else if (base.length !== 1) return undefined;
      const prefix = `${modifiers.has('ctrl') ? '^' : ''}${shift ? '+' : ''}${modifiers.has('alt') ? '%' : ''}`;
      return `${prefix}${base}`;
    }
  }

  // Preserve existing .NET SendKeys notation such as ^s or {ENTER}.
  return key;
}

/**
 * Escape text so punctuation in a URL or a snippet is typed literally instead of being
 * parsed as a SendKeys chord.
 *
 * Order matters: the metacharacter pass runs first, so the {ENTER} and {TAB} tokens that
 * the newline and tab passes insert are not escaped a second time and stay real keypresses.
 * The Win32 source this port was checked against escaped after substituting, which turned a
 * newline into the literal text "{ENTER}"; the URL and punctuation contract is identical.
 */
export function encodeSendKeysText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[+^%~(){}]/g, character => `{${character}}`)
    .replace(/\r\n|\r|\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
}

/* ------------------------------------------------------------------ *
 * 3. the C# native helper (compiled once per lane as NewmarkCuNative)
 * ------------------------------------------------------------------ */

const MOVE_CURVE_TOKEN = '__MOVE_CURVE_MS__';

// NOTE: keep every method the contract names public. mouse_event is only ever called from
// PowerShell call sites that pass [System.UIntPtr]::Zero explicitly, so the only
// declaration here stays a pure P/Invoke declaration.
const NATIVE_CSHARP_TEMPLATE = `using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NewmarkCuNative
{
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public sealed class CuWindowInfo
  {
    public long Handle { get; set; }
    public string Title { get; set; }
    public string ClassName { get; set; }
    public int ProcessId { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Right { get; set; }
    public int Bottom { get; set; }
    public int ClientLeft { get; set; }
    public int ClientTop { get; set; }
    public int ClientWidth { get; set; }
    public int ClientHeight { get; set; }
    public bool Visible { get; set; }
    public bool Minimized { get; set; }
    public bool Foreground { get; set; }
    public bool Occluded { get; set; }
    public bool IntersectsVirtualScreen { get; set; }
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  const uint GW_OWNER = 4;
  const uint GA_ROOT = 2;
  const int SW_RESTORE = 9;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int SM_CXSCREEN = 0;
  const int SM_CYSCREEN = 1;
  const int SM_XVIRTUALSCREEN = 76;
  const int SM_YVIRTUALSCREEN = 77;
  const int SM_CXVIRTUALSCREEN = 78;
  const int SM_CYVIRTUALSCREEN = 79;
  const uint CHILD_SKIP = 0x0007;

  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hWnd, POINT point, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] static extern uint GetWindowThreadProcessIdDiscard(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll", EntryPoint="PostMessageW", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);

  static readonly Random MotionRandom = new Random();
  static readonly object MotionLock = new object();

  public static IntPtr EnterPhysicalDpiContext()
  {
    try { return SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    catch (EntryPointNotFoundException) { return IntPtr.Zero; }
  }

  public static void LeavePhysicalDpiContext(IntPtr previous)
  {
    if (previous == IntPtr.Zero) return;
    try { SetThreadDpiAwarenessContext(previous); }
    catch (EntryPointNotFoundException) { }
  }

  public static bool TryBecomePhysicalDpiAware()
  {
    try { return SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch (Exception) { return false; }
  }

  // Physical-coordinate entry point: the physical DPI context is installed around the
  // cursor write and restored in a finally, so a caller can never inherit it.
  public static bool SetCursorPosPhysical(int x, int y)
  {
    IntPtr previous = IntPtr.Zero;
    try
    {
      previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
      return SetCursorPos(x, y);
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static bool MoveCursorSmooth(int x, int y)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      POINT start;
      if (!GetCursorPos(out start)) return false;
      double dx = x - start.X;
      double dy = y - start.Y;
      double length = Math.Sqrt(dx * dx + dy * dy);
      double nx = length < 1 ? 0 : -dy / length;
      double ny = length < 1 ? 0 : dx / length;
      double arc;
      lock (MotionLock) { arc = (3 + MotionRandom.NextDouble() * 9) * (MotionRandom.Next(2) == 0 ? -1 : 1); }
      long begin = Environment.TickCount;
      const int duration = ${MOVE_CURVE_TOKEN};
      const int points = 10;
      for (int i = 1; i <= points; i++)
      {
        double t = i / (double)points;
        double eased = 0.5 - 0.5 * Math.Cos(Math.PI * t);
        double inv = 1 - eased;
        double p1x = start.X + dx * 0.30 + nx * arc;
        double p1y = start.Y + dy * 0.30 + ny * arc;
        double p2x = start.X + dx * 0.70 + nx * arc * 0.55;
        double p2y = start.Y + dy * 0.70 + ny * arc * 0.55;
        double c1 = 3 * inv * inv * eased;
        double c2 = 3 * inv * eased * eased;
        double px = inv * inv * inv * start.X + c1 * p1x + c2 * p2x + eased * eased * eased * x;
        double py = inv * inv * inv * start.Y + c1 * p1y + c2 * p2y + eased * eased * eased * y;
        double jitter;
        lock (MotionLock) { jitter = (MotionRandom.NextDouble() - 0.5) * 1.4 * Math.Sin(Math.PI * t); }
        int nextX = i == points ? x : (int)Math.Round(px + nx * jitter);
        int nextY = i == points ? y : (int)Math.Round(py + ny * jitter);
        if (!SetCursorPos(nextX, nextY)) return false;
        int remaining = i * duration / points - (int)(Environment.TickCount - begin);
        if (remaining > 0) System.Threading.Thread.Sleep(remaining);
      }
      return true;
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static int GetProcessId(IntPtr hWnd)
  {
    uint processId = 0;
    GetWindowThreadProcessId(hWnd, out processId);
    return unchecked((int)processId);
  }

  public static string WindowTitle(IntPtr hWnd)
  {
    StringBuilder text = new StringBuilder(512);
    int length = GetWindowTextW(hWnd, text, text.Capacity);
    return length > 0 ? text.ToString() : String.Empty;
  }

  public static string ClassName(IntPtr hWnd)
  {
    StringBuilder name = new StringBuilder(256);
    int length = GetClassNameW(hWnd, name, name.Capacity);
    return length > 0 ? name.ToString() : String.Empty;
  }

  // 0 = usable, 1 = not a window any more, 2 = the process id no longer owns it.
  public static int WindowOwnershipState(IntPtr hWnd, int expectedProcessId)
  {
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return 1;
    if (expectedProcessId > 0 && GetProcessId(hWnd) != expectedProcessId) return 2;
    return 0;
  }

  public static int[] WindowRectValues(IntPtr hWnd)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return new int[0];
      return new int[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static int[] BoundsRectValues(IntPtr hWnd)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      RECT rect;
      try
      {
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) == 0
          && rect.Right > rect.Left && rect.Bottom > rect.Top)
        {
          return new int[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
        }
      }
      catch (DllNotFoundException) { }
      if (!GetWindowRect(hWnd, out rect)) return new int[0];
      return new int[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  // Screen coordinates of the client origin, then the client size.
  public static int[] ClientAreaValues(IntPtr hWnd)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      RECT client;
      if (!GetClientRect(hWnd, out client)) return new int[0];
      POINT origin = new POINT();
      origin.X = 0;
      origin.Y = 0;
      if (!ClientToScreen(hWnd, ref origin)) return new int[0];
      return new int[] { origin.X, origin.Y, client.Right - client.Left, client.Bottom - client.Top };
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  // left, top, width, height of the whole virtual screen in physical pixels.
  public static int[] VirtualScreenValues()
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
      int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
      int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
      int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
      if (width <= 0 || height <= 0)
      {
        left = 0;
        top = 0;
        width = GetSystemMetrics(SM_CXSCREEN);
        height = GetSystemMetrics(SM_CYSCREEN);
      }
      return new int[] { left, top, width, height };
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static int[] CursorPosition()
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      POINT point;
      if (!GetCursorPos(out point)) return new int[0];
      return new int[] { point.X, point.Y };
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static bool ActivateWindow(IntPtr hWnd)
  {
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return false;
    ShowWindow(hWnd, SW_RESTORE);
    uint own = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessIdDiscard(GetForegroundWindow(), IntPtr.Zero);
    uint target = GetWindowThreadProcessIdDiscard(hWnd, IntPtr.Zero);
    bool attachedForeground = false;
    bool attachedTarget = false;
    try
    {
      if (foreground != 0 && foreground != own) attachedForeground = AttachThreadInput(own, foreground, true);
      if (target != 0 && target != own && target != foreground) attachedTarget = AttachThreadInput(own, target, true);
      BringWindowToTop(hWnd);
      SetActiveWindow(hWnd);
      for (int attempt = 0; attempt < 5; attempt++)
      {
        SetForegroundWindow(hWnd);
        if (GetForegroundWindow() == hWnd) return true;
        System.Threading.Thread.Sleep(20);
      }
      return GetForegroundWindow() == hWnd;
    }
    finally
    {
      if (attachedTarget) AttachThreadInput(own, target, false);
      if (attachedForeground) AttachThreadInput(own, foreground, false);
    }
  }

  public static bool IsClientPoint(IntPtr hWnd, int x, int y)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      RECT client;
      if (!IsWindow(hWnd) || !GetClientRect(hWnd, out client)) return false;
      POINT origin = new POINT();
      origin.X = 0;
      origin.Y = 0;
      if (!ClientToScreen(hWnd, ref origin)) return false;
      return x >= origin.X && y >= origin.Y && x < origin.X + (client.Right - client.Left) && y < origin.Y + (client.Bottom - client.Top);
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static IntPtr DeepestChildAtScreenPoint(IntPtr root, int screenX, int screenY)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      IntPtr current = root;
      if (current == IntPtr.Zero) return current;
      for (int i = 0; i < 24; i++)
      {
        POINT point = new POINT();
        point.X = screenX;
        point.Y = screenY;
        if (!ScreenToClient(current, ref point)) break;
        IntPtr child = ChildWindowFromPointEx(current, point, CHILD_SKIP);
        if (child == IntPtr.Zero || child == current) break;
        current = child;
      }
      return current;
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static bool ScreenToClientPoint(IntPtr hWnd, ref int x, ref int y)
  {
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      POINT point = new POINT();
      point.X = x;
      point.Y = y;
      if (!ScreenToClient(hWnd, ref point)) return false;
      x = point.X;
      y = point.Y;
      return true;
    }
    finally { LeavePhysicalDpiContext(previous); }
  }

  public static int PackPoint(int x, int y)
  {
    return ((y & 0xffff) << 16) | (x & 0xffff);
  }

  public static int KeyMessageLParam(uint virtualKey, bool keyUp)
  {
    uint value = 1u | ((MapVirtualKeyW(virtualKey, 0) & 0xffu) << 16);
    if (keyUp) value |= (uint)(1u << 30) | (uint)(1u << 31);
    return unchecked((int)value);
  }

  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);

  public static bool PostWindowMessage(IntPtr hWnd, uint msg, uint wParam, int lParam)
  {
    return IsWindow(hWnd) && PostMessage(hWnd, msg, new UIntPtr(wParam), new IntPtr(lParam));
  }

  // Virtual press: the whole path is posted to the target thread queue, and every button
  // transition is posted to the deepest child under the point. A move-only call posts
  // WM_MOUSEMOVE and nothing else.
  public static bool PostMousePath(IntPtr root, int fromX, int fromY, int toX, int toY, bool click, bool right)
  {
    if (!IsClientPoint(root, toX, toY)) return false;
    double dx = toX - fromX;
    double dy = toY - fromY;
    double length = Math.Sqrt(dx * dx + dy * dy);
    double nx = length < 1 ? 0 : -dy / length;
    double ny = length < 1 ? 0 : dx / length;
    double arc;
    lock (MotionLock) { arc = (2 + MotionRandom.NextDouble() * 6) * (MotionRandom.Next(2) == 0 ? -1 : 1); }
    long begin = Environment.TickCount;
    const int duration = ${MOVE_CURVE_TOKEN};
    const int points = 10;
    for (int i = 1; i <= points; i++)
    {
      double t = i / (double)points;
      double eased = 0.5 - 0.5 * Math.Cos(Math.PI * t);
      double inv = 1 - eased;
      double p1x = fromX + dx * 0.30 + nx * arc;
      double p1y = fromY + dy * 0.30 + ny * arc;
      double p2x = fromX + dx * 0.70 + nx * arc * 0.55;
      double p2y = fromY + dy * 0.70 + ny * arc * 0.55;
      double c1 = 3 * inv * inv * eased;
      double c2 = 3 * inv * eased * eased;
      double px = inv * inv * inv * fromX + c1 * p1x + c2 * p2x + eased * eased * eased * toX;
      double py = inv * inv * inv * fromY + c1 * p1y + c2 * p2y + eased * eased * eased * toY;
      double jitter;
      lock (MotionLock) { jitter = (MotionRandom.NextDouble() - 0.5) * 1.2 * Math.Sin(Math.PI * t); }
      int screenX = i == points ? toX : (int)Math.Round(px + nx * jitter);
      int screenY = i == points ? toY : (int)Math.Round(py + ny * jitter);
      IntPtr target = DeepestChildAtScreenPoint(root, screenX, screenY);
      int clientX = screenX;
      int clientY = screenY;
      if (!ScreenToClientPoint(target, ref clientX, ref clientY)) return false;
      if (!PostWindowMessage(target, 0x0200, 0, PackPoint(clientX, clientY))) return false;
      int remaining = i * duration / points - (int)(Environment.TickCount - begin);
      if (remaining > 0) System.Threading.Thread.Sleep(remaining);
    }
    if (!click) return true;
    int pressX = toX;
    int pressY = toY;
    IntPtr finalTarget = DeepestChildAtScreenPoint(root, toX, toY);
    if (!ScreenToClientPoint(finalTarget, ref pressX, ref pressY)) return false;
    uint down = right ? 0x0204u : 0x0201u;
    uint up = right ? 0x0205u : 0x0202u;
    uint held = right ? 0x0002u : 0x0001u;
    int packed = PackPoint(pressX, pressY);
    if (!PostWindowMessage(finalTarget, down, held, packed)) return false;
    System.Threading.Thread.Sleep(35);
    return PostWindowMessage(finalTarget, up, 0, packed);
  }

  // Virtual drag: the held button is released in a finally, on movement failure and on any
  // early return, so a posted drag can never leave a button stuck down.
  public static bool PostMouseDrag(IntPtr root, int fromX, int fromY, int startX, int startY, int endX, int endY, bool right)
  {
    if (!IsClientPoint(root, startX, startY) || !IsClientPoint(root, endX, endY)) return false;
    if (!PostMousePath(root, fromX, fromY, startX, startY, false, false)) return false;
    IntPtr capture = DeepestChildAtScreenPoint(root, startX, startY);
    if (capture == IntPtr.Zero) return false;
    int beginX = startX;
    int beginY = startY;
    if (!ScreenToClientPoint(capture, ref beginX, ref beginY)) return false;
    uint down = right ? 0x0204u : 0x0201u;
    uint move = 0x0200u;
    uint up = right ? 0x0205u : 0x0202u;
    uint held = right ? 0x0002u : 0x0001u;
    bool downQueued = false;
    bool success = false;
    try
    {
      downQueued = PostWindowMessage(capture, down, held, PackPoint(beginX, beginY));
      if (!downQueued) return false;
      System.Threading.Thread.Sleep(10);
      double dx = endX - startX;
      double dy = endY - startY;
      double length = Math.Sqrt(dx * dx + dy * dy);
      double nx = length < 1 ? 0 : -dy / length;
      double ny = length < 1 ? 0 : dx / length;
      double arc;
      lock (MotionLock) { arc = (2 + MotionRandom.NextDouble() * 6) * (MotionRandom.Next(2) == 0 ? -1 : 1); }
      long begin = Environment.TickCount;
      const int duration = ${MOVE_CURVE_TOKEN};
      const int points = 10;
      success = true;
      for (int i = 1; i <= points; i++)
      {
        double t = i / (double)points;
        double eased = 0.5 - 0.5 * Math.Cos(Math.PI * t);
        double inv = 1 - eased;
        double p1x = startX + dx * 0.30 + nx * arc;
        double p1y = startY + dy * 0.30 + ny * arc;
        double p2x = startX + dx * 0.70 + nx * arc * 0.55;
        double p2y = startY + dy * 0.70 + ny * arc * 0.55;
        double c1 = 3 * inv * inv * eased;
        double c2 = 3 * inv * eased * eased;
        double px = inv * inv * inv * startX + c1 * p1x + c2 * p2x + eased * eased * eased * endX;
        double py = inv * inv * inv * startY + c1 * p1y + c2 * p2y + eased * eased * eased * endY;
        double jitter;
        lock (MotionLock) { jitter = (MotionRandom.NextDouble() - 0.5) * 1.2 * Math.Sin(Math.PI * t); }
        int screenX = i == points ? endX : (int)Math.Round(px + nx * jitter);
        int screenY = i == points ? endY : (int)Math.Round(py + ny * jitter);
        int clientX = screenX;
        int clientY = screenY;
        if (!ScreenToClientPoint(capture, ref clientX, ref clientY) || !PostWindowMessage(capture, move, held, PackPoint(clientX, clientY)))
        {
          success = false;
          break;
        }
        int remaining = i * duration / points - (int)(Environment.TickCount - begin);
        if (remaining > 0) System.Threading.Thread.Sleep(remaining);
      }
    }
    finally
    {
      if (downQueued)
      {
        int endClientX = endX;
        int endClientY = endY;
        if (!ScreenToClientPoint(capture, ref endClientX, ref endClientY) || !PostWindowMessage(capture, up, 0, PackPoint(endClientX, endClientY))) success = false;
      }
    }
    return success;
  }

  static bool IsOccluded(IntPtr hWnd, int left, int top, int right, int bottom)
  {
    POINT point = new POINT();
    point.X = (left + right) / 2;
    point.Y = (top + bottom) / 2;
    IntPtr at = WindowFromPoint(point);
    if (at == IntPtr.Zero) return true;
    IntPtr root = GetAncestor(at, GA_ROOT);
    if (root == IntPtr.Zero) root = at;
    return root != hWnd;
  }

  public static CuWindowInfo[] EnumTopLevelWindows(bool virtualScope, bool includeMinimized)
  {
    List<CuWindowInfo> results = new List<CuWindowInfo>();
    IntPtr foreground = GetForegroundWindow();
    int[] virtualScreen = VirtualScreenValues();
    int vleft = virtualScreen[0];
    int vtop = virtualScreen[1];
    int vright = vleft + virtualScreen[2];
    int vbottom = vtop + virtualScreen[3];
    IntPtr previous = EnterPhysicalDpiContext();
    try
    {
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
      {
        try
        {
          if (hWnd == IntPtr.Zero) return true;
          int processId = GetProcessId(hWnd);
          if (processId <= 0) return true;
          string className = ClassName(hWnd);
          if (className == "Progman" || className == "WorkerW" || className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd") return true;
          string title = WindowTitle(hWnd);
          if (title.Length == 0 && className.Length == 0) return true;
          RECT rect;
          if (!GetWindowRect(hWnd, out rect)) return true;
          int width = rect.Right - rect.Left;
          int height = rect.Bottom - rect.Top;
          if (width <= 40 || height <= 40) return true;
          bool minimized = IsIconic(hWnd);
          bool visible = IsWindowVisible(hWnd);
          bool intersects = rect.Left < vright && rect.Right > vleft && rect.Top < vbottom && rect.Bottom > vtop;
          bool occluded = !minimized && IsOccluded(hWnd, rect.Left, rect.Top, rect.Right, rect.Bottom);
          if (minimized) { if (!includeMinimized) return true; }
          else
          {
            if (!intersects) return true;
            if (virtualScope) { if (!visible && !occluded) return true; }
            else { if (!visible || occluded) return true; }
          }
          int[] client = ClientAreaValues(hWnd);
          CuWindowInfo info = new CuWindowInfo();
          info.Handle = hWnd.ToInt64();
          info.Title = title;
          info.ClassName = className;
          info.ProcessId = processId;
          info.Left = rect.Left;
          info.Top = rect.Top;
          info.Right = rect.Right;
          info.Bottom = rect.Bottom;
          info.ClientLeft = client.Length == 4 ? client[0] : rect.Left;
          info.ClientTop = client.Length == 4 ? client[1] : rect.Top;
          info.ClientWidth = client.Length == 4 ? client[2] : width;
          info.ClientHeight = client.Length == 4 ? client[3] : height;
          info.Visible = visible;
          info.Minimized = minimized;
          info.Foreground = hWnd == foreground;
          info.Occluded = occluded;
          info.IntersectsVirtualScreen = intersects;
          results.Add(info);
        }
        catch (Exception) { }
        return true;
      }, IntPtr.Zero);
    }
    finally { LeavePhysicalDpiContext(previous); }
    return results.ToArray();
  }
}`;

const NATIVE_CSHARP = NATIVE_CSHARP_TEMPLATE.split(MOVE_CURVE_TOKEN).join(String(MOVE_CURVE_MS));

/* ------------------------------------------------------------------ *
 * 4. the persistent PowerShell host and the lane registry
 * ------------------------------------------------------------------ */

const READY_ID = '__newmark_cu_ready__';

function resolvePowerShellExecutable() {
  const override = process.env.NEWMARK_CU_POWERSHELL;
  if (override && fs.existsSync(override)) return override;
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'pwsh.exe'));
    candidates.push(path.join(dir, 'pwsh'));
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) candidates.push(path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (programFilesX86) candidates.push(path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return 'powershell.exe';
}

let cachedShellExecutable;
function shellExecutable() {
  if (!cachedShellExecutable) cachedShellExecutable = resolvePowerShellExecutable();
  return cachedShellExecutable;
}

/** True when UIA is available in this lane: only the two UIA lanes load it. */
function laneLoadsUiAutomation(lane) {
  return lane === 'uia' || lane === 'uia_advisory';
}

function createHostScript(lane) {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$newmarkWarnings = New-Object System.Collections.Generic.List[string]',
    'try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop } catch { $newmarkWarnings.Add("System.Windows.Forms unavailable: " + [string]$_) }',
    'try { Add-Type -AssemblyName System.Drawing -ErrorAction Stop } catch { $newmarkWarnings.Add("System.Drawing unavailable: " + [string]$_) }',
    ...(laneLoadsUiAutomation(lane) ? [
      'try { Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop } catch { $newmarkWarnings.Add("UIAutomationClient unavailable: " + [string]$_) }',
      'try { Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop } catch { $newmarkWarnings.Add("UIAutomationTypes unavailable: " + [string]$_) }',
    ] : []),
    `try { if (-not ("NewmarkCuNative" -as [type])) { Add-Type -TypeDefinition ${psQuote(NATIVE_CSHARP)} -ErrorAction Stop }; $newmarkDpi = $false; try { $newmarkDpi = [NewmarkCuNative]::TryBecomePhysicalDpiAware() } catch { }; [Console]::Out.WriteLine((@{ id=${psQuote(READY_ID)}; ready=$true; process_dpi_aware=$newmarkDpi; warnings=$newmarkWarnings.ToArray() } | ConvertTo-Json -Compress -Depth 4)) } catch { [Console]::Out.WriteLine((@{ id=${psQuote(READY_ID)}; ready=$false; error=[string]$_ } | ConvertTo-Json -Compress -Depth 4)) }`,
    '[Console]::Out.Flush()',
    'while (($line = [Console]::In.ReadLine()) -ne $null) {',
    '  $id = ""; $timer = [System.Diagnostics.Stopwatch]::StartNew(); $response = $null',
    '  try {',
    '    $request = $line | ConvertFrom-Json; $id = [string]$request.id',
    '    $source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.script))',
    '    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Stop"',
    '    try { $output = (& ([scriptblock]::Create($source)) 2>&1 | Out-String -Width 1048576).Trim() } finally { $ErrorActionPreference = $previousPreference }',
    '    $response = @{ id=$id; ok=$true; output=$output; elapsed_ms=[int]$timer.ElapsedMilliseconds }',
    '  } catch { $response = @{ id=$id; ok=$false; output=[string]$_; elapsed_ms=[int]$timer.ElapsedMilliseconds } }',
    '  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush()',
    '}',
  ].join('; ');
}

const hostScripts = new Map();
function hostScript(lane) {
  if (!hostScripts.has(lane)) hostScripts.set(lane, createHostScript(lane));
  return hostScripts.get(lane);
}

class PowerShellWorker {
  constructor(lane) {
    this.lane = lane;
    this.child = null;
    this.readyChild = null;
    this.pending = new Map();
    this.readinessWaiters = new Set();
    this.unavailableUntil = 0;
    this.consecutiveTimeouts = 0;
    this.childPid = null;
    this.queue = Promise.resolve();
    this.initError = '';
    this.warnings = [];
    this.spawnedEver = false;
    this.usedFallbackShell = false;
  }

  ready() {
    return IS_WINDOWS
      && Date.now() >= this.unavailableUntil
      && !!this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.readyChild === this.child;
  }

  diagnostics() {
    return {
      lane: this.lane,
      ready: this.ready(),
      live: this.isLive(),
      child_pid: this.isLive() ? this.childPid : null,
      cooldown_remaining_ms: Math.max(0, this.unavailableUntil - Date.now()),
      consecutive_timeouts: this.consecutiveTimeouts,
      init_error: this.initError || undefined,
      warnings: this.warnings.length ? [...this.warnings] : undefined,
      spawn_failures: this.spawnFailures || 0,
      used_fallback_shell: this.usedFallbackShell || undefined,
    };
  }

  isLive() {
    const child = this.child;
    return !!child && !child.killed && child.exitCode === null;
  }

  async prepare(timeoutMs) {
    const startedAt = Date.now();
    if (!IS_WINDOWS) return { ready: false, elapsedMs: 0 };
    registerCleanup();
    if (Date.now() < this.unavailableUntil) return { ready: false, elapsedMs: 0 };
    const child = this.ensureChild();
    if (this.readyChild === child) return { ready: true, elapsedMs: Date.now() - startedAt };
    const ready = await new Promise(resolve => {
      let settled = false;
      let waiter;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.readinessWaiters.delete(waiter);
        resolve(value);
      };
      waiter = {
        child,
        resolve: finish,
        timer: setTimeout(() => finish(false), Math.max(0, Math.floor(timeoutMs))),
      };
      this.readinessWaiters.add(waiter);
      if (this.readyChild === child) finish(true);
    });
    return { ready, elapsedMs: Date.now() - startedAt };
  }

  async run(script, timeoutMs) {
    const startedAt = Date.now();
    if (!IS_WINDOWS) {
      return { ok: false, output: 'unsupported_platform: the persistent PowerShell lane host is Windows-only.', elapsedMs: 0, error_code: 'unsupported_platform' };
    }
    registerCleanup();
    if (Date.now() < this.unavailableUntil) {
      return {
        ok: false,
        output: `Computer Use ${this.lane} lane is cooling down after a timeout; it will accept work again shortly.`,
        elapsedMs: 0,
        error_code: 'lane_cooling_down',
      };
    }
    // Serialise the lane on the Node side as well: one lane executes one script at a time,
    // so a queued request must not burn its own timeout while an earlier script runs.
    const run = async () => {
      try {
        const result = await this.send(script, timeoutMs);
        if (result.ok) {
          this.consecutiveTimeouts = 0;
          this.unavailableUntil = 0;
        }
        return { ...result, elapsedMs: Date.now() - startedAt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out after/i.test(message)) {
          // A timed-out script is still occupying this lane: kill it and cool the lane down
          // so it cannot block any other lane.
          this.stop();
          this.consecutiveTimeouts += 1;
          const cooldown = ADVISORY_LANES.includes(this.lane)
            ? Math.min(500 * (2 ** Math.min(this.consecutiveTimeouts - 1, 3)), ADVISORY_TIMEOUT_COOLDOWN_MS)
            : LANE_TIMEOUT_COOLDOWN_MS;
          this.unavailableUntil = Date.now() + cooldown;
          this.initError = message;
          return { ok: false, output: message, elapsedMs: Date.now() - startedAt, error_code: 'lane_timeout', cooldown_ms: cooldown };
        }
        return { ok: false, output: message, elapsedMs: Date.now() - startedAt, error_code: 'lane_failure' };
      }
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(() => undefined, () => undefined);
    return await chained;
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.readyChild = null;
    this.childPid = null;
    if (child) this.resolveReadiness(child, false);
    if (child && !child.killed) {
      try { child.kill(); } catch { /* ignore */ }
    }
    this.rejectPending(`Computer Use ${this.lane} lane stopped.`);
  }

  async send(script, timeoutMs) {
    const child = this.ensureChild();
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Computer Use ${this.lane} lane timed out after ${timeoutMs} ms.`));
      }, Math.max(100, Number(timeoutMs) || 0));
      this.pending.set(id, {
        timer,
        resolve: result => resolve({ ...result, elapsedMs: Math.max(result.elapsedMs, Date.now() - startedAt) }),
      });
      const request = JSON.stringify({ id, script: Buffer.from(String(script), 'utf8').toString('base64') });
      child.stdin.write(`${request}\n`, 'utf8', error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  ensureChild() {
    if (this.isLive()) return this.child;
    if (!IS_WINDOWS) throw new Error('unsupported_platform: the persistent PowerShell lane host is Windows-only.');
    const executable = this.usedFallbackShell ? 'powershell.exe' : shellExecutable();
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', hostScript(this.lane)];
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.spawnedEver = true;
    child.stdin.setDefaultEncoding('utf8');
    let buffer = '';
    const handleChunk = chunk => {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        this.handleLine(line, child);
        index = buffer.indexOf('\n');
      }
      if (buffer.length > 4 * 1024 * 1024) buffer = '';
    };
    child.stdout.on('data', handleChunk);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8192); });
    child.once('error', error => {
      const code = error && error.code;
      // pwsh may be absent even though it sits on PATH as an execution alias: fall back once.
      if (code === 'ENOENT' && !this.usedFallbackShell && shellExecutable() !== 'powershell.exe') {
        this.usedFallbackShell = true;
        this.spawnFailures = (this.spawnFailures || 0) + 1;
        if (this.child === child) {
          this.child = null;
          this.readyChild = null;
          this.childPid = null;
          this.resolveReadiness(child, false);
        }
        return;
      }
      if (this.child !== child) return;
      this.child = null;
      this.readyChild = null;
      this.childPid = null;
      this.initError = error instanceof Error ? error.message : String(error);
      this.resolveReadiness(child, false);
      this.rejectPending(this.initError);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.readyChild = null;
      this.childPid = null;
      this.resolveReadiness(child, false);
      this.rejectPending(`Computer Use ${this.lane} lane exited (${code === null ? (signal || 'unknown') : code}).${stderr ? ` ${stderr.trim()}` : ''}`);
    });
    this.child = child;
    this.childPid = child.pid === undefined ? null : child.pid;
    return child;
  }

  handleLine(line, child) {
    const parsed = parseJsonObject(line);
    if (!parsed) return;
    if (String(parsed.id || '') === READY_ID) {
      if (this.child !== child) return;
      if (parsed.ready === true) {
        this.readyChild = child;
        this.initError = '';
        if (Array.isArray(parsed.warnings)) this.warnings = parsed.warnings.map(String);
        this.resolveReadiness(child, true);
      } else {
        this.initError = String(parsed.error || 'The lane host failed to initialise the native helper.');
        this.resolveReadiness(child, false);
      }
      return;
    }
    const id = String(parsed.id || '');
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve({
      ok: parsed.ok === true,
      output: String(parsed.output === undefined || parsed.output === null ? '' : parsed.output),
      elapsedMs: Math.max(0, Number(parsed.elapsed_ms) || 0),
    });
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, output: message, elapsedMs: 0 });
    }
    this.pending.clear();
  }

  resolveReadiness(child, ready) {
    for (const waiter of [...this.readinessWaiters]) {
      if (waiter.child === child) waiter.resolve(ready);
    }
  }
}

const workers = new Map(LANES.map(lane => [lane, new PowerShellWorker(lane)]));

function workerFor(lane) {
  const worker = workers.get(lane);
  if (!worker) throw new Error(`Unknown Computer Use lane: ${lane}`);
  return worker;
}

let cleanupRegistered = false;
function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    stopAll();
    releaseLease('process_exit');
  });
}

/** Start (or reuse) the persistent worker of one lane and wait for its readiness sentinel. */
export async function prepareLane(lane, timeoutMs = DEFAULT_INIT_TIMEOUT_MS) {
  if (!LANES.includes(lane)) return { ready: false, elapsedMs: 0, error: `Unknown Computer Use lane: ${lane}` };
  if (!IS_WINDOWS) return { ready: false, elapsedMs: 0, error: 'unsupported_platform' };
  return await workerFor(lane).prepare(clampNumber(timeoutMs, 100, 120000, DEFAULT_INIT_TIMEOUT_MS));
}

/** Send one script to one lane and read until that request's end sentinel. */
export async function runInLane(lane, script, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
  if (!LANES.includes(lane)) {
    return { ok: false, output: `Unknown Computer Use lane: ${lane}`, elapsedMs: 0, error_code: 'unknown_lane' };
  }
  if (!IS_WINDOWS) {
    return { ok: false, output: 'unsupported_platform: the persistent PowerShell lane host is Windows-only.', elapsedMs: 0, error_code: 'unsupported_platform' };
  }
  return await workerFor(lane).run(String(script), clampNumber(timeoutMs, 100, 300000, DEFAULT_ACTION_TIMEOUT_MS));
}

export function laneReady(lane) {
  if (!LANES.includes(lane)) return false;
  return workerFor(lane).ready();
}

export function stopLane(lane) {
  if (!LANES.includes(lane)) return;
  workerFor(lane).stop();
}

/** Terminate every lane child process. Safe to call at any time, including from exit. */
export function stopAll() {
  for (const lane of LANES) workers.get(lane).stop();
  releaseLease('stop_all');
}

/** How many lane child processes are still alive right now. */
export function liveLaneCount() {
  let live = 0;
  for (const lane of LANES) {
    if (workers.get(lane).isLive()) live += 1;
  }
  return live;
}

/** Per-lane diagnostics for mode_report. */
export function laneDiagnostics() {
  return LANES.map(lane => workers.get(lane).diagnostics());
}

/* ------------------------------------------------------------------ *
 * 5. capture and observation
 * ------------------------------------------------------------------ */

const CAPTURE_DIRECTORY_NAME = 'newmark2dsh-computer-use';

function captureDirectory() {
  const directory = path.join(os.tmpdir(), CAPTURE_DIRECTORY_NAME);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function capturePath(ownerId, kind) {
  const nonce = crypto.randomBytes(4).toString('hex');
  return path.join(captureDirectory(), `${kind}-${crypto.createHash('sha1').update(String(ownerId)).digest('hex').slice(0, 8)}-${Date.now()}-${nonce}.png`);
}

function laneWorkerOrNull(lane) {
  const worker = workers.get(lane);
  return worker || null;
}

/** The digest grid and the scale-down happen in the lane; this is the shared core. */
function windowBitmapLines(handle, processId) {
  return [
    `$hwnd = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleHex(handle))}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($hwnd, ${Number(processId) || 0})`,
    `if ($ownership -eq 2) { ${psError('target_window_ownership_changed', 'The process id no longer owns the target window.')} }`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target window is no longer valid.')} }`,
    `if ([NewmarkCuNative]::IsIconic($hwnd)) { ${psError('window_minimized', 'A minimized window has no capturable presentation.')} }`,
    '$bounds = [NewmarkCuNative]::BoundsRectValues($hwnd)',
    `if ($bounds.Count -lt 4) { ${psError('window_rect_unavailable', 'The target window did not report a window rectangle.')} }`,
    '$sourceX = $bounds[0]; $sourceY = $bounds[1]',
    '$sourceWidth = $bounds[2] - $bounds[0]; $sourceHeight = $bounds[3] - $bounds[1]',
    `if ($sourceWidth -le 0 -or $sourceHeight -le 0) { ${psError('capture_zero_size', 'The target window reported a zero-size presentation.')} }`,
  ];
}

function digestSampleLines(bitmapExpression) {
  const cells = SPARSE_DIGEST_WIDTH * SPARSE_DIGEST_HEIGHT;
  return [
    `$thumb = New-Object System.Drawing.Bitmap ${SPARSE_DIGEST_WIDTH}, ${SPARSE_DIGEST_HEIGHT}`,
    '$thumbGraphics = [System.Drawing.Graphics]::FromImage($thumb)',
    '$thumbGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear',
    `$thumbGraphics.DrawImage(${bitmapExpression}, 0, 0, ${SPARSE_DIGEST_WIDTH}, ${SPARSE_DIGEST_HEIGHT})`,
    '$thumbGraphics.Dispose()',
    `$luma = New-Object System.Collections.Generic.List[int]`,
    `for ($row = 0; $row -lt ${SPARSE_DIGEST_HEIGHT}; $row++) {`,
    `  for ($column = 0; $column -lt ${SPARSE_DIGEST_WIDTH}; $column++) {`,
    '    $pixel = $thumb.GetPixel($column, $row)',
    '    $luma.Add([int][Math]::Round(($pixel.R * 0.299) + ($pixel.G * 0.587) + ($pixel.B * 0.114)))',
    '  }',
    '}',
    '$thumb.Dispose()',
    `$distinct = ($luma | Sort-Object -Unique).Count`,
    `$cells = ${cells}`,
    'if ($distinct -le 1) { ' + psError('capture_monochrome', 'The capture was a single flat colour, so it is not a real desktop presentation.') + ' }',
    '$lumaText = ($luma -join ",")',
  ];
}

/** Full capture of one window: PrintWindow(hwnd, hdc, 2) in the window_capture lane only. */
function fullCaptureScript(handle, processId, outPath, maxWidth, maxHeight) {
  return [
    '$ErrorActionPreference = "Stop"',
    ...windowBitmapLines(handle, processId),
    '$source = New-Object System.Drawing.Bitmap $sourceWidth, $sourceHeight',
    '$sourceGraphics = [System.Drawing.Graphics]::FromImage($source)',
    '$previousDpi = [NewmarkCuNative]::EnterPhysicalDpiContext()',
    'try {',
    '  $captureHdc = $sourceGraphics.GetHdc()',
    '  try { $captured = [NewmarkCuNative]::PrintWindow($hwnd, $captureHdc, 2) } finally { $sourceGraphics.ReleaseHdc($captureHdc) }',
    '} finally { [NewmarkCuNative]::LeavePhysicalDpiContext($previousDpi) }',
    `if (-not $captured) { ${psError('capture_failed', 'PrintWindow could not render this application window.')} }`,
    ...digestSampleLines('$source'),
    `$maxWidth = ${maxWidth}; $maxHeight = ${maxHeight}`,
    '$scale = [Math]::Min(1.0, [Math]::Min(($maxWidth / [double]$sourceWidth), ($maxHeight / [double]$sourceHeight)))',
    '$imageWidth = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))',
    '$imageHeight = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))',
    '$target = New-Object System.Drawing.Bitmap $imageWidth, $imageHeight',
    '$targetGraphics = [System.Drawing.Graphics]::FromImage($target)',
    '$targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear',
    '$targetGraphics.DrawImage($source, 0, 0, $imageWidth, $imageHeight)',
    '$targetGraphics.Dispose()',
    `${psQuote(outPath)} | ForEach-Object { if ([System.IO.File]::Exists($_)) { [System.IO.File]::Delete($_) } }`,
    `$target.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$target.Dispose(); $sourceGraphics.Dispose(); $source.Dispose()',
    `$imageBytes = (Get-Item -LiteralPath ${psQuote(outPath)}).Length`,
    `$lumaValues = @($lumaText -split "," | ForEach-Object { [int]$_ })`,
    `Write-Output (@{ ok=$true; image_path=${psQuote(outPath)}; width=$sourceWidth; height=$sourceHeight; image_width=$imageWidth; image_height=$imageHeight; image_bytes=$imageBytes; image_mime="image/png"; capture_method="PrintWindow(hwnd,hdc,2)"; digest_width=${SPARSE_DIGEST_WIDTH}; digest_height=${SPARSE_DIGEST_HEIGHT}; distinct_luma=$distinct; luma_min=($lumaValues | Measure-Object -Minimum).Minimum; luma_max=($lumaValues | Measure-Object -Maximum).Maximum; luma=$lumaText } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

/** One 32x18 grayscale digest of one window, used by sparse observation. */
function sparseDigestScript(handle, processId) {
  return [
    '$ErrorActionPreference = "Stop"',
    ...windowBitmapLines(handle, processId),
    '$source = New-Object System.Drawing.Bitmap $sourceWidth, $sourceHeight',
    '$sourceGraphics = [System.Drawing.Graphics]::FromImage($source)',
    '$previousDpi = [NewmarkCuNative]::EnterPhysicalDpiContext()',
    'try {',
    '  $captureHdc = $sourceGraphics.GetHdc()',
    '  try { $captured = [NewmarkCuNative]::PrintWindow($hwnd, $captureHdc, 2) } finally { $sourceGraphics.ReleaseHdc($captureHdc) }',
    '} finally { [NewmarkCuNative]::LeavePhysicalDpiContext($previousDpi) }',
    `if (-not $captured) { ${psError('capture_failed', 'PrintWindow could not render this application window.')} }`,
    ...digestSampleLines('$source'),
    '$sourceGraphics.Dispose(); $source.Dispose()',
    `Write-Output (@{ ok=$true; digest_width=${SPARSE_DIGEST_WIDTH}; digest_height=${SPARSE_DIGEST_HEIGHT}; width=$sourceWidth; height=$sourceHeight; distinct_luma=$distinct; luma=$lumaText } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function lumaToBytes(luma) {
  const values = Array.isArray(luma) ? luma : [];
  const bytes = Buffer.alloc(Math.max(0, Math.min(values.length, SPARSE_DIGEST_WIDTH * SPARSE_DIGEST_HEIGHT)));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = clampNumber(values[index], 0, 255, 0);
  }
  return bytes;
}

function lumaArray(value) {
  if (Array.isArray(value)) return value.map(item => clampNumber(item, 0, 255, 0));
  return String(value === null || value === undefined ? '' : value)
    .split(',')
    .map(item => clampNumber(item, 0, 255, 0));
}

function digestOf(luma) {
  return crypto.createHash('sha256').update(lumaToBytes(luma)).digest('hex').slice(0, 16);
}

/**
 * Full observation of one window: one PrintWindow capture in the window_capture lane.
 * A monochrome or zero-size capture is a hard error, never a silent empty image.
 */
export async function captureWindow(options = {}) {
  const handle = handleHex(options.handle || options.windowHandle);
  const processId = Number(options.processId || options.process_id || 0);
  if (!handle) return failure('observe', 'window_handle_required', 'A non-zero native window handle is required for capture.');
  if (!IS_WINDOWS) return failure('observe', 'unsupported_platform', 'Computer Use Win32 capture is Windows-only.');
  const maxWidth = clampNumber(options.maxWidth ?? options.captureMaxWidth, 320, 2048, 1280);
  const maxHeight = clampNumber(options.maxHeight ?? options.captureMaxHeight, 240, 2048, 960);
  const ownerId = String(options.ownerId || 'direct');
  const lane = 'window_capture';
  const outPath = options.imagePath || capturePath(ownerId, 'observe');
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return failure('observe', 'lane_unavailable', `The window_capture lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}`, { lane });
  }
  const startedAt = Date.now();
  const result = await runInLane(lane, fullCaptureScript(handle, processId, outPath, maxWidth, maxHeight), clampNumber(options.timeoutMs, 1000, 300000, 30000));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    return failure('observe', parsed.code, parsed.message, { lane, window_handle: unwrapHandle(handle), telemetry: { capture_ms: Date.now() - startedAt, lane } });
  }
  const parsed = parseJsonObject(result.output);
  if (!parsed || parsed.ok !== true) {
    return failure('observe', 'capture_result_invalid', 'The window_capture lane returned an unreadable capture result.', { lane });
  }
  const width = Number(parsed.width) || 0;
  const height = Number(parsed.height) || 0;
  const distinct = Number(parsed.distinct_luma) || 0;
  if (width <= 0 || height <= 0) {
    return failure('observe', 'capture_zero_size', 'The capture reported a zero-size presentation, so it is not a usable observation.', { lane });
  }
  if (distinct <= 1) {
    return failure('observe', 'capture_monochrome', 'The capture was a single flat colour, so it is not a real desktop presentation.', { lane });
  }
  return {
    ok: true,
    action: 'observe',
    lane,
    image_path: String(parsed.image_path || outPath),
    width,
    height,
    image_width: Number(parsed.image_width) || width,
    image_height: Number(parsed.image_height) || height,
    image_bytes: Number(parsed.image_bytes) || 0,
    image_mime: 'image/png',
    capture_method: String(parsed.capture_method || 'PrintWindow(hwnd,hdc,2)'),
    digest: {
      width: SPARSE_DIGEST_WIDTH,
      height: SPARSE_DIGEST_HEIGHT,
      sha256_prefix: digestOf(lumaArray(parsed.luma)),
      luma_min: Number(parsed.luma_min) || 0,
      luma_max: Number(parsed.luma_max) || 0,
      distinct_luma: distinct,
    },
    telemetry: { capture_ms: Date.now() - startedAt, lane, lane_elapsed_ms: result.elapsedMs },
  };
}

/**
 * Sparse observation: passive bounded sampling of a 32x18 grayscale digest, at most 5 Hz.
 * The result is a wake-up hint only, never a fresh full observation.
 */
export async function sparseObservation(options = {}) {
  const action = String(options.action || 'observe');
  const handle = handleHex(options.windowHandle || options.handle);
  const processId = Number(options.processId || options.process_id || 0);
  const requestedWait = options.sparseWaitMs ?? options.sparse_wait_ms;
  const waitMs = clampNumber(requestedWait, 0, SPARSE_MAX_WAIT_MS, 0);
  const signal = options.signal;
  const lane = 'sparse';
  const base = {
    ok: true,
    action,
    observation: 'sparse',
    mouse_mode: options.mouseMode === 'virtual' ? 'virtual' : 'real',
    must_reacquire_full_observation: true,
    sparse_digest: `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}-grayscale`,
    sparse_wait_ms: waitMs,
    sparse_max_wait_ms: SPARSE_MAX_WAIT_MS,
    sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
    window_handle: handle ? unwrapHandle(handle) : undefined,
  };
  if (signal && signal.aborted) return cancelledResult(action, signal, { ...base, ok: false });
  if (!handle) {
    return {
      ...base,
      ok: false,
      changed: false,
      samples: 0,
      reason: 'window_handle_required',
      error_code: 'window_handle_required',
      error: 'Sparse observation needs a target window: pass window_handle or app_target, or observe with a foreground window available.',
    };
  }
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return {
      ...base,
      ok: false,
      changed: false,
      reason: 'lane_unavailable',
      error_code: 'lane_unavailable',
      error: `The sparse lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}`,
      samples: 0,
    };
  }
  const deadline = Date.now() + waitMs;
  const maxSamples = Math.max(1, Math.min(1 + Math.ceil(waitMs / SPARSE_MIN_INTERVAL_MS), 26));
  let baseline = null;
  let samples = 0;
  let changedCells = 0;
  let strongCells = 0;
  let digestDelta = 0;
  let lastSampleAt = 0;
  let reason = 'wait_elapsed';
  let lastDigest = '';
  let lastError;
  while (samples < maxSamples) {
    if (signal && signal.aborted) return cancelledResult(action, signal, { ...base, ok: false, samples });
    if (lastSampleAt) {
      const gap = lastSampleAt + SPARSE_MIN_INTERVAL_MS - Date.now();
      if (gap > 0) await sleep(Math.min(gap, Math.max(0, deadline - Date.now()) + SPARSE_MIN_INTERVAL_MS));
    }
    if (samples > 0 && Date.now() > deadline) break;
    const result = await runInLane(lane, sparseDigestScript(handle, processId), clampNumber(options.timeoutMs, 1000, 300000, 15000));
    if (!result.ok) {
      const parsed = parsePsError(result.output);
      reason = 'sampling_failed';
      lastError = { error_code: parsed.code, error: parsed.message };
      break;
    }
    const parsed = parseJsonObject(result.output);
    if (!parsed || parsed.ok !== true) {
      reason = 'sampling_failed';
      lastError = { error_code: 'sampling_result_invalid', error: 'The sparse lane returned an unreadable digest result.' };
      break;
    }
    const luma = lumaArray(parsed.luma);
    samples += 1;
    lastSampleAt = Date.now();
    if (!baseline) {
      baseline = luma;
      lastDigest = digestOf(luma);
      if (waitMs === 0 || samples >= maxSamples) break;
      continue;
    }
    changedCells = 0;
    strongCells = 0;
    digestDelta = 0;
    const cells = Math.min(baseline.length, luma.length);
    for (let index = 0; index < cells; index += 1) {
      const delta = Math.abs(luma[index] - baseline[index]);
      digestDelta += delta;
      if (delta >= SPARSE_CELL_THRESHOLD) changedCells += 1;
      if (delta >= SPARSE_STRONG_THRESHOLD) strongCells += 1;
    }
    lastDigest = digestOf(luma);
    if (changedCells >= 4 || strongCells >= 2) {
      reason = 'coarse_change';
      break;
    }
    if (Date.now() >= deadline) break;
  }
  const changed = reason === 'coarse_change';
  return {
    ...base,
    ok: reason !== 'sampling_failed',
    changed,
    changed_cells: changedCells,
    strong_cells: strongCells,
    digest_delta: digestDelta,
    digest_delta_ratio: Number((digestDelta / (SPARSE_DIGEST_WIDTH * SPARSE_DIGEST_HEIGHT * 255)).toFixed(6)),
    digest: lastDigest,
    samples,
    reason,
    telemetry: { lane, sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS, sparse_wait_ms: waitMs },
    ...(lastError || {}),
  };
}

/* ------------------------------------------------------------------ *
 * 6. window enumeration, UIA and target resolution
 * ------------------------------------------------------------------ */

const targetsByOwner = new Map();
const observationsByOwner = new Map();

function ownerKey(ownerId) {
  return String(ownerId || 'direct');
}

function targetRegistry(ownerId) {
  const key = ownerKey(ownerId);
  if (!targetsByOwner.has(key)) targetsByOwner.set(key, new Map());
  return targetsByOwner.get(key);
}

function observationCache(ownerId) {
  return observationsByOwner.get(ownerKey(ownerId));
}

function sceneGeneration(applications, controls) {
  const windowPart = applications
    .map(app => `${app.handle}|${app.process_id}|${app.rect ? `${app.rect.x},${app.rect.y},${app.rect.width},${app.rect.height}` : ''}|${app.foreground ? 'fg' : ''}`)
    .sort()
    .join(';');
  const controlPart = controls
    .slice(0, 48)
    .map(control => `${control.control_type}|${normalizeText(control.name)}|${control.rect ? `${bucket(control.rect.x)},${bucket(control.rect.y)}` : ''}`)
    .join(';');
  return crypto.createHash('sha1').update(`${windowPart}#${controlPart}`).digest('hex').slice(0, 16);
}

function windowListScript(virtualScope, includeMinimized) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$virtualScope = ${virtualScope ? '$true' : '$false'}`,
    `$includeMinimized = ${includeMinimized ? '$true' : '$false'}`,
    '$items = New-Object System.Collections.Generic.List[object]',
    'foreach ($window in [NewmarkCuNative]::EnumTopLevelWindows($virtualScope, $includeMinimized)) {',
    '  $items.Add([pscustomobject]@{',
    `    handle=("0x{0:X}" -f $window.Handle);`,
    '    title=[string]$window.Title;',
    '    process_id=[int]$window.ProcessId;',
    '    class_name=[string]$window.ClassName;',
    '    rect=[pscustomobject]@{ x=[int]$window.Left; y=[int]$window.Top; width=[int]($window.Right - $window.Left); height=[int]($window.Bottom - $window.Top) };',
    '    client_rect=[pscustomobject]@{ x=[int]$window.ClientLeft; y=[int]$window.ClientTop; width=[int]$window.ClientWidth; height=[int]$window.ClientHeight };',
    '    visible=[bool]$window.Visible;',
    '    minimized=[bool]$window.Minimized;',
    '    foreground=[bool]$window.Foreground;',
    '    occluded=[bool]$window.Occluded;',
    '  }) | Out-Null',
    '}',
    '$maxChars = 200000',
    '$json = ConvertTo-Json -Depth 5 -Compress @($items.ToArray())',
    'while ($items.Count -gt 1 -and $json.Length -gt $maxChars) { $items.RemoveAt($items.Count - 1); $json = ConvertTo-Json -Depth 5 -Compress @($items.ToArray()) }',
    'Write-Output $json',
  ].join('\r\n');
}

function windowByHandleScript(handle, processId) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$hwnd = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleHex(handle))}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($hwnd, ${Number(processId) || 0})`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target window is no longer valid or is owned by another process.')} }`,
    '$rect = [NewmarkCuNative]::WindowRectValues($hwnd)',
    '$client = [NewmarkCuNative]::ClientAreaValues($hwnd)',
    `if ($rect.Count -lt 4) { ${psError('window_rect_unavailable', 'The target window did not report a window rectangle.')} }`,
    `Write-Output (@{ ok=$true; handle=("0x{0:X}" -f $hwnd.ToInt64()); title=[NewmarkCuNative]::WindowTitle($hwnd); process_id=[NewmarkCuNative]::GetProcessId($hwnd); class_name=[NewmarkCuNative]::ClassName($hwnd); rect=@{ x=$rect[0]; y=$rect[1]; width=($rect[2]-$rect[0]); height=($rect[3]-$rect[1]) }; client_rect=@{ x=$client[0]; y=$client[1]; width=$client[2]; height=$client[3] }; visible=[NewmarkCuNative]::IsWindowVisible($hwnd); minimized=[NewmarkCuNative]::IsIconic($hwnd); foreground=([NewmarkCuNative]::GetForegroundWindow() -eq $hwnd); occluded=$false } | ConvertTo-Json -Compress -Depth 5)`,
  ].join('\r\n');
}

/** Top-level windows, with the virtual/real occlusion rules applied. */
async function enumerateApplications(options = {}) {
  const action = String(options.action || 'app_list');
  const virtualScope = options.virtualScope === true;
  const includeMinimized = options.includeMinimized === true;
  const lane = advisoryLane('windows', options);
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return { ok: false, applications: [], lane, error_code: 'lane_unavailable', error: `The ${lane} lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}` };
  }
  const startedAt = Date.now();
  const result = await runInLane(lane, windowListScript(virtualScope, includeMinimized), clampNumber(options.timeoutMs, 1000, 120000, 30000));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    return { ok: false, applications: [], lane, error_code: parsed.code, error: parsed.message, elapsedMs: Date.now() - startedAt };
  }
  const applications = parseJsonArray(result.output)
    .filter(entry => entry && typeof entry === 'object')
    .slice(0, MAX_APPLICATIONS)
    .map(entry => ({
      handle: String(entry.handle || ''),
      title: String(entry.title || ''),
      process_id: Number(entry.process_id) || 0,
      class_name: String(entry.class_name || ''),
      rect: normalizeRect(entry.rect),
      client_rect: normalizeRect(entry.client_rect),
      visible: entry.visible === true,
      minimized: entry.minimized === true,
      foreground: entry.foreground === true,
      occluded: entry.occluded === true,
    }))
    .filter(entry => handleToInt(entry.handle) !== 0);
  return { ok: true, applications, lane, elapsedMs: Date.now() - startedAt };
}

function normalizeRect(rect) {
  const source = rect && typeof rect === 'object' ? rect : {};
  return {
    x: Number(source.x) || 0,
    y: Number(source.y) || 0,
    width: Math.max(0, Number(source.width) || 0),
    height: Math.max(0, Number(source.height) || 0),
  };
}

/** Resolve the lane for a kind, honouring an explicit advisory lane request. */
function advisoryLane(kind, options = {}) {
  const requested = typeof options.lane === 'string' ? options.lane : '';
  if (kind === 'uia' && requested === 'uia_advisory') return 'uia_advisory';
  if (kind === 'windows' && requested === 'windows_advisory') return 'windows_advisory';
  return kind;
}

/** Bounded UI Automation control list of one window, with stable target ids. */
function uiaScript(handleHexValue, maxChars) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$nativeHandle = [System.IntPtr]::new([Convert]::ToInt64(${psQuote(handleHexValue)}, 16))`,
    '$root = [System.Windows.Automation.AutomationElement]::FromHandle($nativeHandle)',
    `if ($null -eq $root) { ${psError('uia_root_unavailable', 'The UI Automation root of the target window is unavailable.')} }`,
    '$cache = New-Object System.Windows.Automation.CacheRequest',
    '$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element',
    '$cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition',
    '@([System.Windows.Automation.AutomationElement]::NameProperty, [System.Windows.Automation.AutomationElement]::AutomationIdProperty, [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.AutomationElement]::ClassNameProperty, [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty, [System.Windows.Automation.AutomationElement]::IsOffscreenProperty, [System.Windows.Automation.AutomationElement]::IsEnabledProperty) | ForEach-Object { $cache.Add($_) }',
    '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
    '$stack = New-Object System.Collections.Stack',
    '$first = $walker.GetFirstChild($root, $cache)',
    'if ($null -ne $first) { $stack.Push($first) }',
    '$items = New-Object System.Collections.Generic.List[object]',
    '$visited = 0',
    `while ($stack.Count -gt 0 -and $visited -lt 240 -and $items.Count -lt ${MAX_UIA_ELEMENTS}) {`,
    '  $element = [System.Windows.Automation.AutomationElement]$stack.Pop()',
    '  $visited++',
    '  try { $sibling = $walker.GetNextSibling($element, $cache); if ($null -ne $sibling) { $stack.Push($sibling) } } catch { }',
    '  try { $child = $walker.GetFirstChild($element, $cache); if ($null -ne $child) { $stack.Push($child) } } catch { }',
    '  try {',
    '    $rect = $element.Cached.BoundingRectangle',
    '    $name = [string]$element.Cached.Name',
    '    $automationId = [string]$element.Cached.AutomationId',
    '    if (($name -or $automationId) -and $rect.Width -gt 1 -and $rect.Height -gt 1 -and -not $element.Cached.IsOffscreen) {',
    '      $items.Add([pscustomobject]@{',
    '        name=$name;',
    '        automation_id=$automationId;',
    '        control_type=$element.Cached.ControlType.ProgrammaticName.Replace("ControlType.","");',
    '        class_name=[string]$element.Cached.ClassName;',
    '        process_id=[int]$element.Cached.ProcessId;',
    '        enabled=[bool]$element.Cached.IsEnabled;',
    '        bbox=@{ x=[int]$rect.X; y=[int]$rect.Y; width=[int]$rect.Width; height=[int]$rect.Height };',
    '        center=@{ x=[int]($rect.X + ($rect.Width / 2)); y=[int]($rect.Y + ($rect.Height / 2)) }',
    '      }) | Out-Null',
    '    }',
    '  } catch { }',
    '}',
    `$maxChars = ${maxChars}`,
    '$payload = @{ visited=$visited; items=$items.ToArray() }',
    '$json = $payload | ConvertTo-Json -Depth 5 -Compress',
    'while ($json.Length -gt $maxChars -and $items.Count -gt 0) { $items.RemoveAt($items.Count - 1); $payload = @{ visited=$visited; items=$items.ToArray() }; $json = $payload | ConvertTo-Json -Depth 5 -Compress }',
    'Write-Output $json',
  ].join('\r\n');
}

/**
 * Observe the UIA controls of one window and register stable target ids for the owner.
 * The registry keeps a click point per target id, so move/click can use target_id.
 */
async function observeControls(handle, processId, options = {}) {
  const action = String(options.action || 'observe');
  const handleValue = handleHex(handle);
  if (!handleValue) return { ok: false, controls: [], error_code: 'window_handle_required', error: 'UI Automation needs a non-zero native window handle.' };
  const lane = advisoryLane('uia', options);
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return { ok: false, controls: [], lane, error_code: 'lane_unavailable', error: `The ${lane} lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}` };
  }
  const startedAt = Date.now();
  const maxChars = clampNumber(options.maxChars, 1000, 200000, 60000);
  const result = await runInLane(lane, uiaScript(handleValue, maxChars), clampNumber(options.timeoutMs, 1000, 120000, 30000));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    return { ok: false, controls: [], lane, error_code: parsed.code, error: parsed.message, elapsedMs: Date.now() - startedAt };
  }
  const payload = parseJsonObject(result.output);
  const elements = payload && Array.isArray(payload.items) ? payload.items : [];
  const registry = targetRegistry(options.ownerId);
  const controls = [];
  const seen = new Set();
  for (const element of elements) {
    const rect = normalizeRect(element.bbox);
    const name = String(element.name || '');
    const automationId = String(element.automation_id || '');
    if (!name && !automationId) continue;
    if (rect.width <= 1 || rect.height <= 1) continue;
    const targetId = stableTargetId({ name, automationId, controlType: element.control_type, className: element.class_name, rect });
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    const center = {
      x: Number(element.center && element.center.x) || Math.round(rect.x + rect.width / 2),
      y: Number(element.center && element.center.y) || Math.round(rect.y + rect.height / 2),
    };
    controls.push({
      target_id: targetId,
      name,
      control_type: String(element.control_type || ''),
      rect,
      enabled: element.enabled !== false,
    });
    registry.set(targetId, {
      target_id: targetId,
      x: center.x,
      y: center.y,
      rect,
      name,
      control_type: String(element.control_type || ''),
      risk: controlRisk({ name, automationId, controlType: element.control_type }),
      window_handle: unwrapHandle(handleValue),
      process_id: Number(processId) || Number(element.process_id) || 0,
      role: semanticRole(element.control_type),
    });
  }
  if (registry.size > 2000) {
    const excess = [...registry.keys()].slice(0, registry.size - 2000);
    for (const key of excess) registry.delete(key);
  }
  return {
    ok: true,
    controls,
    visited: payload ? Number(payload.visited) || 0 : 0,
    lane,
    elapsedMs: Date.now() - startedAt,
    truncated: payload ? payload.items && payload.items.length > controls.length : false,
  };
}

function semanticRole(controlType) {
  const type = String(controlType || '').toLowerCase();
  if (type.includes('button')) return 'button';
  if (type.includes('edit') || type.includes('document')) return 'text';
  if (type.includes('menu')) return 'menu';
  if (type.includes('tab')) return 'tab';
  if (type.includes('list')) return 'list';
  if (type.includes('checkbox')) return 'checkbox';
  if (type.includes('radio')) return 'radio';
  return type || 'control';
}

function controlRisk(control) {
  const marker = `${control.name} ${control.automationId} ${control.controlType}`.toLowerCase();
  return /delete|remove|format|reset|shutdown|close|付款|支付|删除|移除|重置/.test(marker) ? 'medium' : 'low';
}

/** Deterministic, stable across observations while the control stays put. */
function stableTargetId(control) {
  const parts = [
    normalizeText(control.name),
    normalizeText(control.automationId),
    normalizeText(control.controlType),
    normalizeText(control.className),
    String(bucket(control.rect ? control.rect.x : 0)),
    String(bucket(control.rect ? control.rect.y : 0)),
    String(bucket(control.rect ? control.rect.width : 0, 24)),
    String(bucket(control.rect ? control.rect.height : 0, 24)),
  ];
  return `cu-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`;
}

function resolveTargetId(targetId, ownerId) {
  const key = String(targetId || '').trim();
  if (!key) return null;
  const registry = targetRegistry(ownerId);
  const entry = registry.get(key);
  if (entry) return { ...entry, ok: true };
  return { ok: false, error_code: 'target_id_unknown', error: `Unknown target_id ${key}; call observe or app_observe again before acting on it.` };
}

/** Fetch one window by handle through the windows lane. */
async function applicationByHandle(handle, options = {}) {
  const lane = advisoryLane('windows', options);
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return { ok: false, error_code: 'lane_unavailable', error: `The ${lane} lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}` };
  }
  const result = await runInLane(lane, windowByHandleScript(handle, 0), clampNumber(options.timeoutMs, 1000, 120000, 15000));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    return { ok: false, error_code: parsed.code, error: parsed.message };
  }
  const parsed = parseJsonObject(result.output);
  if (!parsed || parsed.ok !== true) return { ok: false, error_code: 'window_result_invalid', error: 'The windows lane returned an unreadable window record.' };
  return {
    ok: true,
    application: {
      handle: String(parsed.handle || ''),
      title: String(parsed.title || ''),
      process_id: Number(parsed.process_id) || 0,
      class_name: String(parsed.class_name || ''),
      rect: normalizeRect(parsed.rect),
      client_rect: normalizeRect(parsed.client_rect),
      visible: parsed.visible === true,
      minimized: parsed.minimized === true,
      foreground: parsed.foreground === true,
      occluded: parsed.occluded === true,
    },
  };
}

/**
 * Resolve the target application of an app-scoped action: an explicit window handle, a
 * title match, the bound virtual target, or the foreground window.
 */
async function resolveApplication(options = {}) {
  const explicitHandle = handleHex(options.windowHandle || options.window_handle);
  if (explicitHandle) {
    const resolved = await applicationByHandle(explicitHandle, options);
    if (!resolved.ok) return { ok: false, applications: [], error_code: resolved.error_code, error: resolved.error };
    return { ok: true, application: resolved.application };
  }
  const virtual = options.virtualScope === true;
  if (virtual) {
    const bound = virtualPointerFor(options.ownerId);
    if (bound && bound.windowHandle) {
      const resolved = await applicationByHandle(bound.windowHandle, options);
      if (resolved.ok) return { ok: true, application: resolved.application };
    }
  }
  const enumerated = await enumerateApplications({ ...options, virtualScope: virtual });
  if (!enumerated.ok) return { ok: false, applications: [], error_code: enumerated.error_code, error: enumerated.error };
  const applications = enumerated.applications;
  const target = String(options.appTarget || options.app_target || '').trim();
  if (!target) {
    if (!virtual) {
      const foreground = applications.find(app => app.foreground === true);
      if (foreground) return { ok: true, application: foreground };
      return { ok: false, applications, error_code: 'foreground_window_unavailable', error: 'No foreground window is available to act on.' };
    }
    return { ok: false, applications, error_code: 'app_target_required', error: 'Virtual mode requires an app_target or window_handle so it never falls back to the foreground desktop.' };
  }
  const wanted = target.toLowerCase();
  const wantedHandle = handleHex(target);
  let matches = applications.filter(app => (wantedHandle && app.handle.toLowerCase() === `0x${wantedHandle}`.toLowerCase()));
  if (!matches.length) matches = applications.filter(app => app.title.toLowerCase().includes(wanted));
  if (!matches.length) matches = applications.filter(app => app.class_name.toLowerCase().includes(wanted));
  if (!matches.length) {
    return {
      ok: false,
      applications: applications.slice(0, 20),
      error_code: 'app_target_not_found',
      error: `No open window matched app_target ${target}.`,
    };
  }
  const preferred = matches.find(app => app.foreground === true) || matches[0];
  return { ok: true, application: preferred, applications: matches.slice(0, 20) };
}

/* ------------------------------------------------------------------ *
 * 7. real (physical) pointer and keyboard delivery, behind one reservation queue
 * ------------------------------------------------------------------ */

let lastRealMouseReservationAt = 0;
let realMouseQueue = Promise.resolve();

/**
 * One reservation queue for clicks and drags. A sequence that clicks therefore waits in the
 * same queue as a direct click: nothing bypasses the 350 ms floor.
 */
async function withRealMouseReservation(operation) {
  let unlock = () => {};
  const previous = realMouseQueue;
  realMouseQueue = new Promise(resolve => { unlock = resolve; });
  await previous;
  try {
    const delayMs = Math.max(0, lastRealMouseReservationAt + MIN_ACTION_INTERVAL_MS - Date.now());
    if (delayMs > 0) await sleep(delayMs);
    try {
      return await operation();
    } finally {
      lastRealMouseReservationAt = Date.now();
    }
  } finally {
    unlock();
  }
}

function foregroundGuardLines(expect = {}) {
  const lines = [];
  const handle = handleHex(expect.handle);
  if (handle) {
    const literal = `[IntPtr]::new([Convert]::ToInt64(${psQuote(handle)}, 16))`;
    lines.push(`$expectedForeground = ${literal}`);
    lines.push(`$targetState = [NewmarkCuNative]::WindowOwnershipState($expectedForeground, ${Number(expect.processId) || 0})`);
    lines.push(`if ($targetState -eq 2) { ${psError('target_window_ownership_changed', 'The process id no longer owns the target window, so the real-mode action was refused.')} }`);
    lines.push(`if ($targetState -ne 0) { ${psError('target_window_invalid', 'The target window is no longer valid, so the real-mode action was refused.')} }`);
    lines.push(`if ([NewmarkCuNative]::GetForegroundWindow() -ne $expectedForeground) { ${psError('foreground_not_granted', 'Activation did not grant foreground to the target window, so the real-mode action was refused instead of typing into another window.')} }`);
  } else {
    lines.push(`if ([NewmarkCuNative]::GetForegroundWindow() -eq [IntPtr]::Zero) { ${psError('foreground_unavailable', 'No foreground window is available for real-mode delivery.')} }`);
  }
  return lines;
}

function realMoveScript(x, y, expect) {
  return [
    '$ErrorActionPreference = "Stop"',
    ...foregroundGuardLines(expect),
    `if (-not [NewmarkCuNative]::MoveCursorSmooth(${x}, ${y})) { ${psError('cursor_move_failed', 'Smooth physical cursor movement failed for the requested screen coordinate.')} }`,
    `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; x=${x}; y=${y}; path_duration_ms=${MOVE_CURVE_MS}; foreground_verified=$true } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function realClickScript(x, y, button, expect) {
  const isRight = button === 'right';
  const down = isRight ? '0x0008' : '0x0002';
  const up = isRight ? '0x0010' : '0x0004';
  return [
    '$ErrorActionPreference = "Stop"',
    ...foregroundGuardLines(expect),
    `if (-not [NewmarkCuNative]::MoveCursorSmooth(${x}, ${y})) { ${psError('cursor_move_failed', 'Smooth physical cursor movement failed for the requested screen coordinate.')} }`,
    'if ([NewmarkCuNative]::GetForegroundWindow() -eq [IntPtr]::Zero) { ' + psError('foreground_unavailable', 'The foreground window disappeared before the click was delivered.') + ' }',
    `[NewmarkCuNative]::mouse_event(${down},0,0,0,[System.UIntPtr]::Zero)`,
    'Start-Sleep -Milliseconds 40',
    `[NewmarkCuNative]::mouse_event(${up},0,0,0,[System.UIntPtr]::Zero)`,
    `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; x=${x}; y=${y}; button=${psQuote(button)}; path_duration_ms=${MOVE_CURVE_MS}; minimum_action_interval_ms=${MIN_ACTION_INTERVAL_MS}; foreground_verified=$true } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function realDragScript(startX, startY, endX, endY, button, expect) {
  const isRight = button === 'right';
  const down = isRight ? '0x0008' : '0x0002';
  const up = isRight ? '0x0010' : '0x0004';
  return [
    '$ErrorActionPreference = "Stop"',
    ...foregroundGuardLines(expect),
    '$buttonDown = $false',
    'try {',
    `  if (-not [NewmarkCuNative]::MoveCursorSmooth(${startX}, ${startY})) { ${psError('cursor_move_failed', 'Smooth physical cursor movement to the drag start failed.')} }`,
    `  [NewmarkCuNative]::mouse_event(${down},0,0,0,[System.UIntPtr]::Zero)`,
    '  $buttonDown = $true',
    `  if (-not [NewmarkCuNative]::MoveCursorSmooth(${endX}, ${endY})) { ${psError('cursor_move_failed', 'Smooth physical cursor movement during the drag failed.')} }`,
    '} finally {',
    `  if ($buttonDown) { [NewmarkCuNative]::mouse_event(${up},0,0,0,[System.UIntPtr]::Zero) }`,
    '}',
    `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; start_x=${startX}; start_y=${startY}; end_x=${endX}; end_y=${endY}; button=${psQuote(button)}; released_in_finally=$true; approach_path_duration_ms=${MOVE_CURVE_MS}; drag_path_duration_ms=${MOVE_CURVE_MS}; minimum_action_interval_ms=${MIN_ACTION_INTERVAL_MS} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function realReleaseScript(button) {
  const up = button === 'right' ? '0x0010' : '0x0004';
  return [
    '$ErrorActionPreference = "Stop"',
    `[NewmarkCuNative]::mouse_event(${up},0,0,0,[System.UIntPtr]::Zero)`,
    `Write-Output (@{ ok=$true; released=$true; button=${psQuote(button)} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function realScrollScript(x, y, scrollX, scrollY, expect) {
  const wheel = -scrollY;
  const lines = [
    '$ErrorActionPreference = "Stop"',
    ...foregroundGuardLines(expect),
    `if (-not [NewmarkCuNative]::MoveCursorSmooth(${x}, ${y})) { ${psError('cursor_move_failed', 'Smooth physical cursor movement failed for the requested screen coordinate.')} }`,
  ];
  if (wheel) lines.push(`[NewmarkCuNative]::mouse_event(0x0800,0,0,${wheel},[System.UIntPtr]::Zero)`);
  if (scrollX) lines.push(`[NewmarkCuNative]::mouse_event(0x1000,0,0,${scrollX},[System.UIntPtr]::Zero)`);
  lines.push(`Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; x=${x}; y=${y}; scroll_x=${scrollX}; scroll_y=${scrollY} } | ConvertTo-Json -Compress)`);
  return lines.join('\r\n');
}

function realTypeScript(text) {
  return [
    '$ErrorActionPreference = "Stop"',
    ...foregroundGuardLines({}),
    `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(encodeSendKeysText(text))})`,
    `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; chars=${text.length}; foreground_verified=$true } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function realKeyScript(key) {
  const notation = normalizeSendKeysKey(key);
  if (!notation) return { error: `Unsupported key or key chord: ${key}` };
  return {
    script: [
      '$ErrorActionPreference = "Stop"',
      ...foregroundGuardLines({}),
      `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(notation)})`,
      `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; key=${psQuote(key)}; send_keys=${psQuote(notation)}; foreground_verified=$true } | ConvertTo-Json -Compress)`,
    ].join('\r\n'),
  };
}

function activateScript(handle, processId) {
  const handleValue = handleHex(handle);
  return [
    '$ErrorActionPreference = "Stop"',
    `$hwnd = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleValue)}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($hwnd, ${Number(processId) || 0})`,
    `if ($ownership -eq 2) { ${psError('target_window_ownership_changed', 'The process id no longer owns the target window, so activation was refused.')} }`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target window is no longer valid, so activation was refused.')} }`,
    `if (-not [NewmarkCuNative]::ActivateWindow($hwnd)) { ${psError('foreground_not_granted', 'Windows did not grant foreground focus to the selected application window.')} }`,
    `if ([NewmarkCuNative]::GetForegroundWindow() -ne $hwnd) { ${psError('foreground_not_granted', 'The target window is not the foreground window after activation.')} }`,
    `Write-Output (@{ ok=$true; action="app_activate"; handle=("0x{0:X}" -f $hwnd.ToInt64()); foreground_verified=$true; mouse_mode="real" } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

async function runActionScript(script, options = {}) {
  const lane = typeof options.lane === 'string' && LANES.includes(options.lane) ? options.lane : 'action';
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return failure(options.action, 'lane_unavailable', `The ${lane} lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}`, { lane });
  }
  const result = await runInLane(lane, script, clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    return failure(options.action, parsed.code, parsed.message, { lane, telemetry: { lane, lane_elapsed_ms: result.elapsedMs } });
  }
  const parsed = parseJsonObject(result.output);
  if (!parsed) {
    return failure(options.action, 'lane_result_invalid', 'The lane returned a result that was not readable JSON.', { lane, raw: String(result.output).slice(0, 500) });
  }
  return { ...parsed, lane, telemetry: { lane, lane_elapsed_ms: result.elapsedMs } };
}

/* ------------------------------------------------------------------ *
 * 8. the virtual (posted-message) delivery path
 *
 * Everything between the two markers below is reachable only from virtual mode. The only
 * delivery mechanism in this region is PostMessage: no physical pointer API, no cursor
 * placement, no activation helper is referenced anywhere inside it. The contract gate
 * extracts exactly this region and asserts that.
 * ------------------------------------------------------------------ */

/* @virtual-mode-begin */

const virtualPointers = new Map();

/** Independent virtual pointer position per owner. */
function virtualPointerFor(ownerId) {
  return virtualPointers.get(ownerKey(ownerId));
}

function setVirtualPointer(ownerId, pointer) {
  virtualPointers.set(ownerKey(ownerId), pointer);
}

function clearVirtualCursor(ownerId) {
  virtualPointers.delete(ownerKey(ownerId));
}

function virtualRefusal(action, options, detail) {
  return failure(action, 'virtual_mode_unsupported_action', detail, {
    mouse_mode: 'virtual',
    fallback_to_real_delivery: false,
    physical_delivery_used: false,
    system_cursor_moved: false,
  });
}

/** Virtual mode never activates: binding only records which window receives messages. */
function bindVirtualTarget(application, ownerId) {
  if (application.minimized === true) {
    return failure('app_activate', 'window_minimized', 'A minimized window has no capturable presentation.', {
      mouse_mode: 'virtual',
      app: application,
      fallback_to_real_delivery: false,
    });
  }
  const pointer = virtualPointerFor(ownerId);
  const sameWindow = pointer && pointer.windowHandle.toLowerCase() === String(application.handle).toLowerCase();
  setVirtualPointer(ownerId, {
    windowHandle: String(application.handle),
    x: sameWindow ? pointer.x : Math.round(application.client_rect.x + application.client_rect.width / 2),
    y: sameWindow ? pointer.y : Math.round(application.client_rect.y + application.client_rect.height / 2),
    targetHandle: sameWindow ? pointer.targetHandle : String(application.handle),
  });
  return {
    ok: true,
    action: 'app_activate',
    mouse_mode: 'virtual',
    delivery: 'posted-window-messages',
    activated: false,
    foreground_activated: false,
    physical_delivery_used: false,
    system_cursor_moved: false,
    app: application,
    bound_handle: String(application.handle),
  };
}

/** The point must be inside the target client area: verified in Node and again in the lane. */
function virtualClientPoint(application, x, y) {
  const client = application.client_rect || { x: 0, y: 0, width: 0, height: 0 };
  if (client.width <= 0 || client.height <= 0) {
    return { ok: false, error: 'The target window client area is empty, so it cannot receive virtual messages.' };
  }
  const inside = x >= client.x && y >= client.y && x < client.x + client.width && y < client.y + client.height;
  if (!inside) {
    return { ok: false, error: `A virtual pointer point must lie inside the target client area (${client.x},${client.y},${client.width}x${client.height}); received ${x},${y}.` };
  }
  return { ok: true };
}

/**
 * Invariant 3, checked in Node before any message is posted: a virtual click or scroll
 * point must lie inside the target client area. The lane repeats the same check against the
 * live window, so a stale rectangle can never open a hole.
 */
function virtualPointRefusal(action, application, point, header = {}, options = {}) {
  const check = virtualClientPoint(application, point.x, point.y);
  if (check.ok) return null;
  return failure(action, 'virtual_point_outside_client_area', check.error, {
    ...header,
    mouse_mode: 'virtual',
    app: application,
    lane: options.lane,
    fallback_to_real_delivery: false,
    physical_delivery_used: false,
    system_cursor_moved: false,
  });
}

function virtualWindowGuardLines(handle, processId, action) {
  const handleValue = handleHex(handle);
  return [
    `$root = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleValue)}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($root, ${Number(processId) || 0})`,
    `if ($ownership -eq 2) { ${psError('target_window_ownership_changed', 'The process id no longer owns the target window, so the virtual message was refused.')} }`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target window is no longer valid, so the virtual message was refused.')} }`,
    `if ([NewmarkCuNative]::IsIconic($root)) { ${psError('window_minimized', 'A minimized window has no capturable presentation.')} }`,
    `$foregroundBefore = [NewmarkCuNative]::GetForegroundWindow().ToInt64()`,
  ];
}

function virtualReceiptLines(action, application, extra = {}) {
  const fields = Object.entries(extra).map(([key, value]) => `${key}=${value};`).join(' ');
  return [
    `$foregroundAfter = [NewmarkCuNative]::GetForegroundWindow().ToInt64()`,
    `Write-Output (@{ ok=$true; action=${psQuote(action)}; mouse_mode="virtual"; delivery="posted-window-messages"; delivery_semantics="queued-to-target-thread-message-queue"; queued=$true; action_completed=$false; system_cursor_moved=$false; fallback_to_real_delivery=$false; foreground_activated=$false; foreground_changed=($foregroundBefore -ne $foregroundAfter); target_window=${psQuote(application.handle)}; ${fields} } | ConvertTo-Json -Compress)`,
  ];
}

function virtualMoveOrClickScript(action, application, fromX, fromY, x, y, button) {
  const isRight = button === 'right';
  return [
    '$ErrorActionPreference = "Stop"',
    ...virtualWindowGuardLines(application.handle, application.process_id, action),
    `if (-not [NewmarkCuNative]::IsClientPoint($root, ${x}, ${y})) { ${psError('virtual_point_outside_client_area', `A virtual ${action} point must lie inside the target client area.`)} }`,
    `if (-not [NewmarkCuNative]::PostMousePath($root, ${fromX}, ${fromY}, ${x}, ${y}, ${action === 'click' ? '$true' : '$false'}, ${isRight ? '$true' : '$false'})) { ${psError('virtual_message_rejected', 'The target application did not accept the posted mouse path.')} }`,
    `$targetControl = [NewmarkCuNative]::DeepestChildAtScreenPoint($root, ${x}, ${y})`,
    `$clientX = ${x}; $clientY = ${y}`,
    `if (-not [NewmarkCuNative]::ScreenToClientPoint($targetControl, [ref]$clientX, [ref]$clientY)) { ${psError('virtual_client_point_failed', 'The target control coordinates could not be resolved.')} }`,
    ...virtualReceiptLines(action, application, {
      x,
      y,
      client_x: '$clientX',
      client_y: '$clientY',
      button: psQuote(button),
      target_control: '("0x{0:X}" -f $targetControl.ToInt64())',
      path_duration_ms: MOVE_CURVE_MS,
    }),
  ].join('\r\n');
}

function virtualDragScript(application, fromX, fromY, startX, startY, endX, endY, button) {
  const isRight = button === 'right';
  return [
    '$ErrorActionPreference = "Stop"',
    ...virtualWindowGuardLines(application.handle, application.process_id, 'drag'),
    `if (-not [NewmarkCuNative]::IsClientPoint($root, ${startX}, ${startY}) -or -not [NewmarkCuNative]::IsClientPoint($root, ${endX}, ${endY})) { ${psError('virtual_point_outside_client_area', 'Virtual drag endpoints must lie inside the target client area.')} }`,
    `if (-not [NewmarkCuNative]::PostMouseDrag($root, ${fromX}, ${fromY}, ${startX}, ${startY}, ${endX}, ${endY}, ${isRight ? '$true' : '$false'})) { ${psError('virtual_message_rejected', 'The target application did not accept the posted drag path.')} }`,
    `$targetControl = [NewmarkCuNative]::DeepestChildAtScreenPoint($root, ${startX}, ${startY})`,
    ...virtualReceiptLines('drag', application, {
      start_x: startX,
      start_y: startY,
      end_x: endX,
      end_y: endY,
      button: psQuote(button),
      target_control: '("0x{0:X}" -f $targetControl.ToInt64())',
      drag_released_in_finally: '$true',
      approach_path_duration_ms: MOVE_CURVE_MS,
      drag_path_duration_ms: MOVE_CURVE_MS,
    }),
  ].join('\r\n');
}

function virtualReleaseScript(application, x, y, button) {
  const isRight = button === 'right';
  const up = isRight ? '0x0205' : '0x0202';
  return [
    '$ErrorActionPreference = "Stop"',
    `$root = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleHex(application.handle))}, 16))`,
    'if ([NewmarkCuNative]::IsWindow($root)) {',
    `  $target = [NewmarkCuNative]::DeepestChildAtScreenPoint($root, ${x}, ${y})`,
    `  if ($target -ne [IntPtr]::Zero) { $clientX = ${x}; $clientY = ${y}; if ([NewmarkCuNative]::ScreenToClientPoint($target, [ref]$clientX, [ref]$clientY)) { [void][NewmarkCuNative]::PostWindowMessage($target, ${up}, 0, [NewmarkCuNative]::PackPoint($clientX, $clientY)) } }`,
    '}',
    `Write-Output (@{ ok=$true; released=$true; button=${psQuote(button)} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function virtualScrollScript(application, x, y, scrollX, scrollY) {
  const wheelY = ((-scrollY) & 0xffff) * 65536;
  const wheelX = (scrollX & 0xffff) * 65536;
  const lines = [
    '$ErrorActionPreference = "Stop"',
    ...virtualWindowGuardLines(application.handle, application.process_id, 'scroll'),
    `if (-not [NewmarkCuNative]::IsClientPoint($root, ${x}, ${y})) { ${psError('virtual_point_outside_client_area', 'A virtual scroll point must lie inside the target client area.')} }`,
    `$targetControl = [NewmarkCuNative]::DeepestChildAtScreenPoint($root, ${x}, ${y})`,
    `$packed = [NewmarkCuNative]::PackPoint(${x}, ${y})`,
  ];
  if (scrollY) lines.push(`if (-not [NewmarkCuNative]::PostWindowMessage($targetControl, 0x020A, [uint32]${wheelY}, $packed)) { ${psError('virtual_message_rejected', 'WM_MOUSEWHEEL could not be queued for the target window.')} }`);
  if (scrollX) lines.push(`if (-not [NewmarkCuNative]::PostWindowMessage($targetControl, 0x020E, [uint32]${wheelX}, $packed)) { ${psError('virtual_message_rejected', 'WM_MOUSEHWHEEL could not be queued for the target window.')} }`);
  lines.push(...virtualReceiptLines('app_scroll', application, {
    x,
    y,
    scroll_x: scrollX,
    scroll_y: scrollY,
    target_control: '("0x{0:X}" -f $targetControl.ToInt64())',
  }));
  return lines.join('\r\n');
}

function virtualTypeScript(application, text, targetHandle) {
  const codes = Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
  return [
    '$ErrorActionPreference = "Stop"',
    `$target = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleHex(targetHandle || application.handle))}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($target, ${Number(application.process_id) || 0})`,
    `if ($ownership -eq 2) { ${psError('target_window_ownership_changed', 'The target control is owned by another process, so typing was refused.')} }`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target control window is no longer valid, so typing was refused.')} }`,
    `$foregroundBefore = [NewmarkCuNative]::GetForegroundWindow().ToInt64()`,
    `$codes = @(${codes.join(',')})`,
    `foreach ($code in $codes) { if (-not [NewmarkCuNative]::PostWindowMessage($target, 0x0102, [uint32]$code, 0)) { ${psError('virtual_message_rejected', 'WM_CHAR could not be queued for the target window.')} } }`,
    ...virtualReceiptLines('app_type', application, { chars: text.length, target_control: '("0x{0:X}" -f $target.ToInt64())' }),
  ].join('\r\n');
}

function virtualKeyCodes(key) {
  const aliases = {
    enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, bksp: 0x08,
    delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d, space: 0x20, up: 0x26, arrowup: 0x26,
    down: 0x28, arrowdown: 0x28, left: 0x25, arrowleft: 0x25, right: 0x27, arrowright: 0x27,
    home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  };
  let parts = String(key || '').trim().split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length === 1) {
    const notation = /^([+^%]*)(?:\{([^{}]+)\}|(.))$/.exec(parts[0]);
    if (notation && (notation[1] || notation[2])) {
      const modifiers = notation[1].split('').map(modifier => (modifier === '^' ? 'ctrl' : modifier === '%' ? 'alt' : 'shift'));
      parts = [...modifiers, notation[2] || notation[3]];
    }
  }
  if (!parts.length) return undefined;
  const modifiers = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = part.toLowerCase();
    const code = modifier === 'ctrl' || modifier === 'control' ? 0x11 : modifier === 'alt' ? 0x12 : modifier === 'shift' ? 0x10 : 0;
    if (!code) return undefined;
    if (!modifiers.includes(code)) modifiers.push(code);
  }
  const final = parts[parts.length - 1];
  const lower = final.toLowerCase();
  let keyCode = aliases[lower];
  if (!keyCode && /^f(?:[1-9]|1[0-6])$/i.test(final)) keyCode = 0x70 + Number(final.slice(1)) - 1;
  if (!keyCode && /^[a-z0-9]$/i.test(final)) keyCode = final.toUpperCase().charCodeAt(0);
  if (!keyCode || keyCode > 0xffff) return undefined;
  const shiftCase = /^[A-Z]$/.test(final) && !modifiers.includes(0x10);
  if (shiftCase) modifiers.push(0x10);
  return { modifiers, keyCode, shiftCase };
}

function virtualKeyScript(application, key, targetHandle) {
  const parsed = virtualKeyCodes(key);
  if (!parsed) return { error: `Virtual app_key accepts one key or a ctrl/alt/shift chord such as ctrl+l, enter, or F5: ${key}` };
  const keyDowns = [...parsed.modifiers, parsed.keyCode];
  const keyUps = [...keyDowns].reverse();
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `$target = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleHex(targetHandle || application.handle))}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($target, ${Number(application.process_id) || 0})`,
    `if ($ownership -eq 2) { ${psError('target_window_ownership_changed', 'The target control is owned by another process, so the key was refused.')} }`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target control window is no longer valid, so the key was refused.')} }`,
    `$foregroundBefore = [NewmarkCuNative]::GetForegroundWindow().ToInt64()`,
  ];
  for (const code of keyDowns) lines.push(`if (-not [NewmarkCuNative]::PostWindowMessage($target, 0x0100, ${code}, [NewmarkCuNative]::KeyMessageLParam(${code}, $false))) { ${psError('virtual_message_rejected', 'WM_KEYDOWN could not be queued for the target window.')} }`);
  for (const code of keyUps) lines.push(`if (-not [NewmarkCuNative]::PostWindowMessage($target, 0x0101, ${code}, [NewmarkCuNative]::KeyMessageLParam(${code}, $true))) { ${psError('virtual_message_rejected', 'WM_KEYUP could not be queued for the target window.')} }`);
  lines.push(...virtualReceiptLines('app_key', application, {
    key: psQuote(key),
    key_code: parsed.keyCode,
    modifiers: `@(${parsed.modifiers.join(',')})`,
    target_control: '("0x{0:X}" -f $target.ToInt64())',
  }));
  return { script: lines.join('\r\n') };
}

async function virtualMoveOrClick(options) {
  const action = options.action === 'move' ? 'move' : 'click';
  const application = options.application;
  const button = options.button === 'right' ? 'right' : 'left';
  const point = options.point;
  const pointer = virtualPointerFor(options.ownerId);
  const sameWindow = pointer && pointer.windowHandle.toLowerCase() === String(application.handle).toLowerCase();
  const fromX = sameWindow ? pointer.x : Math.round(application.client_rect.x + application.client_rect.width / 2);
  const fromY = sameWindow ? pointer.y : Math.round(application.client_rect.y + application.client_rect.height / 2);
  const result = await runActionScript(
    virtualMoveOrClickScript(action, application, fromX, fromY, point.x, point.y, button),
    { action, ...options },
  );
  if (result.ok === true) {
    setVirtualPointer(options.ownerId, {
      windowHandle: String(application.handle),
      x: point.x,
      y: point.y,
      targetHandle: String(result.target_control || application.handle),
    });
  }
  return { ...result, mouse_mode: 'virtual', app: application, physical_delivery_used: false };
}

async function virtualDrag(options) {
  const application = options.application;
  const button = options.button === 'right' ? 'right' : 'left';
  const released = { done: false };
  const release = async () => {
    if (released.done) return;
    released.done = true;
    await runInLane('action', virtualReleaseScript(application, options.end.x, options.end.y, button), 5000);
  };
  const onAbort = () => {
    // Cancellation kills the lane that is posting the move path and then posts the button
    // release, so an aborted virtual drag cannot leave the target holding a button.
    stopLane('action');
    void release();
  };
  if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
  let result;
  try {
    const pointer = virtualPointerFor(options.ownerId);
    const sameWindow = pointer && pointer.windowHandle.toLowerCase() === String(application.handle).toLowerCase();
    const fromX = sameWindow ? pointer.x : Math.round(application.client_rect.x + application.client_rect.width / 2);
    const fromY = sameWindow ? pointer.y : Math.round(application.client_rect.y + application.client_rect.height / 2);
    result = await runActionScript(
      virtualDragScript(application, fromX, fromY, options.start.x, options.start.y, options.end.x, options.end.y, button),
      { action: 'drag', ...options },
    );
  } finally {
    // Both drag modes release the held button in a finally, on movement failure and on
    // cancellation: the lane script releases inside its own finally, and this releases
    // again when the lane never reported success.
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    if (!result || result.ok !== true) await release();
  }
  if (result && result.ok === true) {
    setVirtualPointer(options.ownerId, {
      windowHandle: String(application.handle),
      x: options.end.x,
      y: options.end.y,
      targetHandle: String(result.target_control || application.handle),
    });
  }
  return { ...(result || failure('drag', 'cancelled', 'The virtual drag did not complete.')), mouse_mode: 'virtual', app: application, physical_delivery_used: false };
}

async function virtualScroll(options) {
  const application = options.application;
  const result = await runActionScript(
    virtualScrollScript(application, options.point.x, options.point.y, options.scrollX, options.scrollY),
    { action: 'app_scroll', ...options },
  );
  return { ...result, mouse_mode: 'virtual', app: application, physical_delivery_used: false };
}

async function virtualType(options) {
  const application = options.application;
  const text = String(options.text || '');
  if (!text) return failure(options.action, 'text_required', 'text is required.', { mouse_mode: 'virtual', app: application });
  if (text.length > 4096) return failure(options.action, 'text_too_long', 'Virtual typing is capped at 4096 UTF-16 code units per action.', { mouse_mode: 'virtual', app: application });
  const pointer = virtualPointerFor(options.ownerId);
  const targetHandle = pointer && pointer.windowHandle.toLowerCase() === String(application.handle).toLowerCase() ? pointer.targetHandle : application.handle;
  const result = await runActionScript(virtualTypeScript(application, text, targetHandle), { action: 'app_type', ...options });
  return { ...result, mouse_mode: 'virtual', app: application, physical_delivery_used: false };
}

async function virtualKey(options) {
  const application = options.application;
  const key = String(options.key || '').trim();
  const built = virtualKeyScript(application, key, (virtualPointerFor(options.ownerId) || {}).targetHandle || application.handle);
  if (built.error) return failure(options.action, 'virtual_key_unsupported', built.error, { mouse_mode: 'virtual', app: application });
  const result = await runActionScript(built.script, { action: 'app_key', ...options });
  return { ...result, mouse_mode: 'virtual', app: application, physical_delivery_used: false };
}

/* @virtual-mode-end */

/* ------------------------------------------------------------------ *
 * 9. sequence, the takeover lease, and the dispatcher
 * ------------------------------------------------------------------ */

async function foregroundScene(options) {
  const applications = await enumerateApplications({ ...options, virtualScope: false });
  const foregroundHandle = applications.applications.find(app => app.foreground === true);
  const controls = foregroundHandle
    ? await observeControls(foregroundHandle.handle, foregroundHandle.process_id, { ...options, action: 'app_observe' })
    : { ok: false, controls: [] };
  return {
    generation: sceneGeneration(applications.applications, controls.controls || []),
    warning: applications.error || controls.error,
  };
}

async function executeSequence(options) {
  const action = 'sequence';
  const steps = Array.isArray(options.steps) ? options.steps.slice(0, SEQUENCE_MAX_STEPS) : [];
  if (!steps.length) return failure(action, 'sequence_steps_required', `steps must contain one to ${SEQUENCE_MAX_STEPS} mouse or key steps.`);
  const cache = observationCache(options.ownerId);
  const completed = [];
  let expectedGeneration = cache ? cache.sceneGeneration : '';
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
    const stepAction = String(step.action || '').toLowerCase();
    if (!SEQUENCE_STEP_ACTIONS.includes(stepAction)) {
      return failure(action, 'unsupported_sequence_action', `sequence supports mouse and key steps only; ${stepAction || '(empty)'} is not one of ${SEQUENCE_STEP_ACTIONS.join(', ')}.`, { completed, stopped_at: index, requires_observe: true });
    }
    const needsTarget = stepAction === 'move' || stepAction === 'click' || stepAction === 'scroll';
    const hasPoint = Number.isFinite(Number(step.x)) && Number.isFinite(Number(step.y));
    if (needsTarget && !step.targetId && !hasPoint) {
      return failure(action, 'sequence_step_point_required', `Step ${index} needs a target_id or explicit x/y coordinates.`, { completed, stopped_at: index, requires_observe: true });
    }
    if (needsTarget && step.targetId) {
      const target = resolveTargetId(step.targetId, options.ownerId);
      if (target && target.ok !== true) {
        return failure(action, 'target_id_unknown', target.error, { completed, stopped_at: index, requires_observe: true });
      }
      if (target && target.risk === 'medium') {
        return failure(action, 'sequence_medium_risk_target', 'A medium-risk target requires a single action followed by observe.', { completed, stopped_at: index, requires_observe: true });
      }
      step.__target = target;
    }
    if (needsTarget && !cache && !hasPoint) {
      return failure(action, 'observe_required', 'Call observe or app_observe before a scene-checked sequence.', { completed, stopped_at: index, requires_observe: true });
    }
    const stepResult = await runSequenceStep(stepAction, step, options);
    completed.push(stepResult);
    if (stepResult.ok !== true) return { ...stepResult, action, completed, stopped_at: index, requires_observe: true };
    if (index >= steps.length - 1) continue;
    const scene = await foregroundScene(options);
    if (expectedGeneration && scene.generation !== expectedGeneration) {
      return {
        ok: true,
        action,
        mouse_mode: 'real',
        completed,
        stopped_at: index + 1,
        requires_observe: true,
        stop_reason: 'focus-window-menu-dialog-or-scene-changed',
        previous_scene_generation: expectedGeneration,
        current_scene_generation: scene.generation,
        warning: scene.warning,
      };
    }
    expectedGeneration = scene.generation;
  }
  return { ok: true, action, mouse_mode: 'real', completed, requires_observe: false, scene_generation: expectedGeneration, minimum_action_interval_ms: MIN_ACTION_INTERVAL_MS, reservation_queue: 'shared-with-click-and-drag' };
}

/** One sequence step. Mouse clicks and drags go through the shared reservation queue. */
async function runSequenceStep(stepAction, step, options) {
  const target = step.__target;
  const x = target ? target.x : Math.floor(Number(step.x));
  const y = target ? target.y : Math.floor(Number(step.y));
  if (stepAction === 'wait') {
    const durationMs = clampNumber(step.durationMs ?? step.duration_ms, 0, 60000, 250);
    await sleep(durationMs);
    return { ok: true, action: 'wait', duration_ms: durationMs };
  }
  if (stepAction === 'type') return await realStep('type', realTypeScript(String(step.text || '')), options);
  if (stepAction === 'key') {
    const built = realKeyScript(String(step.key || ''));
    if (built.error) return failure('key', 'key_unsupported', built.error);
    return await realStep('key', built.script, options);
  }
  if (stepAction === 'move') return await realStep('move', realMoveScript(x, y, {}), options);
  if (stepAction === 'click') return await realStep('click', realClickScript(x, y, step.button === 'right' ? 'right' : 'left', {}), options, true);
  if (stepAction === 'scroll') {
    const scrollX = Math.floor(Number(step.scrollX || step.scroll_x || 0));
    const scrollY = Math.floor(Number(step.scrollY || step.scroll_y || 0));
    if (!scrollX && !scrollY) return failure('scroll', 'scroll_delta_required', 'scroll_x or scroll_y is required.');
    return await realStep('scroll', realScrollScript(x, y, scrollX, scrollY, {}), options);
  }
  if (stepAction === 'drag') {
    const startX = Math.floor(Number(step.startX ?? step.start_x));
    const startY = Math.floor(Number(step.startY ?? step.start_y));
    const endX = Math.floor(Number(step.endX ?? step.end_x));
    const endY = Math.floor(Number(step.endY ?? step.end_y));
    if (![startX, startY, endX, endY].every(Number.isFinite)) {
      return failure('drag', 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.');
    }
    const button = step.button === 'right' ? 'right' : 'left';
    return await realStep('drag', realDragScript(startX, startY, endX, endY, button, {}), options, true);
  }
  return failure(stepAction, 'unsupported_sequence_action', `sequence supports mouse and key steps only; ${stepAction} is not supported.`);
}

async function realStep(action, script, options, reserved = false) {
  const run = async () => await runActionScript(script, { action, ...options });
  const result = reserved ? await withRealMouseReservation(run) : await run();
  return { ...result, mouse_mode: 'real', delivery: 'physical-desktop' };
}

/* --- the single-owner takeover lease ------------------------------ */

const lease = {
  ownerId: null,
  mouseMode: 'real',
  acquiredAt: 0,
  expiresAt: 0,
  timer: null,
  lastReleaseReason: '',
  lastOverlayError: '',
};

/**
 * The visible half of the takeover: a native, screen-wide WinForms overlay
 * (./overlay-win32.js) whose lifecycle is bound to this lease.
 *
 * It is started without being awaited. The lease is the contract and the window is a
 * side effect, so a desktop that cannot draw one must not fail `takeover_start`; the
 * outcome is observable instead - `mode_report` reports `overlay.running` and the reason
 * it is not running.
 */
function startTakeoverOverlay(ownerId) {
  try {
    const started = startOverlay({ ownerId, ownerPid: process.pid, durationMs: 0, action: 'takeover_start' });
    if (started && typeof started.catch === 'function') started.catch(() => undefined);
  } catch (error) {
    lease.lastOverlayError = error instanceof Error ? error.message : String(error);
  }
}

function releaseLease(reason) {
  lease.lastReleaseReason = reason;
  if (lease.timer) {
    clearTimeout(lease.timer);
    lease.timer = null;
  }
  lease.ownerId = null;
  lease.acquiredAt = 0;
  lease.expiresAt = 0;
  // Every exit path restores the physical mouse mode.
  lease.mouseMode = 'real';
  // The visible half of the lease: takeover_stop, lease expiry, stopAll() and process
  // exit all land here, so the native overlay can never outlive the lease that owns it.
  try {
    releaseOverlay(reason);
  } catch (error) {
    lease.lastOverlayError = error instanceof Error ? error.message : String(error);
  }
  return { released: true, reason };
}

function activeLease() {
  if (!lease.ownerId) return null;
  if (Date.now() >= lease.expiresAt) {
    releaseLease('expired');
    return null;
  }
  return {
    owner_id: lease.ownerId,
    mouse_mode: lease.mouseMode,
    acquired_at: lease.acquiredAt,
    expires_at: lease.expiresAt,
    ttl_ms: LEASE_TTL_MS,
    expires_in_ms: Math.max(0, lease.expiresAt - Date.now()),
  };
}

function currentMouseMode() {
  const active = activeLease();
  return active ? active.mouse_mode : 'real';
}

function takeoverStart(options) {
  const action = 'takeover_start';
  const ownerId = String(options.ownerId || 'direct');
  const requested = options.mouseMode === 'virtual' ? 'virtual' : 'real';
  const existing = activeLease();
  if (existing && existing.owner_id !== ownerId) {
    return failure(action, 'takeover_lease_occupied', `The takeover lease is held by ${existing.owner_id}; it was not stolen.`, {
      takeover: false,
      lock_owner: existing.owner_id,
      requested_owner: ownerId,
      lock_mouse_mode: existing.mouse_mode,
      requested_mouse_mode: requested,
      ttl_ms: LEASE_TTL_MS,
      expires_in_ms: existing.expires_in_ms,
      lease: existing,
      mouse_mode: existing.mouse_mode,
      fallback_to_real_delivery: false,
    });
  }
  if (lease.timer) clearTimeout(lease.timer);
  lease.ownerId = ownerId;
  lease.mouseMode = requested;
  lease.acquiredAt = Date.now();
  lease.expiresAt = lease.acquiredAt + LEASE_TTL_MS;
  // Lease expiry restores the physical mouse mode on its own.
  lease.timer = setTimeout(() => { releaseLease('expired'); }, LEASE_TTL_MS);
  if (lease.timer.unref) lease.timer.unref();
  // The takeover is only real once the screen itself carries the effect.
  startTakeoverOverlay(ownerId);
  const overlaySnapshot = overlayState();
  return {
    ok: true,
    action,
    takeover: true,
    mouse_mode: requested,
    delivery: requested === 'virtual' ? 'posted-window-messages' : 'physical-desktop',
    lease: {
      owner_id: ownerId,
      mouse_mode: requested,
      ttl_ms: LEASE_TTL_MS,
      acquired_at: lease.acquiredAt,
      expires_at: lease.expiresAt,
      expires_in_ms: LEASE_TTL_MS,
    },
    overlay: overlaySnapshot,
    physical_delivery_used: false,
    system_cursor_moved: false,
    fallback_to_real_delivery: false,
  };
}

function takeoverStop(options) {
  const action = 'takeover_stop';
  const ownerId = String(options.ownerId || 'direct');
  const existing = activeLease();
  if (existing && existing.owner_id !== ownerId) {
    return failure(action, 'takeover_lease_owned_by_another_owner', `The takeover lease belongs to ${existing.owner_id}; ${ownerId} cannot release it.`, {
      takeover: false,
      lock_owner: existing.owner_id,
      requested_owner: ownerId,
    });
  }
  const previousOwner = existing ? existing.owner_id : null;
  clearVirtualCursor(ownerId);
  releaseLease('takeover_stop');
  return {
    ok: true,
    action,
    takeover: false,
    mouse_mode: 'real',
    released_owner: previousOwner,
    lease: { held: false, owner_id: null, mouse_mode: 'real', ttl_ms: LEASE_TTL_MS },
    overlay: overlayState(),
    physical_delivery_used: false,
    system_cursor_moved: false,
  };
}

/** The effective mode of one action. Only takeover_start can change the session mode. */
function effectiveMouseMode(options) {
  const requested = options.mouseMode === 'virtual' ? 'virtual' : (options.mouseMode === 'real' ? 'real' : undefined);
  const active = activeLease();
  if (active) {
    return {
      mode: active.mouse_mode,
      lease_owner: active.owner_id,
      lease_held: true,
      requested,
      requested_ignored: requested !== undefined && requested !== active.mouse_mode,
    };
  }
  return { mode: requested === 'virtual' ? 'virtual' : 'real', lease_owner: null, lease_held: false, requested, requested_ignored: false };
}

/* --- the dispatcher ---------------------------------------------- */

export async function runComputerUse(options = {}) {
  const action = String((options && options.action) || 'observe').toLowerCase();
  try {
    const result = await dispatchComputerUse(action, options || {});
    return stringifyResult(result);
  } catch (error) {
    return stringifyResult(failure(action, 'internal_error', error instanceof Error ? error.message : String(error)));
  }
}

function unsupportedPlatform(action) {
  return failure(action, 'unsupported_platform', 'Computer Use Win32 automation is Windows-only; no desktop action was attempted.', {
    platform: process.platform,
    supported_platforms: ['win32'],
    supported_actions: [...ALL_ACTIONS],
    physical_delivery_used: false,
    fallback_to_real_delivery: false,
  });
}

async function dispatchComputerUse(action, options) {
  if (options.signal && options.signal.aborted) return cancelledResult(action, options.signal);

  // The takeover lease is pure process state, so it also works off Windows where nothing
  // can be typed or clicked. Everything that touches the desktop is refused there.
  if (action === 'takeover_start') return takeoverStart(options);
  if (action === 'takeover_stop') return takeoverStop(options);
  if (action === 'mode_report') return modeReport(action, options);
  if (action === 'wait') {
    const durationMs = clampNumber(options.durationMs ?? options.duration_ms, 0, 60000, 1000);
    const startedAt = Date.now();
    await sleep(durationMs);
    return { ok: true, action, duration_ms: Date.now() - startedAt, mouse_mode: currentMouseMode(), physical_delivery_used: false };
  }

  if (!IS_WINDOWS) return unsupportedPlatform(action);

  if (!ALL_ACTIONS.includes(action)) {
    return failure(action, 'unknown_action', `Unknown computer_use action: ${action}.`, { supported_actions: [...ALL_ACTIONS] });
  }

  const mode = effectiveMouseMode(options);
  const header = {
    mouse_mode: mode.mode,
    requested_mouse_mode: mode.requested,
    mouse_mode_override_ignored: mode.requested_ignored,
    lease_owner: mode.lease_owner,
    lane_routing: actionLanes(action),
  };

  if (action === 'observe') return await observeAction(action, options, mode, header);
  if (action === 'app_list') return await appListAction(action, options, mode, header);
  if (action === 'app_observe') return await appObserveAction(action, options, mode, header);
  if (action === 'app_activate') return await appActivateAction(action, options, mode, header);
  if (action === 'move' || action === 'click' || action === 'scroll' || action === 'drag' || action === 'type' || action === 'key') {
    return await desktopPhysicalAction(action, options, mode, header);
  }
  if (action === 'app_click' || action === 'app_drag' || action === 'app_scroll' || action === 'app_type' || action === 'app_key') {
    return await appPhysicalAction(action, options, mode, header);
  }
  if (action === 'sequence') return await sequenceAction(action, options, mode, header);
  return failure(action, 'unknown_action', `Unknown computer_use action: ${action}.`, { supported_actions: [...ALL_ACTIONS] });
}

async function observeAction(action, options, mode, header) {
  if (mode.mode === 'virtual') {
    return virtualRefusal(action, options, 'Virtual mode refuses the foreground desktop observation: use app_observe with app_target or window_handle so it never captures the whole desktop.');
  }
  const sparseRequested = options.observation === 'sparse' || options.sparse === true || options.sparseWaitMs !== undefined || options.sparse_wait_ms !== undefined;
  if (sparseRequested && options.observation !== 'full') {
    const resolved = await resolveApplication({ ...options, virtualScope: false });
    if (resolved.ok !== true) {
      return failure(action, resolved.error_code || 'window_unavailable', resolved.error || 'No window is available to sample.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
    }
    const sparse = await sparseObservation({
      ...options,
      action,
      mouseMode: mode.mode,
      windowHandle: resolved.application.handle,
      processId: resolved.application.process_id,
    });
    return { ...header, ...sparse, must_reacquire_full_observation: true };
  }
  const resolved = await resolveApplication({ ...options, virtualScope: false });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'window_unavailable', resolved.error || 'No window is available to observe.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
  }
  return await fullObservation(action, options, mode, header, resolved.application);
}

async function appObserveAction(action, options, mode, header) {
  if (mode.mode === 'virtual' && !handleHex(options.windowHandle || options.window_handle) && !options.appTarget && !options.app_target) {
    return virtualRefusal(action, options, 'Virtual mode refuses the foreground scene check: app_observe needs app_target or window_handle in virtual mode.');
  }
  const resolved = await resolveApplication({ ...options, virtualScope: mode.mode === 'virtual' });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
  }
  const sparseRequested = options.observation === 'sparse' || options.sparse === true || options.sparseWaitMs !== undefined || options.sparse_wait_ms !== undefined;
  if (sparseRequested && options.observation !== 'full') {
    const sparse = await sparseObservation({
      ...options,
      action,
      mouseMode: mode.mode,
      windowHandle: resolved.application.handle,
      processId: resolved.application.process_id,
    });
    return { ...header, ...sparse, must_reacquire_full_observation: true, app: resolved.application };
  }
  return await fullObservation(action, options, mode, header, resolved.application);
}

async function fullObservation(action, options, mode, header, application) {
  if (application.minimized === true) {
    return failure(action, 'window_minimized', 'A minimized window has no capturable presentation.', { ...header, app: application });
  }
  const capture = await captureWindow({
    handle: application.handle,
    processId: application.process_id,
    ownerId: options.ownerId,
    imagePath: options.imagePath || options.image_path,
    maxWidth: options.captureMaxWidth ?? options.max_width,
    maxHeight: options.captureMaxHeight ?? options.max_height,
    timeoutMs: options.captureTimeoutMs,
  });
  if (capture.ok !== true) {
    return { ...header, ...capture, action, app: application };
  }
  const controls = await observeControls(application.handle, application.process_id, { ...options, action });
  const bounded = controls.controls.slice(0, MAX_UIA_ELEMENTS);
  observationsByOwner.set(ownerKey(options.ownerId), {
    windowHandle: application.handle,
    sceneGeneration: sceneGeneration([application], bounded),
    capturedAt: Date.now(),
  });
  return {
    ...header,
    ok: true,
    action,
    observation: 'full',
    must_reacquire_full_observation: false,
    app: application,
    window: application,
    image_path: capture.image_path,
    image_mime: capture.image_mime,
    width: capture.width,
    height: capture.height,
    image_width: capture.image_width,
    image_height: capture.image_height,
    image_bytes: capture.image_bytes,
    capture: {
      image_path: capture.image_path,
      image_mime: capture.image_mime,
      width: capture.width,
      height: capture.height,
      image_bytes: capture.image_bytes,
      capture_method: capture.capture_method,
      lane: capture.lane,
      digest: capture.digest,
    },
    controls: bounded,
    control_count: bounded.length,
    uia_visited: controls.visited || 0,
    target_scope: application.handle,
    telemetry: {
      lane: capture.lane,
      capture_ms: capture.telemetry ? capture.telemetry.capture_ms : undefined,
      uia_ms: controls.elapsedMs,
      uia_lane: controls.lane,
      uia_error: controls.error,
    },
  };
}

async function appListAction(action, options, mode, header) {
  const virtualScope = mode.mode === 'virtual' || options.includeOccluded === true || options.include_occluded === true;
  const first = await enumerateApplications({
    ...options,
    virtualScope,
    includeMinimized: options.includeMinimized === true,
    lane: options.lane,
  });
  const enumerated = first.ok === true && first.applications.length > 0
    ? first
    : await enumerateApplications({ ...options, virtualScope, includeMinimized: options.includeMinimized === true, lane: options.lane });
  return {
    ...header,
    ok: enumerated.ok === true,
    action,
    applications: enumerated.applications,
    windows: enumerated.applications,
    count: enumerated.applications.length,
    scope: virtualScope ? 'virtual-includes-occluded' : 'real-visible-unoccluded',
    ...(enumerated.error_code ? { error_code: enumerated.error_code, error: enumerated.error } : {}),
    telemetry: {
      lane: enumerated.lane,
      elapsed_ms: enumerated.elapsedMs,
      retried_empty_result: enumerated !== first,
    },
  };
}

async function appActivateAction(action, options, mode, header) {
  const resolved = await resolveApplication({ ...options, virtualScope: mode.mode === 'virtual' });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
  }
  const application = resolved.application;
  if (mode.mode === 'virtual') return { ...header, ...bindVirtualTarget(application, options.ownerId) };
  if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, app: application, mouse_mode: 'real' };
  const result = await runActionScript(activateScript(application.handle, application.process_id), { action, ...options, lane: 'action' });
  return { ...header, ...result, app: application };
}

async function desktopPhysicalAction(action, options, mode, header) {
  const target = options.targetId ? resolveTargetId(options.targetId, options.ownerId) : null;
  if (target && target.ok !== true) return failure(action, target.error_code, target.error, { ...header });
  if (mode.mode === 'virtual') {
    const hasScope = handleHex(options.windowHandle || options.window_handle) || options.appTarget || options.app_target || (observationCache(options.ownerId) || {}).windowHandle;
    if (!hasScope) {
      return failure(action, 'virtual_mode_requires_app_target', 'Virtual mode requires app_target, window_handle or a prior app_observe target so it never falls back to the foreground desktop.', { ...header, fallback_to_real_delivery: false, physical_delivery_used: false });
    }
    const resolved = await resolveApplication({ ...options, virtualScope: true });
    if (resolved.ok !== true) {
      return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
    }
    const application = resolved.application;
    if (options.dryRun === true) {
      return {
        ...header,
        ok: true,
        action,
        dry_run: true,
        mouse_mode: 'virtual',
        delivery: 'posted-window-messages',
        queued: false,
        action_completed: false,
        physical_delivery_used: false,
        system_cursor_moved: false,
        app: application,
        target_id: options.targetId,
        x: target ? target.x : (Number.isFinite(Number(options.x)) ? Math.floor(Number(options.x)) : undefined),
        y: target ? target.y : (Number.isFinite(Number(options.y)) ? Math.floor(Number(options.y)) : undefined),
      };
    }
    if (action === 'move' || action === 'click') {
      const point = target ? { x: target.x, y: target.y } : { x: Math.floor(Number(options.x)), y: Math.floor(Number(options.y)) };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
      const refusal = virtualPointRefusal(action, application, point, header, options);
      if (refusal) return refusal;
      return { ...header, ...(await virtualMoveOrClick({ ...options, action, application, ownerId: options.ownerId, point, button: options.button })) };
    }
    if (action === 'drag') {
      const points = ['startX', 'startY', 'endX', 'endY'].map(key => Math.floor(Number(options[key])));
      if (!points.every(Number.isFinite)) return failure(action, 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.', { ...header });
      const start = { x: points[0], y: points[1] };
      const end = { x: points[2], y: points[3] };
      const refusal = virtualPointRefusal(action, application, start, header, options) || virtualPointRefusal(action, application, end, header, options);
      if (refusal) return refusal;
      return { ...header, ...(await virtualDrag({ ...options, action, application, ownerId: options.ownerId, start, end, button: options.button })) };
    }
    if (action === 'scroll') {
      const point = target ? { x: target.x, y: target.y } : { x: Math.floor(Number(options.x)), y: Math.floor(Number(options.y)) };
      const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
      const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
      if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
      const refusal = virtualPointRefusal(action, application, point, header, options);
      if (refusal) return refusal;
      return { ...header, ...(await virtualScroll({ ...options, action, application, ownerId: options.ownerId, point, scrollX, scrollY })) };
    }
    if (action === 'type') return { ...header, ...(await virtualType({ ...options, action, application, ownerId: options.ownerId, text: options.text })) };
    return { ...header, ...(await virtualKey({ ...options, action, application, ownerId: options.ownerId, key: options.key })) };
  }

  if (options.dryRun === true) {
    return { ...header, ok: true, action, dry_run: true, x: Math.floor(Number(options.x)), y: Math.floor(Number(options.y)), target_id: options.targetId, mouse_mode: 'real' };
  }
  if (action === 'type') return { ...header, ...(await realStep('type', realTypeScript(String(options.text || '')), options)) };
  if (action === 'key') {
    const built = realKeyScript(String(options.key || ''));
    if (built.error) return failure(action, 'key_unsupported', built.error, { ...header });
    return { ...header, ...(await realStep('key', built.script, options)) };
  }
  if (!target && !Number.isFinite(Number(options.x))) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
  if (!target && !Number.isFinite(Number(options.y))) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
  const x = target ? target.x : Math.floor(Number(options.x));
  const y = target ? target.y : Math.floor(Number(options.y));
  if (action === 'move') return { ...header, ...(await realStep('move', realMoveScript(x, y, {}), options, false)) };
  if (action === 'click') return { ...header, ...(await realStep('click', realClickScript(x, y, options.button === 'right' ? 'right' : 'left', {}), options, true)) };
  if (action === 'scroll') {
    const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
    const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
    if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
    return { ...header, ...(await realStep('scroll', realScrollScript(x, y, scrollX, scrollY, {}), options, false)) };
  }
  const points = ['startX', 'startY', 'endX', 'endY'].map(key => Math.floor(Number(options[key])));
  if (!points.every(Number.isFinite)) return failure(action, 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.', { ...header });
  const button = options.button === 'right' ? 'right' : 'left';
  const dragged = await dragWithRelease({ action, script: realDragScript(points[0], points[1], points[2], points[3], button, {}), releaseScript: realReleaseScript(button), options, reserved: true });
  return { ...header, ...dragged };
}

async function appPhysicalAction(action, options, mode, header) {
  const resolved = await resolveApplication({ ...options, virtualScope: mode.mode === 'virtual' });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
  }
  const application = resolved.application;
  if (application.minimized === true) {
    return failure(action, 'window_minimized', 'A minimized window has no capturable presentation.', { ...header, app: application });
  }
  const point = appScopedPoint(application, options.x, options.y);
  if (point.error) return failure(action, 'point_outside_window', point.error, { ...header, app: application });

  if (mode.mode === 'virtual') {
    if (options.dryRun === true) {
      return {
        ...header,
        ok: true,
        action,
        dry_run: true,
        mouse_mode: 'virtual',
        delivery: 'posted-window-messages',
        queued: false,
        action_completed: false,
        physical_delivery_used: false,
        system_cursor_moved: false,
        app: application,
        x: point.x,
        y: point.y,
      };
    }
    const virtualAction = action === 'app_click' ? 'click' : action === 'app_drag' ? 'drag' : action;
    if (virtualAction === 'click') {
      const refusal = virtualPointRefusal(action, application, point, header, options);
      if (refusal) return refusal;
      return { ...header, ...(await virtualMoveOrClick({ ...options, action: 'click', application, ownerId: options.ownerId, point, button: options.button })), action };
    }
    if (virtualAction === 'drag') {
      const points = ['startX', 'startY', 'endX', 'endY'].map(key => Math.floor(Number(options[key])));
      if (!points.every(Number.isFinite)) return failure(action, 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.', { ...header });
      const start = appScopedPoint(application, points[0], points[1]);
      const end = appScopedPoint(application, points[2], points[3]);
      if (start.error || end.error) return failure(action, 'point_outside_window', start.error || end.error, { ...header, app: application });
      const refusal = virtualPointRefusal(action, application, start, header, options) || virtualPointRefusal(action, application, end, header, options);
      if (refusal) return refusal;
      return { ...header, ...(await virtualDrag({ ...options, action: 'drag', application, ownerId: options.ownerId, start, end, button: options.button })), action };
    }
    if (virtualAction === 'app_scroll') {
      const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
      const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
      if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
      const refusal = virtualPointRefusal(action, application, point, header, options);
      if (refusal) return refusal;
      return { ...header, ...(await virtualScroll({ ...options, action: 'app_scroll', application, ownerId: options.ownerId, point, scrollX, scrollY })), action };
    }
    if (virtualAction === 'app_type') return { ...header, ...(await virtualType({ ...options, action, application, ownerId: options.ownerId, text: options.text })) };
    return { ...header, ...(await virtualKey({ ...options, action, application, ownerId: options.ownerId, key: options.key })) };
  }

  if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, app: application, x: point.x, y: point.y, mouse_mode: 'real' };
  const activated = await runActionScript(activateScript(application.handle, application.process_id), { action, ...options, lane: 'action' });
  if (activated.ok !== true) return { ...header, ...activated, app: application };
  const expect = { handle: application.handle, processId: application.process_id };
  if (action === 'app_click') {
    const clicked = await realStep('click', realClickScript(point.x, point.y, options.button === 'right' ? 'right' : 'left', expect), options, true);
    return { ...header, ...clicked, action, app: application, foreground_verified: true };
  }
  if (action === 'app_scroll') {
    const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
    const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
    if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
    const scrolled = await realStep('scroll', realScrollScript(point.x, point.y, scrollX, scrollY, expect), options, false);
    return { ...header, ...scrolled, action, app: application, foreground_verified: true };
  }
  if (action === 'app_type') {
    const typed = await realStep('type', realTypeScript(String(options.text || '')), options, false);
    return { ...header, ...typed, action, app: application, foreground_verified: true };
  }
  if (action === 'app_key') {
    const built = realKeyScript(String(options.key || ''));
    if (built.error) return failure(action, 'key_unsupported', built.error, { ...header });
    const pressed = await realStep('key', built.script, options, false);
    return { ...header, ...pressed, action, app: application, foreground_verified: true };
  }
  const points = ['startX', 'startY', 'endX', 'endY'].map(key => Math.floor(Number(options[key])));
  if (!points.every(Number.isFinite)) return failure(action, 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.', { ...header });
  const start = appScopedPoint(application, points[0], points[1]);
  const end = appScopedPoint(application, points[2], points[3]);
  if (start.error || end.error) return failure(action, 'point_outside_window', start.error || end.error, { ...header, app: application });
  const button = options.button === 'right' ? 'right' : 'left';
  const dragged = await dragWithRelease({ action, script: realDragScript(start.x, start.y, end.x, end.y, button, expect), releaseScript: realReleaseScript(button), options, reserved: true });
  return { ...header, ...dragged, action, app: application, foreground_verified: true };
}

/**
 * A drag releases the held button in a finally in both modes. The lane script does that
 * inside its own finally; this adds a best-effort release whenever the lane call itself did
 * not report success (timeout, kill, cancellation, movement failure).
 */
async function dragWithRelease({ action, script, releaseScript, options, reserved }) {
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await runInLane('action', releaseScript, 5000);
  };
  let result;
  const onAbort = () => {
    // Cancellation kills the lane that is moving the physical cursor and then releases the
    // held button on a fresh lane, so an aborted drag cannot leave a button stuck down.
    stopLane('action');
    void release();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      await release();
      return failure(action, 'cancelled', 'The drag was cancelled before it started.');
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    result = reserved ? await withRealMouseReservation(async () => await runActionScript(script, { action, ...options })) : await runActionScript(script, { action, ...options });
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    if (!result || result.ok !== true) await release();
  }
  return { ...(result || failure(action, 'cancelled', 'The drag did not complete.')), mouse_mode: 'real', delivery: 'physical-desktop', drag_release_guard: true };
}

function appScopedPoint(application, x, y) {
  const nx = Number(x);
  const ny = Number(y);
  const client = application.client_rect || { x: 0, y: 0, width: 0, height: 0 };
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return { x: Math.round(client.x + client.width / 2), y: Math.round(client.y + client.height / 2) };
  }
  const relative = nx >= 0 && nx <= 1;
  const relativeY = ny >= 0 && ny <= 1;
  const px = relative ? client.x + Math.round(client.width * nx) : client.x + Math.round(nx);
  const py = relativeY ? client.y + Math.round(client.height * ny) : client.y + Math.round(ny);
  if (px < client.x || px > client.x + client.width || py < client.y || py > client.y + client.height) {
    return { x: px, y: py, error: 'app-scoped x/y is outside the selected application window client area.' };
  }
  return { x: px, y: py };
}

async function sequenceAction(action, options, mode, header) {
  if (mode.mode === 'virtual') {
    return virtualRefusal(action, options, 'Virtual mode refuses a scene-checked sequence: use app_observe followed by explicit app_* actions.');
  }
  const result = await executeSequence(options);
  return { ...header, ...result };
}

function modeReport(action, options) {
  const active = activeLease();
  return {
    ok: true,
    action,
    platform: process.platform,
    supported: IS_WINDOWS,
    mouse_mode: currentMouseMode(),
    requested_mouse_mode: options.mouseMode,
    mouse_mode_mutable_by_action: false,
    mode_inventory: MODE_INVENTORY,
    observation_defaults: {
      sparse_wait_ms: 0,
      sparse_max_wait_ms: SPARSE_MAX_WAIT_MS,
      sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
      sparse_digest: `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}-grayscale`,
      full_capture: 'PrintWindow(hwnd,hdc,2) in the window_capture lane',
    },
    constants: {
      lease_ttl_ms: LEASE_TTL_MS,
      min_action_interval_ms: MIN_ACTION_INTERVAL_MS,
      move_curve_ms: MOVE_CURVE_MS,
      sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
      sparse_max_wait_ms: SPARSE_MAX_WAIT_MS,
    },
    lease: active
      ? { held: true, ...active, last_release_reason: lease.lastReleaseReason }
      : { held: false, owner_id: null, mouse_mode: 'real', ttl_ms: LEASE_TTL_MS, last_release_reason: lease.lastReleaseReason },
    lease_release_restores_mouse_mode: 'real',
    // The takeover effect is a native window covering the whole screen, not the DSH
    // page's CSS ring: `running` is what is on screen, `reason` is why it is not.
    overlay: overlayState(),
    overlay_contract: overlayContractReport(),
    overlay_last_error: lease.lastOverlayError || undefined,
    lanes: laneDiagnostics(),
    live_lane_count: liveLaneCount(),
    lane_routing: ACTION_LANES,
    actions: {
      desktop: [...DESKTOP_ACTIONS],
      app: [...APP_ACTIONS],
      sequence_steps: [...SEQUENCE_STEP_ACTIONS],
      all: [...ALL_ACTIONS],
    },
    virtual_mode: {
      delivery: 'posted-window-messages',
      receipts_are_honest: { queued: true, action_completed: false },
      refuses: ['observe', 'app_observe', 'sequence'],
      never_falls_back_to_real_delivery: true,
    },
    physical_delivery_used: false,
  };
}

function stringifyResult(result) {
  let output = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(output, 'utf8') <= 32768) return output;
  const compact = { ...result };
  if (Array.isArray(compact.controls)) compact.controls = compact.controls.slice(0, 32);
  if (Array.isArray(compact.applications)) compact.applications = compact.applications.slice(0, 20);
  if (Array.isArray(compact.windows)) compact.windows = compact.windows.slice(0, 20);
  compact.result_truncated = true;
  output = JSON.stringify(compact, null, 2);
  if (Buffer.byteLength(output, 'utf8') <= 32768) return output;
  return JSON.stringify({
    ok: compact.ok === true,
    action: compact.action,
    error_code: compact.error_code,
    error: compact.error,
    mouse_mode: compact.mouse_mode,
    warning: 'Computer Use result exceeded 32 KiB and was compacted.',
    image_path: compact.image_path,
    width: compact.width,
    height: compact.height,
    control_count: compact.control_count,
    result_truncated: true,
  }, null, 2);
}
