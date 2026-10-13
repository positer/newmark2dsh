import {createHash} from 'node:crypto';
export const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
export const INITIATIVE_DEFAULTS={initiative:true,pace:'balanced',quietStart:23,quietEnd:8,snoozeUntil:0};
export const PACES={quiet:{gap:8*HOUR,attempts:2,messages:1},balanced:{gap:4*HOUR,attempts:4,messages:2},active:{gap:2*HOUR,attempts:6,messages:3}};
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
export function localClock(time){const p=Object.fromEntries(clock.formatToParts(new Date(time)).map(p=>[p.type,p.value]));return{day:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};}
export function isQuiet(settings,time){const h=localClock(time).hour,a=settings.quietStart,b=settings.quietEnd;return a===b?false:a<b?h>=a&&h<b:h>=a||h<b;}
export function dayCounts(state,time){return state.day===localClock(time).day?{attempts:state.attempts||0,sent:state.sent||0}:{attempts:0,sent:0};}
export function touchDay(state,time){const day=localClock(time).day;if(state.day!==day)Object.assign(state,{day,attempts:0,sent:0});}
export function initiativeGate(settings,state,time,{ready=true,readerFocused=false,busy=false,idleMs=0}={},engagedAt=0,bootReadyAt=0){
 const pace=PACES[settings.pace]||PACES.balanced,counts=dayCounts(state,time);
 let reason='ready';
 if(!settings.companion||!settings.initiative)reason='disabled';else if(settings.snoozeUntil>time)reason='snoozed';else if(isQuiet(settings,time))reason='quiet_hours';
 else if(!ready)reason='runtime_unavailable';else if(time<bootReadyAt)reason='startup_settle';else if(readerFocused)reason='reading';else if(busy)reason='busy';
 else if(idleMs>=90*MINUTE)reason='away';else if(idleMs<MINUTE)reason='typing';else if(time-Math.max(engagedAt,state.lastUserAt||0,state.lastReadAt||0)<45*MINUTE)reason='recent_conversation';
 else if(counts.attempts>=pace.attempts)reason='daily_reasoning_budget';else if(counts.sent>=pace.messages)reason='daily_message_budget';
 else if(time<(state.nextAttemptAt||0))reason='cooldown';
 return{allowed:reason==='ready',reason,counts,pace};
}
export function nextGap(settings,state){const pace=PACES[settings.pace]||PACES.balanced;return Math.max(pace.gap,Math.min(DAY,pace.gap*2**Math.min(3,state.unanswered||0)));}
export function messageGate(settings,state,time,text,topic,engagedAt=0){
 if(!settings.companion||!settings.initiative)return'disabled';if(settings.snoozeUntil>time)return'snoozed';if(isQuiet(settings,time))return'quiet_hours';
 if(time-Math.max(engagedAt,state.lastUserAt||0,state.lastReadAt||0)<45*MINUTE)return'recent_conversation';
 if(dayCounts(state,time).sent>=(PACES[settings.pace]||PACES.balanced).messages)return'daily_message_budget';
 if(state.lastMessageAt&&time-state.lastMessageAt<nextGap(settings,state))return'cooldown';
 const hash=createHash('sha256').update(text.replace(/\s+/g,'').trim()).digest('hex');
 if(time-(state.lastMessageAt||0)<DAY&&(state.lastTextHash===hash||(topic&&state.lastTopic===topic)))return'duplicate_topic';return'';
}
export function recordMessage(state,time,text,topic){touchDay(state,time);state.sent++;state.lastMessageAt=time;state.lastTopic=topic;state.lastTextHash=createHash('sha256').update(text.replace(/\s+/g,'').trim()).digest('hex');state.unanswered=(state.unanswered||0)+1;}
