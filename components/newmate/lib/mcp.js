import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
export const MCP_ROUTE='/newmark-newmate/mcp';
export function newMateCalls(mate) {
  const output={schema:{type:'object'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]};
  return [
    {name:'newmate_todo_add',description:'Create a persistent one-shot NewMate reminder with an explicit activation time and content. By default activate one NewMate conversation turn after attention/quiet/input guards clear. Use mode=reminder for exact saved text without a model call. Any conversation or NewMate may create it. Use an ISO timestamp with time zone; ask for a missing time. Pass repeat (every+unit, optional weekdays 1=Mon..7=Sun and at HH:MM, or a rule string like \"every 2 d on 1-5 at 09:00\") for a recurring reminder; without repeat it fires once. At due time a conversation activation waits for the full attention gate (companion on, NewMate itself idle, plus quiet hours, snooze, desktop, no DSH turn running, not reading, no draft, keyboard idle 60 s); a mode=reminder message waits only for the companion switch and NewMate being idle, because it costs no model call and interrupts no turn. Companion off postpones both, and the item records why it is waiting.',parameters:{type:'object',properties:{mode:{type:'string',enum:['conversation','reminder'],description:'conversation (default) activates one NewMate turn at a suitable time; reminder sends exact saved text without a model call.'},activateAt:{type:'string',description:'Future ISO timestamp with explicit Z or UTC offset.'},content:{type:'string',minLength:1,maxLength:16000},repeat:{type:'object',description:'Optional repeat rule. every+unit continue the reminder; weekdays restricts it to days of the week (1=Mon..7=Sun); at pins the clock (HH:MM); rule accepts a string such as "every 2 d on 1-5 at 09:00".',properties:{every:{type:'integer',minimum:1,maximum:10000},unit:{type:'string',enum:['min','h','d']},weekdays:{type:'array',items:{type:'integer',minimum:1,maximum:7}},at:{type:'string'},rule:{type:'string'}},additionalProperties:false}},required:['activateAt','content'],additionalProperties:false},execute:(a,e)=>mate.todoAdd(a,e)},
    {name:'newmate_todo_list',description:'Read NewMate reminders with activation time, exact content and pending/delivered/cancelled state.',parameters:{type:'object',properties:{},additionalProperties:false},execute:()=>mate.todoList()},
    {name:'newmate_todo_cancel',description:'Cancel an undelivered NewMate reminder; retains its audit entry and does not delete files or messages.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:a=>mate.todoCancel(a.id)},
    {name:'newmate_chat',description:'Ask the persistent NewMate companion. Returns a task ID; poll newmate_task_status for the response. The persona, the complete MemoryLab tag tree, all short memories and the run tool-group schemas are already injected.',parameters:{type:'object',properties:{prompt:{type:'string',minLength:1,maxLength:16000}},required:['prompt'],additionalProperties:false},execute:(a,execution)=>mate.chat(a.prompt,execution)},
    {name:'newmate_task_status',description:'Read one NewMate task, its companion response and the live agent-loop status of the current or last run: phase, model turn, completed tool calls, the tool executing now, elapsed time and the recent tool events. running is true only while a run is in flight.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:a=>{const state=mate.state();const task=state.tasks.find(t=>t.id===a.id);if(!task)throw Error('任务不存在');return{ok:true,task,messages:state.messages.filter(m=>m.id===a.id),agentLoop:mate.loopStatus()};}},
    {name:'newmate_message',description:'Send a proactive message to the user through NewMate and its desktop pet bubble. Do not send unsolicited capability or permission reports; these are suppressed. Requires the user companion switch enabled; no restart or file actions.',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:16000},id:{type:'string',maxLength:100},summary:{type:'string',maxLength:100},topic:{type:'string',maxLength:80}},required:['text'],additionalProperties:false},execute:(a,e)=>mate.message(a.text,{id:a.id||e?.callId,summary:a.summary,topic:a.topic})},
    {name:'newmate_memory_context',description:'Read the initialization payload NewMate runs with: its persona, the complete MemoryLab tag tree (every tag with parents/children/aliases, plus each memory node slug, name and tags), every short-memory row with its own expiry flag, and the schema of the run tool group as the live registry exposes it. toolsMissing names group tools the current exposure does not carry; they are not callable. Bodies stay out of it; read them with memory_lab_read.',parameters:{type:'object',properties:{},additionalProperties:false},execute:()=>({ok:true,...mate.memoryContext()})},
  ].map(tool=>({...tool,output}));
}
export function createNewMateMcp({root,mate,version='0.3.14'}) {
  const tokenFile=path.join(root,'newMate','mcp-token');
  const definitions=newMateCalls(mate);
  const token=()=>{try{return fs.readFileSync(tokenFile,'utf8').trim();}catch(e){if(e.code==='ENOENT')return '';throw e;}};
  const info=()=>{if(!token()){fs.mkdirSync(path.dirname(tokenFile),{recursive:true});try{fs.writeFileSync(tokenFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}return{ok:true,path:MCP_ROUTE,transport:'streamable-http',tokenFile,protocolVersions:['2025-06-18','2025-03-26']};};
  async function rpc(message) {
    const id=message?.id??null;
    const error=(code,text)=>({jsonrpc:'2.0',id,error:{code,message:text}});
    if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(message.id!==undefined&&typeof message.id!=='string'&&typeof message.id!=='number'))return error(-32600,'Invalid Request');
    if(message.id===undefined)return null;
    let result;
    switch(message.method){
      case 'initialize':result={protocolVersion:['2025-06-18','2025-03-26'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'newmark-newmate',version}};break;
      case 'ping':result={};break;
      case 'tools/list':result={tools:definitions.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters,outputSchema:{type:'object'}}))};break;
      case 'tools/call':{
        const tool=definitions.find(t=>t.name===message.params?.name);if(!tool)return error(-32602,'Unknown tool');
        const args=message.params?.arguments??{};
        if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!Object.hasOwn(tool.parameters.properties,k))||(tool.parameters.required||[]).some(k=>typeof args[k]!=='string'))return error(-32602,'Invalid tool arguments');
        try{const value=await tool.execute(args);result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false};}catch(e){result={content:[{type:'text',text:e.message}],isError:true};}break;
      }
      default:return error(-32601,'Method not found');
    }
    return{jsonrpc:'2.0',id,result};
  }
  return{info,rpc,definitions,async handler(req,res){
    const send=(status,value,extra={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra});res.end(value===undefined?'':JSON.stringify(value));};
    try{
      if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{return send(403,{error:'invalid_origin'});}if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.host!==req.headers.host)return send(403,{error:'invalid_origin'});}
      const expected=Buffer.from(token());const authorization=String(req.headers.authorization||'');const supplied=Buffer.from(authorization.startsWith('Bearer ')?authorization.slice(7):'');
      if(!expected.length||expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return send(401,{error:'unauthorized'},{'www-authenticate':'Bearer realm="NewMate"'});
      if(req.method!=='POST')return send(405,undefined,{allow:'POST'});
      const protocol=req.headers['mcp-protocol-version'];if(protocol&&!['2025-06-18','2025-03-26'].includes(protocol))return send(400,{error:'unsupported_protocol'});
      if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(415,{error:'content_type'});
      const accept=String(req.headers.accept||'');if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return send(406,{error:'accept'});
      const chunks=[];let bytes=0;for await(const chunk of req){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>32768)return send(413,{error:'body_too_large'});chunks.push(buffer);}const raw=Buffer.concat(chunks).toString('utf8');
      let message;try{message=JSON.parse(raw);}catch{return send(400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
      const value=await rpc(message);return send(value===null?202:200,value===null?undefined:value);
    }catch(e){return send(500,{error:e.message});}
  }};
}
