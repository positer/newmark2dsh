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

/** Newmark's action surface, exactly. */
export const COMPUTER_USE_ACTIONS = [
  'observe', 'app_list', 'app_observe', 'wait_for', 'sequence',
  'takeover_start', 'takeover_stop', 'move', 'click', 'drag', 'scroll',
  'type', 'key', 'wait', 'app_activate', 'app_click', 'app_drag',
  'app_scroll', 'app_type', 'app_key', 'mode_report',
];

/** Newmark's lease TTL, as a named constant rather than a repeated literal. */
export const LEASE_TTL_MS = 120_000;

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

export function createComputerUse({ captionDir, logger, leaseTtlMs = LEASE_TTL_MS } = {}) {
  /** The lease lifetime this instance uses; the exported constant is the default. */
  const ttlMs = Number.isFinite(leaseTtlMs) && leaseTtlMs > 0 ? Math.floor(leaseTtlMs) : LEASE_TTL_MS;
  /** The last lease this component observed; refreshed on every lease action. */
  let lease = { ownerId: '', mouseMode: 'real', acquiredAt: 0, expiresAt: 0 };

  /** Read the mirror without mutating it: an expired lease reads as free. */
  function leaseView() {
    const now = Date.now();
    const held = Boolean(lease.ownerId) && lease.expiresAt > now;
    return {
      held,
      ownerId: held ? lease.ownerId : '',
      mouseMode: held ? lease.mouseMode : 'real',
      acquiredAt: held ? lease.acquiredAt : 0,
      expiresAt: held ? lease.expiresAt : 0,
      ttlMs: ttlMs,
      remainingMs: held ? lease.expiresAt - now : 0,
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
        return null;
      }
    })();
    return backendPromise;
  }

  /** Keep the lease mirror in step with what the backend actually did. */
  function observeLeaseArgs(args, result) {
    const action = String(args?.action || '');
    if (action === 'takeover_start') {
      const requested = args?.mouse_mode === 'virtual' ? 'virtual' : 'real';
      lease = { ownerId: String(args?.owner_id || 'dsh'), mouseMode: requested, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs };
    } else if (action === 'takeover_stop') {
      lease = { ownerId: '', mouseMode: 'real', acquiredAt: 0, expiresAt: 0 };
    } else if (typeof result === 'string') {
      // A refusal that names another owner is authoritative: mirror it.
      try {
        const parsed = JSON.parse(result);
        if (parsed && parsed.lock_owner && parsed.ok === false) {
          lease = { ...lease, ownerId: String(parsed.lock_owner), expiresAt: Math.max(lease.expiresAt, Date.now() + ttlMs) };
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
            const result = await backend.runComputerUse({
              ...args,
              imageDir: captionDir,
              ownerId: String(args?.owner_id || 'dsh'),
              mouseMode: args?.mouse_mode,
            });
            observeLeaseArgs(args, result);
            return asToolResult(result);
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
            return asToolResult(await backend.runComputerUse({
              action: application ? 'app_observe' : 'observe',
              appTarget: args?.app_target,
              windowHandle: args?.window_handle,
              captureMaxWidth: args?.capture_max_width,
              captureMaxHeight: args?.capture_max_height,
              imageDir: captionDir,
              // `screen_capture` deliberately never touches the lease.
              ownerId: 'screen-capture',
              skipLease: true,
            }));
          },
        },
      ];
    },
  };
}
