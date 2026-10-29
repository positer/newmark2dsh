import {createHash} from 'node:crypto';
export const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
export const INITIATIVE_DEFAULTS={initiative:true,pace:'balanced',quietStart:23,quietEnd:8,snoozeUntil:0};
/**
 * The three initiative levels. They no longer carry "N messages per day" quotas: the user asked for
 * the exact counts (and the wording that stated them) to go away, because a quota made the companion
 * answer to a number rather than to what actually happened. What each level now decides is:
 *
 *   gap        the cooldown between two proactive contacts (a time rule, not a quota);
 *   threshold  how much accumulated evidence - workspace changes PLUS quiet time - is needed before
 *              one contact is made (this is the value the monitor's accumulator compares against);
 *   timeWeight how much pure quiet time contributes per gap. A level that is "more active" needs
 *              less evidence and lets time count for more.
 *
 * There is deliberately no daily cap. The gap and the threshold are the only limits, and both are
 * things the user can see and reason about.
 */
export const PACES={
  quiet:{gap:8*HOUR,threshold:0.85,timeWeight:0.15},
  balanced:{gap:4*HOUR,threshold:0.6,timeWeight:0.25},
  active:{gap:2*HOUR,threshold:0.4,timeWeight:0.35},
};
/** The level's evidence threshold: what the workspace accumulator must reach. */
export const paceThreshold=pace=>(PACES[pace]||PACES.balanced).threshold;
/** The level's quiet-time weight per gap. */
export const paceTimeWeight=pace=>(PACES[pace]||PACES.balanced).timeWeight;
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
export function localClock(time){const p=Object.fromEntries(clock.formatToParts(new Date(time)).map(p=>[p.type,p.value]));return{day:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};}
export function isQuiet(settings,time){const h=localClock(time).hour,a=settings.quietStart,b=settings.quietEnd;return a===b?false:a<b?h>=a&&h<b:h>=a||h<b;}
export function dayCounts(state,time){return state.day===localClock(time).day?{attempts:state.attempts||0,sent:state.sent||0}:{attempts:0,sent:0};}
export function touchDay(state,time){const day=localClock(time).day;if(state.day!==day)Object.assign(state,{day,attempts:0,sent:0});}
/**
 * The gate. The two quota reasons are gone: everything left is about whether a contact is
 * appropriate RIGHT NOW (switch, snooze, quiet hours, desktop state, attention, cooldown), and the
 * "how much" question is answered by the threshold, not by a count.
 */
export function initiativeGate(settings,state,time,{ready=true,readerFocused=false,busy=false,idleMs=0}={},engagedAt=0,bootReadyAt=0){
 const pace=PACES[settings.pace]||PACES.balanced;
 let reason='ready';
 if(!settings.companion||!settings.initiative)reason='disabled';else if(settings.snoozeUntil>time)reason='snoozed';else if(isQuiet(settings,time))reason='quiet_hours';
 else if(!ready)reason='runtime_unavailable';else if(time<bootReadyAt)reason='startup_settle';else if(readerFocused)reason='reading';else if(busy)reason='busy';
 else if(idleMs>=90*MINUTE)reason='away';else if(idleMs<MINUTE)reason='typing';else if(time-Math.max(engagedAt,state.lastUserAt||0,state.lastReadAt||0)<45*MINUTE)reason='recent_conversation';
 else if(time<(state.nextAttemptAt||0))reason='cooldown';
 return{allowed:reason==='ready',reason,pace,threshold:pace.threshold,timeWeight:pace.timeWeight};
}
export function nextGap(settings,state){const pace=PACES[settings.pace]||PACES.balanced;return Math.max(pace.gap,Math.min(DAY,pace.gap*2**Math.min(3,state.unanswered||0)));}
export function messageGate(settings,state,time,text,topic,engagedAt=0){
 if(!settings.companion||!settings.initiative)return'disabled';if(settings.snoozeUntil>time)return'snoozed';if(isQuiet(settings,time))return'quiet_hours';
 if(time-Math.max(engagedAt,state.lastUserAt||0,state.lastReadAt||0)<45*MINUTE)return'recent_conversation';
 if(state.lastMessageAt&&time-state.lastMessageAt<nextGap(settings,state))return'cooldown';
 const hash=createHash('sha256').update(text.replace(/\s+/g,'').trim()).digest('hex');
 if(time-(state.lastMessageAt||0)<DAY&&(state.lastTextHash===hash||(topic&&state.lastTopic===topic)))return'duplicate_topic';return'';
}
export function recordMessage(state,time,text,topic){touchDay(state,time);state.sent++;state.lastMessageAt=time;state.lastTopic=topic;state.lastTextHash=createHash('sha256').update(text.replace(/\s+/g,'').trim()).digest('hex');state.unanswered=(state.unanswered||0)+1;}
