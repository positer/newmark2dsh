/**
 * The shared Newmark root, as a rule rather than an instance.
 *
 * Every row resolves the same root from its own `config.root`, so no row has to
 * depend on another being active. One rule, one implementation, three consumers —
 * which is what keeps the rows independently switchable: a component row that
 * cannot reach a sibling's service can still find the store, and a component row
 * that is switched off cannot break the others.
 *
 * ## Following Newmark, rather than coinciding with it
 *
 * Newmark decides its own root in `userRuntimeRoot()` (identical in its `main.ts` and its
 * launcher):
 *
 *     return path.join(os.homedir(), '.Newmark');
 *
 * so the conventional path is a HOME-relative rule and this file must never be a literal
 * path — a plugin that hardcoded one would work on exactly one machine. `defaultRoot()` is
 * that same rule, which is why it is written as a join here too.
 *
 * Newmark's own tooling also honours a `NEWMARK_USER_ROOT` override
 * (`DESKTOP/scripts/release-installed-readonly-validation-stress.cjs`:
 * `path.resolve(process.env.NEWMARK_USER_ROOT || path.join(os.homedir(), '.Newmark'))`).
 * A redirected Newmark and this plugin must not end up reading two different stores, so the
 * same override is honoured here, in the same position: after the explicit config, before
 * the convention.
 *
 * What is deliberately NOT followed is Newmark's `--root` command-line argument
 * (`main.ts` `resolveRoot`). That flag belongs to a process launch, and this plugin has no
 * way to observe how another process was started; inventing a guess would be worse than
 * saying so. `config.root` is the supported way to point this plugin at such a root.

 * ## One implementation, re-exported
 *
 * This file is the ONLY place the root rule is written. The root module inside each component
 * re-exports from here, so a change to the rule reaches every component by being made once —
 * the components are not edited for it. Anything added below is therefore reached by all three
 * consumers at once, which is the point and also the caution.
 *
 * (Written without the usual glob spelling on purpose: the two characters that end a block
 * comment appear inside a path like the one this sentence avoids, and an earlier draft of this
 * paragraph closed its own comment and turned the rest of the line into code. The first draft
 * of a comment is not exempt from being parsed.)
 */
import os from 'node:os';
import path from 'node:path';

/** Newmark's conventional user-level root: `<home>/.Newmark`, never a literal path. */
export function defaultRoot() {
  return path.join(os.homedir(), '.Newmark');
}

/** The override Newmark's own tooling reads, in the same position Newmark puts it. */
export function envRoot(env = process.env) {
  const declared = typeof env?.NEWMARK_USER_ROOT === 'string' ? env.NEWMARK_USER_ROOT.trim() : '';
  return declared ? path.resolve(declared) : '';
}

/**
 * Resolve the shared user root. Precedence, highest first:
 *   1. this plugin's own `config.root` — what the user typed into the row;
 *   2. `NEWMARK_USER_ROOT`, so a redirected Newmark and this plugin share one store;
 *   3. `<home>/.Newmark`, the rule Newmark's `userRuntimeRoot()` states.
 */
export function resolveRoot(config, env = process.env) {
  const configured = typeof config?.root === 'string' ? config.root.trim() : '';
  if (configured) return path.resolve(configured);
  return envRoot(env) || defaultRoot();
}

