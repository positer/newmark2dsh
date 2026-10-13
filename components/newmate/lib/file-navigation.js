import fs from 'node:fs';
import path from 'node:path';
import {fileLinks} from './presentation.js';

export function referencedFile(messages, id, target) {
  if(typeof target!=='string'||/[\u0000-\u001f]/.test(target)||!path.isAbsolute(target))throw Error('只支持已引用的绝对文件路径');
  if(!messages.some(m=>m.id===id&&m.role==='assistant'&&fileLinks(m.text).some(link=>link.path===target)))throw Error('文件未在该回复中引用');
  if(!fs.statSync(target).isFile())throw Error('引用不是现存文件');
  return path.resolve(target);
}

export async function revealReferencedFile({messages,id,target,controller,signal}) {
  const file=referencedFile(messages,id,target);
  if(!controller?.openWorkspacePath)throw Error('DSH 原生文件管理器接口不可用');
  await controller.openWorkspacePath({path:file,action:'reveal'},signal);
  return{ok:true,path:file,opened:'file-manager'};
}

// Bytes feed DSH's registered document body; this module never implements a viewer.
export function readReferencedFile(messages,id,target) {
  const file=referencedFile(messages,id,target),before=fs.statSync(file);
  if(before.size>32*1024*1024)throw Error('文件超过原生预览读取上限，请在文件管理器定位');
  const data=fs.readFileSync(file),after=fs.statSync(file);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('文件在读取时发生变化，请重试');
  return{ok:true,path:file,data:data.toString('base64'),version:`${after.size}:${after.mtimeMs}`};
}
