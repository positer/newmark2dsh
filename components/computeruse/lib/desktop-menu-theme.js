/** DSH renderer -> native menu appearance bridge. No arbitrary file paths or commands. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MENU_THEME_ROUTE = '/newmark-computeruse/menu-theme';
export const MENU_CLIENT_ROUTE = '/newmark-computeruse/menu-client.js';
export const menuThemePath = root => path.join(root, 'computer-use', 'desktop-menu-theme.json');
const maxBytes = 8 * 1024 * 1024;

export function validateMenuTheme(value) {
  if (value?.version !== 1 || typeof value.html !== 'string' || typeof value.css !== 'string') throw Error('Invalid menu snapshot');
  if (!value.html.includes('data-newmate-slider') || !value.html.includes('type="range"')) throw Error('Missing size slider');
  // Rendering accepts inert menu markup, never plugin JavaScript, documents or frames.
  if (/<\s*(?:script|iframe|object|embed|meta|base|link|form)\b|\son[a-z]+\s*=/i.test(value.html)) throw Error('Non-menu markup');
  for (const attrs of [value.htmlAttributes, value.bodyAttributes]) {
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw Error('Invalid root attributes');
    for (const [key, val] of Object.entries(attrs)) {
      if (!/^(?:class|style|lang|dir|data-[a-z0-9_-]+)$/.test(key) || typeof val !== 'string') throw Error('Invalid root attribute');
    }
  }
  return value;
}

export function installMenuThemeBridge(ctx, root) {
  const token = crypto.randomBytes(24).toString('hex');
  const target = menuThemePath(root);
  let lastHash = '';
  const respond = (res, code, body) => { res.writeHead(code, {'content-type':'application/json', 'cache-control':'no-store'}); res.end(JSON.stringify(body)); };
  ctx.effect(() => ctx.webServer.register({kind:'exact', path:MENU_CLIENT_ROUTE, handler(req,res) {
    if (req.method !== 'GET') return respond(res,405,{ok:false});
    res.writeHead(200, {'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
    res.end(fs.readFileSync(fileURLToPath(new URL('./desktop-menu-client.js', import.meta.url))));
  }}), 'newmate-menu-client');
  ctx.effect(() => ctx.webServer.register({kind:'exact', path:MENU_THEME_ROUTE, async handler(req,res) {
    if (req.method === 'GET') return respond(res,200,{path:MENU_THEME_ROUTE,client:MENU_CLIENT_ROUTE,token});
    if (req.method !== 'POST') return respond(res,405,{ok:false});
    if (req.headers['x-newmate-theme-token'] !== token) return respond(res,403,{ok:false});
    try {
      let bytes = 0; const chunks=[];
      for await (const chunk of req) { bytes += chunk.length; if(bytes > maxBytes) return respond(res,413,{ok:false}); chunks.push(Buffer.from(chunk)); }
      const snapshot = validateMenuTheme(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const body = JSON.stringify(snapshot);
      const hash = crypto.createHash('sha256').update(body).digest('hex');
      if (hash !== lastHash) {
        fs.mkdirSync(path.dirname(target),{recursive:true});
        const temporary = target+'.'+process.pid+'.tmp';
        fs.writeFileSync(temporary, JSON.stringify({...snapshot,hash,updatedAt:new Date().toISOString()}));
        fs.renameSync(temporary,target); lastHash=hash;
      }
      respond(res,200,{ok:true,hash});
    } catch(error) { ctx.logger?.warn?.('NewMate menu theme: '+error.message); if(!res.headersSent) respond(res,400,{ok:false,error:'invalid_menu_theme'}); }
  }}), 'newmate-menu-theme');
  return {path:MENU_THEME_ROUTE, client:MENU_CLIENT_ROUTE, token};
}
