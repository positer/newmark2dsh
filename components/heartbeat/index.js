import fs from 'node:fs';
import { createHeartBeat } from './component.js';
import { resolveRoot } from '../../lib/root.js';
import { embedJson } from '../../lib/embed.js';
import { currentConversation } from '../../lib/conversation-delivery.js';
export const name = 'newmark-heartbeat';
export const inject = ['tools', 'webServer'];
export const SNAPSHOT_GLOBAL = '__NEWMARK_HEARTBEAT__';
export function apply(ctx, config) {
  const core = ctx.get?.('newmarkComponents');
  const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const beat = createHeartBeat({ root: resolveRoot(config), core: () => core, agents: () => ctx.get?.('agents'), goals: () => ctx.get?.('goals'), version, logger:ctx.logger });
  if (core) core.heartBeat = beat;
  ctx.effect(() => () => { beat.stop(); if (core?.heartBeat === beat) delete core.heartBeat; }, 'heartbeat-bridge');
  ctx.effect(() => { const timer = setInterval(() => beat.tick().catch(e => ctx.logger?.warn?.(e.message)), 2000); timer.unref?.(); return () => clearInterval(timer); }, 'heartbeat-delivery');
  const output = { schema: { type: 'object' }, render: (_, v) => [{ type: 'text', text: JSON.stringify(v) }] };
  /* The commit is scheduled rather than performed inline so the tool result reaches the caller
   * before an independent helper stops this process. The timer is an effect, so a host that tears
   * the component down before the helper is ready cancels the restart instead of leaving an
   * orphaned helper waiting for a 'go' file that no one will write. */
  const commitAfterResponse = (helper, label) => ctx.effect(() => {
    const timer = setTimeout(() => { try { helper.commit(); } catch (e) { ctx.logger?.warn?.(e.message); } }, 1500); timer.unref?.();
    return () => { clearTimeout(timer); helper.cancel(); };
  }, label);
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_after_restart', description: '目标不需要手动设置：本组件在重启前记录所有活动对话的目标状态，重启后自动恢复当时 active 的目标；只有自动恢复没成功而 get_goal 仍显示 active+disarmed 时，才用 goal_restore 补一次。不要用原生 create_goal 或 update_goal 去做这件事——自动续跑轮里它们必被拒（requires a direct human turn on a top-level agent），而且它们能改写目标、goal_restore 不能。 Register a durable post-restart task for this conversation only. Target identity is taken from the host, never from arguments. Pass intentId to make the same call this conversation\'s continuation receipt for an open two-phase restart.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 16000 }, intentId: { type: 'string', maxLength: 100 } }, required: ['prompt'], additionalProperties: false }, output,
    execute: (a, e) => beat.schedule(a.prompt, currentConversation(e), e, { intentId: a.intentId }),
  }), 'heartbeat-task-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_activity', description: '目标不需要手动设置：本组件在重启前记录所有活动对话的目标状态，重启后自动恢复当时 active 的目标（heartbeat_activity 的 goal_restore 回执）；只有自动恢复没成功、而 get_goal 仍显示 paused 或 active+disarmed 时，才调用 goal_restore 补一次。不要用原生 create_goal 或 update_goal 做恢复——自动续跑轮里它们必被拒（requires a direct human turn on a top-level agent），而且它们能改写目标、goal_restore 不能。 Read-only: which OTHER conversations are running right now. Call it before deciding how to restart — heartbeat_restart refuses to restart until it has reported this, so use it to decide between force:true (nobody else is running, or you accept interrupting them) and broadcast:true (wait for every running conversation to register its continuation).',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    execute: (a, e) => beat.activity(e),
  }), 'heartbeat-activity-tool');
  /*
   * The one tool that may restore a goal from a turn the host does not consider human.
   *
   * Its arguments object is EMPTY and closed on purpose: there is nothing to pass, so there is
   * nothing to rewrite. The identity is the authenticated execution, so it cannot reach another
   * conversation's goal. See beat.restoreGoal for what it refuses (blocked, complete, everything
   * that is not a pause).
   */
  ctx.effect(() => ctx.tools.register({ name: 'goal_restore', description: 'Restore THIS conversation\'s goal and nothing else: resume a PAUSED goal, or re-arm an ACTIVE goal the host disarmed when the session resumed. Works in any host turn, including an automatic continuation where the host\'s own update_goal{action:"resume"} is refused ("requires a direct human turn on a top-level agent"). It takes no arguments: it cannot rewrite the objective, change the round cap, un-block a BLOCKED goal, revive a COMPLETE one, or touch another conversation - those all answer with their own code (goal_blocked / goal_complete / no_goal / not_restorable). Call this instead of create_goal or update_goal whenever the job is \'the goal stopped and should run again\'.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    execute: (a, e) => beat.restoreGoal(e),
  }), 'heartbeat-goal-restore-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart', description: '目标不需要手动设置：本组件在重启前记录所有活动对话的目标状态，重启后自动恢复当时 active 的目标（heartbeat_activity 的 goal_restore 回执）；只有自动恢复没成功、而 get_goal 仍显示 paused 或 active+disarmed 时，才调用 goal_restore 补一次。不要用原生 create_goal 或 update_goal 做恢复——自动续跑轮里它们必被拒（requires a direct human turn on a top-level agent），而且它们能改写目标、goal_restore 不能。 Request a global DSH restart. IMPORTANT: the first call does NOT restart — it returns { code:"confirmation_required", activity } listing the OTHER conversations running right now, and you then decide: call again with force:true to restart now (interrupting them), or with broadcast:true to open the two-phase barrier and wait for every running conversation to register its continuation. With broadcast=false and force=false nothing restarts and previously registered tasks are delivered once the new desktop host is ready. With broadcast=true this only OPENS a two-phase restart: every running conversation is told to register a continuation, the call returns phase "preparing" with the participants, and nothing restarts until heartbeat_restart_commit is called and the receipts are in.',
    parameters: { type: 'object', properties: {
      broadcast: { type: 'boolean', description: 'true opens the two-phase barrier instead of restarting now.' },
      ackMode: { type: 'string', enum: ['auto', 'agent'], description: "auto (default) registers a continuation for every running conversation without spending a model call; agent delivers a notification into each conversation and waits for that conversation's own heartbeat_after_restart or heartbeat_restart_ack." },
      ackTimeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: 'How long the barrier waits for receipts before the onTimeout policy applies. Default 90000.' },
      onTimeout: { type: 'string', enum: ['abort', 'proceed'], description: "abort (default) refuses the restart and names the conversations that never answered; proceed restarts anyway and records them." },
      force: { type: 'boolean', description: 'Skip the barrier checks for this intent. The intent records that it was forced.' },
      reason: { type: 'string', maxLength: 200, description: 'Why this restart is being requested, recorded with the intent.' },
    }, additionalProperties: false }, output,
    async execute(a, execution) {
      currentConversation(execution);
      if (a.broadcast !== true) {
        /**
         * Probe FIRST, always. A plain restart used to go straight to globalRestart(), so the
         * caller could interrupt another conversation's turn without ever being told there was
         * one. The first call now reports who else is running and does NOT restart; the caller
         * then either forces it or opens the broadcast barrier.
         */
        const probe = beat.activity(execution);
        if (a.force !== true) {
          const others = probe.ok ? probe.count : null;
          return {
            ok: false,
            code: probe.ok ? 'confirmation_required' : 'activity_unavailable',
            restarted: false,
            activity: probe,
            next: probe.ok
              ? [
                  { call: 'heartbeat_restart', arguments: { force: true }, when: others === 0 ? '没有其他对话在运行，可以直接强制重启' : '确认可以打断上面列出的 ' + others + ' 个运行中对话' },
                  { call: 'heartbeat_restart', arguments: { broadcast: true }, when: '不想打断它们：发起广播，等每个对话登记接续后由 heartbeat_restart_commit 收尾' },
                ]
              : [],
            guidance: probe.ok
              ? '先看 activity：count>0 表示还有别的对话在跑。强制重启会打断它们；广播会等它们各自登记接续再重启。'
              : '无法确认是否有其他对话在运行（agents 服务不可用）。要重启必须显式 force:true，并自行承担打断的风险。',
          };
        }
        const helper = await beat.globalRestart();
        commitAfterResponse(helper, 'heartbeat-confirmed-restart');
        return { ok: true, restarting: true, forced: true, activity: probe };
      }
      return beat.beginBarrier(a, execution);
    },
  }), 'heartbeat-restart-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart_commit', description: '目标不需要手动设置：本组件在重启前记录所有活动对话的目标状态，重启后自动恢复当时 active 的目标（heartbeat_activity 的 goal_restore 回执）；只有自动恢复没成功、而 get_goal 仍显示 paused 或 active+disarmed 时，才调用 goal_restore 补一次。不要用原生 create_goal 或 update_goal 做恢复——自动续跑轮里它们必被拒（requires a direct human turn on a top-level agent），而且它们能改写目标、goal_restore 不能。 Commit an open two-phase restart opened by heartbeat_restart {broadcast:true}. Waits for the receipts; only when every participant is finished and this conversation has registered its own continuation does it launch the restart and return phase "committed". Otherwise it returns phase "aborted" with the reason and the named conversations that never answered, and the host keeps running. Only the conversation that opened the intent may commit it.',
    parameters: { type: 'object', properties: { intentId: { type: 'string', maxLength: 100 }, force: { type: 'boolean', description: 'Skip the receipt checks for this commit; the intent records the conversations that were still missing.' } }, required: ['intentId'], additionalProperties: false }, output,
    async execute(a, execution) {
      const result = await beat.commitBarrier(a, execution);
      if (!result.ok) return result;
      commitAfterResponse(result.helper, 'heartbeat-barrier-commit');
      return { ok: true, phase: result.phase, intentId: result.intentId, acks: result.acks, missing: result.missing };
    },
  }), 'heartbeat-barrier-commit-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart_cancel', description: '目标不需要手动设置：本组件在重启前记录所有活动对话的目标状态，重启后自动恢复当时 active 的目标（heartbeat_activity 的 goal_restore 回执）；只有自动恢复没成功、而 get_goal 仍显示 paused 或 active+disarmed 时，才调用 goal_restore 补一次。不要用原生 create_goal 或 update_goal 做恢复——自动续跑轮里它们必被拒（requires a direct human turn on a top-level agent），而且它们能改写目标、goal_restore 不能。 Cancel an open two-phase restart opened by heartbeat_restart {broadcast:true}, without restarting. ONE state transition: preparing -> aborted(reason "cancelled"), plus a durable notice to the requester. The cancelled intent can never be committed afterwards and the barrier is free to be re-opened. Only the conversation that opened the intent may cancel it, and only while it is still preparing — once committing the restart helper is already launched and the intent is no longer a promise that can be withdrawn. A refusal is a named code: not_requester, unknown_intent, not_preparing.',
    parameters: { type: 'object', properties: { intentId: { type: 'string', maxLength: 100 } }, required: ['intentId'], additionalProperties: false }, output,
    execute: (a, execution) => beat.cancelBarrier(a, execution),
  }), 'heartbeat-barrier-cancel-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart_ack', description: '目标不需要手动设置：本组件在重启前记录所有活动对话的目标状态，重启后自动恢复当时 active 的目标（heartbeat_activity 的 goal_restore 回执）；只有自动恢复没成功、而 get_goal 仍显示 paused 或 active+disarmed 时，才调用 goal_restore 补一次。不要用原生 create_goal 或 update_goal 做恢复——自动续跑轮里它们必被拒（requires a direct human turn on a top-level agent），而且它们能改写目标、goal_restore 不能。 Give this conversation\'s own continuation receipt for an open two-phase restart. The receipt is attributed to the conversation that calls it, from the host session identity, so one conversation can never answer for another. continuation "registered" means this conversation already has a post-restart continuation; "none" declares that it needs none.',
    parameters: { type: 'object', properties: { intentId: { type: 'string', maxLength: 100 }, continuation: { type: 'string', enum: ['registered', 'none'] } }, required: ['intentId', 'continuation'], additionalProperties: false }, output,
    execute: (a, execution) => beat.acknowledge(a, execution),
  }), 'heartbeat-barrier-ack-tool');
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', `<script>window.${SNAPSHOT_GLOBAL}=${embedJson({ ok: true })};</script></head>`)), 'heartbeat-presence');
}
