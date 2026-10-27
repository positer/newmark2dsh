/**
 * The WeChat ClawBot channel, inside the plugin.
 *
 * Same contract as the standalone bridge in SCRIPTS/clawbot-newmate, now driven from the NewMate
 * settings page:
 *   in  - the WeChat text is handed to mate.chat(text, undefined, undefined), i.e. the very
 *         function the page's own POST reaches, so start / steer / queue is decided by chat()
 *         and nothing else.
 *   out - the run's final assistant message (id === task.id) is sent back as its `plain` bubble
 *         version; message.text (the rich UI rendering) is never forwarded, and no typing,
 *         progress or proactive message is ever sent.
 *   ack - the moment chat() accepts a message, its iLink message_id is written to a persisted
 *         ledger and is never handed to NewMate again, including after a restart. The ack is
 *         bookkeeping only: nothing is sent to WeChat until the final reply exists.
 *
 * The iLink protocol client here mirrors SCRIPTS/clawbot-demo/clawbot-demo.mjs (kept standalone
 * because an installed plugin cannot import a repo script). If the protocol changes, both move.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { qrDataUrl } from './wechat-qr.js';
import { bubbleText } from './reply-format.js';

export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const APP_ID = 'bot';
const APP_VERSION = 132106;          // 0x00MMNNPP for 2.4.10
const CHANNEL_VERSION = '2.4.10';
const LONG_POLL_MS = 35000;
const API_TIMEOUT_MS = 15000;
const LOGIN_POLL_MS = 1200;
const LOGIN_TTL_MS = 8 * 60 * 1000;
const REPLY_POLL_MS = 1000;
const REPLY_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 2;
const RETRY_MS = 2000;
const MAX_QR_REFRESH = 3;

export function wechatStatePath(root) {
  return path.join(root, 'newMate', 'wechat.json');
}

function emptyState() {
  return {
    schema: 1,
    phase: 'disconnected',
    token: '', botId: '', baseUrl: ILINK_BASE, ilinkUserId: '',
    cursor: '', ledger: {}, pending: [], awaiting: {}, sent: {},
    qrcode: '', qrAt: 0, error: '', connectedAt: 0, updatedAt: 0,
    stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0 },
  };
}

function mask(value) {
  const text = typeof value === 'string' ? value : '';
  return text ? (text.length <= 8 ? '****' : '****' + text.slice(-4)) : '';
}

/** One protocol client. Every call is bounded; a timeout is reported, never thrown as a crash. */
export function createIlink({ getBaseUrl, getToken, log }) {
  const headers = (token) => {
    const value = {
      'content-type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': String(APP_VERSION),
    };
    if (token) value.Authorization = 'Bearer ' + token;
    return value;
  };
  const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: 'NewMate/wechat-clawbot' });
  const url = (endpoint) => {
    // The base URL can change after a login redirect, so it is read on every call.
    const base = String(getBaseUrl() || ILINK_BASE);
    return new URL(endpoint, base.endsWith('/') ? base : base + '/').toString();
  };

  async function call({ endpoint, method = 'POST', payload, token, timeoutMs = API_TIMEOUT_MS }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();
    try {
      const response = await fetch(url(endpoint), {
        method,
        headers: headers(token),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text, timedOut: false };
    } catch (error) {
      if (error && error.name === 'AbortError') return { ok: false, status: 0, text: '', timedOut: true };
      return { ok: false, status: 0, text: '', error: error.message };
    } finally { clearTimeout(timer); }
  }

  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

  return {
    async qrcode() {
      const reply = await call({ endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3', payload: { local_token_list: [] } });
      if (!reply.ok) return { ok: false, error: 'get_bot_qrcode HTTP ' + reply.status };
      const body = parse(reply.text);
      if (!body || typeof body.qrcode !== 'string') return { ok: false, error: 'no qrcode in reply' };
      return { ok: true, qrcode: body.qrcode, image: String(body.qrcode_img_content || '') };
    },
    async qrStatus(qrcode, verifyCode) {
      let endpoint = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
      if (verifyCode) endpoint += '&verify_code=' + encodeURIComponent(verifyCode);
      const reply = await call({ endpoint, method: 'GET', timeoutMs: LONG_POLL_MS });
      if (reply.timedOut) return { status: 'wait' };
      const body = parse(reply.text);
      return body && typeof body.status === 'string' ? body : { status: 'wait' };
    },
    async updates(cursor) {
      const reply = await call({
        endpoint: 'ilink/bot/getupdates',
        payload: { get_updates_buf: cursor || '', base_info: baseInfo() },
        token: getToken(),
        timeoutMs: LONG_POLL_MS,
      });
      if (reply.timedOut) return { ok: true, timedOut: true, resp: { ret: 0, msgs: [], get_updates_buf: cursor } };
      if (!reply.ok) return { ok: false, status: reply.status, error: reply.text.slice(0, 200) };
      return { ok: true, resp: parse(reply.text) || {} };
    },
    async sendText({ to, text, contextToken }) {
      const reply = await call({
        endpoint: 'ilink/bot/sendmessage',
        token: getToken(),
        payload: {
          msg: {
            from_user_id: '', to_user_id: to,
            client_id: 'newmate-wechat:' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
            message_type: 2, message_state: 2,
            context_token: contextToken || undefined,
            item_list: [{ type: 1, text_item: { text: String(text).slice(0, 4000) } }],
          },
          base_info: baseInfo(),
        },
      });
      if (!reply.ok) return { ok: false, error: reply.text.slice(0, 200) };
      const body = parse(reply.text) || {};
      if (body.ret && body.ret !== 0) return { ok: false, ret: body.ret, errmsg: body.errmsg || '' };
      return { ok: true, messageId: body.message_id || null, ret: body.ret };
    },
    async notify(start) {
      return call({ endpoint: start ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop', token: getToken(), payload: { base_info: baseInfo() } });
    },
  };
}
