/**
 * Newmark Core — the **core component**.
 *
 * The bundle carries three components, and the Loader carries two rows:
 *
 * | Component | Loaded as | Responsibility |
 * |---|---|---|
 * | `newmark-core` | Loader row `newmark-core` → `newmark2dsh` | this file: the shared Newmark root and its config |
 * | `newmark-memorylab` | a child of this row's fiber (`ctx.plugin`) | the MemoryLab store, the seven `memory_lab_*` tools |
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
  MODEL_ID_FIELD,
  enumerateModelCatalog,
  normaliseSelection,
  resolveSelection,
  selectionIsListed,
} from './lib/model-selection.js';
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

/**
 * The name of the service this row provides to its own composed components.
 *
 * There is exactly ONE service, and it is how a component child of this row's fiber learns
 * two things it cannot work out for itself: the shared root, and the model the user
 * authorised for the bundle. `agent-api` names it `DEFAULT_CORE_SERVICE` on its side and
 * overrides it through its own `coreService` config; the two strings are one string.
 *
 * Only a descendant can see it — Cordis resolves a service by walking UP the consumer's fiber
 * ancestry, so this is reachable by the components this row mounts and by nothing else. That
 * is the whole reason the components are composed here rather than declared as sibling rows.
 */
export const CORE_SERVICE = 'newmarkComponents';

/**
 * The accessor on that service which answers the authorised model.
 *
 * `components/agent-api/lib/core-model.js` reads exactly this name — its `CORE_MODEL_ACCESSOR`.
 * It is a method rather than a value so a read always sees the current selection: the panel
 * writes the field, the Loader re-applies this row, and the next call answers the new model.
 */
export const CORE_MODEL_ACCESSOR = 'model';

/** The wire key the panel sends to set the model, and the key this route answers under. */
export const MODEL_COMPONENT_KEY = 'model';

/**
 * The shared root and the authorised model, for the Client half and for diagnostics.
 *
 * `model` is the one field on this row that is not a switch: it is **准用 — authorised**. The
 * bundle runs nothing on a model nobody chose, so an empty value is a real state and not a
 * missing one, and `agent-api` refuses with `model_not_selected` while it holds. A silent
 * default would be a model the user did not authorise, which is the failure this field exists
 * to make impossible.
 *
 * The pair is stored as two flat strings rather than a nested `{ provider, model }` object
 * because the profile patch is read by people and two sibling keys are what a person can edit
 * by hand without guessing at indentation.
 */
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
      model: schema
        .string()
        .description(
          'The model id this bundle is authorised to run, chosen on the plugin config page from the ' +
            'models currently available in DSH. Empty means nothing is authorised, and agent-api ' +
            'refuses rather than substituting a default.',
        )
        .default(''),
      modelProvider: schema
        .string()
        .description('The provider route the authorised model belongs to, e.g. deepseek-official.')
        .default(''),
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
// `configEditor` was injected here once, and was used WRONG: it toggled the Dev preset by
// writing `disabled` inside the row's *config*, where no plugin Config has such a field — so
// the write was accepted, persisted, and did nothing at all. The preset switch therefore goes
// through this bundle's own validated write to the profile patch (`lib/preset-row.js`).
//
// It is injected again now, for the purpose it actually has: it writes a row's **config**, and
// choosing the bundle's model changes exactly that. The distinction is worth keeping written
// down, because it is the difference between the preset switch being dead and this one working
// — same call, different target. Even so it is read through `ctx.get(...)` rather than as
// `ctx.<service>`: this row must stay mountable in a profile whose config editor is absent (the
// base patch disables that row when there is no `profileContext`), and a hard read of a service
// that is not there is a throw, not a `undefined`.
//
// `loader` is deliberately NOT injected either. `configEditor.edit(entry, change)` needs the
// row's own Loader entry, which `ctx.fiber.entry` carries — the Loader itself puts it there
// (`cordis-plugin-loader/lib/index.js:52` reads `ctx.fiber.entry`, and
// `dsh-agent-default-model/lib/index.js:54` takes the same route to the same editor).
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
  agentApi: {
    load: () => import('./components/agent-api/index.js'),
    config: (root) => ({ root, workspace: '', timeoutMs: 120000, maxSteps: 8 }),
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
  agentApi: '__NEWMARK_AGENTAPI__',
};

export function apply(ctx, config) {
  const root = resolveRoot(config);

  /**
   * The effective config, read at the moment of the read.
   *
   * `ctx.fiber.entry.options.config` is the same object the Loader handed this `apply()`, and
   * it is the object `configEditor.edit` mutates in place through `resolveConfig` before it
   * writes the file (`dsh-config-editor/lib/index.js:83`). Reading it lazily is what makes the
   * model accessor answer the NEW selection the instant the panel writes one, rather than the
   * selection this `apply()` was called with; the `config` argument is the fallback for a
   * context with no Loader entry above it (a harness, a hand-mounted row).
   */
  const liveConfig = () => ctx.fiber?.entry?.options?.config ?? config ?? {};

  /**
   * Read an optional service, without requiring it.
   *
   * Guards BOTH cases with one expression: a service nobody provided (for which Cordis's own
   * `ctx.get` is documented to answer `undefined` — `@deepseek-ai/cordis/lib/index.js:755-765`),
   * and a context with no `get` at all — a harness, or a row mounted by hand. `ctx.get('llm')`
   * on such a context throws `ctx.get is not a function`, and inside a route handler that throw
   * ends the Host process rather than the request.
   */
  const maybe = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);

  /**
   * The shared service this row provides to its composed components.
   *
   * **Provided BEFORE the compose loop**, so that a component mounted by this row can read it
   * while its own `apply()` runs: Cordis resolves a service by walking up the consumer's fiber
   * ancestry, and a child mounted first would look for a service that does not exist yet and
   * stay at `waiting for service` for ever.
   *
   * It carries two things and deliberately no more:
   *
   *   `root()`   the shared Newmark user root, so a component cannot place its own store or
   *              its own run workspace somewhere the user did not choose.
   *   `model()`  **the model the user authorised for this bundle** — `{ provider, model,
   *              reasoningEffort? }`, or `{}` when nothing is authorised. A method, not a
   *              value, so a read after the panel writes answers the new model. A component
   *              that needs a model reads this one selection; there is no second place to
   *              choose one, which is why `agent-api` has no `model` config field.
   *
   * Reading `{}` is a real answer and not a missing one: it means nothing has been authorised
   * yet, and the consumer is expected to refuse rather than invent a default.
   */
  const service = {
    root: () => root,
    [CORE_MODEL_ACCESSOR]: () => {
      const selection = normaliseSelection({
        provider: liveConfig().modelProvider,
        model: liveConfig().model,
      });
      if (!selection.ok) return {};
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      };
    },
  };
  if (typeof ctx.provide === 'function') ctx.provide(CORE_SERVICE, service);

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
          // A route handler runs with no caller above it to catch anything, so an
          // exception thrown here does not become a failed request — it takes the whole
          // Host process down. That is exactly what happened: reading the shell's config
          // editor threw, the throw escaped this handler, and DSH Desktop reported
          // "运行会话的后台服务已停止，退出码 1". Every path below is guarded so the worst
          // case is a 500 the panel can display.
          //
          // `await` is safe on a plain value, so one guard serves both the synchronous reads
          // and the asynchronous one (the model catalogue is awaited). A rejected promise is
          // caught here too, which a bare `try` around a synchronous call would not do.
          //
          // ONE ANSWER PER REQUEST, enforced rather than assumed. `send` is called from the
          // GET body AND from every branch of the POST body, and those branches used to sit
          // inside one synchronous listener where a second call was impossible. The listener is
          // `async` now, so it is possible: writing a second response to a finished one is at
          // best silently dropped and at worst throws ERR_STREAM_WRITE_AFTER_END *inside a
          // route handler*, which is the failure mode that ends the Host process. So the first
          // answer wins and any later one is refused and logged — the caller still gets the
          // answer it was owed, and the attempt is visible instead of fatal.
          let answered = false;
          const send = (status, body) => {
            if (answered) {
              ctx.logger?.warn?.(
                'newmark-core: refused a second response on the control route; the first answer already went out',
              );
              return false;
            }
            answered = true;
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
            return true;
          };

          /**
           * The preset selection's real state, read from `<profile>/cordis.patch.yml`.
           *
           * What the switch changes is the `agent-preset-registry` entry's
           * `config.selectedDefault`, in the PROFILE patch, so the file is the only thing
           * that knows the truth. `profileContext` is what names that file; without it the
           * answer is 501 and no path is guessed.
           */
          const presetState = () => {            const profile = ctx.profileContext;
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

          /**
           * Run one read, and turn a throw into the 500 the panel can display.
           *
           * `await` is safe on a plain value, so this one guard serves both the synchronous
           * reads and the asynchronous catalogue. A rejected promise is caught too, which a
           * bare `try` around a synchronous call would not do.
           */
          const safe = async (body) => {
            try {
              return await body();
            } catch (error) {
              ctx.logger?.warn?.('newmark-core: control route failed: ' + (error?.message ?? error));
              send(500, { ok: false, error: 'handler_failed', detail: String(error?.message ?? error) });
              return undefined;
            }
          };

          /**
           * The available models and the authorised one, read HOST-side (see `lib/model-selection.js`).
           *
           * One read, one answer, no second channel: the panel renders its `<select>` from
           * this and from nothing else, so the list it shows and the selection it shows are
           * read at the same instant and cannot disagree.
           *
           * `selectedListed` is a THREE-state answer and the panel renders all three:
           * `true` it is in the list, `false` it was enumerated and is gone (the provider
           * dropped it, the credentials lapsed, the route was retired), `null` its provider
           * could not be enumerated at all. The third state is not decoration: reporting
           * "gone" because a listing endpoint was down would be this half inventing a fact,
           * and reporting a stale selection as fine is the failure the panel exists to show.
           */
          const modelState = async () => {
            const selection = service[CORE_MODEL_ACCESSOR]();
            try {
              // `agentDefaultModel` is read as a reference point and never as the bundle's
              // model; it is optional because a profile may not have the service.
              const defaults = maybe('agentDefaultModel');
              const defaultSelection =
                typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined;
              const catalog = await enumerateModelCatalog(maybe('llm'), { defaultSelection });
              const resolved = resolveSelection(selection, catalog);
              return {
                ok: catalog.ok,
                ...(catalog.ok ? {} : { error: 'catalog_unavailable', detail: catalog.reason }),
                // What the agent-api component will read this instant, because it reads the
                // same accessor — so the panel and the run cannot be looking at two models.
                selected: resolved.selected,
                selectedListed: resolved.selectedListed,
                defaultSelection: catalog.defaultSelection.ok ? catalog.defaultSelection : null,
                models: catalog.models,
                groups: catalog.groups,
                failures: catalog.failures,
                routableProviders: catalog.routableProviders,
                editable: typeof maybe('configEditor')?.edit === 'function' && ctx.fiber?.entry !== undefined,
                component: MODEL_COMPONENT_KEY,
              };
            } catch (error) {
              return {
                ok: false,
                error: 'catalog_failed',
                detail: String(error?.message ?? error),
                selected: normaliseSelection({ provider: selection?.provider, model: selection?.model }).ok
                  ? { provider: selection.provider, model: selection.model }
                  : null,
                selectedListed: null,
                models: [],
                groups: [],
                failures: [],
                routableProviders: [],
                component: MODEL_COMPONENT_KEY,
              };
            }
          };

          if (req.method === 'GET') {
            // The preset is not a composed component, so its state is read from the
            // profile patch rather than from `composed`. Its key is the constant the POST
            // branch below compares against and the client row sends, spelled once.
            //
            // The answer is built in ONE guarded body and the model catalogue is awaited
            // inside it, so the switches and the model are read together. `modelState()`
            // reports its own failure rather than throwing: a page that cannot list models
            // must still be able to switch a component off.
            send(
              200,
              (await safe(async () => ({
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
                [MODEL_COMPONENT_KEY]: await modelState(),
              }))) ?? { ok: false, error: 'handler_failed' },
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
          req.on('end', async () => {
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
              // `await`, and not for the promise's value — `safe` runs a synchronous body
              // synchronously. It is awaited because `safe` IS async, so calling it without
              // `await` binds `result` to the PROMISE rather than to what the write returned:
              // `result.ok` would be `undefined`, the branch below would answer 400, and the
              // failure it reported would be a failure that never happened — with the file
              // already correctly written. That is exactly the confusing half-state this whole
              // route exists to avoid, and it is what a one-word omission bought.
              const result = await safe(() => setPresetSelected(profile, wanted));
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

            // ---------------------------------------------------------------- the model ---
            //
            // Choosing the bundle's model changes the CORE ROW'S CONFIG, and
            // `configEditor.edit(row, change)` is the mechanism whose actual purpose that is:
            // it writes a row's `config`, and this changes exactly that. (It was the WRONG
            // mechanism for the preset switch, where the target was the row's *enabled state*
            // — a `disabled` key landed inside the config object, where no plugin Config has
            // such a field, and was accepted and did nothing. Same call; the target is what
            // differed, and that history must not make this one look wrong.)
            //
            // Tested before COMPONENTS, like the preset, because `model` is not a component
            // key either. It is compared against MODEL_COMPONENT_KEY, the key the GET
            // publishes and the client row sends.
            if (name === MODEL_COMPONENT_KEY) {
              const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : '';
              const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
              const entry = ctx.fiber?.entry;
              const configEditor = maybe('configEditor');

              if (!provider || !model) {
                send(400, {
                  ok: false,
                  component: MODEL_COMPONENT_KEY,
                  error: 'model_required',
                  detail: 'a model is chosen as a provider route and a model id, and neither may be empty',
                });
                return;
              }
              if (entry === undefined || typeof configEditor?.edit !== 'function') {
                // 501, not a guess: with no row entry or no editor there is nothing to write
                // through, and a second write path to the profile patch would be a second
                // place where the same value can be wrong.
                send(501, {
                  ok: false,
                  component: MODEL_COMPONENT_KEY,
                  error: 'config_editor_unavailable',
                  detail:
                    'this row has no Loader entry, or the configEditor service is not reachable from this ' +
                    'scope, so the model cannot be persisted; nothing was written and no path is guessed',
                });
                return;
              }

              const outcome = await safe(async () => {
                // The catalogue is consulted BEFORE the write, for the reason the design
                // says: a selection that is not currently available fails at run time, and
                // the whole point of choosing here is that it cannot. A catalogue that could
                // not be READ is not evidence, so it does not block the write — refusing to
                // persist a model because a listing endpoint was down would be this half
                // inventing a fact.
                const catalog = await enumerateModelCatalog(maybe('llm'), {});
                if (catalog.ok && !selectionIsListed(catalog, provider, model)) {
                  return {
                    status: 400,
                    body: {
                      ok: false,
                      component: MODEL_COMPONENT_KEY,
                      error: 'model_not_listed',
                      detail: `DSH does not currently list ${provider}/${model}, so it cannot be authorised`,
                      routableProviders: catalog.routableProviders,
                      failures: catalog.failures,
                    },
                  };
                }

                // The value is written to the file by the editor, and the receipt must carry
                // what was PERSISTED rather than what was requested — so the row's config is
                // read back. It has to be read back AFTER the edit, and that ordering is the
                // whole bug this replaced.
                //
                // The object captured BEFORE the edit is not the object the editor updates.
                // `configEditor.edit` resolves the config through the row's fiber, so
                // `entry.options.config` is REPLACED rather than mutated in place; a reference
                // taken before the call keeps pointing at the pre-edit object, `live.model`
                // stays undefined, and the receipt says "the write did not take: the row's
                // config still holds /" — printing two empty strings around a slash — for a
                // write that had in fact taken. The patch file carried
                // `model: deepseek-flash, modelProvider: deepseek-official` the whole time.
                //
                // That is the same class of defect as the `memory_lab_reindex` output-boundary
                // bug fixed in 0.2.2: an operation that SUCCEEDED, reported to the caller as a
                // failure. A caller's natural response to a failed write is to write again.
                await configEditor.edit(entry, (current) => ({
                  ...current,
                  model,
                  modelProvider: provider,
                }));
                const live = entry.options.config ?? {};
                const persisted = normaliseSelection({
                  provider: live.modelProvider,
                  model: live.model,
                });
                const ok = persisted.ok && persisted.provider === provider && persisted.model === model;
                const result = {
                  ok,
                  component: MODEL_COMPONENT_KEY,
                  // The receipt carries the state READ BACK, not the request.
                  provider: persisted.provider,
                  model: persisted.model,
                  detail: ok
                    ? `${persisted.provider}/${persisted.model} is persisted in this row's config`
                    : `the write did not take: the row's config still holds ` +
                      `${String(live.modelProvider ?? '')}/${String(live.model ?? '')}`,
                };
                return { status: ok ? 200 : 400, body: result };
              });
              if (outcome === undefined) return;
              ctx.logger?.info?.(
                `newmark-core: ${MODEL_COMPONENT_KEY} ${outcome.body.ok === true ? 'set to ' + outcome.body.provider + '/' + outcome.body.model : 'FAILED ' + String(outcome.body.error ?? outcome.body.detail)}`,
              );
              // The answer carries the state read back through the same reader the GET uses,
              // so one reader serves both halves and the panel cannot disagree with itself.
              send(outcome.status, { ...outcome.body, [MODEL_COMPONENT_KEY]: await modelState() });
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
