import { AsyncLocalStorage } from 'node:async_hooks';
// Agent API may resolve tools at process scope for PTC. Keep the initiating session
// without changing tool visibility or accepting model arguments as credentials.
const callers = new AsyncLocalStorage();
export function computerUseCaller(execution) {
  const id = execution?.agent?.session?.id || execution?.agent?.id;
  return id ? `dsh-session:${id}` : callers.getStore();
}
export function withComputerUseCaller(execution, run) {
  return callers.run(computerUseCaller(execution), run);
}
