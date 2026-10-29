/**
 * The live half of a NewMate run.
 *
 * A NewMate reply is produced by a run this bundle drives itself: agent-api's own agent loop.
 * Until this module existed the loop was invisible while it ran — `interaction()` could say
 * `running: true` and that was the whole answer, so a companion using ComputerUse was a cursor
 * moving with no legible progress behind it. The receipt agent-api returns carries the event
 * log, and it arrives at the END, which is exactly when a reader no longer needs it.
 *
 * So the same bounded event view agent-api puts in its receipt is handed to this recorder as
 * each event happens (`components/agent-api/component.js` publishes it through the NewMate
 * context), and this module keeps a snapshot of the run in flight: phase, model turn, completed
 * tool calls, the tool currently executing, elapsed time, the stop reason and the last events.
 * `snapshot()` is what `newmate_state`, GET /newmark-newmate, the MCP `newmate_task_status`
 * and the NewMate page read, so all four surfaces report the same facts from one place.
 *
 * ## What this module is not
 *
 * It runs nothing, dispatches nothing and decides nothing. It is a view over events that already
 * happened, and a reader can only see what the loop itself reported. It never persists: a
 * restart loses it, which is correct, because "what a run is doing right now" is not a durable
 * fact. The last finished run stays readable until the next one starts, so a caller that polls
 * one second too late still gets the outcome instead of an empty answer.
 *
 * ## Why the bounds live here
 *
 * The snapshot is returned by tools and by a route the page polls every two seconds, and it is
 * built from loop events whose text fields agent-api already truncates at 240 characters. A long
 * run can still produce hundreds of events, so the recorder keeps the most recent
 * LOOP_EVENT_LIMIT within LOOP_EVENT_CHARS and reports `dropped` — the same discipline the run
 * receipt uses: a short list says what it left out instead of looking complete.
 */

/** How many recent events one snapshot keeps, and the characters they may spend together. */
export const LOOP_EVENT_LIMIT = 24;
export const LOOP_EVENT_CHARS = 6000;

/** One event's text field. agent-api's view is already bounded; this is the second bound. */
const TEXT_LIMIT = 200;

/**
 * How much of one thought segment the TIMELINE keeps.
 *
 * A thought is a segment of the run, not a single event: the seam republishes the accumulating
 * reasoning while it streams, and the page needs those republications to land in the same place
 * in the timeline, in the order the model produced them. So the recorder keeps ONE ring entry per
 * thought segment and replaces its text as it grows, capped here so a long thought cannot crowd
 * out the tool events that came before it.
 */
export const THINKING_SEGMENT_CHARS = 1200;

function text(value) {
  if (value === undefined || value === null) return null;
  const raw = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value); } catch { return ''; }
  })();
  if (!raw) return null;
  return raw.length > TEXT_LIMIT ? `${raw.slice(0, TEXT_LIMIT)}…(+${raw.length - TEXT_LIMIT})` : raw;
}

/** The one line a reader needs from an event, per type. Never undefined, never unbounded. */
function summary(view) {
  const type = String(view?.type ?? '');
  if (type === 'tool_execution_start') return text(view?.arguments);
  if (type === 'tool_execution_end') return view?.is_error === true ? text(view?.error ?? view?.code ?? 'failed') : text(view?.result);
  if (type === 'thinking') {
    const raw = typeof view?.text === 'string' ? view.text : '';
    return raw.length > THINKING_SEGMENT_CHARS ? `…(+${raw.length - THINKING_SEGMENT_CHARS} chars)\n${raw.slice(-THINKING_SEGMENT_CHARS)}` : raw;
  }
  if (type === 'turn_end') return `${Number(view?.tool_results) || 0} results, ${Number(view?.errors) || 0} errors`;
  if (type === 'agent_end') return text(view?.stop_reason);
  return null;
}

/**
 * Create one recorder.
 *
 * @param now - the clock, so a gate can drive elapsed time instead of sleeping.
 */
export function createLoopStatus(now = Date.now) {
  let active = null;
  let last = null;
  let sequence = 0;

  const fresh = (task) => ({
    runId: String(task?.id ?? ''),
    kind: String(task?.kind ?? 'chat'),
    startedAt: now(),
    finishedAt: null,
    phase: 'starting',
    turns: 0,
    toolCalls: 0,
    currentTool: null,
    stopReason: null,
    error: null,
    events: [],
    dropped: 0,
    chars: 0,
    /** The model's own reasoning while the turn streams; live-only, replaced as it grows. */
    thinking: { text: '', at: null, truncated: false },
    used: new Set(),
    cleanup: { attempted: false, at: null },
  });

  function keep(run, view) {
    const record = {
      seq: ++sequence,
      at: now(),
      type: String(view?.type ?? ''),
      turn: Number.isFinite(view?.turn) ? view.turn : null,
      tool: typeof view?.tool === 'string' ? view.tool : null,
      call_id: typeof view?.call_id === 'string' ? view.call_id : null,
      is_error: view?.is_error === true,
      text: summary(view),
    };
    const size = JSON.stringify(record).length;
    while (run.events.length > 0 && (run.events.length >= LOOP_EVENT_LIMIT || run.chars + size > LOOP_EVENT_CHARS)) {
      run.chars -= JSON.stringify(run.events.shift()).length;
      run.dropped += 1;
    }
    if (run.events.length >= LOOP_EVENT_LIMIT || run.chars + size > LOOP_EVENT_CHARS) {
      run.dropped += 1;
      return;
    }
    run.events.push(record);
    run.chars += size;
  }

  /** Drop the OLDEST entries until the ring is back inside both bounds. Never drops the last. */
  function trimBudget(run) {
    while (run.events.length > 1 && (run.events.length > LOOP_EVENT_LIMIT || run.chars > LOOP_EVENT_CHARS)) {
      run.chars -= JSON.stringify(run.events.shift()).length;
      run.dropped += 1;
    }
  }

  function shape(run, running) {
    if (!run) {
      return {
        running: false, phase: 'idle', runId: null, kind: null,
        startedAt: null, finishedAt: null, elapsedMs: 0,
        turns: 0, toolCalls: 0, currentTool: null,
        stopReason: null, error: null, events: [], dropped: 0,
        thinking: { text: '', at: null, truncated: false },
        cleanup: { attempted: false, at: null },
      };
    }
    return {
      running,
      phase: run.phase,
      runId: run.runId || null,
      kind: run.kind,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      elapsedMs: Math.max(0, (run.finishedAt ?? now()) - run.startedAt),
      turns: run.turns,
      toolCalls: run.toolCalls,
      currentTool: run.currentTool,
      stopReason: run.stopReason,
      error: run.error,
      events: run.events.map((event) => ({ ...event })),
      dropped: run.dropped,
      thinking: { ...run.thinking },
      cleanup: { ...run.cleanup },
    };
  }

  return {
    /** Begin recording one run. The previous finished snapshot is replaced, not merged. */
    start(task) {
      active = fresh(task);
      last = null;
    },
    /** One loop event, exactly as agent-api's receipt view carries it. Ignored outside a run. */
    event(view) {
      if (!active) return;
      const type = String(view?.type ?? '');
      if (type === 'thinking') {
        /**
         * A THOUGHT IS A TIMELINE SEGMENT, not a value that lives outside the ring.
         *
         * The page must show thoughts and tool calls in the order the model produced them, so
         * the newest republication either extends the segment already at the end of the ring
         * (the seam is still streaming the same thought) or starts a new segment after whatever
         * happened in between. ONE entry per segment: a republication replaces its text instead
         * of appending a second row, which is what keeps the 24-event bound meaningful while the
         * stream keeps refreshing. The latest whole segment also stays available as `thinking`
         * for the status line. The truncation marker is carried through rather than stripped,
         * because a view that silently showed the tail would look like the whole thought.
         */
        const newest = typeof view?.text === 'string' ? view.text : '';
        if (!newest) return;
        active.thinking = { text: newest, at: now(), truncated: /…\(\+\d+ chars\)/.test(newest) };
        const previous = active.events[active.events.length - 1];
        if (previous && previous.type === 'thinking') {
          active.chars -= JSON.stringify(previous).length;
          previous.text = summary(view);
          previous.at = now();
          previous.turn = active.turns;
          active.chars += JSON.stringify(previous).length;
          trimBudget(active);
          return;
        }
        keep(active, { type: 'thinking', turn: active.turns, text: newest });
        return;
      }
      if (type === 'agent_start') active.phase = 'model';
      else if (type === 'turn_start') {
        active.phase = 'model';
        if (Number.isFinite(view?.turn)) active.turns = Math.max(active.turns, view.turn);
      } else if (type === 'tool_execution_start') {
        active.phase = 'tool';
        active.currentTool = typeof view?.tool === 'string' ? view.tool : null;
        if (view?.tool === 'computer_use') active.used.add('computer_use');
      } else if (type === 'tool_execution_end') {
        active.toolCalls += 1;
        active.currentTool = null;
        active.phase = 'model';
      } else if (type === 'agent_end') {
        active.phase = 'finishing';
        active.stopReason = typeof view?.stop_reason === 'string' ? view.stop_reason : null;
      }
      keep(active, view);
    },
    /** Whether this run called a named tool. Read by the ComputerUse lease release. */
    used(name) {
      return Boolean(active && active.used.has(name));
    },
    /** A phase that is not derivable from an event (e.g. 'releasing' around lease cleanup). */
    note(phase) {
      if (active) active.phase = String(phase);
    },
    /** Record that the release path ran, whichever way the release itself answered. */
    cleaned() {
      if (!active) return;
      active.cleanup.attempted = true;
      active.cleanup.at = now();
    },
    /**
     * Settle the run. `phase` is the durable task's own outcome ('done' | 'failed' | 'paused' |
     * 'interrupted' | 'superseded'), so the live view cannot claim a success the task record denies.
     */
    finish({ phase, error = null } = {}) {
      if (!active) return;
      active.finishedAt = now();
      active.phase = String(phase || 'done');
      active.error = error === null || error === undefined ? null : String(error);
      last = active;
      active = null;
    },
    /** The snapshot every surface reads. Always lossless JSON: no undefined values. */
    snapshot() {
      return shape(active || last, Boolean(active));
    },
  };
}
