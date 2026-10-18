# The tool-output boundary (measured)

**This is not a style rule.** DSH validates every tool's return value as LOSSLESS JSON before
handing it to a caller, and a value it rejects is an operation **that already happened**, reported
to its caller as a hard failure. The obvious response to "it failed" is to do it again.

That boundary has now silently discarded **two real operations** in this bundle:

| Version | What was thrown away |
|---|---|
| 0.2.2 | `memory_lab_reindex` returned `error: undefined` on its SUCCESS path. The index had been written; the caller was told the rebuild failed. |
| 0.2.8 | `agent_api_send` returned `{ turn: undefined }` in its event log. The user pressed 重建索引, the Agent really ran — real time, real tokens — and the panel showed `判定未完成：INVALID_TOOL_OUTPUT`. The answer existed; it was discarded for a field nobody read. |

## The rule, and where the Harness applies it

| Fact | Source |
|---|---|
| the walker accepts `null`, booleans, strings, finite non-`-0` numbers, plain arrays, plain objects | `@deepseek-ai/dsh-util-values/lib/index.js:46-153` |
| `undefined` dies here | `…/dsh-util-values/lib/index.js:109` — `if (typeof current !== "object") return void 0` |
| a tool's value is snapshotted before it is returned | `@deepseek-ai/dsh-tools/lib/types/index.js:1189-1190` → `:106-118` |
| a rejection is `ToolOutputError` / `INVALID_TOOL_OUTPUT` | `…/dsh-tools/lib/types/index.js:77-85` |
| the projector is validated too (`output.render`) | `…/dsh-tools/lib/types/index.js:91-104` |
| declared `parameters` are validated at schema projection | `…/dsh-tools/lib/index.js:3042` (from `schemas()`, `:3024`) |
| declared `output.schema` is validated at registration | `…/dsh-tools/lib/index.js:323-327` (`assertSupportedJsonSchema`) |

## 1. The hole in the acceptance gate, and its repair

`scripts/verify-agent-api-live.mjs` used to call the component's tool `execute` **directly** in its
rounds 2 and 3, through a helper named `callAgentApiTool`. That call never goes through
`ctx.tools.execute`, so **the registry's output boundary was never applied to those values**. Round 4
*did* dispatch through the registry — which is why it caught the MemoryLab defect in 0.2.2 and not
the `agent_api_send` one in 0.2.8.

**The acceptance gate had a hole exactly where this class of defect lives.**

What every round dispatches now:

| Round | Before | Now |
|---|---|---|
| 2 — one conversation round | `definition.execute(args, …)` | `dispatchTool(tools, 'agent_api_send', …)` → `ctx.tools.execute` |
| 3 — one tool-call round, widened | `definition.execute(args, …)` | `dispatchTool(tools, 'agent_api_send', …)` → `ctx.tools.execute` |
| 4 — the MemoryLab rebuild | `dispatchTool` (already) | unchanged |

Both rounds now assert the boundary **before** they assert anything about the content:

```
[PASS] the registry ACCEPTED the run's value (DSH's output boundary: no INVALID_TOOL_OUTPUT)
       isError=false code=- name=-
```

`boundaryDetail(call)` reports `isError`, the registry's `code`, its `name` and its own message, so
a rejection names `INVALID_TOOL_OUTPUT` instead of surfacing later as "no parseable envelope".

**This is the change that would have caught the 0.2.8 defect, and it is measured**: mutation `M6`
puts the direct-execute call back into round 2, and the class gate below goes red on the check that
holds the routing shut.

## 2. The class check: `scripts/verify-tool-output-boundary.mjs`

Every tool the bundle registers, against DSH's own walker — imported from the installation, never
reimplemented. **21 checks, 0 failures.** No model call, no pointer, no key, no window, no capture,
no spawn; nothing written under the user's root.

### What it dispatches, and how

Everything is mounted on a **real `ToolRuntime`** (`@deepseek-ai/dsh-tools`, the class the Host
composes) over a real Cordis context, registered by the three real components, against a throwaway
root in the system temp directory:

* **36 dispatches** through `ctx.tools.execute` — the call a model's tool call makes.
* A **complete run** through `agent_api_send`'s own loop, driven by a scripted `llm` service (the
  documented `StreamChunk` union), so the envelope that carried the 0.2.8 defect is reached without
  a provider and without a token: `exit 0`, `route loop`, `turns 1`, and its event log
  `[{agent_start,null},{turn_start,1},{turn_end,null},{agent_end,null}]`.
* An **exit-4 `max_steps` run**, whose event log rides in `extra` rather than beside `result` — a
  different shape, the same boundary.
* The exit-3 `llm_unavailable` and `core_service_absent` envelopes, each on its own registry.
* The seven `memory_lab_*` tools against a throwaway store, including `memory_lab_reindex` — the
  shape that carried the 0.2.2 defect.
* Every `computer_use` action that answers without capturing the screen or delivering input.

> **Appended — the count above is the number at that measurement.** MemoryLab bundles **nine**
> `memory_lab_*` tools now (the bundle registers **fifteen** in total), and the gate dispatches all
> nine. The two added are reads that navigate the tag graph, and each one's payload is a NEW shape,
> which is exactly where a new `undefined` appears in this repository's history:
>
> | Tool | Paths dispatched | Why each is its own shape |
> |---|---|---|
> | `memory_lab_root_tags` | on an empty store | zero counts, empty `roots` and a `window` — the empty answer |
> | | on a populated store | the ordinary answer, with every field present |
> | `memory_lab_subtag_tree` | an ordinary subtree | the structure table, the components, the statistics |
> | | the same subtree, bounded | `bounds.dropped`, the report a truncation must carry |
> | | a tag that does not exist | the `NOT_FOUND` envelope, beside the roots that do |
> | | a blank tag | the body throws, so no value reaches the boundary |
>
> The three class assertions are unchanged and cover them: **47 dispatches, 0 rejected**. The
> "fifteen tools" line is the check that a new tool cannot slip past this gate, and it is the one
> that fails if a tool is added and not dispatched here.

### How a rejection is reported

A recording registry wraps each definition at `register` so the RAW value a body returned is kept
even when the registry throws it away. A rejection is therefore reported as a **path**:

```
boundary_counterfactual   isError=true code=INVALID_TOOL_OUTPUT
  $.result.receipt.planted: undefined is not a JSON value
  (rejected at `typeof current !== "object"`, :109)
```

`firstViolation` descends only through nodes DSH's walker has **already rejected**, so the path it
names is a path the walker really rejects, and a value it calls clean is a value the walker
accepted. The verdict is never this module's own opinion.

### Three outcomes, kept apart

| kind | Meaning |
|---|---|
| `returned` | the body answered and the registry accepted the value |
| `rejected` | the body **answered** and the registry refused the value — **the defect class** |
| `threw` | the body raised; no value ever reached the boundary |

Conflating the last two is the mistake this whole exercise is about. `memory_lab_tag_apply` with an
empty decision list is a deliberate refusal: its body **throws** (`memoryLabStoreError
INVALID_DECISION`, `memory-store.js:2470-2474`), and the gate asserts that it is reported as a throw
and never with the boundary's code.

### What it does NOT cover, named rather than implied

| Tool | Why not dispatched here | Where its values ARE measured |
|---|---|---|
| `screen_capture` | every path reaches a lane process and captures the screen or enumerates the user's windows; this gate runs inside the release gate, unattended | `verify-computeruse-output-boundary.mjs` |
| `computer_use` — the move/click/drag/scroll/type/key/`app_*`/`sequence`/`takeover_*` actions | they deliver input or acquire the desktop | `verify-computeruse-output-boundary.mjs` (30 stub dispatches, one spawn canary, `snapshotJsonValue` asserted clean) |

**A check holds those exceptions shut**: the gate reads the named gate's source and FAILS if it
stops dispatching the tool. An exception here cannot quietly become a hole.

## 3. The per-tool audit

Method: every `undefined` in a **value position** (not a comparison, not a guard) in the three
components, then what stops it reaching the returned value. Carrier is the funnel or guard that
holds; the last column is the measurement behind it.

| Tool | Value built by | `undefined` sites on the path | Carrier |
|---|---|---|---|
| `agent_api_state` | `envelope({result, extra:{profile}})` `component.js:510-531` | none in value position — `modelView` wraps every field in `String(… ?? '')` (`:344-354`); `capability()` spreads `code` conditionally (`contract.js:358-360`) | exhaustive `String`/ternary |
| `agent_api_catalog` | `component.js:1036-1046` | none — `String(entry?.name ?? '')`, `String(entry?.description ?? '')`, `entry?.parameters ?? {type:'object'}` | `String` + `??` |
| `agent_api_tool` | `component.js:937` | none — `classifyToolResult` ends `value === undefined ? null : value` (`contract.js:279`) | explicit `null` |
| `agent_api_send` | `component.js:809-836` | **`component.js:765` `turn: event?.turn`** | **was unprotected → fixed to `?? null` (0.2.8)** |
| | | `usage: last?.usage ?? null`; `model_verified` is `true/false/null` on every path (`core-model.js:126-169`); `model.verifiedReason` is always a string | `??`, exhaustive returns |
| `memory_lab_read` | `store.read` | `memory-store.js:692` `preferredLanguage` → `String(value)` then an `includes` test falling back to the store's own setting; `:1335` → `componentList`, whose first statement is `if (value === undefined …) return []` (`:218`) | coercion + fallback; explicit `[]` |
| `memory_lab_query` | `store.query` | same store family | as above |
| `memory_lab_update` | `verifiedReceipt` `component.js:907-944` | `:927` `slug: written?.slug` on the **not-verified** branch | see "the latent site" below |
| `memory_lab_delete` | `verifiedReceipt` | same | same |
| `memory_lab_reindex` | `component.js:1131-1165` | **`error: verified.ok ? undefined : …`** | **was unprotected (0.2.2) → fixed to a conditional spread** |
| `memory_lab_tag_review` | `component.js:1201-1206` | `request`/`prompt` are `… ? … : null` | explicit `null`s |
| `memory_lab_tag_apply` | `component.js:1271-1281` | none — the empty-decision case **throws** instead of returning | measured: `body-threw` |
| `computer_use` | `runBackend` → `asToolResult(JSON.parse(stringifyResult(…)))` `component.js:262-279` | **9 sites in value position** in `lib/win32.js`: `:1356,:1357,:1359` (lane diagnostics, reached by `mode_report`), `:1882`, `:3234`, `:3416`, `:3540,:3541`, `:3794` | **the JSON-string funnel** |
| `screen_capture` | same | same | same funnel |

`lib/linux.js` carries the same families of site — lane diagnostics (`:777`, `:868-870`), the window
record helper (`:1146`, `:1150`, whose caller maps `undefined` to `null` at `:1249-1260`), sparse
observation (`:2232`), typed text (`:2886`), the mode header key (`:3394`) and capture telemetry
(`:3559`) — and `lib/overlay-win32.js` carries two in the overlay error record (`:1035`, `:1041`).
Every one of them is behind the same funnel.

### The ComputerUse finding: protected by X, and here is X

`lib/win32.js` really does build result objects carrying `undefined`-valued fields — the lane
diagnostics and `mode_report`'s own answer among them. They do not reach the boundary, for a reason
that is not visible in those files:

* every `return` inside `runComputerUse` is `return stringifyResult(result)`
  (`lib/win32.js:3250-3258` — two such returns; `lib/linux.js` likewise), and every action
  composer is reached only through `dispatchComputerUse`, so the whole backend is behind that one
  funnel;
* the tool layer parses the string back — `asToolResult` → `JSON.parse` (`component.js:48-60`);
* **`JSON.parse` cannot produce `undefined`.**

Measured, both ways:

* mutation `M8` (a control) rewrites one of those sites — `mode_report`'s `overlay_last_error`,
  which the gate really executes — from `|| undefined` to `|| null`. **Verdict GREEN**: fixing a
  ComputerUse site changes nothing, because the funnel had already made it harmless.
* mutation `M9` breaks the funnel itself (`asToolResult` returns the raw JSON string). **Verdict
  RED** — and note the mechanism: a string is perfectly good JSON, so it is *not* caught by walking
  for `undefined`. It is caught because the tool **declares** `output.schema: {type:'object'}`
  and the registry validates the value against it. That is the measured proof that the
  declared-output half of the class check earns its place.

`verify-newmark-core.mjs` also asserts the funnel structurally (every `runComputerUse` return path
must be a `stringifyResult` call, and the component must parse rather than pass through).

**This is the cautionary case, reported as found**: a dozen `… : undefined` backends sites, and
none of them is a defect. The defect was in the one place nobody was looking — an envelope builder.

### The latent site, and why no gate can exercise it

`memorylab/component.js:927` — the not-verified branch of `verifiedReceipt` returns
`slug: written?.slug`. If `written.slug` were `undefined` on that branch, the whole
`memory_lab_update` / `memory_lab_delete` receipt would be rejected: the caller would see
`INVALID_TOOL_OUTPUT` instead of "the write did not verify", which is a *worse* report replacing a
*bad* one.

**Reachability disproved by reading the store, not assumed away.** The branch requires
`!verified.ok`, and `readBack(written?.slug || '')` returns `{ok:true}` for an empty slug
(`component.js:890`), so the branch needs a truthy `slug`. Both callers satisfy it:

* `MemoryLabStore.update` (`memory-store.js:1806-1818`) throws `STALE_WRITE` rather than returning,
  and its success return carries `slug: prepared.slug`;
* `MemoryLabStore.delete` (`:1929-1945`) throws on every failure path and its success return
  carries `slug: existing.slug`.

So the site is unreachable today. It is recorded anyway, because **its protection is an invariant
of another module rather than a guard at the site** — a future store change that answered
`{ok:false}` instead of throwing would make this fire, and no gate here would see it, since a gate
can only measure reachable branches.

## 4. The mutation table

`scripts/measure-tool-output-boundary-mutations.mjs` — 10 mutations, 8 red and 2 green controls,
every file restored **byte-for-byte** and verified by sha256, with a final sweep. Every check the
gate turns red is named.

| id | expected | verdict | gate exit | passed | failed | the check that went red |
|---|---|---|---|---|---|---|
| M1 | RED | RED | 1 | 15 | 6 | `agent_api_send completed a real run…`, `the loop envelope's own event log crosses the boundary…`, `agent_api_send answered an exit-4 envelope…`, `the capped run really reached its step cap…`, `no dispatched value was REJECTED…`, `every value a tool body returned is lossless JSON…` |
| M2 | RED | RED | 1 | 19 | 2 | `no dispatched value was REJECTED…`, `every value a tool body returned is lossless JSON…` |
| M3 | RED | RED | 1 | 20 | 1 | `every registered tool declares a lossless name, description, parameters and output schema…` |
| M4 | RED | RED | 1 | 19 | 2 | `no dispatched value was REJECTED…`, `every value a tool body returned is lossless JSON…` |
| M5 | RED | RED | 1 | 18 | 3 | `a planted undefined IS rejected by this registry…`, `and the gate files it as a REJECTION…`, `and this gate names the field that killed it…` |
| M6 | RED | RED | 1 | 20 | 1 | `the acceptance gate dispatches agent_api_send through the registry in both rounds…` |
| M7 | GREEN | GREEN | 0 | 21 | 0 | — (control: a behaviour-free comment) |
| M8 | GREEN | GREEN | 0 | 21 | 0 | — (control: a ComputerUse `… : undefined` site → `null`) |
| M9 | RED | RED | 1 | 20 | 1 | `no dispatched value was REJECTED…` |
| M10 | RED | RED | 1 | 15 | 6 | `every registered tool declares a lossless name, description…`, `DSH projected every registered tool's schema for a caller…`, plus the four `agent_api_send` shape checks |

What each row is for:

* **M1** — the 0.2.8 defect itself, put back: `turn: event?.turn`. The gate catches it, at the path.
* **M2** — the 0.2.2 defect itself, put back, in another component and another tool.
* **M3** — a non-lossless **`description`**. Of the four declared fields DSH pre-validates two, so
  this is the mutation that proves the declared-output walk is not a restatement of a check DSH
  already makes.
* **M4** — the same shape in `memory_lab_read`: a check that only ever went red on the incident it
  was written for would be a memorial rather than a gate.
* **M5** — a mutation of the **gate**: the counterfactual's planted `undefined` is removed, and the
  registry accepts it. Without this row, "the registry rejects a planted undefined" would be an
  assumption.
* **M6** — the hole itself, put back in the acceptance gate.
* **M10** — **the mutation that changed the gate.** The first version of this gate called
  `ctx.tools.schemas()` before walking what the tools declare; DSH validates declared `parameters`
  there (`dsh-tools/lib/index.js:3042`), so the gate died with `exit 2`, wrote no receipt, and
  reported the defect as "the gate itself failed" instead of as a failed check with a path. The gate
  now reads the tool set from the registry map, walks the declarations **first**, and reports the
  projection as its own named check. M10 is red on both.

### The bytes this table was measured against

The table was re-run from scratch after a comment-only edit to the gate's header, so these are the
sha256 of the files **as they ship**, and the final sweep confirmed every one of them is back at
exactly that value:

| File | sha256 |
|---|---|
| `components/agent-api/component.js` | `cf715e09bed0958e4a05544501db1128dc2de265f83a37e7dcc1e9f052e16d76` |
| `components/memorylab/component.js` | `c8abdbc6ae64d18511da81069536dfadc3993aa57a2fb31820385259a280ed5f` |
| `components/computeruse/component.js` | `e2e05351388869596e567caed8a363ee8885ccd68b3a230756e1876720c281a6` |
| `components/computeruse/lib/win32.js` | `cf4ef7b05d1479a4884d3d7cd1e120327cb9f2a665f15c7eee25368b6cd7c224` |
| `scripts/verify-tool-output-boundary.mjs` | `78b3d2e5272d29db3db934aceb42e35e49e5fdba1c6ca8373fbb6e211a8c0ee0` |
| `scripts/verify-agent-api-live.mjs` | `1b511bd5ad08283de144126acfa47f6ba58dd34d0320c59060d894144fec2a95` |

Receipts: `evidence/tool-output-boundary/mutations/mutation-table.json` (the table as data) and
`evidence/tool-output-boundary/mutation-harness.log` (the full transcript, including each
mutation's gate output).

> **Appended 2026-10-01 — the table above records the bytes at that measurement, not the
> working tree today.** Two of its six rows no longer match, and they are named here
> rather than edited above (A3: append, mark superseded, never rewrite a conclusion).
> `components/computeruse/component.js` now carries the ComputerUse operating guide in its
> `computer_use` description (`docs/03-computer-use-playbook.md`) and hashes to
> `13896c976c88a2b8eded3351757ea02d58e823dca182552e83bcdd23abe5d703`;
> `components/computeruse/lib/win32.js` hashes to
> `72370221abbced8fc05e6117ffaebf1e9972cbddc5ec87461a730279800db087`. The other four rows
> still match. **The property this section is about is unchanged**: the harness computes
> those bytes itself at start-up and verifies the restoration against them, so a stale row
> here cannot make a boundary check pass.

## 5. What remains unverified

* **`verify-agent-api-live.mjs` was not run.** It spends real tokens and rewrites the live index's
  `updatedAt`; running it is the owner's call. Its rounds 2 and 3 were changed and **read**, not
  executed — the routing they now use is the routing `M6` proves the class gate holds shut, but the
  edited file's runtime behaviour is unmeasured.
* **The live registry's own behaviour under a real provider** — unchanged by this work, and still
  only reachable through that gate.
* **`screen_capture`'s value** — measured by `verify-computeruse-output-boundary.mjs`, not here. If
  that gate is deleted, this gate fails; if it is weakened without deleting the dispatch lines, this
  gate would not notice.
* **Unreachable branches in general** — `memorylab/component.js:927` is the example: a gate measures
  values, and a site that cannot be reached cannot be measured. Its protection is another module's
  invariant, stated above rather than assumed.
* **`output.render`'s projection** — not called a second time by the class gate, deliberately: the
  registry makes that projection on every dispatch, so re-calling it would be measuring this gate's
  copy of a call the registry already made. A render that returns a non-lossless value surfaces
  through the dispatch assertions, with `output.render returned non-lossless JSON` in the registry's
  own message.
