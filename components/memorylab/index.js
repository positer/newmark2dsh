/**
 * Newmark Core — the **MemoryLab component**.
 *
 * Owns the shared durable store at `<root>/Memory Lab` and the five `memory_lab_*`
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
  });

  const definitions = memorylab.tools();
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `newmark-memorylab-tool-${definition.name}`);
  }

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
