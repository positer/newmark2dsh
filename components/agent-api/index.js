/**
 * Newmark Core — the **agent-api component row**.
 *
 * The component key is `agentApi`; this module is what the core row mounts with
 * `ctx.plugin()`, from `components/agent-api/index.js`, exactly like the other two
 * components. It is not a Loader row of its own: the bundle declares one row, and the
 * components are composed by it.
 *
 * **The contract this component publishes — the envelope, the exit codes, the four tools,
 * the failure modes, the lifecycle statement and the workspace limit — is documented in full
 * at the top of `component.js`.** Read that first; this file only wires it to Cordis.
 *
 * ## What it publishes
 *
 * - `window.__NEWMARK_AGENTAPI__` — the host profile and the workspace, injected into the
 *   page the shell already serves. **Its presence is the switch**, the same rule the other
 *   two components follow: switching this component off disposes its fiber, which retires
 *   the page global, the route and all four tools together.
 * - `GET /newmark-agentapi/state` — the same state envelope over the bundle's own web
 *   carrier. Read only: any other method answers 405, and the refusal names the reason.
 * - The four tools, through `ctx.tools.register`.
 * - `components/agent-api/lib/presence.js`, importable by another component whether or not
 *   this one is mounted. That is how "switched off" stays observable to a caller.
 *
 * ## What it injects, and the one service it deliberately does not
 *
 * `tools` and `webServer` are injected, like the other two components.
 *
 * `subagents` is **not** injected. It is read optionally through `ctx.get('subagents')`,
 * because a hard dependency would be worse than useless here: this bundle's components are
 * independent by construction (see the core row's note on why siblings cannot share a
 * service), so a component that sat at `waiting for service` in a profile without
 * `@deepseek-ai/dsh-subagent` would never activate at all — and the capability it was waiting
 * for is one this component is designed to report as unavailable rather than require. With
 * the optional read, a profile without subagents still gets `agent_api_state`,
 * `agent_api_catalog` and `agent_api_tool`, and `agent_api_send` answers exit 3 with
 * `subagent_service_absent`, which is the honest answer.
 *
 * `llm` is not injected either, and that is a refusal rather than an omission: a raw provider
 * completion is not an agent run, and the capability table says so in those words.
 */
import { createAgentApi, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_MESSAGES } from './component.js';
import { schema } from './lib/schema.js';
import { resolveRoot } from './lib/root.js';
import { embedJson } from './lib/embed.js';
import { withComputerUseCaller } from '../../lib/cu-caller.js';

/**
 * The page global this component publishes. Absent on the page means the component is off.
 *
 * Spelled HERE as a literal, the way every other part of this bundle spells its own global
 * (`__NEWMARK_CORE__`, `__NEWMARK_MEMORYLAB__`, `__NEWMARK_COMPUTERUSE__`), rather than
 * re-exported from `lib/presence.js` where the same string also lives. The two are one constant
 * and the gate asserts they agree; what the literal buys is that each row's global can be read
 * off its entry file, which is what the bundle's own gates and the Client half both look for.
 */
export const SNAPSHOT_GLOBAL = '__NEWMARK_AGENTAPI__';

/**
 * The route this component serves its read-only state on.
 *
 * A route and not only a page injection, because the point of this component is to be
 * callable: an external in-process caller can read the host profile without a model request,
 * which is exactly what the reference's `state` command is for. It is a route on the
 * `webServer` service the bundle already owns — no new server, no new port — and it lives and
 * dies with this component's fiber, so its presence means what the page global's presence
 * means.
 *
 * The RUN half is deliberately not served here. A run spends the user's provider credentials
 * and model budget; a loopback route is reachable by any local process and cannot identify a
 * caller, while the tool channel is where the registry's pre-policy applies. The refusal is
 * recorded as `http.run` in `probeCapabilities`, and it is a refusal rather than an
 * impossibility: the loop behind it is the same one the tools call.
 */
export const STATE_ROUTE = '/newmark-agentapi/state';

export const name = 'newmark-agentapi';

/**
 * `tools` and `webServer` are hard dependencies: without them this component can do nothing at
 * all and should not be mounted.
 *
 * `llm` and the core row's service are deliberately **not** in this list. They are read with
 * `ctx.get(...)`, the documented optional form, so a profile that has not yet provided the core
 * service — or one without an llm service — still gets a mounted component that answers
 * `agent_api_state`, `agent_api_catalog` and `agent_api_tool`, and reports the missing piece as
 * an unavailable capability with its own code. A hard dependency would instead leave this
 * component at `waiting for service` for ever, which is a worse answer than an honest one.
 */
export const inject = ['tools', 'webServer'];

/**
 * The name of the service the core row provides, which carries the shared root and the
 * authorised model. Held as a constant AND as a config field so the wiring is a line: whatever
 * the core row calls it, this string is the only thing that changes.
 */
export const DEFAULT_CORE_SERVICE = 'newmarkComponents';

export const Config = schema
  ? schema.object({
      root: schema
        .string()
        .description("The shared Newmark user root. Empty means Newmark's own path, ~/.Newmark.")
        .default(''),
      workspace: schema
        .string()
        .description('The working directory a run works in. Empty means <root>/Work.')
        .default(''),
      coreService: schema
        .string()
        .description('The name of the core row service that carries the root and the authorised model.')
        .default(DEFAULT_CORE_SERVICE),
      timeoutMs: schema
        .natural()
        .description('How long a run or a dispatch may take before it is aborted, in milliseconds.')
        .default(120000),
      maxSteps: schema
        .natural()
        .description('Model turns a run may take before it is stopped and reported as max_steps.')
        .default(8),
      contextMaxMessages: schema
        .natural()
        .description(
          'The temporary conversation\u2019s bound, in messages. The history lives in memory for the ' +
            'length of one run, is never a session, and is released when the run ends. Oldest messages ' +
            'are evicted first and the drop is reported; the prompt is never evicted.',
        )
        .default(48),
      contextMaxChars: schema
        .natural()
        .description(
          'The temporary conversation\u2019s bound, in characters. Reaching it evicts oldest-first, ' +
            'counting what went; it does not summarise and does not page to disk.',
        )
        .default(262144),
    })
  : undefined;

export function apply(ctx, config) {
  const root = resolveRoot(config);
  const timeoutMs =
    Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? Math.floor(config.timeoutMs) : 120000;
  const maxSteps = Number.isFinite(config?.maxSteps) && config.maxSteps > 0 ? Math.floor(config.maxSteps) : 8;
  // The temporary conversation's bounds, read the same way as the other two numbers: a value the
  // schema would not have produced is discarded rather than clamped, so the effective bound is
  // always one the config page could have shown.
  const contextMaxMessages =
    Number.isFinite(config?.contextMaxMessages) && config.contextMaxMessages > 1
      ? Math.floor(config.contextMaxMessages)
      : DEFAULT_CONTEXT_MAX_MESSAGES;
  const contextMaxChars =
    Number.isFinite(config?.contextMaxChars) && config.contextMaxChars > 0
      ? Math.floor(config.contextMaxChars)
      : DEFAULT_CONTEXT_MAX_CHARS;
  const coreService =
    typeof config?.coreService === 'string' && config.coreService.trim() ? config.coreService.trim() : DEFAULT_CORE_SERVICE;

  const optional = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);

  const api = createAgentApi({
    root,
    workspace: typeof config?.workspace === 'string' ? config.workspace : '',
    timeoutMs,
    maxSteps,
    contextMaxMessages,
    contextMaxChars,
    logger: ctx.logger,
    // A function, not a snapshot. A service can appear or disappear while this component is
    // mounted, and a profile read once at apply() time would keep reporting a capability the
    // host no longer has.
    services: () => ({
      tools: ctx.tools,
      webServer: ctx.webServer,
      llm: optional('llm'),
      core: optional(coreService),
    }),
  });

  const definitions = api.tools();
  for (const definition of definitions) {
    const execute = definition.execute;
    definition.execute = (args, execution) => withComputerUseCaller(execution, () => execute(args, execution));
    ctx.effect(() => ctx.tools.register(definition), `newmark-agentapi-tool-${definition.name}`);
  }

  /**
   * THE TOOL-ONLY CONSTRAINT, enforced by structure rather than by convention.
   *
   * The user's rule: this component may be invoked **only by tools**. No route, no page global,
   * nothing else in the plugin. So the run half is reachable from the tool definitions below and
   * from nothing else in this file — and that is arranged, not merely intended:
   *
   *   1. `api` (which carries `runSend`) is captured in this closure and handed ONLY to
   *      `api.tools()`. That is the whole of the run's reachability: `api.tools()` is called once,
   *      its definitions go to `ctx.tools.register`, and the registered `execute` functions are
   *      the only things that call into a run.
   *   2. The route handler below is a closure over `api.stateEnvelope` and nothing else. It has no
   *      name for `runSend`, for `api.tools()`, or for any tool's `execute` — so an edit that
   *      wanted a route-triggered run would have to add the reference, which is a visible change
   *      rather than a call that happens to be in scope.
   *   3. `stateEnvelope()` is a read: it projects the registry and reads service references. It
   *      cannot start a run, so even the reference the route DOES hold is inert for that purpose.
   *
   * The gate asserts all three from outside: that no HTTP method produces a run (the POST refusal
   * is checked, and the counters are asserted not to move across the route), and that the route
   * closure holds no run-capable name. That is the difference between this being true and this
   * being a paragraph.
   *
   * The refusal below is the outward statement of the same rule, and it says WHY in the terms a
   * caller needs: a loopback route is reachable by any local process and cannot identify its
   * caller, while the tool channel is where a caller is identified and where the registry's
   * pre-policy applies.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };
          // The read half, and the only thing this handler can do. `stateEnvelope` on its own
          // cannot run anything: it reads the registry and the service references.
          const readState = () => api.stateEnvelope();
          // A route handler runs with no caller above it to catch anything, so a throw here
          // does not become a failed request — it ends the Host process. Every path below is
          // guarded so the worst case is a 500 the caller can read.
          try {
            if (req.method !== 'GET') {
              send(405, {
                ok: false,
                tool: 'agent_api_state',
                route: 'none',
                exit: 2,
                class: 'invalid',
                code: 'read_only_route',
                error:
                  'this route reports state and nothing else. A run is available only through the agent_api_send ' +
                  'and agent_api_tool TOOLS, and that is a constraint rather than a convenience: a run spends the ' +
                  "user's provider credentials and model budget, a loopback route is reachable by any local process " +
                  'and cannot identify its caller, and the tool channel is where a caller is identified and where ' +
                  'the registry pre-policy applies. This component is invoked only by tools.',
              });
              return;
            }
            send(200, readState());
          } catch (error) {
            ctx.logger?.warn?.('newmark-agentapi: state route failed: ' + (error?.message ?? error));
            send(500, {
              ok: false,
              tool: 'agent_api_state',
              route: 'none',
              exit: 4,
              class: 'failed',
              code: 'state_failed',
              error: String(error?.message ?? error),
            });
          }
        },
      }),
    'newmark-agentapi-state-route',
  );

  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        let payload;
        try {
          // The same profile a tool call would see: a run needs no Agent, so the page global
          // reports the real capability table rather than a reduced one.
          const state = api.stateEnvelope();
          payload = {
            ok: true,
            role: 'agent-api',
            root,
            platform: process.platform,
            workspace: state.result.workspace,
            profile: state.profile,
            generatedAt: new Date().toISOString(),
          };
        } catch (error) {
          // A failed snapshot must not blank the page: hand the Client half a structured error
          // it can render honestly rather than an empty profile.
          payload = {
            ok: false,
            role: 'agent-api',
            root,
            error: error instanceof Error ? error.message : String(error),
            generatedAt: new Date().toISOString(),
          };
        }
        const script = `<script>window.${SNAPSHOT_GLOBAL}=${embedJson(payload)};</script>`;
        const at = html.indexOf('</head>');
        return at === -1 ? script + html : html.slice(0, at) + script + html.slice(at);
      }),
    'newmark-agentapi-index-injection',
  );

  const profile = api.profileFor();
  const available = profile.capabilities.filter((entry) => entry.state === 'available').map((entry) => entry.id);
  ctx.logger?.info?.(
    `newmark-agentapi: active on ${root}, workspace=${api.workspaceDir()}, ` +
      `${definitions.length} tools, capabilities available: ${available.join(', ') || 'none'}`,
  );

  /**
   * The instance this `apply()` built.
   *
   * A Cordis `apply` has no documented return value and the Loader ignores one, so returning it
   * changes nothing about how this component mounts. It is returned anyway because the thing it
   * exposes is otherwise unreachable: `counters` is what proves a read performs no run and what
   * proves the temporary conversation is released, and a gate can only assert those from OUTSIDE
   * if it can see the same object the tools report from. Without this, the only routes to the
   * counters are the tools themselves — which is fine for a caller and useless for a check that
   * has to compare an in-flight reading with a settled one.
   */
  return api;
}
