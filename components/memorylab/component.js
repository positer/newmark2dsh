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
import fs from 'node:fs';
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
        // The graph's size travels with the findings because the prompt states it, and a
        // caller reading the request alone must not have to look anywhere else for it.
        tags: review.counts.tags,
        components: review.counts.components,
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

  /**
   * What a prompt says when there is nothing to send, and when there is nobody to send it to.
   *
   * A review finds nothing, a review cannot be taken, or a question has no evidence: each of
   * those is a real answer, and none of them is a prompt. They are kept apart on purpose —
   * "there is nothing to judge" and "the judgement half is switched off" are different states
   * to be in, and collapsing them into one blank string is how a caller comes to believe a
   * judgement was asked for and came back empty.
   */
  const PROMPT_NOTICES = Object.freeze({
    none: '索引里没有需要判定的事项：确定性重建已经做完，标签图没有留下同义近义、假根父节点或误解析的候选。这不是跳过，也不是失败，是重建后的稳定状态。',
    unavailable: `判定不可用：${AGENT_API_INTERFACE} 已停用，标签判定的三个问题都没有可用的运行来源。这不是跳过，也不是待办——确定性重建不受影响。`,
  });
  const NO_EVIDENCE_NOTICE = '（这一次的审查结果没有返回任何发现，因此没有证据可以呈现。）';
  const REVIEW_UNAVAILABLE_NOTICE = '审查暂时读不出来，所以现在没有可复制的提示词：';

  /**
   * The judgement request as the PROMPT a model is actually sent.
   *
   * The request is the structured half — questions with ids and evidence kinds, the graph's
   * relationship version, the finding counts, an answer shape. Handing that object to a model
   * is handing it a payload. This renders the same thing as the prose a person would write, and
   * it is the only place in this bundle where the three questions become a message:
   *
   *  - the three questions are asked in the USER'S OWN WORDS for them (同义近义 tag 合并 /
   *    假根父节点接续 / 未被正确解析的 tag 误读为单 tag), with their finding kinds attached as
   *    where-to-look, never as the thing being asked;
   *  - the sequence is stated as a procedure: read the evidence, decide, then apply — two calls
   *    with a decision between them, which is what this component has always said it is;
   *  - the guard travels with the prompt (`expectedRelationshipVersion`, archive + undo), so a
   *    run that decides correctly and applies late is refused rather than applied to a graph
   *    something else has already changed;
   *  - and it says what NOT to do, because this store holds real memory: no inventing tags, no
   *    rewriting component bodies, no merging a near-synonym the evidence does not name.
   *
   * It takes the REQUEST, which is the one object both callers already have: `judgementRequest`
   * builds it for a review, and the prompt points a run back at the review for the findings
   * themselves. The one thing it reads about the findings is their count — the request carries
   * them under `findings`, and OF ZERO it produces a notice and no task, because a prompt that
   * asked a model to decide over an empty review would be asking it to invent the repairs. A
   * review passed straight in from the store carries the same numbers as `counts`, so both
   * shapes are read; passing the wrong one used to render `undefined` into the text.
   *
   * The guards below are the difference between a prompt and a trap, and each was a real defect
   * before it was a guard: reading `counts` off the request root silently sent an empty review
   * as a task, and reading the version from `request.graph` alone emitted the placeholder into a
   * prompt that already had it — the request states it in `answer.expectedRelationshipVersion`.
   */
  function judgementPrompt(request) {
    const source = request && typeof request === 'object' ? request : {};
    const questions = Array.isArray(source.questions) ? source.questions : [];
    const graph = source.graph && typeof source.graph === 'object' ? source.graph : {};
    const counts = (source.counts && typeof source.counts === 'object' && source.counts) || (source.findings && typeof source.findings === 'object' && source.findings) || null;
    /* The graph's identity, read from the one place the request states it — with the graph
     * block as the fallback, so a request built the other way round still renders a version. */
    const version = String(source.answer?.expectedRelationshipVersion || graph.relationshipVersion || '');
    const workspace = String(source.workspace || '');

    const notice = (status, text) => ({ status, text: '', notice: text, interface: AGENT_API_INTERFACE, workspace, relationshipVersion: version });

    /* NOTHING TO JUDGE: a notice, and deliberately no task. A prompt that asked a model to decide
     * with no findings would be asking it to invent the repairs, against a store holding real
     * memory — so this branch is the one that must never grow a body. */
    if (counts && Number(counts.total) === 0) return notice('none', PROMPT_NOTICES.none);
    /* A question with no evidence in it is not asked: see the note on PROMPT_NOTICES. */
    const asked = questions.filter((question) => question && Array.isArray(question.evidence) && question.evidence.length > 0);
    if (!asked.length) return notice('none', NO_EVIDENCE_NOTICE);

    const kinds = asked.flatMap((question) => question.evidence.map(String));
    const body = asked.map((question, index) => `${index + 1}. ${String(question.ask || '')}\n   —— 这一类发现（kind）是：${question.evidence.map(String).join('、')}；它们只说明去哪里找证据，不构成结论。`).join('\n');
    const scale = counts
      ? `当前标签图：relationshipVersion = ${version || '（第 1 步返回的那个值）'}；标签 ${counts.tags} 个、记忆组件 ${counts.components} 个；本次审查共报告 ${counts.total} 项待判定（${Object.entries(counts.byKind || {})
          .filter(([, n]) => Number(n) > 0)
          .map(([kind, n]) => `${kind} ${n}`)
          .join('、') || '无'}）。`
      : `当前标签图：relationshipVersion = ${version || '（第 1 步返回的那个值）'}；标签 ${graph.tags ?? '?'} 个、记忆组件 ${graph.components ?? '?'} 个。`;

    const text = [
      '请你对 Memory Lab 的标签图做一次索引判定，并把判定结果应用回索引。',
      '',
      '你要判定的是下面三类问题：',
      '',
      body,
      '',
      scale,
      '',
      '请按这个顺序做，不要跳步：',
      '',
      '1. 先调用 memory_lab_tag_review（只读）取证据与请求：它返回每一条发现的证据（evidence）、可选的决定（options）和当前的关系版本（relationshipVersion）。它不改写任何东西。',
      '2. 然后你自己逐条判定。可用的决定有四种：merge（把若干同义近义的 tag 合并到一个规范拼写，existingInto 的意思就是 canonical）、reparent（把一个根 tag 接到某个父 tag 之下）、split（把被误读成单个 tag 的名字还原成一条链）、join（把一条链收成一个 tag）。每一条决定，只使用审查里真实出现过的 tag 名，并使用审查给出的 options 里的形状。',
      `3. 最后调用 memory_lab_tag_apply 应用你接受的决定，并带上 expectedRelationshipVersion = ${version || '（第 1 步返回的那个值）'}。`,
      '',
      '约束：',
      '- 不要发明任何新的 tag 名，也不要发明审查里没有出现过的拼写。',
      '- 不要改写任何组件的正文、简介或 slug：判定只动标签图，正文是记忆本身。',
      '- 同义近义 tag 合并：只有当证据（stableInto 或共享词干与成员重合）真的指向同一个概念时才合并；只是拼写相近、证据没有点名的，不要合并。',
      '- 假根父节点接续：只有候选父节点在 tagPaths 里真的有层级依据时才 reparent；否则把这一个发现留给下一次审查，不要修。',
      '- 未被正确解析的 tag 误读为单 tag：只有证据明确说明候选链时才 split 或 join。',
      '- 不要直接改索引文件，也不要用别的工具改标签结构：标签图只经 memory_lab_tag_apply 改动。',
      "- 每次 apply 都会先把改动前的索引归档到 archive/，并在 policy.jsonl 里记录每个受影响组件的旧标签和一条 undo；要撤销一个已经记录的决定，就用它给的 undo 或 set-tags/unfold，不要去反推。",
      '- 信息性的发现（options 只有 { kind: "none" }）不需要处理，它没有任何可应用的决定。',
      '- 一次只应用你真正接受的决定：审查里没提到的部分保持不动。',
      '',
      `关系版本：apply 会核对 expectedRelationshipVersion = ${version || '（第 1 步返回的那个值）'}；如果读和写之间标签图变了，写入会被拒绝，请重新审查一次再决定。`,
      '',
      '如果你判断某一类问题当前没有可接受的修复，就什么都不应用，并在回答里说明理由；不要为了完成任务而做没有证据的合并或接续。',
      /* The workspace is NOT printed here.
       *
       * It is in the request, and the tool result carries it, so a run has it either way — and
       * the one thing this text must never do is put a local store path on a page a person is
       * looking at, or hand it to whatever a copied prompt is pasted into. The path the run
       * works in is a fact about the HOST, and the host is where it is read. */
    ]
      .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
      .join('\n')
      .trim();

    return {
      status: 'ready',
      text,
      notice: '',
      interface: AGENT_API_INTERFACE,
      relationshipVersion: version,
      questions: asked.length,
      kinds,
    };
  }

  /* ONE review per graph, memoized. `tagReview` walks every tag pair, so the snapshot this feeds
   * — built on every page load and after every rebuild — must not recompute it while nothing has
   * changed. The key is the index file's modification time AND the relationship version of the
   * graph inside it: either one moving means the graph was written, which is the only thing that
   * can change a finding, and requiring both to be unchanged is what makes a stale prompt
   * impossible rather than unlikely. Whether a run is reachable is in the key too, because the
   * prompt becomes unusable (and usable again) with that switch alone. */
  let promptCache = { key: '', value: null };

  /**
   * The prompt the panel offers and a run is given, taken from ONE review of the graph.
   *
   * The same call the tool makes, so the text a person copies and the text a tool hands a run
   * cannot drift apart — there is one prompt and this is where it is built.
   *
   * `status` is the prompt's own status unless no run is reachable, in which case it is
   * `unavailable` and the text is withheld: a prompt nobody can use is not offered beside a
   * notice, and "there is nobody to ask" must not be readable as "there was nothing to ask".
   */
  function promptForReview() {
    const judge = judgeState();
    let value;
    try {
      const review = store.tagReview({ limit: 25 });
      const prompt = judgementPrompt(judgementRequest(review));
      value = {
        ...prompt,
        counts: review.counts,
        window: review.window,
        // Whether a run can be asked for AT ALL is the same question the tool envelope
        // answers, and it is answered here from the same one place. The text is withheld
        // rather than shown next to a notice: a prompt a reader cannot use is not offered.
        status: judge.status === 'available' ? prompt.status : 'unavailable',
        notice: judge.status === 'available' ? prompt.notice : PROMPT_NOTICES.unavailable,
        text: judge.status === 'available' ? prompt.text : '',
      };
    } catch (error) {
      value = {
        status: 'unknown',
        text: '',
        notice: `${REVIEW_UNAVAILABLE_NOTICE}${error instanceof Error ? error.message : String(error)}`,
        interface: AGENT_API_INTERFACE,
        workspace: path.join(root, 'Work'),
        relationshipVersion: '',
      };
    }
    return value;
  }

  /**
   * `promptForReview()`, recomputed only when the thing it describes has moved.
   *
   * `tagReview` walks every tag pair, and the snapshot this feeds is built on every page load
   * and after every rebuild, so an unmemoized review would be paid for on a page that only
   * ever displays it. The key is the index file's identity: its modification time AND the
   * relationship version of the graph inside it. Either one moving means the graph was
   * written, which is the only thing that can change a finding — and requiring both to be
   * unchanged is what makes a stale prompt impossible rather than unlikely.
   */
  function promptForGraph() {
    const judge = judgeState();
    let stamp = 'no-index';
    try {
      stamp = String(fs.statSync(store.indexPath).mtimeMs);
    } catch {
      /* An absent index is the empty store: a state with a review, not a failure. */
    }
    const key = `${stamp}|${judge.status}`;
    if (promptCache.key === key && promptCache.value) return promptCache.value;
    const value = promptForReview();
    /* The version goes into the key, so the next call re-derives only after the graph's
     * version has actually moved. The file's mtime is checked first because it is one stat
     * call against a hash over every tag and every component membership. */
    promptCache = { key: `${key}|${value.relationshipVersion}`, value };
    return value;
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
        /* And every snapshot carries the PROMPT that asks for a judgement, as text.
         *
         * This is the one thing the panel may offer and still not do: it can be copied and
         * pasted by a person, and it can never be run from here — there is no model call on any
         * path out of this component, and there is no route that produces one. Rendering it
         * here rather than in the panel is not a shortcut: the panel has no tool context by
         * construction, so the copy a reader takes from it is the only way the judgement half
         * reaches the place that can actually run it.
         *
         * `status` is one of `ready` (a prompt to send), `none` (nothing to judge — a notice,
         * and deliberately no task), `unavailable` (agent-api is off) and `unknown` (the review
         * could not be read). Nothing here is ever model output; the text is composed from the
         * request and the review's own counts. */
        prompt: promptForGraph(),
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
              'This result also carries the judgement envelope: whether a run can be asked for right now, the request that says what is being judged, where it runs and what shape the answer takes, and `prompt` — the same ask as the prose you would send a model, ready to hand to a run as it stands. ' +
              'THE SEQUENCE IS AGENT-DRIVEN AND IT IS TWO CALLS: this tool gives you the evidence and the request; YOU decide; memory_lab_tag_apply applies and records your decisions. Nothing here judges, and the config panel cannot judge either — a judgement is a model run, agent-api is invoked only by tools, and a panel button has no tool context. The panel shows this same prompt for a person to copy, and that copy is the whole of its part in the judgement. When you want a run to make the decision for you, obtain one from agent-api through its agent_api_send tool.',
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
            //
            // `prompt` is the same request as the prose a model is sent, so a caller that
            // wants to hand the judgement to a run does not have to compose the ask itself —
            // and a caller reading this result by eye can see exactly what the judgement is.
            // It is null when the request is null: with no run reachable there is no prompt
            // to offer, and an empty string there would read as "asked and answered nothing".
            return {
              ...review,
              judge,
              request: judge.status === 'available' ? judgementRequest(review) : null,
              prompt: judge.status === 'available' ? judgementPrompt(judgementRequest(review)) : null,
            };
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
