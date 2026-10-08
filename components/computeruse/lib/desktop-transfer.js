/** Native presentation bridges. The manifest always identifies the original PID/start time. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(os.tmpdir(),'newmark2dsh-computer-use','transfers');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const alive=pid=>{try{process.kill(Number(pid),0);return true;}catch{return false;}};
function write(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}
let compiling;
let buildInfo;
function nativeBuild(){
  if(buildInfo)return buildInfo;
  const sources=['desktop-pet.cs','desktop-menu.cs','desktop-transfer.cs'].map(name=>path.join(here,name));
  const vendor=path.resolve(here,'../vendor/webview2'),dlls=['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'];
  const hash=crypto.createHash('sha256');for(const file of [...sources,...dlls.map(name=>path.join(vendor,name))])hash.update(fs.readFileSync(file));
  const dir=path.join(root,'bin',hash.digest('hex').slice(0,20));
  return buildInfo={sources,vendor,dlls,dir,exe:path.join(dir,'newmark-transfer.exe')};
}
function sameBroker(status){
  if(!status.start)return false;
  try{const {exe}=nativeBuild();return fs.existsSync(exe)&&execFileSync(exe,['--identity',String(status.pid)],{encoding:'utf8',windowsHide:true,timeout:2000}).trim()===String(status.start);}catch{return false;}
}
export async function compileDesktopTransfer(){
  if(compiling)return compiling;
  compiling=(async()=>{
    const {sources,vendor,dlls,dir,exe}=nativeBuild();fs.mkdirSync(dir,{recursive:true});
    for(const name of dlls)if(!fs.existsSync(path.join(dir,name)))fs.copyFileSync(path.join(vendor,name),path.join(dir,name));
    if(fs.existsSync(exe))return exe;
    const candidate=path.join(dir,`transfer-${process.pid}-${crypto.randomUUID()}.exe`);
    try{await new Promise((resolve,reject)=>{
      const compiler=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
      const child=spawn(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/main:TransferProgram','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',...dlls.slice(0,2).map(name=>`/r:${path.join(dir,name)}`),`/out:${candidate}`,...sources],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
      const timer=setTimeout(()=>{child.kill();reject(Error('Transfer compiler timed out'));},30000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(output));});
    });try{fs.renameSync(candidate,exe);}catch(error){if(!fs.existsSync(exe))throw error;}}finally{fs.rmSync(candidate,{force:true});}return exe;
  })();try{return await compiling;}catch(error){compiling=null;throw error;}
}
function launch(exe,mode,file){const child=spawn(exe,[mode,file],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();return child;}
export async function inspectTransferSource(config){
  const exe=await compileDesktopTransfer(),directory=path.join(root,'inspect-'+crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'config.json');write(file,{...config,directory});const child=launch(exe,'--inspect',file);
  for(let i=0;i<200;i++){const result=read(path.join(directory,'inspection.json'));if(result)return result;const fatal=read(path.join(directory,'fatal.json'));if(fatal)throw Error(fatal.error);if(child.exitCode!==null)throw Error('Source inspection failed');await sleep(50);}child.kill();throw Error('Source inspection timed out');
}
async function waitFor(directory,predicate,timeout=15000){
  const start=Date.now();while(Date.now()-start<timeout){const state=read(path.join(directory,'status.json'));if(state&&predicate(state))return state;const fatal=read(path.join(directory,'fatal.json'));if(fatal)throw Error(fatal.error);if(state?.state==='error')throw Error(state.error);await sleep(50);}throw Error('Transfer native host did not reach the requested state');
}
export function desktopTransfers(directoryRoot=root){
  if(!fs.existsSync(directoryRoot))return [];
  return fs.readdirSync(directoryRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name!=='bin').map(entry=>{
    const directory=path.join(directoryRoot,entry.name),config=read(path.join(directory,'config.json')),status=read(path.join(directory,'status.json'));
    // A delayed paint/control thread is not a vanished mapping. Retain its
    // identity so return/cleanup can still address the original process; the
    // command handshake separately proves that the broker answered.
    if(!config||!status||!['prepared','concealing','concealed','active','parked'].includes(status.state)||!alive(status.pid))return null;
    // Old records may refer to a PID reused by an unrelated app. A stale
    // heartbeat is accepted only after checking its recorded creation time.
    if(!(Date.now()-Date.parse(status.utc)<=5000)&&!sameBroker(status))return null;
    return {directory,config,status};
  }).filter(Boolean);
}
export function transferReport(record){const {config:c,status:s}=record;return {transfer_id:c.id,original_process_id:c.sourcePid,original_process_start:c.sourceStart,original_window_handle:c.sourceHandle,original_desktop:c.sourceDesktop,presentation_desktop:s.target_desktop,presentation_side:s.side,window_handle:s.hwnd,proxy_process_id:s.pid,owner_id:c.ownerId,original_process_restarted:false,native_window_migrated:false,interactive_mapping:true,delivery:'posted-window-messages',frames:s.frames,state:s.state};}
export function findDesktopTransfer({transferId,windowHandle,processId}={}){
  const normalize=h=>{try{return BigInt(String(h).toLowerCase().startsWith('0x')?String(h):'0x'+String(h)).toString(16);}catch{return '';}};
  const records=desktopTransfers().filter(r=>transferId?r.config.id===transferId:windowHandle?[r.status.hwnd,r.config.sourceHandle].some(h=>normalize(h)===normalize(windowHandle)):processId?[r.config.sourcePid,r.status.pid].includes(Number(processId)):false);
  if(records.length>1)throw Error('Multiple presentations match this process; specify one transfer_id or window_handle.');
  return records[0]||null;
}
export async function transferCommand(record,op){
  const id=crypto.randomUUID();write(path.join(record.directory,'command.json'),{id,op});
  const state=await waitFor(record.directory,s=>s.last_command===id&&(op==='conceal'?s.state==='concealed':op==='show'?s.state==='active':op==='park'?s.state==='parked':op==='return'?s.state==='returned':op==='handoff'?s.state==='handed-off':true));
  record.status=state;return state;
}
export async function animateDesktopTransfer(record,direction,anchor,bounds){
  const exe=await compileDesktopTransfer();const directory=path.join(record.directory,'animation-'+crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
  const config={...record.config,directory,anchorX:Math.round(anchor.x),anchorY:Math.round(anchor.y),animationDesktop:anchor.layer?.desktop||record.config.sourceDesktop,animationPrevious:anchor.layer?.previous||'0x0',animationTopmost:!!anchor.layer?.topmost,...bounds,animation:direction,image:path.join(record.directory,'frame.png')};
  const file=path.join(directory,'config.json');write(file,config);const child=launch(exe,'--animate',file);
  const start=Date.now();while(Date.now()-start<16000){const result=read(path.join(directory,'animation-result.json'));if(result?.completed)return result;const error=read(path.join(directory,'animation-error.json'))||read(path.join(directory,'fatal.json'));if(error)throw Error(error.error);if(child.exitCode!==null)throw Error('Transfer animation exited before completing');await sleep(40);}child.kill();throw Error('Transfer animation timed out');
}
export async function startDesktopTransfer(config,{anchor,animate=true}={}){
  const exe=await compileDesktopTransfer(),id=crypto.randomUUID(),directory=path.join(root,id);fs.mkdirSync(directory,{recursive:true});
  const native={...config,id,directory,ownerPid:process.pid};const file=path.join(directory,'config.json');write(file,native);
  const child=launch(exe,'--broker',file);let record;
  try{
    const prepared=await waitFor(directory,s=>s.state==='prepared');record={directory,config:native,status:prepared};
    const guardian={...native,brokerPid:prepared.pid,brokerStart:prepared.start,jobSourcePid:prepared.job_handle!=='0x0'?prepared.pid:0,jobSourceStart:prepared.start,jobHandle:prepared.job_handle};
    const guardianFile=path.join(directory,'guardian-config.json');write(guardianFile,guardian);launch(exe,'--guardian',guardianFile);
    let guard;for(let i=0;i<100;i++){guard=read(path.join(directory,'guardian.json'));if(guard?.ready)break;await sleep(50);}if(!guard?.ready)throw Error('Transfer lifetime guardian did not become ready');
    await transferCommand(record,'conceal');
    const animation=animate?await animateDesktopTransfer(record,native.side==='real'?'out':'in',anchor,{x:native.x,y:native.y,width:native.width,height:native.height}):null;
    await transferCommand(record,'show');return {record,animation};
  }catch(error){if(record){try{await transferCommand(record,'return');}catch{child.kill();}}else child.kill();throw error;}
}
export async function returnDesktopTransfer(record,{anchor,animate=true}={}){
  const bounds=record.status.side==='real'?record.status.bounds:{x:record.config.x,y:record.config.y,width:record.config.width,height:record.config.height};
  await transferCommand(record,'park');let animation;
  try{animation=animate?await animateDesktopTransfer(record,record.status.side==='real'?'in':'out',anchor,bounds):null;}catch(error){await transferCommand(record,'show');throw error;}
  await transferCommand(record,'return');return {animation,original_process_id:record.config.sourcePid,original_process_start:record.config.sourceStart,window_handle:record.config.sourceHandle,presentation_desktop:record.config.sourceDesktop,original_process_restarted:false,native_window_migrated:false,returned_to_original_window:true};
}
export async function cleanupTransferredDesktop(desktop){
  const record=desktopTransfers().find(r=>r.config.sourceDesktop===desktop);if(!record)return null;
  const guard=read(path.join(record.directory,'guardian.json'));if(!guard?.ready)throw Error('Retained application guardian is unavailable');
  const config={...record.config,jobSourcePid:guard.pid,jobSourceStart:guard.start,jobHandle:guard.job_handle};
  const file=path.join(record.directory,'cleanup-config.json');write(file,config);fs.rmSync(path.join(record.directory,'cleanup.json'),{force:true});
  const child=launch(await compileDesktopTransfer(),'--cleanup',file);
  for(let i=0;i<200;i++){const result=read(path.join(record.directory,'cleanup.json'));if(result)return result;if(child.exitCode!==null)throw Error('Retained desktop cleanup failed');await sleep(50);}child.kill();throw Error('Retained desktop cleanup timed out');
}
export function releaseDesktopTransfersSync(){for(const record of desktopTransfers())if(record.config.ownerPid===process.pid)try{fs.writeFileSync(path.join(record.directory,'owner-release'),'release');}catch{}}
export async function restoreVirtualTransfers(ownerId){
  for(const record of desktopTransfers().filter(r=>r.config.ownerId===ownerId&&r.status.side==='virtual')){
    if(record.config.sourceDesktop==='Default')await returnDesktopTransfer(record,{animate:false});
    else {
      await startDesktopTransfer({...record.config,targetDesktop:'Default',side:'real',jobSourcePid:record.status.pid,jobSourceStart:record.status.start,jobHandle:record.status.job_handle},{animate:false});
      await transferCommand(record,'handoff');
    }
  }
}
