/**
 * Newmark Core — the **MemoryLab** component.
 *
 * Owns the durable store over the shared `~/.Newmark` user path and the five
 * model-facing tools that go with it. Everything this component needs is here:
 * the store module is plugin-owned pure Node, and no harness package is
 * imported.
 *
 * The store writes the same files, in the same layout, that Newmark itself
 * writes — `Memory Lab/index.json`, `Memory Lab/components/`,
 * `Memory Lab/archive/`, `Memory Lab/policy.jsonl` — so the two products share
 * one memory.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { MemoryLabStore } from './lib/memory-store.js';

/** The signature the store records for one component body. */
function bodyDigest(body) {
  return crypto.createHash('sha256').update(String(body), 'utf8').digest('hex');
}

/**
 * Whether the persisted index still matches the files on disk.
 *
 * A rebuild is idempotent in the graph, but it rewrites the index timestamp — so
 * running it on every page load would rewrite a store Newmark also owns, once per
 * load, forever. The store already records what a rebuild would recompute:
 * `relationshipVersion` at the top level and `contentHash` / `bytes` per
 * component. Comparing those against the bodies the snapshot just read is enough
 * to decide, and the steady state performs no write at all.
 */
function needsRebuild(visual) {
  const index = visual && typeof visual === 'object' ? visual.index : null;
  if (!index || !index.relationshipVersion) return true;
  const raw = index.components;
  const entries = Array.isArray(raw) ? raw.map((entry) => [entry.slug, entry]) : Object.entries(raw || {});
  if (entries.length === 0) return false;
  for (const [slug, meta] of entries) {
    const body = visual.contents ? visual.contents[slug] : undefined;
    if (typeof body !== 'string') return true;
    if (meta.contentHash !== bodyDigest(body)) return true;
    if (meta.bytes !== Buffer.byteLength(body, 'utf8')) return true;
  }
  return false;
}

/**
 * The Memory Lab folder Newmark itself uses, under the shared user root.
 *
 * `root` is the Newmark user root (`~/.Newmark`), NOT the memory folder: the
 * store lives in `<root>/Memory Lab`, exactly like Newmark's own
 * `MemoryLabManager(rootPath)`. Getting this wrong once wrote an empty
 * `index.json` into the user's Newmark root, which is why the release gate now
 * asserts this join rather than trusting the call site.
 */
export function memoryLabDir(root) {
  return path.join(root, 'Memory Lab');
}

/**
 * Normalize an index for the wire.
 *
 * The store keys `components` by slug; the renderer wants an array carrying an
 * explicit `slug`. Converting here means a shape change can never make the panel
 * silently render an empty store.
 */
function toComponentArray(components) {
  if (Array.isArray(components)) return components.filter((entry) => entry && typeof entry === 'object' && entry.slug);
  if (components && typeof components === 'object') {
    return Object.entries(components).map(([slug, entry]) => ({ slug, ...(entry || {}) }));
  }
  return [];
}

function toWireIndex(index) {
  const source = index && typeof index === 'object' ? index : {};
  return {
    relationshipVersion: String(source.relationshipVersion || ''),
    updatedAt: String(source.updatedAt || ''),
    preferredLanguage: String(source.preferredLanguage || 'auto'),
    tags: source.tags && typeof source.tags === 'object' && !Array.isArray(source.tags) ? source.tags : {},
    components: toComponentArray(source.components),
  };
}

function toolText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * Create the MemoryLab component.
 *
 * @param root - the shared Newmark user root.
 * @param language - `'auto' | 'en' | 'zh'`, selecting the canonical bilingual tag.
 * @param logger - optional logger for activation lines.
 */
export function createMemoryLab({ root, language = 'auto', reindexOnRender = true, logger } = {}) {
  const labDir = memoryLabDir(root);
  const store = new MemoryLabStore(labDir, { language });
  store.ensureLayout();
  logger?.info?.(`newmark-core/memorylab: store ready at ${labDir}`);

  /** Read a component back off disk; an empty slug only asserts the index reads. */
  function readBack(slug, expectation = 'present') {
    try {
      const state = store.read(slug || '');
      if (!state || !state.index) return { ok: false, error: 'index unreadable after rebuild' };
      if (!slug) return { ok: true };
      const component = toComponentArray(state.index.components).find((entry) => entry.slug === slug);
      // A delete is verified by the component being gone; a write by it being there.
      if (expectation === 'absent') {
        return component ? { ok: false, error: `component ${slug} is still present after rebuild` } : { ok: true, absent: true };
      }
      if (!component) return { ok: false, error: `component ${slug} absent after rebuild` };
      return { ok: true, component };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * A mutation is only successful once the deterministic rebuild AND the
   * read-back agree. Failure is a structured error, never a silent success.
   */
  function verifiedReceipt(written, operation) {
    const rebuilt = store.reindex();
    const verified = readBack(written?.slug || '', operation === 'delete' ? 'absent' : 'present');
    if (!verified.ok) {
      return {
        ok: false,
        action: String(operation).toUpperCase(),
        slug: written?.slug,
        error: `Memory Lab ${operation} did not verify after rebuild: ${verified.error}`,
        receipt: { rebuilt: true, verified: false, operation, at: new Date().toISOString() },
      };
    }
    return {
      ...written,
      relationshipVersion: rebuilt.relationshipVersion,
      receipt: {
        rebuilt: true,
        verified: true,
        operation,
        revision: verified.component?.revision ?? null,
        updatedAt: verified.component?.updatedAt ?? null,
        at: new Date().toISOString(),
      },
    };
  }

  return {
    name: 'memorylab',
    store,
    rootDir: root,

    /**
     * The ONE snapshot the renderer and the injected page global are built from.
     *
     * The deterministic rebuild runs here, which is what makes the panel's
     * "reindex" action honest: it asks for a page reload, this rebuild runs while
     * the index is rendered, and the fresh snapshot arrives through the same
     * injection. A rebuild failure is reported, never swallowed.
     */
    snapshot() {
      let reindexError = '';
      let visual = store.visualizationSnapshot();
      if (reindexOnRender && needsRebuild(visual)) {
        try {
          store.reindex();
          // Re-read so the snapshot the panel receives is the rebuilt one.
          visual = store.visualizationSnapshot();
        } catch (error) {
          reindexError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        root,
        reindexError,
        relationshipVersion: String(visual.relationshipVersion || ''),
        loadedAt: Number(visual.loadedAt) || Date.now(),
        index: toWireIndex(visual.index),
        contents: visual.contents && typeof visual.contents === 'object' ? visual.contents : {},
      };
    },

    /** The five model-facing tools, bundled with this component. */
    tools() {
      return [
        {
          name: 'memory_lab_read',
          description:
            'Read the Memory Lab index, its path and its usage instructions. Optionally pass a component slug or name to read that component core markdown.',
          parameters: {
            type: 'object',
            properties: {
              component: { type: 'string', description: 'Component slug or name. Omit it to read the whole index.' },
              name: { type: 'string', description: 'Component name; an alias for component.' },
              slug: { type: 'string', description: 'Component slug; an alias for component.' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatRead(value)) },
          async execute(args) {
            return store.read(String(args?.component || args?.slug || args?.name || ''));
          },
        },
        {
          name: 'memory_lab_query',
          description:
            'Retrieve a bounded, task-relevant Memory Lab set with deterministic scoring and adaptive early stopping. Prefer this over loading the complete index when a focused query is enough.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to look for. Matched against names, tags, descriptions and bodies.' },
              limit: { type: 'number', description: '1-12, default 5' },
              max_chars: { type: 'number', description: '1000-48000, default 12000' },
            },
            required: ['query'],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatQuery(value)) },
          async execute(args) {
            return store.query({ query: String(args?.query || ''), limit: args?.limit, maxChars: args?.max_chars });
          },
        },
        {
          name: 'memory_lab_update',
          description:
            'Create or incrementally patch one Memory Lab component. Creating requires name and content; patching requires component plus only the changed fields, and should carry expectedUpdatedAt from the latest read. prefer contentAppend or oldText/newText for small body edits. The previous revision is archived and a stale write fails closed. Reports success only after the index rebuild and read-back verification return a completed receipt.',
          parameters: {
            type: 'object',
            properties: {
              component: { type: 'string', description: 'Existing component slug or name. Required to patch; omit it only when creating.' },
              name: { type: 'string', description: 'Component name. Required when creating; defaults to the existing name when patching.' },
              description: { type: 'string', description: 'One-line summary shown in search results.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Flat tags, each with its leading #, e.g. "#理论物理".' },
              tagPaths: {
                type: 'array',
                items: { type: 'array', items: { type: 'string' } },
                description: 'Full parent chains, each an array from root to leaf, e.g. [["#AI", "#Agent"]].',
              },
              content: { type: 'string', description: 'The complete core markdown. Replaces the whole body.' },
              contentAppend: { type: 'string', description: 'Appended to the existing body. Prefer this over resending content.' },
              oldText: { type: 'string', description: 'Exact fragment to replace; must occur once unless replaceAll is true.' },
              newText: { type: 'string', description: 'Replacement for oldText.' },
              replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText instead of requiring a unique one.' },
              kind: { type: 'string', enum: ['file', 'folder'], description: 'Storage shape: a single core.md, or a folder holding one.' },
              expectedUpdatedAt: { type: 'string', description: 'updatedAt from the latest read. A mismatch fails closed instead of overwriting newer memory.' },
              reason: { type: 'string', description: 'Why this change is being made; recorded in policy.jsonl.' },
              source: { type: 'string', description: 'Who or what made the change; recorded in policy.jsonl.' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatWrite(value)) },
          async execute(args) {
            // The store reads the selector from `component`, which is also this
            // tool's public parameter — the two names agree, as they do in Newmark.
            const plan = store.prepareUpdate(args || {});
            return verifiedReceipt(store.update(plan), 'update');
          },
        },
        {
          name: 'memory_lab_delete',
          description:
            'Remove one obsolete durable memory component. Use it only for an explicit user request to forget or remove memory: the final revision is archived, the active component is removed, the tag graph is rebuilt, and a verified receipt is returned.',
          parameters: {
            type: 'object',
            properties: {
              component: { type: 'string', description: 'Component slug or name to remove. A selector is required.' },
              name: { type: 'string', description: 'Component name; an alias for component.' },
              slug: { type: 'string', description: 'Component slug; an alias for component.' },
              expectedUpdatedAt: { type: 'string', description: 'updatedAt from the latest read. A mismatch fails closed.' },
              reason: { type: 'string', description: 'Why the memory is being forgotten; recorded in policy.jsonl.' },
              source: { type: 'string', description: 'Who or what asked for the removal; recorded in policy.jsonl.' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatWrite(value)) },
          async execute(args) {
            const result = store.delete(String(args?.component || args?.slug || args?.name || ''), {
              reason: args?.reason,
              source: args?.source,
              expectedUpdatedAt: args?.expectedUpdatedAt,
            });
            return verifiedReceipt(result, 'delete');
          },
        },
        {
          name: 'memory_lab_reindex',
          description:
            'Rebuild and normalise the Memory Lab tag graph from every component tags/tagPaths. This is the single normalisation entry point: bilingual synonyms fold to one canonical tag, aliases are preserved, and repeated rebuilds are graph-idempotent.',
          parameters: { type: 'object', properties: {}, required: [] },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatWrite(value)) },
          async execute() {
            const result = store.reindex();
            const verified = readBack('');
            return {
              ok: verified.ok,
              action: 'REINDEX',
              relationshipVersion: result.relationshipVersion,
              components: result.components,
              tags: result.tags,
              receipt: { rebuilt: true, verified: verified.ok, operation: 'reindex', at: new Date().toISOString() },
              error: verified.ok ? undefined : verified.error,
            };
          },
        },
      ];
    },
  };
}
