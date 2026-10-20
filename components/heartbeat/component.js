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
// So the continuation has to restore the goal's own state rather than assume it — read it, then
// re-arm exactly the ones that were active, and leave a paused goal paused.
const CONTINUATION_PROMPT = 'Newmark2DSH 已重启。先恢复这个对话的目标状态：读 get_goal；若 phase:"active" 且 activation:"disarmed"（会话恢复后宿主会把进行中的目标解除武装），调用 update_goal{action:"resume"} 重新武装；若 phase:"paused" 保持暂停，不要 resume；没有 goal 则跳过。然后从上一句用户消息继续；不要重复已经完成的动作，未完成的工作先说明状态。';
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

export function createHeartBeat({ root, core, agents, goals = () => null, controller = createRestartController(root), probe = probeDesktop, pid = process.pid, version, logger, now = Date.now }) {
  const failures = createErrorLog({root,logger});
  const store = durableState(path.join(root, 'heartBeat', 'state.json'), { schema: 3, tasks: [], receipts: [], terminated: [], intent: null, intents: [] });
  // Retire the previous delivered marker into a permanent consumption receipt.
  if(store.read().tasks.some(t=>t.status==='delivered')) store.change(s=>{s.receipts ||= [];for(const t of s.tasks.filter(t=>t.status==='delivered'))if(!s.receipts.some(r=>r.id===t.id))s.receipts.push({id:t.id,delivered:t.delivered||Date.now()});s.tasks=s.tasks.filter(t=>t.status!=='delivered');s.schema=3;});
  let pumping = false, stopped = false;

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

  /* ------------------------------------------------------------------------- tasks --- */
  const enqueue = (prompt, destination, agent) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw Error('重启任务须为 1–16000 字符');
    if (typeof destination !== 'string' || !destination) throw Error('重启任务需要目标对话');
    const modelSelection=conversationModel(agent);
    const id = randomUUID(); store.change(s => { if(s.tasks.length >= 2000) throw Error('heartBeat 任务队列已达容量上限'); s.tasks.push({ id, prompt, destination, status: 'waiting', created: Date.now(), creatorPid: pid,...modelSelection?{modelSelection}:{} }); }); return { ok: true, id, destination };
  };
  const schedule = (prompt, destination, execution, options = {}) => {
    if (execution) destination = currentConversation(execution);
    const registered = enqueue(prompt, destination, execution?.agent);
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
    try {
      prepared = await controller.prepare(version);
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
      const helper = await controller.restart(ticket);
      const updateId = update ? schedule('Newmark2DSH 更新后 DSH 已重启。请确认组件状态，报告未完成的持久任务；不要自动重复失败动作。', 'newmate').id : null;
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
      const prepared = await controller.prepare(version); return this.restart(prepared.ticket);
    },
    beginBarrier, commitBarrier, cancelBarrier, acknowledge, barrierState,
    async tick() {
      if (pumping || stopped) return; pumping = true;
      const delivered = [];
      try {
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
              core().newMate.enqueue(task.prompt, 'newmate', task.id);
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
