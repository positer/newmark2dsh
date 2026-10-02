/**
 * Newmark Core — **the DSH model seam**, and the message translation across it.
 *
 * The reference loop takes its model as a function (`config.streamFn`) precisely so the
 * transport is not part of the loop. This module is that function for DSH: it turns the
 * loop's transport-free messages into one `GenerateOptions`, drives `ctx.llm.stream`, and
 * turns the `StreamChunk` union back into one assistant message.
 *
 * ## The contract, read from the published types rather than guessed
 *
 * `@deepseek-ai/dsh-llm/lib/typert.host.js`:
 *
 *   `GenerateOptions` (line 313) — `{ provider, model, reasoningEffort?, messages, system?,
 *   tools?, toolHistory?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }`
 *   `llm.stream(options): AsyncIterable<StreamChunk>` — the service's streaming call
 *   `StreamChunk` — `block-start | text-delta | reasoning-delta | tool-call-delta | block-end
 *   | usage | finish`
 *   `FinishReason` — `{kind:'stop'} | {kind:'tool-calls'} | {kind:'max-tokens'} |
 *   {kind:'aborted', failure} | {kind:'error', failure}`
 *   `RequestMessage = Message | RequestUserInput`, and `RequestUserInput` (line 465) is
 *   `{ role: 'user', content }` with **no `id` and no `source`** — the only request shape that
 *   needs nothing minted, which is why the prompt crosses as one of those.
 *   `MessageBase` (line 401) — `{ id, content, source }`, so an assistant turn needs an `id`
 *   and a `source: { kind: 'model', provider, model }`, and a tool result needs
 *   `source: { kind: 'tool', callId }`.
 *
 * ## Where the model and the credentials come from
 *
 * `ctx.agentDefaultModel.currentSelection()` — the user's own configured default
 * (`dsh-agent-default-model/lib/index.js:38`), returning `{ provider, model,
 * reasoningEffort? }`. The credentials and the endpoint belong to the llm service's adapter
 * for that provider, so this component configures nothing and holds no key: it names the
 * model the user already chose and hands the call to the service that already knows how to
 * make it. An explicit override is possible through this component's own config, which is
 * useful for pointing the judging runs at a cheaper model without touching the default.
 *
 * ## What this seam does NOT do, and the run inherits
 *
 * `ctx.llm.stream` is the provider call and nothing above it. A run driven through this seam
 * therefore has **no DSH session log, no `tools/pre-execute` guards, no approval policy and
 * no sandbox decision** — those live in the agent loop and the session, which this component
 * does not use. That is the trade the user chose, and it is stated in the tool descriptions
 * because a caller has to know it to judge what a run's output is worth.
 */

/** Which chunk types carry something this loop reads. Kept as data so the gate can assert the set. */
export const CONSUMED_CHUNK_TYPES = ['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'];

/** The finish kinds this seam maps, and the loop stop reason each becomes. */
export const FINISH_TO_STOP = {
  stop: 'stop',
  'tool-calls': 'tool-calls',
  'max-tokens': 'max-tokens',
  aborted: 'aborted',
  error: 'error',
};

/** A `MessageId` for a message this component mints. Branded at the type level, a string at runtime. */
let messageCounter = 0;
function messageId() {
  messageCounter += 1;
  return `agent-api-msg-${messageCounter}`;
}

/** The system prompt a judging run gets. Short on purpose: it is a judge, not an assistant. */
export const JUDGE_SYSTEM_PROMPT = [
  'You are a bounded judging run invoked through the Newmark agent-api interface.',
  'Answer the request you are given and nothing else. You may call the tools you have been',
  'given when the request needs evidence, and then answer. Do not ask clarifying questions:',
  'there is no user attached to this run, so a question cannot be answered.',
].join(' ');

/**
 * Translate one loop message into a DSH request message.
 *
 * Three shapes, and each is the smallest one the published types accept rather than the
 * richest one they allow: `RequestUserInput` for a user turn because it needs no `id` and no
 * `source`, and `MessageBase`'s `id`/`source` only where the type does not let us omit them.
 */
export function toRequestMessage(message, model) {
  if (message.role === 'toolResult') {
    return {
      id: messageId(),
      role: 'tool',
      content: message.content,
      source: { kind: 'tool', callId: message.toolCallId },
      toolCallId: message.toolCallId,
      ...(message.isError === true ? { isError: true } : {}),
    };
  }
  if (message.role === 'assistant') {
    return {
      id: messageId(),
      role: 'assistant',
      content: message.content,
      source: { kind: 'model', provider: String(model?.provider ?? ''), model: String(model?.model ?? '') },
    };
  }
  return { role: 'user', content: message.content };
}

/** The whole loop context, as the request's message list. */
export function toRequestMessages(messages, model) {
  return (messages || []).map((message) => toRequestMessage(message, model));
}

/**
 * A tool call's arguments, as the object the tool registry requires.
 *
 * **This is where the seam and the registry disagreed, and it was a real failure, not a
 * formality.** DSH hands a `tool-call` block its arguments as JSON *text*: a real
 * `block-end` for a call to `probe { value: 'abc' }` carries `typeof block.arguments ===
 * 'string'` with the value `'{"value": "abc"}'`. The `tool-call-delta` path is text by
 * construction, since it accumulates `argumentsDelta`.
 *
 * `components/agent-api/component.js`'s run-tool wrapper hands that value straight to
 * `ctx.tools.execute({ …, arguments: args })`, and the registry requires an OBJECT there: it
 * refuses a string with `INVALID_ARGS`, "invalid arguments: \"arguments\" must be an object".
 * The visible consequence was every tool call in every run failing, the model retrying the
 * same call, and the run dying at `max_steps` with an empty answer — a tool chain that looked
 * wired up and could never once have worked.
 *
 * The translation belongs here because this module is the seam: it is the only place that
 * knows DSH's wire shape and the loop's `call.arguments` contract at the same time.
 *
 * ## WHERE IT IS APPLIED, which is the other half of the same fact
 *
 * It is applied **at the tool boundary** (`component.js` sets `prepareArguments` on every tool
 * it offers a run), and deliberately NOT to the block the loop keeps in its history — because
 * the same block is sent back to the provider on the next turn, and THERE DSH's published type
 * is `ToolCallBlock.arguments: string`. The DeepSeek Messages adapter reads it with
 * `JSON.parse(raw)` (`dsh-llm-deepseek/lib/index.js`, `toolInput`); given an object that parse
 * fails and the argument set is silently replaced with `{}`, so a model would be shown its own
 * previous call as having had no arguments at all. Normalising in place destroyed the echo;
 * normalising at the boundary does not, and `arguments` stays the text the type declares.
 *
 * Text that is not a JSON object is reported as `{}` rather than thrown: an empty argument
 * set reaches the tool, the tool's own validation answers with its own message, and that
 * message is a better failure than a seam that dies before the tool is ever asked. That is the
 * LENIENT reading. `toolCallArgumentsChecked` below is the same parse with the failure KEPT,
 * which is what a run needs when the provider itself emitted unusable JSON — see its own note.
 */
export function toolCallArguments(raw) {
  return toolCallArgumentsChecked(raw).value;
}

/**
 * The same parse, answering with what went wrong instead of erasing it.
 *
 * WHY THE FAILURE HAS TO SURVIVE. The DeepSeek Messages adapter validates the tool-call
 * arguments the provider streamed, at `message_stop`, and throws
 * `DeepSeek Messages stream: tool input is invalid JSON (MALFORMED_RESPONSE)`
 * (`dsh-llm-deepseek/lib/index.js:1983-1992`). That is a real, measured outcome of a run whose
 * model degenerated after several failed tool calls. Two things follow, and both are this
 * function's business:
 *
 *   1. a call whose arguments cannot be parsed must reach the model as a LEGIBLE tool result —
 *      "your call's arguments were not valid JSON, here is an excerpt, re-issue it" — rather
 *      than as a run that dies with a transport error;
 *   2. `ok` distinguishes "there were no arguments" (an empty object, or valid `null`) from
 *      "the arguments were not readable", so the component never silently calls a tool with
 *      `{}` because the text was garbage.
 *
 * Valid JSON that is simply not an object (`null`, a number, an array) keeps the LENIENT
 * reading: `{ ok: true, value: {} }`. That is deliberate — it is what this seam did before, and
 * narrowing it to an error would turn a working no-argument call into a failure.
 */
export function toolCallArgumentsChecked(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: {}, reason: '' };
  if (typeof raw === 'object') {
    return Array.isArray(raw) ? { ok: true, value: {}, reason: '' } : { ok: true, value: raw, reason: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, value: {}, reason: `the arguments were a ${typeof raw}, not the JSON text a tool call carries` };
  }
  const text = raw.trim();
  if (text === '') return { ok: true, value: {}, reason: '' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      value: {},
      reason: `the tool call's arguments were not valid JSON (${error?.message ?? 'parse failed'}): ${excerpt(text)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, value: {}, reason: '' };
  return { ok: true, value: parsed, reason: '' };
}

/** A bounded, single-line excerpt of text a model may have to act on. */
export function excerpt(text, limit = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…(+${flat.length - limit} chars)` : flat;
}

/**
 * A stable key for one tool call: the tool's name and its arguments, canonicalised.
 *
 * Canonicalisation is the point, and it is why this lives beside `toolCallArguments` rather than
 * in the loop: the SAME call can be spelled `'{"component":"X"}'` and `'{"component": "X"}'`,
 * and a retry bound that treated those as different calls would not bound anything. `arguments`
 * is text on the wire and an object at the registry, so both spellings are normalised through
 * the same parse before they are compared.
 */
export function toolCallKey(call) {
  const name = String(call?.name ?? '');
  let value;
  try {
    value = stableJson(toolCallArguments(call?.arguments));
  } catch {
    return `${name}\u0000<unreadable>`;
  }
  return `${name}\u0000${value}`;
}

/** JSON with object keys in a fixed order, so two equal values have one spelling. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/**
 * Read one stream to its end and answer with the assistant message it built.
 *
 * The `block-end` chunks are authoritative: `block-end` carries `{ index, block }`, a
 * complete `ContentBlock`, so an assistant turn's content is assembled from those rather than
 * from the deltas. The deltas are still accumulated, because a `tool-call` block that arrives
 * only as `tool-call-delta` chunks would otherwise be lost, and losing a tool call silently
 * turns a run that needed evidence into a run that answered without it.
 *
 * THE BLOCKS ARE KEPT AS THEY ARRIVED, and that is a fix rather than an omission. They used to
 * be normalised here — the arguments turned into an object for the registry — and the same
 * object was then pushed into the loop's history and sent back to the provider on the next
 * turn, where DSH's `ToolCallBlock.arguments` is a STRING and the DeepSeek adapter reads it
 * with `JSON.parse`. The model was therefore shown every one of its own earlier calls with no
 * arguments. The registry gets its object at the tool boundary now (`prepareArguments`), and
 * the durable block keeps the shape the published type declares.
 *
 * ## A stream that fails AFTER it delivered content
 *
 * `for await` over an adapter that throws loses every chunk already pulled — and the DeepSeek
 * Messages adapter throws at `message_stop`, after all `block-end` chunks have been yielded, to
 * report tool arguments the provider streamed as invalid JSON
 * (`dsh-llm-deepseek/lib/index.js:1983-1992`). Reading that as "the turn produced nothing"
 * turned a completed completion into `run_failed` with a transport error. So the throw is held
 * rather than propagated, and then:
 *
 *   - **nothing usable arrived** (no block-end, no recovered call) — rethrow, and the run fails
 *     honestly with the provider's own message;
 *   - **an abort** — rethrow, so cancellation stays cancellation;
 *   - **a tool call did arrive** — the turn continues with `stopReason: 'tool-calls'`. The
 *     arguments are whatever text arrived, and the tool boundary's checked parse turns unusable
 *     JSON into a legible tool result for the model. The turn's text, if any, is partial; the
 *     answer that matters comes from a later, complete turn, which is why this is safe.
 */
export async function collectAssistant(stream, model, onPartial, options = {}) {
  const blocks = [];
  const toolCalls = new Map();
  let usage;
  let finish;
  let streamError = null;
  try {
    for await (const chunk of stream) {
      switch (chunk?.type) {
        case 'block-end':
          if (Number.isInteger(chunk.index)) blocks[chunk.index] = chunk.block;
          break;
        case 'tool-call-delta': {
          const current = toolCalls.get(chunk.id) || { type: 'tool-call', id: chunk.id, name: chunk.name ?? '', arguments: '' };
          if (chunk.name) current.name = chunk.name;
          current.arguments += chunk.argumentsDelta ?? '';
          toolCalls.set(chunk.id, current);
          break;
        }
        case 'usage':
          usage = chunk.usage;
          break;
        case 'finish':
          finish = chunk.reason;
          break;
        default:
          break;
      }
      if (typeof onPartial === 'function') onPartial(chunk);
    }
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    streamError = error;
  }

  const content = blocks.filter(Boolean);
  if (content.length === 0 && toolCalls.size > 0) {
    // No completed blocks arrived, so the deltas are all there is. Recovered rather than
    // dropped: the alternative is a run that quietly stops calling tools. The recovered
    // arguments are text by construction — the shape the block keeps.
    content.push(...toolCalls.values());
  }

  if (streamError !== null) {
    const calls = content.filter((block) => block?.type === 'tool-call');
    if (calls.length === 0) throw streamError;
    return {
      role: 'assistant',
      content,
      usage,
      stopReason: 'tool-calls',
      diagnostic: `the model stream failed after delivering ${calls.length} tool call(s); the turn was kept so the failure reaches the model as a tool result: ${failureText({ message: streamError?.message ?? String(streamError), code: streamError?.code })}`,
      failureCode: String(streamError?.code ?? ''),
      recoveredFrom: 'stream-failed-after-content',
      model,
      timestamp: Date.now(),
    };
  }

  const kind = String(finish?.kind ?? 'stop');
  const stopReason = FINISH_TO_STOP[kind] ?? 'error';
  return {
    role: 'assistant',
    content,
    usage,
    stopReason,
    diagnostic: failureText(finish?.failure),
    failureCode: finish?.failure ? String(finish.failure.code ?? '') : '',
    model,
    timestamp: Date.now(),
  };
}

/**
 * The whole failure chain a finish reason carries, as one line.
 *
 * The adapter wraps transport faults, so the sentence that says what actually went wrong is
 * in `cause`, not in `message`. Reporting only the wrapper is how a run comes back as
 * "DeepSeek Messages transport failed" with four words of cause and no way to act on them —
 * which is exactly what happened the first time this seam met a real provider.
 */
export function failureText(failure) {
  if (!failure) return '';
  const parts = [];
  let current = failure;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
    const code = current.code !== undefined ? ` (${current.code})` : '';
    const message = current.message ?? (typeof current === 'string' ? current : '');
    if (message || code) parts.push(`${message}${code}`);
    current = current.cause;
  }
  return parts.join('  <-  ');
}

/**
 * Build the loop's `streamFn` on top of a DSH `llm` service.
 *
 * @param llm - `ctx.llm`, or `undefined` when the service is not reachable. The returned
 *   function answers with a single `error` event in that case rather than throwing, so a
 *   missing service becomes a classified run failure instead of an exception out of a tool.
 * @param selection - `{ provider, model, reasoningEffort? }`, already resolved.
 * @param options.maxTokens - an optional cap on the run's own completions.
 */
export function createLlmStreamFn(llm, selection, options = {}) {
  return async function streamFn(_model, request, ctx = {}) {
    const provider = String(selection?.provider ?? '');
    const model = String(selection?.model ?? '');
    const fail = (message, code) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'error',
          error: assistantMessageWithError(_model ?? { provider, model }, message, code),
        };
      },
    });

    if (provider === '' || model === '') {
      return fail('no model is selected: ctx.agentDefaultModel named no provider and no model', 'NO_MODEL_SELECTED');
    }
    if (typeof llm?.stream !== 'function') {
      return fail('the llm service is not reachable from this scope, so no model call can be made', 'LLM_UNAVAILABLE');
    }

    const generate = {
      provider,
      model,
      messages: toRequestMessages(request.messages, { provider, model }),
      ...(request.systemPrompt ? { system: String(request.systemPrompt) } : {}),
      ...(Array.isArray(request.tools) && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      ...(Number.isFinite(options.maxTokens) ? { maxTokens: options.maxTokens } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };

    let stream;
    try {
      stream = llm.stream(generate);
    } catch (error) {
      return fail(`the llm service refused the call: ${error?.message ?? error}`, 'LLM_CALL_FAILED');
    }

    return {
      async *[Symbol.asyncIterator]() {
        try {
          const message = await collectAssistant(stream, { provider, model }, undefined, { signal: ctx.signal });
          // The loop's seam contract: a finished turn is a `done` event, a failed one is an
          // `error` event carrying the same assistant-message shape. Both are yielded rather
          // than thrown, so a provider failure becomes a classified run failure instead of an
          // exception escaping a tool.
          if (message.stopReason === 'error' || message.stopReason === 'aborted') yield { type: 'error', error: message };
          else yield { type: 'done', message };
        } catch (error) {
          yield {
            type: 'error',
            error: assistantMessageWithError({ provider, model }, `the model stream failed: ${error?.message ?? error}`, 'LLM_STREAM_FAILED'),
          };
        }
      },
    };
  };
}

function assistantMessageWithError(model, message, code) {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    diagnostic: String(message),
    failureCode: String(code),
    model,
    timestamp: Date.now(),
  };
}
