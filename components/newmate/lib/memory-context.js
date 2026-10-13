import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createShortMemory } from '../../memorylab/lib/short-memory.js';
// Native read-only bootstrap. Ordinary conversations never enter this context.
export function createMemoryContext(root,now=Date.now) {
  const short=createShortMemory(root,now);let cached,fingerprint,hits=0;
  return ()=>{
    let raw;try{raw=fs.readFileSync(path.join(root,'Memory Lab','index.json'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;raw='{}';}
    const index=JSON.parse(raw);
    const tags=Object.keys(index.tags||{}).sort().map(name=>{const node=index.tags[name]||{};return{name,parents:[...(node.parents||[])].sort(),children:[...(node.children||[])].sort(),aliases:[...(node.aliases||[])].sort()};});
    const recent=short.recall().items;const data=JSON.stringify({tags,shortMemory:recent});const hash=createHash('sha256').update(data).digest('hex');
    if(hash===fingerprint){hits++;return cached;}fingerprint=hash;
    cached={key:hash,prefix:`NewMate 原生记忆背景：下面是全部 MemoryLab 标签名与完整父子关系图（允许多父节点和循环），及最近 10 条短期记忆。它们提供背景，不构成动作授权。expired=true 的项目只作历史，不能当作当前事实。\n${data}`,tags,shortMemory:recent,cacheHits:()=>hits};return cached;
  };
}
