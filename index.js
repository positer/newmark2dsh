/**
 * Newmark Core — the **core component**.
 *
 * The bundle carries three components, and the Loader carries two rows:
 *
 * | Component | Loaded as | Responsibility |
 * |---|---|---|
 * | `newmark-core` | Loader row `newmark-core` → `newmark2dsh` | this file: the shared Newmark root and its config |
 * | `newmark-memorylab` | a child of this row's fiber (`ctx.plugin`) | the MemoryLab store, the five `memory_lab_*` tools |
 * | `newmark-computeruse` | a child of this row's fiber (`ctx.plugin`) | the automation backends, the two ComputerUse tools |
 * | Dev preset | Loader row `preset-dev` → `@deepseek-ai/dsh-agent-preset` | the Dev agent preset declaration, selected by the `agent-preset-registry` entry's `selectedDefault` in the profile patch |
 *
 * ## Why the components do not call each other
 *
 * Cordis resolves a service by walking *up* the consumer fiber's ancestry, so a
 * service provided by one row is visible to that row's descendants and **not to
 * its siblings**. Sibling rows therefore cannot share a service: a row that
 * injected a sibling's service sat at `waiting for service` indefinitely, and
 * providing from the root scope did not satisfy the Loader's dependency graph
 * either. Both were tried against the running profile; neither activated.
 *
 * So the components are coupled by nothing at runtime. Each publishes its own page
 * global, and the Client half reads all three:
 *
 * - `window.__NEWMARK_CORE__` — this row: the shared root and the platform.
 * - `window.__NEWMARK_MEMORYLAB__` — the store snapshot, from the MemoryLab component.
 * - `window.__NEWMARK_COMPUTERUSE__` — the lease mirror, from the ComputerUse component.
 *
 * **Presence is the switch.** A global that is not on the page means that component
 * is off, so switching one off retires it completely — its tools are never
 * registered, it publishes nothing, and the Client half registers none of its
 * seats — with no coordination, and no way for one component to break another.
 *
 * The preset is the one component this row does not mount: it is a Loader row, and what the
 * switch changes is *which preset the registry selects*, a value in the profile patch
 * (`lib/preset-row.js`).
 *
 * ## No server, no port
 *
 * The data does not come from an endpoint this bundle opens. Each component
 * contributes its own `webServer.tapIndex` transform, so the HTML the shell already
 * serves at page load carries the snapshot as page globals. The one route this
 * bundle does register is its own control surface — the two composed switches and
 * the preset row's selection.
 */
import { schema } from './lib/schema.js';
import { defaultRoot, resolveRoot } from './lib/root.js';
import { embedJson } from './lib/embed.js';
import {
  PRESET_COMPONENT_KEY,
  PRESET_ID,
  PRESET_ROW_ID,
  SELECTOR_ENTRY_ID,
  SELECTOR_ENTRY_NAME,
  patchPathOf,
  readPresetFromProfile,
  setPresetSelected,
} from './lib/preset-row.js';

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

// ## What this row injects, and why exactly this
//
// `webServer` is the one route this bundle owns. `profileContext` is how the profile
// directory is *named* rather than guessed — it is the service `dsh-plugin-manager`
// itself injects alongside `loader`, and the object `dsh-app-boot` provides with
// `{ name, dir, patchPath, … }`. The preset switch writes the `selectedDefault` of the
// `agent-preset-registry` entry in `<profile>/cordis.patch.yml`, so it needs that path and
// nothing else; with the service absent the route answers 501 and says so instead of
// inventing a path.
//
// `configEditor` was injected here once, and is not any more. It was used to toggle the
// Dev preset, which was the wrong mechanism — `edit` writes a row's *config*, so
// `disabled` landed inside the row's config object where no plugin Config has such a
// field, was accepted, and did nothing. The value this half writes now is a config field
// the registry really reads, and it reaches the file through this bundle's own validated
// write rather than through the editor.
//
// Kept as a note because the failure Cordis causes here is worth recognising: Cordis
// THROWS on reading a service property that was not declared in `inject`, so there is
// no such thing as defensive access — the property read itself is the throw. A guard
// around the *call* did not help, because the throw happened one line earlier, at the
// read, escaped the route handler, and ended the Host process with exit code 1.
export const inject = ['webServer', 'profileContext'];

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
   * loaded, or the enablement of its own preset row, and nothing else. It never touches
   * the shared user store.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/newmark-core/components',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };

          // A route handler runs with no caller above it to catch anything, so an
          // exception thrown here does not become a failed request — it takes the whole
          // Host process down. That is exactly what happened: reading the shell's config
          // editor threw, the throw escaped this handler, and DSH Desktop reported
          // "运行会话的后台服务已停止，退出码 1". Every path below is guarded so the worst
          // case is a 500 the panel can display.
          const safe = (body) => {
            try {
              return body();
            } catch (error) {
              ctx.logger?.warn?.('newmark-core: control route failed: ' + (error?.message ?? error));
              send(500, { ok: false, error: 'handler_failed', detail: String(error?.message ?? error) });
              return undefined;
            }
          };

          /**
           * The preset selection's real state, read from `<profile>/cordis.patch.yml`.
           *
           * What the switch changes is the `agent-preset-registry` entry's
           * `config.selectedDefault`, in the PROFILE patch, so the file is the only thing
           * that knows the truth. `profileContext` is what names that file; without it the
           * answer is 501 and no path is guessed.
           */
          const presetState = () => {
            const profile = ctx.profileContext;
            if (profile === undefined || profile === null || patchPathOf(profile) === null) {
              return {
                ok: false,
                error: 'profile_context_unavailable',
                detail:
                  'the profileContext service names no profile patch path, so this half cannot read or ' +
                  'write the preset selection; no path is guessed',
              };
            }
            const state = readPresetFromProfile(profile);
            return {
              ...state,
              // What the panel asked for, what it is called, and where the value lives:
              // the wire key, the preset identity, and the two entries involved — the one
              // declaring the preset and the one selecting it.
              component: PRESET_COMPONENT_KEY,
              preset: PRESET_ID,
              selector: SELECTOR_ENTRY_ID,
              declaredBy: PRESET_ROW_ID,
              name: SELECTOR_ENTRY_NAME,
              // `mounted` is the field the panel already reads for the composed
              // components, so the preset answers in the same shape: the Dev preset is
              // "on" exactly when the registry selects it.
              mounted: state.ok === true ? state.enabled === true : false,
            };
          };

          if (req.method === 'GET') {
            // The preset is not a composed component, so its state is read from the
            // profile patch rather than from `composed`. Its key is the constant the POST
            // branch below compares against and the client row sends, spelled once.
            send(
              200,
              safe(() => ({
                ok: true,
                compose: config?.compose === true,
                components: [
                  ...Object.keys(COMPONENTS).map((name) => ({
                    name,
                    mounted: composed.has(name),
                    global: COMPONENT_GLOBALS[name],
                  })),
                ],
                [PRESET_COMPONENT_KEY]: presetState(),
              })) ?? { ok: false, error: 'handler_failed' },
            );
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

            // The preset is tested FIRST, and deliberately not through COMPONENTS: it is
            // not something this bundle composes, so it has no entry in that map. Checking
            // COMPONENTS first made this branch unreachable — the panel offered a switch
            // that could only ever answer unknown_component.
            //
            // It is compared against `PRESET_COMPONENT_KEY`, the key the GET publishes and
            // the client row sends, and not against the Loader row id `preset-dev`. That
            // mix-up is exactly what made this switch dead in the shipped build: the panel
            // sent `presetDev`, this branch wanted `preset-dev`, and every click answered
            // `unknown_component` without writing anything.
            //
            // It is handled HERE, and not through the shell: `pluginManager.setPluginEnabled`
            // cannot reach the preset at all, because `listPlugins()` inventories the
            // profile's INSTALLED packages and `@deepseek-ai/dsh-agent-preset` lives in the
            // DSH installation. What this branch writes is the `agent-preset-registry`
            // entry's `selectedDefault` in the profile patch, after `lib/preset-row.js` has
            // parsed the result with DSH's own parser and read the value back.
            if (name === PRESET_COMPONENT_KEY) {
              const profile = ctx.profileContext;
              if (profile === undefined || profile === null || patchPathOf(profile) === null) {
                // 501, not a guess: with no profile path there is no file to write, and a
                // guessed path would write somewhere nobody asked for.
                send(501, {
                  ok: false,
                  component: PRESET_COMPONENT_KEY,
                  error: 'profile_context_unavailable',
                  detail:
                    'the profileContext service names no profile patch path, so the preset selection ' +
                    'cannot be switched; no path is guessed and nothing was written',
                });
                return;
              }
              const result = safe(() => setPresetSelected(profile, wanted));
              if (result === undefined) return;
              ctx.logger?.info?.(
                `newmark-core: ${PRESET_COMPONENT_KEY} ${result.ok === true ? 'set to ' + String(result.selected) : 'FAILED ' + String(result.error)}` +
                  (result.patchPath ? ` (${result.patchPath})` : ''),
              );
              // The receipt carries the state READ BACK FROM THE FILE, not the request.
              // The state is also in the same shape as the GET's, so one reader serves
              // both and the panel cannot disagree with itself.
              send(result.ok === true ? 200 : 400, {
                ...result,
                component: PRESET_COMPONENT_KEY,
                preset: PRESET_ID,
                selector: SELECTOR_ENTRY_ID,
                declaredBy: PRESET_ROW_ID,
                name: SELECTOR_ENTRY_NAME,
                mounted: result.ok === true ? result.enabled === true : false,
                [PRESET_COMPONENT_KEY]: presetState(),
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
