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
      .newmate-size-heading { margin-bottom:12px; font-size:13px; line-height:20px; }
      .newmate-size-limits { font-size:11px; line-height:14px; opacity:.65; margin-top:6px; }
      .newmate-size-control input { display:block; width:100%; margin:0; cursor:pointer; accent-color:var(--dsw-alias-label-primary); }
      .newmate-size-control output { font-variant-numeric:tabular-nums; min-width:46px; text-align:right; }
    }`;

    function NewMatePetMenuControl(){return h('div',{style:{display:'grid',gap:2,padding:6,minWidth:180}},h('button',{type:'button',role:'menuitem',className:'newmate-pet-action','data-newmate-action':'stop-companion',style:{textAlign:'left',padding:'10px 14px',border:0,borderRadius:7,background:'transparent',color:'inherit',font:'inherit'}},'退出伴随'),h('button',{type:'button',role:'menuitem',className:'newmate-pet-action','data-newmate-action':'settings',style:{textAlign:'left',padding:'10px 14px',border:0,borderRadius:7,background:'transparent',color:'inherit',font:'inherit'}},'打开设置'));}
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
    let MarkdownText = null, UpdateModal = null, UpdateButton = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      UpdateModal = primitives?.Modal;
      UpdateButton = primitives?.Button;
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
    components: { memoryLab: Boolean(memory), computerUse: Boolean(automation), agentApi: Boolean(api), newMate: Boolean(window.__NEWMARK_NEWMATE__), heartBeat: Boolean(window.__NEWMARK_HEARTBEAT__) },
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
    /*
     * The short-memory list is presented NEWEST FIRST.
     *
     * It used to be appended in creation order, so the row a reader actually opens this panel
     * for - what was just recorded - sat at the bottom behind a scroll, and every fresh entry
     * pushed the visible ones down. The transport order is not the presentation order, so this
     * sorts rather than reverses: the API keeps answering oldest-first because the NewMate run
     * reads the same rows as a chronological history, and a reverse() here would silently
     * inherit whatever order that endpoint happens to have.
     */
    const shortNewestFirst = (items) => (items || []).slice().sort((a, b) => {
      const at = Date.parse(a?.createdAt);
      const bt = Date.parse(b?.createdAt);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
      return (Number(b?.seq) || 0) - (Number(a?.seq) || 0);
    });
    function ShortMemoryView() {
      const [data,setData]=React.useState({items:[],path:'',loading:true,error:''});
      const [,setClock]=React.useState(0);
      React.useEffect(()=>{let disposed=false;
        fetch('/newmark-memorylab/short-memory',{cache:'no-store'}).then(async response=>{const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'读取短期记忆失败');if(!disposed)setData({...value,loading:false,error:''});}).catch(e=>{if(!disposed)setData({items:[],path:'',loading:false,error:e.message});});
        const timer=setInterval(()=>{if(!disposed)setClock(n=>n+1);},60000);return()=>{disposed=true;clearInterval(timer);};
      },[]);
      return h('section',{className:'ml-short-memory',style:{padding:24,width:'100%',overflowY:'auto'}},
        h('h3',null,'短期记忆'),h('p',null,'建议每条 100 token 内 · 默认 7 天过期 · 过期项目保留并灰显 · 最新在最上'),
        data.loading?h('p',null,'载入中…'):data.error?h('p',{role:'alert'},data.error):!data.items.length?h('p',null,'暂无短期记忆'):h('ol',null,...shortNewestFirst(data.items).map(item=>{const expired=Date.parse(item.expiresAt)<=Date.now();return h('li',{key:item.seq,'data-expired':expired,style:{padding:'12px 0',whiteSpace:'pre-wrap',color:expired?'var(--dsw-alias-label-tertiary)':'var(--dsw-alias-label-primary)',opacity:expired?0.55:1}},h('div',null,`#${item.seq} · ${new Date(item.createdAt).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})} · ${expired?'已过期':'有效'} · 到期 ${new Date(item.expiresAt).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})}`),h('p',null,item.content));})),
        data.path&&h('p',{className:'ml-preview-desc'},`完整文件：${data.path}`));
    }
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
              '详细',
            ),
            h('button',{type:'button',className:`ml-tab${view==='short'?' active':''}`,onClick:()=>setView('short')},'短期'),
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
        view !== 'short' && state.phase === 'ready' && componentCount === 0 && tagCount === 0
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
              view === 'short' ? h(ShortMemoryView) : state.phase === 'ready'
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
          if(typeof document==='undefined' || typeof document.createElement!=='function' || (window.__NEWMARK_CORE__?.platform||document.documentElement?.getAttribute?.('data-platform'))!=='win32') return ()=>{};
          let disposed=false, stop=()=>{}, activeToken='', polling=false;
          const connect=async(initial)=>{
            if(disposed||polling) return;polling=true;
            try {
              let connection=initial;
              if(!connection){
                const response=await fetch('/newmark-computeruse/menu-theme',{credentials:'same-origin'});
                if(!response.ok){stop();stop=()=>{};activeToken='';return;}
                connection=await response.json();
              }
              if(disposed||connection.token===activeToken)return;
              const module=await import(connection.client);if(disposed)return;
              stop();stop=module.startDshMenuThemeBridge({React,createRoot:require('react-dom/client').createRoot,
                Menu:require('@deepseek-ai/dsh-client-ui-primitives').Menu,connection,renderSlider:NewMatePetMenuControl,sliderCss:NEWMATE_SLIDER_CSS+'.newmate-pet-action:hover,.newmate-pet-action:focus-visible{background:var(--dsw-alias-interactive-bg-hover)!important;outline:0;}'});activeToken=connection.token;
            } catch(error) { if(!disposed) console.warn('NewMate menu bridge:',error.message); }
            finally {polling=false;}
          };
          // Give the DSH shell its first paint before mounting the hidden menu.
          // The injected connection is already authenticated by the served page.
          const initial=window.__NEWMARK_COMPUTERUSE__?.menuTheme;
          const idle=typeof window.requestIdleCallback==='function'
            ? window.requestIdleCallback(()=>connect(initial),{timeout:1500})
            : setTimeout(()=>connect(initial),250);
          const timer=setInterval(()=>connect(),5000);
          return ()=>{disposed=true;clearInterval(timer);if(typeof window.cancelIdleCallback==='function')window.cancelIdleCallback(idle);else clearTimeout(idle);stop();};
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
            newMate: Boolean(source && source.newMate),
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

        {
          let NewMateMarkdown;
          try { NewMateMarkdown=require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText; } catch { /* Text fallback for hosts without the shared renderer. */ }

          const mateFileLinks=text=>{const result=[];for(const m of String(text).matchAll(/\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/g)){let path=m[2]||m[3];try{if(/^file:\/\//i.test(path)){const u=new URL(path);if(u.hostname&&u.hostname!=='localhost')continue;path=decodeURIComponent(u.pathname).replace(/^\/([a-z]:)/i,'$1');}else path=decodeURIComponent(path);}catch{continue;}if(/^[a-z]:[\\/]|^\/(?!\/)/i.test(path))result.push({label:m[1],path});}return result;};
          const matePreviewDocument=html=>'<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; font-src data:; connect-src &apos;none&apos;; frame-src &apos;none&apos;; object-src &apos;none&apos;; form-action &apos;none&apos;; base-uri &apos;none&apos;"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body>'+html+'</body></html>';
          function nativeDocumentEntry(path){
            const definitions=ctx.get?.('documentPreviews')?.candidates?.(path)||[],entries=ctx.slots.entriesOfSlot?.('sidebar.right.tab.document')||ctx.slots.entries('sidebar.right.tab.document');
            for(const definition of definitions){const entry=entries.find(e=>e.options?.key===definition.id);if(entry?.component)return{definition,entry};}
          }
          async function openMateFile(file,id){
            const request=async action=>{const r=await fetch('/newmark-newmate',{method:'POST',headers:{'content-type':'application/json','x-newmark-newmate':'1'},body:JSON.stringify({action,id,path:file.path})});const body=await r.json();if(!r.ok||!body.ok)throw Error(body.error||'文件定位失败');return body;};
            const target=await request('file-target'),native=nativeDocumentEntry(target.path);
            if(!native){await request('reveal-file');return;}
            const reveal=()=>request('reveal-file');
            try{
              const value=await request('file-content');
              const data=Uint8Array.from(atob(value.data),c=>c.charCodeAt(0));
              window.dispatchEvent(new CustomEvent('newmark-newmate-preview',{detail:{file:{path:target.path,data,version:value.version},title:file.label,reveal}}));
            }catch(error){console.debug('[newmate] native document unavailable:',error?.message);await reveal();}
          }
          const NativeDocumentBoundary=React.Component?class extends React.Component{
            constructor(props){super(props);this.state={failed:false};}
            static getDerivedStateFromError(){return{failed:true};}
            componentDidCatch(error){console.debug('[newmate] registered document renderer failed:',error?.message);Promise.resolve(this.props.reveal()).catch(()=>{});}
            render(){return this.state.failed?h('div',{role:'alert'},'当前原生预览不可用。',h('button',{onClick:()=>this.props.reveal()},'在文件管理器定位')):this.props.children;}
          }:({children})=>children;
          function NewMateNativeDocument({file,reveal}){
            const native=nativeDocumentEntry(file.path),scope=React.useRef('newmate-document-'+Math.random().toString(36).slice(2));
            const life=React.useMemo(()=>new AbortController(),[file.path,file.version]);
            React.useEffect(()=>()=>life.abort(),[life]);
            const binding=React.useMemo(()=>{
              if(!native)return null;
              const {definition,entry}=native,id=scope.current,store=entry.store?.create?.(id),actions=store?.actions||{};
              const injected=typeof entry.inject==='function'?entry.inject(id,actions):entry.inject||{};
              const content=definition.loading==='text-pages'?(()=>{const text=new TextDecoder('utf-8',{fatal:true}).decode(file.data);return{kind:'text',text,eof:true,pages:[{offset:1,text,lines:text.split('\n').length}]};})():definition.loading==='renderer'?undefined:{kind:'bytes',data:file.data};
              const address='dsh-resource://file/session/'+encodeURIComponent(id)+'/'+file.path.replaceAll('\\','/').split('/').map(encodeURIComponent).join('/');
              const tab={id,contentId:address,navigation:{params:{}},signal:life.signal};
              const emptySnapshot={};
              const useStore=selector=>{const value=React.useSyncExternalStore(store?.subscribe||(()=>()=>{}),store?.getSnapshot||(()=>emptySnapshot),store?.getSnapshot||(()=>emptySnapshot));return typeof selector==='function'?selector(value):value;};
              return{entry,props:{...injected,content,resourceAddress:address,wrap:false,actions,useStore,useTabInfo:()=>({tab}),useResource:()=>({phase:'ready',value:{absolutePath:file.path,version:file.version}}),useInteractivePreview:selector=>typeof selector==='function'?selector(false):false,retainTab:()=>{},readRelated:async()=>({ok:false,error:{code:'UNAVAILABLE',message:'仅展示当前已引用的文件'}}),addResource:()=>{},setResources:()=>{},scrollportRef:()=>{},t:entry.locale?ctx.get?.('locale')?.bind?.(entry.locale):key=>key}};
            },[file.path,file.version,native?.definition?.id,native?.entry]);
            React.useEffect(()=>()=>binding?.props.actions.forget?.(scope.current),[binding]);
            if(!binding)return h('button',{onClick:reveal},'在文件管理器定位');
            return h(NativeDocumentBoundary,{key:file.path+file.version,reveal},h(binding.entry.component,binding.props));
          }
          function NewMateInteractive({html,index}){
            const frame=React.useRef(null),[height,setHeight]=React.useState(340),[expanded,setExpanded]=React.useState(false),[sourceOpen,setSourceOpen]=React.useState(false),token=React.useRef('newmate-inline-'+Math.random().toString(36).slice(2));
            React.useEffect(()=>{const resize=e=>{if(expanded||e.source!==frame.current?.contentWindow||e.data?.token!==token.current||e.data?.type!=='newmate-size')return;const n=Number(e.data.height);if(Number.isFinite(n))setHeight(Math.max(160,Math.min(1200,n)));};window.addEventListener('message',resize);return()=>window.removeEventListener('message',resize);},[expanded]);
            const measure='<script>(()=>{const send=()=>parent.postMessage({type:"newmate-size",token:'+JSON.stringify(token.current)+',height:document.documentElement.scrollHeight},"*");new ResizeObserver(send).observe(document.documentElement);addEventListener("load",send);send();})()</script>';
            return h('section',{className:'nm-inline-ui','aria-label':'交互回复 '+(index+1)},h('div',{className:'nm-inline-toolbar'},h('span',null,'交互页面'),h('button',{onClick:()=>{setHeight(340);setExpanded(v=>!v);}},expanded?'收起':'展开'),h('button',{onClick:()=>setSourceOpen(v=>!v)},sourceOpen?'隐藏源码':'源码'),h('button',{onClick:()=>navigator.clipboard?.writeText(html)},'复制代码')),
              h('iframe',{ref:frame,title:'NewMate 交互回复 '+(index+1),sandbox:'allow-scripts',referrerPolicy:'no-referrer',srcDoc:matePreviewDocument(html+measure),style:{height:expanded?'70vh':height,width:'100%',border:0,display:'block',background:'white'}}),sourceOpen&&h('pre',null,html));
          }
          function NewMateReply({message}){
            const [fileError,setFileError]=React.useState('');
            const openFile=file=>{setFileError('');openMateFile(file,message.id).catch(error=>setFileError(error.message));};
            const text=message.text||'',artifacts=[...text.matchAll(/^\x60{3}html[^\n]*\n([\s\S]*?)^\x60{3}\s*$/gim)].slice(0,8),files=mateFileLinks(text);
            let prose=text;for(const a of artifacts)prose=prose.replace(a[0],'');
            const show=detail=>window.dispatchEvent(new CustomEvent('newmark-newmate-preview',{detail}));
            if(NewMateMarkdown)prose=prose.replace(/\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/g,match=>mateFileLinks(match).length?'`'+mateFileLinks(match)[0].label.replaceAll('`','')+'`':match);
            const fileMentions={resolve:value=>{const file=files.find(f=>f.label===value||f.path===value);return file?{title:file.path,label:'打开文件 '+file.label,open:()=>openFile(file)}:undefined;}};
            return h(React.Fragment,null,h('div',{className:'nm-reply-body'},NewMateMarkdown?h(NewMateMarkdown,{text:prose,labels:newMateMarkdownLabels,fileMentions}):prose),fileError&&h('p',{role:'alert'},fileError),
              !NewMateMarkdown&&files.length>0&&h('div',{className:'nm-file-links'},...files.map((file,i)=>h('button',{key:i,className:'nm-file-link',title:file.path,onClick:()=>openFile(file)},'↗ '+file.label))),
              ...artifacts.map((a,i)=>h(NewMateInteractive,{key:i,html:a[1],index:i})));
          }
          const newMateMarkdownLabels={code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'注释'};
          function NewMateIcon(props){const size=typeof props?.size==='number'?props.size:18;return h('span',{style:{width:size,height:size,display:'inline-flex',alignItems:'center',justifyContent:'center',overflow:'hidden',flexShrink:0,opacity:.84},'aria-hidden':true},h('img',{src:'/newmark-newmate/avatar.png',alt:'',width:Math.round(size*1.15),height:size,style:{display:'block',objectFit:'contain',transform:'scale(1.65) scaleX(-1)',filter:'grayscale(1)'}}));}
          const NEWMATE_CHAT_CSS = `
            .nm-todo{position:absolute;z-index:12;right:0;top:0;bottom:0;width:min(460px,100%);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#141414);border-left:1px solid var(--dsw-alias-border-secondary,#444);box-shadow:-12px 0 36px #0002}.nm-todo>header{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid var(--dsw-alias-border-secondary,#444)}.nm-todo header strong{font-size:16px}.nm-todo header p,.nm-todo-hint{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#aaa);margin:5px 0 0}.nm-todo-scroll{overflow:auto;padding:20px 22px}.nm-todo-form{display:grid;gap:14px;padding-bottom:18px}.nm-todo-form label{display:grid;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary,#aaa)}.nm-todo-form input,.nm-todo-form textarea,.nm-todo-form select{width:100%;padding:10px 12px;background:var(--dsw-alias-bg-elevated,#252525);border:1px solid var(--dsw-alias-border-primary,#555);border-radius:10px;color:var(--dsw-alias-label-primary,#eee)}.nm-todo-form textarea{resize:vertical;line-height:1.6}.nm-todo-form>button{justify-self:end}.nm-page .nm-todo-form button.nm-send{background:var(--dsw-alias-label-primary,#eee);color:var(--dsw-alias-bg-base,#141414)}.nm-todo-form input[type=datetime-local]{color-scheme:var(--nm-color-scheme,normal)}.nm-todo-list{margin-top:22px}.nm-todo-item{padding:16px 0;border-top:1px solid var(--dsw-alias-border-secondary,#444)}.nm-todo-meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.nm-todo-item p{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;line-height:1.7}.nm-todo-item button{font-size:12px;padding:4px 0}.nm-todo-item[data-status=cancelled],.nm-todo-item[data-status=delivered]{opacity:.6}.nm-todo-item small{display:block;color:var(--dsw-alias-status-error,#ef9292)}.nm-todo-empty{font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary,#aaa)}@media(max-width:620px){.nm-header{flex-wrap:wrap}.nm-header-actions{margin-left:auto}}
            .nm-page .nm-reply-body code:has(>button[aria-label^="打开文件 "]){background:transparent;border:0;border-radius:0;padding:0;font:inherit;box-shadow:none}.nm-page .nm-reply-body button[aria-label^="打开文件 "]{display:inline;padding:0;border:0;border-radius:0;background:transparent;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:3px;box-shadow:none}.nm-page .nm-reply-body button[aria-label^="打开文件 "] svg{display:none}.nm-page .nm-reply-body button[aria-label^="打开文件 "]:hover{background:transparent;text-decoration-thickness:2px}
            .nm-inline-ui{margin:14px 0;border:1px solid var(--dsw-alias-border-secondary);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}.nm-inline-toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;font-size:12px}.nm-inline-toolbar>span{flex:1;color:var(--dsw-alias-label-secondary)}.nm-inline-ui pre{margin:0;padding:14px;max-height:360px;overflow:auto;white-space:pre-wrap;font:12px/1.6 monospace}.nm-native-document{flex:1;min-height:0;overflow:auto;padding:12px;position:relative}.nm-file-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.nm-page .nm-file-link{border:0;border-radius:0;background:transparent;font-weight:600;color:var(--dsw-alias-brand-primary,#6ea2ff);text-decoration:underline;text-align:left;padding:4px 0}.nm-artifact{display:flex;align-items:center;gap:12px;padding:14px 16px;margin:14px 0;border:1px solid var(--dsw-alias-border-secondary,#7774);border-radius:12px;background:var(--dsw-alias-bg-elevated,#252525)}.nm-artifact div{flex:1}.nm-artifact p{font-size:12px;margin:4px 0;color:var(--dsw-alias-label-secondary,#aaa)}.nm-preview{position:absolute;z-index:10;right:0;top:0;bottom:0;width:min(55%,820px);min-width:min(360px,100%);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#141414);border-left:1px solid var(--dsw-alias-border-primary,#555);box-shadow:-10px 0 30px #0002}.nm-preview.expanded{width:100%;min-width:0}.nm-preview header{display:flex;gap:6px;align-items:center;padding:14px;border-bottom:1px solid var(--dsw-alias-border-secondary,#7774)}.nm-preview header strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nm-preview iframe{width:100%;flex:1;min-height:0;border:0;background:white}.nm-preview pre{margin:0;padding:18px;overflow:auto;flex:1;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 monospace}.nm-preview-path{padding:8px 16px;font-size:11px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#aaa)}
            .nm-page{height:100%;width:100%;min-height:0;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);background:var(--dsw-alias-bg-base,#141414);color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:14px;position:relative}
            .nm-page *{box-sizing:border-box}.nm-page button,.nm-page input,.nm-page textarea{font:inherit;color:inherit}.nm-page button{cursor:pointer;transition:background .15s;border:1px solid transparent;border-radius:9px;background:transparent;padding:8px 12px}.nm-page button:hover{background:var(--dsw-alias-bg-hover,#ffffff0b)}.nm-page button:focus-visible,.nm-page textarea:focus-visible,.nm-page input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6ea2ff);outline-offset:2px}.nm-page button:disabled{opacity:.45;cursor:default}
            .nm-history{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-secondary,#ffffff12);background:var(--dsw-alias-bg-elevated,#1b1b1b);padding:20px 12px 12px;gap:16px}.nm-history-heading{display:flex;align-items:center;justify-content:space-between;padding:0 8px;font-size:15px;font-weight:600}.nm-new{width:100%;border-color:var(--dsw-alias-border-secondary,#ffffff20);text-align:left;min-height:40px}.nm-search{width:100%;padding:9px 11px;border:1px solid var(--dsw-alias-border-secondary,#ffffff20);border-radius:9px;background:transparent}.nm-thread-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:5px}.nm-thread{position:relative;border-radius:10px}.nm-thread.active{background:var(--dsw-alias-bg-hover,#ffffff0b)}.nm-page .nm-thread-main{width:100%;text-align:left;padding:12px;display:grid;gap:6px}.nm-thread-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;padding-right:9px}.nm-thread-date{color:var(--dsw-alias-label-tertiary,#888);font-size:11px}.nm-thread-actions{display:flex;justify-content:flex-end;padding:0 5px 5px;gap:2px}.nm-thread-actions button{font-size:11px;padding:4px 7px;color:var(--dsw-alias-label-secondary,#aaa)}.nm-history-footer{display:grid;gap:5px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-secondary,#ffffff12)}.nm-history-empty{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#888);padding:12px}.nm-unread{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#6ea2ff);margin-right:6px}
            .nm-main{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto}.nm-header{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 28px;border-bottom:1px solid var(--dsw-alias-border-secondary,#ffffff12)}.nm-heading{min-width:0;display:grid;gap:5px}.nm-heading h2{font-size:16px;margin:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nm-subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}.nm-header-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}.nm-header-actions>button{font-size:12px;color:var(--dsw-alias-label-secondary,#aaa);min-height:34px}.nm-header-actions>button:hover{color:var(--dsw-alias-label-primary,#eee)}.nm-brand{display:flex;align-items:center;gap:12px;min-width:0}.nm-brand-mark{width:34px;height:34px;display:grid;place-items:center;overflow:hidden;border-radius:10px;background:var(--dsw-alias-bg-elevated,#202020);flex-shrink:0}.nm-brand-mark img{width:27px;height:27px;object-fit:contain;transform:scale(1.65);opacity:.9}.nm-page .nm-switch{display:flex;align-items:center;gap:9px;white-space:nowrap;font-size:12px}.nm-switch-track{width:31px;height:18px;border-radius:12px;background:var(--dsw-alias-border-primary,#555);position:relative}.nm-switch-track:after{content:'';position:absolute;width:12px;height:12px;background:white;top:3px;left:3px;border-radius:50%;transition:transform .18s}.nm-switch[aria-checked=true] .nm-switch-track{background:var(--dsw-alias-brand-primary,#548bea)}.nm-switch[aria-checked=true] .nm-switch-track:after{transform:translateX(13px);background:var(--dsw-alias-bg-base,#141414)}.nm-history-toggle{display:inline-block}.nm-history-view{height:100%;overflow:auto;padding:24px 32px}.nm-history-view .nm-thread-list{max-width:760px;margin:auto;overflow:visible;gap:4px}.nm-history-view .nm-thread-main{min-height:64px;border-bottom:1px solid var(--dsw-alias-border-secondary,#ffffff12);border-radius:0;padding:14px 12px}.nm-history-view .nm-thread-main:hover{border-radius:9px}.nm-history-view .nm-thread-title{font-size:14px}.nm-history-view .nm-header{padding:0 12px 20px;max-width:760px;margin:auto}.nm-history-reading .nm-header{min-width:0}.nm-history-view .nm-search{max-width:760px;display:block;margin:16px auto}.nm-history-reading{min-height:0;min-width:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);height:100%}.nm-feed{overflow:auto;min-height:0;padding:28px 32px;scrollbar-gutter:stable;scroll-padding-block:24px}.nm-feed:empty{padding:0}.nm-message{max-width:760px;margin:0 auto 28px;line-height:1.8;font-size:14px}.nm-message-label{display:flex;gap:9px;align-items:center;font-size:12px;font-weight:600;margin-bottom:8px}.nm-avatar{width:25px;height:25px;display:grid;place-items:center;border-radius:8px;background:var(--dsw-alias-bg-hover,#ffffff12);font-size:12px;overflow:hidden}.nm-message time{font-weight:400;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}.nm-message-body{white-space:pre-wrap;overflow-wrap:anywhere}.nm-message.user{display:flex;flex-direction:column;align-items:flex-end}.nm-message.user .nm-message-body{max-width:88%;padding:12px 17px;border-radius:14px 14px 4px 14px;background:var(--dsw-alias-bg-elevated,#252525)}.nm-proactive{font-weight:400;color:var(--dsw-alias-brand-primary,#6ea2ff);font-size:11px}.nm-welcome{height:100%;min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:24px;color:var(--dsw-alias-label-secondary,#aaa)}.nm-welcome-mark{width:56px;height:56px;border-radius:18px;display:grid;place-items:center;font-size:23px;color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-elevated,#252525)}.nm-welcome h3{margin:4px 0 0;font-size:21px;font-weight:500;color:var(--dsw-alias-label-primary,#eee)}.nm-welcome p{font-size:13px;line-height:1.8;max-width:360px;margin:0;white-space:pre-line}.nm-prompts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px}.nm-prompts button{border-color:var(--dsw-alias-border-secondary,#ffffff20);font-size:12px;padding:9px 14px;color:var(--dsw-alias-label-secondary,#aaa)}.nm-prompts button:hover{border-color:var(--dsw-alias-border-primary,#ffffff35);color:var(--dsw-alias-label-primary,#eee)}
            .nm-composer-wrap{padding:8px 28px 18px;background:var(--dsw-alias-bg-base,#141414)}.nm-composer{max-width:760px;margin:auto;padding:13px 15px 10px;border:1px solid var(--dsw-alias-border-primary,#ffffff28);border-radius:16px;background:var(--dsw-alias-bg-elevated,#202020)}.nm-composer textarea{display:block;width:100%;resize:none;caret-color:var(--dsw-alias-label-primary,#eee);min-height:54px;max-height:150px;background:transparent;border:0;outline:none;line-height:1.6;padding:0}.nm-composer:focus-within{border-color:var(--dsw-alias-label-secondary,#aaa)}.nm-page .nm-composer textarea:focus-visible{outline:none}.nm-composer textarea::placeholder{color:var(--dsw-alias-label-tertiary,#888);opacity:1}.nm-composer-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.nm-composer-hint{margin-left:auto;margin-right:2px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#888);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}.nm-page .nm-send{background:var(--dsw-alias-label-primary,#e8e8e8);color:var(--dsw-alias-bg-base,#141414);font-size:12px;padding:7px 16px}.nm-error{max-width:760px;margin:0 auto 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-status-error,#ef9292)}.nm-pending{font-size:12px;color:var(--dsw-alias-label-secondary,#aaa);max-width:760px;margin:12px auto}.nm-live{font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}.nm-question{max-width:760px;margin:0 auto 10px;border:1px solid var(--dsw-alias-border-primary,#555);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-elevated,#1b1b1b)}.nm-question-text{margin:0 0 10px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#eee)}.nm-option{display:block;width:100%;text-align:left;margin:0 0 8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-secondary,#444);border-radius:9px;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1.5}.nm-option:hover{border-color:var(--dsw-alias-brand-primary,#548bea)}.nm-option:disabled{opacity:.55;cursor:default}.nm-option-label{font-weight:600}.nm-option-desc{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}.nm-question-manual{display:flex;gap:8px;margin-top:4px}.nm-question-manual input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-secondary,#444);border-radius:8px;background:var(--dsw-alias-bg-base,#141414);color:inherit;font-size:12px}.nm-question-manual button{padding:8px 14px;border:1px solid var(--dsw-alias-border-secondary,#444);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#252525);color:inherit;cursor:pointer;font-size:12px}.nm-live-thought{max-width:760px;margin:0 auto 8px;padding-left:9px;border-left:1px solid var(--dsw-alias-border-secondary,#ffffff20);font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#888);white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto}.nm-tasks{font-size:12px;max-width:760px;margin:20px auto;color:var(--dsw-alias-label-secondary,#aaa)}.nm-tasks-row{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,#ffffff12)}.nm-rename{display:flex;gap:4px;padding:7px}.nm-rename input{width:100%;min-width:0;background:transparent;border:1px solid var(--dsw-alias-border-secondary,#ffffff20);border-radius:5px;padding:6px}
            @media(max-width:760px){.nm-page{grid-template-columns:minmax(0,1fr)}.nm-history{display:none}.nm-history-open .nm-history{display:flex;position:absolute;left:0;top:72px;bottom:0;width:240px;z-index:5;box-shadow:12px 0 35px #0003}.nm-history-toggle{display:inline-block}.nm-header{padding:14px 16px;gap:8px}.nm-header-actions{gap:2px}.nm-feed{padding:22px 18px}.nm-composer-wrap{padding:8px 16px 14px}.nm-subtitle{font-size:11px}.nm-message.user .nm-message-body{max-width:94%}}@media(prefers-reduced-motion:reduce){.nm-page *{transition:none}}
            .nm-attachments{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.nm-attach{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 8px;border:1px solid var(--dsw-alias-border-secondary,#ffffff20);border-radius:999px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#aaa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 6px 6px 0}.nm-attach-size{opacity:.65}.nm-page .nm-attach button{border:0;background:transparent;padding:0 2px;font-size:12px;color:inherit;opacity:.7}.nm-page .nm-attach button:hover{opacity:1}.nm-page .nm-attach-btn{font-size:12px;padding:6px 10px;border:1px solid var(--dsw-alias-border-secondary,#ffffff20);border-radius:9px;color:var(--dsw-alias-label-secondary,#aaa);white-space:nowrap}.nm-page .nm-attach-btn:hover{color:var(--dsw-alias-label-primary,#eee)}`;
          function NewMatePanel() {

            const [preview,setPreview]=React.useState(null),[previewExpanded,setPreviewExpanded]=React.useState(false),[previewSource,setPreviewSource]=React.useState(false);
            const previewRequest=React.useRef(0);
            React.useEffect(()=>{const open=e=>{const value=e.detail;if(!value?.file)return;setTodoOpen(false);setPreviewExpanded(false);setPreviewSource(false);setPreview(value);};window.addEventListener('newmark-newmate-preview',open);return()=>window.removeEventListener('newmark-newmate-preview',open);},[]);

            const [state, setState] = React.useState({ messages: [], tasks: [], threads:[],settings:{companion:false,notifications:false} });
  const [answering,setAnswering]=React.useState(null);
            const [text, setText] = React.useState('');
            // Files the user picked for the NEXT message. They are uploaded one by one (the bytes
            // go to /newmark-newmate/upload, never through the JSON action), and only the returned
            // attachment record travels with the 'chat' post, so the message stays small.
            const [files,setFiles]=React.useState([]),[uploading,setUploading]=React.useState(false);
            const fileInput=React.useRef(null);
            const [error, setError] = React.useState('');
            const [sending, setSending] = React.useState(false);
            const [busy,setBusy]=React.useState(false),[settingsView,setSettingsView]=React.useState(window.__NEWMARK_NEWMATE_OPEN_SETTINGS__===true),[search,setSearch]=React.useState(''),[historyOpen,setHistoryOpen]=React.useState(false),[viewedHistory,setViewedHistory]=React.useState(null);

            const [todoOpen,setTodoOpen]=React.useState(false), [todoRepeat,setTodoRepeat]=React.useState('none'), [todoEvery,setTodoEvery]=React.useState(1), [todoDays,setTodoDays]=React.useState([]),[todoContent,setTodoContent]=React.useState(''),[todoTime,setTodoTime]=React.useState(''),[todoMode,setTodoMode]=React.useState('conversation');
            const [wechatOpen,setWechatOpen]=React.useState(false);
            const feed=React.useRef(null),follow=React.useRef(true),drafts=React.useRef(window.__NEWMARK_NEWMATE_DRAFTS__||= {}),revision=React.useRef(0);
            const readerClient=React.useRef(`newmate-page-${Math.random().toString(36).slice(2)}`),readerSequence=React.useRef(0);
            const threadId=state.activeThreadId||'',current=state.threads.find(t=>t.id===threadId),messages=state.messages.filter(m=>m.threadId===threadId),tasks=state.tasks.filter(t=>t.threadId===threadId);
            React.useEffect(()=>{window.__NEWMARK_NEWMATE_OPEN_SETTINGS__=false;const open=e=>{setSettingsView(e.detail?.settings===true);setTodoOpen(false);window.__NEWMARK_NEWMATE_OPEN_SETTINGS__=false;setHistoryOpen(false);setViewedHistory(null);requestAnimationFrame(()=>document.querySelector('.nm-composer textarea')?.focus());};window.addEventListener('newmark-newmate-open-chat',open);return()=>window.removeEventListener('newmark-newmate-open-chat',open);},[]);
            const pending=tasks.some(t=>['pending','running'].includes(t.status));
            React.useEffect(()=>{if(!threadId)return;const timer=setTimeout(()=>{fetch('/newmark-newmate',{method:'POST',headers:{'content-type':'application/json','x-newmark-newmate':'1'},body:JSON.stringify({action:'attention',id:threadId,editing:Boolean(text.trim()),client:readerClient.current,sequence:++readerSequence.current})}).catch(()=>{});},250);return()=>clearTimeout(timer);},[threadId,text]);

            /** The three kinds of tool NewMate uses, as the short verb the page shows. */
            function toolAction(tool) {
              const name=String(tool||'');
              if (/^memory_lab_/.test(name)||/^shortMemory_/.test(name)) return '查看记忆';
              if (name==='computer_use'||name==='screen_capture') return '控制电脑';
              if (name==='newmate_ask') return '询问用户';
              return '调用工具';
            }
            /** The one-line live state of the agent loop, in the user-facing short form. */
            /** 微信通道的一句话状态；按钮文案只由连接状态决定。 */
            function loopStatusLine(loop, now = Date.now()) {
              if (!loop?.running) return 'NewMate 正在回复 · 可继续输入引导';
              const phases={starting:'正在准备',model:'正在思考',finishing:'正在收尾',releasing:'正在释放桌面接管'};
              const action=loop.phase==='tool'&&loop.currentTool?(loop.currentTool==='newmate_search'?'正在进行搜索':'正在'+toolAction(loop.currentTool)):(phases[loop.phase]||'正在工作');
              // Elapsed time is derived from the run's start with the LOCAL clock, not from the last polled snapshot:
              // a server elapsedMs only moves when the page polls, which is what made the seconds jump and accelerate.
              const elapsed=loop.startedAt?Math.max(0,now-loop.startedAt):Math.max(0,Number(loop.elapsedMs)||0);
              const seconds=Math.floor(elapsed/1000);
              return [action,loop.turns?'第 '+loop.turns+' 轮':'',seconds?seconds+'s':''].filter(Boolean).join(' · ');
            }
            /**
             * The status line owns its own 250 ms clock, so seconds tick smoothly even though the loop
             * snapshot is polled separately. Only this small subtree re-renders on a tick.
             */
            function LiveStatus({loop,question}) {
              const [now,setNow]=React.useState(()=>Date.now());
              React.useEffect(()=>{ if(!loop?.running) return undefined; const timer=setInterval(()=>setNow(Date.now()),250); return ()=>clearInterval(timer); },[loop?.running]);
              return h('p',{className:'nm-pending'+(loop?.running?' nm-live':''),role:'status'},question?'等你选择 · 第 '+(loop?.turns||1)+' 轮':loopStatusLine(loop,now));
            }
            /**
             * The LATEST live state only: the current thought tail while the model is thinking, or
             * the tool that is running. The full activity history is deliberately not rendered: the
             * conversation shows user inputs, persisted replies, and this one live line, so the page
             * never grows a second, transient transcript beside the real conversation.
             */
            function renderLiveThought(loop) {
              if (!loop?.running||loop.phase==='tool') return null;
              const thought=typeof loop.thinking?.text==='string'?loop.thinking.text.trim():'';
              if (!thought) return null;
              return h('p',{className:'nm-live-thought',role:'status'},thought.length>600?'…'+thought.slice(-600):thought);
            }
            /**
             * The option question, drawn as Newmark's option block: the question, one button per
             * choice with its description, and a free-text field for an answer the choices do not
             * cover. The answer is POSTed back and resolves the blocked tool call, so the SAME run
             * continues with the user's choice; this is a presentation piece, not a second loop.
             */
            function renderQuestion(question) {
              if(!question) return null;
              const waiting=answering===question.id;
              const answer=payload=>{ if(waiting) return; setAnswering(question.id); setError(''); post({action:'answer-question',id:question.id,...payload}).catch(e=>setError(e.message)).finally(()=>setAnswering(null)); };
              return h('section',{className:'nm-question',role:'group','aria-label':'NewMate 询问'},
                h('p',{className:'nm-question-text'},question.question),
                ...(question.options||[]).map(option=>h('button',{key:option.label,type:'button',className:'nm-option',disabled:waiting,onClick:()=>answer({label:option.label})},
                  h('span',{className:'nm-option-label'},option.label),
                  option.description?h('span',{className:'nm-option-desc'},option.description):null)),
                h('form',{className:'nm-question-manual',onSubmit:e=>{e.preventDefault();const text=e.currentTarget.elements.answer.value.trim();if(text)answer({text});}},
                  h('input',{name:'answer',type:'text',maxLength:2000,placeholder:'或直接输入回答','aria-label':'直接输入回答'}),
                  h('button',{type:'submit',disabled:waiting},waiting?'提交中…':'提交')));
            }
            async function refresh() {
              const token=++revision.current;
              const response = await fetch('/newmark-newmate', { cache: 'no-store' });
              const value = await response.json(); if (!response.ok || !value.ok) throw Error(value.error || '读取失败'); if(token===revision.current)setState(value);
            }
            React.useEffect(() => { let disposed = false;
              const read = async () => { const token=++revision.current;try { const response = await fetch('/newmark-newmate', {cache:'no-store'}); const value = await response.json(); if (!disposed&&token===revision.current) { if (!response.ok || !value.ok) setError(value.error || '读取失败'); else setState(value); } } catch(e) { if (!disposed) setError(e.message); } };
              read(); const timer = setInterval(read, 2000); return () => { disposed = true; clearInterval(timer); };
            }, [state.agentLoop?.running]);
            React.useEffect(() => {
              if (!state.agentLoop?.running) return undefined;
              let disposed = false;
              const read = async () => { try { const response = await fetch('/newmark-newmate/loop', { cache: 'no-store' }); const value = await response.json(); if (!disposed && response.ok && value.ok) setState(current => ({ ...current, agentLoop: value.agentLoop, question: value.question !== undefined ? value.question : current.question })); } catch {} };
              read(); const timer = setInterval(read, 200); return () => { disposed = true; clearInterval(timer); };
            }, [state.agentLoop?.running]);
            React.useEffect(()=>{setText(drafts.current[threadId]||'');follow.current=true;},[threadId]);
            React.useEffect(()=>{if(feed.current&&follow.current)feed.current.scrollTop=feed.current.scrollHeight;},[threadId,messages.length,pending]);
            React.useEffect(()=>{
              const publish=focused=>fetch('/newmark-newmate',{method:'POST',keepalive:true,headers:{'content-type':'application/json','x-newmark-newmate':'1'},body:JSON.stringify({action:focused?'read':'presence',id:threadId,focused,client:readerClient.current,sequence:++readerSequence.current})}).catch(()=>{});
              const mark=()=>publish(Boolean(!settingsView&&!historyOpen&&threadId&&document.visibilityState!=='hidden'&&document.hasFocus?.()));
              const blur=()=>publish(false);
              mark();window.addEventListener('focus',mark);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',mark);
              const timer=setInterval(mark,5000);
              return()=>{clearInterval(timer);window.removeEventListener('focus',mark);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',mark);publish(false);};
            },[threadId,settingsView,historyOpen]);
            async function post(input) { const r = await fetch('/newmark-newmate', { method:'POST', headers:{'content-type':'application/json','x-newmark-newmate':'1'}, body:JSON.stringify(input) }); const v = await r.json(); if (!r.ok || !v.ok) throw Error(v.error || '提交失败'); await refresh(); }
            async function act(input){if(busy)return;setBusy(true);setError('');try{await post(input);}catch(e){setError(e.message);}finally{setBusy(false);}}
            async function attach(list){const picked=[...(list||[])];if(!picked.length)return;setUploading(true);setError('');try{for(const item of picked){const response=await fetch('/newmark-newmate/upload',{method:'POST',headers:{'content-type':'application/octet-stream','x-newmark-newmate':'1','x-newmate-filename':encodeURIComponent(item.name||'file.bin')},body:item});const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||('上传失败：'+(item.name||'文件')));setFiles(current=>[...current,value.attachment].slice(0,8));}}catch(e){setError(e.message);}finally{setUploading(false);}}
            async function send(e){e?.preventDefault?.();if((!text.trim()&&!files.length)||sending||!threadId)return;setSending(true);setError('');follow.current=true;const message=text,attached=files;try{await post({action:'chat',text:message,threadId,attachments:attached.length?attached:undefined});if(drafts.current[threadId]===message){drafts.current[threadId]='';setText('');}setFiles([]);}catch(e){setError(e.message);}finally{setSending(false);}}
            const toggle=h('button',{className:'nm-switch',role:'switch','aria-label':'陪伴开关','aria-checked':state.settings.companion===true,disabled:busy,onClick:()=>act({action:'settings',settings:{companion:!state.settings.companion}})},h('span',{className:'nm-switch-track','aria-hidden':true}),'陪伴');
            const date=at=>new Date(at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});
            async function addTodo(e){e.preventDefault();if(busy)return;setBusy(true);setError('');try{const repeat=todoRepeat==='none'?undefined:{every:Math.max(1,Number(todoEvery)||1),unit:todoRepeat,weekdays:todoRepeat==='d'&&todoDays.length?todoDays:undefined};await post({action:'todo-add',activateAt:new Date(todoTime).toISOString(),content:todoContent,mode:todoMode,repeat});setTodoDays([]);setTodoContent('');setTodoTime('');}catch(e){setError(e.message);}finally{setBusy(false);}}
            function renderTodos(){if(!todoOpen)return null;const list=[...(state.todos||[])].map(t=>({...t,repeatLabel:t.repeatText||(t.repeat?'重复':'')})).sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)||a.activateAt-b.activateAt),labels={pending:'等待合适时机',activated:'已激活 · 正在处理',completed:'已完成',delivering:'正在投递',delivered:'已投递',cancelled:'已取消',failed:'未完成'};return h('aside',{className:'nm-todo','aria-label':'toDoList 待办列表'},h('header',null,h('div',null,h('strong',null,'toDoList'),h('p',null,'在合适的时候，开始一轮对话。')),h('button',{'aria-label':'关闭待办',onClick:()=>setTodoOpen(false)},'×')),h('div',{className:'nm-todo-scroll'},h('form',{className:'nm-todo-form',onSubmit:addTodo},h('label',null,'激活时间',h('input',{type:'datetime-local',required:true,value:todoTime,'aria-label':'待办激活时间',onChange:e=>setTodoTime(e.target.value)})),h('label',null,'到期方式',h('select',{value:todoMode,'aria-label':'待办到期方式',onChange:e=>setTodoMode(e.target.value)},h('option',{value:'conversation'},'激活 NewMate 对话'),h('option',{value:'reminder'},'仅发送原文提醒'))),h('label',null,'重复',h('select',{value:todoRepeat,'aria-label':'待办重复频率',onChange:e=>setTodoRepeat(e.target.value)},h('option',{value:'none'},'不重复'),h('option',{value:'min'},'按分钟'),h('option',{value:'h'},'按小时'),h('option',{value:'d'},'按天'))),todoRepeat!=='none'&&h('label',null,'每隔',h('input',{type:'number',min:1,max:10000,value:todoEvery,'aria-label':'重复间隔',onChange:e=>setTodoEvery(Number(e.target.value))})),todoRepeat==='d'&&h('div',{className:'nm-todo-days','aria-label':'重复工作日'},...['一二三四五六日'].map((name,i)=>h('label',{key:name},h('input',{type:'checkbox',checked:todoDays.includes(i+1),onChange:e=>setTodoDays(cur=>e.target.checked?[...new Set([...cur,i+1])].sort((a,b)=>a-b):cur.filter(d=>d!==i+1))}),'周'+name))),h('label',null,'内容或委托',h('textarea',{rows:3,required:true,maxLength:16000,value:todoContent,'aria-label':'待办发送内容',placeholder:'例如：该出发去见朋友了。',onChange:e=>setTodoContent(e.target.value)})),h('button',{type:'submit',className:'nm-send',disabled:busy||!todoTime||!todoContent.trim()},'添加待办')),error&&h('p',{role:'alert',className:'nm-error'},error),h('p',{className:'nm-todo-hint'},'两种到期方式都只等「陪伴开启 + NewMate 自己空闲」，与 DSH 工作区会话无关；被挡下时这里写明原因。静默时段只静音气泡，不推迟到账。'),h('div',{className:'nm-todo-list'},...list.map(t=>h('article',{key:t.id,className:'nm-todo-item','data-status':t.status},h('div',{className:'nm-todo-meta'},h('time',{dateTime:new Date(t.activateAt).toISOString()},new Date(t.activateAt).toLocaleString('zh-CN',{hour12:false})),h('span',null,t.status==='pending'&&t.activateAt<=Date.now()?(t.deferred?.reason?'已到期 · '+t.deferred.reason:'已到期 · 等待合适时机'):labels[t.status]||t.status)),h('small',null,t.mode==='conversation'?'激活 NewMate 对话':'原文提醒'),h('p',null,t.content),t.error&&h('small',null,t.error),['pending','failed'].includes(t.status)&&h('button',{disabled:busy,onClick:()=>act({action:'todo-cancel',id:t.id})},'取消待办'))),!list.length&&h('p',{className:'nm-todo-empty'},'还没有待办。把想记住的时间和事情放在这里。'))));}
            function renderPreview(){return preview?.file&&h('aside',{className:'nm-preview'+(previewExpanded?' expanded':''),'aria-label':'NewMate 原生文件预览'},h('header',null,h('strong',null,preview.title||'文件预览'),h('button',{onClick:()=>setPreviewExpanded(v=>!v)},previewExpanded?'收起':'展开'),h('button',{onClick:()=>preview.reveal()},'定位文件'),h('button',{'aria-label':'关闭预览',onClick:()=>setPreview(null)},'×')),h('div',{className:'nm-preview-path'},preview.file.path),h('div',{className:'nm-native-document'},h(NativeDocumentBoundary,{key:preview.file.path+preview.file.version,reveal:preview.reveal},h(NewMateNativeDocument,{file:preview.file,reveal:preview.reveal}))));}
            // The settings view is the SAME catalogue the plugin page renders — components,
            // model, companion, desktop size, update — mounted a second time. It is not a second
            // page: the sections come from CONFIG_SECTION_ORDER, so a control added to the bundle
            // appears here in the same commit, and one removed here is removed from the plugin
            // page too. Its companion surface is this panel's live state, which already polls the
            // route every two seconds; the rest comes from the same hook the plugin page uses.
            if(settingsView){
              return h(NewMateSettingsView,{state,act,busy,error:String(error||''),onBack:()=>setSettingsView(false)});
            }
            const history=state.threads.filter(t=>t.id!==threadId&&t.title.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>b.updated-a.updated);
            if(historyOpen){const selected=state.threads.find(t=>t.id===viewedHistory),past=state.messages.filter(m=>m.threadId===viewedHistory);
              return h('section',{className:'nm-page','aria-label':'NewMate 历史只读'},h('style',null,NEWMATE_CHAT_CSS),h('div',{className:selected?'nm-history-reading':'nm-history-view'},
                h('header',{className:'nm-header'},h('div',{className:'nm-heading'},h('h2',null,selected?.title||'历史对话'),h('span',{className:'nm-subtitle'},'仅供查看 · 不可编辑或重新激活')),h('div',{className:'nm-header-actions'},selected&&h('button',{onClick:()=>setViewedHistory(null)},'历史列表'),h('button',{onClick:()=>{setHistoryOpen(false);setViewedHistory(null);}},'返回当前对话'))),
                selected?h('div',{className:'nm-feed'},...past.map((m,i)=>h('article',{key:m.id+':'+i,className:'nm-message'},h('div',{className:'nm-message-label'},m.role==='user'?null:'NewMate',h('time',null,new Date(m.at).toLocaleString('zh-CN'))),h('div',{className:'nm-message-body'},m.role==='assistant'?h(NewMateReply,{message:m}):h(React.Fragment,null,(Array.isArray(m.attachments)?m.attachments:[]).map(a=>h('span',{key:a.id,className:'nm-attach'},'📎 '+a.name,h('span',{className:'nm-attach-size'},Math.max(1,Math.round((a.bytes||0)/1024))+' KB'))),m.text))))):
                h(React.Fragment,null,h('input',{className:'nm-search',value:search,'aria-label':'搜索历史对话',placeholder:'搜索历史对话',onChange:e=>setSearch(e.target.value)}),h('div',{className:'nm-thread-list'},...history.map(t=>h('button',{key:t.id,className:'nm-thread-main',onClick:()=>setViewedHistory(t.id)},h('span',{className:'nm-thread-title'},t.title),h('span',{className:'nm-thread-date'},date(t.updated)))),!history.length&&h('p',{className:'nm-history-empty'},'暂无历史对话')))),renderPreview());
            }
            return h('section',{className:'nm-page','aria-label':'NewMate 聊天'},h('style',null,NEWMATE_CHAT_CSS),
              h('main',{className:'nm-main'},h('header',{className:'nm-header'},h('div',{className:'nm-brand'},h('span',{className:'nm-brand-mark','aria-hidden':true},h('img',{src:'/newmark-newmate/avatar.png',alt:''})),h('div',{className:'nm-heading'},h('h2',null,'NewMate'),h('span',{className:'nm-subtitle'},state.settings.companion?'陪伴已开启 · 双击桌宠来聊聊':'由 MemoryLab 记忆陪伴你'))),h('div',{className:'nm-header-actions'},h('button',{'aria-label':'打开 toDoList 待办',onClick:()=>{setPreview(null);setTodoOpen(v=>!v);}},'待办'),h('button',{className:'nm-history-toggle','aria-label':'历史对话',onClick:()=>{setViewedHistory(null);setHistoryOpen(true);}},'历史'),h('button',{disabled:busy,onClick:()=>act({action:'new-thread'})},'新对话'),toggle,h('button',{'aria-label':'Newmark 插件设置',onClick:()=>setSettingsView(true)},'设置'))),
                h('div',{className:'nm-feed',ref:feed,role:'log','aria-live':'polite',onScroll:e=>{const node=e.currentTarget;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<70;}},
                  !messages.length?h('div',{className:'nm-welcome'},h('div',{className:'nm-welcome-mark','aria-hidden':true},h('img',{src:'/newmark-newmate/avatar.png',alt:'',style:{width:40,height:40,objectFit:'contain',transform:'scale(1.65)'}})),h('h3',null,'今天想聊些什么？'),h('p',null,'聊聊最近的想法，梳理接下来的计划。\n我会带着你的记忆，慢慢了解你。'),h('div',{className:'nm-prompts'},...['一起梳理今天的计划','聊聊我最近的想法'].map(prompt=>h('button',{key:prompt,onClick:()=>{setText(prompt);drafts.current[threadId]=prompt;}},prompt)))):
                  messages.map((m,i)=>h('article',{key:m.id+':'+i,className:`nm-message ${m.role==='user'?'user':'assistant'}`},h('div',{className:'nm-message-label'},m.role!=='user'&&h('span',{className:'nm-avatar','aria-hidden':true},h('img',{src:'/newmark-newmate/avatar.png',alt:'',style:{width:24,height:24,objectFit:'contain',transform:'scale(1.65)'}})),m.role==='user'?null:'NewMate',m.proactive&&h('span',{className:'nm-proactive'},'主动消息'),h('time',{dateTime:new Date(m.at).toISOString()},new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}))),h('div',{className:'nm-message-body'},m.role==='assistant'?h(NewMateReply,{message:m}):h(React.Fragment,null,(Array.isArray(m.attachments)?m.attachments:[]).map(a=>h('span',{key:a.id,className:'nm-attach'},'📎 '+a.name,h('span',{className:'nm-attach-size'},Math.max(1,Math.round((a.bytes||0)/1024))+' KB'))),m.text)))),
                  pending&&h(LiveStatus,{loop:state.agentLoop,question:state.question}),renderLiveThought(state.agentLoop),renderQuestion(state.question),
                  tasks.some(t=>!['measurement','self_activation'].includes(t.kind)&&['failed','interrupted'].includes(t.status))&&h('details',{className:'nm-tasks'},h('summary',null,'需要处理的任务'),...tasks.filter(t=>!['measurement','self_activation'].includes(t.kind)&&['failed','interrupted'].includes(t.status)).map(t=>h('div',{key:t.id,className:'nm-tasks-row'},t.prompt.slice(0,80),h('p',null,t.error),h('button',{disabled:busy,onClick:()=>act({action:'retry',id:t.id})},'重试'))))),
                h('div',{className:'nm-composer-wrap'},error&&h('p',{role:'alert',className:'nm-error'},error),h('form',{className:'nm-composer',onSubmit:send},h('input',{type:'file',multiple:true,ref:fileInput,style:{display:'none'},'aria-hidden':true,onChange:e=>{const picked=[...(e.target.files||[])];e.target.value='';attach(picked);}}),files.length?h('div',{className:'nm-attachments','aria-label':'本条消息的附件'},...files.map(f=>h('span',{key:f.id,className:'nm-attach'},'📎 '+f.name,h('span',{className:'nm-attach-size'},Math.max(1,Math.round((f.bytes||0)/1024))+' KB'),h('button',{type:'button','aria-label':'移除附件 '+f.name,onClick:()=>setFiles(current=>current.filter(x=>x.id!==f.id))},'×')))):null,h('textarea',{value:text,rows:2,maxLength:16000,'aria-label':'给 NewMate 的消息',placeholder:threadId?(state.interaction?.running?'补充要求，直接引导当前回复…':'和 NewMate 聊聊…'):'新建一段对话，开始聊聊…',disabled:!threadId,onChange:e=>{setText(e.target.value);drafts.current[threadId]=e.target.value;},onKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent?.isComposing){e.preventDefault();send();}}}),h('div',{className:'nm-composer-row'},h('button',{type:'button',className:'nm-attach-btn','aria-label':'上传文件给 NewMate',disabled:sending||uploading||!threadId,onClick:()=>fileInput.current?.click()},uploading?'上传中…':'📎 上传文件'),h('span',{className:'nm-composer-hint'},state.interaction?.running?'Enter 加入引导 · Shift + Enter 换行':'Enter 发送 · Shift + Enter 换行'),h('button',{type:'submit',className:'nm-send',disabled:sending||!threadId||(!text.trim()&&!files.length)},sending?'发送中…':state.interaction?.running?'引导':'发送'))))),
                renderTodos(),renderPreview());
          }

          ctx.effect(()=>{
            if(typeof MutationObserver!=='function'||!document.body?.appendChild)return()=>{};
            let disposed=false,last='',busy=false;const sync=async()=>{if(disposed||busy)return;busy=true;try{const probe=document.createElement('span');probe.style.cssText='position:fixed;visibility:hidden;background:var(--dsw-alias-bg-base)';document.body.appendChild(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();const rgb=color.match(/[\d.]+/g)?.slice(0,3).map(Number);const dark=rgb?.length===3?rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722<128:matchMedia('(prefers-color-scheme:dark)').matches;const scheme=dark?'dark':'light';if(document.documentElement.style.getPropertyValue('--nm-color-scheme')!==scheme)document.documentElement.style.setProperty('--nm-color-scheme',scheme);if(String(dark)!==last){const r=await fetch('/newmark-newmate',{method:'POST',headers:{'content-type':'application/json','x-newmark-newmate':'1'},body:JSON.stringify({action:'theme',dark})});if(r.ok&&!disposed)last=String(dark);}}catch{}finally{busy=false;}};const observer=new MutationObserver(sync);observer.observe(document.documentElement,{attributes:true});observer.observe(document.body,{attributes:true});const timer=setInterval(sync,3000);sync();return()=>{disposed=true;observer.disconnect();clearInterval(timer);};
          },'newmate-bubble-theme');
          ctx.effect(()=>{
            let disposed=false,lastId=null,polling=false;
            const open=async(threadId,page)=>{const layout=ctx.get?.('layout')||ctx.layout;if(!layout?.selectPanel)return false;window.__NEWMARK_NEWMATE_OPEN_SETTINGS__=page==='settings';layout.selectPanel('newmate');window.dispatchEvent(new CustomEvent('newmark-newmate-open-chat',{detail:{settings:page==='settings'}}));return true;};
            const read=async()=>{if(disposed||polling)return;polling=true;try{
              const r=await fetch('/newmark-newmate/events',{cache:'no-store'});if(!r.ok)return;const value=await r.json(),id=value.openChat?.id;
              if(lastId===null){lastId='';if(!id||Date.now()-Date.parse(value.openChat.at||'')>15000)lastId=id||'';}
              if(id&&id!==lastId&&await open(value.openChat.threadId,value.openChat.page))lastId=id;
            }catch{}finally{polling=false;}};
            read();window.addEventListener?.('focus',read);window.document?.addEventListener?.('visibilitychange',read);const timer=setInterval(read,750);timer.unref?.();return()=>{disposed=true;clearInterval(timer);window.removeEventListener?.('focus',read);window.document?.removeEventListener?.('visibilitychange',read);};
          },'newmate-pet-navigation');
          ctx.effect(() => {
            let releases = [];
            const update = (enabled) => {
              if (enabled && !releases.length) releases = [
                ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name:'sidebar.panellist',id:'newmate',order:21,label:()=> 'NewMate'}, NewMateIcon)),
                ctx.slots.inject('main', () => ctx.slots.register({name:'main',key:'newmate'}, NewMatePanel)),
              ];
              if (!enabled) { for (const release of releases) release?.(); releases = []; }
            };
            const changed = event => { if(event.detail?.key === 'newMate') update(event.detail.mounted === true); };
            update(switches.newMate);
            window.addEventListener?.('newmark-component-change', changed);
            let disposed=false;
            fetch('/newmark-core/components',{cache:'no-store'}).then(async response=>{const value=await response.json();if(!disposed&&response.ok&&Array.isArray(value.components)){const row=value.components.find(row=>row.name==='newMate');if(row)update(row.mounted===true);}}).catch(()=>{});
            return () => { disposed=true;window.removeEventListener?.('newmark-component-change', changed); update(false); };
          }, 'newmate-client-seats');
        }

        /* ============================================================================
         * The configuration format.
         *
         * Every configuration surface this bundle owns is ONE composition of the parts
         * below. Two mounts use it — the plugin page's own seat (plugins.bundle.config)
         * and the NewMate settings view — and they render the same catalogue in the same
         * order, so a control cannot exist on one of them and be missing from the other:
         *
         *   ConfigPage       the page frame: heading, subtitle, hero actions, sections
         *   ConfigSection    a titled group, carrying data-config-section=<id>
         *   ConfigCard       one bordered surface: category, title, copy, body, footer
         *   ConfigRow        one component: name, role, state, note, one action
         *   ConfigField      one labelled control, with its hint
         *   ConfigNote       one line of state — plain, warning or error
         *   ConfigSwitch     the one toggle shape (role=switch, aria-checked)
         *   ConfigSelect     a select built from an options list
         *   ConfigNumber     a number input with its unit
         *   ConfigButton     DSH's own Button when the shell carries it, otherwise an
         *                    equivalent with the same props and the same tokens
         *
         * The rule the format holds: a control is declared ONCE. Adding a field to a
         * section puts it on both mounts in the same edit; removing it takes it off both.
         * That property is what the two pages being locked to each other means — it is a
         * fact about the catalogue, not about two blocks of markup that agree by hand
         * until the next edit.
         *
         * Styling is --dsw-* tokens only: no literal colour, no !important, and every
         * selector of this format is namespaced nmc-, so a rule of another plugin still
         * wins by cascade order. The single exception is the shell-row suppression in
         * PLUGIN_ROWS_CSS below, which the plugin mount renders and the other does not.
         * ========================================================================== */
        const CONFIG_CSS = `
    /* width:100% + min-width:0: the six-row grid's intrinsic width is wide, and as an auto-sized
       child of the NewMate pane it grew past the pane and got clipped on the right (measured from
       a capture: the second card and the hero mark were cut at the window edge). The plugin seat
       is already narrower than max-width, so this changes nothing there. */
    .nmc-page{display:flex;flex-direction:column;gap:26px;width:100%;max-width:1060px;min-width:0;margin:0 auto;padding:4px 2px 28px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);box-sizing:border-box}
    .nmc-page *,.nmc-page *::before,.nmc-page *::after{box-sizing:border-box}
    .nmc-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:6px 0 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
    .nmc-hero-copy{display:grid;gap:6px;min-width:0}
    .nmc-title{margin:0;font:var(--dsw-font-l-20);letter-spacing:-.01em}
    .nmc-subtitle{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
    .nmc-hero-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
    .nmc-hero-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:0 0 auto}
    .nmc-mark{font:var(--dsw-font-l-20);color:var(--dsw-alias-label-primary)}
    .nmc-section{display:grid;gap:12px}
    .nmc-section-head{display:grid;gap:3px}
    .nmc-section-title{margin:0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}
    .nmc-section-note{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
    /* TWO COLUMNS, NOT auto-fit. The plugin seat and the NewMate panel are containers of
       different widths (measured: 905 and ~1040 CSS px), and an auto-fit list turned that
       difference into three columns on one page and two on the other — the same catalogue
       laid out differently on the two mounts. The column count is the format's decision, so
       it is fixed here and only the narrow breakpoint below changes it. */
    .nmc-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .nmc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;align-items:stretch}
    .nmc-stack{display:grid;gap:12px}
    .nmc-row{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;grid-template-areas:"dot name state action" "dot role state action" "dot note note note";align-items:start;gap:3px 10px;padding:13px 14px;min-height:96px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
    .nmc-row:hover{border-color:var(--dsw-alias-border-l2)}
    .nmc-dot{grid-area:dot;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
    .nmc-dot-on{background:var(--dsw-alias-state-success-primary)}
    .nmc-dot-pending{background:var(--dsw-alias-state-warn-primary)}
    .nmc-row-name{grid-area:name;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}
    .nmc-row-role{grid-area:role;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
    /* align-self:start, not center: the row's cells are top-aligned, and a centred pill sat
       26 px below its own button (measured) — two labels for one state on two different
       lines. Both sit on the name line, at every row height. */
    .nmc-row-state{grid-area:state;font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-secondary);padding:3px 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap;align-self:start;margin-top:1px}
    .nmc-row-note{grid-area:note;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin-top:2px}
    .nmc-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
    .nmc-card:hover{border-color:var(--dsw-alias-border-l2)}
    .nmc-card-warn{border-color:var(--dsw-alias-state-warn-primary)}
    .nmc-card-category{font:var(--dsw-font-xxxs-strong-11);letter-spacing:.08em;color:var(--dsw-alias-label-tertiary)}
    .nmc-card-title{margin:0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}
    .nmc-card-copy{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
    .nmc-card-foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
    .nmc-field{display:grid;gap:6px;min-width:0}
    .nmc-field-label{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
    .nmc-field-control{display:flex;align-items:center;gap:8px;min-width:0}
    .nmc-field-inline{grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px}
    .nmc-field-inline .nmc-field-hint{grid-column:1 / -1}
    .nmc-field-hint{margin:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
    .nmc-row-fields{display:grid;gap:12px;margin-top:2px}
    .nmc-note{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
    .nmc-note-warn{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere}
    .nmc-note-error{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
    .nmc-rule{margin:2px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1)}
    .nmc-switch{display:inline-flex;align-items:center;gap:8px;padding:4px 10px 4px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap}
    .nmc-switch:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
    .nmc-switch:disabled{opacity:.45;cursor:default}
    .nmc-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .nmc-switch-track{position:relative;width:30px;height:18px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
    .nmc-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
    .nmc-switch[aria-checked="true"] .nmc-switch-track{background:var(--dsw-alias-state-success-primary)}
    .nmc-switch[aria-checked="true"] .nmc-switch-knob{transform:translateX(12px)}
    .nmc-select{min-width:0;flex:1 1 auto;min-height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
    .nmc-select:disabled{opacity:.55;cursor:default}
    .nmc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .nmc-number{width:88px;min-height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
    .nmc-number:disabled{opacity:.55;cursor:default}
    .nmc-number:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    .nmc-unit{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
    .nmc-action{min-height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap}
    .nmc-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
    .nmc-action:disabled{opacity:.45;cursor:default}
    .nmc-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .nmc-action-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
    .nmc-action-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
    .nmc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    /* The NewMate mount's shell. The plugin page arrives inside the plugin manager's own
       scrolling page; the NewMate panel has none, so without this the page was the direct child
       of a pane that sizes to content. Same padding as the settings page it replaces. */
    .nmc-mount{box-sizing:border-box;height:100%;min-height:0;min-width:0;width:100%;overflow-y:auto;overflow-x:hidden;padding:24px}
    .nmc-card .newmate-size-control{width:100%;padding:0}
    .nmc-card .newmate-size-heading{margin-bottom:14px}
    @media(max-width:640px){.nmc-page{gap:22px}.nmc-title{font:var(--dsw-font-m-18)}.nmc-row{min-height:0;padding:12px}.nmc-list{grid-template-columns:1fr}}
`;
        /**
         * The shell's own component rows, which this bundle's page replaces.
         *
         * The plugin page has no slot for suppressing them: that section is rendered
         * unconditionally from the bundle's row list, and the hidden slots filter the plugin
         * LIST page, not a bundle's page.
         *
         * An adjacent-sibling rule was tried first and did not work, which means the slot
         * renders the panel inside a wrapper and the rows section is not its sibling. So
         * this rule is unscoped instead, and its scoping comes from which mount renders the
         * tag: suppressRows below is passed by the plugin mount alone, never by the NewMate
         * settings view, so the rule is in the DOM only while the page that needs it is.
         *
         * THE ONE UNSCOPED SELECTOR IN THIS PACKAGE, declared rather than hidden: the
         * data-plugin-rows ATTRIBUTE is not a namespace, so another plugin that put the same
         * attribute on its own element would be styled by it. That cannot happen on the
         * bundle page as the shell renders it today (one bundle per page, and the attribute
         * is the shell's own for its row section). The gate keeps a list of exactly this
         * exception, so a SECOND unscoped selector fails rather than joining it quietly.
         *
         * The panel above replaces what it hides: it names the components and carries their
         * switches, which those rows cannot do.
         */
        const PLUGIN_ROWS_CSS = '[data-plugin-rows] { display: none; }';

        /* ------------------------------------------------------------------ the parts --- */

        /**
         * One button, in whichever of its two forms the shell supports.
         *
         * DSH's own Button carries the shell's exact button tokens, so it is preferred; a
         * shell without the primitives still gets a button, styled from the same tokens, so
         * this format never has to be re-styled for a missing module. Both forms take the
         * same props, so a call site names the role rather than the implementation.
         */
        function ConfigButton({ variant, size, onClick, disabled, title, children }) {
          const kind = variant || 'outline';
          if (typeof UpdateButton === 'function') {
            return h(UpdateButton, { variant: kind, size, onClick, disabled, title }, children);
          }
          return h('button', {
            type: 'button',
            className: kind === 'primary' ? 'nmc-action nmc-action-primary' : 'nmc-action',
            onClick, disabled, title,
          }, children);
        }

        /** The page frame every configuration surface is rendered inside. */
        function ConfigPage({ title, subtitle, mark, actions, sections, suppressRows }) {
          return h('section', { className: 'nmc-page', 'aria-label': title },
            h('style', null, CONFIG_CSS + NEWMATE_SLIDER_CSS + (suppressRows ? PLUGIN_ROWS_CSS : '')),
            h('header', { className: 'nmc-hero' },
              h('div', { className: 'nmc-hero-copy' },
                h('h2', { className: 'nmc-title' }, title),
                subtitle ? h('p', { className: 'nmc-subtitle' }, subtitle) : null),
              h('div', { className: 'nmc-hero-actions' },
                ...(Array.isArray(actions) ? actions.filter(Boolean) : []),
                mark ? h('div', { className: 'nmc-hero-mark', 'aria-hidden': true }, mark) : null)),
            ...(Array.isArray(sections) ? sections.filter(Boolean) : []));
        }

        /** One titled group. The id is the section's identity in the catalogue, not decoration. */
        function ConfigSection({ id, title, note, children }) {
          return h('section', { className: 'nmc-section', 'data-config-section': id, 'aria-label': title },
            h('div', { className: 'nmc-section-head' },
              h('h3', { className: 'nmc-section-title' }, title),
              note ? h('p', { className: 'nmc-section-note' }, note) : null),
            children);
        }

        /** One bordered surface with its own category, title, copy and footer. */
        function ConfigCard({ category, title, description, footer, tone, children }) {
          return h('section', { className: 'nmc-card' + (tone === 'warn' ? ' nmc-card-warn' : ''), 'aria-label': title },
            category ? h('span', { className: 'nmc-card-category' }, category) : null,
            title ? h('h4', { className: 'nmc-card-title' }, title) : null,
            description ? h('p', { className: 'nmc-card-copy' }, description) : null,
            children,
            footer ? h('div', { className: 'nmc-card-foot' }, footer) : null);
        }

        /**
         * One component: what it is called, what it does, what state it is in, and the one
         * action that changes that state. `state` is the Host's answer rendered in words;
         * `note` is the detail that identifies it.
         */
        function ConfigRow({ name, role, state, note, action, on, pending }) {
          return h('li', { className: 'nmc-row' },
            h('span', { className: pending ? 'nmc-dot nmc-dot-pending' : on ? 'nmc-dot nmc-dot-on' : 'nmc-dot', 'aria-hidden': true }),
            h('span', { className: 'nmc-row-name' }, name),
            h('span', { className: 'nmc-row-role' }, role),
            state ? h('span', { className: 'nmc-row-state' }, state) : null,
            h('span', { className: 'nmc-row-note' }, note),
            action || null);
        }

        /** One labelled control. `inline` puts the label beside it instead of above. */
        function ConfigField({ id, label, hint, control, inline }) {
          return h('div', { className: 'nmc-field' + (inline ? ' nmc-field-inline' : '') },
            h('label', { className: 'nmc-field-label', htmlFor: id }, label),
            h('div', { className: 'nmc-field-control' }, control),
            hint ? h('p', { className: 'nmc-field-hint' }, hint) : null);
        }

        /** One line of state. `tone` is what it means, not how it is coloured. */
        function ConfigNote({ tone, children }) {
          const kind = tone === 'warn' ? 'nmc-note-warn' : tone === 'error' ? 'nmc-note-error' : 'nmc-note';
          return h('p', { className: kind, role: tone === 'error' ? 'alert' : undefined }, children);
        }

        /** The one toggle shape: a switch role, its track, and its label. */
        function ConfigSwitch({ id, label, checked, disabled, onChange }) {
          return h('button', {
            id, type: 'button', role: 'switch', className: 'nmc-switch',
            'aria-checked': checked === true, 'aria-label': label, disabled,
            onClick: () => onChange?.(checked !== true),
          },
            h('span', { className: 'nmc-switch-track', 'aria-hidden': true }, h('span', { className: 'nmc-switch-knob' })),
            h('span', { className: 'nmc-switch-label' }, label));
        }

        /** A select over an explicit option list; `groups` renders optgroups instead. */
        function ConfigSelect({ id, label, value, options, groups, onChange, disabled }) {
          const flat = Array.isArray(options) ? options : [];
          const nested = Array.isArray(groups) ? groups : [];
          return h('select', {
            id, className: 'nmc-select', value: value === undefined ? '' : value,
            'aria-label': label, disabled,
            onChange: event => onChange?.(event.target.value),
          },
            ...flat.map(option => h('option', { key: String(option.value), value: option.value, disabled: option.disabled === true }, option.label)),
            ...nested.map(group => h('optgroup', { key: group.id, label: group.label },
              ...(group.options || []).map(option => h('option', { key: String(option.value), value: option.value, disabled: option.disabled === true }, option.label)))));
        }

        /** A number field with the unit read out beside it and its own hint. */
        function ConfigNumber({ id, label, value, min, max, step, unit, hint, onChange, disabled }) {
          return h(ConfigField, {
            id, label, hint,
            control: h(React.Fragment, null,
              h('input', {
                id, type: 'number', className: 'nmc-number', value,
                min, max, step, disabled, 'aria-label': label,
                onChange: event => onChange?.(Number(event.target.value)),
              }),
              unit ? h('span', { className: 'nmc-unit' }, unit) : null),
          });
        }
        /* -------------------------------------------------------- the components list --- */

        /**
         * The components this bundle composes, named as their products — one list, read by
         * the components section on every mount. `mounted` and `absent` are the words the row
         * says when the Host reports the component running or not; a component whose note
         * needs a live fact (the lease, the snapshot root) supplies it through `note`.
         */
        const CONFIG_COMPONENTS = [
          { key: 'core', name: 'Newmark Core', role: 'shared user store, page snapshot', switchable: false },
          { key: 'memoryLab', name: 'MemoryLab', role: 'durable memory, nine memory_lab_* tools, sidebar renderer', switchable: true, mounted: 'store mounted', absent: 'not loaded' },
          { key: 'computerUse', name: 'ComputerUse', role: '21 computer_use actions, native screen-wide takeover stroke', switchable: true },
          { key: 'agentApi', name: 'Agent API', role: '标准化的 Agent 调用接口：信封、错误分级、只读状态与 agent run', switchable: true, mounted: 'interface mounted', absent: 'not loaded' },
          { key: 'newMate', name: 'NewMate', role: 'MemoryLab 驱动的陪伴内核、持久任务与低成本文件测量', switchable: true, mounted: 'kernel mounted', absent: 'not loaded' },
          { key: 'heartBeat', name: 'heartBeat', role: 'DSH 全局重启与重启后向当前对话 / NewMate 投递任务', switchable: true, mounted: 'restart delivery mounted', absent: 'not loaded' },
        ];

        /**
         * The components section.
         *
         * Everything the row says is the Host's answer, never the click: `applied[key]` is the
         * receipt of the last switch, the note prefers the Host's own `detail` over the row's
         * prose, and a failed switch prints the status, the error code and the detail together —
         * showing one of them has already cost a diagnosis round.
         */
        function ConfigComponents({ model }) {
          const rows = CONFIG_COMPONENTS.map(entry => {
            const answer = model.applied[entry.key];
            const answered = answer && answer.ok === true && typeof answer.mounted === 'boolean';
            // `on` is null until something has answered: the page snapshot may be absent and the
            // route may not have replied yet, and a row that renders that as 已禁用 tells the user
            // five running components are off. The measured case: opening the page showed
            // 已禁用 / not loaded for all five rows, then 已启用 a moment later.
            const on = answered ? answer.mounted : model.on(entry.key);
            const unknown = on === null || on === undefined;
            const failed = Boolean(answer && answer.ok === false);
            const note = failed
              ? [answer.httpStatus ? 'HTTP ' + answer.httpStatus : null, answer.error ? String(answer.error) : null, answer.detail ? String(answer.detail) : null].filter(Boolean).join(' · ') || 'failed'
              : answered && answer.detail ? String(answer.detail) : unknown ? '' : model.note(entry.key, on === true);
            return h(ConfigRow, {
              key: entry.key,
              name: entry.name,
              role: entry.role,
              on: on === true,
              pending: unknown,
              state: failed ? '切换失败' : unknown ? '读取中…' : on ? '已启用' : '已禁用',
              note,
              action: entry.switchable
                ? h(ConfigButton, {
                    variant: on === true ? 'outline' : 'primary',
                    disabled: model.pending === entry.key || unknown,
                    onClick: () => model.toggle(entry.key, on !== true),
                  }, model.pending === entry.key ? '…' : on ? '禁用' : '启用')
                : null,
            });
          });
          return h('ul', { className: 'nmc-list' }, ...rows);
        }

        /* --------------------------------------------------------------- the model card --- */

        /**
         * The authorised model.
         *
         * Four states are kept apart on purpose: not read yet, nothing authorised, authorised
         * and listed, authorised and GONE. The last two must never look alike — a stale
         * selection that reads as fine fails at run time with the provider's own error, which
         * is the expensive way to learn it. The control shows the Host's answer and never a
         * click, and an authorised model that is no longer offered stays selected and labelled
         * rather than falling back to some other model's name.
         */
        function ConfigModelCard({ model }) {
          const state = model.state;
          const chosen = state && state.selected ? state.selected.provider + '\u0000' + state.selected.model : '';
          const groups = state && Array.isArray(state.groups) ? state.groups : [];
          const offered = groups.some(group => (group.models || []).some(entry => entry.provider + '\u0000' + entry.id === chosen));
          const options = [];
          if (chosen && !offered) options.push({ value: chosen, label: state.selected.provider + ' / ' + state.selected.model + ' —— 不在当前可用列表中' });
          if (chosen && !offered) options.unshift({ value: '', label: '— 请重新选择 —', disabled: true });
          const grouped = groups.map(group => ({
            id: group.id,
            label: group.name || group.id,
            options: (group.models || []).map(entry => ({
              value: entry.provider + '\u0000' + entry.id,
              label: entry.name && entry.name !== entry.id ? entry.name + ' (' + entry.id + ')' : entry.id,
            })),
          }));
          const empty = state && state.ok === true && (state.models || []).length === 0 && (state.failures || []).length === 0;
          return h(ConfigCard, {
            title: '准用模型',
            footer: model.error ? h(ConfigNote, { tone: 'warn' }, model.error) : null,
          },
            h(ConfigNote, { tone: state !== null && state.selectedListed === false ? 'warn' : 'plain' },
              state === null
                ? '读取中…'
                : state.selected
                  ? '已准用：' + state.selected.provider + ' / ' + state.selected.model
                  : '尚未准用任何模型 —— agent-api 会以 model_not_selected 拒绝运行，不会替用户选择'),
            state !== null && state.selected && state.selectedListed === false
              ? h(ConfigNote, { tone: 'warn' }, '⚠ 已准用的模型当前不在 DSH 的可用列表中：provider 已移除、凭据失效或模型已下线。运行会在开始前被拒绝（model_unavailable），请重新准用一个。')
              : null,
            state !== null && state.selected && state.selectedListed === null
              ? h(ConfigNote, { tone: 'warn' }, '该模型所属的 provider 这次未能枚举，因此它是否仍可用未经验证（不是「已失去」）：运行会照常尝试，若 provider 真的不在，失败会带 provider 自己的报错。')
              : null,
            state === null ? null : state.ok !== true
              ? h(ConfigNote, { tone: 'warn' }, '无法读取 DSH 的可用模型列表：' + (state.detail || state.error || 'unknown') + '。模型选择不可用；上面的组件开关不受影响。')
              : h(ConfigField, {
                  id: 'nmc-model', label: '模型', inline: true,
                  control: h(React.Fragment, null,
                    h(ConfigSelect, {
                      id: 'nmc-model', label: '准用模型', value: chosen,
                      options: chosen ? options : [{ value: '', label: '— 尚未准用 —' }, ...options],
                      groups: grouped,
                      disabled: model.busy || !model.loaded || state.editable === false,
                      onChange: value => { const parts = String(value || '').split('\u0000'); model.save(parts[0], parts[1]); },
                    }),
                    model.busy ? h('span', { className: 'nmc-unit' }, '写入中…') : null),
                }),
            state !== null && Array.isArray(state.failures) && state.failures.length > 0
              ? h(ConfigNote, null, 'provider 枚举失败：' + state.failures.map(failure => (failure.id || failure.name) + ': ' + failure.message).join(' · '))
              : null,
            empty ? h(ConfigNote, null, 'DSH 当前没有列出任何可用模型。') : null,
            state !== null && state.defaultSelection
              ? h(ConfigNote, null, 'DSH 的默认模型是 ' + state.defaultSelection.provider + ' / ' + state.defaultSelection.model + '（仅供参考；本 bundle 只用上面准用的模型，未准用时拒绝运行）。')
              : null,
            state !== null && state.editable === false
              ? h(ConfigNote, null, '此 profile 的配置编辑器不可用，因此这个选择无法写入 profile patch；开关不受影响。')
              : null);
        }

        /* ----------------------------------------------------------- the companion card --- */

        /**
         * The companion and the workspace monitor — the one card both mounts render.
         *
         * Field for field this is the page the user already had; what changed is that it is
         * declared here and mounted twice, so the plugin page and the NewMate settings view
         * cannot drift apart. The save is one patch of the settings object, exactly as the
         * route validates it.
         */
        function ConfigCompanionCard({ model }) {
          const settings = model.settings || {};
          const watch = model.watch || {};
          const wechat = model.wechat || {};
          const busy = model.busy === true;
          const [qrOpen, setQrOpen] = React.useState(false);
          const save = patch => model.save(patch);
          // While the QR window is open the card keeps asking, because the code arrives from
          // WeChat after the connect call returns. The NewMate mount needs no such poll: the
          // page behind it already reads the same route every two seconds.
          React.useEffect(() => {
            if (!qrOpen) return undefined;
            const timer = setInterval(() => { try { model.refresh?.(); } catch {} }, 1500);
            return () => clearInterval(timer);
          }, [qrOpen]);
          const quietOptions = Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: String(hour).padStart(2, '0') + ':00' }));
          return h(ConfigCard, {
            title: '陪伴与工作区监控',
            description: '两页写的是同一份设置：开关立即生效，对比间隔从下一轮开始算，不会打断正在进行的那一轮。',
          },
            h('div', { className: 'nmc-row-fields' },
              h(ConfigSwitch, {
                id: 'nmc-initiative', label: '允许主动陪伴',
                checked: settings.initiative !== false, disabled: busy,
                onChange: value => save({ initiative: value }),
              }),
              h(ConfigNote, null, '不用你先开口，也会在合适的空隙聊聊；没有具体内容时保持沉默。'),
              h(ConfigField, {
                id: 'nmc-pace', label: '主动性', inline: true,
                control: h(ConfigSelect, {
                  id: 'nmc-pace', label: '主动性', value: settings.pace || 'balanced', disabled: busy,
                  options: [
                    { value: 'quiet', label: '低 · 更少打扰' },
                    { value: 'balanced', label: '中 · 均衡' },
                    { value: 'active', label: '高 · 更主动' },
                  ],
                  onChange: value => save({ pace: value }),
                }),
              }),
              h(ConfigNote, null, '主动性同时决定触发阈值（当前 ' + (watch.threshold ?? 0.6) + '）和安静时间的权重；没有每日条数上限，间距与静默时段仍然生效。'),
              h(ConfigField, {
                label: '静默时段（北京时间）', inline: true,
                control: h(React.Fragment, null,
                  h(ConfigSelect, { id: 'nmc-quiet-start', label: '静默开始时间', value: settings.quietStart ?? 23, options: quietOptions, disabled: busy, onChange: value => save({ quietStart: Number(value) }) }),
                  h('span', { className: 'nmc-unit' }, '至'),
                  h(ConfigSelect, { id: 'nmc-quiet-end', label: '静默结束时间', value: settings.quietEnd ?? 8, options: quietOptions, disabled: busy, onChange: value => save({ quietEnd: Number(value) }) })),
              }),
              h('div', { className: 'nmc-actions' },
                h(ConfigButton, { variant: 'outline', disabled: busy, onClick: () => save({ snoozeUntil: Date.now() + 8 * 3600000 }) }, '暂停主动陪伴 8 小时'),
                (settings.snoozeUntil || 0) > Date.now()
                  ? h(ConfigButton, { variant: 'outline', disabled: busy, onClick: () => save({ snoozeUntil: 0 }) }, '恢复主动陪伴')
                  : null),
              h('hr', { className: 'nmc-rule' }),
              h(ConfigSwitch, {
                id: 'nmc-watch', label: '对比工作区文件变动',
                checked: settings.watchEnabled !== false, disabled: busy,
                onChange: value => save({ watchEnabled: value }),
              }),
              h(ConfigNote, null, '启动时对比一次，之后按间隔重复；只比较文件数量、名称与最新修改时间，不读取文件内容。'),
              h(ConfigNumber, {
                id: 'nmc-watch-interval', label: '对比间隔', unit: '分钟',
                value: settings.watchIntervalMinutes ?? 30, min: 5, max: 1440, step: 5, disabled: busy,
                hint: '范围 5–1440。',
                onChange: value => save({ watchIntervalMinutes: Number(value) }),
              }),
              h(ConfigNote, null, '扫描深度与 DSH 自建改动权重保留默认值（3 层 / 0.1 倍）：深度可在插件配置里调整，权重是固定默认值，两页都不再提供开关。'),
              h('hr', { className: 'nmc-rule' }),
              h('div', { className: 'nmc-actions' },
                h('span', { className: 'nmc-field-label' }, '微信 ClawBot'),
                h('span', { className: 'nmc-unit' }, wechatPhaseText(wechat)),
                h(ConfigButton, {
                  variant: wechat.connected ? 'outline' : 'primary', disabled: busy,
                  onClick: async () => { try { await model.connectWechat?.(); } finally { setQrOpen(true); } },
                }, wechat.connected ? '重新连接' : '发起连接')),
              h(ConfigNote, null, wechatHint(wechat))),
            model.error ? h(ConfigNote, { tone: 'error' }, model.error) : null,
            qrOpen && UpdateModal ? h(UpdateModal, {
              open: true, title: '连接微信 ClawBot', closeLabel: '取消',
              onClose: () => setQrOpen(false),
              description: wechat.connected
                ? '已连接。关闭这个窗口即可，无需再扫码。'
                : wechat.waiting
                  ? '用手机微信扫描下面的二维码：我 → 设置 → 插件 → 微信 ClawBot → 扫描二维码。绑定成功后这里会自动变成已连接。'
                  : '正在向微信申请二维码…',
              footer: h(React.Fragment, null,
                h(ConfigButton, { variant: 'outline', onClick: () => model.connectWechat?.() }, '重新生成二维码'),
                h(ConfigButton, { variant: 'primary', onClick: () => setQrOpen(false) }, wechat.connected ? '完成' : '关闭')),
            }, wechat.qr && wechat.qr.image
              ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: 12, background: 'var(--dsw-alias-bg-base)', borderRadius: 12, width: 'fit-content', margin: '4px auto 0' } },
                  h('img', { src: wechat.qr.image, alt: '微信 ClawBot 绑定二维码', width: 260, height: 260, style: { display: 'block', imageRendering: 'pixelated' } }))
              : h('p', { className: 'nmc-note', style: { textAlign: 'center', minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, '正在向微信申请二维码…')) : null);
        }
        /* ------------------------------------------------------------- the desktop card --- */

        /** The desktop pet's size: the same control the pet's own menu renders. */
        function ConfigDesktopCard({ model }) {
          return h(ConfigCard, {
            title: 'NewMate',
            description: '显示大小在此调整并自动保存；桌宠右键可退出伴随或打开设置。',
            footer: model.error ? null : '默认 100% · 自动保存，启动时恢复上次大小',
          },
            h(NewMateSizeControl, {
              value: model.scale === null || model.scale === undefined ? 1 : model.scale,
              onChange: model.save,
              disabled: model.scale === null || model.scale === undefined,
              title: '显示大小',
            }),
            model.error ? h(ConfigNote, { tone: 'error' }, model.error) : null);
        }

        /* -------------------------------------------------------------- the update card --- */

        /**
         * The bundle's own update, from this page only.
         *
         * The check asks the Host's update route, compares the installed version with npm's
         * latest, asks the user through the shell's own confirmation modal, then installs the
         * named tarball and restarts through the restart helper. A downgrade is refused rather
         * than performed: an older official release is not an update.
         */
        function ConfigUpdateCard({ model }) {
          return h(ConfigCard, {
            title: 'Newmark Core',
            description: '统一更新五个组件，重启后任务由 heartBeat 接续。',
          },
            h('div', { className: 'nmc-actions' },
              h(ConfigButton, { variant: 'outline', disabled: model.busy, onClick: model.check }, model.busy ? '处理中…' : '检查更新')),
            h(ConfigNote, null, model.message),
            model.prompt && UpdateModal
              ? h(UpdateModal, {
                  open: true, title: '更新 Newmark Core', closeLabel: '取消',
                  onClose: () => model.decide(false),
                  description: '当前 ' + model.prompt.current + ' → 最新 ' + model.prompt.latest + '。所有组件将一并更新；安装成功后会结束当前 DSH 及其任务进程并重新启动。',
                  footer: h(React.Fragment, null,
                    h(ConfigButton, { variant: 'outline', onClick: () => model.decide(false) }, '取消'),
                    h(ConfigButton, { variant: 'primary', onClick: () => model.decide(true) }, '更新并重启')),
                })
              : null);
        }

        /* ------------------------------------------------------------- the catalogue --- */

        /**
         * The catalogue: which sections exist, in which order, and what each renders.
         *
         * Both mounts walk CONFIG_SECTION_ORDER, so the plugin page and the NewMate settings
         * view show the same sections in the same order. A section added here appears on both;
         * a section removed here leaves both. That is the lock.
         */
        const CONFIG_SECTION_ORDER = ['components', 'model', 'companion', 'desktop', 'update'];
        const CONFIG_SECTIONS = {
          components: {
            title: '组件',
            note: '五个组件同装同卸，开关立即生效。',
            render: model => h(ConfigComponents, { model: model.components }),
          },
          model: {
            title: '智能体',
            note: '运行用哪个模型由这里决定；未准用时拒绝运行。',
            render: model => h('div', { className: 'nmc-grid' }, h(ConfigModelCard, { model: model.model })),
          },
          companion: {
            title: '陪伴',
            note: '主动陪伴与工作区监控在同一张卡里；与 DSH 工作区会话无关。',
            render: model => h('div', { className: 'nmc-grid' }, h(ConfigCompanionCard, { model: model.companion })),
          },
          desktop: {
            title: '桌面助手',
            note: '桌宠的大小，与陪伴开关分开。',
            render: model => h('div', { className: 'nmc-grid' }, h(ConfigDesktopCard, { model: model.desktop })),
          },
          update: {
            title: '版本管理',
            note: '一个 tarball、一次重启。',
            render: model => h('div', { className: 'nmc-grid' }, h(ConfigUpdateCard, { model: model.update })),
          },
        };

        /**
         * The two mounts.
         *
         * `suppressRows` is the only difference that is not prose: the shell's component rows
         * exist on the plugin page and nowhere else, so only that mount renders the rule that
         * hides them.
         */
        const CONFIG_MOUNTS = {
          plugin: {
            title: 'Newmark2DSH',
            subtitle: '记忆、执行与陪伴，在一处管理。下面的陪伴与桌面设置与 NewMate 设置页是同一份内容。',
            suppressRows: true,
          },
          newmate: {
            title: 'NewMate 设置',
            subtitle: '与 DSH 插件配置页（Newmark Core → 配置）是同一份内容：下面每个开关在两处都能改。',
            suppressRows: false,
          },
        };

        /** One page, rendered from the catalogue against one set of surfaces. */
        function ConfigSurface({ mount, core, companion, actions }) {
          const spec = CONFIG_MOUNTS[mount] || CONFIG_MOUNTS.plugin;
          const model = { ...core, companion };
          return h(ConfigPage, {
            title: spec.title,
            subtitle: spec.subtitle,
            mark: h('span', { className: 'nmc-mark' }, 'N'),
            suppressRows: spec.suppressRows,
            actions: actions || [],
            sections: CONFIG_SECTION_ORDER.map(id => {
              const section = CONFIG_SECTIONS[id];
              return h(ConfigSection, { key: id, id, title: section.title, note: section.note }, section.render(model));
            }),
          });
        }
        /* ------------------------------------------------------------------ the data --- */

        /**
         * The bundle's own control surface: the components, the authorised model, the pet's
         * size and the update.
         *
         * One GET answers the components and the model together, because the route answers
         * them together — there is no second channel and no second source of truth. After
         * every write the surface asks again rather than trusting the POST's receipt: the
         * POST reports whether the Host accepted the change, and only the next read reports
         * whether it took effect. Those are not the same thing, and a page that renders the
         * receipt would be describing a click.
         */
        function useCoreSurface() {
          const state = useMemoryLab();
          const payload = state && typeof state.payload === 'object' ? state.payload : null;
          const components = payload && typeof payload.components === 'object' && payload.components ? payload.components : {};
          const lease = payload && typeof payload.computerUse === 'object' && payload.computerUse ? payload.computerUse : null;

          const [pending, setPending] = React.useState('');
          const [applied, setApplied] = React.useState({});
          const [loaded, setLoaded] = React.useState(false);
          const [hostCompose, setHostCompose] = React.useState(null);
          const [updateMessage, setUpdateMessage] = React.useState('所有组件随 Newmark Core 统一更新。');
          const [updateBusy, setUpdateBusy] = React.useState(false);
          const [updatePrompt, setUpdatePrompt] = React.useState(null);
          const updateLock = React.useRef(false);
          const updateDecision = React.useRef(null);
          const decideUpdate = confirmed => {
            const resolve = updateDecision.current;
            updateDecision.current = null;
            setUpdatePrompt(null);
            resolve?.(confirmed);
          };
          React.useEffect(() => () => {
            updateDecision.current?.(false);
            updateDecision.current = null;
          }, []);

          /** Read the component rows and the composed switches. */
          const readState = () =>
            fetch('/newmark-core/components')
              .then(response => response.json().catch(() => ({})).then(body => ({ ...body, httpStatus: response.status })))
              .then(result => {
                if (!result || !Array.isArray(result.components)) return false;
                if (typeof result.compose === 'boolean') setHostCompose(result.compose);
                const next = {};
                for (const entry of result.components) next[entry.name] = { ok: true, mounted: entry.mounted === true, detail: entry.detail };
                setApplied(current => ({ ...current, ...next }));
                return true;
              })
              .catch(() => false);

          const [modelState, setModelState] = React.useState(null);
          const [modelBusy, setModelBusy] = React.useState(false);
          const [modelError, setModelError] = React.useState('');

          /**
           * Read the authorised model and the models DSH offers. A catalogue that could not be
           * read leaves ok:false with the Host's own detail, which is what the card renders; a
           * silent empty list would look exactly like DSH has no models.
           */
          const readModel = () =>
            fetch('/newmark-core/components')
              .then(response => response.json().catch(() => ({})).then(body => ({ ...body, httpStatus: response.status })))
              .then(body => {
                const answer = body && typeof body.model === 'object' && body.model ? body.model : null;
                setModelState(answer === null ? { ok: false, error: 'no_model_answer', detail: 'the route answered HTTP ' + (body?.httpStatus ?? 'nothing') + ' with no model block' } : answer);
                return answer;
              })
              .catch(error => {
                setModelState({ ok: false, error: 'model_read_failed', detail: String((error && error.message) || error) });
                return null;
              });

          React.useEffect(() => {
            let live = true;
            readState().then(() => { if (live) setLoaded(true); });
            readModel();
            return () => { live = false; };
          }, []);

          /** Persist one model choice, then ask what is true. Never optimistic. */
          const saveModel = (provider, model) => {
            if (!provider || !model) return;
            setModelBusy(true);
            setModelError('');
            fetch('/newmark-core/components', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ component: 'model', provider, model }),
            })
              .then(response => response.json().catch(() => ({})).then(body => ({ ...body, httpStatus: response.status, ok: body && body.ok === true })))
              .then(result => {
                if (result.ok !== true) {
                  setModelError([
                    result.httpStatus ? 'HTTP ' + result.httpStatus : null,
                    result.error ? String(result.error) : null,
                    result.detail ? String(result.detail) : null,
                  ].filter(Boolean).join(' · ') || 'the write failed');
                }
                return readModel();
              })
              .catch(error => setModelError(String((error && error.message) || error)))
              .then(() => setModelBusy(false));
          };

          /** ONE path for every switch: POST the desired state, then read what is true. */
          const toggle = (key, next) => {
            setPending(key);
            fetch('/newmark-core/components', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ component: key, enabled: next }),
            })
              .then(response => response.json().catch(() => ({})).then(body => ({ ...body, httpStatus: response.status, ok: body && body.ok === true })))
              .then(result => {
                setApplied(current => ({ ...current, [key]: result }));
                if (result.ok && typeof result.mounted === 'boolean' && typeof window.CustomEvent === 'function') {
                  window.dispatchEvent(new window.CustomEvent('newmark-component-change', { detail: { key, mounted: result.mounted } }));
                }
                return readState();
              })
              .catch(error => setApplied(current => ({ ...current, [key]: { ok: false, error: String(error) } })))
              .then(() => setPending(''));
          };

          /** The pet's display size, written through the same route and read back from it. */
          const [petScale, setPetScale] = React.useState(null);
          const [petError, setPetError] = React.useState('');
          const petWrite = React.useRef({ pending: null, busy: false, revision: 0, live: true });
          React.useEffect(() => {
            const control = petWrite.current;
            control.live = true;
            const read = async () => {
              const revision = control.revision;
              if (control.busy || control.pending !== null) return;
              try {
                const response = await fetch('/newmark-core/components?view=newMate');
                const body = await response.json();
                if (control.live && revision === control.revision && body.newMate) {
                  setPetScale(body.newMate.sizeMultiplier);
                  setPetError(body.newMate.ok ? '' : body.newMate.error);
                }
              } catch (error) { if (control.live) setPetError(error.message); }
            };
            read();
            const timer = setInterval(read, 1000);
            return () => { control.live = false; clearInterval(timer); };
          }, []);
          const savePetScale = async value => {
            setPetScale(value);
            const control = petWrite.current;
            control.pending = value;
            control.revision++;
            if (control.busy) return;
            control.busy = true;
            try {
              while (control.pending !== null) {
                const next = control.pending;
                control.pending = null;
                const response = await fetch('/newmark-core/components', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ component: 'newMate', sizeMultiplier: next }) });
                const result = await response.json();
                if (!response.ok || !result.ok) throw Error(result.error || '大小保存失败');
                if (control.live) setPetError('');
              }
            } catch (error) { if (control.live) setPetError(error.message); control.pending = null; }
            finally { control.busy = false; }
          };

          /** Install the named release, then restart through the restart helper. */
          const updateCore = async () => {
            if (updateLock.current) return;
            updateLock.current = true;
            setUpdateBusy(true);
            let requested = false;
            try {
              const manager = coreUpdateManager;
              if (!manager) throw new Error('当前宿主的插件管理服务尚未就绪');
              const response = await fetch('/newmark-core/update', { cache: 'no-store', credentials: 'same-origin' });
              if (response.status === 404 || response.status === 405) throw new Error('当前宿主尚未加载更新接口，请完全退出并重启 DSH');
              if (response.status === 401 || response.status === 403) throw new Error('当前页面认证已失效，请重新打开 DSH 插件配置页');
              const text = await response.text();
              if (!text.trim()) throw new Error('更新接口返回空响应（HTTP ' + response.status + '），请完全重启 DSH 后重试');
              let latest;
              try { latest = JSON.parse(text); }
              catch { throw new Error('更新接口返回非 JSON 响应（HTTP ' + response.status + '），请完全重启 DSH 后重试'); }
              if (!response.ok || !latest.ok) throw new Error(latest.error || '无法查询最新版');
              const installed = await manager.listBundles();
              if (!installed.ok) throw new Error(installed.error?.message || '无法读取已安装版本');
              const currentVersion = installed.value.find(bundle => bundle.name === 'newmark2dsh')?.version;
              if (/^\d+\.\d+\.\d+$/.test(currentVersion || '')) {
                const currentParts = currentVersion.split('.').map(Number), nextParts = latest.latest.split('.').map(Number);
                const different = currentParts.findIndex((part, index) => part !== nextParts[index]);
                if (different >= 0 && currentParts[different] > nextParts[different]) {
                  setUpdateMessage('已安装 ' + currentVersion + '，官方 latest 暂为 ' + latest.latest + '；未执行降级。');
                  return;
                }
              }
              if (currentVersion === latest.latest) {
                setUpdateMessage('已安装最新版本 ' + latest.latest + '；若刚完成更新，请完全重启 DSH。');
                return;
              }
              if (!UpdateModal || !UpdateButton) throw new Error('当前宿主的确认弹窗组件不可用');
              setUpdateMessage('发现新版本 ' + latest.latest + '，等待确认。');
              const confirmed = await new Promise(resolve => {
                updateDecision.current = resolve;
                setUpdatePrompt({ current: currentVersion || latest.current, latest: latest.latest });
              });
              if (!confirmed) { setUpdateMessage('已取消更新。'); return; }
              const restartRequest = async input => {
                const answer = await fetch('/newmark-core/update', {
                  method: 'POST', credentials: 'same-origin',
                  headers: { 'content-type': 'application/json', 'x-newmark-restart': '1' },
                  body: JSON.stringify(input),
                });
                const body = await answer.text();
                let result;
                try { result = JSON.parse(body); } catch { throw new Error('重启辅助宿主返回无效响应'); }
                if (!answer.ok || !result.ok) throw new Error(result.error || '重启辅助宿主未就绪');
                return result;
              };
              const restart = await restartRequest({ action: 'prepare', version: latest.latest });
              setUpdateMessage('正在更新 Newmark Core 至 ' + latest.latest + '…');
              requested = true;
              // The authoritative tarball names exactly the selected release. It avoids
              // pnpm's bare-name age fallback without changing the user's pnpm policies.
              const answer = await manager.installBundle(latest.tarball, {
                enabled: true, registry: latest.registry, requestId: crypto.randomUUID(),
              });
              if (!answer.ok) throw new Error(answer.error?.message || '安装结果不可用，请查看 DSH 插件管理记录');
              const receipt = answer.value;
              if (!['applied', 'restart-required'].includes(receipt.application)) {
                throw new Error(receipt.error?.diagnostic || '安装返回状态：' + receipt.application);
              }
              const after = await manager.listBundles();
              if (!after.ok || after.value.find(bundle => bundle.name === 'newmark2dsh')?.version !== latest.latest) {
                throw new Error('安装后的版本核验未通过，请查看 DSH 插件管理记录');
              }
              setUpdateMessage('已安装 ' + latest.latest + '，正在完整重启 DSH…');
              await restartRequest({ action: 'restart', ticket: restart.ticket });
            } catch (error) {
              setUpdateMessage((requested ? '更新未确认' : '更新失败') + '：' + (error.message || error) + '。未回退旧版本。');
            } finally { updateLock.current = false; setUpdateBusy(false); }
          };

          // true / false / null. null means NOTHING HAS BEEN READ: the page snapshot is absent and
          // the control route has not answered, so "off" would be a guess the user reads as a fact.
          const on = key => {
            if (key === 'core') return hostCompose === null ? (payload ? Boolean(payload.root) : null) : hostCompose;
            if (components[key] === true) return true;
            return payload ? false : null;
          };
          const note = (key, running) => {
            if (key === 'core') return payload && payload.root ? payload.root : 'no snapshot on this page';
            if (key === 'computerUse') {
              return running
                ? lease ? (lease.held ? 'lease held by ' + (lease.ownerId || 'unknown') : 'loaded, lease free') : 'loaded, lease state unavailable'
                : 'not loaded';
            }
            const entry = CONFIG_COMPONENTS.find(row => row.key === key) || {};
            return running ? entry.mounted || 'loaded' : entry.absent || 'not loaded';
          };

          return {
            components: { applied, pending, loaded, on, note, toggle },
            model: { state: modelState, busy: modelBusy, error: modelError, save: saveModel, loaded },
            desktop: { scale: petScale, error: petError, save: savePetScale },
            update: { message: updateMessage, busy: updateBusy, check: updateCore, prompt: updatePrompt, decide: decideUpdate },
          };
        }
        /**
         * The companion settings, read and written through NewMate's own route.
         *
         * The route validates the patch (an unknown key is refused outright), so the page
         * sends the smallest patch and then shows whatever the next read says. It keeps no
         * local copy of the settings: two copies of a settings object is how a page starts
         * disagreeing with the store it is supposed to be describing.
         */
        function useCompanionSurface() {
          const [snapshot, setSnapshot] = React.useState(null);
          const [busy, setBusy] = React.useState(false);
          const [error, setError] = React.useState('');
          const read = async () => {
            const response = await fetch('/newmark-newmate', { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok || !body.ok) throw Error(body.error || '读取失败');
            setSnapshot(body);
            return body;
          };
          React.useEffect(() => {
            let live = true;
            read().catch(failure => { if (live) setError(failure.message || String(failure)); });
            return () => { live = false; };
          }, []);
          const post = async input => {
            const response = await fetch('/newmark-newmate', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-newmark-newmate': '1' },
              body: JSON.stringify(input),
            });
            const body = await response.json();
            if (!response.ok || !body.ok) throw Error(body.error || '提交失败');
            return body;
          };
          const write = async input => {
            setBusy(true);
            setError('');
            try { await post(input); await read(); }
            catch (failure) { setError(failure.message || String(failure)); }
            finally { setBusy(false); }
          };
          return {
            settings: (snapshot && snapshot.settings) || {},
            watch: (snapshot && snapshot.watch) || {},
            wechat: (snapshot && snapshot.wechat) || {},
            busy, error,
            save: settings => write({ action: 'settings', settings }),
            connectWechat: () => write({ action: 'wechat-connect' }),
            refresh: () => { read().catch(() => {}); },
          };
        }

        /** How WeChat's own state reads in one word; the long sentence lives in wechatHint. */
        function wechatPhaseText(wechat) {
          if (!wechat || !wechat.phase || wechat.phase === 'disconnected') return '未连接';
          if (wechat.phase === 'connected') return '已连接';
          if (wechat.phase === 'waiting_scan') return '等待扫码…';
          if (wechat.phase === 'error') return '出错 ' + (wechat.error || '');
          return '未连接';
        }

        /** What a connection means while it is being made and after it is. */
        function wechatHint(wechat) {
          if (!wechat || !wechat.connected) {
            return '未连接。点「发起连接」弹出二维码；绑定信息只保存在本机，重启后自动恢复；点「重新连接」会清除旧登录并重新扫码。';
          }
          return '已连接。微信里发来的话等于你在页面上发信（运行中同样插入引导）；发来的图片、视频与文件也会存到本机，和页面上传共用同一套存储（图片与文档本身不解析，只按名称与字节数转述）。NewMate 的最终回复只以纯文字气泡发回微信，不转发思考、工具或主动消息。';
        }

        /**
         * How the plugin page opens the other mount. Written by `apply`, which owns `ctx`; a
         * factory-scope seat keeps the registration line naming the component itself instead of
         * a wrapper. Null until `apply` runs, which is why the action is conditional.
         */
        let openNewMateSeat = null;

        /**
         * The bundle's page, in the seat the shell gives a bundle (`plugins.bundle.config`).
         *
         * It renders the catalogue, and its one hero action points at the other mount of the
         * same catalogue: NewMate's own settings view. That is the direction the two pages are
         * locked in — this page can open the other, and both are built from one list.
         */
        function NewmarkConfigPanel() {
          const openNewMate = openNewMateSeat;
          const core = useCoreSurface();
          const companion = useCompanionSurface();
          return h(ConfigSurface, {
            mount: 'plugin',
            core,
            companion,
            actions: [
              openNewMate
                ? h(ConfigButton, { variant: 'outline', onClick: openNewMate, title: '在 NewMate 里打开同一份设置' }, 'NewMate 设置')
                : null,
            ],
          });
        }

        /**
         * The NewMate settings view: the same catalogue, mounted inside the NewMate panel.
         *
         * Its companion surface is the panel's own live state rather than a second read of
         * the same route, because this view already renders inside a page that polls it every
         * two seconds. The component, model, desktop and update sections come from the same
         * hook the plugin page uses — a switch here and a switch there are one switch.
         */
        function NewMateSettingsView({ state, act, busy, error, onBack }) {
          const core = useCoreSurface();
          const settings = (state && state.settings) || {};
          const watch = (state && state.watch) || {};
          const wechat = (state && state.wechat) || {};
          const companion = {
            settings, watch, wechat, busy: busy === true, error: error || '',
            save: patch => act({ action: 'settings', settings: patch }),
            connectWechat: () => act({ action: 'wechat-connect' }),
          };
          return h('div', { className: 'nmc-mount' },
            h(ConfigSurface, {
              mount: 'newmate',
              core,
              companion,
              actions: [h(ConfigButton, { variant: 'outline', onClick: onBack }, '返回 NewMate')],
            }));
        }
        // ------------------------------------------------------------ the config page
        //
        // This bundle owns its own page. The rows the card draws are Loader
        // bookkeeping: they name a row and the module it resolved to, which is the wrong
        // thing to show a person. The names that matter are the components, and what
        // matters about them is whether they are running — so they are rendered here, by
        // their product names, from the same page globals the rest of this half reads.
        /**
         * Open NewMate's own settings view from the plugin page.
         *
         * The seat is a function rather than a prop because the panel is registered by the
         * same `apply` that owns `ctx`, and the registration line names the component itself.
         * A layout without selectPanel still dispatches the event: the NewMate panel listens for
         * it wherever it is rendered, so the half that can work is not withheld by the half that
         * cannot.
         */
        openNewMateSeat = () => {
          const layout = ctx.get?.('layout') || ctx.layout;
          layout?.selectPanel?.('newmate');
          window.dispatchEvent(new CustomEvent('newmark-newmate-open-chat', { detail: { settings: true } }));
        };

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
