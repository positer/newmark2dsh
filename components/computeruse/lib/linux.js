/**
 * Newmark ComputerUse - Linux desktop automation layer.
 *
 * A pure Node ESM module (node:child_process / node:fs / node:os / node:path / node:crypto
 * only, no DSH import, no TypeScript, no build step) that executes genuine Linux desktop
 * automation by driving the system tools the session actually has:
 *
 *   input     xdotool (preferred) -> xte from xautomation -> ydotool (kernel-level, Wayland-friendly)
 *   windows   wmctrl -lGpx (preferred) -> xdotool search, with xprop for the active window,
 *             the process id and the iconified state
 *   capture   gnome-screenshot -> scrot -> import (ImageMagick) -> ffmpeg -f x11grab
 *   digest    magick -> convert (ImageMagick) -> ffmpeg, downsampling to the 32x18 grayscale
 *             grid the Windows sibling measures
 *
 * It is the Linux sibling of lib/win32.js and presents the same public contract name for
 * name: lanes(), MODE_INVENTORY, the shared constants, prepareLane / runInLane / laneReady /
 * liveLaneCount / stopLane / stopAll / laneDiagnostics, captureWindow, sparseObservation,
 * runComputerUse (a JSON string), the key normaliser and the literal-text encoder, plus the
 * same option names, result keys and error vocabulary, so the Host half dispatches to either
 * backend without special-casing.
 *
 * Lane model, and how it differs from the Windows sibling. Win32 owns one persistent
 * PowerShell worker per lane because interpreter start-up is expensive there. On Linux every
 * tool is already a short-lived process, so a persistent interpreter would add start-up cost,
 * a quoting dialect and a second failure surface without buying anything. A lane here is the
 * same *contract* object - a named, serialised, individually killable execution slot with a
 * readiness probe and a timeout cooldown - backed by real child processes instead of a REPL:
 *
 *   - prepareLane probes the lane's required capability against the cached backend probe.
 *   - runInLane(lane, command) runs one POSIX shell command in that lane under a hard
 *     timeout, serialised on the Node side, and returns { ok, output, elapsedMs, error_code }.
 *     The lane script dialect is a shell command, not PowerShell: this is the one place the
 *     two backends are not textually interchangeable, and the Host half never sends lane
 *     scripts - it calls runComputerUse.
 *   - stopLane kills that lane's in-flight child; a timeout cools the lane down exactly as the
 *     Win32 sibling does (60 s for the action lane, bounded backoff for the advisory lanes).
 *
 * Everything that touches the desktop is probed, never assumed, and every refusal is
 * structured: an absent tool, a missing display, an unverifiable window or a vanished window
 * is reported with its own code instead of being papered over with a plausible-looking
 * success. Retired experimental work from the local Computer Use laboratory, and every
 * learned or on-device model runtime, is intentionally absent: this module only ever drives
 * the shipped X11/Wayland command-line tools listed above.
 *
 * Layout of this file
 *   1. constants, lanes, mode inventory, action tables
 *   2. small pure helpers (clamping, failure shaping, handles, key normalisation, literal text)
 *   3. the backend probe: which tools exist, which are chosen, what is missing
 *   4. the tool runner (spawn/timeout/kill/ENOENT) and the lane registry
 *   5. window enumeration, target resolution, ownership verification, containment
 *   6. capture, the 32x18 grayscale digest, full and sparse observation
 *   7. real input delivery, behind one shared click/drag reservation queue
 *   8. the virtual-mode region: refusal only, delimited by the @virtual-mode markers
 *   9. wait_for, sequence, the single-owner takeover lease, and the action dispatcher
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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
 * lane        - which execution slot carries the work
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
 * It is accepted by `runComputerUse` and routes through the same dispatch and the same
 * guards as every other action; it is simply not advertised as an action a model can name.
 */
export const INTERNAL_ACTIONS = Object.freeze(['capture_screen']);

/**
 * Lane routing: which execution slot carries the work of an action.
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

/**
 * The published twenty-value action enum also carries `wait_for`, which has no Windows lane
 * entry and is implemented here as a read-only poll of the window list. It is accepted by
 * runComputerUse and it is deliberately NOT added to ACTION_LANES or ALL_ACTIONS, whose
 * contents stay identical to the Windows sibling.
 */
const READ_ONLY_POLL_ACTION = 'wait_for';

/** Cooldown after a timed-out lane is killed, so it cannot block another lane. */
const LANE_TIMEOUT_COOLDOWN_MS = 60000;
const ADVISORY_TIMEOUT_COOLDOWN_MS = 4000;
const ADVISORY_LANES = Object.freeze(['uia_advisory', 'windows_advisory']);

const DEFAULT_ACTION_TIMEOUT_MS = 20000;
const DEFAULT_INIT_TIMEOUT_MS = 25000;
const DEFAULT_TOOL_TIMEOUT_MS = 10000;
const WINDOW_TOOL_TIMEOUT_MS = 8000;
const CAPTURE_TIMEOUT_MS = 20000;
const DIGEST_TIMEOUT_MS = 20000;
const LANE_SCRIPT_TIMEOUT_MS = 30000;

const SEQUENCE_MAX_STEPS = 8;
const MAX_APPLICATIONS = 200;
const MAX_REGISTERED_TARGETS = 2000;
/** One process per field: the xdotool-only fallback stays short on purpose. */
const FALLBACK_MAX_APPLICATIONS = 20;
/** One xprop process per window: only the head of a long list is probed for iconified state. */
const MAX_MINIMIZED_PROBES = 30;
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;

const CLICK_HOLD_MS = 40;
const MOVE_CURVE_POINTS = 10;
const DEFAULT_WAIT_FOR_MS = 5000;
const MAX_WAIT_FOR_MS = 30000;
const WAIT_FOR_POLL_MS = 250;
const TYPE_DELAY_MS = 12;
const MAX_TYPE_CHARS = 100000;
const MAX_SCROLL_STEPS = 50;

/** The capture directory mirrors the Windows sibling: a real image, never in the workspace. */
const CAPTURE_DIRECTORY_NAME = 'newmark2dsh-computer-use';

const IS_LINUX = process.platform === 'linux';

/* ------------------------------------------------------------------ *
 * 2. small pure helpers
 * ------------------------------------------------------------------ */

/** Structured refusal. `extra` fields are copied first so the core fields always win. */
function failure(action, code, message, extra = {}) {
  return { ...extra, ok: false, action, code, error_code: code, error: message };
}

function clampNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)); });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text) {
  const value = String(text === null || text === undefined ? '' : text).trim();
  if (!value) return '';
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || '';
}

function tail(text, limit = 400) {
  const value = String(text === null || text === undefined ? '' : text).trim();
  return value.length > limit ? value.slice(-limit) : value;
}

function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

function bucket(value, size = 48) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric / size) : 0;
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

/** An X11 window id, normalised into the same `0x`-prefixed hex spelling the sibling uses. */
function handleHex(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  return /[1-9a-f]/i.test(raw) ? raw.toUpperCase() : '';
}

function handleToInt(value) {
  const hex = handleHex(value);
  if (!hex) return 0;
  const numeric = Number.parseInt(hex, 16);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function unwrapHandle(value) {
  return `0x${handleToInt(value).toString(16).toUpperCase()}`;
}

function hexFromDecimal(value) {
  const numeric = Number(String(value === null || value === undefined ? '' : value).trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return unwrapHandle(Math.trunc(numeric).toString(16));
}

function sameHandle(left, right) {
  const a = handleToInt(left);
  const b = handleToInt(right);
  return a !== 0 && a === b;
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

function pointInsideRect(rect, x, y) {
  const box = normalizeRect(rect);
  if (box.width <= 0 || box.height <= 0) return false;
  return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
}

function centerOf(rect) {
  const box = normalizeRect(rect);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/* --- keyboard spelling translation --------------------------------- */

const XDOTOOL_MODIFIERS = Object.freeze({
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl',
  shift: 'shift',
  alt: 'alt', option: 'alt', opt: 'alt',
  super: 'super', win: 'super', windows: 'super', cmd: 'super', command: 'super',
  meta: 'meta',
  hyper: 'hyper',
});

const MODIFIER_RANK = Object.freeze({ ctrl: 0, shift: 1, alt: 2, super: 3, meta: 4, hyper: 5 });

/**
 * The fixed alias table, keyed by the human spelling and valued with the X keysym name that
 * `xdotool key` resolves. Page Up and Page Down use the classic X11 keysyms Prior and Next,
 * which are the names the X server itself defines for those keys.
 */
const XDOTOOL_KEY_ALIASES = Object.freeze({
  enter: 'Return', return: 'Return', cr: 'Return',
  esc: 'Escape', escape: 'Escape',
  backspace: 'BackSpace', bksp: 'BackSpace', bs: 'BackSpace',
  delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert',
  tab: 'Tab',
  space: 'space', spacebar: 'space',
  up: 'Up', arrowup: 'Up', 'arrow-up': 'Up',
  down: 'Down', arrowdown: 'Down', 'arrow-down': 'Down',
  left: 'Left', arrowleft: 'Left', 'arrow-left': 'Left',
  right: 'Right', arrowright: 'Right', 'arrow-right': 'Right',
  home: 'Home', end: 'End',
  pageup: 'Prior', 'page-up': 'Prior', pgup: 'Prior', prior: 'Prior',
  pagedown: 'Next', 'page-down': 'Next', pgdn: 'Next', next: 'Next',
  menu: 'Menu', printscreen: 'Print', 'print-screen': 'Print',
  plus: 'plus', minus: 'minus', equal: 'equal', comma: 'comma', period: 'period',
  slash: 'slash', backslash: 'backslash', semicolon: 'semicolon', apostrophe: 'apostrophe',
  grave: 'grave', bracketleft: 'bracketleft', bracketright: 'bracketright',
});

/**
 * The extra X keysyms this port accepts by name beyond the alias table: the modifier keys, the
 * keypad, the media keys and the lock keys, which are the ones a caller reaches for and cannot
 * spell with a single character. A name that is not in either table is refused as an unsupported
 * key instead of being forwarded to the tool as a guess.
 */
const XDOTOOL_EXTRA_KEYSYMS = Object.freeze({
  insert: 'Insert', menu: 'Menu', print: 'Print', pause: 'Pause',
  scroll_lock: 'Scroll_Lock', num_lock: 'Num_Lock', caps_lock: 'Caps_Lock',
  control_l: 'Control_L', control_r: 'Control_R', shift_l: 'Shift_L', shift_r: 'Shift_R',
  alt_l: 'Alt_L', alt_r: 'Alt_R', super_l: 'Super_L', super_r: 'Super_R',
  meta_l: 'Meta_L', meta_r: 'Meta_R', hyper_l: 'Hyper_L', hyper_r: 'Hyper_R',
  kp_enter: 'KP_Enter', kp_add: 'KP_Add', kp_subtract: 'KP_Subtract', kp_multiply: 'KP_Multiply',
  kp_divide: 'KP_Divide', kp_decimal: 'KP_Decimal', kp_separator: 'KP_Separator',
  kp_home: 'KP_Home', kp_end: 'KP_End', kp_up: 'KP_Up', kp_down: 'KP_Down',
  kp_left: 'KP_Left', kp_right: 'KP_Right', kp_page_up: 'KP_Page_Up', kp_page_down: 'KP_Page_Down',
  kp_insert: 'KP_Insert', kp_delete: 'KP_Delete',
  kp_0: 'KP_0', kp_1: 'KP_1', kp_2: 'KP_2', kp_3: 'KP_3', kp_4: 'KP_4',
  kp_5: 'KP_5', kp_6: 'KP_6', kp_7: 'KP_7', kp_8: 'KP_8', kp_9: 'KP_9',
  xf86audiolowervolume: 'XF86AudioLowerVolume', xf86audioMute: 'XF86AudioMute', xf86audioraisevolume: 'XF86AudioRaiseVolume',
  xf86audiomute: 'XF86AudioMute', xf86audioplay: 'XF86AudioPlay', xf86audiopause: 'XF86AudioPause',
  xf86audionext: 'XF86AudioNext', xf86audioprev: 'XF86AudioPrev', xf86audiostop: 'XF86AudioStop',
  xf86monbrightnessdown: 'XF86MonBrightnessDown', xf86monbrightnessup: 'XF86MonBrightnessUp',
  xf86screensaver: 'XF86ScreenSaver', xf86display: 'XF86Display', xf86wlan: 'XF86WLAN',
});

/** One key, an alias, a braced .NET spelling such as {ENTER}, or a named extra keysym. */
function normalizeXdotoolBase(value) {
  let base = String(value === null || value === undefined ? '' : value).trim();
  if (!base) return undefined;
  const braced = /^\{([^{}]+)\}$/.exec(base);
  if (braced) base = braced[1].trim();
  if (!base) return undefined;
  const lower = base.toLowerCase();
  const alias = XDOTOOL_KEY_ALIASES[lower];
  if (alias) return alias;
  const extra = XDOTOOL_EXTRA_KEYSYMS[lower.replace(/[-\s]/g, '_')];
  if (extra) return extra;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(base)) return base.toUpperCase();
  if (base.length === 1) return base;
  return undefined;
}

/**
 * Normalise a human key spelling into the chord form `xdotool key` takes.
 * ctrl+l -> ctrl+l, ctrl+shift+l -> ctrl+shift+l, alt+f4 -> alt+F4, enter -> Return,
 * ^s -> ctrl+s (the .NET spelling is accepted and converted, never forwarded as text).
 */
export function normalizeXdotoolKey(value) {
  const key = String(value === null || value === undefined ? '' : value).trim();
  if (!key) return undefined;

  // The caret/plus/percent prefix spelling: ^ = ctrl, + = shift, % = alt.
  const prefixed = /^([\^%+]+)(.+)$/.exec(key);
  if (prefixed) {
    const modifiers = new Set();
    for (const symbol of prefixed[1]) {
      if (symbol === '^') modifiers.add('ctrl');
      else if (symbol === '+') modifiers.add('shift');
      else modifiers.add('alt');
    }
    const base = normalizeXdotoolBase(prefixed[2]);
    if (!base) return undefined;
    const ordered = [...modifiers].sort((a, b) => MODIFIER_RANK[a] - MODIFIER_RANK[b]);
    return [...ordered, base].join('+');
  }

  if (!key.includes('+')) return normalizeXdotoolBase(key);

  const parts = key.split('+').map(part => part.trim());
  if (parts.length < 2) return undefined;
  const base = normalizeXdotoolBase(parts[parts.length - 1]);
  if (!base) return undefined;
  const modifiers = new Set();
  for (const part of parts.slice(0, -1)) {
    const modifier = XDOTOOL_MODIFIERS[part.toLowerCase()];
    if (!modifier) return undefined;
    modifiers.add(modifier);
  }
  if (!modifiers.size) return undefined;
  const ordered = [...modifiers].sort((a, b) => MODIFIER_RANK[a] - MODIFIER_RANK[b]);
  return [...ordered, base].join('+');
}

/**
 * The mirrored contract name. On Windows this produces .NET SendKeys notation because that is
 * what the delivery path consumes; here the only keyboard delivery path is `xdotool key`, so
 * the same contract name returns the chord form that path consumes. A caller that hands either
 * backend the same human spelling gets the notation its own delivery path needs.
 */
export function normalizeSendKeysKey(value) {
  return normalizeXdotoolKey(value);
}

/**
 * Literal text, unchanged.
 *
 * Windows has to escape SendKeys metacharacters because `+ ^ % ~ ( ) { }` are syntax there.
 * `xdotool type` (and `xte str`) have no metacharacter syntax at all: every character of the
 * argument is typed as itself, and the argument reaches the tool as one argv element, never
 * through a shell. Escaping anything here would therefore *corrupt* the text - a URL would be
 * typed as `https://a{+}b` - so the literal-preserving equivalent of the Windows encoder is
 * the identity. The newline and tab characters stay as themselves; the tools type them as
 * Return and Tab.
 */
export function encodeSendKeysText(value) {
  return String(value === null || value === undefined ? '' : value);
}

/** The same receipt key the Windows sibling reports, kept honest for the Linux path. */
function textDelivery(backend) {
  return backend === 'ydotool' ? 'kernel-uinput' : 'x11-test-extension';
}

/* ------------------------------------------------------------------ *
 * 3. the backend probe
 *
 * Capability is measured once per (platform, PATH) and cached: nothing here assumes a tool
 * exists because it usually does. A changed PATH invalidates the cache, so installing a tool
 * in a running session is picked up on the next action instead of being cached away.
 * ------------------------------------------------------------------ */

const TOOL_INVENTORY = Object.freeze([
  'xdotool', 'xte', 'ydotool',
  'wmctrl', 'xprop',
  'gnome-screenshot', 'scrot', 'import', 'ffmpeg',
  'magick', 'convert', 'identify', 'ffprobe',
]);

/**
 * Candidate chains, in the documented preference order. An empty chain means the capability
 * exists in the contract but has no implementation in this port: the accessibility tree
 * (AT-SPI over D-Bus) is not implemented here, so the uia lanes never report ready and
 * target ids are window-level rather than control-level.
 */
const TOOL_CHAINS = Object.freeze({
  input: Object.freeze(['xdotool', 'xte', 'ydotool']),
  windows: Object.freeze(['wmctrl', 'xdotool']),
  capture: Object.freeze(['gnome-screenshot', 'scrot', 'import', 'ffmpeg']),
  /* The whole screen, which is not the same request as one window: the entries here are the
   * ones that can address the root window or the full display, in preference order. */
  screen_capture: Object.freeze(['import', 'gnome-screenshot', 'scrot', 'ffmpeg']),
  digest: Object.freeze(['magick', 'convert', 'ffmpeg']),
  dimensions: Object.freeze(['identify', 'magick', 'ffprobe']),
  active_window: Object.freeze(['xdotool', 'xprop']),
  window_info: Object.freeze(['xprop', 'xdotool']),
  activate: Object.freeze(['wmctrl', 'xdotool']),
  accessibility: Object.freeze([]),
});

/** What each lane needs before it can carry work. */
const LANE_REQUIREMENTS = Object.freeze({
  action: Object.freeze(['input']),
  uia: Object.freeze(['accessibility']),
  windows: Object.freeze(['windows']),
  uia_advisory: Object.freeze(['accessibility']),
  windows_advisory: Object.freeze(['windows']),
  window_capture: Object.freeze(['capture']),
  sparse: Object.freeze(['capture']),
});

const probeCache = { key: null, value: null };

/** Resolve one executable name against PATH without spawning anything. */
function resolveExecutable(name) {
  const pathValue = String(process.env.PATH || '');
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, not executable, or not readable: the next directory decides.
    }
  }
  return null;
}

function firstFound(tools, chain) {
  for (const name of chain) {
    if (tools[name]) return name;
  }
  return null;
}

/** The cached capability probe: which tools exist, which backend each capability chose. */
function capabilities() {
  const cacheKey = `${process.platform}\u0000${String(process.env.PATH || '')}`;
  if (probeCache.value && probeCache.key === cacheKey) return probeCache.value;
  const tools = {};
  for (const name of TOOL_INVENTORY) tools[name] = resolveExecutable(name);
  const backend = {};
  for (const [capability, chain] of Object.entries(TOOL_CHAINS)) backend[capability] = firstFound(tools, chain);
  const value = {
    cache_key: cacheKey,
    tools: { ...tools },
    backend,
    missing_tools: TOOL_INVENTORY.filter(name => !tools[name]),
    probed_at: Date.now(),
  };
  probeCache.key = cacheKey;
  probeCache.value = value;
  return value;
}

/** `backend: { input, windows, capture }` plus the probed availability, on every result. */
function backendReport(captureOverride) {
  const caps = capabilities();
  return {
    backend: {
      input: caps.backend.input,
      windows: caps.backend.windows,
      capture: captureOverride || caps.backend.capture,
    },
    backend_detail: {
      input_chain: [...TOOL_CHAINS.input],
      windows_chain: [...TOOL_CHAINS.windows],
      capture_chain: [...TOOL_CHAINS.capture],
      digest: caps.backend.digest,
      dimensions: caps.backend.dimensions,
      active_window: caps.backend.active_window,
      window_info: caps.backend.window_info,
      activate: caps.backend.activate,
      accessibility: null,
      resolved_paths: { ...caps.tools },
    },
    missing_tools: [...caps.missing_tools],
  };
}

function displayState() {
  const display = String(process.env.DISPLAY || '').trim();
  const waylandDisplay = String(process.env.WAYLAND_DISPLAY || '').trim();
  const sessionType = String(process.env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  const session = display && waylandDisplay
    ? 'x11-with-wayland-display'
    : display ? 'x11' : waylandDisplay ? 'wayland' : 'none';
  return {
    DISPLAY: display || null,
    WAYLAND_DISPLAY: waylandDisplay || null,
    x11: Boolean(display),
    wayland: Boolean(waylandDisplay),
    available: Boolean(display || waylandDisplay),
    xdg_session_type: sessionType || null,
    session,
  };
}

/* --- the three gates every desktop/app action passes through ------ */

function unsupportedPlatform(action) {
  return failure(action, 'unsupported_platform', 'Computer Use Linux automation is Linux-only; no desktop action was attempted.', {
    platform: process.platform,
    supported_platforms: ['linux'],
    supported_actions: [...ALL_ACTIONS],
    extensions: [READ_ONLY_POLL_ACTION],
    physical_delivery_used: false,
    fallback_to_real_delivery: false,
    ...backendReport(),
  });
}

function displayGuard(action) {
  if (!IS_LINUX) return unsupportedPlatform(action);
  const display = displayState();
  if (!display.available) {
    return failure(action, 'no_display', 'No X11 or Wayland display is available (DISPLAY and WAYLAND_DISPLAY are both unset), so no desktop action was attempted.', {
      platform: process.platform,
      display,
      physical_delivery_used: false,
      fallback_to_real_delivery: false,
      system_cursor_moved: false,
      ...backendReport(),
    });
  }
  return null;
}

/**
 * Refuse when the capability has no backend. The receipt names the tool that is missing and
 * the whole chain, so the caller can install something instead of guessing.
 */
function toolGuard(action, capability) {
  const caps = capabilities();
  const chain = TOOL_CHAINS[capability] || [];
  const selected = caps.backend[capability];
  if (selected) return null;
  const missing = chain.filter(name => !caps.tools[name]);
  const reason = chain.length
    ? `No ${capability} backend is available: none of ${chain.join(', ')} is installed or on PATH.`
    : `No ${capability} backend exists in this port.`;
  return failure(action, 'missing_backend_tool', reason, {
    tool: chain.length ? chain[0] : null,
    tool_chain: [...chain],
    missing_tools: missing,
    capability,
    ...backendReport(),
  });
}

/** Carry the named-tool fields of a deeper refusal outward, so the real cause is never lost. */
function toolFields(source) {
  const fields = {};
  if (!source || typeof source !== 'object') return fields;
  for (const key of ['tool', 'tool_chain', 'capability', 'missing_tools']) {
    if (source[key] !== undefined) fields[key] = source[key];
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * 4. the tool runner and the lane registry
 * ------------------------------------------------------------------ */

const liveChildren = new Set();

/** Terminate one child, escalating from SIGTERM to SIGKILL when asked to be gentle. */
function killChild(child, immediate = false) {
  if (!child) return;
  const finished = child.exitCode !== null || child.signalCode !== null;
  if (finished) return;
  const signal = immediate ? 'SIGKILL' : 'SIGTERM';
  try {
    child.kill(signal);
  } catch {
    // Already gone, or the signal could not be delivered: the close handler settles it.
  }
  if (immediate) return;
  const escalate = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, 400);
  if (typeof escalate.unref === 'function') escalate.unref();
}

/**
 * Run one tool to completion under a hard timeout. Every path settles exactly once: a missing
 * binary, a non-zero exit, a spawn failure and a timeout all resolve with a structured reason,
 * and a child that ignores SIGTERM is killed again after a short grace period so no call can
 * be left hanging or orphaned.
 */
function runTool(command, args, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs, 100, 300000, DEFAULT_TOOL_TIMEOUT_MS);
  const lane = typeof options.lane === 'string' && LANES.includes(options.lane) ? options.lane : 'action';
  registerCleanup();
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        ok: false,
        error_code: 'spawn_failed',
        error: `${command} could not be started: ${messageOf(error)}`,
        command,
        args: [...args],
        lane,
        elapsed_ms: 0,
        timeout_ms: timeoutMs,
      });
      return;
    }

    const startedAt = Date.now();
    const state = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, settled: false, timedOut: false };
    let timer = null;
    let hardTimer = null;

    const settle = result => {
      if (state.settled) return;
      state.settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      liveChildren.delete(child);
      const stdoutBuffer = Buffer.concat(state.stdout);
      const stderrText = Buffer.concat(state.stderr).toString('utf8');
      resolve({
        ...result,
        command,
        args: [...args],
        lane,
        stdout: stdoutBuffer.toString('utf8'),
        stdoutBuffer,
        stderr: stderrText,
        elapsed_ms: Date.now() - startedAt,
        timeout_ms: timeoutMs,
      });
    };

    liveChildren.add(child);

    timer = setTimeout(() => {
      state.timedOut = true;
      killChild(child, false);
      hardTimer = setTimeout(() => {
        killChild(child, true);
        settle({
          ok: false,
          error_code: 'tool_timeout',
          timed_out: true,
          error: `${command} did not exit within ${timeoutMs} ms and was killed.`,
        });
      }, 2500);
      if (typeof hardTimer.unref === 'function') hardTimer.unref();
    }, timeoutMs);

    const collect = (chunk, stream) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (stream === 'stdout') {
        if (state.stdoutBytes >= MAX_TOOL_OUTPUT_BYTES) return;
        state.stdoutBytes += buffer.length;
        state.stdout.push(buffer);
        return;
      }
      if (state.stderrBytes >= MAX_TOOL_OUTPUT_BYTES) return;
      state.stderrBytes += buffer.length;
      state.stderr.push(buffer);
    };

    if (child.stdout) child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    if (child.stderr) child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.stdout.on('error', () => { /* the close handler settles the request */ });
    child.stderr.on('error', () => { /* the close handler settles the request */ });

    child.once('error', error => {
      const code = error && error.code === 'ENOENT' ? 'missing_tool' : 'spawn_failed';
      settle({
        ok: false,
        error_code: code,
        spawn_error_code: error && error.code ? String(error.code) : undefined,
        error: code === 'missing_tool'
          ? `${command} is not installed or not on PATH, so nothing was attempted.`
          : `${command} could not be started: ${messageOf(error)}`,
      });
    });

    child.once('close', (code, signal) => {
      if (state.timedOut) {
        settle({
          ok: false,
          error_code: 'tool_timeout',
          timed_out: true,
          exit_code: code,
          signal: signal || null,
          error: `${command} timed out after ${timeoutMs} ms.`,
        });
        return;
      }
      if (code === 0) {
        settle({ ok: true, exit_code: 0 });
        return;
      }
      const detail = firstLine(Buffer.concat(state.stderr).toString('utf8')) || firstLine(Buffer.concat(state.stdout).toString('utf8'));
      settle({
        ok: false,
        error_code: 'tool_failed',
        exit_code: code,
        signal: signal || null,
        error: `${command} exited with ${code === null ? `signal ${signal || 'unknown'}` : `code ${code}`}${detail ? `: ${detail}` : '.'}`,
      });
    });
  });
}

function laneCapabilityReason(lane) {
  if (!IS_LINUX) return { ready: false, error: 'unsupported_platform' };
  const display = displayState();
  if (!display.available) return { ready: false, error: 'no_display', display };
  const requirements = LANE_REQUIREMENTS[lane] || [];
  for (const capability of requirements) {
    const selected = capabilities().backend[capability];
    if (!selected) {
      const chain = TOOL_CHAINS[capability] || [];
      return {
        ready: false,
        error: chain.length ? 'missing_backend_tool' : `${capability}_backend_unavailable`,
        capability,
        tool: chain.length ? chain[0] : null,
        tool_chain: [...chain],
      };
    }
  }
  return { ready: true };
}

class LinuxLane {
  constructor(lane) {
    this.lane = lane;
    this.child = null;
    this.childPid = null;
    this.cooldownUntil = 0;
    this.consecutiveTimeouts = 0;
    this.initError = '';
    this.spawnFailures = 0;
    this.warnings = (LANE_REQUIREMENTS[lane] || []).includes('accessibility')
      ? ['This port implements no accessibility tree, so this lane never reports ready.']
      : [];
    this.queue = Promise.resolve();
  }

  isLive() {
    const child = this.child;
    return Boolean(child) && child.exitCode === null && child.signalCode === null;
  }

  ready() {
    if (!IS_LINUX) return false;
    if (Date.now() < this.cooldownUntil) return false;
    return laneCapabilityReason(this.lane).ready === true;
  }

  diagnostics() {
    const reason = laneCapabilityReason(this.lane);
    return {
      lane: this.lane,
      ready: this.ready(),
      live: this.isLive(),
      child_pid: this.isLive() ? this.childPid : null,
      cooldown_remaining_ms: Math.max(0, this.cooldownUntil - Date.now()),
      consecutive_timeouts: this.consecutiveTimeouts,
      init_error: this.initError || undefined,
      warnings: this.warnings.length ? [...this.warnings] : undefined,
      readiness_error: reason.ready === true ? undefined : reason.error,
      requirements: [...(LANE_REQUIREMENTS[this.lane] || [])],
      spawn_failures: this.spawnFailures || 0,
      execution_model: 'spawn-per-request-posix-shell',
    };
  }

  async prepare(timeoutMs) {
    const startedAt = Date.now();
    if (!IS_LINUX) return { ready: false, elapsedMs: 0, error: 'unsupported_platform' };
    registerCleanup();
    const reason = laneCapabilityReason(this.lane);
    if (reason.ready === true && Date.now() < this.cooldownUntil) {
      return {
        ready: false,
        elapsedMs: Date.now() - startedAt,
        lane: this.lane,
        error: 'lane_cooling_down',
        cooldown_remaining_ms: Math.max(0, this.cooldownUntil - Date.now()),
      };
    }
    if (reason.ready !== true) {
      this.initError = reason.error;
      return {
        ready: false,
        elapsedMs: Date.now() - startedAt,
        lane: this.lane,
        error: reason.error,
        capability: reason.capability,
        tool: reason.tool,
        tool_chain: reason.tool_chain,
        ...backendReport(),
      };
    }
    // The probe is synchronous on Linux, so readiness is immediate; timeoutMs is accepted for
    // contract parity with the Windows host, which has to wait for an interpreter.
    const bounded = clampNumber(timeoutMs, 100, 120000, DEFAULT_INIT_TIMEOUT_MS);
    return { ready: true, elapsedMs: Date.now() - startedAt, lane: this.lane, init_timeout_ms: bounded, ...backendReport() };
  }

  async run(command, timeoutMs) {
    const startedAt = Date.now();
    if (!IS_LINUX) {
      return { ok: false, output: 'unsupported_platform: the Computer Use lane host is Linux-only.', elapsedMs: 0, error_code: 'unsupported_platform', lane: this.lane };
    }
    registerCleanup();
    if (Date.now() < this.cooldownUntil) {
      return {
        ok: false,
        output: `Computer Use ${this.lane} lane is cooling down after a timeout; it will accept work again shortly.`,
        elapsedMs: 0,
        error_code: 'lane_cooling_down',
        lane: this.lane,
        cooldown_remaining_ms: Math.max(0, this.cooldownUntil - Date.now()),
      };
    }
    // Serialise the lane on the Node side as well: one lane executes one command at a time, so a
    // queued request must not burn its own timeout while an earlier command still runs.
    const run = async () => {
      const bounded = clampNumber(timeoutMs, 100, 300000, LANE_SCRIPT_TIMEOUT_MS);
      const result = await runTool('/bin/sh', ['-c', String(command)], { timeoutMs: bounded, lane: this.lane });
      if (result.ok) {
        this.consecutiveTimeouts = 0;
        this.cooldownUntil = 0;
        this.initError = '';
        return { ok: true, output: result.stdout, elapsedMs: Date.now() - startedAt, exit_code: 0 };
      }
      if (result.error_code === 'spawn_failed' || result.error_code === 'missing_tool') {
        this.spawnFailures += 1;
        this.initError = result.error;
        return { ok: false, output: result.error, elapsedMs: Date.now() - startedAt, error_code: 'lane_unavailable', lane: this.lane };
      }
      if (result.error_code === 'tool_timeout') {
        this.stop();
        this.consecutiveTimeouts += 1;
        const cooldown = ADVISORY_LANES.includes(this.lane)
          ? Math.min(500 * (2 ** Math.min(this.consecutiveTimeouts - 1, 3)), ADVISORY_TIMEOUT_COOLDOWN_MS)
          : LANE_TIMEOUT_COOLDOWN_MS;
        this.cooldownUntil = Date.now() + cooldown;
        this.initError = result.error;
        return { ok: false, output: result.error, elapsedMs: Date.now() - startedAt, error_code: 'lane_timeout', lane: this.lane, cooldown_ms: cooldown };
      }
      const output = `${result.stdout}${result.stderr}`.trim() || result.error;
      this.initError = output;
      return { ok: false, output, elapsedMs: Date.now() - startedAt, error_code: 'lane_script_failed', lane: this.lane, exit_code: result.exit_code };
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(() => undefined, () => undefined);
    return await chained;
  }

  /** Kill the in-flight child of this lane. Safe to call at any time. */
  stop() {
    const child = this.child;
    this.child = null;
    this.childPid = null;
    killChild(child, true);
  }
}

const lanesById = new Map(LANES.map(lane => [lane, new LinuxLane(lane)]));

function laneFor(lane) {
  const worker = lanesById.get(lane);
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

/** Start (or reuse) the execution slot of one lane and report its readiness. */
export async function prepareLane(lane, timeoutMs = DEFAULT_INIT_TIMEOUT_MS) {
  if (!LANES.includes(lane)) return { ready: false, elapsedMs: 0, error: `Unknown Computer Use lane: ${lane}` };
  if (!IS_LINUX) return { ready: false, elapsedMs: 0, error: 'unsupported_platform' };
  return await laneFor(lane).prepare(clampNumber(timeoutMs, 100, 120000, DEFAULT_INIT_TIMEOUT_MS));
}

/** Run one POSIX shell command in one lane and read its output back under a hard timeout. */
export async function runInLane(lane, script, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
  if (!LANES.includes(lane)) {
    return { ok: false, output: `Unknown Computer Use lane: ${lane}`, elapsedMs: 0, error_code: 'unknown_lane', lane };
  }
  if (!IS_LINUX) {
    return { ok: false, output: 'unsupported_platform: the Computer Use lane host is Linux-only.', elapsedMs: 0, error_code: 'unsupported_platform', lane };
  }
  return await laneFor(lane).run(String(script), clampNumber(timeoutMs, 100, 300000, DEFAULT_ACTION_TIMEOUT_MS));
}

export function laneReady(lane) {
  if (!LANES.includes(lane)) return false;
  return laneFor(lane).ready();
}

export function stopLane(lane) {
  if (!LANES.includes(lane)) return;
  laneFor(lane).stop();
}

/** Terminate every child the lanes own. Idempotent, and safe to call from an exit handler. */
export function stopAll() {
  for (const lane of LANES) laneFor(lane).stop();
  for (const child of [...liveChildren]) killChild(child, true);
  liveChildren.clear();
  releaseLease('stop_all');
}

/** How many lanes currently own a live child process. */
export function liveLaneCount() {
  let live = 0;
  for (const lane of LANES) {
    if (laneFor(lane).isLive()) live += 1;
  }
  return live;
}

/** Per-lane diagnostics for mode_report. */
export function laneDiagnostics() {
  return LANES.map(lane => laneFor(lane).diagnostics());
}

/* ------------------------------------------------------------------ *
 * 5. window enumeration, target resolution, verification, containment
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

function advisoryLane(kind, options = {}) {
  const requested = typeof options.lane === 'string' ? options.lane : '';
  if (kind === 'uia' && requested === 'uia_advisory') return 'uia_advisory';
  if (kind === 'windows' && requested === 'windows_advisory') return 'windows_advisory';
  return kind;
}

/** Read /proc for the executable name of a pid. Null when /proc cannot answer. */
function processName(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return null;
  try {
    const comm = fs.readFileSync(`/proc/${value}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch { /* not readable */ }
  try {
    const cmdline = fs.readFileSync(`/proc/${value}/cmdline`, 'utf8').split('\u0000').filter(Boolean)[0];
    if (cmdline) return path.basename(cmdline);
  } catch { /* not readable */ }
  return null;
}

/**
 * `wmctrl -lGpx` rows.
 *
 * The leading columns are fixed and are anchored by the regular expression below: id, desktop,
 * pid, x, y, width, height. What follows is the WM_CLASS (only because -x was requested), then
 * the client machine, then the title. Only two of those three are separable without guessing:
 * a token containing a dot is the instance.class pair, and a leading token equal to this
 * machine's own hostname is the client machine. Anything else is left in the title verbatim
 * rather than being dropped on a guess - a title that keeps a remote machine name is a smaller
 * lie than a title with a real word removed.
 */
function parseWmctrlRows(text) {
  const rows = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const match = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    rows.push({
      handle: unwrapHandle(match[1]),
      desktop: Number(match[2]),
      process_id: Math.max(0, Number(match[3])),
      geometry: {
        x: Number(match[4]),
        y: Number(match[5]),
        width: Math.max(0, Number(match[6])),
        height: Math.max(0, Number(match[7])),
      },
      tail: match[8] || '',
    });
  }
  return rows;
}

function splitWmctrlTail(tail) {
  const tokens = String(tail || '').split(/\s+/).filter(Boolean);
  const result = { class_name: null, machine: null, title: '' };
  if (tokens.length >= 2 && /^[^\s/]+\.[^\s/]+$/.test(tokens[0])) {
    result.class_name = tokens.shift();
  }
  if (tokens.length >= 2) {
    const host = os.hostname().toLowerCase();
    const candidate = tokens[0].toLowerCase();
    if (candidate === host || (candidate.split('.')[0] === host.split('.')[0] && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tokens[0]))) {
      result.machine = tokens.shift();
    }
  }
  result.title = tokens.length ? tokens.join(' ') : '';
  return result;
}

/**
 * Name every contract field this record could not obtain and why. A null is a measurement that
 * did not happen, never a value that was assumed.
 */
function unobtainableFields(record) {
  const fields = {};
  if (record.title === null) fields.title = 'the window title could not be read from this backend';
  if (record.class_name === null) fields.class_name = 'the backend did not report a WM_CLASS for this window';
  if (record.process_id === null) fields.process_id = 'the window did not report an owning process id (_NET_WM_PID), so ownership cannot be verified';
  if (record.process_name === null) fields.process_name = 'the owning process name could not be read from /proc';
  if (record.minimized === null) fields.minimized = 'xprop is not installed, so the iconified state cannot be measured';
  if (record.foreground === null) fields.foreground = 'the active window could not be determined, so no window can be marked foreground';
  if (record.desktop === null) fields.desktop = 'this backend does not report a desktop number';
  fields.occluded = 'occlusion is not measurable with wmctrl or xdotool and is always reported as null';
  fields.frame_rect = record.frame_rect === null ? 'the window manager published no _NET_FRAME_EXTENTS' : undefined;
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }
  return Object.keys(fields).length ? fields : undefined;
}

/** `xprop` value readers. Every one of them returns null rather than a guess. */
function parseXpropWindowId(text) {
  const match = /(0x[0-9a-fA-F]+)/.exec(String(text || ''));
  if (!match) return '';
  const hex = handleHex(match[1]);
  return hex && /[1-9a-f]/i.test(hex) ? unwrapHandle(hex) : '';
}

function parseXpropPid(text) {
  const match = /=\s*(\d+)/.exec(String(text || ''));
  if (!match) return 0;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/** The active window, from xdotool first and xprop second. Never guessed. */
async function activeWindowHandle(timeoutMs = WINDOW_TOOL_TIMEOUT_MS) {
  const caps = capabilities();
  if (caps.tools.xdotool) {
    const result = await runTool('xdotool', ['getactivewindow'], { timeoutMs, lane: 'windows' });
    if (result.ok) {
      const handle = hexFromDecimal(String(result.stdout).trim().split(/\s+/).pop());
      if (handle) return { ok: true, handle, source: 'xdotool getactivewindow' };
    }
  }
  if (caps.tools.xprop) {
    const result = await runTool('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW'], { timeoutMs, lane: 'windows' });
    if (result.ok) {
      const handle = parseXpropWindowId(result.stdout);
      if (handle) return { ok: true, handle, source: 'xprop -root _NET_ACTIVE_WINDOW' };
    }
  }
  return {
    ok: false,
    error_code: 'active_window_unavailable',
    error: 'The active window could not be determined: neither xdotool nor xprop is available, or the window manager does not publish _NET_ACTIVE_WINDOW.',
  };
}

/** Iconified state from the window manager, or null when it cannot be measured. */
async function windowMinimized(handle, timeoutMs = WINDOW_TOOL_TIMEOUT_MS) {
  const caps = capabilities();
  if (!caps.tools.xprop) return null;
  const result = await runTool('xprop', ['-id', unwrapHandle(handle), '_NET_WM_STATE', 'WM_STATE'], { timeoutMs, lane: 'windows' });
  if (!result.ok) return null;
  if (/_NET_WM_STATE_HIDDEN/.test(result.stdout)) return true;
  if (/window state:\s*Iconic/i.test(result.stdout)) return true;
  if (/window state:\s*Normal/i.test(result.stdout)) return false;
  if (/_NET_WM_STATE\(/i.test(result.stdout)) return false;
  return null;
}

async function windowPid(handle, timeoutMs = WINDOW_TOOL_TIMEOUT_MS) {
  const caps = capabilities();
  const target = unwrapHandle(handle);
  if (caps.tools.xdotool) {
    const result = await runTool('xdotool', ['getwindowpid', target], { timeoutMs, lane: 'windows' });
    if (result.ok) {
      const numeric = Number(String(result.stdout).trim().split(/\s+/).pop());
      if (Number.isFinite(numeric) && numeric > 0) return { pid: Math.trunc(numeric), source: 'xdotool getwindowpid' };
    }
  }
  if (caps.tools.xprop) {
    const result = await runTool('xprop', ['-id', target, '_NET_WM_PID'], { timeoutMs, lane: 'windows' });
    if (result.ok) {
      const numeric = parseXpropPid(result.stdout);
      if (numeric > 0) return { pid: numeric, source: 'xprop _NET_WM_PID' };
    }
  }
  return { pid: 0, source: null };
}

/** Frame extents, when the window manager publishes them: the only frame geometry available. */
async function windowFrameRect(handle, geometry, timeoutMs = WINDOW_TOOL_TIMEOUT_MS) {
  const caps = capabilities();
  if (!caps.tools.xprop) return null;
  const result = await runTool('xprop', ['-id', unwrapHandle(handle), '_NET_FRAME_EXTENTS'], { timeoutMs, lane: 'windows' });
  if (!result.ok) return null;
  const match = /=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/.exec(result.stdout);
  if (!match) return null;
  const [left, right, top, bottom] = match.slice(1).map(Number);
  const box = normalizeRect(geometry);
  return {
    x: box.x - left,
    y: box.y - top,
    width: box.width + left + right,
    height: box.height + top + bottom,
    extents: { left, right, top, bottom },
  };
}

function buildWindowRecord(fields) {
  const geometry = normalizeRect(fields.geometry);
  const processId = Number(fields.process_id) || 0;
  const record = {
    handle: unwrapHandle(fields.handle),
    title: fields.title === undefined ? null : fields.title,
    process_id: processId > 0 ? processId : null,
    process_name: processId > 0 ? processName(processId) : null,
    class_name: fields.class_name === undefined ? null : fields.class_name,
    geometry,
    rect: { ...geometry },
    client_rect: { ...geometry },
    frame_rect: fields.frame_rect === undefined ? null : fields.frame_rect,
    desktop: fields.desktop === undefined ? null : fields.desktop,
    visible: fields.visible === undefined ? null : fields.visible,
    minimized: fields.minimized === undefined ? null : fields.minimized,
    foreground: fields.foreground === undefined ? null : fields.foreground,
    occluded: null,
    source: fields.source || null,
    title_source: fields.title_source || null,
    pid_source: fields.pid_source || null,
    geometry_is_client_area: true,
  };
  const unobtainable = unobtainableFields(record);
  if (unobtainable) record.null_fields = unobtainable;
  return record;
}

/**
 * Top-level windows.
 *
 * `wmctrl -lGpx` is the primary source: one process for the whole list, with pid, geometry and
 * WM_CLASS. Without it the xdotool fallback costs one process per field, so it is capped.
 * Occlusion is not measurable with these tools and is reported as null, never invented; the
 * scope label says what was listed instead of borrowing the Windows wording.
 */
async function enumerateApplications(options = {}) {
  const startedAt = Date.now();
  const lane = advisoryLane('windows', options);
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 120000, WINDOW_TOOL_TIMEOUT_MS + 4000);
  const includeMinimized = options.includeMinimized === true;
  const caps = capabilities();

  if (caps.tools.wmctrl) {
    const listed = await runTool('wmctrl', ['-lGpx'], { timeoutMs, lane });
    if (!listed.ok) {
      return {
        ok: false,
        applications: [],
        lane,
        backend: 'wmctrl -lGpx',
        capability: 'windows',
        error_code: listed.error_code === 'missing_tool' ? 'missing_backend_tool' : 'window_enumeration_failed',
        error: listed.error_code === 'missing_tool'
          ? 'wmctrl is not installed or not on PATH, so no window list could be read.'
          : `wmctrl -lGpx failed: ${tail(listed.stderr) || listed.error}`,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const active = await activeWindowHandle(timeoutMs);
    const rows = parseWmctrlRows(listed.stdout);
    const applications = [];
    let minimizedProbes = 0;
    for (const row of rows) {
      const box = row.geometry;
      if (box.width <= 1 || box.height <= 1) continue;
      const tailParts = splitWmctrlTail(row.tail);
      let minimized = null;
      if (caps.tools.xprop && minimizedProbes < MAX_MINIMIZED_PROBES) {
        minimizedProbes += 1;
        minimized = await windowMinimized(row.handle, timeoutMs);
      }
      if (minimized === true && !includeMinimized) continue;
      applications.push(buildWindowRecord({
        handle: row.handle,
        title: tailParts.title,
        process_id: row.process_id,
        class_name: tailParts.class_name,
        desktop: Number.isFinite(row.desktop) ? row.desktop : null,
        geometry: box,
        visible: true,
        minimized,
        foreground: active.ok ? sameHandle(active.handle, row.handle) : null,
        source: 'wmctrl -lGpx',
        title_source: 'wmctrl -lGpx tail',
        pid_source: 'wmctrl -lGpx -p',
      }));
      if (applications.length >= MAX_APPLICATIONS) break;
    }
    return {
      ok: true,
      applications,
      lane,
      backend: 'wmctrl -lGpx',
      scope: 'managed-windows',
      occlusion_measured: false,
      minimized_probe_limit: MAX_MINIMIZED_PROBES,
      minimized_probed: minimizedProbes,
      active_window: active.ok ? { handle: active.handle, source: active.source } : { handle: null, error: active.error },
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (caps.tools.xdotool) {
    const searched = await runTool('xdotool', ['search', '--onlyvisible', '--name', ''], { timeoutMs, lane });
    if (!searched.ok) {
      return {
        ok: false,
        applications: [],
        lane,
        backend: 'xdotool search',
        capability: 'windows',
        error_code: searched.error_code === 'missing_tool' ? 'missing_backend_tool' : 'window_enumeration_failed',
        error: `xdotool search failed: ${tail(searched.stderr) || searched.error}`,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const active = await activeWindowHandle(timeoutMs);
    const ids = String(searched.stdout).split(/\s+/).map(hexFromDecimal).filter(Boolean);
    const applications = [];
    for (const id of ids) {
      if (applications.length >= FALLBACK_MAX_APPLICATIONS) break;
      const record = await windowRecordFromXdotool(id, { timeoutMs, lane, active });
      if (!record) continue;
      if (record.minimized === true && !includeMinimized) continue;
      applications.push(record);
    }
    return {
      ok: true,
      applications,
      lane,
      backend: 'xdotool search --onlyvisible --name ""',
      scope: 'viewable-toplevel-windows',
      occlusion_measured: false,
      truncated: ids.length > applications.length,
      active_window: active.ok ? { handle: active.handle, source: active.source } : { handle: null, error: active.error },
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    ok: false,
    applications: [],
    lane,
    backend: null,
    capability: 'windows',
    error_code: 'missing_backend_tool',
    tool: 'wmctrl',
    tool_chain: [...TOOL_CHAINS.windows],
    missing_tools: TOOL_CHAINS.windows.filter(name => !caps.tools[name]),
    error: `No window backend is available: none of ${TOOL_CHAINS.windows.join(', ')} is installed or on PATH.`,
    elapsedMs: Date.now() - startedAt,
  };
}

/** One window record through the xdotool-only path: one process per field, by design. */
async function windowRecordFromXdotool(handle, context) {
  const target = unwrapHandle(handle);
  const geometry = await runTool('xdotool', ['getwindowgeometry', '--shell', target], { timeoutMs: context.timeoutMs, lane: context.lane });
  if (!geometry.ok) return null;
  const values = {};
  for (const line of String(geometry.stdout).split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  if (!Number.isFinite(values.WIDTH) || !Number.isFinite(values.HEIGHT)) return null;
  if (values.WIDTH <= 1 || values.HEIGHT <= 1) return null;

  const name = await runTool('xdotool', ['getwindowname', target], { timeoutMs: context.timeoutMs, lane: context.lane });
  const className = await runTool('xdotool', ['getwindowclassname', target], { timeoutMs: context.timeoutMs, lane: context.lane });
  const resolvedClass = className.ok ? String(className.stdout).trim() : '';
  // A toolkit child window has no WM_CLASS: dropping those keeps this fallback to real toplevels.
  if (!resolvedClass) return null;
  const pid = await windowPid(target, context.timeoutMs);
  const minimized = await windowMinimized(target, context.timeoutMs);
  return buildWindowRecord({
    handle: target,
    title: name.ok ? String(name.stdout).trim() : null,
    process_id: pid.pid,
    class_name: resolvedClass,
    desktop: null,
    geometry: { x: values.X || 0, y: values.Y || 0, width: values.WIDTH, height: values.HEIGHT },
    visible: true,
    minimized,
    foreground: context.active && context.active.ok ? sameHandle(context.active.handle, target) : null,
    source: 'xdotool getwindowgeometry',
    title_source: name.ok ? 'xdotool getwindowname' : null,
    pid_source: pid.source,
  });
}

/** Fetch one window by handle, with its live process id. */
async function applicationByHandle(handle, options = {}) {
  const lane = advisoryLane('windows', options);
  const target = unwrapHandle(handle);
  if (!handleToInt(target)) {
    return { ok: false, error_code: 'window_handle_required', error: 'A non-zero X11 window id is required.' };
  }
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 120000, WINDOW_TOOL_TIMEOUT_MS);
  const caps = capabilities();
  const active = await activeWindowHandle(timeoutMs);

  if (caps.tools.xdotool) {
    const geometry = await runTool('xdotool', ['getwindowgeometry', '--shell', target], { timeoutMs, lane });
    if (!geometry.ok) {
      const direct = caps.tools.xprop
        ? await runTool('xprop', ['-id', target, 'WM_STATE'], { timeoutMs, lane })
        : { ok: false };
      if (!direct.ok) {
        return {
          ok: false,
          error_code: 'target_window_invalid',
          error: `The window ${target} could not be queried, so it is no longer a usable target: ${firstLine(geometry.stderr) || geometry.error}`,
        };
      }
      return {
        ok: false,
        error_code: 'window_geometry_unavailable',
        error: `The window ${target} exists but reported no geometry, so a point inside it cannot be computed.`,
      };
    }
    const values = {};
    for (const line of String(geometry.stdout).split(/\r?\n/)) {
      const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
      if (match) values[match[1]] = Number(match[2]);
    }
    if (!Number.isFinite(values.WIDTH) || !Number.isFinite(values.HEIGHT) || values.WIDTH <= 0 || values.HEIGHT <= 0) {
      return { ok: false, error_code: 'window_geometry_unavailable', error: `The window ${target} reported a zero-size geometry.` };
    }
    const name = await runTool('xdotool', ['getwindowname', target], { timeoutMs, lane });
    const className = await runTool('xdotool', ['getwindowclassname', target], { timeoutMs, lane });
    const pid = await windowPid(target, timeoutMs);
    const minimized = await windowMinimized(target, timeoutMs);
    const geometryBox = { x: values.X || 0, y: values.Y || 0, width: values.WIDTH, height: values.HEIGHT };
    const frameRect = await windowFrameRect(target, geometryBox, timeoutMs);
    return {
      ok: true,
      application: buildWindowRecord({
        handle: target,
        title: name.ok ? String(name.stdout).trim() : null,
        process_id: pid.pid,
        class_name: className.ok ? String(className.stdout).trim() : null,
        desktop: null,
        geometry: geometryBox,
        frame_rect: frameRect,
        visible: true,
        minimized,
        foreground: active.ok ? sameHandle(active.handle, target) : null,
        source: 'xdotool getwindowgeometry',
        title_source: name.ok ? 'xdotool getwindowname' : null,
        pid_source: pid.source,
      }),
    };
  }

  if (caps.tools.wmctrl) {
    const listed = await runTool('wmctrl', ['-lGpx'], { timeoutMs, lane });
    if (!listed.ok) {
      return {
        ok: false,
        error_code: listed.error_code === 'missing_tool' ? 'missing_backend_tool' : 'window_enumeration_failed',
        error: `wmctrl -lGpx failed while resolving ${target}: ${tail(listed.stderr) || listed.error}`,
      };
    }
    const row = parseWmctrlRows(listed.stdout).find(item => sameHandle(item.handle, target));
    if (!row) {
      return { ok: false, error_code: 'target_window_invalid', error: `The window ${target} is not in the window manager's client list any more.` };
    }
    const tailParts = splitWmctrlTail(row.tail);
    const minimized = await windowMinimized(target, timeoutMs);
    return {
      ok: true,
      application: buildWindowRecord({
        handle: target,
        title: tailParts.title,
        process_id: row.process_id,
        class_name: tailParts.class_name,
        desktop: row.desktop,
        geometry: row.geometry,
        visible: true,
        minimized,
        foreground: active.ok ? sameHandle(active.handle, target) : null,
        source: 'wmctrl -lGpx',
        title_source: 'wmctrl -lGpx tail',
        pid_source: 'wmctrl -lGpx -p',
      }),
    };
  }

  return {
    ok: false,
    error_code: 'missing_backend_tool',
    tool: 'wmctrl',
    capability: 'windows',
    tool_chain: [...TOOL_CHAINS.windows],
    missing_tools: TOOL_CHAINS.windows.filter(name => !caps.tools[name]),
    error: `No window backend is available: none of ${TOOL_CHAINS.windows.join(', ')} is installed or on PATH.`,
  };
}

/**
 * Resolve the target of an app-scoped action: an explicit window id, a title or class match, or
 * the foreground window. The virtual branch of the Windows sibling is absent on purpose: there
 * is no virtual delivery here, and a virtual request never reaches this function.
 */
async function resolveApplication(options = {}) {
  const explicitHandle = handleHex(options.windowHandle || options.window_handle);
  if (explicitHandle) {
    const resolved = await applicationByHandle(explicitHandle, options);
    if (!resolved.ok) {
      return { ok: false, applications: [], error_code: resolved.error_code, error: resolved.error, extra: toolFields(resolved) };
    }
    return { ok: true, application: resolved.application };
  }
  const enumerated = await enumerateApplications({ ...options, virtualScope: false, includeMinimized: options.includeMinimized === true });
  if (!enumerated.ok) {
    return { ok: false, applications: [], error_code: enumerated.error_code, error: enumerated.error, extra: toolFields(enumerated) };
  }
  const applications = enumerated.applications;
  const target = String(options.appTarget || options.app_target || '').trim();
  if (!target) {
    const foreground = applications.find(app => app.foreground === true);
    if (foreground) return { ok: true, application: foreground };
    return {
      ok: false,
      applications,
      error_code: 'foreground_window_unavailable',
      error: 'No foreground window is available to act on: the window manager did not publish an active window, or none of the listed windows is active.',
    };
  }
  const wanted = target.toLowerCase();
  const wantedHandle = handleHex(target);
  let matches = wantedHandle ? applications.filter(app => sameHandle(app.handle, wantedHandle)) : [];
  if (!matches.length) matches = applications.filter(app => String(app.title || '').toLowerCase().includes(wanted));
  if (!matches.length) matches = applications.filter(app => String(app.class_name || '').toLowerCase().includes(wanted));
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

/**
 * Re-verify a target window immediately before any input: it must still exist, and the process
 * id read back from the window must still be the process id this action resolved. A window
 * whose owner cannot be read is refused rather than typed into.
 */
async function verifyTargetWindow(application, options = {}) {
  const handle = unwrapHandle(application.handle);
  if (!handleToInt(handle)) {
    return { ok: false, error_code: 'window_handle_required', error: 'A non-zero X11 window id is required before any input.' };
  }
  const verified = await applicationByHandle(handle, options);
  if (verified.ok !== true) {
    return {
      ok: false,
      error_code: verified.error_code === 'window_geometry_unavailable' ? 'target_window_invalid' : verified.error_code,
      error: verified.error,
      extra: toolFields(verified),
      verification: { handle, exists: false },
    };
  }
  const refreshed = verified.application;
  const expected = Number(application.process_id) || 0;
  const actual = Number(refreshed.process_id) || 0;
  if (refreshed.minimized === true) {
    return {
      ok: false,
      error_code: 'window_minimized',
      error: 'The target window is iconified, so it has no presentation to act on.',
      verification: { handle, exists: true, minimized: true, process_id: actual },
    };
  }
  if (expected > 0 && actual > 0 && expected !== actual) {
    return {
      ok: false,
      error_code: 'target_window_ownership_changed',
      error: `The window ${handle} is owned by process ${actual}, not by the process ${expected} this action resolved, so the input was refused.`,
      verification: { handle, exists: true, expected_process_id: expected, process_id: actual },
    };
  }
  if (actual <= 0) {
    return {
      ok: false,
      error_code: 'target_window_unverifiable',
      error: `The window ${handle} did not report an owning process id (_NET_WM_PID), so it cannot be verified as the window this action resolved; no input was delivered.`,
      verification: { handle, exists: true, expected_process_id: expected, process_id: null },
    };
  }
  return {
    ok: true,
    application: refreshed,
    verification: { handle, exists: true, process_id: actual, source: refreshed.pid_source, re_resolved: true },
  };
}

/** Resolve and verify in one step, returning either a verified window or a structured refusal. */
async function resolveVerifiedTarget(action, options) {
  const resolved = await resolveApplication(options);
  if (resolved.ok !== true) {
    return {
      ok: false,
      result: failure(action, resolved.error_code || 'app_target_not_found', resolved.error, {
        ...(resolved.extra || {}),
        applications: (resolved.applications || []).slice(0, 20),
      }),
    };
  }
  const verified = await verifyTargetWindow(resolved.application, options);
  if (verified.ok !== true) {
    return {
      ok: false,
      result: failure(action, verified.error_code, verified.error, {
        ...(verified.extra || {}),
        app: resolved.application,
        verification: verified.verification,
      }),
    };
  }
  return { ok: true, application: verified.application, verification: verified.verification };
}

/** Containment: a delivered point must lie inside the target window's client geometry. */
function containmentRefusal(action, application, point, header) {
  const geometry = application.geometry || application.client_rect;
  if (pointInsideRect(geometry, point.x, point.y)) return null;
  const box = normalizeRect(geometry);
  return failure(action, 'point_outside_window', `The point ${point.x},${point.y} lies outside the target window client area (${box.x},${box.y},${box.width}x${box.height}); the ${action} was refused instead of being delivered elsewhere.`, {
    ...header,
    app: application,
    point: { x: point.x, y: point.y },
    window_geometry: box,
    physical_delivery_used: false,
  });
}

/** app-scoped x/y: a fraction of the client area, or a pixel offset inside it. */
function appScopedPoint(application, x, y) {
  const nx = Number(x);
  const ny = Number(y);
  const client = application.client_rect || application.geometry || { x: 0, y: 0, width: 0, height: 0 };
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return { x: Math.round(client.x + client.width / 2), y: Math.round(client.y + client.height / 2) };
  }
  const relativeX = nx >= 0 && nx <= 1;
  const relativeY = ny >= 0 && ny <= 1;
  const px = relativeX ? client.x + Math.round(client.width * nx) : client.x + Math.round(nx);
  const py = relativeY ? client.y + Math.round(client.height * ny) : client.y + Math.round(ny);
  if (px < client.x || px > client.x + client.width || py < client.y || py > client.y + client.height) {
    return { x: px, y: py, error: 'app-scoped x/y is outside the selected application window client area.' };
  }
  return { x: px, y: py };
}

/* --- target ids --------------------------------------------------- *
 * Linux has no accessibility control tree in this port, so a target id names a *window*: the
 * id is derived the same way the sibling derives a control id (a hash of the stable identity
 * fields and the bucketed geometry), which keeps an id steady across observations while the
 * window stays put.
 * ------------------------------------------------------------------ */

function stableTargetId(window) {
  const parts = [
    normalizeText(window.title),
    normalizeText(window.class_name),
    String(Number(window.process_id) || 0),
    String(bucket(window.geometry ? window.geometry.x : 0)),
    String(bucket(window.geometry ? window.geometry.y : 0)),
    String(bucket(window.geometry ? window.geometry.width : 0, 24)),
    String(bucket(window.geometry ? window.geometry.height : 0, 24)),
  ];
  return `cu-${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`;
}

function windowRisk(window) {
  const marker = `${window.title || ''} ${window.class_name || ''}`.toLowerCase();
  return /delete|remove|format|reset|shutdown|close|付款|支付|删除|移除|重置/.test(marker) ? 'medium' : 'low';
}

function registerWindowTargets(applications, ownerId) {
  const registry = targetRegistry(ownerId);
  for (const application of applications) {
    const targetId = stableTargetId(application);
    const center = centerOf(application.geometry);
    registry.set(targetId, {
      target_id: targetId,
      x: center.x,
      y: center.y,
      rect: normalizeRect(application.geometry),
      name: application.title,
      control_type: 'Window',
      risk: windowRisk(application),
      window_handle: unwrapHandle(application.handle),
      process_id: Number(application.process_id) || 0,
      role: 'window',
    });
  }
  if (registry.size > MAX_REGISTERED_TARGETS) {
    const excess = [...registry.keys()].slice(0, registry.size - MAX_REGISTERED_TARGETS);
    for (const key of excess) registry.delete(key);
  }
  return registry.size;
}

function resolveTargetId(targetId, ownerId) {
  const key = String(targetId || '').trim();
  if (!key) return null;
  const entry = targetRegistry(ownerId).get(key);
  if (entry) return { ...entry, ok: true };
  return { ok: false, error_code: 'target_id_unknown', error: `Unknown target_id ${key}; call app_list, observe or app_observe again before acting on it.` };
}

/** The scene fingerprint: the window set and its bucketed geometry, never a pixel guess. */
function sceneGeneration(applications) {
  const windowPart = applications
    .map(app => `${app.handle}|${Number(app.process_id) || 0}|${app.geometry ? `${app.geometry.x},${app.geometry.y},${app.geometry.width},${app.geometry.height}` : ''}|${app.foreground ? 'fg' : ''}`)
    .sort()
    .join(';');
  return crypto.createHash('sha1').update(windowPart).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * 6. capture, the 32x18 digest, full and sparse observation
 * ------------------------------------------------------------------ */

function captureDirectory() {
  const directory = path.join(os.tmpdir(), CAPTURE_DIRECTORY_NAME);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function capturePath(ownerId, kind) {
  const nonce = crypto.randomBytes(4).toString('hex');
  return path.join(captureDirectory(), `${kind}-${crypto.createHash('sha1').update(String(ownerId)).digest('hex').slice(0, 8)}-${Date.now()}-${nonce}.png`);
}

function statImage(imagePath) {
  try {
    const stat = fs.statSync(imagePath);
    if (!stat.isFile()) {
      return { ok: false, error_code: 'capture_failed', error: `The capture tool did not write a file at ${imagePath}.` };
    }
    if (stat.size <= 0) {
      return { ok: false, error_code: 'capture_failed', error: `The capture file at ${imagePath} is zero bytes, so it is not a real desktop presentation.` };
    }
    return { ok: true, bytes: stat.size };
  } catch (error) {
    return { ok: false, error_code: 'capture_failed', error: `No capture file exists at ${imagePath}: ${messageOf(error)}` };
  }
}

function pngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height, format: 'png' } : null;
}

function jpegDimensions(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height, format: 'jpeg' } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** Image size: the header first, then a real tool. Never a guess. */
async function imageDimensions(imagePath, buffer, timeoutMs) {
  const header = pngDimensions(buffer) || jpegDimensions(buffer);
  if (header) return { ok: true, ...header, source: 'file-header' };
  const caps = capabilities();
  for (const tool of TOOL_CHAINS.dimensions) {
    if (!caps.tools[tool]) continue;
    const args = tool === 'ffprobe'
      ? ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', imagePath]
      : tool === 'identify'
        ? ['-format', '%w %h', imagePath]
        : ['identify', '-format', '%w %h', imagePath];
    const result = await runTool(tool, args, { timeoutMs, lane: 'window_capture' });
    if (!result.ok) continue;
    const match = /(\d+)\s*[x ]\s*(\d+)/.exec(String(result.stdout));
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0) return { ok: true, width, height, format: 'unknown', source: tool };
  }
  return {
    ok: false,
    error_code: 'capture_dimensions_unavailable',
    error: `The capture at ${imagePath} is not a PNG or JPEG with a readable header, and none of ${TOOL_CHAINS.dimensions.join(', ')} could measure it.`,
    tool_chain: [...TOOL_CHAINS.dimensions],
  };
}

/**
 * The 32x18 grayscale digest, measured with the same recipe as the Windows sibling: resize to
 * the grid with a bilinear filter, take luma, and hash the 576 bytes. A digest that is not
 * exactly 576 bytes is a hard error, because a short read would silently compare nonsense.
 */
async function digest32x18FromImage(imagePath, timeoutMs) {
  const caps = capabilities();
  const tool = caps.backend.digest;
  const expected = SPARSE_DIGEST_WIDTH * SPARSE_DIGEST_HEIGHT;
  if (!tool) {
    return {
      ok: false,
      error_code: 'missing_backend_tool',
      tool: TOOL_CHAINS.digest[0],
      tool_chain: [...TOOL_CHAINS.digest],
      missing_tools: TOOL_CHAINS.digest.filter(name => !caps.tools[name]),
      capability: 'digest',
      error: `No image digest backend is available: none of ${TOOL_CHAINS.digest.join(', ')} is installed or on PATH, so no 32x18 grayscale digest can be measured.`,
    };
  }
  const args = tool === 'ffmpeg'
    ? ['-v', 'error', '-i', imagePath, '-vf', `scale=${SPARSE_DIGEST_WIDTH}:${SPARSE_DIGEST_HEIGHT}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-']
    : [imagePath, '-filter', 'Triangle', '-resize', `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}!`, '-colorspace', 'Gray', '-depth', '8', 'gray:-'];
  const result = await runTool(tool, args, { timeoutMs, lane: 'sparse' });
  if (!result.ok) {
    return {
      ok: false,
      error_code: result.error_code === 'missing_tool' ? 'missing_backend_tool' : 'digest_failed',
      tool,
      error: `The digest backend ${tool} failed on ${imagePath}: ${firstLine(result.stderr) || result.error}`,
      stderr: tail(result.stderr),
    };
  }
  const raw = result.stdoutBuffer;
  if (!raw || raw.length !== expected) {
    return {
      ok: false,
      error_code: 'digest_failed',
      tool,
      error: `The digest backend ${tool} returned ${raw ? raw.length : 0} bytes instead of the ${expected} bytes of a ${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT} grayscale grid.`,
    };
  }
  const luma = Array.from(raw);
  let minimum = 255;
  let maximum = 0;
  const distinct = new Set();
  for (const value of luma) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    distinct.add(value);
  }
  return {
    ok: true,
    tool,
    luma,
    digest: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16),
    distinct_luma: distinct.size,
    luma_min: minimum,
    luma_max: maximum,
  };
}

/* --- capture plans ------------------------------------------------ */

function displayBase() {
  const display = String(process.env.DISPLAY || '').trim();
  if (!display) return '';
  return display.replace(/\+\d+,\d+$/, '');
}

/** The f-keys stay even: x11grab refuses an odd capture size. */
function evenDimension(value) {
  const numeric = Math.max(2, Math.floor(Number(value) || 0));
  return numeric % 2 === 0 ? numeric : numeric - 1;
}

/**
 * Which installed capture tool can address this window, in the documented chain order.
 * The focused-window tools are only usable when the target is the active window; the window
 * grabber addresses one window id exactly; the region grabber needs an X11 display. The chain
 * order decides preference, not correctness, and the tool that actually ran is reported.
 */
function captureAttempts(application, outPath, options) {
  const caps = capabilities();
  const attempts = [];
  const resize = options.resize !== false;
  const maxWidth = clampNumber(options.maxWidth ?? options.captureMaxWidth, 320, 2048, 1280);
  const maxHeight = clampNumber(options.maxHeight ?? options.captureMaxHeight, 240, 2048, 960);
  const handle = unwrapHandle(application.handle);
  const focused = application.foreground === true;
  const base = displayBase();
  const box = normalizeRect(application.geometry || application.client_rect);

  if (caps.tools['gnome-screenshot'] && focused) {
    attempts.push({
      tool: 'gnome-screenshot',
      args: ['-w', '-f', outPath],
      method: 'gnome-screenshot -w (focused window)',
      exact_window: true,
      resize: false,
    });
  }
  if (caps.tools.scrot && focused) {
    attempts.push({ tool: 'scrot', args: ['-u', outPath], method: 'scrot -u (focused window)', exact_window: true, resize: false });
  }
  if (caps.tools.import) {
    const args = ['-window', handle];
    if (resize) args.push('-resize', `${maxWidth}x${maxHeight}>`);
    args.push(outPath);
    attempts.push({
      tool: 'import',
      args,
      method: `import -window ${handle}${resize ? ` -resize ${maxWidth}x${maxHeight}>` : ''}`,
      exact_window: true,
      resize,
    });
  }
  if (caps.tools.ffmpeg && base && box.width > 1 && box.height > 1) {
    const width = evenDimension(box.width);
    const height = evenDimension(box.height);
    attempts.push({
      tool: 'ffmpeg',
      args: [
        '-y', '-v', 'error', '-f', 'x11grab',
        '-video_size', `${width}x${height}`,
        '-i', `${base}+${Math.floor(box.x)},${Math.floor(box.y)}`,
        '-frames:v', '1', outPath,
      ],
      method: `ffmpeg -f x11grab -video_size ${width}x${height} -i ${base}+${Math.floor(box.x)},${Math.floor(box.y)}`,
      exact_window: false,
      resize: false,
    });
  }
  return attempts;
}

/** Capture one window into one file. Every failure names the tool that failed and why. */
async function captureToFile(application, outPath, options = {}) {
  const caps = capabilities();
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, CAPTURE_TIMEOUT_MS);
  const attempts = captureAttempts(application, outPath, options);
  if (!attempts.length) {
    const chain = TOOL_CHAINS.capture;
    const missing = chain.filter(name => !caps.tools[name]);
    if (missing.length === chain.length) {
      return {
        ok: false,
        error_code: 'missing_backend_tool',
        tool: chain[0],
        tool_chain: [...chain],
        missing_tools: missing,
        capability: 'capture',
        error: `No capture backend is available: none of ${chain.join(', ')} is installed or on PATH.`,
      };
    }
    return {
      ok: false,
      error_code: 'capture_window_unsupported',
      tool_chain: [...chain],
      available_tools: chain.filter(name => caps.tools[name]),
      error: `The installed capture tools (${chain.filter(name => caps.tools[name]).join(', ')}) cannot address window ${unwrapHandle(application.handle)}: the focused-window grabbers only capture the active window, and the region grabber needs an X11 DISPLAY.`,
    };
  }
  const failures = [];
  for (const attempt of attempts) {
    try { fs.rmSync(outPath, { force: true }); } catch { /* nothing to remove */ }
    const result = await runTool(attempt.tool, attempt.args, { timeoutMs, lane: 'window_capture' });
    if (result.ok) {
      const stat = statImage(outPath);
      if (stat.ok) {
        return {
          ok: true,
          tool: attempt.tool,
          method: attempt.method,
          exact_window: attempt.exact_window === true,
          resize_applied: attempt.resize === true,
          image_bytes: stat.bytes,
        };
      }
      failures.push({ tool: attempt.tool, error_code: stat.error_code, error: stat.error });
      continue;
    }
    failures.push({
      tool: attempt.tool,
      error_code: result.error_code,
      error: result.error,
      stderr: firstLine(result.stderr),
    });
  }
  const firstMissing = failures.find(item => item.error_code === 'missing_tool');
  return {
    ok: false,
    error_code: firstMissing ? 'missing_backend_tool' : 'capture_failed',
    error: `Every available capture tool failed for window ${unwrapHandle(application.handle)}: ${failures.map(item => `${item.tool}: ${item.error}`).join(' | ')}`,
    failures,
  };
}

/** The image type of a real capture: the measured format first, the requested extension second. */
function imageMime(format, imagePath) {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  const extension = path.extname(String(imagePath || '')).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Full observation of the **whole screen**, the Linux half of the same capability the
 * Windows backend answers with a screen-DC copy.
 *
 * It resolves no window: the point of the request is the screen, not a window on it. Every
 * entry in the chain addresses the root window or the full display - `import -window root`,
 * `gnome-screenshot` without a window flag, `scrot` without `-u`, and `ffmpeg`'s x11grab
 * over the whole display - so a screen request can never be answered with the foreground
 * window, which is exactly the defect this replaces on the Windows sibling.
 *
 * The reported bounds are the captured image's own, measured from the file, so the answer
 * says what was really copied rather than what was asked for.
 */
export async function captureScreen(options = {}) {
  const action = String(options.action || 'capture_screen');
  const blocked = displayGuard(action) || toolGuard(action, 'capture') || toolGuard(action, 'digest');
  if (blocked) return blocked;
  const caps = capabilities();
  const chain = TOOL_CHAINS.screen_capture;
  const available = chain.filter(name => caps.tools[name]);
  if (!available.length) {
    return failure(action, 'missing_backend_tool', `No whole-screen capture backend is available: none of ${chain.join(', ')} is installed or on PATH.`, {
      tool_chain: [...chain],
      missing_tools: [...chain],
      capability: 'screen_capture',
    });
  }
  const ownerId = String(options.ownerId || 'direct');
  const outPath = options.imagePath || options.image_path || capturePath(ownerId, 'screen');
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, CAPTURE_TIMEOUT_MS);
  const base = displayBase();
  const maxWidth = clampNumber(options.maxWidth ?? options.captureMaxWidth, 320, 2048, 1280);
  const maxHeight = clampNumber(options.maxHeight ?? options.captureMaxHeight, 240, 2048, 960);
  const startedAt = Date.now();
  const attempts = [];
  for (const tool of chain) {
    if (!caps.tools[tool]) continue;
    if (tool === 'import') attempts.push({ tool, args: ['-window', 'root', outPath], method: 'import -window root' });
    else if (tool === 'gnome-screenshot') attempts.push({ tool, args: ['-f', outPath], method: 'gnome-screenshot (whole screen)' });
    else if (tool === 'scrot') attempts.push({ tool, args: [outPath], method: 'scrot (whole screen)' });
    else if (tool === 'ffmpeg' && base) attempts.push({
      tool,
      args: ['-y', '-v', 'error', '-f', 'x11grab', '-i', base, '-frames:v', '1', outPath],
      method: `ffmpeg -f x11grab -i ${base}`,
    });
  }
  const failures = [];
  for (const attempt of attempts) {
    try { fs.rmSync(outPath, { force: true }); } catch { /* nothing to remove */ }
    const result = await runTool(attempt.tool, attempt.args, { timeoutMs, lane: 'window_capture' });
    if (!result.ok) {
      failures.push({ tool: attempt.tool, error_code: result.error_code, error: result.error, stderr: firstLine(result.stderr) });
      continue;
    }
    const stat = statImage(outPath);
    if (!stat.ok) {
      failures.push({ tool: attempt.tool, error_code: stat.error_code, error: stat.error });
      continue;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(outPath);
    } catch (error) {
      failures.push({ tool: attempt.tool, error_code: 'capture_failed', error: `the capture at ${outPath} could not be read back: ${messageOf(error)}` });
      continue;
    }
    const dimensions = await imageDimensions(outPath, buffer, timeoutMs);
    if (dimensions.ok !== true) {
      failures.push({ tool: attempt.tool, error_code: dimensions.error_code, error: dimensions.error });
      continue;
    }
    const digest = await digest32x18FromImage(outPath, timeoutMs);
    if (digest.ok !== true) {
      failures.push({ tool: attempt.tool, error_code: digest.error_code, error: digest.error });
      continue;
    }
    const width = Number(dimensions.width) || 0;
    const height = Number(dimensions.height) || 0;
    if (width <= 0 || height <= 0) {
      failures.push({ tool: attempt.tool, error_code: 'capture_zero_size', error: 'the capture reported a zero-size presentation' });
      continue;
    }
    if (digest.distinct_luma <= 1) {
      failures.push({ tool: attempt.tool, error_code: 'capture_monochrome', error: 'the capture was a single flat colour' });
      continue;
    }
    return {
      ok: true,
      action,
      lane: 'window_capture',
      image_path: outPath,
      imagePath: outPath,
      image_mime: imageMime(dimensions.format, outPath),
      width,
      height,
      image_width: width,
      image_height: height,
      image_bytes: stat.bytes,
      image_mime_measured: dimensions.format,
      /* The screen, not a window and not a region of one: the reader can tell which. */
      target_scope: 'screen',
      capture_scope: 'whole-display',
      capture_method: attempt.method,
      resize_applied: false,
      requested_max_width: maxWidth,
      requested_max_height: maxHeight,
      digest: {
        width: SPARSE_DIGEST_WIDTH,
        height: SPARSE_DIGEST_HEIGHT,
        sha256_prefix: digest.digest,
        luma_min: digest.luma_min,
        luma_max: digest.luma_max,
        distinct_luma: digest.distinct_luma,
      },
      digest32x18: digest.digest,
      digest32x18_geometry: `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}-grayscale`,
      digest_tool: digest.tool,
      ...backendReport(attempt.tool),
      telemetry: { capture_ms: Date.now() - startedAt, lane: 'window_capture', width_source: dimensions.source },
    };
  }
  try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
  return failure(action, 'capture_screen_failed', `Every whole-screen capture backend failed: ${failures.map(item => `${item.tool}: ${item.error}`).join(' | ')}`, {
    lane: 'window_capture',
    tool_chain: [...chain],
    available_tools: available,
    failures,
  });
}

/**
 * Full observation of one window: capture a real image, then measure the 32x18 digest. A
 * zero-byte, missing or single-colour capture is a hard error, never a silent empty image.
 */
export async function captureWindow(options = {}) {
  const action = String(options.action || 'observe');
  const handle = handleHex(options.handle || options.windowHandle || options.window_handle);
  if (!handle) return failure(action, 'window_handle_required', 'A non-zero X11 window id is required for capture.');
  const blocked = displayGuard(action) || toolGuard(action, 'capture') || toolGuard(action, 'digest');
  if (blocked) return blocked;

  const resolved = await applicationByHandle(handle, options);
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code, resolved.error, { window_handle: unwrapHandle(handle) });
  }
  const application = resolved.application;
  if (application.minimized === true) {
    return failure(action, 'window_minimized', 'An iconified window has no capturable presentation.', { window_handle: application.handle, app: application });
  }

  const ownerId = String(options.ownerId || 'direct');
  const outPath = options.imagePath || options.image_path || capturePath(ownerId, 'observe');
  const startedAt = Date.now();
  const captured = await captureToFile(application, outPath, {
    ...options,
    maxWidth: options.maxWidth ?? options.captureMaxWidth,
    maxHeight: options.maxHeight ?? options.captureMaxHeight,
    resize: options.resize,
  });
  if (captured.ok !== true) {
    try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
    return failure(action, captured.error_code, captured.error, {
      lane: 'window_capture',
      window_handle: application.handle,
      app: application,
      ...backendReport(captured.tool || null),
      ...(captured.tool_chain ? { tool_chain: captured.tool_chain, missing_tools: captured.missing_tools || [] } : {}),
      ...(captured.failures ? { failures: captured.failures } : {}),
      telemetry: { capture_ms: Date.now() - startedAt, lane: 'window_capture' },
    });
  }

  const stat = statImage(outPath);
  if (stat.ok !== true) {
    return failure(action, stat.error_code, stat.error, { lane: 'window_capture', window_handle: application.handle });
  }
  let buffer;
  try {
    buffer = fs.readFileSync(outPath);
  } catch (error) {
    return failure(action, 'capture_failed', `The capture file at ${outPath} could not be read back: ${messageOf(error)}`, { lane: 'window_capture' });
  }
  const dimensions = await imageDimensions(outPath, buffer, clampNumber(options.timeoutMs, 1000, 300000, DIGEST_TIMEOUT_MS));
  if (dimensions.ok !== true) {
    return failure(action, dimensions.error_code, dimensions.error, { lane: 'window_capture', window_handle: application.handle });
  }
  const digest = await digest32x18FromImage(outPath, clampNumber(options.timeoutMs, 1000, 300000, DIGEST_TIMEOUT_MS));
  if (digest.ok !== true) {
    return failure(action, digest.error_code, digest.error, {
      lane: 'window_capture',
      window_handle: application.handle,
      ...(digest.tool ? { tool: digest.tool } : {}),
      ...(digest.tool_chain ? { tool_chain: digest.tool_chain, missing_tools: digest.missing_tools || [] } : {}),
    });
  }
  if (digest.distinct_luma <= 1) {
    try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
    return failure(action, 'capture_monochrome', 'The capture was a single flat colour, so it is not a real desktop presentation.', {
      lane: 'window_capture',
      window_handle: application.handle,
      capture_method: captured.method,
    });
  }
  const width = Number(dimensions.width) || 0;
  const height = Number(dimensions.height) || 0;
  if (width <= 0 || height <= 0) {
    return failure(action, 'capture_zero_size', 'The capture reported a zero-size presentation, so it is not a usable observation.', { lane: 'window_capture' });
  }

  return {
    ok: true,
    action,
    lane: 'window_capture',
    image_path: outPath,
    imagePath: outPath,
    width,
    height,
    image_width: width,
    image_height: height,
    image_bytes: stat.bytes,
    bytes: stat.bytes,
    image_mime: imageMime(dimensions.format, outPath),
    capture_method: captured.method,
    capture_scope: captured.exact_window ? 'window' : 'window-region',
    resize_applied: captured.resize_applied === true,
    digest: {
      width: SPARSE_DIGEST_WIDTH,
      height: SPARSE_DIGEST_HEIGHT,
      sha256_prefix: digest.digest,
      luma_min: digest.luma_min,
      luma_max: digest.luma_max,
      distinct_luma: digest.distinct_luma,
    },
    digest32x18: digest.digest,
    digest32x18_geometry: `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}-grayscale`,
    digest_tool: digest.tool,
    window_handle: application.handle,
    app: application,
    ...backendReport(captured.tool),
    telemetry: { capture_ms: Date.now() - startedAt, lane: 'window_capture', width_source: dimensions.source },
  };
}

/** One sparse sample: a real capture of the window, digested to the 32x18 grid. */
async function sparseDigestSample(application, options) {
  const ownerId = String(options.ownerId || 'direct');
  const samplePath = capturePath(ownerId, 'sparse');
  try {
    const captured = await captureToFile(application, samplePath, { ...options, resize: false });
    if (captured.ok !== true) return { ok: false, error_code: captured.error_code, error: captured.error };
    const digest = await digest32x18FromImage(samplePath, clampNumber(options.timeoutMs, 1000, 300000, DIGEST_TIMEOUT_MS));
    if (digest.ok !== true) return { ok: false, error_code: digest.error_code, error: digest.error };
    return { ok: true, luma: digest.luma, digest: digest.digest, distinct_luma: digest.distinct_luma };
  } finally {
    // A sparse sample is ephemeral by contract: the frame never outlives the measurement.
    try { fs.rmSync(samplePath, { force: true }); } catch { /* ignore */ }
  }
}

function lumaArray(value) {
  if (Array.isArray(value)) return value.map(item => clampNumber(item, 0, 255, 0));
  return String(value === null || value === undefined ? '' : value)
    .split(',')
    .map(item => clampNumber(item, 0, 255, 0));
}

function compareLuma(baseline, luma) {
  let changedCells = 0;
  let strongCells = 0;
  let digestDelta = 0;
  const cells = Math.min(baseline.length, luma.length);
  for (let index = 0; index < cells; index += 1) {
    const delta = Math.abs(luma[index] - baseline[index]);
    digestDelta += delta;
    if (delta >= SPARSE_CELL_THRESHOLD) changedCells += 1;
    if (delta >= SPARSE_STRONG_THRESHOLD) strongCells += 1;
  }
  return { changedCells, strongCells, digestDelta, cells };
}

/** The sparse envelope every sparse result carries, refusal or not. */
function sparseBase(action, options, mode) {
  const handle = handleHex(options.windowHandle || options.window_handle || options.handle);
  const effectiveMode = mode && mode.mode ? mode.mode : (options.mouseMode === 'virtual' ? 'virtual' : 'real');
  return {
    ok: true,
    action,
    observation: 'sparse',
    mouse_mode: effectiveMode,
    must_reacquire_full_observation: true,
    sparse_digest: `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}-grayscale`,
    sparse_wait_ms: clampNumber(options.sparseWaitMs ?? options.sparse_wait_ms, 0, SPARSE_MAX_WAIT_MS, 0),
    sparse_max_wait_ms: SPARSE_MAX_WAIT_MS,
    sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
    window_handle: handle ? unwrapHandle(handle) : undefined,
  };
}

function sparseRequested(options) {
  return options.observation === 'sparse' || options.sparse === true
    || options.sparseWaitMs !== undefined || options.sparse_wait_ms !== undefined;
}

/**
 * Sparse observation as one action: the envelope survives every refusal, so a caller can always
 * read `must_reacquire_full_observation` and the requested wait even when nothing was sampled.
 */
async function sparseAction(action, options, mode) {
  const base = sparseBase(action, options, mode);
  const blocked = displayGuard(action) || toolGuard(action, 'capture') || toolGuard(action, 'digest');
  if (blocked) {
    return { ...base, ...blocked, ok: false, changed: false, samples: 0, reason: blocked.error_code };
  }
  const resolved = await resolveApplication({ ...options, virtualScope: false });
  if (resolved.ok !== true) {
    const code = resolved.error_code || 'window_unavailable';
    return {
      ...base,
      ok: false,
      changed: false,
      samples: 0,
      reason: code,
      code,
      error_code: code,
      error: resolved.error,
      applications: (resolved.applications || []).slice(0, 20),
      ...(resolved.extra || {}),
    };
  }
  const sparse = await sparseObservation({
    ...options,
    action,
    mouseMode: mode.mode,
    windowHandle: resolved.application.handle,
    processId: resolved.application.process_id,
  });
  return { ...sparse, must_reacquire_full_observation: true, app: resolved.application };
}

/**
 * Sparse observation: passive bounded sampling of the 32x18 grayscale digest, at most 5 Hz.
 * The result is a wake-up hint only: it always says the caller must re-acquire a full
 * observation, whatever it reports.
 */
export async function sparseObservation(options = {}) {
  const action = String(options.action || 'observe');
  const handle = handleHex(options.windowHandle || options.window_handle || options.handle);
  const waitMs = clampNumber(options.sparseWaitMs ?? options.sparse_wait_ms, 0, SPARSE_MAX_WAIT_MS, 0);
  const signal = options.signal;
  const lane = 'sparse';
  const base = sparseBase(action, options);
  if (signal && signal.aborted) return cancelledResult(action, signal, { ...base, ok: false });
  if (!handle) {
    return {
      ...base,
      ok: false,
      changed: false,
      samples: 0,
      reason: 'window_handle_required',
      code: 'window_handle_required',
      error_code: 'window_handle_required',
      error: 'Sparse observation needs a target window: pass window_handle or app_target, or observe with a foreground window available.',
    };
  }
  const blocked = displayGuard(action) || toolGuard(action, 'capture') || toolGuard(action, 'digest');
  if (blocked) return { ...blocked, ...base, ok: false, changed: false, samples: 0, reason: blocked.error_code };

  const resolved = await applicationByHandle(handle, options);
  if (resolved.ok !== true) {
    return { ...base, ok: false, changed: false, samples: 0, reason: resolved.error_code, code: resolved.error_code, error_code: resolved.error_code, error: resolved.error };
  }
  const application = resolved.application;
  if (application.minimized === true) {
    return { ...base, ok: false, changed: false, samples: 0, reason: 'window_minimized', code: 'window_minimized', error_code: 'window_minimized', error: 'An iconified window has no presentation to sample.' };
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
    const sample = await sparseDigestSample(application, { ...options, action });
    if (sample.ok !== true) {
      reason = 'sampling_failed';
      lastError = { error_code: sample.error_code, error: sample.error };
      break;
    }
    const luma = lumaArray(sample.luma);
    samples += 1;
    lastSampleAt = Date.now();
    if (!baseline) {
      baseline = luma;
      lastDigest = sample.digest;
      if (waitMs === 0 || samples >= maxSamples) break;
      continue;
    }
    const compared = compareLuma(baseline, luma);
    changedCells = compared.changedCells;
    strongCells = compared.strongCells;
    digestDelta = compared.digestDelta;
    lastDigest = sample.digest;
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
    digest32x18: lastDigest,
    samples,
    reason,
    app: application,
    ...backendReport(),
    telemetry: {
      lane,
      sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
      sparse_wait_ms: waitMs,
      sample_cost_note: 'each sample is a real capture plus a resize, so the 200 ms floor is a rate limit rather than a guarantee',
    },
    ...(lastError || {}),
  };
}

/* ------------------------------------------------------------------ *
 * 7. real input delivery, behind one shared click/drag reservation queue
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

/**
 * A smooth, slightly randomised, DPI-free cursor path over roughly MOVE_CURVE_MS: a cubic
 * Bezier with a perpendicular arc and a small jitter, sampled at ten points, with the last
 * point exactly the target. X11 has no DPI coordinate space to translate, so the curve is the
 * whole of the Windows sibling's real-mode movement contract that survives the port.
 */
function interpolatedPath(from, to, options = {}) {
  const points = clampNumber(options.points, 2, 60, MOVE_CURVE_POINTS);
  const arcScale = Number.isFinite(Number(options.arcScale)) ? Number(options.arcScale) : 1;
  const jitterScale = Number.isFinite(Number(options.jitterScale)) ? Number(options.jitterScale) : 1.4;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const nx = length < 1 ? 0 : -dy / length;
  const ny = length < 1 ? 0 : dx / length;
  const random = () => crypto.randomInt(0, 1000) / 1000;
  const arc = (3 + random() * 9) * arcScale * (crypto.randomInt(0, 2) === 0 ? -1 : 1);
  const path = [];
  for (let index = 1; index <= points; index += 1) {
    const t = index / points;
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const inverse = 1 - eased;
    const p1x = from.x + dx * 0.30 + nx * arc;
    const p1y = from.y + dy * 0.30 + ny * arc;
    const p2x = from.x + dx * 0.70 + nx * arc * 0.55;
    const p2y = from.y + dy * 0.70 + ny * arc * 0.55;
    const c1 = 3 * inverse * inverse * eased;
    const c2 = 3 * inverse * eased * eased;
    const px = inverse * inverse * inverse * from.x + c1 * p1x + c2 * p2x + eased * eased * eased * to.x;
    const py = inverse * inverse * inverse * from.y + c1 * p1y + c2 * p2y + eased * eased * eased * to.y;
    const jitter = (random() - 0.5) * jitterScale * Math.sin(Math.PI * t);
    path.push(index === points
      ? { x: to.x, y: to.y }
      : { x: Math.round(px + nx * jitter), y: Math.round(py + ny * jitter) });
  }
  return path;
}

/* --- ydotool ------------------------------------------------------- *
 * Kernel-level injection needs Linux input event codes, and typing needs a keyboard layout.
 * The layout below is the US layout, which is the only one this port claims: a character that
 * is not in the table makes the whole typing request refuse before a single key is sent, so a
 * partial or wrong string can never reach the session.
 * ------------------------------------------------------------------ */

const YDOTOOL_KEYCODES = Object.freeze({
  Escape: 1, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, equal: 13, BackSpace: 14, Tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, bracketleft: 26, bracketright: 27,
  Return: 28, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, semicolon: 39, apostrophe: 40, grave: 41,
  backslash: 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, comma: 51, period: 52, slash: 53,
  space: 57,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  Home: 102, Up: 103, Prior: 104, Left: 105, Right: 106, End: 107, Down: 108, Next: 109, Insert: 110, Delete: 111,
});

const YDOTOOL_MODIFIER_KEYCODES = Object.freeze({ ctrl: 29, shift: 42, alt: 56, super: 125, meta: 126, hyper: null });

/**
 * ydotool takes a button mask, not a button number: the low nibble selects the button and the
 * two high bits ask for the press and the release. A click is therefore the mask with both bits
 * set, and a held drag needs the two halves separately.
 */
const YDOTOOL_BUTTONS = Object.freeze({
  left: Object.freeze({ click: '0xC0', down: '0x40', up: '0x80' }),
  right: Object.freeze({ click: '0xC1', down: '0x41', up: '0x81' }),
  middle: Object.freeze({ click: '0xC2', down: '0x42', up: '0x82' }),
});

function ydotoolKeyPlan(chord) {
  const parts = String(chord || '').split('+').filter(Boolean);
  if (!parts.length) return null;
  const base = parts[parts.length - 1];
  const keycode = YDOTOOL_KEYCODES[base];
  if (!keycode) return null;
  const modifierCodes = [];
  for (const part of parts.slice(0, -1)) {
    const code = YDOTOOL_MODIFIER_KEYCODES[part];
    if (!code) return null;
    if (!modifierCodes.includes(code)) modifierCodes.push(code);
  }
  const downs = [...modifierCodes.map(code => `${code}:1`), `${keycode}:1`];
  const ups = [...downs].reverse().map(token => token.replace(':1', ':0'));
  return [...downs, ...ups];
}

/* --- the three delivery backends ---------------------------------- */

function buttonName(button) {
  return button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
}

function xdotoolButton(button) {
  return button === 'right' ? '3' : button === 'middle' ? '2' : '1';
}

/** Move the real pointer to one point with the selected backend. */
async function moveToPoint(backend, point, timeoutMs) {
  if (backend === 'xdotool') {
    return await runTool('xdotool', ['mousemove', '--sync', String(point.x), String(point.y)], { timeoutMs, lane: 'action' });
  }
  if (backend === 'xte') {
    return await runTool('xte', [`mousemove ${point.x} ${point.y}`], { timeoutMs, lane: 'action' });
  }
  if (backend === 'ydotool') {
    const result = await runTool('ydotool', ['mousemove', '--absolute', '-x', String(point.x), '-y', String(point.y)], { timeoutMs, lane: 'action' });
    if (result.ok) return result;
    // Older ydotool builds take the same arguments without the explicit absolute flag.
    return await runTool('ydotool', ['mousemove', '-x', String(point.x), '-y', String(point.y)], { timeoutMs, lane: 'action' });
  }
  return { ok: false, error_code: 'missing_backend_tool', error: `No input backend is available to move the pointer.` };
}

/** Walk the interpolated path, pacing the ten steps across the curve duration. */
async function moveAlongPath(backend, path, timeoutMs) {
  const startedAt = Date.now();
  for (let index = 0; index < path.length; index += 1) {
    const result = await moveToPoint(backend, path[index], timeoutMs);
    if (!result.ok) return { ok: false, error_code: result.error_code, error: result.error, step: index, stderr: firstLine(result.stderr) };
    const targetElapsed = ((index + 1) * MOVE_CURVE_MS) / path.length;
    const remaining = targetElapsed - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }
  return { ok: true, steps: path.length, elapsed_ms: Date.now() - startedAt };
}

/** Where the real pointer is now, when the selected backend can tell us. */
async function currentPointerPosition(timeoutMs) {
  const caps = capabilities();
  if (caps.tools.xdotool) {
    const result = await runTool('xdotool', ['getmouselocation', '--shell'], { timeoutMs, lane: 'action' });
    if (result.ok) {
      const values = {};
      for (const line of String(result.stdout).split(/\r?\n/)) {
        const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
        if (match) values[match[1]] = Number(match[2]);
      }
      if (Number.isFinite(values.X) && Number.isFinite(values.Y)) return { ok: true, x: values.X, y: values.Y };
    }
  }
  return { ok: false };
}

/**
 * A path from wherever the real pointer is to the target, so a move starts at the current
 * cursor exactly as the Windows sibling's curve does. A backend that cannot report the pointer
 * position yields the degenerate path: one move to the target instead of a curve through it.
 */
async function approachPath(target, timeoutMs) {
  const current = await currentPointerPosition(timeoutMs);
  const from = current.ok ? { x: current.x, y: current.y } : target;
  return interpolatedPath(from, target);
}

async function pressButton(backend, button, down, timeoutMs) {
  const name = buttonName(button);
  if (backend === 'xdotool') {
    return await runTool('xdotool', [down ? 'mousedown' : 'mouseup', xdotoolButton(name)], { timeoutMs, lane: 'action' });
  }
  if (backend === 'xte') {
    return await runTool('xte', [down ? `mousedown ${xdotoolButton(name)}` : `mouseup ${xdotoolButton(name)}`], { timeoutMs, lane: 'action' });
  }
  if (backend === 'ydotool') {
    const masks = YDOTOOL_BUTTONS[name];
    return await runTool('ydotool', ['click', down ? masks.down : masks.up], { timeoutMs, lane: 'action' });
  }
  return { ok: false, error_code: 'missing_backend_tool', error: 'No input backend is available to press a pointer button.' };
}

/** Release a held button on a fresh call, used by the drag release guards. */
async function releaseButton(button) {
  const backend = capabilities().backend.input;
  if (!backend) return { ok: false, error_code: 'missing_backend_tool', error: 'No input backend is available to release a pointer button.' };
  return await pressButton(backend, button, false, DEFAULT_TOOL_TIMEOUT_MS);
}

/** The four X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. */
const X_WHEEL_BUTTONS = Object.freeze({ up: '4', down: '5', left: '6', right: '7' });

async function wheelClicks(backend, direction, steps, timeoutMs) {
  const code = X_WHEEL_BUTTONS[direction];
  if (!code || steps <= 0) return { ok: true, stdout: '', stderr: '', exit_code: 0, steps: 0 };
  if (backend === 'xdotool') {
    return await runTool('xdotool', ['click', '--clearmodifiers', '--repeat', String(steps), code], { timeoutMs, lane: 'action' });
  }
  if (backend === 'xte') {
    const commands = Array.from({ length: steps }, () => `mouseclick ${code}`);
    return await runTool('xte', commands, { timeoutMs, lane: 'action' });
  }
  if (backend === 'ydotool') {
    // ydotool's command surface carries buttons and keys, and no wheel event, so a scroll is
    // refused by name instead of being invented as a button the kernel input layer will ignore.
    return {
      ok: false,
      error_code: 'scroll_backend_unsupported',
      error: 'ydotool exposes no wheel event, so scrolling cannot be delivered through it; install xdotool or xte for a session that needs scrolling.',
    };
  }
  return { ok: false, error_code: 'missing_backend_tool', error: 'No input backend is available to scroll.' };
}

async function typeLiteralText(backend, text, timeoutMs) {
  if (backend === 'xdotool') {
    return await runTool('xdotool', ['type', '--clearmodifiers', '--delay', String(TYPE_DELAY_MS), '--', text], { timeoutMs, lane: 'action' });
  }
  if (backend === 'xte') {
    return await runTool('xte', [`str ${text}`], { timeoutMs, lane: 'action' });
  }
  if (backend === 'ydotool') {
    // ydotool types through its own keymap, so the text is handed over as one argument and is
    // never re-interpreted: a leading dash is the only thing that could read as an option.
    const args = text.startsWith('-') ? ['type', '--', text] : ['type', text];
    return await runTool('ydotool', args, { timeoutMs, lane: 'action' });
  }
  return { ok: false, error_code: 'missing_backend_tool', error: 'No input backend is available to type text.' };
}

async function pressChord(backend, chord, timeoutMs) {
  if (backend === 'xdotool') {
    return await runTool('xdotool', ['key', '--clearmodifiers', chord], { timeoutMs, lane: 'action' });
  }
  if (backend === 'xte') {
    const parts = chord.split('+');
    const base = parts[parts.length - 1];
    const commands = [];
    const modifierNames = { ctrl: 'Control_L', shift: 'Shift_L', alt: 'Alt_L', super: 'Super_L', meta: 'Meta_L', hyper: 'Hyper_L' };
    for (const part of parts.slice(0, -1)) {
      const name = modifierNames[part];
      if (!name) return { ok: false, error_code: 'key_unsupported', error: `xte cannot express the modifier ${part}.` };
      commands.push(`keydown ${name}`);
    }
    commands.push(`key ${base}`);
    for (const part of [...parts.slice(0, -1)].reverse()) {
      commands.push(`keyup ${modifierNames[part]}`);
    }
    return await runTool('xte', commands, { timeoutMs, lane: 'action' });
  }
  if (backend === 'ydotool') {
    const plan = ydotoolKeyPlan(chord);
    if (!plan) {
      return { ok: false, error_code: 'key_unsupported', error: `ydotool cannot express the chord ${chord} with an input event code.` };
    }
    return await runTool('ydotool', ['key', ...plan], { timeoutMs, lane: 'action' });
  }
  return { ok: false, error_code: 'missing_backend_tool', error: 'No input backend is available to press a key.' };
}

/* --- receipts ------------------------------------------------------ */

/**
 * The receipt of a delivered action. `foreground_verified` is deliberately NOT set here: only
 * the keystroke paths check focus, so only they may claim it, and every other delivery states
 * `focus_checked: false` instead of borrowing a guarantee it did not measure.
 */
function deliveryReceipt(action, fields) {
  const backend = capabilities().backend.input;
  return {
    ...fields,
    ...backendReport(),
    ok: true,
    action,
    mouse_mode: 'real',
    delivery: 'physical-desktop',
    physical_delivery_used: true,
    system_cursor_moved: true,
    fallback_to_real_delivery: false,
    input_backend: backend,
    text_delivery: textDelivery(backend),
    path_duration_ms: MOVE_CURVE_MS,
    move_curve_points: MOVE_CURVE_POINTS,
    minimum_action_interval_ms: MIN_ACTION_INTERVAL_MS,
    window_verified: true,
  };
}

/** The active-window guard: keystrokes follow focus, so focus must be the verified window. */
async function focusGuard(action, application, header) {
  const active = await activeWindowHandle();
  if (!active.ok) {
    return failure(action, 'foreground_not_verifiable', `The active window could not be determined (${active.error}), so typing was refused rather than sent to an unknown window.`, {
      ...header,
      app: application,
      physical_delivery_used: false,
    });
  }
  if (!sameHandle(active.handle, application.handle)) {
    return failure(action, 'foreground_not_granted', `The target window ${unwrapHandle(application.handle)} is not the active window (${active.handle} is), so the input was refused instead of being typed into another window.`, {
      ...header,
      app: application,
      active_window: active.handle,
      active_window_source: active.source,
      physical_delivery_used: false,
    });
  }
  return null;
}

/* --- the six desktop deliveries ----------------------------------- */

/**
 * Every delivery re-checks that an input backend exists, so a sequence step or an app action
 * that reached delivery without a dispatcher-level guard still refuses by name instead of
 * reporting a movement failure for a tool that was never installed.
 */
function inputRefusal(action, header) {
  const blocked = toolGuard(action, 'input');
  return blocked ? { ...blocked, ...header } : null;
}

async function deliverMove(action, options, application, point, header) {
  const unavailable = inputRefusal(action, header);
  if (unavailable) return unavailable;
  const backend = capabilities().backend.input;
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS);
  const moved = await moveAlongPath(backend, await approachPath(point, timeoutMs), timeoutMs);
  if (moved.ok !== true) {
    return failure(action, moved.error_code, `The interpolated pointer path failed: ${moved.error}`, {
      ...header,
      app: application,
      x: point.x,
      y: point.y,
      path_step: moved.step,
      physical_delivery_used: false,
    });
  }
  return deliveryReceipt(action, { ...header, app: application, x: point.x, y: point.y, path_steps: moved.steps, path_elapsed_ms: moved.elapsed_ms, focus_checked: false });
}

async function deliverClick(action, options, application, point, button, header) {
  const unavailable = inputRefusal(action, header);
  if (unavailable) return unavailable;
  const backend = capabilities().backend.input;
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS);
  const moved = await moveAlongPath(backend, await approachPath(point, timeoutMs), timeoutMs);
  if (moved.ok !== true) {
    return failure(action, 'cursor_move_failed', `The pointer could not reach the click point: ${moved.error}`, { ...header, app: application, x: point.x, y: point.y });
  }
  const down = await pressButton(backend, button, true, timeoutMs);
  if (!down.ok) {
    return failure(action, down.error_code === 'missing_tool' ? 'missing_backend_tool' : 'button_press_failed', `The ${button} button could not be pressed: ${down.error}`, { ...header, app: application, x: point.x, y: point.y });
  }
  await sleep(CLICK_HOLD_MS);
  const up = await pressButton(backend, button, false, timeoutMs);
  if (!up.ok) {
    return failure(action, up.error_code === 'missing_tool' ? 'missing_backend_tool' : 'button_release_failed', `The ${button} button could not be released: ${up.error}`, { ...header, app: application, x: point.x, y: point.y, button_held: true });
  }
  return deliveryReceipt(action, { ...header, app: application, x: point.x, y: point.y, button, hold_ms: CLICK_HOLD_MS, button_released: true, focus_checked: false });
}

/**
 * A drag releases the held button in a finally, on a movement failure, on a lane timeout and on
 * cancellation, so an aborted drag can never leave a real button stuck down.
 */
async function deliverDrag(action, options, application, start, end, button, header) {
  const unavailable = inputRefusal(action, header);
  if (unavailable) return unavailable;
  const backend = capabilities().backend.input;
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS);
  const released = { done: false };
  const release = async () => {
    if (released.done) return null;
    released.done = true;
    return await releaseButton(button);
  };
  const signal = options.signal;
  const onAbort = () => {
    // Cancellation kills the lane that is moving the pointer and then releases the button on a
    // fresh call, so an aborted drag cannot leave the session holding a button. The release is
    // dispatched rather than awaited so the abort handler returns immediately; it settles on its
    // own and can never surface as an unhandled rejection.
    stopLane('action');
    void release().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      await release();
      return failure(action, 'cancelled', 'The drag was cancelled before it started.', { ...header, app: application, drag_release_guard: true });
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let result;
  try {
    const approach = await moveAlongPath(backend, await approachPath(start, timeoutMs), timeoutMs);
    if (approach.ok !== true) {
      result = failure(action, 'cursor_move_failed', `The pointer could not reach the drag start: ${approach.error}`, { ...header, app: application, start_x: start.x, start_y: start.y });
    } else {
      const down = await pressButton(backend, button, true, timeoutMs);
      if (!down.ok) {
        result = failure(action, down.error_code === 'missing_tool' ? 'missing_backend_tool' : 'button_press_failed', `The ${button} button could not be pressed for the drag: ${down.error}`, { ...header, app: application });
      } else {
        released.done = false;
        try {
          const travelled = await moveAlongPath(backend, interpolatedPath(start, end), timeoutMs);
          result = travelled.ok === true
            ? deliveryReceipt(action, { ...header, app: application, start_x: start.x, start_y: start.y, end_x: end.x, end_y: end.y, button, released_in_finally: true, drag_release_guard: true, focus_checked: false })
            : failure(action, 'cursor_move_failed', `The pointer could not complete the drag path: ${travelled.error}`, { ...header, app: application, start_x: start.x, start_y: start.y, end_x: end.x, end_y: end.y });
        } finally {
          const up = await release();
          if (result && result.ok === true && (!up || up.ok !== true)) {
            result = failure(action, 'button_release_failed', `The ${button} button could not be released after the drag: ${up ? up.error : 'no release was attempted'}`, { ...header, app: application, button_held: true });
          }
          if (result && result.ok === true) result.button_released = true;
        }
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!result || result.ok !== true) await release();
  }
  return { ...(result || failure(action, 'cancelled', 'The drag did not complete.', { ...header })), drag_release_guard: true };
}

async function deliverScroll(action, options, application, point, scrollX, scrollY, header) {
  const unavailable = inputRefusal(action, header);
  if (unavailable) return unavailable;
  const backend = capabilities().backend.input;
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS);
  const approach = await moveAlongPath(backend, await approachPath(point, timeoutMs), timeoutMs);
  if (approach.ok !== true) {
    return failure(action, 'cursor_move_failed', `The pointer could not reach the scroll point: ${approach.error}`, { ...header, app: application, x: point.x, y: point.y });
  }
  const verticalSteps = Math.min(Math.abs(Math.trunc(scrollY)), MAX_SCROLL_STEPS);
  const horizontalSteps = Math.min(Math.abs(Math.trunc(scrollX)), MAX_SCROLL_STEPS);
  if (verticalSteps) {
    const scrolled = await wheelClicks(backend, scrollY > 0 ? 'up' : 'down', verticalSteps, timeoutMs);
    if (!scrolled.ok) {
      return failure(action, scrolled.error_code === 'missing_tool' ? 'missing_backend_tool' : scrolled.error_code, `The vertical wheel step failed: ${scrolled.error}`, { ...header, app: application, x: point.x, y: point.y });
    }
  }
  if (horizontalSteps) {
    const scrolled = await wheelClicks(backend, scrollX > 0 ? 'right' : 'left', horizontalSteps, timeoutMs);
    if (!scrolled.ok) {
      return failure(action, scrolled.error_code === 'missing_tool' ? 'missing_backend_tool' : scrolled.error_code, `The horizontal wheel step failed: ${scrolled.error}`, { ...header, app: application, x: point.x, y: point.y });
    }
  }
  return deliveryReceipt(action, {
    ...header,
    app: application,
    x: point.x,
    y: point.y,
    scroll_x: scrollX,
    scroll_y: scrollY,
    wheel_steps_x: horizontalSteps,
    wheel_steps_y: verticalSteps,
    wheel_model: 'one X11 button 4/5/6/7 click per wheel step',
    focus_checked: false,
  });
}

async function deliverType(action, options, application, text, header) {
  const unavailable = inputRefusal(action, header);
  if (unavailable) return unavailable;
  const backend = capabilities().backend.input;
  const focused = await focusGuard(action, application, header);
  if (focused) return focused;
  if (!text.length) {
    return deliveryReceipt(action, { ...header, app: application, chars: 0, typed: false, no_op: true, foreground_verified: true });
  }
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS);
  const result = await typeLiteralText(backend, text, timeoutMs);
  if (!result.ok) {
    return failure(action, result.error_code === 'missing_tool' ? 'missing_backend_tool' : result.error_code, result.error, {
      ...header,
      app: application,
      chars: text.length,
      ...(result.untypeable_character !== undefined ? { untypeable_character: result.untypeable_character } : {}),
    });
  }
  return deliveryReceipt(action, {
    ...header,
    app: application,
    chars: text.length,
    typed: true,
    text_is_literal: true,
    type_delay_ms: backend === 'xdotool' ? TYPE_DELAY_MS : undefined,
    foreground_verified: true,
  });
}

async function deliverKey(action, options, application, key, header) {
  const backend = capabilities().backend.input;
  const chord = normalizeXdotoolKey(key);
  if (!chord) {
    return failure(action, 'key_unsupported', `Unsupported key or key chord: ${key}`, { ...header, app: application });
  }
  const focused = await focusGuard(action, application, header);
  if (focused) return focused;
  const timeoutMs = clampNumber(options.timeoutMs, 1000, 300000, DEFAULT_ACTION_TIMEOUT_MS);
  const result = await pressChord(backend, chord, timeoutMs);
  if (!result.ok) {
    return failure(action, result.error_code === 'missing_tool' ? 'missing_backend_tool' : result.error_code, result.error, { ...header, app: application, key, chord });
  }
  return deliveryReceipt(action, { ...header, app: application, key, chord, foreground_verified: true });
}

/** Activate one window and verify that activation actually took focus. */
async function activateWindow(action, application, header) {
  const caps = capabilities();
  const handle = unwrapHandle(application.handle);
  const blocked = toolGuard(action, 'activate');
  if (blocked) return { ...blocked, app: application };
  const attempts = [];
  if (caps.tools.wmctrl) attempts.push({ tool: 'wmctrl', args: ['-i', '-a', handle], method: 'wmctrl -i -a' });
  if (caps.tools.xdotool) attempts.push({ tool: 'xdotool', args: ['windowactivate', '--sync', handle], method: 'xdotool windowactivate --sync' });
  const failures = [];
  for (const attempt of attempts) {
    const result = await runTool(attempt.tool, attempt.args, { timeoutMs: WINDOW_TOOL_TIMEOUT_MS, lane: 'action' });
    if (!result.ok) {
      failures.push({ tool: attempt.tool, error: result.error, stderr: firstLine(result.stderr) });
      continue;
    }
    const active = await activeWindowHandle();
    if (!active.ok) {
      return failure(action, 'foreground_not_verifiable', `The window manager did not report an active window after ${attempt.method}, so activation could not be verified.`, { ...header, app: application, activation: attempt.method });
    }
    if (!sameHandle(active.handle, handle)) {
      failures.push({ tool: attempt.tool, error: `the active window is ${active.handle}, not ${handle}` });
      continue;
    }
    return { ok: true, app: application, activation: attempt.method, foreground_verified: true, active_window: active.handle };
  }
  return failure(action, 'foreground_not_granted', `The window manager did not grant focus to ${handle}: ${failures.map(item => `${item.tool}: ${item.error}`).join(' | ')}`, {
    ...header,
    app: application,
    failures,
  });
}

/* ------------------------------------------------------------------ *
 * 8. the virtual-mode region: refusal only
 *
 * Everything between the two markers below concerns virtual mode, and nothing inside it starts
 * a process, moves a pointer or sends a key. The contract gate extracts exactly this region and
 * asserts that.
 * ------------------------------------------------------------------ */

/* @virtual-mode-begin */

/*
 * Why this port has no virtual delivery path.
 *
 * On the Windows sibling, virtual mode means one specific mechanism: synthetic window messages
 * posted into one target window's own event queue, so the shared pointer never moves and the
 * scene is never checked against the whole desktop. There is no equivalent here that this port
 * is willing to call virtual. Every injection route a Linux session can reasonably have is
 * global by construction - it drives the shared pointer and the shared keyboard focus of the
 * display server or of the kernel input layer - so a "virtual click" would reach whatever the
 * server finds under the pointer, and a "virtual keystroke" would reach whatever currently
 * holds focus. The only per-window route that does exist is asking the window manager to raise
 * and focus a chosen window and then sending input to it; that is not a virtual delivery path
 * at all. It moves the real pointer, changes the real focus, steals the user's window, and is
 * documented as unreliable across window managers, so a receipt that called it virtual would
 * be a false statement about what happened to the user's desktop.
 *
 * The contract therefore stays honest in the only way it can: virtual is a supported *lease*
 * value and an unsupported *delivery* value. A caller that asks for a virtual takeover is told
 * exactly what it got - the mode is recorded, every action that would have to deliver input
 * refuses with `virtual_mode_unsupported`, and the caller can still read the window list. What
 * never happens is the silent fallback: no action in this file switches delivery because a
 * virtual delivery was requested. A refusal costs one tool call; a silent fallback would move
 * a user's cursor, change their focus and type into a window the caller did not choose.
 *
 * What a caller should do instead: release the takeover with `takeover_stop`, observe the real
 * desktop, and use the app-scoped actions with an explicit target, so every point is checked
 * against that window's live geometry before anything is delivered.
 */

const VIRTUAL_MODE_SUPPORTED = false;
const VIRTUAL_DELIVERY = 'none';

/** Actions that would have to deliver input: all refused while virtual is in force. */
const VIRTUAL_REFUSED_ACTIONS = Object.freeze([
  'move', 'click', 'drag', 'scroll', 'type', 'key',
  'app_activate', 'app_click', 'app_drag', 'app_scroll', 'app_type', 'app_key',
  'observe', 'app_observe', 'sequence',
]);

/** Read-only actions that deliver nothing and stay available. */
const VIRTUAL_ALLOWED_ACTIONS = Object.freeze(['app_list', 'app_observe', 'wait_for', 'wait', 'mode_report', 'takeover_start', 'takeover_stop']);

function virtualRefusal(action, detail, extra = {}) {
  return failure(action, 'virtual_mode_unsupported', detail, {
    ...extra,
    mouse_mode: 'virtual',
    virtual_mode_supported: VIRTUAL_MODE_SUPPORTED,
    delivery: VIRTUAL_DELIVERY,
    queued: false,
    action_completed: false,
    physical_delivery_used: false,
    system_cursor_moved: false,
    fallback_to_real_delivery: false,
    refused_actions: [...VIRTUAL_REFUSED_ACTIONS],
  });
}

/**
 * The one place the dispatcher asks whether virtual mode permits an action. `app_observe` is
 * allowed only with an explicit window scope, because an unscoped observation would have to
 * check the real foreground desktop that virtual mode exists to avoid.
 */
function virtualActionRefusal(action, options = {}) {
  if (!VIRTUAL_REFUSED_ACTIONS.includes(action)) return null;
  if (action === 'observe') {
    return virtualRefusal(action, 'Virtual mode has no delivery path on this platform, so the scene-checked observation of the real desktop is refused. Use app_observe with an explicit window_handle or app_target, or release the takeover and observe the real desktop.');
  }
  if (action === 'sequence') {
    return virtualRefusal(action, 'Virtual mode has no delivery path on this platform, so a scene-checked sequence is refused. Use app_observe and then explicit app_* actions.');
  }
  if (action === 'app_observe') {
    const scoped = Boolean(handleHex(options.windowHandle || options.window_handle) || options.appTarget || options.app_target);
    if (!scoped) {
      return virtualRefusal(action, 'Virtual mode refuses the foreground scene check: app_observe needs app_target or window_handle so it never falls back to the foreground desktop.');
    }
    return null;
  }
  return virtualRefusal(action, `Virtual mode has no delivery path on this platform, so ${action} is refused. Nothing was delivered, and no real input was substituted for it.`);
}

/** The virtual half of mode_report, reported even while no lease is held. */
function virtualModeReport() {
  return {
    supported: VIRTUAL_MODE_SUPPORTED,
    delivery: VIRTUAL_DELIVERY,
    reason: 'Linux has no per-window synthetic input queue: every available injection route drives the shared pointer and focus of the session, so a delivery this port called virtual would be real input under another name.',
    refuses: [...VIRTUAL_REFUSED_ACTIONS],
    allows_read_only: [...VIRTUAL_ALLOWED_ACTIONS],
    never_falls_back_to_real_delivery: true,
    receipts_are_honest: { queued: false, action_completed: false },
  };
}

/* @virtual-mode-end */

/* ------------------------------------------------------------------ *
 * 9. wait_for, sequence, the takeover lease, and the dispatcher
 * ------------------------------------------------------------------ */

/**
 * `wait_for` is read-only and bounded: it polls the real window list, a target id or a window
 * id until it matches, the deadline passes or the caller cancels. There is no accessibility
 * text tree in this port, so a text match is a window title or class match.
 */
async function waitForAction(action, options) {
  const header = {
    action,
    read_only: true,
    mouse_mode: currentMouseMode(),
    physical_delivery_used: false,
    system_cursor_moved: false,
    fallback_to_real_delivery: false,
    ...backendReport(),
  };
  const timeoutMs = clampNumber(options.timeoutMs ?? options.timeout_ms, 1, MAX_WAIT_FOR_MS, DEFAULT_WAIT_FOR_MS);
  const signal = options.signal;
  const text = String(options.text || options.waitForText || options.wait_for_text || '').trim();
  const targetId = String(options.targetId || options.target_id || '').trim();
  const handle = handleHex(options.windowHandle || options.window_handle);
  const wantsWindow = options.waitForWindow === true || options.wait_for_window === true || (!text && !targetId && !handle);
  if (!text && !targetId && !handle && !wantsWindow) {
    return failure(action, 'wait_for_target_required', 'wait_for needs one of text, target_id, window_handle or wait_for_window.', header);
  }
  const blocked = displayGuard(action) || toolGuard(action, 'windows');
  if (blocked) return { ...header, ...blocked };

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let samples = 0;
  let lastApplications = [];
  let lastError;
  const target = targetId ? resolveTargetId(targetId, options.ownerId) : null;
  if (target && target.ok !== true) {
    return { ...header, ...failure(action, 'target_id_unknown', target.error) };
  }
  while (true) {
    if (signal && signal.aborted) {
      return { ...header, ...cancelledResult(action, signal), matched: false, samples, reason: 'cancelled' };
    }
    samples += 1;
    const enumerated = await enumerateApplications({ ...options, includeMinimized: false });
    if (enumerated.ok !== true) {
      lastError = { error_code: enumerated.error_code, error: enumerated.error, ...toolFields(enumerated) };
    } else {
      lastApplications = enumerated.applications;
      const windowMatch = handle ? lastApplications.find(app => sameHandle(app.handle, handle)) : undefined;
      const textMatch = text
        ? lastApplications.find(app => `${app.title || ''} ${app.class_name || ''}`.toLowerCase().includes(text.toLowerCase()))
        : undefined;
      const targetMatch = target && target.ok === true
        ? lastApplications.find(app => sameHandle(app.handle, target.window_handle))
        : undefined;
      const matched = windowMatch || textMatch || targetMatch
        || (!text && !targetId && !handle && wantsWindow && lastApplications.length ? lastApplications[0] : undefined);
      if (matched) {
        registerWindowTargets(lastApplications, options.ownerId);
        return {
          ...header,
          ok: true,
          matched: true,
          reason: 'match',
          match_kind: windowMatch ? 'window_handle' : textMatch ? 'text' : targetMatch ? 'target_id' : 'visible_window',
          matched_window: matched,
          applications: lastApplications.slice(0, 20),
          samples,
          elapsed_ms: Date.now() - startedAt,
          timeout_ms: timeoutMs,
          text_match_scope: 'window titles and WM_CLASS: this port has no accessibility text tree',
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(WAIT_FOR_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return {
    ...header,
    ok: true,
    matched: false,
    reason: 'timeout',
    applications: lastApplications.slice(0, 20),
    samples,
    elapsed_ms: Date.now() - startedAt,
    timeout_ms: timeoutMs,
    ...(lastError || {}),
  };
}

async function sceneSnapshot(options) {
  const enumerated = await enumerateApplications({ ...options, includeMinimized: false });
  if (enumerated.ok !== true) {
    return { generation: '', applications: [], error: enumerated.error, error_code: enumerated.error_code };
  }
  return { generation: sceneGeneration(enumerated.applications), applications: enumerated.applications };
}

/** One sequence step. A click or a drag goes through the shared reservation queue. */
async function runSequenceStep(stepAction, step, options, header) {
  const target = step.__target;
  const x = target ? target.x : Math.floor(Number(step.x));
  const y = target ? target.y : Math.floor(Number(step.y));
  if (stepAction === 'wait') {
    const durationMs = clampNumber(step.durationMs ?? step.duration_ms, 0, 60000, 250);
    await sleep(durationMs);
    return { ok: true, action: 'wait', duration_ms: durationMs };
  }
  if (stepAction === 'type') {
    const verified = await resolveVerifiedTarget('type', options);
    if (verified.ok !== true) return verified.result;
    return await deliverType('type', options, verified.application, String(step.text || ''), header);
  }
  if (stepAction === 'key') {
    const verified = await resolveVerifiedTarget('key', options);
    if (verified.ok !== true) return verified.result;
    return await deliverKey('key', options, verified.application, String(step.key || ''), header);
  }
  if (stepAction === 'move' || stepAction === 'click' || stepAction === 'scroll') {
    const verified = await resolveVerifiedTarget(stepAction, options);
    if (verified.ok !== true) return verified.result;
    const application = verified.application;
    const point = { x, y };
    const refusal = containmentRefusal(stepAction, application, point, header);
    if (refusal) return refusal;
    if (stepAction === 'move') return await deliverMove('move', options, application, point, header);
    if (stepAction === 'click') {
      const button = step.button === 'right' ? 'right' : 'left';
      return await withRealMouseReservation(async () => await deliverClick('click', options, application, point, button, header));
    }
    const scrollX = Math.floor(Number(step.scrollX || step.scroll_x || 0));
    const scrollY = Math.floor(Number(step.scrollY || step.scroll_y || 0));
    if (!scrollX && !scrollY) return failure('scroll', 'scroll_delta_required', 'scroll_x or scroll_y is required.');
    return await deliverScroll('scroll', options, application, point, scrollX, scrollY, header);
  }
  if (stepAction === 'drag') {
    const startX = Math.floor(Number(step.startX ?? step.start_x));
    const startY = Math.floor(Number(step.startY ?? step.start_y));
    const endX = Math.floor(Number(step.endX ?? step.end_x));
    const endY = Math.floor(Number(step.endY ?? step.end_y));
    if (![startX, startY, endX, endY].every(Number.isFinite)) {
      return failure('drag', 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.');
    }
    const verified = await resolveVerifiedTarget('drag', options);
    if (verified.ok !== true) return verified.result;
    const application = verified.application;
    const start = { x: startX, y: startY };
    const end = { x: endX, y: endY };
    const refusal = containmentRefusal('drag', application, start, header) || containmentRefusal('drag', application, end, header);
    if (refusal) return refusal;
    const button = step.button === 'right' ? 'right' : 'left';
    return await withRealMouseReservation(async () => await deliverDrag('drag', options, application, start, end, button, header));
  }
  return failure(stepAction, 'unsupported_sequence_action', `sequence supports mouse and key steps only; ${stepAction} is not supported.`);
}

async function executeSequence(options, header) {
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
      return failure(action, 'unsupported_sequence_action', `sequence supports mouse and key steps only; ${stepAction || '(empty)'} is not one of ${SEQUENCE_STEP_ACTIONS.join(', ')}.`, { ...header, completed, stopped_at: index, requires_observe: true });
    }
    const needsTarget = stepAction === 'move' || stepAction === 'click' || stepAction === 'scroll';
    const hasPoint = Number.isFinite(Number(step.x)) && Number.isFinite(Number(step.y));
    if (needsTarget && !step.targetId && !step.target_id && !hasPoint) {
      return failure(action, 'sequence_step_point_required', `Step ${index} needs a target_id or explicit x/y coordinates.`, { ...header, completed, stopped_at: index, requires_observe: true });
    }
    if (needsTarget && (step.targetId || step.target_id)) {
      const target = resolveTargetId(step.targetId || step.target_id, options.ownerId);
      if (target && target.ok !== true) {
        return failure(action, 'target_id_unknown', target.error, { ...header, completed, stopped_at: index, requires_observe: true });
      }
      if (target && target.risk === 'medium') {
        return failure(action, 'sequence_medium_risk_target', 'A medium-risk target requires a single action followed by observe.', { ...header, completed, stopped_at: index, requires_observe: true });
      }
      step.__target = target;
    }
    if (needsTarget && !cache && !hasPoint) {
      return failure(action, 'observe_required', 'Call observe or app_observe before a scene-checked sequence.', { ...header, completed, stopped_at: index, requires_observe: true });
    }
    const stepResult = await runSequenceStep(stepAction, step, options, header);
    completed.push(stepResult);
    if (stepResult.ok !== true) return { ...stepResult, action, completed, stopped_at: index, requires_observe: true };
    if (index >= steps.length - 1) continue;
    const scene = await sceneSnapshot(options);
    if (expectedGeneration && scene.generation && scene.generation !== expectedGeneration) {
      return {
        ...header,
        ok: true,
        action,
        mouse_mode: 'real',
        completed,
        stopped_at: index + 1,
        requires_observe: true,
        stop_reason: 'focus-window-menu-dialog-or-scene-changed',
        previous_scene_generation: expectedGeneration,
        current_scene_generation: scene.generation,
      };
    }
    if (scene.generation) expectedGeneration = scene.generation;
  }
  return {
    ...header,
    ok: true,
    action,
    mouse_mode: 'real',
    completed,
    requires_observe: false,
    scene_generation: expectedGeneration,
    minimum_action_interval_ms: MIN_ACTION_INTERVAL_MS,
    reservation_queue: 'shared-with-click-and-drag',
  };
}

/* --- the single-owner takeover lease ------------------------------ */

const lease = {
  ownerId: null,
  mouseMode: 'real',
  acquiredAt: 0,
  expiresAt: 0,
  timer: null,
  lastReleaseReason: '',
};

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
      virtual_mode_supported: VIRTUAL_MODE_SUPPORTED,
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
  return {
    ok: true,
    action,
    takeover: true,
    mouse_mode: requested,
    delivery: requested === 'virtual' ? VIRTUAL_DELIVERY : 'physical-desktop',
    virtual_mode_supported: VIRTUAL_MODE_SUPPORTED,
    virtual_mode_note: requested === 'virtual'
      ? 'The lease holds virtual, and every action that would have to deliver input refuses with virtual_mode_unsupported; nothing falls back to real input.'
      : undefined,
    lease: {
      owner_id: ownerId,
      mouse_mode: requested,
      ttl_ms: LEASE_TTL_MS,
      acquired_at: lease.acquiredAt,
      expires_at: lease.expiresAt,
      expires_in_ms: LEASE_TTL_MS,
    },
    ...backendReport(),
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
  releaseLease('takeover_stop');
  return {
    ok: true,
    action,
    takeover: false,
    mouse_mode: 'real',
    released_owner: previousOwner,
    lease: { held: false, owner_id: null, mouse_mode: 'real', ttl_ms: LEASE_TTL_MS },
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

/* --- the action handlers ------------------------------------------ */

function modeReport(action, options) {
  const active = activeLease();
  const caps = capabilities();
  return {
    ok: true,
    action,
    platform: process.platform,
    supported: IS_LINUX,
    mouse_mode: currentMouseMode(),
    requested_mouse_mode: options.mouseMode,
    mouse_mode_mutable_by_action: false,
    mode_inventory: MODE_INVENTORY,
    observation_defaults: {
      sparse_wait_ms: 0,
      sparse_max_wait_ms: SPARSE_MAX_WAIT_MS,
      sparse_min_interval_ms: SPARSE_MIN_INTERVAL_MS,
      sparse_digest: `${SPARSE_DIGEST_WIDTH}x${SPARSE_DIGEST_HEIGHT}-grayscale`,
      full_capture: 'one window capture through import -window, or the focused-window grabber, or ffmpeg x11grab (first available that can address the window)',
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
    lanes: laneDiagnostics(),
    live_lane_count: liveLaneCount(),
    lane_routing: ACTION_LANES,
    actions: {
      desktop: [...DESKTOP_ACTIONS],
      app: [...APP_ACTIONS],
      sequence_steps: [...SEQUENCE_STEP_ACTIONS],
      all: [...ALL_ACTIONS],
      extensions: [READ_ONLY_POLL_ACTION],
    },
    display: displayState(),
    ...backendReport(),
    probe: { cache_key: caps.cache_key, probed_at: caps.probed_at, tools: { ...caps.tools } },
    accessibility: {
      available: false,
      reason: 'This port implements no accessibility tree, so the uia lanes never report ready and a target_id names a window rather than a control.',
      uia_lanes_ready: LANES.filter(lane => (LANE_REQUIREMENTS[lane] || []).includes('accessibility')).filter(lane => laneReady(lane)),
    },
    virtual_mode: virtualModeReport(),
    boundaries: [
      'wmctrl and xdotool report the client window geometry: there is no frame rectangle unless the window manager publishes _NET_FRAME_EXTENTS, and occlusion is not measurable with these tools and is reported as null.',
      'The focused-window grabbers can only capture the active window; a non-active target is captured with the window grabber or the region grabber, and the region grabber captures whatever is composited there.',
      'A real-mode click is delivered to whatever the X server finds under the pointer; the point is verified to lie inside the resolved target window, but stacking is not changed.',
      'Under a Wayland session the X11 tools only reach clients running through XWayland; a Wayland-native window needs ydotool, whose typing is limited to the US layout this port ships.',
      'x11grab capture sizes are rounded down to even numbers, so a captured region can differ from the window geometry by one pixel.',
    ],
    physical_delivery_used: false,
  };
}

/** Full observation of the foreground window. A sparse request is routed before this point. */
async function observeAction(action, options, mode, header) {
  const resolved = await resolveApplication({ ...options, virtualScope: false });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'window_unavailable', resolved.error || 'No window is available to observe.', { ...header, ...(resolved.extra || {}), applications: (resolved.applications || []).slice(0, 20) });
  }
  return await fullObservation(action, options, mode, header, resolved.application);
}

/** Full observation of one named window. A sparse request is routed before this point. */
async function appObserveAction(action, options, mode, header) {
  const resolved = await resolveApplication({ ...options, virtualScope: false });
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, ...(resolved.extra || {}), applications: (resolved.applications || []).slice(0, 20) });
  }
  return await fullObservation(action, options, mode, header, resolved.application);
}

async function fullObservation(action, options, mode, header, application) {
  if (application.minimized === true) {
    return failure(action, 'window_minimized', 'An iconified window has no capturable presentation.', { ...header, app: application });
  }
  const verified = await verifyTargetWindow(application, options);
  if (verified.ok !== true) {
    return failure(action, verified.error_code, verified.error, { ...header, app: application, verification: verified.verification });
  }
  const capture = await captureWindow({
    handle: verified.application.handle,
    processId: verified.application.process_id,
    ownerId: options.ownerId,
    imagePath: options.imagePath || options.image_path,
    maxWidth: options.captureMaxWidth ?? options.max_width,
    maxHeight: options.captureMaxHeight ?? options.max_height,
    timeoutMs: options.captureTimeoutMs ?? options.timeoutMs,
    action,
  });
  if (capture.ok !== true) {
    return { ...header, ...capture, action, app: verified.application };
  }
  registerWindowTargets([verified.application], options.ownerId);
  observationsByOwner.set(ownerKey(options.ownerId), {
    windowHandle: verified.application.handle,
    sceneGeneration: sceneGeneration([verified.application]),
    capturedAt: Date.now(),
  });
  return {
    ...header,
    ok: true,
    action,
    observation: 'full',
    must_reacquire_full_observation: false,
    app: verified.application,
    window: verified.application,
    image_path: capture.image_path,
    imagePath: capture.imagePath,
    image_mime: capture.image_mime,
    width: capture.width,
    height: capture.height,
    image_width: capture.image_width,
    image_height: capture.image_height,
    image_bytes: capture.image_bytes,
    bytes: capture.bytes,
    digest32x18: capture.digest32x18,
    capture: {
      image_path: capture.image_path,
      image_mime: capture.image_mime,
      width: capture.width,
      height: capture.height,
      image_bytes: capture.image_bytes,
      capture_method: capture.capture_method,
      capture_scope: capture.capture_scope,
      resize_applied: capture.resize_applied,
      lane: capture.lane,
      digest: capture.digest,
      digest32x18: capture.digest32x18,
      digest_tool: capture.digest_tool,
    },
    controls: [],
    control_count: 0,
    uia_visited: 0,
    target_scope: verified.application.handle,
    control_tree: {
      available: false,
      reason: 'This port implements no accessibility tree: a target_id names a window, and app_list is the way to enumerate what is on screen.',
    },
    window_verification: verified.verification,
    target_id: stableTargetId(verified.application),
    telemetry: {
      lane: capture.lane,
      capture_ms: capture.telemetry ? capture.telemetry.capture_ms : undefined,
      input_backend: capabilities().backend.input,
      uia_error: 'accessibility_backend_unavailable',
    },
  };
}

async function appListAction(action, options, mode, header) {
  const includeMinimized = options.includeMinimized === true;
  const first = await enumerateApplications({ ...options, includeMinimized });
  const enumerated = first.ok === true && first.applications.length > 0
    ? first
    : await enumerateApplications({ ...options, includeMinimized });
  if (enumerated.ok === true) registerWindowTargets(enumerated.applications, options.ownerId);
  return {
    ...header,
    ok: enumerated.ok === true,
    action,
    applications: enumerated.applications,
    windows: enumerated.applications,
    count: enumerated.applications.length,
    scope: options.includeOccluded === true || options.include_occluded === true
      ? 'all-managed-windows'
      : 'managed-windows-this-desktop',
    occlusion: {
      measured: false,
      reason: 'wmctrl and xdotool do not report occlusion; app_observe a window and judge from the captured pixels.',
    },
    minimized_included: includeMinimized,
    telemetry: {
      lane: enumerated.lane,
      elapsed_ms: enumerated.elapsedMs,
      backend: enumerated.backend,
      minimized_probed: enumerated.minimized_probed,
      retried_empty_result: enumerated !== first,
    },
    ...backendReport(),
    ...(enumerated.error_code ? { code: enumerated.error_code, error_code: enumerated.error_code, error: enumerated.error, ...toolFields(enumerated) } : {}),
  };
}

async function appActivateAction(action, options, mode, header) {
  const resolved = await resolveApplication(options);
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, ...(resolved.extra || {}), applications: (resolved.applications || []).slice(0, 20) });
  }
  const application = resolved.application;
  if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, app: application, mouse_mode: 'real' };
  const activated = await activateWindow(action, application, header);
  if (activated.ok !== true) return { ...header, ...activated };
  registerWindowTargets([application], options.ownerId);
  return {
    ...header,
    ok: true,
    action,
    app: activated.app,
    handle: unwrapHandle(application.handle),
    foreground_verified: true,
    mouse_mode: 'real',
    activation: activated.activation,
    active_window: activated.active_window,
  };
}

async function desktopPhysicalAction(action, options, mode, header) {
  const target = options.targetId || options.target_id ? resolveTargetId(options.targetId || options.target_id, options.ownerId) : null;
  if (target && target.ok !== true) return failure(action, target.error_code, target.error, { ...header });
  if (action === 'type') {
    if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, mouse_mode: 'real' };
    const verified = await resolveVerifiedTarget(action, options);
    if (verified.ok !== true) return { ...header, ...verified.result };
    return { ...header, ...(await deliverType(action, options, verified.application, String(options.text || ''), header)) };
  }
  if (action === 'key') {
    if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, mouse_mode: 'real' };
    const verified = await resolveVerifiedTarget(action, options);
    if (verified.ok !== true) return { ...header, ...verified.result };
    return { ...header, ...(await deliverKey(action, options, verified.application, String(options.key || ''), header)) };
  }
  if (!target && !Number.isFinite(Number(options.x))) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
  if (!target && !Number.isFinite(Number(options.y))) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
  const x = target ? target.x : Math.floor(Number(options.x));
  const y = target ? target.y : Math.floor(Number(options.y));
  if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, x, y, target_id: options.targetId || options.target_id, mouse_mode: 'real' };
  const verified = await resolveVerifiedTarget(action, options);
  if (verified.ok !== true) return { ...header, ...verified.result };
  const application = verified.application;
  const point = { x, y };
  if (action === 'move') return { ...header, ...(await deliverMove(action, options, application, point, header)) };
  const refusal = containmentRefusal(action, application, point, header);
  if (refusal) return refusal;
  if (action === 'click') {
    const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left';
    return { ...header, ...(await withRealMouseReservation(async () => await deliverClick(action, options, application, point, button, header))) };
  }
  if (action === 'scroll') {
    const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
    const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
    if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
    return { ...header, ...(await deliverScroll(action, options, application, point, scrollX, scrollY, header)) };
  }
  const points = ['startX', 'startY', 'endX', 'endY'].map(key => Math.floor(Number(options[key])));
  if (!points.every(Number.isFinite)) return failure(action, 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.', { ...header });
  const start = { x: points[0], y: points[1] };
  const end = { x: points[2], y: points[3] };
  const dragRefusal = containmentRefusal(action, application, start, header) || containmentRefusal(action, application, end, header);
  if (dragRefusal) return dragRefusal;
  const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left';
  return { ...header, ...(await withRealMouseReservation(async () => await deliverDrag(action, options, application, start, end, button, header))) };
}

async function appPhysicalAction(action, options, mode, header) {
  const resolved = await resolveApplication(options);
  if (resolved.ok !== true) {
    return failure(action, resolved.error_code || 'app_target_not_found', resolved.error || 'The requested application window was not found.', { ...header, ...(resolved.extra || {}), applications: (resolved.applications || []).slice(0, 20) });
  }
  const resolvedApplication = resolved.application;
  if (resolvedApplication.minimized === true) {
    return failure(action, 'window_minimized', 'An iconified window has no presentation to act on.', { ...header, app: resolvedApplication });
  }
  const point = appScopedPoint(resolvedApplication, options.x, options.y);
  if (point.error) return failure(action, 'point_outside_window', point.error, { ...header, app: resolvedApplication });
  if (options.dryRun === true) return { ...header, ok: true, action, dry_run: true, app: resolvedApplication, x: point.x, y: point.y, mouse_mode: 'real' };

  const activated = await activateWindow(action, resolvedApplication, header);
  if (activated.ok !== true) return { ...header, ...activated };
  const application = activated.app;

  const dragPoints = ['startX', 'startY', 'endX', 'endY'].map(key => Math.floor(Number(options[key])));
  const needsDrag = action === 'app_drag';
  if (needsDrag && !dragPoints.every(Number.isFinite)) {
    return failure(action, 'drag_points_required', 'start_x, start_y, end_x and end_y are required pixel coordinates.', { ...header });
  }
  const start = needsDrag ? appScopedPoint(application, dragPoints[0], dragPoints[1]) : null;
  const end = needsDrag ? appScopedPoint(application, dragPoints[2], dragPoints[3]) : null;
  if (needsDrag && (start.error || end.error)) {
    return failure(action, 'point_outside_window', start.error || end.error, { ...header, app: application });
  }

  const verified = await verifyTargetWindow(application, options);
  if (verified.ok !== true) return { ...header, ...failure(action, verified.error_code, verified.error, { app: application, verification: verified.verification }) };
  const verifiedApplication = verified.application;

  if (action === 'app_click') {
    const refusal = containmentRefusal(action, verifiedApplication, point, header);
    if (refusal) return refusal;
    const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left';
    const clicked = await withRealMouseReservation(async () => await deliverClick(action, options, verifiedApplication, point, button, header));
    return { ...header, ...clicked, action, app: verifiedApplication, window_verification: verified.verification };
  }
  if (action === 'app_scroll') {
    const scrollX = Math.floor(Number(options.scrollX || options.scroll_x || 0));
    const scrollY = Math.floor(Number(options.scrollY || options.scroll_y || 0));
    if (!scrollX && !scrollY) return failure(action, 'scroll_delta_required', 'scroll_x or scroll_y is required.', { ...header });
    const refusal = containmentRefusal(action, verifiedApplication, point, header);
    if (refusal) return refusal;
    const scrolled = await deliverScroll(action, options, verifiedApplication, point, scrollX, scrollY, header);
    return { ...header, ...scrolled, action, app: verifiedApplication, window_verification: verified.verification };
  }
  if (action === 'app_type') {
    const typed = await deliverType(action, options, verifiedApplication, String(options.text || ''), header);
    return { ...header, ...typed, action, app: verifiedApplication, window_verification: verified.verification };
  }
  if (action === 'app_key') {
    const pressed = await deliverKey(action, options, verifiedApplication, String(options.key || ''), header);
    return { ...header, ...pressed, action, app: verifiedApplication, window_verification: verified.verification };
  }
  const refusal = containmentRefusal(action, verifiedApplication, start, header) || containmentRefusal(action, verifiedApplication, end, header);
  if (refusal) return refusal;
  const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left';
  const dragged = await withRealMouseReservation(async () => await deliverDrag(action, options, verifiedApplication, start, end, button, header));
  return { ...header, ...dragged, action, app: verifiedApplication, window_verification: verified.verification };
}

/* --- the dispatcher ---------------------------------------------- */

export async function runComputerUse(options = {}) {
  const action = String((options && options.action) || 'observe').toLowerCase();
  try {
    const result = await dispatchComputerUse(action, options || {});
    return stringifyResult(result);
  } catch (error) {
    return stringifyResult(failure(action, 'internal_error', messageOf(error)));
  }
}

async function dispatchComputerUse(action, options) {
  if (options.signal && options.signal.aborted) return cancelledResult(action, options.signal);

  // The takeover lease is pure process state, so it also works off Linux where nothing can be
  // typed or clicked. Everything that touches the desktop is refused there.
  if (action === 'takeover_start') return takeoverStart(options);
  if (action === 'takeover_stop') return takeoverStop(options);
  if (action === 'mode_report') return modeReport(action, options);
  if (action === 'wait') {
    const durationMs = clampNumber(options.durationMs ?? options.duration_ms, 0, 60000, 1000);
    const startedAt = Date.now();
    await sleep(durationMs);
    return { ok: true, action, duration_ms: Date.now() - startedAt, mouse_mode: currentMouseMode(), physical_delivery_used: false };
  }

  if (!IS_LINUX) return unsupportedPlatform(action);

  if (action === READ_ONLY_POLL_ACTION) return await waitForAction(action, options);

  if (!ALL_ACTIONS.includes(action) && !INTERNAL_ACTIONS.includes(action)) {
    return failure(action, 'unknown_action', `Unknown computer_use action: ${action}.`, { supported_actions: [...ALL_ACTIONS], extensions: [READ_ONLY_POLL_ACTION] });
  }

  const mode = effectiveMouseMode(options);
  const header = {
    mouse_mode: mode.mode,
    requested_mouse_mode: mode.requested,
    mouse_mode_override_ignored: mode.requested_ignored,
    lease_owner: mode.lease_owner,
    lane_routing: actionLanes(action),
    // Every action result states the delivery truth, so no refusal can be read as a delivery.
    physical_delivery_used: false,
    system_cursor_moved: false,
    fallback_to_real_delivery: false,
    ...backendReport(),
  };

  if (mode.mode === 'virtual') {
    const refused = virtualActionRefusal(action, options);
    if (refused) return { ...header, ...refused };
  }

  // A sparse request keeps its own envelope through every refusal, so the caller can always read
  // must_reacquire_full_observation and the wait it asked for.
  if ((action === 'observe' || action === 'app_observe') && sparseRequested(options) && options.observation !== 'full') {
    return { ...header, ...(await sparseAction(action, options, mode)) };
  }

  const blocked = displayGuard(action);
  if (blocked) return { ...header, ...blocked };

  if (action === 'app_list') return await appListAction(action, options, mode, header);
  if (action === 'capture_screen') {
    /* The whole-desktop capture behind `screen_capture` with `target: "desktop"`. It is on
     * the dispatchable surface but deliberately not on the model-facing action list, exactly
     * as on the Windows sibling. */
    const needed = toolGuard(action, 'capture') || toolGuard(action, 'digest');
    if (needed) return { ...header, ...needed };
    return { ...header, ...(await captureScreen({ ...options, action })) };
  }
  if (action === 'observe') {
    const needed = toolGuard(action, 'capture') || toolGuard(action, 'digest');
    if (needed) return { ...header, ...needed };
    return await observeAction(action, options, mode, header);
  }
  if (action === 'app_observe') {
    const needed = toolGuard(action, 'capture') || toolGuard(action, 'digest');
    if (needed) return { ...header, ...needed };
    return await appObserveAction(action, options, mode, header);
  }
  if (action === 'app_activate') return await appActivateAction(action, options, mode, header);
  if (action === 'move' || action === 'click' || action === 'drag' || action === 'scroll' || action === 'type' || action === 'key') {
    const needed = toolGuard(action, 'input');
    if (needed) return { ...header, ...needed };
    return await desktopPhysicalAction(action, options, mode, header);
  }
  if (action === 'app_click' || action === 'app_drag' || action === 'app_scroll' || action === 'app_type' || action === 'app_key') {
    const needed = toolGuard(action, 'input');
    if (needed) return { ...header, ...needed };
    return await appPhysicalAction(action, options, mode, header);
  }
  if (action === 'sequence') {
    // A step that would deliver input needs an input backend, and naming it here is more useful
    // than failing later on the window lookup. A wait-only sequence delivers nothing, so it is
    // never refused for want of an input backend it would not use.
    const steps = Array.isArray(options.steps) ? options.steps : [];
    const delivers = steps.some(step => step && ['move', 'click', 'drag', 'scroll', 'type', 'key'].includes(String(step.action || '').toLowerCase()));
    if (delivers) {
      const needed = toolGuard(action, 'input');
      if (needed) return { ...header, ...needed };
    }
    return await executeSequence(options, header);
  }
  return failure(action, 'unknown_action', `Unknown computer_use action: ${action}.`, { supported_actions: [...ALL_ACTIONS] });
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
    code: compact.code,
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
