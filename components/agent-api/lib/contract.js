/**
 * Newmark Core — the **agent-api contract**, as pure code.
 *
 * This module is the component's whole reason for existing. It holds no service, opens no
 * route, registers no tool and touches no file: everything here is a function of its
 * arguments, which is what lets the gate assert it directly.
 *
 * ## What this is modelled on
 *
 * Newmark's own `--cli` mode (`DESKTOP/src/cli-commands.ts`). Three things there are the
 * contract rather than the implementation, and all three are reproduced here:
 *
 *  1. **The envelope** — every tool invocation answers with
 *     `{ ok: boolean, tool: string, error?: string, route: 'direct' | … }`
 *     (`CliToolEnvelope`, cli-commands.ts:275-281).
 *  2. **The exit codes** — `2` invalid argument / schema error / unsupported, `3` an
 *     unavailable host capability, `4` the tool itself reported `ok: false`, `130` aborted,
 *     plus `0` for success (`type CliToolExitCode`, cli-commands.ts:273).
 *  3. **The classification** — `classifyCliToolOutput` (cli-commands.ts:294-321), the one
 *     function that decides which of those codes a call earned.
 *
 * ## The one thing that had to change, and why it is an improvement rather than a drift
 *
 * A CLI reports its outcome as **text on a pipe and a process exit status**. That is why
 * the reference implementation has to scrape the *first line* of a tool's stdout with seven
 * regular expressions: a subprocess has no other channel. The classification is a function
 * of a string because the transport forced it to be.
 *
 * A tool inside a DSH plugin has no pipe. `ctx.tools.execute` answers with a structured
 * `ToolExecutionResult` — `{ isError: false, value }` on success, or
 * `{ isError: true, error: { message, info?: { name, code } } }` on failure
 * (`@deepseek-ai/dsh-tools/lib/index.js:3616-3630`) — and the failure carries a machine
 * readable `info.code` such as `UNKNOWN_TOOL`, `INVALID_ARGS`, `UNSUPPORTED_SCHEMA`,
 * `ABORTED` or `ABORTED_BEFORE_DISPATCH`. Reading that code is strictly more reliable than
 * matching a regex against prose.
 *
 * So this module keeps **both** classifiers, and neither is decoration:
 *
 *  - `classifyToolResult` takes the structured result. This is the path a dispatch through
 *    the registry takes.
 *  - `classifyToolOutput` takes a raw string, with the reference's seven rules in the
 *    reference's own order and precedence. This is the path taken when a dispatched tool's
 *    *value* is a string, or when an object carries `ok: false` — Newmark's own tools answer
 *    that way, so the bridge is live, not a fallback kept for sentiment.
 *
 * Because a tool result has **no exit status**, the exit code travels *inside* the envelope
 * as `exit`. That is the only faithful way to keep a contract whose codes are the point,
 * once the transport stops being a process. `exit` is not advisory: `ok` is derived from it,
 * and `class` names it in words.
 *
 * ## What the reference does that this cannot, and how that is handled
 *
 * `cli-commands.ts` runs `new Agent(root, …)` and `agent.tools.setHostProfile({ kind: 'cli',
 * … })` because it *is* a separate process that owns its own runtime, and it can cold-start
 * one. **This component deliberately does not do that, and does not model it.** The
 * supported lifecycle is narrower and is stated in every tool description: agent-api is
 * available **while the DSH process is alive and Cordis is healthy**, and it is not a
 * standalone tool. If DSH is not running there is nothing here to answer, and a caller that
 * expects otherwise should be told so by the lifecycle line rather than by a confusing
 * absence.
 *
 * The host-profile idea survives the change of meaning. `kind: 'cli'` told the tool layer
 * what a command line can do; `kind: 'dsh-plugin'` tells a caller what a plugin can do, and
 * — this is the part that matters — the declaration is **derived from the services actually
 * in hand** rather than asserted. See `probeCapabilities`.
 */

/* ------------------------------------------------------------------ exit codes --- */

/** Success. The reference's implicit `0`. */
export const EXIT_OK = 0;
/** Invalid argument, schema error, or a tool name this caller cannot reach. */
export const EXIT_INVALID = 2;
/** An unavailable host capability: the host profile declares it, and says it cannot. */
export const EXIT_UNAVAILABLE = 3;
/** The tool itself reported an unsuccessful result. */
export const EXIT_FAILED = 4;
/** Aborted. The reference reserves `130`, the shell's `SIGINT` convention. */
export const EXIT_ABORTED = 130;

/** Every code the contract defines, in the reference's order. */
export const EXIT_CODES = [EXIT_OK, EXIT_INVALID, EXIT_UNAVAILABLE, EXIT_FAILED, EXIT_ABORTED];

/** The word each code is named by, so a reader never has to decode a number. */
export const CLASS_OF_EXIT = {
  [EXIT_OK]: 'ok',
  [EXIT_INVALID]: 'invalid',
  [EXIT_UNAVAILABLE]: 'unavailable',
  [EXIT_FAILED]: 'failed',
  [EXIT_ABORTED]: 'aborted',
};

/**
 * The `route` field's value set — how the call was carried.
 *
 *   `direct`  an in-process dispatch through the tool registry, or a read
 *   `loop`    through this component's own agent loop, i.e. a model call happened
 *   `none`    nothing ran
 *
 * `subagent` is deliberately absent: this component no longer reaches for a subagent, and a
 * route value nobody can produce would be a vocabulary entry that lies about the design.
 */
export const ROUTES = ['direct', 'loop', 'none'];

/** The keys every envelope carries, in order, before any per-call extras. */
export const ENVELOPE_CORE_KEYS = ['ok', 'tool', 'route', 'exit', 'class'];

/* ---------------------------------------------------------------- the envelope --- */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the one envelope every call answers with.
 *
 * `ok` is not passed in: it is derived from `exit`, so an envelope cannot claim success
 * while carrying a failure code. That is the whole discipline of the reference's
 * `emitCliToolEnvelope`, which sets the exit status and prints the JSON from one call site
 * so the two can never disagree.
 *
 * @param fields.tool - the tool name, as the reference's `tool` field carries it.
 * @param fields.exit - one of `EXIT_CODES`. An unknown value fails closed to `EXIT_FAILED`,
 *   because a result whose seriousness cannot be established is not a success.
 * @param fields.route - one of `ROUTES`; defaults to `direct`.
 * @param fields.result - present exactly when `exit === EXIT_OK`.
 * @param fields.error - present exactly when `exit !== EXIT_OK`.
 * @param fields.code - a machine-readable failure code; present exactly when failing.
 * @param fields.extra - further keys, appended after the contract's own.
 */
export function envelope(fields = {}) {
  const exit = EXIT_CODES.includes(fields.exit) ? fields.exit : EXIT_FAILED;
  const out = {
    ok: exit === EXIT_OK,
    tool: String(fields.tool ?? ''),
    route: ROUTES.includes(fields.route) ? fields.route : 'direct',
    exit,
    class: CLASS_OF_EXIT[exit],
  };
  if (exit === EXIT_OK) {
    out.result = fields.result === undefined ? null : fields.result;
  } else {
    out.error = String(fields.error ?? `${fields.tool ?? 'the tool'} failed.`);
    out.code = String(fields.code ?? 'failed');
  }
  if (isPlainObject(fields.extra)) Object.assign(out, fields.extra);
  return out;
}

/* ------------------------------------------------------------ the classifier --- */

/**
 * The reference's `parsedToolOutput` (cli-commands.ts:288-292), verbatim in behaviour.
 *
 * Note what it does *not* parse: anything that does not begin with `{` or `[` is returned
 * as the string it was. The reference's first rule then tests the parse for `ok === false`,
 * and deliberately skips arrays.
 */
export function parsedToolOutput(output) {
  const text = typeof output === 'string' ? output : String(output ?? '');
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/**
 * The reference's `classifyCliToolOutput` (cli-commands.ts:294-321), rule for rule.
 *
 * The rules are transcribed in the reference's own order, because the order is load-bearing:
 * `[tool unsupported]` is tested before the generic `[<something> error]` rule, and the
 * `abort` rule is tested after the marker rules so a tool whose *name* contains "abort"
 * cannot hijack a structured failure. Each rule is given a `code` here because a CLI had a
 * numeric status and nothing else, while a plugin can afford to say which rule fired.
 *
 * @param tool - the tool name, used for the reference's own fallback messages.
 * @param output - the raw string a dispatched tool answered with.
 * @returns `{ exit, code?, error?, result? }` — never an envelope; `envelope()` wraps it.
 */
export function classifyToolOutput(tool, output) {
  const name = String(tool ?? '');
  const text = typeof output === 'string' ? output : String(output ?? '');
  const result = parsedToolOutput(text);

  // Rule 1 — a JSON object that says `ok: false` is a failure, whatever else it contains.
  if (isPlainObject(result) && result.ok === false) {
    return {
      exit: EXIT_FAILED,
      code: 'tool_reported_failure',
      error: String(result.error || `${name} reported an unsuccessful result.`),
    };
  }

  const firstLine = text.trim().split(/\r?\n/, 1)[0] || `${name} failed.`;

  // Rule 2 — the tool's arguments did not fit its schema.
  if (/^\[(?:tool schema error|\?)]/i.test(firstLine)) {
    return { exit: EXIT_INVALID, code: 'tool_schema_error', error: firstLine };
  }

  // Rule 3 — an unsupported tool. The reference splits this by *capability*: a name that
  // denotes a host capability this build cannot provide is an unavailable capability (3),
  // while any other unsupported name is a bad argument (2). The same split is kept, with
  // the same two name shapes, so the codes mean what they meant.
  if (/^\[tool unsupported]/i.test(firstLine)) {
    const unavailableHostCapability = name === 'computer_use' || name.startsWith('browser_');
    return {
      exit: unavailableHostCapability ? EXIT_UNAVAILABLE : EXIT_INVALID,
      code: unavailableHostCapability ? 'host_capability_unavailable' : 'tool_unsupported',
      error: firstLine,
    };
  }

  // Rule 4 — context management is Agent-owned, so its failures are the tool's own (4).
  if (/^\[(?:context_compress|context_history_manage)]/i.test(firstLine)) {
    return { exit: EXIT_FAILED, code: 'context_operation_failed', error: firstLine };
  }

  // Rule 5 — a policy refusal: the tool exists and the call was denied. That is an
  // unavailable capability (3), not a fault in the tool.
  if (/^\[(?:tool disabled|permission|write gate blocked|Subagent sandbox)]/i.test(firstLine)) {
    return { exit: EXIT_UNAVAILABLE, code: 'capability_denied', error: firstLine };
  }

  // Rule 6 — cancellation. Tested after the marker rules so a structured failure whose
  // text happens to mention aborting is still classified by its own marker.
  if (/abort(?:ed|ing)?/i.test(firstLine)) {
    return { exit: EXIT_ABORTED, code: 'aborted', error: firstLine };
  }

  // Rule 7 — any other `[<something> error]` marker is the tool's own failure (4).
  if (/^\[[^\]]+ error]/i.test(firstLine)) {
    return { exit: EXIT_FAILED, code: 'tool_error', error: firstLine };
  }

  return { exit: EXIT_OK, result };
}

/**
 * Classify a `ToolExecutionResult` from `ctx.tools.execute`.
 *
 * The structured path. Its rules are the reference's rules, reached through fields instead
 * of through a first line:
 *
 *  - a success whose `value` carries `ok: false` is a failure (the reference's rule 1);
 *  - a success whose `value` is a string is classified as raw output, so a Newmark-authored
 *    tool that answers with its CLI text is classified identically either way;
 *  - `info.name === 'AbortError'` or an `ABORTED*` code is cancellation (rule 6, `130`);
 *  - `UNKNOWN_TOOL` is an unreachable tool name (rule 3's non-capability arm, `2`);
 *  - `INVALID_ARGS` / `UNSUPPORTED_SCHEMA` are argument and schema errors (rule 2, `2`);
 *  - everything else is the tool's own failure (rules 4 and 7, `4`).
 *
 * A value that is not an object at all — a bare string or number — is passed to
 * `classifyToolOutput`, so the two classifiers agree on every input shape rather than
 * disagreeing at the seam.
 */
export function classifyToolResult(tool, result) {
  const name = String(tool ?? '');
  if (!isPlainObject(result)) return classifyToolOutput(name, result);

  if (result.isError !== true) {
    const value = result.value;
    if (isPlainObject(value) && value.ok === false) {
      return {
        exit: EXIT_FAILED,
        code: 'tool_reported_failure',
        error: String(value.error || `${name} reported an unsuccessful result.`),
      };
    }
    if (typeof value === 'string') {
      const classified = classifyToolOutput(name, value);
      // A string that carries a marker is classified by that marker; a plain string is the
      // successful result, already parsed by `classifyToolOutput` where it was JSON.
      return classified.exit === EXIT_OK ? { exit: EXIT_OK, result: classified.result } : classified;
    }
    return { exit: EXIT_OK, result: value === undefined ? null : value };
  }

  const info = isPlainObject(result.error?.info) ? result.error.info : {};
  const message = String(result.error?.message ?? `${name} failed.`);
  const errorName = String(info.name ?? '');
  const infoCode = String(info.code ?? '');

  if (errorName === 'AbortError' || infoCode === 'ABORTED' || infoCode === 'ABORTED_BEFORE_DISPATCH') {
    return { exit: EXIT_ABORTED, code: infoCode || 'ABORTED', error: message };
  }
  if (infoCode === 'UNKNOWN_TOOL') {
    return { exit: EXIT_INVALID, code: 'unknown_tool', error: message };
  }
  if (infoCode === 'INVALID_ARGS' || infoCode === 'UNSUPPORTED_SCHEMA') {
    return { exit: EXIT_INVALID, code: infoCode.toLowerCase(), error: message };
  }
  return { exit: EXIT_FAILED, code: infoCode || 'tool_error', error: message };
}

/* ------------------------------------------------------------ the host profile --- */

/**
 * What a DSH plugin host is, in the shape the reference declares a CLI host.
 *
 * The reference's `agent.tools.setHostProfile({ kind: 'cli', platform, electronBrowser,
 * windowsComputerUse })` is a *declaration*, and its value is that capabilities follow from
 * it: a `cli` host has no Electron browser and has ComputerUse only on Windows, so a tool
 * that needs either can be refused with code 3 **before** it is attempted.
 *
 * The equivalent here is a declaration of what a **plugin inside a live DSH process** can
 * reach. The important difference is that this one is not written down and trusted: every
 * capability below is *probed* against the services actually in hand (`probeCapabilities`),
 * so the declaration cannot drift away from what the code can do. A profile that claimed a
 * capability the host lacks would be worse than no profile, because a caller would plan
 * around it.
 */
export const HOST_KIND = 'dsh-plugin';

/** The lifecycle statement, in one line, reused by every tool description. */
export const LIFECYCLE =
  'Available while the DSH process is alive and Cordis is healthy. This is not a standalone ' +
  'tool and there is no cold start: if DSH is not running, nothing here answers.';

/**
 * What a run through this component is, and what it therefore is not.
 *
 * Repeated in the tool descriptions because a caller has to know it to judge what a run's
 * answer is worth. One clause per sentence on purpose: this is the whole cost, and a caller
 * who does not read it will over-trust the answer.
 */
export const RUN_ISOLATION =
  'A run is driven by this component own agent loop over ctx.llm.stream, so it is NOT a DSH ' +
  'agent session. It writes no session log, it appears in no conversation, history or ' +
  'subagent catalogue, it is subject to no tools/pre-execute guard, no approval policy and no ' +
  'sandbox decision, and it is therefore not auditable through any of them. Its tool calls ' +
  'execute in the GLOBAL tool view rather than the calling agent scope, so a per-agent tool ' +
  'restriction does not reach it. It sees only the tools this component chooses to give it. ' +
  'What it does carry is the model the user authorised and the credentials the llm service ' +
  'already holds, because the call goes through that service rather than around it.';

/**
 * The capability ids, in report order.
 *
 * `model.selected` is separate from `model.request` on purpose: "the user authorised a model
 * and it is really there" and "a provider call can be made at all" are different questions,
 * and the first one failing is the failure this contract most needs to be able to name.
 */
export const CAPABILITY_IDS = [
  'state.read',
  'catalog.read',
  'model.selected',
  'model.request',
  'tool.dispatch',
  'agent.run',
  'http.state',
  'http.run',
];

function capability(id, kind, state, code, evidence, reason) {
  return { id, kind, state, ...(state === 'available' ? {} : { code }), evidence, reason };
}

/**
 * Probe what this host can actually do.
 *
 * Three states, and the third is the one that keeps this honest:
 *
 *   `available`   — the named member is a function on the service in hand, right now.
 *   `unavailable` — the member is absent. The host cannot do it; code 3.
 *   `refused`     — the member exists and this component declines to expose it, with the
 *                   reason stated. This is deliberately NOT called "unavailable": saying a
 *                   thing is impossible when it is merely refused is the kind of claim that
 *                   makes the rest of the profile untrustworthy.
 *
 * @param services - `{ tools, llm, webServer, core }`, each possibly `undefined`.
 * @param context - `{ model, workspace }`. `model` is the result of `readCoreSelection`: the
 *   model the user authorised for this bundle, already resolved. It is an input rather than
 *   something probed here, because reading it touches the core row and a capability probe
 *   must stay a pure function of what it was handed.
 */
export function probeCapabilities(services = {}, context = {}) {
  const { tools, llm } = services;
  const isFn = (value) => typeof value === 'function';
  const hasTools = tools !== undefined && tools !== null;
  const model = context.model && typeof context.model === 'object' ? context.model : null;
  const modelOk = model?.ok === true;
  const llmOk = isFn(llm?.stream);
  const catalogOk = isFn(tools?.schemas);
  const dispatchOk = isFn(tools?.execute);

  return [
    capability(
      'state.read',
      'read',
      'available',
      '',
      'in-process: no service required',
      'reads this component own state and the shape of the services it was handed; ' +
        'performs no model request and executes no tool',
    ),
    capability(
      'catalog.read',
      'read',
      catalogOk ? 'available' : 'unavailable',
      'catalog_unavailable',
      'ctx.tools.schemas',
      catalogOk
        ? 'the registry projects its visible definitions onto model-facing schemas'
        : hasTools
          ? 'the injected tools service has no schemas() method'
          : 'the tools service is not reachable from this scope',
    ),
    capability(
      'model.selected',
      'read',
      modelOk ? 'available' : 'unavailable',
      String(model?.code ?? 'core_service_absent'),
      model?.source === 'core-service' ? 'core model accessor on the core row service' : 'none',
      modelOk
        ? `the user authorised ${model.provider}/${model.model} for this bundle, and it is listed by the provider`
        : String(model?.reason ?? 'no authorised model could be read'),
    ),
    capability(
      'model.request',
      'run',
      llmOk && modelOk ? 'available' : 'unavailable',
      !llmOk ? 'llm_unavailable' : 'model_not_selected',
      'ctx.llm.stream',
      llmOk && modelOk
        ? `the provider call behind every run, made through the llm service with the model the user ` +
          `authorised and the credentials that service already holds. It is the run engine rather than ` +
          `a second capability, and it is also why a run is invisible to DSH machinery: ${RUN_ISOLATION}`
        : !llmOk
          ? 'the llm service is not reachable from this scope, so no provider call can be made'
          : String(model?.reason ?? 'no model has been authorised for this bundle'),
    ),
    capability(
      'tool.dispatch',
      'run',
      dispatchOk ? 'available' : 'unavailable',
      'tool_dispatch_unavailable',
      'ctx.tools.execute',
      dispatchOk
        ? 'the registry executes a named tool through pre-policy, guards, around-dispatch and post-policy'
        : hasTools
          ? 'the injected tools service has no execute() method'
          : 'the tools service is not reachable from this scope',
    ),
    capability(
      'agent.run',
      'run',
      llmOk && modelOk && catalogOk && dispatchOk ? 'available' : 'unavailable',
      !modelOk
        ? String(model?.code ?? 'model_not_selected')
        : !llmOk
          ? 'llm_unavailable'
          : 'tools_unavailable',
      'this component own loop over ctx.llm.stream + ctx.tools',
      llmOk && modelOk && catalogOk && dispatchOk
        ? 'the run can be driven end to end: an authorised model to call, and a restricted tool set to offer it'
        : !modelOk
          ? `no run can happen because no authorised model is available: ${String(model?.reason ?? 'none was read')}`
          : 'a run needs both a model call and a tool registry to offer the run its tools, and one of them is missing',
    ),
    capability(
      'http.state',
      'read',
      isFn(services.webServer?.register) ? 'available' : 'unavailable',
      'http_state_unavailable',
      'ctx.webServer.register',
      isFn(services.webServer?.register)
        ? 'this component serves its own read-only state route on the web carrier the bundle already owns'
        : 'the webServer service is not reachable from this scope',
    ),
    capability(
      'http.run',
      'run',
      'refused',
      'http_run_refused',
      'none',
      'a loopback route is reachable by any local process and is indistinguishable from the user, ' +
        'while a run spends the user\'s provider credentials and model budget. The run half stays in ' +
        'the tool channel and this route answers 405 for anything but a read — a refusal, not an ' +
        'impossibility: the loop behind it is the same one the tool calls',
    ),
  ];
}

/**
 * The profile object a caller can plan around.
 *
 * @param services - as `probeCapabilities`.
 * @param context - `{ model, workspace, component }`.
 */
export function hostProfile(services = {}, context = {}) {
  const model = context.model && typeof context.model === 'object' ? context.model : {};
  return {
    kind: HOST_KIND,
    component: String(context.component ?? 'agentApi'),
    platform: process.platform,
    lifecycle: 'dsh-process',
    workspace: String(context.workspace ?? ''),
    engine: 'own-loop',
    // Which model the bundle was authorised to use, and whether it is really there. The
    // accessor name is the wiring's business; this reports what was read and how.
    model: {
      ok: model.ok === true,
      source: String(model.source ?? 'none'),
      provider: String(model.provider ?? ''),
      model: String(model.model ?? ''),
      code: model.ok === true ? '' : String(model.code ?? ''),
    },
    capabilities: probeCapabilities(services, context),
  };
}

/** The capability entry with this id, or `undefined`. */
export function capabilityOf(profile, id) {
  return (profile?.capabilities ?? []).find((entry) => entry?.id === id);
}

/** The ids this profile declares available. Used by the gate and by `agent_api_state`. */
export function availableCapabilities(profile) {
  return (profile?.capabilities ?? []).filter((entry) => entry?.state === 'available').map((entry) => entry.id);
}
