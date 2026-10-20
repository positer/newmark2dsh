import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { durableState } from '../../lib/durable-state.js';
import { currentConversation, deliverConversation } from '../../lib/conversation-delivery.js';
import { classifyToolResult } from '../agent-api/lib/contract.js';
import { createErrorLog } from '../../lib/errors.js';
import { withNewMateContext } from '../../lib/newmate-context.js';
import { createMemoryContext } from './lib/memory-context.js';
import { computerUseCaller, withComputerUseCaller } from '../../lib/cu-caller.js';
import {PROACTIVE_STYLE,proactiveMessageGate} from './lib/proactive-message.js';
import {threadHandoff,shouldRotate} from './lib/thread-handoff.js';
import {todoInput,todoMessageId} from './lib/todo-list.js';
import {INITIATIVE_DEFAULTS,PACES,MINUTE,HOUR,DAY,initiativeGate,messageGate,nextGap,touchDay,recordMessage,isQuiet} from './lib/initiative.js';


/**
 * The tool group a NewMate run may use. ONE list, read three ways: it is the run's allow list, it
 * is the group whose schemas initialization describes, and it is what the gates compare against.
 *
 * Names only - never schemas - because the schema must come from the LIVE registry: a tool this
 * bundle registers and a tool a plugin provides are described the same way, and a name the
 * current exposure does not carry is reported as missing instead of being described as callable.
 * newmate_task is in the group but only allowed on turns bound to an origin conversation; the
 * persona states that condition, so the schema is not a grant.
 */
export const NEWMATE_RUN_TOOLS = Object.freeze([
  'memory_lab_read', 'memory_lab_query', 'memory_lab_root_tags', 'memory_lab_subtag_tree',
  'memory_lab_update', 'memory_lab_reindex', 'memory_lab_tag_review', 'memory_lab_tag_apply',
  'shortMemory_add', 'shortMemory_recall', 'shortMemory_where', 'shortMemory_size',
  'newmate_todo_add', 'newmate_todo_list', 'newmate_todo_cancel', 'newmate_task',
]);
export function createNewMate({ root, tools, agents, now = Date.now, logger, onNotify = async () => {}, onCompanion = async () => {}, onPresence = () => {}, environment=()=>({ready:true,idleMs:2*MINUTE}) }) {
  const failures = createErrorLog({root,logger});
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
  function todoActivationReady(){const s=store.read(),env=environment();return s.settings.companion&&!isQuiet(s.settings,now())&&!(s.settings.snoozeUntil>now())&&env.ready!==false&&!env.busy&&!env.readerFocused&&readingUntil<=now()&&env.idleMs>=MINUTE&&!(s.attention?.[s.activeThreadId]?.draftUntil>now());}
  async function deliverDueTodo(){
    const state=store.read();if(!state.settings.companion||state.tasks.some(t=>t.kind==='chat'&&['pending','running'].includes(t.status)))return;
    const item=state.todos.filter(t=>t.status==='pending'&&t.activateAt<=now()).sort((a,b)=>a.activateAt-b.activateAt||a.created-b.created)[0];if(!item)return;
    if(item.mode==='conversation'){
      if(!todoActivationReady())return;
      if(state.tasks.length>=2000||state.tasks.filter(t=>['pending','running'].includes(t.status)).length>=100)return;
      thread();const destination=rotateForMessage('todo',item.content),id=todoMessageId(item.id);
      store.change(s=>{const t=s.todos.find(t=>t.id===item.id);if(t?.status!=='pending')return;if(!s.tasks.some(task=>task.id===id))s.tasks.push({id,todoId:item.id,kind:'todo_activation',prompt:item.content,destination:'newmate',threadId:destination,status:'pending',created:now(),...(item.origin?.startsWith('dsh-session:')?{origin:item.origin.slice('dsh-session:'.length)}:{})});Object.assign(t,{status:'activated',activatedAt:now(),taskId:id,threadId:destination});});
      return;
    }
    let claimed=false;store.change(s=>{const t=s.todos.find(t=>t.id===item.id);if(t?.status==='pending'){t.status='delivering';claimed=true;}});if(!claimed)return;
    try{
      let message=store.read().messages.find(m=>m.id===todoMessageId(item.id));
      if(!message){thread();const destination=rotateForMessage('todo',item.content);message={id:todoMessageId(item.id),todoId:item.id,threadId:destination,role:'assistant',text:item.content,at:now(),proactive:true,unread:true};store.change(s=>{s.messages.push(message);s.threads.find(t=>t.id===destination).updated=now();});await notify(message);}
      store.change(s=>{Object.assign(s.todos.find(t=>t.id===item.id),{status:'delivered',deliveredAt:message.at,messageId:message.id,threadId:message.threadId});});
    }catch(error){const receipt=store.read().messages.find(m=>m.id===todoMessageId(item.id));store.change(s=>{Object.assign(s.todos.find(t=>t.id===item.id),receipt?{status:'delivered',deliveredAt:receipt.at,messageId:receipt.id,threadId:receipt.threadId}:{status:'failed',error:String(error.message)});});failures.record({where:'newmate/todo',code:'todo_delivery_failed',message:String(error.message)});}
  }
  const enqueue = (prompt, destination = 'newmate', id = randomUUID(), threadId) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw Error('任务内容须为 1–16000 字符');
    const targetThread=thread(threadId).id;
    store.change(s => {
      if (s.tasks.some(t => t.id === id)) return;
      if (s.tasks.filter(t => ['pending','running'].includes(t.status)).length >= 100 || s.tasks.length >= 2000) throw Error('持久任务队列已达到容量上限');
      s.tasks.push({ id, prompt, destination, threadId:targetThread, status: 'pending', created: now() });
    });
    return { ok: true, id };
  };
  async function tick() {
    if (running || stopped || todoDelivering) return;
    const todoState=store.read();if(todoState.settings.companion&&todoState.todos.some(t=>t.status==='pending'&&t.activateAt<=now())){todoDelivering=true;try{await deliverDueTodo();}finally{todoDelivering=false;}if(stopped)return;}
    if(now()-lastProbeAt>=MINUTE){lastProbeAt=now();probeInitiative();}
    const task = store.read().tasks.find(t => t.kind==='chat'&&t.status==='pending')||store.read().tasks.find(t => t.status === 'pending'&&(t.kind!=='todo_activation'||todoActivationReady()));
    if (!task) return;
    running = true; active = new AbortController();activeTask=task;manualRestart=false;userPreempted=false;guide={pending:[],drain(){return this.pending.splice(0);}};
    const automatic=task.kind==='measurement'||task.kind==='self_activation',delegated=task.kind==='todo_activation',unsolicited=task.kind!=='chat';activeAutomatic=automatic||delegated;
    try {
      if(automatic){const s=store.read();if(!s.settings.companion||!s.settings.initiative||task.threadId!==s.activeThreadId){store.change(s=>{Object.assign(s.tasks.find(t=>t.id===task.id),{status:'paused',finished:now()});});return;}}
      store.change(s => { s.tasks.find(t => t.id === task.id).status = 'running'; });
      if (task.destination !== 'newmate') await deliverConversation(agents(), task.destination, task, active.signal);
      else {
        const recent=store.read().messages.filter(m=>m.threadId===task.threadId);
        const history = automatic?recent.slice(-6).map(({role,text,at,proactive})=>({role,text:text.slice(0,500),at,proactive})):recent.slice(-12);
        const memory = nativeMemory();
        const outcome = task.localText?{isError:false,value:{ok:true,result:{structured:{notify:true,text:task.localText,topic:'gentle-presence'}}}}:await withComputerUseCaller(task.origin?{agent:{session:{id:task.origin}}}:undefined,()=>withNewMateContext({...memory,steer:{drain:()=>guide?.drain()||[],hasPending:()=>Boolean(guide?.pending.length)}},()=>tools.execute({ callId: `newmate:${task.id}`, name: 'agent_api_send', arguments: {
          prompt: `当前时间：${new Date(now()).toISOString()}；本机时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}。你可使用 newmate_todo_add/list/cancel 管理定时待办，创建必须有确定的激活时间（带时区 ISO）和要发送给用户的原文；缺少时间时先确认。仅为用户明确需求或可靠的已有委托创建，不凭空给用户安排事项。默认 mode=conversation，到期在合适时激活一轮 NewMate；仅需原文提醒时显式使用 mode=reminder，不调用模型。人格、完整 MemoryLab 标签树、全部短期记忆与记忆工具组 schema 已在最早的系统前缀注入。\n近期对话：${JSON.stringify(history)}\n当前任务：${task.prompt}${delegated?'\n这是用户预先安排的待办激活。现在运行这一轮，结合记忆和既有对话自然回应或处理上述明确委托；不要仅复述待办，不要为待办之外的事扩大授权。不是实时用户发问，不编造用户刚刚说了什么；只发送有用结果或具体下一步。任务失败不自动重试，不创建重复待办。':''}${unsolicited?'\n'+PROACTIVE_STYLE:''}${automatic?'\n输出协议：最终只输出一个合法 JSON 对象，不要 Markdown、代码围栏、说明文字或思考过程。只允许 notify（布尔）、text（字符串，最多240字符）、topic（可选字符串，最多80字符）三个键。例如 {"notify":false,"text":"","topic":"check-in"}。notify=true 时把实际发给用户的简短消息放入 text；没有合适内容时 notify=false，text=""。禁止在 JSON 之外输出任何内容。':''}`,
          tools: { allow: [...NEWMATE_RUN_TOOLS.filter((name)=>name!=='newmate_task'), ...(!automatic&&task.origin?['newmate_task']:[])] }, timeout_ms: automatic?45000:120000, max_steps: automatic?3:8,
          ...(automatic ? { output_schema: { type:'object',properties:{notify:{type:'boolean'},text:{type:'string',maxLength:240},topic:{type:'string',maxLength:80}},required:['notify','text'],additionalProperties:false } } : {}),
        }, signal: active.signal })));
        active.signal.throwIfAborted();
        // A guide arriving after the loop ended must never publish an obsolete answer.
        if(guide.pending.length){store.change(s=>{const t=s.tasks.find(t=>t.id===task.id);t.status='pending';t.prompt=guide.pending.map(m=>m.content[0].text).join('\n');});return;}
        const classified = classifyToolResult('agent_api_send', outcome);
        if (classified.exit !== 0) throw Error(classified.error || 'Agent API 调用失败');
        const envelope = classified.result;
        if (envelope?.ok !== true) throw Error(envelope?.error || 'Agent API 未完成任务');
        const decision = envelope.result?.structured;
        if(automatic&&(typeof decision?.notify!=='boolean'||typeof decision?.text!=='string'||(decision.topic!==undefined&&(typeof decision.topic!=='string'||decision.topic.length>80))))throw Error('主动判断未符合 notify/text/topic 协议');
        const answer = automatic ? decision?.text?.trim() : envelope.result?.output;
        if (typeof answer !== 'string' || (!answer && !unsolicited)) throw Error('Agent API 没有返回文本');
        const current=store.read(),topic=decision?.topic||task.reason||'check-in',latest=automatic?environment():{};
        if(delegated&&task.threadId!==current.activeThreadId)throw Error('待办运行期间已切换对话，回复未发布；可显式重试');
        const lateGate=automatic?(latest.ready===false?'runtime_unavailable':latest.busy?'busy':latest.readerFocused?'reading':latest.idleMs>=90*MINUTE?'away':latest.idleMs<MINUTE?'typing':''):'';
        const contentGate=unsolicited?proactiveMessageGate(answer):'';
        const suppression=contentGate||(automatic?(decision?.notify!==true||!answer?'not_actionable':task.threadId!==current.activeThreadId?'history_closed':lateGate||messageGate(current.settings,current.initiative,now(),answer,topic,engagedAt)):'');
        if(!suppression) {
          const destination=automatic?rotateForMessage(topic,answer):task.threadId;
          const message={id:task.id,threadId:destination,role:'assistant',text:answer,at:now(),proactive:automatic||delegated,autonomous:automatic,unread:true,...task.todoId?{todoId:task.todoId}: {}};
          store.change(s => { s.messages.push(message);const t=s.threads.find(t=>t.id===destination);if(t)t.updated=now();if(automatic){recordMessage(s.initiative,now(),answer,topic);s.initiative.nextAttemptAt=now()+nextGap(s.settings,s.initiative);s.initiative.lastOutcome='message';} });
          await notify(message);
        }else store.change(s=>{s.initiative.lastOutcome=suppression;s.tasks.find(t=>t.id===task.id).suppressed=suppression;});
      }
      store.change(s => { Object.assign(s.tasks.find(t => t.id === task.id),{status:'completed',finished:now()});if(task.todoId)Object.assign(s.todos.find(t=>t.id===task.todoId),{status:s.messages.some(m=>m.id===task.id)?'completed':'failed',completedAt:now(),messageId:s.messages.some(m=>m.id===task.id)?task.id:null,...!s.messages.some(m=>m.id===task.id)?{error:'运行已结束，但回复被主动消息格式规则抑制'}:{}}); });
    } catch (error) {
      const paused=automatic&&active.signal.aborted&&!stopped;
      if (!stopped&&!paused&&!manualRestart&&!userPreempted) failures.record({where:'newmate/task',code:error.code || 'task_failed',message:String(error.message),fields:{taskId:task.id}});
      store.change(s => { Object.assign(s.tasks.find(t => t.id === task.id), { status: manualRestart?'pending':userPreempted?'interrupted':paused?'paused':stopped ? 'interrupted' : 'failed', error: manualRestart?'已切换为用户引导':userPreempted?'用户已切换到新对话':paused?'主动陪伴已暂停':String(error.message), finished: now() });if(task.todoId&&!manualRestart)Object.assign(s.todos.find(t=>t.id===task.todoId),{status:'failed',error:String(error.message)});if(automatic)s.initiative.lastOutcome=manualRestart?'user_steer':paused?'paused':stopped?'interrupted':'failed'; });
    } finally { running = false;activeAutomatic=false;activeTask=null;guide=null;if(!stopped&&store.read().tasks.some(t=>t.kind==='chat'&&t.status==='pending'))queueMicrotask(()=>tick().catch(e=>logger?.warn?.(e.message))); }
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
  return {
    todoAdd(input,execution,source='agent'){const value=todoInput(input,now()),id=randomUUID();store.change(s=>{if(s.todos.length>=2000||s.todos.filter(t=>['pending','delivering'].includes(t.status)).length>=100)throw Error('待办列表已达到容量上限');s.todos.push({id,...value,created:now(),status:'pending',source,origin:computerUseCaller(execution)||undefined});});return{ok:true,todo:store.read().todos.find(t=>t.id===id)};},
    todoList(){return{ok:true,todos:store.read().todos};},
    todoCancel(id){store.change(s=>{const t=s.todos.find(t=>t.id===id);if(!t||!['pending','failed'].includes(t.status))throw Error('该待办不存在、已投递或正在投递');t.status='cancelled';t.cancelledAt=now();});return{ok:true,id};},
    state: store.read, enqueue, tick, initiativeStatus(){const s=store.read(),env=environment();return{...initiativeGate(s.settings,s.initiative,now(),{...env,busy:env.busy||running||s.tasks.some(t=>['pending','running'].includes(t.status))},engagedAt,bootReadyAt),nextAttemptAt:s.initiative.nextAttemptAt,lastReason:s.initiative.lastReason,lastOutcome:s.initiative.lastOutcome};},stop() { stopped = true; active?.abort(); },
    async configure(settings) {
      if(!settings||Object.keys(settings).some(k=>!['companion','notifications',...Object.keys(INITIATIVE_DEFAULTS)].includes(k)))throw Error('陪伴设置无效');
      for(const [key,value]of Object.entries(settings)){if(['companion','notifications','initiative'].includes(key)&&typeof value!=='boolean')throw Error('开关无效');if(key==='pace'&&(typeof value!=='string'||!Object.hasOwn(PACES,value)))throw Error('陪伴频率无效');if(['quietStart','quietEnd'].includes(key)&&(!Number.isInteger(value)||value<0||value>23))throw Error('静默时间无效');if(key==='snoozeUntil'&&(!Number.isFinite(value)||value<0||value>now()+7*DAY))throw Error('暂停期限无效');}
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
    chat(text, execution, threadId) {
      if(typeof text!=='string'||!text.trim()||text.length>16000)throw Error('消息须为 1–16000 字符');
      const selected=thread(threadId),caller=computerUseCaller(execution),origin=caller?.startsWith('dsh-session:')?caller.slice('dsh-session:'.length):undefined;
      const inputId=randomUUID();let task,mode='start';
      if(running&&activeTask?.threadId===selected.id&&activeTask.destination==='newmate'){
        if(guide.pending.length>=32||guide.pending.reduce((n,m)=>n+m.content[0].text.length,0)+text.length>32000)throw Error('当前引导过长，请等待当前回复处理');
        task={ok:true,id:activeTask.id};mode='steer';
        if(activeAutomatic){manualRestart=true;store.change(s=>{const t=s.tasks.find(t=>t.id===activeTask.id);t.kind='chat';t.prompt=text;if(origin)t.origin=origin;});active.abort();}
        else guide.pending.push({role:'user',content:[{type:'text',text}],timestamp:now()});
      }else{
        if(running&&activeTask?.destination==='newmate'&&activeTask.threadId!==selected.id){userPreempted=true;active.abort();}
        const pending=store.read().tasks.find(t=>t.kind==='chat'&&t.threadId===selected.id&&t.status==='pending');
        if(pending){task={ok:true,id:pending.id};mode='steer';store.change(s=>{s.tasks.find(t=>t.id===pending.id).prompt=text;});}
        else {task=enqueue(text,'newmate',randomUUID(),selected.id);store.change(s=>{const t=s.tasks.find(t=>t.id===task.id);t.kind='chat';if(origin)t.origin=origin;});}
      }
      store.change(s=>{s.messages.push({role:'user',text,threadId:selected.id,at:now(),id:inputId,steerTaskId:task.id});const p=s.initiative;p.lastUserAt=now();p.unanswered=0;p.nextAttemptAt=Math.max(p.nextAttemptAt||0,now()+45*MINUTE);s.attention ||= {};s.attention[selected.id]={...(s.attention[selected.id]||{}),lastFocusedAt:now(),draftUntil:0};const t=s.threads.find(t=>t.id===selected.id);t.updated=now();if(t.title==='新对话')t.title=text.trim().slice(0,32);});
      if(!running)queueMicrotask(()=>tick().catch(e=>logger?.warn?.(e.message)));return{...task,mode,inputId};
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
