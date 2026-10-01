/**
 * The bundle's failure log: every failure is written under the shared root AND printed.
 *
 * The user's instruction is exact — 所有失败行为都要在.Newmark保存报错打印 — and it is two
 * obligations, not one. **Both, every time**: a line in `<root>/errors.jsonl`, and the same
 * failure through `ctx.logger.error`, so it lands in the DSH host log. The file is for looking
 * afterwards; the log is for seeing it at the time. Neither is a substitute for the other.
 *
 * ## Why the root, and not `Memory Lab/`
 *
 * The instruction says 所有失败行为 — every failure behaviour — and the failures are not all
 * MemoryLab's: the model write and the preset switch belong to the core row, and the backends
 * belong to ComputerUse. So the log sits at the Newmark root, beside the store rather than
 * inside it, and it is the ONLY write this bundle makes under `~/.Newmark` outside the store it
 * already owns.
 *
 * The path is NOT written down. It is `path.join(resolveRoot(config), 'errors.jsonl')`, derived
 * from the same rule the store uses (`lib/root.js`), so a redirected `NEWMARK_USER_ROOT` moves
 * the log with the store and this file never becomes a literal path that works on one machine.
 *
 * ## The shape, and why it is JSONL beside `policy.jsonl`
 *
 *     {"at":"2026-10-01T01:23:45.678Z","where":"memorylab/judgement","code":"run_timeout",
 *      "message":"运行在 300000 ms 内没有结束，已被中止","detail":"Error: … <- Error: …"}
 *
 * One JSON object per line, appended. `policy.jsonl` is this store's existing audit trail, so a
 * reader who can read one can read the other; and a line-per-object file survives a truncated
 * tail, a concurrent writer and a `Select-String` over the tail, which a rewritten JSON array
 * would not.
 *
 * `where` names the component and the half — `memorylab/rebuild`, `memorylab/judgement`,
 * `core/model-write`, `core/preset-switch`, `core/compose`, `computeruse/backend`. `code` is
 * stable and machine-readable, and it is the OPERATION'S OWN code wherever the operation has
 * one: a run that answered `max_steps` is recorded as `max_steps`, not as `judgement_failed`,
 * because a code that summarises is a code that hides which failure happened. `detail` carries
 * the cause chain where there is one.
 *
 * ## The four rules, and why each is a rule
 *
 * 1. **Logging a failure must never throw.** Disk full, permissions, a missing directory, a bad
 *    root, a hostile `message` object, a logger that itself throws — every one of those is
 *    caught here. A failure logger that becomes a new failure source is worse than no logger,
 *    because it takes down the operation it was describing. {@link createErrorLog} therefore
 *    has no throwing path at all: it returns `{ ok, path, error }` and a caller that ignores
 *    the answer loses nothing.
 *
 * 2. **A failure must not be disguised.** This bundle has already lost two releases to that
 *    exact mistake — `memory_lab_reindex` wrote correctly and reported failure (0.2.2), and the
 *    model write succeeded and reported failure (0.2.4) — so the rule is written here as well
 *    as at each call site: a timeout is recorded as a timeout, `agent-api` switched off is its
 *    own code and never "nothing to do", and where a run answered with a code, that code is
 *    what is recorded.
 *
 * 3. **Zero findings is NOT a failure.** See the exclusion note on `done()` in
 *    `components/memorylab/component.js`: `none` (the deterministic rebuild left nothing to
 *    judge) and `judged` (a run answered) write nothing, because a clean store pressed twice
 *    would otherwise fill this file with noise and teach its reader to ignore it.
 *
 * 4. **One line per failure, appended, never rewritten.** There is no truncation, no rotation
 *    and no read-modify-write anywhere in this module: `fs.appendFileSync(…, { flag: 'a' })` is
 *    the only write, which is also what makes two halves logging at once safe.
 *
 * ## The directory may not exist
 *
 * Creating it is fine; failing to create it falls back to the logger and never throws. The
 * append is tried first and a missing directory is retried once after `mkdirSync`, so the
 * steady state — a root that exists, because the store is in it — costs no extra `stat` at all.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The file, at the Newmark root. Never a literal path: see the header. */
export const ERROR_LOG_FILENAME = 'errors.jsonl';

/**
 * The absolute path of the log for a root, or `''` when there is no usable root.
 *
 * `''` is a real answer and not an error: a row mounted by hand with no root has nowhere to
 * write, and the honest response is to print the failure and say the log has no path — never to
 * invent one, and never to write `errors.jsonl` into whatever the process's working directory
 * happens to be.
 */
export function errorLogPath(root) {
  try {
    if (typeof root !== 'string' || root.trim() === '') return '';
    return path.join(path.resolve(root), ERROR_LOG_FILENAME);
  } catch {
    return '';
  }
}

/**
 * A string for anything, without ever throwing.
 *
 * `String(value)` throws for an object with a hostile `toString`, and a `message` is whatever a
 * caller passed, so every conversion in this module goes through here.
 */
function safeText(value, fallback = '') {
  try {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return fallback;
    const text = String(value);
    return text === 'undefined' || text === 'null' ? fallback : text;
  } catch {
    return fallback;
  }
}

/** One failure in the words a person reads: `TypeError: this is what went wrong`. */
export function describeError(error) {
  try {
    if (error instanceof Error) {
      const message = safeText(error.message, '');
      const name = safeText(error.name, 'Error');
      return message === '' ? name : `${name}: ${message}`;
    }
    return safeText(error, 'an unknown failure');
  } catch {
    return 'an unknown failure';
  }
}

/**
 * The cause chain of a failure, outermost first, as one line.
 *
 * `detail` is what makes a logged failure diagnosable rather than merely known: `EACCES` on its
 * own says nothing, `Error: the write was refused <- EACCES: permission denied, open
 * 'cordis.patch.yml'` says where to look. The depth is bounded because a chain built in a loop
 * is a chain that can be infinite, and a log line is not the place to find that out.
 */
export function causeChain(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const text = describeError(current);
    if (text !== '' && parts[parts.length - 1] !== text) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
}

/**
 * A `JSON.stringify` replacer that cannot throw.
 *
 * `JSON.stringify` throws on a circular structure and on a `BigInt`, and both can reach here
 * through the optional `fields` — a run's own result object is not this module's to trust. The
 * seen-set is per call, so one object appearing twice as a SIBLING is not treated as a cycle.
 */
function safeReplacer(seen) {
  return function replacer(key, value) {
    if (typeof value === 'bigint') return String(value);
    if (value instanceof Error) {
      return { name: safeText(value.name, 'Error'), message: safeText(value.message, '') };
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * The line for one failure, as an object.
 *
 * The four required fields are forced to strings, and anything else the caller sent rides along
 * so a reader gets the run's own `exit`, `status`, `turns` and `toolCalls` without a second
 * lookup. `fields` may not overwrite the required keys: a caller able to rename `where` would be
 * able to make a failure say it happened somewhere else.
 */
function buildLine(failure) {
  const source = failure !== null && typeof failure === 'object' ? failure : {};
  const line = {
    at: safeText(source.at, '') || new Date().toISOString(),
    where: safeText(source.where, 'unknown'),
    code: safeText(source.code, 'unknown'),
    message: safeText(source.message, 'a failure with no message'),
  };
  const detail = safeText(source.detail, '');
  if (detail !== '') line.detail = detail;
  const fields = source.fields;
  if (fields !== null && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === 'at' || key === 'where' || key === 'code' || key === 'message' || key === 'detail') continue;
      line[key] = value;
    }
  }
  return line;
}

/** A line as text. Cannot throw: a value that defeats the serialiser degrades to a line saying so. */
function lineText(line) {
  try {
    const text = JSON.stringify(line, safeReplacer(new WeakSet()));
    if (text !== undefined) return text;
  } catch {
    // Fall through to the report below: a failure with no line is the thing this module exists
    // to prevent, so even an unserialisable failure gets one.
  }
  return JSON.stringify({
    at: safeText(line.at, '') || new Date().toISOString(),
    where: safeText(line.where, 'unknown'),
    code: safeText(line.code, 'unknown'),
    message: 'a failure that could not be serialised',
    detail: safeText(line.message, ''),
  });
}

/**
 * Append one line, creating the directory if that is what is missing.
 *
 * @returns `null` on success, or the error that stopped it.
 */
function appendLine(file, text) {
  try {
    fs.appendFileSync(file, text, { encoding: 'utf8', flag: 'a' });
    return null;
  } catch (error) {
    // The directory may not exist. That is the one case worth a second attempt; everything else
    // (permissions, a full disk, a file where the directory should be) is reported, not retried.
    if (error?.code !== 'ENOENT') return error;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text, { encoding: 'utf8', flag: 'a' });
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * The failure log for one root.
 *
 * @param options.root — the shared Newmark user root, from `lib/root.js`. Never the memory
 *   folder: a failure is not MemoryLab's property, and the log sits beside the store.
 * @param options.logger — the row's `ctx.logger`. Optional, because a hand-mounted row may have
 *   none; a missing logger means the file is the only record, which still beats silence.
 * @returns `{ path, record }`. `record()` never throws and never rejects; its answer is for
 *   tests and diagnostics, and a caller that ignores it loses nothing.
 */
export function createErrorLog({ root, logger } = {}) {
  const file = errorLogPath(root);

  /** Print, through whatever logger there is, without ever letting the logger become the failure. */
  const print = (text) => {
    try {
      logger?.error?.(text);
    } catch {
      // A logger that throws must not take down the operation it was describing. There is
      // nowhere left to report that, so it is deliberately swallowed.
    }
  };

  return {
    /** Where lines go. `''` means "printed only", and `record()` says so in its answer. */
    path: file,

    /**
     * Record one failure: printed always, appended whenever there is a root to append to.
     *
     * @param failure.where — component and half, e.g. `memorylab/judgement`.
     * @param failure.code — stable and machine-readable, the operation's own code where it has
     *   one, never a summary of it.
     * @param failure.message — what happened, in one sentence.
     * @param failure.detail — the cause chain, where there is one.
     * @param failure.fields — anything else worth carrying (a run's `exit`, a status, a count).
     * @returns `{ ok, path, error }`. Never throws.
     */
    record(failure) {
      let line;
      try {
        line = buildLine(failure);
      } catch {
        // `buildLine` has its own guards; this one exists because rule 1 has no exceptions.
        line = { at: new Date().toISOString(), where: 'unknown', code: 'unknown', message: 'a failure that could not be read' };
      }

      // PRINTED FIRST, before the write is even attempted: the host log is what a person
      // watching sees, and a write that hangs or ends the process must not be able to steal the
      // only report of the failure.
      print(
        `newmark-core/failure: where=${line.where} code=${line.code} message=${line.message}` +
          (line.detail === undefined ? '' : ` detail=${line.detail}`) +
          (file === '' ? ' [no resolved root: printed only]' : ` log=${file}`),
      );

      if (file === '') return { ok: false, path: '', error: 'no_root' };

      const writeError = appendLine(file, lineText(line) + '\n');
      if (writeError === null) return { ok: true, path: file };

      // The log itself failed. That is a failure too, and it is printed rather than thrown —
      // rule 1 — so the failure above is at least visible where a person is looking.
      print(
        `newmark-core/failure: the error log ${file} could not be written ` +
          `(${safeText(writeError?.code, 'unknown')}) ${describeError(writeError)}; the failure above is printed only`,
      );
      return { ok: false, path: file, error: describeError(writeError) };
    },
  };
}
