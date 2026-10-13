import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableState } from '../../lib/durable-state.js';
import { createRestartController, probeDesktop } from '../../lib/core-restart.js';
import { currentConversation, deliverConversation, conversationModel } from '../../lib/conversation-delivery.js';
import { createErrorLog } from '../../lib/errors.js';

export function createHeartBeat({ root, core, agents, controller = createRestartController(root), probe = probeDesktop, pid = process.pid, version, logger }) {
  const failures = createErrorLog({root,logger});
  const store = durableState(path.join(root, 'heartBeat', 'state.json'), { schema: 2, tasks: [], receipts: [] });
  // Retire the previous delivered marker into a permanent consumption receipt.
  if(store.read().tasks.some(t=>t.status==='delivered')) store.change(s=>{s.receipts ||= [];for(const t of s.tasks.filter(t=>t.status==='delivered'))if(!s.receipts.some(r=>r.id===t.id))s.receipts.push({id:t.id,delivered:t.delivered||Date.now()});s.tasks=s.tasks.filter(t=>t.status!=='delivered');s.schema=2;});
  let pumping = false, stopped = false;
  const schedule = (prompt, destination, execution) => {
    if (execution) destination = currentConversation(execution);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw Error('重启任务须为 1–16000 字符');
    const modelSelection=conversationModel(execution?.agent);
    const id = randomUUID(); store.change(s => { if(s.tasks.length >= 2000) throw Error('heartBeat 任务队列已达容量上限'); s.tasks.push({ id, prompt, destination, status: 'waiting', created: Date.now(), creatorPid: pid,...modelSelection?{modelSelection}:{} }); }); return { ok: true, id };
  };
  return {
    state: store.read, schedule, stop() { stopped = true; },
    prepare: targetVersion => controller.prepare(targetVersion),
    async restart(ticket, update = false) {
      const helper = await controller.restart(ticket);
      const updateId = update ? schedule('Newmark2DSH 更新后 DSH 已重启。请确认组件状态，报告未完成的持久任务；不要自动重复失败动作。', 'newmate').id : null;
      let finished = false;
      return {
        folder: helper.folder,
        commit() {
          if (finished) return;
          store.change(s => { for (const t of s.tasks) if (t.status === 'waiting') Object.assign(t, { status: 'armed', restartPid:pid, folder: helper.folder }); });
          try { helper.commit(); finished = true; } catch (e) { store.change(s => { for (const t of s.tasks) if (t.folder === helper.folder) t.status = 'waiting'; }); helper.cancel(); throw e; }
        },
        cancel() { if (!finished) { finished = true; helper.cancel(); if (updateId) store.change(s => { s.tasks.find(t => t.id === updateId).status = 'cancelled'; }); } },
      };
    },
    async globalRestart() { const prepared = await controller.prepare(version); return this.restart(prepared.ticket); },
    async tick() {
      if (pumping || stopped) return; pumping = true;
      try {
        for (const task of store.read().tasks.filter(t => t.status === 'armed' && t.restartPid !== pid)) {
          try {
            const status = JSON.parse(fs.readFileSync(path.join(task.folder, 'status.json'), 'utf8').replace(/^\uFEFF/, ''));
            if (status.state !== 'running') continue;
            const job = JSON.parse(fs.readFileSync(path.join(task.folder, 'job.json'), 'utf8'));
            const owner = await probe();
            if (stopped) return;
            if (owner.path !== job.owner.path || owner.created === job.owner.created) continue;
            if (task.destination === 'newmate') {
              if (!core()?.newMate) continue;
              core().newMate.enqueue(task.prompt, 'newmate', task.id);
            } else await deliverConversation(agents(), task.destination, task);
            // One atomic durable mutation consumes the executable record and leaves only its ID.
            store.change(s => {s.receipts ||= [];if(!s.receipts.some(r=>r.id===task.id))s.receipts.push({id:task.id,delivered:Date.now()});s.tasks=s.tasks.filter(t=>t.id!==task.id);s.schema=2;});
          } catch (error) {
            if (task.error !== String(error.message)) { failures.record({where:'heartbeat/delivery',code:error.code || 'delivery_failed',message:String(error.message),fields:{taskId:task.id}}); store.change(s => { s.tasks.find(t => t.id === task.id).error = String(error.message); }); }
          }
        }
      } finally { pumping = false; }
    },
  };
}
