import fs from 'node:fs';
import path from 'node:path';
import {referencedFile,revealReferencedFile,readReferencedFile} from './lib/file-navigation.js';
import { createNewMate } from './component.js';
import { resolveRoot } from '../../lib/root.js';
import { embedJson } from '../../lib/embed.js';
import { schema } from '../../lib/schema.js';
import { createNewMateMcp, MCP_ROUTE } from './lib/mcp.js';
import { startDesktopPet, stopDesktopPet, companionPetEvents, notifyDesktopPet, updateDesktopPetFocus, claimDesktopPetNotice, updateDesktopPetTheme } from '../computeruse/lib/desktop-pet.js';
import { probeDesktop } from '../../lib/core-restart.js';
export const name = 'newmark-newmate';
export const inject = ['tools', 'webServer'];
export const SNAPSHOT_GLOBAL = '__NEWMARK_NEWMATE__';
export const Config = schema ? schema.object({ root: schema.string().default(''), watchRoot: schema.string().description('Explicit opt-in directory for shallow metadata-only file-change measurement. Empty disables watching.').default('') }) : undefined;
export function apply(ctx, config) {
  const core = ctx.get?.('newmarkComponents');
  let disposed=false,lastPetCommand='';
  let companionChange=Promise.resolve();
  const companion=enabled=>companionChange=companionChange.catch(()=>{}).then(async()=>{
    if(!enabled)return stopDesktopPet('companion_disabled','companion');
    const owner=process.platform==='darwin'?{path:process.execPath}:await probeDesktop();if(disposed)return;
    const answer=await startDesktopPet({usage:'companion',userRoot:resolveRoot(config),dshExe:owner.path});
    if(disposed){await stopDesktopPet('companion_disposed','companion');return;}
    if(!answer.ok)throw Error(answer.error||'陪伴桌宠未能启动');
    return answer;
  });
  const environment=()=>{const pet=companionPetEvents();let busy=false;try{const agents=ctx.get?.('agents')?.list?.()||[],jobs=ctx.get?.('jobs');busy=agents.some(a=>a.status==='running'||a.inbox?.nextTurn?.length>0||a.inbox?.nextStep?.length>0)||Boolean(jobs&&[undefined,...agents].some(a=>jobs.list(a?.id).some(j=>['running','stopping'].includes(j.status))));}catch{busy=true;}return{ready:pet.running&&pet.statusAgeMs<2000&&pet.window?.user_desktop_active===true,readerFocused:pet.window?.reader_focused===true,busy:busy||pet.window?.cu===true,idleMs:pet.window?.input_idle_ms??0};};
  const mate = createNewMate({ root: resolveRoot(config), tools: ctx.tools, agents: () => ctx.get?.('agents'), logger:ctx.logger,onCompanion:companion,onNotify:notifyDesktopPet,onPresence:updateDesktopPetFocus,environment });
  ctx.effect(()=>{if(mate.state().settings.companion)companion(true).catch(e=>mate.failure('newmate/pet',e));return()=>{disposed=true;stopDesktopPet('companion_disposed','companion').catch(e=>ctx.logger?.warn?.(e.message));};},'newmate-companion-pet');
  const mcp=createNewMateMcp({root:resolveRoot(config),mate});
  for(const definition of mcp.definitions)ctx.effect(()=>ctx.tools.register(definition),`newmate-call-${definition.name}`);
  ctx.effect(()=>ctx.tools.register({name:'newmate_mcp_info',description:'Enable the NewMate MCP credential and return its endpoint path and local token file. The token is not returned in chat.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:mcp.info}),'newmate-mcp-info');
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:MCP_ROUTE,handler:mcp.handler}),'newmate-mcp');
  if (core) core.newMate = mate;
  ctx.effect(() => () => { mate.stop(); if (core?.newMate === mate) delete core.newMate; }, 'newmate-bridge');
  ctx.effect(() => { const timer = setInterval(async()=>{try{const command=companionPetEvents().command;if(command?.id&&command.id!==lastPetCommand&&command.action==='stop-companion'){lastPetCommand=command.id;await mate.configure({companion:false});}await mate.tick();}catch(e){ctx.logger?.warn?.(e.message);}},1500); timer.unref?.(); return () => clearInterval(timer); }, 'newmate-worker');
  if (config?.watchRoot) ctx.effect(() => {
    const directory = fs.realpathSync(config.watchRoot); let timer; const pending = new Set();
    const watcher = fs.watch(directory, (_, file) => {
      if (file && pending.size < 256) pending.add(String(file)); clearTimeout(timer);
      timer = setTimeout(() => { for (const name of pending) mate.measure(directory, name); pending.clear(); }, 500); timer.unref?.();
    });
    watcher.on('error', e => mate.failure('newmate/measurement',e)); watcher.unref?.();
    return () => { watcher.close(); clearTimeout(timer); };
  }, 'newmate-sparse-files');
  for (const [toolName, action] of [['newmate_task', (a, e) => mate.wake(a.prompt, e)], ['newmate_state', () => mate.state()]]) {
    ctx.effect(() => ctx.tools.register({ name: toolName, description: toolName === 'newmate_task' ? 'Persist a task in NewMate and awaken only this DSH conversation. No deletion permission.' : 'Read NewMate persistent tasks and companion state.',
      parameters: { type: 'object', properties: toolName === 'newmate_task' ? { prompt: { type: 'string', maxLength: 16000 } } : {}, required: toolName === 'newmate_task' ? ['prompt'] : [], additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: action,
    }), `newmate-tool-${toolName}`);
  }
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', `<script>window.${SNAPSHOT_GLOBAL}=${embedJson({ ok: true })};</script></head>`)), 'newmate-presence');
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/newmark-newmate/events',handler:async(req,res)=>{res.writeHead(req.method==='GET'?200:405,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(req.method==='GET'?{ok:true,...companionPetEvents()}:{ok:false,error:'read_only'}));}}),'newmate-pet-events');
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/newmark-newmate/avatar.png',handler:async(req,res)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return;}res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=3600'});res.end(fs.readFileSync(new URL('../computeruse/assets/desktop-pet.png',import.meta.url)));}}),'newmate-avatar');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/newmark-newmate', handler: async (req, res) => {
    let status = 200, body;
    try {
      if (req.method === 'GET') body = { ok: true, ...mate.state(),pet:companionPetEvents(),initiativeStatus:mate.initiativeStatus(),interaction:mate.interaction() };
      else if (req.method === 'POST') {
        if (req.headers['x-newmark-newmate'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') throw Error('请求来源无效');
        const chunks=[];let bytes=0;for await(const chunk of req){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>64000)throw Error('请求过大');chunks.push(buffer);}const raw=Buffer.concat(chunks).toString('utf8');
        const input = JSON.parse(raw);
        switch(input.action){
          case 'theme':body=updateDesktopPetTheme(input.dark);break;
          case 'file-target':body={ok:true,path:referencedFile(mate.state().messages,input.id,input.path)};break;
          case 'file-content':body=readReferencedFile(mate.state().messages,input.id,input.path);break;
          case 'reveal-file':body=await revealReferencedFile({messages:mate.state().messages,id:input.id,target:input.path,controller:ctx.get?.('sessionController'),signal:new AbortController().signal});break;
          case 'claim-notification':body=claimDesktopPetNotice(input.id);break;
          case 'retry':body=mate.retry(input.id);break;
          case 'chat':body=mate.chat(input.text,undefined,input.threadId);break;
          case 'settings':body=await mate.configure(input.settings);break;
          case 'new-thread':body=mate.createThread();break;
          case 'select-thread':body=mate.selectThread(input.id);break;
          case 'rename-thread':body=mate.renameThread(input.id,input.title);break;
          case 'archive-thread':body=mate.archiveThread(input.id,input.archived);break;
          case 'read':body=mate.markRead(input.id,input.focused===true,input.client,input.sequence);break;
          case 'attention':body=mate.attention(input.id,input.editing,input.client,input.sequence);break;
          case 'presence':body=mate.presence(input.focused===true,input.client,input.sequence);break;
          default:throw Error('未知操作');
        }
      } else { status = 405; body = { ok: false, error: 'method_not_allowed' }; }
    } catch (e) { mate.failure('newmate/chat',e); status = 400; body = { ok: false, error: e.message }; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
  } }), 'newmate-chat');
}
