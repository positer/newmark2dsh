/**
 * Newmark Core — the **ComputerUse** component.
 *
 * Owns the platform automation backends and the two model-facing tools, and
 * keeps a synchronous mirror of the exclusive descent lease so the injected page
 * snapshot can carry it without an async call during an index render.
 *
 * Everything here is plugin-owned: `lib/win32.js` is the Windows backend and
 * `lib/linux.js` is the Linux backend, both loaded lazily so a platform without
 * one — or a backend that fails to load — degrades to a structured error instead
 * of taking the plugin down. No harness package is imported.
 *
 * The retired on-device perception line has no representation here: this
 * component carries no learned model, no artifact loader, no ABI validator, no
 * inference runtime and no accelerator path. The release gate asserts that the
 * package's source never names that line at all, so the prohibition is checked
 * mechanically instead of being promised in prose.
 */

import { causeChain, createErrorLog, describeError } from '../../lib/errors.js';

/** Newmark's action surface, exactly. */
export const COMPUTER_USE_ACTIONS = [
  'observe', 'app_list', 'app_observe', 'wait_for', 'sequence',
  'takeover_start', 'takeover_stop', 'move', 'click', 'drag', 'scroll',
  'type', 'key', 'wait', 'app_activate', 'app_click', 'app_drag',
  'app_scroll', 'app_type', 'app_key', 'mode_report',
];

/**
 * The takeover lease has no time limit, so there is no TTL constant.
 *
 * A lease ends when `takeover_stop` releases it, or when the owning process dies. The
 * mirror below reports `expiresAt`, `ttlMs` and `remainingMs` as `null` rather than as a
 * number, because any number there would be read as a real deadline by a caller that
 * trusts it.
 */
export const LEASE_EXPIRY = 'none';

/**
 * The value a tool returns.
 *
 * The backends answer with a JSON string for the same reason a CLI does — it is the
 * transport Newmark's own modules exchange — while a tool's declared output is an
 * object. Parsing here keeps the two honest, and a non-JSON answer becomes a
 * reported result instead of a validation failure.
 */
function asToolResult(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not JSON: fall through and report it as text */
    }
    return { ok: true, text: value };
  }
  return { ok: false, code: 'backend_no_result', error: 'the ComputerUse backend returned no result' };
}

function toolText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * The declared parameter surface is snake_case; the backends read camelCase.
 *
 * The two families do not meet on their own. `execute` used to spread the tool's arguments
 * straight into `runComputerUse`, so every parameter a backend reads only in its camelCase
 * spelling was silently discarded - `dry_run` most seriously, because a caller that asked
 * for a dry run got a real one and no field saying otherwise.
 *
 * A few names were carried across all along, each by accident rather than by a rule: the
 * backends happen to accept both spellings of `scroll_x`/`scroll_y`, `sparse_wait_ms` and
 * `duration_ms` (`lib/win32.js:3562`, `:3318`, `:3279`), and of `app_target` and
 * `window_handle` (`:2326`, `:1802`). Those work today and are mapped here too, so they no
 * longer depend on a fallback surviving.
 *
 * This table is the whole translation, and it is deliberately explicit rather than
 * generated from a case rule: a generated one would also rewrite `action`, `x`, `y`, `text`,
 * `key`, `button` and `steps`, which are spelled the same in both families, and it would
 * silently "fix" any future parameter whether or not a backend read exists for it. A name
 * belongs here only when a read of that camelCase name exists in a backend.
 *
 * `include_ui_tree` is absent on purpose: no backend reads it under any spelling, so giving
 * it a camelCase name would only hide that it does nothing.
 */
const SNAKE_TO_CAMEL = Object.freeze({
  owner_id: 'ownerId',
  mouse_mode: 'mouseMode',
  app_target: 'appTarget',
  window_handle: 'windowHandle',
  target_id: 'targetId',
  scroll_x: 'scrollX',
  scroll_y: 'scrollY',
  duration_ms: 'durationMs',
  timeout_ms: 'timeoutMs',
  sparse_wait_ms: 'sparseWaitMs',
  capture_max_width: 'captureMaxWidth',
  capture_max_height: 'captureMaxHeight',
  max_chars: 'maxChars',
  dry_run: 'dryRun',
  start_x: 'startX',
  start_y: 'startY',
  end_x: 'endX',
  end_y: 'endY',
});

/**
 * The declared tool arguments under the backends' own option names.
 *
 * A camelCase key from the caller has no snake_case sibling to collide with, so it is left
 * as it stands: a direct `runComputerUse` dispatch and a tool call then land on the same
 * option. When a caller sends both spellings of one parameter the declared spelling wins,
 * because that is the contract the schema publishes.
 */
function backendOptions(args) {
  const source = args && typeof args === 'object' ? args : {};
  const translated = { ...source };
  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (source[snake] === undefined) continue;
    translated[camel] = source[snake];
    delete translated[snake];
  }
  return translated;
}

export function createComputerUse({ captionDir, root, logger, leaseTtlMs } = {}) {
  /**
   * The bundle's failure log, from the shared root rule.
   *
   * A backend that will not load, a lane that will not start, a tool that answers an error:
   * each is a failure behaviour and each is written to `<root>/errors.jsonl` AND printed.
   * `root` is the one the core row resolves (`lib/root.js`), so a redirected
   * `NEWMARK_USER_ROOT` moves this log with the store rather than leaving it behind.
   */
  const failures = createErrorLog({ root, logger });

  /**
   * The frozen Loader row (`index.js`) still declares a `leaseTtlMs` setting and passes it
   * here. There is no TTL any more, so it is deliberately inert - but it is reported as
   * `ignored_lease_ttl_ms` rather than swallowed, so a caller that sets it can see it had
   * no effect instead of believing it shortened or lengthened the lease.
   */
  const ignoredLeaseTtlMs = Number.isFinite(leaseTtlMs) && leaseTtlMs > 0 ? Math.floor(leaseTtlMs) : null;
  /** The last lease this component observed; refreshed on every lease action. */
  let lease = { ownerId: '', mouseMode: 'real', acquiredAt: 0 };

  /**
   * Read the mirror without mutating it.
   *
   * A held lease stays held: the mirror has no clock, matching the backend, which no longer
   * expires a lease on a timer. The three duration fields are `null` - "no expiry" - and
   * `expiry` says so in words.
   */
  function leaseView() {
    const held = Boolean(lease.ownerId);
    return {
      held,
      ownerId: held ? lease.ownerId : '',
      mouseMode: held ? lease.mouseMode : 'real',
      acquiredAt: held ? lease.acquiredAt : 0,
      expiry: LEASE_EXPIRY,
      expiresAt: null,
      ttlMs: null,
      remainingMs: null,
      releasedBy: 'takeover_stop',
      ignored_lease_ttl_ms: ignoredLeaseTtlMs,
    };
  }

  /**
   * Load the platform backend lazily and cache the outcome. A missing backend is
   * a reported capability gap, never a crash.
   */
  let backendPromise = null;

  /**
   * Why no backend is available, as a code and a message.
   *
   * Two different failures used to share one answer: a platform this plugin has no
   * backend for, and a backend that exists but could not be loaded. The second is a
   * defect with a cause worth carrying, so it is reported as its own code and the
   * underlying message is never swallowed.
   */
  let backendFailure = null;

  function loadBackend() {
    backendPromise ??= (async () => {
      const wanted = process.platform === 'win32' ? './lib/win32.js' : process.platform === 'linux' ? './lib/linux.js' : '';
      if (!wanted) {
        backendFailure = {
          code: 'unsupported_platform',
          error: `Computer Use has no backend for ${process.platform}. Windows and Linux are supported.`,
        };
        failures.record({
          where: 'computeruse/backend',
          code: backendFailure.code,
          message: backendFailure.error,
          fields: { platform: process.platform },
        });
        return null;
      }
      try {
        return await import(wanted);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        backendFailure = {
          code: 'backend_unavailable',
          error: `Computer Use could not load its ${process.platform} backend (${wanted}): ${detail}`,
        };
        logger?.warn?.(`newmark-core/computeruse: ${backendFailure.error}`);
        /* THE CAUSE, RECORDED ONCE. Every tool call after this answers the cached
         * `UNAVAILABLE(action)`, and that per-call answer is deliberately NOT recorded again:
         * one backend that will not load is one failure, and a line per call would turn a
         * broken install into a file nobody can read to the end of. The `detail` is what makes
         * this line worth having — the module path and the loader's own message. */
        failures.record({
          where: 'computeruse/backend',
          code: backendFailure.code,
          message: backendFailure.error,
          detail: causeChain(error),
          fields: { platform: process.platform, module: wanted },
        });
        return null;
      }
    })();
    return backendPromise;
  }

  /**
   * A result the backend answered with, recorded when it is a failure.
   *
   * The spec names three ComputerUse failures — the lane failing to start, a backend error, and
   * the tool returning an error — and this is the third. `ok:false` is the whole test: the
   * backend's own code is recorded verbatim (`error_code` in the shipped backends, `code` in the
   * tool layer's own `backend_no_result`), and so is its own sentence. A refusal the backend
   * chose to phrase as a failure is still an action that did not happen, and recording it with
   * the code that names it is the opposite of disguising it.
   *
   * `detail` is deliberately empty here: there is no cause chain, and inventing one would be
   * this module summarising a failure the backend already names.
   */
  function reportOutcome(action, value) {
    if (!value || typeof value !== 'object' || value.ok !== false) return;
    failures.record({
      where: 'computeruse/backend',
      code: String(value.code || value.error_code || 'backend_error'),
      message: String(value.error || value.output || `the ${action} action reported a failure`),
      fields: { action: String(action) },
    });
  }

  /**
   * Run one backend call: record what it threw, and record what it answered.
   *
   * The shipped backends catch their own failures and answer a structured result, so the throw
   * path is for a backend that misbehaves — which is exactly when a silent failure would be
   * hardest to find. The error is re-thrown so the registry's `isError` result is unchanged.
   */
  async function runBackend(backend, options) {
    let raw;
    try {
      raw = await backend.runComputerUse(options);
    } catch (error) {
      failures.record({
        where: 'computeruse/backend',
        code: 'backend_threw',
        message: `the Computer Use backend threw on ${String(options?.action || 'observe')}: ${describeError(error)}`,
        detail: causeChain(error),
        fields: { action: String(options?.action || 'observe'), platform: process.platform },
      });
      throw error;
    }
    const value = asToolResult(raw);
    reportOutcome(String(options?.action || 'observe'), value);
    return value;
  }

  /** Keep the lease mirror in step with what the backend actually did. */
  function observeLeaseArgs(args, result) {
    const action = String(args?.action || '');
    if (action === 'takeover_start') {
      const requested = args?.mouse_mode === 'virtual' ? 'virtual' : 'real';
      lease = { ownerId: String(args?.owner_id || 'dsh'), mouseMode: requested, acquiredAt: Date.now() };
    } else if (action === 'takeover_stop') {
      lease = { ownerId: '', mouseMode: 'real', acquiredAt: 0 };
    } else if (typeof result === 'string') {
      // A refusal that names another owner is authoritative: mirror it. It does not expire.
      try {
        const parsed = JSON.parse(result);
        if (parsed && parsed.lock_owner && parsed.ok === false) {
          lease = { ...lease, ownerId: String(parsed.lock_owner) };
        }
      } catch {
        /* a non-JSON result carries no lease information */
      }
    }
  }

  const UNAVAILABLE = (action) => ({
    ok: false,
    action,
    code: (backendFailure && backendFailure.code) || 'backend_unavailable',
    error: (backendFailure && backendFailure.error) || `Computer Use has no backend for ${process.platform}.`,
  });

  return {
    name: 'computeruse',
    leaseView,

    /** The two model-facing tools, bundled with this component. */
    tools() {
      return [
        {
          name: 'computer_use',
          description:
            'Drive this desktop through Newmark ComputerUse. Accepts the full action surface (observe, app_list, app_observe, wait_for, sequence, takeover_start, takeover_stop, move, click, drag, scroll, type, key, wait, app_activate and the app_* variants). Mouse mode is bound for the session at takeover_start only, and the takeover lease is exclusive to one owner.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: COMPUTER_USE_ACTIONS },
              mouse_mode: { type: 'string', enum: ['real', 'virtual'], description: 'Accepted on takeover_start only.' },
              owner_id: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              start_x: { type: 'number' },
              start_y: { type: 'number' },
              end_x: { type: 'number' },
              end_y: { type: 'number' },
              target_id: { type: 'string' },
              app_target: { type: 'string' },
              window_handle: { type: 'string' },
              button: { type: 'string', enum: ['left', 'right'] },
              text: { type: 'string' },
              key: { type: 'string' },
              scroll_x: { type: 'number' },
              scroll_y: { type: 'number' },
              duration_ms: { type: 'number' },
              timeout_ms: { type: 'number' },
              sparse_wait_ms: { type: 'number' },
              include_ui_tree: { type: 'boolean' },
              capture_max_width: { type: 'number' },
              capture_max_height: { type: 'number' },
              max_chars: { type: 'number' },
              dry_run: { type: 'boolean' },
              steps: { type: 'array', items: { type: 'object' } },
            },
            required: ['action'],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },
          async execute(args) {
            const action = String(args?.action || 'observe');
            const backend = await loadBackend();
            if (!backend) return UNAVAILABLE(action);
            /**
             * The declared arguments are translated before they are handed over. Nothing
             * above this line and nothing below it changes: the schema keeps publishing
             * snake_case, and the backend keeps reading camelCase.
             */
            const translated = backendOptions(args);
            const result = await runBackend(backend, {
              ...translated,
              imageDir: captionDir,
              ownerId: String(translated.ownerId || 'dsh'),
              mouseMode: translated.mouseMode,
            });
            observeLeaseArgs(translated, result);
            return result;
          },
        },
        {
          name: 'screen_capture',
          description:
            'Read-only desktop or application capture. Never acquires or mutates the Computer Use lease, so it is safe to call while another owner holds it.',
          parameters: {
            type: 'object',
            properties: {
              target: { type: 'string', enum: ['desktop', 'application'] },
              app_target: { type: 'string' },
              window_handle: { type: 'string' },
              capture_max_width: { type: 'number' },
              capture_max_height: { type: 'number' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },
          async execute(args) {
            const backend = await loadBackend();
            if (!backend) return UNAVAILABLE('observe');
            const application = String(args?.target || 'desktop') === 'application';
            return runBackend(backend, {
              action: application ? 'app_observe' : 'observe',
              appTarget: args?.app_target,
              windowHandle: args?.window_handle,
              captureMaxWidth: args?.capture_max_width,
              captureMaxHeight: args?.capture_max_height,
              imageDir: captionDir,
              // `screen_capture` deliberately never touches the lease.
              ownerId: 'screen-capture',
              skipLease: true,
            });
          },
        },
      ];
    },
  };
}
