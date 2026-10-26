import { AsyncLocalStorage } from 'node:async_hooks';
// Agent API may resolve tools at process scope for PTC. Keep the initiating session
// without changing tool visibility or accepting model arguments as credentials.
const callers = new AsyncLocalStorage();
/**
 * The identity a ComputerUse lease belongs to when no DSH conversation is attached.
 *
 * A lease is exclusive per desktop mode and has NO expiry, so the owner string is a safety
 * boundary and not merely a label: `takeover_stop` refuses to release a lease held by another
 * owner. NewMate drives the same two ComputerUse tools as a conversation does, and it may not
 * borrow the requesting conversation's identity (its lease would then be indistinguishable from
 * that conversation's, and a later `takeover_stop` from the conversation could end it) nor fall
 * back to the shared `dsh` label (every direct API caller that declares nothing uses it). So a
 * NewMate run binds its own stable owner for the length of the run, and nothing the model emits
 * can change it.
 */
const owners = new AsyncLocalStorage();
export function computerUseCaller(execution) {
  const id = execution?.agent?.session?.id || execution?.agent?.id;
  return id ? `dsh-session:${id}` : callers.getStore();
}
export function withComputerUseCaller(execution, run) {
  return callers.run(computerUseCaller(execution), run);
}
/** Bind a ComputerUse owner for everything inside `run`. Used by NewMate's run wrapper. */
export function withComputerUseOwner(owner, run) {
  return owners.run(owner, run);
}
/**
 * The owner a ComputerUse action is attributed to.
 *
 * Precedence, highest first: the host's own agent identity (a conversation calling the tool
 * directly), the owner a caller bound explicitly (`withComputerUseOwner` — NewMate), and the
 * initiating session recorded by `withComputerUseCaller` for callers that still use that
 * channel. The model's `owner_id` argument stays a last-resort label for direct API callers and
 * is never consulted here; `components/computeruse/component.js` applies it after this answer is
 * empty.
 */
export function computerUseOwner(execution) {
  const id = execution?.agent?.session?.id || execution?.agent?.id;
  if (id) return `dsh-session:${id}`;
  return owners.getStore() || callers.getStore();
}
