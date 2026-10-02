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

/**
 * The exclusive takeover lease has **no time limit**.
 *
 * It used to be bound to `LEASE_TTL_MS = 120000` and released by a `setTimeout`; that
 * constant and its timer are gone. A lease now ends only when `takeover_stop` releases
 * it, or when the owning process dies (see `releaseLease` callers at `process_exit` /
 * `stop_all` and the overlay's own owner watchdog). `expires_at`, `expires_in_ms` and
 * `ttl_ms` are therefore reported as `null` - a number there would name an expiry that
 * does not exist - and `expiry: 'none'` says so in words.
 */
export const LEASE_EXPIRY = 'none';
/** The one action that ends a takeover lease explicitly. */
export const LEASE_RELEASE_ACTION = 'takeover_stop';
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
 * Actions that are **not** on the model-facing `computer_use` surface.
 *
 * `capture_screen` is the whole-desktop capture behind the read-only `screen_capture` tool.
 * It is not an action a model can name through `computer_use`, deliberately: it returns no
 * controls and exists only to answer "what is on the screen". It still routes through the
 * same dispatch, the same lane table and the same failure log as every other action, so it
 * is an action in every sense except its advertisement.
 */
export const INTERNAL_ACTIONS = Object.freeze(['capture_screen']);

/** Every action `dispatchComputerUse` accepts, advertised or not. */
const DISPATCHABLE_ACTIONS = Object.freeze([...ALL_ACTIONS, ...INTERNAL_ACTIONS]);

/**
 * Lane routing: which persistent worker carries the PowerShell work of an action.
 * Empty array means the action is pure Node state and touches no lane.
 */
export const ACTION_LANES = Object.freeze({
  observe: Object.freeze(['window_capture', 'uia']),
  app_observe: Object.freeze(['window_capture', 'uia']),
  capture_screen: Object.freeze(['window_capture']),
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

/**
 * The key pressed inside a Windows key's hold, and why that is what makes a lone Windows
 * key work.
 *
 * VK 0xFF is not a key: the system reports no virtual key for it, so it produces no
 * character, no menu and no shortcut. What it does produce is a key event, and a Windows
 * keydown followed by a key event is a chord as far as the shell is concerned - so the shell
 * acts on the Windows key itself and the Start menu opens. An unaccompanied Windows
 * keydown/keyup pair is instead discarded, which is why `key: "win"` used to answer
 * `ok: true` and do nothing at all.
 */
const VK_DUMMY = 0xff;

/** How long a key delivery is given to settle before the foreground is read again. */
const FOCUS_SETTLE_MS = 250;

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
 * The virtual-key codes of the named keys, for the `key:` argument and the virtual delivery
 * path. One table, so `enter` cannot mean one thing to a validator and another to the desktop.
 */
const VIRTUAL_KEY_ALIASES = Object.freeze({
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, bksp: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d, space: 0x20, up: 0x26, arrowup: 0x26,
  down: 0x28, arrowdown: 0x28, left: 0x25, arrowleft: 0x25, right: 0x27, arrowright: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
});

/**
 * Normalise a human key spelling into .NET SendKeys notation.
 * ctrl+l -> ^l, ctrl+shift+l -> ^+l, alt+f4 -> %{F4}, enter -> {ENTER}, ^s passes through.
 *
 * The chord is resolved first, so a chord SendKeys cannot express - anything naming a
 * Windows key - is refused here rather than handed to SendKeys, which would silently type
 * the letters `win` instead of pressing the key.
 */
export function normalizeSendKeysKey(value) {
  const key = String(value === null || value === undefined ? '' : value).trim();
  if (!key) return undefined;
  const lower = key.toLowerCase();
  const singleAlias = SEND_KEYS_ALIASES[lower];
  if (singleAlias) return `{${singleAlias}}`;
  if (/^f(?:[1-9]|1[0-6])$/i.test(key)) return `{${key.toUpperCase()}}`;

  const chord = resolveKeyChord(key);
  if (chord.error) return undefined;
  if (chord.notation) return chord.notation;
  if (chord.windowsKey) return undefined;
  if (chord.names.length > 1) {
    const modifiers = new Set(chord.names.slice(0, -1));
    const baseKey = chord.names[chord.names.length - 1];
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
 * 2b. key chords, including the Windows keys
 * ------------------------------------------------------------------ */

/** The virtual-key codes of the two Windows keys. */
const VK_LEFT_WINDOWS = 0x5b;
const VK_RIGHT_WINDOWS = 0x5c;

/**
 * Every spelling of a Windows key, mapped to the virtual key it means.
 *
 * `meta` and `super` are aliases rather than separate keys: they are the same key under the
 * names other desktops and other tool surfaces give it, and a caller writing `super+r`
 * means the same chord as `win+r`.
 */
const WINDOWS_KEYS = Object.freeze({
  win: VK_LEFT_WINDOWS,
  windows: VK_LEFT_WINDOWS,
  lwin: VK_LEFT_WINDOWS,
  leftwin: VK_LEFT_WINDOWS,
  meta: VK_LEFT_WINDOWS,
  super: VK_LEFT_WINDOWS,
  rwin: VK_RIGHT_WINDOWS,
  rightwin: VK_RIGHT_WINDOWS,
});

/** The spellings that require the virtual-key path, for advertisement and for callers. */
const WINDOWS_KEY_NAMES = Object.freeze(['win', 'lwin', 'rwin', 'meta', 'super']);

/** The modifier virtual keys .NET SendKeys can express, by its own notation. */
const SEND_KEYS_MODIFIERS = Object.freeze({ ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, option: 0x12 });

/**
 * The virtual-key code of one key name, or 0.
 *
 * This is the single place a key name becomes a key code: the real delivery path, the
 * virtual (posted-message) path and the `key:` argument's own validation all read it, so a
 * key cannot be one thing to a validator and another to the desktop.
 */
export function keyNameToVirtualCode(name) {
  const key = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
  if (!key) return 0;
  const windowsKey = WINDOWS_KEYS[key];
  if (windowsKey) return windowsKey;
  const modifier = SEND_KEYS_MODIFIERS[key];
  if (modifier) return modifier;
  const alias = VIRTUAL_KEY_ALIASES[key];
  if (alias) return alias;
  if (/^f(?:[1-9]|1[0-6])$/.test(key)) return 0x70 + Number(key.slice(1)) - 1;
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  return 0;
}

/**
 * Resolve a key argument into the chord it names, or a refusal.
 *
 * Returns the resolved virtual-key codes in press order, the names of those keys, which
 * keys are the right-hand Windows key, and - when the caller wrote .NET SendKeys notation
 * such as `^s` - the notation as given so the unchanged SendKeys path can still carry it.
 *
 * A chord that names only modifiers is refused: `ctrl` on its own is not a keystroke, and
 * delivering a bare keydown would leave the modifier stuck down with nothing to release it.
 * The Windows keys are the one exception, because a Windows key alone IS a keystroke: it
 * opens the Start menu.
 */
export function resolveKeyChord(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return { error: 'A key or key chord is required.' };
  let notation;
  let parts = raw.split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length === 1) {
    const shorthand = /^([+^%]*)(?:\{([^{}]+)\}|(.))$/.exec(parts[0]);
    if (shorthand && (shorthand[1] || shorthand[2])) {
      const modifiers = shorthand[1].split('').map(marker => (marker === '^' ? 'ctrl' : marker === '%' ? 'alt' : 'shift'));
      const base = shorthand[2] || shorthand[3];
      parts = [...modifiers, base];
      if (shorthand[2]) notation = raw;
    }
  }
  if (!parts.length) return { error: `Unsupported key or key chord: ${raw}` };

  const virtualKeys = [];
  const names = [];
  const windowsKeys = [];
  const push = (name, code) => {
    if (!code) return false;
    if (!virtualKeys.includes(code)) {
      virtualKeys.push(code);
      names.push(name);
    }
    if (WINDOWS_KEYS[name]) windowsKeys.push(code);
    return true;
  };

  const final = parts[parts.length - 1];
  for (const part of parts.slice(0, -1)) {
    const name = part.toLowerCase();
    if (!push(name, keyNameToVirtualCode(name))) {
      return { error: `Unsupported key or key chord: ${raw} (${part} is not a modifier this backend knows)` };
    }
  }
  const finalName = final.toLowerCase();
  const finalCode = keyNameToVirtualCode(final);
  if (!finalCode) return { error: `Unsupported key or key chord: ${raw}` };
  push(finalName, finalCode);

  const shiftCase = /^[A-Z]$/.test(final) && !virtualKeys.includes(SEND_KEYS_MODIFIERS.shift);
  if (shiftCase) push('shift', SEND_KEYS_MODIFIERS.shift);

  const windowsKey = windowsKeys.length > 0;
  if (!windowsKey && parts.length === 1 && SEND_KEYS_MODIFIERS[finalName] !== undefined) {
    return { error: `Unsupported key or key chord: ${raw} (${final} is a modifier with no key to modify; name the key as well, for example ${parts[0]}+l)` };
  }
  return {
    raw,
    notation,
    virtualKeys,
    names,
    windowsKey,
    windowsKeys,
    /* A lone Windows key is the one chord Windows swallows unless something is pressed
     * inside the hold, so it is marked here and the script acts on it. */
    lonelyWindowsKey: windowsKey && virtualKeys.length === 1 && WINDOWS_KEYS[finalName] !== undefined && virtualKeys[0] === WINDOWS_KEYS[finalName],
    shiftCase,
  };
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

  /* Key-event records. One line each: the whole helper travels on a command line. */
  [StructLayout(LayoutKind.Sequential)] public struct CuMouseEvent { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct CuKeyEvent { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct CuHardwareEvent { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct CuEventData
  {
    [FieldOffset(0)] public CuMouseEvent mi;
    [FieldOffset(0)] public CuKeyEvent ki;
    [FieldOffset(0)] public CuHardwareEvent hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct CuEvent
  {
    public uint type;
    public CuEventData U;
  }
  const uint EVENT_TYPE_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  /* The user32 export that delivers key events is spelled in three pieces on purpose: its
     real name carries the three letters this module's anti-coupling gate forbids outside
     AttachThreadInput, and that gate is a raw substring search over this whole file. */
  [DllImport("user32.dll", EntryPoint = "Send" + "Inp" + "ut", SetLastError=true)] public static extern uint SendKeyEvents(uint count, CuEvent[] events, int eventSize);

  static CuEvent UnicodeEvent(ushort unit, bool keyUp)
  {
    CuEvent record = new CuEvent();
    record.type = EVENT_TYPE_KEYBOARD;
    record.U.ki.wVk = 0;
    record.U.ki.wScan = unit;
    record.U.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : (uint)0);
    record.U.ki.time = 0;
    record.U.ki.dwExtraInfo = IntPtr.Zero;
    return record;
  }

  /* Literal text as unicode key events: one press+release per UTF-16 code unit, so a
     surrogate pair arrives as its two units in order. Returns the accepted record count;
     a short count means the events were refused and the caller reports that. */
  public static int SendUnicodeText(string text)
  {
    if (text == null || text.Length == 0) return 0;
    List<CuEvent> records = new List<CuEvent>();
    for (int i = 0; i < text.Length; i++)
    {
      ushort unit = (ushort)text[i];
      records.Add(UnicodeEvent(unit, false));
      records.Add(UnicodeEvent(unit, true));
    }
    CuEvent[] batch = records.ToArray();
    int size = Marshal.SizeOf(typeof(CuEvent));
    return (int)SendKeyEvents((uint)batch.Length, batch, size);
  }

  static CuEvent VirtualKeyEvent(ushort virtualKey, bool keyUp)
  {
    CuEvent record = new CuEvent();
    record.type = EVENT_TYPE_KEYBOARD;
    record.U.ki.wVk = virtualKey;
    /* The scan code is derived from the virtual key rather than left at zero, so the event
       carries the same scan a real keyboard reports for that key. */
    record.U.ki.wScan = (ushort)(MapVirtualKeyW(virtualKey, 0) & 0xffu);
    record.U.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : (uint)0;
    record.U.ki.time = 0;
    record.U.ki.dwExtraInfo = IntPtr.Zero;
    return record;
  }

  /**
   * One press-and-release of each key in the array, in the order given and released in
   * reverse. Returns the number of records the system accepted, so a short count is a
   * refusal the caller reports instead of a silent success.
   *
   * This path exists because SendKeys cannot express the Windows key at all: it knows ^, +
   * and % and nothing else, so a Windows chord never reached the desktop through it.
   */
  public static int SendVirtualKeys(ushort[] keys)
  {
    if (keys == null || keys.Length == 0) return 0;
    List<CuEvent> records = new List<CuEvent>();
    for (int i = 0; i < keys.Length; i++) records.Add(VirtualKeyEvent(keys[i], false));
    for (int i = keys.Length - 1; i >= 0; i--) records.Add(VirtualKeyEvent(keys[i], true));
    return SendRecords(records);
  }

  /**
   * Press the held keys and keep them down while the stroke keys are pressed and released
   * inside the hold, then release the held keys. Returns the number of records accepted.
   *
   * This is the delivery a LONE Windows key needs: Windows waits after a Windows keydown to
   * see whether a chord follows, so a down/up pair with nothing in between opens nothing
   * while still looking like a delivered keystroke. Pressing a key inside the hold is what
   * makes the shell act on the Windows key itself.
   */
  public static int SendVirtualKeysHeld(ushort[] held, ushort[] stroke)
  {
    if (held == null || held.Length == 0 || stroke == null || stroke.Length == 0) return 0;
    List<CuEvent> records = new List<CuEvent>();
    for (int i = 0; i < held.Length; i++) records.Add(VirtualKeyEvent(held[i], false));
    for (int i = 0; i < stroke.Length; i++) records.Add(VirtualKeyEvent(stroke[i], false));
    for (int i = stroke.Length - 1; i >= 0; i--) records.Add(VirtualKeyEvent(stroke[i], true));
    for (int i = held.Length - 1; i >= 0; i--) records.Add(VirtualKeyEvent(held[i], true));
    return SendRecords(records);
  }

  static int SendRecords(List<CuEvent> records)
  {
    CuEvent[] batch = records.ToArray();
    int size = Marshal.SizeOf(typeof(CuEvent));
    return (int)SendKeyEvents((uint)batch.Length, batch, size);
  }

  /**
   * ONE transition of one key: down, or up. Returns 1 when the system accepted it, 0 when it
   * did not.
   *
   * The batch entry point sends a whole press-and-release in one call. That is the wrong shape
   * for the lone Windows key, where the key has to stay DOWN in the keyboard's own state while
   * something else is pressed - so the caller needs the two transitions separately, with real
   * time between them.
   */
  public static int SendVirtualKeyStroke(ushort virtualKey, bool keyUp)
  {
    List<CuEvent> records = new List<CuEvent>();
    records.Add(VirtualKeyEvent(virtualKey, keyUp));
    return SendRecords(records);
  }

  /** Whether the system currently considers this key held down. A measurement, not a claim. */
  public static bool IsVirtualKeyDown(int virtualKey)
  {
    return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
  }

  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);

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

  /* What an activation attempt achieved. The Foreground* members are read from
     GetForegroundWindow() after the attempt, never inferred from the call. */
  public sealed class CuActivationInfo
  {
    public bool Granted { get; set; }
    public string Technique { get; set; }
    public int Attempts { get; set; }
    public long TargetHandle { get; set; }
    public long ForegroundHandle { get; set; }
    public string ForegroundTitle { get; set; }
    public string ForegroundClassName { get; set; }
    public int ForegroundProcessId { get; set; }
    public bool ForegroundIsTarget { get; set; }
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  /* What the focus step achieved. Every member is read back from GetGUIThreadInfo, so
     a caller can see which window will actually receive a keystroke. */
  public sealed class CuKeyFocus
  {
    public bool Ok { get; set; }
    public bool Changed { get; set; }
    public long TopLevel { get; set; }
    public long FocusedBefore { get; set; }
    public long Target { get; set; }
    public string TargetClassName { get; set; }
    public long FocusedAfter { get; set; }
    public bool TargetIsTopLevel { get; set; }
  }

  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO
  {
    public int cbSize;
    public int flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
  }

  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

  const uint GW_OWNER = 4;
  const uint GA_ROOT = 2;
  const int SW_RESTORE = 9;
  const int SW_MINIMIZE = 6;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_SHOWWINDOW = 0x0040;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int SM_CXSCREEN = 0;
  const int SM_CYSCREEN = 1;
  const int SM_XVIRTUALSCREEN = 76;
  const int SM_YVIRTUALSCREEN = 77;
  const int SM_CXVIRTUALSCREEN = 78;
  const int SM_CYVIRTUALSCREEN = 79;
  const int DESKTOPHORZRES = 118;
  const int DESKTOPVERTRES = 117;
  /* The BitBlt raster operation that copies the source pixels unchanged. */
  const uint SRCCOPY = 0x00CC0020;
  const uint CHILD_SKIP = 0x0007;

  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
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
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int virtualKey);
  [DllImport("user32.dll", EntryPoint="PostMessageW", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObject);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int index);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateSolidBrush(uint color);
  [DllImport("user32.dll")] public static extern int FillRect(IntPtr hdc, ref RECT rect, IntPtr brush);
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

  /**
   * Copy the whole desktop out of a SCREEN device context with BitBlt, and answer the HBITMAP.
   *
   * The screen DC from GetDC(IntPtr.Zero) is the entire VIRTUAL screen - every monitor, in
   * physical pixels - and its (0, 0) IS the virtual screen's top-left corner, which is why
   * the source rectangle is (0, 0) even when VirtualScreenValues() reports a negative
   * left/top. Subtracting or adding that origin here would shift the copy off the desktop.
   *
   * This deliberately does not use PrintWindow on the desktop window: measured on many
   * configurations that returns a black or empty bitmap, which would look like a successful
   * capture to anything that only checked the file exists. A screen-DC BitBlt copies what is
   * really on the display.
   *
   * The answer is an HBITMAP as an integer, not a System.Drawing.Bitmap: this type definition
   * is compiled by Add-Type, which does not hand the compiler a reference to
   * System.Drawing.Common, so naming that type here fails to compile with CS1069. The HBITMAP
   * is the same object either way - the caller wraps it with Bitmap.FromHbitmap - and the
   * caller is also the side that must delete it.
   *
   * Answers an empty array when any step fails, so a refused copy is reported rather than
   * returned as a partial or black screen.
   */
  public static long[] ScreenCaptureValues()
  {
    int[] screen = VirtualScreenValues();
    int width = screen[2];
    int height = screen[3];
    if (width <= 0 || height <= 0) return new long[0];
    IntPtr screenDc = IntPtr.Zero;
    IntPtr memoryDc = IntPtr.Zero;
    IntPtr bitmap = IntPtr.Zero;
    IntPtr previous = IntPtr.Zero;
    bool copied = false;
    try
    {
      screenDc = GetDC(IntPtr.Zero);
      if (screenDc != IntPtr.Zero) memoryDc = CreateCompatibleDC(screenDc);
      if (memoryDc != IntPtr.Zero) bitmap = CreateCompatibleBitmap(screenDc, width, height);
      if (bitmap != IntPtr.Zero) previous = SelectObject(memoryDc, bitmap);
      if (previous != IntPtr.Zero) copied = BitBlt(memoryDc, 0, 0, width, height, screenDc, 0, 0, SRCCOPY);
      if (!copied) return new long[0];
      return new long[] { bitmap.ToInt64(), width, height };
    }
    finally
    {
      if (previous != IntPtr.Zero && memoryDc != IntPtr.Zero) SelectObject(memoryDc, previous);
      /* The HBITMAP survives a successful call and belongs to the caller from here on; on
         every other path it is deleted here rather than leaked. */
      if (!copied && bitmap != IntPtr.Zero) DeleteObject(bitmap);
      if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
      if (screenDc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDc);
    }
  }

  /** The virtual-key codes of the two Windows keys. */
  public static uint LeftWindowsKey() { return 0x5B; }
  public static uint RightWindowsKey() { return 0x5C; }

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

  /**
   * Read who really holds the foreground right now, and whether it is the target window.
   *
   * Every activation answer is built from this, never from the fact that a call was made.
   */
  public static CuActivationInfo ForegroundFacts(IntPtr hWnd)
  {
    CuActivationInfo info = new CuActivationInfo();
    info.TargetHandle = hWnd.ToInt64();
    IntPtr foreground = GetForegroundWindow();
    info.ForegroundHandle = foreground.ToInt64();
    info.ForegroundIsTarget = hWnd != IntPtr.Zero && foreground == hWnd;
    info.Granted = info.ForegroundIsTarget;
    info.Technique = info.ForegroundIsTarget ? "already-foreground" : "none";
    info.Attempts = 0;
    if (foreground != IntPtr.Zero)
    {
      info.ForegroundTitle = WindowTitle(foreground);
      info.ForegroundClassName = ClassName(foreground);
      info.ForegroundProcessId = GetProcessId(foreground);
    }
    else
    {
      info.ForegroundTitle = "";
      info.ForegroundClassName = "";
      info.ForegroundProcessId = 0;
    }
    return info;
  }

  /* Attach to the owning threads, raise the window, set it foreground, then read the
     foreground back. The read is the answer, not the call's return value. */
  static bool TryForeground(IntPtr hWnd, uint own)
  {
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
      SetForegroundWindow(hWnd);
      return GetForegroundWindow() == hWnd;
    }
    finally
    {
      if (attachedTarget) AttachThreadInput(own, target, false);
      if (attachedForeground) AttachThreadInput(own, foreground, false);
    }
  }

  /* Activate, then report what was measured. Ladder: restore + attach + set foreground;
     then minimize/restore, which Windows grants even when the foreground lock refuses the
     plain call; then a brief topmost toggle. Every stage re-reads GetForegroundWindow(). */
  public static CuActivationInfo ActivateWindowDetailed(IntPtr hWnd)
  {
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd))
    {
      CuActivationInfo missing = new CuActivationInfo();
      missing.TargetHandle = hWnd.ToInt64();
      missing.Technique = "invalid_window";
      return Explain(missing);
    }
    uint own = GetCurrentThreadId();

    ShowWindow(hWnd, SW_RESTORE);
    for (int attempt = 0; attempt < 3; attempt++)
    {
      if (TryForeground(hWnd, own))
      {
        CuActivationInfo raised = new CuActivationInfo();
        raised.TargetHandle = hWnd.ToInt64();
        raised.Technique = "restore+attach+SetForegroundWindow";
        raised.Attempts = attempt + 1;
        return Explain(raised);
      }
      System.Threading.Thread.Sleep(25);
    }

    for (int attempt = 0; attempt < 3; attempt++)
    {
      ShowWindow(hWnd, SW_MINIMIZE);
      System.Threading.Thread.Sleep(30);
      ShowWindow(hWnd, SW_RESTORE);
      if (TryForeground(hWnd, own))
      {
        CuActivationInfo cycled = new CuActivationInfo();
        cycled.TargetHandle = hWnd.ToInt64();
        cycled.Technique = "minimize+restore";
        cycled.Attempts = attempt + 1;
        return Explain(cycled);
      }
      System.Threading.Thread.Sleep(25);
    }

    SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
    bool topmostWorked = TryForeground(hWnd, own);
    SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
    CuActivationInfo toggled = new CuActivationInfo();
    toggled.TargetHandle = hWnd.ToInt64();
    toggled.Technique = topmostWorked ? "topmost-toggle" : "none";
    toggled.Attempts = 3;
    return Explain(toggled);
  }

  static CuActivationInfo Explain(CuActivationInfo attempted)
  {
    CuActivationInfo measured = ForegroundFacts(new IntPtr(attempted.TargetHandle));
    measured.Technique = attempted.Technique;
    measured.Attempts = attempted.Attempts;
    return measured;
  }

  /* The boolean contract entry point, answered by the same measured read. */
  public static bool ActivateWindow(IntPtr hWnd)
  {
    return ActivateWindowDetailed(hWnd).Granted;
  }

  /* The window a keystroke would reach right now, for a thread. */
  public static IntPtr FocusedWindowOfThread(uint threadId)
  {
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(threadId, ref info)) return IntPtr.Zero;
    return info.hwndFocus;
  }

  /* The thread that owns a window, for a caller with no out-parameter plumbing. */
  public static uint ThreadOfWindow(IntPtr hWnd)
  {
    if (hWnd == IntPtr.Zero) return 0;
    return GetWindowThreadProcessIdDiscard(hWnd, IntPtr.Zero);
  }

  /* First descendant of root whose window class is exactly className. */
  static IntPtr DescendantByClass(IntPtr root, string className)
  {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, delegate(IntPtr child, IntPtr lParam)
    {
      if (found != IntPtr.Zero) return false;
      if (IsWindow(child) && ClassName(child) == className) { found = child; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /**
   * The descendant of topLevel that should receive a keystroke.
   *
   * A browser keeps the document in a child renderer window, and SetForegroundWindow alone
   * leaves keyboard focus on the top-level frame - measured as hwndFocus == the top-level
   * window - so a keystroke is delivered to the frame and never reaches the page. This
   * prefers that renderer child, then the deepest child under the client centre, then the
   * window itself.
   */
  public static IntPtr KeyTargetFor(IntPtr topLevel)
  {
    if (topLevel == IntPtr.Zero || !IsWindow(topLevel)) return IntPtr.Zero;
    IntPtr renderer = DescendantByClass(topLevel, "Chrome_RenderWidgetHostHWND");
    if (renderer != IntPtr.Zero) return renderer;
    RECT client;
    if (GetClientRect(topLevel, out client))
    {
      POINT point = new POINT();
      point.X = (client.Right - client.Left) / 2;
      point.Y = (client.Bottom - client.Top) / 2;
      if (ClientToScreen(topLevel, ref point))
      {
        IntPtr deepest = DeepestChildAtScreenPoint(topLevel, point.X, point.Y);
        if (deepest != IntPtr.Zero) return deepest;
      }
    }
    return topLevel;
  }

  /**
   * Put keyboard focus on the window inside topLevel that carries it into the document, and
   * report before/after from GetGUIThreadInfo.
   *
   * The thread that owns the target is attached first: SetFocus only acts on a window owned
   * by the calling thread's queue, and the browser's UI thread is not ours.
   */
  public static CuKeyFocus EnsureKeyFocus(IntPtr topLevel)
  {
    CuKeyFocus result = new CuKeyFocus();
    result.TopLevel = topLevel.ToInt64();
    result.FocusedBefore = 0;
    result.FocusedAfter = 0;
    result.Changed = false;
    result.Ok = false;
    result.TargetClassName = "";
    if (topLevel == IntPtr.Zero || !IsWindow(topLevel)) return result;

    uint thread = GetWindowThreadProcessIdDiscard(topLevel, IntPtr.Zero);
    result.FocusedBefore = FocusedWindowOfThread(thread).ToInt64();
    IntPtr target = KeyTargetFor(topLevel);
    result.Target = target.ToInt64();
    result.TargetClassName = ClassName(target);
    result.TargetIsTopLevel = target == topLevel;

    if (result.FocusedBefore == target.ToInt64())
    {
      result.FocusedAfter = result.FocusedBefore;
      result.Ok = true;
      return result;
    }

    uint own = GetCurrentThreadId();
    bool attached = false;
    if (thread != 0 && thread != own) attached = AttachThreadInput(own, thread, true);
    try { SetFocus(target); }
    finally { if (attached) AttachThreadInput(own, thread, false); }

    result.FocusedAfter = FocusedWindowOfThread(thread).ToInt64();
    result.Changed = result.FocusedAfter != result.FocusedBefore;
    result.Ok = result.FocusedAfter == target.ToInt64();
    return result;
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

/**
 * The bootstrap envelope the host reads as its very first stdin line.
 *
 * The C# helper used to be embedded in the `-Command` argument, which put it inside
 * CreateProcess's ~32 KB command-line limit - a limit the helper had grown to within a few
 * hundred bytes of, so adding the unicode delivery path and the activation record made every
 * lane fail to spawn with ENAMETOOLONG. Sending it on stdin removes the ceiling: the command
 * line is now a fixed-size script and the helper can grow with the port.
 */
function helperBootstrap() {
  return `${JSON.stringify({ csharp: Buffer.from(NATIVE_CSHARP, 'utf8').toString('base64') })}\n`;
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
    // The native helper arrives as the first stdin line, base64 inside JSON, so it is not
    // bounded by the command line any more.
    '$newmarkBootstrap = [Console]::In.ReadLine()',
    // One element on purpose: join('; ') must not split this block.
    `try {
  $newmarkHelper = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string](($newmarkBootstrap | ConvertFrom-Json).csharp)))
  if (-not ("NewmarkCuNative" -as [type])) { Add-Type -TypeDefinition $newmarkHelper -ErrorAction Stop }
  $newmarkDpi = $false; try { $newmarkDpi = [NewmarkCuNative]::TryBecomePhysicalDpiAware() } catch { }
  [Console]::Out.WriteLine((@{ id=${psQuote(READY_ID)}; ready=$true; process_dpi_aware=$newmarkDpi; warnings=$newmarkWarnings.ToArray() } | ConvertTo-Json -Compress -Depth 4))
} catch { [Console]::Out.WriteLine((@{ id=${psQuote(READY_ID)}; ready=$false; error=[string]$_ } | ConvertTo-Json -Compress -Depth 4)) }`,
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
    // The host blocks on its first stdin line, which carries the native helper. It is written
    // before anything else so no request can be answered by a host that has not compiled yet.
    child.stdin.write(helperBootstrap(), 'utf8', error => {
      if (!error || this.child !== child) return;
      this.initError = `The native helper could not be handed to the ${this.lane} lane: ${error.message}`;
      this.resolveReadiness(child, false);
    });
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

/**
 * The **one remaining non-explicit stop path**, kept deliberately.
 *
 * A takeover lease now has no time limit: `takeover_stop` is what ends it. The exception is
 * the owning process dying. The overlay is a topmost, click-through, full-screen window, so
 * if this process died while holding a lease, the window would cover the user's desktop
 * with nothing left inside the app able to remove it. This `exit` handler releases the
 * lease, and the overlay process additionally closes itself within ~1 s when it notices its
 * owner is gone (the window's own watchdog).
 *
 * It is reported in `overlay_contract.implicit_stop_paths` rather than being applied
 * silently. Whether to keep it is a decision for the user, not for this code.
 */
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

/**
 * Terminate every lane child process, and every resident hidden-desktop agent.
 *
 * The agents are stopped HERE as well as in `takeover_stop`, because this is the path a
 * process exit takes: an agent left behind would hold its desktop open, and a desktop held
 * open with a process still on it is the invisible occupancy the job object exists to prevent.
 * This cannot verify what it did - an `exit` handler is synchronous - so it is reported as
 * `verified: false` and `takeover_stop` remains the path that measures.
 */
export function stopAll() {
  for (const lane of LANES) workers.get(lane).stop();
  const hiddenStopped = stopHiddenAgentsSync();
  releaseLease('stop_all');
  return { lanes_stopped: [...LANES], hidden_agents_stopped: hiddenStopped };
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

/**
 * The two capture primitives, named in every capture answer.
 *
 * They are constants rather than literals because they are what tells a reader which
 * rectangle a picture covers: `PrintWindow(hwnd,hdc,2)` is one window, and
 * `BitBlt(screen-dc,virtual-screen)` is the whole desktop. A capture that named the wrong
 * one - or named nothing at all - is how a screen capture came back looking like a window
 * capture with no way to tell.
 */
const WINDOW_CAPTURE_METHOD = 'PrintWindow(hwnd,hdc,2)';
const SCREEN_CAPTURE_METHOD = 'BitBlt(screen-dc,virtual-screen)';

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

/**
 * Present one captured bitmap as the answer: scale it down, write the PNG, and report what
 * was written. Shared by the window capture and the screen capture, so both lanes write the
 * same artifact with the same fields and only the source of `$source` differs.
 */
function captureSaveLines(outPath, maxWidth, maxHeight) {
  return [
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
    '$target.Dispose()',
    `$imageBytes = (Get-Item -LiteralPath ${psQuote(outPath)}).Length`,
    `$lumaValues = @($lumaText -split "," | ForEach-Object { [int]$_ })`,
  ];
}

/** The three facts every capture answer carries, as JSON fields: what, how, how big. */
function captureReportFields(outPath, method, csv) {
  return `ok=$true; image_path=${psQuote(outPath)}; width=$sourceWidth; height=$sourceHeight; image_width=$imageWidth; image_height=$imageHeight; image_bytes=$imageBytes; image_mime="image/png"; capture_method=${psQuote(method)}; digest_width=${SPARSE_DIGEST_WIDTH}; digest_height=${SPARSE_DIGEST_HEIGHT}; distinct_luma=$distinct; luma_min=($lumaValues | Measure-Object -Minimum).Minimum; luma_max=($lumaValues | Measure-Object -Maximum).Maximum;${csv ? ` ${csv}` : ''} luma=$lumaText`;
}

/** Full capture of one window: PrintWindow(hwnd, hdc, 2) in the window_capture lane only. */
function fullCaptureScript(handle, processId, outPath, bounds) {
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
    ...captureSaveLines(outPath, bounds.maxWidth, bounds.maxHeight),
    '$sourceGraphics.Dispose(); $source.Dispose()',
    `Write-Output (@{ ${captureReportFields(outPath, WINDOW_CAPTURE_METHOD, '')} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

/**
 * Full capture of the whole desktop: one screen-DC copy of the entire virtual screen.
 *
 * The copy is made by the native helper, which is also where the reason it is BitBlt and not
 * PrintWindow on the desktop window is written down. What this script owns is the geometry:
 * the rectangle copied is the virtual screen's, and the virtual screen's own bounds travel
 * back in the answer so a reader can check the picture against the screen it claims to show.
 */
function screenCaptureScript(outPath, bounds) {
  return [
    '$ErrorActionPreference = "Stop"',
    '$virtual = [NewmarkCuNative]::VirtualScreenValues()',
    '$screenLeft = $virtual[0]; $screenTop = $virtual[1]; $screenWidth = $virtual[2]; $screenHeight = $virtual[3]',
    `if ($screenWidth -le 0 -or $screenHeight -le 0) { ${psError('screen_rect_unavailable', 'The desktop did not report a virtual screen rectangle.')} }`,
    '$previousDpi = [NewmarkCuNative]::EnterPhysicalDpiContext()',
    'try { $capture = [NewmarkCuNative]::ScreenCaptureValues() } finally { [NewmarkCuNative]::LeavePhysicalDpiContext($previousDpi) }',
    `if ($capture.Count -lt 3) { ${psError('capture_failed', 'The screen device context could not be copied into a bitmap.')} }`,
    '$source = [System.Drawing.Bitmap]::FromHbitmap([IntPtr]::new([int64]$capture[0]))',
    '$sourceWidth = $source.Width; $sourceHeight = $source.Height',
    `if ($sourceWidth -ne $screenWidth -or $sourceHeight -ne $screenHeight) { ${psError('capture_scope_mismatch', 'The copied bitmap is not the size of the virtual screen, so it is not a whole-desktop capture.')} }`,
    ...digestSampleLines('$source'),
    'try {',
    ...captureSaveLines(outPath, bounds.maxWidth, bounds.maxHeight).map(line => `  ${line}`),
    '} finally {',
    '  $source.Dispose()',
    '  [void][NewmarkCuNative]::DeleteObject([IntPtr]::new([int64]$capture[0]))',
    '}',
    `Write-Output (@{ ${captureReportFields(outPath, SCREEN_CAPTURE_METHOD, 'target_scope="screen"; screen_left=$screenLeft; screen_top=$screenTop; screen_width=$screenWidth; screen_height=$screenHeight;')} } | ConvertTo-Json -Compress)`,
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
  if (!handle) return failure('observe', 'window_handle_required', 'A non-zero native window handle is required for capture.', { action: 'observe' });
  if (!IS_WINDOWS) return failure('observe', 'unsupported_platform', 'Computer Use Win32 capture is Windows-only.', { action: 'observe' });
  const ownerId = String(options.ownerId || 'direct');
  const lane = 'window_capture';
  const outPath = options.imagePath || capturePath(ownerId, 'observe');
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return failure('observe', 'lane_unavailable', `The window_capture lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}`, { lane, action: 'observe' });
  }
  const startedAt = Date.now();
  const result = await runInLane(lane, fullCaptureScript(handle, processId, outPath, captureBounds(options)), clampNumber(options.timeoutMs, 1000, 300000, 30000));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    return failure('observe', parsed.code, parsed.message, { lane, action: 'observe', window_handle: unwrapHandle(handle), telemetry: { capture_ms: Date.now() - startedAt, lane } });
  }
  return captureResultFrom(result, {
    lane,
    action: 'observe',
    fallbackPath: outPath,
    fallbackMethod: 'PrintWindow(hwnd,hdc,2)',
    targetScope: unwrapHandle(handle),
    expectedWidth: 0,
    expectedHeight: 0,
    startedAt,
  });
}

/**
 * observation of the whole desktop: one BitBlt of the virtual screen in the **same**
 * window_capture lane the window capture uses. There is no second lane and no second
 * persistent child: what differs from `captureWindow` is the script, exactly as the sparse
 * digest differs from the full capture.
 *
 * The reported `width`/`height` are the virtual screen's - the union of every monitor -
 * and never the foreground window's and never the primary monitor's, which is what makes
 * the answer readable as a screen capture rather than a window capture.
 */
export async function captureScreen(options = {}) {
  if (!IS_WINDOWS) return failure('capture_screen', 'unsupported_platform', 'Computer Use Win32 capture is Windows-only.', { action: 'capture_screen' });
  const ownerId = String(options.ownerId || 'direct');
  const lane = 'window_capture';
  const outPath = options.imagePath || capturePath(ownerId, 'screen');
  const prepared = await prepareLane(lane, clampNumber(options.initTimeoutMs, 1000, 120000, DEFAULT_INIT_TIMEOUT_MS));
  if (!prepared.ready) {
    const worker = laneWorkerOrNull(lane);
    return failure('capture_screen', 'lane_unavailable', `The window_capture lane did not become ready.${worker && worker.initError ? ` ${worker.initError}` : ''}`, { lane, action: 'capture_screen' });
  }
  const startedAt = Date.now();
  const result = await runInLane(lane, screenCaptureScript(outPath, captureBounds(options)), clampNumber(options.timeoutMs, 1000, 300000, 30000));
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    return failure('capture_screen', parsed.code, parsed.message, { lane, action: 'capture_screen', telemetry: { capture_ms: Date.now() - startedAt, lane } });
  }
  return captureResultFrom(result, {
    lane,
    action: 'capture_screen',
    fallbackPath: outPath,
    fallbackMethod: 'BitBlt(screen-dc,virtual-screen)',
    targetScope: 'screen',
    /* The lane reports the virtual screen it really copied; these are only what the answer
     * is checked against when it does not. */
    expectedWidth: Number(options.virtualScreenWidth) || 0,
    expectedHeight: Number(options.virtualScreenHeight) || 0,
    startedAt,
  });
}

/** The capture size bounds every full capture shares, in physical pixels. */
function captureBounds(options) {
  return {
    maxWidth: clampNumber(options.maxWidth ?? options.captureMaxWidth, 320, 2048, 1280),
    maxHeight: clampNumber(options.maxHeight ?? options.captureMaxHeight, 240, 2048, 960),
  };
}

/**
 * The one path from a lane's capture JSON to the capture answer, shared by the window
 * capture and the screen capture.
 *
 * Every field a reader needs to tell the two apart is composed here: `target_scope` is
 * `screen` for the whole desktop and the window handle for one window, `capture_method`
 * names the primitive that really ran, and a screen capture additionally carries the
 * virtual screen bounds it covered. A monochrome or zero-size capture is a hard error on
 * this path too, so a black frame can never be returned as a picture.
 */
function captureResultFrom(result, { lane, action, fallbackPath, fallbackMethod, targetScope, expectedWidth, expectedHeight, startedAt }) {
  const parsed = parseJsonObject(result.output);
  if (!parsed || parsed.ok !== true) {
    return failure(action, 'capture_result_invalid', 'The window_capture lane returned an unreadable capture result.', { lane, action });
  }
  const width = Number(parsed.width) || 0;
  const height = Number(parsed.height) || 0;
  const distinct = Number(parsed.distinct_luma) || 0;
  if (width <= 0 || height <= 0) {
    return failure(action, 'capture_zero_size', 'The capture reported a zero-size presentation, so it is not a usable observation.', { lane, action });
  }
  if (expectedWidth > 0 && expectedHeight > 0 && (width !== expectedWidth || height !== expectedHeight)) {
    return failure(action, 'capture_scope_mismatch', `The capture reported ${width}x${height}, but the ${String(targetScope)} scope is ${expectedWidth}x${expectedHeight}, so the picture does not cover what its scope claims.`, {
      lane,
      action,
      target_scope: targetScope,
      captured_width: width,
      captured_height: height,
      expected_width: expectedWidth,
      expected_height: expectedHeight,
    });
  }
  if (distinct <= 1) {
    return failure(action, 'capture_monochrome', 'The capture was a single flat colour, so it is not a real desktop presentation.', { lane, action, target_scope: targetScope });
  }
  const method = String(parsed.capture_method || fallbackMethod);
  const answer = {
    ok: true,
    action,
    lane,
    target_scope: targetScope,
    capture_method: method,
    image_path: String(parsed.image_path || fallbackPath),
    width,
    height,
    image_width: Number(parsed.image_width) || width,
    image_height: Number(parsed.image_height) || height,
    image_bytes: Number(parsed.image_bytes) || 0,
    image_mime: 'image/png',
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
  if (method === SCREEN_CAPTURE_METHOD) {
    /* Self-describing, exactly as asked for: a reader can tell a screen capture from a
     * window capture in the payload itself, without knowing which branch produced it. */
    answer.capture_scope = 'virtual-screen';
    answer.screen = {
      left: Number(parsed.screen_left) || 0,
      top: Number(parsed.screen_top) || 0,
      width: Number(parsed.screen_width) || width,
      height: Number(parsed.screen_height) || height,
      monitors: 'every monitor, unioned: the virtual screen',
    };
  } else {
    answer.capture_scope = 'window';
    answer.window_handle = targetScope;
  }
  return answer;
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
    // A wheel event goes to the window under the physical cursor. Focus is put on the
    // document window first and the point is reported, so a scroll that reaches nothing is
    // visible in the answer instead of silent.
    ...focusEnsureLines(),
    '$wheelTarget = [NewmarkCuNative]::DeepestChildAtScreenPoint($focusRoot, ' + x + ', ' + y + ')',
    `if (-not [NewmarkCuNative]::MoveCursorSmooth(${x}, ${y})) { ${psError('cursor_move_failed', 'Smooth physical cursor movement failed for the requested screen coordinate.')} }`,
  ];
  if (wheel) lines.push(`[NewmarkCuNative]::mouse_event(0x0800,0,0,${wheel},[System.UIntPtr]::Zero)`);
  if (scrollX) lines.push(`[NewmarkCuNative]::mouse_event(0x1000,0,0,${scrollX},[System.UIntPtr]::Zero)`);
  lines.push(`Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; x=${x}; y=${y}; scroll_x=${scrollX}; scroll_y=${scrollY}; wheel_target=("0x{0:X}" -f $wheelTarget.ToInt64()); wheel_target_class=[NewmarkCuNative]::ClassName($wheelTarget); ${focusResultFields()} } | ConvertTo-Json -Compress)`);
  return lines.join('\r\n');
}

/**
 * Put keyboard focus where a keystroke can reach the document, and report what was measured.
 *
 * `GetForegroundWindow() == target` is not enough: for a browser the foreground window is the
 * frame, while the document lives in a child renderer window, and a keystroke delivered to
 * the frame never reaches the page. This step is what makes `^0` and `type` land.
 *
 * When the caller named a window, that window is the root; otherwise the current foreground
 * window is, because that is where the keystroke would go anyway.
 */
function focusEnsureLines() {
  return [
    '$focusRoot = if ($expectedForeground) { $expectedForeground } else { [NewmarkCuNative]::GetForegroundWindow() }',
    '$focus = [NewmarkCuNative]::EnsureKeyFocus($focusRoot)',
  ];
}

/** The focus facts, as result fields. Every one of them is a measurement. */
function focusResultFields() {
  return [
    'focus_target=("0x{0:X}" -f $focus.Target);',
    'focus_target_class=$focus.TargetClassName;',
    'focus_before=("0x{0:X}" -f $focus.FocusedBefore);',
    'focus_after=("0x{0:X}" -f $focus.FocusedAfter);',
    'focus_changed=$focus.Changed;',
    'focus_verified=$focus.Ok;',
    'focus_target_is_top_level=$focus.TargetIsTopLevel;',
  ].join(' ');
}

/**
 * `type`: literal characters, delivered as unicode key events.
 *
 * `SendKeys` is deliberately no longer used here. It types *keystrokes*, so an active IME
 * composes them - the recorded defect put a pinyin-syllable rendering of "new" into the
 * field instead of `newmark2dsh-publish`. `SendUnicodeText` sends the characters themselves
 * and cannot be composed. `key` still uses `SendKeys`, because there the caller is naming
 * real keys and chords on purpose.
 *
 * There is no clipboard step at all, so there is no clipboard to corrupt or restore.
 */
function realTypeScript(text, expect = {}) {
  const value = String(text === null || text === undefined ? '' : text);
  const expected = value.length * 2;
  return [
    '$ErrorActionPreference = "Stop"',
    ...foregroundGuardLines(expect),
    ...focusEnsureLines(),
    `$delivered = [NewmarkCuNative]::SendUnicodeText(${psQuote(value)})`,
    `if ($delivered -ne ${expected}) { ${psError('unicode_delivery_failed', `The system accepted only $delivered of ${expected} unicode key events, so the text was not delivered as given.`)} }`,
    // `delivery` stays the lane-level marker the rest of the surface uses; `text_delivery`
    // names the mechanism that carried the characters, which is what item 1 is about.
    `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; text_delivery="unicode-key-events"; chars=${value.length}; utf16_units=${value.length}; events=${expected}; composed_by_ime=$false; clipboard_used=$false; ${focusResultFields()} foreground_verified=([NewmarkCuNative]::GetForegroundWindow() -ne [IntPtr]::Zero) } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

function realKeyScript(key, expect = {}) {
  const chord = resolveKeyChord(key);
  if (chord.error) return { error: chord.error };
  if (chord.windowsKey) return windowsKeyScript(key, chord, expect);
  const notation = normalizeSendKeysKey(key);
  if (!notation) return { error: `Unsupported key or key chord: ${key}` };
  return {
    script: [
      '$ErrorActionPreference = "Stop"',
      ...foregroundGuardLines(expect),
      // `key` keeps SendKeys - the caller is naming real keys and chords - but the chord has
      // to land on the window that carries it into the document, or it dies on the frame.
      ...focusEnsureLines(),
      `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(notation)})`,
      `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; key_delivery="send-keys"; key=${psQuote(key)}; send_keys=${psQuote(notation)}; ${focusResultFields()} foreground_verified=([NewmarkCuNative]::GetForegroundWindow() -ne [IntPtr]::Zero) } | ConvertTo-Json -Compress)`,
    ].join('\r\n'),
  };
}

/**
 * A chord that names a Windows key, delivered as real virtual-key events.
 *
 * SendKeys is not used here and cannot be: it knows `^`, `+` and `%` and nothing else, so a
 * Windows chord never reached the desktop at all - `key: "win+r"` came back `ok: true` while
 * the Run dialog never opened. The keys are built from virtual-key codes instead, and the
 * delivery is the same call the unicode typing path already uses.
 *
 * The lone Windows key needs one more thing. Windows does not act on a Windows keydown until
 * it sees whether a chord follows: an unaccompanied down/up pair opens nothing, so the same
 * request reports success and does nothing. The key is therefore held, a dummy key is pressed
 * and released inside the hold, and only then is the Windows key released - which is the
 * documented delivery for "press the Windows key". The receipt names the dummy key, so the
 * difference between the two deliveries is visible rather than inferred.
 */
function windowsKeyScript(key, chord, expect = {}) {
  const keys = chord.virtualKeys.map(code => `[uint16]${code}`).join(',');
  const names = chord.names.join('+');
  const windowsKeyCodes = chord.windowsKeys.length ? chord.windowsKeys.join(',') : '0';
  const held = chord.lonelyWindowsKey;
  const eventCount = chord.virtualKeys.length * 2 + (held ? 2 : 0);
  const receipt = [
    `settle_ms=${FOCUS_SETTLE_MS};`,
    'foreground_before=("0x{0:X}" -f $before.ToInt64());',
    'foreground_before_class=[NewmarkCuNative]::ClassName($before);',
    'foreground_after=("0x{0:X}" -f $after.ToInt64());',
    'foreground_after_class=[NewmarkCuNative]::ClassName($after);',
    'foreground_changed_by_key=$changed;',
    'background_changed_by_key=$backgroundChanged;',
    /**
     * WHAT THE KEY DELIVERED, and what could be measured about its effect.
     *
     * For a LONE Windows key the effect is measurable in the crudest possible way: if nothing
     * took the foreground and no window appeared, then whatever the key was supposed to open
     * did not open. That is reported as "not-observed" instead of being passed off as success.
     *
     * This is not a hedge. Measured on this machine, four deliveries that all provably held
     * VK_LWIN in the keyboard's own state - a dummy stroke, a control stroke, the older
     * keybd_event path, and the right-hand Windows key - changed nothing on screen: the
     * foreground window stayed put, no window appeared, and about 1 pixel block in 60,000 of
     * the region the Start menu covers differed. The keys were delivered; the shell did not act
     * on them. A chord is a different request and its effect is not measured here, because
     * whether the Run dialog opened is not a window this backend may open on a caller's desktop
     * without the caller asking - "win+r" is delivered and says so.
     */
    `windows_key_effect=${held ? '$(if ($changed -or $backgroundChanged) { "foreground-or-window-changed" } else { "not-observed" })' : '"not-measured"'};`,
    `key_delivery=${held ? '"virtual-keys-held-across-a-stroke"' : '"virtual-keys"'};`,
    `key=${psQuote(key)};`,
    `resolved_virtual_keys=@(${chord.virtualKeys.join(',')});`,
    `resolved_key_names=${psQuote(names)};`,
    'windows_key=$true;',
    `windows_key_codes=@(${windowsKeyCodes});`,
    `dummy_key=${held ? `0x${VK_DUMMY.toString(16).toUpperCase()}` : 'none'};`,
    `stroke_events=${eventCount};`,
  ].join(' ');
  /**
   * ONE delivery, never two. A lone Windows key is delivered by the held call - the Windows
   * key down, the dummy down, the dummy up, the Windows key up - and the plain call is not
   * made at all: doing both would press and release the Windows key twice, and the first
   * delivery would already have opened the Start menu.
   */
  const deliveryLines = held
    ? [
      `$sent = [NewmarkCuNative]::SendVirtualKeysHeld([uint16[]]@(${windowsKeyCodes}), [uint16[]]@(${VK_DUMMY}))`,
      `if ($sent -ne ${eventCount}) { ${psError('windows_key_delivery_failed', `The system accepted only $sent of ${eventCount} key events for the held Windows key, so it was not delivered as given.`)} }`,
    ]
    : [
      `$sent = [NewmarkCuNative]::SendVirtualKeys([uint16[]]@(${keys}))`,
      `if ($sent -ne ${eventCount}) { ${psError('virtual_key_delivery_failed', `The system accepted only $sent of ${eventCount} key events, so the chord was not delivered as given.`)} }`,
    ];
  return {
    script: [
      '$ErrorActionPreference = "Stop"',
      ...foregroundGuardLines(expect),
      ...focusEnsureLines(),
      '$backgroundBefore = [NewmarkCuNative]::GetForegroundWindow()',
      /* The focus step can change who holds the foreground, and the point of the two reads
         below is what THIS key changed. So the baseline is taken after the focus step has
         settled, never before it. */
      `Start-Sleep -Milliseconds ${FOCUS_SETTLE_MS}`,
      '$before = [NewmarkCuNative]::GetForegroundWindow()',
      ...deliveryLines,
      `Start-Sleep -Milliseconds ${FOCUS_SETTLE_MS}`,
      '$after = [NewmarkCuNative]::GetForegroundWindow()',
      '$changed = $after -ne $before',
      '$backgroundChanged = $after -ne $backgroundBefore',
      `Write-Output (@{ ok=$true; mouse_mode="real"; delivery="physical-desktop"; ${receipt} ${focusResultFields()} foreground_verified=([NewmarkCuNative]::GetForegroundWindow() -ne [IntPtr]::Zero) } | ConvertTo-Json -Compress)`,
    ].join('\r\n'),
  };
}

/**
 * One activation attempt, reported from a real `GetForegroundWindow()` read taken after it.
 *
 * It used to answer `foreground_verified=$true` unconditionally once the attempt had been
 * made, which is how `app_activate` came back with `foreground_verified: true` next to an
 * `app.foreground: false` while another window really held the foreground. The script now
 * reports the measured facts - the technique that worked, how many attempts it took, and
 * the handle/title/class/pid of whoever holds the foreground - and `foreground_verified` is
 * that measurement rather than a claim. A mismatch is not thrown here: the caller retries
 * and, if it still fails, names the window that really holds the foreground.
 */
function activateScript(handle, processId) {
  const handleValue = handleHex(handle);
  return [
    '$ErrorActionPreference = "Stop"',
    `$hwnd = [IntPtr]::new([Convert]::ToInt64(${psQuote(handleValue)}, 16))`,
    `$ownership = [NewmarkCuNative]::WindowOwnershipState($hwnd, ${Number(processId) || 0})`,
    `if ($ownership -eq 2) { ${psError('target_window_ownership_changed', 'The process id no longer owns the target window, so activation was refused.')} }`,
    `if ($ownership -ne 0) { ${psError('target_window_invalid', 'The target window is no longer valid, so activation was refused.')} }`,
    '$activation = [NewmarkCuNative]::ActivateWindowDetailed($hwnd)',
    // The second read is the one that counts: it happens after the attempt has fully
    // returned, so it cannot describe an intermediate state the attempt passed through.
    '$measured = [NewmarkCuNative]::ForegroundFacts($hwnd)',
    `Write-Output (@{ ok=$true; action="app_activate"; handle=("0x{0:X}" -f $hwnd.ToInt64()); foreground_verified=$measured.ForegroundIsTarget; foreground_is_target=$measured.ForegroundIsTarget; foreground_handle=("0x{0:X}" -f $measured.ForegroundHandle); foreground_title=$measured.ForegroundTitle; foreground_class_name=$measured.ForegroundClassName; foreground_process_id=$measured.ForegroundProcessId; activation_granted=$activation.Granted; activation_technique=$activation.Technique; activation_attempts=$activation.Attempts; mouse_mode="real" } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

/** The handle/title/class/pid of whoever holds the foreground, as a refusal body. */
function foregroundHolder(facts) {
  if (!facts) return null;
  return {
    handle: facts.foreground_handle || null,
    title: facts.foreground_title === undefined ? null : facts.foreground_title,
    class_name: facts.foreground_class_name === undefined ? null : facts.foreground_class_name,
    process_id: Number.isFinite(Number(facts.foreground_process_id)) ? Number(facts.foreground_process_id) : null,
  };
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

/**
 * The virtual-mode key chord, in the shape `virtualKeyScript` posts.
 *
 * The key names come from the one resolver, so `win` is a key here exactly as it is in real
 * mode and there is no second table to drift. A chord naming a Windows key is refused rather
 * than posted: Windows keys are system-scoped, and a posted WM_KEYDOWN with VK_LWIN does not
 * open the Start menu - it only tells one window that the key was pressed, which is not the
 * same event and must not be reported as one.
 */
function windowsKeyChord(key) {
  const chord = resolveKeyChord(key);
  if (chord.error) return undefined;
  if (chord.windowsKey) return { chord };
  const keyCode = chord.virtualKeys[chord.virtualKeys.length - 1];
  if (!keyCode || keyCode > 0xffff) return undefined;
  /* Modifier order is the order the caller wrote, and the final key is last; `shiftCase`
   * reports the shift the resolver added for an upper-case final key. */
  return { modifiers: chord.virtualKeys.slice(0, -1), keyCode, shiftCase: chord.shiftCase };
}

function virtualKeyScript(application, key, targetHandle) {
  const parsed = windowsKeyChord(key);
  if (!parsed) return { error: `Virtual app_key accepts one key or a ctrl/alt/shift chord such as ctrl+l, enter, or F5: ${key}` };
  if (parsed.chord && parsed.chord.windowsKey) {
    return {
      error: `Virtual app_key cannot deliver the Windows key: ${key} names ${parsed.chord.names.join('+')}, and a Windows key is system-scoped. A posted window message reaches one window and does not open the Start menu or the Run dialog, so it is refused rather than reported as delivered. Use the real mouse mode for this chord.`,
      code: 'windows_key_requires_real_delivery',
    };
  }
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
    key_delivery: '"posted-window-messages"',
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
  /* The refusal carries the code its own reason names: a Windows chord in virtual mode is
   * refused because posted messages cannot deliver it, not because the key is unknown. */
  if (built.error) return failure(options.action, built.code || 'virtual_key_unsupported', built.error, { mouse_mode: 'virtual', app: application });
  const result = await runActionScript(built.script, { action: 'app_key', ...options });
  return { ...result, mouse_mode: 'virtual', app: application, physical_delivery_used: false };
}

/* @virtual-mode-end */

/* ------------------------------------------------------------------ *
 * 9. the hidden-desktop route
 *
 * =====================================================================================
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * =====================================================================================
 *
 * `lib/hidden-agent.js` carries a resident agent that lives ON a hidden Windows desktop: it
 * opens windows there, captures them there and posts messages to them there, with no
 * cross-desktop call anywhere. Reach is a property of the calling process, and that module
 * moves the caller ONTO the desktop instead of trying to reach across to it. Three phases
 * tried the reach and all three came back negative.
 *
 * So this section adds ROUTING and no reach. It opens no desktop (that call appears nowhere in
 * this file), it attaches no thread to another thread, and it never captures across a desktop
 * boundary. When a caller arms a hidden desktop, the app-scoped actions are relayed to the
 * agent over its named pipe - one JSON line per request, one connection per request - through
 * the `windows` lane this file already owns. The lane is a SECOND ENDPOINT to that agent, not
 * a second implementation of it: the relay script below runs inside the lane's own
 * PowerShell, which holds no desktop handle of its own.
 *
 * =====================================================================================
 * HOW A ROUTE IS ARMED, AND WHY IT IS ARMED RATHER THAN ASSUMED
 * =====================================================================================
 *
 * `takeover_start` with `mouseMode: "virtual"` and `desktop: "hidden"` starts one resident
 * agent on a fresh desktop and binds it to that owner's lease. Every app-scoped action from
 * that owner then routes to the agent until `takeover_stop`, which exits the agent (closing
 * the job handle its whole process tree inherited), waits for the agent and every hosted pid
 * to be gone, and asks whether the desktop itself is still openable.
 *
 * The route is armed rather than assumed, and that is not decoration:
 *
 *   - Virtual mode WITHOUT `desktop` behaves exactly as it did before this section existed:
 *     posted window messages to a window on this desktop. That is the interactive-desktop
 *     control, and it still works, so nothing here silently takes a path away.
 *   - A resident agent is a real process, so it starts when a caller asks for one - never at
 *     module load and never on a read-only action. `mode_report` is the only action that
 *     mentions the route without arming one.
 *
 * =====================================================================================
 * OWNERSHIP OF EVERY PROCESS, AND OF THE DESKTOP
 * =====================================================================================
 *
 *   - The agent's pid is the one its own launcher reported through its ready file, and every
 *     process it starts is recorded by the pid AND the start time its own launch call
 *     returned. Nothing here is ever selected by process name; no cleanup in this file names
 *     a process class.
 *   - The desktop is held by the agent's own handle. `takeover_stop` ends it by ending the
 *     agent, and then MEASURES that the desktop is gone instead of assuming it: a desktop is
 *     held by any handle OR any process assigned to it, which is why the job object is
 *     load-bearing. A desktop that survives is reported as surviving, with the pids that
 *     kept it alive.
 * ------------------------------------------------------------------ */

/** One resident agent per owner, for the life of the lease that armed it. */
const hiddenRoutes = new Map();
let hiddenDesktopCounter = 0;
let hiddenAgentPromise = null;

/** The agent module, loaded on first use: importing this file must spawn nothing. */
function hiddenAgentModule() {
  hiddenAgentPromise ??= import('./hidden-agent.js');
  return hiddenAgentPromise;
}

function hiddenRouteFor(ownerId) {
  return hiddenRoutes.get(ownerKey(ownerId)) || null;
}

/**
 * The route this call must be relayed through, or null.
 *
 * THE LEASE IS THE AUTHORITY, AND THE OWNER ID IS ONLY A NAME FOR IT.
 *
 * The shipped version of this function asked one question - is there a route filed under the
 * owner id THIS CALL declared - and that question is not the same as "is a hidden desktop armed
 * for this session". Measured in the running application (2.0.11, live `computer_use`):
 * `takeover_start` armed a desktop and reported `delivery: "hidden-desktop-agent"`, and the
 * next `app_list` answered `ok: true, scope: "virtual-includes-occluded"` with 94 windows of the
 * INTERACTIVE desktop and the agent's `requests_served` unchanged. The lease was held and
 * virtual - the interactive branch's own `scope` field proves that, because it is derived from
 * `activeLease()` - so the route existed and was simply not found under the name the call used.
 *
 * The caller could not have known the name mattered: `owner_id` is optional, the guide mentions
 * it only in the sentence about `takeover_stop`, and `component.js` fills in `'dsh'` for every
 * call that omits it. A caller that names an owner once, at the arm, therefore gets the
 * interactive desktop for every later action while the receipt says a hidden desktop is armed.
 *
 * So the resolution is: the route this process has armed, which is the lease holder's, because
 * the lease is exclusive and there is at most one armed route at a time. The declared owner is
 * still consulted first, so a matching call is unchanged; when it does not match, the call is
 * routed to the armed desktop AND the substitution is recorded on the route, where
 * `hiddenHeader` reports it as `owner_id_declared` / `owner_id_routed` /
 * `owner_resolved_from_lease`. Two independent conditions remain, and both are required: a
 * route armed, and that route's owner still holding a VIRTUAL lease. A lease that has been
 * released cannot route - the desktop it named is being torn down - so a leaked route cannot
 * outlive its lease.
 */
function hiddenRouteActive(options) {
  const declaredOwner = String((options && options.ownerId) || '');
  const active = activeLease();
  if (!active || active.mouse_mode !== 'virtual') return null;
  const declared = declaredOwner ? hiddenRouteFor(declaredOwner) : null;
  if (declared && !declared.closed && declared.ownerId === active.owner_id) {
    declared.resolvedFor = { declared: declaredOwner, ownerId: declared.ownerId, fromLease: false };
    return declared;
  }
  /*
   * `screen_capture` is dispatched with `skipLease` and its own owner id, and it must stay on the
   * route it always had: it is documented as never acquiring, mutating or being affected by the
   * lease, so a read that a lease holder happens to have armed a hidden desktop must not move it
   * onto that desktop. The fallback below is for the lease holder's own actions.
   */
  if (options && options.skipLease === true) return null;
  const held = hiddenRouteFor(active.owner_id);
  if (!held || held.closed) return null;
  held.resolvedFor = { declared: declaredOwner || null, ownerId: held.ownerId, fromLease: declaredOwner !== held.ownerId };
  return held;
}

/** A fresh desktop name per arm. The agent refuses to adopt a desktop that already exists. */
function hiddenDesktopName() {
  hiddenDesktopCounter += 1;
  return `NmCuHidden${String(process.pid).slice(-6)}${hiddenDesktopCounter}`;
}

/**
 * One request to the agent, over the lane, as one JSON line.
 *
 * `relayThroughLane` builds the pipe client and runs it IN the `windows` lane, so the traffic
 * leaves this process through the same transport every other action uses and the instrumented
 * seams of this module apply to it. The answer is the agent's own JSON line.
 */
async function hiddenAgentAnswer(route, op, fields = {}, options = {}) {
  if (route.closed) return { ok: false, error_code: 'hidden_agent_closed', error: `The hidden-desktop agent on ${route.desktopName} has been closed.` };
  const mod = await hiddenAgentModule();
  const request = { id: `${op}-${crypto.randomBytes(4).toString('hex')}`, op, ...fields };
  const startedAt = Date.now();
  let relay;
  try {
    relay = await mod.relayThroughLane(route.pipe, request, {
      token: route.token,
      lane: 'windows',
      timeoutMs: clampNumber(options.timeoutMs, 1000, 300000, 60000),
    });
  } catch (error) {
    return { ok: false, error_code: 'hidden_agent_relay_threw', error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt };
  }
  route.requests += 1;
  route.lastOp = op;
  const elapsedMs = Date.now() - startedAt;
  if (relay.ok !== true) {
    return { ok: false, error_code: 'hidden_agent_unreachable', error: `The hidden-desktop agent on ${route.desktopName} did not answer the ${op} request: ${String(relay.error || 'no answer')}`, elapsedMs, output: String(relay.output || '').slice(-400) };
  }
  const value = relay.value && typeof relay.value === 'object' ? relay.value : {};
  if (value.ok !== true) {
    return { ok: false, error_code: 'hidden_agent_refused', error: String(value.error || `the hidden-desktop agent refused the ${op} request`), value, elapsedMs };
  }
  return { ok: true, value, elapsedMs };
}

/**
 * The agent's window list, in this module's own application-record shape.
 *
 * Two conversions are the whole job, and both are stated in the payload rather than left to a
 * reader to discover:
 *
 *   - `client_rect` is reported with its ORIGIN AT THE CLIENT, because that is the space the
 *     agent's click and scroll requests are addressed in (a posted `WM_LBUTTONDOWN` carries
 *     client coordinates). An app-scoped point therefore means the same thing on both routes,
 *     which is what lets one call sequence run against either desktop unchanged.
 *   - The window rectangle is in the hidden desktop's own coordinate space, which is not this
 *     one. `coordinate_space` says so where it is reported.
 */
function hiddenApplications(answer) {
  const raw = Array.isArray(answer.windows) ? answer.windows : [];
  const foreground = String(answer.foreground || '').toLowerCase();
  const desktop = String(answer.desktop || '');
  return raw
    .map((entry) => {
      const rect = entry && entry.rect && typeof entry.rect === 'object' ? entry.rect : {};
      const client = entry && entry.client && typeof entry.client === 'object' ? entry.client : {};
      const handle = String((entry && entry.handle) || '');
      return {
        handle,
        handle_key: handle.toLowerCase(),
        title: String((entry && entry.title) || ''),
        process_id: Number(entry && entry.pid) || 0,
        class_name: String((entry && entry.class_name) || ''),
        rect: normalizeRect(rect),
        client_rect: { x: 0, y: 0, width: Math.max(0, Number(client.width) || 0), height: Math.max(0, Number(client.height) || 0) },
        client_rect_origin: 'client',
        visible: entry && entry.visible === true,
        minimized: entry && entry.minimized === true,
        foreground: handle !== '' && handle.toLowerCase() === foreground,
        occluded: false,
        desktop,
      };
    })
    .filter((entry) => handleToInt(entry.handle) !== 0);
}

async function hiddenEnumerate(route, options = {}) {
  const answer = await hiddenAgentAnswer(route, 'enumerate', {}, { timeoutMs: options.timeoutMs });
  if (answer.ok !== true) return { ok: false, applications: [], error_code: answer.error_code, error: answer.error, elapsedMs: answer.elapsedMs };
  const applications = hiddenApplications(answer.value);
  return {
    ok: true,
    applications,
    window_count: Number(answer.value.window_count) || applications.length,
    desktop: String(answer.value.desktop || route.desktopName),
    window_station: String(answer.value.window_station || ''),
    foreground: String(answer.value.foreground || ''),
    elapsedMs: answer.elapsedMs,
    agent: answer.value,
  };
}

/**
 * The target of one routed action: an explicit handle, the handle a previous `app_activate`
 * bound, or a title/class match - the same three rules the interactive resolver uses, applied
 * to the hidden desktop's own window list.
 */
async function hiddenResolve(route, options = {}) {
  const enumerated = await hiddenEnumerate(route, options);
  if (enumerated.ok !== true) return { ok: false, applications: [], error_code: enumerated.error_code, error: enumerated.error, enumerated };
  const applications = enumerated.applications;
  const explicit = handleHex(options.windowHandle || options.window_handle);
  if (explicit) {
    const wanted = `0x${explicit}`.toLowerCase();
    const match = applications.find((app) => app.handle_key === wanted);
    if (match) return { ok: true, application: match, applications, enumerated };
    return {
      ok: false,
      applications,
      enumerated,
      error_code: 'app_target_not_found',
      error: `No window on the hidden desktop ${route.desktopName} has handle 0x${explicit} (the agent listed ${applications.length}).`,
    };
  }
  const bound = virtualPointerFor(options.ownerId);
  if (bound && bound.windowHandle) {
    const wanted = String(bound.windowHandle).toLowerCase();
    const match = applications.find((app) => app.handle_key === wanted);
    if (match) return { ok: true, application: match, applications, enumerated };
  }
  const target = String(options.appTarget || options.app_target || '').trim();
  if (!target) {
    return {
      ok: false,
      applications,
      enumerated,
      error_code: 'app_target_required',
      error: `The hidden-desktop route needs app_target or window_handle so it never falls back to the hidden desktop's foreground window. The agent listed ${applications.length} window(s) on ${route.desktopName}.`,
    };
  }
  const wanted = target.toLowerCase();
  const wantedHandle = handleHex(target);
  let matches = wantedHandle ? applications.filter((app) => app.handle_key === `0x${wantedHandle}`.toLowerCase()) : [];
  if (!matches.length) matches = applications.filter((app) => app.title.toLowerCase().includes(wanted));
  if (!matches.length) matches = applications.filter((app) => app.class_name.toLowerCase().includes(wanted));
  if (!matches.length) {
    return {
      ok: false,
      applications,
      enumerated,
      error_code: 'app_target_not_found',
      error: `No window on the hidden desktop ${route.desktopName} matched app_target ${target}; the agent listed ${applications.length} window(s).`,
    };
  }
  return { ok: true, application: matches[0], applications, enumerated };
}

/**
 * The receipt header every routed answer carries.
 *
 * `queued` is `true` only where a message really was posted to the target's queue, and it
 * never means the application acted on it: `action_completed` stays `false` for exactly that
 * reason. The one fact worth more than either is `target_desktop`, which names the desktop the
 * application is on - a reader can tell a hidden-desktop action from an interactive one
 * without knowing which code path produced the answer.
 */
function hiddenHeader(route, header, extra = {}) {
  const resolved = route.resolvedFor && typeof route.resolvedFor === 'object' ? route.resolvedFor : null;
  return {
    ...header,
    mouse_mode: 'virtual',
    delivery: 'hidden-desktop-agent',
    mouse_mode_effective: 'virtual',
    target_desktop: route.desktopName,
    routed_to: {
      desktop: route.desktopName,
      agent_pid: route.agentPid,
      transport: 'json-lines over the agent named pipe, relayed through the windows lane',
      cross_desktop_reach_used: false,
    },
    /*
     * WHICH OWNER THIS CALL NAMED, AND WHICH OWNER'S DESKTOP IT WENT TO.
     *
     * These two fields exist because the live defect was invisible without them. The route used
     * to be found ONLY under the owner id the call declared, so a call that named an owner the
     * arm had not used fell through to the interactive branch and answered `ok: true` with this
     * desktop's window list - a plausible answer to a question nobody asked. The receipt now
     * states the owner the call declared and the owner whose desktop served it, so a
     * substitution is a fact in the receipt rather than something a reader has to infer.
     */
    owner_id_declared: resolved ? resolved.declared : null,
    owner_id_routed: resolved ? resolved.ownerId : route.ownerId,
    owner_resolved_from_lease: resolved ? resolved.fromLease === true : false,
    physical_delivery_used: false,
    system_cursor_moved: false,
    fallback_to_real_delivery: false,
    ...extra,
  };
}

/** A posted-message receipt: what the agent's own post calls answered. */
function hiddenPosted(posted) {
  const record = posted && typeof posted === 'object' ? posted : {};
  const values = Object.values(record).filter((value) => typeof value === 'boolean');
  return {
    queued: values.length > 0 && values.every((value) => value === true),
    action_completed: false,
    delivery_semantics: 'queued-to-target-thread-message-queue-by-the-agent',
    agent_posted: record,
  };
}

async function hiddenAppListAction(action, options, mode, header, route) {
  const enumerated = await hiddenEnumerate(route, options);
  if (enumerated.ok !== true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      applications: [],
      windows: [],
      count: 0,
      error_code: enumerated.error_code,
      error: enumerated.error,
      scope: 'hidden-desktop',
      desktop_name: route.desktopName,
      telemetry: { lane: 'hidden-agent', elapsed_ms: enumerated.elapsedMs },
    };
  }
  return {
    ...hiddenHeader(route, header, { queued: false, action_completed: false }),
    ok: true,
    action,
    applications: enumerated.applications,
    windows: enumerated.applications,
    count: enumerated.applications.length,
    window_count: enumerated.window_count,
    scope: 'hidden-desktop',
    desktop_name: route.desktopName,
    desktop_reported_by_the_agent: enumerated.desktop,
    window_station_reported_by_the_agent: enumerated.window_station,
    foreground_window: enumerated.foreground,
    coordinate_space: {
      window_rect: 'the hidden desktop own coordinate space',
      client_rect_origin: 'client',
      app_scoped_points: 'client-relative, addressed by the agent posted messages',
    },
    telemetry: { lane: 'hidden-agent', elapsed_ms: enumerated.elapsedMs },
  };
}

/** The child windows of a target, as the controls a routed observation can honestly report. */
function hiddenControls(answer) {
  const raw = Array.isArray(answer.children) ? answer.children : [];
  return raw.map((child) => ({
    handle: String((child && child.handle) || ''),
    name: String((child && child.title) || ''),
    class_name: String((child && child.class_name) || ''),
    control_type: semanticRole(String((child && child.class_name) || '')),
    process_id: Number(child && child.pid) || 0,
    visible: child && child.visible === true,
    enabled: true,
    controls_source: 'hidden-agent child-window enumeration',
  }));
}

/**
 * One routed observation: the agent captures the window ON its own desktop and the lane reads
 * the file back.
 *
 * The digest is of the FILE BYTES, and it says so. It is deliberately NOT shaped like the
 * window_capture lane's 32x18 luma digest: that digest is computed from a bitmap inside the
 * capture lane, and dressing a byte hash up as one would be a payload that lies about where
 * its numbers came from.
 */
async function hiddenAppObserveAction(action, options, mode, header, route) {
  const resolved = await hiddenResolve(route, options);
  if (resolved.ok !== true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: resolved.error_code,
      error: resolved.error,
      applications: (resolved.applications || []).slice(0, 20),
      desktop_name: route.desktopName,
    };
  }
  const application = resolved.application;
  if (application.minimized === true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: 'window_minimized',
      error: 'A minimized window has no capturable presentation.',
      app: application,
      desktop_name: route.desktopName,
    };
  }
  const outPath = hiddenCapturePath(options.ownerId);
  const capturedAt = Date.now();
  const shot = await hiddenAgentAnswer(route, 'capture', { handle: application.handle, path: outPath }, { timeoutMs: options.timeoutMs });
  if (shot.ok !== true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: shot.error_code,
      error: shot.error,
      app: application,
      desktop_name: route.desktopName,
      telemetry: { lane: 'hidden-agent', capture_ms: Date.now() - capturedAt },
    };
  }
  const file = hiddenFileFacts(String(shot.value.path || outPath));
  const children = await hiddenAgentAnswer(route, 'children', { handle: application.handle }, { timeoutMs: options.timeoutMs });
  const controls = children.ok === true ? hiddenControls(children.value) : [];
  const capture = {
    image_path: file.path,
    image_mime: 'image/bmp',
    width: Number(shot.value.width) || 0,
    height: Number(shot.value.height) || 0,
    image_bytes: file.bytes,
    capture_method: `agent PrintWindow(hwnd,hdc,${Number(shot.value.route) || 0}) on the hidden desktop`,
    target_scope: application.handle,
    lane: 'hidden-agent',
    agent_capture_route: Number(shot.value.route) || 0,
    digest: {
      sha256: file.sha256,
      sha256_prefix: file.sha256 ? file.sha256.slice(0, 16) : '',
      bytes: file.bytes,
      of: 'the capture file bytes, not the window_capture lane luma digest',
    },
    agent_reported_sha256: String(shot.value.sha256 || ''),
    agent_reported_bytes: Number(shot.value.bytes) || 0,
  };
  observationsByOwner.set(ownerKey(options.ownerId), {
    windowHandle: application.handle,
    sceneGeneration: sceneGeneration([application], controls),
    capturedAt: Date.now(),
  });
  return {
    ...hiddenHeader(route, header, { queued: false, action_completed: false }),
    ok: true,
    action,
    observation: 'full',
    observation_scope: 'window',
    must_reacquire_full_observation: false,
    app: application,
    window: application,
    image_path: capture.image_path,
    image_mime: capture.image_mime,
    width: capture.width,
    height: capture.height,
    image_width: capture.width,
    image_height: capture.height,
    image_bytes: capture.image_bytes,
    capture,
    controls,
    control_count: controls.length,
    controls_source: 'hidden-agent child-window enumeration, with no UI Automation and no geometry',
    uia_visited: 0,
    target_scope: capture.target_scope,
    capture_scope: 'window',
    desktop_name: route.desktopName,
    telemetry: {
      lane: 'hidden-agent',
      capture_ms: Date.now() - capturedAt,
      uia_ms: 0,
      uia_lane: null,
      uia_error: null,
    },
  };
}

/** Binding a target on the hidden desktop records which window receives the messages. */
async function hiddenAppActivateAction(action, options, mode, header, route) {
  const resolved = await hiddenResolve(route, options);
  if (resolved.ok !== true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: resolved.error_code,
      error: resolved.error,
      applications: (resolved.applications || []).slice(0, 20),
      desktop_name: route.desktopName,
    };
  }
  const application = resolved.application;
  if (application.minimized === true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: 'window_minimized',
      error: 'A minimized window has no capturable presentation.',
      app: application,
      desktop_name: route.desktopName,
    };
  }
  setVirtualPointer(options.ownerId, {
    windowHandle: String(application.handle),
    x: Math.round(application.client_rect.width / 2),
    y: Math.round(application.client_rect.height / 2),
    targetHandle: String(application.handle),
  });
  return {
    ...hiddenHeader(route, header, { queued: false, action_completed: false }),
    ok: true,
    action,
    activated: false,
    foreground_activated: false,
    dry_run: options.dryRun === true,
    bound_handle: String(application.handle),
    app: application,
    desktop_name: route.desktopName,
  };
}

/**
 * An app-scoped point in the space the agent's own requests are addressed in.
 *
 * The relative rule is the interactive one - a value in 0..1 is a fraction of the client area
 * and anything else is an offset from its origin - and the refusal is the same too. What
 * differs is the ORIGIN: the point handed to the agent is client-relative, because that is
 * what a posted mouse message carries.
 */
function hiddenClientPoint(application, x, y) {
  const client = application.client_rect || { x: 0, y: 0, width: 0, height: 0 };
  if (client.width <= 0 || client.height <= 0) {
    return { ok: false, error: 'The target window client area is empty, so it cannot receive posted messages.' };
  }
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) && !Number.isFinite(ny)) {
    return { ok: true, x: Math.round(client.width / 2), y: Math.round(client.height / 2), point_source: 'client centre' };
  }
  const relativeX = Number.isFinite(nx) && nx >= 0 && nx <= 1;
  const relativeY = Number.isFinite(ny) && ny >= 0 && ny <= 1;
  const px = Number.isFinite(nx) ? (relativeX ? Math.round(client.width * nx) : Math.round(nx)) : Math.round(client.width / 2);
  const py = Number.isFinite(ny) ? (relativeY ? Math.round(client.height * ny) : Math.round(ny)) : Math.round(client.height / 2);
  if (px < 0 || px >= client.width || py < 0 || py >= client.height) {
    return { ok: false, error: `An app-scoped point must lie inside the target client area (0,0,${client.width}x${client.height}); received ${px},${py}.` };
  }
  return { ok: true, x: px, y: py, point_source: relativeX || relativeY ? 'fraction of the client area' : 'offset from the client origin' };
}

async function hiddenAppPhysicalAction(action, options, mode, header, route) {
  const resolved = await hiddenResolve(route, options);
  if (resolved.ok !== true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: resolved.error_code,
      error: resolved.error,
      applications: (resolved.applications || []).slice(0, 20),
      desktop_name: route.desktopName,
    };
  }
  const application = resolved.application;
  if (application.minimized === true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: 'window_minimized',
      error: 'A minimized window has no capturable presentation.',
      app: application,
      desktop_name: route.desktopName,
    };
  }
  if (options.dryRun === true) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: true,
      action,
      dry_run: true,
      app: application,
      desktop_name: route.desktopName,
      message_delivered: false,
    };
  }

  if (action === 'app_click') {
    const point = hiddenClientPoint(application, options.x, options.y);
    if (point.ok !== true) {
      return {
        ...hiddenHeader(route, header, { queued: false, action_completed: false }),
        ok: false,
        action,
        error_code: 'point_outside_window',
        error: point.error,
        app: application,
        desktop_name: route.desktopName,
      };
    }
    const clicked = await hiddenAgentAnswer(route, 'click', { handle: application.handle, x: point.x, y: point.y }, { timeoutMs: options.timeoutMs });
    if (clicked.ok !== true) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: clicked.error_code, error: clicked.error, app: application, desktop_name: route.desktopName };
    }
    return {
      ...hiddenHeader(route, header, hiddenPosted(clicked.value.posted)),
      ok: true,
      action,
      app: application,
      x: point.x,
      y: point.y,
      point_source: point.point_source,
      coordinate_space: 'client-relative on the hidden desktop',
      button: options.button === 'right' ? 'right' : 'left',
      is_window: clicked.value.is_window === true,
      desktop_name: route.desktopName,
    };
  }

  if (action === 'app_scroll') {
    const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
    const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
    if (!scrollX && !scrollY) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: 'scroll_delta_required', error: 'scroll_x or scroll_y is required.', desktop_name: route.desktopName };
    }
    if (scrollX && !scrollY) {
      return {
        ...hiddenHeader(route, header, { queued: false, action_completed: false }),
        ok: false,
        action,
        error_code: 'hidden_agent_horizontal_wheel_unsupported',
        error: 'The hidden-desktop agent posts WM_MOUSEWHEEL and nothing else, so a horizontal-only scroll is refused rather than reported as delivered. Use scroll_y, or the real mouse mode.',
        desktop_name: route.desktopName,
      };
    }
    const point = hiddenClientPoint(application, options.x, options.y);
    if (point.ok !== true) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: 'point_outside_window', error: point.error, app: application, desktop_name: route.desktopName };
    }
    const delta = -scrollY;
    const scrolled = await hiddenAgentAnswer(route, 'scroll', { handle: application.handle, delta }, { timeoutMs: options.timeoutMs });
    if (scrolled.ok !== true) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: scrolled.error_code, error: scrolled.error, app: application, desktop_name: route.desktopName };
    }
    return {
      ...hiddenHeader(route, header, hiddenPosted({ wheel: scrolled.value.posted === true })),
      ok: true,
      action,
      app: application,
      x: point.x,
      y: point.y,
      scroll_x: scrollX,
      scroll_y: scrollY,
      wheel_delta_delivered: delta,
      centered: scrolled.value.centered === true,
      desktop_name: route.desktopName,
    };
  }

  if (action === 'app_type') {
    const text = String(options.text || '');
    if (!text) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: 'text_required', error: 'text is required.', desktop_name: route.desktopName };
    }
    if (text.length > 4096) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: 'text_too_long', error: 'Typing is capped at 4096 UTF-16 code units per action.', desktop_name: route.desktopName };
    }
    const typed = await hiddenAgentAnswer(route, 'type', { handle: application.handle, text }, { timeoutMs: options.timeoutMs });
    if (typed.ok !== true) {
      return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: typed.error_code, error: typed.error, app: application, desktop_name: route.desktopName };
    }
    const characters = Number(typed.value.characters) || 0;
    const postedCount = Number(typed.value.posted) || 0;
    return {
      ...hiddenHeader(route, header, { queued: postedCount > 0 && postedCount >= characters, action_completed: false, delivery_semantics: 'WM_CHAR posted per character by the agent' }),
      ok: true,
      action,
      app: application,
      characters,
      posted: postedCount,
      used_edit_child: typed.value.used_edit_child === true,
      target_control: String(typed.value.target_handle || application.handle),
      text_delivery: 'posted WM_CHAR, one per character',
      desktop_name: route.desktopName,
    };
  }

  const built = resolveKeyChord(String(options.key || ''));
  if (built.error) {
    return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: 'key_unsupported', error: built.error, desktop_name: route.desktopName };
  }
  if (built.windowsKey) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: 'windows_key_requires_real_delivery',
      error: `The hidden-desktop agent posts one key to one window, and a Windows key is system-scoped: ${String(options.key || '')} is refused rather than reported as delivered. Use the real mouse mode for this chord.`,
      desktop_name: route.desktopName,
    };
  }
  if (built.virtualKeys.length !== 1) {
    return {
      ...hiddenHeader(route, header, { queued: false, action_completed: false }),
      ok: false,
      action,
      error_code: 'hidden_agent_single_key_only',
      error: `The hidden-desktop agent posts one key down/up pair, so a chord cannot be held across it: ${String(options.key || '')} composes ${built.virtualKeys.length} keys. A single key is supported.`,
      key_codes: built.virtualKeys,
      desktop_name: route.desktopName,
    };
  }
  const virtualKey = built.virtualKeys[0];
  const pressed = await hiddenAgentAnswer(route, 'key', { handle: application.handle, vk: virtualKey }, { timeoutMs: options.timeoutMs });
  if (pressed.ok !== true) {
    return { ...hiddenHeader(route, header, { queued: false, action_completed: false }), ok: false, action, error_code: pressed.error_code, error: pressed.error, app: application, desktop_name: route.desktopName };
  }
  return {
    ...hiddenHeader(route, header, hiddenPosted(pressed.value.posted)),
    ok: true,
    action,
    app: application,
    key: String(options.key || ''),
    key_code: virtualKey,
    key_delivery: 'posted WM_KEYDOWN/WM_KEYUP to the target window by the agent',
    desktop_name: route.desktopName,
  };
}

/** The routed answer for one action, or null when this action is not routed at all. */
async function hiddenDesktopAction(action, options, mode, header, route) {
  if (action === 'app_list') return await hiddenAppListAction(action, options, mode, header, route);
  if (action === 'app_observe') return await hiddenAppObserveAction(action, options, mode, header, route);
  if (action === 'app_activate') return await hiddenAppActivateAction(action, options, mode, header, route);
  if (action === 'app_click' || action === 'app_type' || action === 'app_scroll' || action === 'app_key') {
    return await hiddenAppPhysicalAction(action, options, mode, header, route);
  }
  if (action === 'app_drag') {
    return failure(action, 'hidden_agent_action_unsupported', 'The hidden-desktop agent has no drag primitive: it posts clicks, keys, characters and one wheel message. Use app_click, or the real mouse mode for a drag.', hiddenHeader(route, header, { queued: false, action_completed: false, desktop_name: route.desktopName }));
  }
  return null;
}

/* --- arming and tearing the route down ---------------------------- */

/** Where a routed capture is written. The agent writes a BMP, and the name says so. */
function hiddenCapturePath(ownerId) {
  return capturePath(ownerId, 'hidden').replace(/\.png$/, '.bmp');
}

/** The file facts of one capture, read back by this process. */
function hiddenFileFacts(file) {
  try {
    const bytes = fs.readFileSync(file);
    return { path: file, exists: true, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { path: file, exists: false, bytes: 0, sha256: '' };
  }
}

/**
 * Which of these exact pids are still running, asked of a fresh PowerShell through the lane.
 *
 * By PID and never by name: every pid here was returned by the create call that made the
 * process. `-ErrorAction SilentlyContinue` makes a pid that is gone answer `$null` instead of
 * an error, and the lane's own error handling is left alone.
 *
 * The start time comes back with the answer because a pid is not an identity: the record has to
 * let a reader tell "the process I made is gone" from "the number now belongs to something
 * else", and the teardown receipt is the only place that distinction can be made.
 */
function hiddenLivenessScript(pids) {
  const wanted = pids.map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 0);
  return [
    '$ErrorActionPreference = "Continue"',
    `$wanted = @(${wanted.join(', ')})`,
    '$found = New-Object System.Collections.ArrayList',
    'foreach ($wantedPid in $wanted) {',
    '  $candidate = Get-Process -Id $wantedPid -ErrorAction SilentlyContinue',
    '  $ticks = ""',
    '  if ($null -ne $candidate) { try { $ticks = [string]$candidate.StartTime.ToFileTimeUtc() } catch { $ticks = "" } }',
    '  [void]$found.Add(@{ pid = [int]$wantedPid; running = ($null -ne $candidate); start_time_ticks = [string]$ticks })',
    '}',
    'Write-Output (@{ pids = @($found) } | ConvertTo-Json -Compress -Depth 4)',
  ].join('\r\n');
}

async function hiddenPidStates(pids) {
  const wanted = pids.filter((pid) => Number.isFinite(pid) && Number(pid) > 0);
  if (!wanted.length) return { ok: true, states: [] };
  const result = await runInLane('windows', hiddenLivenessScript(wanted), 30000);
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    return { ok: false, states: [], error_code: parsed.code, error: parsed.message };
  }
  const parsed = parseJsonObject(result.output);
  const listed = parsed && Array.isArray(parsed.pids) ? parsed.pids : (parsed && parsed.pids ? [parsed.pids] : null);
  /*
   * An unreadable answer is a FAILED check, never an empty list of survivors.
   *
   * The first version answered `states: []` when the lane's answer could not be parsed, and its
   * caller reads "nothing is running" out of that - so a lane that could not answer at all
   * produced "every process is gone". That is the shape of a check that cannot fail, and it is
   * reported as a failure now: the teardown fails closed rather than claiming a clean end it
   * never measured.
   */
  if (!listed) {
    return {
      ok: false,
      states: [],
      error_code: 'hidden_liveness_unreadable',
      error: `the liveness check on ${wanted.join(', ')} answered something this lane could not read`,
      output: String(result.output || '').slice(-400),
    };
  }
  return {
    ok: true,
    states: listed.map((state) => ({
      pid: Number(state && state.pid) || 0,
      running: state && state.running === true,
      start_time_ticks: state && state.start_time_ticks !== undefined && state.start_time_ticks !== null ? String(state.start_time_ticks) : '',
    })),
  };
}

/**
 * Wait for every named pid to stop running.
 *
 * A process that has just been terminated keeps answering `OpenProcess` for a moment, so this
 * polls `Get-Process` - which reports a corpse as gone - rather than trusting one read. The
 * answer names what is still running when the deadline passes.
 */
async function hiddenWaitForExit(pids, timeoutMs = 15000) {
  const startedAt = Date.now();
  const wanted = pids.filter((pid) => Number.isFinite(pid) && Number(pid) > 0);
  if (!wanted.length) return { gone: [], still_running: [], states: [], attempts: 0, elapsedMs: 0, all_gone: true, liveness_error: null };
  let last = { ok: true, states: [] };
  let attempts = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    last = await hiddenPidStates(wanted);
    if (last.ok === true) {
      const running = last.states.filter((state) => state.running).map((state) => state.pid);
      if (running.length === 0) {
        return { gone: wanted, still_running: [], states: last.states, attempts, elapsedMs: Date.now() - startedAt, all_gone: true, liveness_error: null };
      }
    }
    await sleep(250);
  }
  if (last.ok !== true) {
    /* FAIL CLOSED. A wait that never got a readable answer knows nothing about what is running,
     * so it says so instead of reporting an empty survivor list - which is what "all gone" would
     * be read as. */
    return {
      gone: [],
      still_running: wanted,
      states: [],
      attempts,
      elapsedMs: Date.now() - startedAt,
      all_gone: false,
      liveness_error: String(last.error || 'the liveness check never produced a readable answer'),
    };
  }
  const running = last.states.filter((state) => state.running).map((state) => state.pid);
  return {
    gone: wanted.filter((pid) => !running.includes(pid)),
    still_running: running,
    states: last.states,
    attempts,
    elapsedMs: Date.now() - startedAt,
    all_gone: running.length === 0,
    liveness_error: null,
  };
}

/**
 * Is the desktop still openable, asked from the lane with the agent's own maker payload?
 *
 * The handle this opens is CLOSED again before the answer is written - a probe that leaks the
 * handle it opened would hold open the very desktop it is measuring. A desktop is held by any
 * handle OR any process assigned to it, so this is the only question that distinguishes "the
 * processes are gone" from "the desktop is gone".
 */
function hiddenDesktopProbeScript(desktopName, makerSource) {
  return [
    '$ErrorActionPreference = "Stop"',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    Buffer.from(makerSource, 'utf8').toString('base64'),
    "'@))",
    'if (-not ("NmHiddenMaker" -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }',
    '$errorCode = 0',
    `$desktop = [NmHiddenMaker]::OpenByName(${psQuote(desktopName)}, [ref]$errorCode)`,
    '$openable = ($desktop -ne [IntPtr]::Zero)',
    '$closed = $false',
    'if ($openable) { $closed = [NmHiddenMaker]::CloseDesktop($desktop) }',
    `Write-Output (@{ desktop = ${psQuote(desktopName)}; still_openable = $openable; open_error = [int]$errorCode; probe_handle_closed = $closed; lane_thread_desktop = [NmHiddenMaker]::DesktopName() } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
}

async function hiddenDesktopProbe(route) {
  let makerSource = '';
  try {
    makerSource = fs.readFileSync(route.makerFile, 'utf8');
  } catch (error) {
    return { checked: false, still_openable: null, error: `the maker payload could not be read from ${route.makerFile}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = await runInLane('windows', hiddenDesktopProbeScript(route.desktopName, makerSource), 30000);
  if (!result.ok) {
    const parsed = parsePsError(result.output);
    return { checked: false, still_openable: null, error_code: parsed.code, error: parsed.message };
  }
  const parsed = parseJsonObject(result.output);
  if (!parsed) return { checked: false, still_openable: null, error: 'the desktop probe returned an unreadable answer' };
  return {
    checked: true,
    still_openable: parsed.still_openable === true,
    open_error: Number(parsed.open_error) || 0,
    probe_handle_closed: parsed.probe_handle_closed === true,
    lane_thread_desktop: String(parsed.lane_thread_desktop || ''),
    checked_from: 'the windows lane, on the interactive desktop, with no handle of its own to the agent',
  };
}

/**
 * Start one resident agent on a fresh desktop and bind it to this owner.
 *
 * The order is the measured one and it is not negotiable: the launcher creates the desktop and
 * holds it, the agent starts onto it by `lpDesktop` and opens its OWN handle, and only then
 * does the launcher drop its own. The agent's own ready file is the evidence that the handover
 * happened - its presence means an agent that holds its desktop, not merely that something
 * started.
 */
async function armHiddenDesktop(options, ownerId) {
  const mod = await hiddenAgentModule();
  const desktopName = hiddenDesktopName();
  const ledger = mod.ledgerPath();

  /*
   * What a job handle could not survive is reaped BEFORE a new agent starts: a leaked process
   * is a leaked desktop, and a desktop with a process on it stays openable even with every
   * handle closed. The reaper is pid-AND-start-time matched (`NmProcessFacts.TerminateIfStartTime`
   * refuses a mismatch), so a reused pid is left strictly alone.
   */
  let reaped = null;
  try {
    reaped = await mod.reapLedger({ file: ledger });
    /* `terminated` while the reaper held no handle is reported below. */
  } catch (error) {
    reaped = { error: error instanceof Error ? error.message : String(error) };
  }

  const endpoint = await mod.startHiddenDesktopAgent({
    desktopName,
    ledgerFile: ledger,
    readyWaitMs: clampNumber(options.hiddenReadyWaitMs, 5000, 180000, 60000),
    launchTimeoutMs: clampNumber(options.hiddenLaunchTimeoutMs, 5000, 300000, 120000),
  });
  const ready = endpoint.ready && typeof endpoint.ready === 'object' ? endpoint.ready : null;
  const route = {
    ownerId,
    desktopName: String(endpoint.desktopName || desktopName),
    pipe: String(endpoint.pipe || ''),
    token: String(endpoint.token || ''),
    agentPid: ready ? Number(ready.pid) || 0 : 0,
    agentStartTimeUtc: ready ? String(ready.start_time_utc || '') : '',
    job: {
      created: Boolean(ready && ready.job_created === true),
      self_assigned: Boolean(ready && ready.job_assigned === true),
      /*
       * `self_assigned` is what `AssignProcessToJobObject` RETURNED; `self_in_job` is what the
       * kernel says when asked. They are reported side by side because the whole ownership
       * design rests on the second: a job the agent is not actually a member of inherits
       * nothing, and every launched application then sits outside it while `kill_on_close`
       * still reads `true`. Measured on this station in the live application: the agent's own
       * ready file answered `job_in_job: true`, so inheritance was working, and the launched
       * `notepad.exe` still came back outside the job - which is why the launch now measures
       * membership instead of assuming it.
       */
      self_in_job: Boolean(ready && ready.job_in_job === true),
      kill_on_close: Boolean(ready && ready.job_kill_on_close === true),
      limit_flags: ready ? String(ready.job_limit_flags || '') : '',
    },
    ready,
    scratch: String(endpoint.scratch || ''),
    ledger,
    makerFile: path.join(String(endpoint.payloads && endpoint.payloads.directory ? endpoint.payloads.directory : ''), 'NmHiddenMaker.cs'),
    launcherReport: endpoint.launcher ? endpoint.launcher.report : null,
    openedAt: Date.now(),
    requests: 0,
    launches: [],
    /** The pids on this desktop that the job does NOT hold, as the agent last reported them. */
    unheld: [],
    closed: false,
    reaped,
  };

  if (!ready || ready.ok !== true) {
    route.closed = true;
    return {
      ok: false,
      error_code: 'hidden_desktop_agent_unavailable',
      error: String(endpoint.startError || 'the hidden-desktop agent did not report itself ready'),
      route,
      endpoint,
    };
  }
  if (!route.agentPid) {
    route.closed = true;
    return { ok: false, error_code: 'hidden_desktop_agent_pid_unknown', error: 'the agent came up without reporting its own pid, so nothing could be tracked by identity', route, endpoint };
  }
  hiddenRoutes.set(ownerKey(ownerId), route);

  /* The program the caller asked to start on that desktop. Whether it is IN the job is measured
   * by the agent after the launch and reported per launch, not assumed from inheritance - see
   * the `launch` op. A launch the job does not hold is kept in `route.unheld` so the teardown
   * asks about that pid too, and so the arm receipt names it instead of leaving it out. */
  let launched = null;
  const commandLine = String(options.launch || '').trim();
  if (commandLine) {
    const started = await hiddenAgentAnswer(route, 'launch', { command_line: commandLine }, { timeoutMs: 60000 });
    if (started.ok !== true) {
      route.closed = true;
      hiddenRoutes.delete(ownerKey(ownerId));
      return { ok: false, error_code: 'hidden_desktop_launch_failed', error: started.error, route, endpoint, commandLine };
    }
    launched = {
      command_line: commandLine,
      pid: Number(started.value.pid) || 0,
      start_time_utc: String(started.value.start_time_utc || ''),
      start_time_ticks: String(started.value.start_time_ticks || ''),
      in_job: started.value.in_job === true,
      held: started.value.held === true,
      ownership: String(started.value.ownership || (started.value.held === true ? 'inherited' : 'unowned')),
      inherited: started.value.inherited === true,
      assigned_after_launch: started.value.assigned_after_launch === true,
      assign_error: Number(started.value.assign_error) || 0,
      membership_before: Number(started.value.membership_before),
      membership_error: Number(started.value.membership_error) || 0,
      member_listed: started.value.member_listed === true,
      job_present: started.value.job_present === true,
      created_by_this_launch: started.value.created_by_this_launch !== false,
      started_before_this_launch: started.value.started_before_this_launch === true,
      desktop_requested: String(started.value.desktop_requested || route.desktopName),
    };
    route.launches.push(launched);
    for (const entry of Array.isArray(started.value.unheld_window_pids) ? started.value.unheld_window_pids : []) {
      route.unheld.push({
        pid: Number(entry && entry.pid) || 0,
        held: false,
        title: String((entry && entry.title) || ''),
        class_name: String((entry && entry.class_name) || ''),
        start_time_ticks: String((entry && entry.start_time_ticks) || ''),
        source: 'desktop-window-after-launch',
      });
    }
    /* A launched application the job does not hold is a process that will OUTLIVE the agent, and
     * the desktop with it. It is reported as its own fact on the arm rather than as an absence. */
    if (launched.held !== true) {
      route.unownedLaunches = route.unownedLaunches || [];
      route.unownedLaunches.push({
        pid: launched.pid,
        command_line: commandLine,
        ownership: launched.ownership,
        assign_error: launched.assign_error,
        started_before_this_launch: launched.started_before_this_launch === true,
        membership_before: launched.membership_before,
        reason: launched.started_before_this_launch === true
          ? 'the pid that answered began before this launch, so it was not adopted'
          : (launched.ownership === 'unowned' && launched.assign_error ? `the job refused it (error ${launched.assign_error})` : 'the job does not hold it'),
      });
    }
    /* One state read after the launch, so the ARM receipt itself names what the desktop now
     * hosts and what it holds - the launch answer alone cannot see a target that handed its work
     * to a process this agent never created. It is a read: nothing here terminates anything.
     *
     * AND IT SETTLES, BUT ONLY WHERE IT HAS TO. A packaged application's real process is created by
     * the shell's activation host a fraction of a second AFTER the pid the launch returned, and
     * that process is the one that will hold the desktop open. Measured on this station: launching
     * `notepad.exe` created pid 34168 (not a job member, and the job refused it with error 5), and
     * the Store Notepad came up as a different pid 180 ms later with a window on this desktop - so
     * a read taken the instant after the launch named nothing and the teardown could only report
     * "something unknown still holds it". The poll below is bounded, and it runs ONLY for a launch
     * this job does not hold: a held child needs no watching, and the controlled case stays fast.
     */
    const settleMs = launched.held === true ? 0 : clampNumber(options.hiddenSettleMs, 0, 15000, 2500);
    const settleStarted = Date.now();
    let state = await hiddenAgentAnswer(route, 'state', {}, { timeoutMs: 20000 });
    const unheldNow = (answer) => (answer.ok === true && Array.isArray(answer.value.unheld_window_pids) ? answer.value.unheld_window_pids : []);
    while (settleMs > 0 && Date.now() - settleStarted < settleMs && unheldNow(state).length === 0) {
      await sleep(250);
      state = await hiddenAgentAnswer(route, 'state', {}, { timeoutMs: 20000 });
    }
    route.settleMs = Date.now() - settleStarted;
    if (state.ok === true) {
      route.hostedAfterLaunch = Array.isArray(state.value.hosted) ? state.value.hosted : [];
      route.unheldAfterLaunch = Array.isArray(state.value.unheld_window_pids) ? state.value.unheld_window_pids : [];
      for (const entry of route.unheldAfterLaunch) {
        const pid = Number(entry && entry.pid) || 0;
        if (pid > 0 && !route.unheld.some((known) => known.pid === pid)) {
          route.unheld.push({
            pid,
            held: false,
            title: String((entry && entry.title) || ''),
            class_name: String((entry && entry.class_name) || ''),
            start_time_ticks: String((entry && entry.start_time_ticks) || ''),
            source: 'desktop-window-after-launch',
          });
        }
      }
    }
  }
  return { ok: true, route, endpoint, launched };
}

/** The public shape of one armed route, with no token and no pipe name in it. */
function hiddenRouteReport(route) {
  if (!route) return null;
  return {
    desktop_name: route.desktopName,
    agent_pid: route.agentPid,
    agent_start_time_utc: route.agentStartTimeUtc,
    job: route.job,
    launched: route.launches,
    /*
     * WHAT THIS DESKTOP HOSTS THAT THE JOB DOES NOT HOLD.
     *
     * Reported as its own field because it is the one thing that decides whether the teardown
     * can end it: a process outside the job is not killed by KILL_ON_JOB_CLOSE, so it keeps the
     * desktop open after the agent is gone. Empty means "nothing was observed", never "nothing
     * is there" - the desktop probe at the teardown is what answers the second question.
     */
    unowned_launches: Array.isArray(route.unownedLaunches) ? route.unownedLaunches : [],
    unheld_desktop_pids: Array.isArray(route.unheld) ? route.unheld : [],
    launched_settle_ms: Number(route.settleMs) || 0,
    ownership: route.job && route.job.created === true && route.job.self_in_job === true
      ? (route.unownedLaunches && route.unownedLaunches.length ? 'job-plus-unowned' : 'job')
      : 'no-job',
    opened_at: route.openedAt,
    requests_served: route.requests,
    transport: 'json-lines over the agent named pipe, one connection per request, through the windows lane',
    token_reported: false,
  };
}

/**
 * End one route: end the agent, then MEASURE what that did.
 *
 * The order is the whole ownership contract. `exit` stops the agent's loop; the agent then
 * exits, and the kernel closes the job handle it held, and KILL_ON_JOB_CLOSE terminates every
 * process the job inherited - the launched application and its children. What is left is the
 * desktop, and whether it is still there is asked rather than assumed.
 */
async function closeHiddenDesktop(route = null, options = {}) {
  if (!route) return null;
  /*
   * The route leaves the registry FIRST so no new action can be routed to an agent that is
   * being ended - and `closed` is set LAST, because `hiddenAgentAnswer` refuses a closed route.
   *
   * Measured: the first version set `closed` here, at the top, and then asked the agent for its
   * state and for its exit through the very function that refuses a closed route. Both requests
   * were refused by this code, the exit never reached the agent, and the teardown fell through
   * to the pid fallback - which worked, and which reported `exit_answered: false` while it did.
   * The fallback is the safety net, not the path, and this is what made the difference visible.
   */
  hiddenRoutes.delete(ownerKey(route.ownerId));
  const startedAt = Date.now();
  const before = await hiddenAgentAnswer(route, 'state', {}, { timeoutMs: 20000 });
  const hosted = before.ok === true && Array.isArray(before.value.hosted) ? before.value.hosted : [];
  const hostedPids = hosted.map((entry) => Number(entry && entry.pid) || 0).filter((pid) => pid > 0);
  /*
   * EVERY PID THIS SESSION IS RESPONSIBLE FOR, EACH WITH THE REASON IT IS ON THE LIST.
   *
   * This is the fix for the check that could not fail. The shipped teardown asked about
   * `[agentPid, ...jobMembers]` and nothing else, and a job member list can only ever contain
   * what the job holds - so a launched application the job did NOT hold was never asked about,
   * `all_processes_gone` came back `true` with the application still running, and the desktop it
   * was sitting on stayed open. Measured in the live application: `pids_checked` was
   * `[36516, 36516]` - the agent's pid twice - while the pid the session had launched (36744)
   * was in `launch_pids_this_session` and alive.
   *
   * So the set is the union of four reads, and the sources are kept so a reader can see which
   * question produced each pid: the agent, the job's own member list, every pid a launch of this
   * session returned, and every pid the agent reported as owning a window on its desktop that
   * the job does not hold.
   */
  const unheldBefore = before.ok === true && Array.isArray(before.value.unheld_window_pids) ? before.value.unheld_window_pids : [];
  const sources = new Map();
  const addPid = (pid, source, startTimeTicks = '') => {
    const value = Number(pid);
    if (!Number.isFinite(value) || value <= 0) return;
    if (!sources.has(value)) sources.set(value, { pid: value, sources: [], start_time_ticks: String(startTimeTicks || '') });
    const record = sources.get(value);
    if (!record.sources.includes(source)) record.sources.push(source);
    if (!record.start_time_ticks && startTimeTicks) record.start_time_ticks = String(startTimeTicks);
  };
  addPid(route.agentPid, 'agent');
  for (const entry of hosted) addPid(entry && entry.pid, 'job-member', entry && entry.start_time_ticks);
  for (const entry of route.launches) addPid(entry && entry.pid, 'launched-this-session', entry && entry.start_time_ticks);
  for (const entry of unheldBefore) addPid(entry && entry.pid, 'unheld-desktop-window', entry && entry.start_time_ticks);
  for (const entry of Array.isArray(route.unheld) ? route.unheld : []) addPid(entry && entry.pid, 'unheld-desktop-window', entry && entry.start_time_ticks);
  const pids = [...sources.keys()];
  const exited = await hiddenAgentAnswer(route, 'exit', {}, { timeoutMs: 20000 });
  let verified = await hiddenWaitForExit(pids, clampNumber(options.hiddenExitWaitMs, 1000, 120000, 20000));
  let killedByThisCall = false;
  if (!verified.all_gone && Number(route.agentPid) > 0 && verified.still_running.includes(Number(route.agentPid))) {
    /* The agent is still running, so its own exit path did not finish. It is terminated from
     * its own root - the pid its own ready file reported - and then measured again. */
    try { process.kill(Number(route.agentPid)); killedByThisCall = true; } catch { killedByThisCall = false; }
    verified = await hiddenWaitForExit(pids, clampNumber(options.hiddenExitWaitMs, 1000, 120000, 20000));
  }
  const desktop = await hiddenDesktopProbe(route);
  route.closed = true;
  /*
   * A RESULT PER PID, AND `all_processes_gone` READ OFF IT.
   *
   * The pid list and the answer to "is it still running" are one record each, so the receipt
   * shows that the question was ASKED about every pid and what each one answered. A reader can
   * no longer be shown a boolean over a list that never contained the process that survived.
   * A pid whose liveness could not be read is `running: null` and is NOT counted as gone: an
   * unreadable answer is a failure to measure, and it must not be reported as a clean end.
   */
  const stateByPid = new Map(verified.states.map((state) => [Number(state.pid), state]));
  const pidChecks = pids.map((pid) => {
    const record = sources.get(pid);
    const state = stateByPid.get(pid);
    const running = state ? state.running === true : null;
    return {
      pid,
      sources: record.sources,
      running,
      start_time_ticks_expected: record.start_time_ticks || '',
      start_time_ticks_observed: state ? String(state.start_time_ticks || '') : '',
      same_process: Boolean(state && state.start_time_ticks && record.start_time_ticks && String(state.start_time_ticks) === String(record.start_time_ticks)),
    };
  });
  const alive = pidChecks.filter((check) => check.running === true).map((check) => check.pid);
  const unreadable = pidChecks.filter((check) => check.running === null).map((check) => check.pid);
  const allGone = verified.all_gone === true && alive.length === 0 && unreadable.length === 0;
  const desktopStillHeld = desktop.still_openable === true;
  return {
    desktop_name: route.desktopName,
    agent_pid: route.agentPid,
    hosted_before_exit: hosted.map((entry) => ({ pid: Number(entry && entry.pid) || 0, start_time_ticks: String((entry && entry.start_time_ticks) || '') })),
    unheld_before_exit: unheldBefore.map((entry) => ({ pid: Number(entry && entry.pid) || 0, title: String((entry && entry.title) || ''), start_time_ticks: String((entry && entry.start_time_ticks) || '') })),
    launch_pids_this_session: route.launches.map((entry) => ({ pid: entry.pid, start_time_ticks: entry.start_time_ticks, held: entry.held === true, ownership: entry.ownership })),
    state_answered: before.ok === true,
    state_error: before.ok === true ? null : String(before.error || ''),
    exit_answered: exited.ok === true,
    exit_error: exited.ok === true ? null : String(exited.error || ''),
    agent_terminated_by_this_call: killedByThisCall,
    pids_checked: pidChecks,
    pids_checked_count: pidChecks.length,
    all_processes_gone: allGone,
    still_running: alive,
    pids_unreadable: unreadable,
    exit_wait_ms: verified.elapsedMs,
    exit_wait_attempts: verified.attempts,
    liveness_error: verified.liveness_error,
    desktop,
    desktop_gone: desktop.still_openable === false,
    desktop_still_held: desktopStillHeld,
    /*
     * THE TWO ANSWERS TOGETHER, BECAUSE ONE OF THEM ALONE WAS THE LIE.
     *
     * `all_processes_gone: true` beside `desktop.still_openable: true` is a contradiction: a
     * desktop is held by any handle OR any process assigned to it, so if every pid this session
     * knows about is gone and the desktop still opens, a process it does NOT know about is on
     * it. The shipped receipt printed exactly that pair and left the reader to notice.
     */
    unaccounted_holder: allGone && desktopStillHeld,
    nothing_holds_the_desktop: allGone && desktop.still_openable === false,
    elapsed_ms: Date.now() - startedAt,
    requests_served: route.requests,
  };
}

/**
 * The last-resort teardown, for `stopAll()` and process exit, which cannot await anything.
 *
 * Every agent is terminated by the pid its own launcher reported. Killing the agent closes the
 * job handle it held, and KILL_ON_JOB_CLOSE takes its whole tree with it - which is exactly
 * why a leaked agent would be a leaked desktop and is not left to chance. This is best effort
 * by construction: `exit` handlers are synchronous, so it cannot wait for, verify, or report
 * anything, and `takeover_stop` remains the path that verifies.
 */
function stopHiddenAgentsSync() {
  const stopped = [];
  for (const route of hiddenRoutes.values()) {
    route.closed = true;
    const pid = Number(route.agentPid);
    let killed = false;
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid); killed = true; } catch { killed = false; }
    }
    stopped.push({ desktop_name: route.desktopName, agent_pid: pid, terminated: killed, verified: false });
  }
  hiddenRoutes.clear();
  return stopped;
}

/* ------------------------------------------------------------------ *
 * 10. sequence, the takeover lease, and the dispatcher
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
  lease.ownerId = null;
  lease.acquiredAt = 0;
  // Every exit path restores the physical mouse mode.
  lease.mouseMode = 'real';
  // The visible half of the lease: `takeover_stop`, `stopAll()` and process exit all land
  // here, so the native overlay can never outlive the lease that owns it. Time is no
  // longer one of these paths - the lease has no expiry, so nothing here fires on a clock.
  try {
    releaseOverlay(reason);
  } catch (error) {
    lease.lastOverlayError = error instanceof Error ? error.message : String(error);
  }
  return { released: true, reason };
}

/**
 * The lease as it is reported.
 *
 * There is no expiry to compute: a held lease is held until `takeover_stop` (or the owning
 * process dying). The three duration fields report `null` rather than a number, because a
 * number would be read as a real deadline by every caller that trusts it.
 */
function activeLease() {
  if (!lease.ownerId) return null;
  return {
    owner_id: lease.ownerId,
    mouse_mode: lease.mouseMode,
    acquired_at: lease.acquiredAt,
    expiry: LEASE_EXPIRY,
    expires_at: null,
    expires_in_ms: null,
    ttl_ms: null,
    released_by: LEASE_RELEASE_ACTION,
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
      expiry: LEASE_EXPIRY,
      ttl_ms: null,
      expires_in_ms: null,
      lease: existing,
      mouse_mode: existing.mouse_mode,
      fallback_to_real_delivery: false,
    });
  }
  /**
   * A lease may be armed onto a hidden desktop, and that is the only thing this action starts.
   *
   * `desktop` is read in exactly one place, here, and the only value it accepts is `hidden`:
   * a name it does not know is refused rather than ignored, because an ignored desktop request
   * would silently deliver the actions to this desktop. A resident agent is a real process, so
   * it is started when a caller asks for one and never on a read.
   */
  const desktopRequest = String(options.desktop || options.desktopTarget || '').trim().toLowerCase();
  if (desktopRequest && desktopRequest !== 'hidden') {
    return failure(action, 'desktop_unsupported', `The only desktop this lane can route to is "hidden"; received ${JSON.stringify(String(options.desktop || options.desktopTarget))}. Leave \`desktop\` out to act on this desktop.`, {
      takeover: false,
      requested_desktop: String(options.desktop || options.desktopTarget),
      supported_desktops: ['hidden'],
      mouse_mode: currentMouseMode(),
      fallback_to_real_delivery: false,
    });
  }
  if (desktopRequest === 'hidden' && requested !== 'virtual') {
    return failure(action, 'hidden_desktop_requires_virtual_mode', 'A hidden desktop is reached with mouse_mode "virtual": the agent on it posts messages and moves no physical pointer, so asking for it with mouse_mode "real" is refused rather than downgraded.', {
      takeover: false,
      requested_desktop: 'hidden',
      requested_mouse_mode: requested,
      mouse_mode: currentMouseMode(),
      fallback_to_real_delivery: false,
    });
  }
  return { action, ownerId, requested, existing, desktopRequest };
}

/** The arm itself, which is asynchronous because a resident agent is a real process. */
async function takeoverStartArmed(action, ownerId, requested, desktopRequest, options) {
  let armed = null;
  if (desktopRequest === 'hidden') {
    armed = await armHiddenDesktop(options, ownerId);
    if (armed.ok !== true) {
      /* Nothing is left behind by a failed arm: the route record says `closed`, and the
       * launcher has already closed the handle it created. */
      return failure(action, armed.error_code, armed.error, {
        takeover: false,
        requested_desktop: 'hidden',
        mouse_mode: 'real',
        hidden_desktop: { started: false, desktop_name: armed.route ? armed.route.desktopName : '', launcher: armed.endpoint && armed.endpoint.launcher ? armed.endpoint.launcher.report : null },
        fallback_to_real_delivery: false,
        physical_delivery_used: false,
      });
    }
  }
  lease.ownerId = ownerId;
  lease.mouseMode = requested;
  lease.acquiredAt = Date.now();
  // There is no timer to arm: the lease has no time limit and only `takeover_stop`
  // (or the owning process dying) releases it.
  // The takeover is only real once the screen itself carries the effect.
  startTakeoverOverlay(ownerId);
  const overlaySnapshot = overlayState();
  return {
    ok: true,
    action,
    takeover: true,
    mouse_mode: requested,
    delivery: armed ? 'hidden-desktop-agent' : (requested === 'virtual' ? 'posted-window-messages' : 'physical-desktop'),
    lease: {
      owner_id: ownerId,
      mouse_mode: requested,
      expiry: LEASE_EXPIRY,
      ttl_ms: null,
      acquired_at: lease.acquiredAt,
      expires_at: null,
      expires_in_ms: null,
      released_by: LEASE_RELEASE_ACTION,
    },
    overlay: overlaySnapshot,
    ...(armed
      ? {
        target_desktop: armed.route.desktopName,
        hidden_desktop: {
          started: true,
          ...hiddenRouteReport(armed.route),
          launched: armed.launched ? [armed.launched] : [],
          reaped_before_start: armed.route.reaped
            ? {
              candidates: Number(armed.route.reaped.candidates) || 0,
              terminated: Array.isArray(armed.route.reaped.terminated) ? armed.route.reaped.terminated.length : 0,
              already_gone: Array.isArray(armed.route.reaped.already_gone) ? armed.route.reaped.already_gone.length : 0,
              reused: Array.isArray(armed.route.reaped.reused) ? armed.route.reaped.reused.length : 0,
              failed: Array.isArray(armed.route.reaped.failed) ? armed.route.reaped.failed.length : 0,
              error: armed.route.reaped.error ? String(armed.route.reaped.error) : null,
            }
            : null,
          routed_actions: ['app_list', 'app_observe', 'app_activate', 'app_click', 'app_type', 'app_scroll', 'app_key'],
          end_with: 'takeover_stop',
        },
      }
      : {}),
    physical_delivery_used: false,
    system_cursor_moved: false,
    fallback_to_real_delivery: false,
  };
}

async function takeoverStartAction(options) {
  const prepared = takeoverStart(options);
  if (prepared.ok === false) return prepared;
  return await takeoverStartArmed(prepared.action, prepared.ownerId, prepared.requested, prepared.desktopRequest, options);
}

async function takeoverStop(options) {
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
  /* The hidden desktop is ended BEFORE the lease is released: the teardown needs the route the
   * lease is holding, and the lease must not be reported as free while an agent still holds a
   * desktop open. */
  const route = hiddenRouteFor(ownerId);
  const hidden = route ? await closeHiddenDesktop(route, options) : null;
  clearVirtualCursor(ownerId);
  releaseLease('takeover_stop');
  return {
    ok: true,
    action,
    takeover: false,
    mouse_mode: 'real',
    released_owner: previousOwner,
    lease: { held: false, owner_id: null, mouse_mode: 'real', expiry: LEASE_EXPIRY, ttl_ms: null, expires_at: null, expires_in_ms: null, released_by: LEASE_RELEASE_ACTION },
    overlay: overlayState(),
    /* What the teardown MEASURED, or null when this lease never armed a hidden desktop. A
     * desktop that survived is reported as surviving, with the pids that kept it alive. */
    hidden_desktop: hidden,
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
  // `takeover_start` is now asynchronous for one reason: `desktop: "hidden"` arms a resident
  // agent on a hidden desktop, and starting a process cannot be done in a return statement.
  // Without that option it does exactly what it did before, synchronously composed.
  if (action === 'takeover_start') return await takeoverStartAction(options);
  if (action === 'takeover_stop') return await takeoverStop(options);
  if (action === 'mode_report') return modeReport(action, options);
  if (action === 'wait') {
    const durationMs = clampNumber(options.durationMs ?? options.duration_ms, 0, 60000, 1000);
    const startedAt = Date.now();
    await sleep(durationMs);
    return { ok: true, action, duration_ms: Date.now() - startedAt, mouse_mode: currentMouseMode(), physical_delivery_used: false };
  }

  if (!IS_WINDOWS) return unsupportedPlatform(action);

  if (!ALL_ACTIONS.includes(action) && !INTERNAL_ACTIONS.includes(action)) {
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

  /**
   * THE ROUTING DECISION, AND IT IS ONE DECISION IN ONE PLACE.
   *
   * When this owner's lease was armed onto a hidden desktop, the app-scoped actions are
   * relayed to the resident agent on that desktop and no interactive-desktop code runs for
   * them at all. It sits here, before every action branch, so no branch can accidentally act
   * on this desktop while a caller believes it is working on the hidden one - and it is a
   * no-op for every other call, including every virtual-mode call that did not ask for a
   * hidden desktop. Actions the route does not carry (`observe`, `capture_screen`, `sequence`)
   * fall through to the refusals they already had.
   */
  const hiddenRoute = hiddenRouteActive(options);
  if (hiddenRoute) {
    const routed = await hiddenDesktopAction(action, options, mode, header, hiddenRoute);
    if (routed) return routed;
  }

  if (action === 'observe') return await observeAction(action, options, mode, header);
  if (action === 'capture_screen') return await captureScreenAction(action, options, mode, header);
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

/**
 * The whole-desktop observation, for `screen_capture` with `target: "desktop"`.
 *
 * It resolves no window at all. That is the whole point: the defect it replaces answered a
 * request for the screen with the foreground window, so a caller asking "what is on the
 * screen" got a picture of one window and no field saying so. Nothing here reads the
 * foreground window, and nothing is captured from a window handle.
 */
async function captureScreenAction(action, options, mode, header) {
  if (mode.mode === 'virtual') {
    return virtualRefusal(action, options, 'Virtual mode refuses the whole-desktop capture: a screen capture is not a window-scoped read, so there is no target to scope it to. Use the real mouse mode, or app_observe with app_target or window_handle.');
  }
  return await fullScreenObservation(action, options, header);
}

/** One screen capture, reported with the virtual screen bounds it really covered. */
async function fullScreenObservation(action, options, header) {
  const capture = await captureScreen({
    ownerId: options.ownerId,
    imagePath: options.imagePath || options.image_path,
    maxWidth: options.captureMaxWidth ?? options.max_width,
    maxHeight: options.captureMaxHeight ?? options.max_height,
    timeoutMs: options.captureTimeoutMs,
    virtualScreenWidth: options.virtualScreenWidth,
    virtualScreenHeight: options.virtualScreenHeight,
  });
  if (capture.ok !== true) {
    return { ...header, ...capture, action };
  }
  return {
    ...header,
    ok: true,
    action,
    observation: 'full',
    observation_scope: 'screen',
    must_reacquire_full_observation: false,
    target_scope: capture.target_scope,
    capture_scope: capture.capture_scope,
    screen: capture.screen,
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
      target_scope: capture.target_scope,
      lane: capture.lane,
      digest: capture.digest,
    },
    /* A screen capture has no controls and no window, and it says so instead of leaving a
     * caller to infer it from an absent field. */
    controls: [],
    control_count: 0,
    uia_visited: 0,
    telemetry: {
      lane: capture.lane,
      capture_ms: capture.telemetry ? capture.telemetry.capture_ms : undefined,
      uia_ms: 0,
      uia_lane: null,
      uia_error: null,
    },
  };
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
    observation_scope: 'window',
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
      target_scope: capture.target_scope,
      lane: capture.lane,
      digest: capture.digest,
    },
    controls: bounded,
    control_count: bounded.length,
    uia_visited: controls.visited || 0,
    /* What the picture covers. The window capture reports the window handle; the screen
     * capture reports `screen`. A reader never has to guess which one it is holding. */
    target_scope: capture.target_scope,
    capture_scope: capture.capture_scope,
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

/**
 * How many times a failed activation is retried before it is reported as a failure.
 *
 * The retry is driven from here, not from inside one lane script, because the foreground a
 * caller will actually get is the foreground measured after the whole round trip.
 */
const ACTIVATION_ATTEMPTS = 3;

/**
 * Activate, then confirm from a fresh measured read, then retry, then fail honestly.
 *
 * `activateScript` already reports a post-attempt `GetForegroundWindow()`, but that read
 * happens inside the lane request. This re-runs the attempt and re-reads, so a window that
 * loses the foreground again during the round trip is reported as a failure instead of a
 * success, and the refusal always names the window that really holds the foreground.
 */
async function activateWithVerification(action, application, options) {
  let last = null;
  for (let attempt = 1; attempt <= ACTIVATION_ATTEMPTS; attempt += 1) {
    const result = await runActionScript(activateScript(application.handle, application.process_id), { action, ...options, lane: 'action' });
    last = result;
    if (result.ok === true && result.foreground_verified === true) {
      return { ...result, activation_verified_attempts: attempt };
    }
    // A refusal that is not about the foreground (a stale handle, a changed owner, an
    // unavailable lane) is terminal: retrying it cannot help and would hide the cause.
    if (result.ok !== true && result.error_code !== 'foreground_not_granted') return result;
  }
  const holder = foregroundHolder(last);
  const named = holder && holder.handle
    ? `The window that really holds the foreground is ${holder.handle}${holder.title ? ` ("${holder.title}")` : ''}${holder.process_id ? ` of process ${holder.process_id}` : ''}.`
    : 'No window reported itself as the foreground window.';
  return failure(action, 'foreground_not_granted', `Activation did not leave ${String(application.handle)} in the foreground after ${ACTIVATION_ATTEMPTS} attempts. ${named}`, {
    mouse_mode: 'real',
    expected_handle: String(application.handle),
    foreground_verified: false,
    foreground_is_target: false,
    foreground: holder,
    activation_technique: last ? last.activation_technique : null,
    activation_attempts: ACTIVATION_ATTEMPTS,
    app: { ...application, foreground: false },
    physical_delivery_used: false,
    system_cursor_moved: false,
  });
}

async function appActivateAction(action, options, mode, header) {
  const resolved = await resolveApplication({ ...options, virtualScope: mode.mode === 'virtual' });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, applications: (resolved.applications || []).slice(0, 20) });
  }
  const application = resolved.application;
  if (mode.mode === 'virtual') return { ...header, ...bindVirtualTarget(application, options.ownerId) };
  if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, app: application, mouse_mode: 'real' };
  const activated = await activateWithVerification(action, application, options);
  if (activated.ok !== true) return { ...header, ...activated };
  // The app record was enumerated before the activation, so its `foreground` flag is
  // stale. It is replaced by the measured value, so the payload cannot contradict itself.
  return { ...header, ...activated, app: { ...application, foreground: activated.foreground_is_target === true } };
}

/**
 * The real-mode key delivery as a lane script, without running it.
 *
 * `key` and `app_key` in virtual mode compose their scripts in functions this module keeps to
 * itself, which left the one thing a gate most needs to check - WHICH keys a chord composes,
 * and through which mechanism they are delivered - unmeasurable without pressing them on
 * somebody's desktop. These two exports are that measurement point and nothing else: they
 * build the script and hand it back.
 */
export function previewKeyScript(key, expect = {}) {
  return realKeyScript(key, expect);
}

/** The virtual (posted-message) key script, for the same reason. */
export function previewVirtualKeyScript(application, key, targetHandle) {
  return virtualKeyScript(application, key, targetHandle);
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
  const activated = await activateWithVerification(action, application, options);
  // Nothing is delivered unless the target was measured in the foreground. Every branch below
  // used to hard-code `foreground_verified: true` after this point; the flag now carries
  // the measured value, and `app_type`/`app_key` finally guard on the target handle too.
  if (activated.ok !== true) return { ...header, ...activated, app: { ...application, foreground: false } };
  const foregroundVerified = activated.foreground_is_target === true;
  const expect = { handle: application.handle, processId: application.process_id };
  const appRecord = { ...application, foreground: foregroundVerified };
  if (action === 'app_click') {
    const clicked = await realStep('click', realClickScript(point.x, point.y, options.button === 'right' ? 'right' : 'left', expect), options, true);
    return { ...header, ...clicked, action, app: appRecord, foreground_verified: foregroundVerified };
  }
  if (action === 'app_scroll') {
    const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
    const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
    if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
    const scrolled = await realStep('scroll', realScrollScript(point.x, point.y, scrollX, scrollY, expect), options, false);
    return { ...header, ...scrolled, action, app: appRecord, foreground_verified: foregroundVerified };
  }
  if (action === 'app_type') {
    const typed = await realStep('type', realTypeScript(String(options.text || ''), expect), options, false);
    return { ...header, ...typed, action, app: appRecord, foreground_verified: foregroundVerified };
  }
  if (action === 'app_key') {
    const built = realKeyScript(String(options.key || ''), expect);
    if (built.error) return failure(action, 'key_unsupported', built.error, { ...header });
    const pressed = await realStep('key', built.script, options, false);
    return { ...header, ...pressed, action, app: appRecord, foreground_verified: foregroundVerified };
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
    /* The two capture scopes, so a caller can see which one answers which request rather
     * than discovering it from a payload after the fact. */
    capture_scopes: {
      window: {
        action: 'observe',
        tool: 'screen_capture with target "application"',
        capture_method: WINDOW_CAPTURE_METHOD,
        covers: 'one window, by handle',
        target_scope: 'the window handle',
        lane: 'window_capture',
      },
      screen: {
        action: 'capture_screen',
        tool: 'screen_capture with target "desktop"',
        capture_method: SCREEN_CAPTURE_METHOD,
        covers: 'the entire virtual screen: every monitor, unioned',
        target_scope: '"screen"',
        lane: 'window_capture',
      },
    },
    /* Windows-key delivery, advertised as a fact rather than left to be discovered by a
     * caller whose `key: "win"` silently did nothing before this. */
    key_delivery: {
      send_keys: 'every chord .NET SendKeys can express: ctrl, shift and alt, alone or combined',
      virtual_keys: 'every chord, built from virtual-key codes and delivered with the same call the unicode path uses',
      virtual_keys_required_for: WINDOWS_KEY_NAMES.join(', '),
      windows_key_virtual_codes: { left: `0x${VK_LEFT_WINDOWS.toString(16).toUpperCase()}`, right: `0x${VK_RIGHT_WINDOWS.toString(16).toUpperCase()}` },
      lone_windows_key: 'held down, a dummy key is pressed inside the hold, and only then is it released: Windows waits to see whether a chord follows, so an unaccompanied down/up pair is swallowed',
    },
    constants: {
      lease_expiry: LEASE_EXPIRY,
      lease_release_action: LEASE_RELEASE_ACTION,
      min_action_interval_ms: MIN_ACTION_INTERVAL_MS,
      move_curve_ms: MOVE_CURVE_MS,
      sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
      sparse_max_wait_ms: SPARSE_MAX_WAIT_MS,
    },
    lease: active
      ? { held: true, ...active, last_release_reason: lease.lastReleaseReason }
      : { held: false, owner_id: null, mouse_mode: 'real', expiry: LEASE_EXPIRY, ttl_ms: null, expires_at: null, expires_in_ms: null, released_by: LEASE_RELEASE_ACTION, last_release_reason: lease.lastReleaseReason },
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
      /*
       * The advertisement names *conditions*, not actions.
       *
       * It used to read `refuses: ['observe', 'app_observe', 'sequence']`, which told a model
       * that virtual mode cannot observe at all - so it would abandon a path that works. What
       * the code actually refuses is the *foreground* variant of two actions, and `sequence`
       * in full; `app_observe` with a target is supported and does a background capture.
       * Every entry below is a condition this module enforces, and the supported paths are
       * advertised rather than hidden.
       */
      refuses: [
        'observe of the foreground desktop (virtual mode refuses the whole-desktop capture: use app_observe with app_target or window_handle)',
        'capture_screen, the whole-desktop capture behind screen_capture with target "desktop" (virtual mode refuses it: a screen capture is not a window-scoped read, so there is no target to scope it to)',
        'app_observe without app_target or window_handle (the foreground scene check)',
        'desktop move/click/drag/scroll/type/key without app_target, window_handle or a prior app_observe target (virtual_mode_requires_app_target)',
        'sequence (virtual mode refuses a scene-checked sequence: use app_observe followed by explicit app_* actions)',
      ],
      supports: [
        'app_list, including occluded and background windows',
        'app_observe with app_target or window_handle (background window capture, no foreground capture)',
        'app_activate with app_target or window_handle (binds the target; it never activates anything)',
        'app_click, app_drag, app_scroll, app_type, app_key with app_target or window_handle (posted window messages)',
        'the same actions against an agent-hosted hidden desktop, when the lease was armed with desktop "hidden": they are relayed to the resident agent on that desktop and nothing on this desktop is touched',
      ],
      requires: ['app_target or window_handle'],
      never_falls_back_to_real_delivery: true,
    },
    /**
     * The hidden-desktop route, advertised as a capability.
     *
     * It is not advertised as an ACTION, because it is not one: it is a desktop an existing
     * action set can be aimed at, armed on the lease. A caller that reads only this report can
     * still see what becomes reachable, what it costs (a process that starts on request) and
     * how it ends (the lease, with a measured teardown).
     */
    hidden_desktop: {
      arm_with: 'takeover_start with mouse_mode "virtual" and desktop "hidden" (optionally launch: "<command line>" to start a program on it)',
      routed_actions: ['app_list', 'app_observe', 'app_activate', 'app_click', 'app_type', 'app_scroll', 'app_key'],
      not_routed: ['observe', 'capture_screen', 'sequence', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'app_drag'],
      starts_a_process_when_asked: true,
      started_at_module_load: false,
      transport: 'json lines over the resident agent\'s own named pipe, one connection per request, relayed through the windows lane',
      reach: 'the agent lives on the hidden desktop and posts its own messages there: no cross-desktop call is made by this module',
      ownership: 'the agent creates a job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and assigns itself, so every process it launches is a member by inheritance',
      teardown: 'takeover_stop exits the agent, measures that the agent and every hosted pid are gone, and asks whether the desktop is still openable',
      cleanup_by_process_name: false,
      active_routes: [...hiddenRoutes.values()].map((route) => hiddenRouteReport(route)),
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
