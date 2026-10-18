# DSH plugin contract (verified)

Every fact in this file was read from the running Harness through
`cordis_inspect_query`, from an installed package's shipped `README.zh.md`, or
observed in an installation result. Nothing here is inferred from another
plugin's UI. Re-verify with the Inspect providers before relying on a detail.

## 1. Where a plugin can put UI

Slot topology is read with `Slots.listSubTree` (`platform: client`). The two
seats this workspace uses:

| Slot | Kind | Purpose (verbatim) | Registration fields |
|---|---|---|---|
| `sidebar.panellist` | list | "Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata." | `id` (required), `order`, `label` |
| `main` | keyed | "Central panel selected by sidebar entry id." | `key` (required) |

`sidebar.panellist` carries `replaceRisk: none`; `main` carries
`shadows-shipped-ui`, and its key domain is open — `conversation` is already
taken, `plugins` is taken by the shipped panel row.

**The entry is one id, not two registrations to reconcile.** The panellist
`id` *is* the `main` key: registering `id: 'memory-lab'` in the panellist and
`key: 'memory-lab'` in `main` gives the sidebar a button that dispatches to our
panel. Verified live after installation:

```
sidebar.panellist occupants: pf/plugins (order 0), pf/memory-lab (order 20)
main occupants:              pf/plugins, pf/conversation, pf/memory-lab
```

The panellist icon component receives `SidebarPanelIconOwnerProps`:
`{ size: number; active: boolean }` — the sidebar owns geometry, the plugin owns
the mark. The `label` field may be a thunk, "re-read on every projection, so
localized text follows the active locale without re-registering".

Other seats read and deliberately not used: `shell.overlay` (frame-wide floating
layer — reserved for the ComputerUse takeover effects), `sidebar.footer.action`,
`settings.section`, `conversation.header.leading`.

## 2. Client half

The browser artifact is one file registering a lazy factory whose id equals the
package name:

```js
window.__ModuleLoader__.load({
  id: '@local/<package>',
  factory(require) {
    const React = require('react');
    return { inject: ['slots'], apply(ctx) { /* register here */ } };
  },
});
```

- `require('react')` resolves from the frozen platform module table. No JSX: the
  artifact is hand-written plain JS, so components are `React.createElement`
  calls.
- Do **not** `require('@deepseek-ai/dsh-client-ui-primitives')` or any other
  Harness Client package as a module. The shipped reference is explicit that a
  throwing component blanks the slot entry with
  `slot entry crashed in '<slot>'`.
- Return `{ inject: ['slots'], apply(ctx) }`. `inject` is the Cordis service
  injection, so `apply` runs only once `ctx.slots` exists. Optional services are
  read with `ctx.get(name)` plus an undefined check, never assumed.
- Registrations live inside `ctx.effect(...)`, which returns the disposer, so
  plugin unload and slot collapse remove them.
- Build the contribution with
  `ctx.slots.inject(slotKey, () => ctx.slots.register(options, Component))`.
  `inject` runs the callback per declaration lifetime and returns a disposer.
- Styles are a component-local `<style>` element rendered as a React element
  ("Component-local styles can render as React elements so unmounting removes
  them"). The plugin never touches `document.head` itself.
- Styling uses only the `--dsw-alias-*` theme tokens. `Theme.listTokens`
  currently exposes: `bg-base`, `bg-layer-1`, `bg-layer-2`, `bg-overlay`,
  `border-l1`, `border-l2`, `brand-primary`, `label-primary`,
  `label-secondary`, `state-error-primary`, `state-idle-primary`,
  `state-success-primary`, `state-warn-primary`, `specific-sidebar-fill`. All of
  them "require light and dark".

## 3. Client → Host data path

`host.call(...)` is **not** available to an installed bundle: the Inspect
`Builtin` provider documents it as a symbol "available to a dynamic Client
half", and the only installed bundle whose client code calls it is the dynamic
Cordis runner. An installed bundle therefore reaches its Host half through the
HTTP surface the Host half owns:

```js
// Host half
ctx.inject(['webServer'], (httpCtx) => {
  httpCtx.effect(() => httpCtx.webServer.register({
    kind: 'prefix',                       // 'exact' | 'prefix'
    path: '/newmark-memorylab',
    handler: (req, res) => { /* node IncomingMessage / ServerResponse */ },
  }), 'label');
});
```

```js
// Client half
const response = await fetch('/newmark-memorylab/probe');
```

`webServer.register` throws on a duplicate `(kind, path)`, so the prefix is a
composition-level contract: one plugin, one prefix. The handler owns the full
response lifecycle and receives Node's raw `IncomingMessage`/`ServerResponse`.

**Admission.** The Desktop Host classifies every HTTP request
(`lib/desktop-browser-access-*.js`): a request carrying the Electron renderer
token in header `x-dsh-desktop-renderer` is admitted as `renderer`; an ordinary
browser is admitted only when `ordinaryBrowserEnabled` is true, and any request
whose query string carries a `dsh-desktop-*` key is always denied. A bare
unauthenticated `GET /` from PowerShell returns `403`, which is that policy
working, not a broken server. A same-origin `fetch` from the GUI page is made by
the Electron network session and is admitted.

Consequence for this workspace: the panel must degrade honestly when the fetch
is refused, and must never present a refused fetch as an empty store.

## 4. Host half

```js
export const name = 'newmark-memorylab';
export const inject = ['tools'];            // hard dependencies only
export function apply(ctx, config) { /* register resources in ctx.effect */ }
```

- Export either `apply(ctx, config)` (optionally with `inject` and `Config`) or
  a service class as the default export. Never mix the forms.
- `ctx.tools.register(definition)` returns the disposer.
  `ToolDefinition` = `ToolSchema` (`name`, `description`, `parameters`) plus
  `output: { schema, render(args, value) → ContentBlock[] }` and
  `execute(args, exec) → Promise<unknown>`; optional `projectContent`,
  `finalizeContent`, `timeoutMs`, `isConcurrencySafe`, `presentCall`,
  `presentResult`.
- Optional services are attached with `ctx.inject([...], (scopedCtx) => ...)` so
  a composition without them keeps the plugin active instead of throwing.
- Put tunable values in `Config` so a user's patch layer survives upgrades. A
  plugin that declares `Config` validates the row's `config` at activation and
  then reports a schema through `Config.listConfigs`; a plugin without `Config`
  reports `status: "absent"` for its mounted row. That distinction is how this
  workspace proves a row is mounted without reading process logs.

## 5. Bundle manifest and installation

```json
{
  "name": "@local/newmark-memorylab",
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "icon": "./icon.svg",
  "meta": { "title": "...", "description": "..." },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] }
  }
}
```

- `icon` is relative to the manifest directory; SVG/PNG/JPEG/WebP up to 256 KiB;
  absolute paths, URLs, escaping paths and escaping symlinks are rejected.
- `meta.title` / `meta.description` feed Plugin Manager cards, bundle details and
  the settings inventory **without activating the plugin**; `locale/en.json` and
  `locale/zh.json` carry the same fields per language.
- `dsh.client.inject` lists *other packages* whose activation must precede ours.
  A name that no enabled row provides fails composition, so it is left empty
  here: `slots` is a service dependency and belongs in `inject`, not here.
- Installation is `plugin_manager` `action: install_bundle` with the absolute
  package directory. The result's `application` field — not a log, not a process
  list — decides whether the change is live. `applied` means live.

## 6. What installation alone does not prove

`application: applied` plus a live slot occupant proves the registration, not
what a user sees. Per the plugin-development verification rule, without browser
control verification stops at: JavaScript syntax, manifest validation, and the
live Client slot. This workspace states that limit explicitly in every
verification record instead of claiming a rendering it did not observe.

## 7. Agent presets, and what "creator mode" is (verified 2026-10-05)

Citations are into the installed Desktop build
(`%LOCALAPPDATA%\Programs\DSH Desktop\resources\app`), which is what this profile
actually runs.

### 7.1 创造模式 is the shipped `cordis` preset

The picker's 「创造模式」 / "Creator mode" is not a separately built feature: it is
the preset declared by `node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`
(`id: cordis`), and the picker copy is `dsh-client-ui-agent-preset/lib/client.js`
(`presetCordisName`). Its documented capability is "runtime inspection, persistent
plugin management, and development guidance for Cordis plugins and Agent presets",
and in that file that capability is exactly **three rows**:

| Row | Package | What it contributes |
|---|---|---|
| `tool-cordis` | `@deepseek-ai/dsh-tool-cordis` | `cordis_inspect_list` / `cordis_inspect_query` — the Service and Event directories, live Config schemas, the Slot tree, the tool catalog. Read-only: the provider declares `list*` methods only. |
| `skill-filesystem` | `@deepseek-ai/dsh-skill-filesystem` | `config.customSkillDirs` pointing at `@deepseek-ai/dsh-agent-preset/skills`, which holds `agent-experience`, `cordis-composition-reference`, `cordis-plugin-development` and `editing-cordis-compositions`. |
| `tool-plugin-manager` | `@deepseek-ai/dsh-plugin-manager/tools` | install / enable / disable / remove bundles and plugins. Gated `disabled: !!js "!ctx.get('profileContext')"` — without a profile patch there is nothing to manage. |

A **mode is a tool list, not a privilege.** What a session may actually change is
decided by its sandbox and approval settings; these rows decide only whether the
agent can see the harness's own composition and act on it.

### 7.2 A preset's rows mount in the session's scope, not the root's

`@deepseek-ai/dsh-base` declares the root `tool-plugin-manager` row as a literal
`disabled: true`, and `plugin_manager list_plugins` reports it `enabled: false` —
while a session on a preset that declares its own `tool-plugin-manager` row has the
tool. Measured on this machine: this workspace's own agent session listed 49 tools
including `plugin_manager`, `cordis_inspect_list` and `cordis_inspect_query`, and
the session's `agent-preset/selected` record named `cordis`. **Read a preset's
capability from its own plugin list, never from the root row list.**

### 7.3 The profile layer is what runs, and it replaces `config` wholesale

`dsh/lib/profile-boot-BZ2ZjNWi.js` and `dsh-plugin-desktop/lib/profile-hhId3Pkk.js`
stack the layers in this order: every bundle in `dsh.profile.bundles`, the
desktop's own patch (right after `@deepseek-ai/dsh-web-app`), the market provider,
**then the profile's `cordis.patch.yml`**, then the home patch, then `--patch`
overlays. A patch entry with an `id` and no `insert` replaces the matched row's
fields, and `config` is **replaced, never merged**
(`cordis-plugin-include/lib/index.js:99-102`).

Two consequences this workspace got wrong once and now asserts:

- A profile-side copy of a preset declaration is not a mirror of the bundle's, it
  is **the one in force**. They are compared on every run of
  `verify-preset-patch.mjs` (`the live profile copy carries the capability rows the
  bundle declares`), because a silent divergence reads as a source of truth that
  is not the source in force.
- `disabled` written at four spaces inside that entry is `config.disabled`, where
  no plugin Config has such a field: accepted, persisted, inert. Only a
  **two-space** `disabled` is the row's. The four-space one had sat in the live
  profile since 2026-10-01 doing nothing.

### 7.4 `customSkillDirs` resolves through the Desktop's resolution overlay

The expression the shipped preset uses is
`createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')`.
A profile directory has **no** `node_modules/@deepseek-ai`, so plain Node
resolution from the profile patch would throw. It works because the Desktop
installs a process-wide resolver
(`dsh-plugin-desktop/lib/module-resolution-CTTB3FAS.js`: `Module._resolveFilename`
is replaced and ESM `registerHooks` is installed), and its two anchors are the
Desktop installation and `<profile>/node_modules`. Verified here: the package
resolves to `resources/app/node_modules/@deepseek-ai/dsh-agent-preset/package.json`
and all four `SKILL.md` files exist under its `skills/`.

### 7.5 Reloading a bundle patch into a running Host

- `plugin_manager action=install_bundle` on a package **already present** in the
  profile manifest returns `application: restart-required` and does **not** reload
  (`dsh-plugin-manager/lib/types/index.js:601-602`: `if (Object.hasOwn(before, name))
  return 'restart-required'`). The package files are updated; the running tree keeps
  its boot composition.
- `plugin_manager action=set_bundle <name> enabled=true` **does** reload:
  `reload()` → `reconcileProfilePatches(root, readProfilePatches(...), ...)`, which
  updates the root Include entry's `patches` and re-composes the tree
  (`dsh-app-boot/lib/index.js:3477-3505`). It throws when any id in `requiredIds`
  failed to activate, or when a failure that was not there before appears — so a
  non-throwing `application: applied` is positive evidence that the named rows are
  live, not merely written. Measured on 2026-10-05: `changed: false`,
  `application: applied`, `warnings: []`, and the Host log gained no new line.

### 7.6 A Dev task's header and the preset it mounts can disagree

`session.v4.jsonl` records `agentPreset` in the session header, and the mounted
preset separately in its `agent-preset/selected` event
(`dsh-agent-preset-registry/lib/index.js:761`). On 2026-10-05 two consecutive
sessions read `agentPreset: dev` in the header and `{"agentPreset":"cordis"}` in
the event, with the `cordis` persona and tool list actually mounted. **Read
`agent-preset/selected` when asking which mode a session ran in** — the header is
a request, the event is the result. This is a client-side selection fact; nothing
in a bundle patch can change it.

### 7.7 One package, many preset rows — and what the id may contain

Both facts below were measured while adding `rDev` (2026-10-05).

**A package may back more than one preset row.** The bundle's own comment once claimed
"ONE Loader entry per package" as a hard constraint, quoting the fatal
`resolves from multiple active Loader sources` error. That error belongs to the
**client-module** registry, and `@deepseek-ai/dsh-agent-preset` triggers none of it:
its manifest carries **no `dsh` field at all** (measured), so it contributes no client
bundle. The shipped `@deepseek-ai/dsh-web-app` bundle declares four rows on that
package — `preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis` — in a
profile that boots. What the rule really binds is the bundle's own client-carrying
package: `newmark2dsh` is addressed by exactly one row.

**A preset `id` is any non-empty string; the convention is lowercase.** The schema is
`id: z.string().required()` and the registry checks only `id.trim()` and duplicates
(`dsh-agent-preset/lib/index.js:14`, `dsh-agent-preset-registry/lib/index.js:502-503`).
Nothing lowercases, slugs or case-folds it: the picker renders `preset.name ?? preset.id`
and sorts by `localeCompare`. So `id: rDev` would be accepted — but every shipped id in
this install is lowercase, and this workspace has already paid for mixed case in this
exact area: the plugin panel sent `presetDev` while the route compared `preset-dev`, and
every click was a silent no-op that also wrote nothing and logged nothing
(`verify-preset-patch.mjs` mechanism 3). `rDev` is therefore shipped as
**`id: rdev`, `name: rDev`** — the lowercase id, the camelCase label.

### 7.8 Two presets over one agent: what "the same, minus these rows" costs

A preset is a declaration the registry mounts as written; there is no inheritance
between rows and no reference to another preset's plugin list. So a restricted twin
is a **second full copy** of the plugin list, and the only thing that keeps the two
copies honest is a computed difference:

- `verify-newmark-core.mjs` maps each preset's plugin rows to `id → declaration` and
  requires the difference to be exactly the three capability changes.
- Comments and blank lines are stripped before comparing, because a comment above the
  *next* row is not part of the row before it — without that, three unrelated rows
  "differed" over prose alone.
- `measure-dev-rdev-mutations.mjs` plants each rejected shape and requires the gate to
  go red, restoring the patch byte-identically. On its first run it found a real hole:
  a **presence** regex for `skill-filesystem` stayed green while `rDev` regained a
  `customSkillDirs`, because the two asserted lines were still adjacent. Row identity
  is now whole-row equality.

The same reasoning applies to the profile-layer mirror of `preset-dev` in §7.3: a
declaration that exists twice is a declaration that can disagree with itself, and only
a comparison notices.

### 7.9 Where the default preset is decided, and why the page does not

Until 0.2.16 the plugin card carried a "Dev preset" switch. It wrote
`agent-preset-registry`'s `config.selectedDefault` into the **profile patch**
(`~/.dsh/profiles/<p>/cordis.patch.yml`) through `lib/preset-row.js`, a 734-line
parse/plan/write module inside the shipped package. It was removed on the user's
instruction — 去除插件配置中的预设dev preset插件开关行，不用插件配置页调控默认预设 — and
this is what is true now:

- **The default preset is a declaration in the patch layers.** `selectedDefault ?? default`
  is what `agent-preset-registry` reads (`dsh-agent-preset-registry/lib/index.js:493-495`).
  The bundle declares `selectedDefault: dev`; the live profile patch declares the same.
  Changing it means editing one of those files, which is the same surface every other
  composition setting lives on.
- **This bundle writes no file of its own.** `newmark2dsh`'s Host half injects `webServer`
  and nothing else — `profileContext` existed solely to name the patch the switch wrote, and
  an unused injection is a dependency that can only stall the row. The gates assert the
  absence four ways (no writer module, no `profileContext`, no route branch, no panel row),
  and `measure-preset-write-path-mutations.mjs` proves each assertion fires when the shape
  comes back.
- **The parser stayed, the writer did not.** Reading a patch (with `!!js` declared exactly
  as the Loader declares it) is still needed by the gate that compares the profile's copy of
  a declaration against the bundle's; it lives in `scripts/lib/preset-patch.mjs`, outside the
  package, because a `lib/` file with no runtime caller reads as shipped plugin code.

A mode's *tools* are still chosen on the card (`MemoryLab`, `ComputerUse`, `Agent API`);
what that card no longer does is decide which preset a new task starts in.
