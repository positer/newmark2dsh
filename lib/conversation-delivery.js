import { computerUseCaller } from './cu-caller.js';
export function conversationModel(agent) {
  const saved=agent?.session?.requestHeader?.()?.config;
  const selected=[saved,agent?.options].find(v=>typeof v?.provider==='string'&&v.provider.trim()&&typeof v?.model==='string'&&v.model.trim());
  if(!selected)return null;
  return {provider:selected.provider,model:selected.model,...typeof selected.reasoningEffort==='string'?{reasoningEffort:selected.reasoningEffort}:{}};
}
function restoreModel(agent,fallback) {
  // A live entry point may already own a valid selection; never repoint it.
  if(typeof agent?.options?.provider==='string'&&agent.options.provider.trim()&&typeof agent.options.model==='string'&&agent.options.model.trim())return;
  const selected=conversationModel(agent)||conversationModel({options:fallback});
  if(!selected)throw Error('原对话没有可恢复的供应商/模型选择，未投递重启任务');
  agent.options ||= {};
  Object.assign(agent.options,selected);
  if(selected.reasoningEffort===undefined)delete agent.options.reasoningEffort;
}
export function currentConversation(execution) {
  const caller = computerUseCaller(execution);
  if (!caller?.startsWith('dsh-session:')) throw Error('当前调用没有可信的 DSH 对话身份');
  return caller.slice('dsh-session:'.length);
}
export async function deliverConversation(agents, sessionId, task, signal) {
  if (!agents) throw Error('DSH agents 服务不可用');
  let agent = agents.get(sessionId);
  if (!agent) agent = (await agents.resume({ resumeSessionId: sessionId, signal,
    // The persisted session is available here, before the loop can consume its inbox.
    setup: (_ctx,resumed) => {restoreModel(resumed,task.modelSelection);},
  })).agent;
  signal?.throwIfAborted();
  if (!agent?.followup) throw Error('持久对话不能接收 followup');
  restoreModel(agent,task.modelSelection);
  const id = `newmark-task:${task.id}`;
  // A task retried after a crash keeps its message identity.
  const events = agent.session?.snapshotEvents?.() || [];
  const inserted = events.some(event => event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => message.id === id));
  if (!inserted) {
    await agent.followup({ id, role: 'user', content: [{ type: 'text', text: task.prompt }], source: { kind: 'cordis-host-runner' } });
  }
  const sessions = agent.ctx?.get?.('sessions');
  if (!sessions?.flush || await sessions.flush(agent.session) !== true) throw Error('对话任务尚未通过 session/flush 持久化屏障');
}
