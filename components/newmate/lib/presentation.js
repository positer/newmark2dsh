/** Short presentation text is separate from the durable full reply; no extra model call. */
export function bubbleSummary(text, explicit) {
  const plain=String(explicit||text||'').replace(/```[\s\S]*?```/g,'').replace(/!?\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/^[\s#>*-]+/gm,'').replace(/[`*_~]/g,'').replace(/\s+/g,' ').trim();
  const first=plain.match(/^.{1,80}?[。！？.!?](?:\s|$)/u)?.[0]?.trim()||plain;
  const points=Array.from(first);return points.length>80?points.slice(0,79).join('')+'…':first||'有一份新回复，点这里查看。';
}
export function fileLinks(text) {
  const links=[];
  for(const match of String(text).matchAll(/\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
    let target=match[2]||match[3];
    try{if(/^file:\/\//i.test(target)){const url=new URL(target);if(url.hostname&&url.hostname!=='localhost')continue;target=decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i,'$1');}else target=decodeURIComponent(target);}catch{continue;}
    if(/^[a-z]:[\\/]|^\/(?!\/)/i.test(target))links.push({label:match[1],path:target});
  }return links;
}
