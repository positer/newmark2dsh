/**
 * Is agent-api mounted? — the authoritative presence predicate, readable by a caller.
 *
 * ## Why this file exists, and why it is the whole answer to "what does disabled mean"
 *
 * A component that has been switched off **cannot report its own absence**. Switching a
 * composed component off disposes its fiber, and disposing the fiber disposes every
 * `ctx.tools.register` effect it held — so the tools are gone, and there is no code left
 * running that could answer "I am off". A caller that only learns about the switch by
 * *calling* agent-api learns it from a materialised `UNKNOWN_TOOL` error, which is
 * indistinguishable from a typo in a tool name and arrives one layer too late.
 *
 * So the predicate is not a method on the component. It is a pure function over the
 * **tools registry**, which outlives the component and is already injected by every
 * component in this bundle (`inject = ['tools', 'webServer']`). Presence of the tool IS
 * the switch, exactly as presence of the page global is the switch on the Client half —
 * the same rule the bundle already uses for `__NEWMARK_MEMORYLAB__` and
 * `__NEWMARK_COMPUTERUSE__`, moved to the Host side where the Host-side caller can see it.
 *
 * It lives inside `components/agent-api/` rather than in the core because it is part of
 * THIS component's published contract, and it must keep working when this component is
 * unmounted — which it does, because importing a module is not injecting a service.
 * MemoryLab resolving this path is not the components injecting each other's services;
 * it is one component reading another's declared identity.
 *
 * ## The three answers, which must never be conflated
 *
 *   agent_api_disabled  (exit 3) — mounted: false. No judgement was attempted. Nothing ran.
 *   agent_unreachable   (exit 3) — mounted: true, but no Agent is reachable from the call
 *                                  site, so no judgement could be attempted.
 *   run_failed          (exit 4) — mounted: true, an Agent was reachable, the run ran and
 *                                  failed. A judgement was attempted and did not arrive.
 *
 * `active: false` therefore means "do not attempt a judgement", never "the judgement said
 * no". A caller that treats the two as the same thing reports success while having judged
 * nothing, which is the failure this predicate exists to prevent.
 */

/** The component key the core row's `COMPONENTS` map and the config panel use. */
export const AGENT_API_COMPONENT = 'agentApi';

/** The module `name` this component's `index.js` exports. */
export const AGENT_API_PLUGIN = 'newmark-agentapi';

/** The page global this component publishes. Absent on the page means the component is off. */
export const AGENT_API_GLOBAL = '__NEWMARK_AGENTAPI__';

/**
 * The tool whose registration is the presence signal.
 *
 * `agent_api_send` is the run half, so a caller that finds it registered has found the
 * capability it actually wants; a read-only tool would be a weaker signal. The other
 * three are listed for completeness and for callers that want to check the whole surface.
 */
export const AGENT_API_PRESENCE_TOOL = 'agent_api_send';

/** Every tool this component registers, in the order `component.js` registers them. */
export const AGENT_API_TOOLS = ['agent_api_state', 'agent_api_catalog', 'agent_api_tool', 'agent_api_send'];

/** The exit code that carries "no judgement was made", from the shared contract table. */
export const AGENT_API_DISABLED_EXIT = 3;

/** The machine-readable code a caller should report when the component is off. */
export const AGENT_API_DISABLED_CODE = 'agent_api_disabled';

/**
 * Read this component's presence from the tools registry.
 *
 * @param tools - the `tools` service (`ctx.tools`). Tolerated as `undefined`, because a
 *   scope that cannot even see the registry must get an answer rather than a throw.
 * @returns `{ id, active, tool, mounted, registered, reason }`. `active === true` means a
 *   call to `agent_api_send` is meaningful. When it is false, `reason` says why and the
 *   caller must answer exit 3 / `agent_api_disabled` without attempting the call.
 */
export function agentApiPresence(tools) {
  const id = AGENT_API_COMPONENT;
  if (tools === undefined || tools === null) {
    return {
      id,
      active: false,
      mounted: false,
      registered: [],
      tool: AGENT_API_PRESENCE_TOOL,
      reason: 'the tools registry is not reachable from this scope, so agent-api presence cannot be read',
    };
  }
  if (typeof tools.get !== 'function') {
    return {
      id,
      active: false,
      mounted: false,
      registered: [],
      tool: AGENT_API_PRESENCE_TOOL,
      reason: 'the object handed to agentApiPresence has no get(name) method, so it is not a tools registry',
    };
  }
  const registered = AGENT_API_TOOLS.filter((name) => tools.get(name) !== undefined);
  const active = registered.includes(AGENT_API_PRESENCE_TOOL);
  return {
    id,
    active,
    mounted: active,
    registered,
    tool: AGENT_API_PRESENCE_TOOL,
    reason: active
      ? 'agent_api_send is registered: the component is mounted and a judgement may be attempted'
      : registered.length > 0
        ? `the component is partly mounted: ${registered.join(', ')} registered but ${AGENT_API_PRESENCE_TOOL} is not`
        : 'agent_api_send is not registered: the component is switched off, or it failed to compose',
  };
}

/**
 * The answer a caller returns when `active` is false.
 *
 * Shaped as the shared envelope so a caller does not have to invent one, and so the
 * "switched off" answer is byte-comparable with the answers the component itself gives.
 */
export function agentApiDisabledEnvelope(presence) {
  return {
    ok: false,
    tool: AGENT_API_PRESENCE_TOOL,
    route: 'none',
    exit: AGENT_API_DISABLED_EXIT,
    class: 'unavailable',
    error: `agent-api is not mounted: ${presence?.reason ?? 'no presence was read'}`,
    code: AGENT_API_DISABLED_CODE,
  };
}
