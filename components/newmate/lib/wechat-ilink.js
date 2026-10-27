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
 * A FILE is the one outbound thing that is not a reply. The protocol needs three calls for it and
 * the order is not negotiable: getuploadurl declares the size/md5/key and returns an upload
 * target, the AES-128-ECB ciphertext is POSTed there and its response header x-encrypted-param is
 * the download parameter, and only then does sendmessage carry a type-4 file_item that references
 * it. A caption is a SEPARATE text message, because one request carries exactly one item. This
 * client exposes the two protocol halves (uploadFile, sendItem) and nothing else; deciding what a
 * caption is, who the recipient is, and what may be sent at all belongs to the channel above.
 * Source of the field spellings: @tencent-weixin/openclaw-weixin 2.4.10, src/cdn/upload.ts,
 * src/cdn/cdn-upload.ts, src/messaging/send.ts — read at the time this was written.
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
/**
 * The media CDN. A login can return a different API host; the CDN host is a client constant in the
 * official client (src/auth/accounts.ts CDN_BASE_URL) and is used only when getuploadurl answers
 * without an `upload_full_url`.
 */
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** A 20 MB attachment over a phone hotspot needs more than the 15 s an API call gets. */
const CDN_UPLOAD_TIMEOUT_MS = 120000;
/** Official client: retry server errors, abort at once on 4xx (src/cdn/cdn-upload.ts). */
const CDN_UPLOAD_ATTEMPTS = 3;
/** UploadMediaType.FILE — 1 image, 2 video, 3 file, 4 voice. */
const MEDIA_TYPE_FILE = 3;
/** MessageItemType.FILE. */
const ITEM_TYPE_FILE = 4;
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

/** AES-128-ECB with PKCS#7 padding — the cipher the media CDN accepts. */
function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Ciphertext size for that padding, which is what getuploadurl calls `filesize`. */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** The upload target when the server did not answer with a full URL. */
export function cdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return String(cdnBaseUrl).replace(/\/+$/, '') + '/upload?encrypted_query_param=' + encodeURIComponent(uploadParam) + '&filekey=' + encodeURIComponent(filekey);
}

/** One protocol client. Every call is bounded; a timeout is reported, never thrown as a crash. */
export function createIlink({ getBaseUrl, getToken, log, getCdnBaseUrl }) {
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

  /**
   * Put the exact digits of a uint64 id back into a parsed reply.
   *
   * message_id is a uint64 on the wire, and JSON.parse rounds anything above 2^53: the live send
   * that measured this came back as 7520828416397238000 where the real id had more significant
   * digits, so the number could not identify the message it claimed to name. The official client
   * solves the same problem by rewriting those fields into strings before parsing
   * (parseWeixinApiJson / LOSSLESS_ID_FIELDS); this is that intent, narrower: parse normally, then
   * take the digits straight out of the raw text for the ids this client reports.
   */
  const losslessIds = (body, text) => {
    if (!body || typeof body !== 'object') return body;
    for (const field of ['message_id', 'svr_id']) {
      const match = new RegExp('"' + field + '"\\s*:\\s*"?(\\d{6,20})"?').exec(text);
      if (match) body[field] = match[1];
    }
    return body;
  };

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
      const body = losslessIds(parse(reply.text) || {}, reply.text);
      if (body.ret && body.ret !== 0) return { ok: false, ret: body.ret, errmsg: body.errmsg || '' };
      return { ok: true, messageId: body.message_id || null, ret: body.ret };
    },
    /**
     * Upload one buffer to the media CDN and answer what a file_item needs to reference it.
     *
     * `bytes` is the plaintext exactly as it sits on disk: the size, the md5 and the ciphertext
     * all derive from it, and the caller must not re-read the file between the two calls or the
     * md5 in the upload declaration would no longer describe what was uploaded.
     */
    async uploadFile({ to, bytes }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, code: 'upload_empty', error: '没有可上传的内容' };
      const rawsize = bytes.length;
      const rawfilemd5 = crypto.createHash('md5').update(bytes).digest('hex');
      const filesize = aesEcbPaddedSize(rawsize);
      const filekey = crypto.randomBytes(16).toString('hex');
      const aeskey = crypto.randomBytes(16);

      const declared = await call({
        endpoint: 'ilink/bot/getuploadurl',
        token: getToken(),
        payload: {
          filekey, media_type: MEDIA_TYPE_FILE, to_user_id: to,
          rawsize, rawfilemd5, filesize,
          // A file attachment needs no thumbnail; image and video are the media types that do.
          no_need_thumb: true,
          aeskey: aeskey.toString('hex'),
          base_info: baseInfo(),
        },
      });
      if (!declared.ok) {
        return { ok: false, code: declared.timedOut ? 'upload_url_timeout' : 'upload_url_failed', status: declared.status, error: 'getuploadurl HTTP ' + declared.status + ' ' + String(declared.text || '').slice(0, 200) };
      }
      const declaration = parse(declared.text) || {};
      if (declaration.ret && declaration.ret !== 0) {
        return { ok: false, code: 'upload_url_refused', ret: declaration.ret, error: 'getuploadurl ret=' + declaration.ret + ' ' + (declaration.errmsg || '') };
      }
      const full = typeof declaration.upload_full_url === 'string' ? declaration.upload_full_url.trim() : '';
      const param = typeof declaration.upload_param === 'string' ? declaration.upload_param.trim() : '';
      if (!full && !param) {
        return { ok: false, code: 'upload_url_missing', error: 'getuploadurl 既没有返回 upload_full_url 也没有 upload_param' };
      }
      const target = full || cdnUploadUrl({ cdnBaseUrl: String(getCdnBaseUrl?.() || CDN_BASE), uploadParam: param, filekey });

      const ciphertext = encryptAesEcb(bytes, aeskey);
      let lastError = '';
      for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CDN_UPLOAD_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        try {
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array(ciphertext),
            signal: controller.signal,
          });
          if (response.status >= 400 && response.status < 500) {
            // A client error is final: the declaration or the key is wrong, and repeating it only
            // makes the caller wait longer for the same answer.
            return { ok: false, code: 'cdn_upload_rejected', status: response.status, error: 'CDN 拒绝上传 HTTP ' + response.status + ' ' + String(response.headers.get('x-error-message') || '').slice(0, 200) };
          }
          if (response.status !== 200) {
            lastError = 'HTTP ' + response.status;
            continue;
          }
          const downloadParam = response.headers.get('x-encrypted-param');
          if (!downloadParam) { lastError = 'CDN 响应缺少 x-encrypted-param'; continue; }
          return {
            ok: true,
            filekey,
            encryptQueryParam: downloadParam,
            // The official client stores the hex STRING and base64s those bytes for CDNMedia.aes_key
            // (send.ts `Buffer.from(uploaded.aeskey).toString("base64")`). Not the 16 raw bytes.
            aesKeyBase64: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
            fileSize: rawsize,
            cipherSize: ciphertext.length,
            attempts: attempt,
          };
        } catch (error) {
          lastError = error && error.name === 'AbortError' ? '上传超时' : String(error && error.message || error);
        } finally { clearTimeout(timer); }
      }
      return { ok: false, code: 'cdn_upload_failed', error: 'CDN 上传失败（已试 ' + CDN_UPLOAD_ATTEMPTS + ' 次）：' + lastError };
    },
    /** Send exactly one message item; the protocol carries one item per request. */
    async sendItem({ to, item, contextToken }) {
      const reply = await call({
        endpoint: 'ilink/bot/sendmessage',
        token: getToken(),
        payload: {
          msg: {
            from_user_id: '', to_user_id: to,
            client_id: 'newmate-wechat:' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
            message_type: 2, message_state: 2,
            context_token: contextToken || undefined,
            item_list: [item],
          },
          base_info: baseInfo(),
        },
      });
      if (!reply.ok) return { ok: false, code: 'send_failed', status: reply.status, error: 'sendmessage HTTP ' + reply.status + ' ' + String(reply.text || '').slice(0, 200) };
      const body = losslessIds(parse(reply.text) || {}, reply.text);
      if (body.ret && body.ret !== 0) return { ok: false, code: 'send_refused', ret: body.ret, errmsg: body.errmsg || '', error: 'sendmessage ret=' + body.ret + ' ' + (body.errmsg || '') };
      return { ok: true, messageId: body.message_id || null, ret: body.ret, hasRet: Object.hasOwn(body, 'ret') };
    },
    /**
     * Build the type-4 file item from an upload receipt. Exported as a plain function so a caller
     * (and a gate) can hold the item shape without sending anything.
     */
    fileItem({ fileName, upload }) {
      return {
        type: ITEM_TYPE_FILE,
        file_item: {
          media: { encrypt_query_param: upload.encryptQueryParam, aes_key: upload.aesKeyBase64, encrypt_type: 1 },
          file_name: fileName,
          // The protocol wants this as a STRING of plaintext bytes (send.ts: `len: String(fileSize)`).
          len: String(upload.fileSize),
        },
      };
    },
    async notify(start) {
      return call({ endpoint: start ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop', token: getToken(), payload: { base_info: baseInfo() } });
    },
  };
}
