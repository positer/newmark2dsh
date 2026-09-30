/**
 * Newmark Core — **the authorised model**, read from the core row.
 *
 * ## Why this is a separate module with one named accessor
 *
 * The plugin config page chooses **one** model for the whole bundle, single-select from the
 * models currently available in DSH. That makes the model a property of the *core row*, not
 * of this component: every part of the bundle that needs a model reads the same one, and this
 * component is a consumer of that decision rather than the owner of it. So there is
 * deliberately **no `model` field in this component's Config** — a second place to choose a
 * model would be a second answer to one question.
 *
 * The accessor is therefore read from the same service that carries `root`
 * (`services.core`), and the accessor's name is held in **one constant** here so the wiring
 * is a line rather than a rewrite:
 *
 *     export const CORE_MODEL_ACCESSOR = 'model';
 *
 * If the core row names it something else, that string changes and nothing else does.
 *
 * ## The four answers, which must not be conflated
 *
 * This is the failure the whole contract exists to prevent: a rebuild that reports success
 * while having judged nothing, because the model it was told to use was gone. So "no model"
 * is split as finely as "no component" is:
 *
 *   `core_service_absent`         the core row provides no service in this scope
 *   `core_model_accessor_absent`  the service is there but has no model accessor
 *   `model_not_selected`          the user has authorised nothing yet — REFUSED, not defaulted
 *   `model_unavailable`           a model was authorised and the provider no longer lists it
 *
 * and separately, not a refusal at all:
 *
 *   `model_unverified`            the model list could not be read, so availability is UNKNOWN
 *
 * **No run is ever attempted on a default.** A silently chosen model is a model the user did
 * not authorise, and the user's word for this field is 准用 — authorised. If nothing is
 * authorised, this component refuses with exit 3 and says so, rather than picking something.
 *
 * `model_unverified` is deliberately NOT a refusal. Failure to check is not evidence of
 * absence: refusing a run because a listing endpoint was down would be this component
 * inventing a fact. The run proceeds, the profile records `verified: null`, and if the
 * provider really is gone the run fails as a run failure — with the provider's own message,
 * which is the most useful thing anyone could have said.
 */

/** The one accessor name this component reads off the core row's service. */
export const CORE_MODEL_ACCESSOR = 'model';

/** The `{ provider, id }` field names `ctx.llm.listModels` answers with. Read from the type, not the name. */
export const MODEL_INFO_FIELDS = { provider: 'provider', id: 'id' };

/**
 * Read the model the user authorised for this bundle.
 *
 * @param services - `{ core }`, where `core` is the service the core row provides.
 * @returns `{ ok, source, provider, model, reasoningEffort?, code?, reason? }`. `ok === false`
 *   always carries both a `code` and a `reason`, because a caller that has to refuse needs to
 *   say why.
 */
export function readCoreSelection(services = {}) {
  const core = services?.core;
  if (core === undefined || core === null) {
    return {
      ok: false,
      source: 'none',
      code: 'core_service_absent',
      reason:
        'the core row provides no service in this scope, so the model this bundle was authorised to use ' +
        'cannot be read; this component does not choose a model of its own',
    };
  }
  const accessor = core[CORE_MODEL_ACCESSOR];
  if (typeof accessor !== 'function') {
    return {
      ok: false,
      source: 'core-service',
      code: 'core_model_accessor_absent',
      reason:
        `the core row service has no ${CORE_MODEL_ACCESSOR}() accessor, so the authorised model cannot be ` +
        `read; one accessor name is all this component needs and it is CORE_MODEL_ACCESSOR in lib/core-model.js`,
    };
  }
  let selection;
  try {
    selection = accessor.call(core);
  } catch (error) {
    return {
      ok: false,
      source: 'core-service',
      code: 'core_model_accessor_threw',
      reason: `reading the authorised model from the core row failed: ${error?.message ?? error}`,
    };
  }
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
  const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
  if (!provider || !model) {
    return {
      ok: false,
      source: 'core-service',
      code: 'model_not_selected',
      reason:
        'no model has been authorised for this bundle yet. Choose one on the plugin config page — this ' +
        'component deliberately refuses rather than substituting a default, because a default is a model ' +
        'the user did not authorise',
    };
  }
  return {
    ok: true,
    source: 'core-service',
    provider,
    model,
    ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  };
}

/**
 * Confirm the authorised model is still one the provider lists.
 *
 * @param llm - `ctx.llm`. `listModels(provider)` answers `LlmModelInfo[]`, whose fields are
 *   `{ provider, id, name, description?, inputModalities? }` —
 *   `@deepseek-ai/dsh-llm/lib/typert.host.js:377` — so the match is on `id`, not on `name`.
 * @returns `{ verified, code, reason }` where `verified` is `true`, `false`, or `null` for
 *   "could not be checked". Only `false` is a refusal.
 */
export async function verifyModelAvailable(llm, selection) {
  if (!selection?.ok) {
    return { verified: false, code: String(selection?.code ?? 'model_not_selected'), reason: String(selection?.reason ?? '') };
  }
  if (typeof llm?.listModels !== 'function') {
    return {
      verified: null,
      code: 'model_unverified',
      reason: 'the llm service cannot list models, so the authorised model could not be confirmed present; the run is attempted anyway',
    };
  }
  let listed;
  try {
    listed = await llm.listModels(selection.provider);
  } catch (error) {
    return {
      verified: null,
      code: 'model_unverified',
      reason: `listing models for ${selection.provider} failed, so the authorised model could not be confirmed present: ${error?.message ?? error}`,
    };
  }
  if (!Array.isArray(listed)) {
    return { verified: null, code: 'model_unverified', reason: 'the llm service answered with no model list, so the authorised model could not be confirmed present' };
  }
  if (listed.length === 0) {
    // An empty list is "the provider currently offers nothing", which for an authorised model
    // is unavailable rather than unverifiable: there is nothing it could have matched.
    return {
      verified: false,
      code: 'model_unavailable',
      reason: `the provider ${selection.provider} currently lists no models at all, so the authorised model ${selection.model} is not available`,
    };
  }
  const found = listed.some((entry) => String(entry?.[MODEL_INFO_FIELDS.id] ?? '') === selection.model);
  return found
    ? { verified: true, code: '', reason: `the provider ${selection.provider} lists ${selection.model}` }
    : {
        verified: false,
        code: 'model_unavailable',
        reason:
          `the provider ${selection.provider} no longer lists ${selection.model}, so the authorised model is ` +
          `unavailable. Re-authorise a model on the plugin config page. This is NOT a failed run: no run was attempted`,
      };
}
