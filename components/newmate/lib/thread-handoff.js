import {HOUR,DAY} from './initiative.js';
/** Attention is evidence of engagement, not an inference about the user's feelings. */
export function threadHandoff(state,time,{topic='',focused=false,draft=false,busy=false,engagedAt=0}={}) {
  const current=state.threads.find(t=>t.id===state.activeThreadId&&!t.archived);
  const attention=state.attention?.[state.activeThreadId]||{};
  const messages=state.messages.filter(m=>m.threadId===state.activeThreadId);
  const recent=Math.max(current?.created||0,engagedAt,attention.lastFocusedAt||0,...messages.filter(m=>m.role==='user').map(m=>m.at||0));
  if(!current||!messages.length)return'';
  if(focused||draft||attention.draftUntil>time||busy)return'attention_protected';
  if(state.lastThreadRotation&&time-state.lastThreadRotation.at<DAY)return'rotation_cooldown';
  if(time-recent<4*HOUR)return'recent_interest';
  const lastTopic=state.initiative.lastTopic;
  if(topic&&lastTopic&&topic!==lastTopic&&time-recent>=8*HOUR)return'new_topic_after_absence';
  if(time-recent>=DAY&&(state.initiative.unanswered||0)>=2)return'long_unanswered';
  return'';
}
export const shouldRotate=reason=>['new_topic_after_absence','long_unanswered'].includes(reason);
