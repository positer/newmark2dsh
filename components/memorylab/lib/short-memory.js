import path from 'node:path';
import { durableState } from '../../../lib/durable-state.js';

/**
 * What this store IS, at the head of every model-facing description.
 *
 * Read together with MemoryLab's `LONG_TERM_ROLE` (`../component.js`): the two stores are one
 * decision a caller makes before it writes anything, so each states its own half on every tool.
 * A tool description is read one tool at a time — a model that reaches `shortMemory_recall`
 * without having read `shortMemory_add` must still know that this list ages out and that durable
 * knowledge does not belong in it.
 *
 * "expire on their own" is the whole point, and it is not the same as "are deleted": an expired
 * item stays in the list, flagged, and `shortMemory_recall` returns it with that flag. What
 * expires is its standing as a current fact — the same rule NewMate applies when it injects the
 * latest ten. Saying "auto-cleaned" here would be a promise this store does not keep.
 *
 * The sentence is REPEATED thirteen times in this bundle's tool surface, so its length is a
 * context tax paid on every request; the gate caps it at 320 characters for that reason.
 */
export const SHORT_TERM_ROLE =
  'Short-term memory (shortMemory): a flat, list-style scratch list whose items expire on their own — seven days by default, and expired rows stay in the list, flagged. Use it for cross-conversation task handoff: where the work stopped and what comes next. Durable knowledge belongs to memory_lab_*.';

/** What each of the four tools does, after the role that is shared by all of them. */
const DESCRIPTIONS = Object.freeze({
  add: 'Add one item. Prefer at most 100 tokens. Default expiry is seven days; expired items remain in the list.',
  recall: 'Return the most recent ten short-term memories directly, including expiry flags.',
  where: 'Return the absolute path of the complete short-term memory list.',
  size: 'Return the total number of short-term memories, including expired items.',
});

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
      return ['add','recall','where','size'].map(action=>({name:`shortMemory_${action}`,description:`${SHORT_TERM_ROLE} ${DESCRIPTIONS[action]}`,parameters:{type:'object',properties:action==='add'?{content:{type:'string',minLength:1,maxLength:4000},expires_at:{type:'string',description:'Optional ISO expiry, default seven days.'}}:{},required:action==='add'?['content']:[],additionalProperties:false},output,execute:args=>action==='add'?this.add(args):this[action]()}));
    },
  };
}
