/**
 * Login, receive loop and reply forwarding for the WeChat ClawBot channel.
 *
 * The channel is driven entirely from the NewMate settings page: connect() starts the QR
 * handshake, status() is what the page renders, and the receive loop only exists while a token
 * is stored. Nothing here reaches into NewMate's run: inbound goes through mate.chat(), which is
 * the same function the page's POST arrives at, and outbound reads mate.state() and forwards the
 * `plain` bubble of the assistant message whose id equals the task id.
 *
 * Two outbound shapes exist, and both are the user's own request rather than an unprompted push:
 *   - a REPLY to a WeChat message he sent (forwardReplies, keyed by the task id);
 *   - a SCHEDULED item he set a time for (forwardScheduled, keyed by `todo:<todoId>`) — a plain
 *     reminder's saved text and, since 0.3.67, the model's answer to a conversation activation.
 * A proactive check-in that nobody asked for is still never sent here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CDN_BASE, ILINK_BASE, createIlink, wechatStatePath } from './wechat-ilink.js';
import { qrDataUrl } from './wechat-qr.js';
import { bubbleText, toPlain } from './reply-format.js';
import { inspectWechatFile } from './wechat-file.js';
import { saveUpload, UPLOAD_MAX_BYTES } from './upload-store.js';

const LOGIN_POLL_MS = 1200;
const LOGIN_TTL_MS = 8 * 60 * 1000;
const REPLY_POLL_MS = 1000;
const REPLY_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 2;
const RETRY_MS = 2000;
const MAX_QR_REFRESH = 3;

function emptyState() {
  return {
    schema: 1, phase: 'disconnected',
    token: '', botId: '', baseUrl: ILINK_BASE, ilinkUserId: '',
    cursor: '', ledger: {}, pending: [], awaiting: {}, sent: {},
    qrcode: '', qrAt: 0, error: '', connectedAt: 0, updatedAt: 0,
    stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0, files: 0, fileFailed: 0, media: 0, mediaBytes: 0, mediaFailed: 0, voiceUnsupported: 0 },
  };
}

export function createWechatChannel({ root, mate, log = () => {}, baseUrl = ILINK_BASE, cdnBaseUrl = CDN_BASE }) {
  const file = wechatStatePath(root);
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      // stats MERGE rather than replace: a state file written by an older version has no
      // `files` counter, and copying it wholesale would answer `undefined` for a number the page
      // and the tool report. The same reason keeps every other counter a number.
      return { ...emptyState(), ...value, ledger: value.ledger || {}, awaiting: value.awaiting || {}, sent: value.sent || {}, pending: Array.isArray(value.pending) ? value.pending : [], stats: { ...emptyState().stats, ...(value.stats || {}) } };
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      log('wechat/state-read: ' + error.message);
      return emptyState();
    }
  };
  const freshState = !fs.existsSync(file);
  let state = read();
  // A brand-new state starts at the caller's base URL, so a gate can point this at a fake
  // iLink server instead of the real one. A stored token keeps the base URL it was issued for.
  if (freshState) state.baseUrl = baseUrl;
  const save = () => {
    state.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) { log('wechat/state-write: ' + error.message); }
  };
  // Anything delivered before this moment is history, not something to replay on first run.
  if (!state.reminderWatermark) { state.reminderWatermark = Date.now(); save(); }
  const ilink = createIlink({ getBaseUrl: () => state.baseUrl || ILINK_BASE, getToken: () => state.token, getCdnBaseUrl: () => cdnBaseUrl, log });
  let stopped = false;
  let loginRun = null;
  let loginGeneration = 0;
  let receiveGeneration = 0;
  let receiveRun = null;
  let replyTimer = null;
  let watchdogTimer = null;

  /* --------------------------------------------------------------- status */

  const status = () => ({
    phase: state.phase,
    connected: state.phase === 'connected' && Boolean(state.token),
    botId: state.botId || '',
    error: state.error || '',
    connectedAt: state.connectedAt || 0,
    waiting: state.phase === 'waiting_scan',
    qr: state.phase === 'waiting_scan' && state.qrcode
      ? { image: safeQr(state.qrcode), at: state.qrAt }
      : null,
    stats: state.stats,
    lastPollAt: state.lastPollAt || 0,
    lastInboundAt: state.lastInboundAt || 0,
    receiveSince: state.receiveSince || 0,
    consecutiveErrors: state.consecutiveErrors || 0,
    forwarded: Object.keys(state.sent || {}).length,
    pending: state.pending.length,
    awaiting: Object.keys(state.awaiting).length,
    files: { count: Number(state.stats.files || 0), failed: Number(state.stats.fileFailed || 0), last: state.lastFile || null },
    // The inbound half of the same question: how many files did the USER send us, and how many of
    // those could not be fetched. Kept apart from files{} - that one is what this bot SENT.
    media: {
      count: Number(state.stats.media || 0),
      bytes: Number(state.stats.mediaBytes || 0),
      failed: Number(state.stats.mediaFailed || 0),
      voiceUnsupported: Number(state.stats.voiceUnsupported || 0),
      last: state.lastInboundFile || null,
    },
  });

  function safeQr(payload) {
    try { return qrDataUrl(payload, { scale: 7, margin: 3 }); } catch (error) { log('wechat/qr: ' + error.message); return ''; }
  }

  /* ---------------------------------------------------------------- login */

  function finishLogin(reason) {
    if (reason === 'connected') {
      state.phase = 'connected';
      state.connectedAt = Date.now();
      state.error = '';
      state.qrcode = '';
      save();
      log('wechat: connected as ' + (state.botId || '?').slice(0, 12));
      startReceive();
      return;
    }
    state.phase = 'error';
    state.error = reason;
    state.qrcode = '';
    save();
    log('wechat: login ended with ' + reason);
  }

  async function loginLoop(generation) {
    const stale = () => stopped || generation !== loginGeneration;
    const deadline = Date.now() + LOGIN_TTL_MS;
    let refreshes = 0;
    let qr = await ilink.qrcode();
    if (!qr.ok) return finishLogin(qr.error || 'qrcode_failed');
    let scanned = false;
    for (;;) {
      if (stale()) return;
      state.phase = 'waiting_scan';
      state.qrcode = qr.image;
      state.qrAt = Date.now();
      state.error = '';
      save();
      while (Date.now() < deadline) {
        if (stale()) return;
        const result = await ilink.qrStatus(qr.qrcode);
        const name = result && result.status;
        if (name === 'confirmed') {
          if (!result.ilink_bot_id || !result.bot_token) return finishLogin('confirmed_without_credentials');
          state.token = result.bot_token;
          state.botId = result.ilink_bot_id;
          state.ilinkUserId = result.ilink_user_id || '';
          state.baseUrl = result.baseurl || ILINK_BASE;
          state.cursor = state.cursor || '';
          return finishLogin('connected');
        }
        if (name === 'scaned') { scanned = true; }
        if (name === 'binded_redirect') return finishLogin('already_bound');
        if (name === 'need_verifycode') return finishLogin('verify_code_required');
        if (name === 'verify_code_blocked') return finishLogin('verify_code_blocked');
        if (name === 'expired') break;
        if (name === 'scaned_but_redirect' && result.redirect_host) {
          state.baseUrl = 'https://' + result.redirect_host;
          save();
        }
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
      }
      if (stale()) return;
      refreshes += 1;
      if (refreshes > MAX_QR_REFRESH) return finishLogin('qr_expired');
      qr = await ilink.qrcode();
      if (!qr.ok) return finishLogin(qr.error || 'qrcode_failed');
    }
  }

  /* ---------------------------------------------------- inbound media (user -> bot) */

  /**
   * The ONE media item a WeChat message carries, in the official client's priority order.
   *
   * A message carries at most one downloadable media item (the SDK picks image > video > file >
   * voice and never more than one), so accepting one is the protocol, not a shortcut we took.
   * Picking the same order as the official client means a message the phone and this channel
   * disagree about cannot exist.
   *
   * What each field is for:
   *   encrypt_query_param / full_url  the CDN reference (full_url wins when the server sent one);
   *   aes_key                         the key, in one of two encodings (see parseAesKey);
   *   image aeskey                    a bare 32-hex key that WINS over aes_key for images;
   *   file_name                       the ONLY name the protocol carries, and only for files.
   */
  const MEDIA_ITEM_ORDER = [
    { type: 2, key: 'image_item', kind: 'image', plaintextAllowed: true },
    { type: 5, key: 'video_item', kind: 'video', plaintextAllowed: false },
    { type: 4, key: 'file_item', kind: 'file', plaintextAllowed: false },
  ];

  const hasReference = (media) => Boolean(media && (media.encrypt_query_param || media.full_url));

  function describeMedia(items) {
    for (const spec of MEDIA_ITEM_ORDER) {
      const item = items.find((entry) => entry && entry.type === spec.type && entry[spec.key] && hasReference(entry[spec.key].media));
      if (!item) continue;
      const payload = item[spec.key];
      const media = payload.media || {};
      const named = typeof payload.file_name === 'string' && payload.file_name.trim() ? payload.file_name : '';
      const fileName = named || (spec.kind === 'video' ? 'video.mp4' : 'image.bin');
      return {
        kind: spec.kind,
        plaintextAllowed: spec.plaintextAllowed === true,
        fileName,
        originalName: named,
        encryptQueryParam: typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param : '',
        fullUrl: typeof media.full_url === 'string' ? media.full_url : '',
        aesKeyBase64: typeof media.aes_key === 'string' ? media.aes_key : '',
        aeskeyHex: spec.kind === 'image' && typeof payload.aeskey === 'string' ? payload.aeskey : '',
        declaredBytes: Number(spec.kind === 'file' ? payload.len : payload.video_size) || 0,
      };
    }
    return null;
  }

  /**
   * A name for an inbound image.
   *
   * The extension is sniffed from the BYTES, not from the message: an image item carries no file
   * name and no mime type, and naming a JPEG .bin would make the rest of the store describe it as
   * binary. The magic numbers are the five formats a phone actually sends.
   */
  function imageFileName(bytes, at) {
    const stamp = new Date(at || Date.now());
    const pad = (value) => String(value).padStart(2, '0');
    const base = '图片-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds());
    const head = bytes.subarray(0, 12);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return base + '.jpg';
    if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return base + '.png';
    if (head.subarray(0, 3).toString('ascii') === 'GIF') return base + '.gif';
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return base + '.webp';
    if (head.subarray(0, 2).toString('ascii') === 'BM') return base + '.bmp';
    return base + '.img';
  }

  function queue(messages) {
    let queued = 0;
    for (const message of messages || []) {
      const id = String(message.message_id !== undefined ? message.message_id : (message.seq !== undefined ? message.seq : ''));
      if (Number(message.message_type) !== 1) { state.stats.skipped += 1; continue; }
      const items = Array.isArray(message.item_list) ? message.item_list : [];
      const textItem = items.find((item) => item && item.type === 1);
      let text = textItem && textItem.text_item && typeof textItem.text_item.text === 'string' ? textItem.text_item.text : '';
      const voice = items.find((item) => item && item.type === 3);
      // The server transcribes voice itself, and the SILK decode belongs to the phone's side of the
      // protocol; when the server sent the transcript, a voice message IS a text message here.
      if (!text && voice && voice.voice_item && typeof voice.voice_item.text === 'string') text = voice.voice_item.text;
      const media = describeMedia(items);
      if (!text && !media) {
        // A voice item without a server transcript is the one inbound kind this bundle cannot use:
        // decoding SILK needs a codec it does not carry. Counted apart from skipped, because "the
        // user spoke" and "there was nothing to read" are different facts.
        if (voice) state.stats.voiceUnsupported = Number(state.stats.voiceUnsupported || 0) + 1;
        state.stats.skipped += 1;
        continue;
      }
      const known = id ? state.ledger[id] : null;
      if (known && known.state === 'acked') { state.stats.skipped += 1; log('wechat: id ' + id + ' already confirmed, not delivered again'); continue; }
      if (state.pending.some((item) => item.id === id)) continue;
      state.pending.push({ id, text, peer: String(message.from_user_id || ''), contextToken: String(message.context_token || ''), at: Date.now(), attempts: 0, ...media ? { media } : {} });
      state.stats.inbound += 1;
      state.lastInboundAt = Date.now();
      queued += 1;
    }
    return queued;
  }

  /**
   * Hand ONE pending item to NewMate, fetching its media first when it has any.
   *
   * The split matters: a DOWNLOAD failure is not a DELIVERY failure. The first is retried and, when
   * it keeps failing, still becomes a message to NewMate that says plainly the file could not be
   * fetched - a file the user believes they sent cannot be dropped in silence. The second is the
   * delivery itself, retried and then recorded as failed.
   */
  async function deliverOne(item) {
    let attachment;
    if (item.media) {
      const got = await ilink.downloadMedia({
        encryptQueryParam: item.media.encryptQueryParam,
        fullUrl: item.media.fullUrl,
        aesKeyBase64: item.media.aesKeyBase64,
        aeskeyHex: item.media.aeskeyHex,
        allowPlaintext: item.media.plaintextAllowed === true,
        maxBytes: UPLOAD_MAX_BYTES,
      });
      if (!got.ok) return { failure: got };
      const name = item.media.kind === 'image' ? imageFileName(got.bytes, item.at) : item.media.fileName;
      const stored = saveUpload({ root, bytes: got.bytes, name, source: 'wechat', at: Date.now() });
      if (!stored.ok) return { failure: stored };
      attachment = stored.entry;
      state.stats.media = Number(state.stats.media || 0) + 1;
      state.stats.mediaBytes = Number(state.stats.mediaBytes || 0) + attachment.bytes;
      state.lastInboundFile = { at: Date.now(), id: item.id, name: attachment.name, bytes: attachment.bytes, kind: attachment.kind, decrypted: got.decrypted === true, declaredBytes: Number(item.media.declaredBytes || 0) };
    }
    try {
      // Exactly the call the page's POST reaches, plus the attachment list the page also uses.
      return { answer: mate.chat(item.text, undefined, undefined, attachment ? [attachment] : undefined), attachment };
    } catch (error) {
      return { answer: { ok: false, error: error.message }, attachment };
    }
  }

  /** What the user is owed, through NewMate, when a file could not be fetched at all. */
  function mediaFailureNotice(item, failure) {
    const label = item.media.kind === 'image' ? '图片' : item.media.kind === 'video' ? '视频' : '文件';
    return '（用户通过微信发来一个' + label + '，本机没能取回：' + item.media.fileName + '；原因：' + (failure.code || 'download_failed') + '）'
      + '请如实告诉用户没有收到这个' + label + '，不要假装看过它，也不要描述里面的内容。';
  }

  async function drain(generation) {
    for (const item of [...state.pending]) {
      if (generation !== undefined && generation !== receiveGeneration) return;
      if (item.lastAttempt && Date.now() - item.lastAttempt < RETRY_MS) continue;
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastAttempt = Date.now();
      let attempt = await deliverOne(item);
      let notice = false;
      if (attempt.failure) {
        if (item.attempts < MAX_DELIVERY_ATTEMPTS) {
          save();
          continue;
        }
        // Final attempt: the file is gone for good (an expired CDN reference, a key that does not
        // match, a store that refused it), so the USER is owed an answer rather than silence.
        state.stats.mediaFailed = Number(state.stats.mediaFailed || 0) + 1;
        log('wechat: could not fetch media for ' + item.id + ' (' + (attempt.failure.code || 'failed') + '), delivering a notice instead');
        try { attempt = { answer: mate.chat(mediaFailureNotice(item, attempt.failure), undefined, undefined), failure: attempt.failure }; notice = true; }
        catch (error) { attempt = { answer: { ok: false, error: error.message }, failure: attempt.failure }; }
      }
      const answer = attempt.answer;
      if (!answer || answer.ok !== true) {
        if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
          state.ledger[item.id] = { state: 'failed', attempts: item.attempts, error: String((attempt.failure || answer || {}).error || 'unavailable'), at: Date.now() };
          state.pending = state.pending.filter((entry) => entry.id !== item.id);
          log('wechat: gave up delivering ' + item.id + ' after ' + item.attempts + ' attempts');
        }
        save();
        continue;
      }
      /**
       * Receipt: from this line on, that WeChat message is never handed to NewMate again. The
       * attachment receipt says what was STORED (name, bytes, kind, digest); it does not claim the
       * model read it, because whether it did is the answer's business, not the channel's.
       */
      state.ledger[item.id] = {
        state: 'acked', attempts: item.attempts, taskId: String(answer.id || ''), mode: answer.mode, at: Date.now(),
        ...attempt.attachment ? { attachment: { name: attempt.attachment.name, bytes: attempt.attachment.bytes, kind: attempt.attachment.kind, sha256: attempt.attachment.sha256 } } : {},
        ...notice ? { mediaFailure: String(attempt.failure?.code || 'download_failed'), notice: true } : {},
      };
      state.pending = state.pending.filter((entry) => entry.id !== item.id);
      state.stats.acked += 1;
      // The reminder forwarder needs somewhere to send: remember the newest peer and its token.
      state.lastPeer = { to: item.peer, contextToken: item.contextToken || (state.lastPeer && state.lastPeer.contextToken) || '', at: Date.now() };
      if (answer.id) {
        const previous = state.awaiting[answer.id];
        state.awaiting[answer.id] = {
          peer: item.peer,
          contextToken: item.contextToken || (previous && previous.contextToken) || '',
          at: (previous && previous.at) || Date.now(),
          tries: (previous && previous.tries) || 0,
        };
      }
      save();
    }
  }

  function textOf(entry) { return bubbleText(entry); }

  async function forwardReplies() {
    const ids = Object.keys(state.awaiting);
    if (!ids.length) return;
    const snapshot = mate.state();
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    for (const taskId of ids) {
      const entry = state.awaiting[taskId];
      if (!entry) continue;
      if (Date.now() - Number(entry.at || 0) > REPLY_TIMEOUT_MS) {
        delete state.awaiting[taskId]; save();
        log('wechat: no reply for task ' + taskId + ' within the window, dropped');
        continue;
      }
      const reply = messages.find((message) => message && String(message.id) === String(taskId) && message.role === 'assistant');
      if (!reply) continue;
      const value = textOf(reply);
      if (!value) { delete state.awaiting[taskId]; save(); continue; }
      // Already forwarded: a restart, a replay or a second timer tick must not send it again.
      if (state.sent[taskId]) { delete state.awaiting[taskId]; save(); continue; }
      /**
       * CLAIM BEFORE THE AWAIT. Deleting the entry only after the network call returned let two
       * overlapping ticks both see the same task and both send it — measured in production:
       * one reply, three WeChat messages. The claim is synchronous and persisted, so the second
       * tick finds nothing to do; a failure below puts the entry back for a retry.
       */
      delete state.awaiting[taskId];
      save();
      const sent = await ilink.sendText({ to: entry.peer, text: value, contextToken: entry.contextToken });
      if (sent.ok) {
        state.stats.replies += 1;
        state.sent[taskId] = { at: Date.now(), messageId: sent.messageId, chars: value.length };
        save();
      } else {
        state.stats.sendFailed += 1;
        entry.tries = Number(entry.tries || 0) + 1;
        if (entry.tries >= 3) delete state.awaiting[taskId];
        save();
      }
    }
  }

  /**
   * SCHEDULED deliveries are NOT replies to anything this channel sent: NewMate pushes them as
   * assistant messages whose id is `todo:<todoId>`, with no task behind them, so forwardReplies()
   * never sees them — that is why a plain-text reminder reached the page and the desktop bubble but
   * never the phone.
   *
   * Both due modes are forwarded, because they are the same promise to the user: he scheduled
   * something and it is now due. 0.3.67 extends this from `reminder` to a `conversation`
   * activation too: measured 2026-10-29 11:20, an activation due at 03:20:18.425 was delivered to
   * the page and the bubble (1.4 s) and NOT to WeChat — `stats.replies` stayed 31, no `sent`
   * receipt — because this function filtered on `mode === 'reminder'` and forwardReplies() only
   * knows tasks a WeChat message created. The model's answer is the thing he asked for, so it goes
   * out as the same plain bubble as a reminder.
   *
   * Guards kept as they were: a message is forwarded once (`sent`), only newer than the watermark
   * (a fresh install must not replay history), and only within 30 minutes of being produced.
   */
  async function forwardScheduled() {
    const snapshot = mate.state();
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const todos = Array.isArray(snapshot.todos) ? snapshot.todos : [];
    if (!messages.length) return;
    const reminderTodos = new Set(todos.filter((todo) => todo && (todo.mode === 'reminder' || todo.mode === 'conversation')).map((todo) => String(todo.id)));
    if (!reminderTodos.size) return;
    for (const message of messages) {
      if (!message || message.role !== 'assistant' || !message.id) continue;
      const todoId = message.todoId ? String(message.todoId) : (typeof message.id === 'string' && message.id.startsWith('todo:') ? message.id.slice(5) : '');
      if (!todoId || !reminderTodos.has(todoId)) continue;
      if (state.sent[message.id]) continue;
      /**
       * STRICTLY OLDER than the watermark, not "at or older": two scheduled items can carry the SAME
       * millisecond (measured in this gate: a reminder and an activation stamped `future` together),
       * and advancing the watermark to that instant then skipped the second one forever. Duplicates
       * are already excluded by `state.sent[message.id]` above, so the watermark only has to say
       * "history from before this channel started".
       */
      if (Number(message.at || 0) < Number(state.reminderWatermark || 0)) continue;
      if (Date.now() - Number(message.at || 0) > 30 * 60 * 1000) continue;   // too old to be useful
      // The reminder body is the user's own text: strip anything that would render oddly but keep
      // it whole (the 80-character bubble limit would cut a real sentence in half).
      const value = toPlain(String(message.text || ''), 4000);
      if (!value) continue;
      // The paired user id from the login is a valid recipient even before the first inbound
      // message of this process; a context_token is only needed for a threaded reply, so an
      // empty one is passed and the server decides.
      const peer = state.lastPeer || (state.ilinkUserId ? { to: state.ilinkUserId, contextToken: '' } : null);
      if (!peer || !peer.to) {
        // Do not mark it: a reminder that arrived before any WeChat peer existed must still go
        // out once one does. The age guard below stops ancient ones from being replayed.
        log('wechat: scheduled message ' + message.id + ' has no WeChat recipient yet, will retry');
        continue;
      }
      // Claim first: the timer can tick again while the send is in flight.
      state.sent[message.id] = { at: Date.now(), chars: value.length, reminder: true, pending: true };
      save();
      const sent = await ilink.sendText({ to: peer.to, text: value, contextToken: peer.contextToken });
      if (sent.ok) {
        state.stats.replies += 1;
        state.sent[message.id] = { at: Date.now(), messageId: sent.messageId, chars: value.length, reminder: true };
        state.reminderWatermark = Math.max(Number(state.reminderWatermark || 0), Number(message.at || 0));
        save();
        log('wechat: forwarded scheduled message ' + message.id + ' (' + value.length + ' chars)');
      } else {
        state.stats.sendFailed += 1;
        delete state.sent[message.id];
        save();
        log('wechat: scheduled send failed ret=' + (sent.ret === undefined ? '(none)' : sent.ret) + ' ' + (sent.errmsg || sent.error || ''));
      }
    }
  }

  /* ---------------------------------------------------------------- files */

  /**
   * Send ONE existing file to the bound WeChat user.
   *
   * This is the only outbound path that is not a reply: a caller asked for it, so it does not wait
   * for a run, does not consult the companion switches, and does not touch the reminder watermark.
   * What it DOES share with every other send is the recipient rule (the newest inbound peer, falling
   * back to the user who scanned the QR) and the fact that accepted-by-the-server is the only claim
   * the protocol supports. messageId is the one thing that makes a send identifiable afterwards, so
   * the answer always says whether it was present instead of implying delivery.
   *
   * Every refusal is its own code, because a bare 文件没发出去 is useless to a caller: a missing
   * file, a file over the bound, a forbidden type, an unconnected channel and a rejected recipient
   * each need something different done about them.
   */
  async function sendFile({ path: target, caption = '', receiver = '', cwd } = {}) {
    const inspected = inspectWechatFile({ path: target, cwd });
    if (!inspected.ok) return inspected;
    const file = inspected.file;
    const described = { name: file.fileName, bytes: file.bytes, path: file.path };
    if (!state.token) {
      return { ok: false, code: 'wechat_not_connected', error: '微信 ClawBot 未连接：先在 NewMate 设置页「发起连接」并扫码，再发文件。', file: described };
    }
    if (state.phase === 'error' && state.error === 'session_paused') {
      return { ok: false, code: 'wechat_session_paused', error: '微信侧会话已暂停（errcode=-14）：需要人工重新扫码，重启不会自动恢复。', file: described };
    }
    const to = String(receiver || '').trim() || (state.lastPeer && state.lastPeer.to) || state.ilinkUserId || '';
    if (!to) {
      return { ok: false, code: 'receiver_unavailable', error: '没有可用的微信接收者：还没收到过这个用户的消息，也没有登录用户 id。可以先让用户给 ClawBot 发一条消息。', file: described };
    }
    let bytes;
    try { bytes = fs.readFileSync(file.path); } catch (error) {
      return { ok: false, code: 'file_unreadable', error: '读取文件失败：' + error.message, path: file.path };
    }
    if (bytes.length !== file.bytes) {
      // The file changed between the inspection and the read: the upload declaration would state
      // one size and the ciphertext would carry another, so nothing is sent.
      return { ok: false, code: 'file_changed', error: '文件在检查与读取之间发生了变化（' + file.bytes + ' → ' + bytes.length + ' 字节），未发送。', path: file.path };
    }

    const upload = await ilink.uploadFile({ to, bytes });
    if (!upload.ok) {
      state.stats.fileFailed = Number(state.stats.fileFailed || 0) + 1;
      save();
      log('wechat: file upload refused for ' + file.fileName + ' (' + (upload.code || 'upload_failed') + ')');
      return { ok: false, ...upload, file: described };
    }

    const contextToken = (state.lastPeer && state.lastPeer.contextToken) || '';
    const note = String(caption || '').trim().slice(0, 500);
    let captionMessageId = null;
    if (note) {
      // One request carries one item, so the caption is its own message and goes first - a caption
      // that arrived after its file reads as a correction rather than a description.
      const sent = await ilink.sendText({ to, text: note, contextToken });
      if (!sent.ok) {
        state.stats.fileFailed = Number(state.stats.fileFailed || 0) + 1;
        save();
        return { ok: false, code: 'caption_failed', error: '说明文字发送失败：' + (sent.error || sent.errmsg || ('ret=' + sent.ret)), file: described };
      }
      captionMessageId = sent.messageId;
    }

    const sent = await ilink.sendItem({ to, item: ilink.fileItem({ fileName: file.fileName, upload }), contextToken });
    if (!sent.ok) {
      state.stats.fileFailed = Number(state.stats.fileFailed || 0) + 1;
      save();
      log('wechat: file send failed for ' + file.fileName + ' (' + (sent.code || 'send_failed') + ')');
      return { ok: false, ...sent, captionMessageId, file: described };
    }

    state.stats.files = Number(state.stats.files || 0) + 1;
    state.lastFile = { at: Date.now(), name: file.fileName, bytes: bytes.length, messageId: sent.messageId || null, caption: Boolean(note) };
    save();
    log('wechat: sent file ' + file.fileName + ' (' + bytes.length + ' bytes) as ' + (sent.messageId || 'no message id'));
    return {
      ok: true,
      file: described,
      receiver: to,
      caption: note || null,
      captionMessageId,
      messageId: sent.messageId,
      receipt: {
        accepted: true,
        serverMessageId: sent.messageId,
        ret: sent.hasRet ? sent.ret : null,
        // Accepted is the server's answer; nobody has confirmed the phone rendered it, and the live
        // samples so far returned a message_id with no ret field at all, so the two are reported
        // separately instead of one standing in for the other.
        state: sent.messageId ? 'accepted_with_message_id' : 'accepted_without_message_id',
      },
      upload: { filekey: upload.filekey, cipherBytes: upload.cipherSize, attempts: upload.attempts },
    };
  }

  async function receiveLoop(generation) {
    const stale = () => stopped || generation !== receiveGeneration;
    state.receiveSince = Date.now();
    save();
    await ilink.notify(true).catch(() => ({}));
    let consecutive = 0;
    while (!stopped && state.token && !stale()) {
      if (state.pending.length) await drain(generation).catch((error) => log('wechat/drain: ' + error.message));
      const poll = await ilink.updates(state.cursor || '');
      if (stopped || stale()) break;
      if (poll.timedOut) continue;
      if (!poll.ok) {
        consecutive += 1;
        state.consecutiveErrors = consecutive;
        state.lastErrorAt = Date.now();
        save();
        /**
         * Never give up on a transport failure. A DSH restart, a sleeping laptop or a dropped
         * connection used to end the loop after five tries and leave the channel dead until the
         * user pressed 重新连接. Only the server saying -14 (account paused) stops it.
         */
        const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(consecutive - 1, 5)));
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      consecutive = 0;
      state.consecutiveErrors = 0;
      state.lastPollAt = Date.now();
      const resp = poll.resp || {};
      const code = resp.errcode !== undefined ? resp.errcode : resp.ret;
      if (code === -14) { state.phase = 'error'; state.error = 'session_paused'; save(); break; }
      if (code && code !== 0) { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
      queue(resp.msgs);
      await drain(generation);
      if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) state.cursor = resp.get_updates_buf;
      save();
    }
    if (!stale()) await ilink.notify(false).catch(() => ({}));
  }

  function startReceive() {
    // A reconnect starts a new loop; the old one notices its generation is stale and exits at
    // its next boundary, so two loops never drain the same queue item.
    receiveGeneration += 1;
    const generation = receiveGeneration;
    receiveRun = receiveLoop(generation)
      .catch((error) => log('wechat/receive: ' + error.message))
      .finally(() => { if (generation === receiveGeneration) receiveRun = null; });
    if (watchdogTimer) clearInterval(watchdogTimer);
    /**
     * A loop can be alive on paper and dead in practice (a request stuck behind a network that
     * changed under it). If no poll has completed for 90 s while a token is stored, restart it;
     * startReceive() supersedes the old loop by generation.
     */
    watchdogTimer = setInterval(() => {
      if (stopped || !state.token) return;
      const last = Number(state.lastPollAt || state.receiveSince || 0);
      if (last && Date.now() - last > 90000) {
        log('wechat: no completed poll for ' + Math.round((Date.now() - last) / 1000) + 's, restarting the receive loop');
        startReceive();
      }
    }, 30000);
    if (watchdogTimer.unref) watchdogTimer.unref();
    if (replyTimer) clearInterval(replyTimer);
    let forwarding = false;
    replyTimer = setInterval(async () => {
      // Reminders arrive without any outstanding task, so the guard cannot be 'awaiting is empty'.
      if (stopped || forwarding) return;
      forwarding = true;
      try { await forwardReplies(); await forwardScheduled(); } catch (error) { log('wechat/replies: ' + error.message); } finally { forwarding = false; }
    }, REPLY_POLL_MS);
    if (replyTimer.unref) replyTimer.unref();
  }

  /* ------------------------------------------------------------- lifecycle */

  function logout() {
    state.token = ''; state.botId = ''; state.ilinkUserId = '';
    state.cursor = ''; state.ledger = {}; state.pending = []; state.awaiting = {}; state.sent = {};
    state.phase = 'disconnected'; state.error = ''; state.qrcode = ''; state.connectedAt = 0;
    // The base URL is deliberately kept: it is where this deployment's server lives, not a credential.
    state.stats = emptyState().stats;
    save();
  }

  async function connect() {
    // 重新连接 = 清掉登录信息再走一遍，不是复用旧 token。An in-flight login is superseded,
    // not joined: the user pressed the button again, so the newest QR is the one that counts.
    loginGeneration += 1;
    const generation = loginGeneration;
    if (state.token || state.phase === 'connected' || Object.keys(state.sent).length) logout();
    stopped = false;
    state.phase = 'waiting_scan';
    state.error = '';
    state.qrcode = '';
    save();
    loginRun = loginLoop(generation)
      .catch((error) => finishLogin('login_failed: ' + error.message))
      .finally(() => { if (generation === loginGeneration) loginRun = null; });
    return status();
  }

  async function stop() {
    stopped = true;
    if (replyTimer) { clearInterval(replyTimer); replyTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    // Best effort: tell the server this client is going away, so the next process starts clean.
    if (state.token) await ilink.notify(false).catch(() => ({}));
    if (state.phase === 'waiting_scan') { state.phase = 'disconnected'; state.qrcode = ''; save(); }
  }

  /** Resume a stored session on mount: no QR, no user action. */
  function resume() {
    if (!state.token) return;
    // A restart must come back by itself; only a server-declared pause (-14) needs the user.
    if (state.phase === 'error' && state.error !== 'session_paused') {
      state.error = '';
      log('wechat: resuming after "' + (state.error || 'error') + '"');
    }
    if (state.error === 'session_paused') return;
    state.phase = 'connected';
    state.error = '';
    save();
    startReceive();
  }

  return { status, connect, logout, stop, resume, sendFile, statePath: file };
}
