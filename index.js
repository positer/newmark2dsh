/**
 * Newmark Core — the **core component**.
 *
 * The bundle carries four independent Loader rows, each its own switch:
 *
 * | Row | Module | Responsibility |
 * |---|---|---|
 * | `newmark-core` | `newmark2dsh` | this file: the shared Newmark root and its config |
 * | `newmark-memorylab` | `./memorylab.js` | the MemoryLab store, the five `memory_lab_*` tools |
 * | `newmark-computeruse` | `./computeruse.js` | the automation backends, the two ComputerUse tools |
 * | `preset-dev` | `@deepseek-ai/dsh-agent-preset` | the Dev agent preset declaration |
 *
 * ## Why the rows do not call each other
 *
 * Cordis resolves a service by walking *up* the consumer fiber's ancestry, so a
 * service provided by one row is visible to that row's descendants and **not to
 * its siblings**. Four sibling rows therefore cannot share a service: a row that
 * injected a sibling's service sat at `waiting for service` indefinitely, and
 * providing from the root scope did not satisfy the Loader's dependency graph
 * either. Both were tried against the running profile; neither activated.
 *
 * So the rows are coupled by nothing at runtime. Each publishes its own page
 * global, and the Client half reads all three:
 *
 * - `window.__NEWMARK_CORE__` — this row: the shared root and the platform.
 * - `window.__NEWMARK_MEMORYLAB__` — the store snapshot, from the MemoryLab row.
 * - `window.__NEWMARK_COMPUTERUSE__` — the lease mirror, from the ComputerUse row.
 *
 * **Presence is the switch.** A global that is not on the page means that row is
 * off, so switching a component off retires it completely — its tools are never
 * registered, it publishes nothing, and the Client half registers none of its
 * seats — with no coordination, and no way for one component to break another.
 *
 * ## No server, no port
 *
 * The data does not come from an endpoint this bundle opens. Each row contributes
 * its own `webServer.tapIndex` transform, so the HTML the shell already serves at
 * page load carries the snapshot as page globals.
 */
import { schema } from './lib/schema.js';
import { defaultRoot, resolveRoot } from './lib/root.js';
import { embedJson } from './lib/embed.js';

/** The page global this row publishes. */
export const SNAPSHOT_GLOBAL = '__NEWMARK_CORE__';

export { defaultRoot, resolveRoot, embedJson };

/** The shared root, for the Client half and for diagnostics. */
export const Config = schema
  ? schema.object({
      root: schema
        .string()
        .description("The shared Newmark user root. Empty means Newmark's own path, ~/.Newmark.")
        .default(''),
    })
  : undefined;

export const name = 'newmark-core';

export const inject = ['webServer'];

export function apply(ctx, config) {
  const root = resolveRoot(config);

  ctx.logger?.info?.(`newmark-core: core component active, root=${root}, platform=${process.platform}`);

  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        const payload = {
          ok: true,
          role: 'core',
          root,
          platform: process.platform,
          generatedAt: new Date().toISOString(),
        };
        const script = `<script>window.${SNAPSHOT_GLOBAL}=${embedJson(payload)};</script>`;
        const at = html.indexOf('</head>');
        return at === -1 ? script + html : html.slice(0, at) + script + html.slice(at);
      }),
    'newmark-core-index-injection',
  );
}
