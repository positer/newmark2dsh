import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { conversationPaused, deliverConversation } from '../../../lib/conversation-delivery.js';
import { newMateContext } from '../../../lib/newmate-context.js';

/**
 * NewMate's three conversation-level tools: start a NEW conversation in a workspace, hand a message
 * to an EXISTING conversation, and read a conversation's transcript.
 *
 * These are the only tools in this bundle that act on something other than the companion's own
 * store, so every one of them is bounded and refuses by name:
 *
 *  - a created conversation is a REAL DSH conversation: it costs a model turn in that session, it
 *    shows up in the user's sidebar, and its cwd is a real directory. The caller therefore has to
 *    name (or inherit) a validated workspace, and the number of conversations NewMate may create is
 *    capped per process - an autonomous loop must not be able to mint conversations without bound;
 *  - a delivery is the same contract `newmate_task` uses (stable `newmark-task:<id>` identity, host
 *    runner source, `sessions.flush` barrier) and obeys the same user-pause rule;
 *  - a read is bounded in messages and characters, reports what it dropped, and never writes.
 *
 * Definitions live in the private tool map (`newmark.newmate.privateTools`), so a DSH agent's own
 * catalog never lists them: they are NewMate's tools, admitted only by NewMate's run allow list.
 */

/** The three names, in the order the persona introduces them. */
export const CONVERSATION_TOOLS = Object.freeze([
  'newmate_conversation_new',
  'newmate_conversation_send',
  'newmate_conversation_read',
]);

/** Caps. Every one of these is a refusal, never a silent truncation of intent. */
const MAX_PROMPT_CHARS = 16000;
const MAX_SESSION_ID_CHARS = 100;
const MAX_LIVE_CONVERSATIONS = 16;
const MAX_READ_MESSAGES = 60;
const DEFAULT_READ_MESSAGES = 20;
const MAX_READ_CHARS = 6000;
const MAX_MESSAGE_CHARS = 800;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * One message out of a raw session event, or null.
 *
 * Only the two conversational event types carry user-visible text; reasoning blocks and tool calls
 * are deliberately not part of a transcript read (they are not what "reading a conversation" means,
 * and they are the bulk of the bytes).
 */
function messageOf(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'user/message') {
    const data = event.data ?? {};
    const content = Array.isArray(data.content) ? data.content : [];
    const body = content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n').trim();
    if (!body) return null;
    const source = typeof data.source?.kind === 'string' ? data.source.kind : 'user';
    return { role: 'user', source, text: body, at: Number.isFinite(event.time) ? event.time : undefined };
  }
  if (event.type === 'assistant/message') {
    const message = event.data?.message ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const body = content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n').trim();
    if (!body) return null;
    return { role: 'assistant', source: 'model', text: body, at: Number.isFinite(event.time) ? event.time : undefined };
  }
  return null;
}

/** Bound a transcript: newest messages first, then the character budget, reporting what was dropped. */
function boundTranscript(messages, { limit, maxChars }) {
  const kept = [];
  let chars = 0;
  let droppedMessages = 0;
  let droppedChars = 0;
  let clip = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (kept.length >= limit) { droppedMessages += index + 1; droppedChars += messages.slice(0, index + 1).reduce((sum, item) => sum + item.text.length, 0); break; }
    let body = message.text;
    if (body.length > MAX_MESSAGE_CHARS) { droppedChars += body.length - MAX_MESSAGE_CHARS; body = body.slice(0, MAX_MESSAGE_CHARS) + '…'; clip = true; }
    if (chars + body.length > maxChars && kept.length) { droppedMessages += index + 1; droppedChars += messages.slice(0, index + 1).reduce((sum, item) => sum + item.text.length, 0); break; }
    kept.push({ ...message, text: body });
    chars += body.length;
  }
  kept.reverse();
  return { messages: kept, droppedMessages, droppedChars, clipped: clip, chars };
}

export function createConversationBridge({ services, now = Date.now, log = () => {} }) {
  const agents = () => { try { return services?.agents?.(); } catch { return undefined; } };
  const presets = () => { try { return services?.presets?.(); } catch { return undefined; } };
  const workspaces = () => { try { return services?.workspaces?.(); } catch { return undefined; } };
  const persistence = () => { try { return services?.persistence?.(); } catch { return undefined; } };
  /** Handles of the conversations this bridge created, so teardown can dispose exactly them. */
  const created = new Map();
  /** A created conversation is retained here; when the cap is reached creation is refused. */
  const refuse = (code, error) => ({ ok: false, code, error });

  /** The requester's workspace: an explicit cwd wins, then the conversation this run is bound to. */
  async function resolveCwd(explicit) {
    if (explicit !== undefined) {
      const value = text(explicit);
      if (!value || !path.isAbsolute(value)) throw Object.assign(Error('workspace path must be an absolute directory'), { code: 'workspace_invalid' });
      let directory;
      try { directory = fs.realpathSync(value); } catch { throw Object.assign(Error('workspace directory does not exist: ' + value), { code: 'workspace_missing' }); }
      if (!fs.statSync(directory).isDirectory()) throw Object.assign(Error('workspace path is not a directory: ' + value), { code: 'workspace_not_directory' });
      return directory;
    }
    const inherited = newMateContext()?.conversation?.cwd;
    if (typeof inherited === 'string' && path.isAbsolute(inherited)) { try { return fs.realpathSync(inherited); } catch { /* fall through */ } }
    const registry = workspaces();
    if (registry?.list) {
      const list = await registry.list();
      const first = Array.isArray(list) ? list.find((entry) => typeof entry?.path === 'string' && path.isAbsolute(entry.path)) : undefined;
      if (first) { try { return fs.realpathSync(first.path); } catch { /* fall through */ } }
    }
    throw Object.assign(Error('no workspace could be resolved for a new conversation; pass an absolute cwd'), { code: 'workspace_unknown' });
  }

  /** A preset id that can be mounted, or undefined when this host has no preset service. */
  async function resolvePreset() {
    const service = presets();
    if (!service) return undefined;
    const inherited = newMateContext()?.conversation?.preset;
    if (typeof inherited === 'string' && inherited.trim()) return inherited.trim();
    const fallback = service.defaultId;
    return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : undefined;
  }

  /**
   * The model selection a new conversation is created with.
   *
   * Precedence: the conversation this run answers for (its recorded provider/model), then the
   * bundle's own authorised model (wired in index.js from the core row). No default is invented:
   * the bundle's whole model rule is that a silently chosen model is a model the user did not
   * authorise, so an empty answer is a refusal, not a fallback.
   */
  function resolveModel() {
    const inherited = newMateContext()?.conversation?.model;
    const usable = (value) => value && typeof value.provider === 'string' && value.provider.trim() && typeof value.model === 'string' && value.model.trim() ? { provider: value.provider, model: value.model, ...typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {} } : undefined;
    const own = usable(inherited);
    if (own) return own;
    let bundled;
    try { bundled = services?.model?.(); } catch { bundled = undefined; }
    return usable(bundled);
  }

  async function create(args = {}) {
    const prompt = args.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) return refuse('invalid_prompt', 'prompt must be 1-' + MAX_PROMPT_CHARS + ' characters');
    if (created.size >= MAX_LIVE_CONVERSATIONS) return refuse('conversation_limit', 'this process already created ' + created.size + ' conversations; dispose one before creating another');
    const registry = agents();
    if (!registry?.create) return refuse('agents_unavailable', 'the DSH agents service is not reachable; a conversation cannot be created');
    let cwd, preset;
    try { cwd = await resolveCwd(args.cwd); } catch (error) { return refuse(error.code || 'workspace_invalid', error.message); }
    try { preset = await resolvePreset(); } catch (error) { return refuse('preset_unresolved', String(error.message)); }
    /**
     * A created conversation MUST carry a model selection.
     *
     * deliverConversation restores the model before it delivers, and it throws when neither
     * agent.options nor the session request header names one - so a session created without a
     * selection is a session whose first message can never be delivered. The model is therefore
     * resolved BEFORE creation and creation is refused when there is none: a conversation the
     * bundle cannot authorise a model for must not exist.
     */
    const model = resolveModel();
    if (!model) return refuse('model_unavailable', 'no provider/model selection is available for a new conversation; start it from a conversation context or choose a model in the plugin config');
    const sessionId = randomUUID();
    let handle;
    try {
      handle = await registry.create({
        sessionId,
        meta: { cwd, ...(preset ? { agentPreset: preset } : {}) },
        agentOptions: { ...model },
        // The preset is mounted here, before publication, because a created Agent takes its whole
        // composition from setup: without this mount the conversation runs on the Host composition
        // alone (the 45-tool / no-filesystem trap recorded in lib/conversation-delivery.js).
        ...(preset ? { setup: async (agentCtx) => { await presets().mount(agentCtx, preset); } } : {}),
      });
    } catch (error) {
      return refuse('create_failed', String(error.message));
    }
    created.set(sessionId, handle);
    try {
      await deliverConversation(agents(), sessionId, { id: randomUUID(), prompt }, undefined);
    } catch (error) {
      // The conversation exists but the first message did not cross the barrier: report both facts
      // rather than pretending the call failed as a whole.
      await dispose(sessionId).catch(() => {});
      return refuse('delivery_failed', String(error.message));
    }
    // Attach only after the first message crossed the durability barrier. The registry itself does
    // not need that (it validates the LIVE header, and the host attaches right after create); the
    // order is ours so that a conversation whose first message could not be delivered is disposed
    // in the branch above and never published into the user's workspace list.
    try { const workspace = await workspaces()?.resolveByPath?.(cwd); await workspace?.attachSession?.(sessionId); }
    catch (error) { log('newmate/conversation-workspace', error); }
    return { ok: true, sessionId, cwd, preset: preset ?? null, createdAt: now() };
  }

  async function send(args = {}) {
    const sessionId = text(args.sessionId);
    const prompt = args.prompt;
    if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS) return refuse('invalid_session', 'sessionId must be a non-empty session id');
    if (sessionId === newMateContext()?.conversation?.origin) return refuse('self_target', 'this run is already the conversation being addressed; answer in place instead');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) return refuse('invalid_prompt', 'prompt must be 1-' + MAX_PROMPT_CHARS + ' characters');
    const registry = agents();
    if (!registry) return refuse('agents_unavailable', 'the DSH agents service is not reachable');
    const live = registry.get?.(sessionId);
    if (live && conversationPaused(services?.goals?.(), live)) return refuse('target_paused', 'the user paused that conversation; it was not woken');
    const id = randomUUID();
    try {
      await deliverConversation(registry, sessionId, { id, prompt }, undefined);
    } catch (error) {
      return refuse('delivery_failed', String(error.message));
    }
    return { ok: true, sessionId, messageId: 'newmark-task:' + id };
  }

  async function read(args = {}) {
    const sessionId = text(args.sessionId);
    if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS) return refuse('invalid_session', 'sessionId must be a non-empty session id');
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), MAX_READ_MESSAGES) : DEFAULT_READ_MESSAGES;
    const maxChars = Number.isInteger(args.maxChars) ? Math.min(Math.max(args.maxChars, 200), MAX_READ_CHARS) : MAX_READ_CHARS;
    let header, events, from;
    const live = agents()?.get?.(sessionId);
    if (live?.session?.snapshotEvents) {
      events = live.session.snapshotEvents();
      header = live.session.header;
      from = 'live';
    } else {
      const store = persistence();
      if (!store?.load) return refuse('unknown_conversation', 'no live conversation and no session persistence to read it from');
      // inspect() is the READ-ONLY read: load() commits cold recovery, which is a write, and a
      // transcript read must not repair anything on disk. load() stays as the fallback for a host
      // whose persistence service is older than inspect.
      try {
        const loaded = store.inspect ? await store.inspect(sessionId) : await store.load(sessionId);
        events = loaded?.events; header = loaded?.meta; from = 'persisted';
      }
      catch (error) { return refuse('unknown_conversation', 'that conversation could not be read: ' + String(error.message)); }
    }
    const all = (Array.isArray(events) ? events : []).map(messageOf).filter(Boolean);
    const bounded = boundTranscript(all, { limit, maxChars });
    return {
      ok: true,
      sessionId,
      from,
      cwd: typeof header?.cwd === 'string' ? header.cwd : null,
      createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
      title: typeof header?.title === 'string' ? header.title : null,
      total: all.length,
      messages: bounded.messages,
      chars: bounded.chars,
      truncated: { messages: bounded.droppedMessages > 0, chars: bounded.chars >= maxChars || bounded.clipped, droppedMessages: bounded.droppedMessages, droppedChars: bounded.droppedChars },
    };
  }

  async function dispose(sessionId) {
    const handle = created.get(sessionId);
    if (!handle) return false;
    created.delete(sessionId);
    try { await handle.dispose?.(); } catch (error) { log('newmate/conversation-dispose', error); }
    return true;
  }

  /** Dispose every conversation this bridge created. Called once when the component stops. */
  async function stop() {
    const ids = [...created.keys()];
    await Promise.all(ids.map((id) => dispose(id)));
    return ids.length;
  }

  const definitions = [
    {
      name: 'newmate_conversation_new',
      description: 'Start a new DSH conversation in a workspace and give it its first message. It becomes a real conversation the user can open, and it runs one model turn. Omit cwd to inherit the workspace of the conversation you are answering; the number of conversations you may create per process is capped.',
      parameters: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS }, cwd: { type: 'string', description: 'Absolute workspace directory. Omit to inherit the requesting conversation workspace.' } }, required: ['prompt'], additionalProperties: false },
      execute: (args) => create(args),
    },
    {
      name: 'newmate_conversation_send',
      description: 'Deliver one message into an existing DSH conversation, which then runs a turn on it. The message is attributed to the host runner, not to the user. A conversation the user paused is refused, and a delivery is not confirmation that the conversation answered.',
      parameters: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: MAX_SESSION_ID_CHARS }, prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS } }, required: ['sessionId', 'prompt'], additionalProperties: false },
      execute: (args) => send(args),
    },
    {
      name: 'newmate_conversation_read',
      description: 'Read a bounded transcript of one DSH conversation: newest user/assistant text only, no reasoning and no tool calls. Report what was dropped instead of implying you saw everything.',
      parameters: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1, maxLength: MAX_SESSION_ID_CHARS }, limit: { type: 'integer', minimum: 1, maximum: MAX_READ_MESSAGES }, maxChars: { type: 'integer', minimum: 200, maximum: MAX_READ_CHARS } }, required: ['sessionId'], additionalProperties: false },
      execute: (args) => read(args),
    },
  ];

  return { definitions, create, send, read, dispose, stop, created: () => [...created.keys()] };
}
