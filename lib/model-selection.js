/**
 * Newmark Core — **the model catalogue and the persisted selection**, in the core row.
 *
 * The plugin config page offers ONE model for the whole bundle, chosen from the models
 * currently available in DSH. That makes the model a property of the core row and not of any
 * component: every part of the bundle that needs a model reads the same selection, and
 * `agent-api` is a consumer of that decision rather than the owner of it
 * (`components/agent-api/lib/core-model.js`, one accessor name).
 *
 * This module is the core row's half of that: it enumerates what DSH can route to, and it
 * answers whether the persisted choice is still one of them.
 *
 * ## Where the catalogue is read, and where it is deliberately NOT read
 *
 * `ctx.llm.listProviders()` and `ctx.llm.listModels(providerId)` are read HOST-side, in this
 * process, and the answer is served through the control route this bundle already owns
 * (`/newmark-core/components`). It is deliberately not reached through the shell's remote
 * namespace: this bundle has already lost a round to a remote namespace that did not resolve,
 * and a Host-side enumeration needs no channel the panel does not already use.
 *
 * ## The exact shape `ctx.llm.listModels(providerId)` returns
 *
 * Read from the implementation, not guessed — `@deepseek-ai/dsh-llm/lib/index.js:2073`:
 *
 *     async listModels(provider) {
 *       const models = await this.registration(provider).adapter.listModels(provider);
 *       ... return models.map((model) => ({
 *         provider: model.provider,          // ALWAYS === the provider argument; throw otherwise
 *         id: model.id,                      // non-empty string; the value to match on
 *         name: model.name,                  // non-empty string; display only
 *         ...(description === undefined ? {} : { description }),
 *         ...(inputModalities === undefined ? {} : { inputModalities }),
 *       }));
 *     }
 *
 * So it is an **array of detached `LlmModelInfo`**, it is **async**, it **throws** for an
 * unregistered provider (`LlmError`), and it **throws** `INVALID_CATALOG` when an adapter
 * returns a duplicate id or mismatched provider. The published signature is
 * `async listModels(provider: string): Promise<LlmModelInfo[]>` (`lib/typert.host.js:193`).
 * Two consequences this module depends on:
 *
 *   1. the match is on `id`, never on `name` — a display name is not an address;
 *   2. `provider` on each entry cannot disagree with the argument, so an entry's own
 *      `provider` is not a second source of truth to reconcile.
 *
 * ## Why every provider, and not only the default one
 *
 * `buildModelCatalog` (`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js:10`)
 * enumerates **every** provider that the registry lists and keeps the ones that answer with
 * at least one model, isolating each provider's failure instead of failing the whole read.
 * That is the catalogue the browser model picker shows, and a selection this page offers has
 * to be one that picker could also have offered — the core row serves a model to a run, and a
 * run that DSH could not route would be a selection that fails at run time, which is exactly
 * what this page exists to prevent. Restricting the read to the current default provider would
 * have been cheaper, but the bundle is meant to be a drop-in for profiles this file does not
 * know: a profile whose default model costs too much for a judging loop would have had no way
 * to point the runs at another provider at all.
 *
 * `ctx.agentDefaultModel.currentSelection()` is read as well, for two reasons and no more:
 * it is a *reference point* the panel can show beside the user's own choice, so
 * "nothing authorised yet" is visibly different from "authorised, and different from your
 * default"; and it is the one selection DSH already considers routable, so a provider the
 * catalogue could not enumerate is still reported rather than hidden. It is **never** used as
 * the bundle's model — that is the whole point of the field being 准用, authorised.
 */

/**
 * The one field name this module matches a model on.
 *
 * Held as a constant because it is the single fact about `LlmModelInfo` that a wrong guess
 * would break silently: matching `name` instead of `id` finds nothing for a model whose
 * display name differs from its id, and a catalogue that finds nothing looks exactly like a
 * provider that offers nothing.
 */
export const MODEL_ID_FIELD = 'id';

/** The provider field on a catalogue entry, which the service guarantees equals the argument. */
export const MODEL_PROVIDER_FIELD = 'provider';

/**
 * What `{ provider, model }` means for one entry of this page: available, gone, or unverified.
 *
 * Three states and not a boolean, because "the catalogue does not list it" and "the catalogue
 * could not be read" are different facts and only the first one is evidence about the model.
 * Conflating them is the failure `lib/core-model.js` splits four ways on the agent-api side.
 */
export const LISTED = { yes: true, no: false, unverified: null };

/** Normalise `ctx.agentDefaultModel.currentSelection()` — `{ provider, model, reasoningEffort? }`. */
export function normaliseSelection(value) {
  const provider = typeof value?.[MODEL_PROVIDER_FIELD] === 'string' ? value[MODEL_PROVIDER_FIELD].trim() : '';
  const model = typeof value?.model === 'string' ? value.model.trim() : '';
  const reasoningEffort =
    typeof value?.reasoningEffort === 'string' && value.reasoningEffort.trim() ? value.reasoningEffort.trim() : '';
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ok: Boolean(provider && model),
  };
}

/**
 * Enumerate every model DSH can currently route to.
 *
 * Each provider is isolated: one that throws (unregistered route, lapsed credentials, a dead
 * catalogue endpoint) becomes a `failures` entry with its own message and the rest of the
 * catalogue still answers. An empty catalogue is therefore a fact about the registry, and a
 * partial one says so rather than looking complete.
 *
 * @param llm - `ctx.llm`, or `undefined` when the service is not reachable from this scope.
 * @param defaults - `{ defaultSelection }`, the deployment default, read from
 *   `ctx.agentDefaultModel.currentSelection()` when not given.
 * @returns `{ ok, reason, models, groups, failures, routableProviders, defaultSelection }`.
 *   `ok` is false only when there is no catalogue at all — no service, no `listProviders`, or
 *   a `listProviders` that threw. A catalogue with some failed providers is still `ok: true`.
 */
export async function enumerateModelCatalog(llm, defaults = {}) {
  const defaultSelection = normaliseSelection(defaults.defaultSelection);
  if (typeof llm?.listProviders !== 'function') {
    return {
      ok: false,
      reason:
        'the llm service is not reachable from this scope, or cannot list providers, so the models ' +
        'currently available in DSH cannot be read and no choice can be offered on this page',
      models: [],
      groups: [],
      failures: [],
      routableProviders: [],
      defaultSelection,
    };
  }

  let providers;
  try {
    providers = llm.listProviders();
  } catch (error) {
    return {
      ok: false,
      reason: `listing the DSH providers failed: ${error?.message ?? error}`,
      models: [],
      groups: [],
      failures: [],
      routableProviders: [],
      defaultSelection,
    };
  }
  const list = Array.isArray(providers) ? providers : [];
  if (typeof llm.listModels !== 'function') {
    return {
      ok: false,
      reason: 'the llm service cannot list models, so the models currently available in DSH cannot be read',
      models: [],
      groups: [],
      failures: [],
      routableProviders: [],
      defaultSelection,
    };
  }

  const settled = await Promise.all(
    list.map(async (provider) => {
      const id = String(provider?.[MODEL_ID_FIELD] ?? '');
      const name = String(provider?.name ?? id);
      if (!id) return { kind: 'failure', failure: { id: '', name, message: 'this provider entry carries no id' } };
      try {
        const models = await llm.listModels(id);
        const entries = (Array.isArray(models) ? models : []).map((model) => ({
          provider: id,
          id: String(model?.[MODEL_ID_FIELD] ?? ''),
          name: String(model?.name ?? model?.[MODEL_ID_FIELD] ?? ''),
          ...(typeof model?.description === 'string' ? { description: model.description } : {}),
        }));
        return { kind: 'group', group: { id, name, models: entries.filter((entry) => entry.id) } };
      } catch (error) {
        return { kind: 'failure', failure: { id, name, message: String(error?.message ?? error) } };
      }
    }),
  );

  // Mirrors `buildCatalog`'s own two rules: only non-empty groups are routable, and the
  // provider order is the registry's. An empty group is not an offer and must not be
  // rendered as one — selecting from it would be selecting nothing.
  const groups = settled.flatMap((item) => (item.kind === 'group' && item.group.models.length > 0 ? [item.group] : []));
  return {
    ok: true,
    reason: '',
    models: groups.flatMap((group) =>
      group.models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        group: group.id,
        groupName: group.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
    ),
    groups,
    failures: settled.flatMap((item) => (item.kind === 'failure' ? [item.failure] : [])),
    routableProviders: groups.map((group) => group.id),
    defaultSelection,
  };
}

/**
 * Read the persisted selection against the catalogue, as the three states above.
 *
 * @param selection - `{ provider, model }`, in practice the core row's own `model()` accessor.
 * @param catalog - the answer from `enumerateModelCatalog`.
 * @returns `{ selected, selectedListed, listedIn }` where `listedIn` is `null` when the
 *   selection's provider is not in the catalogue at all — which is "gone", not "unknown":
 *   a provider that is absent from `routableProviders` was enumerated and offered nothing, or
 *   failed to enumerate, and `catalog.failures` says which.
 */
export function resolveSelection(selection, catalog) {
  const chosen = normaliseSelection(selection);
  const selected = chosen.ok ? { provider: chosen.provider, model: chosen.model } : null;
  if (selected === null) return { selected: null, selectedListed: null, listedIn: null };

  // A provider that FAILED to enumerate is unknown, not absent: `failures` names it, and
  // "could not be checked" must not be reported as "gone".
  const failed = catalog.failures.some((failure) => failure.id === selected.provider);
  if (failed) return { selected, selectedListed: LISTED.unverified, listedIn: null };

  const offered = catalog.models.some(
    (model) => model.provider === selected.provider && model[MODEL_ID_FIELD] === selected.model,
  );
  return { selected, selectedListed: offered ? LISTED.yes : LISTED.no, listedIn: selected.provider };
}

/** Whether one `{ provider, model }` pair is in the catalogue — the write path's own guard. */
export function selectionIsListed(catalog, provider, model) {
  return catalog.models.some((entry) => entry.provider === provider && entry[MODEL_ID_FIELD] === model);
}
