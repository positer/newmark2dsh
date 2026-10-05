/**
 * Newmark Core — the **MemoryLab component**.
 *
 * Owns the shared durable store at `<root>/Memory Lab` and the nine `memory_lab_*`
 * tools, and publishes `window.__NEWMARK_MEMORYLAB__` for the Client half.
 *
 * It is an independent Loader row: disabling `newmark-memorylab` retires the whole
 * component — the tools are never registered, nothing is published, and the Client
 * half therefore registers neither the sidebar entry nor the panel.
 *
 * The row resolves the shared root from its own `config.root`, using the same rule
 * every other row uses (`lib/root.js`). It deliberately does not depend on the core
 * row: Cordis resolves services by walking up the consumer's fiber ancestry, so a
 * sibling row's service is unreachable, and a component that could not start
 * without a sibling would not be independently switchable.
 */
import { createMemoryLab, DEFAULT_JUDGEMENT_TIMEOUT_MS } from './component.js';
import { schema } from './lib/schema.js';
import { resolveRoot } from './lib/root.js';
import { embedJson } from './lib/embed.js';
import { causeChain, describeError } from '../../lib/errors.js';

/** The page global this row publishes. */
export const SNAPSHOT_GLOBAL = '__NEWMARK_MEMORYLAB__';

/**
 * The route this component serves its CURRENT snapshot on.
 *
 * The panel needs two reads the page injection cannot give it: the store as it is
 * now (重置), and the store after a rebuild this half was asked to run (重建索引).
 * An index injection is a pure html-to-html transform, so it cannot see a request
 * and cannot be asked for anything; a route can. This is a route on the same
 * `webServer` service the row already injects — no new server, port or channel —
 * and it lives and dies with this component's fiber, so its presence means exactly
 * what the page global's presence means.
 *
 * ## `?reindex=1` is ONE ACTION IN TWO HALVES, and it is the only route that can
 * ## produce a run
 *
 * The user's instruction is exact: 先硬流程重建，再提交 Agent-api 用内置的 Newmark Agent core
 * 进行 agent prompt 驱动的重建. So a rebuild request runs, in this order:
 *
 *   1. `memorylab.rebuild()` — the deterministic normalizer, reported as `result`;
 *   2. `memorylab.judge()` — the judgement, dispatched through the `agent_api_send` TOOL, and
 *      reported separately as `judgement`.
 *
 * This is a DELIBERATE, NARROW change to the bundle's oldest rule. The rule was "the agent core is
 * tool-invoked only, and no HTTP method produces a run", and it existed because a route-triggered
 * run was the wrong shape. What the user asked for is this one path and nothing wider: the route
 * does not run anything itself — it asks MemoryLab to, and MemoryLab reaches the run the only way
 * a run is ever reached, by dispatching the tool through the registry (`judge()` in `component.js`
 * says why that is the right shape). No other route gains that ability, no request can supply a
 * prompt, and `agent_api_send` stays a tool that nothing but a tool execution invokes.
 *
 * A plain read (`GET` with no `reindex=1`) never rebuilds and never dispatches: it is the same
 * route and a different action, which is what the panel's 重置 needs.
 */
export const SNAPSHOT_ROUTE = '/newmark-memorylab/snapshot';

export const name = 'newmark-memorylab';

export const inject = ['tools', 'webServer'];

export const Config = schema
  ? schema.object({
      root: schema
        .string()
        .description("The shared Newmark user root. Empty means Newmark's own path, ~/.Newmark.")
        .default(''),
      language: schema
        .union(['auto', 'zh', 'en'])
        .description('Tag folding language. Auto follows the store.')
        .default('auto'),
      reindexOnRender: schema
        .boolean()
        .description('Rebuild the index while rendering it, but only when it is stale.')
        .default(true),
      judgementTimeoutMs: schema
        .natural()
        .description(
          'How long the judgement half of 重建索引 may take before it is aborted and reported as a ' +
            'timeout, in milliseconds. The deterministic rebuild beside it takes milliseconds; a run of ' +
            'the agent core takes turns. This is the bound that guarantees the button comes back with an ' +
            'answer, so a run that cannot finish inside it is reported as a timeout and never as a judgement.',
        )
        .default(DEFAULT_JUDGEMENT_TIMEOUT_MS),
    })
  : undefined;

export function apply(ctx, config) {
  const root = resolveRoot(config);
  const language = config?.language === 'zh' || config?.language === 'en' ? config.language : 'auto';
  /* The bound on the judgement half, read the way the other numbers in this bundle are: a value
   * the schema would not have produced is discarded rather than clamped, so the effective bound is
   * always one the config page could have shown. */
  const judgementTimeoutMs =
    Number.isFinite(config?.judgementTimeoutMs) && config.judgementTimeoutMs > 0
      ? Math.floor(config.judgementTimeoutMs)
      : DEFAULT_JUDGEMENT_TIMEOUT_MS;

  const memorylab = createMemoryLab({
    root,
    language,
    // The deterministic rebuild runs while the page index is rendered, which is
    // what makes the panel's "reindex" action honest: it asks for a reload and the
    // rebuild happens on the Host half. It only writes when the index is actually
    // stale, so a steady store is never rewritten.
    reindexOnRender: config?.reindexOnRender !== false,
    logger: ctx.logger,
    /**
     * The ONE line that says how this component reaches a judge — and a run.
     *
     * The TOOLS REGISTRY, and not a service handed down from the core row. `agent-api` is invoked
     * only by tools, so whether `agent_api_send` is currently registered is the presence signal,
     * and its `execute` is the only route to a run: there is no second thing to look up, and
     * nothing here probes the page, the routes or another component.
     *
     * `readAgentApi()` and `judge()` in `component.js` are the only places this is read, and they
     * read the SAME object — so "a judge is reachable" and "the judge was asked" cannot come apart.
     * What it replaced: the core row used to provide an `agentApi` service (`{ active, isActive,
     * root }`) and this line used to look that service up by name off the context. That design let
     * a route reach a run illegitimately; what the route does now is dispatch the TOOL, which is
     * how a run is reached, and nothing here looks a service up at all.
     */
    tools: ctx.tools,
  });

  const definitions = memorylab.tools();
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `newmark-memorylab-tool-${definition.name}`);
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SNAPSHOT_ROUTE,
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
          };
          // A route handler has no caller above it to catch anything: a throw here
          // does not become a failed request, it ends the Host process. Every path
          // below is guarded so the worst case is a 500 the panel can report.
          try {
            if (req.method !== 'GET') {
              send(405, { ok: false, error: 'method_not_allowed' });
              return;
            }
            const wanted = new URL(String(req.url || SNAPSHOT_ROUTE), 'http://newmark.invalid').searchParams.get('reindex') === '1';
            /* HALF ONE, FIRST. `memorylab.rebuild()` is the deterministic normalizer: it runs to
             * completion before anything is submitted to the agent core, and its result is
             * reported on its own (`result`). A failure here is reported too, and it is passed on
             * to the judgement half as `rebuildError` so that half says it was not asked for
             * rather than reporting an empty judgement. */
            let reindexError = '';
            let rebuild = null;
            if (wanted) {
              try {
                rebuild = memorylab.rebuild();
              } catch (error) {
                reindexError = error instanceof Error ? error.message : String(error);
              }
            }
            /* HALF TWO, SECOND — and only when the rebuild was asked for. `judge()` builds the ask
             * from the graph the rebuild just wrote and dispatches `agent_api_send` through the
             * registry; it takes NOTHING from the request, which is why its whole argument list is
             * these two locals. A plain read never reaches this line, so 重置 cannot start a run
             * even by accident. */
            let judgement = null;
            if (wanted) {
              judgement = await memorylab.judge({ timeoutMs: judgementTimeoutMs, rebuildError: reindexError });
            }
            /* The snapshot is taken AFTER both halves, so a judgement that APPLIED decisions is
             * visible in the payload the panel re-renders from. `rebuild: false` keeps this read
             * pure: the only writes on this path are the two halves above. */
            const payload = memorylab.snapshot({ rebuild: false });
            ctx.logger?.info?.(
              `newmark-memorylab: snapshot served${wanted ? ' after a rebuild' : ' (read only)'}` +
                `${wanted ? ` (rebuild ${reindexError ? 'failed: ' + reindexError : 'ok'})` : ''}` +
                `${judgement ? ` (judgement ${judgement.status}${judgement.attempted ? `, ${judgement.turns} turns` : ''})` : ''}`,
            );
            send(200, {
              ...payload,
              reindexError: payload.reindexError || reindexError,
              source: 'route',
              rebuild: wanted,
              result: rebuild,
              judgement,
            });
          } catch (error) {
            ctx.logger?.warn?.('newmark-memorylab: snapshot route failed: ' + (error?.message ?? error));
            /* A route handler that throws has no caller above it to report to, so this is the
             * only record of what happened: the panel gets its 500, and the failure is
             * persisted and printed like every other. The rebuild and the judgement inside this
             * `try` record themselves before they throw, so this line is for what is left —
             * reading the snapshot itself. */
            memorylab.failures.record({
              where: 'memorylab/snapshot',
              code: 'snapshot_failed',
              message: `the snapshot route failed: ${describeError(error)}`,
              detail: causeChain(error),
              fields: { route: SNAPSHOT_ROUTE },
            });
            send(500, { ok: false, error: 'snapshot_failed', detail: String(error?.message ?? error) });
          }
        },
      }),
    'newmark-memorylab-snapshot-route',
  );

  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        let payload;
        try {
          payload = memorylab.snapshot();
        } catch (error) {
          // A failed snapshot must not blank the page: hand the Client half a
          // structured error it can render honestly instead of an empty store.
          payload = {
            ok: false,
            generatedAt: new Date().toISOString(),
            root,
            error: error instanceof Error ? error.message : String(error),
          };
          /* The page still renders, so nothing is visibly broken — which is exactly why this
           * failure needs a record. A store that cannot be read is the quiet kind of broken:
           * the panel draws an empty store and the person concludes they have no memories. */
          memorylab.failures.record({
            where: 'memorylab/snapshot',
            code: 'index_injection_failed',
            message: `the page index could not carry the store snapshot: ${describeError(error)}`,
            detail: causeChain(error),
            fields: { root },
          });
        }
        const script = `<script>window.${SNAPSHOT_GLOBAL}=${embedJson(payload)};</script>`;
        const at = html.indexOf('</head>');
        return at === -1 ? script + html : html.slice(0, at) + script + html.slice(at);
      }),
    'newmark-memorylab-index-injection',
  );

  ctx.logger?.info?.(`newmark-memorylab: active on ${root} (${definitions.length} tools)`);
}
