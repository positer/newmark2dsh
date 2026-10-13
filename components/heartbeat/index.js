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
  const beat = createHeartBeat({ root: resolveRoot(config), core: () => core, agents: () => ctx.get?.('agents'), version, logger:ctx.logger });
  if (core) core.heartBeat = beat;
  ctx.effect(() => () => { beat.stop(); if (core?.heartBeat === beat) delete core.heartBeat; }, 'heartbeat-bridge');
  ctx.effect(() => { const timer = setInterval(() => beat.tick().catch(e => ctx.logger?.warn?.(e.message)), 2000); timer.unref?.(); return () => clearInterval(timer); }, 'heartbeat-delivery');
  const output = { schema: { type: 'object' }, render: (_, v) => [{ type: 'text', text: JSON.stringify(v) }] };
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_after_restart', description: 'Register a durable post-restart task for this conversation only. Target identity is taken from the host, never from arguments.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 16000 } }, required: ['prompt'], additionalProperties: false }, output,
    execute: (a, e) => beat.schedule(a.prompt, currentConversation(e),e),
  }), 'heartbeat-task-tool');
  ctx.effect(() => ctx.tools.register({ name: 'heartbeat_restart', description: 'Request global DSH restart. Previously registered tasks will be delivered only after the new desktop host is ready.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    async execute(_, execution) {
      currentConversation(execution);
      const helper = await beat.globalRestart();
      // Complete the tool result before the independent helper stops this process.
      ctx.effect(() => {
        const timer = setTimeout(() => { try { helper.commit(); } catch (e) { ctx.logger?.warn?.(e.message); } }, 1500); timer.unref?.();
        return () => { clearTimeout(timer); helper.cancel(); };
      }, 'heartbeat-confirmed-restart');
      return { ok: true, restarting: true };
    },
  }), 'heartbeat-restart-tool');
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', `<script>window.${SNAPSHOT_GLOBAL}=${embedJson({ ok: true })};</script></head>`)), 'heartbeat-presence');
}
