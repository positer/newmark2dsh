// Persisted one-shot reminders. ISO timestamps must explicitly identify their time zone.
export function todoInput(input,now){
  if(!input||typeof input.content!=='string'||!input.content.trim()||input.content.length>16000)throw Error('待办内容须为 1–16000 字符');
  const parts=typeof input.activateAt==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input.activateAt);
  if(!parts)throw Error('激活时间须为带时区的 ISO 时间');
  const [,year,month,day,hour,minute,second='0']=parts.map((v,i)=>i===0?v:Number(v));
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)throw Error('激活时间的日期或时分秒无效');
  const activateAt=Date.parse(input.activateAt);if(!Number.isFinite(activateAt)||activateAt<=now)throw Error('激活时间须晚于现在');
  const mode=input.mode??'conversation';if(!['reminder','conversation'].includes(mode))throw Error('待办方式无效');
  return{content:input.content.trim(),activateAt,mode};
}
export const todoMessageId=id=>`todo:${id}`;
