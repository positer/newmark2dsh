import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableState } from '../../lib/durable-state.js';
import { createRestartController, probeDesktop } from '../../lib/core-restart.js';
import { currentConversation, deliverConversation, conversationModel } from '../../lib/conversation-delivery.js';
import { createErrorLog } from '../../lib/errors.js';

/* The continuation an auto-covered conversation receives. It is deliberately the same text for
 * every session: the barrier promises "nobody is dropped", not "somebody guessed your next step",
 * so the wording must not pretend to know what that conversation was doing. */
// The restart itself does not touch a conversation's goal, but a RESUMED session has its goal
// DISARMED by the host: an active goal stops being continued automatically until it is re-armed.
// What this continuation may therefore SAY about the goal is bounded by the host's own authority
// rules, read from the installed tool (dsh-tool-goal/lib/index.js):
//   - update_goal edit / pause / resume and create_goal call requireDirectHuman(), which needs a
//     user/message with source.kind === 'user' in the open turn of a runtime root;
//   - update_goal complete / blocked accept that OR the goal's own admitted round (a user/message
//     with source.kind === 'goal' matching goalId+revision+round).
// A restart continuation is neither: its source is not 'user' and it is not a goal round. So the
// re-arm instruction this prompt used to carry (update_goal{action:"resume"}) was refused every
// single time it was obeyed - measured by the harness as "this goal operation requires a direct
// human turn on a top-level agent". The continuation now reads the goal, states the boundary, and
// leaves the re-arm to the human turn that can actually authorise it.
/*
 * The goal operations this continuation is allowed to ask for, as data rather than prose.
 *
 * The list is the host's rule, not ours: `get_goal` is a read and is always answered, while every
 * write needs authority this round does not carry. Keeping it here means the prompt below is
 * generated from the same facts a gate can assert, so the two cannot drift apart again.
 */
/* The continuation texts this component has shipped before. A durable task keeps the text it was
 * ENQUEUED with, so a task created by 0.3.50 still says "恢复这个对话的目标状态…update_goal resume"
 * after an upgrade and would be delivered verbatim - that is exactly how a fixed prompt kept
 * reaching a conversation and kept hitting the host's refusal. On boot these are rewritten to the
 * current text: the task's meaning ("wake this conversation and continue") did not change, only the
 * instruction did. A caller's own heartbeat_after_restart prompt is never in this list and is never
 * touched. */
const RETIRED_CONTINUATION_TEXTS = Object.freeze([
  'Newmark2DSH 已重启。先恢复这个对话的目标状态：读 get_goal；若 phase:"active" 且 activation:"disarmed"（会话恢复后宿主会把进行中的目标解除武装），调用 update_goal{action:"resume"} 重新武装；若 phase:"paused" 保持暂停，不要 resume；没有 goal 则跳过。然后从上一句用户消息继续；不要重复已经完成的动作，未完成的工作先说明状态。',
  'Newmark2DSH 已重启。先读 get_goal 了解目标状态，但这一轮不要写目标：create_goal 与 update_goal 的 edit/pause/resume 需要直接的人类轮次，complete/blocked 只在本目标自己的轮次里被接受，而重启接续两者都不是，调用它们必定被拒（"requires a direct human turn on a top-level agent"）。若目标是 active 且 disarmed，说明宿主在会话恢复时解除了武装——若目标仍是 active/disarmed：这一轮不要调用 update_goal，用一句话请用户回复“继续”，那一句人类输入才是重新武装它的授权。若 phase 是 paused 就保持暂停；没有 goal 则跳过。然后从上一句用户消息继续；不要重复已经完成的动作，未完成的工作先说明状态。',
]);
export const CONTINUATION_GOAL_POLICY = Object.freeze({
  allowed: Object.freeze(['get_goal', 'goal_restore']),
  refused: Object.freeze([
    'create_goal',
    'update_goal:edit',
    'update_goal:pause',
    'update_goal:resume',
    'update_goal:complete',
    'update_goal:blocked',
  ]),
  authority: 'update_goal pause/resume/edit and create_goal need a direct human message in this turn; complete/blocked are also legal on the goal\'s own admitted round; a restart continuation is neither, which is why it restores through goal_restore instead of the host tool.',
  resume_hint: '若目标被暂停（phase:"paused"）或在会话恢复时被解除武装（phase:"active" 且 activation:"disarmed"），调用 goal_restore 恢复它；它只做这一件事，不改写目标、不解除阻断。',
});
export const CONTINUATION_PROMPT = 'Newmark2DSH 已重启。重启前本组件已记录每个活动对话的目标状态，并在新进程里**自动**恢复当时处于 active 的目标（见 heartbeat_activity 的 goal_restore 回执），所以正常情况下目标已经在跑，你不需要做任何目标操作。先读 get_goal 确认：若仍是 active 且 armed，直接继续；若仍是 paused、或仍是 active 但 disarmed（说明自动恢复失败或晚于本次接续），调用 goal_restore 补一次。不要调用 create_goal 或 update_goal（自动续跑轮里它们必被拒：requires a direct human turn on a top-level agent），也不要改写目标或解除阻断。没有 goal 则跳过。然后从上一句用户消息继续；不要重复已经完成的动作，未完成的工作先说明状态。';
/* Agent-mode broadcast. It names the two tools by their exact parameters because the session's own
 * agent is the only party that can give a receipt for that session, and it must be able to do it
 * without guessing which call shape counts. */
const NOTIFY_PROMPT = id => 'Newmark2DSH 准备重启（intentId=' + id + '）。本对话在重启前必须给出接续回执：'
  + '需要重启后继续的工作请调用 heartbeat_after_restart {intentId:"' + id + '", prompt:"…"} 登记；'
  + '不需要接续请调用 heartbeat_restart_ack {intentId:"' + id + '", continuation:"none"}。'
  + '回执到齐之前不会重启。';
/* A leftover preparing intent means the process that opened the barrier died before committing, so
 * the restart it promised did NOT happen. Saying so is the point: the requester must not believe it
 * was restarted, and it must not silently keep waiting for a helper that will never run. */
const INTERRUPTED_PROMPT = id => 'Newmark2DSH 上一次两阶段重启（intentId=' + id + '）没有提交就中断了，DSH 仍在原进程中运行。'
  + '请检查是否有未完成的登记；需要时重新发起 heartbeat_restart {broadcast:true}。';
/* Cancelling an open preparation is a decision the requester made, so the notice says who ended it
 * and what it means: the host was NOT restarted and the promise to the participants is withdrawn.
 * It travels the same durable delivery path the interrupted notice uses — that is what makes "the
 * requester was told" a persisted fact rather than a claim about a socket. */
const CANCELLED_PROMPT = id => 'Newmark2DSH 两阶段重启（intentId=' + id + '）已被 requester 取消：DSH 继续运行，未执行重启。'
  + '该 intent 不会再被提交；需要重启时请重新发起 heartbeat_restart {broadcast:true}。';

const ACK_MODES = ['auto', 'agent'];
const TIMEOUT_POLICIES = ['abort', 'proceed'];
/* Phases in which the barrier still owns the restart decision. Anything else is history. */
const OPEN_PHASES = ['preparing', 'committing'];
/* An ack that ends this participant's obligation. 'closed' is terminal because a conversation that
 * no longer has a live agent cannot answer, and its continuation is still delivered after restart. */
const TERMINAL_ACKS = ['registered', 'none', 'closed'];
const DEFAULT_ACK_TIMEOUT_MS = 90000;
const MIN_ACK_TIMEOUT_MS = 1000;
const MAX_ACK_TIMEOUT_MS = 600000;
const INTENT_HISTORY_LIMIT = 20;
/* N consecutive FAILED delivery attempts end an armed task. The tick runs every 2 s, so three
 * failures is ~6 s of retrying — long enough that a transient throw (a flush that answers false, an
 * unreadable half-written status.json) is not mistaken for a dead task, short enough that the task
 * is reclaimed inside the session that observed it. ONLY a failure counts: a task whose restart
 * helper has not yet reported the new process, or whose companion target is switched off, is
 * WAITING, not failing, and is never counted. Without this bound an armed task whose helper
 * reported a "failed" status is retried forever — measured on this machine before the change: 7 tasks,
 * state.json schema 3, every one status:"armed", every helper status.json state:"failed". */
export const DELIVERY_FAILURE_LIMIT = 3;
/* The status a terminated task records ("failed(final)") is deliberately not "failed": an armed task
 * already carries an "error" field on a task that keeps retrying, so a reader must be able to tell
 * "this failed once and may still be delivered" from "this is over, and here is why". */
const TERMINATED_STATUS = 'failed(final)';
/* A restart performed OUTSIDE this component (a manual relaunch, an operator script) never runs the
 * barrier's commit, so every registered continuation stays status:"waiting" forever and the user is
 * told "已重启" while their conversation silently does not continue — measured 2026-10-26. Such a
 * task is adopted on the next boot: it was created by a DIFFERENT process, it is older than a minute
 * (so a continuation registered moments ago is never stolen), and at most ADOPT_LIMIT are adopted so
 * a stale queue cannot turn one boot into a flood. */
const ADOPT_MIN_AGE_MS = 60000;
/* How many 2 s ticks the post-restart goal restore waits for the host to load agents before it
 * records "could not read the services" and stops. 30 ticks is a minute: boot normally has the
 * sessions up long before that, and a receipt that says it gave up beats an endless retry. */
const GOAL_RESTORE_ATTEMPTS = 30;
/* How long after a boot the goal restore keeps watching. The host publishes its disarm when the
 * session really resumes, which can land a minute after the first tick (measured: armed at 01:27:07,
 * disarmed at 01:28:13), so a one-shot restore at boot can miss the very window it exists for. */
const GOAL_RESTORE_WINDOW_MS = 180000;
const ADOPT_LIMIT = 8;

export function createHeartBeat({ root, core, agents, goals = () => null, controller = createRestartController(root), probe = probeDesktop, pid = process.pid, version, logger, now = Date.now }) {
  const failures = createErrorLog({root,logger});
  /**
   * The version a restart should end up running: the one ON DISK, not the one this process was
   * built from. "Install the new package, then restart" is the normal path, and preparing with the
   * running version made the restart controller refuse with 安装版本未通过核验 every time the two
   * differed — which is exactly when a restart matters.
   */
  const installedVersion = () => {
    try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || version; }
    catch { return version; }
  };
  const store = durableState(path.join(root, 'heartBeat', 'state.json'), { schema: 3, tasks: [], receipts: [], terminated: [], intent: null, intents: [] });
  // Retire the previous delivered marker into a permanent consumption receipt.
  if(store.read().tasks.some(t=>t.status==='delivered')) store.change(s=>{s.receipts ||= [];for(const t of s.tasks.filter(t=>t.status==='delivered'))if(!s.receipts.some(r=>r.id===t.id))s.receipts.push({id:t.id,delivered:t.delivered||Date.now()});s.tasks=s.tasks.filter(t=>t.status!=='delivered');s.schema=3;});
  let pumping = false, stopped = false;
  let goalRestoreAttempts = 0;
  // A continuation registered by an earlier process is evidence that a restart was intended. If this
  // process is that restart (whatever performed it), the task must be delivered here instead of
  // waiting for a helper that will never report.
  const adopted = [];
  store.change(s => {
    for (const task of s.tasks) {
      if (task.status !== 'waiting' || task.creatorPid === pid) continue;
      if (Date.now() - (Number(task.created) || 0) < ADOPT_MIN_AGE_MS) continue;
      if (adopted.length >= ADOPT_LIMIT) break;
      Object.assign(task, { status: 'armed', restartPid: null, folder: null, adoptedAt: Date.now() });
      adopted.push(task.id);
    }
    s.schema = 3;
  });

  /* ------------------------------------------------------------------ participants --- */
  // "Running conversation" is read from the host, never from a caller's argument: a barrier whose
  // members are named by the party restarting protects nobody.
  // The host's OWN predicate for "this Session's Agent is running" is `agent.status === 'running'`
  // — dsh-agent's installTurnArchiveAdmission reads exactly that, and documents it as "a turn
  // waiting for an approval or an answer included". Reading `agent.running` /
  // `agent.session.running` (fields the host never sets) made this false for EVERY conversation,
  // so every loaded conversation was labelled 'live', became a participant, and was woken by a
  // continuation after the restart. Measured 2026-10-17: a broadcast over two live sessions
  // continued a conversation that had nothing in flight.
  const looksBusy = agent => agent?.status === 'running';
  // A conversation the user PAUSED is a conversation the user stopped: a restart must not wake it.
  // The goal service is the only holder of that decision — dsh-tool-goal reads `ctx.goals.get(agent)`
  // — and it is keyed by the live AGENT object, returning { phase, ... }. An absent service, an
  // absent goal and a throwing read all mean "no pause recorded": a restart is never refused
  // because a goal could not be read.
  const pausedByUser = agent => { try { return goals?.()?.get?.(agent)?.phase === 'paused'; } catch { return false; } };
  // Who a restart may wake. The requester is always included (it is the one asking); everyone else
  // must be CONFIRMED to be running AND not paused by the user.
  const wokenByBarrier = (entry, requesterSessionId) => entry.view.sessionId === requesterSessionId || (entry.view.state === 'busy' && !pausedByUser(entry.agent));
  const wokenByUpdate = entry => entry.view.state === 'busy' && !pausedByUser(entry.agent);
  const identity = agent => {
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : (typeof agent?.id === 'string' ? agent.id : null);
    if (!sessionId) return null;
    const title = typeof agent?.session?.title === 'string' && agent.session.title.trim() ? agent.session.title : null;
    const activity = Number(agent?.session?.lastActivityAt);
    // state is what the host exposes and nothing more: 'busy' only when the host marks the agent
    // running, 'live' otherwise. 'closed' and 'unreachable' are written later, where they are
    // actually measured — by liveness re-reads and by a failed delivery.
    return { sessionId, title, lastActivityAt: Number.isFinite(activity) ? activity : null, state: looksBusy(agent) ? 'busy' : 'live' };
  };
  const liveAgents = () => {
    const service = agents();
    if (!service || typeof service.roots !== 'function') return null;
    return service.roots().map(agent => ({ agent, view: identity(agent) })).filter(entry => entry.view);
  };

  /* ------------------------------------------------------- goal continuity --- */
  /**
   * Snapshot every live conversation's GOAL state and RUNNING state, right before a restart.
   *
   * Why this exists. The host keeps a goal's durable phase but its continuation authority
   * (activation) is PROCESS-local: on the session-start edge after a restart, dsh-goal publishes
   * 'disarmed' (dsh-goal/lib/index.js, the session-start subscription, and runtimeState() which
   * starts every process with activation 'disarmed'). A goal that was running therefore stops being
   * continued by dsh-goal-round-driver - the driver only acts when phase==='active' &&
   * activation==='armed' - until something calls goals.resume(agent, ref). The host's own tool can't:
   * update_goal{action:'resume'} requires a direct human turn. So the restart itself has to remember
   * what was running and re-arm it once the new process has the agents back.
   *
   * What is recorded is what the re-arm decision needs and nothing else: session id, whether the
   * conversation was running, and the goal's id/phase/activation/revision/rounds. The objective is
   * deliberately NOT copied - this snapshot must never become a way to rewrite a goal.
   */
  const captureGoalSnapshot = (reason) => {
    const live = liveAgents();
    if (live === null) return { ok: false, code: 'agents_unavailable', record: null };
    const service = goals?.() ?? null;
    const entries = [];
    for (const entry of live) {
      let goal = null;
      try { goal = service?.get?.(entry.agent) ?? null; } catch (error) { goal = null; }
      entries.push({
        sessionId: entry.view.sessionId,
        title: entry.view.title,
        running: entry.view.state === 'busy',
        goalId: goal?.id ?? null,
        phase: goal?.phase ?? null,
        activation: goal?.activation ?? null,
        revision: goal?.revision ?? null,
        roundsStarted: goal?.roundsStarted ?? null,
        maxGoalRounds: goal?.maxGoalRounds ?? null,
      });
    }
    const record = { schema: 1, at: now(), reason, entries };
    store.change((s) => { s.schema = 3; s.goalSnapshot = record; s.goalRestore = null; });
    return { ok: true, code: 'captured', record, count: entries.length };
  };

  /**
   * Re-arm the goals that were RUNNING when the restart happened, once, on the new process.
   *
   * Only a goal whose phase was 'active' before the restart is a candidate. 'paused' is the user's
   * stop and 'blocked' is a conclusion a human reached - the service would happily resume a blocked
   * goal (its resumable set is active/paused/blocked), which is exactly why this check is here: the
   * restart must not turn either decision into a side effect. A complete goal has nothing to resume.
   *
   * It waits for the agents to exist (the host loads sessions asynchronously after boot), and gives
   * up honestly: after GOAL_RESTORE_ATTEMPTS ticks the receipt says so instead of retrying forever.
   */
  /**
   * Rewrite any queued continuation that still carries a retired instruction.
   *
   * A durable task keeps the text it was enqueued with, so after an upgrade the queue can still
   * hold the OLD goal instruction and deliver it word for word (measured 01:17:57: a conversation
   * received the previous version's text one restart after the fix was installed). The task's
   * meaning never changed - wake and continue - so the text is refreshed to what this version
   * wants to say. Only the exact retired strings are rewritten; a caller's own prompt is never
   * matched and never touched.
   */
  const refreshStaleContinuations = () => {
    let refreshed = 0;
    store.change((s) => {
      for (const task of s.tasks) {
        if (task.status !== 'waiting' && task.status !== 'armed') continue;
        if (!RETIRED_CONTINUATION_TEXTS.includes(task.prompt)) continue;
        task.prompt = CONTINUATION_PROMPT;
        task.refreshedAt = now();
        refreshed += 1;
      }
      s.schema = 3;
    });
    return refreshed;
  };

  const restoreGoalSnapshot = () => {
const state = store.read();
/* Only a receipt THIS version wrote carries `events` and `candidates`. A receipt from an older
 * version is discarded rather than reused: its shape makes the watch throw (measured 01:31: the
 * 0.3.58 boot inherited a 0.3.57 receipt with no `events` array, threw on record.events.filter and
 * never wrote a new one - so nothing was watched and nothing restored). */
const rawExisting = state.goalRestore || null;
/* The record belongs to ONE boot. `pid` is the boot identity here: reusing a receipt from the
 * previous process carried its candidate list and its settle marks into a new boot, which produced
 * a receipt saying agents_loaded 0 and all_sessions_settled while the goal had only ever been
 * observed (measured 01:38:59). Cross-boot reuse is never correct - the host state it describes is
 * gone - so only this process's own record is resumed. */
const existing = rawExisting && rawExisting.bootPid === pid && Array.isArray(rawExisting.events) && Array.isArray(rawExisting.candidates) ? rawExisting : null;
if (existing?.settled) return { state: 'settled', receipt: existing };
const snapshot = state.goalSnapshot && !state.goalSnapshot.appliedAt && !state.goalSnapshot.gaveUpAt ? state.goalSnapshot : null;
const service = goals?.() ?? null;
const live = liveAgents();
if (!service || typeof service.resume !== 'function' || typeof service.get !== 'function' || (live === null && !existing)) {
  goalRestoreAttempts += 1;
  if (goalRestoreAttempts >= GOAL_RESTORE_ATTEMPTS) {
    store.change((s) => {
      s.schema = 3;
      s.goalRestore = { ...(s.goalRestore || {}), settled: true, closed_reason: 'services_unavailable', attempts: goalRestoreAttempts, at: s.goalRestore?.at ?? now(), deadline: s.goalRestore?.deadline ?? now(), mode: snapshot ? 'snapshot' : 'boot_sweep', events: s.goalRestore?.events || [], resumed: s.goalRestore?.resumed || [], skipped: s.goalRestore?.skipped || [], resumed_count: s.goalRestore?.resumed_count || 0, skipped_count: (s.goalRestore?.skipped || []).length };
    });
    failures.record({ where: 'heartbeat/goal-restore', code: 'services_unavailable', message: 'goal restore could not read the goal service or the agent registry', fields: { attempts: goalRestoreAttempts } });
  }
  return { state: 'waiting', attempts: goalRestoreAttempts };
}
/* The candidates: with a snapshot, the conversations that were ACTIVE when we went down; without
 * one, every live conversation (an external relaunch wrote no snapshot at all). */
const candidates = snapshot && Array.isArray(snapshot.entries) && snapshot.entries.length
  ? snapshot.entries.map((entry) => ({ sessionId: entry.sessionId, phase_before: entry.phase, from: 'snapshot' }))
  : (live || []).map((entry) => ({ sessionId: entry.view.sessionId, phase_before: null, from: 'boot_sweep' }));
/* READINESS: an empty registry on the first tick is not "nothing to restore" - the host loads
 * sessions asynchronously. Measured 01:24:55 and again 01:27:07: acting on that empty (or stale)
 * view produced a receipt with nothing resumed while a live goal sat disarmed. */
const loadedNow = candidates.filter((entry) => (live || []).some((candidate) => candidate.view.sessionId === entry.sessionId));
if (!loadedNow.length && !existing) {
  goalRestoreAttempts += 1;
  if (goalRestoreAttempts < GOAL_RESTORE_ATTEMPTS) return { state: 'waiting', attempts: goalRestoreAttempts, agents_loaded: (live || []).length };
  store.change((s) => {
    s.schema = 3;
    s.goalRestore = { at: now(), deadline: now(), mode: snapshot ? 'snapshot' : 'boot_sweep', settled: true, closed_reason: 'agents_never_loaded', attempts: goalRestoreAttempts, agents_loaded: (live || []).length, events: [], resumed: [], skipped: [] };
  });
  return { state: 'gave_up' };
}
/* The candidate list is PERSISTED with the record: without that, the second tick recomputes it from
 * a snapshot that is already marked applied, silently switches to "every live agent", and loses the
 * conversations that have not come back yet. */
const candidatesUsed = existing?.candidates?.length ? existing.candidates : candidates;
const record = existing || {
  bootPid: pid,
  candidates: candidates.map((entry) => ({ sessionId: entry.sessionId, phase_before: entry.phase_before, from: entry.from })),
  at: now(),
  snapshotAt: snapshot?.at ?? null,
  mode: snapshot ? 'snapshot' : 'boot_sweep',
  reason: snapshot?.reason ?? 'no_snapshot',
  deadline: now() + GOAL_RESTORE_WINDOW_MS,
  settled: false,
  events: [],
  resumed: [],
  skipped: [],
  resumed_count: 0,
  skipped_count: 0,
  verified_count: 0,
};
const refreshed = refreshStaleContinuations();
/* ONLY a terminal outcome settles a session. Seeing 'armed' does not: the host publishes its
 * disarm when the session really resumes, which can land a minute AFTER a resume of ours
 * (measured 01:34:54 resumed+armed, 01:36:01 disarmed again). A watch that closes on the first
 * 'armed' therefore stops exactly when it is still needed. */
const settledSessions = new Set(record.events.filter((event) => event.kind === 'settled').map((event) => event.sessionId));
let resumedNow = 0;
for (const entry of candidates) {
  if (settledSessions.has(entry.sessionId)) continue;
  const found = (live || []).find((candidate) => candidate.view.sessionId === entry.sessionId);
  const settle = (kind, reason, extra = {}) => record.events.push({ at: now(), sessionId: entry.sessionId, kind, reason, ...extra });
  if (!found) {
    /* Not loaded yet: a reason only once the window is over, otherwise it is still coming. */
    if (now() > record.deadline) { record.skipped.push({ sessionId: entry.sessionId, reason: 'agent_not_loaded', phase_before: entry.phase_before }); settle('settled', 'agent_not_loaded'); }
    continue;
  }
  let goal = null;
  try { goal = service.get(found.agent) ?? null; } catch (error) {
    record.skipped.push({ sessionId: entry.sessionId, reason: 'goal_read_failed', error: String(error?.message || error), phase_before: entry.phase_before }); settle('settled', 'goal_read_failed');
    continue;
  }
  if (!goal) { record.skipped.push({ sessionId: entry.sessionId, reason: 'no_goal_now', phase_before: entry.phase_before }); settle('settled', 'no_goal_now'); continue; }
  if (goal.phase === 'blocked') { record.skipped.push({ sessionId: entry.sessionId, reason: 'goal_blocked', phase_before: entry.phase_before }); settle('settled', 'goal_blocked'); continue; }
  if (goal.phase === 'complete') { record.skipped.push({ sessionId: entry.sessionId, reason: 'goal_complete', phase_before: entry.phase_before }); settle('settled', 'goal_complete'); continue; }
  if (goal.phase === 'paused') { record.skipped.push({ sessionId: entry.sessionId, reason: 'paused_by_user', phase_before: entry.phase_before }); settle('settled', 'paused_by_user'); continue; }
  if (goal.phase !== 'active') { record.skipped.push({ sessionId: entry.sessionId, reason: 'phase_changed', phase: goal.phase }); settle('settled', 'phase_changed'); continue; }
  if (goal.activation === 'armed') {
    /* Armed RIGHT NOW. That is not proof it will stay armed: the host publishes its disarm when the
     * session actually resumes, which lands AFTER the first tick (measured 01:27:07 armed at boot,
     * 01:28:13 disarmed already). So the session is watched until the window closes and re-armed the
     * moment it goes disarmed. */
    record.events.push({ at: now(), sessionId: entry.sessionId, kind: 'observed', reason: 'armed', phase_before: entry.phase_before });
    continue;
  }
  const before = { phase: goal.phase, activation: goal.activation, roundsStarted: goal.roundsStarted };
  try { service.resume(found.agent, { id: goal.id, revision: goal.revision }); }
  catch (error) { record.skipped.push({ sessionId: entry.sessionId, reason: 'resume_refused', error: String(error?.message || error), phase_before: entry.phase_before }); settle('settled', 'resume_refused'); continue; }
  let after = null;
  try { after = service.get(found.agent); } catch { after = null; }
  const verified = Boolean(after && after.phase === 'active' && after.activation === 'armed');
  record.resumed.push({ sessionId: entry.sessionId, goalId: goal.id, before, after: after ? { phase: after.phase, activation: after.activation, roundsStarted: after.roundsStarted } : null, verified, from: entry.from, at: now() });
  /* NOT settled: a disarm that lands after this resume (the host publishes it when the session
   * really resumes) must be caught by a later tick inside the window. */
  resumedNow += 1;
}
record.resumed_count = record.resumed.length;
record.skipped_count = record.skipped.length;
record.verified_count = record.resumed.filter((entry) => entry.verified).length;
record.refreshed_continuations = (record.refreshed_continuations || 0) + refreshed;
record.agents_loaded = (live || []).length;
record.agents_expected = candidates.length;
record.attempts = goalRestoreAttempts + 1;
const allSettled = candidates.every((entry) => settledSessions.has(entry.sessionId));
if (allSettled) { record.settled = true; record.closed_reason = 'all_sessions_settled'; }
else if (now() > record.deadline) { record.settled = true; record.closed_reason = 'window_elapsed'; }
store.change((s) => { s.schema = 3; if (s.goalSnapshot && !s.goalSnapshot.appliedAt) s.goalSnapshot = { ...s.goalSnapshot, appliedAt: now() }; s.goalRestore = record; });
if (record.settled) goalRestoreAttempts = 0;
return { state: record.settled ? 'settled' : 'watching', receipt: record, resumed_now: resumedNow };
  };

  /**
   * The pre-restart probe: who ELSE is running right now.
   *
   * A restart that goes straight to globalRestart() cannot tell the caller that it is about to
   * interrupt somebody's turn. The tool layer therefore asks this FIRST and refuses to restart
   * until the caller has either seen this report and forced it, or opened the broadcast barrier
   * that lets every running conversation register its continuation and finish.
   *
   * 'running' means the host's own predicate (agent.status === 'running') and not paused by the
   * user. The requester is reported separately as `self`: it is always the one asking.
   */
  const activity = (execution) => {
    const requesterSessionId = execution ? currentConversation(execution) : null;
    const live = liveAgents();
    if (live === null) return { ok: false, code: 'agents_unavailable', error: 'DSH agents 服务不可用，无法确认是否有其他对话在运行' };
    const self = live.find(entry => entry.view.sessionId === requesterSessionId) || null;
    const busyOthers = live.filter(entry => entry.view.sessionId !== requesterSessionId && entry.view.state === 'busy' && !pausedByUser(entry.agent));
    const running = busyOthers.map(entry => ({ ...entry.view }));
    const idleOthers = live.filter(entry => entry.view.sessionId !== requesterSessionId).length - running.length;
    const intent = store.read().intent;
    return {
      ok: true,
      at: now(),
      self: self ? { ...self.view } : null,
      running,
      count: running.length,
      idleOthers: Math.max(0, idleOthers),
      intent: intent ? progressOf(intent) : null,
      /* What the LAST restart did to goals, so a caller can ask instead of guessing. */
      goal_restore: store.read().goalRestore || null,
    };
  };


  /* ------------------------------------------------------------------------- tasks --- */
  const enqueue = (prompt, destination, agent, options = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw Error('重启任务须为 1–16000 字符');
    if (typeof destination !== 'string' || !destination) throw Error('重启任务需要目标对话');
    // ONE pending continuation per (destination, prompt). The barrier's auto registration and the
    // update route's wokenByUpdate both enqueue the SAME continuation text for the same session;
    // measured 2026-10-26 20:32: that produced two identical continuation messages for one restart,
    // and the conversation was woken twice for it. A second registration with identical content is
    // the same promise, not a new one.
    const duplicate = store.read().tasks.find(t => t.destination === destination && t.prompt === prompt && (t.status === 'waiting' || t.status === 'armed'));
    if (duplicate) return { ok: true, id: duplicate.id, destination, duplicate: true };
    const modelSelection=conversationModel(agent);
    const id = randomUUID(); store.change(s => { if(s.tasks.length >= 2000) throw Error('heartBeat 任务队列已达容量上限'); s.tasks.push({ id, prompt, destination, status: 'waiting', created: Date.now(), creatorPid: pid, ...options.kind ? { kind: options.kind } : {},...modelSelection?{modelSelection}:{} }); }); return { ok: true, id, destination };
  };
  const schedule = (prompt, destination, execution, options = {}) => {
    if (execution) destination = currentConversation(execution);
    const registered = enqueue(prompt, destination, execution?.agent, options);
    // A registration made while a barrier is open IS that session's receipt, so the caller cannot
    // register a continuation and then be reported as missing.
    if (options.intentId) ack(destination, 'registered', 'schedule', options.intentId);
    return { ok: true, id: registered.id };
  };

  /* ------------------------------------------------------------------------ intent --- */
  const activeIntent = () => {
    const state = store.read();
    return state.intent && OPEN_PHASES.includes(state.intent.phase) ? state.intent : null;
  };
  const participantOf = (intent, sessionId) => intent?.participants.find(p => p.sessionId === sessionId) || null;
  const pendingOf = intent => (intent?.participants || []).filter(p => !TERMINAL_ACKS.includes(p.ack))
    .map(p => ({ sessionId: p.sessionId, title: p.title, state: p.state, lastActivityAt: p.lastActivityAt, ack: p.ack, note: p.note || null }));
  const ackedOf = intent => (intent?.participants || []).filter(p => TERMINAL_ACKS.includes(p.ack))
    .map(p => ({ sessionId: p.sessionId, ack: p.ack, ackSource: p.ackSource, ackAt: p.ackAt }));
  const progressOf = intent => ({ phase: intent.phase, participants: intent.participants.length, acked: ackedOf(intent).length, missing: pendingOf(intent), deadline: intent.deadline });
  function ack(sessionId, continuation, source, intentId) {
    let changed = false;
    store.change(s => {
      const intent = s.intent;
      if (!intent || !OPEN_PHASES.includes(intent.phase)) return;
      if (intentId && intent.id !== intentId) return;
      const participant = participantOf(intent, sessionId);
      if (!participant || participant.ack === continuation) return;
      Object.assign(participant, { ack: continuation, ackSource: source, ackAt: now() });
      intent.updatedAt = now(); s.schema = 3; changed = true;
    });
    return changed;
  }
  function note(sessionId, text, intentId) {
    store.change(s => { const intent = s.intent; if (!intent || intent.id !== intentId) return; const participant = participantOf(intent, sessionId); if (participant) participant.note = text; s.schema = 3; });
  }
  function finishIntent(reason, phase) {
    const open = store.read().intent;
    if (!open) return null;
    const record = { ...open, phase, abortReason: reason || null, closedAt: now(), updatedAt: now() };
    store.change(s => {
      if (!s.intent) return;
      Object.assign(s.intent, record);
      s.intents ||= []; s.intents.push(s.intent);
      if (s.intents.length > INTENT_HISTORY_LIMIT) s.intents = s.intents.slice(-INTENT_HISTORY_LIMIT);
      s.intent = null; s.schema = 3;
    });
    return record;
  }

  /* Auto mode pays no model token and still covers a busy conversation: the durable continuation it
   * registers is the same fact a delivered task reads, so the receipt cannot claim more than the
   * delivery will honour. A registration that fails is not a missing receipt — it is a participant
   * that cannot be reached, and it must block the barrier exactly like a refusal would. */
  async function cover(entry, intent) {
    try { enqueue(CONTINUATION_PROMPT, entry.view.sessionId, entry.agent); ack(entry.view.sessionId, 'registered', 'auto', intent.id); return true; }
    catch (error) { ack(entry.view.sessionId, 'unreachable', 'auto', intent.id); note(entry.view.sessionId, 'auto:' + String(error.message), intent.id); return false; }
  }
  /* Agent mode asks the conversation itself. The notification goes through the same durable delivery
   * and flush barrier as a task, so "the session was told" means the message is persisted, not that
   * a socket accepted a byte. The requester is skipped: it is inside this call and will ack by tool. */
  async function notify(entry, intent) {
    try {
      await deliverConversation(agents(), entry.view.sessionId, { id: 'intent:' + intent.id + ':' + entry.view.sessionId, prompt: NOTIFY_PROMPT(intent.id), modelSelection: conversationModel(entry.agent) });
      return true;
    } catch (error) { ack(entry.view.sessionId, 'unreachable', 'notify', intent.id); note(entry.view.sessionId, 'notify:' + String(error.message), intent.id); return false; }
  }
  /* Best effort by design. The companion is a courtesy channel, so a disabled switch or a silenced
   * bubble must not become a reason a restart is refused — but it is recorded, because "we told the
   * user" is a claim that has to be readable after the fact. */
  async function notifyCompanion(intent) {
    const mate = core()?.newMate;
    if (!mate || typeof mate.message !== 'function') return 'no-companion';
    try {
      await mate.message(
        'Newmark2DSH 准备重启（intentId=' + intent.id + '，' + intent.participants.length + ' 个运行中对话）。'
        + '接续回执到齐后才会重启；到 ' + new Date(intent.deadline).toISOString() + ' 仍未到齐时按「'
        + (intent.onTimeout === 'abort' ? '放弃重启' : '照常重启') + '」处理。'
        + '放弃方式是让这次准备过期或提交一次会缺回执的 commit。',
        { id: 'newmark-intent:' + intent.id, summary: 'Newmark2DSH 准备重启，等待接续回执' });
      return 'sent';
    } catch (error) { return 'skipped:' + String(error.message); }
  }
  /* A session that is gone cannot answer, so it leaves the required set; its record stays, because
   * the continuation registered for it is still owed after the restart. A conversation that appeared
   * AFTER the broadcast is added instead of ignored: restarting it behind its back is the exact harm
   * this barrier exists to prevent. */
  async function refresh(intent) {
    const live = liveAgents();
    if (live === null) return false;
    const alive = new Set(live.map(entry => entry.view.sessionId));
    for (const participant of store.read().intent?.participants || []) {
      if (participant.sessionId === intent.requesterSessionId) continue;
      if (!alive.has(participant.sessionId) && !TERMINAL_ACKS.includes(participant.ack)) ack(participant.sessionId, 'closed', 'liveness', intent.id);
    }
    const seen = new Set((store.read().intent?.participants || []).map(p => p.sessionId));
    for (const entry of live) {
      if (seen.has(entry.view.sessionId)) continue;
      // Same rule as beginBarrier: APPEARING is not the same as WORKING. A conversation that
      // appeared and is not in a turn cannot be interrupted by the restart, so it is not added —
      // waking it would be the over-broadcast this narrowing exists to remove.
      if (!wokenByBarrier(entry, intent.requesterSessionId)) continue;
      store.change(s => { if (s.intent?.id !== intent.id) return; s.intent.participants.push({ ...entry.view, ack: 'pending', ackSource: null, ackAt: null, note: 'appeared-after-prepare' }); s.schema = 3; });
      if (intent.ackMode === 'auto') await cover(entry, intent);
    }
    return true;
  }

  /* --------------------------------------------------------------- barrier phase --- */
  async function beginBarrier(options = {}, execution) {
    const requesterSessionId = currentConversation(execution);
    const ackMode = options.ackMode === undefined ? 'auto' : options.ackMode;
    if (!ACK_MODES.includes(ackMode)) throw Error('接续回执模式须为 auto 或 agent');
    const onTimeout = options.onTimeout === undefined ? 'abort' : options.onTimeout;
    if (!TIMEOUT_POLICIES.includes(onTimeout)) throw Error('超时策略须为 abort 或 proceed');
    const ackTimeoutMs = options.ackTimeoutMs === undefined ? DEFAULT_ACK_TIMEOUT_MS : options.ackTimeoutMs;
    if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs < MIN_ACK_TIMEOUT_MS || ackTimeoutMs > MAX_ACK_TIMEOUT_MS) throw Error('接续回执超时须为 ' + MIN_ACK_TIMEOUT_MS + '–' + MAX_ACK_TIMEOUT_MS + ' 之间的整数毫秒');
    const reason = options.reason === undefined ? null : options.reason;
    if (reason !== null && (typeof reason !== 'string' || reason.length > 200)) throw Error('重启理由须为不超过 200 字符的字符串');
    const running = activeIntent();
    if (running) return { ok: false, phase: 'rejected', reason: 'intent_in_progress', intentId: running.id, progress: progressOf(running) };
    const live = liveAgents();
    if (live === null) throw Error('DSH agents 服务不可用，无法确认运行中的对话，不发起广播重启');
    const at = now();
    const requester = live.find(entry => entry.view.sessionId === requesterSessionId);
    // Only conversations CONFIRMED to be running are protected and woken. An idle-but-loaded
    // conversation has no turn in flight: the restart cannot interrupt it, and a continuation
    // would only wake it for nothing. The requester is always a participant — it is the one asking.
    const participants = live.filter(entry => wokenByBarrier(entry, requesterSessionId));
    const intent = {
      id: randomUUID(), requesterSessionId, requesterPid: pid, createdAt: at, updatedAt: at,
      deadline: at + ackTimeoutMs, ackMode, onTimeout, force: options.force === true, reason,
      requesterModel: requester ? conversationModel(requester.agent) : null,
      phase: 'preparing', ticket: null, folder: null, committedAt: null, delivery: null, bubble: null,
      participants: participants.map(entry => ({ ...entry.view, ack: 'pending', ackSource: null, ackAt: null, note: null })),
    };
    store.change(s => { s.intent = intent; s.intents ||= []; s.schema = 3; });
    for (const entry of participants) {
      if (ackMode === 'auto') await cover(entry, intent);
      else if (entry.view.sessionId !== requesterSessionId) await notify(entry, intent);
    }
    const bubble = await notifyCompanion(intent);
    store.change(s => { if (s.intent?.id === intent.id) s.intent.bubble = bubble; s.schema = 3; });
    const current = store.read().intent;
    return {
      ok: true, phase: 'preparing', intentId: intent.id, ackMode, onTimeout, deadline: intent.deadline,
      participants: current ? current.participants.map(p => ({ ...p })) : [], missing: current ? pendingOf(current) : [],
    };
  }

  async function commitBarrier(options = {}, execution) {
    const requesterSessionId = currentConversation(execution);
    const wanted = typeof options.intentId === 'string' && options.intentId ? options.intentId : null;
    const state = store.read();
    const intent = state.intent;
    if (!intent || !OPEN_PHASES.includes(intent.phase)) return { ok: false, phase: 'aborted', intentId: wanted ?? intent?.id ?? null, reason: 'no_intent', missing: [] };
    // The named intent must BE the open one. Without this, a commit for an intent that was already
    // cancelled (or already closed for any other reason) would silently spend whatever barrier is
    // open at that moment — i.e. withdraw a promise nobody committed to and restart the host on it.
    if (wanted && intent.id !== wanted) return { ok: false, phase: 'aborted', intentId: wanted, reason: 'intent_mismatch', missing: [] };
    // Only the session that opened the barrier may spend it. A refusal here leaves the intent open,
    // because a stranger's failed attempt is not the requester's decision to abandon.
    if (intent.requesterSessionId !== requesterSessionId) return { ok: false, phase: 'aborted', intentId: intent.id, reason: 'not_requester', missing: pendingOf(intent) };
    await refresh(intent);
    const at = now();
    const abort = reason => { const closed = finishIntent(reason, 'aborted'); return { ok: false, phase: 'aborted', intentId: closed.id, reason, missing: pendingOf(closed) }; };
    const force = options.force === true || intent.force === true;
    const proceed = intent.onTimeout === 'proceed';
    if (!force) {
      // A deadline that has passed is not a slow participant, it is a decision that was never made;
      // unless the requester chose 'proceed', it aborts and the host keeps running.
      if (at > intent.deadline && !proceed) return abort('deadline_exceeded');
      const requester = participantOf(store.read().intent, requesterSessionId);
      if (!requester || requester.ack !== 'registered') return abort('requester_not_registered');
      const missing = pendingOf(store.read().intent);
      if (missing.length && !(proceed && at > intent.deadline)) return abort('missing_acks');
    }
    const missing = pendingOf(store.read().intent);
    const acks = ackedOf(store.read().intent);
    let prepared, helper;
    /* What was running BEFORE the helper takes this process down. The new process cannot read it
     * afterwards, so it is recorded here, next to the restart that will need it. */
    const goalSnapshot = captureGoalSnapshot('barrier');
    try {
      prepared = await controller.prepare(installedVersion());
      helper = await controller.restart(prepared.ticket);
    } catch (error) {
      // The launch failed, so the run must be exactly as it was: still preparing, still abortable.
      failures.record({ where: 'heartbeat/barrier', code: error.code || 'restart_failed', message: String(error.message), fields: { intentId: intent.id } });
      throw error;
    }
    store.change(s => {
      if (s.intent?.id !== intent.id) return;
      Object.assign(s.intent, { phase: 'committing', ticket: prepared.ticket, folder: helper.folder, committedAt: at, updatedAt: at, missing, acks });
      for (const t of s.tasks) if (t.status === 'waiting') Object.assign(t, { status: 'armed', restartPid: pid, folder: helper.folder });
      s.schema = 3;
    });
    return { ok: true, phase: 'committed', intentId: intent.id, acks, missing, helper };
  }

  /* The one transition the state machine did not have: an open preparation is a promise the
   * requester may withdraw explicitly, instead of abandoning it by committing a barrier that is
   * certain to be missing receipts or by waiting the deadline out. Only the session that OPENED the
   * intent may cancel it — a stranger's cancel is not the requester's decision, exactly as a
   * stranger's commit is not — and only while the intent is still 'preparing': once 'committing'
   * the helper has already been launched and the restart is a thing that has happened, not a
   * promise that can be withdrawn. Every refusal is a named code and writes nothing. */
  async function cancelBarrier(options = {}, execution) {
    const requesterSessionId = currentConversation(execution);
    const wanted = typeof options.intentId === 'string' && options.intentId ? options.intentId : null;
    const state = store.read();
    const intent = state.intent;
    if (!intent || intent.id !== wanted) {
      const closed = (state.intents || []).some(record => record.id === wanted);
      return { ok: false, phase: 'refused', reason: closed ? 'not_preparing' : 'unknown_intent', intentId: wanted, missing: [] };
    }
    if (intent.requesterSessionId !== requesterSessionId) return { ok: false, phase: 'refused', reason: 'not_requester', intentId: intent.id, missing: pendingOf(intent) };
    if (intent.phase !== 'preparing') return { ok: false, phase: 'refused', reason: 'not_preparing', intentId: intent.id, missing: pendingOf(intent) };
    const missing = pendingOf(intent);
    const closed = finishIntent('cancelled', 'aborted');
    const notified = await notifyCancelled(closed);
    return { ok: true, phase: 'aborted', intentId: closed.id, reason: 'cancelled', missing, notified };
  }

  /* Best effort and recorded, for the same reason the interrupted notice is: "the requester was
   * told" has to be readable after the fact, and a notice that could not be delivered must not turn
   * a cancel that DID happen into a failed call. */
  async function notifyCancelled(intent) {
    if (!intent?.requesterSessionId) return 'no-requester';
    try {
      await deliverConversation(agents(), intent.requesterSessionId, { id: 'intent-cancelled:' + intent.id, prompt: CANCELLED_PROMPT(intent.id), modelSelection: intent.requesterModel });
      return 'sent';
    } catch (error) {
      failures.record({ where: 'heartbeat/barrier-cancel-notice', code: error.code || 'notice_failed', message: String(error.message), fields: { intentId: intent.id } });
      return 'skipped:' + String(error.message);
    }
  }

  function acknowledge(options = {}, execution) {
    const sessionId = currentConversation(execution);
    const intent = store.read().intent;
    if (!intent || !OPEN_PHASES.includes(intent.phase)) throw Error('当前没有进行中的重启准备，无法给出接续回执');
    const participant = participantOf(intent, sessionId);
    if (!participant) throw Error('该对话不是本次重启准备的参与者；接续回执只能由参与者自己给出');
    const continuation = options.continuation;
    if (continuation !== 'registered' && continuation !== 'none') throw Error("接续回执须为 'registered' 或 'none'");
    ack(sessionId, continuation, 'ack', intent.id);
    return { ok: true, intentId: intent.id, sessionId, ack: continuation, missing: pendingOf(store.read().intent) };
  }

  const barrierState = () => { const state = store.read(); return { intent: state.intent || null, intents: state.intents || [] }; };
  /* The status a reader gets back: the durable file plus the collections that may be absent in a
   * file written before they existed. A terminated task is REPORTED here — never silently dropped —
   * because "this armed task is over, and here is why" is the fact a reader of the queue needs. */
  const status = () => {
    const state = store.read();
    return { ...state, tasks: state.tasks || [], receipts: state.receipts || [], terminated: state.terminated || [] };
  };

  /* -------------------------------------------------------------------- delivery --- */
  /* A leftover intent is swept on every tick, because a barrier that only exists in the process
   * that opened it would forget its promise the moment that process is replaced — which is exactly
   * the moment the promise matters. */
  async function sweepIntent(delivered) {
    const intent = store.read().intent;
    if (!intent) return;
    if (intent.phase === 'committing') {
      if (!intent.folder) return;
      let status, job;
      try { status = JSON.parse(fs.readFileSync(path.join(intent.folder, 'status.json'), 'utf8').replace(/^﻿/, '')); job = JSON.parse(fs.readFileSync(path.join(intent.folder, 'job.json'), 'utf8')); } catch { return; }
      if (status.state !== 'running') return;
      const owner = await probe();
      if (stopped) return;
      if (owner.path !== job.owner.path || owner.created === job.owner.created) return;
      const at = now();
      store.change(s => {
        if (s.intent?.id !== intent.id) return;
        Object.assign(s.intent, { phase: 'committed', delivery: { at, tasks: delivered }, updatedAt: at });
        s.intents ||= []; s.intents.push(s.intent);
        if (s.intents.length > INTENT_HISTORY_LIMIT) s.intents = s.intents.slice(-INTENT_HISTORY_LIMIT);
        s.intent = null; s.schema = 3;
      });
      return;
    }
    if (intent.phase !== 'preparing') return;
    if (intent.requesterPid !== pid) {
      const closed = finishIntent('restart_not_committed', 'interrupted');
      if (!closed) return;
      if (!closed.requesterSessionId) return;
      try { await deliverConversation(agents(), closed.requesterSessionId, { id: 'intent-interrupted:' + closed.id, prompt: INTERRUPTED_PROMPT(closed.id), modelSelection: closed.requesterModel }); }
      catch (error) { failures.record({ where: 'heartbeat/barrier-notice', code: error.code || 'notice_failed', message: String(error.message), fields: { intentId: closed.id } }); }
      return;
    }
    // An expired preparation is closed here so the next broadcast is not refused forever by an
    // intent nobody is going to commit.
    if (now() > intent.deadline) finishIntent('deadline_exceeded', 'aborted');
  }

  /* The same atomic sweep the committed delivery uses: one durable mutation consumes the
   * executable record and leaves a payload-free audit record behind. The record says the task is
   * terminal and carries the reason it was terminated, so "this armed task is over, and why" is
   * readable from the status instead of being inferred from a task that quietly stopped appearing. */
  function terminateTask(task, reason, attempts) {
    store.change(s => {
      s.terminated ||= [];
      if (!s.terminated.some(r => r.id === task.id)) s.terminated.push({ id: task.id, status: TERMINATED_STATUS, reason: String(reason).slice(0, 400), attempts, destination: task.destination, terminated: Date.now() });
      s.tasks = s.tasks.filter(t => t.id !== task.id);
      s.schema = 3;
    });
  }

  return {
    state: status, schedule, stop() { stopped = true; },
    prepare: targetVersion => controller.prepare(targetVersion),
    async restart(ticket, update = false) {
      const goalSnapshot = captureGoalSnapshot(update ? 'update' : 'immediate');
      const helper = await controller.restart(ticket);
      // kind:'update_report' tells NewMate this report was REQUESTED, so it is displayed instead of
    // being judged by the proactive-message format rule (240 chars, no lists) and dropped.
    const updateId = update ? schedule('Newmark2DSH 更新后 DSH 已重启。请确认组件状态，报告未完成的持久任务；不要自动重复失败动作。', 'newmate', undefined, { kind: 'update_report' }).id : null;
      // An UPDATE restart is issued by the panel or the update route, so there is no requesting
      // conversation to hand a continuation to — and until now NOTHING got one, which silently killed
      // work that was in flight: measured 2026-10-17, an update restart took the host down while this
      // conversation was mid-turn and it was never continued ("没有继续却中断重启了"). Register a
      // continuation for every conversation CONFIRMED to be running, using the same predicate the
      // broadcast uses (agent.status === 'running'), so an idle-but-loaded conversation is still not
      // woken. commit() arms them exactly as it arms a barrier's, and the new host delivers them.
      const continued = [];
      if (update) {
        for (const entry of liveAgents() || []) {
          if (!wokenByUpdate(entry)) continue;
          try { enqueue(CONTINUATION_PROMPT, entry.view.sessionId, entry.agent); continued.push(entry.view.sessionId); }
          catch (error) { failures.record({ where: 'heartbeat/update', code: error.code || 'continuation_failed', message: String(error.message), fields: { sessionId: entry.view.sessionId } }); }
        }
      }
      let finished = false;
      return {
        folder: helper.folder,
        continued,
        commit() {
          if (finished) return;
          store.change(s => { for (const t of s.tasks) if (t.status === 'waiting') Object.assign(t, { status: 'armed', restartPid:pid, folder: helper.folder }); });
          try { helper.commit(); finished = true; } catch (e) { store.change(s => { for (const t of s.tasks) if (t.folder === helper.folder) t.status = 'waiting'; }); helper.cancel(); throw e; }
        },
        cancel() { if (!finished) { finished = true; helper.cancel(); if (updateId) store.change(s => { s.tasks.find(t => t.id === updateId).status = 'cancelled'; }); } },
      };
    },
    async globalRestart() {
      // An open barrier is a promise to other conversations; an immediate restart would break it.
      const running = activeIntent();
      if (running) throw Error('已有一个进行中的两阶段重启准备（intentId=' + running.id + '），请先提交或等它结束');
      const prepared = await controller.prepare(installedVersion()); return this.restart(prepared.ticket);
    },
    /**
     * Restore THIS conversation's goal, in any host turn, and do nothing else.
     *
     * WHY A PLUGIN TOOL EXISTS FOR THIS. The host's own update_goal{action:"resume"} requires a direct
     * human turn (dsh-tool-goal requireDirectHuman), so an automatic continuation - which is exactly
     * what a restart delivers - can never re-arm a goal through it: measured live, the resumed
     * conversation hit "this goal operation requires a direct human turn on a top-level agent" every
     * time. The goal SERVICE has no such guard (the guard lives in the tool), so this component -
     * which already reads the service to leave paused conversations alone - can ask it directly.
     *
     * WHAT IT DELIBERATELY CANNOT DO. No objective, no round cap, no un-blocking, no other
     * conversation: identity comes from the authenticated execution, and the tool's arguments object
     * is empty and closed. blocked and complete are refused by name, because both are conclusions a
     * human reached; reviving them here would turn a decision into a side effect. The only mutation
     * this can cause is resume on a paused goal, or a re-arm of an active goal the host disarmed when
     * the session resumed.
     */
    async restoreGoal(execution) {
      const agent = execution?.agent ?? null;
      if (!agent || !agent.session?.id) {
        return { ok: false, code: 'agent_unavailable', action_taken: 'none', error: '没有可识别的调用方会话：本工具只恢复调用它的那个对话的目标。' };
      }
      const service = goals?.() ?? null;
      if (!service || typeof service.get !== 'function' || typeof service.resume !== 'function') {
        return { ok: false, code: 'goal_service_unavailable', action_taken: 'none', error: '宿主没有提供 goal 服务，无法恢复目标。' };
      }
      let current;
      try { current = service.get(agent); } catch (error) {
        return { ok: false, code: 'goal_read_failed', action_taken: 'none', error: String(error?.message || error) };
      }
      if (!current) return { ok: false, code: 'no_goal', action_taken: 'none', error: '这个对话没有目标，没有可恢复的东西。' };
      const facts = { id: current.id, phase: current.phase, activation: current.activation, rounds_started: current.roundsStarted };
      if (current.phase === 'blocked') {
        return { ok: false, code: 'goal_blocked', action_taken: 'none', goal: facts, error: '目标已被阻断：阻断是一个结论，本工具不解除它，也不重启它。' };
      }
      if (current.phase === 'complete') {
        return { ok: false, code: 'goal_complete', action_taken: 'none', goal: facts, error: '目标已经完成，没有可恢复的东西。' };
      }
      const paused = current.phase === 'paused';
      const disarmed = current.phase === 'active' && current.activation === 'disarmed';
      if (!paused && !disarmed) {
        return { ok: true, code: 'not_restorable', changed: false, action_taken: 'none', goal: facts, note: '目标既没有暂停、也没有被解除武装，未做任何改动。' };
      }
      const ref = { id: current.id, revision: current.revision };
      try { service.resume(agent, ref); } catch (error) {
        return { ok: false, code: 'resume_failed', action_taken: 'resume', goal: facts, error: String(error?.message || error) };
      }
      let after = null;
      try { after = service.get(agent); } catch { after = null; }
      const verified = Boolean(after && after.id === current.id && after.phase === 'active');
      return {
        ok: verified,
        code: verified ? (paused ? 'restored' : 'rearmed') : 'resume_unverified',
        changed: true,
        action_taken: 'resume',
        mode: paused ? 'paused_goal_resumed' : 'disarmed_goal_rearmed',
        before: facts,
        after: after ? { id: after.id, phase: after.phase, activation: after.activation, rounds_started: after.roundsStarted } : null,
        verified,
        note: verified ? '目标已恢复运行；本工具没有改写目标，也没有解除任何阻断。' : 'resume 已调用，但读回的状态仍不是 active——如实报告，不当作成功。',
      };
    },
    activity,
    beginBarrier, commitBarrier, cancelBarrier, acknowledge, barrierState,
    async tick() {
      if (pumping || stopped) return; pumping = true;
      const delivered = [];
      /* BEFORE delivering anything: re-arm the goals that were running when we went down. The
       * continuation a conversation receives may tell it to work, but the host will not continue a
       * goal round on its own until the goal is armed again, and no model turn can arm it. */
      try { restoreGoalSnapshot(); } catch (error) { failures.record({ where: 'heartbeat/goal-restore', code: 'restore_failed', message: String(error?.message || error) }); }
      try {
        /* Adopted continuations have no restart helper behind them: this boot IS the new process.
         * Deliver once, then consume the record; a failure is counted like any other and the task is
         * terminated after DELIVERY_FAILURE_LIMIT so a destination that can never be resumed does not
         * retry for the life of the machine. */
        for (const task of store.read().tasks.filter(t => t.status === 'armed' && !t.folder)) {
          try {
            if (task.destination === 'newmate') {
              if (!core()?.newMate) continue;
              core().newMate.enqueue(task.prompt, 'newmate', task.id, undefined, task.kind ? { kind: task.kind } : undefined);
            } else await deliverConversation(agents(), task.destination, task);
            delivered.push(task.id);
            store.change(s => { s.receipts ||= []; if (!s.receipts.some(r => r.id === task.id)) s.receipts.push({ id: task.id, delivered: Date.now(), adopted: true }); s.tasks = s.tasks.filter(t => t.id !== task.id); s.schema = 3; });
          } catch (error) {
            const attempts = (task.failures || 0) + 1;
            if (attempts >= DELIVERY_FAILURE_LIMIT) { terminateTask(task, String(error?.message ?? error), attempts); continue; }
            store.change(s => { const target = s.tasks.find(t => t.id === task.id); if (target) { target.error = String(error?.message ?? error); target.failures = attempts; } s.schema = 3; });
          }
        }
        for (const task of store.read().tasks.filter(t => t.status === 'armed' && t.restartPid !== pid)) {
          /* One FAILED delivery attempt, counted in the durable record. At DELIVERY_FAILURE_LIMIT the
           * task is terminated instead of retried: either the restart happened and the delivery keeps
           * failing, or the helper reported failure and no restart is coming. A task that is merely
           * WAITING — helper not yet running, owner unchanged, companion target switched off — is not
           * counted, because waiting is not failing. */
          const fail = error => {
            const reason = String(error?.message ?? error);
            const attempts = (task.failures || 0) + 1;
            if (task.error !== reason) failures.record({ where: 'heartbeat/delivery', code: error?.code || 'delivery_failed', message: reason, fields: { taskId: task.id, attempt: attempts, limit: DELIVERY_FAILURE_LIMIT } });
            if (attempts >= DELIVERY_FAILURE_LIMIT) { terminateTask(task, reason, attempts); return; }
            store.change(s => { const target = s.tasks.find(t => t.id === task.id); if (!target) return; target.error = reason; target.failures = attempts; s.schema = 3; });
          };
          try {
            const status = JSON.parse(fs.readFileSync(path.join(task.folder, 'status.json'), 'utf8').replace(/^﻿/, ''));
            // The helper's own terminal failure: it will never report the new process, so this task
            // can never be delivered. That is a failure, not a wait — and it is the measured
            // production case (state:"failed", detail:"DSH exited during startup").
            if (status.state === 'failed') { fail(Error(status.detail || '重启辅助程序报告失败')); continue; }
            if (status.state !== 'running') continue;
            const job = JSON.parse(fs.readFileSync(path.join(task.folder, 'job.json'), 'utf8'));
            const owner = await probe();
            if (stopped) return;
            if (owner.path !== job.owner.path || owner.created === job.owner.created) continue;
            if (task.destination === 'newmate') {
              if (!core()?.newMate) continue;
              core().newMate.enqueue(task.prompt, 'newmate', task.id, undefined, task.kind ? { kind: task.kind } : undefined);
            } else await deliverConversation(agents(), task.destination, task);
            delivered.push(task.id);
            // One atomic durable mutation consumes the executable record and leaves only its ID.
            store.change(s => {s.receipts ||= [];if(!s.receipts.some(r=>r.id===task.id))s.receipts.push({id:task.id,delivered:Date.now()});s.tasks=s.tasks.filter(t=>t.id!==task.id);s.schema=3;});
          } catch (error) {
            fail(error);
          }
        }
        await sweepIntent(delivered);
      } finally { pumping = false; }
    },
  };
}
