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
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_after_restart', description: 'Register a durable post-restart task for this conversation only. Target identity is taken from the host, never from arguments. Pass intentId to make the same call this conversation\'s continuation receipt for an open two-phase restart.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 16000 }, intentId: { type: 'string', maxLength: 100 } }, required: ['prompt'], additionalProperties: false }, output,
    execute: (a, e) => beat.schedule(a.prompt, currentConversation(e), e, { intentId: a.intentId }),
  }), 'heartbeat-task-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart', description: 'Request a global DSH restart. With broadcast=false (default) the restart happens immediately and previously registered tasks are delivered once the new desktop host is ready. With broadcast=true this only OPENS a two-phase restart: every running conversation is told to register a continuation, the call returns phase "preparing" with the participants, and nothing restarts until heartbeat_restart_commit is called and the receipts are in.',
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
        const helper = await beat.globalRestart();
        commitAfterResponse(helper, 'heartbeat-confirmed-restart');
        return { ok: true, restarting: true };
      }
      return beat.beginBarrier(a, execution);
    },
  }), 'heartbeat-restart-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart_commit', description: 'Commit an open two-phase restart opened by heartbeat_restart {broadcast:true}. Waits for the receipts; only when every participant is finished and this conversation has registered its own continuation does it launch the restart and return phase "committed". Otherwise it returns phase "aborted" with the reason and the named conversations that never answered, and the host keeps running. Only the conversation that opened the intent may commit it.',
    parameters: { type: 'object', properties: { intentId: { type: 'string', maxLength: 100 }, force: { type: 'boolean', description: 'Skip the receipt checks for this commit; the intent records the conversations that were still missing.' } }, required: ['intentId'], additionalProperties: false }, output,
    async execute(a, execution) {
      const result = await beat.commitBarrier(a, execution);
      if (!result.ok) return result;
      commitAfterResponse(result.helper, 'heartbeat-barrier-commit');
      return { ok: true, phase: result.phase, intentId: result.intentId, acks: result.acks, missing: result.missing };
    },
  }), 'heartbeat-barrier-commit-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart_cancel', description: 'Cancel an open two-phase restart opened by heartbeat_restart {broadcast:true}, without restarting. ONE state transition: preparing -> aborted(reason "cancelled"), plus a durable notice to the requester. The cancelled intent can never be committed afterwards and the barrier is free to be re-opened. Only the conversation that opened the intent may cancel it, and only while it is still preparing — once committing the restart helper is already launched and the intent is no longer a promise that can be withdrawn. A refusal is a named code: not_requester, unknown_intent, not_preparing.',
    parameters: { type: 'object', properties: { intentId: { type: 'string', maxLength: 100 } }, required: ['intentId'], additionalProperties: false }, output,
    execute: (a, execution) => beat.cancelBarrier(a, execution),
  }), 'heartbeat-barrier-cancel-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart_ack', description: 'Give this conversation\'s own continuation receipt for an open two-phase restart. The receipt is attributed to the conversation that calls it, from the host session identity, so one conversation can never answer for another. continuation "registered" means this conversation already has a post-restart continuation; "none" declares that it needs none.',
    parameters: { type: 'object', properties: { intentId: { type: 'string', maxLength: 100 }, continuation: { type: 'string', enum: ['registered', 'none'] } }, required: ['intentId', 'continuation'], additionalProperties: false }, output,
    execute: (a, execution) => beat.acknowledge(a, execution),
  }), 'heartbeat-barrier-ack-tool');
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', `<script>window.${SNAPSHOT_GLOBAL}=${embedJson({ ok: true })};</script></head>`)), 'heartbeat-presence');
}
