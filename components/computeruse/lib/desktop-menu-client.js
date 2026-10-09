/** Capture the real DSH Menu DOM + ordered live CSS, including plugin overrides.
 * The native WebView consumes CSS/markup only, not the DSH application's scripts.
 */
export function startDshMenuThemeBridge({React, createRoot, Menu, connection, renderSlider, sliderCss}) {
  if (!connection || !Menu) return () => {};
  let disposed=false, busy=false, timer, last='', captured=null;
  const resources=new Map();
  const processedSheets=new WeakMap();
  const yieldToShell=()=>new Promise(resolve=>setTimeout(resolve,0));
  const sliderStyle=document.createElement('style');sliderStyle.textContent=sliderCss;document.head.append(sliderStyle);
  const attrs = element => Object.fromEntries([...element.attributes].filter(a => /^(class|style|lang|dir|data-[a-z0-9_-]+)$/.test(a.name)).map(a=>[a.name,a.value]));
  const tick = () => new Promise(resolve => setTimeout(resolve,30));
  async function captureMenu() {
    const holder=document.createElement('div'); holder.setAttribute('aria-hidden','true'); holder.inert=true;
    holder.style.cssText='position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none';
    document.body.append(holder); const mount=createRoot(holder);
    try {
      mount.render(React.createElement(Menu,{open:true,autoFocus:false,anchor:null,onClose(){},onSelect(){}},React.createElement(renderSlider,{value:1})));
      for(let i=0;i<30 && !holder.querySelector('[role="menu"]');i++) await tick();
      const menu=holder.querySelector('[role="menu"]'); if(!menu) throw Error('DSH Menu unavailable');
      const clone=menu.cloneNode(true); clone.setAttribute('data-newmate-menu',''); clone.removeAttribute('style');
      if(!clone.querySelector('[data-newmate-slider]'))throw Error('DSH size slider unavailable');
      for(const element of [clone,...clone.querySelectorAll('*')]) for(const a of [...element.attributes]) if(/^on/i.test(a.name)) element.removeAttribute(a.name);
      return {html:clone.outerHTML};
    } finally { mount.unmount(); holder.remove(); }
  }
  async function inlineUrls(css,base) {
    const matches=[...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)];
    for(const m of matches) {
      if(/^(data:|#)/i.test(m[2])) continue;
      let url; try { url=new URL(m[2],base); } catch { continue; }
      // No third-party fetch or credentials export. Native rendering makes no network requests.
      if(url.origin!==location.origin) { css=css.replaceAll(m[0],'url("")'); continue; }
      if(!resources.has(url.href)) resources.set(url.href,(async()=>{
        try { const response=await fetch(url,{credentials:'same-origin',signal:AbortSignal.timeout(5000)}); if(!response.ok) return '';
          const blob=await response.blob(); if(blob.size>1024*1024) return '';
          return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve('');reader.readAsDataURL(blob);});
        } catch { return ''; }
      })());
      css=css.replaceAll(m[0],`url("${await resources.get(url.href)}")`);
    }
    return css;
  }
  async function sheetText(sheet) {
    if(sheet.disabled || (sheet.media?.mediaText && !matchMedia(sheet.media.mediaText).matches)) return '';
    let rules; try { rules=[...sheet.cssRules]; } catch { return ''; }
    const parts=[];
    for(const rule of rules) {
      if(rule.type===3 && rule.styleSheet) {
        let text=await sheetText(rule.styleSheet);
        if(rule.media?.mediaText) text=`@media ${rule.media.mediaText}{${text}}`;
        if(rule.supportsText) text=`@supports ${rule.supportsText}{${text}}`;
        if(rule.layerName!==null && rule.layerName!==undefined) text=`@layer ${rule.layerName}{${text}}`;
        parts.push(text);
      }
      else parts.push(rule.cssText);
    }
    const raw=parts.join('\n'), base=sheet.href||document.baseURI;
    const cached=processedSheets.get(sheet);
    if(cached?.raw===raw && cached.base===base) return cached.text;
    const text=await inlineUrls(raw,base);
    processedSheets.set(sheet,{raw,base,text});
    return text;
  }
  async function sync() {
    if(disposed||busy) return; busy=true;
    try {
      if(!captured) captured=await captureMenu();
      const sheets=[...document.styleSheets,...(document.adoptedStyleSheets||[])];
      const chunks=[];
      let sliceStart=performance.now();
      for(const sheet of sheets) {
        if(disposed)return;
        chunks.push(await sheetText(sheet));
        if(performance.now()-sliceStart>=4){await yieldToShell();sliceStart=performance.now();}
      }
      const css=chunks.join('\n');
      const bodyAttributes=attrs(document.body);
      // Include inherited resolved custom properties, including plugins' CSSOM token changes.
      const computed=getComputedStyle(document.body); let inherited='';
      for(const key of computed) if(key.startsWith('--')) inherited+=key+':'+computed.getPropertyValue(key)+';';
      bodyAttributes.style=(bodyAttributes.style||'')+';'+inherited;
      const snapshot={version:1,...captured,css,htmlAttributes:attrs(document.documentElement),bodyAttributes};
      const body=JSON.stringify(snapshot);
      if(body===last||disposed) return;
      const response=await fetch(connection.path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-newmate-theme-token':connection.token},body});
      if(!response.ok) throw Error('DSH menu style sync: '+response.status);
      if(!disposed) last=body;
    } catch(error) { if(!disposed) console.warn('NewMate menu theme unavailable:',error.message); }
    finally { busy=false; }
  }
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(sync,150);};
  const observer=new MutationObserver(schedule);
  observer.observe(document.head,{subtree:true,childList:true,characterData:true,attributes:true});
  observer.observe(document.documentElement,{attributes:true}); observer.observe(document.body,{attributes:true});
  // CSSStyleSheet.insertRule/replaceSync and adoptedStyleSheets do not emit DOM mutations.
  const interval=setInterval(sync,3000); document.addEventListener('visibilitychange',schedule); sync();
  return ()=>{disposed=true;clearTimeout(timer);clearInterval(interval);observer.disconnect();document.removeEventListener('visibilitychange',schedule);resources.clear();sliderStyle.remove();};
}
