/**
 * Newmark Core — the **MemoryLab component**.
 *
 * Owns the shared durable store at `<root>/Memory Lab` and the seven `memory_lab_*`
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
import { createMemoryLab } from './component.js';
import { schema } from './lib/schema.js';
import { resolveRoot } from './lib/root.js';
import { embedJson } from './lib/embed.js';

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
    })
  : undefined;

export function apply(ctx, config) {
  const root = resolveRoot(config);
  const language = config?.language === 'zh' || config?.language === 'en' ? config.language : 'auto';

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
     * The ONE line that says how this component learns whether a judge is reachable.
     *
     * The TOOLS REGISTRY, and not a service handed down from the core row. `agent-api` is invoked
     * only by tools, so whether `agent_api_send` is currently registered is both the presence
     * signal and the only route to a run — there is no second thing to look up, and nothing here
     * probes the page, the routes or another component.
     *
     * `readAgentApi()` in `component.js` is the only place this is read. What it replaced: the
     * core row used to provide an `agentApi` service (`{ active, isActive, root }`) and this line
     * used to look that service up by name off the context. That design let a route reach a run,
     * which the user's constraint forbids; a tool-invoked run leaves the registry as the honest
     * answer, and nothing here looks a service up at all any more.
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
            let reindexError = '';
            let rebuild = null;
            if (wanted) {
              try {
                rebuild = memorylab.rebuild();
              } catch (error) {
                reindexError = error instanceof Error ? error.message : String(error);
              }
            }
            const payload = memorylab.snapshot({ rebuild: false });
            ctx.logger?.info?.(
              `newmark-memorylab: snapshot served${wanted ? ' after a rebuild' : ' (read only)'}${reindexError ? ` (rebuild failed: ${reindexError})` : ''}`,
            );
            send(200, { ...payload, reindexError: payload.reindexError || reindexError, source: 'route', rebuild: wanted, result: rebuild });
          } catch (error) {
            ctx.logger?.warn?.('newmark-memorylab: snapshot route failed: ' + (error?.message ?? error));
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
        }
        const script = `<script>window.${SNAPSHOT_GLOBAL}=${embedJson(payload)};</script>`;
        const at = html.indexOf('</head>');
        return at === -1 ? script + html : html.slice(0, at) + script + html.slice(at);
      }),
    'newmark-memorylab-index-injection',
  );

  ctx.logger?.info?.(`newmark-memorylab: active on ${root} (${definitions.length} tools)`);
}
