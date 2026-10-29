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
/**
 * Whether the user has paused this conversation's goal.
 *
 * The host's goal service is the only holder of that decision (dsh-tool-goal reads
 * `ctx.goals.get(agent).phase`), and a paused conversation must not be woken by a background route:
 * waking it starts a model turn the user did not ask for. heartbeat keeps its own copy of this
 * predicate for restart participants; the wake route (`newmate_task` -> a conversation) asks the
 * same question here. Fail-open: no service, no goal, or a throwing read all mean "not paused",
 * because a missing answer must never block a delivery the user did ask for.
 */
export function conversationPaused(goals, agent) {
  try { return goals?.get?.(agent)?.phase === 'paused'; } catch { return false; }
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
    setup: async (ctx,resumed) => {
      restoreModel(resumed,task.modelSelection);
      // A resumed Agent takes its WHOLE composition from this setup (dsh-agent-loop calls
      // setup?.(prepared.agent.ctx, prepared.agent)), so the preset the session records has to be
      // mounted here. Without this mount the Agent runs on the Host composition alone — measured
      // 45 tools, presentation native, no run_code and no read/write/edit/glob/grep/pwsh
      // (Newmark2DSH/archive/20261017-231450-rdev-mount/RESULT.md). Trap avoided: the preset is NOT
      // in session.requestHeader() (that folded EpochHeader carries provider/model/tools only).
      const presets=ctx.get?.('agentPresets');
      const recorded=ctx.get?.('sessionProjections')?.stateOf?.(resumed.session,'agentPreset')
        ?? resumed?.session?.header?.agentPreset;
      if(presets&&typeof recorded==='string'&&recorded.trim())await presets.mount(ctx,recorded);
    },
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
