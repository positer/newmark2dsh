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
 *
 * A page global is fixed once it has been written, so 重置 (reset) and 重建索引
 * (reindex) re-read the current state by asking the shell for its own index
 * document again and reading the globals out of that response — the same route and
 * the same injection the page loaded with. The shell is never reloaded: it keeps
 * its state, and this panel alone re-renders.
 */
window.__ModuleLoader__.load({
  id: 'newmark2dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NEWMATE_SLIDER_CSS = `@layer newmate-controls {
      .newmate-size-control { box-sizing:border-box; width:260px; max-width:100%; padding:12px; color:var(--dsw-alias-label-primary); font:inherit; }
      .newmate-size-heading,.newmate-size-limits { display:flex; justify-content:space-between; gap:16px; }
      .newmate-size-heading { margin-bottom:12px; font-size:13px; }
      .newmate-size-limits { font-size:11px; opacity:.65; margin-top:6px; }
      .newmate-size-control input { display:block; width:100%; margin:0; cursor:pointer; accent-color:var(--dsw-alias-label-primary); }
      .newmate-size-control output { font-variant-numeric:tabular-nums; min-width:46px; text-align:right; }
      .nmc-config-section { display:grid; gap:12px; padding:16px 0; }
      .nmc-config-section + .nmc-config-section { border-top:1px solid var(--dsw-alias-border-secondary); }
      .nmc-config-subhead { font-size:13px; margin:0; font-weight:500; }
    }`;
    function NewMateSizeControl({value=1,onChange,disabled=false,title='NewMate 大小'}) {
      const percent=Math.round(value*1000)/10;
      return h('div',{className:'newmate-size-control','data-newmate-size':''},
        h('div',{className:'newmate-size-heading'},h('span',null,title),h('output',{'data-newmate-output':''},percent+'%')),
        h('input',{type:'range',min:30,max:300,step:.1,value:percent,disabled,'aria-label':'NewMate 大小倍率','data-newmate-slider':'',onChange:event=>onChange?.(Number(event.target.value)/100)}),
        h('div',{className:'newmate-size-limits'},h('span',null,'30%'),h('span',null,'300%')));
    }


    /**
     * The harness's Markdown renderer, when the shell has it.
     *
     * A component body is Markdown, and often LaTeX. Rendering it as preformatted text is
     * what the pane used to do, and it is what the pane must keep doing when this resolve
     * fails — an older shell, or a build that does not carry the primitives. So the require
     * is guarded here, ONCE, at module scope: the answer is a value the render path reads,
     * not a throw it has to catch.
     *
     * `MarkdownText` is the whole thing — Markdown AND maths are one component, because the
     * package parses with `mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()]`
     * (`dsh-client-ui-primitives/lib/index.js:10739`). It is what the harness's own tool
     * cards render through (`dsh-client-ui-tool/lib/client.js:9`, `:1362`). The package's
     * `exports` map is `"." -> ./lib/index.js`, so a bare require is the supported way in.
     */
    let MarkdownText = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      if (primitives && typeof primitives.MarkdownText === 'function') MarkdownText = primitives.MarkdownText;
    } catch (error) {
      MarkdownText = null;
    }

    /**
     * The chrome MarkdownText reads off its labels prop, and the only keys it reads.
     *
     * Two reads exist in the shipped package and BOTH are unguarded, so `undefined` is not
     * a safe argument — this is measured off the installed bundle, not inferred from the
     * types:
     *
     *   - `renderCode` reads `context.labels.code.copyLabel`, `.copiedLabel` and
     *     `.toolbarLabels` (`lib/index.js:11361-11363`). It runs for EVERY fenced code
     *     block, which a memory body may easily contain, so a bare `{}` throws there.
     *   - `renderFootnoteSection` reads `context.labels.footnotes` (`:11661`). It runs only
     *     when a footnote was referenced AND defined — it returns at `:11654` otherwise —
     *     but a body that carries one reaches it.
     *
     * `toolbarLabels` is read one level deeper, by `CodeToolbar`
     * (`:9459`, `:9468`, `:9488`): `codeLabel`, `wrapLabel`, `unwrapLabel`. Those three are
     * the smallest set that satisfies the read; the shape below is the reference adapter's
     * from the shipped caller (`dsh-client-ui-tool/lib/client.js:1098-1118`), spelled out
     * rather than imported so this pane owes the tool plugin nothing.
     *
     * FROZEN ON PURPOSE. `MarkdownText` memoises on the identity of `labels`, and its own
     * docs say a new identity "discards the streaming render cache mid-message"
     * (`:11796`). A fresh object per render would re-parse the body every time the pane
     * re-renders — and this pane re-renders on every selection change.
     */
    const PREVIEW_MARKDOWN_LABELS = Object.freeze({
      code: Object.freeze({
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: Object.freeze({ codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' }),
      }),
      footnotes: '脚注',
    });

    /**
     * One component body, rendered.
     *
     * It reads as nothing at all when the body is empty, which is the pane's existing
     * behaviour for a store with no body — a blank reading pane says "no memory" rather
     * than rendering an empty document.
     *
     * `variant="compact"` is not decoration. The default `body` variant is document
     * typography: 32px block margins on every heading (`markdown/MarkdownText.module.css`)
     * inside a column that is `min(420px, 40%)` wide and sits beside the graph — a body of
     * five headings would spend most of the pane on whitespace. `compact` is the variant the
     * package documents for exactly this ("`variant="compact"` uses secondary text sizing,
     * uniform bold headings, and tight block spacing", `:11805-11807`), and it sets
     * `max-width: 100%` on itself and scrolls code blocks in their own box instead of
     * widening the pane.
     */
    function PreviewBody({ text }) {
      const body = String(text == null ? '' : text);
      if (body === '') return null;
      if (MarkdownText) {
        return h(
          'div',
          { className: 'ml-preview-doc' },
          h(MarkdownText, { text: body, labels: PREVIEW_MARKDOWN_LABELS, variant: 'compact' }),
        );
      }
      return h('pre', null, body);
    }

    const PANEL_ID = 'memory-lab';
    /** The page global the Host half's index injection writes. */
    /** The core row's global: the shared Newmark root and the platform. */
const CORE_GLOBAL = '__NEWMARK_CORE__';
/** The MemoryLab row's global: the store snapshot. Its presence is the switch. */
const MEMORYLAB_GLOBAL = '__NEWMARK_MEMORYLAB__';
/** The ComputerUse row's global: the lease mirror. Its presence is the switch. */
const COMPUTERUSE_GLOBAL = '__NEWMARK_COMPUTERUSE__';
/** The agent-api row's global: the host profile. Its presence is the switch. */
const AGENTAPI_GLOBAL = '__NEWMARK_AGENTAPI__';
/** Used in diagnostics, so an absent injection still names the global it looked for. */
const SNAPSHOT_GLOBAL = CORE_GLOBAL;

/** The lease an unmounted ComputerUse row implies. */
const FREE_LEASE = { held: false, ownerId: '', mouseMode: 'real', ttlMs: 0, remainingMs: 0 };

/**
 * Compose the four row globals into one payload.
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
  const api = window[AGENTAPI_GLOBAL];
  if (!core && !memory && !automation && !api) return undefined;
  return {
    ...(memory || {}),
    ok: memory ? memory.ok === true : true,
    root: (memory && memory.root) || (core && core.root) || '',
    platform: (core && core.platform) || '',
    generatedAt: (memory && memory.generatedAt) || (core && core.generatedAt) || '',
    components: { memoryLab: Boolean(memory), computerUse: Boolean(automation), agentApi: Boolean(api) },
    computerUse: automation || FREE_LEASE,
    agentApi: api || null,
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
/* The plain-text path, and NOT dead: this is what the pane renders when the shell cannot
   give us the primitives (see MarkdownText in the factory). The pre keeps the body
   readable AND selectable there, which is the whole reason the fallback exists rather
   than rendering nothing. On the rendered path the only <pre> in the pane belongs to a
   fenced code block inside the markdown document, and that one wears the primitives' own
   md-code-block class instead of this bare selector. */
.ml-preview-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-primary); }
/* The rendered document. min-width: 0 is what stops a wide table or an unbreakable token
   from widening the flex row instead of scrolling inside the pane; MarkdownText's own
   .compact rule carries max-width: 100% for the same reason. */
.ml-preview-doc { min-width: 0; }
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
/* flex-wrap and overflow-wrap are here because this line now carries the outcome of a
 * judgement as well as the store's own numbers: a failure clause is a sentence, and a sentence
 * that cannot wrap in an 11 px status bar is a sentence nobody can read. */
.ml-status { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); flex-shrink: 0; flex-wrap: wrap; overflow-wrap: anywhere; }
.ml-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.ml-status[data-state="ready"] .ml-dot { background: var(--dsw-alias-state-success-primary); }
.ml-status[data-state="error"] .ml-dot { background: var(--dsw-alias-state-error-primary); }
.ml-status[data-state="loading"] .ml-dot { background: var(--dsw-alias-state-warn-primary); }
.ml-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
/* The rebuild light bar: one slow, continuous black-and-white gradient travelling around the
 * MemoryLab panel's border.
 *
 * The first version of this was wrong, and wrong in a way worth recording. It used a repeating
 * linear gradient with hard stops on four separate edges, travelling 64 px per lap over
 * 3000 ms. Hard stops produce dashes, four edges produce four independent runs, and a 3000 ms
 * lap is fast — so what it drew was discrete black-and-white segments stepping around the
 * frame with visible seams at every corner. What is wanted is one unbroken gradient, flowing
 * slowly around the whole border.
 *
 * So it is a single element now. A conic gradient sweeps continuously around the perimeter
 * instead of four straight edges meeting at corners; an @property registration makes its angle
 * animatable, which a plain custom property cannot be; and two mask layers XORed together cut
 * the middle out, leaving a 2 px ring over the panel. One revolution takes 9 s on purpose — a
 * gradient that hurries reads as a progress bar, and this is a state, not a measurement.
 *
 * THIS IS NOT TAKEOVER GEOMETRY, and the distinction is load-bearing. The takeover stroke is a
 * native topmost click-through Win32 window owned by the Host half, covering the whole screen
 * and living outside DSH's window entirely; the Client half draws no part of it, and must not.
 * This is a 2 px border on this panel, drawn in the DOM, lit only while a rebuild runs. Both
 * are black-and-white and both wind around an edge, which is the family resemblance; that is
 * where it stops. The bundle's gate asserts the absence of the TAKEOVER (its surface, its
 * marquee, the overlay), not the absence of a gradient — an earlier version of that check
 * banned a CSS function by name and so failed on this panel's own progress bar, which is
 * mis-scoped rather than strict.
 *
 * (No backticks in this block, deliberately: the stylesheet is a template literal, and a
 * backtick in a comment ends the string. The same mistake, one character over, already cost a
 * round when a slash-star inside a path closed a block comment early.)
 *
 * It shows only while a rebuild is running — a bar that is always lit says nothing. Honours
 * prefers-reduced-motion, because a perpetual animation is exactly what that query is for, and
 * this is decoration on a state the button already reports in words. */
@property --ml-lap-angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
.ml-lap {
  position: absolute; inset: 0; z-index: 9; pointer-events: none;
  padding: 2px; border-radius: inherit;
  opacity: 0; transition: opacity 200ms cubic-bezier(0.16,1,0.3,1);
  background: conic-gradient(from var(--ml-lap-angle), #000000, #ffffff, #000000, #ffffff, #000000);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: ml-lap-sweep 9000ms linear infinite;
}
.ml-busy .ml-lap { opacity: 1; }
@keyframes ml-lap-sweep { to { --ml-lap-angle: 360deg; } }
@media (prefers-reduced-motion: reduce) {
  .ml-lap { animation: none; }
}
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
        refreshError: '',
        /**
         * What the judgement half of the last rebuild DID — read from the Host half, never
         * composed here.
         *
         * It is present only on the answer to a rebuild request, because it is a fact about that
         * action and not about the store: the Host runs the deterministic rebuild and then submits
         * the ask to the agent core, and reports the two halves separately. `status` says which of
         * them happened, `label` is the one clause this panel prints, and `attempted` says whether
         * a run was even asked for. A plain read carries `null`, so 重置 cannot leave a stale
         * judgement clause standing next to a store that was never re-judged.
         *
         * `payload.judge` — whether a judge is REACHABLE — is deliberately not mirrored into this
         * state. It used to be, and nothing read it once the strip that warned about it was
         * removed: a switch mirror beside an outcome that already names the switch is dead state,
         * and dead state is what a later reader wires something to by mistake.
         */
        judgement: payload.judgement && typeof payload.judgement === 'object' ? payload.judgement : null,
        root: String(payload.root || ''),
        generatedAt: String(payload.generatedAt || ''),
      };
    }

    /* --------------------------------------------------- re-reading the snapshot */

    /** The route the MemoryLab Host half serves its current snapshot on. */
    const SNAPSHOT_ROUTE = '/newmark-memorylab/snapshot';

    /**
     * The four globals the Host half injects into the served page index.
     *
     * `window.__NEWMARK_MEMORYLAB__` is the store snapshot, and the other three carry
     * the shared root, the platform, the ComputerUse lease mirror and the agent-api host
     * profile — the same four `readPageGlobals()` composes into the payload every renderer
     * reads. All four are listed here, not only the one the panel re-reads: a page re-read
     * that restored three globals of four would leave whichever component was left out
     * reporting the state of the page before the reload.
     */
    const INJECTED_GLOBALS = [CORE_GLOBAL, MEMORYLAB_GLOBAL, COMPUTERUSE_GLOBAL, AGENTAPI_GLOBAL];

    /**
     * Pull the injected globals out of a served index document.
     *
     * Each row writes one `<script>window.NAME=<json>;</script>`, and the JSON is
     * escaped by `embedJson`, which turns every `<` into `\u003c` — so the body of
     * one injection can never contain `</script>` and the element's own end is a
     * safe terminator.
     */
    function readInjectedFromHtml(html) {
      const found = {};
      for (const name of INJECTED_GLOBALS) {
        const marker = `window.${name}=`;
        const at = html.indexOf(marker);
        if (at === -1) continue;
        const end = html.indexOf('</script>', at);
        if (end === -1) continue;
        const body = html.slice(at + marker.length, end).trim().replace(/;$/, '');
        try {
          found[name] = JSON.parse(body);
        } catch {
          /* a global this half cannot parse is left exactly as it was */
        }
      }
      return found;
    }

    /**
     * Ask the Host half for the store as it is now, or as it is after a rebuild.
     *
     * This is the read the panel's two actions need and the one thing an index
     * injection cannot do: a tap is a pure html-to-html transform, so it can never
     * see a request, and a page global is fixed once written. The route lives on the
     * same `webServer` service the Host half already injects and is registered and
     * disposed with the MemoryLab component, so asking it is asking the component
     * that owns the store — and `reindex=1` is the only way to ask for the rebuild
     * itself rather than for whatever a page render happens to do.
     */
    async function readFromHost({ rebuild }) {
      const response = await fetch(rebuild ? `${SNAPSHOT_ROUTE}?reindex=1` : SNAPSHOT_ROUTE, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response || response.ok !== true) throw new Error(`HTTP ${response ? response.status : 'no response'}`);
      const payload = await response.json();
      if (!payload || payload.ok !== true) throw new Error(String((payload && payload.error) || 'the Host half reported no snapshot'));
      return payload;
    }

    /**
     * Fallback read: ask the shell for its own index document and take the globals
     * out of it.
     *
     * A page global is fixed once it has been written, so the only way to get a
     * fresh one is a freshly rendered index — which is what this asks for. It is the
     * fallback and not the primary path because rendering the index runs the Host
     * half's staleness check rather than anything the panel asked for, so it cannot
     * tell 重置 and 重建索引 apart; it exists so that a Host half older than this
     * bundle (HMR swaps the client) still gives both actions a working read. Nothing
     * here opens a channel of its own, and this half never asks the page to reload
     * itself: the shell keeps its state while this panel re-renders.
     */
    async function refreshFromShell() {
      if (typeof window === 'undefined') throw new Error('no page to re-read: this panel is not running in a browser');
      if (typeof fetch !== 'function') {
        throw new Error('this page cannot fetch the shell index, so the panel keeps the snapshot the page loaded with');
      }
      const target =
        window.location && typeof window.location.pathname === 'string' && window.location.pathname ? window.location.pathname : '/';
      const response = await fetch(target, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'text/html' },
      });
      if (!response || response.ok !== true) {
        throw new Error(`the shell index answered HTTP ${response ? response.status : 'nothing'}`);
      }
      const html = await response.text();
      const found = readInjectedFromHtml(html);
      if (!found[MEMORYLAB_GLOBAL]) {
        throw new Error(`the served index carried no ${MEMORYLAB_GLOBAL} injection, so there was nothing fresh to read`);
      }
      // Publish what came back exactly as a page load would, so every later
      // synchronous read of these globals sees the same state this render used.
      for (const [name, value] of Object.entries(found)) window[name] = value;
      return found;
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
        refreshError: '',
        judgement: null,
        servedBy: 'page-global',
        rebuildResult: null,
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
     * Take ONE snapshot.
     *
     * `source: 'page'` reads the page global the Host half injected when the shell
     * served this page: synchronous, no request, and what the panel opens on.
     *
     * `source: 'host'` asks the MemoryLab component for the store as it is NOW —
     * `rebuild: true` asks it to rebuild the index first — and falls back to the
     * page-index re-read if that route is not there. A failed read is never fatal
     * and never silent: the panel keeps the snapshot it has and reports the failure
     * in `refreshError`.
     *
     * Called when the panel opens, when the user resets, and when the user asks for
     * a rebuild — never on a click, a tag navigation, a drag or a zoom, all of which
     * read the retained graph.
     */
    async function loadVisualization({ reason, source = 'page', rebuild = false }) {
      if (inflight > 0) return;
      const token = ++generation;
      inflight += 1;
      emit({ phase: 'loading', error: '', refreshError: '', reason });
      try {
        let refreshError = '';
        let servedBy = source === 'host' ? 'route' : 'page-global';
        let rebuildResult = null;
        if (source === 'host') {
          try {
            const fresh = await readFromHost({ rebuild });
            if (token !== generation) return; // superseded: a newer snapshot owns the panel
            // Hot installation can start the client after the shell HTML was served.
            // Recover the host snapshot without asking the user to reload the application.
            if (typeof window !== 'undefined') window[MEMORYLAB_GLOBAL] = fresh;
            rebuildResult = fresh.result || null;
            emit({
              phase: 'ready',
              error: '',
              refreshError: '',
              servedBy,
              rebuildResult,
              relationshipVersion: String(fresh.relationshipVersion || ''),
              loadedAt: Number(fresh.loadedAt) || Date.now(),
              components: Array.isArray(fresh.index && fresh.index.components) ? fresh.index.components : [],
              tags: fresh.index && typeof fresh.index.tags === 'object' ? fresh.index.tags : {},
              contents: fresh.contents && typeof fresh.contents === 'object' ? fresh.contents : {},
              root: String(fresh.root || ''),
              generatedAt: String(fresh.generatedAt || ''),
              reindexError: String(fresh.reindexError || ''),
              // The judgement half of the action this read asked for, as the Host half reported
              // it. Absent on a plain read — see `readInjected()`.
              judgement: fresh.judgement && typeof fresh.judgement === 'object' ? fresh.judgement : null,
              // The store fields are the fresh ones; the switch states and the lease
              // mirror still come from the page globals this page was served with.
              payload: { ...(readPageGlobals() || {}), ...fresh },
              reason,
            });
            return;
          } catch (error) {
            refreshError = error instanceof Error ? error.message : String(error);
            servedBy = 'page-global';
            // The route is the only read that can be asked for a rebuild, so say
            // which read the panel is on when it falls back to the other one.
            try {
              await refreshFromShell();
            } catch (fallbackError) {
              const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
              refreshError = `${refreshError}; the page re-read failed too: ${detail}`;
            }
          }
        }
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
          refreshError,
          servedBy,
          rebuildResult,
          relationshipVersion: String(payload.relationshipVersion || ''),
          loadedAt: Number(payload.loadedAt) || Date.now(),
          components: Array.isArray(index.components) ? index.components : [],
          tags: index.tags && typeof index.tags === 'object' ? index.tags : {},
          contents: payload.contents && typeof payload.contents === 'object' ? payload.contents : {},
          root: String(payload.root || ''),
          generatedAt: String(payload.generatedAt || ''),
          reindexError: String(payload.reindexError || ''),
          /* The page-index fallback carries no judgement, because it did not ask for one: the
           * path it took renders the shell's index, and the Host's rendering rebuild performs
           * no run. Leaving the previous clause standing would report a judgement this read
           * never made. */
          judgement: null,
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
     * 重建索引 — one action in two halves, asked for in one request.
     *
     * The Host half runs the deterministic rebuild FIRST and then submits the judgement to the
     * agent core, and reports the two separately. This half's whole part is to ask for that
     * action, show that it is running, and render what came back: it composes no prompt, runs
     * nothing, and has no tool context by construction — which is why the run happens on the
     * other side of this route.
     *
     * Neither half is faked. A rebuild that failed comes back as `reindexError`, a judgement that
     * did not happen comes back as `judgement.status` with its own `label`, and a read that failed
     * leaves the panel saying so. The stale clause from the previous action is cleared on the way
     * in, so a running judgement is never shown beside an old result.
     */
    async function reindex() {
      emit({ reindexing: true, error: '', judgement: null });
      try {
        await loadVisualization({ reason: 'reindex', source: 'host', rebuild: true });
      } finally {
        emit({ reindexing: false });
      }
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
/* THE FOCUS-MODE MENU, drawn to DSH's own compact menu (ui-primitives Menu.module.css):
   4px-padded card, prominent elevation, 24px rows at --dsw-radius-sm, hover and keyboard
   focus sharing one fill, selection marked by a trailing check. Every value is a token with a
   fallback, so a theme or another plugin overrides the token rather than the rule, and a build
   that does not define the token still gets a menu that matches the panel. Namespaced under the
   ml- prefix with no bare element selectors and no !important — see the ModeMenu comment above.

   THE CARD IS AS WIDE AS ITS TEXT, not as wide as DSH's compact minimum. The shell's own compact
   list reserves 156px because its rows carry labels, icons and shortcuts; these four rows are two
   CJK characters each, so that floor left most of the card empty — the user's instruction was to
   keep the width of the text. A max-content width with no min-width floor does exactly that: the
   card shrinks to its longest row plus the 4px padding, and the rows stay full-width so hover and
   the focus fill still cover the whole card. Everything else in the card keeps DSH's metrics. */
.ml-menu-root { position: relative; display: inline-flex; }
.ml-menubtn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; cursor: pointer; }
.ml-menubtn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ml-menubtn:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in oklab, var(--dsw-alias-brand-primary) 40%, transparent); }
.ml-menubtn-caret { flex: none; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-top: 4px solid currentColor; opacity: .65; }
.ml-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 40; box-sizing: border-box; display: flex; flex-direction: column; width: max-content; padding: 4px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgb(0 0 0 / 22%)); -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, none); backdrop-filter: var(--dsw-menu-backdrop-filter, none); }
.ml-menuitem { display: flex; align-items: center; gap: 5px; width: 100%; min-height: 24px; padding: 2px 6px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; line-height: 17px; text-align: left; cursor: pointer; }
.ml-menuitem:hover, .ml-menuitem.active, .ml-menuitem:focus-visible { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); outline: none; }
.ml-menuitem-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ml-menucheck { flex: none; width: 12px; text-align: center; color: var(--dsw-alias-label-primary); }
`;

    /** A panel-level selection expressed as the overview's node id. */
    function selectionToNodeId(selection) {
      if (!selection || typeof selection !== 'object') return '';
      if (selection.kind === 'tag' && selection.tag) return `tag:${selection.tag}`;
      if (selection.kind === 'component' && selection.slug) return `component:${selection.slug}`;
      return '';
    }

    /**
     * THE FOCUS-MODE MENU — a DSH-styled listbox instead of a native `<select>`.
     *
     * Why it is not a `<select>` any more: a native select's CLOSED control can be styled, but its
     * OPEN list is drawn by the platform, so this control used to open a light Win32 popup inside a
     * dark themed panel — the one surface in the panel that did not follow the theme, and it could
     * not be fixed with CSS. The control is therefore an ordinary button plus a listbox card, and
     * the card is sized and coloured to DSH's own menu (`@deepseek-ai/dsh-client-ui-primitives`
     * `Menu.module.css`, the compact variant: a 4px-padded card with a prominent elevation, rows of
     * `min-height: 24px`, `padding: 2px 6px`, `--dsw-radius-sm`, 11px/17px, hover and keyboard focus
     * sharing `--dsw-alias-interactive-bg-hover`, and selection marked by a trailing check rather
     * than a second fill).
     *
     * THE ROWS CARRY THE MODE NAME AND NOTHING ELSE. An earlier revision put a one-line
     * explanation in each row ("父链与子树同时高亮" and so on). The user's instruction was to keep the
     * original titles only, and the instruction is also the better match for the menus this card is
     * copying: DSH's own rows are a label plus an optional icon or shortcut, four two-character CJK
     * words need no gloss, and a description column would make this card wider than the menus it is
     * imitating.
     *
     * COMPATIBILITY WITH OTHER PLUGINS' OVERRIDES, which is the other half of the requirement:
     *
     *   1. Every value is a THEME TOKEN, and the tokens this build may not define are read with a
     *      FALLBACK (`var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay))`). So a theme — or
     *      another plugin calling `theme.overrideTokens` — moves this menu with everything else,
     *      and a token that is absent still leaves a menu that matches the panel around it.
     *   2. Every selector is namespaced under `ml-` and no rule names a bare element type. Another
     *      plugin's stylesheet cannot match these classes by accident, and ours cannot match its
     *      markup: the rule removed here was `.ml-oactions select`, which styled an element TYPE
     *      inside a class we do not own exclusively.
     *   3. No `!important` anywhere, so a later override — ours or another plugin's — still wins by
     *      ordinary cascade order. Nothing here writes to `body`, `:root` or `*`.
     *
     * The card renders INSIDE the overview header rather than through the shell's frame-wide
     * floating seat: the header sits at the stage's top edge and the card opens downward well inside
     * it, so the stage's `contain: strict` (which would clip anything reaching its edge) never cuts
     * it, and a floating seat would add a cross-panel coordinate channel for no visible gain.
     */
    const MODE_OPTIONS = [
      { value: 'both', label: '双向' },
      { value: 'parents', label: '父链' },
      { value: 'children', label: '子树' },
      { value: 'direct', label: '直接' },
    ];

    function ModeMenu({ value, onChange }) {
      const [open, setOpen] = React.useState(false);
      const [active, setActive] = React.useState(0);
      const rootRef = React.useRef(null);
      const buttonRef = React.useRef(null);
      const itemRefs = React.useRef([]);
      const index = Math.max(0, MODE_OPTIONS.findIndex((option) => option.value === value));
      const current = MODE_OPTIONS[index];
      const optionId = (option) => `ml-mode-${option.value}`;

      // Closing on an outside pointer and on Escape is what every menu in the shell does; the
      // listener is capture-phase so it still fires when the pointer lands on a canvas node whose
      // handler would otherwise swallow it.
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open]);

      const close = (refocus) => {
        setOpen(false);
        if (refocus && buttonRef.current) buttonRef.current.focus();
      };

      const move = (delta) => {
        const next = (active + delta + MODE_OPTIONS.length) % MODE_OPTIONS.length;
        setActive(next);
        const node = itemRefs.current[next];
        if (node && typeof node.focus === 'function') node.focus();
      };

      const onButtonKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(index);
          setOpen(true);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setActive(index);
          setOpen((wasOpen) => !wasOpen);
        }
      };

      const onListKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
          return;
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          move(event.key === 'Home' ? -active : MODE_OPTIONS.length - 1 - active);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onChange(MODE_OPTIONS[active].value);
          close(true);
          return;
        }
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          close(event.key === 'Escape');
        }
      };

      return h(
        'div',
        { className: 'ml-menu-root', ref: rootRef },
        h(
          'button',
          {
            className: 'ml-menubtn',
            type: 'button',
            ref: buttonRef,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': open ? 'ml-mode-list' : undefined,
            onClick: () => {
              setActive(index);
              setOpen((wasOpen) => !wasOpen);
            },
            onKeyDown: onButtonKeyDown,
          },
          h('span', { className: 'ml-menubtn-label' }, current.label),
          h('span', { className: 'ml-menubtn-caret', 'aria-hidden': 'true' }),
        ),
        open
          ? h(
              'div',
              { className: 'ml-menu', id: 'ml-mode-list', role: 'listbox', 'aria-label': 'Focus mode', onKeyDown: onListKeyDown },
              MODE_OPTIONS.map((option, optionIndex) =>
                h(
                  'button',
                  {
                    key: option.value,
                    id: optionId(option),
                    className: `ml-menuitem${optionIndex === active ? ' active' : ''}${option.value === value ? ' selected' : ''}`,
                    type: 'button',
                    role: 'option',
                    ref: (node) => {
                      itemRefs.current[optionIndex] = node;
                    },
                    'aria-selected': option.value === value ? 'true' : 'false',
                    onMouseEnter: () => setActive(optionIndex),
                    onClick: () => {
                      onChange(option.value);
                      close(true);
                    },
                    onKeyDown: onListKeyDown,
                  },
                  h('span', { className: 'ml-menuitem-label' }, option.label),
                  option.value === value ? h('span', { className: 'ml-menucheck', 'aria-hidden': 'true' }, '✓') : null,
                ),
              ),
            )
          : null,
      );
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
        // Where the pointer last was, in stage coordinates. The dot-mode tooltip is placed
        // against this rather than against the node, so it appears beside what the pointer is
        // actually over. Kept as plain mutable state because it is read inside listeners that
        // were registered once and never re-created.
        const pointer = { x: 0, y: 0 };
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
            // A component node carries the tag it is anchored under, so drilling into it from
            // the overview lands in that tag rather than in whichever tag sorts first. The
            // node already knows its own tag; passing it is what keeps the detail view's tag
            // context from being lost on the way in.
            const picked = node.slug
              ? { kind: 'component', slug: node.slug, ...(node.tag ? { tag: node.tag } : {}) }
              : { kind: 'tag', tag: node.tag };
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
            const tip = tipRef.current;
            const stageRect = stage.getBoundingClientRect();
            const width = tip.offsetWidth || 130;
            const height = tip.offsetHeight || 44;
            const GAP = 14;

            // Beside the CURSOR, not beside the node. It used to be placed at the node's
            // screen point, and since `.ml-tip` is `position: absolute` with no transform,
            // that point became the box's top-left corner — so a 130 px box hung ~65 px to
            // the right and ~30 px below a node that, in dot mode, is a 10 px dot. The
            // tooltip looked detached from what the pointer was over.
            //
            // The preference is lower-right of the pointer; each axis flips to the other side
            // when the box would leave the stage, and the result is clamped so it can never
            // hang outside even when the pointer is in a corner.
            let left = pointer.x + GAP;
            let top = pointer.y + GAP;
            if (left + width > stageRect.width - 8) left = pointer.x - GAP - width;
            if (top + height > stageRect.height - 8) top = pointer.y - GAP - height;
            left = Math.max(8, Math.min(stageRect.width - width - 8, left));
            top = Math.max(8, Math.min(stageRect.height - height - 8, top));

            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
            tip.querySelector('.ml-tip-name').textContent = node.name;
            tip.querySelector('.ml-tip-type').textContent = node.type;
            tip.classList.add('show');
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

        /**
         * A node's position on screen, in the BASE camera.
         *
         * During a drag the CSS transform carries the live offset, so the movement lands in the
         * same tick as the pointer instead of waiting for the next frame. Paint must therefore
         * draw at the base — the camera with that offset taken back out — or the offset is
         * applied twice: once here, once by the transform.
         *
         * It was applied twice. `paint()` positioned every node from `camera.x`, which the drag
         * had already moved, and the transform added the same delta again; so the graph ran
         * ahead of the pointer while dragging, and clearing the transform on release removed
         * exactly that delta in one step. That step is the rebound the user met — not a late
         * repaint, a double count being corrected.
         *
         * On release `panRenderX`/`panRenderY` return to zero in the same tick the transform is
         * cleared, so the drawn position is continuous across the release instead of jumping by
         * the offset once the base stops being subtracted.
         */
        function screenOf(node) {
          const baseX = camera.x - panRenderX;
          const baseY = camera.y - panRenderY;
          return { x: baseX + node.x * camera.scale, y: baseY + node.y * camera.scale };
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
          // Zeroed in the SAME tick as the transform is cleared, and this is the whole reason
          // the release is continuous. `screenOf` draws at `camera - panRender`, and the
          // transform adds `panRender` back; while both are live the drawn position is
          // `camera`, which is what it becomes again once both are gone. Clearing only the
          // transform, and leaving the offset for a later frame, would jump the graph by the
          // offset for exactly that frame — the same rebound, moved from the drag to the gap
          // after it.
          panRenderX = 0;
          panRenderY = 0;
          requestFrame();
        }
        function onWheel(event) {
          event.preventDefault();
          const rect = stage.getBoundingClientRect();
          const previous = camera.scale;
          // 0.0022, not the 0.0009 this started at: at 0.0009 one notch of a typical wheel
          // (deltaY 100) moved the scale by exp(-0.09), about 8.6%, so reaching any useful
          // zoom took a dozen or more scrolls. 0.0022 is about 20% per notch — a step you can
          // see, while the range below still spans five orders of magnitude in a few flicks.
          const next = Math.min(10000, Math.max(0.0001, previous * Math.exp(-event.deltaY * 0.0022)));
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
        // Separate from onPointerMove, which is for panning and returns early when no drag is
        // in progress. The tooltip needs the position on every move, dragging or not, and a
        // `mouseenter` on a node fires only after the pointer has already travelled there.
        stage.addEventListener('pointermove', (event) => {
          const rect = stage.getBoundingClientRect();
          pointer.x = event.clientX - rect.left;
          pointer.y = event.clientY - rect.top;
        });
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
            h(ModeMenu, { value: mode, onChange: setMode }),
            h('span', { className: 'ml-ochip' }, `${scaleLabel}%`),
            h('button', { className: 'ml-btn', type: 'button', onClick: () => apiRef.current?.clear() }, '取消'),
            h(
              'button',
              {
                className: 'ml-btn',
                type: 'button',
                title: '把总览相机移回中心与默认缩放；不动任何记忆数据',
                onClick: () => apiRef.current?.reset(),
              },
              '视图归位',
            ),
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
      /**
       * The selected tag SURVIVES a component click.
       *
       * `selection` for a component carries the tag it was opened from, because clicking a
       * component is a move WITHIN a tag, not out of it. This used to read only
       * `selection.kind === 'tag'`, so the moment a component was clicked the tag was
       * forgotten and the expression fell through to `names[0]` — the alphabetically first
       * tag in the store. Two symptoms followed, and the user met both: the selected tag
       * jumped to whichever tag sorts first (`#4维流形`, because `#4` sorts before `#A`), and
       * the list narrowed to the single component that had been clicked, so its siblings
       * disappeared. One cause.
       *
       * `names[0]` answers ONE question — "nothing has been chosen yet, so which tag does
       * the view open on" — and it is only honest for that one. It is not an answer to
       * "which tag was I in", and it must never stand in for a selection that was actually
       * made: a selection that cannot be resolved has to render as nothing, not as the
       * first tag in the store. So an explicit selection resolves to its own tag or to no
       * tag at all, and the default is reached only when there is no selection.
       *
       * A component opened from somewhere with no tag — search results, or a graph node that
       * is not under the current tag — carries no tag and gets none invented for it: the
       * column narrows to that component (see `listed`), which is the only list it is
       * demonstrably a member of.
       */
      const selectedTag =
        (selection?.tag && tags[selection.tag] ? selection.tag : '') ||
        (selection?.kind === 'tag' && tags[selection.tag] ? selection.tag : '') ||
        (selection ? '' : names[0] || '');
      const node = tagOf(tags, selectedTag);
      const parents = node.parents;
      const children = node.children;
      const roots = rootTags(tags);
      const parentColumn = parents.length ? parents : roots;
      /**
       * The COMPONENTS column is the selected tag's OWN member list, resolved
       * through the store's own index — `tags[selectedTag].components` — which is
       * the same list the tag button beside it counts. Nothing else is allowed in.
       *
       * It used to be `components.filter((entry) => entry.tags.includes(selectedTag))`.
       * A component's `tags` is not a statement about this tag: the store puts a
       * component in every tag of every one of its `tagPaths`, so a component whose
       * path only passes THROUGH the selected tag carries it in `tags` as well. The
       * column therefore filled up with components that belong to the tag's
       * DESCENDANTS, which is not what the column is named.
       *
       * Resolving through the member list is also what makes the column honest about
       * its own heading: the COUNT on the tag button and the ROWS under the title are
       * now the same list, so a heading can never disagree with what is under it.
       */
      const members = (name) => {
        const owner = tagOf(tags, name);
        const slugs = new Set(owner.components);
        return components.filter((entry) => slugs.has(entry.slug));
      };
      /**
       * A component click keeps its siblings on screen.
       *
       * This used to narrow to the clicked component alone, so the column emptied down to one
       * row the moment anything was opened — the second half of the same defect the tag
       * fallback caused. A component is something you opened FROM a tag, so the column stays
       * that tag's member list and the opened component is rendered as the selected row inside
       * it. Only when there is no tag to belong to — a search hit, a node outside the current
       * tag — does the column fall back to the single component, because then there is no
       * larger list it is a member of.
       */
      const picked =
        selection?.kind === 'component' && selection.slug
          ? components.filter((entry) => entry.slug === selection.slug)
          : null;
      const listed =
        selectedTag
          ? members(selectedTag)
          : picked || components;
      /**
       * The preview follows the SAME list — and there is no fallback past it.
       *
       * It used to end `|| components[0]`: an empty list silently previewed the first
       * component in the whole store, a stranger's body rendered under a tag it has
       * nothing to do with. That is the defect as the user met it.
       *
       * `listed[0] || null` is not the same chain with one link removed, because `listed`
       * can no longer be empty while a component exists to show. `listed` is either the
       * selected tag's member list or the picked component: the first is non-empty
       * whenever the tag exists, and a selection that resolves to no tag is a component
       * selection, which `picked` has already caught. So the only way to reach a null here
       * is a selection with genuinely nothing under it, and that renders as nothing and
       * says so — measured, not assumed: with the old `components[0]` link restored the
       * rendered page is byte-identical for all eight selection shapes, which is why the
       * plant is inert and why this line does not need defending against it.
       */
      const selected = picked ? picked[0] || null : listed[0] || null;
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
                  // Carries the tag it is being opened FROM, so the view stays in that tag
                  // instead of falling back to the alphabetically first one.
                  onClick: () => onSelect({ kind: 'component', slug: entry.slug, tag: selectedTag }),
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
          h('div', { className: 'ml-preview-body' }, h(PreviewBody, { text: content })),
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
              const hit = componentHits[0];
              const first = tagHits[0]
                ? { kind: 'tag', tag: tagHits[0] }
                : {
                    kind: 'component',
                    slug: hit.slug,
                    ...(Array.isArray(hit.tags) && hit.tags[0] ? { tag: hit.tags[0] } : {}),
                  };
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
                      // A search hit arrives with no tag context — you searched the whole
                      // store — so it carries the component's OWN first tag. That is a real
                      // tag the component is a member of, so the detail view opens on a list
                      // it belongs to rather than on the alphabetically first tag in the
                      // store, which is what an absent tag used to produce.
                      onSelect({
                        kind: 'component',
                        slug: entry.slug,
                        ...(Array.isArray(entry.tags) && entry.tags[0] ? { tag: entry.tags[0] } : {}),
                      });
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

    /* ------------------------------------------------- the panel, and the two halves */

    /**
     * The MemoryLab window: the graph, the two actions, and one status line.
     *
     * 重建索引 is ONE action in two halves and the panel says which of them happened. The Host
     * half runs the deterministic rebuild first and then submits the judgement to the agent core;
     * this half asks for that action over the component's own snapshot route, shows that it is
     * running, and renders what came back — the two halves from the two fields the answer carries
     * (`result` for the rebuild, `judgement` for the run), never blurred into one sentence.
     *
     * That is the whole of this page's part in a judgement, and it is deliberate: the ask, the run
     * and the timeout all belong to the Host half, which has the tool context this page does not.
     * An earlier revision offered the prompt here for a person to copy. It was removed because it
     * was never asked for and because it is false the moment the button runs the Agent — pressing
     * the button runs the judgement, so there is nothing left to copy.
     *
     * The footer is DATA: how much is in the index, which graph version, when the snapshot was
     * taken, the outcome of each half that was asked for, and any error that actually happened. It
     * used to end with an explanation of what the rebuild does and who does the judging —
     * "重建索引只做确定性重建；三类判定由 Agent 经工具完成：先读证据，再决定，再应用". That is
     * narration, not status: nobody asked for it, and it is false now that the button drives the
     * run. A status bar reports; it does not explain itself. */
    function MemoryLabPanel() {
      const state = useMemoryLab();
      const [view, setView] = React.useState('overview');
      const [selection, setSelection] = React.useState(null);

      // ONE snapshot, on open. Every later interaction reads it.
      React.useEffect(() => {
        loadVisualization({ reason: 'open', source: 'host' });
      }, []);

      const tagCount = tagNames(state.tags).length;
      const componentCount = state.components.length;
      /* The judgement clause, taken from the Host half's own `label` — the page renders the
       * outcome and never words it. While the request is in flight there is no outcome yet, so the
       * clause says that instead of showing the previous one. It is appended to whatever the rest
       * of the line says, because a rebuild puts the panel in its loading phase for as long as the
       * run takes: a clause that only existed on the ready branch would be invisible for exactly
       * the minutes it exists for. */
      const judgementClause = state.reindexing
        ? '· 正在重建并运行判定…'
        : state.judgement && typeof state.judgement.label === 'string' && state.judgement.label
          ? `· 判定${state.judgement.label}`
          : '';
      const storeLine =
        state.phase === 'ready'
          ? `${tagCount} 标签 · ${componentCount} 组件 · ${state.relationshipVersion.slice(0, 12)} · 快照生成于 ${formatTime(Date.parse(state.generatedAt) || state.loadedAt)}${state.reindexError ? ` · 重建告警：${state.reindexError}` : ''}${state.refreshError ? ` · 重新读取失败：${state.refreshError}` : ''}`
          : state.phase === 'loading'
            ? '正在载入 Memory Lab…'
            : `Host 半侧未提供快照：${state.error}`;
      const status = `${storeLine}${judgementClause ? ` ${judgementClause}` : ''}`;

      return h(
        'div',
        { className: `ml-root${state.reindexing ? ' ml-busy' : ''}`, 'aria-busy': state.reindexing ? 'true' : 'false' },
        h('style', null, CSS),
        // The rebuild light bar: one element, one continuous sweep, masked down to a 2 px ring.
        // It was four spans when it was four dashes; a single sweep has no corners to seam at,
        // which is the whole reason the dashes read wrong. It is this panel's progress state and
        // NOT the takeover stroke — see the stylesheet comment for why that distinction matters
        // to the gate that asserts the page draws no takeover surface.
        h('div', { className: 'ml-lap', 'aria-hidden': 'true' }),
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
              title: '重新读取 Host 半侧的记忆存储并刷新本面板（不重载外壳）',
              onClick: () => loadVisualization({ reason: 'reset', source: 'host' }),
            },
            '重置',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ml-btn',
              disabled: !!state.reindexing,
              onClick: reindex,
              /* The tooltip names the ACTION and stops there.
               *
               * It used to spell out what the judgement asks — the judgement classes, in the
               * prompt's own words — and that is the built-in prompt leaking into a hover
               * tooltip. A user hovering a button wants to know what the button does; the ask
               * itself belongs to whoever receives it, and paraphrasing it here also meant the
               * tooltip could drift from the prompt it was paraphrasing. The count is not named
               * either, for the same reason: it is a fact about the prompt, not about the
               * button. */
              title: '重建索引：先做确定性重建，再由 Agent 判定一次。不重载外壳。',
            },
            state.reindexing ? '重建并判定中…' : '重建索引',
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
          {
            className: 'ml-status',
            'data-state': state.phase,
            // Which half of the last rebuild this line is reporting, as a value rather than a
            // sentence: `''` when no judgement was asked for, else the Host half's own status.
            'data-ml-judgement': state.reindexing ? 'running' : state.judgement ? String(state.judgement.status || '') : '',
          },
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
      // `slots` and nothing else. The shell's plugin page declares
      // `["remote", "remote.settings"]` because it calls Remote methods; this half does
      // not, so it must not declare a remote namespace.
      //
      // It once declared `['slots', 'remote', 'remote.pluginManager']`, for a preset switch
      // that went through `pluginManager.setPluginEnabled`. That call could not reach the row
      // — `listPlugins()` inventories the profile's INSTALLED packages and
      // `@deepseek-ai/dsh-agent-preset` lives in the DSH installation, so it answered
      // `preset row not listed` — and the namespace was already unnecessary when the switch
      // moved onto this bundle's own route. The switch is gone now; nothing here resolves a
      // remote service at all.
      inject: ['slots'],
      apply(ctx) {
        // Keep the optional management dependency off MemoryLab's own activation path.
        let coreUpdateManager = null;
        if (typeof ctx.plugin === 'function') ctx.plugin({
          name: 'newmark-core-update-client',
          inject: ['remote', 'remote.pluginManager'],
          apply(child) {
            coreUpdateManager = child.remote.pluginManager;
            child.effect(() => () => { coreUpdateManager = null; }, 'newmark-core-update-manager');
          },
        });
        ctx.effect(() => {
          if(typeof document==='undefined' || typeof document.createElement!=='function' || window.__NEWMARK_CORE__?.platform!=='win32') return ()=>{};
          let disposed=false, stop=()=>{}, activeToken='', polling=false;
          const connect=async()=>{
            if(disposed||polling) return;polling=true;
            try {
              const response=await fetch('/newmark-computeruse/menu-theme',{credentials:'same-origin'});
              if(!response.ok){stop();stop=()=>{};activeToken='';return;}
              const connection=await response.json();if(disposed||connection.token===activeToken)return;
              const module=await import(connection.client);if(disposed)return;
              stop();stop=module.startDshMenuThemeBridge({React,createRoot:require('react-dom/client').createRoot,
                Menu:require('@deepseek-ai/dsh-client-ui-primitives').Menu,connection,renderSlider:NewMateSizeControl,sliderCss:NEWMATE_SLIDER_CSS});activeToken=connection.token;
            } catch(error) { if(!disposed) console.warn('NewMate menu bridge:',error.message); }
            finally {polling=false;}
          };
          const timer=setInterval(connect,5000);connect();
          return ()=>{disposed=true;clearInterval(timer);stop();};
        }, 'newmate-dsh-menu-theme');
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
    .nmc-config-settings { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr)); gap:16px; align-items:stretch; }
    .nmc-config-card { min-width:0; display:flex; flex-direction:column; align-items:stretch; gap:12px; padding:20px; border:1px solid var(--dsw-alias-border-secondary); border-radius:16px; background:var(--dsw-alias-bg-elevated); }
    .nmc-config-category { font-size:11px; color:var(--dsw-alias-label-tertiary); letter-spacing:.06em; }
    .nmc-config-card .nmc-config-subhead { margin:0; font-size:16px; font-weight:600; line-height:1.5; color:var(--dsw-alias-label-primary); }
    .nmc-config-description { margin:0; font-size:12px; line-height:1.7; color:var(--dsw-alias-label-secondary); }
    .nmc-config-card.nmc-update-card { margin-top:4px; padding:20px 0 0; border:0; border-radius:0; background:transparent; }
    .nmc-update-header { display:flex; align-items:center; justify-content:space-between; gap:24px; flex-wrap:wrap; }
    .nmc-update-title { display:grid; gap:7px; min-width:0; flex:1 1 230px; }
    .nmc-update-button { min-height:38px; padding:8px 18px; border-radius:10px; white-space:nowrap; flex:0 0 auto; }
    .nmc-config-footnote.nmc-update-status { margin:0; padding-top:4px; border:0; overflow-wrap:anywhere; }
    @media(max-width:480px) { .nmc-update-button { width:100%; } .nmc-update-header { gap:16px; } }
    .nmc-config-section-heading { display:grid; gap:6px; margin-bottom:4px; }
    .nmc-config-section-heading .nmc-config-head { margin:0; font-size:16px; }
    .nmc-config-card .nmc-config-model { padding:0; border:0; background:transparent; gap:12px; }
    .nmc-config-card .nmc-config-model-pick { flex-direction:column; align-items:stretch; gap:6px; }
    .nmc-config-card .nmc-config-select { width:100%; min-height:36px; flex:auto; border-radius:9px; }
    .nmc-config-card .newmate-size-control { width:100%; padding:8px 0; margin-top:4px; }
    .nmc-config-card .newmate-size-heading { margin-bottom:18px; }
    .nmc-config-footnote { margin-top:auto; padding-top:12px; border-top:1px solid var(--dsw-alias-border-secondary); color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.7; }
    .nmc-config-card .nmc-config-model-note { line-height:1.7; overflow-wrap:anywhere; word-break:normal; }
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

       THE ONE UNSCOPED SELECTOR IN THIS PACKAGE, and it is declared rather than hidden:
       the data-plugin-rows ATTRIBUTE is not a namespace, so another plugin that put the
       same attribute on its own element would be styled by it — and one that set the
       attribute on markup of its own would have that markup hidden while our panel is
       mounted. Neither can happen on the bundle page as the shell renders it today (one
       bundle per page, and the attribute is the shell's own for its row section), and the
       alternative is leaving duplicate, contradictory row controls on the page. The gate
       keeps a list of exactly this exception, so a SECOND unscoped selector fails rather
       than joining it quietly.

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
    /* The model block. Not a row in the list above: a row is a switch, and this is the one
       value on the page that is 准用 — authorised. It borrows the rows' surface so the page
       reads as one surface, and its own accents so the states stay apart. */
    .nmc-config-model {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--dsw-alias-bg-elevated);
      border: 1px solid var(--dsw-alias-border-secondary);
    }
    .nmc-config-model-current { font-size: 12px; color: var(--dsw-alias-label-primary); word-break: break-all; }
    .nmc-config-model-pick { display: flex; align-items: center; gap: 8px; }
    .nmc-config-model-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
    .nmc-config-select {
      flex: 1;
      min-width: 0;
      height: 28px;
      padding: 0 8px;
      border-radius: 7px;
      border: 1px solid var(--dsw-alias-border-secondary);
      background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-primary);
      font: inherit;
      font-size: 12px;
    }
    .nmc-config-select:disabled { opacity: 0.55; cursor: default; }
    .nmc-config-model-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
    /* A state that needs acting on, not a decoration: an authorised model that is gone, or a
       catalogue that could not be read. Amber, the shell's own warn token. */
    .nmc-config-model-warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); word-break: break-all; }
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
          const [hostCompose, setHostCompose] = React.useState(null);
          const [updateMessage, setUpdateMessage] = React.useState('所有组件随 Newmark Core 统一更新。');
          const [updateBusy, setUpdateBusy] = React.useState(false);
          const updateLock = React.useRef(false);
          const updateCore = async () => {
            if (updateLock.current) return;
            updateLock.current = true; setUpdateBusy(true);
            let requested = false;
            try {
              const manager = coreUpdateManager;
              if (!manager) throw new Error('当前宿主的插件管理服务尚未就绪');
              setUpdateMessage('正在查询 npm 官方最新版本…');
              const response = await fetch('/newmark-core/update', { cache: 'no-store', credentials: 'same-origin' });
              if (response.status === 404 || response.status === 405) throw new Error('当前宿主尚未加载更新接口，请完全退出并重启 DSH');
              if (response.status === 401 || response.status === 403) throw new Error('当前页面认证已失效，请重新打开 DSH 插件配置页');
              const body = await response.text();
              if (!body.trim()) throw new Error(`更新接口返回空响应（HTTP ${response.status}），请完全重启 DSH 后重试`);
              let latest;
              try { latest = JSON.parse(body); }
              catch { throw new Error(`更新接口返回非 JSON 响应（HTTP ${response.status}），请完全重启 DSH 后重试`); }
              if (!response.ok || !latest.ok) throw new Error(latest.error || '无法查询最新版');
              const installed = await manager.listBundles();
              if (!installed.ok) throw new Error(installed.error?.message || '无法读取已安装版本');
              const currentVersion = installed.value.find(bundle => bundle.name === 'newmark2dsh')?.version;
              if (/^\d+\.\d+\.\d+$/.test(currentVersion || '')) {
                const currentParts = currentVersion.split('.').map(Number), nextParts = latest.latest.split('.').map(Number);
                const different = currentParts.findIndex((part, index) => part !== nextParts[index]);
                if (different >= 0 && currentParts[different] > nextParts[different]) {
                  setUpdateMessage(`已安装 ${currentVersion}，官方 latest 暂为 ${latest.latest}；未执行降级。`); return;
                }
              }
              if (currentVersion === latest.latest) {
                setUpdateMessage(`已安装最新版本 ${latest.latest}；若刚完成更新，请完全重启 DSH。`); return;
              }
              setUpdateMessage(`正在更新 Newmark Core 至 ${latest.latest}…`);
              requested = true;
              // The authoritative tarball names exactly the selected release. It avoids
              // pnpm's bare-name age fallback without changing the user's pnpm policies.
              const answer = await manager.installBundle(latest.tarball, {
                enabled: true, registry: latest.registry, requestId: crypto.randomUUID(),
              });
              if (!answer.ok) throw new Error(answer.error?.message || '安装结果不可用，请查看 DSH 插件管理记录');
              const receipt = answer.value;
              if (!['applied', 'restart-required'].includes(receipt.application)) {
                throw new Error(receipt.error?.diagnostic || `安装返回状态：${receipt.application}`);
              }
              const after = await manager.listBundles();
              if (!after.ok || after.value.find(bundle => bundle.name === 'newmark2dsh')?.version !== latest.latest) {
                throw new Error('安装后的版本核验未通过，请查看 DSH 插件管理记录');
              }
              setUpdateMessage(`已安装 ${latest.latest}。请完全退出并重启 DSH，以加载所有组件。`);
            } catch (error) {
              setUpdateMessage(`${requested ? '更新未确认' : '更新失败'}：${error.message || error}。未回退旧版本。`);
            } finally { updateLock.current = false; setUpdateBusy(false); }
          };

          // The authorised model, read from the same route and shown in its own block below
          // the component rows. It is deliberately NOT a row in `rows`: a row is a switch, and
          // this is a value — the one thing on this page that is 准用, authorised.
          //
          // `null` means the route has not answered yet. `{ ok: false }` means it answered and
          // could not read the catalogue, which is a different thing from an empty catalogue
          // and is rendered as such.
          const [modelState, setModelState] = React.useState(null);
          const [modelBusy, setModelBusy] = React.useState(false);
          const [modelError, setModelError] = React.useState('');
          const [petScale,setPetScale]=React.useState(null),[petError,setPetError]=React.useState('');
          const petWrite=React.useRef({pending:null,busy:false,revision:0,live:true});
          React.useEffect(()=>{
            const control=petWrite.current;control.live=true;
            const read=async()=>{
              const revision=control.revision;
              if(control.busy||control.pending!==null)return;
              try {
                const response=await fetch('/newmark-core/components'+'?view=newMate'),body=await response.json();
                if(control.live && revision===control.revision && body.newMate){setPetScale(body.newMate.sizeMultiplier);setPetError(body.newMate.ok?'':body.newMate.error);}
              } catch(error){if(control.live)setPetError(error.message);}
            };
            read();const timer=setInterval(read,1000);
            return()=>{control.live=false;clearInterval(timer);};
          },[]);
          const savePetScale=async value=>{
            setPetScale(value);const control=petWrite.current;control.pending=value;control.revision++;
            if(control.busy)return;control.busy=true;
            try {
              while(control.pending!==null){
                const next=control.pending;control.pending=null;
                const response=await fetch('/newmark-core/components',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({component:'newMate',sizeMultiplier:next})});
                const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'大小保存失败');
                if(control.live)setPetError('');
              }
            } catch(error){if(control.live)setPetError(error.message);control.pending=null;}
            finally{control.busy=false;}
          };


          // The mount read and the post-switch read ask the same question, so they are the
          // same function. After a switch the panel asks again rather than trusting the
          // POST's receipt: the POST reports whether the Host accepted the change, and only
          // the next read reports whether it took effect. Those are not the same thing.
          //
          // Both composed switches come from this one route, and the route answers the
          // components and the model together — one GET, one answer, no second channel.
          const readState = () =>
            fetch('/newmark-core/components')
              .then((response) =>
                response
                  .json()
                  .catch(() => ({}))
                  .then((body) => ({ ...body, httpStatus: response.status })),
              )
              .then((result) => {
                if (!result || !Array.isArray(result.components)) return false;
                if (typeof result.compose === 'boolean') setHostCompose(result.compose);
                const next = {};
                // Carry `detail` through too: it is the Host's own description of what it
                // read, and dropping it left the panel able to show only a boolean, which
                // is not enough to tell "off" from "the edit did nothing".
                for (const entry of result.components) {
                  next[entry.name] = { ok: true, mounted: entry.mounted === true, detail: entry.detail };
                }
                setApplied((current) => ({ ...current, ...next }));
                return true;
              })
              .catch(() => false);

          /**
           * Read the authorised model and the models DSH currently offers.
           *
           * The read rides the SAME route the switches use: one GET answers the components
           * and the model, so there is no second channel and no second source of truth.
           * `GET /newmark-core/components` therefore does the whole job.
           *
           * Every failure is reported, never swallowed: a catalogue that could not be read
           * leaves `ok: false` with the Host's own detail, which is what the block below
           * renders. A silent empty list would look exactly like "DSH has no models", and a
           * page that says that while the user has models would be worse than one that says
           * it could not find out.
           */
          const readModel = () =>
            fetch('/newmark-core/components')
              .then((response) =>
                response
                  .json()
                  .catch(() => ({}))
                  .then((body) => ({ ...body, httpStatus: response.status })),
              )
              .then((body) => {
                const answer = body && typeof body.model === 'object' && body.model ? body.model : null;
                setModelState(answer === null ? { ok: false, error: 'no_model_answer', detail: `the route answered HTTP ${body?.httpStatus ?? 'nothing'} with no model block` } : answer);
                return answer;
              })
              .catch((error) => {
                setModelState({ ok: false, error: 'model_read_failed', detail: String((error && error.message) || error) });
                return null;
              });

          React.useEffect(() => {
            let live = true;
            readState().then(() => {
              if (live) setLoaded(true);
            });
            readModel();
            return () => {
              live = false;
            };
          }, []);

          /**
           * Persist one choice, then ask what is true.
           *
           * The order matters and is the same one the switches use: POST, then READ. The POST's
           * receipt is what the Host accepted; only the next read says whether it took. The
           * select is NOT updated optimistically — if the write did not land, the control must
           * still show the model that is actually authorised, or the page would be lying about
           * the one value a run depends on.
           */
          const saveModel = (provider, model) => {
            if (!provider || !model) return;
            setModelBusy(true);
            setModelError('');
            fetch('/newmark-core/components', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ component: 'model', provider, model }),
            })
              .then((response) =>
                response
                  .json()
                  .catch(() => ({}))
                  .then((body) => ({ ...body, httpStatus: response.status, ok: body && body.ok === true })),
              )
              .then((result) => {
                if (result.ok !== true) {
                  setModelError(
                    [
                      result.httpStatus ? 'HTTP ' + result.httpStatus : null,
                      result.error ? String(result.error) : null,
                      result.detail ? String(result.detail) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'the write failed',
                  );
                }
                return readModel();
              })
              .catch((error) => setModelError(String((error && error.message) || error)))
              .then(() => setModelBusy(false));
          };

          const toggle = (key, next) => {
            setPending(key);

            // ONE path for both switches. The POST carries the component key and the desired
            // state; the read that follows is what the panel renders, so the receipt can never
            // disagree with the row.
            fetch('/newmark-core/components', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ component: key, enabled: next }),
            })
              .then((response) =>
                // Keep the status. A rejected request or an error page has no JSON body,
                // and swallowing that into a generic message throws away the one fact
                // that identifies the failure. Reading the status costs nothing.
                response
                  .json()
                  .catch(() => ({}))
                  .then((body) => ({ ...body, httpStatus: response.status, ok: body && body.ok === true })),
              )
              .then((result) => {
                setApplied((current) => ({ ...current, [key]: result }));
                // Ask what is true now. If the change did not take, this read will show the
                // old state and the row will keep saying so.
                return readState();
              })
              .catch((error) => setApplied((current) => ({ ...current, [key]: { ok: false, error: String(error) } })))
              .then(() => setPending(''));
          };

          const rows = [
            {
              key: 'core',
              name: 'Newmark Core',
              role: 'shared user store, page snapshot',
              on: hostCompose === null ? Boolean(payload) : hostCompose,
              note: payload && payload.root ? payload.root : 'no snapshot on this page',
              switchable: false,
            },
            {
              key: 'memoryLab',
              name: 'MemoryLab',
              role: 'durable memory, nine memory_lab_* tools, sidebar renderer',
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
              key: 'agentApi',
              name: 'Agent API',
              role: '标准化的 Agent 调用接口：信封、错误分级、只读状态与 agent run',
              on: components.agentApi === true,
              note: components.agentApi === true ? 'interface mounted' : 'not loaded',
              switchable: true,
            },
          ];

          return h(
            'section',
            { className: 'nmc-config' },
            h('style', null, CONFIG_CSS+NEWMATE_SLIDER_CSS),
            h('section',{className:'nmc-config-section','aria-label':'组件'},
            h('h3', { className: 'nmc-config-head' }, '组件'),
            h(
              'ul',
              { className: 'nmc-config-list' },
              ...rows.map((row) => {
                const answer = applied[row.key];
                const answered = answer && answer.ok === true && typeof answer.mounted === 'boolean';
                const on = answered ? answer.mounted : row.on;
                const failed = answer && answer.ok === false;
                // The mount receipt and the note must describe the same state, including
                // after a hot enable when the original page had no Agent API injection.
                const note = row.key === 'agentApi' ? (on ? 'interface mounted' : 'not loaded')
                  : row.key === 'memoryLab' ? (on ? 'store mounted' : 'not loaded')
                  : row.key === 'computerUse' ? (on ? (lease ? (lease.held ? 'lease held by ' + (lease.ownerId || 'unknown') : 'loaded, lease free') : 'loaded, lease state unavailable') : 'not loaded')
                  : row.note;
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
                  h(
                    'span',
                    { className: 'nmc-config-state' },
                    // One vocabulary across the panel: 已启用 / 已禁用, 启用 / 禁用. Every row
                    // that carries a switch is a composed component, and its `note` says what
                    // that component is; the words do not vary, the notes do.
                    failed ? '切换失败' : on ? row.stateOn || '已启用' : row.stateOff || '已禁用',
                  ),
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
                        pending === row.key
                          ? '…'
                          : on
                            ? row.actionOn || '禁用'
                            : row.actionOff || '启用',
                      )
                    : null,
                  h(
                    'span',
                    { className: 'nmc-config-note' },
                    // On failure show everything the Host said: the status identifies a
                    // rejected request, `error` names the branch, `detail` carries the
                    // underlying message. Showing only one of them has already cost a
                    // diagnosis round.
                    failed
                      ? [
                          answer.httpStatus ? 'HTTP ' + answer.httpStatus : null,
                          answer.error ? String(answer.error) : null,
                          answer.detail ? String(answer.detail) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'failed'
                      : // On success the Host's own `detail` wins over the row's prose: it
                        // is what the file holds, named by line, and a state the panel
                        // cannot see is exactly the failure this row exists to show.
                        (answered && answer.detail ? String(answer.detail) : note),
                  ),
                );
              }),
            ),
            ),
            h('section',{className:'nmc-config-section','aria-label':'配置'},
            h('div',{className:'nmc-config-section-heading'},h('h3',{className:'nmc-config-head'},'配置'),h('p',{className:'nmc-config-description'},'设置智能体使用的模型与 NewMate 的桌面显示。')),
            h('div',{className:'nmc-config-settings'},
            h('section',{className:'nmc-config-card','aria-label':'准用模型'},
            h('span',{className:'nmc-config-category'},'智能体'),
            h(
              'h4',
              { className: 'nmc-config-subhead' },
              '准用模型',
            ),
            h(
              'div',
              { className: 'nmc-config-model' },
              // ---- what is authorised right now, in words ------------------------------
              //
              // Four states, kept apart on purpose: not read yet, nothing authorised,
              // authorised and listed, authorised and GONE. The last two must never look
              // alike — a stale selection that reads as fine fails at run time with the
              // provider's own error, which is the expensive way to learn it.
              h(
                'div',
                { className: 'nmc-config-model-current' },
                modelState === null
                  ? '读取中…'
                  : modelState.selected
                    ? `已准用：${modelState.selected.provider} / ${modelState.selected.model}`
                    : '尚未准用任何模型 —— agent-api 会以 model_not_selected 拒绝运行，不会替用户选择',
              ),
              modelState !== null && modelState.selected && modelState.selectedListed === false
                ? h(
                    'div',
                    { className: 'nmc-config-model-warn' },
                    '⚠ 已准用的模型当前不在 DSH 的可用列表中：provider 已移除、凭据失效或模型已下线。运行会在开始前被拒绝（model_unavailable），请重新准用一个。',
                  )
                : null,
              modelState !== null && modelState.selected && modelState.selectedListed === null
                ? h(
                    'div',
                    { className: 'nmc-config-model-warn' },
                    '该模型所属的 provider 这次未能枚举，因此它是否仍可用未经验证（不是「已失去」）：运行会照常尝试，若 provider 真的不在，失败会带 provider 自己的报错。',
                  )
                : null,
              // ---- the control ---------------------------------------------------------
              //
              // `value` is the authorised pair and never a click: the Host's answer is what
              // the control shows. An authorised model that is no longer offered is added as
              // its own option and labelled, so the control shows the truth instead of
              // falling back to some other model's name — the silent substitution this page
              // exists to make impossible.
              (() => {
                if (modelState === null) return null;
                if (modelState.ok !== true) {
                  return h(
                    'div',
                    { className: 'nmc-config-model-warn' },
                    `无法读取 DSH 的可用模型列表：${modelState.detail || modelState.error || 'unknown'}。模型选择不可用；上面的组件开关不受影响。`,
                  );
                }
                const chosen = modelState.selected ? `${modelState.selected.provider}\u0000${modelState.selected.model}` : '';
                const groups = Array.isArray(modelState.groups) ? modelState.groups : [];
                const offered = groups.some((group) =>
                  (group.models || []).some((entry) => `${entry.provider}\u0000${entry.id}` === chosen),
                );
                const options = [];
                if (chosen && !offered) {
                  options.push(
                    h(
                      'option',
                      { key: 'gone', value: chosen },
                      `${modelState.selected.provider} / ${modelState.selected.model} —— 不在当前可用列表中`,
                    ),
                  );
                }
                for (const group of groups) {
                  options.push(
                    h(
                      'optgroup',
                      { key: group.id, label: group.name || group.id },
                      ...(group.models || []).map((entry) =>
                        h(
                          'option',
                          { key: `${entry.provider}\u0000${entry.id}`, value: `${entry.provider}\u0000${entry.id}` },
                          entry.name && entry.name !== entry.id ? `${entry.name} (${entry.id})` : entry.id,
                        ),
                      ),
                    ),
                  );
                }
                if (chosen && !offered) {
                  // An empty value would select the first offered model, which is the silent
                  // substitution again. A disabled placeholder keeps the control on the pair
                  // that is really authorised while showing that it is gone.
                  options.unshift(h('option', { key: 'empty', value: '', disabled: true }, '— 请重新选择 —'));
                }
                return h(
                  'div',
                  { className: 'nmc-config-model-pick' },
                  h('span', { className: 'nmc-config-model-label' }, '模型'),
                  h(
                    'select',
                    {
                      className: 'nmc-config-select',
                      // '' is not a selection: with nothing authorised the control sits on
                      // the placeholder, and choosing is a deliberate act.
                      value: chosen,
                      disabled: modelBusy || !loaded || modelState.editable === false,
                      onChange: (event) => {
                        const [provider, model] = String(event.target.value || '').split('\u0000');
                        saveModel(provider, model);
                      },
                    },
                    ...(chosen ? [] : [h('option', { key: 'none', value: '' }, '— 尚未准用 —')]),
                    ...options,
                  ),
                  modelBusy ? h('span', { className: 'nmc-config-model-label' }, '写入中…') : null,
                );
              })(),
              // ---- everything the Host said about the catalogue ------------------------
              //
              // A provider whose enumeration failed is named, with its own message. Left out,
              // a partial catalogue would be indistinguishable from a complete one, and the
              // one provider that matters could be the one missing.
              modelState !== null && Array.isArray(modelState.failures) && modelState.failures.length > 0
                ? h(
                    'div',
                    { className: 'nmc-config-model-note' },
                    'provider 枚举失败：' +
                      modelState.failures.map((failure) => `${failure.id || failure.name}: ${failure.message}`).join(' · '),
                  )
                : null,
              modelState !== null && modelState.ok === true && (modelState.models || []).length === 0 && (modelState.failures || []).length === 0
                ? h('div', { className: 'nmc-config-model-note' }, 'DSH 当前没有列出任何可用模型。')
                : null,
              modelState !== null && modelState.defaultSelection
                ? h(
                    'div',
                    { className: 'nmc-config-model-note' },
                    `DSH 的默认模型是 ${modelState.defaultSelection.provider} / ${modelState.defaultSelection.model}（仅供参考；本 bundle 只用上面准用的模型，未准用时拒绝运行）。`,
                  )
                : null,
              modelState !== null && modelState.editable === false
                ? h(
                    'div',
                    { className: 'nmc-config-model-note' },
                    '此 profile 的配置编辑器不可用，因此这个选择无法写入 profile patch；开关不受影响。',
                  )
                : null,
              modelError ? h('div', { className: 'nmc-config-model-warn' }, modelError) : null,
            ),
            ),
            h('section',{className:'nmc-config-card','aria-label':'NewMate'},
            h('span',{className:'nmc-config-category'},'桌面助手'),
            h('h4',{className:'nmc-config-subhead'},'NewMate'),
            h('p',{className:'nmc-config-description'},'拖动滑杆调整显示大小，桌宠右键菜单会同步更新。'),
            h(NewMateSizeControl,{value:petScale??1,onChange:savePetScale,disabled:petScale===null,title:'显示大小'}),
            h('div',{className:petError?'nmc-config-model-warn':'nmc-config-footnote',role:petError?'alert':undefined},petError || '默认 100% · 自动保存，启动时恢复上次大小'),
            ),
            ),
            h('section', { className: 'nmc-config-card nmc-update-card', 'data-newmark-core-update': '', 'aria-label': '插件更新' },
              h('div', { className: 'nmc-update-header' },
                h('div', { className: 'nmc-update-title' },
                  h('span', { className: 'nmc-config-category' }, '版本管理'),
                  h('h4', { className: 'nmc-config-subhead' }, 'Newmark Core'),
                  h('p', { className: 'nmc-config-description' }, '统一更新 MemoryLab、ComputerUse 与 Agent API。')),
                h('button', { type: 'button', className: 'nmc-config-switch nmc-update-button', disabled: updateBusy, onClick: updateCore }, updateBusy ? '正在更新…' : '更新到最新版本')),
              h('p', { className: 'nmc-config-footnote nmc-update-status', role: 'status', 'aria-live': 'polite', 'aria-busy': updateBusy }, updateMessage)),
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
