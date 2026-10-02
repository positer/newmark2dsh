/**
 * The C# dialect every native helper in this component must be written in, as one rule in
 * one place.
 *
 * =====================================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================================
 *
 * `lib/win32.js` carries a single C# helper (`NATIVE_CSHARP`, 43.5 KB, 87 public static
 * methods) and it contains none of the constructs listed below. That is not an accident and
 * it is not tidiness: the lane host falls back to `powershell.exe` when `pwsh` cannot be
 * spawned (`lib/win32.js` `ensureChild`), and Windows PowerShell 5.1 compiles `Add-Type`
 * input with the C# 5 compiler shipped in .NET Framework 4. One `$"..."`, one `?.`, one
 * `out var` and the WHOLE lane stops compiling - every action of ComputerUse, at once, with
 * the compiler's error surfacing as a lane failure rather than as a syntax error.
 *
 * A phase wrote a version of this rule, measured that it could fail (it went red on two
 * genuine defects in that phase's own code before going green at 27/0), and then deleted it
 * when it reverted its changes. Nothing has enforced the rule since. It is re-applied here
 * so that it is enforced by a file rather than by memory.
 *
 * There is a second, narrower trap recorded at `lib/win32.js:985-988`: `Add-Type` hands the
 * compiler no reference to `System.Drawing.Common`, so NAMING such a type inside the helper
 * fails to compile with CS1069. The helper returns an `HBITMAP` as an integer for exactly
 * that reason. The PowerShell that SURROUNDS the helper uses `System.Drawing` freely; only
 * the C# block is constrained.
 *
 * =====================================================================================
 * WHY THE CHECK RUNS OVER STRIPPED TEXT
 * =====================================================================================
 *
 * The shipped helper carries a doc comment that names `System.Drawing.Bitmap` in order to
 * explain why it does not use one (`lib/win32.js:985`). A check over raw text would go red
 * on the sentence that documents the rule. So comments and string/char literal CONTENT are
 * removed first - but the string DELIMITERS are kept, because `$"` is a violation precisely
 * when it opens a string, and a stripper that removed the whole literal would hide it.
 *
 * The checker is deliberately textual rather than "just compile it": a compile gate needs a
 * compiler, a reference list and a scratch directory, so it cannot run inside the lane it is
 * protecting. `lib/win32.js` is never imported here and nothing in this file executes a
 * child process.
 */

/**
 * The constructs the measured dialect does not contain.
 *
 * Each entry is a name, the regular expression that finds it in stripped text, and the
 * sentence a failure prints. The list is frozen so a caller cannot narrow the rule by
 * mutating it in place.
 */
export const MODERN_CSHARP = Object.freeze([
  Object.freeze({
    id: 'interpolated-string',
    pattern: /\$"/,
    description: 'an interpolated string ($")',
  }),
  Object.freeze({
    id: 'arrow',
    pattern: /=>/,
    description: 'a lambda or expression-bodied member (=>)',
  }),
  Object.freeze({
    id: 'nameof',
    pattern: /\bnameof\s*\(/,
    description: 'nameof(...)',
  }),
  Object.freeze({
    id: 'out-var',
    pattern: /\bout\s+var\b/,
    description: 'an out variable declaration (out var x)',
  }),
  Object.freeze({
    /*
     * Deliberately only the UNAMBIGUOUS tuple markers.
     *
     * A first version of this rule also matched a tuple type spelled as a parenthesised list
     * of type-and-name pairs. Measured against the shipped helper it produced 50 violations,
     * EVERY ONE of them an ordinary parameter list - `(uint count, CuEvent[] events, int
     * eventSize)` and 49 more. A tuple type and a parameter list are lexically identical in
     * C#: `(int a, int b)` is both. So a regular expression cannot decide this one, and a
     * rule narrowed until it stops firing on real code is a rule that stops meaning anything.
     *
     * What is left here are the markers that cannot be anything else. Tuple SYNTAX with no
     * marker - `(int, string) Foo()`, `var (a, b) = pair`, `(a, b) = (b, a)` - is covered by
     * the compile gate instead (`scripts/verify-computeruse-native-dialect.mjs`), which hands
     * the payload to the same C# 5 compiler the lane falls back to and is therefore exact.
     */
    id: 'tuple',
    pattern: /(?:\bValueTuple\b)|(?:\bSystem\s*\.\s*Tuple\s*<)|(?:\bvar\s*\(\s*[A-Za-z_]\w*\s*,)/,
    description: 'a tuple type or deconstruction that names itself (ValueTuple, System.Tuple<, var (a, b))',
  }),
  Object.freeze({
    id: 'null-conditional',
    pattern: /\?\./,
    description: 'a null-conditional or null-coalescing access (?. or ?[)',
  }),
  Object.freeze({
    id: 'using-static',
    pattern: /\busing\s+static\b/,
    description: 'using static',
  }),
]);

/**
 * Type names that cannot be written in the helper at all.
 *
 * `Add-Type` gives the compiler no `System.Drawing.Common` reference, so a helper that names
 * one of these fails with CS1069 instead of compiling. The bare names are here as well as
 * the namespace because the failure is the same either way.
 */
export const FORBIDDEN_DRAWING_NAMES = Object.freeze([
  Object.freeze({ id: 'system-drawing', pattern: /\bSystem\s*\.\s*Drawing\b/, description: 'the System.Drawing namespace' }),
  Object.freeze({ id: 'bitmap', pattern: /\bBitmap\b/, description: 'the type Bitmap' }),
  Object.freeze({ id: 'graphics', pattern: /\bGraphics\b/, description: 'the type Graphics' }),
  Object.freeze({ id: 'image-format', pattern: /\bImageFormat\b/, description: 'the type ImageFormat' }),
  Object.freeze({ id: 'solid-brush', pattern: /\bSolidBrush\b/, description: 'the type SolidBrush' }),
  Object.freeze({ id: 'drawing-pen', pattern: /\bPen\b/, description: 'the type Pen' }),
]);

/**
 * Strip C# comments and the CONTENT of string and character literals.
 *
 * Handles `//`, `/* *\/`, `"..."` with backslash escapes, `@"..."` verbatim strings with
 * doubled quotes, and `'c'` character literals. Delimiters survive, so an interpolated
 * string is still visible as `$"` and `@"` is still visible as `@"`. Newlines are preserved
 * so a reported line number still points at the line the violation is on.
 *
 * This is a scanner rather than a regular expression on purpose: a regex cannot tell a `"`
 * inside a comment from a `"` that opens a string, and the shipped helper contains both.
 */
export function stripCommentsAndStrings(source) {
  const text = String(source === null || source === undefined ? '' : source);
  const out = [];
  let index = 0;
  const length = text.length;
  const emit = (value) => { out.push(value); };
  const emitNewlines = (value) => {
    let count = 0;
    for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) === 10) count += 1;
    for (let i = 0; i < count; i += 1) emit('\n');
  };
  while (index < length) {
    const here = text[index];
    const next = index + 1 < length ? text[index + 1] : '';
    if (here === '/' && next === '/') {
      let end = index;
      while (end < length && text.charCodeAt(end) !== 10) end += 1;
      emitNewlines(text.slice(index, end));
      index = end;
      continue;
    }
    if (here === '/' && next === '*') {
      let end = index + 2;
      while (end < length && !(text[end] === '*' && text[end + 1] === '/')) end += 1;
      end = Math.min(length, end + 2);
      emitNewlines(text.slice(index, end));
      index = end;
      continue;
    }
    if (here === '@' && next === '"') {
      // A verbatim string: only a doubled quote ends it, and a backslash means nothing.
      let end = index + 2;
      while (end < length) {
        if (text[end] === '"') {
          if (text[end + 1] === '"') { end += 2; continue; }
          end += 1;
          break;
        }
        end += 1;
      }
      emit('@"');
      emitNewlines(text.slice(index + 1, end));
      emit('"');
      index = end;
      continue;
    }
    if (here === '"') {
      let end = index + 1;
      while (end < length) {
        const character = text[end];
        if (character === '\\') { end += 2; continue; }
        if (character === '"') { end += 1; break; }
        if (character === '\n') break;
        end += 1;
      }
      emit('"');
      emitNewlines(text.slice(index, Math.min(end, length)));
      emit('"');
      index = end;
      continue;
    }
    if (here === "'") {
      let end = index + 1;
      while (end < length) {
        const character = text[end];
        if (character === '\\') { end += 2; continue; }
        if (character === "'") { end += 1; break; }
        if (character === '\n') break;
        end += 1;
      }
      emit("''");
      index = Math.min(end, length);
      continue;
    }
    emit(here);
    index += 1;
  }
  return out.join('');
}

/** The 1-based line and column of an offset, for a failure message that can be acted on. */
function locate(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) { line += 1; lineStart = i + 1; }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Every violation in one C# source, as values rather than as a boolean.
 *
 * Returns an array of `{ id, description, line, column, excerpt }`. An empty array means the
 * source is in the dialect. The excerpt is taken from the STRIPPED text so a failure shows
 * the code that is actually there and not the comment that was removed.
 */
export function findDialectViolations(source, options = {}) {
  const stripped = stripCommentsAndStrings(source);
  const rules = options.includeDrawing === false
    ? MODERN_CSHARP
    : MODERN_CSHARP.concat(FORBIDDEN_DRAWING_NAMES);
  const found = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let match = pattern.exec(stripped);
    while (match) {
      const offset = match.index;
      const { line, column } = locate(stripped, offset);
      const excerptStart = Math.max(0, offset - 40);
      const excerptEnd = Math.min(stripped.length, offset + match[0].length + 40);
      found.push({
        id: rule.id,
        description: rule.description,
        line,
        column,
        excerpt: stripped.slice(excerptStart, excerptEnd).replace(/\s+/g, ' ').trim(),
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(stripped);
    }
  }
  found.sort((left, right) => (left.line - right.line) || (left.column - right.column) || left.id.localeCompare(right.id));
  return found;
}

/**
 * The body of the template literal that starts at `anchor`, or an explanation of why not.
 *
 * The C# payloads live in JavaScript template literals. A backtick inside one terminates it
 * and breaks the module - a previous phase lost a lane to exactly that, with a backtick in a
 * C# doc comment. This finds the body between the opening backtick on the anchor line and the
 * first closing backtick that is followed only by `;` or end-of-line, which is how every
 * payload in this component ends.
 *
 * Returns `{ ok: true, body, startLine }` or `{ ok: false, reason }`. It never throws on a
 * missing anchor: a payload that has moved is a fact to report, not an exception.
 */
export function extractTemplateLiteral(source, anchor) {
  const text = String(source === null || source === undefined ? '' : source);
  const at = text.indexOf(anchor);
  if (at < 0) return { ok: false, reason: `the anchor ${JSON.stringify(anchor)} does not appear in the source` };
  const open = text.indexOf('`', at);
  if (open < 0) return { ok: false, reason: `the anchor ${JSON.stringify(anchor)} is not followed by a template literal` };
  let index = open + 1;
  while (index < text.length) {
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] === '`') {
      const rest = text.slice(index + 1);
      const lineEnd = rest.search(/\r?\n/);
      const tail = (lineEnd < 0 ? rest : rest.slice(0, lineEnd)).trim();
      if (tail === '' || tail === ';') {
        const startLine = text.slice(0, open).split('\n').length;
        return { ok: true, body: text.slice(open + 1, index), startLine };
      }
    }
    index += 1;
  }
  return { ok: false, reason: `the template literal opened after ${JSON.stringify(anchor)} is never closed` };
}

/**
 * True when the source is in the dialect. The thin boolean form, for a caller that only
 * wants to assert; the violations themselves come from `findDialectViolations`.
 */
export function isDialectClean(source, options) {
  return findDialectViolations(source, options).length === 0;
}
