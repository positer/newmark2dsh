/**
 * Login, receive loop and reply forwarding for the WeChat ClawBot channel.
 *
 * The channel is driven entirely from the NewMate settings page: connect() starts the QR
 * handshake, status() is what the page renders, and the receive loop only exists while a token
 * is stored. Nothing here reaches into NewMate's run: inbound goes through mate.chat(), which is
 * the same function the page's POST arrives at, and outbound reads mate.state() and forwards the
 * `plain` bubble of the assistant message whose id equals the task id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CDN_BASE, ILINK_BASE, createIlink, wechatStatePath } from './wechat-ilink.js';
import { qrDataUrl } from './wechat-qr.js';
import { bubbleText, toPlain } from './reply-format.js';
import { inspectWechatFile } from './wechat-file.js';

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
    stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0, files: 0, fileFailed: 0 },
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

  /* -------------------------------------------------------------- receive */

  function queue(messages) {
    let queued = 0;
    for (const message of messages || []) {
      const id = String(message.message_id !== undefined ? message.message_id : (message.seq !== undefined ? message.seq : ''));
      if (Number(message.message_type) !== 1) { state.stats.skipped += 1; continue; }
      const items = Array.isArray(message.item_list) ? message.item_list : [];
      const textItem = items.find((item) => item && item.type === 1);
      const text = textItem && textItem.text_item && typeof textItem.text_item.text === 'string' ? textItem.text_item.text : '';
      if (!text) { state.stats.skipped += 1; continue; }
      const known = id ? state.ledger[id] : null;
      if (known && known.state === 'acked') { state.stats.skipped += 1; log('wechat: id ' + id + ' already confirmed, not delivered again'); continue; }
      if (state.pending.some((item) => item.id === id)) continue;
      state.pending.push({ id, text, peer: String(message.from_user_id || ''), contextToken: String(message.context_token || ''), at: Date.now(), attempts: 0 });
      state.stats.inbound += 1;
      state.lastInboundAt = Date.now();
      queued += 1;
    }
    return queued;
  }

  async function drain(generation) {
    for (const item of [...state.pending]) {
      if (generation !== undefined && generation !== receiveGeneration) return;
      if (item.lastAttempt && Date.now() - item.lastAttempt < RETRY_MS) continue;
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastAttempt = Date.now();
      let answer;
      try {
        // Exactly the call the page's POST reaches: chat(text, execution, threadId).
        answer = mate.chat(item.text, undefined, undefined);
      } catch (error) {
        answer = { ok: false, error: error.message };
      }
      if (!answer || answer.ok !== true) {
        if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
          state.ledger[item.id] = { state: 'failed', attempts: item.attempts, error: String(answer && answer.error || 'unavailable'), at: Date.now() };
          state.pending = state.pending.filter((entry) => entry.id !== item.id);
          log('wechat: gave up delivering ' + item.id + ' after ' + item.attempts + ' attempts');
        }
        save();
        continue;
      }
      // Receipt: from this line on, that WeChat message is never handed to NewMate again.
      state.ledger[item.id] = { state: 'acked', attempts: item.attempts, taskId: String(answer.id || ''), mode: answer.mode, at: Date.now() };
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
   * Reminder deliveries are NOT replies to anything this channel sent: NewMate pushes them as
   * assistant messages whose id is `todo:<todoId>`, with no task behind them, so forwardReplies()
   * never sees them — that is why a plain-text reminder reached the page and the desktop bubble but
   * never the phone. They still belong to the user: forward the saved text as the same plain
   * bubble, but only for todos whose mode is `reminder`, and only newer than the watermark so a
   * fresh install does not replay every reminder ever delivered.
   */
  async function forwardReminders() {
    const snapshot = mate.state();
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const todos = Array.isArray(snapshot.todos) ? snapshot.todos : [];
    if (!messages.length) return;
    const reminderTodos = new Set(todos.filter((todo) => todo && todo.mode === 'reminder').map((todo) => String(todo.id)));
    if (!reminderTodos.size) return;
    for (const message of messages) {
      if (!message || message.role !== 'assistant' || !message.id) continue;
      const todoId = message.todoId ? String(message.todoId) : (typeof message.id === 'string' && message.id.startsWith('todo:') ? message.id.slice(5) : '');
      if (!todoId || !reminderTodos.has(todoId)) continue;
      if (state.sent[message.id]) continue;
      if (Number(message.at || 0) <= Number(state.reminderWatermark || 0)) continue;
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
        log('wechat: reminder ' + message.id + ' has no WeChat recipient yet, will retry');
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
        log('wechat: forwarded reminder ' + message.id + ' (' + value.length + ' chars)');
      } else {
        state.stats.sendFailed += 1;
        delete state.sent[message.id];
        save();
        log('wechat: reminder send failed ret=' + (sent.ret === undefined ? '(none)' : sent.ret) + ' ' + (sent.errmsg || sent.error || ''));
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
      try { await forwardReplies(); await forwardReminders(); } catch (error) { log('wechat/replies: ' + error.message); } finally { forwarding = false; }
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
