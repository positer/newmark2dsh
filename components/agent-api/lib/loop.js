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
 */
export async function executeToolCalls(toolCalls, context, config, signal) {
  const tools = context.tools || [];
  const executeOne = async (call) => {
    throwIfAborted(signal);
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) return toolResult(call, `Tool "${call.name}" not found`, true);
    const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
    await emit(config, { type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args });
    try {
      const result = await tool.execute(call.id, args, signal, { workspace: config.workspace });
      throwIfAborted(signal);
      const message = toolResult(call, result.content, false, result.details, result.terminate);
      await emit(config, {
        type: 'tool_execution_end',
        toolCallId: call.id,
        toolName: call.name,
        result: { content: result.content, details: result.details, terminate: result.terminate },
        isError: false,
      });
      return message;
    } catch (error) {
      const message = toolResult(call, error instanceof Error ? error.message : String(error), true);
      await emit(config, { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: message.content }, isError: true });
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

/** The cycle. The reference's `runLoop`, with the steering machinery removed and a step cap added. */
async function runLoop(context, newMessages, config, signal) {
  let turns = 0;
  const maxSteps = Number.isFinite(config.maxSteps) && config.maxSteps > 0 ? Math.floor(config.maxSteps) : 8;
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
      const results = toolCalls.length ? await executeToolCalls(toolCalls, context, config, signal) : [];
      const terminatedByTool = results.some(
        (result) => result.role === 'toolResult' && result.details && typeof result.details === 'object' && result.details.terminate === true,
      );
      hasMoreToolCalls = terminatedByTool ? false : results.length > 0;
      for (const result of results) {
        context.messages.push(result);
        newMessages.push(result);
      }
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
