/**
 * Newmark Core — the **agent loop**, ported from Newmark's own agent kernel.
 *
 * ## Where this came from
 *
 * `DESKTOP/src/core/agentKernel/agent-loop.ts` (314 lines) — the lightest of Newmark's three
 * kernel files, and the only one small enough to be worth porting. `agentKernelRunner.ts`
 * (127 KB) and `conversationKernel.ts` (140 KB) were not read and are not represented here:
 * they are the desktop application's conversation machinery, and this component needs a
 * judgement, not a conversation.
 *
 * What was ported is the **structure and the contract**, not the file: the two entries, the
 * cycle, and the two seams. What was dropped is everything that exists only because Newmark
 * is an interactive desktop application. Everything dropped is named below, with the reason,
 * because a silent omission from a ported loop is how a loop quietly stops looping.
 *
 * ## Kept — the shape, which is the point
 *
 *   `runAgentLoop(prompts, config, signal)`      the fresh-run entry
 *   `runAgentLoopContinue(config, signal)`       the continue entry
 *   `runLoop(context, newMessages, config, …)`   the cycle: an outer follow-up loop and an
 *                                                inner tool-call loop
 *   `streamAssistantResponse(context, …)`        THE MODEL SEAM
 *   `executeToolCalls(toolCalls, context, …)`    THE TOOL SEAM
 *   `MutableContext = { systemPrompt?, messages, tools? }`
 *   `emit(config, event)`                        the event sink
 *   `throwIfAborted` / `AbortError`              cancellation that a caller can recognise
 *   `toolResult(call, content, isError, …)`      the tool-result normaliser
 *   `hasMoreToolCalls = terminatedByTool ? false : toolResults.length > 0`
 *   the concurrency-safe batching in `executeToolCalls`
 *
 * The two seams are the whole reason to port anything: `streamFn` and `tool.execute` are
 * injectable, so the loop can be driven end to end by a test with no model and no tokens.
 * That is what the gate does.
 *
 * ## Dropped — and why
 *
 * 1. **Steering and follow-up queues** (`getSteeringMessages`, `closeSteeringMessages`,
 *    `closeFollowUpMessages`, `reopenMessageQueues`, `shouldStopAfterTurn`). This is the
 *    interactive half of the reference: a person typing into a running turn. A judgement run
 *    has no user attached and no second turn to steer, so the reference's outer loop and its
 *    `pendingMessages` plumbing reduce to nothing. **Consequence to be aware of: this loop
 *    runs exactly one user prompt and then tool turns until the model stops calling tools.**
 * 2. **`config.resolveTools` per-turn re-resolution.** The reference re-reads the tool list
 *    every turn because Newmark's tool set changes while a conversation runs. Here the set is
 *    resolved once from the caller's restriction and cannot change mid-run — which is also
 *    what makes the restriction trustworthy.
 * 3. **`config.transformContext` / `replacementMessages`** — context compression. It exists
 *    to keep a long conversation inside a window; a judgement run is bounded by `maxSteps`
 *    instead, which is simpler and fails rather than silently rewriting its own history.
 * 4. **Newmark's message algebra** (`AgentMessage`, `AssistantMessage`, `ImageContent`,
 *    token `cost` accounting, `api`/`provider`/`model` stamping). DSH owns its own message
 *    types and its adapter stamps its own metadata; re-declaring them here would be a second
 *    vocabulary for the same thing.
 * 5. **`NEWMARK_PROVIDER_DIAGNOSTICS`.** A desktop debugging aid, wired to `console.error`.
 * 6. **`config.toolExecution === 'serial'` fallback path is kept**, and the parallel path is
 *    kept too — but the *default* here is serial, because a judging run makes few tool calls
 *    and a deterministic order is worth more than the overlap.
 *
 * ## Added — one thing the reference does not have, and needs
 *
 * `config.maxSteps`. The reference's inner loop is bounded only by the model eventually
 * stopping. A component that runs without a user watching must not be, so the loop counts
 * model turns and stops at the cap with `stopReason: 'max-steps'` — reported as a failure,
 * never as a judgement.
 */

/** The error a cancelled run throws, named so a caller's `AbortError` check works. */
function abortError() {
  const error = new Error('Agent run aborted');
  error.name = 'AbortError';
  return error;
}

/** The reference's `throwIfAborted`, kept whole — including its preference for the signal's own reason. */
export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw abortError();
}

/** The reference's `assistantMessage`, cut down to what this loop and its seam actually read. */
export function assistantMessage(model) {
  return { role: 'assistant', content: [], stopReason: 'stop', model, timestamp: Date.now() };
}

/**
 * Normalise one tool result — the reference's `toolResult`, with Newmark's image handling
 * dropped because nothing this loop can offer returns an image.
 */
export function toolResult(call, content, isError, details, terminate) {
  const mergedDetails = terminate
    ? { ...(details && typeof details === 'object' ? details : {}), terminate }
    : details;
  const normalized = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: normalized,
    details: mergedDetails,
    isError,
    timestamp: Date.now(),
  };
}

/** The reference's `emit`, kept as a function so a caller can pass a straight no-op. */
async function emit(config, event) {
  if (typeof config.emit !== 'function') return;
  await config.emit(event);
}

/** The classification a thrown tool error carries, in a shape that survives a JSON round trip. */
function failureDetails(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : '',
    exit: Number.isFinite(error?.exit) ? error.exit : null,
  };
}

/**
 * How many times ONE call (same tool, same canonical arguments) may fail the SAME way before the
 * loop stops executing it. See `runLoop` for what reaching it does; the number is the point at
 * which "the model is trying again" has stopped being a plausible description.
 */
export const DEFAULT_REPEAT_LIMIT = 2;

/** The text of a tool result, for the failure signature. Bounded: it is compared, not shown. */
function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
  return text.length > 400 ? text.slice(0, 400) : text;
}

/** A call's identity for the repeat bound: its name and its arguments, canonically spelled. */
function defaultCallKey(call) {
  const name = String(call?.name ?? '');
  const raw = call?.arguments;
  if (typeof raw === 'string') return `${name}\u0000${raw.trim()}`;
  try {
    return `${name}\u0000${JSON.stringify(raw ?? null)}`;
  } catch {
    return `${name}\u0000<unreadable>`;
  }
}

/** `2` -> `2nd`. One line, and it is read by a model. */
function ordinal(count) {
  const suffix = count % 100 >= 11 && count % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][count % 10] || 'th';
  return `${count}${suffix}`;
}

function shorten(text, limit = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…(+${flat.length - limit} chars)` : flat;
}

/**
 * What the model is told when a call it has already repeated is refused, and what it is told on
 * the turn where the loop stops.
 *
 * These sentences are the whole settling mechanism's visible half: a model that is told a tool
 * failed should change approach or report the failure, and a model that is told *nothing it can
 * act on* has nothing to change. Both name the tool, the count and the last failure, so the
 * answer the run finally gives can be an honest one.
 */
function repeatNotice(call, count) {
  return (
    `\n\n[agent-api] This is the ${ordinal(count)} time this exact call (${call.name}, same arguments) has failed the same way. ` +
    `It will not succeed as written. Change the arguments or the approach, or answer with what you have and say plainly that ${call.name} failed. ` +
    `A ${ordinal(count + 1)} identical attempt will not be executed.`
  );
}

function refusedNotice(call, count, lastError) {
  return (
    `[agent-api] This call was NOT executed. ${call.name} with these arguments has already failed the same way ${count} times ` +
    `(last failure: ${shorten(lastError)}), so this ${ordinal(count + 1)} identical attempt was refused rather than repeated. ` +
    `Answer now with what you have, and state plainly that ${call.name} failed.`
  );
}

const STOPPED_NOTICE =
  '[agent-api] Not executed: this exact call had already been refused for repeating an identical failure, and it was issued again. ' +
  'The run is stopping here, and its answer is reported as not having settled.';

/**
 * THE MODEL SEAM, driven per turn. The reference's `streamAssistantResponse`.
 *
 * `config.streamFn(model, { systemPrompt, messages, tools }, { signal })` answers with an
 * async iterable of events, exactly as the reference's does:
 *   `{ type: 'done', message }`   the finished assistant message
 *   `{ type: 'error', error }`    a failure, shaped as an assistant message
 *   `{ partial }`                 a partial assistant message
 *
 * The seam is a function on the config and not an import, which is what makes the loop
 * testable with no model, no credentials and no tokens.
 */
export async function streamAssistantResponse(context, config, signal) {
  throwIfAborted(signal);
  const stream = await config.streamFn(
    config.state.model,
    { systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools },
    { signal },
  );
  let final = null;
  let current = assistantMessage(config.state.model);
  for await (const event of stream) {
    throwIfAborted(signal);
    if (event.type === 'done') {
      final = event.message;
      current = final;
    } else if (event.type === 'error') {
      final = event.error;
      current = final;
    } else if ('partial' in event) {
      current = event.partial;
    }
  }
  return final || current;
}

/**
 * THE TOOL SEAM. The reference's `executeToolCalls`, including its concurrency grading: a
 * tool is only overlapped with its siblings when it declares `concurrencySafe === true`, and
 * everything else forms a serial barrier. The reference's comment states the reason better
 * than a paraphrase would: a blind `Promise.all` over side-effecting tools is a race.
 *
 * An unknown tool is a result, not a throw, so one bad name cannot end a run.
 *
 * ## WHAT AN EVENT CARRIES, and why it carries it
 *
 * `tool_execution_start` and `tool_execution_end` used to be emitted with a `toolCallId` and a
 * `toolName` that the component's event log then threw away, keeping `{ type, turn }` and
 * nothing else. A receipt could therefore show that a run had looped and could not show WHY —
 * which is the only thing a reader of that receipt needs. Both events now carry the payload:
 * the start carries the arguments as the model emitted them, and the end carries `isError`
 * plus either the tool's own content or the failure's message and code. The BOUND is applied by
 * the component, which owns the envelope (`EVENT_*` there); these are the raw facts.
 *
 * The `turn` on a tool event is the turn whose assistant message requested the call — previously
 * absent, so a tool event could not be placed in the run at all.
 *
 * ## AND WHAT A FAILED CALL DOES TO THE LOOP
 *
 * Nothing here decides that. A failed call is a result with `isError: true`; the loop's own
 * repeat bound (`DEFAULT_REPEAT_LIMIT`, applied in `runLoop`) is what stops a model from
 * spending the whole budget repeating it.
 */
export async function executeToolCalls(toolCalls, context, config, signal, turn = null) {
  const tools = context.tools || [];
  const executeOne = async (call) => {
    throwIfAborted(signal);
    await emit(config, {
      type: 'tool_execution_start',
      turn,
      toolCallId: call.id,
      toolName: call.name,
      // As the model emitted it: JSON text on the wire, an object when a caller prepared one.
      // The registry's own object is derived from this by `prepareArguments`, and a mismatch
      // between the two is exactly what a reader of a looping run needs to be able to see.
      arguments: call.arguments,
    });
    try {
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) {
        const text = `Tool "${call.name}" not found`;
        await emit(config, {
          type: 'tool_execution_end',
          turn,
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          error: { message: text, code: 'unknown_tool', exit: null },
        });
        return toolResult(call, text, true, { code: 'unknown_tool' });
      }
      // INSIDE the try, deliberately. `prepareArguments` is where a call whose arguments are not
      // the JSON text the wire carries becomes a legible failure (`toolCallArgumentsChecked`);
      // called outside, that throw would escape `executeToolCalls` and end the RUN — the opposite
      // of what a malformed argument set should do, because it is the model that has to be told.
      const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
      const result = await tool.execute(call.id, args, signal, { workspace: config.workspace });
      throwIfAborted(signal);
      const message = toolResult(call, result.content, false, result.details, result.terminate);
      await emit(config, {
        type: 'tool_execution_end',
        turn,
        toolCallId: call.id,
        toolName: call.name,
        isError: false,
        result: { content: result.content, details: result.details, terminate: result.terminate },
      });
      return message;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const details = failureDetails(error);
      const message = toolResult(call, text, true, details);
      await emit(config, {
        type: 'tool_execution_end',
        turn,
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        error: { message: text, ...details },
      });
      return message;
    }
  };

  if (config.toolExecution === 'parallel') {
    const results = [];
    let index = 0;
    while (index < toolCalls.length) {
      const tool = tools.find((candidate) => candidate.name === toolCalls[index].name);
      if (tool && tool.concurrencySafe === true) {
        const batch = [];
        while (index < toolCalls.length) {
          const candidate = toolCalls[index];
          const candidateTool = tools.find((t) => t.name === candidate.name);
          if (!candidateTool || candidateTool.concurrencySafe !== true) break;
          batch.push(candidate);
          index += 1;
        }
        results.push(...(await Promise.all(batch.map((call) => executeOne(call)))));
      } else {
        results.push(await executeOne(toolCalls[index]));
        index += 1;
      }
    }
    return results;
  }

  const results = [];
  for (const call of toolCalls) results.push(await executeOne(call));
  return results;
}

/**
 * The cycle. The reference's `runLoop`, with the steering machinery removed, a step cap added,
 * and — the part that is not in the reference because the reference has a user attached — a
 * bound on REPEATING A FAILED CALL.
 *
 * ## Why a step cap is not enough, measured
 *
 * On the running 0.2.11 bundle a run whose model called `memory_lab_read` for a component that
 * does not exist called that same tool on EVERY turn of its budget and ended at `max_steps`
 * (6 turns in the user's round, 3 of 3 in this component's own re-measurement). The failure DID
 * reach the model — as a `tool` message with `isError: true` — and its whole text was
 * `[object Object]`, because the MemoryLab tools report `{ ok: false, error: { … } }` and the
 * classifier stringified the object. The model was handed a tool failure that told it nothing,
 * so it had nothing to adapt to, and the budget was what ended the run.
 *
 * Both halves of that are fixed where they belong (`describeFailure` in `lib/contract.js`, and
 * the argument echo in `lib/llm-seam.js`). This is the third half, and it holds even when a
 * model is simply determined: **a run that calls the same tool with the same arguments and gets
 * the same failure repeatedly is not making progress, and burning the budget on it is worse
 * than stopping and saying so.**
 *
 * ## What the bound does, in order
 *
 *   1. the FIRST identical failure is an ordinary tool result;
 *   2. when the SAME call fails the SAME way a `repeatLimit`-th time, its result carries an
 *      explicit directive: it will not succeed as written, change approach or answer;
 *   3. the next identical call is **not executed at all**. It gets a result that says it was
 *      refused, why, and what the last failure was, and the model is asked to answer;
 *   4. a turn that answers with prose ends the run normally — `stop`, a real answer about the
 *      failure, which is a PASS;
 *   5. a turn that calls only already-refused calls ends the run with
 *      `stopReason: 'repeated-tool-failure'` — a distinct, honest report, NOT `max-steps`.
 *
 * A genuinely different call is never refused, so "change approach" stays available, and the
 * tally is keyed on the tool, the canonical arguments AND the failure text: a failure that
 * CHANGES is progress and resets the count.
 */
async function runLoop(context, newMessages, config, signal) {
  let turns = 0;
  const maxSteps = Number.isFinite(config.maxSteps) && config.maxSteps > 0 ? Math.floor(config.maxSteps) : 8;
  const repeatLimit =
    Number.isFinite(config.repeatLimit) && config.repeatLimit > 0 ? Math.floor(config.repeatLimit) : DEFAULT_REPEAT_LIMIT;
  const callKey = typeof config.callKey === 'function' ? config.callKey : defaultCallKey;
  const failures = new Map();
  let refusedLastTurn = false;
  while (true) {
    throwIfAborted(signal);
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls) {
      throwIfAborted(signal);
      if (turns >= maxSteps) {
        // The added bound. A judging run that will not stop is a run that will not return,
        // and there is no user here to interrupt it.
        newMessages.push({ role: 'assistant', content: [], stopReason: 'max-steps', timestamp: Date.now() });
        await emit(config, { type: 'agent_end', messages: newMessages, stopReason: 'max-steps' });
        return { stopReason: 'max-steps', messages: newMessages };
      }
      turns += 1;
      await emit(config, { type: 'turn_start', turn: turns });

      const assistant = await streamAssistantResponse(context, config, signal);
      context.messages.push(assistant);
      newMessages.push(assistant);

      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
        await emit(config, { type: 'turn_end', message: assistant, toolResults: [] });
        await emit(config, { type: 'agent_end', messages: newMessages, stopReason: assistant.stopReason });
        return { stopReason: assistant.stopReason, messages: newMessages };
      }

      const toolCalls = (assistant.content || []).filter((block) => block.type === 'tool-call');
      const keyed = toolCalls.map((call) => ({ call, key: String(callKey(call)) }));

      /* 5 — the point of no return. After a refusal the model was asked to answer; a turn that
       * calls nothing but already-refused calls is not an answer, and one more turn would only
       * buy another identical attempt. The calls still get results, because a `tool-call` block
       * without a matching `toolResult` is a history the provider refuses. */
      if (refusedLastTurn && keyed.length > 0 && keyed.every((entry) => (failures.get(entry.key)?.count ?? 0) >= repeatLimit)) {
        const results = keyed.map((entry) => toolResult(entry.call, STOPPED_NOTICE, true, { repeated: true, refused: true }));
        for (const result of results) {
          context.messages.push(result);
          newMessages.push(result);
        }
        await emit(config, { type: 'turn_end', message: assistant, toolResults: results });
        await emit(config, { type: 'agent_end', messages: newMessages, stopReason: 'repeated-tool-failure' });
        return { stopReason: 'repeated-tool-failure', messages: newMessages };
      }

      let results = [];
      let refusedThisTurn = 0;
      if (keyed.length > 0) {
        const runnable = [];
        for (const entry of keyed) {
          const tally = failures.get(entry.key);
          if (tally && tally.count >= repeatLimit) entry.refused = tally;
          else runnable.push(entry.call);
        }
        const executed = runnable.length > 0 ? await executeToolCalls(runnable, context, config, signal, turns) : [];
        const byId = new Map(executed.map((result) => [result.toolCallId, result]));
        const merged = [];
        for (const entry of keyed) {
          if (!entry.refused) {
            // `?? …` rather than a bare lookup: two calls sharing one id would collapse in the map,
            // and an `undefined` pushed into the history is a message the provider rejects — a
            // history that cannot be sent is worse than a result that says the result is missing.
            merged.push(byId.get(entry.call.id) ?? toolResult(entry.call, 'the tool returned no result for this call', true, { code: 'no_result' }));
            continue;
          }
          /* 3 — refused, not executed, and told why. `tool_execution_end` is emitted here too, so
           * a receipt shows the refusal in the run rather than as a call that vanished. */
          refusedThisTurn += 1;
          const text = refusedNotice(entry.call, entry.refused.count, entry.refused.error);
          await emit(config, {
            type: 'tool_execution_end',
            turn: turns,
            toolCallId: entry.call.id,
            toolName: entry.call.name,
            isError: true,
            refused: true,
            error: { message: text, code: 'repeated_tool_failure', exit: null },
          });
          merged.push(toolResult(entry.call, text, true, { repeated: true, refused: true, count: entry.refused.count }));
        }

        /* The tally, and 2 — the directive on the failure that reaches the limit. A failure whose
         * TEXT changed is a different failure: the model did something, so the count starts over.
         * `repeatLimit` is where the notice appears, and about that the code is exact: the number
         * of times the call may still be EXECUTED is `repeatLimit - 1` after the notice. */
        results = merged.map((result, index) => {
          const entry = keyed[index];
          if (!result || result.isError !== true || entry.refused) return result;
          const error = resultText(result);
          const previous = failures.get(entry.key);
          const count = previous && previous.error === error ? previous.count + 1 : 1;
          failures.set(entry.key, { error, count });
          if (count < repeatLimit) return result;
          return toolResult(entry.call, `${error}${repeatNotice(entry.call, count)}`, true, { ...(result.details ?? {}), repeated: count });
        });
      }

      const terminatedByTool = results.some(
        (result) => result?.role === 'toolResult' && result.details && typeof result.details === 'object' && result.details.terminate === true,
      );
      hasMoreToolCalls = terminatedByTool ? false : results.length > 0;
      for (const result of results) {
        context.messages.push(result);
        newMessages.push(result);
      }
      refusedLastTurn = refusedThisTurn > 0;
      await emit(config, { type: 'turn_end', message: assistant, toolResults: results });
      if (!hasMoreToolCalls) {
        await emit(config, { type: 'agent_end', messages: newMessages, stopReason: assistant.stopReason });
        return { stopReason: assistant.stopReason, messages: newMessages };
      }
    }
    break;
  }
  await emit(config, { type: 'agent_end', messages: newMessages });
  return { stopReason: 'stop', messages: newMessages };
}

/** The fresh-run entry. The reference's `runAgentLoop`. */
export async function runAgentLoop(prompts, config, signal) {
  throwIfAborted(signal);
  const newMessages = [];
  const context = {
    systemPrompt: config.state.systemPrompt,
    messages: (config.state.messages || []).slice(),
    tools: (config.state.tools || []).slice(),
  };
  await emit(config, { type: 'agent_start' });
  for (const prompt of prompts) {
    throwIfAborted(signal);
    context.messages.push(prompt);
    newMessages.push(prompt);
  }
  return runLoop(context, newMessages, config, signal);
}

/** The continue entry. The reference's `runAgentLoopContinue`, with its two guards kept. */
export async function runAgentLoopContinue(config, signal) {
  const newMessages = [];
  const context = {
    systemPrompt: config.state.systemPrompt,
    messages: (config.state.messages || []).slice(),
    tools: (config.state.tools || []).slice(),
  };
  if (context.messages.length === 0) throw new Error('Cannot continue: no messages in context');
  if (context.messages[context.messages.length - 1].role === 'assistant') {
    throw new Error('Cannot continue from message role: assistant');
  }
  await emit(config, { type: 'agent_start' });
  return runLoop(context, newMessages, config, signal);
}
