/**
 * Newmark Core — the **MemoryLab** component.
 *
 * Owns the durable store over the shared `~/.Newmark` user path and the nine
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
import { MemoryLabStore, MemoryLabStoreError, TAG_DECISION_KINDS, DEFAULT_ROOT_LIMIT, MAX_ROOT_LIMIT, DEFAULT_TREE_MAX_TAGS, MAX_TREE_MAX_TAGS, DEFAULT_TREE_MAX_COMPONENTS, MAX_TREE_MAX_COMPONENTS } from './lib/memory-store.js';
// The presence probe belongs to the component that owns the tool being probed, and it works
// whether or not that component is mounted — which is the whole reason it can answer "is a judge
// reachable" for a component that is switched off. Reading it here rather than re-implementing it
// is what keeps one answer to one question.
//
// `AGENT_API_PRESENCE_TOOL` is the same identity read twice: it is the tool whose registration IS
// the presence signal, and it is the tool this component dispatches to obtain a judgement. One
// constant, so "a judge is reachable" and "the judge was asked" cannot come to mean two different
// tools.
import { agentApiPresence, AGENT_API_PRESENCE_TOOL } from '../agent-api/lib/presence.js';
// The bundle's failure log — one implementation, in the core's `lib/`, the way the root rule is.
// This component owns two of the failures the user asked to have persisted: the deterministic
// rebuild, and every judgement that is not a verdict.
import { causeChain, createErrorLog, describeError } from '../../lib/errors.js';

/**
 * The decisions that ARE a judgement, as opposed to a reversal of one.
 *
 * `merge`, `reparent`, `split`, `join` and `cut` decide something about the graph, so they
 * are the Agent half of a rebuild and need the `agent-api` interface; `set-tags` and
 * `unfold` only restore tags a recorded decision replaced, so they never do.
 *
 * `cut` belongs here for the same reason the other four do: it is the decision 解环判定
 * produces — which edge of a cycle to break — and it is the only decision that can break one.
 * A cycle has no reparent that breaks it, so gating `cut` behind a reachable judge is what
 * keeps cycle-breaking a judgement rather than something that happens on its own.
 */
export const JUDGEMENT_DECISION_KINDS = Object.freeze(['merge', 'reparent', 'split', 'join', 'cut']);

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
 * ## The judgement is TOOL-INVOKED — by this component, through the registry
 *
 * The rule that governs this bundle has not changed: **the run half of `agent-api` is reachable
 * from its own tool definitions and from nothing else.** What the user changed is WHO CALLS THE
 * TOOL. Pressing 重建索引 is one action in two halves, in this order:
 *
 *   1. the DETERMINISTIC rebuild — `store.reindex()`, the normalizer, milliseconds (先硬流程重建);
 *   2. the JUDGEMENT — this component builds the ask with `judgementPrompt()` and dispatches
 *      `agent_api_send` through the tools registry (`judge()` below), so a run of this bundle's
 *      own agent core actually happens, driven by that prompt.
 *
 * An earlier revision of this file said "This component never runs a judgement itself, and
 * neither does the panel", and the revision before that said "There is ONE path, not two" and
 * claimed the run was callable from the panel's own snapshot route. Both are now history: the
 * first is false (the panel's button does cause a run, through this component), and the second
 * described a design the user replaced with the tool-invoked sequence. Neither story may be left
 * standing in the tree, because the next reader implements the story they were told.
 *
 * What has NOT changed, and what the gate still asserts: the RUN itself is invoked only through
 * the tool. The route reaches it by dispatching `agent_api_send` — the same call a model makes —
 * so the run goes through the registry's pre-policy, guards and post-policy exactly as any other
 * tool call does, and there is no second entry point into `runSend`. A caller-supplied prompt
 * cannot reach it either: the ask is built here, from a fresh review of the graph, and the route
 * passes this component nothing but its own two locals.
 *
 * ## How "is a judge reachable" is answered, now
 *
 * Through the TOOLS REGISTRY, not through a service this component was handed: whether
 * `agent_api_send` is currently registered is a fact about right now, it is readable by anything
 * that can see `ctx.tools`, and it is exactly the fact that matters — if the tool is not there,
 * no tool-invoked run can happen. That probe lives in `agent-api`'s own `lib/presence.js`, which
 * is importable whether or not that component is mounted, and `readAgentApi` below is the only
 * place in MemoryLab that reads it — the same registry, and the same `get`, that `judge()`
 * dispatches through. `AGENT_API_SERVICE` is kept below only to name the concept in prose;
 * nothing looks it up.
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

/**
 * The tool a rebuild's judgement half is dispatched through.
 *
 * Not a second constant and not a second lookup: this is `agent-api`'s own declared identity read
 * from its presence module, so the tool whose registration makes a judge reachable is the tool
 * that gets called, and neither fact can drift from the other.
 */
export const JUDGEMENT_TOOL = AGENT_API_PRESENCE_TOOL;

/**
 * How long a rebuild's judgement half may take, by default.
 *
 * A run is a model loop — several turns, tool calls, round trips — and the deterministic rebuild
 * beside it is milliseconds. The bound exists for one reason: the button must always come back
 * with an answer. A run that cannot finish inside this window is aborted and reported as a
 * TIMEOUT, which is a state of its own; it must never be reported as a judgement, as a skip, or
 * as a silent no-op, and the request must never be left open on it.
 */
export const DEFAULT_JUDGEMENT_TIMEOUT_MS = 300000;

/**
 * Why a run could not even be attempted, in the words a person reads.
 *
 * `agent_api_send` answers exit 3 with a machine code when NOTHING WAS ATTEMPTED — no model is
 * authorised, the model is gone, the llm or the registry is unreachable. Those codes are the
 * interesting half of the failure surface (by far the likeliest one in the app is
 * `model_not_selected`, on a profile where nobody has chosen a model yet), and this is where each
 * becomes a sentence in the user's language instead of an identifier. A code this table does not
 * name falls back to the component's own message, so an unfamiliar failure is reported rather
 * than swallowed.
 */
const UNAVAILABLE_GLOSS = Object.freeze({
  agent_api_disabled: 'agent-api 已停用',
  model_not_selected: '还没有选定模型，agent-api 不会替你默认一个',
  model_unavailable: '已选定的模型在提供方那里已经不可用',
  core_service_absent: '核心行没有把共享根与授权模型交给它',
  core_model_accessor_absent: '核心行没有提供读取授权模型的方法',
  llm_unavailable: '模型服务不可达，无法发起这次运行',
  tools_unavailable: '工具注册表不可达，无法驱动这次运行',
  workspace_unavailable: '运行的工作目录不可用',
});

/**
 * The envelope a dispatched tool answered with, when it answered with one.
 *
 * A `ToolExecutionResult` is `{ content, isError, value }` on success and
 * `{ content, isError, error }` on failure; `agent_api_send` answers with the envelope as its
 * VALUE on every path, including its refusals. So the envelope is read from `value`, and its
 * absence is a real difference — it means the dispatch never reached the tool — rather than
 * something to be smoothed over.
 */
function readEnvelope(outcome) {
  const value = outcome && typeof outcome === 'object' ? outcome.value : undefined;
  return value && typeof value === 'object' && typeof value.exit === 'number' ? value : null;
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
 * @param tools - the `tools` service (`ctx.tools`), read for TWO things that are one fact: whether
 *        `agent_api_send` is currently registered, which is what "a judge is reachable" means, and
 *        the `execute` that dispatches it, which is what a judgement IS. Both are read from this
 *        one object at the moment they are used, so a caller cannot hand in a dispatcher for a
 *        registry that was never probed. `agent-api` is invoked only by tools, so the registry is
 *        both the presence signal and the only route to a run — there is no second thing to look
 *        up. Its absence is a state the app reaches (the user switches `agent-api` off and its
 *        tools are retired), so it is not an error here: it is what makes the Agent half of a
 *        rebuild unavailable, and every envelope this component produces says which of the two
 *        it is.
 */
export function createMemoryLab({ root, language = 'auto', reindexOnRender = true, logger, tools } = {}) {
  const labDir = memoryLabDir(root);
  const store = new MemoryLabStore(labDir, { language });
  store.ensureLayout();
  logger?.info?.(`newmark-core/memorylab: store ready at ${labDir}`);

  /**
   * The bundle's failure log, from the SAME resolved root the store is placed under.
   *
   * `where: 'memorylab/rebuild'` and `where: 'memorylab/judgement'` are this component's two
   * halves, and `lib/errors.js` says how a line is shaped, why the path is derived rather than
   * written down, and why zero findings never reaches it. What matters at THIS call site is
   * rule 1: `record()` never throws, so a rebuild that failed does not fail a second time while
   * being reported.
   */
  const failures = createErrorLog({ root, logger });

  /**
   * The deterministic rebuild — the ONE wrapper every rebuild in this component goes through.
   *
   * `store.reindex()` is called from four places (a verified write, the snapshot's stale check,
   * the rebuild method, and the `memory_lab_reindex` tool) and a throw from any of them is the
   * same failure: `<root>/Memory Lab` could not be normalised. Recording it here rather than at
   * four call sites is what makes "the rebuild failed" one record instead of four chances to
   * forget — and the error is re-thrown, so every caller keeps the behaviour it had.
   */
  function reindexOnce() {
    try {
      return store.reindex();
    } catch (error) {
      failures.record({
        where: 'memorylab/rebuild',
        code: 'rebuild_failed',
        message: `the deterministic rebuild threw: ${describeError(error)}`,
        detail: causeChain(error),
        fields: { index: path.join(labDir, 'index.json') },
      });
      throw error;
    }
  }

  /**
   * What the judgement half of a rebuild looks like right now.
   *
   * Read afresh on every call that needs it. `judged` is the one field that must
   * never be guessed: MemoryLab judges nothing by READING, so it is `false` unless a caller
   * has just handed over decisions this call applied — a run this component dispatched is
   * reported by `judge()` below, in its own result, and never leaks into this one.
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
      // The sequence, stated where a caller reads it — and it is the sequence the panel's own
      // button now runs, in this order. This component dispatches the run; it does not decide.
      sequence: [
        '确定性重建：store.reindex() 先跑完，索引与标签图是这次判定的输入',
        `判定：MemoryLab 把 judgementPrompt 交给 agent-api 的 ${JUDGEMENT_TOOL} 工具运行一次（页面上的重建索引按钮就是这条路）`,
        'memory_lab_tag_apply 应用并记录决定，可撤销',
      ],
      note: judged
        ? 'these decisions were applied and recorded; the receipt carries the undo that reverses them'
        : judge.available
          ? 'nothing was judged by THIS call: a reading tool never judges. The judgement runs when the panel asks for a rebuild (确定性重建之后，提交 agent-api 运行一次), or when an agent decides from memory_lab_tag_review and applies through memory_lab_tag_apply'
          : `the ${AGENT_API_INTERFACE} component is off, so the four judgement classes (假根父节点接续, 同义近义 tag 合并, 未被正确解析的 tag 误读为单 tag, 解环判定) are unavailable here — not skipped and not pending; the deterministic rebuild is unaffected`,
    };
  }

  /**
   * What the judgement is asked, where it runs, and what it must answer with.
   *
   * This is the request an in-process run through the interface consumes — the same
   * object whether the trigger was a tool call or the panel's own route. The four
   * questions are the user's own names for the four things a rebuild cannot decide
   * by rule; each is stated with the finding kind that carries its evidence, so a
   * run is told what it is being asked rather than handed a payload and left to
   * guess.
   *
   * The fourth — 解环判定, in the user's own words — covers the two shapes one finding kind
   * carries and says so: a cycle the stored graph really holds (`stored-cycle`, read from
   * index.json before the normalizer drops its second edge), and two roots that name each
   * other as candidate parent (`candidate-mutual`, the shape the Agent met when it refused to
   * reparent three false roots because 其 why 为共现且 #作者↔#研究 互为候选，属循环). They need
   * different evidence and different decisions, which is why the finding says which it is.
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
        {
          id: 'cycle-break',
          ask: '解环判定：which tags form a cycle — a cycle the stored graph really holds, or two roots that each name the other as candidate parent — and which edge should be broken, in which direction?',
          evidence: ['cycle-candidate'],
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
    none: '索引里没有需要判定的事项——确定性重建已经做完，标签图没有留下同义近义、假根父节点、误解析或成环的候选。这不是跳过，也不是失败，是重建后的稳定状态。',
    unavailable: `agent-api 已停用，标签判定的四个问题都没有可用的运行来源；确定性重建不受影响。这不是跳过，也不是待办。`,
  });
  const NO_EVIDENCE_NOTICE = '（这一次的审查结果没有返回任何发现，因此没有证据可以呈现。）';
  const REVIEW_UNAVAILABLE_NOTICE = '审查暂时读不出来，因此这次判定没有可提交的内容：';

  /**
   * The judgement request as the PROMPT a model is actually sent.
   *
   * The request is the structured half — questions with ids and evidence kinds, the graph's
   * relationship version, the finding counts, an answer shape. Handing that object to a model
   * is handing it a payload. This renders the same thing as the prose a person would write, and
   * it is the only place in this bundle where the four questions become a message:
   *
   *  - the four questions are asked in the USER'S OWN WORDS for them (同义近义 tag 合并 /
   *    假根父节点接续 / 未被正确解析的 tag 误读为单 tag / 解环判定), with their finding kinds
   *    attached as where-to-look, never as the thing being asked;
   *  - the sequence is stated as a procedure: read the evidence, decide, then apply — two calls
   *    with a decision between them, which is what this component has always said it is;
   *  - the guard travels with the prompt (`expectedRelationshipVersion`, archive + undo), so a
   *    run that decides correctly and applies late is refused rather than applied to a graph
   *    something else has already changed;
   *  - and it says what NOT to do, because this store holds real memory: no inventing tags, no
   *    rewriting component bodies, no merging a near-synonym the evidence does not name.
   *
   * It takes the REQUEST, which is the one object there is: `judgementRequest` builds it from a
   * review, and the prompt points a run back at `memory_lab_tag_review` for the findings
   * themselves — the same tool a model caller uses, and the same text this component dispatches. The one thing it reads about the findings is their count — the request carries
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
      '你要判定的是下面四类问题：',
      '',
      body,
      '',
      scale,
      '',
      '请按这个顺序做，不要跳步：',
      '',
      '1. 先调用 memory_lab_tag_review（只读）取证据与请求：它返回每一条发现的证据（evidence）、可选的决定（options）和当前的关系版本（relationshipVersion）。它不改写任何东西。',
      '2. 然后你自己逐条判定。可用的决定有五种：merge（把若干同义近义的 tag 合并到一个规范拼写，existingInto 的意思就是 canonical）、reparent（把一个根 tag 接到某个父 tag 之下）、split（把被误读成单个 tag 的名字还原成一条链）、join（把一条链收成一个 tag）、cut（剪断一条 parent -> child 的边，形状是 { parent, child }：把 parent 从断言这条边的组件 tagPaths 里去掉，环就解开了）。每一条决定，只使用审查里真实出现过的 tag 名，并使用审查给出的 options 里的形状。',
      `3. 最后调用 memory_lab_tag_apply 应用你接受的决定，并带上 expectedRelationshipVersion = ${version || '（第 1 步返回的那个值）'}。`,
      '',
      '约束：',
      '- 不要发明任何新的 tag 名，也不要发明审查里没有出现过的拼写。',
      '- 不要改写任何组件的正文、简介或 slug：判定只动标签图，正文是记忆本身。',
      '- 同义近义 tag 合并：只有当证据（stableInto 或共享词干与成员重合）真的指向同一个概念时才合并；只是拼写相近、证据没有点名的，不要合并。',
      '- 假根父节点接续：只有候选父节点在 tagPaths 里真的有层级依据时才 reparent；否则把这一个发现留给下一次审查，不要修。',
      '- 未被正确解析的 tag 误读为单 tag：只有证据明确说明候选链时才 split 或 join。',
      '- 解环判定：先看 evidence.shape 是哪一种。shape = "stored-cycle" 是索引文件里真的成环，用 cut 剪断环上的一条边（reparent 也能让环消失，但那是规范化顺手丢边的副作用，回执里不会说是哪一条边没了；cut 会点名这条边，所以解环要用 cut）。cut 的证据里 edges 给出环上每一条边、assertedBy 给出哪些组件断言了它、suggestedCut 是建议剪断的那一条，剪断环上任意一条边都能解环。shape = "candidate-mutual" 是图里并没有环、只是两个根节点互为候选父节点：只有 evidence.direction 指出哪一边更一般（name-containment / synonym-group / structure）时才按那个方向 reparent；direction.directionDecided 为 false、或 why 说明这只是共现时，就什么都不要应用，并说明理由——把没有证据的方向说成结论，比不判定更糟。',
      '- 不要直接改索引文件，也不要用别的工具改标签结构：标签图只经 memory_lab_tag_apply 改动。',
      "- 每次 apply 都会先把改动前的索引归档到 archive/，并在 policy.jsonl 里记录每个受影响组件的旧标签和一条 undo；要撤销一个已经记录的决定，就用它给的 undo 或 set-tags/unfold，不要去反推。",
      '- 信息性的发现（options 只有 { kind: "none" }）不需要处理，它没有任何可应用的决定。',
      '- 一次只应用你真正接受的决定：审查里没提到的部分保持不动。',
      '',
      `关系版本：apply 会核对 expectedRelationshipVersion = ${version || '（第 1 步返回的那个值）'}；如果读和写之间标签图变了，写入会被拒绝，请重新审查一次再决定。`,
      '',
      '如果你判断某一类问题当前没有可接受的修复，就什么都不应用，并在回答里说明理由；不要为了完成任务而做没有证据的合并、接续或剪断。',
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

  /**
   * The ask a run is given, taken from ONE fresh review of the graph.
   *
   * This is where the judgement's text is built, and it is called once per rebuild — never per
   * page load. It used to be memoized because the SNAPSHOT carried it and a snapshot is built on
   * every render; the snapshot no longer carries it (the run consumes it, the page has no use for
   * it), and a rebuild is exactly the moment the evidence must be read again, so the cache and its
   * key are gone with the reason for them.
   *
   * The same call the `memory_lab_tag_review` tool makes, so the ask a run is handed and the ask a
   * model reads from that tool cannot drift apart — there is one prompt and this is where it is
   * built.
   *
   * `status` is `ready` (a prompt to send), `none` (nothing to judge — a notice, and deliberately
   * no body, so a run is never asked to invent repairs in a store holding real memory) or
   * `unknown` (the review could not be read). Whether a run is REACHABLE is a separate question
   * and is answered by `judge()` below from the registry, because "there is nobody to ask" and
   * "there is nothing to ask" must never collapse into one answer.
   */
  function judgementAsk() {
    try {
      const review = store.tagReview({ limit: 25 });
      return { ...judgementPrompt(judgementRequest(review)), counts: review.counts, window: review.window };
    } catch (error) {
      return {
        status: 'unknown',
        text: '',
        notice: `${REVIEW_UNAVAILABLE_NOTICE}${error instanceof Error ? error.message : String(error)}`,
        interface: AGENT_API_INTERFACE,
        workspace: path.join(root, 'Work'),
        relationshipVersion: '',
      };
    }
  }

  /* How many judgement asks THIS instance has dispatched. A dispatched call is identified by its
   * `callId`, so two asks must never share one — a counter is the smallest thing that guarantees
   * it, and it is also what makes "exactly one dispatch per rebuild" countable from outside. */
  let judgementAsks = 0;

  /**
   * The stable log codes for the statuses that carry no run code of their own.
   *
   * Every other status is recorded with `envelope.code` VERBATIM — `max_steps`, `run_failed`,
   * `schema_violation`, `model_not_selected`, `agent_api_disabled`, `dispatch_threw`,
   * `no_envelope`, and whatever the next one is called — because a code that summarises is a
   * code that hides which failure happened, and this bundle has lost two releases to exactly
   * that. These four are the cases where there is no run to have a code: no run was attempted
   * (`agent_api_off`), the bound ended the call before any answer came back (`run_timeout`), the
   * deterministic half failed first (`judgement_blocked`), or the ask could not even be built
   * (`judgement_unknown`).
   */
  const JUDGEMENT_LOG_CODE = Object.freeze({
    timeout: 'run_timeout',
    unavailable: 'agent_api_off',
    blocked: 'judgement_blocked',
    unknown: 'judgement_unknown',
    aborted: 'run_aborted',
  });

  /**
   * Persist one judgement that is not a verdict — into `<root>/errors.jsonl`, and to the log.
   *
   * ## What is recorded, and what is deliberately not
   *
   * `agent-api` switched off is its own code (`agent_api_off`) and never "nothing to do"; a
   * timeout is `run_timeout` and never a judgement, a skip or a silent no-op. Both, because the
   * alternative is the disguise rule 2 forbids.
   *
   * **`judged` and `none` are NOT failures and never reach this function.** `judged` is a run
   * that answered — the one status that is a verdict. `none` means the deterministic rebuild
   * left nothing to judge: a review found no findings, so no run was asked for. That is the
   * STEADY STATE of a clean store, and it is what a person sees every time they press 重建索引
   * twice in a row. Recording it would fill this file with noise on a healthy store and teach
   * whoever reads it that the file can be ignored — which would cost the failures that matter
   * their only reader. **If a later reader is tempted to "fix" this by recording every status:
   * that is the change this paragraph exists to stop.**
   *
   * A run that answered with an exit code carries that code here; a status whose cause was
   * already recorded elsewhere (`blocked`, whose cause is the `memorylab/rebuild` line) is
   * still recorded, because "the judgement did not happen" is its own fact and the panel's
   * 重建索引 receipt is the only other place it appears.
   */
  function recordJudgement(envelope) {
    if (envelope.status === 'judged' || envelope.status === 'none') return;
    const own = String(envelope.code || '').trim();
    /* An envelope whose `code` is literally its own status carries this component's PLACEHOLDER,
     * not a run's code: the timeout branch sets `code: 'timeout'` because there is no run to have
     * answered, and `aborted` is the same shape. Those take the log's name for the event; every
     * other code is a run's own and is recorded exactly as it came back. */
    const placeholder = own === '' || own === envelope.status;
    const code = placeholder ? JUDGEMENT_LOG_CODE[envelope.status] || `judgement_${envelope.status}` : own;
    const message =
      String(envelope.reason || '').trim() !== ''
        ? String(envelope.reason)
        : String(envelope.label || '').trim() !== ''
          ? String(envelope.label)
          : `the judgement ended as ${envelope.status}`;
    failures.record({
      where: 'memorylab/judgement',
      code,
      message,
      detail: String(envelope.label || ''),
      fields: {
        status: String(envelope.status),
        label: String(envelope.label || ''),
        attempted: envelope.attempted === true,
        exit: envelope.exit === undefined ? null : envelope.exit,
        runCode: own,
        turns: Number(envelope.turns) || 0,
        toolCalls: Number(envelope.toolCalls) || 0,
        boundMs: Number(envelope.boundMs) || 0,
        elapsedMs: Number(envelope.elapsedMs) || 0,
      },
    });
  }

  /**
   * The judgement half of a rebuild: ask the agent core for one run, and report what came back.
   *
   * THE ONE WAY THIS COMPONENT REACHES A RUN: it dispatches `agent_api_send` — `agent-api`'s own
   * run tool — through the tools registry it was constructed with, via `tools.execute`. Not a
   * service, not a private import, not a copy of the loop. That choice is deliberate and it is the
   * whole reason the bundle's "invoked only by tools" rule survives this feature:
   *
   *   - the run is produced by a TOOL EXECUTION, so it goes through the registry's pre-policy,
   *     its guards and its post-policy exactly as a model's own tool call does;
   *   - there is no second entry point into `runSend` — the route cannot reach the loop, only
   *     this one tool;
   *   - the presence answer and the dispatch read the SAME registry object at the same moment, so
   *     a caller cannot hand in a dispatcher for a registry that was never probed. That is why
   *     `judge()` takes no dispatcher argument: taking one would be a way to run something else.
   *
   * The ask is built HERE, from a fresh review of the graph the deterministic rebuild just wrote.
   * Nothing a request carries reaches the prompt: the arguments are this method's own three
   * values, and the tool set is left at `agent_api_send`'s own default (the `memory_lab_*` tools
   * and nothing else), because a judgement reads a memory graph and needs no filesystem — so the
   * one thing this call must never do is WIDEN a run.
   *
   * ONE BOUND, AND IT DOES TWO THINGS. `timeoutMs` is a timer this call owns:
   *
   *   - it aborts the signal the dispatch was handed, so a run that honours `exec.signal` stops
   *     where it is — `agent-api` does, and it releases its temporary conversation on the way out;
   *   - it settles this call whatever the tool does, so a dispatch that ignored the signal cannot
   *     hold the request open. A run that would not stop is reported as a TIMEOUT, which is what
   *     it is, and never as a judgement, a skip, or a silent no-op.
   *
   * Every failure is partial and named. `status` is one of:
   *
   *   `judged`      a run was asked for and answered (exit 0) — the only status that is a verdict;
   *   `failed`      a run was asked for and did not deliver (exit 4, exit 2, or a dispatch that
   *                 never reached the tool). No judgement was produced;
   *   `timeout`     a run was asked for and did not finish inside the bound; it was aborted;
   *   `aborted`     the run was cancelled for some other reason (exit 130 without our timer);
   *   `unavailable` the run could not be attempted at all — agent-api is off (no dispatch), or its
   *                 exit-3 answer says nothing was attempted (no model, no llm, no registry);
   *   `none`        nothing to judge: the review found no findings, so no run was asked for;
   *   `unknown`     the ask could not be built (the review could not be read) or sent (no registry
   *                 dispatch). Distinct from `unavailable`, which names a switch or a code;
   *   `blocked`     the deterministic half failed, so the judgement was not asked for at all.
   *
   * The deterministic rebuild stands in every one of them, and `label` is the one clause the panel
   * prints, so what happened is said in one place rather than reconstructed by the page.
   */
  async function judge({ timeoutMs = DEFAULT_JUDGEMENT_TIMEOUT_MS, rebuildError = '' } = {}) {
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_JUDGEMENT_TIMEOUT_MS;
    const workspace = path.join(root, 'Work');
    const startedAt = Date.now();
    const base = {
      interface: AGENT_API_INTERFACE,
      tool: JUDGEMENT_TOOL,
      workspace,
      boundMs: bound,
      attempted: false,
      status: 'unknown',
      label: '',
      reason: '',
      exit: null,
      code: '',
      error: '',
      turns: 0,
      toolCalls: 0,
      stopReason: '',
      relationshipVersion: '',
      elapsedMs: 0,
    };
    /* ONE EXIT, AND THE RECORD IS ON IT. Every branch above returns through `done`, so putting
     * the record here is what makes "every failure in this taxonomy is persisted" a property of
     * the shape rather than a promise about eleven call sites — a branch added later is covered
     * without being edited. `recordJudgement` is a no-op for the two statuses that are not
     * failures, and `record()` cannot throw, so nothing about the envelope it returns changes. */
    const done = (fields) => {
      const envelope = { ...base, elapsedMs: Date.now() - startedAt, ...fields };
      recordJudgement(envelope);
      return envelope;
    };

    /* HALF ONE FAILED, SO HALF TWO IS NOT ASKED FOR. A judgement is a decision about the graph,
     * and the graph is what the deterministic rebuild produces. Asking for one on a rebuild that
     * threw would be judging a store this component could not write — and reporting it as a
     * judgement that came back empty is exactly the collapse this whole envelope exists to
     * prevent. It is REPORTED. */
    if (rebuildError) {
      return done({
        status: 'blocked',
        reason: `确定性重建失败：${rebuildError}`,
        label: `未发起：确定性重建失败——${rebuildError}`,
      });
    }

    const judge = readAgentApi(tools);
    if (!judge.available) {
      return done({
        status: 'unavailable',
        reason: judge.reason,
        label: `未运行：${PROMPT_NOTICES.unavailable}`,
      });
    }

    const ask = judgementAsk();
    if (ask.status === 'none') {
      return done({ status: 'none', reason: ask.notice, label: `未发起：${ask.notice}` });
    }
    const askText = typeof ask.text === 'string' ? ask.text : '';
    if (ask.status !== 'ready' || !askText.trim()) {
      return done({ status: 'unknown', reason: ask.notice, label: `未发起：${ask.notice}` });
    }
    if (typeof tools?.execute !== 'function') {
      return done({
        status: 'unknown',
        reason: 'the tools registry has no execute(), so the ask cannot be dispatched',
        label: '未发起：工具注册表不可达，判定无法提交',
      });
    }

    judgementAsks += 1;
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, bound);
    });
    let outcome = null;
    try {
      const dispatched = tools.execute({
        callId: `newmark-memorylab:judge:${judgementAsks}:${Date.now().toString(36)}`,
        name: JUDGEMENT_TOOL,
        // The ask, the directory the run works in, and the bound. No `tools`, no `max_steps`, no
        // `output_schema`: the run gets `agent_api_send`'s own narrow defaults, and a judgement
        // must never widen what a run may reach.
        arguments: { prompt: askText, workspace, timeout_ms: bound },
        signal: controller.signal,
      });
      /* Settling the race is this call's business; the dispatched promise's own rejection is not
       * — if it loses the race, nobody is left to read it, and an unhandled rejection would end
       * the Host process rather than the request. */
      if (dispatched && typeof dispatched.catch === 'function') dispatched.catch(() => {});
      const raced = await Promise.race([dispatched, expiry]);
      /* THE ONE TIMEOUT ANSWER, reached in one place. `expiry` settles with `null` and a dispatch
       * that returns an envelope never does, so a null here means the bound is what ended this
       * call. Once `raced` is anything else, the classification below runs synchronously after this
       * await — the timer cannot fire in between — so the branches after this one carry no
       * `timedOut` test: a second timeout answer would be a branch nothing can reach, and a reader
       * would trust it. */
      if (raced === null && timedOut) {
        return done({
          status: 'timeout',
          attempted: true,
          code: 'timeout',
          reason: `运行在 ${bound} ms 内没有结束，已被中止`,
          relationshipVersion: ask.relationshipVersion,
          label: `超时未完成：${bound} ms 内没有返回，运行已中止，判定没有产生`,
        });
      }
      outcome = raced;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return done({
        status: 'failed',
        attempted: true,
        code: 'dispatch_threw',
        error: message,
        reason: message,
        relationshipVersion: ask.relationshipVersion,
        label: `未完成：dispatch_threw——${message}`,
      });
    } finally {
      clearTimeout(timer);
    }

    const envelope = readEnvelope(outcome);
    if (!envelope) {
      /* No envelope means the dispatch never reached the tool: an unknown name, a guard's denial,
       * a registry failure. `agent_api_send` answers with an envelope on EVERY path, including its
       * refusals, so this is a different thing from any answer it could have given. */
      const message = String(outcome?.error?.message || 'the dispatch returned no envelope');
      const code = String(outcome?.error?.info?.code || 'no_envelope');
      return done({
        status: 'failed',
        attempted: true,
        code,
        error: message,
        reason: message,
        relationshipVersion: ask.relationshipVersion,
        label: `未完成：${code}——${message}`,
      });
    }

    const result = envelope.result && typeof envelope.result === 'object' ? envelope.result : {};
    const answered = {
      attempted: true,
      exit: envelope.exit,
      code: String(envelope.code || ''),
      error: String(envelope.error || ''),
      turns: Number(result.turns) || 0,
      toolCalls: Number(result.tool_calls) || 0,
      stopReason: String(result.stop_reason || ''),
      relationshipVersion: ask.relationshipVersion,
    };

    if (envelope.exit === 0) {
      /* The ONLY status that is a verdict. What the run applied is in the store and in
       * policy.jsonl — the panel's clause is a fact about the run, not a second copy of it. */
      return done({
        ...answered,
        status: 'judged',
        reason: '',
        label: `已运行：${answered.turns} 轮模型、${answered.toolCalls} 次工具调用，用时 ${Date.now() - startedAt} ms`,
      });
    }
    if (envelope.exit === 3) {
      const gloss = UNAVAILABLE_GLOSS[answered.code] || '';
      return done({
        ...answered,
        status: 'unavailable',
        reason: answered.error,
        label: `未运行：${gloss || answered.error || answered.code || '运行来源不可用'}`,
      });
    }
    if (envelope.exit === 130) {
      return done({
        ...answered,
        status: 'aborted',
        reason: answered.error,
        label: `已中止：${answered.error || '运行被取消，判定没有产生'}`,
      });
    }
    /* Everything else — exit 2 (the ask was refused as invalid) and exit 4 (a run happened and did
     * not deliver) — is a judgement that did NOT arrive, and it says which. */
    return done({
      ...answered,
      status: 'failed',
      reason: answered.error,
      label: `未完成：${answered.code || 'failed'}——${answered.error}`,
    });
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
    const rebuilt = reindexOnce();
    const verified = readBack(written?.slug || '', operation === 'delete' ? 'absent' : 'present');
    if (!verified.ok) {
      /* A WRITE THAT DID NOT VERIFY. The component was written and the index does not agree —
       * missing after an update, still present after a delete — so this is an operation that was
       * ATTEMPTED and did not achieve its effect: a failure by the line this bundle draws, and
       * the 0.2.2 defect class in its worst form. It is reported to the caller in the receipt
       * below AND persisted here, because the caller is usually a model that may say nothing
       * about it, and a store that quietly lost a memory is what this envelope exists to make
       * visible. */
      failures.record({
        where: 'memorylab/write',
        code: 'write_not_verified',
        message: `Memory Lab ${operation} did not verify after rebuild: ${verified.error}`,
        fields: { action: String(operation).toUpperCase(), slug: String(written?.slug ?? '') },
      });
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
     * The failure log, for the halves that live in `index.js`.
     *
     * The route and the page injection can both fail on their own — a snapshot that cannot be
     * read, a route that throws — and those failures belong in the same file as the rebuild's
     * and the judgement's. Handing out this one object rather than letting `index.js` build a
     * second one is what keeps it one log with one path.
     */
    failures,

    /**
     * The ONE snapshot the renderer and the injected page global are built from.
     *
     * `snapshot()` — what the page index injection calls — rebuilds the index when
     * it is stale, which is what makes a page render honest about the store it draws.
     * `snapshot({ rebuild: false })` is the pure read: it never writes, so re-reading the
     * store can never rewrite it. A rebuild failure is reported, never swallowed.
     *
     * It carries NO prompt. The judgement's ask is built and consumed inside `judge()`, in the
     * same call that dispatches it; a page has no use for the text (it cannot run one, and it
     * no longer offers one to copy), and leaving it here would be the "提示词放那" the user
     * removed. What the snapshot carries about the judgement half is its REACHABILITY (`judge`),
     * which is a fact about the store's surroundings rather than a task.
     */
    snapshot(options = {}) {
      const mayRebuild = options.rebuild !== false;
      let reindexError = '';
      let visual = store.visualizationSnapshot();
      if (mayRebuild && reindexOnRender && needsRebuild(visual)) {
        try {
          reindexOnce();
          // Re-read so the snapshot the panel receives is the rebuilt one.
          visual = store.visualizationSnapshot();
        } catch (error) {
          // Already recorded by `reindexOnce`; carried out as `reindexError` too, because the
          // snapshot's own reader has to be told as well as the log.
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
      const result = reindexOnce();
      return { relationshipVersion: result.relationshipVersion, components: result.components, tags: result.tags, warnings: result.warnings };
    },

    /**
     * The judgement half of a rebuild, on its own.
     *
     * The route runs this immediately after `rebuild()`, on the SAME store, so the ask is built
     * from the graph the deterministic half just wrote. Exposed as a method rather than hidden in
     * the route because the sequence is the feature: 先硬流程重建，再提交 agent-api 运行一次, and a
     * caller (or a check) has to be able to drive each half and see which one answered.
     */
    judge,

    /** The ask the next judgement would dispatch, without dispatching it. */
    judgementAsk,

    /** The nine model-facing tools, bundled with this component. */
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
          name: 'memory_lab_root_tags',
          description:
            'List the ROOT parent tags — every tag with no parent — with the numbers that decide which branch to descend into, so a caller can choose one WITHOUT reading the whole index: each root carries its direct child count, the components carrying it directly, and the size of the subtree beneath it in tags and in components. Aliases are included when the store has them. Ordered by subtree size, largest first, ties by tag name. Read-only: it writes nothing, rebuilds nothing and judges nothing. Descend with memory_lab_subtag_tree.',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: `Roots per page, 1-${MAX_ROOT_LIMIT}, default ${DEFAULT_ROOT_LIMIT}.` },
              offset: { type: 'number', description: 'Skip this many roots. window.omitted says how many the page left out.' },
            },
            required: [],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatRootTags(value)) },
          async execute(args) {
            return store.rootTags({ limit: args?.limit, offset: args?.offset });
          },
        },
        {
          name: 'memory_lab_subtag_tree',
          description:
            "Read ONE tag's subtree: the structure level by level (each tag's name, depth, parent, child count and how many components carry it directly, depth-first and in a stable order), every component name in the subtree deduplicated and reachable afterwards with memory_lab_read — each saying whether it carries the tag itself, a descendant, or both — and the statistics that size it (tags, components, depth reached). The leading '#' is optional; an unknown tag is NOT_FOUND naming the tag. Bounded: the payload respects max_tags and max_components, states every limit it respected and lists everything it dropped, so a short answer is never mistaken for a small subtree. Read-only: it writes nothing, rebuilds nothing and judges nothing.",
          parameters: {
            type: 'object',
            properties: {
              tag: {
                type: 'string',
                description: `The tag whose subtree to read, for example "#研究". A leading "#" is optional; an alias the store advertises resolves to its own tag. Required.`,
              },
              max_tags: {
                type: 'number',
                description: `Cap on rows in the structure table, 1-${MAX_TREE_MAX_TAGS}, default ${DEFAULT_TREE_MAX_TAGS}. Anything beyond it is counted, reported in bounds.dropped, and never silently cut.`,
              },
              max_components: {
                type: 'number',
                description: `Cap on entries in the component list, 1-${MAX_TREE_MAX_COMPONENTS}, default ${DEFAULT_TREE_MAX_COMPONENTS}. The count is still the true one; bounds.dropped says what was left out.`,
              },
            },
            required: ['tag'],
          },
          output: { schema: { type: 'object' }, render: (args, value) => toolText(store.formatSubtagTree(value)) },
          async execute(args) {
            return store.subtagTree({ tag: args?.tag, max_tags: args?.max_tags, max_components: args?.max_components });
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
            const result = reindexOnce();
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
            'Report the tag-graph repairs that need judgement rather than a rule: a root tag whose memories are already filed under another tag, near-synonym tags, a name that may be a collapsed path, a chain that may be one tag, stored values a rebuild does not reproduce, and the cycles — a cycle the stored graph really holds (`stored-cycle`, read from index.json before the normalizer drops its second edge) or two roots that each name the other as candidate parent (`candidate-mutual`); the finding says which shape it is and carries what makes a direction logical, or says plainly that nothing does. Read-only — it rewrites nothing. Every finding carries the facts to decide it and the decision shape to pass to memory_lab_tag_apply. ' +
              'This result also carries the judgement envelope: whether a run can be asked for right now, the request that says what is being judged, where it runs and what shape the answer takes, and `prompt` — the same ask as the prose you would send a model, ready to hand to a run as it stands. It is the SAME text the panel\'s 重建索引 dispatches when it runs the judgement itself, so a run you start by hand and a run started from the panel are asked the same thing. ' +
              'THE SEQUENCE IS AGENT-DRIVEN AND IT IS TWO CALLS: this tool gives you the evidence and the request; YOU decide; memory_lab_tag_apply applies and records your decisions. Nothing here judges. When you want a run to make the decision for you, obtain one from agent-api through its agent_api_send tool — that is also what the panel does, through this component.',
          parameters: {
            type: 'object',
            properties: {
              kinds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Report only these finding kinds: false-root, synonym-candidate, single-tag-path, path-might-be-one-tag, rule-not-reproducible, cycle-candidate. Omit for all of them.',
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
            'Apply the tag-graph decisions you made from memory_lab_tag_review: merge folds tags into one canonical tag, reparent continues a root tag under a parent, split turns a collapsed name into a chain, join turns a chain into one tag, cut removes one parent -> child edge from the component tagPaths that assert it (the way a cycle is broken: reparent cannot break one, because moving a node of a cycle under another node of it is refused as a cycle and moving it outside leaves the cycle intact), and set-tags/unfold restore previous tags exactly. Before it writes, the current index is archived under archive/ and one policy.jsonl line records the decisions, every affected component previous tags and an undo list that restores the previous graph. A judgement decision (merge, reparent, split, join, cut) requires the agent-api component and is refused while it is switched off; a reversal still applies.',
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
                      enum: ['merge', 'reparent', 'split', 'join', 'cut', 'set-tags', 'unfold'],
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
             * The five judging decisions need the Agent half of the rebuild, so with
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
