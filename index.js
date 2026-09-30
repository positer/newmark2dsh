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
      compose: schema
        .boolean()
        .description(
          'Load the MemoryLab and ComputerUse components from inside this row instead of ' +
            'declaring them as separate Loader rows. On by default: this is how the bundle ships.',
        )
        .default(true),
    })
  : undefined;

export const name = 'newmark-core';

export const inject = ['webServer'];

/**
 * The components this row loads itself. Paths, so nothing has to resolve packages.
 *
 * Each entry carries the config its component's own row used to receive from the patch,
 * so composing changes how a component is loaded and not what it is configured with.
 */
const COMPONENTS = {
  memoryLab: {
    load: () => import('./components/memorylab/index.js'),
    config: (root) => ({ root, language: 'auto', reindexOnRender: true }),
  },
  computerUse: {
    load: () => import('./components/computeruse/index.js'),
    config: () => ({ leaseTtlMs: 120000 }),
  },
};

/**
 * The composed components, by name.
 *
 * The value is whatever ctx.plugin returns - a fiber in Cordis - and disposing it is
 * what unloads the component. Keeping it is the difference between a switch that works
 * and a switch that only looks like one.
 */
const composed = new Map();

/** The page global each component publishes, which is how its state is observed. */
const COMPONENT_GLOBALS = {
  memoryLab: '__NEWMARK_MEMORYLAB__',
  computerUse: '__NEWMARK_COMPUTERUSE__',
};

export function apply(ctx, config) {
  const root = resolveRoot(config);

  /** Dispose a composed component, which unregisters its tools. */
  const unmount = (name) => {
    const fiber = composed.get(name);
    composed.delete(name);
    try {
      fiber?.dispose?.();
    } catch (error) {
      ctx.logger?.warn?.(
        'newmark-core: ' + name + ' did not unmount cleanly: ' + (error?.message ?? error),
      );
    }
    return fiber !== undefined;
  };

  /** Compose a component that is not currently mounted. */
  const mount = (name) => {
    if (composed.has(name) || config?.compose !== true) return false;
    const component = COMPONENTS[name];
    if (!component) return false;
    component
      .load()
      .then((module) => {
        if (!composed.has(name)) composed.set(name, ctx.plugin(module, component.config(root)));
      })
      .catch((error) => {
        ctx.logger?.error?.(
          'newmark-core: ' + name + ' failed to compose: ' + (error?.message ?? error),
        );
      });
    return true;
  };

  /**
   * A same-origin control surface for this bundle own config page.
   *
   * Reading is a plain GET. Switching is a POST carrying component and enabled, which is
   * the only write this bundle accepts: it changes which of its own components are
   * loaded and nothing else. It never touches the shared user store.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/newmark-core/components',
        handler: (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };

          if (req.method === 'GET') {
            // The preset is a Loader row, not a composed component, so its state comes
            // from the shell's config editor rather than from `composed`. It is read
            // here and concatenated — an earlier version spread an array into this
            // object literal, which produced a stray numeric key and no `presetDev`
            // entry at all, so the panel could never show the preset's real state.
            const presetEntry = (() => {
              const editor = ctx.configEditor;
              if (!editor || typeof editor.configuration !== 'function') return [];
              const row = editor.configuration().find((r) => r?.entry?.id === 'preset-dev');
              if (!row) return [];
              return [{ name: 'presetDev', mounted: row.entry.disabled !== true, global: null }];
            })();

            send(200, {
              ok: true,
              compose: config?.compose === true,
              components: [
                ...Object.keys(COMPONENTS).map((name) => ({
                  name,
                  mounted: composed.has(name),
                  global: COMPONENT_GLOBALS[name],
                })),
                ...presetEntry,
              ],
            });
            return;
          }

          if (req.method !== 'POST') {
            send(405, { ok: false, error: 'method_not_allowed' });
            return;
          }

          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 4096) req.destroy();
          });
          req.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(body || '{}');
            } catch {
              send(400, { ok: false, error: 'invalid_json' });
              return;
            }
            const name = String(parsed.component || '');
            const wanted = parsed.enabled === true;

            // The preset is tested FIRST, and deliberately not through COMPONENTS: it is a
            // Loader row rather than something this bundle composes, so it has no entry in
            // that map. Checking COMPONENTS first made this branch unreachable — the panel
            // offered a switch that could only ever answer unknown_component.
            if (name === 'presetDev') {
              const editor = ctx.configEditor;
              if (!editor || typeof editor.edit !== 'function') {
                send(501, { ok: false, error: 'config_editor_unavailable' });
                return;
              }
              const all = typeof editor.configuration === 'function' ? editor.configuration() : [];
              const found = all.find((row) => row?.entry?.id === 'preset-dev');
              if (!found) {
                send(404, { ok: false, error: 'preset_row_not_found' });
                return;
              }
              editor
                .edit(found.entry, (current) => ({ ...current, disabled: !wanted }))
                .then(() => {
                  ctx.logger?.info?.('newmark-core: preset-dev ' + (wanted ? 'enabled' : 'disabled'));
                  send(200, { ok: true, component: name, enabled: wanted, application: 'applied' });
                })
                .catch((error) => {
                  send(500, { ok: false, error: 'edit_failed', detail: String(error?.message ?? error) });
                });
              return;
            }
            if (!COMPONENTS[name]) {
              send(400, { ok: false, error: 'unknown_component', component: name });
              return;
            }
            const changed = wanted ? mount(name) : unmount(name);
            ctx.logger?.info?.(
              'newmark-core: ' + name + (wanted ? ' composed' : ' unmounted') + (changed ? ' (changed)' : ' (no change)'),
            );
            send(200, {
              ok: true,
              component: name,
              enabled: wanted,
              mounted: composed.has(name) || wanted,
              changed,
            });
          });
        },
      }),
    'newmark-core-component-controls',
  );

  ctx.logger?.info?.(`newmark-core: core component active, root=${root}, platform=${process.platform}`);

  // Composed rather than declared: one Loader row means the plugin card shows one row,
  // so nothing in the UI has to render a module path. The components are ordinary ESM
  // imports of files that ship inside this package, so no package manager has to
  // resolve anything and the profile needs no state of its own.
  if (config?.compose === true) {
    for (const [name, component] of Object.entries(COMPONENTS)) {
      ctx.effect(
        () => {
          let cancelled = false;
          component
            .load()
            .then((module) => {
              if (cancelled) return;
              composed.set(name, ctx.plugin(module, component.config(root)));
            })
            .catch((error) => {
              ctx.logger?.error?.(
                'newmark-core: ' + name + ' failed to compose: ' + (error?.message ?? error),
              );
            });
          return () => {
            cancelled = true;
            unmount(name);
          };
        },
        'newmark-compose-' + name,
      );
    }
  }

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
