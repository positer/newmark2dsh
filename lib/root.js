/**
 * The shared Newmark root, as a rule rather than an instance.
 *
 * Every row resolves the same root from its own `config.root`, so no row has to
 * depend on another being active. One rule, one implementation, three consumers —
 * which is what keeps the rows independently switchable: a component row that
 * cannot reach a sibling's service can still find the store, and a component row
 * that is switched off cannot break the others.
 */
import os from 'node:os';
import path from 'node:path';

/** Newmark's conventional user-level root. */
export function defaultRoot() {
  return path.join(os.homedir(), '.Newmark');
}

/** Resolve the shared user root: config wins, otherwise Newmark's own path. */
export function resolveRoot(config) {
  const configured = typeof config?.root === 'string' ? config.root.trim() : '';
  return configured ? path.resolve(configured) : defaultRoot();
}
