import {createHash} from 'node:crypto';
export const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
/**
 * How many check-ins one piece of evidence may survive without producing a contact.
 *
 * The evidence a proactive check-in is about (a file change, a memory change) used to be cleared the
 * moment a check-in was SCHEDULED, so a silent or refused check-in consumed the only proof that
 * anything had happened. Keeping it is right; keeping it forever is not, because a change that is
 * genuinely not worth mentioning would make every later check-in talk about the same thing. Three
 * attempts is the bound: one judgement, one retry after the gap, one last chance - then the evidence
 * expires and the expiry is recorded instead of the change being silently dropped.
 */
export const MAX_EVIDENCE_ATTEMPTS=3;
/**
 * Quiet hours are MINUTES FROM LOCAL MIDNIGHT on a half-hour grid (0..1410), not whole hours.
 *
 * The user asked for half-hour granularity (静默时间段设置调整为半小时一段) and for a switch that turns
 * the window off entirely (提供静默区间开关). Both are representation changes, so the legacy shape has to
 * keep meaning what it meant: a stored integer 0..23 is an HOUR from the old settings and is read as
 * hour*60 (see quietBoundary), while anything >= 24 is already minutes. `quietStart === quietEnd` keeps
 * its old meaning - an empty window - and `quietEnabled:false` switches the window off without losing
 * the chosen boundaries.
 */
export const QUIET_STEP_MINUTES=30;
export const QUIET_LAST_MINUTES=24*60-QUIET_STEP_MINUTES;
export const INITIATIVE_DEFAULTS={initiative:true,pace:'balanced',quietEnabled:true,quietStart:23*60,quietEnd:8*60,snoozeUntil:0};
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
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function localClock(time){const p=Object.fromEntries(clock.formatToParts(new Date(time)).map(p=>[p.type,p.value]));const hour=Number(p.hour);return{day:`${p.year}-${p.month}-${p.day}`,hour,minute:Number(p.minute),minutes:hour*60+Number(p.minute)};}
/**
 * One boundary in minutes. Integers 0..23 are the LEGACY hour shape and are multiplied; anything on the
 * half-hour grid is taken as minutes; anything else falls back, so a hand-edited state cannot produce a
 * boundary the settings page cannot express.
 */
export function quietBoundary(value,fallback=0){const number=Number(value);if(!Number.isFinite(number))return fallback;if(Number.isInteger(number)&&number>=0&&number<=23)return number*60;if(Number.isInteger(number)&&number>=0&&number<=QUIET_LAST_MINUTES&&number%QUIET_STEP_MINUTES===0)return number;return fallback;}
/** The window as the gate, the page and the receipts all read it. */
export function quietWindow(settings={}){return{enabled:settings.quietEnabled!==false,start:quietBoundary(settings.quietStart,INITIATIVE_DEFAULTS.quietStart),end:quietBoundary(settings.quietEnd,INITIATIVE_DEFAULTS.quietEnd)};}
/** `1410` -> `23:30`, for receipts and the page. */
export function quietClock(minutes){const value=quietBoundary(minutes,0);return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');}
export function isQuiet(settings,time){
 const{enabled,start,end}=quietWindow(settings);
 if(!enabled||start===end)return false;
 const m=localClock(time).minutes;
 return start<end?m>=start&&m<end:m>=start||m<end;
}
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
