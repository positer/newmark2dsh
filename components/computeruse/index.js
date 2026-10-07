/**
 * Newmark Core — the **ComputerUse component**.
 *
 * Owns the automation backends (Windows and Linux) and the two tools,
 * `computer_use` and `screen_capture`, and publishes
 * `window.__NEWMARK_COMPUTERUSE__` for the Client half.
 *
 * It is an independent Loader row: disabling `newmark-computeruse` retires the
 * whole component — no tools are registered, nothing is published, and the Client
 * half therefore draws no takeover stroke.
 *
 * It is deliberately implicit in the UI. ComputerUse never adds a sidebar entry or
 * a panel; its only visible surface is the takeover stroke, drawn by the Client
 * half from the lease this row publishes. Like the MemoryLab row it depends on no
 * sibling row.
 */
import { createComputerUse } from './component.js';
import { schema } from './lib/schema.js';
import { embedJson } from './lib/embed.js';
import { resolveRoot } from './lib/root.js';
import { installMenuThemeBridge } from './lib/desktop-menu-theme.js';

/** The page global this row publishes. */
export const SNAPSHOT_GLOBAL = '__NEWMARK_COMPUTERUSE__';

export const name = 'newmark-computeruse';

export const inject = ['tools', 'webServer'];

export const Config = schema
  ? schema.object({
      root: schema
        .string()
        .description(
          "The shared Newmark user root. Empty means Newmark's own path, ~/.Newmark. This component " +
            'owns no store of its own: the root is what places its failure log beside the one the ' +
            'MemoryLab store lives in.',
        )
        .default(''),
      leaseTtlMs: schema
        .natural()
        .description('How long a ComputerUse takeover lease stays valid, in milliseconds.')
        .default(120000),
    })
  : undefined;

export function apply(ctx, config) {
  /* The same rule every other row resolves its root with (`lib/root.js`), read here for ONE
   * reason: a backend failure is written to `<root>/errors.jsonl`. It is deliberately not a
   * second path computation — a component that worked out its own root would be able to log a
   * failure somewhere other than where the store is, which is the thing the shared rule exists
   * to prevent. */
  const root = resolveRoot(config);
  const leaseTtlMs = Number.isFinite(config?.leaseTtlMs) && config.leaseTtlMs > 0 ? Math.floor(config.leaseTtlMs) : 120000;

  const computeruse = createComputerUse({ root, logger: ctx.logger, leaseTtlMs });
  const menuTheme = process.platform === 'win32' ? installMenuThemeBridge(ctx, root) : null;

  const definitions = computeruse.tools();
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `newmark-computeruse-tool-${definition.name}`);
  }

  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        let payload;
        try {
          payload = computeruse.leaseView();
        } catch {
          payload = { held: false, ownerId: '', mouseMode: 'real', ttlMs: 0, remainingMs: 0 };
        }
        const script = `<script>window.${SNAPSHOT_GLOBAL}=${embedJson({...payload, menuTheme})};</script>`;
        const at = html.indexOf('</head>');
        return at === -1 ? script + html : html.slice(0, at) + script + html.slice(at);
      }),
    'newmark-computeruse-index-injection',
  );

  ctx.logger?.info?.(
    `newmark-computeruse: active, platform=${process.platform}, leaseTtlMs=${leaseTtlMs} (${definitions.length} tools)`,
  );
}
