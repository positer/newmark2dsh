/**
 * The one adapter between this package's call sites and the host tool registry.
 *
 * DSH 0.2.2 changed `tools.execute` from ONE call
 * (`{ callId, name, arguments, signal }`, returning a `ToolExecutionResult`)
 * to a raw BATCH
 * (`{ calls: [{ type: 'tool-call', id, name, arguments }], signal }`, returning
 * `{ results: [{ callId, result }], additionalContexts, concluded }`).
 *
 * Every host-side dispatch in this package used the old single-call shape, so on
 * 0.2.2 the registry rejected the input and the whole batch failed with
 * `Tool batch execution failed` before the tool ever ran — which is exactly how
 * NewMate's `agent_api_send` died at 87 ms with `turns: 0`.
 *
 * The result is unwrapped back to the single `ToolExecutionResult` the callers
 * already classify, so only the transport shape changes here.
 *
 * @param tools the registry (`ctx.tools`, or a captured `view.tools`)
 * @param call one call: `{ callId, name, arguments, signal, agent? }`
 * @returns the call's `ToolExecutionResult` (`{ isError, value, content, error }`)
 */
export function executeOne(tools, call) {
  const { callId, name, signal, agent } = call;
  const args = call.arguments ?? {};
  const block = { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) };
  const input = { calls: [block], signal, ...(agent === undefined ? {} : { agent }) };
  return Promise.resolve(tools.execute(input)).then((batch) => {
    const first = batch && Array.isArray(batch.results) ? batch.results[0] : undefined;
    if (!first) throw new Error(`tool batch returned no result for "${name}"`);
    return first.result;
  });
}
