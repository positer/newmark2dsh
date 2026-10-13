/** Official DSH desktop Host backend. Native permission grants remain user-owned. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),source=fileURLToPath(new URL('./darwin-native.swift',import.meta.url));
let worker=null,starting=null,serial=0,tail=Promise.resolve();const pending=new Map();
const observations=new Map();
const fail=(code,error)=>({ok:false,error_code:code,code,error});
export const DARWIN_ACTIONS=['mode_report','app_list','observe','app_observe','takeover_start','takeover_stop','app_activate','click','app_click','move','type','app_type','key','app_key','scroll','app_scroll','sequence','wait'];
export const MODE_INVENTORY={real:{supported:true,implementation:'native prototype; Mac build/interaction acceptance pending',actions:DARWIN_ACTIONS,requires:['macOS 14+ for interactive CU','accessibility','screen-recording']},virtual:{supported:false,code:'macos_vm_not_provisioned',route:'Virtualization.framework isolated guest'}};
export function validateDarwinRequest(input){
 if(input.mode==='virtual'||input.mouseMode==='virtual'||input.desktop||input.desktopName)return fail('macos_vm_not_provisioned','macOS Spaces and background windows are not isolated desktops. Provision the explicit Virtualization.framework guest; no host-desktop fallback.');
 if(!input.action||typeof input.action!=='string')return fail('invalid_action','Missing action');
 if(!DARWIN_ACTIONS.includes(input.action))return fail('unsupported_action','macOS native prototype does not implement '+input.action);
 for(const key of ['x','y','scrollX','scrollY','durationMs'])if(input[key]!==undefined&&!Number.isFinite(input[key]))return fail('invalid_coordinate',key+' must be finite');
 for(const key of ['x','y'])if(input[key]!==undefined&&Math.abs(input[key])>32768)return fail('invalid_coordinate','Coordinate is outside supported desktop bounds');
 if(input.text!==undefined&&(typeof input.text!=='string'||input.text.length>16000))return fail('invalid_text','Text exceeds 16000 characters');
 if(input.action==='sequence'&&(!Array.isArray(input.steps)||!input.steps.length||input.steps.length>32||input.steps.some(step=>step.action==='sequence'||validateDarwinRequest({...input,...step,action:step.action})!==null)))return fail('invalid_sequence','Sequence needs 1–32 individually supported bounded steps');
 return null;
}
async function start(){
 if(process.platform!=='darwin')throw Object.assign(Error('macOS native helper is unavailable on this platform'),{code:'unsupported_platform'});
 const directory=path.join(os.homedir(),'Library','Caches','Newmark-CU');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const hash=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16),binary=path.join(directory,'cu-'+hash);
 if(!fs.existsSync(binary)){if(!['/Library/Developer/CommandLineTools/usr/bin/swiftc','/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'].some(p=>fs.existsSync(p)))throw Object.assign(Error('Install the macOS Swift command-line SDK manually; no installer is opened automatically'),{code:'macos_sdk_required'});const temp=binary+'.'+process.pid+'.tmp';await execute('/usr/bin/xcrun',['swiftc','-parse-as-library',source,'-o',temp,'-framework','AppKit','-framework','ScreenCaptureKit'],{timeout:120000,maxBuffer:1024*1024});fs.renameSync(temp,binary);fs.chmodSync(binary,0o700);}
 const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});let buffer='',stderr='';
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2048);});
 child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>16*1024*1024){child.kill();return;}for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line),request=pending.get(value.requestId);if(request){pending.delete(value.requestId);clearTimeout(request.timer);request.resolve(value);}}catch{child.kill();}}});
 child.on('exit',()=>{if(worker===child)worker=null;starting=null;for(const request of pending.values()){clearTimeout(request.timer);request.resolve(fail('macos_helper_exited',stderr||'Native helper exited'));}pending.clear();});
 child.on('error',error=>{if(worker===child)worker=null;starting=null;for(const request of pending.values()){clearTimeout(request.timer);request.resolve(fail('macos_helper_unavailable',error.message));}pending.clear();});worker=child;return child;
}
export function sparseDistance(before,after){if(!Array.isArray(before)||!Array.isArray(after)||before.length!==576||after.length!==576||[...before,...after].some(n=>!Number.isFinite(n)||n<0||n>255))return null;return before.reduce((sum,n,i)=>sum+Math.abs(n-after[i]),0)/(576*255);}
async function dispatch(input){const child=worker||await(starting||=start().catch(error=>{starting=null;throw error;}));const requestId=++serial;return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(requestId);child.kill();resolve(fail('macos_action_timeout','Native action timed out; helper lease released'));},15000);pending.set(requestId,{resolve,timer});child.stdin.write(JSON.stringify({...input,requestId})+'\n');});}
export async function runComputerUse(options={}){
 const refusal=validateDarwinRequest(options);if(refusal)return JSON.stringify(refusal);
 if(options.action==='mode_report')return JSON.stringify({ok:true,platform:'darwin',modes:MODE_INVENTORY,hostIsMac:process.platform==='darwin',nativeHelperRunning:Boolean(worker),acceptance:'Mac hardware validation pending',virtual_isolation:'requires separately provisioned VM; never Spaces'});
 if(options.action==='wait'){const duration=options.durationMs??options.ms??0;if(!Number.isFinite(duration)||duration<0||duration>5000)return JSON.stringify(fail('invalid_wait','Wait must be between zero and 5000 ms'));await new Promise(resolve=>setTimeout(resolve,duration));return JSON.stringify({ok:true,waited_ms:duration});}
 if(options.action==='sequence'){const results=[];for(const step of options.steps){const result=JSON.parse(await runComputerUse({...options,...step,action:step.action,steps:undefined,ownerId:options.ownerId}));results.push(result);if(!result.ok)return JSON.stringify({ok:false,error_code:result.error_code,results,stopped_at:results.length-1});}return JSON.stringify({ok:true,results});}
 const run=async()=>{try{const key=options.action==='observe'?'screen':String(options.windowHandle||options.appTarget||'');const previous=observations.get(key),observation=['observe','app_observe'].includes(options.action);let result=await dispatch({...options,ownerId:String(options.ownerId||''),sparseOnly:observation&&Boolean(previous)&&Date.now()-previous.at<60000});if(result.ok&&observation){const distance=sparseDistance(previous?.grid,result.sparse_grid);if(!result.image_path&&(distance===null||distance>=.02))result=await dispatch({...options,ownerId:String(options.ownerId||''),sparseOnly:false});if(result.ok){result.sparse={changed:distance===null||distance>=.02,distance,grid:'32x18 grayscale'};if(result.image_path){if(observations.size>=64)observations.delete(observations.keys().next().value);observations.set(key,{at:Date.now(),grid:result.sparse_grid});}delete result.sparse_grid;}}return JSON.stringify(result);}catch(error){return JSON.stringify(fail(error.code||'macos_helper_unavailable',error.message));}};
 const result=tail.then(run,run);tail=result.then(()=>{},()=>{});return result;
}
export async function stopAll(){worker?.kill();worker=null;starting=null;observations.clear();return{ok:true};}
export const laneDiagnostics=()=>({platform:'darwin',helperPid:worker?.pid||null,pending:pending.size});
