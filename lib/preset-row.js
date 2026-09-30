/**
 * Selecting the Dev preset, by editing the profile patch.
 *
 * ## What this module is, after the 2026-09-30 change
 *
 * The Dev preset belongs to this bundle, and the bundle's own patch *declares* it
 * (`- id: preset-dev` → `@deepseek-ai/dsh-agent-preset`) and *selects* it (the
 * `agent-preset-registry` entry's `config.selectedDefault`). The switch used to write an
 * id-targeted `disabled: true` onto the declaring row, which was accepted and reported
 * "off" while the registry kept selecting `dev` from the bundle layer — a file that
 * contradicted itself. The switch now writes the field that actually decides, and this
 * header is the evidence for why that field and no other.
 *
 * ## The registry's config surface, measured in the installation
 *
 * `@deepseek-ai/dsh-agent-preset-registry/lib/index.js:471-474`:
 *
 *     static Config = z.object({
 *       default: z.string().required(),
 *       selectedDefault: z.string().volatile()
 *     });
 *
 * `lib/index.js:493-495`: `get defaultId() { return this.config.selectedDefault.get() ??
 * this.config.default; }` — `selectedDefault` decides which preset a new session starts
 * in, and `default` is the required value the registry falls back to when
 * `selectedDefault` states nothing. `remoteExportList` (`lib/index.js:592-598`) marks
 * `isDefault: row.id === defaultId`, which is the flag the picker renders as "in use".
 *
 * **There is no "hide" field.** `list()` (`lib/index.js:577-588`) and
 * `remoteExportList()` (`lib/index.js:592-598`) emit every registered definition, and the
 * picker renders every row it is given, splitting them into built-in and custom groups
 * and nothing else (`@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js:897-1013`). The
 * declaring row's own Config has no such key either
 * (`@deepseek-ai/dsh-agent-preset/lib/index.js:13-19`: `id`, `name`, `description`,
 * `order`, `plugins`). The only way to remove a preset from that picker is to stop
 * declaring it, which is exactly the mechanism this module replaced — and it is the
 * self-contradiction the change exists to remove, because the registry would still be
 * selecting `dev`. So the switch **deselects** the preset and the panel says so; it does
 * not claim to hide it.
 *
 * ## Why the profile patch is the right home for this value
 *
 * It is the same field the shell's own picker writes, through the settings service:
 * `dsh-client-ui-agent-preset/lib/client.js:1060` names the namespace
 * `agent-preset-registry`, `:1072` calls
 * `ctx.remote.settings.update('agent-preset-registry', { selectedDefault: id })`, the
 * host's `SettingsForms.write` (`dsh-settings/lib/index.js:501-537`) resolves the volatile
 * field and hands the edit to `configEditor.edit`, and `dsh-config-editor/lib/index.js`
 * writes to `profileContext.patchPath` — `:24-26` names the document, `:98` finds the
 * last id-matched non-`insert` entry, `:110` sets its `config`. A profile-patch edit is
 * therefore not a workaround for that API; it targets the same key in the same file.
 *
 * ## The traps this module still has to avoid
 *
 * `preset-dev`'s entry carries a `plugins:` list whose members have their OWN `disabled:`
 * keys — `disabled: !!js process.platform === 'win32'` at eight spaces. An earlier version
 * matched `/^\s+disabled:/`, found those nested lines, rewrote them at two-space indent,
 * and produced `YAMLException: bad indent`: the Loader refused the whole file.
 *
 * So every entry has a **measured extent** (its `- id:` line to the next line matching
 * `/^- /`), the config key is read only at **exactly two spaces** and the field only at
 * **exactly four**, the resulting TEXT is parsed with DSH's own parser, the value is read
 * back through that parse and compared with the intent, and the parsed document is
 * compared with the original everywhere except the one field. Anything else is refused,
 * with the line and the reason, and nothing is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** The preset this module selects. */
export const PRESET_ID = 'dev';

/** The preset it falls back to when the Dev preset is deselected. */
export const FALLBACK_PRESET_ID = 'standard';

/** The registry entry whose config decides which preset is the default. */
export const SELECTOR_ENTRY_ID = 'agent-preset-registry';

/** That entry's module, as the bundle patch and the profile patch both name it. */
export const SELECTOR_ENTRY_NAME = '@deepseek-ai/dsh-agent-preset-registry';

/** The one config key this module writes. Read only at exactly four spaces. */
export const SELECTOR_KEY = 'selectedDefault';

/**
 * The Loader row that DECLARES the Dev preset.
 *
 * Read-only for this module: it is where the preset comes from, not where the selection
 * lives, and writing `disabled` there was the mechanism this one replaced.
 */
export const PRESET_ROW_ID = 'preset-dev';

/**
 * The wire key the panel sends as `component` and reads back from the GET.
 *
 * It is NOT the Loader row id, and conflating the two is what made the switch dead: the
 * route compared `component` against `preset-dev` while the panel sent `presetDev`, so
 * every click answered `unknown_component` and wrote nothing. One constant, used by both
 * the GET payload key and the POST branch, is what keeps them in step.
 */
export const PRESET_COMPONENT_KEY = 'presetDev';

/** The profile patch filename, as `dsh-app-boot` composes it. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';

/** A top-level sequence entry starts at column 0 with `- `. */
const ENTRY_START = /^- /;

/** The row's own `id:` line, at column 0. */
const rowIdLine = (id) => `- id: ${id}`;

/**
 * A key of the entry itself is at exactly two spaces.
 *
 * The nested plugin entries inside `plugins:` are deeper, and this pattern is what keeps
 * them out of reach.
 */
const OWN_CONFIG = /^ {2}config:(.*)$/;

/** The entry's next own key, at exactly two spaces: where its `config:` block ends. */
const NEXT_OWN_KEY = /^ {2}\S/;

/** The one key this module writes, at exactly four spaces — one level inside `config:`. */
const CONFIG_SELECTED = /^ {4}selectedDefault:(.*)$/;

/**
 * Resolve the Loader's own `yaml` parser, from an anchor that names where the process
 * is looking from.
 *
 * The anchor is the profile first, and that is not a guess: resolving from
 * `<profile>/` finds `@deepseek-ai/dsh-app-boot` and `yaml` in the **running harness**
 * — measured, in this profile, as
 * `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\yaml\dist\index.js`.
 * Every other candidate is a fallback for the checkout, where the profile does not
 * exist yet:
 *
 *   1. the profile directory (or `patchPath`'s directory),
 *   2. a bare `yaml` from the profile — the same tree, when `exports` hides the
 *      subpath,
 *   3. this module's own location, which is where the workspace's `node_modules`
 *      would be if it had one,
 *   4. the standard DSH Desktop installation directories, which are what is left when
 *      the profile has no dependency tree at all.
 *
 * `null` means no candidate answered. That is reported to the user rather than
 * worked around: an unvalidated write is exactly what this module exists to refuse.
 */
function resolveYaml(anchor) {
  const tried = [];

  const candidates = [];
  if (typeof anchor === 'string' && anchor.length > 0) {
    candidates.push(anchor.endsWith(path.sep) ? anchor : anchor + path.sep);
  }
  candidates.push(import.meta.url);
  for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.DSH_HOME]) {
    if (typeof root === 'string' && root.length > 0) {
      candidates.push(path.join(root, 'Programs', 'DSH Desktop', 'resources', 'app') + path.sep);
      candidates.push(path.join(root, 'resources', 'app') + path.sep);
      candidates.push(root.endsWith(path.sep) ? root : root + path.sep);
    }
  }

  for (const candidate of candidates) {
    try {
      // The shell's own package is asked for first, because it is what proves the
      // candidate is a harness installation rather than any directory that happens to
      // sit near a package called `yaml`.
      createRequire(candidate).resolve('@deepseek-ai/dsh-app-boot/package.json');
    } catch {
      tried.push(`${candidate} (no harness)`);
      continue;
    }
    for (const specifier of ['yaml', '@deepseek-ai/dsh-app-boot']) {
      try {
        const resolved = createRequire(candidate).resolve(specifier);
        const entry = createRequire(candidate)(specifier);
        if (specifier === 'yaml') return { parser: entry, from: resolved };
        // `dsh-app-boot` re-exports the same parser the Loader uses; asking it is a
        // second chance, not a different implementation.
        if (entry && typeof entry.parseDocument === 'function') {
          return { parser: entry, from: resolved };
        }
      } catch {
        tried.push(`${candidate} -> ${specifier}`);
      }
    }
  }

  return { parser: null, from: null, tried };
}

/** The custom tag the Loader declares, so `!!js` resolves rather than fails. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value };

/** Resolution is per anchor, and an anchor does not change within a process. */
const yamlCache = new Map();

/**
 * DSH's own YAML parser, and the custom tag declared exactly as the Loader declares it.
 *
 * The profile patch contains `!!js` expressions. Without that declaration every `!!js`
 * scalar is an unresolved-tag error and a perfectly good file looks corrupt — which is
 * how a validation step can end up rejecting a file the Loader would have read.
 */
export function dshYaml(anchor) {
  const key = typeof anchor === 'string' ? anchor : '';
  if (!yamlCache.has(key)) yamlCache.set(key, resolveYaml(anchor));
  return yamlCache.get(key).parser;
}

/** Where the parser was loaded from, for diagnostics. `null` when it was not found. */
export function yamlOrigin(anchor) {
  const key = typeof anchor === 'string' ? anchor : '';
  if (!yamlCache.has(key)) yamlCache.set(key, resolveYaml(anchor));
  return yamlCache.get(key).from;
}

/**
 * Parse profile-patch text the way the Loader does.
 *
 * Returns either `{ ok: true, document }` or `{ ok: false, line, reason }`, so a
 * caller can refuse a write and say which line and why rather than throwing a
 * message that names neither.
 */
export function parsePatch(text, anchor) {
  const YAML = dshYaml(anchor);
  if (!YAML) {
    return {
      ok: false,
      line: null,
      reason:
        'the `yaml` parser the Loader uses could not be found, so the edit cannot be validated and is ' +
        'refused rather than written unvalidated',
    };
  }
  const lineCounter = new YAML.LineCounter();
  const document = YAML.parseDocument(text, { customTags: [JS_TAG], lineCounter });
  const error = document.errors[0];
  if (error !== undefined) {
    // `linePos` is present because a LineCounter was supplied; a parser that
    // reports an error without one still has to answer, so the line is optional.
    const at = error.linePos?.[0];
    return {
      ok: false,
      line: at === undefined ? null : at.line,
      reason: String(error.message || error),
    };
  }
  if (document.contents === null || document.contents === undefined) {
    return { ok: false, line: null, reason: 'the profile patch is empty' };
  }
  if (document.contents.items === undefined) {
    return { ok: false, line: null, reason: 'the profile patch must be a YAML sequence of entries' };
  }
  return { ok: true, document };
}

/** The path of the profile patch for a `profileContext`, or `null` if it cannot be named. */
export function patchPathOf(profile) {
  if (!profile || typeof profile !== 'object') return null;
  // `patchPath` is the field the shell's own plugin manager writes to. `dir` is the
  // documented fallback. Neither present means no path can be named, and a guessed
  // path is worse than an honest refusal.
  if (typeof profile.patchPath === 'string' && profile.patchPath.length > 0) return profile.patchPath;
  if (typeof profile.dir === 'string' && profile.dir.length > 0) {
    return path.join(profile.dir, PROFILE_PATCH_FILENAME);
  }
  return null;
}

/**
 * The extent of a top-level entry: its `- id:` line to the next line matching `/^- /`.
 *
 * `end` is exclusive. A trailing empty element from a final newline is not an entry
 * start, so an entry that is last in the file ends at the array's length and a key
 * inserted there lands before the trailing newline, not after it.
 *
 * The **last** matching entry wins, not the first, because that is the one the Loader
 * applies last and the one the shell's own writer edits
 * (`dsh-config-editor/lib/index.js:98`, `findLastIndex`). Editing an earlier duplicate
 * would look like a successful switch and change nothing the Loader reads.
 */
export function entryBounds(lines, id = SELECTOR_ENTRY_ID) {
  const wanted = rowIdLine(id);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === wanted) start = index;
  }
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !ENTRY_START.test(lines[end])) end += 1;
  return { start, end };
}

/**
 * The entry's `config:` block, as a range of line indexes.
 *
 * `configIndex` is the 0-based index of the `  config:` line; `start`/`end` bound the
 * lines that belong to it, ending at the entry's next own key (exactly two spaces) or at
 * the entry's end. A `config:` that is not a block mapping is reported rather than
 * rewritten: this module edits text, and it will not reformat a flow mapping in place.
 *
 * @returns `{ found: false }`, `{ found: true, ok: false, line, reason }`, or
 *   `{ found: true, ok: true, configIndex, start, end }`.
 */
export function configBlock(lines, bounds) {
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const match = OWN_CONFIG.exec(lines[index]);
    if (!match) continue;
    const rest = match[1].trim();
    if (rest !== '' && !rest.startsWith('#')) {
      return {
        found: true,
        ok: false,
        line: index + 1,
        reason:
          `the config key on line ${index + 1} is not a block mapping (it reads ` +
          `${JSON.stringify(rest)}), and this module does not reformat a mapping it did not write`,
      };
    }
    let end = index + 1;
    while (end < bounds.end && !NEXT_OWN_KEY.test(lines[end])) end += 1;
    return { found: true, ok: true, configIndex: index, start: index + 1, end };
  }
  return { found: false };
}

/**
 * The `selectedDefault` the file states, read from the text at exactly four spaces
 * inside the config block.
 *
 * `present` distinguishes "the key states nothing here" from "there is no key", which are
 * the same state to the registry but not the same file, and the difference is what
 * insert-versus-replace turns on.
 */
export function readSelectedLine(lines, block, id = SELECTOR_ENTRY_ID) {
  if (block === null) return { present: false, value: null, raw: null, line: null, bounds: null };
  const bounds = entryBounds(lines, id);
  for (let index = block.start; index < block.end; index += 1) {
    const match = CONFIG_SELECTED.exec(lines[index]);
    if (match) {
      const raw = match[1].trim();
      return {
        present: true,
        // A trailing comment is kept out of the value, the way YAML reads it.
        value: raw.replace(/\s+#.*$/, ''),
        raw,
        line: index + 1,
        bounds,
      };
    }
  }
  return { present: false, value: null, raw: null, line: null, bounds };
}

/**
 * The entry the Loader reads the value from: the LAST top-level entry whose `id:`
 * matches, which is the one it applies last.
 *
 * The value is read through the parsed document, which is the Loader's own view of the
 * file, rather than from the text — a key at the wrong indent parses as something else
 * entirely, and that is the defect the read-back exists to catch.
 */
export function parsedRow(document, id = SELECTOR_ENTRY_ID) {
  // A document that is not a sequence has no rows to read. This is a refusal, not a
  // crash: the caller's worst case has to be a message, because a `/^- /` extent that
  // ran past the end of the sequence is one of the ways an edit goes wrong.
  const items = document?.contents?.items;
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (document.getIn([index, 'id']) === id) {
      return { index, node: items[index], selected: document.getIn([index, 'config', SELECTOR_KEY]) };
    }
  }
  return null;
}

/** A refusal: the same shape for every branch, so no caller has to invent one. */
function refusal(refused, line, reason) {
  return { ok: false, refused, line: line ?? null, reason };
}

/**
 * Produce the edited text for `selected`, without writing anything.
 *
 * `selected` is the switch's own question — is the Dev preset the one the registry
 * selects — and it is answered with a value, never with a deleted key: this profile layer
 * has to *state* the selection, because the bundle layer beneath it selects `dev`, and a
 * layer that says nothing leaves the bundle's `dev` in force.
 *
 * Returns `{ ok: true, text, changed, inserted, line, value }` or
 * `{ ok: false, refused, line, reason }`. Every refusal names a line and a reason, and
 * every success has already been parsed by DSH's own parser, read back, and compared with
 * the original document everywhere except the one field.
 *
 * `options.testInjectLine` is a fault-injection hook and the only thing it can do is
 * make the edit WORSE: it replaces the edited line with arbitrary text so the
 * `unparseable_result` refusal is reachable from a test. The property it proves — a
 * write that cannot parse is refused and nothing is written — is the property that
 * keeps this file from ever handing the Loader a patch it rejects wholesale, and a
 * refusal path nobody can reach is a refusal path nobody has tested. Production
 * callers never pass it.
 */
export function planPresetWrite(original, selected, options = undefined) {
  const anchor = options?.anchor;
  const value = selected === true ? PRESET_ID : FALLBACK_PRESET_ID;
  const wanted = `    ${SELECTOR_KEY}: ${value}`;

  const before = parsePatch(original, anchor);
  if (!before.ok) {
    return refusal(
      'unparseable_source',
      before.line,
      'the profile patch does not parse before the edit: ' + before.reason,
    );
  }

  const lines = original.split('\n');
  const bounds = entryBounds(lines, SELECTOR_ENTRY_ID);
  if (bounds === null) {
    // No entry to target, and none is invented. `dsh-app-boot/lib/index.js:2769` and `:2932`
    // state the layer rule the harness actually implements: "Other patches replace supplied
    // fields; config is replaced wholesale, not deep-merged", and "Bundle, profile, home, and
    // CLI layers apply in that order. A patch config replaces the whole config." An appended
    // `- id: agent-preset-registry` holding only `selectedDefault` would therefore REPLACE the
    // bundle layer's config and drop `default`, which
    // `dsh-agent-preset-registry/lib/index.js:471-474` declares `z.string().required()` — the
    // row would fail to activate and every preset would break at boot. This module cannot
    // read the inherited layer to copy the rest of the config in, so it refuses.
    return refusal(
      'selector_entry_absent',
      null,
      `the profile patch has no top-level entry with id ${SELECTOR_ENTRY_ID}, and this module does not ` +
        'append one: a patch config replaces the whole config rather than deep-merging it ' +
        '(`dsh-app-boot/lib/index.js:2769`), so an appended config stating only ' +
        `${SELECTOR_KEY} would drop the required \`default\` key of the layer beneath and break every ` +
        'preset at boot. The profile patch must already carry the entry before this switch can state a ' +
        'selection in it',
    );
  }

  const block = configBlock(lines, bounds);
  if (!block.found) {
    return refusal(
      'selector_config_absent',
      bounds.start + 1,
      `entry ${SELECTOR_ENTRY_ID} on line ${bounds.start + 1} has no config block, and a ` +
        `${SELECTOR_KEY} key cannot be placed in one that does not exist without inventing the ` +
        'required keys that belong beside it',
    );
  }
  if (!block.ok) {
    return refusal('selector_config_not_block', block.line, block.reason);
  }

  const own = readSelectedLine(lines, block);
  const next = lines.slice();
  let inserted = false;
  let at;

  if (own.present) {
    if (next[own.line - 1] === wanted) {
      return { ok: true, text: original, changed: false, inserted: false, line: own.line, value };
    }
    next[own.line - 1] = wanted;
    at = own.line;
  } else {
    // Directly after the entry's `config:` line, which is where a key of that mapping
    // belongs: one level in from `config:`, and inside the block that was measured.
    at = block.configIndex + 2; // 1-based line number of the inserted line
    next.splice(block.configIndex + 1, 0, wanted);
    inserted = true;
  }
  if (typeof options?.testInjectLine === 'string') next[at - 1] = options.testInjectLine;

  const text = next.join('\n');
  const after = parsePatch(text, anchor);
  if (!after.ok) {
    return refusal(
      'unparseable_result',
      after.line,
      'the edit would not parse, so it is refused: ' + after.reason,
    );
  }

  // The Loader reads the parsed document, so this checks the value it will actually see
  // rather than the shape of the text. A YAML round-trip can still be wrong — an inserted
  // key at the wrong indent parses as something else entirely — and this is the assertion
  // that catches it.
  const row = parsedRow(after.document, SELECTOR_ENTRY_ID);
  if (row === null) {
    return refusal(
      'entry_not_found_after_edit',
      at,
      `the ${SELECTOR_ENTRY_ID} entry is not a readable top-level sequence item after the edit, so the ` +
        'registry would not see the selection and the edit is refused',
    );
  }
  if (row.selected !== value) {
    return refusal(
      'value_not_applied',
      at,
      `the edit does not apply: the parsed entry states ${SELECTOR_KEY}=${JSON.stringify(row.selected)}, ` +
        `wanted ${JSON.stringify(value)}`,
    );
  }

  // Everything except that one field must be untouched, compared as the parsed document
  // rather than as text: an edit that lands in the wrong entry, at the wrong level, or
  // over a neighbouring key parses perfectly well and still changes the file's meaning.
  // Deleting the field from both sides makes this hold for an insert and a replace alike.
  const collateral = untouchedElsewhere(before.document, after.document);
  if (collateral !== null) {
    return refusal('collateral_change', at, collateral);
  }

  return { ok: true, text, changed: true, inserted, appended: false, line: at, value };
}

/**
 * Compare two parsed patch documents everywhere except the field this module writes.
 *
 * @returns `null` when only that field differs, or a sentence naming the first difference.
 */
function untouchedElsewhere(before, after) {
  const strip = (document) => {
    const rows = document.toJS?.();
    if (!Array.isArray(rows)) return rows;
    const copy = structuredClone(rows);
    // Only the entry that decides — the LAST one with this id, which is the one the
    // Loader applies last — has the field removed. An earlier duplicate is left in the
    // comparison on purpose, so an edit that touched one of those is caught here.
    let last = -1;
    for (let index = 0; index < copy.length; index += 1) {
      if (copy[index] && copy[index].id === SELECTOR_ENTRY_ID) last = index;
    }
    if (last < 0) return copy;
    const config = copy[last].config;
    if (config !== null && typeof config === 'object') delete config[SELECTOR_KEY];
    return copy;
  };
  const left = JSON.stringify(strip(before));
  const right = JSON.stringify(strip(after));
  if (left === right) return null;
  return (
    'the edit changes more than ' +
    `${SELECTOR_ENTRY_ID}.config.${SELECTOR_KEY}, so it is refused; the parsed patch differs elsewhere ` +
    '(a key placed in the wrong entry or at the wrong level parses cleanly and is still the wrong file)'
  );
}

/** The state read from the file itself, never from what a caller hoped to write. */
export function readPresetState(text, id = SELECTOR_ENTRY_ID) {
  const lines = text.split('\n');
  const bounds = entryBounds(lines, id);
  if (bounds === null) {
    return {
      present: false,
      entryId: id,
      selected: null,
      enabled: null,
      line: null,
      detail: `no top-level entry with id ${id} in the profile patch`,
    };
  }
  const block = configBlock(lines, bounds);
  if (!block.found || !block.ok) {
    return {
      present: true,
      entryId: id,
      selected: null,
      enabled: false,
      line: block.found ? block.line : null,
      detail: block.found
        ? `entry ${id} line ${block.line} has a config key that is not a block mapping`
        : `entry ${id} on line ${bounds.start + 1} has no config block, so it states no selection of its own`,
    };
  }
  const own = readSelectedLine(lines, block);
  if (!own.present) {
    return {
      present: true,
      entryId: id,
      selected: null,
      enabled: false,
      line: null,
      detail:
        `entry ${id} states no ${SELECTOR_KEY} at four spaces, so the layers beneath decide which preset ` +
        'the registry selects',
    };
  }
  const wanted = own.value === PRESET_ID;
  return {
    present: true,
    entryId: id,
    selected: own.value,
    enabled: wanted,
    line: own.line,
    detail: `entry ${id} line ${own.line} reads ${SELECTOR_KEY}: ${own.value}`,
  };
}

/**
 * Write the edited text atomically: a sibling temp file in the same directory, then a
 * rename over the target. Nothing is written into the profile directory as a backup —
 * the shell keeps its own (`<patch>.bak-<timestamp>`) and a second backup layer is a
 * file nobody owns.
 */
export function writeAtomicSync(filename, text) {
  const dir = path.dirname(filename);
  let mode = 0o644;
  try {
    mode = fs.statSync(filename).mode & 0o777;
  } catch {
    // A missing target is fine: it is created by the rename below.
  }
  const temp = path.join(
    dir,
    `.${path.basename(filename)}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`,
  );
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    fs.renameSync(temp, filename);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp file is already gone, or cannot be removed; the rename error is
      // the one worth reporting.
    }
    throw error;
  }
  return temp;
}

/**
 * Read the selection from `<profile>/cordis.patch.yml`.
 *
 * Returns a discriminated answer rather than throwing, because the only caller is an
 * HTTP route whose worst case must be a JSON body the panel can display.
 */
export function readPresetFromProfile(profile, id = SELECTOR_ENTRY_ID) {
  const patchPath = patchPathOf(profile);
  if (patchPath === null) {
    return { ok: false, error: 'no_profile_path', detail: 'profileContext names neither patchPath nor dir' };
  }
  let text;
  try {
    text = fs.readFileSync(patchPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: 'patch_unreadable',
      detail: `${patchPath} could not be read: ${String(error?.message ?? error)}`,
      patchPath,
    };
  }
  const state = readPresetState(text, id);
  return { ok: true, patchPath, bytes: Buffer.byteLength(text, 'utf8'), ...state };
}

/**
 * Switch the selection, and report the state the file holds afterwards.
 *
 * The read-back is a second read of the file on disk, not the plan: a plan that
 * validated but did not land is exactly the failure this whole module exists to make
 * visible.
 */
export function setPresetSelected(profile, selected, id = SELECTOR_ENTRY_ID) {
  const patchPath = patchPathOf(profile);
  if (patchPath === null) {
    return { ok: false, error: 'no_profile_path', detail: 'profileContext names neither patchPath nor dir' };
  }
  let original;
  try {
    original = fs.readFileSync(patchPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: 'patch_unreadable',
      detail: `${patchPath} could not be read: ${String(error?.message ?? error)}`,
      patchPath,
    };
  }

  // See `planPresetWrite`: fault injection is opt-in through the environment, so a
  // production call can never reach it.
  const injected = process.env.NEWMARK_TEST_INJECT_PATCH_LINE;
  const plan = planPresetWrite(original, selected, {
    // The profile is the resolution anchor: it is the directory the process is
    // reading and writing, and the one the harness's own dependency tree is found from.
    anchor: path.dirname(patchPath),
    ...(typeof injected === 'string' && injected.length > 0 ? { testInjectLine: injected } : {}),
  });
  if (!plan.ok) {
    // `reason` is the canonical name this module refuses under; `detail` carries the same
    // sentence because the panel's shared failure renderer reads that field.
    return {
      ok: false,
      error: plan.refused,
      reason: plan.reason,
      detail: plan.reason,
      line: plan.line,
      patchPath,
    };
  }

  if (plan.changed) {
    try {
      writeAtomicSync(patchPath, plan.text);
    } catch (error) {
      return {
        ok: false,
        error: 'write_failed',
        reason: `${patchPath} could not be replaced: ${String(error?.message ?? error)}`,
        detail: `${patchPath} could not be replaced: ${String(error?.message ?? error)}`,
        patchPath,
      };
    }
  }

  const after = readPresetFromProfile(profile, id);
  if (!after.ok) return { ...after, patchPath, changed: plan.changed };
  return {
    ...after,
    changed: plan.changed,
    inserted: plan.inserted,
    appended: plan.appended === true,
    wrote: plan.changed,
    requested: selected,
  };
}
