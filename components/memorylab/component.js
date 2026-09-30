/**
 * Newmark Core — the **MemoryLab** component.
 *
 * Owns the durable store over the shared `~/.Newmark` user path and the seven
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
import { MemoryLabStore, MemoryLabStoreError, TAG_DECISION_KINDS } from './lib/memory-store.js';
// The presence probe belongs to the component that owns the tool being probed, and it works
// whether or not that component is mounted — which is the whole reason it can answer "is a judge
// reachable" for a component that is switched off. Reading it here rather than re-implementing it
// is what keeps one answer to one question.
import { agentApiPresence } from '../agent-api/lib/presence.js';

/**
 * The decisions that ARE a judgement, as opposed to a reversal of one.
 *
 * `merge`, `reparent`, `split` and `join` decide something about the graph, so they
 * are the Agent half of a rebuild and need the `agent-api` interface; `set-tags` and
 * `unfold` only restore tags a recorded decision replaced, so they never do.
 */
export const JUDGEMENT_DECISION_KINDS = Object.freeze(['merge', 'reparent', 'split', 'join']);

/**
 * The interface MemoryLab hands its judgement to, and how it is reached.
 *
 * MemoryLab owns the store and the tag graph; it does not own a model, and it must
 * not grow one. The judgement is a run of this bundle's own — `agent-api` carries a
 * small runtime for it, driven by DSH's configured model and credentials, in process
 * — so this component reports what a judge needs and records what comes back:
 *
 *   1. `memory_lab_tag_review` returns the evidence a judge needs, plus the request
 *      that says what is being judged, where it runs (`<root>/Work`) and what shape
 *      the answer takes.
 *   2. `memory_lab_tag_apply` applies the decisions and records them — archived, and
 *      reversible through the `undo` the receipt carries.
 *
 * ## The judgement is TOOL-INVOKED, and the two-step shape is deliberate
 *
 * **This component never runs a judgement itself, and neither does the panel.** The sequence is
 * agent-driven end to end: the agent calls `memory_lab_tag_review`, reads the evidence and the
 * request it carries, decides, and applies the decisions through `memory_lab_tag_apply` —
 * obtaining a run from `agent-api` through a TOOL call when a run is wanted. `agent-api` is
 * invoked only by tools, so there is no path from a route, a page global or this component
 * straight into a run, and the panel's 重建索引 performs the deterministic rebuild only.
 *
 * An earlier revision of this file said "There is ONE path, not two" and claimed the run was
 * callable from the panel's own snapshot route. That was true of a design the user has since
 * replaced, and it is the wrong story to leave in the tree: a reader who believed it would build
 * the route-triggered judgement that the constraint forbids. What replaced it is not a fallback
 * and not a queue — it is the two calls above, in that order.
 *
 * ## How "is a judge reachable" is answered, now
 *
 * Through the TOOLS REGISTRY, not through a service this component was handed: whether
 * `agent_api_send` is currently registered is a fact about right now, it is readable by anything
 * that can see `ctx.tools`, and it is exactly the fact that matters — if the tool is not there,
 * no tool-invoked run can happen. That probe lives in `agent-api`'s own `lib/presence.js`, which
 * is importable whether or not that component is mounted, and `readAgentApi` below is the only
 * place in MemoryLab that reads it. `AGENT_API_SERVICE` is kept below only to name the concept in
 * prose; nothing looks it up.
 */
export const AGENT_API_INTERFACE = 'agent-api';

/**
 * The name this interface used to be reached under, kept for the record only.
 *
 * True of the replaced design: the core row provided a `{ active, isActive, root }` service, and
 * this component read it. Nothing looks it up any more — a judged run is a tool call, so the
 * registry is both the presence signal and the only way to reach one.
 */
export const AGENT_API_SERVICE = 'agentApi';

/**
 * The ONE place MemoryLab asks whether a judge is reachable.
 *
 * @param tools - the `tools` service (`ctx.tools`). `agent_api_send` being registered is the
 *   signal, because a tool-invoked run is the only kind there is: if the tool is absent, no run
 *   can be asked for, and that is the honest answer rather than a reason to look elsewhere.
 * @returns `{ available, reason, active }`, the shape every caller already reads.
 *
 * `available` is a fact about right now, not a preference: a component switched off retires its
 * tools, so the answer flips with the switch and every caller reads it again at the moment it
 * acts. Two detection mechanisms is what this contract exists to prevent, so there is exactly one
 * and it is this one.
 */
export function readAgentApi(tools) {
  const presence = agentApiPresence(tools);
  return {
    available: presence.active === true,
    reason: presence.active === true ? '' : `the ${AGENT_API_INTERFACE} component is switched off, so no run can be asked for: ${presence.reason}`,
    active: Array.isArray(presence.registered) ? presence.registered.map(String) : [],
  };
}

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
 * @param tools - the `tools` service (`ctx.tools`), read for ONE thing: whether
 *        `agent_api_send` is currently registered, which is what "a judge is reachable" means.
 *        `agent-api` is invoked only by tools, so the registry is both the presence signal and
 *        the only route to a run — there is no second thing to look up. Its absence is a state
 *        the app reaches (the user switches `agent-api` off and its tools are retired), so it is
 *        not an error here: it is what makes the Agent half of a rebuild unavailable, and every
 *        envelope this component produces says which of the two it is.
 */
export function createMemoryLab({ root, language = 'auto', reindexOnRender = true, logger, tools } = {}) {
  const labDir = memoryLabDir(root);
  const store = new MemoryLabStore(labDir, { language });
  store.ensureLayout();
  logger?.info?.(`newmark-core/memorylab: store ready at ${labDir}`);

  /**
   * What the judgement half of a rebuild looks like right now.
   *
   * Read afresh on every call that needs it. `judged` is the one field that must
   * never be guessed: MemoryLab does not judge, so it is `false` unless a caller
   * has just handed over decisions this call applied.
   */
  function judgeState({ judged = false, applied = 0 } = {}) {
    const judge = readAgentApi(tools);
    return {
      interface: AGENT_API_INTERFACE,
      workspace: path.join(root, 'Work'),
      /** Whether a judge can be reached at all, and why not when it cannot. */
      status: judge.available ? 'available' : 'unavailable',
      reason: judge.reason,
      active: judge.active,
      /** Whether THIS result reflects decisions that were judged and applied. */
      judged,
      applied,
      applyWith: 'memory_lab_tag_apply',
      // The sequence, stated where a caller reads it. It is two calls and a decision by the agent
      // in between; nothing here runs a judgement, and nothing here can.
      sequence: [
        'memory_lab_tag_review reads the evidence and carries the request',
        'the agent decides, obtaining a run from agent-api through a tool call when one is wanted',
        'memory_lab_tag_apply applies the decisions and records them, reversibly',
      ],
      note: judged
        ? 'these decisions were applied and recorded; the receipt carries the undo that reverses them'
        : judge.available
          ? 'nothing was judged by this call: a judgement is an agent-driven sequence — this tool reads the evidence, the agent decides, and memory_lab_tag_apply applies the result. This component never runs a judgement itself, and the panel never runs one either'
          : `the ${AGENT_API_INTERFACE} component is off, so the three judgement classes (假根父节点接续, 同义近义 tag 合并, 未被正确解析的 tag 误读为单 tag) are unavailable here — not skipped and not pending; the deterministic rebuild is unaffected`,
    };
  }

  /**
   * What the judgement is asked, where it runs, and what it must answer with.
   *
   * This is the request an in-process run through the interface consumes — the same
   * object whether the trigger was a tool call or the panel's own route. The three
   * questions are the user's own names for the three things a rebuild cannot decide
   * by rule; each is stated with the finding kind that carries its evidence, so a
   * run is told what it is being asked rather than handed a payload and left to
   * guess.
   */
  function judgementRequest(review) {
    return {
      interface: AGENT_API_INTERFACE,
      workspace: path.join(root, 'Work'),
      operation: 'memorylab-tag-judgement',
      questions: [
        { id: 'false-root', ask: '假根父节点接续：which root tags are not true roots and should continue under a real parent?', evidence: ['false-root'] },
        { id: 'synonym-merge', ask: '同义近义 tag 合并：which tags are one tag, and which spelling should survive as canonical?', evidence: ['synonym-candidate'] },
        {
          id: 'misparsed-tag',
          ask: '未被正确解析的 tag 误读为单 tag：which stored name is really a chain, and which chain is really one tag?',
          evidence: ['single-tag-path', 'path-might-be-one-tag'],
        },
      ],
      graph: {
        relationshipVersion: String(review.relationshipVersion || ''),
        indexPath: review.indexPath,
        tags: review.counts.tags,
        components: review.counts.components,
      },
      findings: {
        total: review.counts.findings,
        byKind: review.counts.byKind,
        returned: review.window.returned,
        omitted: review.window.omitted,
      },
      answer: {
        applyWith: 'memory_lab_tag_apply',
        decisionKinds: TAG_DECISION_KINDS.slice(),
        expectedRelationshipVersion: String(review.relationshipVersion || ''),
        reversible: 'every apply archives the pre-change index.json and returns the undo that restores it',
      },
    };
  }

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
     * `snapshot()` — what the page index injection calls — rebuilds the index when
     * it is stale, which is what makes the panel's 重建索引 action honest: the
     * action asks this half for a rebuild, the deterministic rebuild runs, and the
     * panel re-renders from the answer. `snapshot({ rebuild: false })` is the pure
     * read the panel's 重置 action asks for: it never writes, so re-reading the
     * store can never rewrite it. A rebuild failure is reported, never swallowed.
     */
    snapshot(options = {}) {
      const mayRebuild = options.rebuild !== false;
      let reindexError = '';
      let visual = store.visualizationSnapshot();
      if (mayRebuild && reindexOnRender && needsRebuild(visual)) {
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
        // Every snapshot carries whether the judgement half of a rebuild exists, so
        // the panel and the config page can never look the same with it switched off.
        judge: judgeState(),
      };
    },

    /** The deterministic rebuild on its own, with the store's own result. */
    rebuild() {
      const result = store.reindex();
      return { relationshipVersion: result.relationshipVersion, components: result.components, tags: result.tags, warnings: result.warnings };
    },

    /** The seven model-facing tools, bundled with this component. */
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
            'Rebuild the index and the tag graph from every component tags/tagPaths: the deterministic normalizer. It folds the bilingual spellings its built-in table names, keeps the other spellings as aliases, keeps every tagPath, drops tags no component references, and repeated rebuilds are graph-idempotent. It never merges a near-synonym the table does not name, never re-parents a root tag and never repairs a mis-parsed tag name: memory_lab_tag_review reports those, and memory_lab_tag_apply records the decisions you make from it.',
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
              // A deterministic rebuild decides nothing, and says so in the same
              // envelope a judgement uses — including whether a judge exists at all.
              judge: judgeState(),
              warnings: result.warnings,
              receipt: { rebuilt: true, verified: verified.ok, operation: 'reindex', at: new Date().toISOString() },
              /* `error` is OMITTED on success, not set to `undefined`.
               *
               * DSH validates a tool's return value as LOSSLESS JSON before handing it back
               * (`dsh-tools/lib/index.js:2578`, rules in `dsh-util-values/lib/index.js`). Its
               * walker accepts null, boolean, string, finite non-negative-zero numbers, plain
               * arrays and plain objects — and REJECTS anything else at
               * `if (typeof current !== "object") return void 0`, which is where `undefined`
               * lands, because `undefined` is not a JSON value.
               *
               * So `error: verified.ok ? undefined : verified.error` made the WHOLE result
               * invalid in exactly the case where the rebuild had worked: the index was
               * written, the tool returned, and the registry threw `INVALID_TOOL_OUTPUT —
               * value is not lossless JSON` instead of returning it. A caller — a model driving
               * this tool — saw a hard failure for an operation that succeeded, which is worse
               * than a plain failure because the obvious response is to run it again.
               *
               * Spreading the key in conditionally keeps the success shape identical to what it
               * always meant, minus a key that could never survive the boundary. */
              ...(verified.ok ? {} : { error: verified.error }),
            };
          },
        },
        {
          name: 'memory_lab_tag_review',
          description:
            'Report the tag-graph repairs that need judgement rather than a rule: a root tag whose memories are already filed under another tag, near-synonym tags, a name that may be a collapsed path, a chain that may be one tag, and stored values a rebuild does not reproduce. Read-only — it rewrites nothing. Every finding carries the facts to decide it and the decision shape to pass to memory_lab_tag_apply. ' +
              'This result also carries the judgement envelope: whether a run can be asked for right now, and the request that says what is being judged, where it runs and what shape the answer takes. ' +
              'THE SEQUENCE IS AGENT-DRIVEN AND IT IS TWO CALLS: this tool gives you the evidence and the request; YOU decide; memory_lab_tag_apply applies and records your decisions. Nothing here judges, and the config panel cannot judge either — a judgement is a model run, agent-api is invoked only by tools, and a panel button has no tool context. When you want a run to make the decision for you, obtain one from agent-api through its agent_api_send tool.',
          parameters: {
            type: 'object',
            properties: {
              kinds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Report only these finding kinds: false-root, synonym-candidate, single-tag-path, path-might-be-one-tag, rule-not-reproducible. Omit for all of them.',
              },
              limit: { type: 'number', description: 'Findings per page, 1-200, default 25.' },
              offset: { type: 'number', description: 'Skip this many findings. The window in the result says how many were omitted.' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatTagReview(value)) },
          async execute(args) {
            const review = store.tagReview({ kinds: args?.kinds, limit: args?.limit, offset: args?.offset });
            const judge = judgeState();
            // The envelope is the same either way the judgement runs: the findings and
            // the request sit beside each other, so a judge reading this result now and
            // a judge handed the request later both get everything they need, and the
            // `status` field says which of them can happen.
            return { ...review, judge, request: judge.status === 'available' ? judgementRequest(review) : null };
          },
        },
        {
          name: 'memory_lab_tag_apply',
          description:
            'Apply the tag-graph decisions you made from memory_lab_tag_review: merge folds tags into one canonical tag, reparent continues a root tag under a parent, split turns a collapsed name into a chain, join turns a chain into one tag, and set-tags/unfold restore previous tags exactly. Before it writes, the current index is archived under archive/ and one policy.jsonl line records the decisions, every affected component previous tags and an undo list that restores the previous graph. A judgement decision (merge, reparent, split, join) requires the agent-api component and is refused while it is switched off; a reversal still applies.',
          parameters: {
            type: 'object',
            properties: {
              decisions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: {
                      type: 'string',
                      enum: ['merge', 'reparent', 'split', 'join', 'set-tags', 'unfold'],
                      description: 'Which repair this decision is; the other fields are the ones that kind reads.',
                    },
                  },
                  required: ['kind'],
                },
                description:
                  'The decisions to apply, in order. Use the shapes the review options show; a decision that changes nothing is reported in `skipped`, not applied.',
              },
              reason: { type: 'string', description: 'Why these repairs are being made; recorded in policy.jsonl.' },
              source: { type: 'string', description: 'Who or what decided them; recorded in policy.jsonl.' },
              expectedRelationshipVersion: {
                type: 'string',
                description: 'relationshipVersion from the review. A mismatch fails closed instead of rewriting a graph something else changed.',
              },
              dryRun: { type: 'boolean', description: 'Report exactly what would change, undo included, and write nothing.' },
            },
            required: ['decisions'],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatTagApply(value)) },
          async execute(args) {
            const decisions = Array.isArray(args?.decisions) ? args.decisions : [];
            const judge = judgeState();
            /**
             * A judgement is not a reversal, and the two do not share a gate.
             *
             * The four judging decisions need the Agent half of the rebuild, so with
             * `agent-api` switched off they are UNAVAILABLE: this refuses, names the
             * switch, and writes nothing — it never applies half a judgement. A
             * reversal is `set-tags`/`unfold` only, decides nothing, and is the way back
             * from a decision that was already recorded, so it must keep working when
             * the switch is off — otherwise switching `agent-api` off would strand a
             * merge that is already in the store.
             */
            const judgements = decisions.filter((decision) => JUDGEMENT_DECISION_KINDS.includes(decision && decision.kind));
            if (judgements.length && judge.status !== 'available') {
              throw new MemoryLabStoreError(
                'AGENT_UNAVAILABLE',
                `The ${AGENT_API_INTERFACE} component is switched off, so a tag judgement cannot be applied: ${judge.reason}. This is the Agent half of the rebuild and it is unavailable here, not skipped — nothing was written. memory_lab_reindex still rebuilds deterministically, and a reversal (set-tags/unfold) still applies.`,
                {
                  interface: AGENT_API_INTERFACE,
                  reason: judge.reason,
                  judgementKinds: Array.from(new Set(judgements.map((decision) => String(decision.kind)))).sort(),
                  knownJudgementKinds: JUDGEMENT_DECISION_KINDS.slice(),
                  reversedBy: 'set-tags/unfold decisions',
                },
              );
            }
            const result = store.applyTagDecisions({
              decisions,
              reason: args?.reason,
              source: args?.source,
              expectedRelationshipVersion: args?.expectedRelationshipVersion,
              dryRun: args?.dryRun === true,
            });
            // `judged` is true only here, and only for decisions this call applied: a
            // judgement run that failed elsewhere produces no MemoryLab result at all,
            // so "off" and "ran and failed" cannot collapse into one answer.
            return { ...result, judge: judgeState({ judged: result.changed === true && judgements.length > 0, applied: result.applied?.length || 0 }) };
          },
        },
      ];
    },
  };
}
