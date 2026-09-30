/**
 * Client half of Newmark Core.
 *
 * Two components, one bundle:
 *
 *   **MemoryLab** owns the left-column entry and the presentation window.
 *   `sidebar.panellist` carries the id `memory-lab` and `main` carries the same
 *   key, so the sidebar renders the button and dispatches to our panel. The
 *   presentation is the Memory Lab itself — the overview graph, the detail tag
 *   graph with its component preview, the tag and component search, reset and
 *   reindex — rendered by this plugin's own renderer, from ONE snapshot, with a
 *   generation guard so a stale snapshot can never replace a newer one.
 *
 *   **ComputerUse** deliberately registers no entry, no panel and no overlay: it
 *   is an implicit capability, and its client surface is nothing at all. The
 *   takeover stroke is a native topmost click-through window owned by the Host
 *   half that covers the whole screen — it must live outside the DSH window, so
 *   the page neither draws it nor learns about it. Nothing here can therefore go
 *   stale, and the stroke needs no page load to appear or to clear.
 *
 * ## Where the snapshot comes from — no server, no port
 *
 * The Host half contributes an index injection, so the shell's own HTML carries
 * the snapshot as the page global this module reads. Nothing here opens a
 * channel, and nothing here imports a harness package: the only shared
 * dependencies are React from the platform module table, the `slots` service,
 * the theme tokens and that global.
 */
window.__ModuleLoader__.load({
  id: 'newmark2dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'memory-lab';
    /** The page global the Host half's index injection writes. */
    /** The core row's global: the shared Newmark root and the platform. */
const CORE_GLOBAL = '__NEWMARK_CORE__';
/** The MemoryLab row's global: the store snapshot. Its presence is the switch. */
const MEMORYLAB_GLOBAL = '__NEWMARK_MEMORYLAB__';
/** The ComputerUse row's global: the lease mirror. Its presence is the switch. */
const COMPUTERUSE_GLOBAL = '__NEWMARK_COMPUTERUSE__';
/** Used in diagnostics, so an absent injection still names the global it looked for. */
const SNAPSHOT_GLOBAL = CORE_GLOBAL;

/** The lease an unmounted ComputerUse row implies. */
const FREE_LEASE = { held: false, ownerId: '', mouseMode: 'real', ttlMs: 0, remainingMs: 0 };

/**
 * Compose the three row globals into one payload.
 *
 * Returns `undefined` when no row published anything, which is the signal that the
 * Host half's injection did not run at all — the Client half then fails open and
 * registers every seat, because an absent page global is a harness problem rather
 * than a user switching a component off. When the core global *is* present, a
 * missing component global means exactly what it says: that component is off.
 */
function readPageGlobals() {
  if (typeof window === 'undefined') return undefined;
  const core = window[CORE_GLOBAL];
  const memory = window[MEMORYLAB_GLOBAL];
  const automation = window[COMPUTERUSE_GLOBAL];
  if (!core && !memory && !automation) return undefined;
  return {
    ...(memory || {}),
    ok: memory ? memory.ok === true : true,
    root: (memory && memory.root) || (core && core.root) || '',
    platform: (core && core.platform) || '',
    generatedAt: (memory && memory.generatedAt) || (core && core.generatedAt) || '',
    components: { memoryLab: Boolean(memory), computerUse: Boolean(automation) },
    computerUse: automation || FREE_LEASE,
  };
}
    const CAMERA_DEFAULT = 0.88;
    const DOT_MODE_SCALE = 0.28;

    /* ------------------------------------------------------------------ styles */

    const CSS = `
.ml-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.ml-topbar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-shrink: 0; }
.ml-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.ml-tab { height: 26px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.ml-tab:hover { color: var(--dsw-alias-label-primary); }
.ml-tab.active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; }
.ml-search { position: relative; flex: 1; min-width: 120px; max-width: 420px; }
.ml-search input { width: 100%; height: 28px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.ml-search input:focus { outline: none; border-color: var(--dsw-alias-border-l2); }
.ml-results { position: absolute; top: 32px; left: 0; right: 0; z-index: 5; max-height: 280px; overflow: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 10px 30px rgb(0 0 0 / 22%); }
.ml-result { display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.ml-result:hover { background: var(--dsw-alias-bg-layer-2); }
.ml-result-kind { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-left: 6px; }
.ml-spacer { flex: 1; }
.ml-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.ml-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.ml-btn:disabled { opacity: .55; cursor: progress; }
.ml-body { flex: 1; min-height: 0; display: flex; }
.ml-graph { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(140px, 1fr) minmax(160px, 1.15fr) minmax(140px, 1fr); gap: 10px; padding: 14px; overflow: auto; }
.ml-col { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.ml-col-title { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.ml-node { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.ml-node:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.ml-node.selected { border-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.ml-node-count { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ml-center .ml-node { padding: 9px 12px; font-size: 13px; }
.ml-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 6px 2px; }
.ml-preview { width: min(420px, 40%); flex-shrink: 0; border-left: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; min-height: 0; }
.ml-preview-head { padding: 12px 14px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ml-preview-title { font-size: 13px; font-weight: 600; }
.ml-preview-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; line-height: 1.5; }
.ml-preview-tags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px; }
.ml-tag { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ml-preview-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; }
.ml-preview-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-primary); }
.ml-overview { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.ml-overview svg { display: block; width: 100%; height: 100%; cursor: grab; }
.ml-overview svg:active { cursor: grabbing; }
.ml-link { fill: none; stroke-width: 1; }
.ml-link.parent { stroke: var(--dsw-alias-state-warn-primary); opacity: .5; }
.ml-link.child { stroke: var(--dsw-alias-state-success-primary); opacity: .45; }
.ml-flow { fill: none; stroke-width: 1.4; stroke-dasharray: 5 9; animation: ml-flow 1.6s linear infinite; }
.ml-flow.parent { stroke: var(--dsw-alias-state-warn-primary); }
.ml-flow.child { stroke: var(--dsw-alias-state-success-primary); }
@keyframes ml-flow { to { stroke-dashoffset: -56; } }
.ml-ovnode { cursor: pointer; }
.ml-ovnode circle { fill: var(--dsw-alias-bg-layer-2); stroke: var(--dsw-alias-border-l2); }
.ml-ovnode.root circle { fill: var(--dsw-alias-brand-primary); stroke: var(--dsw-alias-brand-primary); }
.ml-ovnode.anchor circle { fill: var(--dsw-alias-state-warn-primary); stroke: var(--dsw-alias-state-warn-primary); }
.ml-ovnode.leaf circle { fill: var(--dsw-alias-state-success-primary); stroke: var(--dsw-alias-state-success-primary); }
.ml-ovnode text { fill: var(--dsw-alias-label-secondary); font-size: 10px; pointer-events: none; }
.ml-ovnode.focus circle { stroke: var(--dsw-alias-label-primary); stroke-width: 2; }
.ml-ovnode.focus text { fill: var(--dsw-alias-label-primary); font-weight: 600; }
.ml-ovnode.dim { opacity: .18; }
.ml-toolbar { position: absolute; top: 12px; right: 14px; display: flex; gap: 6px; align-items: center; padding: 5px 8px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); }
.ml-zoom { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); min-width: 38px; text-align: center; }
.ml-status { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); flex-shrink: 0; }
.ml-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.ml-status[data-state="ready"] .ml-dot { background: var(--dsw-alias-state-success-primary); }
.ml-status[data-state="error"] .ml-dot { background: var(--dsw-alias-state-error-primary); }
.ml-status[data-state="loading"] .ml-dot { background: var(--dsw-alias-state-warn-primary); }
.ml-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ml-busy { box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary); }
`;

    /* ------------------------------------------------------------------- store */

    /**
     * The panel owns one snapshot and one generation token. The token is a plain
     * closure counter, so an older in-flight response can never overwrite a newer
     * snapshot — the parent's `generation` rule, kept here as the same mechanism.
     */
    /**
     * Read the Host half's injected snapshot, synchronously.
     *
     * The injection lands in `<head>` before the plugin loader boots, so the
     * store can start ready instead of starting on a loading placeholder that the
     * first effect then replaces. `loadVisualization` still re-reads it on open
     * and on reset, which is where the generation guard matters.
     */
    function readInjected() {
      const payload = typeof window !== 'undefined' ? readPageGlobals() : undefined;
      if (!payload || payload.ok !== true) return null;
      const index = payload.index || {};
      return {
        phase: 'ready',
        error: '',
        relationshipVersion: String(payload.relationshipVersion || ''),
        loadedAt: Number(payload.loadedAt) || Date.now(),
        components: Array.isArray(index.components) ? index.components : [],
        tags: index.tags && typeof index.tags === 'object' ? index.tags : {},
        contents: payload.contents && typeof payload.contents === 'object' ? payload.contents : {},
        /** Kept so the ComputerUse lease can be read from the same snapshot. */
        payload,
        reindexError: String(payload.reindexError || ''),
        root: String(payload.root || ''),
        generatedAt: String(payload.generatedAt || ''),
      };
    }

    const listeners = new Set();
    let snapshot =
      readInjected() ?? {
        phase: 'loading',
        error: '',
        relationshipVersion: '',
        loadedAt: 0,
        components: [],
        tags: {},
        contents: {},
        payload: null,
        reindexError: '',
        root: '',
        generatedAt: '',
      };
    let generation = 0;
    let inflight = 0;

    function emit(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getSnapshot() {
      return snapshot;
    }

    function useMemoryLab() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /**
     * Take ONE snapshot, from the page global the Host half injected.
     *
     * Called only when the panel opens, when the user resets, and after the
     * reindex reload — never on a click, a tag navigation, a drag or a zoom, all
     * of which read the retained graph.
     */
    async function loadVisualization({ reason }) {
      if (inflight > 0) return;
      const token = ++generation;
      inflight += 1;
      emit({ phase: 'loading', error: '', reason });
      try {
        const payload = typeof window !== 'undefined' ? readPageGlobals() : undefined;
        if (!payload) {
          throw new Error(
            `the page global ${SNAPSHOT_GLOBAL} is absent: the Host half's index injection did not run. Reload once after enabling the plugin, and check the Host log for a failed injection.`,
          );
        }
        if (payload.ok !== true) throw new Error(String(payload.error || 'the Host half reported no snapshot'));
        if (token !== generation) return; // superseded: a newer snapshot owns the panel
        const index = payload.index || {};
        emit({
          phase: 'ready',
          error: '',
          relationshipVersion: String(payload.relationshipVersion || ''),
          loadedAt: Number(payload.loadedAt) || Date.now(),
          components: Array.isArray(index.components) ? index.components : [],
          tags: index.tags && typeof index.tags === 'object' ? index.tags : {},
          contents: payload.contents && typeof payload.contents === 'object' ? payload.contents : {},
          root: String(payload.root || ''),
          generatedAt: String(payload.generatedAt || ''),
          reindexError: String(payload.reindexError || ''),
          payload,
          reason,
        });
      } catch (error) {
        if (token !== generation) return;
        emit({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
          reason,
        });
      } finally {
        inflight -= 1;
      }
    }

    /**
     * Reindex, then refresh the page.
     *
     * The deterministic rebuild belongs to the Host half and runs while it
     * renders the page index, so the honest client-side action is to ask for
     * that rebuild by reloading and let the fresh snapshot arrive through the
     * same index injection everything else uses. Nothing is faked: if the
     * rebuild fails on the Host half, the next snapshot carries `reindexError`
     * and the panel reports it.
     */
    function reindex() {
      emit({ reindexing: true, error: '' });
      if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
        window.location.reload();
        return;
      }
      emit({ reindexing: false, error: 'this environment cannot reload the page; run memory_lab_reindex on the Host side instead' });
    }

    /* -------------------------------------------------------------- derivation */

    /** Tag names present as nodes, sorted, matching the parent's tag dictionary. */
    function tagNames(tags) {
      return Object.keys(tags || {}).sort();
    }

    function tagOf(tags, name) {
      const value = tags?.[name];
      return value && typeof value === 'object'
        ? {
            parents: Array.isArray(value.parents) ? value.parents.filter((p) => !!tags[p]) : [],
            children: Array.isArray(value.children) ? value.children.filter((c) => !!tags[c]) : [],
            components: Array.isArray(value.components) ? value.components : [],
            aliases: Array.isArray(value.aliases) ? value.aliases : [],
          }
        : { parents: [], children: [], components: [], aliases: [] };
    }

    /** Root tags: no parent that still exists — the parent's own definition. */
    function rootTags(tags) {
      return tagNames(tags).filter((name) => tagOf(tags, name).parents.length === 0);
    }

    function componentOf(components, slug) {
      return (components || []).find((entry) => entry && entry.slug === slug) || null;
    }

    function formatTime(ms) {
      if (!ms) return '—';
      const date = new Date(ms);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    }

    /* ------------------------------------------------------------- overview view */

    /**
     * The overview's core rendering, ported completely.
     *
     * Everything the Newmark overview does is here: the anchor/root/tag/leaf/addon
     * classification and radial seeding, the two edge kinds, the bounded rotating
     * repulsion with per-kind springs and ambient drift at 72% velocity retention,
     * the 50 ms dirty-frame scheduler, the 0.28 zoom-dots threshold, the four focus
     * modes, camera pan with a synchronous compositor transform, pointer-anchored
     * wheel zoom, toggleable selection and the dot-mode tooltip.
     *
     * It renders imperatively inside a thin React wrapper on purpose: a declarative
     * re-render per frame would reconcile every node and both paths of every edge on
     * every tick and visibly stutter on a large graph.
     */

    const OVERVIEW = {
      /** Root tags seed on the inner ellipse; everything else on the outer one. */
      ROOT_RX: 240,
      ROOT_RY: 184,
      TAG_RX: 330,
      TAG_RY: 248,
      /** Components sit on the widest ellipse with a phase offset. */
      COMPONENT_RX: 390,
      COMPONENT_RY: 280,
      COMPONENT_PHASE: 0.35,
      /** Repulsion samples at most this many rotating peers per node per frame. */
      FANOUT_MAX: 24,
      /** Pair force softening and strength. */
      SOFTENING: 700,
      REPULSION: 52000,
      /** Per-kind spring rest length, hard length and stiffness. */
      SPRING: {
        anchor: { wanted: 220, maxLen: 310, k: 0.018 },
        component: { wanted: 135, maxLen: 220, k: 0.018 },
        child: { wanted: 165, maxLen: 250, k: 0.018 },
      },
      /** Velocity retention per step: 0.72 keeps 72%, doubling the older damping. */
      RETENTION: 0.72,
      /** Ambient drift keeps the graph visibly alive instead of converging. */
      DRIFT_PHASE: 0.00075,
      DRIFT_MAG: 0.045,
      DRIFT_PULL: 0.0007,
      DRIFT_GOLDEN: 1.618,
      /** Frame budget: ~20 FPS, and unthrottled while the user is panning. */
      FRAME_INTERVAL_MS: 50,
      /** Below this scale every node collapses to a coloured dot. */
      DOT_SCALE: 0.28,
      /** Auto-centring step per frame while a focus is held and the camera is not manual. */
      CENTER_STEP: 0.06,
    };

    const FOCUS_MODES = ['both', 'parents', 'children', 'direct'];

    /**
     * Build the graph: anchor at the origin, root tags on the inner ellipse, every
     * other tag on the outer ellipse, components on the widest one, with
     * `'child'` edges for anchor→root and parent→tag and `'component'` edges for
     * tag→component. Edge ids are namespaced `anchor` / `tag:<t>` / `component:<s>`.
     */
    function buildOverviewGraph(tags, components) {
      const tagNames = Object.keys(tags || {}).sort();
      const nodes = [{ id: 'anchor', name: 'Memory Lab', type: 'Anchor', cls: 'anchor', x: 0, y: 0, vx: 0, vy: 0, fixed: true }];
      const edges = [];
      const exists = (tag) => Boolean(tags && tags[tag]);

      for (let i = 0; i < tagNames.length; i += 1) {
        const tag = tagNames[i];
        const node = tagOf(tags, tag);
        const parents = node.parents.filter(exists);
        const children = node.children.filter(exists);
        const cls = parents.length ? (children.length ? 'tag' : 'leaf') : 'root';
        const ring = parents.length ? 2 : 1;
        const angle = (i / Math.max(1, tagNames.length)) * Math.PI * 2;
        nodes.push({
          id: `tag:${tag}`,
          name: tag,
          tag,
          type: cls === 'root' ? 'Root tag' : 'Tag',
          cls,
          x: Math.cos(angle) * (150 + ring * 90),
          y: Math.sin(angle) * (120 + ring * 64),
          vx: 0,
          vy: 0,
        });
        if (!parents.length) edges.push(['anchor', `tag:${tag}`, 'child']);
        for (const parent of parents) edges.push([`tag:${parent}`, `tag:${tag}`, 'child']);
        for (const slug of [...node.components].filter((s) => componentOf(components, s)).sort()) {
          edges.push([`tag:${tag}`, `component:${slug}`, 'component']);
        }
      }

      const total = (components || []).length;
      for (let j = 0; j < total; j += 1) {
        const entry = components[j];
        const angle = ((j + OVERVIEW.COMPONENT_PHASE) / Math.max(1, total)) * Math.PI * 2;
        nodes.push({
          id: `component:${entry.slug}`,
          name: String(entry.name || entry.slug),
          slug: entry.slug,
          type: 'Component',
          cls: 'addon',
          x: Math.cos(angle) * OVERVIEW.COMPONENT_RX,
          y: Math.sin(angle) * OVERVIEW.COMPONENT_RY,
          vx: 0,
          vy: 0,
        });
      }

      const incoming = new Map();
      const outgoing = new Map();
      for (let index = 0; index < edges.length; index += 1) {
        const [from, to] = edges[index];
        if (!incoming.has(to)) incoming.set(to, []);
        incoming.get(to).push(index);
        if (!outgoing.has(from)) outgoing.set(from, []);
        outgoing.get(from).push(index);
      }
      return { nodes, edges, incoming, outgoing, tagCount: tagNames.length, componentCount: total };
    }

    /**
     * The four focus modes. `parents` walks inbound edges recursively, `children`
     * walks outbound ones, `direct` is one hop each way and `both` is the default.
     */
    function overviewFocus(graph, focusId, mode) {
      if (!focusId) return null;
      const nodeIds = new Set([focusId]);
      const edgeIdxs = new Set();
      const parents = new Set();
      const children = new Set();

      const walk = (lookup, collect, recursive) => {
        const queue = [focusId];
        const seen = new Set([focusId]);
        while (queue.length) {
          const current = queue.shift();
          for (const index of lookup.get(current) || []) {
            const [from, to] = graph.edges[index];
            const next = from === current ? to : from;
            edgeIdxs.add(index);
            collect.add(index);
            if (recursive && !seen.has(next)) {
              seen.add(next);
              nodeIds.add(next);
              queue.push(next);
            }
          }
        }
      };

      if (mode === 'parents') walk(graph.incoming, parents, true);
      else if (mode === 'children') walk(graph.outgoing, children, true);
      else if (mode === 'direct') {
        walk(graph.incoming, parents, false);
        walk(graph.outgoing, children, false);
      } else {
        walk(graph.incoming, parents, true);
        walk(graph.outgoing, children, true);
      }
      return { nodeIds, edgeIdxs, parents, children };
    }

    /** The overview's own styles; DSH tokens, no Newmark material reproduced. */
    const OVERVIEW_CSS = `
.ml-stage { position: relative; flex: 1; min-width: 0; overflow: hidden; contain: strict; cursor: grab; touch-action: none; }
.ml-stage:active { cursor: grabbing; }
.ml-stage-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
/* An untracked link is a plain white line. A tracked one is coloured by what it
   connects: the parent chain amber, the subtree green. Order matters — the child
   and parent rules come after hot so their stroke wins over the base, and the
   child rule comes last so a subtree link is green and not amber. */
.ml-edge { fill: none; stroke-width: 1; stroke: var(--dsw-alias-label-primary); stroke-linecap: round; opacity: .5; }
.ml-edge.dim { opacity: .08; }
.ml-edge.hot { stroke-width: 1.45; opacity: .9; }
.ml-edge.parent { stroke: var(--dsw-alias-state-warn-primary); }
.ml-edge.child { stroke: var(--dsw-alias-state-success-primary); }
.ml-flow { fill: none; stroke-width: 1.7; stroke-dasharray: 16 760; stroke: var(--dsw-alias-brand-primary); animation: ml-flow 0.95s linear infinite; }
.ml-flow.parent { stroke: var(--dsw-alias-state-warn-primary); }
.ml-flow.child { stroke: var(--dsw-alias-state-success-primary); }
@keyframes ml-flow { to { stroke-dashoffset: -210; } }
.ml-nodes { position: absolute; inset: 0; }
.ml-ovnode { position: absolute; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px 0 7px; max-width: 150px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 11px; white-space: nowrap; transform: translate(-50%, -50%); cursor: pointer; transition: opacity 150ms cubic-bezier(0.16,1,0.3,1), border-color 150ms cubic-bezier(0.16,1,0.3,1); }
.ml-ovnode.anchor { height: 32px; border-color: var(--dsw-alias-brand-primary); }
.ml-ovnode.dim { opacity: .18; }
.ml-ovnode.focus { border-color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 22%, transparent); }
.ml-ovdot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-brand-primary); }
.ml-ovnode.root .ml-ovdot, .ml-ovnode.anchor .ml-ovdot { background: var(--dsw-alias-state-warn-primary); }
.ml-ovnode.leaf .ml-ovdot { background: var(--dsw-alias-state-success-primary); }
.ml-ovnode.addon .ml-ovdot { background: var(--dsw-alias-label-secondary); }
.ml-stage.zoom-dots .ml-ovnode { width: 10px; height: 10px; padding: 0; border: 0; background: transparent; box-shadow: none; }
.ml-stage.zoom-dots .ml-ovnode .ml-ovdot { width: 10px; height: 10px; }
.ml-stage.zoom-dots .ml-ovlabel { display: none; }
.ml-tip { position: absolute; z-index: 3; min-width: 130px; max-width: 220px; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); pointer-events: none; opacity: 0; transition: opacity 150ms cubic-bezier(0.16,1,0.3,1); }
.ml-tip.show { opacity: 1; }
.ml-tip-name { font-size: 12px; font-weight: 700; }
.ml-tip-type { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ml-ohead { position: absolute; top: 10px; left: 10px; right: 10px; z-index: 4; display: flex; align-items: center; gap: 8px; justify-content: space-between; pointer-events: none; }
.ml-ochip { padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ml-oactions { display: flex; gap: 6px; align-items: center; pointer-events: auto; }
.ml-oactions select { height: 26px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; }
`;

    /** A panel-level selection expressed as the overview's node id. */
    function selectionToNodeId(selection) {
      if (!selection || typeof selection !== 'object') return '';
      if (selection.kind === 'tag' && selection.tag) return `tag:${selection.tag}`;
      if (selection.kind === 'component' && selection.slug) return `component:${selection.slug}`;
      return '';
    }

    function OverviewView({ state, selection, onFocus, onActivate }) {
      const stageRef = React.useRef(null);
      const svgRef = React.useRef(null);
      const nodeLayerRef = React.useRef(null);
      const tipRef = React.useRef(null);
      const apiRef = React.useRef(null);
      // Held in refs so a panel re-render never rebuilds the graph or the camera.
      const focusRef = React.useRef(onFocus);
      focusRef.current = onFocus;
      const activateRef = React.useRef(onActivate);
      activateRef.current = onActivate;

      const [mode, setMode] = React.useState('both');
      const [focusId, setFocusId] = React.useState('');
      // The engine reads the mode through this ref. It is deliberately not an
      // effect dependency: the mode only changes which edges are highlighted, and
      // rebuilding the engine for that would discard the tracked node — which is
      // exactly the bug where switching 父链/子树 lost the tracking.
      const modeRef = React.useRef(mode);
      modeRef.current = mode;
      const [scaleLabel, setScaleLabel] = React.useState(Math.round(CAMERA_DEFAULT * 100));

      const graphData = React.useMemo(
        () => buildOverviewGraph(state.tags, state.components),
        // Rebuilt only when the graph actually changes, never per frame.
        [state.relationshipVersion, state.components.length, Object.keys(state.tags).length],
      );

      // Build the graph once per (graph, mode): DOM, listeners, physics, scheduler.
      React.useEffect(() => {
        const stage = stageRef.current;
        const svg = svgRef.current;
        const layer = nodeLayerRef.current;
        if (!stage || !svg || !layer) return undefined;

        const graph = graphData;
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
        const camera = { x: 0, y: 0, scale: CAMERA_DEFAULT };
        let focus = '';
        let panActive = false;
        let manualCamera = false;
        let running = true;
        let frameRunning = false;
        let lastFrame = 0;
        let repulsionOffset = 1;
        let cameraInitialised = false;

        // --- DOM: created once, then only mutated. No per-frame reconciliation.
        svg.replaceChildren();
        layer.replaceChildren();
        const edgePaths = graph.edges.map(() => {
          const base = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          base.setAttribute('class', 'ml-edge');
          const flow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          flow.setAttribute('class', 'ml-flow');
          flow.style.display = 'none';
          svg.appendChild(base);
          svg.appendChild(flow);
          return { base, flow };
        });
        const nodeEls = new Map();
        for (const node of graph.nodes) {
          const el = document.createElement('div');
          el.className = `ml-ovnode ${node.cls}`;
          el.tabIndex = 0;
          el.setAttribute('role', 'button');
          el.setAttribute('aria-label', `${node.type}: ${node.name}`);
          const dot = document.createElement('span');
          dot.className = 'ml-ovdot';
          const label = document.createElement('span');
          label.className = 'ml-ovlabel';
          label.textContent = node.name;
          el.append(dot, label);
          el.addEventListener('click', () => {
            const picked = node.slug ? { kind: 'component', slug: node.slug } : { kind: 'tag', tag: node.tag };
            // Second click on the node that is already tracked: open its detail.
            if (focus === node.id) {
              activateRef.current?.(picked);
              return;
            }
            // First click tracks the node and stays in the overview, so a single
            // click selects and a second one drills in.
            focus = node.id;
            setFocusId(node.id);
            manualCamera = false;
            focusRef.current?.(picked);
            requestFrame();
          });
          const showTip = () => {
            if (camera.scale >= OVERVIEW.DOT_SCALE || !tipRef.current) return;
            const stageRect = stage.getBoundingClientRect();
            const left = Math.max(8, Math.min(stageRect.width - tipRef.current.offsetWidth - 22, screenOf(node).x - stageRect.left));
            const top = Math.max(tipRef.current.offsetHeight / 2 + 8, Math.min(stageRect.height - tipRef.current.offsetHeight / 2 - 8, screenOf(node).y - stageRect.top));
            tipRef.current.style.left = `${left}px`;
            tipRef.current.style.top = `${top}px`;
            tipRef.current.querySelector('.ml-tip-name').textContent = node.name;
            tipRef.current.querySelector('.ml-tip-type').textContent = node.type;
            tipRef.current.classList.add('show');
          };
          const hideTip = () => tipRef.current?.classList.remove('show');
          el.addEventListener('mouseenter', showTip);
          el.addEventListener('mouseleave', hideTip);
          el.addEventListener('focus', showTip);
          el.addEventListener('blur', hideTip);
          layer.appendChild(el);
          nodeEls.set(node.id, el);
        }

        // --- physics
        function step(timestamp) {
          for (const node of graph.nodes) {
            node.fx = 0;
            node.fy = 0;
          }
          const count = graph.nodes.length;
          const fanout = Math.min(OVERVIEW.FANOUT_MAX, Math.max(0, count - 1));
          for (let a = 0; a < count; a += 1) {
            const nodeA = graph.nodes[a];
            for (let sample = 1; sample <= fanout; sample += 1) {
              const b = (a + repulsionOffset + sample) % count;
              if (b === a) continue;
              const nodeB = graph.nodes[b];
              const dx = nodeA.x - nodeB.x;
              const dy = nodeA.y - nodeB.y;
              const d2 = dx * dx + dy * dy + OVERVIEW.SOFTENING;
              const d = Math.sqrt(d2);
              const force = OVERVIEW.REPULSION / d2;
              if (!nodeA.fixed) {
                nodeA.fx += (dx / d) * force;
                nodeA.fy += (dy / d) * force;
              }
              if (!nodeB.fixed) {
                nodeB.fx -= (dx / d) * force;
                nodeB.fy -= (dy / d) * force;
              }
            }
          }
          repulsionOffset = count > 1 ? ((repulsionOffset + fanout) % (count - 1)) + 1 : 1;

          for (const [from, to, kind] of graph.edges) {
            const a = nodeById.get(from);
            const b = nodeById.get(to);
            if (!a || !b) continue;
            const spec = from === 'anchor' ? OVERVIEW.SPRING.anchor : kind === 'component' ? OVERVIEW.SPRING.component : OVERVIEW.SPRING.child;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const spring = (Math.min(dist, spec.maxLen) - spec.wanted) * spec.k;
            const ux = (dx / dist) * spring;
            const uy = (dy / dist) * spring;
            if (!a.fixed) {
              a.fx += ux;
              a.fy += uy;
            }
            if (!b.fixed) {
              b.fx -= ux;
              b.fy -= uy;
            }
          }

          const ambientPhase = timestamp * OVERVIEW.DRIFT_PHASE;
          for (let i = 0; i < count; i += 1) {
            const node = graph.nodes[i];
            if (node.fixed) continue;
            node.fx += -node.x * OVERVIEW.DRIFT_PULL + Math.cos(ambientPhase + i * OVERVIEW.DRIFT_GOLDEN) * OVERVIEW.DRIFT_MAG;
            node.fy += -node.y * OVERVIEW.DRIFT_PULL + Math.sin(ambientPhase + i * OVERVIEW.DRIFT_GOLDEN) * OVERVIEW.DRIFT_MAG;
            node.vx = (node.vx + node.fx) * OVERVIEW.RETENTION;
            node.vy = (node.vy + node.fy) * OVERVIEW.RETENTION;
            node.x += node.vx;
            node.y += node.vy;
          }
        }

        function screenOf(node) {
          return { x: camera.x + node.x * camera.scale, y: camera.y + node.y * camera.scale };
        }

        // --- paint
        function paint() {
          const data = focus ? overviewFocus(graph, focus, modeRef.current) : null;
          const stageRect = stage.getBoundingClientRect();
          if (!cameraInitialised && stageRect.width > 0) {
            camera.x = stageRect.width / 2;
            camera.y = stageRect.height / 2;
            cameraInitialised = true;
          }
          if (data && !panActive && !manualCamera) {
            const focused = nodeById.get(focus);
            if (focused) {
              const point = screenOf(focused);
              camera.x += (stageRect.width / 2 - point.x) * OVERVIEW.CENTER_STEP;
              camera.y += (stageRect.height / 2 - point.y) * OVERVIEW.CENTER_STEP;
            }
          }
          const dots = camera.scale < OVERVIEW.DOT_SCALE;
          stage.classList.toggle('zoom-dots', dots);

          for (const node of graph.nodes) {
            const el = nodeEls.get(node.id);
            if (!el) continue;
            const point = screenOf(node);
            el.style.left = `${point.x.toFixed(1)}px`;
            el.style.top = `${point.y.toFixed(1)}px`;
            el.classList.toggle('focus', focus === node.id);
            el.classList.toggle('dim', Boolean(data) && !data.nodeIds.has(node.id));
          }

          for (let index = 0; index < graph.edges.length; index += 1) {
            const [from, to, kind] = graph.edges[index];
            const a = nodeById.get(from);
            const b = nodeById.get(to);
            const pair = edgePaths[index];
            if (!a || !b || !pair) continue;
            const pa = screenOf(a);
            const pb = screenOf(b);
            const d = `M ${pa.x.toFixed(1)} ${pa.y.toFixed(1)} L ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}`;
            let cls = 'ml-edge';
            if (data) {
              if (data.edgeIdxs.has(index)) {
                cls += ' hot';
                if (data.parents.has(index)) cls += ' parent';
                if (data.children.has(index)) cls += ' child';
              } else cls += ' dim';
            }
            // Nothing tracked: every link stays the plain white base. Colouring by
            // the edge's own kind here is what made the whole graph green.
            pair.base.setAttribute('class', cls);
            pair.base.setAttribute('d', d);
            if (data && data.edgeIdxs.has(index)) {
              pair.flow.style.display = '';
              pair.flow.setAttribute('class', `ml-flow${data.parents.has(index) ? ' parent' : ''}${data.children.has(index) ? ' child' : ''}`);
              pair.flow.setAttribute('d', d);
            } else {
              pair.flow.style.display = 'none';
            }
          }
        }

        // --- the one frame scheduler
        //
        // The layout is time-driven and never converges: ambient drift keeps the
        // graph visibly alive, so the loop steps and paints on its interval for as
        // long as the stage is mounted. Physics is suspended while the user drags —
        // the graph pauses under the hand — but the drag's own paint still runs so
        // the camera transform lands. A hidden document does no work at all and
        // picks straight back up when it is visible again.
        function frame(timestamp) {
          if (!running) {
            frameRunning = false;
            return;
          }
          if (!document.hidden) {
            const budget = panActive ? 0 : OVERVIEW.FRAME_INTERVAL_MS;
            if (budget === 0 || timestamp - lastFrame >= budget) {
              lastFrame = timestamp;
              if (!panActive) step(timestamp);
              paint();
            }
          }
          requestAnimationFrame(frame);
        }

        /** Start the loop if it is idle, and force the next frame to run immediately. */
        function requestFrame() {
          if (!running) return;
          lastFrame = 0;
          if (!frameRunning) {
            frameRunning = true;
            requestAnimationFrame(frame);
          }
        }

        // --- camera: pan, zoom
        let drag = null;
        let panRenderX = 0;
        let panRenderY = 0;
        function onPointerDown(event) {
          if (event.target.closest('.ml-ovnode') || event.target.closest('.ml-oactions')) return;
          drag = { px: event.clientX, py: event.clientY, x: camera.x, y: camera.y };
          panActive = true;
          manualCamera = true;
          panRenderX = 0;
          panRenderY = 0;
          stage.setPointerCapture?.(event.pointerId);
        }
        function onPointerMove(event) {
          if (!drag) return;
          camera.x = drag.x + (event.clientX - drag.px);
          camera.y = drag.y + (event.clientY - drag.py);
          panRenderX = camera.x - drag.x;
          panRenderY = camera.y - drag.y;
          // The drag's own transform is applied synchronously so it never lags.
          const transform = `translate3d(${panRenderX}px, ${panRenderY}px, 0)`;
          svg.style.transform = transform;
          layer.style.transform = transform;
          requestFrame();
        }
        function endPan() {
          drag = null;
          panActive = false;
          svg.style.transform = '';
          layer.style.transform = '';
          requestFrame();
        }
        function onWheel(event) {
          event.preventDefault();
          const rect = stage.getBoundingClientRect();
          const previous = camera.scale;
          const next = Math.min(10000, Math.max(0.0001, previous * Math.exp(-event.deltaY * 0.0009)));
          const clientX = event.clientX - rect.left;
          const clientY = event.clientY - rect.top;
          camera.x = clientX - (clientX - camera.x) * (next / previous);
          camera.y = clientY - (clientY - camera.y) * (next / previous);
          camera.scale = next;
          manualCamera = true;
          setScaleLabel(Math.round(next * 100));
          requestFrame();
        }

        stage.addEventListener('pointerdown', onPointerDown);
        stage.addEventListener('pointermove', onPointerMove);
        stage.addEventListener('pointerup', endPan);
        stage.addEventListener('pointercancel', endPan);
        stage.addEventListener('lostpointercapture', endPan);
        stage.addEventListener('wheel', onWheel, { passive: false });
        const onVisibility = () => {
          if (!document.hidden) requestFrame();
        };
        document.addEventListener('visibilitychange', onVisibility);

        apiRef.current = {
          focus: (id) => {
            focus = id;
            manualCamera = false;
            requestFrame();
          },
          reset: () => {
            const rect = stage.getBoundingClientRect();
            camera.x = rect.width / 2;
            camera.y = rect.height / 2;
            camera.scale = CAMERA_DEFAULT;
            manualCamera = false;
            setScaleLabel(Math.round(CAMERA_DEFAULT * 100));
            requestFrame();
          },
          clear: () => {
            focus = '';
            manualCamera = true;
            requestFrame();
          },
          /** Repaint without touching the graph, the camera or the tracking. */
          repaint: () => requestFrame(),
        };
        requestFrame();

        return () => {
          running = false;
          frameRunning = false;
          stage.removeEventListener('pointerdown', onPointerDown);
          stage.removeEventListener('pointermove', onPointerMove);
          stage.removeEventListener('pointerup', endPan);
          stage.removeEventListener('pointercancel', endPan);
          stage.removeEventListener('lostpointercapture', endPan);
          stage.removeEventListener('wheel', onWheel);
          document.removeEventListener('visibilitychange', onVisibility);
          svg.replaceChildren();
          layer.replaceChildren();
        };
      }, [graphData]);

      // A mode change repaints the existing engine so the new highlight lands on
      // the node that is already tracked; it never rebuilds.
      React.useEffect(() => {
        apiRef.current?.repaint();
      }, [mode]);

      // A selection made elsewhere (search, detail view) drives the overview focus.
      React.useEffect(() => {
        const id = selectionToNodeId(selection);
        if (!id) return;
        setFocusId(id);
        apiRef.current?.focus(id);
      }, [selection]);

      const focusLabel = focusId ? `选中：${focusId.replace(/^(tag|component):/, '')}` : '未选中';

      return h(
        'div',
        { className: 'ml-stage', ref: stageRef },
        h('style', null, OVERVIEW_CSS),
        h('svg', { className: 'ml-stage-svg', ref: svgRef, role: 'img', 'aria-label': 'Memory Lab overview' }),
        h('div', { className: 'ml-nodes', ref: nodeLayerRef }),
        h(
          'div',
          { className: 'ml-ohead' },
          h(
            'div',
            { className: 'ml-ochip' },
            `记忆 Tag 图谱 · ${graphData.tagCount} 标签 · ${graphData.componentCount} 记忆组件 · ${focusLabel}`,
          ),
          h(
            'div',
            { className: 'ml-oactions' },
            h(
              'select',
              { value: mode, 'aria-label': 'Focus mode', onChange: (event) => setMode(event.target.value) },
              h('option', { value: 'both' }, '双向'),
              h('option', { value: 'parents' }, '父链'),
              h('option', { value: 'children' }, '子树'),
              h('option', { value: 'direct' }, '直接'),
            ),
            h('span', { className: 'ml-ochip' }, `${scaleLabel}%`),
            h('button', { className: 'ml-btn', type: 'button', onClick: () => apiRef.current?.clear() }, '取消'),
            h('button', { className: 'ml-btn', type: 'button', onClick: () => apiRef.current?.reset() }, '重置'),
          ),
        ),
        h(
          'div',
          { className: 'ml-tip', ref: tipRef },
          h('div', { className: 'ml-tip-name' }),
          h('div', { className: 'ml-tip-type' }),
        ),
      );
    }

    /* --------------------------------------------------------------- detail view */

    function DetailView({ state, selection, onSelect }) {
      const tags = state.tags;
      const components = state.components;
      const names = tagNames(tags);
      const selectedTag = selection?.kind === 'tag' && tags[selection.tag] ? selection.tag : names[0] || '';
      const node = tagOf(tags, selectedTag);
      const parents = node.parents;
      const children = node.children;
      const roots = rootTags(tags);
      const parentColumn = parents.length ? parents : roots;
      const listed =
        selection?.kind === 'component'
          ? components.filter((entry) => entry.slug === selection.slug)
          : selectedTag
            ? components.filter((entry) => (entry.tags || []).includes(selectedTag))
            : components;
      const selected =
        selection?.kind === 'component' && componentOf(components, selection.slug)
          ? componentOf(components, selection.slug)
          : listed[0] || components[0] || null;
      const content = selected ? state.contents[selected.slug] || '' : '';

      function TagButton({ name, selected: isSelected }) {
        const value = tagOf(tags, name);
        return h(
          'button',
          {
            type: 'button',
            className: `ml-node${isSelected ? ' selected' : ''}`,
            onClick: () => onSelect({ kind: 'tag', tag: name }),
          },
          h('span', null, name),
          h('span', { className: 'ml-node-count' }, `${value.components.length}`),
        );
      }

      return h(
        'div',
        { style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } },
        h(
          'div',
          { className: 'ml-graph' },
          h(
            'div',
            { className: 'ml-col' },
            h('div', { className: 'ml-col-title' }, parents.length ? 'Parent tags' : 'Root tags'),
            parentColumn.length === 0 ? h('div', { className: 'ml-empty' }, 'No parent tags') : null,
            parentColumn.map((name) =>
              h(TagButton, { key: `p-${name}`, name, selected: !parents.length && name === selectedTag }),
            ),
          ),
          h(
            'div',
            { className: 'ml-col ml-center' },
            h('div', { className: 'ml-col-title' }, 'Selected tag'),
            selectedTag ? h(TagButton, { name: selectedTag, selected: true }) : h('div', { className: 'ml-empty' }, 'No tags yet'),
          ),
          h(
            'div',
            { className: 'ml-col' },
            h('div', { className: 'ml-col-title' }, 'Child tags'),
            children.length === 0 ? h('div', { className: 'ml-empty' }, 'No child tags') : null,
            children.map((name) => h(TagButton, { key: `c-${name}`, name, selected: false })),
            h('div', { className: 'ml-col-title', style: { marginTop: 10 } }, 'Components'),
            listed.length === 0 ? h('div', { className: 'ml-empty' }, 'No components in this tag') : null,
            listed.map((entry) =>
              h(
                'button',
                {
                  key: entry.slug,
                  type: 'button',
                  className: `ml-node${selected && selected.slug === entry.slug ? ' selected' : ''}`,
                  onClick: () => onSelect({ kind: 'component', slug: entry.slug }),
                },
                h('span', null, String(entry.name || entry.slug)),
                h('span', { className: 'ml-node-count' }, `rev ${entry.revision ?? 1}`),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ml-preview' },
          h(
            'div',
            { className: 'ml-preview-head' },
            h('div', { className: 'ml-preview-title' }, selected ? String(selected.name || selected.slug) : 'No component selected'),
            h(
              'div',
              { className: 'ml-preview-desc' },
              selected
                ? String(selected.description || '') || `${String(selected.kind || 'file')} · ${String(selected.bytes ?? 0)} bytes`
                : 'Select a component to read its Markdown.',
            ),
            selected
              ? h(
                  'div',
                  { className: 'ml-preview-tags' },
                  (selected.tags || []).map((tag) => h('span', { className: 'ml-tag', key: tag }, tag)),
                )
              : null,
          ),
          h('div', { className: 'ml-preview-body' }, h('pre', null, content || '暂无记忆')),
        ),
      );
    }

    /* ------------------------------------------------------------ search results */

    function SearchBox({ state, onSelect }) {
      const [query, setQuery] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const value = query.trim().toLowerCase();
      const tagHits = value ? tagNames(state.tags).filter((name) => name.toLowerCase().includes(value)).slice(0, 12) : [];
      const componentHits = value
        ? state.components
            .filter((entry) =>
              `${entry.name || ''} ${entry.slug || ''} ${entry.description || ''} ${(entry.tags || []).join(' ')}`
                .toLowerCase()
                .includes(value),
            )
            .slice(0, 12)
        : [];
      const total = tagHits.length + componentHits.length;

      return h(
        'div',
        { className: 'ml-search' },
        h('input', {
          value: query,
          placeholder: '搜索标签或记忆组件…',
          'aria-label': 'Search Memory Lab',
          onFocus: () => setOpen(true),
          onBlur: () => setTimeout(() => setOpen(false), 120),
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') setQuery('');
            if (event.key === 'Enter' && total > 0) {
              const first = tagHits[0] ? { kind: 'tag', tag: tagHits[0] } : { kind: 'component', slug: componentHits[0].slug };
              onSelect(first);
              setOpen(false);
            }
          },
        }),
        open && value && total > 0
          ? h(
              'div',
              { className: 'ml-results' },
              tagHits.map((name) =>
                h(
                  'button',
                  {
                    key: `t-${name}`,
                    type: 'button',
                    className: 'ml-result',
                    onMouseDown: () => {
                      onSelect({ kind: 'tag', tag: name });
                      setOpen(false);
                    },
                  },
                  name,
                  h('span', { className: 'ml-result-kind' }, `tag · ${tagOf(state.tags, name).components.length}`),
                ),
              ),
              componentHits.map((entry) =>
                h(
                  'button',
                  {
                    key: `c-${entry.slug}`,
                    type: 'button',
                    className: 'ml-result',
                    onMouseDown: () => {
                      onSelect({ kind: 'component', slug: entry.slug });
                      setOpen(false);
                    },
                  },
                  String(entry.name || entry.slug),
                  h('span', { className: 'ml-result-kind' }, 'component'),
                ),
              ),
            )
          : null,
      );
    }

    /* -------------------------------------------------------------------- panel */

    function MemoryLabPanel() {
      const state = useMemoryLab();
      const [view, setView] = React.useState('overview');
      const [selection, setSelection] = React.useState(null);

      // ONE snapshot, on open. Every later interaction reads it.
      React.useEffect(() => {
        loadVisualization({ reason: 'open' });
      }, []);

      const tagCount = tagNames(state.tags).length;
      const componentCount = state.components.length;
      const status =
        state.phase === 'ready'
          ? `${tagCount} 标签 · ${componentCount} 组件 · ${state.relationshipVersion.slice(0, 12)} · 快照生成于 ${formatTime(Date.parse(state.generatedAt) || state.loadedAt)}${state.reindexError ? ` · 重建告警：${state.reindexError}` : ''}`
          : state.phase === 'loading'
            ? '正在载入 Memory Lab…'
            : `Host 半侧未提供快照：${state.error}`;

      return h(
        'div',
        { className: `ml-root${state.reindexing ? ' ml-busy' : ''}`, 'aria-busy': state.reindexing ? 'true' : 'false' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'ml-topbar' },
          h(
            'div',
            { className: 'ml-tabs', role: 'tablist' },
            h(
              'button',
              { type: 'button', className: `ml-tab${view === 'overview' ? ' active' : ''}`, onClick: () => setView('overview') },
              '总览',
            ),
            h(
              'button',
              { type: 'button', className: `ml-tab${view === 'detail' ? ' active' : ''}`, onClick: () => setView('detail') },
              '详情',
            ),
          ),
          h(SearchBox, { state, onSelect: (next) => { setSelection(next); setView('detail'); } }),
          h('div', { className: 'ml-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'ml-btn',
              disabled: state.phase === 'loading',
              onClick: () => loadVisualization({ reason: 'reset' }),
            },
            '重置',
          ),
          h(
            'button',
            { type: 'button', className: 'ml-btn', disabled: !!state.reindexing, onClick: reindex, title: '完成重建后刷新页面' },
            state.reindexing ? '重建中，正在刷新…' : '重建索引',
          ),
        ),
        state.phase === 'ready' && componentCount === 0 && tagCount === 0
          ? h(
              'div',
              { className: 'ml-body' },
              h(
                'div',
                { style: { padding: 24, maxWidth: 560 } },
                h('div', { className: 'ml-preview-title' }, 'Memory Lab 已就绪，尚无记忆组件'),
                h(
                  'div',
                  { className: 'ml-preview-desc', style: { marginTop: 8 } },
                  '当前还没有任何记忆组件。模型可通过 memory_lab_update 写入第一条持久记忆；写入完成并重建索引后，这里会显示标签图谱与组件内容。',
                ),
              ),
            )
          : h(
              'div',
              { className: 'ml-body' },
              state.phase === 'ready'
                ? view === 'overview'
                  ? h(OverviewView, {
                      state,
                      selection,
                      onFocus: (next) => setSelection(next),
                      onActivate: (next) => {
                        setSelection(next);
                        setView('detail');
                      },
                    })
                  : h(DetailView, { state, selection, onSelect: setSelection })
                : h(
                    'div',
                    { style: { padding: 24 } },
                    h('div', { className: 'ml-preview-desc' }, status),
                  ),
            ),
        h(
          'div',
          { className: 'ml-status', 'data-state': state.phase },
          h('span', { className: 'ml-dot' }),
          status,
        ),
      );
    }

    /**
     * The left-column button artwork: Newmark's own MemoryLab icon.
     *
     * Newmark draws this entry with `lucide-sprite.svg#brain` at 24 units with
     * 2-unit strokes, so the plugin carries the same Lucide `brain` geometry
     * verbatim rather than approximating it with a hand-drawn glyph. The sidebar
     * owns the geometry; this owns the mark.
     */
    function MemoryLabIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        // Verbatim from Newmark's lucide-sprite.svg#brain, in source order.
        h('path', { d: 'M12 18V5' }),
        h('path', { d: 'M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4' }),
        h('path', { d: 'M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5' }),
        h('path', { d: 'M17.997 5.125a4 4 0 0 1 2.526 5.77' }),
        h('path', { d: 'M18 18a4 4 0 0 0 2-7.464' }),
        h('path', { d: 'M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517' }),
        h('path', { d: 'M6 18a4 4 0 0 1-2-7.464' }),
        h('path', { d: 'M6.003 5.125a4 4 0 0 0-2.526 5.77' }),
      );
    }


    /* ------------------------------------------------------------------- plugin */

    return {
      inject: ['slots'],
      apply(ctx) {
        // The two component switches, read from the same injected snapshot the
        // panel reads. The injection lands in <head> before the plugin loader
        // boots, so it is already present here. If it is absent the component
        // stays registered and the panel reports the missing snapshot itself,
        // rather than a feature vanishing with no explanation.
        const switches = (() => {
          const injected = typeof window !== 'undefined' ? readPageGlobals() : undefined;
          const source =
            injected && typeof injected.components === 'object' && injected.components ? injected.components : null;
          return {
            memoryLab: !source || source.memoryLab !== false,
            computerUse: !source || source.computerUse !== false,
          };
        })();

        // MemoryLab owns the sidebar entry and the presentation window. With the
        // component switched off, neither seat is registered at all.
        if (switches.memoryLab) {
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.panellist', () =>
                ctx.slots.register(
                  { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'Memory Lab' },
                  MemoryLabIcon,
                ),
              ),
            'newmark-core-sidebar-entry',
          );

          ctx.effect(
            () =>
              ctx.slots.inject('main', () =>
                ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryLabPanel),
              ),
            'newmark-core-main-panel',
          );
        }

        /** Panel styles. Theme tokens only, so both colour schemes follow the shell. */
        const CONFIG_CSS = `
    .nmc-config { display: flex; flex-direction: column; gap: 10px; }
    .nmc-config-head { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
    .nmc-config-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .nmc-config-row {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto auto;
      grid-template-areas: "dot text state action" ". note note note";
      align-items: center;
      gap: 4px 10px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--dsw-alias-bg-elevated);
      border: 1px solid var(--dsw-alias-border-secondary);
    }
    .nmc-config-switch {
      grid-area: action;
      font: inherit;
      font-size: 12px;
      padding: 3px 12px;
      border-radius: 999px;
      cursor: pointer;
      color: var(--dsw-alias-label-primary);
      background: transparent;
      border: 1px solid var(--dsw-alias-border-secondary);
    }
    .nmc-config-switch:hover:not(:disabled) { border-color: var(--dsw-alias-label-primary); }
    .nmc-config-switch:disabled { opacity: 0.45; cursor: default; }
    /* The plugin page has no slot for suppressing its own component rows: that section
       is rendered unconditionally from the bundle's row list, and the "hidden" slots
       filter the plugin LIST page, not a bundle's page.

       An adjacent-sibling rule was tried first and did not work, which means the slot
       renders this panel inside a wrapper and the rows section is not its sibling. So
       this rule is unscoped instead, and its scoping comes from where the style tag
       lives: the tag is rendered by this component, so it is in the DOM only while this
       panel is mounted, and the plugin page shows one bundle at a time. No other
       plugin's rows can be on screen while this rule is.

       The panel above replaces what it hides: it names the components and carries their
       switches, which those rows cannot do. */
    [data-plugin-rows] { display: none; }
    .nmc-config-dot { grid-area: dot; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
    .nmc-config-on { background: var(--dsw-alias-state-success-primary, #38a06a); }
    .nmc-config-text { grid-area: text; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .nmc-config-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
    .nmc-config-role { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
    .nmc-config-state { grid-area: state; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
    .nmc-config-note { grid-area: note; font-size: 12px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
    `;

        /**
         * The bundle's own configuration page.
         *
         * Registered into `plugins.bundle.config` under this package's name, which is the
         * seat the plugin card renders on the bundle's page. It exists because the rows the
         * card draws underneath are Loader bookkeeping — a row id and the module it resolved
         * to — and a module path is not something a person can act on. Here the components
         * appear by the names they are known by, each with the state that is true right now,
         * read from the same page globals the rest of this half uses.
         */
        function NewmarkConfigPanel() {
          const state = useMemoryLab();
          const payload = state && typeof state.payload === 'object' ? state.payload : null;
          const components = payload && typeof payload.components === 'object' && payload.components ? payload.components : {};
          const lease = payload && typeof payload.computerUse === 'object' && payload.computerUse ? payload.computerUse : null;

          // The Host half owns these switches, so what is shown is its answer — not the
          // click. A switch that only echoed the click would be a label.
          const [pending, setPending] = React.useState('');
          const [applied, setApplied] = React.useState({});
          const [loaded, setLoaded] = React.useState(false);

          React.useEffect(() => {
            let live = true;
            fetch('/newmark-core/components')
              .then((response) => response.json())
              .then((result) => {
                if (!live || !result || !Array.isArray(result.components)) return;
                const next = {};
                for (const entry of result.components) next[entry.name] = { ok: true, mounted: entry.mounted === true };
                setApplied((current) => ({ ...current, ...next }));
                setLoaded(true);
              })
              .catch(() => setLoaded(true));
            return () => {
              live = false;
            };
          }, []);

          const toggle = (key, next) => {
            setPending(key);
            fetch('/newmark-core/components', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ component: key, enabled: next }),
            })
              .then((response) => response.json())
              .then((result) => setApplied((current) => ({ ...current, [key]: result })))
              .catch((error) => setApplied((current) => ({ ...current, [key]: { ok: false, error: String(error) } })))
              .then(() => setPending(''));
          };

          const rows = [
            {
              key: 'core',
              name: 'Newmark Core',
              role: 'shared user store, page snapshot',
              on: Boolean(payload),
              note: payload && payload.root ? payload.root : 'no snapshot on this page',
              switchable: false,
            },
            {
              key: 'memoryLab',
              name: 'MemoryLab',
              role: 'durable memory, five memory_lab_* tools, sidebar renderer',
              on: components.memoryLab === true,
              note: components.memoryLab === true ? 'store mounted' : 'not loaded',
              switchable: true,
            },
            {
              key: 'computerUse',
              name: 'ComputerUse',
              role: '21 computer_use actions, native screen-wide takeover stroke',
              on: components.computerUse === true,
              note:
                components.computerUse === true
                  ? lease && lease.held
                    ? 'lease held by ' + (lease.ownerId || 'unknown')
                    : 'loaded, lease free'
                  : 'not loaded',
              switchable: true,
            },
            {
              key: 'presetDev',
              name: 'Dev preset',
              role: 'agent preset this bundle declares and selects',
              on: true,
              note: 'declared by this bundle; the active preset is chosen in Settings',
              switchable: true,
            },
          ];

          return h(
            'section',
            { className: 'nmc-config' },
            h('style', null, CONFIG_CSS),
            h('div', { className: 'nmc-config-head' }, '组件'),
            h(
              'ul',
              { className: 'nmc-config-list' },
              ...rows.map((row) => {
                const answer = applied[row.key];
                const on = answer && answer.ok === true && typeof answer.mounted === 'boolean' ? answer.mounted : row.on;
                const failed = answer && answer.ok === false;
                return h(
                  'li',
                  { key: row.key, className: 'nmc-config-row' },
                  h('span', { className: on ? 'nmc-config-dot nmc-config-on' : 'nmc-config-dot' }),
                  h(
                    'span',
                    { className: 'nmc-config-text' },
                    h('span', { className: 'nmc-config-name' }, row.name),
                    h('span', { className: 'nmc-config-role' }, row.role),
                  ),
                  h('span', { className: 'nmc-config-state' }, failed ? '切换失败' : on ? '运行中' : '已关闭'),
                  row.switchable
                    ? h(
                        'button',
                        {
                          className: 'nmc-config-switch',
                          type: 'button',
                          disabled: pending === row.key || !loaded,
                          'aria-pressed': on,
                          onClick: () => toggle(row.key, !on),
                        },
                        pending === row.key ? '…' : on ? '关闭' : '开启',
                      )
                    : null,
                  h(
                    'span',
                    { className: 'nmc-config-note' },
                    failed ? String(answer.error || 'failed') : row.note,
                  ),
                );
              }),
            ),
          );
        }

        // ------------------------------------------------------------ the config page
        //
        // This bundle owns its own page. The rows the card draws are Loader
        // bookkeeping: they name a row and the module it resolved to, which is the wrong
        // thing to show a person. The names that matter are the components, and what
        // matters about them is whether they are running — so they are rendered here, by
        // their product names, from the same page globals the rest of this half reads.
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register({ name: 'plugins.bundle.config', key: 'newmark2dsh' }, NewmarkConfigPanel),
            ),
          'newmark-core-config-panel',
        );

        // ComputerUse registers no sidebar entry, no panel and no overlay. The
        // takeover stroke is a native topmost click-through window that the Host half
        // owns and that covers the whole screen, because it must live outside the DSH
        // window entirely. Nothing about the takeover is rendered here, so nothing here
        // can be stale: the stroke appears when the lease is taken and disappears when
        // it ends, with no page load in between.
      },
    };
  },
});
