/**
 * Newmark Core — the **agent-api component**, and the contract another component codes against.
 *
 * =====================================================================================
 * THE PUBLISHED CONTRACT
 * =====================================================================================
 *
 * Identity
 * --------
 *   component key   `agentApi`                     (the core row's `COMPONENTS` entry)
 *   module name     `newmark-agentapi`
 *   package         `newmark2dsh-agent-api`
 *   page global     `__NEWMARK_AGENTAPI__`         (absent on the page means switched off)
 *   state route     GET  /newmark-agentapi/state   (read only; every other method is 405)
 *   tools           `agent_api_state`, `agent_api_catalog`, `agent_api_tool`, `agent_api_send`
 *
 * Lifecycle — part of the contract, not an implementation note
 * -----------------------------------------------------------
 *   **Available while the DSH process is alive and Cordis is healthy. Not a standalone tool,
 *   and there is no cold start.** Newmark's `--cli` mode can run `new Agent(root, …)` because
 *   it *is* a separate process that owns its own runtime; this component runs inside an
 *   already-running session and does not start one. If DSH is not running, nothing here
 *   answers.
 *
 * What a run IS
 * -------------
 *   A run is driven by **this component's own agent loop** (`lib/loop.js`, ported from
 *   Newmark's `DESKTOP/src/core/agentKernel/agent-loop.ts`) over **DSH's `llm` service**
 *   (`lib/llm-seam.js`), using the model the user authorised for this bundle and the
 *   credentials the `llm` service already holds.
 *
 *   It does **not** reach for the running agent. It does not call `ctx.subagents.start`, it
 *   does not call `ctx.agents.create`, it creates no session, and it does not need
 *   `exec.agent` to be present. That is precisely what makes it callable from anywhere —
 *   including MemoryLab's HTTP snapshot route, which has no Agent at all and used to force a
 *   two-step fallback.
 *
 * WHICH TOOLS A CALLER IS SHOWN — the rule, and why it is one function
 * ------------------------------------------------------------------
 *   `callScope()` is the only place this is decided. A call that arrives through a
 *   **conversation** (`exec.agent`) is answered for that conversation: its preset's tools, this
 *   package's, and whatever else that conversation's composition registers. A call that arrives
 *   any other way — the state route, another component in process — is answered for the
 *   **process**: the PTC transport, this package's tools, and the tools other plugins register
 *   globally. Every surface reads it — the state catalog, `agent_api_catalog`, the tool set a run
 *   is offered, and the scope a dispatch is resolved for — because a catalog that reports one set
 *   while the dispatch reaches another is the defect this rule removes.
 *
 *   The one asymmetry is a `ptc` conversation, and it is the registry's, not this component's:
 *   `resolveExecution` collapses a model-direct call, so passing such an agent into `execute`
 *   would answer `UNKNOWN_TOOL` for tools the catalog had just listed. `dispatchScope()` keeps
 *   that call in the process-wide layer instead, and the answer says so (`presentation`, and the
 *   receipt's `tool_reach`).
 *
 * What a run is NOT — the cost, stated where a caller will read it
 * ---------------------------------------------------------------
 *   `RUN_ISOLATION` (lib/contract.js) is repeated in the `agent_api_send` description because
 *   a caller must know it to judge what an answer is worth:
 *   **no session log, no conversation or history entry, no subagent-catalogue entry.** A run's
 *   calls are resolved through `dispatchScope()` and the receipt names both halves: `tool_scope`
 *   is whose exposure the offered list is, `tool_reach` is the layer the calls ran in. A reach of
 *   `process` carries no agent — no guard, approval or sandbox decision applies; a reach of
 *   `conversation` is the calling conversation's own scope, where the guards and sandbox policy
 *   declared for it do apply. A run is not auditable through any of DSH's machinery either way.
 *   What it *does* carry is the authorised model and the service's own credentials.
 *
 * The model is the core row's, not this component's
 * -------------------------------------------------
 *   There is deliberately **no `model` config field here.** The user authorises one model for
 *   the whole bundle on the plugin config page, and this component reads it from the core row
 *   through one named accessor (`lib/core-model.js`, `CORE_MODEL_ACCESSOR`). The ways that can
 *   fail are separate answers, and none of them is a silent default: `core_service_absent`,
 *   `core_model_accessor_absent`, `model_not_selected`, `model_unavailable`. See
 *   `lib/core-model.js` for `model_unverified` and why it is the one that is not a refusal.
 *
 * The envelope — every call, every tool, no exceptions
 * ----------------------------------------------------
 *   {
 *     ok:      boolean,                 // derived from `exit`; never passed in
 *     tool:    string,                  // e.g. 'agent_api_send'
 *     route:   'direct'|'loop'|'none',
 *     exit:    0 | 2 | 3 | 4 | 130,     // the reference's exit codes, carried in the envelope
 *     class:   'ok'|'invalid'|'unavailable'|'failed'|'aborted',
 *     result:  <present exactly when exit === 0>,
 *     error:   <present exactly when exit !== 0>,
 *     code:    <machine-readable; present exactly when exit !== 0>,
 *     ...extras                          // `profile`, `model`, `workspace`, `events`
 *   }
 *
 *   0 ok · 2 invalid argument / schema error / unreachable tool name · 3 unavailable host
 *   capability · 4 the tool itself reported failure · 130 aborted.
 *
 * Reads are separate calls from runs
 * ----------------------------------
 *   `agent_api_state` and `agent_api_catalog` are reads: no model call, no tool execution, no
 *   write. `agent_api_tool` and `agent_api_send` are runs. The reference draws the same line —
 *   its `state` is "Read the current local state as JSON and exit without a model request"
 *   while `tool` and `send` cost an execution — and `state` reports the catalog as names and a
 *   count while `tool --list` returns the definitions, which is why those two are separate
 *   calls here as well.
 *
 * How each direction is served
 * ----------------------------
 *   **The running agent, reaching agent-api.** The four tools, registered with
 *   `ctx.tools.register` inside `ctx.effect`, so disposing this component's fiber retires them.
 *
 *   **A composed component, calling agent-api (MemoryLab's rebuild).** In-process, through the
 *   same registry:
 *
 *     import { agentApiPresence, agentApiDisabledEnvelope } from './lib/presence.js';
 *     const presence = agentApiPresence(ctx.tools);
 *     if (!presence.active) return agentApiDisabledEnvelope(presence);   // exit 3, nothing ran
 *     const answer = await ctx.tools.execute({
 *       callId: `agent-api:${Date.now().toString(36)}`,
 *       name: 'agent_api_send',
 *       arguments: { prompt, output_schema, workspace },
 *       signal: exec?.signal ?? new AbortController().signal,
 *     });
 *
 *   **No Agent is needed and none is passed.** A run is identical from a tool call and from an
 *   HTTP route, which is the whole point of the port. `agent_api_presence` lives in
 *   `lib/presence.js` and works whether or not this component is mounted: **a switched-off
 *   component cannot report its own absence**, so presence is read from the tools registry
 *   that outlives it.
 *
 * The answers that must never be conflated
 * -----------------------------------------
 *   `agent_api_disabled`   exit 3  the component is switched off. Nothing was attempted.
 *   `model_not_selected`   exit 3  mounted, but nothing is authorised. Nothing was attempted.
 *   `model_unavailable`    exit 3  a model was authorised and is gone. Nothing was attempted.
 *   `llm_unavailable`      exit 3  the llm service is unreachable. Nothing was attempted.
 *   `run_failed`           exit 4  a run happened and did not deliver. A judgement was tried.
 *
 *   A caller that reads a 3 as a verdict reports success while having judged nothing. That is
 *   the failure this contract exists to make impossible.
 *
 * agent_api_send — inputs
 * -----------------------
 *   prompt            string, REQUIRED. The task to have judged.
 *   output_schema     object, optional. A JSON Schema with `type: 'object'`. When present the
 *                     run's final answer must parse to a matching object, or the call fails
 *                     (exit 4, `schema_violation`) rather than returning unvalidated prose.
 *   workspace         string, optional. Absolute; defaults to `<newmarkRoot>/Work`. Created if
 *                     absent. See THE WORKSPACE below.
 *   timeout_ms        number, optional. Default 120000.
 *   max_steps         number, optional. Model turns before the run is stopped. Default 8.
 *   tool_filter       object, optional. `{ allow?: string[], deny?: string[] }`.
 *   require_workspace boolean, optional, default false.
 *
 * agent_api_send — output on success (exit 0)
 * -------------------------------------------
 *   result = { output, structured, provider, model, turns, tool_calls, usage, elapsed_ms,
 *              stop_reason, model_verified, workspace, tool_names }
 *
 * agent_api_send — failure modes
 * ------------------------------
 *   2  invalid_prompt · invalid_output_schema · invalid_workspace · invalid_timeout
 *      · invalid_max_steps · invalid_tool_filter · invalid_tools · empty_tool_allow
 *   3  core_service_absent · core_model_accessor_absent · core_model_accessor_threw
 *      · model_not_selected · model_unavailable · llm_unavailable · tools_unavailable
 *      · workspace_unavailable
 *   4  run_failed · schema_violation · max_tokens · max_steps · repeated_tool_failure
 *   130 aborted · timeout
 *
 * A RUN THAT CALLS A FAILING TOOL — the defect this contract grew out of
 * ---------------------------------------------------------------------
 *   Measured on the running 0.2.11 bundle: a run whose model called `memory_lab_read` for a
 *   component that does not exist called that same tool on EVERY turn of its budget and ended at
 *   `max_steps` — three of three turns in this component's own re-measurement, whose prompt asked
 *   in words that the tool not be called again, and six of six in the round the user measured.
 *   The failure DID reach the model — as a tool result with `isError: true`, which is what the
 *   events and the second request's message list show — and its entire text was `[object Object]`,
 *   because the MemoryLab tools report `{ ok: false, error: { … } }` and the classifier stringified
 *   the object. A model handed a failure that says nothing has nothing to adapt to.
 *
 *   Three things now hold that shut, and each is a named check in the gate:
 *
 *   1. **the failure is legible** — `describeFailure` (lib/contract.js) extracts the message and
 *      code from a structured failure, so a failed memory tool reads
 *      `NOT_FOUND: Memory component not found: X {"selector":"X"}`;
 *   2. **the model can see what it called with** — a tool call's arguments stay the JSON TEXT the
 *      published `ToolCallBlock` declares, because that same block is echoed back to the provider
 *      on the next turn and the adapter parses it; the object the registry needs is prepared at the
 *      tool boundary instead (`prepareArguments`);
 *   3. **the budget is not the thing that ends the run** — `lib/loop.js` refuses to execute the
 *      same call after it has failed identically twice, tells the model so, and gives it a turn to
 *      answer. A run that answers about the failure is `stop` / exit 0; a run that keeps calling
 *      the refused tool ends as `repeated_tool_failure` (exit 4), which is a different and more
 *      honest answer than `max_steps`.
 *
 *   A malformed tool call — arguments that are not valid JSON, which the DeepSeek adapter reports
 *   as `MALFORMED_RESPONSE` at `message_stop` — is a LEGIBLE TOOL RESULT rather than a dead run:
 *   the turn is kept (lib/llm-seam.js), the tool boundary reports what was wrong with an excerpt,
 *   and the run continues.
 *
 * THE WORKSPACE — and why it is now honest
 * ----------------------------------------
 *   This component owns the loop, so there is no `resolveChildCwd`, no provider `cwd` config,
 *   no synthetic session and no `enforced: false`. The run's working directory is a property of
 *   the loop this file constructs, so `enforced` is a fact about code in this package and it is
 *   reported `true` when it is true.
 *
 *   What that does and does not mean: the directory is created if absent, it is the working
 *   directory carried in every tool-execution context this loop creates, and it is stated to
 *   the run. It is **not** a process-wide `chdir`, and a tool reached through the DSH registry
 *   resolves its own paths against its own services — which is why the default tool set is the
 *   memory tools, for which a working directory is irrelevant. Nothing outside this component
 *   is moved.
 * =====================================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXIT_ABORTED,
  EXIT_FAILED,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  LIFECYCLE,
  RUN_ISOLATION,
  capabilityOf,
  classifyToolResult,
  envelope,
  hostProfile,
} from './lib/contract.js';
import { runAgentLoop } from './lib/loop.js';
import { JUDGE_SYSTEM_PROMPT, createLlmStreamFn, excerpt, toolCallArgumentsChecked, toolCallKey } from './lib/llm-seam.js';
import { readCoreSelection, verifyModelAvailable } from './lib/core-model.js';

/** The four tools this component registers. */
export const TOOL_STATE = 'agent_api_state';
export const TOOL_CATALOG = 'agent_api_catalog';
export const TOOL_TOOL = 'agent_api_tool';
export const TOOL_SEND = 'agent_api_send';

/** Tool names this component refuses to dispatch, because dispatching them is a loop. */
export const SELF_NAMES = [TOOL_STATE, TOOL_CATALOG, TOOL_TOOL, TOOL_SEND, 'run_code'];

/**
 * The tools a run is given when the caller names no `allow`.
 *
 * Memory and nothing else: a judge reading a memory graph needs the memory tools, and a judge
 * that cannot open a file has no use for a working directory or for a filesystem tool. Naming a
 * prefix rather than a list is deliberate — a new `memory_lab_*` tool joins the judging set
 * without this constant being edited, and no filesystem tool can join it by accident.
 */
export const DEFAULT_RUN_TOOL_PREFIXES = ['memory_lab_'];

/**
 * The token that widens a run's tool set to everything the registry exposes to this caller.
 *
 * A token rather than a mode string, and a token no tool can be named: DSH validates tool names
 * as identifiers, so `'*'` cannot collide. Passing `allow: ['*']` is the whole widening — one
 * word at the call site, and the call site is the thing that has to say it.
 */
export const ALL_TOOLS_TOKEN = '*';

/** The default run budget, in milliseconds, and the default model-turn cap. */
export const DEFAULT_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_STEPS = 8;

/**
 * The temporary conversation's own bound, and what reaching it does.
 *
 * The loop's `maxSteps` bounds the TURNS; nothing bounded the history, and an unbounded history
 * on a bounded loop is still a memory leak with a friendly name — every turn appends an assistant
 * message and a tool result, and a tool result can be arbitrarily large. So the history carries
 * its own cap, in messages and in characters.
 *
 * WHAT REACHING IT DOES — oldest-first eviction, and it is worth being exact because the
 * alternatives are worse:
 *
 *   - The **system prompt** is not in the history at all; it travels as `state.systemPrompt` and
 *     is never evicted. Losing it would silently change what the run was asked to be.
 *   - The **first user message** — the prompt being judged — is pinned. Evicting the question
 *     while keeping the answers is the one eviction that makes a run incoherent rather than
 *     merely forgetful.
 *   - Everything after it is evicted **oldest-first, in whole messages**, never splitting a
 *     tool-call from its result: a `toolResult` whose `tool-call` block is gone is a message the
 *     provider will reject, so pairs are dropped together.
 *   - What is evicted is counted and reported (`context_dropped`), never silently forgotten. A
 *     run that lost its early evidence and says so is usable; one that lost it quietly is not.
 *
 * This is a BOUNDED IN-MEMORY history and nothing more. It does not page to disk, it does not
 * summarise, and it does not survive the call: the run's history is released when the run ends
 * (see `runSend`'s `finally`), which is what "temporary" means here.
 */
export const DEFAULT_CONTEXT_MAX_MESSAGES = 48;
export const DEFAULT_CONTEXT_MAX_CHARS = 262144;

/**
 * The bound on every diagnostic string this component puts in an event, in characters.
 *
 * The event log exists so a receipt can say WHY a run looped, and the two things a reader needs
 * are the tool result and the error. Both can be large — a tool result is arbitrary user text and
 * a failure can carry a whole stack's worth of detail — so the payload is carried BOUNDED with
 * the truncation stated (`…(+N chars)`) rather than either dropped or pasted whole. The envelope
 * has a lossless-JSON boundary to cross and a caller waiting on the other side of it; a payload
 * that blows the envelope is worse than no payload, which is the trade this constant is.
 */
export const EVENT_TEXT_LIMIT = 240;

/** How many events one run's receipt keeps, and the total characters they may spend. */
export const EVENT_MAX_COUNT = 64;
export const EVENT_MAX_CHARS = 16384;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFn = (value) => typeof value === 'function';

function toolText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** The text of a `ContentBlock[]`, which is how a run reports its prose. */
function blockText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : '';
  return blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Whether a value survives a JSON round-trip, which `ctx.tools.execute` requires. */
function jsonSafe(value) {
  if (value === undefined) return true;
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value);
  } catch {
    return false;
  }
}

/** One bounded string, for an event. Never `undefined`, and never unbounded. */
function boundedText(value, limit = EVENT_TEXT_LIMIT) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return excerpt(value, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return excerpt(JSON.stringify(value), limit);
  } catch {
    return '[unserialisable]';
  }
}

/**
 * One loop event, as the receipt carries it.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. The event log used to be
 * `{ type, turn: event?.turn ?? null }` and nothing else, so `tool_execution_start` and
 * `tool_execution_end` — the two events that say a tool was called and what came back — arrived
 * with no payload. A receipt could show that a run had looped and could not show why, which is
 * the only thing a reader of that receipt needs. Measured on the running 0.2.11 bundle: a run
 * that called a failing tool on every one of its turns ended at `max_steps` with six
 * `tool_execution_end` events carrying `{ type, turn: null }`.
 *
 * WHAT IT CARRIES, per type. The tool events carry the tool, the call id, the turn (now emitted
 * by the loop — it is the turn whose assistant message asked for the call), the arguments as the
 * model emitted them, and then either `is_error: false` with the tool's own text, or
 * `is_error: true` with the failure's message and its classification code. Nothing else is
 * invented: a field this function cannot state is `null` or absent, never `undefined`.
 *
 * AND WHY EVERY FIELD IS BUILT THE SAME WAY. `undefined` in a value position has cost this
 * bundle two releases — `memory_lab_reindex` in 0.2.2 and this component's own
 * `turn: event?.turn` in 0.2.8, where a completed run's answer was thrown away at the DSH
 * lossless-JSON boundary. A new event field is exactly where a new `undefined` appears, so every
 * value here goes through `boundedText` (which answers `null`) or through a literal.
 */
export function eventView(event, stats = null) {
  const type = String(event?.type ?? '');
  const turn = Number.isFinite(event?.turn) ? event.turn : null;
  const base = { type, turn };
  const callId = typeof event?.toolCallId === 'string' ? event.toolCallId : null;
  const tool = typeof event.toolName === 'string' ? event.toolName : null;
  if (type === 'tool_execution_start') {
    return { ...base, tool, call_id: callId, arguments: boundedText(event?.arguments) };
  }
  if (type === 'tool_execution_end') {
    const failed = event?.isError === true;
    const content = event?.result?.content;
    const text = Array.isArray(content)
      ? content.map((block) => (block && block.type === 'text' ? String(block.text) : '')).filter(Boolean).join('\n')
      : typeof content === 'string'
        ? content
        : '';
    return {
      ...base,
      tool,
      call_id: callId,
      is_error: failed,
      ...(failed
        ? {
            code: boundedText(event?.error?.code) ?? '',
            error: boundedText(event?.error?.message),
            ...(event?.refused === true ? { refused: true } : {}),
          }
        : { result: boundedText(text) }),
      ...(Number.isFinite(event?.repeat) ? { repeat: event.repeat } : {}),
    };
  }
  if (type === 'turn_end') {
    const results = Array.isArray(event?.toolResults) ? event.toolResults : [];
    return { ...base, tool_results: results.length, errors: results.filter((result) => result?.isError === true).length };
  }
  if (type === 'agent_end') {
    return { ...base, stop_reason: boundedText(event?.stopReason) ?? '', ...(stats ? { events_kept: stats.kept, events_dropped: stats.dropped } : {}) };
  }
  return base;
}

/** Resolve the workspace for one call. Always absolute. */
export function resolveWorkspace(requested, configured, root) {
  const chosen = typeof requested === 'string' && requested.trim() ? requested.trim() : '';
  if (chosen) return path.resolve(chosen);
  const fallback = typeof configured === 'string' && configured.trim() ? configured.trim() : '';
  if (fallback) return path.resolve(fallback);
  return path.resolve(path.join(root, 'Work'));
}

/** Create the workspace if absent, and report what was actually true afterwards. */
export function ensureWorkspace(dir) {
  const result = { path: dir, created: false, exists: false, enterable: false, error: '' };
  try {
    result.exists = fs.existsSync(dir);
    if (!result.exists) {
      fs.mkdirSync(dir, { recursive: true });
      result.created = true;
      result.exists = true;
    }
    if (!fs.statSync(dir).isDirectory()) {
      result.error = `${dir} exists and is not a directory`;
      return result;
    }
    fs.accessSync(dir, fs.constants.R_OK);
    result.enterable = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/**
 * Create the agent-api component.
 *
 * @param root - the shared Newmark user root, from `lib/root.js`. The default workspace is
 *   `<root>/Work`, so the same root rule that places the memory store places the run workspace.
 * @param services - a *function* returning `{ tools, llm, webServer, core }` as they are RIGHT
 *   NOW. A function rather than an object because a profile can gain or lose a service while
 *   this component is mounted, and a snapshot taken at `apply()` time would report a capability
 *   the host no longer has.
 */
export function createAgentApi({
  root,
  workspace = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSteps = DEFAULT_MAX_STEPS,
  contextMaxMessages = DEFAULT_CONTEXT_MAX_MESSAGES,
  contextMaxChars = DEFAULT_CONTEXT_MAX_CHARS,
  toolPrefixes = DEFAULT_RUN_TOOL_PREFIXES,
  services = () => ({}),
  logger,
} = {}) {
  /**
   * Counters, so "a read does not perform a run" is observable rather than promised.
   *
   * `activeRuns` and `retainedMessages` are the temporary conversation's own evidence, and they
   * exist because a release that only happens on the happy path is a release that does not
   * happen: a run's history must be gone whether it answered, failed, was aborted or timed out.
   * Both must read 0 once every call has returned, and the gate asserts that after a successful
   * run AND after a failed one. A release that only ran on success would leave `activeRuns` at 1
   * for ever, which is the shape this pair is here to catch.
   */
  const counters = { reads: 0, dispatches: 0, runs: 0, modelCalls: 0, toolCalls: 0, activeRuns: 0, retainedMessages: 0 };

  const serviceView = () => {
    try {
      return services() ?? {};
    } catch (error) {
      logger?.warn?.(`newmark-agentapi: reading the service view failed: ${error?.message ?? error}`);
      return {};
    }
  };

  const defaultWorkspace = () => resolveWorkspace('', workspace, root);

  /** The model the bundle was authorised to use, as a compact view for the envelope. */
  function modelView(view) {
    const selection = readCoreSelection(view);
    return {
      ok: selection.ok === true,
      source: String(selection.source ?? 'none'),
      provider: String(selection.provider ?? ''),
      model: String(selection.model ?? ''),
      code: selection.ok === true ? '' : String(selection.code ?? ''),
      reason: selection.ok === true ? '' : String(selection.reason ?? ''),
    };
  }

  /** The host profile for this moment, probed against the services in hand. */
  function profileFor(view = serviceView()) {
    return hostProfile(view, { model: readCoreSelection(view), workspace: defaultWorkspace(), component: 'agentApi' });
  }

  /**
   * The run's TEMPORARY CONVERSATION: a bounded, in-memory message history that lives exactly as
   * long as the call that made it.
   *
   * ## Why it is not a session, and why that is the point
   *
   * This is the thing that must never become a DSH session. A session is a stored, listable,
   * resumable object with a log, an entry in the conversation list, a place in the subagent
   * catalogue and a line in the workspace's session accounting. None of that is wanted here: a
   * run is a bounded question with a bounded answer, made on behalf of a tool call. So the
   * history is an array in this closure and nothing else — no `sessionPersistence.create`, no
   * session id, no log file, no registry entry — and `release()` below is what makes "temporary"
   * true rather than aspirational.
   *
   * ## The bound, and what reaching it does
   *
   * `maxSteps` bounds the turns; this bounds the history. See
   * `DEFAULT_CONTEXT_MAX_MESSAGES` / `DEFAULT_CONTEXT_MAX_CHARS` for what eviction does and what
   * it deliberately never evicts (the prompt). Both the cap and the drop count are reported, so
   * a run that forgot its early evidence says so rather than quietly answering from less.
   */
  function createConversation() {
    const messages = [];
    const dropped = { messages: 0, chars: 0 };
    let chars = 0;

    const sizeOf = (message) => {
      try {
        return JSON.stringify(message ?? null)?.length ?? 0;
      } catch {
        return 0;
      }
    };

    /** The next message that may be evicted: never the prompt, which is the first user turn. */
    const evictable = () => {
      for (let index = 1; index < messages.length; index += 1) {
        if (messages[index]?.role !== 'assistant' || messages[index]?.content?.length !== 0) return index;
      }
      return messages.length;
    };

    const trim = () => {
      // Three bounds, applied until none is exceeded. A tool result can be large enough to break
      // the character cap on its own, so "evict one and re-check" is not the same as "evict until
      // it fits" — the loop is what makes the cap a cap.
      while (messages.length > contextMaxMessages || chars > contextMaxChars) {
        const at = evictable();
        if (at >= messages.length) break; // nothing but the pinned prompt is left
        const [gone] = messages.splice(at, 1);
        const size = sizeOf(gone);
        chars -= size;
        dropped.messages += 1;
        dropped.chars += size;
        // A tool result whose tool-call block was just evicted is a message the provider would
        // reject, so the pair goes together. Walking forward while the pair is incomplete is what
        // keeps the history a history the model can be shown.
        if (gone?.role === 'assistant' && Array.isArray(gone.content)) {
          const calls = new Set(gone.content.filter((b) => b?.type === 'tool-call').map((b) => b.id));
          for (let index = messages.length - 1; index >= 1; index -= 1) {
            if (calls.has(messages[index]?.toolCallId)) {
              const size2 = sizeOf(messages[index]);
              messages.splice(index, 1);
              chars -= size2;
              dropped.messages += 1;
              dropped.chars += size2;
            }
          }
        }
      }
      counters.retainedMessages = messages.length;
      return { messages: messages.length, chars, dropped: { ...dropped } };
    };

    return {
      messages,
      push(message) {
        messages.push(message);
        chars += sizeOf(message);
        return trim();
      },
      /** One snapshot, detached: the caller keeps it after `release()` empties the array. */
      stats() {
        return { messages: messages.length, chars, dropped: { ...dropped } };
      },
      /**
       * Release the history. Called from a `finally`, so it runs whether the run answered,
       * failed, was aborted or timed out — a release on the happy path only would leave a
       * failed run's conversation in memory until the process ended.
       *
       * `length = 0` rather than dropping the reference: an array another closure still holds
       * would otherwise keep every message alive, which is the difference between dropping a
       * reference and releasing the memory behind it. `counters.retainedMessages` goes to 0 with
       * it, and that is what the gate reads — a counter that only ever decremented on success
       * would sit above zero for ever after one failure.
       */
      release() {
        messages.length = 0;
        chars = 0;
        counters.retainedMessages = 0;
      },
    };
  }

  /**
   * Which of the registry's tools a run would be given, by the same rule the run uses.
   *
   * THE TWO SETS, which is the whole of this function:
   *
   *   default (no `allow`)   the memory tools. `DEFAULT_RUN_TOOL_PREFIXES` are matched by prefix
   *                          so a new `memory_lab_*` joins the judging set without an edit, and
   *                          no filesystem tool can join it by accident. This stays the default:
   *                          MemoryLab's rebuild depends on it, and a judging run that needs no
   *                          filesystem should not have one.
   *   `allow: ['*']`         **every tool the registry exposes to this caller**, minus the
   *                          reserved names below. This is the widening, and it is opt-in per
   *                          call: the caller has to write the token, which is the point.
   *
   * `'*'` is a token and not a name a tool can have — DSH validates tool names as identifiers —
   * so it cannot collide with a real tool. The other two things it is not: it is not a `deny`
   * token (a deny list of `'*'` would be an empty set, so it is read as a literal name and
   * matches nothing), and it is not accepted alongside an empty `allow`, which is refused at the
   * argument boundary rather than silently widening.
   *
   * `SELF_NAMES` is subtracted from BOTH sets, always and first: dispatching this component's own
   * tools from inside a run it is driving would re-enter the loop, and `run_code` is a reserved
   * PTC transport name rather than a capability. `ctx.tools.restrict()` refuses to name it too.
   */
  function runToolNames(names, filter) {
    const allow = Array.isArray(filter?.allow) ? filter.allow.map(String) : null;
    const deny = Array.isArray(filter?.deny) ? filter.deny.map(String) : [];
    const prefixes = Array.isArray(toolPrefixes) ? toolPrefixes.map(String) : DEFAULT_RUN_TOOL_PREFIXES;
    const everything = allow !== null && allow.includes(ALL_TOOLS_TOKEN);
    return names.filter((name) => {
      if (SELF_NAMES.includes(name)) return false;
      if (deny.includes(name)) return false;
      if (everything) return true;
      if (allow) return allow.includes(name);
      return prefixes.some((prefix) => name.startsWith(prefix));
    });
  }

  /**
   * WHICH SCOPE A CALL IS RESOLVED FOR — the rule, in one place.
   *
   * A call that arrives through a **conversation** (`exec.agent`) is resolved for THAT
   * conversation: `ctx.tools.schemas(agent)` chains the scope's own layer over the global one, so
   * the answer is the preset's tools plus this package's plus whatever else that conversation's
   * composition registers. A call with **no conversation** — the state route, another component
   * in process — is resolved for the **process**: `schemas()` is the global layer alone, which is
   * the PTC transport, this package's tools, and the tools other plugins register globally.
   *
   * Every surface here reads this one function — `agent_api_state.catalog`, `agent_api_catalog`,
   * the tool set a run is offered, and the scope a dispatch is resolved for — because a catalog
   * that says one thing while the dispatch does another is the defect this rule exists to remove.
   *
   * `presentation` is what the conversation's own MODEL is shown. Under `ptc` the registry
   * **collapses** a model-direct call: `resolveExecution` answers `undefined` for every name but
   * the reserved `run_code`, which surfaces as `UNKNOWN_TOOL`. That matters here because passing
   * such an agent into `execute` would deny the very tools the catalog had just listed. `modeFor`
   * is read defensively: a service without it cannot collapse anything, and `native` is then the
   * honest reading.
   */
  function callScope(view, agent) {
    if (agent === undefined || agent === null) return { scope: undefined, target: 'process', presentation: 'global' };
    let presentation = 'native';
    try {
      if (isFn(view?.tools?.modeFor)) presentation = view.tools.modeFor(agent) === 'ptc' ? 'ptc' : 'native';
    } catch {
      presentation = 'native';
    }
    return { scope: agent, target: 'conversation', presentation };
  }

  /**
   * The scope a DISPATCH may be resolved for.
   *
   * A `ptc` conversation collapses every direct call but `run_code`, so handing its agent to
   * `execute` would turn a working dispatch into `UNKNOWN_TOOL` — a regression for exactly the
   * presets that carry the PTC surface. Such a call therefore keeps the process-wide view: that is
   * the layer a programmatic caller outside the conversation's transport can really reach, and the
   * answer says so rather than pretending the conversation's own scope applied.
   */
  function dispatchScope(call) {
    return call.target === 'conversation' && call.presentation !== 'ptc' ? call.scope : undefined;
  }

  /**
   * The read half, as one function, shared by the `agent_api_state` tool and the state route.
   *
   * It executes nothing and calls no model: `ctx.tools.schemas(scope)` projects the registry and
   * `serviceView()` reads references. The counters it reports are the evidence, and the gate
   * asserts them from outside by instrumenting the services it hands in.
   *
   * `scope` is the CALLING agent, and it is what makes this read agree with the conversation the
   * caller is in: the registry resolves a scope's view as *its own layer over the global one*, so
   * `schemas(agent)` is the preset's tool list plus this package's, while `schemas()` with no
   * argument is the global layer alone — the PTC transport, this package's fifteen and whatever
   * other plugins register globally. That IS the rule: a conversation is answered for the
   * conversation, and anything else for the process. The route has no Agent, so it reads the
   * process view and says so in `scope`.
   */
  function stateEnvelope(scope) {
    const view = serviceView();
    const profile = profileFor(view);
    const call = callScope(view, scope);
    const schemas = isFn(view.tools?.schemas) ? view.tools.schemas(call.scope) : [];
    const names = Array.isArray(schemas) ? schemas.map((entry) => String(entry?.name ?? '')).filter(Boolean) : [];
    return envelope({
      tool: TOOL_STATE,
      exit: EXIT_OK,
      route: 'direct',
      result: {
        component: 'agentApi',
        root,
        platform: process.platform,
        workspace: defaultWorkspace(),
        engine: 'own-loop',
        catalog: { count: names.length, names: names.slice().sort() },
        scope: call.target,
        presentation: call.presentation,
        runTools: runToolNames(names),
        counters: { ...counters },
      },
      extra: { profile },
    });
  }

  /**
   * Build the restricted tool set offered to one run.
   *
   * The set is chosen HERE and handed to the loop, so the restriction is a property of the loop
   * and cannot be widened by the model: the run's model sees only these names, and a name
   * outside the set is not in the list the loop searches, so `executeToolCalls` answers
   * `Tool "<name>" not found` without the registry ever being asked.
   *
   * A failing tool **throws**, which is what the loop's `executeToolCalls` catches to mark the
   * result `isError` — so a failed call reaches the run's model as a failure it can adapt to,
   * rather than as prose that reads like success.
   *
   * `scope` is the CALLER's agent, when the call came in with one. It is passed to
   * `ctx.tools.schemas(scope)` so the registry projects what THAT caller can see: "the tools DSH
   * exposes" is a statement about a viewing scope, not about the process, and asking for the
   * unrestricted global list would hand a run tools its own caller cannot reach. When there is no
   * `scope` is the CALLER's agent, when the call came in with one, and it is the OFFER scope: it
   * goes to `ctx.tools.schemas(scope)` so the registry projects what that conversation can see.
   * "The tools DSH exposes" is a statement about a viewing scope, not about the process, so a
   * conversation gets its own list and a route-driven call gets the process-wide one.
   *
   * `reach` is the DISPATCH scope for the calls this set will make, and it is not always `scope`:
   * a `ptc` conversation collapses direct calls, so its agent would turn every call but `run_code`
   * into `UNKNOWN_TOOL` (`dispatchScope` owns that decision). A run therefore offers what its
   * caller can see and executes in the widest layer it can actually reach, and the receipt says
   * both: `tool_scope` and `tool_reach`.
   *
   * What this still does NOT do: the run's calls execute outside any conversation's per-agent
   * tool restriction. `ctx.tools.restrict()` is per-agent and cannot be expressed for a scopeless
   * call, which is why the `agent_api_send` description says a run is not audited by DSH's
   * machinery. Scoping the LIST is a choice of what to offer; `reach` widens what may execute.
   */
  function buildRunTools(view, filter, signal, scope, reach) {
    const schemas = isFn(view.tools?.schemas) ? view.tools.schemas(scope) : [];
    const all = Array.isArray(schemas) ? schemas : [];
    const permitted = new Set(runToolNames(all.map((entry) => String(entry?.name ?? '')), filter));
    return all
      .filter((entry) => permitted.has(String(entry?.name ?? '')))
      .map((entry) => {
        const name = String(entry.name);
        return {
          name,
          description: String(entry.description ?? ''),
          parameters: entry.parameters ?? { type: 'object' },
          // Everything is a serial barrier. The reference grades tools it knows; this component
          // does not know what a registry tool does to the world, and an ungraded tool that
          // overlapped a sibling would be a race it invented.
          concurrencySafe: false,
          /**
           * THE TOOL BOUNDARY, and the only place the wire's JSON text becomes the object the
           * registry requires. `lib/llm-seam.js` used to do this to the block itself, which also
           * sent the object back to the provider on the next turn where the published type is a
           * string — so the model was shown its own earlier calls with no arguments at all. The
           * parse belongs here, one layer below the message.
           *
           * A call whose arguments are not readable JSON throws, and the LOOP turns that throw
           * into a tool result the model reads (`executeToolCalls` prepares inside its try). The
           * message names the problem and quotes an excerpt, so a model that emitted a broken
           * argument string — the `MALFORMED_RESPONSE` path, measured at 0.2.11 — is told to
           * re-issue the call instead of watching the run die with a transport error.
           */
          prepareArguments(raw) {
            const checked = toolCallArgumentsChecked(raw);
            if (checked.ok) return checked.value;
            const error = new Error(
              `the arguments of this ${name} call could not be read: ${checked.reason}. ` +
                `Re-issue the call with a single valid JSON object as its arguments.`,
            );
            error.code = 'MALFORMED_TOOL_ARGUMENTS';
            throw error;
          },
          async execute(callId, args) {
            counters.toolCalls += 1;
            // `reach` for the same reason the catalog is scoped: a run offers the caller's tool
            // list, so its calls must resolve in a scope that can actually carry them. Announcing
            // one surface and executing another is the bypass this pairing exists to avoid — a
            // tool the list showed but the resolved layer does not carry would answer
            // `UNKNOWN_TOOL` at call time.
            const outcome = await view.tools.execute({
              callId: `agent-api-run:${callId}`,
              name,
              arguments: args ?? {},
              signal,
              ...(reach === undefined ? {} : { agent: reach }),
            });
            const classified = classifyToolResult(name, outcome);
            if (classified.exit !== EXIT_OK) {
              const error = new Error(classified.error);
              error.code = classified.code;
              error.exit = classified.exit;
              throw error;
            }
            return {
              content: typeof classified.result === 'string' ? classified.result : JSON.stringify(classified.result, null, 2),
              details: { exit: EXIT_OK },
            };
          },
        };
      });
  }

  /**
   * Run one prompt through this component's own loop, and classify what came back.
   *
   * Every early return is an envelope with a non-zero `exit`; there is no path that returns
   * `ok: true` without a run having completed and answered.
   */
  async function runSend(args, exec) {
    const tool = TOOL_SEND;
    const view = serviceView();
    const model = modelView(view);
    const selection = readCoreSelection(view);

    /* ---- arguments, before anything is touched ------------------------------- */

    const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
    if (!prompt.trim()) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_prompt', error: 'prompt is required and must be a non-empty string', extra: { model } });
    }
    const outputSchema = args?.output_schema;
    if (outputSchema !== undefined && !(isPlainObject(outputSchema) && outputSchema.type === 'object')) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_output_schema', error: "output_schema must be an object with type: 'object' when present", extra: { model } });
    }
    if (args?.workspace !== undefined && typeof args.workspace !== 'string') {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_workspace', error: 'workspace must be a string when present', extra: { model } });
    }
    if (args?.tool_filter !== undefined && !isPlainObject(args.tool_filter)) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_tool_filter', error: 'tool_filter must be an object when present', extra: { model } });
    }
    const budget = args?.timeout_ms === undefined ? timeoutMs : args.timeout_ms;
    if (!(Number.isFinite(budget) && budget > 0)) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_timeout', error: 'timeout_ms must be a positive finite number when present', extra: { model } });
    }
    const steps = args?.max_steps === undefined ? maxSteps : args.max_steps;
    if (!(Number.isFinite(steps) && steps > 0)) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_max_steps', error: 'max_steps must be a positive finite number when present', extra: { model } });
    }
    /* The tool selection. `tool_filter` is the argument this tool has always taken; `tools` is
     * the name the widening is documented under. Both are accepted, `tools` wins when present,
     * and one rule reads both. An empty `allow` is REFUSED rather than treated as "everything":
     * widening is the dangerous direction, so the one input that could mean either must not be
     * the one that is guessed. */
    const toolFilter = args?.tools !== undefined ? args.tools : args?.tool_filter;
    if (toolFilter !== undefined && !isPlainObject(toolFilter)) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_tools', error: 'tools must be an object when present: { allow?: string[], deny?: string[] }', extra: { model } });
    }
    if (Array.isArray(toolFilter?.allow) && toolFilter.allow.length === 0) {
      return envelope({
        tool,
        exit: EXIT_INVALID,
        route: 'none',
        code: 'empty_tool_allow',
        error:
          "tools.allow must not be an empty list: an empty allow is not \"every tool\". Name the tools you " +
          `want, or pass ['${ALL_TOOLS_TOKEN}'] to widen the run to every tool DSH exposes to this caller`,
        extra: { model },
      });
    }

    // Resolved here, created further down — after every refusal. A call that answers exit 3 has
    // done nothing at all, and "nothing" includes the filesystem: creating the workspace for a
    // run that was never going to happen is a side effect the caller cannot see.
    const workspacePath = resolveWorkspace(args?.workspace, workspace, root);
    const untouchedWorkspace = () => ({
      path: workspacePath,
      created: false,
      exists: fs.existsSync(workspacePath),
      enterable: false,
      enforced: false,
      enforced_by: 'agent-api/loop',
      note: 'the workspace was not touched: the call was refused before anything ran',
    });

    /* ---- is there an authorised model, and can it be called ------------------ */

    // Each of these is its own answer. None of them is "the run failed", because in none of them
    // did a run happen — and a caller that reads one as a verdict reports a judgement that was
    // never made.
    if (!selection.ok) {
      return envelope({ tool, exit: EXIT_UNAVAILABLE, route: 'none', code: selection.code, error: selection.reason, extra: { model, workspace: untouchedWorkspace() } });
    }
    const verified = await verifyModelAvailable(view.llm, selection);
    model.verified = verified.verified;
    model.verifiedReason = verified.reason;
    if (verified.verified === false) {
      return envelope({ tool, exit: EXIT_UNAVAILABLE, route: 'none', code: verified.code, error: verified.reason, extra: { model, workspace: untouchedWorkspace() } });
    }
    if (!isFn(view.llm?.stream)) {
      const capability = capabilityOf(profileFor(view), 'model.request');
      return envelope({ tool, exit: EXIT_UNAVAILABLE, route: 'none', code: String(capability?.code ?? 'llm_unavailable'), error: `no model call can be made: ${capability?.reason ?? 'the llm service is not reachable'}`, extra: { model, workspace: untouchedWorkspace() } });
    }
    if (!isFn(view.tools?.schemas) || !isFn(view.tools?.execute)) {
      const capability = capabilityOf(profileFor(view), 'agent.run');
      return envelope({ tool, exit: EXIT_UNAVAILABLE, route: 'none', code: String(capability?.code ?? 'tools_unavailable'), error: `no run can be driven: ${capability?.reason ?? 'the tools registry is not reachable'}`, extra: { model, workspace: untouchedWorkspace() } });
    }

    /* ---- the workspace is created here, and only here ------------------------ */

    const workspaceState = ensureWorkspace(workspacePath);
    if (!workspaceState.enterable) {
      return envelope({
        tool,
        exit: EXIT_UNAVAILABLE,
        route: 'none',
        code: 'workspace_unavailable',
        error: `the workspace ${workspacePath} could not be used: ${workspaceState.error || 'not an accessible directory'}`,
        extra: { model, workspace: { ...workspaceState, enforced: false, enforced_by: 'agent-api/loop', note: 'the run was never started' } },
      });
    }

    /* ---- the run ------------------------------------------------------------- */

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budget);
    const callerSignal = exec?.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal && isFn(callerSignal.addEventListener)) callerSignal.addEventListener('abort', onCallerAbort, { once: true });

    const startedAt = Date.now();
    const runCall = callScope(view, exec?.agent);
    const runTools = buildRunTools(view, toolFilter, controller.signal, runCall.scope, dispatchScope(runCall));
    const streamFn = createLlmStreamFn(view.llm, selection, {});
    const events = [];
    /**
     * The event log, bounded twice: a count and a character budget.
     *
     * The previous log was `{ type, turn }` per event with a count cap of 64, and the reason it
     * carried nothing was that nothing was offered to it. It is offered now (`eventView`), so it
     * needs a size bound as well — a tool result can be arbitrarily large and this array is
     * inside the envelope the registry validates and the caller reads. Past either bound the log
     * says so (`events_dropped`, `events_truncated`) rather than silently stopping.
     */
    const eventStats = { kept: 0, dropped: 0, chars: 0, truncated: false };
    const pushEvent = (event) => {
      const view_ = eventView(event, eventStats);
      const size = JSON.stringify(view_).length;
      if (eventStats.kept >= EVENT_MAX_COUNT || eventStats.chars + size > EVENT_MAX_CHARS) {
        eventStats.dropped += 1;
        eventStats.truncated = true;
        return;
      }
      eventStats.kept += 1;
      eventStats.chars += size;
      events.push(view_);
    };
    /* The run's OWN tool calls, not the component's lifetime total. `counters.toolCalls` is a
     * per-instance counter that `agent_api_state` reports and every run adds to; reporting it as
     * this run's `tool_calls` said "14" for a run that made one call. Measured live at 0.2.11:
     * a two-turn run with a single tool call answered `tool_calls: 14`. */
    const toolCallsBefore = counters.toolCalls;
    /* THE TEMPORARY CONVERSATION. Built here — after every refusal, so a call that answers exit 3
     * has not even made one — bounded in memory, never a session, and released in the `finally`
     * below on EVERY path: answered, failed, aborted, timed out. */
    const conversation = createConversation();
    let contextStats;
    counters.activeRuns += 1;
    let outcome;
    try {
      counters.modelCalls += 1;
      contextStats = conversation.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
      outcome = await runAgentLoop(
        // Handed the conversation's own message array, already trimmed to the bound. This is the
        // prompt list; the loop then owns its per-turn history, which `maxSteps` bounds (see the
        // note on `createConversation` for exactly what is and is not bounded here).
        conversation.messages.slice(),
        {
          state: { model: selection, systemPrompt: JUDGE_SYSTEM_PROMPT, messages: [], tools: runTools },
          streamFn,
          toolExecution: 'serial',
          maxSteps: Math.floor(steps),
          // THE RETRY BOUND, wired where the wire shape is known. `toolCallKey` canonicalises a
          // call's arguments through the same parse the tool boundary uses, so `{"a":1}` and
          // `{"a": 1}` are ONE call for the bound rather than two — a bound that could be evaded
          // by respacing JSON would not bound anything.
          callKey: toolCallKey,
          // The directory every tool-execution context of this run carries. This component owns
          // the loop, so this is the run's working directory by construction rather than by
          // negotiation with a provider.
          workspace: workspacePath,
          /**
           * The event sink, and the bound on what it keeps.
           *
           * `eventView` builds the payload (the tool, the call id, the turn, the arguments, the
           * error or the result) and `pushEvent` enforces the two bounds — a count and a
           * character budget — past which the log says it dropped events rather than growing.
           *
           * `turn` is `null` and never `undefined`, and that is not tidiness.
           *
           * DSH validates a tool's return value as LOSSLESS JSON before handing it back — the
           * walker accepts null, booleans, strings, finite numbers, plain arrays and plain objects,
           * and rejects `undefined` at `if (typeof current !== "object") return void 0`
           * (`dsh-util-values/lib/index.js`). `{ turn: undefined }` made the WHOLE envelope invalid,
           * so a judgement that had run to completion came back to its caller as
           * `INVALID_TOOL_OUTPUT — tool "agent_api_send" returned invalid output: value is not
           * lossless JSON` — an operation that succeeded, reported as a failure. Third time this
           * bundle has met that boundary; `memory_lab_reindex` and the ComputerUse backends were
           * the other two. Every field `eventView` adds is built to the same rule, and the
           * boundary gate walks the result.
           */
          emit: async (event) => pushEvent(event),
        },
        controller.signal,
      );
    } catch (error) {
      const aborted = timedOut || controller.signal.aborted || error?.name === 'AbortError';
      return envelope({
        tool,
        exit: aborted ? EXIT_ABORTED : EXIT_FAILED,
        route: 'loop',
        code: aborted ? (timedOut ? 'timeout' : 'aborted') : 'run_failed',
        error: aborted ? `the run was cancelled (${timedOut ? 'timeout' : 'caller aborted'})` : `the run failed: ${error?.message ?? error}`,
        // The same figures the settled paths report, so a receipt for a THROWN run also says how
        // far it got: `outcome` never arrived, so the turn and tool-call counts are the ones the
        // event log and the counter carry.
        extra: {
          model,
          context: contextStats,
          workspace: { ...workspaceState, enforced: true, enforced_by: 'agent-api/loop', note: 'the run was driven by this component own loop in this directory' },
          events,
          run: {
            turns: events.filter((event) => event.type === 'turn_start').length,
            tool_calls: counters.toolCalls - toolCallsBefore,
            stop_reason: aborted ? (timedOut ? 'timeout' : 'aborted') : 'threw',
            events_kept: eventStats.kept,
            events_dropped: eventStats.dropped,
            recovered_turns: 0,
          },
        },
      });
    } finally {
      clearTimeout(timer);
      if (callerSignal && isFn(callerSignal.removeEventListener)) callerSignal.removeEventListener('abort', onCallerAbort);
      // THE RELEASE, and it is in a `finally` on purpose: one placed after the `await` would be
      // skipped by exactly the paths that matter — a throw from the loop, an abort, a timeout.
      // `activeRuns` returns to 0 and `retainedMessages` to 0 here, which is what the gate
      // asserts after a successful run AND after a failed one.
      //
      // The stats are taken HERE rather than after the `try`, because this is the last moment the
      // history exists: on the success path the code below this block is past the release, so a
      // `stats()` call there would faithfully report an empty conversation and a run that used
      // the bound would look like one that never had a history.
      contextStats = conversation.stats();
      conversation.release();
      counters.activeRuns -= 1;
    }

    const workspaceReceipt = {
      ...workspaceState,
      enforced: true,
      enforced_by: 'agent-api/loop',
      note:
        'the run was driven by this component own loop with this directory as its working directory. ' +
        'It is not a process-wide chdir, and a tool reached through the DSH registry resolves its own ' +
        'paths against its own services',
    };
    const assistantTurns = outcome.messages.filter((message) => message.role === 'assistant');
    const last = assistantTurns[assistantTurns.length - 1];
    const output = blockText(last?.content);
    /**
     * What the run did, in the three numbers a reader of a FAILED receipt needs.
     *
     * A failure envelope carries no `result` — the contract is explicit that `result` is present
     * exactly when `exit === 0` — so before this block a caller could see `code: 'max_steps'` and
     * nothing else: not how many turns were burned, not how many tool calls were repeated. That is
     * why MemoryLab's rebuild log can print `(judgement failed, 0 turns)` for a run that took
     * eight turns: it reads `result.turns`, and on the failure path there is no `result` to read.
     * The figures are reported here instead, so a receipt says what happened even when it says the
     * run did not deliver.
     */
    const runFacts = {
      turns: assistantTurns.length,
      tool_calls: counters.toolCalls - toolCallsBefore,
      stop_reason: String(outcome.stopReason ?? 'stop'),
      events_kept: eventStats.kept,
      events_dropped: eventStats.dropped,
      /**
       * Turns that survived a provider failure because they had already delivered their content.
       *
       * `lib/llm-seam.js` keeps a turn whose stream threw after delivering a tool call — the
       * `MALFORMED_RESPONSE` path — instead of discarding it and ending the run. When that
       * happens the receipt has to say so: a recovered turn and an ordinary one look identical
       * from the outside, and "the provider failed here and the run continued anyway" is exactly
       * the kind of fact a reader of a judgement receipt needs.
       */
      recovered_turns: assistantTurns.filter((message) => message.recoveredFrom === 'stream-failed-after-content').length,
    };
    const base = {
      output,
      structured: null,
      provider: String(selection.provider),
      model: String(selection.model),
      turns: runFacts.turns,
      tool_calls: runFacts.tool_calls,
      usage: last?.usage ?? null,
      elapsed_ms: Date.now() - startedAt,
      stop_reason: runFacts.stop_reason,
      model_verified: verified.verified,
      workspace: workspaceReceipt,
      tool_names: runTools.map((entry) => entry.name),
      // WHICH SCOPE, said in the receipt rather than left to be inferred: `tool_scope` is whose
      // exposure the list above is (a conversation's, or the process's), and `tool_reach` is the
      // layer the calls in it were resolved for. They differ for a `ptc` conversation, where the
      // offer is the conversation's list and the reach is the process-wide one — the same split
      // `agent_api_state` reports.
      tool_scope: runCall.target,
      tool_reach: dispatchScope(runCall) === undefined ? 'process' : 'conversation',
      // The temporary conversation, reported as facts rather than as a promise: how many messages
      // it held, how many characters, and what the bound evicted. `contextStats` was captured
      // BEFORE `release()` emptied the array, so these are the run's real figures; `released` is
      // `true` because the release happens in the `finally` this path also passes through, and
      // the gate checks it from outside by reading the counters rather than by trusting the field.
      context: {
        max_messages: contextMaxMessages,
        max_chars: contextMaxChars,
        messages: contextStats.messages,
        chars: contextStats.chars,
        dropped_messages: contextStats.dropped.messages,
        dropped_chars: contextStats.dropped.chars,
        released: counters.retainedMessages === 0 && counters.activeRuns === 0,
      },
    };
    const extra = { model, workspace: workspaceReceipt, events, run: runFacts };

    // A truncated, capped or aborted run is not a verdict. Only a clean stop can be a judgement.
    if (timedOut || controller.signal.aborted || outcome.stopReason === 'aborted') {
      return envelope({ tool, exit: EXIT_ABORTED, route: 'loop', code: timedOut ? 'timeout' : 'aborted', error: `the run did not complete (${timedOut ? 'timeout' : 'aborted'})`, extra });
    }
    if (outcome.stopReason === 'max-tokens') {
      return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'max_tokens', error: 'the run ran out of tokens, so its answer is truncated and is not a judgement', extra });
    }
    if (outcome.stopReason === 'max-steps') {
      return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'max_steps', error: `the run did not settle within ${Math.floor(steps)} model turns, so it was stopped and its answer is not a judgement`, extra });
    }
    if (outcome.stopReason === 'repeated-tool-failure') {
      /* NOT `max_steps`, and the difference is the whole point of the bound: this run stopped
       * because it was repeating one failed call, not because it ran out of turns. A caller that
       * reads the two as one thing cannot tell a bad prompt from a model that is stuck. */
      return envelope({
        tool,
        exit: EXIT_FAILED,
        route: 'loop',
        code: 'repeated_tool_failure',
        error:
          `the run kept calling the same tool with the same arguments after that call had already failed identically, ` +
          `so it was stopped after ${runFacts.turns} turn(s) and ${runFacts.tool_calls} tool call(s). Its answer is not a judgement`,
        extra,
      });
    }
    if (outcome.stopReason !== 'stop') {
      return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'run_failed', error: `the run did not complete: stopReason=${outcome.stopReason}${last?.diagnostic ? ` (${last.diagnostic})` : ''}`, extra });
    }
    if (output.trim() === '') {
      return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'run_failed', error: 'the run stopped without answering, so there is no judgement to return', extra });
    }
    if (outputSchema !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'schema_violation', error: 'output_schema was requested and the run did not answer with JSON, so there is no validated judgement', extra });
      }
      if (!isPlainObject(parsed)) {
        return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'schema_violation', error: 'output_schema was requested and the run answered with JSON that is not an object', extra });
      }
      const missing = (Array.isArray(outputSchema.required) ? outputSchema.required : []).filter((key) => !(key in parsed));
      if (missing.length > 0) {
        return envelope({ tool, exit: EXIT_FAILED, route: 'loop', code: 'schema_violation', error: `the run's answer is missing required properties: ${missing.join(', ')}`, extra });
      }
      base.structured = parsed;
    }

    return envelope({ tool, exit: EXIT_OK, route: 'loop', result: base, extra });
  }

  /**
   * Execute one registered tool through the registry, and answer in the same envelope.
   *
   * The reference's `tool <tool-name>` command. It exists so a caller gets the *classification* —
   * the same codes, for the same reasons — rather than having to interpret a
   * `ToolExecutionResult` itself.
   */
  async function runTool(args, exec) {
    const tool = TOOL_TOOL;
    const name = typeof args?.tool === 'string' ? args.tool.trim() : '';
    if (!name) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'missing_tool_name', error: 'tool is required: name the tool to execute' });
    }
    if (SELF_NAMES.includes(name)) {
      return envelope({
        tool,
        exit: EXIT_INVALID,
        route: 'none',
        code: 'recursive_dispatch_refused',
        error: `"${name}" cannot be dispatched through ${TOOL_TOOL}: it would re-enter this component or a reserved transport name`,
      });
    }
    const toolArgs = args?.arguments === undefined ? {} : args.arguments;
    if (!isPlainObject(toolArgs) || !jsonSafe(toolArgs)) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_arguments', error: 'arguments must be a JSON object whose values survive a JSON round trip' });
    }
    const budget = args?.timeout_ms === undefined ? timeoutMs : args.timeout_ms;
    if (!(Number.isFinite(budget) && budget > 0)) {
      return envelope({ tool, exit: EXIT_INVALID, route: 'none', code: 'invalid_timeout', error: 'timeout_ms must be a positive finite number when present' });
    }

    const view = serviceView();
    if (!isFn(view.tools?.execute)) {
      const capability = capabilityOf(profileFor(view), 'tool.dispatch');
      return envelope({ tool, exit: EXIT_UNAVAILABLE, route: 'none', code: String(capability?.code ?? 'tool_dispatch_unavailable'), error: `no tool can be dispatched: ${capability?.reason ?? 'the tools registry is not reachable'}` });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budget);
    const callerSignal = exec?.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal && isFn(callerSignal.addEventListener)) callerSignal.addEventListener('abort', onCallerAbort, { once: true });

    counters.dispatches += 1;
    try {
      // The documented `ToolExecutionInput`. `callId` is a branded string at the type level and
      // an ordinary string at runtime — `dsh-tools/lib/index.js:3134` reads it with no validation
      // or brand check — while `signal` is required and `arguments` must be losslessly
      // JSON-serializable (line 3163).
      //
      // `agent` is passed when the call came from a conversation AND that conversation presents
      // its tools natively: the registry reads it — `createExecution` takes `const agent =
      // exec.agent` and resolves visibility with `this.get(name, agent)`, and the same agent
      // carries that conversation's guards and sandbox policy into the dispatch. It is deliberately
      // NOT passed for a `ptc` conversation, where `resolveExecution` collapses every direct call
      // but `run_code` and the dispatch would answer `UNKNOWN_TOOL` for tools the catalog lists;
      // `dispatchScope` is where that decision lives and why. A route-driven call has no Agent and
      // keeps the process-wide view.
      const call = callScope(view, exec?.agent);
      const reach = dispatchScope(call);
      const outcome = await view.tools.execute({
        callId: `agent-api:${counters.dispatches}:${Date.now().toString(36)}`,
        name,
        arguments: toolArgs,
        signal: controller.signal,
        ...(reach === undefined ? {} : { agent: reach }),
      });
      const classified = classifyToolResult(name, outcome);
      if (classified.exit === EXIT_OK) {
        return envelope({ tool, exit: EXIT_OK, route: 'direct', result: { dispatched: name, value: classified.result } });
      }
      const aborted = classified.exit === EXIT_ABORTED;
      return envelope({ tool, exit: classified.exit, route: 'direct', code: aborted && timedOut ? 'timeout' : classified.code, error: classified.error });
    } catch (error) {
      const aborted = timedOut || controller.signal.aborted || error?.name === 'AbortError';
      return envelope({
        tool,
        exit: aborted ? EXIT_ABORTED : EXIT_FAILED,
        route: 'direct',
        code: aborted ? (timedOut ? 'timeout' : 'aborted') : 'dispatch_threw',
        error: error?.message ?? String(error),
      });
    } finally {
      clearTimeout(timer);
      if (callerSignal && isFn(callerSignal.removeEventListener)) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    name: 'agent-api',
    rootDir: root,
    counters,
    /**
     * The counter block as a detached snapshot.
     *
     * `counters` is a live object, which is what the read tools report and what a caller wants;
     * this is the same numbers taken at one instant, for a check that has to compare an in-flight
     * reading with a settled one. Without it, an observer that captured `counters` early would be
     * holding the very object the run then mutates, and "it was non-zero during the run" and "it
     * was zero after" would both be readings of the same final state.
     */
    counterSnapshot: () => ({ ...counters }),
    /**
     * A fresh temporary conversation, with this component's configured bound.
     *
     * Exposed so the bound is testable as a rule rather than only through a run: a run pushes one
     * prompt, so `dropped_messages` is always 0 on the run path and a check written there would
     * pass whether or not eviction worked. This is not a second way to run anything — it is a
     * message array — and nothing in this file uses it except a caller that wants to inspect the
     * bound.
     */
    conversation: () => createConversation(),
    workspaceDir: defaultWorkspace,
    profileFor,
    modelView,
    stateEnvelope,
    runToolNames,
    buildRunTools,
    callScope,
    dispatchScope,

    /** The four model-facing tools, bundled with this component. */
    tools() {
      const lifecycle = LIFECYCLE;
      const isolation = RUN_ISOLATION;
      return [
        {
          name: TOOL_STATE,
          description:
            'Read this host back as JSON and answer without executing anything: the host profile, the capability table, the authorised model, the workspace, and the tool catalog as names and a count. No model request, no tool execution, no write — this is the read half, and it is the call to make before planning a run. ' +
            'Input: {} — no parameters at all. Output: the envelope with `result = { component, root, platform, workspace, engine, catalog: { count, names }, scope, presentation, runTools, counters: { reads, dispatches, runs, modelCalls, toolCalls } }` and `profile = { kind, platform, lifecycle, engine, model: { ok, source, provider, model, code }, capabilities: [{ id, kind, state, code?, evidence, reason }] }`. ' +
            'WHICH CATALOG YOU GET depends on how you were called, and `scope` says which answered: `"conversation"` when the call arrived through one — the list is then that conversation\'s own tool exposure, its preset\'s tools plus this package\'s plus whatever else it registers, and `presentation` is what that conversation\'s model is shown (`native`, or `ptc` where direct calls collapse to the reserved `run_code`) — and `"process"` for any other route, where the list is the process-wide layer: the PTC transport, this package\'s tools, and the tools other plugins register globally. ' +
            "`state` is `available`, `unavailable` or `refused`; `refused` means the member exists and this component declines to expose it, and the reason says why. Worked example: `agent_api_state {}` -> `{ ok: true, tool: 'agent_api_state', route: 'direct', exit: 0, class: 'ok', result: { platform: 'win32', engine: 'own-loop', catalog: { count: 34 }, counters: { reads: 0, dispatches: 0, runs: 0, modelCalls: 0, toolCalls: 0 } }, profile: { kind: 'dsh-plugin', model: { ok: true, provider: 'deepseek', model: 'deepseek-chat' }, capabilities: [ … ] } }`. " +
            `Always answers with exit 0. ${lifecycle}`,
          parameters: { type: 'object', properties: {}, required: [] },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },
          async execute(args, exec) {
            counters.reads += 1;
            return stateEnvelope(exec?.agent);
          },
        },
        {
          name: TOOL_CATALOG,
          description:
            'List the tools this caller can actually reach, with their descriptions and parameter schemas. A read: it projects the registry, executes nothing and calls no model. This is the reference `tool --list`, and it is a separate call from `agent_api_state` for the same reason the reference separates them — `state` names the tools, this returns their definitions, so the cheap call stays cheap. ' +
            'Input: { detail?: "names"|"full" (default "names"), limit?: number 1-200 (default 50), offset?: number >= 0 (default 0) }. Output: the envelope with `result = { detail, total, offset, returned, truncated, tools: [{ name, description?, parameters? }] }`; `truncated` is true exactly when `offset + returned < total`, so a bounded answer never looks like a complete one. ' +
            'Worked example: `agent_api_catalog { detail: "names", limit: 2 }` -> `{ ok: true, exit: 0, result: { detail: "names", total: 34, offset: 0, returned: 2, truncated: true, tools: [{ name: "read" }, { name: "pwsh" }] } }`. ' +
            `Exit 3 with code catalog_unavailable when the tools registry is not reachable from this scope. ${lifecycle}`,
          parameters: {
            type: 'object',
            properties: {
              detail: { type: 'string', enum: ['names', 'full'], description: 'How much of each definition to return. "names" returns name only; "full" adds description and parameters.' },
              limit: { type: 'number', description: 'Page size, 1-200, default 50. The result says whether it was truncated.' },
              offset: { type: 'number', description: 'Zero-based index of the first tool to return. Default 0.' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },
          async execute(args, exec) {
            counters.reads += 1;
            const view = serviceView();
            if (!isFn(view.tools?.schemas)) {
              const capability = capabilityOf(profileFor(view), 'catalog.read');
              return envelope({ tool: TOOL_CATALOG, exit: EXIT_UNAVAILABLE, route: 'none', code: String(capability?.code ?? 'catalog_unavailable'), error: `the tool catalog cannot be read: ${capability?.reason ?? 'the tools registry is not reachable'}` });
            }
            const detail = args?.detail === 'full' ? 'full' : 'names';
            const limit = Number.isFinite(args?.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), 200) : 50;
            const offset = Number.isFinite(args?.offset) ? Math.max(Math.floor(args.offset), 0) : 0;
            // The CALLING agent's view, so "the tools this caller can actually reach" is true of
            // the caller and not of this component: the registry chains the scope's own layer over
            // the global one, which is how a preset's tools appear. No agent — a route, another
            // component in process — is the process-wide layer, and `scope` says which one answered.
            const call = callScope(view, exec?.agent);
            const schemas = view.tools.schemas(call.scope);
            const all = Array.isArray(schemas) ? schemas : [];
            const page = all.slice(offset, offset + limit);
            const tools = page.map((entry) =>
              detail === 'full'
                ? { name: String(entry?.name ?? ''), description: String(entry?.description ?? ''), parameters: entry?.parameters ?? { type: 'object' } }
                : { name: String(entry?.name ?? '') },
            );
            return envelope({
              tool: TOOL_CATALOG,
              exit: EXIT_OK,
              route: 'direct',
              result: { detail, scope: call.target, presentation: call.presentation, total: all.length, offset, returned: tools.length, truncated: offset + tools.length < all.length, tools },
            });
          },
        },
        {
          name: TOOL_TOOL,
          description:
            'Execute one reachable tool through the DSH registry and answer in this bundle\'s standardised envelope, so a caller gets the same error classification the Newmark CLI gives rather than a raw execution result. This is the reference `tool <tool-name> [json-args]` command. A run: the tool really executes, through pre-policy, guards and post-policy. ' +
            'Input: { tool: string (REQUIRED, the exact registered name), arguments?: object (default {}, must survive a JSON round trip), timeout_ms?: number (positive, default 120000) }. Output: the envelope with `result = { dispatched, value }` on success. ' +
            "Worked example: `agent_api_tool { tool: 'read', arguments: { path: 'README.md' } }` -> `{ ok: true, tool: 'agent_api_tool', route: 'direct', exit: 0, class: 'ok', result: { dispatched: 'read', value: { … } } }`. " +
            'This tool is a thin wrapper for callers that want the classified envelope; a model that just wants to use a tool should call that tool itself. ' +
            'WHICH TOOLS IT CAN REACH follows the same rule as the catalog: a call arriving through a conversation is resolved for THAT conversation (`scope: "conversation"`) — the preset\'s tools, this package\'s, and whatever else that conversation registers — while a call arriving any other way, with no conversation, is resolved for the process (`scope: "process"`): the PTC transport, this package\'s tools, and the tools other plugins register globally. ' +
            'One exception, stated because it would otherwise look like a missing tool: a conversation presenting its tools in `ptc` mode collapses direct calls — the registry admits only the reserved `run_code` — so such a call keeps the process-wide view and the answer names the presentation in `presentation`. ' +
            'Exit 2 for a missing or unusable `tool` name, non-object `arguments`, a bad `timeout_ms`, or a name that is not reachable — including this component\'s own four names, which are refused with code recursive_dispatch_refused because dispatching them would re-enter this component. Exit 3 when the registry itself is unreachable, with code tool_dispatch_unavailable. Exit 4 for a tool that ran and failed, carrying the tool\'s own message. Exit 130 when the caller aborts or the timeout fires. ' +
            `The classification does not decide whether your call was a good idea — read the tool\'s own description first. ${lifecycle}`,
          parameters: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'The exact registered name of the tool to execute. Use agent_api_catalog to list what is reachable.' },
              arguments: { type: 'object', description: 'The tool arguments as a JSON object. Defaults to {}. Must be losslessly JSON-serializable, because the registry snapshots and freezes it.' },
              timeout_ms: { type: 'number', description: 'Abort the dispatch after this many milliseconds. Default 120000.' },
            },
            required: ['tool'],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },
          async execute(args, exec) {
            return runTool(args, exec);
          },
        },
        {
          name: TOOL_SEND,
          description:
            'Have one prompt judged by an agent run driven by this component\'s own loop, and answer with the standardised envelope. This is the reference `send <prompt>` command, and it is the call MemoryLab\'s tag judgement uses to obtain an answer. ' +
            'It needs no DSH Agent and no session: a run works identically from a tool call and from anywhere a tool can be called, which is the only way this component may be invoked. ' +
            `What a run is not: ${isolation} ` +
            `THE TOOL SET, AND WHAT WIDENING IT MEANS. By default a run is given the memory tools and nothing else — a judge reading a memory graph needs those, and nothing else it is likely to want. \`tools: { allow: ['${ALL_TOOLS_TOKEN}'] }\` WIDENS that to every tool the run's \`tool_scope\` exposes: the calling conversation's own exposure when it came from one, otherwise the process-wide layer (the PTC transport, this package's tools, and the tools other plugins register globally). The receipt names both halves — \`tool_scope\` for whose exposure the list is, and \`tool_reach\` for the layer its calls were resolved in; they differ only for a \`ptc\` conversation, whose direct calls collapse to \`run_code\` and whose run therefore executes in the process-wide layer. What the widening does not buy: a run is not a DSH agent session, so it writes no session log, appears in no conversation and no subagent catalogue, and is not auditable through DSH's machinery. Where the reach is the calling conversation, that conversation's guards and sandbox policy do apply to the calls; where it is the process, none of them does. Choose it deliberately, for a caller you would trust to run those tools itself. Whatever the set, this component's own four tools and the reserved run_code transport are subtracted from it always, and a run may never write to the shared Newmark store except through the memory tools. ` +
            'Input: { prompt: string (REQUIRED), output_schema?: object with type "object" (the run must then answer with JSON matching it, or the call fails), workspace?: string (absolute; default <newmarkRoot>/Work, created if absent), timeout_ms?: number (default 120000), max_steps?: number (model turns before the run is stopped, default 8), tools?: { allow?: string[], deny?: string[] } (also accepted under its older name tool_filter; without allow the run is given the memory tools and nothing else; allow must not be empty, and allow: ["' + ALL_TOOLS_TOKEN + '"] means every tool DSH exposes), require_workspace?: boolean (default false) }. ' +
            'Output on success: `result = { output, structured, provider, model, turns, tool_calls, usage, elapsed_ms, stop_reason, model_verified, workspace, tool_names, context }`, where `context` reports the temporary conversation this run held — `{ max_messages, max_chars, messages, chars, dropped_messages, dropped_chars, released }`. The history is in memory for the length of the call and released when it ends, on every path; it is never a session, is never logged, and does not survive the call. `turns` and `tool_calls` are THIS run\'s figures. ' +
            'Every answer also carries `events` — the run\'s own event list, bounded in both count and characters, where each `tool_execution_start` and `tool_execution_end` names the tool, the call id, the turn, the arguments the model emitted and either the tool\'s result or the failure\'s message and code. That is what makes a receipt able to say WHY a run looped rather than only that it did. ' +
            'WHEN A TOOL FAILS. The failure is handed back to the model as a tool result carrying the tool\'s own message (a memory tool\'s `{ ok: false, error: { … } }` is read into its message and code, never into `[object Object]`), and the run\'s model is expected to change approach or answer about it. A run that calls the same tool with the same arguments and gets the same failure repeatedly is not making progress: after two identical failures the third identical call is NOT executed, the model is told so, and it is given a turn to answer. A run that answers ends normally — exit 0 with an honest answer about the failure. A run that keeps calling the refused tool ends as exit 4 `repeated_tool_failure`, which is reported as its own code rather than as `max_steps`. Tool-call arguments that are not valid JSON become a legible tool result for the same reason, rather than a dead run. ' +
            'Worked example: `agent_api_send { prompt: "Answer with JSON: {\\"verdict\\":\\"ok\\"}", output_schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } }` -> `{ ok: true, tool: "agent_api_send", route: "loop", exit: 0, class: "ok", result: { output: "{\\"verdict\\":\\"ok\\"}", structured: { verdict: "ok" }, turns: 1, stop_reason: "stop", workspace: { enforced: true }, context: { messages: 1, released: true } }, model: { ok: true, provider: "deepseek", model: "deepseek-chat" } }`. ' +
            'A non-zero exit is never a verdict. Exit 3 means NOTHING WAS ATTEMPTED: model_not_selected (nothing is authorised yet — this component refuses rather than defaulting, because a default is a model the user did not authorise), model_unavailable (a model was authorised and the provider no longer lists it), core_service_absent, core_model_accessor_absent, llm_unavailable, tools_unavailable, workspace_unavailable. Exit 4 means a run happened and did not deliver: run_failed, schema_violation, max_tokens, max_steps, repeated_tool_failure. Exit 130 means aborted or timed out. Treat a 3 and a 4 differently: a 3 must be reported as "no judgement was made", a 4 may be retried. Every exit-4 answer carries `run: { turns, tool_calls, stop_reason, recovered_turns }`, because a failure carries no `result` and a caller that wants to know how far the run got has nowhere else to read it. ' +
            `Runs are bounded and always return. ${lifecycle}`,
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'The task to have judged. Required and must be non-empty.' },
              output_schema: { type: 'object', description: "A JSON Schema with type: 'object'. When present the run must answer with JSON matching it, or the call fails with exit 4 schema_violation." },
              workspace: { type: 'string', description: 'Absolute working directory for the run. Default <newmarkRoot>/Work, created if absent.' },
              timeout_ms: { type: 'number', description: 'Abort the run after this many milliseconds. Default 120000.' },
              max_steps: { type: 'number', description: 'Model turns before the run is stopped and reported as max_steps. Default 8.' },
              tools: {
                type: 'object',
                description:
                  'Choose the tools the run may use: { allow?: string[], deny?: string[] }. Without allow, the run is given the memory_lab_* tools and nothing else — a judge needs no filesystem. ' +
                  `allow: ['${ALL_TOOLS_TOKEN}'] widens it to EVERY tool the run's \`tool_scope\` exposes — the calling conversation's own exposure, or the process-wide layer when there is none — and the receipt reports \`tool_scope\` and \`tool_reach\` so the two are never conflated. Where the reach is the calling conversation, that conversation's guards and sandbox policy apply to the calls; where it is the process, none of them does. Widening is a deliberate choice, not a convenience.`,
              },
              tool_filter: { type: 'object', description: 'The older name for `tools`; identical rule and identical consequences. `tools` wins when both are present.' },
              require_workspace: { type: 'boolean', description: 'Refuse when the run cannot be shown to work in `workspace`.' },
            },
            required: ['prompt'],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },
          async execute(args, exec) {
            counters.runs += 1;
            return runSend(args, exec);
          },
        },
      ];
    },
  };
}
