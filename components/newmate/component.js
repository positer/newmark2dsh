import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { durableState } from '../../lib/durable-state.js';
import { currentConversation, deliverConversation, conversationPaused, conversationModel } from '../../lib/conversation-delivery.js';
import { classifyToolResult } from '../agent-api/lib/contract.js';
import { createErrorLog } from '../../lib/errors.js';
import { withNewMateContext } from '../../lib/newmate-context.js';
import { createMemoryContext } from './lib/memory-context.js';
import { computerUseCaller, withComputerUseCaller, withComputerUseOwner } from '../../lib/cu-caller.js';
import { createLoopStatus } from './lib/agent-loop.js';
import { NEWMATE_SEARCH_TOOL } from './lib/web-search.js';
import { NEWMATE_ASK_TOOL, ASK_MIN_OPTIONS, ASK_MAX_OPTIONS, ASK_QUESTION_MAX_CHARS, ASK_LABEL_MAX_CHARS } from './lib/ask.js';
import {PROACTIVE_STYLE,proactiveMessageGate} from './lib/proactive-message.js';
import {threadHandoff,shouldRotate} from './lib/thread-handoff.js';
import {todoInput,todoMessageId,nextActivation} from './lib/todo-list.js';
import {REPLY_PROTOCOL,normalizeReply,bubbleText,toPlain} from './lib/reply-format.js';
import {INITIATIVE_DEFAULTS,PACES,MINUTE,HOUR,DAY,initiativeGate,messageGate,nextGap,touchDay,recordMessage,isQuiet,paceThreshold,paceTimeWeight} from './lib/initiative.js';
import { MONITOR_DEFAULTS, evaluateWorkspaces, settle } from './lib/workspace-diff.js';
import { attachmentBlock, normalizeAttachments, readUploadContent, saveUpload, UPLOAD_EXCERPT_CHARS, UPLOAD_MAX_PER_MESSAGE } from './lib/upload-store.js';

/**
 * A local wall-clock stamp WITH its offset.
 *
 * The prompt used to hand the model an ISO string ending in Z (UTC) next to the words "本机时区":
 * measured 2026-10-27 07:55 local, NewMate quoted "现在 23:55，时间不早了" — it read the UTC hour as
 * if it were local, and its own next message admitted the two could not both be true. A time the
 * model has to reconcile is a time it will get wrong, so the prompt now states one unambiguous local
 * instant with its offset, plus the user message's own send time.
 */
/**
 * One run's answer as {rich, plain}. The envelope's own text/plain win; a model that answered with
 * anything else still yields a displayable rich reply and a derived plain one.
 */
const readReply = (envelope, automatic) => {
  const structured = envelope?.result?.structured;
  if (structured && typeof structured.text === 'string') {
    const rich = structured.text.trim();
    const plain = typeof structured.plain === 'string' && structured.plain.trim() ? structured.plain.trim() : toPlain(rich);
    return { rich, plain, notify: typeof structured.notify === 'boolean' ? structured.notify : undefined, topic: typeof structured.topic === 'string' ? structured.topic : undefined, protocol: true };
  }
  return normalizeReply(envelope?.result?.output, { automatic });
};

const localStamp = (ms) => {
  const d = new Date(Number(ms) || 0);
  const p = (value) => String(value).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)}`;
};


/**
 * The tool group a NewMate run may use. ONE list, read four ways: it is the group a run's allow
 * list is drawn from, it is the group whose schemas initialization describes, it is the source of
 * the ComputerUse names the lease rule keys on, and it is what the gates compare against.
 *
 * Names only - never schemas - because the schema must come from the LIVE registry: a tool this
 * bundle registers and a tool a plugin provides are described the same way, and a name the
 * current exposure does not carry is reported as missing instead of being described as callable.
 *
 * THE CONDITIONAL NAMES, whose conditions come from the persona rather than from the registry:
 *   newmate_task                    only on turns bound to an origin conversation
 *   computer_use / screen_capture / newmate_search   only on a run a person asked for - a
 *                                   chat turn, or a todo activation the user scheduled -
 *                                   because an autonomous check-in has no request behind it and
 *                                   neither a desktop takeover nor a web lookup belongs to it.
 * The schema projection still describes both, because the group is the whole surface NewMate may
 * ever use; a schema is not a grant, and `newMateRunTools` is what one run is offered.
 */
export const NEWMATE_RUN_TOOLS = Object.freeze([
  'memory_lab_read', 'memory_lab_query', 'memory_lab_root_tags', 'memory_lab_subtag_tree',
  'memory_lab_update', 'memory_lab_reindex', 'memory_lab_tag_review', 'memory_lab_tag_apply',
  'shortMemory_add', 'shortMemory_recall', 'shortMemory_where', 'shortMemory_size',
  'newmate_todo_add', 'newmate_todo_list', 'newmate_todo_cancel',
  'computer_use', 'screen_capture', NEWMATE_SEARCH_TOOL, NEWMATE_ASK_TOOL, 'compact_context', 'newmate_task',
  'newmate_wechat_send_file', 'newmate_wechat_send_text', 'newmate_attachment_read',
  'newmate_conversation_list', 'newmate_conversation_new', 'newmate_conversation_send', 'newmate_conversation_read',
]);

/** The two ComputerUse tools, and the owner label every NewMate lease carries. */
export const NEWMATE_CU_TOOLS = Object.freeze(['computer_use', 'screen_capture']);
/**
 * The group members a PERSON must have asked for: a desktop takeover and a web lookup are both
 * actions against the outside world, not background bookkeeping. A run constructor withholds
 * them from every autonomous check, and the persona states the same boundary.
 */
/**
 * The group members a PERSON must have asked for: a desktop takeover, a web lookup and a file the
 * user is about to receive on their phone. All four are actions against the outside world rather than
 * background bookkeeping, and a file can never be recalled once it has been sent - which is also why
 * sending one is not something an unprompted self-check may decide to do.
 */
export const NEWMATE_REQUEST_TOOLS = Object.freeze([...NEWMATE_CU_TOOLS, NEWMATE_SEARCH_TOOL, NEWMATE_ASK_TOOL, 'newmate_wechat_send_file']);
/**
 * The ComputerUse owner a NewMate run binds for its whole duration.
 *
 * Not the requesting conversation's session id, and not the shared 'dsh' fallback. A lease has no
 * expiry and is released only by its own owner, so a stable NewMate label is what makes the
 * release path safe: NewMate can release a lease it took, and cannot release - or be confused
 * with - the lease of the conversation that asked it to work.
 */
export const NEWMATE_CU_OWNER = 'newmate';
/** The bound on one lease-release call; a stuck backend must not hold the task queue open. */
export const NEWMATE_CU_RELEASE_TIMEOUT_MS = 8000;

/**
 * The exact allow list one run is offered.
 *
 * `automatic` is the run a scheduled self-check starts (self_activation / measurement); it gets
 * no ComputerUse tools and no `newmate_task`. `origin` is the DSH conversation the task is bound
 * to, and only a user-initiated turn can carry `newmate_task` back to it.
 */
export function newMateRunTools({ automatic = false, origin } = {}) {
  const offered = NEWMATE_RUN_TOOLS.filter((name) => name !== 'newmate_task' && (!automatic || !NEWMATE_REQUEST_TOOLS.includes(name)));
  return !automatic && origin ? [...offered, 'newmate_task'] : offered;
}
export function createNewMate({ root, tools, agents, goals = () => null, now = Date.now, logger, onNotify = async () => {}, onCompanion = async () => {}, onPresence = () => {}, environment=()=>({ready:true,idleMs:2*MINUTE}) }) {
  const failures = createErrorLog({root,logger});
  // The live view of the run in flight: what the page, newmate_state and the MCP status read.
  const live = createLoopStatus(now);
  // The initialization payload is built once at construction and rebuilt whenever memory moves.
  // It carries the persona, the complete tag tree, every short row and the memory tool-group schema;
  // bodies stay on demand. The schema source is the LIVE registry this process registered, not a copy.
  const nativeMemory = createMemoryContext(root,now,{toolSchemas:()=>({schemas:typeof tools?.schemas==='function'?tools.schemas():[],names:NEWMATE_RUN_TOOLS})});
  nativeMemory();
  const store = durableState(path.join(root, 'newMate', 'state.json'), { schema: 2, threads: [{id:'default',title:'与 NewMate 的对话',created:now(),updated:now(),archived:false}], activeThreadId:'default', settings:{companion:false,notifications:false}, messages: [], tasks: [], measurements: {}, lastResponse: 0 });
  if (store.read().schema !== 2) store.change(s => {
    s.schema=2;s.threads=[{id:'default',title:'此前的对话',created:s.messages[0]?.at||now(),updated:now(),archived:false}];s.activeThreadId='default';s.settings={companion:false,notifications:false};
    for(const message of s.messages)message.threadId='default';for(const task of s.tasks)task.threadId='default';
  });
  if(store.read().settings.notifications!==false)store.change(s=>{s.settings.notifications=false;});
  const initial=store.read();
  if(!initial.initiative||initial.initiative.enabledAt===undefined||Object.keys(INITIATIVE_DEFAULTS).some(k=>initial.settings[k]===undefined))store.change(s=>{
    s.settings={...INITIATIVE_DEFAULTS,...s.settings};s.initiative ||= {nextAttemptAt:now()+20*MINUTE,lastUserAt:Math.max(0,...s.messages.filter(m=>m.role==='user').map(m=>m.at||0)),lastMessageAt:0,unanswered:0,attempts:0,sent:0,day:'',signals:[]};s.initiative.enabledAt??=now();
  });
  /**
   * The workspace monitor's durable half: the last snapshot per workspace and the accumulator that
   * survives a restart. It lives in the same state file as everything else, so the start-up
   * comparison (the first of the user's five requirements) compares against what the PREVIOUS run
   * saw, not against nothing.
   */
  if(!store.read().watch||typeof store.read().watch!=='object')store.change(s=>{s.watch={snapshots:{},acc:0,runs:0,lastRunAt:0,lastScore:0,lastDescription:'',lastEvent:null};});
  // The monitor's knobs are NewMate settings (the user's requirement 5: configurable in the plugin
  // settings). They are seeded once so the settings page reads a real value rather than a default
  // it has to invent, and a missing key never changes behaviour.
  // The threshold became the initiative level's business, so a value left in an old state file is
  // removed rather than left visible as a setting nothing reads any more.
  if(store.read().settings.watchThreshold!==undefined)store.change(s=>{delete s.settings.watchThreshold;});
  if(['watchEnabled','watchIntervalMinutes','watchDepth','watchDshWeight'].some(key=>store.read().settings[key]===undefined))store.change(s=>{s.settings={watchEnabled:true,watchIntervalMinutes:MONITOR_DEFAULTS.intervalMinutes,watchDepth:MONITOR_DEFAULTS.depth,watchDshWeight:MONITOR_DEFAULTS.dshWeight,...s.settings};});
  const bootReadyAt=now()+2*MINUTE;
  if(!Array.isArray(store.read().todos))store.change(s=>{s.todos=[];});
  // Notification always follows the durable message receipt. Never notify it again on restart.
  if(store.read().todos.some(t=>t.status==='delivering'))store.change(s=>{for(const t of s.todos)if(t.status==='delivering'){const m=s.messages.find(m=>m.id===todoMessageId(t.id));Object.assign(t,m?{status:'delivered',deliveredAt:m.at,messageId:m.id,threadId:m.threadId}:{status:'pending'});}});
  const memoryMarker=()=>['index.json','short-memory.json'].map(name=>{try{const stat=fs.statSync(path.join(root,'Memory Lab',name));return`${stat.size}:${stat.mtimeMs}`;}catch(error){if(error.code==='ENOENT')return'absent';throw error;}}).join('|');
  let engagedAt=0,lastProbeAt=-Infinity,lastMemoryKey=nativeMemory().key,lastMemoryMarker=memoryMarker();
  let readingUntil=0;
  const readers=new Map();
  const presence=(focused,client='legacy',sequence)=>{
    if(typeof client!=='string'||!client||client.length>100)throw Error('阅读窗口标识无效');
    const previous=readers.get(client);
    if(Number.isFinite(sequence)&&previous&&sequence<=previous.sequence)return false;
    readers.set(client,{until:focused?now()+7000:0,sequence:Number.isFinite(sequence)?sequence:(previous?.sequence||0)+1,at:now()});
    if(focused){engagedAt=now();const a=store.read().attention?.[store.read().activeThreadId];if(!a?.lastFocusedAt||now()-a.lastFocusedAt>=MINUTE)store.change(s=>{s.attention ||= {};const a=s.attention[s.activeThreadId] ||= {};a.lastFocusedAt=now();});}
    for(const [key,value]of readers)if(now()-value.at>10000)readers.delete(key);
    readingUntil=Math.max(0,...[...readers.values()].map(r=>r.until));onPresence(readingUntil);return true;
  };
  const thread = id => { const s=store.read();if(id&&id!==s.activeThreadId)throw Error('历史对话只读，不能重新激活或继续发送');const selected=s.threads.find(t=>t.id===(id||s.activeThreadId)&&!t.archived);if(selected)return selected;
    if(!id){const inbox={id:randomUUID(),title:'NewMate 收件箱',created:now(),updated:now(),archived:false};store.change(s=>{if(s.threads.length>=1000)throw Error('对话数量已达到上限');s.threads.push(inbox);s.activeThreadId=inbox.id;});return inbox;}
    throw Error('对话不存在或已归档');
  };
  const notify = async message => {
    const settings=store.read().settings;
    if(settings.companion){const state=store.read();const muted=isQuiet(settings,now())||settings.snoozeUntil>now()||(message.proactive&&state.initiative.lastInterruptAt&&now()-state.initiative.lastInterruptAt<30*MINUTE);
      if(muted)return{interrupted:false};
      store.change(s=>{s.initiative.lastInterruptAt=now();});
      try{await onNotify({...message,system:false,readerUntil:readingUntil});return{interrupted:true};}catch(error){failures.record({where:'newmate/notification',code:'notification_failed',message:error.message});}
    }return{interrupted:false};
  };
  let running = false, stopped = false, todoDelivering=false, active,activeAutomatic=false,activeTask=null,guide=null,manualRestart=false,userPreempted=false;
  /**
   * Why a scheduled item is still waiting, as a stable code the panel and the record can both read.
   *
   * A gate that only says "not yet" is indistinguishable from a broken gate: on 2026-10-28 14:00 a
   * reminder read "已到期 · 等待合适时机" for 12m47s and nothing anywhere said what it waited for.
   * The codes below are the complete answer, and only the two conditions a due item can actually
   * wait for are in it (2026-10-29).
   */
  const DEFERRAL = {companion_off:'陪伴未开启',newmate_running:'NewMate 正在运行',newmate_busy:'NewMate 队列未空',queue_full:'任务队列已满',model_unavailable:'模型尚未就绪'};
  /**
   * "Nothing was attempted" - agent-api exit 3. It is not an answer and it is not the user's fault:
   * on 2026-10-29 09:04 the user's 07:30 activation ran for 204 ms, hit `model_not_selected` (a fresh
   * bundle has authorised no model yet) and was written `failed`, which never retries. The item was
   * asked for by the user, so it goes back to pending with a short backoff instead of being burned.
   */
  const NOTHING_ATTEMPTED = /no model has been (?:authorised|selected)|model_not_selected/i;
  const NOTHING_ATTEMPTED_RETRY_MS = 5 * MINUTE;
  /**
   * NewMate's own queue: is this companion busy with, or about to start, a turn of its own?
   * Deliberately does NOT consult the DSH host - a turn running in another workspace is not NewMate
   * working, and treating it as such is what held the user's 14:00 reminder for 12 minutes.
   */
  function newmateBusyReason(){
    if(running)return 'newmate_running';
    return store.read().tasks.some(t=>t.kind==='chat'&&['pending','running'].includes(t.status))?'newmate_busy':null;
  }
  /** Idle means this companion is not working; the DSH host is deliberately not consulted. */
  function newmateIdle(){return newmateBusyReason()===null;}
  /**
   * The one gate every due item obeys: the companion switch, and NewMate being idle.
   *
   * The user's rule, in their words (2026-10-29): a todo that activates a NewMate conversation
   * "应该和 dsh 本体的会话没有任何关系，只需要投递给 newMate 并激活 newMate 的对话即可". So the
   * DSH host is not consulted here, and neither are quiet hours, snooze, the desktop, reading,
   * typing or drafts. Both modes therefore wait for exactly the same two things; what differs is
   * only what happens at the end - store the text, or run one turn.
   * Quiet hours and snooze are NOT here on purpose: they belong to notify(), which mutes the BUBBLE
   * while the message is still stored. Refusing delivery there would merge two different promises -
   * "it arrived" and "it interrupted you" - and the receipt records which of the two happened.
   *
   * What the old ladder cost, measured on the user's own record: an item due 2026-10-29 07:30 was
   * still pending at 08:49 reading "已到期 · 等宿主有会话在运行", because a session in another
   * workspace was running. A gate waits for what the action needs, not for what the host is.
   */
  function deliveryBlocker(){
    if(store.read().settings.companion!==true)return 'companion_off';
    return newmateBusyReason();
  }
  /** One predicate, one order: an item runs exactly when nothing refuses it. */
  function deliveryReady(){return deliveryBlocker()===null;}
  /**
   * Record why an item is waiting, and only when the reason CHANGES: the tick runs every 1.5 s, and
   * rewriting the same code on every pass would turn a diagnostic into a disk-thrash.
   */
  function defer(item,code){
    const t=store.read().todos.find(x=>x.id===item.id);
    if(!t||t.status!=='pending'||t.deferred?.code===code)return;
    store.change(s=>{const t=s.todos.find(x=>x.id===item.id);if(t&&t.status==='pending')t.deferred={code,at:now(),reason:DEFERRAL[code]||code};});
  }
  async function deliverDueTodo(){
    const state=store.read();
    /**
     * Due items, in order, but the FIRST ONE THAT CAN RUN wins - a blocked item must not hold the
     * queue behind it. Measured 2026-10-29: with the task queue full, a conversation item returned
     * silently and the reminder behind it was never delivered either.
     *
     * `retryAfter` is the backoff a failed-before-attempting activation leaves behind: the user
     * scheduled that item, so an outage is not an answer (see the catch below).
     */
    const due=state.todos.filter(t=>t.status==='pending'&&t.activateAt<=now()&&!(t.retryAfter>now())).sort((a,b)=>a.activateAt-b.activateAt||a.created-b.created);
    if(!due.length)return;
    let item=null;
    for(const candidate of due){
      const refusal=deliveryBlocker();
      if(refusal){defer(candidate,refusal);break;}
      if(candidate.mode==='conversation'&&(state.tasks.length>=2000||state.tasks.filter(t=>['pending','running'].includes(t.status)).length>=100)){defer(candidate,'queue_full');continue;}
      item=candidate;break;
    }
    if(!item)return;
    /**
     * One gate, both modes (2026-10-29). An activation is held by nothing a reminder is not held by,
     * because neither of them needs the host: the only two facts that can refuse a due item are "the
     * companion is off" and "NewMate is busy with a turn of its own". Whichever refuses is written to
     * the item, so the panel can say WHY instead of showing a bare "waiting for a good moment"
     * (the 2026-10-28 14:00 report).
     */
    const blocker=deliveryBlocker();
    if(blocker){defer(item,blocker);return;}
    if(item.mode==='conversation'){
      const claimedTodo=state.todos.find(t=>t.id===item.id);if(claimedTodo){delete claimedTodo.deferred;delete claimedTodo.retryAfter;}
      thread();const destination=rotateForMessage('todo',item.content),id=todoMessageId(item.id);
      store.change(s=>{const t=s.todos.find(t=>t.id===item.id);if(t?.status!=='pending')return;if(!s.tasks.some(task=>task.id===id))s.tasks.push({id,todoId:item.id,kind:'todo_activation',prompt:item.content,destination:'newmate',threadId:destination,status:'pending',created:now(),...(item.origin?.startsWith('dsh-session:')?{origin:item.origin.slice('dsh-session:'.length)}:{})});Object.assign(t,{status:'activated',activatedAt:now(),taskId:id,threadId:destination});});
      return;
    }
    let claimed=false;store.change(s=>{const t=s.todos.find(t=>t.id===item.id);if(t?.status==='pending'){delete t.deferred;delete t.retryAfter;t.status='delivering';claimed=true;}});if(!claimed)return;
    try{
      let message=store.read().messages.find(m=>m.id===todoMessageId(item.id));
      if(!message){thread();const destination=rotateForMessage('todo',item.content);message={id:todoMessageId(item.id),todoId:item.id,threadId:destination,role:'assistant',text:item.content,at:now(),proactive:true,unread:true};store.change(s=>{s.messages.push(message);s.threads.find(t=>t.id===destination).updated=now();});await notify(message);}
      // A repeating reminder stays pending with its NEXT activation; a one-shot one is delivered.
      store.change(s=>{const t=s.todos.find(t=>t.id===item.id);if(!t)return;const receipt={deliveredAt:message.at,messageId:message.id,threadId:message.threadId,lastDeliveredAt:message.at,deliveries:(t.deliveries||0)+1};const next=item.repeat?nextActivation(item.repeat,now()):null;Object.assign(t,next?{...receipt,status:'pending',activateAt:next}:{...receipt,status:'delivered'});});
    }catch(error){const receipt=store.read().messages.find(m=>m.id===todoMessageId(item.id));store.change(s=>{Object.assign(s.todos.find(t=>t.id===item.id),receipt?{status:'delivered',deliveredAt:receipt.at,messageId:receipt.id,threadId:receipt.threadId}:{status:'failed',error:String(error.message)});});failures.record({where:'newmate/todo',code:'todo_delivery_failed',message:String(error.message)});}
  }
  const enqueue = (prompt, destination = 'newmate', id = randomUUID(), threadId, options = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw Error('任务内容须为 1–16000 字符');
    const targetThread=thread(threadId).id;
    store.change(s => {
      if (s.tasks.some(t => t.id === id)) return;
      if (s.tasks.filter(t => ['pending','running'].includes(t.status)).length >= 100 || s.tasks.length >= 2000) throw Error('持久任务队列已达到容量上限');
      s.tasks.push({ id, prompt, destination, threadId:targetThread, status: 'pending', created: now(), ...options?.kind ? { kind: options.kind } : {}, ...Array.isArray(options?.attachments) && options.attachments.length ? { attachments: options.attachments } : {} });
    });
    return { ok: true, id };
  };
  /**
   * What one turn's task prompt looks like when the user also handed over files.
   *
   * The block is built when the message is ACCEPTED, not when the run starts, because the durable
   * task is the record: a steer, a retry or a queued turn must carry the same file facts the user
   * sent, and re-reading the store at run time would let the two drift.
   *
   * The excerpt budget is what is LEFT of the 16000-character task bound after the user's own
   * words and the block's fixed lines, so a long message shortens the excerpt instead of making
   * the whole message unsendable. If even that does not fit, the excerpt is dropped and only the
   * path is stated - a path the model can read through newmate_attachment_read.
   */
  function withAttachments(text, files) {
    if (!files.length) return text;
    const fixed = 240 * files.length;
    const budget = Math.min(UPLOAD_EXCERPT_CHARS, Math.max(0, 15000 - text.length - fixed));
    let prompt = [text, attachmentBlock(files, { budgetChars: budget })].filter(Boolean).join('\n\n');
    if (prompt.length > 16000) prompt = [text, attachmentBlock(files, { budgetChars: 0 })].filter(Boolean).join('\n\n');
    if (prompt.length > 16000) throw Error('附件说明过长，无法装进一条消息（上限 16000 字符）；请减少附件或缩短消息');
    return prompt;
  }
  /** A durable task's outcome as the live view's phase. The task record is the authority. */
  const liveOutcome = (status) => status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'paused' ? 'paused' : status === 'interrupted' ? 'interrupted' : status === 'pending' ? 'superseded' : 'done';

  /**
   * Release any ComputerUse lease this run took, before the task is reported settled.
   *
   * A lease has no expiry and only its own owner can release it, so a run that ends - answered,
   * failed, cancelled, superseded - while holding one would leave the desktop in takeover with
   * an overlay (or a hidden desktop) that nothing will reclaim. The persona tells the model to
   * call `takeover_stop` itself, and this is the runtime half that does not depend on the model
   * remembering: the same owner label the run bound, so it is the run's own lease or nothing.
   *
   * Both modes are asked because one call releases one slot, and a run may have used either.
   * The stop is a no-op when no lease is held, a refusal when another owner holds it (that
   * owner's lease is untouched), and it is bounded: a wedged backend must not hold the queue.
   * The clock that settles the run is started after this, so the live view says 'releasing'
   * while it runs rather than claiming the turn is over.
   */
  async function releaseComputerUse(taskId) {
    if (!live.used('computer_use')) return;
    live.note('releasing');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEWMATE_CU_RELEASE_TIMEOUT_MS);
    timer.unref?.();
    try {
      for (const mouse_mode of ['real', 'virtual']) {
        try {
          await withComputerUseOwner(NEWMATE_CU_OWNER, () => tools.execute({
            callId: `newmate-release:${taskId}:${mouse_mode}`,
            name: 'computer_use',
            arguments: { action: 'takeover_stop', mouse_mode },
            signal: controller.signal,
          }));
        } catch (error) {
          failures.record({ where: 'newmate/computeruse-release', code: error.code || 'computeruse_release_failed', message: String(error.message), fields: { mouseMode: mouse_mode } });
        }
      }
    } finally {
      clearTimeout(timer);
      live.cleaned();
    }
  }

  /**
   * The conversation this run answers for, as the conversation tools read it.
   *
   * It is captured into the run's ALS context (not passed as tool arguments) because a tool call
   * never carries the invoking conversation: the model must not be able to retarget a delivery or a
   * new conversation by writing a different session id. `newmate_task` already works this way -
   * identity comes from the host, never from model input - and these three tools follow it.
   */
  function conversationOf(task) {
    const origin = typeof task?.origin === 'string' && task.origin ? task.origin : undefined;
    if (!origin) return { origin: undefined };
    let agent;
    try { agent = agents()?.get?.(origin); } catch { agent = undefined; }
    const header = agent?.session?.header;
    let model;
    try { model = agent ? conversationModel(agent) : null; } catch { model = null; }
    return {
      origin,
      cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
      preset: typeof header?.agentPreset === 'string' ? header.agentPreset : undefined,
      ...model ? { model } : {},
    };
  }

  async function tick() {
    if (running || stopped || todoDelivering) return;
    // The due-check no longer short-circuits on the companion switch: deliverDueTodo records WHY it
    // cannot deliver (companion_off included), and a reason nobody ever computes is not a reason.
    const todoState=store.read();if(todoState.todos.some(t=>t.status==='pending'&&t.activateAt<=now())){todoDelivering=true;try{await deliverDueTodo();}finally{todoDelivering=false;}if(stopped)return;}
    if(now()-lastProbeAt>=MINUTE){lastProbeAt=now();probeInitiative();}
    /**
     * Pick the first task that can actually run - and SKIP a paused target instead of returning.
     *
     * It used to `return` on a paused wake, which meant one pending wake into a PAUSED conversation
     * starved everything behind it: measured 2026-10-29 (independent audit), a due activation sat at
     * `activated` with zero model calls across restarts while a paused wake was queued in front of
     * it. A DSH fact (someone paused that conversation's goal) must not decide whether NewMate can
     * run the turn the user scheduled.
     */
    const pending = store.read().tasks.filter(t => t.status === 'pending');
    const candidates = [...pending.filter(t => t.kind === 'chat'), ...pending.filter(t => t.kind !== 'chat')]
      .filter(t => t.kind !== 'todo_activation' || deliveryReady());
    let task = null;
    for (const candidate of candidates) {
      if (candidate.destination !== 'newmate' && conversationPaused(goals(), agents()?.get?.(candidate.destination))) {
        store.change(s => { Object.assign(s.tasks.find(t => t.id === candidate.id), { deferred: 'target_paused' }); });
        continue;
      }
      task = candidate;
      break;
    }
    if (!task) return;
    running = true; active = new AbortController();activeTask=task;manualRestart=false;userPreempted=false;guide={pending:[],drain(){return this.pending.splice(0);}};
    /**
     * `update_report` is a task the restart pipeline ASKED for, not the companion deciding to
     * speak. It used to be classified unsolicited (kind !== 'chat'), so its report was judged by
     * the 240-character / no-list rule of a proactive message and thrown away: measured
     * 2026-10-27, four post-restart reports were suppressed as `proactive_format` and the user
     * never saw them. Requested reports are displayed; only the capability-whine gate applies.
     */
    const report=task.kind==='update_report',automatic=task.kind==='measurement'||task.kind==='self_activation',delegated=task.kind==='todo_activation',unsolicited=task.kind!=='chat'&&!report&&!delegated;activeAutomatic=automatic||delegated;
    /**
     * A delegation is SOLICITED: the user asked for that turn at that time, so the 240-character /
     * no-list rule of a proactive message has no business judging the answer. Measured 2026-10-29
     * (independent audit): a 241-character reply, or a reply with a bullet list, was suppressed as
     * `proactive_format` and the todo was written `failed` - the model ran, the user got nothing,
     * and nothing retried it. */
    try {
      if(automatic){const s=store.read();if(!s.settings.companion||!s.settings.initiative||task.threadId!==s.activeThreadId){store.change(s=>{Object.assign(s.tasks.find(t=>t.id===task.id),{status:'paused',finished:now()});});return;}}
      store.change(s => { s.tasks.find(t => t.id === task.id).status = 'running'; });
      if (task.destination !== 'newmate') await deliverConversation(agents(), task.destination, task, active.signal);
      else {
        live.start(task);
        const recent=store.read().messages.filter(m=>m.threadId===task.threadId);
        const history = automatic?recent.slice(-6).map(({role,text,at,proactive})=>({role,text:text.slice(0,500),at,proactive})):recent.slice(-12);
        const memory = nativeMemory();
        /**
         * Two times, both local and both labelled: when this run started, and when the user actually
         * sent the message it is answering. A queued or steered turn can be minutes later than the
         * message, and the companion must quote the USER's time when it talks about "你发消息的时候"
         * while using the run time for "现在" — not the page-refresh time, and not UTC.
         */
        const userMessageAt = (() => {
          const list = store.read().messages.filter((m) => m.threadId === task.threadId && m.role === 'user');
          return list.length ? list[list.length - 1].at : 0;
        })();
        const timeLine = '当前时间：' + localStamp(now()) + '（本机时区 ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '）；最后一条用户消息发送于：' + (userMessageAt ? localStamp(userMessageAt) : '（本对话还没有用户消息）') + '。两者都是本机时间并带偏移，提到\"现在\"用前者、提到\"你发消息时\"用后者，不要换算成 UTC 或别的时区。\n';
        const outcome = task.localText?{isError:false,value:{ok:true,result:{structured:{notify:true,text:task.localText,topic:'gentle-presence'}}}}:await withComputerUseOwner(NEWMATE_CU_OWNER,()=>withComputerUseCaller(task.origin?{agent:{session:{id:task.origin}}}:undefined,()=>withNewMateContext({...memory,conversation:conversationOf(task),steer:{drain:()=>guide?.drain()||[],hasPending:()=>Boolean(guide?.pending.length)},onEvent:event=>live.event(event)},()=>tools.execute({ callId: `newmate:${task.id}`, name: 'agent_api_send', arguments: {
          prompt: `${timeLine}你可使用 newmate_todo_add/list/cancel 管理定时待办，创建必须有确定的激活时间（带时区 ISO）和要发送给用户的原文；缺少时间时先确认。用户要求重复时给 repeat：{every,unit:\'min\'|\'h\'|\'d\',weekdays?:[1-7]（1=周一）,at?:\'HH:MM\'}，或等价规则串 rule（如 \"every 2 d on 1-5 at 09:00\"）；不给 repeat 就只触发一次。仅为用户明确需求或可靠的已有委托创建，不凭空给用户安排事项。默认 mode=conversation，到期在合适时激活一轮 NewMate；仅需原文提醒时显式使用 mode=reminder，不调用模型。人格、完整 MemoryLab 标签树、全部短期记忆与记忆工具组 schema 已在最早的系统前缀注入。\n近期对话：${JSON.stringify(history)}\n工作区最近变动（稀疏监控的浅层事实，只含文件数量/名称/最新修改时间，不是文件内容）：${store.read().watch?.lastDescription||'（本机尚无对比结果）'}\n当前任务：${task.prompt}${delegated?'\n这是用户预先安排的待办激活。现在运行这一轮，结合记忆和既有对话自然回应或处理上述明确委托；不要仅复述待办，不要为待办之外的事扩大授权。不是实时用户发问，不编造用户刚刚说了什么；只发送有用结果或具体下一步。任务失败不自动重试，不创建重复待办。':''}${unsolicited?'\n'+PROACTIVE_STYLE+'\n若最近确实有工作区变动或已安静很久，主动消息的正文要用具体事实说明（哪些文件新增/改动、隔了多久）；没有具体内容就保持沉默，不要只说“有变化”或泛泛问候。':''}\n${REPLY_PROTOCOL}`,
          tools: { allow: newMateRunTools({automatic,origin:task.origin}) }, timeout_ms: automatic?45000:120000, max_steps: automatic?3:0,
          ...(automatic ? { output_schema: { type:'object',properties:{notify:{type:'boolean'},text:{type:'string',maxLength:400},plain:{type:'string',maxLength:120},topic:{type:'string',maxLength:80}},required:['notify','text'],additionalProperties:false } } : {}),
        }, signal: active.signal }))));
        active.signal.throwIfAborted();
        // A guide arriving after the loop ended must never publish an obsolete answer.
        if(guide.pending.length){store.change(s=>{const t=s.tasks.find(t=>t.id===task.id);t.status='pending';t.prompt=guide.pending.map(m=>m.content[0].text).join('\n');});return;}
        const classified = classifyToolResult('agent_api_send', outcome);
        if (classified.exit !== 0) throw Error(classified.error || 'Agent API 调用失败');
        const envelope = classified.result;
        if (envelope?.ok !== true) throw Error(envelope?.error || 'Agent API 未完成任务');
        /**
         * One answer, two renderings. The page renders `text`; the bubble and any external channel
         * (a WeChat clawbot bridge) get `plain`. Both come from the envelope the prompt asks for,
         * and normalizeReply() derives the plain version when a model ignores it - the JSON object
         * itself must never become the message (`{"notify":false,"text":""}` was a visible message
         * on 2026-10-26 20:39).
         */
        const reply = readReply(envelope, automatic);
        const decision = { ...envelope.result?.structured, text: reply.rich, notify: reply.notify, topic: reply.topic };
        if(automatic&&(typeof reply.notify!=='boolean'||typeof reply.rich!=='string'||(reply.topic!==undefined&&(typeof reply.topic!=='string'||reply.topic.length>80))))throw Error('主动判断未符合 notify/text/plain/topic 协议');
        const answer = reply.rich;
        if (typeof answer !== 'string' || (!answer && !unsolicited && !report)) throw Error('Agent API 没有返回文本');
        const current=store.read(),topic=reply.topic||task.reason||'check-in',latest=automatic?environment():{};
        if(delegated&&task.threadId!==current.activeThreadId)throw Error('待办运行期间已切换对话，回复未发布；可显式重试');
        const lateGate=automatic?(latest.ready===false?'runtime_unavailable':latest.busy?'busy':latest.readerFocused?'reading':latest.idleMs>=90*MINUTE?'away':latest.idleMs<MINUTE?'typing':''):'';
        // Reports are REQUESTED, so neither the proactive format rule nor the capability-whine rule
        // applies to them: measured 2026-10-27, the post-restart report was suppressed twice in a row,
        // once by each gate, and the user saw nothing at all.
        const contentGate=unsolicited?proactiveMessageGate(answer):'';
        // An empty answer is silence for every task kind, reports included: a report with nothing to
        // say must not become an empty bubble.
        const suppression=contentGate||(!answer?'not_actionable':'')||(automatic?(reply.notify!==true?'not_actionable':task.threadId!==current.activeThreadId?'history_closed':lateGate||messageGate(current.settings,current.initiative,now(),answer,topic,engagedAt)):'');
        if(!suppression) {
          const destination=automatic?rotateForMessage(topic,answer):task.threadId;
          // text = the page rendering, plain = what a bubble or an external channel may show.
          const message={id:task.id,threadId:destination,role:'assistant',text:answer,plain:reply.plain,at:now(),proactive:automatic||delegated||report,autonomous:automatic,unread:true,...task.todoId?{todoId:task.todoId}: {}};
          store.change(s => { s.messages.push(message);const t=s.threads.find(t=>t.id===destination);if(t)t.updated=now();if(automatic){recordMessage(s.initiative,now(),answer,topic);s.initiative.nextAttemptAt=now()+nextGap(s.settings,s.initiative);s.initiative.lastOutcome='message';} });
          await notify({ ...message, text: bubbleText(message), rich_text: message.text });
        }else store.change(s=>{s.initiative.lastOutcome=suppression;s.tasks.find(t=>t.id===task.id).suppressed=suppression;});
      }
      store.change(s => { const settled=s.tasks.find(t => t.id === task.id);Object.assign(settled,{status:'completed',finished:now()});delete settled.deferred;if(task.todoId){const todo=s.todos.find(t=>t.id===task.todoId),stored=s.messages.some(m=>m.id===task.id);if(todo){const next=stored&&todo.repeat?nextActivation(todo.repeat,now()):null;delete todo.deferred;Object.assign(todo,stored?(next?{status:'pending',activateAt:next,lastDeliveredAt:now(),messageId:task.id,deliveries:(todo.deliveries||0)+1}:{status:'completed',completedAt:now(),messageId:task.id}):{status:'failed',completedAt:now(),error:'运行已结束，但回复被主动消息格式规则抑制'});}} });
    } catch (error) {
      const paused=automatic&&active.signal.aborted&&!stopped;
      /**
       * A refusal before anything was attempted is not the answer to a scheduled item (2026-10-29).
       * The todo returns to `pending` with a backoff and a reason the panel shows, and the attempt
       * record is removed because the next tick re-creates the same deterministic task id - that is
       * why this is not a silent retry of a failure: nothing was tried, so nothing failed.
       */
      const nothingAttempted = !stopped && !manualRestart && !userPreempted && Boolean(task.todoId)
        && (NOTHING_ATTEMPTED.test(String(error.message || '')) || String(error.code || '') === 'model_not_selected');
      if (!stopped&&!paused&&!manualRestart&&!userPreempted) failures.record({where:'newmate/task',code:error.code || (nothingAttempted ? 'nothing_attempted' : 'task_failed'),message:String(error.message),fields:{taskId:task.id,...nothingAttempted?{retryInMs:NOTHING_ATTEMPTED_RETRY_MS}:{}}});
      store.change(s => {
        if(nothingAttempted){
          const todo=s.todos.find(t=>t.id===task.todoId);
          s.tasks=s.tasks.filter(t=>t.id!==task.id);
          if(todo)Object.assign(todo,{status:'pending',retryAfter:now()+NOTHING_ATTEMPTED_RETRY_MS,deferred:{code:'model_unavailable',at:now(),reason:DEFERRAL.model_unavailable}});
          if(automatic)s.initiative.lastOutcome='nothing_attempted';
          return;
        }
        const attempted=s.tasks.find(t => t.id === task.id);delete attempted.deferred;Object.assign(attempted, { status: manualRestart?'pending':userPreempted?'interrupted':paused?'paused':stopped ? 'interrupted' : 'failed', error: manualRestart?'已切换为用户引导':userPreempted?'用户已切换到新对话':paused?'主动陪伴已暂停':String(error.message), finished: now() });if(task.todoId&&!manualRestart)Object.assign(s.todos.find(t=>t.id===task.todoId),{status:'failed',error:String(error.message)});if(automatic)s.initiative.lastOutcome=manualRestart?'user_steer':paused?'paused':stopped?'interrupted':'failed'; });
    } finally {
      // A lease outlives the turn that took it, so it is released HERE, before the task is
      // reported settled: an unattended companion must not leave the desktop in takeover.
      await releaseComputerUse(task.id);
      const settled = store.read().tasks.find(t => t.id === task.id);
      live.finish({ phase: liveOutcome(settled?.status), error: settled?.error ?? null });
      running = false;activeAutomatic=false;activeTask=null;guide=null;if(!stopped&&store.read().tasks.some(t=>t.kind==='chat'&&t.status==='pending'))queueMicrotask(()=>tick().catch(e=>logger?.warn?.(e.message)));
    }
  }
  function rotateForMessage(topic,text){
    const state=store.read(),env=environment();const reason=threadHandoff(state,now(),{topic,focused:readingUntil>now()||env.readerFocused,draft:state.attention?.[state.activeThreadId]?.draftUntil>now(),busy:state.tasks.some(t=>t.kind==='chat'&&['pending','running'].includes(t.status)),engagedAt});
    if(!shouldRotate(reason))return state.activeThreadId;
    const id=randomUUID();store.change(s=>{if(s.threads.length>=1000)throw Error('对话数量已达到上限');const old=s.threads.find(t=>t.id===s.activeThreadId);old.archived=true;old.archivedReason=reason;s.threads.push({id,title:topic||text.slice(0,32)||'新话题',created:now(),updated:now(),archived:false});s.lastThreadRotation={from:old.id,to:id,at:now(),reason};s.activeThreadId=id;});return id;
  }
  function probeInitiative(){
    const s=store.read(),env=environment();const gate=initiativeGate(s.settings,s.initiative,now(),{...env,busy:env.busy||s.tasks.some(t=>['pending','running'].includes(t.status))},engagedAt,bootReadyAt);
    if(!gate.allowed)return{ok:true,...gate};
    if(s.tasks.length>=2000||s.threads.length>=1000)return{ok:true,allowed:false,reason:'capacity'};
    const memoryKey=nativeMemory().key,marker=memoryMarker();const changed=memoryKey!==lastMemoryKey||marker!==lastMemoryMarker;
    const signals=(s.initiative.signals||[]).filter(signal=>now()-signal.at<DAY);const reason=signals.length?'file-change':changed?'memory-change':'check-in';
    const localDue=reason==='check-in'&&(!s.initiative.lastMessageAt?now()-s.initiative.enabledAt>=DAY:now()-s.initiative.lastMessageAt>=3*DAY);
    const greetings=['我在这儿。今天有没有想慢慢聊一聊的事？','想歇一会儿时，可以来和我聊聊；也可以一起把一件事理清。','如果最近有件事卡住了，可以说给我听，我们一点点来。'];
    const localText=localDue?greetings[(s.initiative.localChecks||0)%greetings.length]:'';
    const prompt=`主动陪伴稀疏检查，触发=${reason}。用户未主动发起也可在合适时简短自然地关心，但没有必要内容时 notify=false。不是强制问候；不要重复追问“在吗”、催促回复、重复上一条话题或假装知道用户正在做什么。最多两句话、240 字符；仅使用有效 MemoryLab 背景，过期记忆不可当当前事实。返回 notify、text，可附具体话题 topic。禁止唤起外部对话或执行工作；只可为用户明确委托创建确定时间的待办，不得为寒暄或无依据推测创建待办。未回应次数=${s.initiative.unanswered||0}。文件信号仅为浅层元数据，不是文件内容/完成证据：${JSON.stringify(signals)}。`;
    const task=enqueue(prompt);lastMemoryKey=memoryKey;lastMemoryMarker=marker;
    store.change(s=>{const t=s.tasks.find(t=>t.id===task.id);t.kind='self_activation';t.reason=reason;if(localText){t.localText=localText;s.initiative.localChecks=(s.initiative.localChecks||0)+1;}touchDay(s.initiative,now());if(!localText)s.initiative.attempts++;s.initiative.lastAttemptAt=now();s.initiative.nextAttemptAt=now()+nextGap(s.settings,s.initiative);s.initiative.signals=[];s.initiative.lastReason=localText?'gentle-presence':reason;});return{ok:true,allowed:true,id:task.id,reason};
  }
  // Interrupted runs are retained and await explicit retry: no automatic duplicate model spend.
  if (store.read().tasks.some(t => t.status === 'running')) store.change(s => { for (const t of s.tasks) if (t.status === 'running') { t.status = 'interrupted'; t.error = '宿主在任务完成前退出，可显式重试'; } });
  if(store.read().todos.some(t=>t.status==='activated'))store.change(s=>{for(const t of s.todos.filter(t=>t.status==='activated')){const message=s.messages.find(m=>m.id===t.taskId),task=s.tasks.find(task=>task.id===t.taskId);if(message){Object.assign(t,{status:'completed',completedAt:message.at,messageId:message.id});if(task)Object.assign(task,{status:'completed',finished:message.at});}else if(!task||['failed','interrupted','cancelled'].includes(task.status))Object.assign(t,{status:'failed',error:task?.error||'激活任务已中断，未自动重试'});}});
  /**
   * THE OPTION QUESTION: one at a time, blocking the run, answered from the page.
   *
   * Newmark's ask design is a tool-shaped question: the run stops at the call, the page renders an
   * option block, and the answer is the tool result, so the SAME run continues with the user's
   * choice. The heavy conversation kernel is deliberately not part of this: only the page
   * presentation and this one waiting seam are reused. A question is never durable - a restart
   * interrupts the run, so the page and the answer live in memory only.
   */
  let pendingAsk = null;
  function settleAsk(result) {
    const current = pendingAsk;
    if (!current) return null;
    pendingAsk = null;
    current.removeAbort?.();
    current.resolve(result);
    return current;
  }
  async function ask(args, execution) {
    if (pendingAsk) return { ok: false, code: 'question_already_pending', error: 'another question is already waiting for the user' };
    const question = typeof args?.question === 'string' ? args.question.trim() : '';
    const raw = Array.isArray(args?.options) ? args.options : [];
    const options = raw.map((option) => ({ label: String(option?.label ?? '').trim(), ...(typeof option?.description === 'string' && option.description.trim() ? { description: option.description.trim() } : {}) }));
    const problem = !question ? 'question is empty'
      : question.length > ASK_QUESTION_MAX_CHARS ? 'question is too long'
        : raw.length < ASK_MIN_OPTIONS ? 'at least ' + ASK_MIN_OPTIONS + ' options are required'
          : raw.length > ASK_MAX_OPTIONS ? 'at most ' + ASK_MAX_OPTIONS + ' options are allowed'
            : options.some((option) => !option.label || option.label.length > ASK_LABEL_MAX_CHARS) ? 'each option needs a non-empty label within the limit'
              : new Set(options.map((option) => option.label)).size !== options.length ? 'option labels must be unique' : '';
    if (problem) return { ok: false, code: 'invalid_question', error: problem };
    if (execution?.signal?.aborted) return { ok: false, code: 'question_aborted', error: 'the run was cancelled before the question was shown', questionId: null };
    const id = randomUUID();
    return new Promise((resolve) => {
      const onAbort = () => settleAsk({ ok: false, code: 'question_aborted', error: 'the run was cancelled before the user answered', questionId: id });
      execution?.signal?.addEventListener?.('abort', onAbort, { once: true });
      pendingAsk = { id, question, options, createdAt: now(), resolve, removeAbort: () => execution?.signal?.removeEventListener?.('abort', onAbort) };
    });
  }
  function answerQuestion(input) {
    if (!pendingAsk || pendingAsk.id !== String(input?.id ?? '')) return { ok: false, error: '没有等待回答的问题，或问题已过期' };
    const label = typeof input?.label === 'string' ? input.label : '';
    const text = typeof input?.text === 'string' ? input.text.trim() : '';
    let answer = null;
    if (label && pendingAsk.options.some((option) => option.label === label)) answer = { label };
    else if (text) answer = { text };
    else return { ok: false, error: '请选择一个选项或输入回答' };
    const current = settleAsk({ ok: true, questionId: pendingAsk.id, answer });
    return { ok: true, questionId: current.id, answer };
  }
  function pendingQuestion() {
    return pendingAsk ? { id: pendingAsk.id, question: pendingAsk.question, options: pendingAsk.options, allowsManual: true, createdAt: pendingAsk.createdAt } : null;
  }

  /** The monitor's knobs, read from NewMate's own settings so the settings page and the file agree. */
  function watchSettings(settings) {
    return {
      enabled: settings?.watchEnabled !== false,
      intervalMinutes: Number.isInteger(settings?.watchIntervalMinutes) ? Math.min(Math.max(settings.watchIntervalMinutes, 5), 1440) : MONITOR_DEFAULTS.intervalMinutes,
      // The threshold is not its own setting any more: it follows the initiative level, so "how
      // active am I" is one choice instead of two that can contradict each other.
      threshold: paceThreshold(settings?.pace),
      depth: Number.isInteger(settings?.watchDepth) ? Math.min(Math.max(settings.watchDepth, 0), 6) : MONITOR_DEFAULTS.depth,
      // How much a change made during a DSH turn still counts. 0 = ignore it entirely, 1 = no
      // distinction; the default 0.1 is the user's "大幅降低".
      dshWeight: typeof settings?.watchDshWeight === 'number' && Number.isFinite(settings.watchDshWeight) ? Math.min(Math.max(settings.watchDshWeight, 0), 1) : MONITOR_DEFAULTS.dshWeight,
    };
  }

  /**
   * ONE comparison pass: scan the workspaces, diff against the last snapshot, score, accumulate.
   *
   * Called once at start-up (the user's requirement 1) and on the interval (requirement 2). When the
   * accumulated score crosses the threshold it pushes ONE signal and asks the initiative gate for a
   * check-in - the same gate that governs every other unsolicited message, so quiet hours, pacing
   * and the daily budget still decide whether anything is said. The accumulator resets only on a
   * fire, so small changes add up (requirement 4).
   */
  function sweepWorkspaces(roots = []) {
    const state = store.read(), settings = state.settings, watch = watchSettings(settings);
    if (!watch.enabled) return { ok: true, skipped: 'disabled', intervalMinutes: watch.intervalMinutes };
    if (!settings.companion) return { ok: true, skipped: 'companion_off', intervalMinutes: watch.intervalMinutes };
    const monitored = (Array.isArray(roots) ? roots : []).filter((root) => typeof root === 'string' && path.isAbsolute(root)).slice(0, MONITOR_DEFAULTS.maxWorkspaces);
    if (!monitored.length) return { ok: true, skipped: 'no_workspace', intervalMinutes: watch.intervalMinutes };
    const previous = state.watch?.snapshots || {}, acc = Number(state.watch?.acc) || 0, at = now();
    const windows = Array.isArray(state.watch?.dshWindows) ? state.watch.dshWindows : [];
    const evaluated = evaluateWorkspaces({ roots: monitored, previous, settings: watch, at, windows });
    /**
     * TIME IS PART OF THE EVIDENCE, per the user's instruction to fuse "很久没有交流" with "文件变了".
     * The file score answers "did work happen"; the time score answers "has it been quiet for long
     * enough that a word is warranted". Each level decides how much an hour of quiet is worth
     * (timeWeight) and how much total evidence is needed (threshold), and there is no daily quota.
     */
    const pace = PACES[settings.pace] || PACES.balanced;
    const lastContact = Math.max(Number(state.initiative?.lastUserAt) || 0, Number(state.initiative?.lastMessageAt) || 0, Number(state.initiative?.lastReadAt) || 0, Number(state.initiative?.enabledAt) || 0);
    // Saturated at one day: "quiet since 1970" on a fresh install is not evidence of anything.
    const idleMs = Math.max(0, Math.min(DAY, at - lastContact));
    const timeScore = Math.min(1, idleMs / pace.gap) * paceTimeWeight(settings.pace);
    const score = Math.min(1, evaluated.score + timeScore);
    const settled = settle(acc, score, { threshold: watch.threshold });
    const fire = settled.fire && score > 0;
    const notable = evaluated.perWorkspace.filter((entry) => entry.changedNames > 0 || entry.countDelta > 0 || entry.timeDelta > 0);
    store.change((s) => {
      s.watch = {
        snapshots: evaluated.snapshots,
        acc: settled.accumulated,
        dshWindows: Array.isArray(s.watch?.dshWindows) ? s.watch.dshWindows : [],
        runs: (s.watch?.runs || 0) + 1,
        lastRunAt: at,
        lastScore: score,
        lastFileScore: evaluated.score,
        lastTimeScore: timeScore,
        lastIdleMs: idleMs,
        lastDescription: evaluated.description || '',
        lastEvent: fire ? { at, reached: settled.at, description: evaluated.description, workspaces: notable.map((entry) => ({ root: entry.root, added: entry.added, removed: entry.removed, changed: entry.changed, countDelta: entry.countDelta, timeDelta: entry.timeDelta })) } : (s.watch?.lastEvent || null),
      };
      if (fire) {
        const signals = (s.initiative.signals || []).filter((signal) => signal?.kind !== 'workspace-diff');
        signals.push({ kind: 'workspace-diff', at, score: Number(settled.at.toFixed(3)), fileScore: Number(evaluated.score.toFixed(3)), timeScore: Number(timeScore.toFixed(3)), idleMs, description: evaluated.description });
        s.initiative.signals = signals.slice(-8);
      }
    });
    if (fire) probeInitiative();
    return {
      ok: true, fired: fire, score: Number(score.toFixed(4)), fileScore: Number(evaluated.score.toFixed(4)), timeScore: Number(timeScore.toFixed(4)), idleMs,
      accumulated: Number(settled.accumulated.toFixed(4)),
      threshold: watch.threshold, at, description: evaluated.description,
      workspaces: evaluated.perWorkspace.map((entry) => ({ root: entry.root, first: entry.first, added: entry.added, removed: entry.removed, changed: entry.changed, user: entry.user, dsh: entry.dsh, dshWeight: entry.dshWeight, countDelta: entry.countDelta, timeDelta: entry.timeDelta })),
    };
  }

  /**
   * Record that a DSH turn is running in these workspace roots right now.
   *
   * The monitor cannot see WHO wrote a file, but it can see WHEN: a file whose mtime falls inside a
   * window when a turn was running is attributed to DSH and weighted down (default 0.1). Windows are
   * extended while turns keep running and pruned after a day, so the table cannot grow without bound.
   */
  function noteDshActivity(roots = [], at = now()) {
    const active = (Array.isArray(roots) ? roots : []).filter((root) => typeof root === 'string' && path.isAbsolute(root));
    if (!active.length) return { ok: true, windows: 0 };
    store.change((s) => {
      const windows = Array.isArray(s.watch?.dshWindows) ? s.watch.dshWindows.filter((window) => at - (Number(window.to) || 0) < DAY) : [];
      for (const root of active) {
        const open = windows.find((window) => window.root === root && at - (Number(window.to) || 0) <= 10000);
        if (open) open.to = Math.max(Number(open.to) || 0, at);
        else windows.push({ root, from: at, to: at });
      }
      s.watch = { ...(s.watch || {}), dshWindows: windows.slice(-64), dshActiveAt: at };
    });
    return { ok: true, windows: active.length };
  }

  /** The monitor as data, for the state route and the settings page. */
  function watchStatus() {
    const state = store.read(), watch = watchSettings(state.settings), monitored = state.watch || {};
    return {
      enabled: watch.enabled, intervalMinutes: watch.intervalMinutes, threshold: watch.threshold, thresholdFromPace: true, pace: state.settings.pace || 'balanced', depth: watch.depth, dshWeight: watch.dshWeight,
      companion: state.settings.companion === true, acc: Number(monitored.acc) || 0, runs: Number(monitored.runs) || 0,
      lastRunAt: monitored.lastRunAt || 0, lastScore: monitored.lastScore || 0, lastDescription: monitored.lastDescription || '',
      lastEvent: monitored.lastEvent || null, workspaces: Object.keys(monitored.snapshots || {}),
    };
  }

  return {
    sweepWorkspaces, watchStatus, noteDshActivity,
    todoAdd(input,execution,source='agent'){const value=todoInput(input,now()),id=randomUUID();store.change(s=>{if(s.todos.length>=2000||s.todos.filter(t=>['pending','delivering'].includes(t.status)).length>=100)throw Error('待办列表已达到容量上限');s.todos.push({id,...value,created:now(),status:'pending',source,origin:computerUseCaller(execution)||undefined});});return{ok:true,todo:store.read().todos.find(t=>t.id===id)};},
    todoList(){return{ok:true,todos:store.read().todos};},
    todoCancel(id){store.change(s=>{const t=s.todos.find(t=>t.id===id);if(!t||!['pending','failed'].includes(t.status))throw Error('该待办不存在、已投递或正在投递');t.status='cancelled';t.cancelledAt=now();delete t.deferred;});return{ok:true,id};},
    state: store.read, deliveryBlocker, deliveryReady, newmateIdle, loopStatus: () => live.snapshot(), ask, answerQuestion, pendingQuestion, enqueue, tick, initiativeStatus(){const s=store.read(),env=environment();return{...initiativeGate(s.settings,s.initiative,now(),{...env,busy:env.busy||running||s.tasks.some(t=>['pending','running'].includes(t.status))},engagedAt,bootReadyAt),nextAttemptAt:s.initiative.nextAttemptAt,lastReason:s.initiative.lastReason,lastOutcome:s.initiative.lastOutcome};},stop() { stopped = true; settleAsk({ ok: false, code: 'question_aborted', error: 'the companion stopped before the user answered', questionId: null }); active?.abort(); },
    async configure(settings) {
      if(!settings||Object.keys(settings).some(k=>!['companion','notifications','watchEnabled','watchIntervalMinutes','watchDepth','watchDshWeight',...Object.keys(INITIATIVE_DEFAULTS)].includes(k)))throw Error('陪伴设置无效');
      for(const [key,value]of Object.entries(settings)){if(['companion','notifications','initiative'].includes(key)&&typeof value!=='boolean')throw Error('开关无效');if(key==='pace'&&(typeof value!=='string'||!Object.hasOwn(PACES,value)))throw Error('陪伴频率无效');if(['quietStart','quietEnd'].includes(key)&&(!Number.isInteger(value)||value<0||value>23))throw Error('静默时间无效');if(key==='watchEnabled'&&typeof value!=='boolean')throw Error('监控开关无效');if(key==='watchIntervalMinutes'&&(!Number.isInteger(value)||value<5||value>1440))throw Error('监控间隔须为 5–1440 分钟');if(key==='watchThreshold')throw Error('监控阈值已并入主动性选择，请改 pace');if(key==='watchDepth'&&(!Number.isInteger(value)||value<0||value>6))throw Error('监控深度须为 0–6');if(key==='watchDshWeight'&&(!Number.isFinite(value)||value<0||value>1))throw Error('DSH 变动权重须在 0–1 之间');if(key==='snoozeUntil'&&(!Number.isFinite(value)||value<0||value>now()+7*DAY))throw Error('暂停期限无效');}
      const before=store.read().settings;store.change(s=>{Object.assign(s.settings,settings,{notifications:false});if(settings.companion===false||settings.initiative===false)for(const task of s.tasks)if(['measurement','self_activation'].includes(task.kind)&&task.status==='pending')task.status='paused';});
      if((settings.companion===true&&!before.companion)||(settings.initiative===true&&!before.initiative))store.change(s=>{s.initiative.enabledAt=now();s.initiative.nextAttemptAt=Math.max(s.initiative.nextAttemptAt||0,now()+20*MINUTE);});
      if((settings.companion===false||settings.initiative===false)&&activeAutomatic)active?.abort();
      try{if(settings.companion!==undefined)await onCompanion(settings.companion);}catch(error){store.change(s=>{s.settings=before;});throw error;}
      return{ok:true,settings:store.read().settings};
    },
    createThread() {const id=randomUUID();store.change(s=>{if(s.threads.length>=1000)throw Error('对话数量已达到上限');const previous=s.threads.find(t=>t.id===s.activeThreadId);if(previous)previous.archived=true;s.threads.push({id,title:'新对话',created:now(),updated:now(),archived:false});s.activeThreadId=id;});return{ok:true,id};},
    selectThread(id) {thread(id);return{ok:true};},
    renameThread() {throw Error('历史对话只读，不能编辑标题');},
    archiveThread() {throw Error('历史对话只读，不能修改或重新激活');},
    presence(focused,client,sequence,editing=false) {presence(focused,client,sequence);return{ok:true};},
    attention(id,editing,client='legacy',sequence=0){if(typeof editing!=='boolean'||typeof client!=='string'||!client||client.length>100||!Number.isFinite(sequence))throw Error('草稿状态无效');thread(id);const old=store.read().attention?.[id]?.draftClients?.[client];if(old&&sequence<=old.sequence)return{ok:true};store.change(s=>{s.attention ||= {};const a=s.attention[id] ||= {};a.draftClients ||= {};for(const [key,value]of Object.entries(a.draftClients))if(value.until<=now()&&key!==client)delete a.draftClients[key];if(Object.keys(a.draftClients).length>=64&&!a.draftClients[client])throw Error('草稿窗口过多');a.draftClients[client]={until:editing?now()+DAY:0,sequence};a.draftUntil=Math.max(0,...Object.values(a.draftClients).map(v=>v.until));});return{ok:true};},
    interaction(){return{running,taskId:activeTask?.id||null,steering:guide?.pending.length||0};},
    markRead(id,focused=false,client,sequence) {if(focused&&presence(true,client,sequence)===false)return{ok:true};if(store.read().messages.some(m=>m.threadId===id&&m.unread))store.change(s=>{if(focused&&id===s.activeThreadId&&s.messages.some(m=>m.threadId===id&&m.unread&&m.proactive)){s.initiative.unanswered=0;s.initiative.lastReadAt=now();s.initiative.nextAttemptAt=now()+(PACES[s.settings.pace]||PACES.balanced).gap;}for(const m of s.messages)if(m.threadId===id)m.unread=false;});return{ok:true};},
    async message(text,options={}) {
      if(!store.read().settings.companion)throw Error('陪伴开关未开启，主动消息已暂停');
      if(typeof text!=='string'||!text.trim()||text.length>16000)throw Error('消息须为 1–16000 字符');
      if(options.id!==undefined&&(typeof options.id!=='string'||!options.id||options.id.length>100))throw Error('主动消息标识须为 1–100 字符');
      if(options.summary!==undefined&&(typeof options.summary!=='string'||options.summary.length>100))throw Error('气泡摘要须为100字符以内');
      if(options.topic!==undefined&&(typeof options.topic!=='string'||options.topic.length>80))throw Error('话题须为80字符以内');
      const contentGate=proactiveMessageGate(text,false);
      if(contentGate)return{ok:true,suppressed:contentGate,interrupted:false};
      const id=options.id||randomUUID(),target=thread(options.threadId);
      if(store.read().messages.some(m=>m.id===id))return{ok:true,id,duplicate:true};
      const destination=rotateForMessage(options.topic||'',text);
      const message={id,threadId:destination,role:'assistant',text:text.trim(),summary:options.summary,at:now(),proactive:true,unread:true};
      store.change(s=>{s.messages.push(message);s.threads.find(t=>t.id===destination).updated=now();});const delivery=await notify(message);return{ok:true,id,...delivery};
    },
    memoryContext() { const value=nativeMemory(); return {key:value.key,tree:structuredClone(value.tree),tags:structuredClone(value.tags),shortMemory:structuredClone(value.shortMemory),shortMemoryTotal:value.shortMemoryTotal,shortMemoryOmitted:value.shortMemoryOmitted,tools:structuredClone(value.tools),toolsMissing:structuredClone(value.toolsMissing),cacheHits:value.cacheHits()}; },
    failure(where,error) { failures.record({where,code:error.code || 'newmate_failed',message:String(error.message)}); },
    /**
     * One user turn, from any entrance: the page, MCP newmate_chat, or the WeChat channel.
     *
     * The fourth argument is the only addition: a list of attachments the user handed over (see
     * lib/upload-store.js). It is optional, so every existing caller is unaffected, and an empty
     * message is legal only when at least one file came with it - a photo from the phone carries no
     * words, and refusing it would make the channel unable to accept the very thing this argument
     * exists for.
     *
     * The durable user message keeps the user's own words (text) and the files (attachments);
     * the TASK prompt keeps the words plus the block that describes them, built once here so a
     * steer, a queued merge and a fresh task all carry the same facts.
     */
    chat(text, execution, threadId, attachments) {
      const files=normalizeAttachments(attachments),words=typeof text==='string'?text:'';
      if(!files.length&&!words.trim())throw Error('消息须为 1–16000 字符');
      if(words.length>16000)throw Error('消息须为 1–16000 字符');
      const prompt=withAttachments(words,files);
      const selected=thread(threadId),caller=computerUseCaller(execution),origin=caller?.startsWith('dsh-session:')?caller.slice('dsh-session:'.length):undefined;
      const inputId=randomUUID();let task,mode='start';
      if(running&&activeTask?.threadId===selected.id&&activeTask.destination==='newmate'){
        if(guide.pending.length>=32||guide.pending.reduce((n,m)=>n+m.content[0].text.length,0)+prompt.length>32000)throw Error('当前引导过长，请等待当前回复处理');
        task={ok:true,id:activeTask.id};mode='steer';
        if(activeAutomatic){manualRestart=true;store.change(s=>{const t=s.tasks.find(t=>t.id===activeTask.id);t.kind='chat';t.prompt=prompt;if(origin)t.origin=origin;if(files.length)t.attachments=files;});active.abort();}
        else guide.pending.push({role:'user',content:[{type:'text',text:prompt}],timestamp:now()});
      }else{
        if(running&&activeTask?.destination==='newmate'&&activeTask.threadId!==selected.id){userPreempted=true;active.abort();}
        const pending=store.read().tasks.find(t=>t.kind==='chat'&&t.threadId===selected.id&&t.status==='pending');
        if(pending){task={ok:true,id:pending.id};mode='steer';store.change(s=>{const t=s.tasks.find(t=>t.id===pending.id);t.prompt=[t.prompt,prompt].filter(Boolean).join('\n');if(files.length)t.attachments=[...(t.attachments||[]),...files];});}
        else {task=enqueue(prompt,'newmate',randomUUID(),selected.id,{attachments:files});store.change(s=>{const t=s.tasks.find(t=>t.id===task.id);t.kind='chat';if(origin)t.origin=origin;});}
      }
      store.change(s=>{s.messages.push({role:'user',text:words,threadId:selected.id,at:now(),id:inputId,steerTaskId:task.id,...(files.length?{attachments:files}:{})});const p=s.initiative;p.lastUserAt=now();p.unanswered=0;p.nextAttemptAt=Math.max(p.nextAttemptAt||0,now()+45*MINUTE);s.attention ||= {};s.attention[selected.id]={...(s.attention[selected.id]||{}),lastFocusedAt:now(),draftUntil:0};const t=s.threads.find(t=>t.id===selected.id);t.updated=now();if(t.title==='新对话')t.title=(words.trim()||files[0].name).slice(0,32);});
      if(!running)queueMicrotask(()=>tick().catch(e=>logger?.warn?.(e.message)));return{...task,mode,inputId,...(files.length?{attachments:files.length}:{})};
    },
    /**
     * Store one file the user handed over, for either entrance (the page route and the WeChat
     * channel call this same method, so a byte bound cannot be enforced in one path only).
     */
    saveAttachment({ bytes, name, source = 'page' } = {}) {
      return saveUpload({ root, name, bytes, source, at: now() });
    },
    /**
     * Read one stored attachment. The containment rule lives in the store, not here: this method
     * exists so the model-facing tool and the page have exactly one reader to reason about.
     */
    readAttachment({ path: target, offset, limit } = {}) {
      return readUploadContent({ root, path: target, offset, limit });
    },
    retry(id) { store.change(s => { const t = s.tasks.find(t => t.id === id); if (!t || (t.todoId&&s.todos.find(todo=>todo.id===t.todoId)?.status==='cancelled') || t.threadId!==s.activeThreadId || ['measurement','self_activation'].includes(t.kind)|| !['failed','interrupted'].includes(t.status)) throw Error('历史/自动任务只读或任务不可重试'); t.status = 'pending'; delete t.error;if(t.todoId){const todo=s.todos.find(todo=>todo.id===t.todoId);if(todo){todo.status='activated';delete todo.error;}} }); return { ok: true }; },
    wake(prompt, execution) { return enqueue(prompt, currentConversation(execution)); },
    measure(directory, filename) {
      if(!store.read().settings.companion)return;
      if (!filename || path.basename(filename) !== filename) return;
      const target = path.join(directory, filename);
      let marker; try { const st = fs.lstatSync(target); if (!st.isFile()) return; marker = `${st.size}:${st.mtimeMs}`; } catch (e) { if (e.code !== 'ENOENT') return; marker = 'missing'; }
      const old = store.read().measurements[target]; if (old === marker) return;
      if (old === undefined && Object.keys(store.read().measurements).length >= 512) return;
      // Local metadata only. File contents are never copied into prompts implicitly.
      store.change(s => { s.measurements[target] = marker; });
      store.change(s=>{const signals=(s.initiative.signals||[]).filter(v=>v.path!==target);signals.push({path:target,marker,at:now()});s.initiative.signals=signals.slice(-8);});
      return { path: target, marker };
    },
  };
}
