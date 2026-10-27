import fs from 'node:fs';
import path from 'node:path';
import {referencedFile,revealReferencedFile,readReferencedFile} from './lib/file-navigation.js';
import { createNewMate } from './component.js';
import { resolveRoot } from '../../lib/root.js';
import { embedJson } from '../../lib/embed.js';
import { schema } from '../../lib/schema.js';
import { createNewMateMcp, MCP_ROUTE } from './lib/mcp.js';
import { createNewMateSearch } from './lib/web-search.js';
import { createAskTool } from './lib/ask.js';
import { createConversationBridge } from './lib/conversations.js';
import { createWechatChannel } from './lib/wechat-channel.js';
import { MONITOR_DEFAULTS, dedupeRoots } from './lib/workspace-diff.js';
import { readCoreSelection } from '../agent-api/lib/core-model.js';
import { startDesktopPet, stopDesktopPet, companionPetEvents, notifyDesktopPet, updateDesktopPetFocus, claimDesktopPetNotice, updateDesktopPetTheme } from '../computeruse/lib/desktop-pet.js';
import { probeDesktop } from '../../lib/core-restart.js';
export const name = 'newmark-newmate';
export const inject = ['tools', 'webServer'];
export const SNAPSHOT_GLOBAL = '__NEWMARK_NEWMATE__';
export const Config = schema ? schema.object({
  root: schema.string().default(''),
  watchRoot: schema.string().description('Extra directory to monitor in addition to the DSH workspaces. The registered workspaces are always monitored, so this is only for a folder that is not registered.').default(''),
  watchEnabled: schema.boolean().description('Compare the workspaces at start-up and on the interval, and let a large enough change start one proactive check-in.').default(true),
  watchIntervalMinutes: schema.number().description('Minutes between two comparisons (requirement: 30 by default). The NewMate settings page can change it at runtime.').default(MONITOR_DEFAULTS.intervalMinutes),
  watchThreshold: schema.number().description('Accumulated weighted score (0.05-1) that triggers one proactive response.').default(MONITOR_DEFAULTS.threshold),
  watchDepth: schema.number().description('How deep inside each workspace to walk: 0 = the folder itself only, default 3.').default(MONITOR_DEFAULTS.depth),
}) : undefined;
export function apply(ctx, config) {
  /** One-shot diagnostic: what the host compaction service exposes in this row scope. */
  const compactionProbe = () => { const service = ctx.get?.("compaction"); if (!service) return { present: false }; const keys = Object.keys(service); return { present: true, type: typeof service, keys, methods: keys.filter((key) => typeof service[key] === "function").map((key) => key + "/" + String(service[key]).slice(0, 160)) }; };
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
  const mate = createNewMate({ root: resolveRoot(config), tools: ctx.tools, agents: () => ctx.get?.('agents'), goals: () => ctx.get?.('goals'), logger:ctx.logger,onCompanion:companion,onNotify:notifyDesktopPet,onPresence:updateDesktopPetFocus,environment });
  /**
   * The WeChat ClawBot channel. Driven from the settings page (one button, two states) and
   * independent of the companion switches: it only ever forwards the final reply of a run the
   * WeChat message itself started, and it never sends a proactive message.
   */
  const wechat = createWechatChannel({ root: resolveRoot(config), mate, log: (line) => ctx.logger?.info?.(line) });
  ctx.effect(()=>{if(mate.state().settings.companion)companion(true).catch(e=>mate.failure('newmate/pet',e));return()=>{disposed=true;stopDesktopPet('companion_disposed','companion').catch(e=>ctx.logger?.warn?.(e.message));};},'newmate-companion-pet');
  /**
   * NewMate's own window onto DSH's native web search. Registered as a tool (not composed into a
   * run) because an agent-api run can only dispatch names the registry carries; the search
   * backend is resolved at call time, preferring the host's ctx.web seam and falling back to the
   * native official provider when the seam is not reachable from a plugin scope.
   */
  const search=createNewMateSearch({ services:()=>({ web: typeof ctx.get==='function'?ctx.get('web'):undefined, credentials: typeof ctx.get==='function'?ctx.get('credentials'):undefined }), env:process.env });

  /**
   * NewMate's conversation tools: they act on real DSH conversations, so they are private tools of
   * this companion rather than registrations every agent can see. Each service is read lazily, so a
   * host that does not carry one (persistence absent, no preset service) refuses by name instead of
   * failing to mount.
   */
  const conversations=createConversationBridge({services:{agents:()=>ctx.get?.('agents'),presets:()=>ctx.get?.('agentPresets'),workspaces:()=>ctx.get?.('workspaceRegistry'),persistence:()=>ctx.get?.('sessionPersistence'),goals:()=>ctx.get?.('goals'),model:()=>{const selection=readCoreSelection({core});return selection?.ok?{provider:selection.provider,model:selection.model,...selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{}}:undefined;}},log:(where,error)=>ctx.logger?.warn?.(where+': '+error?.message)});
  const privateTools={...(globalThis[Symbol.for("newmark.newmate.privateTools")] || {})};
  for(const definition of conversations.definitions)privateTools[definition.name]=definition;
  globalThis[Symbol.for("newmark.newmate.privateTools")] = { ...privateTools, newmate_search: search.definition, compact_context: { name: "compact_context", description: "Compress earlier turns into the summary you provide; the run loop replaces its own history.", parameters: { type: "object", properties: { summary: { type: "string", minLength: 1, maxLength: 12000 }, keepRecent: { type: "integer", minimum: 2, maximum: 40 } }, required: ["summary"], additionalProperties: false }, execute: () => ({ ok: false, error: "compact_context is applied by the run loop" }) } };
  const mcp=createNewMateMcp({root:resolveRoot(config),mate});
  for(const definition of mcp.definitions)ctx.effect(()=>ctx.tools.register(definition),`newmate-call-${definition.name}`);
  ctx.effect(()=>ctx.tools.register({name:'newmate_mcp_info',description:'Enable the NewMate MCP credential and return its endpoint path and local token file. The token is not returned in chat.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:mcp.info}),'newmate-mcp-info');
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:MCP_ROUTE,handler:mcp.handler}),'newmate-mcp');
  if (core) core.newMate = mate;
  ctx.effect(() => () => { mate.stop(); wechat.stop().catch(e=>ctx.logger?.warn?.(e.message)); conversations.stop().catch(e=>ctx.logger?.warn?.(e.message)); if (core?.newMate === mate) delete core.newMate; }, 'newmate-bridge');
  /**
   * A stored WeChat session resumes by itself after a boot or a plugin update: no QR, no user
   * action. Without this the channel looks connected (the state file says so) while receiving
   * nothing, which is exactly the silent failure a restart used to produce.
   */
  ctx.effect(() => { const timer = setTimeout(() => { try { wechat.resume(); } catch (e) { ctx.logger?.warn?.('newmate/wechat-resume: ' + e.message); } }, 4000); timer.unref?.(); return () => clearTimeout(timer); }, 'newmate-wechat-resume');
  ctx.effect(() => { const timer = setInterval(async()=>{try{const command=companionPetEvents().command;if(command?.id&&command.id!==lastPetCommand&&command.action==='stop-companion'){lastPetCommand=command.id;await mate.configure({companion:false});}await mate.tick();}catch(e){ctx.logger?.warn?.(e.message);}},1500); timer.unref?.(); return () => clearInterval(timer); }, 'newmate-worker');
  /**
   * Sparse measurement of the DSH workspaces themselves.
   *
   * The user's requirement is that the companion watch the workspaces it is actually working in,
   * not a directory that had to be typed into a config field first. So the roots are read from the
   * host's workspace registry on every refresh (a workspace added in the GUI is picked up without a
   * restart); ~watchRoot~ stays as an EXTRA root for a folder that is not registered.
   *
   * The watcher is metadata-only and bounded (depth, directory cap, debounce, ignore list); the
   * decision to speak is not made here - it is made by the initiative gate, whose default answer is
   * silence. Measurement itself is a no-op while the companion switch is off, so watching costs
   * two syscalls per event and never becomes background reasoning.
   */
  const monitorRoots = async () => {
    const roots = [];
    if (typeof config?.watchRoot === 'string' && config.watchRoot.trim()) roots.push(config.watchRoot);
    try {
      const registry = ctx.get?.('workspaceRegistry');
      const list = await registry?.list?.();
      for (const entry of Array.isArray(list) ? list : []) if (typeof entry?.path === 'string') roots.push(entry.path);
    } catch (e) { ctx.logger?.warn?.('newmate/watch-roots: ' + e.message); }
    // Registered workspaces can nest; the topmost one covers the rest (dedupeRoots says why).
    return dedupeRoots(roots);
  };
  // The four knobs may also arrive from the plugin config; they are applied ONCE as the initial
  // value and from then on the NewMate settings page (persisted in state.json) is the authority.
  // A config field that silently overrode a runtime choice on every mount would make the settings
  // page a suggestion.
  ctx.effect(() => {
    const seed = {};
    if (typeof config?.watchEnabled === 'boolean') seed.watchEnabled = config.watchEnabled;
    if (Number.isInteger(config?.watchIntervalMinutes) && config.watchIntervalMinutes >= 5) seed.watchIntervalMinutes = config.watchIntervalMinutes;
    if (typeof config?.watchThreshold === 'number' && config.watchThreshold >= 0.05 && config.watchThreshold <= 1) seed.watchThreshold = config.watchThreshold;
    if (Number.isInteger(config?.watchDepth) && config.watchDepth >= 0) seed.watchDepth = config.watchDepth;
    if (Object.keys(seed).length) mate.configure(seed).catch(e => ctx.logger?.warn?.('newmate/watch-config: ' + e.message));
  }, 'newmate-watch-config');
  /**
   * The comparison schedule: once at start-up, then every interval.
   *
   * Start-up gets a short delay rather than running inside mount: a scan competes with everything
   * else the host is doing while it boots, and the first snapshot is only useful once the state file
   * has been read. The interval is re-read after every pass, so changing it in the settings page
   * takes effect without a restart.
   */
  /**
   * Which workspaces have a DSH turn running right now.
   *
   * This is the evidence the monitor uses to discount agent-caused changes: a file written while a
   * turn was running in that folder is almost certainly the agent's own write. The sampler runs on
   * its own short interval (a turn can be short) and caches the workspace list for a minute so it is
   * not re-reading the registry every five seconds.
   */
  ctx.effect(() => {
    let disposed = false, roots = [], rootsAt = 0;
    const sample = async () => {
      if (disposed) return;
      try {
        const nowMs = Date.now();
        if (!roots.length || nowMs - rootsAt > 60000) { roots = await monitorRoots(); rootsAt = nowMs; }
        if (disposed || !roots.length) return;
        const agents = ctx.get?.('agents');
        const running = (agents?.list?.() || []).filter((agent) => agent?.status === 'running');
        const active = new Set();
        for (const agent of running) {
          const cwd = agent?.session?.header?.cwd;
          if (typeof cwd !== 'string') continue;
          // The MOST SPECIFIC root, not every ancestor: a turn inside …/Code/Newmark Agent must not
          // mark …/Code as agent-active, or the user's own edits in the parent get discounted.
          const match = roots.filter((root) => cwd === root || cwd.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0];
          if (match) active.add(match);
        }
        if (active.size) mate.noteDshActivity([...active], nowMs);
      } catch (e) { ctx.logger?.warn?.('newmate/dsh-activity: ' + e.message); }
    };
    const timer = setInterval(sample, 5000); timer.unref?.();
    sample();
    return () => { disposed = true; clearInterval(timer); };
  }, 'newmate-dsh-activity');
  ctx.effect(() => {
    let disposed = false, timer;
    const run = async () => {
      if (disposed) return;
      try {
        const roots = await monitorRoots();
        if (disposed) return;
        const result = mate.sweepWorkspaces(roots);
        if (result?.skipped === 'no_workspace') ctx.logger?.warn?.('newmate/monitor: no workspace root was resolved; nothing is being compared');
      } catch (e) { ctx.logger?.warn?.('newmate/monitor: ' + e.message); }
    };
    const boot = setTimeout(run, 15000); boot.unref?.();
    const schedule = () => {
      const status = mate.watchStatus();
      timer = setTimeout(async () => { await run(); if (!disposed) schedule(); }, Math.max(5, status.intervalMinutes) * 60000);
      timer.unref?.();
    };
    schedule();
    return () => { disposed = true; clearTimeout(boot); clearTimeout(timer); };
  }, 'newmate-workspace-monitor');
  for (const [toolName, action] of [['newmate_task', (a, e) => mate.wake(a.prompt, e)], ['newmate_state', () => ({ ...mate.state(), agentLoop: mate.loopStatus(), question: mate.pendingQuestion(), watch: mate.watchStatus() })]]) {
    ctx.effect(() => ctx.tools.register({ name: toolName, description: toolName === 'newmate_task' ? 'Persist a task in NewMate and awaken only this DSH conversation. No deletion permission.' : 'Read NewMate persistent tasks, companion state and the live agent-loop status of the current or last run (phase, model turn, tool calls, current tool, recent tool events).',
      parameters: { type: 'object', properties: toolName === 'newmate_task' ? { prompt: { type: 'string', maxLength: 16000 } } : {}, required: toolName === 'newmate_task' ? ['prompt'] : [], additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: action,
    }), `newmate-tool-${toolName}`);
  }
  ctx.effect(() => ctx.tools.register(createAskTool(mate)), 'newmate-ask');
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', `<script>window.${SNAPSHOT_GLOBAL}=${embedJson({ ok: true })};</script></head>`)), 'newmate-presence');
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/newmark-newmate/events',handler:async(req,res)=>{res.writeHead(req.method==='GET'?200:405,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(req.method==='GET'?{ok:true,...companionPetEvents()}:{ok:false,error:'read_only'}));}}),'newmate-pet-events');
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/newmark-newmate/avatar.png',handler:async(req,res)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return;}res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=3600'});res.end(fs.readFileSync(new URL('../computeruse/assets/desktop-pet.png',import.meta.url)));}}),'newmate-avatar');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/newmark-newmate/loop', handler: async (req, res) => { if (req.method !== 'GET') { res.writeHead(405); res.end(); return; } res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, agentLoop: mate.loopStatus(), question: mate.pendingQuestion() })); } }), 'newmate-loop-route');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/newmark-newmate', handler: async (req, res) => {
    let status = 200, body;
    try {
      if (req.method === 'GET') body = { ok: true, ...mate.state(),pet:companionPetEvents(),initiativeStatus:mate.initiativeStatus(),interaction:mate.interaction(),agentLoop:mate.loopStatus(),question:mate.pendingQuestion(),compactionProbe:compactionProbe(),watch:mate.watchStatus(),wechat:wechat.status() };
      else if (req.method === 'POST') {
        if (req.headers['x-newmark-newmate'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') throw Error('请求来源无效');
        const chunks=[];let bytes=0;for await(const chunk of req){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>64000)throw Error('请求过大');chunks.push(buffer);}const raw=Buffer.concat(chunks).toString('utf8');
        const input = JSON.parse(raw);
        switch(input.action){
          case 'todo-add':body=mate.todoAdd({activateAt:input.activateAt,content:input.content,mode:input.mode,repeat:input.repeat},undefined,'user');break;
          case 'todo-list':body=mate.todoList();break;
          case 'todo-cancel':body=mate.todoCancel(input.id);break;
          case 'theme':body=updateDesktopPetTheme(input.dark);break;
          case 'file-target':body={ok:true,path:referencedFile(mate.state().messages,input.id,input.path)};break;
          case 'file-content':body=readReferencedFile(mate.state().messages,input.id,input.path);break;
          case 'reveal-file':body=await revealReferencedFile({messages:mate.state().messages,id:input.id,target:input.path,controller:ctx.get?.('sessionController'),signal:new AbortController().signal});break;
          case 'claim-notification':body=claimDesktopPetNotice(input.id);break;
          case 'retry':body=mate.retry(input.id);break;
          case 'chat':body=mate.chat(input.text,undefined,input.threadId);break;
          case 'wechat-connect':body=await wechat.connect();break;
          case 'wechat-logout':wechat.logout();body=wechat.status();break;
          case 'answer-question':body=mate.answerQuestion(input);break;
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
