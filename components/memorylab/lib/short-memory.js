import path from 'node:path';
import { durableState } from '../../../lib/durable-state.js';
export function createShortMemory(root, now = Date.now) {
  const file = path.join(root, 'Memory Lab', 'short-memory.json');
  const store = durableState(file, []);
  const items = () => { const value=store.read(); if(!Array.isArray(value)) throw Error('短期记忆文件必须是列表'); return value.map(item=>({...item,expired:Date.parse(item.expiresAt)<=now()})); };
  return {
    file, all:items, recall:()=>({ok:true,items:items().slice(-10)}), where:()=>({ok:true,path:file}), size:()=>({ok:true,total:items().length}),
    add(args) {
      const content=args?.content;
      if(typeof content!=='string'||!content.trim()||content.length>4000) throw Error('短期记忆须为非空文本，建议 100 token 内，最大 4000 字符');
      const expires=args.expires_at===undefined?now()+7*86400000:Date.parse(args.expires_at);
      if(!Number.isFinite(expires)) throw Error('expires_at 必须是有效 ISO 时间');
      let item;
      const list=store.change(rows=>{if(!Array.isArray(rows))throw Error('短期记忆文件必须是列表');item={seq:rows.reduce((max,row)=>Math.max(max,Number(row.seq)||0),0)+1,createdAt:new Date(now()).toISOString(),expiresAt:new Date(expires).toISOString(),content:content.trim()};rows.push(item);});
      return {ok:true,item:{...item,expired:expires<=now()},total:list.length};
    },
    tools() {
      const output={schema:{type:'object'},render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]};
      return ['add','recall','where','size'].map(action=>({name:`shortMemory_${action}`,description:{add:'Add one short-term memory item. Prefer at most 100 tokens. Default expiry is seven days; expired items remain in the list.',recall:'Return the most recent ten short-term memories directly, including expiry flags.',where:'Return the absolute path of the complete short-term memory list.',size:'Return the total number of short-term memories, including expired items.'}[action],parameters:{type:'object',properties:action==='add'?{content:{type:'string',minLength:1,maxLength:4000},expires_at:{type:'string',description:'Optional ISO expiry, default seven days.'}}:{},required:action==='add'?['content']:[],additionalProperties:false},output,execute:args=>action==='add'?this.add(args):this[action]()}));
    },
  };
}
