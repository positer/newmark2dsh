/** Cross-process Windows takeover slots, independent of package copies and user-root settings. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
let compiling;
function run(file,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Takeover lock compilation timed out'));},30000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(output||`Compiler exit ${code}`));});
  });
}
async function compile() {
  if(compiling)return compiling;
  compiling=(async()=>{
    const source=path.join(here,'takeover-lock.cs');
    const hash=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,20);
    const dir=path.join(os.tmpdir(),'newmark2dsh-computer-use','lock',hash);
    fs.mkdirSync(dir,{recursive:true});const exe=path.join(dir,'takeover-lock.exe');
    if(!fs.existsSync(exe)) {
      const candidate=path.join(dir,`${process.pid}-${crypto.randomUUID()}.exe`);
      try {
        await run(path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/optimize+','/target:exe',`/out:${candidate}`,source]);
        try{fs.renameSync(candidate,exe);}catch(error){if(!fs.existsSync(exe))throw error;}
      } finally {fs.rmSync(candidate,{force:true});}
    }
    return exe;
  })();
  try{return await compiling;}catch(error){compiling=null;throw error;}
}

/** A handle remains held until release or parent death; a competitor never expires it. */
export async function acquireTakeoverLock(mode,{onLost=()=>{}}={}) {
  if(mode!=='real'&&mode!=='virtual')throw new Error('Unknown takeover mode');
  if(process.platform!=='win32')return {ok:false,error_code:'takeover_lock_unsupported'};
  const executable=await compile();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[String(process.pid),mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let text='',errors='',answered=false,held=false,releasing=false;
    const timer=setTimeout(()=>{releasing=true;child.kill();reject(new Error('Takeover lock did not answer'));},10000);
    child.stderr.on('data',chunk=>{errors+=chunk;});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      text+=chunk;if(answered||!text.includes('\n'))return;
      answered=true;clearTimeout(timer);const answer=text.trim();
      if(answer==='occupied'){resolve({ok:false,error_code:'takeover_lease_occupied',mode});return;}
      if(answer!=='acquired'){reject(new Error(`Takeover lock: ${answer}`));return;}
      held=true;
      resolve({ok:true,mode,pid:child.pid,alive:()=>held&&!releasing,
        release:()=>{if(releasing)return;releasing=true;child.stdin.end('release\n');},
        closed:new Promise(done=>child.once('exit',done))});
    });
    child.once('error',error=>{clearTimeout(timer);if(!answered){answered=true;reject(error);}});
    child.once('exit',code=>{
      clearTimeout(timer);const unexpected=held&&!releasing;held=false;
      if(!answered){answered=true;reject(new Error(errors||`Takeover lock exit ${code}`));}
      if(unexpected)onLost();
    });
  });
}
