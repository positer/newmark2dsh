# Governing rulebook (extracted)

Extracted from the parent Newmark Agent project — `OVERVIEW.md` (887 KB),
`taste.md` (183 KB), `archive/`, `agent.md`, `README.md`, `Design.md`,
`_local/dsh-dev-preset/`, `newmark-cu-lab/`, `tasks/`, `docs/` and `.github/` —
because the user's instruction is that *"项目文件夹有 Overview、taste 和 archive/
指导并约束开发"*.

Every rule below carries the source it came from as `path:line` or
`path#section`. A rule without a citation is a defect in this document. The
parent files remain the authority: this file is a faithful extraction, not a
replacement, and where it disagrees with them they win.

> **2026-09-30 — a cited source was removed.** `newmark-cu-lab/` was purged from the
> parent working tree on 2026-09-30 (50.2 GiB / 229,297 files, untracked). Every
> `newmark-cu-lab/*` citation below is therefore **historical**: the file it points at
> no longer exists on disk. A frozen source snapshot of the lab (`nculab/`, `scripts/`,
> `tests/`, `configs/`, `contracts/`, `policies/`, `docs/` and the lab's own
> `README.md` / `STATUS.md` / `OVERVIEW.md` / `taste.md` — 151 files, 1.25 MiB, per-file
> SHA-256) is kept at `archive/20260930-001844-culab-purge/source-snapshot/` in the
> parent's local archive. **The rules are unaffected**: they say what this sub-workspace
> must *not* contain, and that is now enforced by an empty parent tree as well as by the
> machine-checked source assertion.

Scope note: the extraction is complete for everything that constrains a port into
DeepSeek Harness. Parent rules about areas this workspace does not touch (Android
signing, MSI packaging, Gradle, release asset matrices) are kept because they
still bind the parent project and because several of them are the origin of rules
that do apply here — the evidence discipline, the claim vocabulary and the
diagnostics rule in particular.

---

## A. Documentation hierarchy and precedence

**A1** Four resident documents, with these exact mandates —
`_local/dsh-dev-preset/cordis.patch.yml:27-31`:

| Document | Mandate (verbatim) |
|---|---|
| `README.md` | "the commercial/open-source description of the project, written to be the GitHub landing page: positioning, core capabilities, quick start, project structure, license and status. Keep it honest and current; **it sells nothing the code cannot do**." |
| `OVERVIEW.md` | "the whole-project state: the complete file tree, what every folder is for, what every child file contains and does, the project's description and goals, and the current progress." |
| `taste.md` | "the code and theory style that must stay unified across conversations. **Append new decisions here instead of repeating them in chat.**" |
| `archive/` | "timestamped cold data and operation records." |

Corroborated at `agent.md:11-13`: *"对于每一个项目，都应当有一个 `~/archive` 文件夹和
包含详细的项目商业开放描述的 `README.md`、项目整体状况的 `OVERVIEW.md` …**每次执行前
读取，执行完成后及时整理写入**"*; *"`archive/` 文件夹包含按时间戳归档的冷数据和操作
记录留痕."*

**A2** Precedence on conflict — **code wins, the document is corrected, the
conflict is named.** *"When a document disagrees with the code, trust the code,
fix the document, and name the conflict."* —
`_local/dsh-dev-preset/cordis.patch.yml:37`. Chinese, `README.md:7`: *"文档与代码
冲突时以代码为准、归档只增不改."*

**A3** The archive is **append-only and never retro-fitted.** *"keep additions
append-only (never rewrite an existing conclusion to look better); if a decision
changes, append a new dated section and mark the old one superseded."* —
`cordis.patch.yml:37`; mirrored at `newmark-cu-lab/taste.md:43`: *"历史归档只追加，
不覆写上一轮证据."*

**A4** Declared role map, from `OVERVIEW.md`'s own self-description:
`OVERVIEW.md` = "project status, architecture/file-tree routing, release
decisions, and evidence index" (`OVERVIEW.md:2451`); `README.md` = "user-facing
product, interfaces, configuration, build, and verification guide" (`:2450`);
`archive/` = "timestamped cold evidence, stress reports, screenshots, and
operation records" (`:2446`); `taste.md` = "persistent retry/UI interaction style
contract" (`:1275`); `Design.md` = "Newmark Agent 设计规格书" (`Design.md:1`);
`agent.md` = "Newmark Agent - Default System Prompt" (`agent.md:1`).

**A5** **A sub-workspace is expected to carry its own four-document set.**
`newmark-cu-lab/` does — `newmark-cu-lab/OVERVIEW.md:13-16`; `newmark-cu-lab/README.md:62`:
*"项目文件职责见 `OVERVIEW.md`，实现和实验约定见 `taste.md`."*

**A6** Planning artifacts have a fixed home. *"Every release plan goes in
`tasks/plan.md` and its executable checklist in `tasks/todo.md`"*; *"Preserve
historical plans below the current release section."* — `taste.md:681-682`.

**A7** Published versus local-only. *"Keep planning and implementation evidence in
timestamped local archive files excluded from Git; publish source and the
maintained project `README`/`OVERVIEW`/`taste` documents only."* — `taste.md:683`;
`README.md:51`; enforced at `.gitignore:61-62`.

---

## B. Hard rules (MUST)

### B.1 Process

**B-1** Read `README.md`, `OVERVIEW.md`, `taste.md` and the newest `archive/`
entries **from disk** before the first action of any work — *"do not rely on
memory of an earlier conversation"*; a missing document is created first, in the
same shape as its siblings. — `cordis.patch.yml:33`

**B-2** Write back after the work: update `README.md` when the outward description
or usage changed; update `OVERVIEW.md` for **every** file-tree, folder-purpose,
file-construction or progress change; append new style rules to `taste.md`; then
archive under `archive/<YYYYMMDD-HHMMSS>-<short-slug>/` with the before/after
state of every touched file, what was done, the conclusions, the supporting
evidence and the exact timestamps. **A work item without its write-back is
unfinished.** — `cordis.patch.yml:35`

**B-3** Define the goal, the acceptance criteria and the evidence that proves
completion **before** writing code. — `cordis.patch.yml:41`

**B-4** Measure rather than claim, and label each claim's epistemic class.
*"verify with a real run — a command, a measurement, a read-back of the actual
artifact — rather than with prose. **Distinguish measured facts from hypotheses
from guesses, and label them as such.** Admit uncertainty instead of
manufacturing confidence: **an unverified claim presented as verified is the worst
possible outcome.**"* — `cordis.patch.yml:41`

**B-5** Prefer the smallest sufficient change; prefer existing patterns over new
machinery. — `cordis.patch.yml:41`, `:83`

**B-6** Leave work reviewable: tight diff, naming and structure consistent with
`taste.md`, and a statement of what changed, why, and how it was verified. Every
piece of work is reviewed by Gemini and Claude Code. — `cordis.patch.yml:43`;
`agent.md:11`

**B-7** A plan must be decision-complete: goal and success criteria, changes
grouped by subsystem, public API / schema / data-flow changes, edge cases,
failure modes, tests, acceptance criteria and explicit assumptions. —
`cordis.patch.yml:89`

**B-8** Explore before planning; in plan mode do not edit, write, run formatters
or code generation that rewrites tracked files, or otherwise carry out the plan.
— `cordis.patch.yml:83`

**B-9** Keep the tool catalog identical across modes for request-cache stability.
— `cordis.patch.yml:85`

**B-10** Keep request-scoped system/bootstrap text **byte-stable** across tool
subrounds; never inject counts, ids, timestamps or plan state into the cached
prefix. — `taste.md:654`

**B-11** Small named helpers and constants over duplicated numeric limits. —
`taste.md:644`

### B.2 Data, state and recovery

**B-12** Every in-flight persistent state needs an explicit orphan verdict, a
reclaim action and an audit event, reachable from cold start, the state
projection, and a new user command. Recovery must reconnect the downstream chain
and re-trigger execution, or it is "recovered but nobody runs it". —
`taste.md:212-214`

**B-13** Terminal writes converge on **one idempotent settlement path**, with a
`finally` fallback; any branch that can skip settlement becomes a RUNNING orphan
in real runs. — `taste.md:208`

**B-14** Whoever holds a lease must heartbeat it, at one third of the lease
interval, stopped at settlement; crash recovery proves the owner is dead via
`worker=<role>:<pid>` plus `process.kill(pid, 0)` and a grace period for pid
reuse. — `taste.md:206-207`

**B-15** A lease is a crash detector, not a wall-clock budget. — `taste.md:203`

**B-16** Keep a previous-good copy of every persisted ledger: copy the good file
to `.bak` after each successful write; on a read failure restore from `.bak` and
leave the bad file as `.corrupt`. Semantics: "most recent complete write, at most
one write lost". — `taste.md:219-220`

**B-17** Read paths must be write-free: an `ensure*` API performs zero writes when
the object exists, and a read-only projection has its own entry rather than
materialising a whole snapshot to read one field. — `taste.md:243-244`

**B-18** Version dataset-shaped snapshots per generation and refuse to overwrite a
same-named snapshot. — `taste.md:112`

### B.3 Evidence and gates

**B-19** Diagnostics and probes stay in source and **must not exist in the
artifact**. *"判据不是「默认关闭」，而是「产物里根本不存在」"* — including the
environment switch, the snapshot capability, the output path and the probe's own
name. — `taste.md:184-189`; `OVERVIEW.md:435-445`

**B-20** The packaging gate must prove its own discriminating power: assert that a
stripped build carries **zero** markers **and** that the development build still
carries them plus the probe source file. — `taste.md:187`

**B-21** The gate must not pollute the workspace: build stripped artifacts to a
temp path, never over the developer's `dist/`. — `taste.md:188`

**B-22** A new gate must be shown to **fail on the old code** before it is
trusted. — `taste.md:146`; `OVERVIEW.md:499`

**B-23** Diagnose a defect with an in-build A/B (inject the equivalent old
behaviour, reproduce, remove, verify) rather than by rolling back source. —
`taste.md:239`, `:263`, `:499`, `:508`

**B-24** *"A green gate is only worth something after the failures it survived are
on record."* — `taste.md:976`. *"A gate measured on a scenario that never ran is
worse than no gate."* — `taste.md:996`

**B-25** Every new gate is **enrolled** into a named chain and into the full
release closure; a gate with no caller does not exist. — `OVERVIEW.md:338`;
`DESKTOP/package.json:55,65,115`

**B-26** Every verification record ends with a `## Boundaries` block stating what
was **not** verified. Canonical sentence: *"This test used an isolated app root
and synthetic UI; it did not send user conversation or screenshot content."* —
`archive/2026-09-29-pc-computer-use-reliability-0.6.9.md:23,45-47`

**B-27** Keep rejected intermediate artifacts as rejected evidence; never
overwrite original evidence. — `taste.md:540`;
`02_AGENT执行清单.md:10`

**B-28** Machine-readable evidence accompanies every measurement: `REPORT.md`
plus `MANIFEST.json` plus `evidence/`; hash manifests alongside handoff packs. —
`OVERVIEW.md:236`, `:356`; `newmark-cu-lab/OVERVIEW.md:183`

**B-29** Fixtures live under the system temp directory, never clean the user's
real runtime root, are field-complete, and are tested at real scale (tens of MiB)
or the defect is invisible. — `taste.md:693`, `:153-154`

**B-30** An independent, no-context audit is a real gate type; it discovers the
product from `README.md` and real `--help`/version output alone, modifies nothing,
and reports a first-class verdict such as `BLOCK_MSI_UAC`. — `OVERVIEW.md:2459-2472`

**B-31** Accept an external review when it is correct, and retract an over-strong
conclusion as a required archival action. — `OVERVIEW.md:149`, `:156`, `:159-163`

### B.4 Claims — "cannot be claimed without X"

| Claim | Requires | Cite |
|---|---|---|
| Frame-rate improvement | same build, interleaved multi-round on/off, fixed refresh mode, DPI, history fixture, provider, warmup, action sequence | `taste.md:1039`, `:1046` |
| Renderer frame timing | RAF **cadence** reported as cadence, never as display FPS; intervals over 1× and 2× budget plus ≥50 ms stalls | `taste.md:1018`, `:1030` |
| Packaged GUI performance | bind to the executable and `app.asar` hashes; equal display versions are not the same build | `taste.md:1032-1034` |
| Installed-runtime performance | never from the old installed version | `taste.md:919` |
| Visual / popup acceptance | real-renderer screenshots at actual viewport dimensions and active window ownership; an ignored rotation, an ANR overlay or an unfinished compositor frame is diagnostic evidence, **not** a pass | `taste.md:377`, `:587`, `:899` |
| Long-conversation surface | real-renderer screenshot, fixture seeded through the production store, real DOM gestures, paired fresh-conversation control | `taste.md:944-945` |
| Compaction | the real path `Agent.process → runAgentKernel → transformContext → maybeCompress` | `taste.md:923` |
| Upstream cache hit | never from fixture tests; real observations with provider/model and workload boundaries | `taste.md:479-482` |
| Release-ready | the exact asset matrix, every asset verified independently, byte size and SHA-256, signing identity, local packaging separated from external publication | `taste.md:685` |
| MSI repair success | exit 0 necessary but not sufficient; explicit installed-boundary verification; installed/package ASAR equality; preserved user-state hashes | `taste.md:686` |
| CU drag acceptance | real drop-state assertion on an isolated native window; virtual drag leaves the physical cursor **and** the foreground HWND unchanged | `taste.md:9` |
| Sparse-CU attribution | interleaved multi-round feature-on/off in the same build, holding refresh/window/DPI/fixture/provider/power/warmup/interaction constant | `taste.md:1023` |
| A UI surface | a screenshot from the real renderer; a source string is not a surface claim | `taste.md:944`, `:134` |

### B.5 Naming and language

**B-32** Bilingual parity is a product rule: complete English then complete
Simplified Chinese in release notes. — `taste.md:395`

**B-33** Neutral, claim-labelled report language: *"**PASS 只对应已测门禁**；候选、
估计、未测和失败分别命名."* — `newmark-cu-lab/taste.md:51`

**B-34** Release naming `dev-X.Y.Z` / `Newmark Agent dev-X.Y.Z`; numeric package
version; synchronized Android `versionCode`; the six established assets. —
`taste.md:395`; `README.md:691-695`

**B-35** Gate/script naming: `*Verify.ts` under `src/tests/`, `verify-*.cjs` /
`test-*.cjs` / `release-*.cjs` under `scripts/`; the npm script name is the
citation handle. — `DESKTOP/package.json:65,221-226`

**B-36** Archive entry naming: `archive/<YYYYMMDD-HHMMSS>-<short-slug>/`. —
`cordis.patch.yml:35`

**B-37** Never bake a developer machine's user name or absolute path into shipped
source, demo data, script defaults or packaged assets. — `taste.md:620`, `:612`

---

## C. Prohibitions (MUST NOT)

### C.1 Retired, deprecated and frozen

**C-1.1** The desktop App has **retired the on-device CU model route entirely**;
CULab / NES-T / NMEP / ONNX must not appear in the App.
*"App 源码、依赖和打包产物不再包含 CULab/NES-T/NMEP/ONNX loader、工件发现或 schema
emitter."* — `OVERVIEW.md:59`
*"Desktop Computer Use **不加载本地 CULab/NES-T/NMEP/ONNX 模型**；App **不保留这条模型
发现、ABI 或推理接口**。"* — `taste.md:50`
*"桌面端已彻底停用 CULab/NES-T/NMEP/ONNX 端侧推理接口与依赖。"* — `README.md:81`

**C-1.2** CU-Lab is quarantined as an isolated historical research project with its
own frozen schema; its outputs are not deployable products. *(Partly superseded
2026-09-30: the project was deleted from the parent working tree; the quarantine is
now the absence of the directory plus the frozen source snapshot in `archive/`.)*
*"`newmark-cu-lab/` 保留为**隔离的历史研究项目**，使用自身冻结 schema，**不读取桌面
源码**；其 `.nmep` 输出**不属于可部署产物**。"* — `OVERVIEW.md:59`
*"旧 `.nmep` 产物**仅是研究记录，不是可部署候选**。"* — `newmark-cu-lab/README.md:3`
*"**本项目不再读取 `../DESKTOP/`**"* — `newmark-cu-lab/STATUS.md:5`

**C-1.3** Source-level anti-coupling assertion, machine-checked: *"`src/`（除
`tests/`）**不得出现 `newmark-cu-lab`**"* — `OVERVIEW.md:190`.

**C-1.4** The CU channel must keep working with **no weights present**: the
no-weight behaviour is `uia-only`, it must not escalate, it must forbid blind
coordinates, and a disabled provider must not fabricate detections. —
`OVERVIEW.md:180`, `:190-193`

**C-1.5** Dynamic INT8 is retired as a shipping choice: *"**动态 INT8 量化是纯亏**"* —
it cost 43% relative recall (0.4157 → 0.2359) **and** 16.2× latency (186 ms →
3,022 ms) on identical frames. Prefer static QDQ with calibration. —
`taste.md:986`; `OVERVIEW.md:249`

**C-1.6** Artifact stage alone does not authorise loading: `INTEGRATION_CANDIDATE`
and `ACCEPTED_FOR_RELEASE` must both carry `detectorPass=true` and
`trackingPass=true`. — `README.md:105`; `taste.md:1014`

**C-1.7** The App must not train: *"**App 只做推理，不做训练。** …**不允许
PyTorch/蒸馏/训练数据收集**"*; a load failure states **why it refused** and never
silently degrades. — `taste.md:124`; `OVERVIEW.md:334`

**C-1.8** Retired: `quality_by_task`, feedback learning and any second selector.
*"**Auto 只能有一个模型决策者。** …**即使它「只是微调」也不接受**"*; the searchable
verdict is that `learnedPreference`, `FEEDBACK_WINDOW_MS`, `recordFeedback(`,
`rankEligible`, `rankCandidate`, `switchThreshold` and cache affinity must not
appear on an active routing path. Legacy user data is *"不会被新代码读取、覆写或
删除"*. — `taste.md:138`; `OVERVIEW.md:42`, `:387`

**C-1.9** The Auto route is fail-closed with **no local fallback selector**;
strict-capability failure stops routing, and *"「回退到旧排序器」**不是降级**，是把被
删除的架构偷偷装回来."* Default hard timeout 3000 ms. — `taste.md:62`, `:141`;
`OVERVIEW.md:75`

**C-1.10** Auto-off means nothing moves: no candidate enumeration, no decision
engine call, no routing write, no config change; the injected engine's call count
must be **0** and `resolvedDeployment` byte-identical. — `taste.md:130-133`

**C-1.11** The CU-Lab generation ladder forbids skipping a generation: a later
generation's tool errors out before the previous exit gate passes, rather than
quietly running with the earlier config. — `taste.md:107`;
`newmark-cu-lab/STATUS.md:130`

**C-1.12** `nes-t-v0.1.yaml` stays structurally frozen; a change beyond target
parameter count, input size, descriptor width or artifact boundary goes to a new
generation or an explicit ablation. — `newmark-cu-lab/taste.md:9`, `:50`

**C-1.13** `modelKind: nes-t` is frozen ABI and is not renamed with product
versions. — `newmark-cu-lab/STATUS.md:115`

### C.2 Probes, diagnostics and packaged content

**C-2.1** Probes must never enter the shipped artifact. — `taste.md:184`;
`OVERVIEW.md:435-448`

**C-2.2** `app.asar` must contain no `dist/tests` entries and no probe module; the
host bundle must contain no `NEWMARK_MEMORY_PROBE`, `writeHeapSnapshot`,
`host-memory.jsonl` or `installHostRuntimeHooks` markers. — `OVERVIEW.md:443-445`

**C-2.3** Tests, source maps, build caches, logs and temporary output must never
enter the published tarball. — `OVERVIEW.md:3619`

### C.3 Computer Use screenshots

**C-3.1** Screenshots are **ephemeral only** and must never be stored under the
local archive or the workspace; the temporary image is deleted immediately after
preparing the provider request, and on a direct observation it is deleted before
the tool result returns with **no real path exposed**. — `OVERVIEW.md:3170-3184`

**C-3.2** Observation frames must never enter `conversation-media/`. —
`OVERVIEW.md:3263`, `:3312`

**C-3.3** Frame retention is authorised **only by trusted execution context, never
by model-authored arguments**; the model schema cannot grant its own retention
permission. Exactly one frame is retained on the trusted vision path until
structured model input preparation, with normal, error and cancellation cleanup.
— `OVERVIEW.md:3467`, `:3499-3500`

### C.4 Other hard prohibitions

**C-4.1** Never `!important` or id-level specificity to win a float-content
cascade. — `taste.md:262`
**C-4.2** Never delete the whole list and re-render instead of honouring a user
drag; a user-held drag order outranks authoritative list pushes. — `taste.md:237-238`
**C-4.3** No visual motion unless the product requirement explicitly calls for
it. — `taste.md:639`
**C-4.4** Never convert a plain information disclosure into a material container.
— `taste.md:638`, `:791-792`
**C-4.5** No Material/Foundation gray ripple anywhere in Newmark-owned surfaces,
including Settings, the right sidebar, Memory Lab, conversation, navigation and
overlays. — `taste.md:662-663`
**C-4.6** Never re-enable the deleted gradient settings: the marquee is fixed at
pure black / white / black / white, 3 s, 2 px (PC) and 2 dp (Android), and the
three legacy config keys are cleared on the first upgrade load. — `OVERVIEW.md:4035`
**C-4.7** Never fabricate a reference or an action success from visual
interpretation; label approximate results. — `taste.md:910`
**C-4.8** Never silently replace malformed tool arguments with `{}` or accept
trailing JSON. — `taste.md:732`
**C-4.9** Never claim complete upstream cache reuse across a schema addition, an
explicit context compression, or a consumed transient image. — `taste.md:470`
**C-4.10** Never synthesise cached-token counts, or retry completed work to chase a
cache hit. — `taste.md:471`
**C-4.11** On Linux, Computer Use returns an explicit unsupported result rather
than crashing. — `OVERVIEW.md:3186`
**C-4.12** Never treat the local-only archive as a public repository artifact. —
`.gitignore:61-62`; `README.md:51`
**C-4.13** Never hand-edit generated build output. — `OVERVIEW.md:2441`
**C-4.14** Never instrument a new tool when an existing `edit`, item-update or
field-patch already covers the operation. — `taste.md:677`; `OVERVIEW.md:1238`
**C-4.15** Never accept "smoke test passed" as feature completion. —
`Design.md:490`
**C-4.16** Never let a run end with stray owned processes or a modified real
user configuration. — `OVERVIEW.md:2463`, `:2516`
**C-4.17** Never derive a motion label from the command that was sent; compute
labels from measured geometry and pixels. — `taste.md:1001`
**C-4.18** Never use ground truth inside a measurement and call it an upper bound.
— `taste.md:1005`
**C-4.19** Quarantine a failed episode with a machine-readable reason rather than
silently filtering it. — `taste.md:1004`
**C-4.20** Never report a non-accelerated result as accelerated; only a profile
observation of the real execution provider counts. — `newmark-cu-lab/taste.md:58-59`

---

## D. Verification and evidence gates

**D-1** Evidence standard: a real run — a command, a measurement, a read-back of
the actual artifact. — `cordis.patch.yml:41`

**D-2** Verdict vocabulary: `PASS` only for a measured gate; `candidate`,
`estimate`, `untested`, `SKIP`, `BLOCKED`, `NO-GO` and `HOLD` are separate words.
— `newmark-cu-lab/taste.md:51`; `OVERVIEW.md:2345`, `:2387`, `:2472`

**D-3** The parent's gates this port takes as its model of a named chain:
`npm run test:full-release` composes build → history/compression verification →
`test:desktop:built` → intelligence tier → TUI → mode/conversation stress →
cross-platform env → SSH/WSL stress → CLI → GUI/TUI/CLI stress → build-driver
cancellation (`DESKTOP/package.json:55`); `test:computer-use-runtime` composes
clean build → sparse-only → performance → session → CLI accuracy
(`DESKTOP/package.json:115`); Memory Lab has `test:memory-policy` →
`memoryPolicyVerify.js` (`:68`).

**D-4** Fixture obligations: a seeded conversation must be marked started
(`firstAgentResponseStarted` + `titleRequestMessageId`); a suspended Flow fixture
must carry its `Flow/<name>.Flow.json`; a send after a pause toggle must wait for
`queuePaused === false` and an idle agent. — `taste.md:946-949`

**D-5** Real-model gates are opt-in and excluded from the credential-free suite,
and they run with an isolated root, synthetic visual marks and a forced read-only
action guard. — `README.md:49`; `OVERVIEW.md:34`

**D-6** Boundary statements are mandatory and named `## Boundaries`. —
`archive/2026-09-29-*.md:41-47`

---

## E. Visual and motion taste (values that bind any ported UI)

**E-1** Design source of truth: *"遵循 Apple 设计守则; 轻量平滑动效; 按键点击缩放反馈;
鼠标悬停/拖拽差异化动效; **贝塞尔圆角倒角处理所有窗口角**; 禁用默认选择框高亮、列表
弹出、次级菜单边框、滑条等; GPU 加速页面动效"*; *"可调节高斯模糊程度（透明 ↔ 模糊连续
调节）"*. — `Design.md:71-80`

**E-2** Dark theme is neutral gray, not blue-black: canvas `#101010`; raised
layers `#181818` / `#222222` / `#292929` / `#303030` / `#383838`; labels `#f2f2f2`
/ `#cecece` / `#949494`. — `taste.md:518`

**E-3** Cross-platform opaque text tokens: dark `F2F2F2` / `CECECE` / `949494`;
light `0A0A1A` / `1A1A2E` / `6A7090`. — `taste.md:382`

**E-4** Semantic status colours: the light theme uses a **darker step**; reusing
the dark theme's pale yellow/pale red text is forbidden, and the memory graph's
nodes, edges and grid obey the same rule. — `taste.md:895`

**E-5** Iconography: the Lucide family, **24-unit viewport, 2-unit strokes, round
caps and joins**; never approximate with filled Material icons; icon colours use
themed semantic colours and are never hard-coded. — `taste.md:381`, `:586`

**E-6** The frozen marquee — the value this port reproduces verbatim:

| Token | Value | Cite |
|---|---|---|
| Colour stops | pure black → white → black → white closed loop (`--g1..--g4` = `#000000`, `#ffffff`, `#000000`, `#ffffff`) | `OVERVIEW.md:4035`; `index.html:123-126` |
| Period | `3s` linear | `index.html:127`; `OVERVIEW.md:4035` |
| Width | `2px` PC / `2dp` Android | `index.html:128`; `OVERVIEW.md:4035` |
| Sweep | `conic-gradient(from var(--marquee-angle))` with `@property --marquee-angle { syntax:'<angle>' }`, `0deg → 360deg` | `index.html:4195-4201`, `:6403` |
| Ring cut | `padding: 2px`; mask `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`; composite `xor` / `exclude` | `index.html:4205-4222` |
| Fallback | `@supports not (background: conic-gradient(from 0deg, red, blue))` → `linear-gradient(var(--marquee-angle), …)` + `marquee-rotate-fallback` `hue-rotate` | `index.html:4234-4240` |
| Compositing | `z-index: -1`, `pointer-events: none`, `transform: translateZ(0)` | `index.html:4229-4231` |
| Authoritative override | the later block at `index.html:6399-6407` is the binding one: strictly a continuous black/white/black/white border, `opacity: 1`, `mix-blend-mode: normal` | `index.html:6399-6407` |

**E-7** Motion timing table (parent values, for reference when a port needs a
duration):

| Token | Value | Cite |
|---|---|---|
| PC selection glass lift/track | 360 ms | `README.md:795` |
| PC selection glass shrink landing | 180 ms | `README.md:795` |
| PC popup escape/landing fade | 120 ms | `taste.md:473`; `README.md:791` |
| PC long-press drag activation | 80 ms (was 300 ms) | `taste.md:487` |
| Mobile glass lift / fall | 105 ms / 165 ms | `OVERVIEW.md:1254` |
| Mobile float drag follower time constant | 55 ms | `taste.md:526` |
| Mobile stationary hold before glass drag | 300 ms | `taste.md:815-817` |
| Conversation capsule marquee sweep | 3 s linear | `taste.md:352` |

**E-8** Motion discipline: frame-coalesce pointer-driven optics; never draw a
popup canvas per pointer event; join the actual lift and travel animations before
contraction; a delay or `yield()` is not evidence that another animation finished;
`prefers-reduced-motion` must cover later `!important`-carrying material rules. —
`taste.md:569`, `:559`, `:1045`

**E-9** Error and empty states: error copy is actionable and localised, never raw
transport text; never silently turn missing usage into a measured zero percent; a
loop that can reach a state with no further change and no exit condition is a busy
loop and must be bounded and settled. — `taste.md:854`, `:453`, `:939`

---

## F. Port-relevant constraints

### F.1 Newmark-MemoryLab

**F-1.1** The durable-memory contract is fixed and explicitly shared between PC
and mobile: *"bounded read/query, versioned add/update/refactor/delete,
`expectedUpdatedAt` stale-write rejection, **archive-before-mutation**,
`policy.jsonl` audit, tag DAG/`tagPaths`, and verified rebuild receipts."* —
`taste.md:675`

**F-1.2** Index normalisation has **exactly one owner**, and every UI and Agent
reindex entrance calls it. Bilingual synonyms select **one language-preferred
canonical tag**, preserve the alternatives as aliases, rewrite component
`tags`/`tagPaths`, remove obsolete synonym nodes, and stay **graph-idempotent**
across repeated rebuilds. — `taste.md:676`; `OVERVIEW.md:1236`. The bug class to
avoid: a `reindex()` that does not rebuild the tag graph from the components'
own tags, leaving an overview of `0 标签 · 1 组件` and a detail page saying
「暂无记忆」. — `OVERVIEW.md:3877`

**F-1.3** `memory_lab_query` policy surface, exactly: deterministic scoring over
name / tags / description / content; each scanned component capped at **64,000
characters**; output budget **1,000–48,000 characters**; **1–12** components;
stop when remaining scores fall below **35%** of the strongest result;
English-like terms plus Chinese bigrams for bounded multilingual retrieval; Plan
mode permits this read-only query while continuing to block mutation. —
`OVERVIEW.md:2729`

**F-1.4** `memory_lab_update`: records an explicit **ADD or UPDATE** decision;
advances per-component revisions; checks an optional `expectedUpdatedAt` read
token; **archives the previous core Markdown before replacement**; records content
hashes **without copying memory content into the policy log**. — `OVERVIEW.md:2731`

**F-1.5** `memory_lab_delete`: requires an explicit user forget/remove request;
rejects a stale deletion; archives the final revision; removes the active
component; deterministically rebuilds the tag DAG; returns a **verified completion
receipt**. — `OVERVIEW.md:2731`

**F-1.6** Update and reindex **block completion** until the deterministic index
rebuild and the read-back verification return a completed receipt. —
`SCRIPTS/release-notes-dev-0.1.0.md:12`

**F-1.7** Audit and archive layout: `Memory Lab/policy.jsonl` is **append-only**,
recording action, target, reason, source, revision, timestamps and the archive
location for replay; `Memory Lab/archive/` retains recovery material. On disk:
`Memory Lab/{index.json, components/, archive/}`. The store owns path-containment
checks and tool-facing usage instructions. — `OVERVIEW.md:2731`, `:3488`

**F-1.8** Read path: **one-shot visualization plus a retained in-memory graph,
never re-read on interaction.** The visualization returns one index, all component
core Markdown, a stable relationship version and the load timestamp; the renderer
calls it only when the visualization opens, Reset is requested, or a reindex
succeeds, and it increments a **generation token** so a stale asynchronous result
cannot replace a newer snapshot. Component selection, detail navigation, tag
search, drag and zoom all use the already-built graph and contents and never call
the read API or rebuild the panel. — `OVERVIEW.md:2715-2717`, `:3413`

**F-1.9** Patch-first writes are mandatory: per-component patch so metadata and
body change independently, with unsubmitted fields preserved and body append or
unique-fragment replace supported; whole replacement remains only for
compatibility. — `OVERVIEW.md:1232`, `:1238`; `taste.md:677`

**F-1.10** Memory Lab UI inherits the glass rules: layout-invariant optical canvas
for glass actions; no Material ripple; a single normalisation owner. —
`taste.md:635`, `:663`; `OVERVIEW.md:1258`

**F-1.11** Memory Lab has **one** visualization implementation; the TUI overview
loads the GUI pipeline in isolated viewer mode so anchor, root tags, components,
edges, physics, camera, focus modes, drag, zoom, reset, accessibility attributes
and styling have one owner. — `OVERVIEW.md:2675`, `:3620`

**F-1.12** Memory Lab is **not** covered by the parent's file-write gate, and the
parent explicitly refuses to claim otherwise. — `taste.md:1055`; `OVERVIEW.md:35`

### F.2 Newmark-ComputerUse

**F-2.1** All modes must be ported. The mode space has **four axes**:
`mouse(2) × observation(2) × lane(7) × lease(2)` —
`mouse = real | virtual`; `observation = sparse | full`;
`lane = action | uia | windows | uia_advisory | windows_advisory | window_capture | sparse`;
`lease = takeover_start | takeover_stop`.

> **Correction (2026-10-25, evidence class restated).** An earlier revision of
> this section called that inventory "verified live from the machine-generated
> `computer_use` `mode_report`". That was wrong, and the correction is recorded
> rather than edited away. The `mode_report`/`owner_id` shape was **authored by
> this workspace's own v0.1 probe plugin**, not discovered from Newmark; an
> independent read-only reconnaissance of the parent repository separately
> flagged it as absent there (`grep` for `mode_report` and `owner_id` across
> `DESKTOP/src` returns no matches). The four axes and the seven lane names are
> still correct, and they come from the parent's real source:
> `ComputerUsePowerShellLane` in `DESKTOP/src/tools/computerUsePowerShellHost.ts:378-386`
> defines exactly those seven lanes; `real | virtual` is the stored
> `mouseModeByRuntime`; `sparse`/`full` observation is `sparse_wait_ms` plus the
> default semantic observation; `takeover_start`/`takeover_stop` are two of the
> twenty schema actions.
>
> **F-2.1b** The lease TTL is **`COMPUTER_USE_LOCK_TTL_MS = 10 * 60 * 1000`**
> (600000 ms), from `DESKTOP/src/core/computerUseSession.ts:30-31`, and the
> occupancy marker is the literal `'computerUse occupied'`. The earlier revision
> of this section stated 120000 ms; that value was also this workspace's own
> invention and is superseded. Expiry restores `mouseMode` to `real`
> (`taste.md:5`).
>
> **F-2.1c** The parent's real published `computer_use` schema takes exactly one
> required field, `action`, drawn from a 20-value enum: `observe`, `app_list`,
> `app_observe`, `wait_for`, `sequence`, `takeover_start`, `takeover_stop`,
> `move`, `click`, `drag`, `scroll`, `type`, `key`, `wait`, `app_activate`,
> `app_click`, `app_drag`, `app_scroll`, `app_type`, `app_key`
> (`DESKTOP/src/tools/index.ts:422-469`). `screen_capture` is a separate
> read-only tool that deliberately never touches the lease.

**F-2.2** Action surface. Desktop scope: `observe`, `move`, `click`, `drag`,
`scroll`, `type`, `key`, `wait`, `takeover_start`, `takeover_stop`. App scope:
`app_list`, `app_observe`, `app_activate`, `app_click`, `app_drag`, `app_scroll`,
`app_type`, `app_key`. — `OVERVIEW.md:3500`, `:3170`

**F-2.3** Observation modes: (a) default semantic — full screenshot plus bounded
UI Automation controls with stable `target_id`; (b) `include_ui_tree=false` fast
screenshot — a fresh screenshot and **stale `target_id` cleared**; (c) `wait_for`,
read-only, bounded polling for UIA text, a `target_id` or a visible window,
returning match / timeout / cancel / UIA-unavailable, **default 5 s, cap 30 s**;
(d) `sparse_wait_ms` passive observe — default `0`, **max 5000 ms**, at most
**5 Hz**, comparing a **32×18 grayscale digest**, with no on-device perception
network. — `taste.md:31`, `:79`; `README.md:37`, `:91`; `OVERVIEW.md:97`

**F-2.4** Sparse results are only a wake-up hint: after a wake, a timeout, a
failure or a display-geometry change the caller **must** re-acquire a fresh full
screenshot plus UIA. Sparse sampling is **not** compressed sensing — the remote
model receives the complete image and there is no sparse reconstruction protocol.
— `taste.md:51`, `:80`, `:54`, `:89-92`; `OVERVIEW.md:113`

**F-2.5** Mouse mode is session-scoped and settable **only** at `takeover_start`;
an individual action may never switch its own mode; stop, toggle-off, runtime
cancellation and **lease expiry all restore `real`**. — `taste.md:5`;
`OVERVIEW.md:15`; `archive/2026-09-29-computer-use-mouse-modes.md:8`

**F-2.6** The lease TTL is exactly **120000 ms**, and the lease is a process-wide
single-owner lock: the owner keeps the sequence until `takeover_stop`, and another
owner receives a structured occupied response carrying `lock_owner` and
`requested_owner` rather than a silent steal. — live `mode_report`;
`OVERVIEW.md:3176`, `:3467`

**F-2.7** Real-mode parameters: start from the current cursor; move in **50 ms**
along a smooth, slightly randomised, **DPI-aware** curve; clicks and drags share a
**minimum 350 ms** interval through one reservation queue; `sequence` must not
bypass that limiter; the PowerShell path releases a held button in `finally` on
error or cancellation. — `taste.md:6`; `OVERVIEW.md:15`, `:3500`

**F-2.8** Virtual-mode prohibitions: no `SetCursorPos`, `mouse_event`,
`SendInput`, `SetForegroundWindow` or activation helper; post only to the chosen
HWND or its child; keep the virtual pointer position per owner; receipts must say
`queued=true` / `action_completed=false`, and success only means the message
entered the target thread's queue. **Never silently fall back from virtual to
real input.** — `taste.md:7-8`;
`archive/2026-09-29-computer-use-mouse-modes.md:10,16,19`

**F-2.9** Virtual-mode incompatibilities: it **rejects `observe`** and a
scene-checked `sequence`, because the scene guard observes the foreground desktop;
the caller uses `app_list` / `app_observe` / `app_*` instead. — `taste.md:9`;
`archive/2026-09-29-computer-use-mouse-modes.md:10`

**F-2.10** Invariants: verify the real foreground window before acting and refuse
if activation failed rather than typing into another window; re-verify window
validity and process ownership before input; keep virtual points inside the client
area; refuse a minimized window for capture; use `[System.UIntPtr]::Zero`
explicitly for `mouse_event.dwExtraInfo` on clicks and both wheel paths;
interpret `SetCursorPos` coordinates as physical pixels through a DPI-aware thread
context; accept `ctrl+l` / `alt+f4` / `enter` spellings and escape SendKeys
metacharacters so a URL is never parsed as a chord. — `taste.md:13-15`, `:50`;
`archive/2026-09-29-pc-computer-use-reliability-0.6.9.md:8-11`

**F-2.11** UIA is an advisory lane: bind queries to the foreground or an
explicitly selected window with the existing short-timeout worker; never fall back
to an `AutomationElement.RootElement` deep walk when the handle is missing; never
deep-walk the host process. Its timeout recovery is bounded exponential backoff
**500 / 1000 / 2000 / 4000 ms**, resetting on success, while the action lane keeps
its longer isolation. — `taste.md:16`, `:32`; `OVERVIEW.md:12`

**F-2.12** `wait_for` stays read-only, and Plan mode exposes only the read-only
operations. — `taste.md:33`; `OVERVIEW.md:24`

**F-2.13** Capture budget: `observe` and `app_observe` default to **1280×960**,
clamp requested bounds to **320×240 – 2048×2048**, preserve aspect ratio and never
upscale. — `OVERVIEW.md:3500`. Visual memory is tiered by **available** memory —
`roomy`/`tight`/`critical`/`severe`: single-image cap 2 MiB → 160 KiB, per-request
visual cap 48 MiB → 2 MiB, retained screenshots ≤12 → ≤1, session visual total
192 MiB → 8 MiB, idle-host RSS reclaim line 1536 → 384 MiB, escalating one tier at
60% of the tier's reclaim line, with the newest image retained and oversize
**downsampled (PNG→JPEG) rather than dropped**. — `OVERVIEW.md:454-455`;
`taste.md:194-201`

**F-2.14** The takeover window effect is the **complete, frozen marquee** — see
E-6 for the exact tokens — drawn click-through around the whole perimeter as one
continuous head-to-tail loop, its lifecycle bound to the owning process, with
`GraphicsPath` fill mode `Winding` so the four corner overlaps are not cut out,
and the creation checked for survival rather than assumed. Mutating desktop
actions also **pulse** the indicator. `takeover_stop` clears it. Launch receipts
let the Build continue immediately; persistent overlay closure is a later
lifecycle action and never gates the current step. — `OVERVIEW.md:3158`,
`:3168-3174`, `:3188`, `:3500`, `:3631`, `:2987`

**F-2.14b** The parent draws that stroke as a **native WinForms overlay**, not in
its renderer, and the archive states why: *"The desktop overlay cannot reuse CSS
masks directly because it is a native WinForms edge-only overlay."* The exact
mechanism, from `DESKTOP/src/tools/computerUse.ts` `startTakeoverOverlay`:
an edge-only `Region` built from four rectangles with `GraphicsPath.FillMode =
Winding` so the four corner overlaps are not cut out; border style `None`,
`ShowInTaskbar = false`, `TopMost = true`, bounds = `SystemInformation.VirtualScreen`;
`WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW` set via `SetWindowLong` and re-asserted with
`SetWindowPos(HWND_TOPMOST, … | SWP_NOACTIVATE)`; `WS_EX_LAYERED` and
`TransparencyKey` **deliberately absent** (their presence was the "full-screen
white board" defect); `DoubleBuffered` with `ControlStyles.Opaque`; **256**
interpolated `SolidBrush` colours around a 4-stop palette; a
`System.Windows.Forms.Timer` at **33 ms** repainting one **clockwise** perimeter
path (`offset = elapsed / 3s × perimeter`); a 1000 ms watchdog that closes the
form when the owning pid disappears; and `lifecycle: 'owner-process-bound'`
(pid = the owning process) versus `'duration-bound'` (pid = 0, self-closing timer,
used only for a timed CLI invocation). Width is hard-coded **2**, speed **3 s**,
palette hard-coded `['#000000', '#ffffff', '#000000', '#ffffff']`; the incoming
`gradient_*` arguments are **discarded**, and the three legacy config keys are
removed from memory and disk on load (`config.ts:502-513`).

**F-2.14c** Mutating real-mode actions also **pulse** the indicator: if no overlay
is running, `pulseTakeoverOverlay()` starts one for **2500 ms** with the remembered
style, so a user sees an indicator even when the model never called
`takeover_start`.

**F-2.15** The effect is **stroke-only** in this port. The parent's own
authoritative override states it is *"strictly a continuous black/white/black/white
border"* with `opacity: 1` and `mix-blend-mode: normal`. The user restated the
requirement: *"我要求的效果是只有原版一致的描边"*. No glow, no corner brackets,
no scanline, no drawn status pill.

**F-2.16** Explicit compatibility boundaries that must be **documented, not
silently handled**: minimized windows are refused for capture; a title bar or
border outside the client area is unsupported for a virtual click; `PrintWindow`
needs the target to answer the render request, so GPU or exclusive-render windows
may return blank and the target may slow while handling it; UIPI and higher
integrity levels may block posting; Raw Input and applications that ignore posted
messages are explicit boundaries. — `archive/2026-09-29-computer-use-mouse-modes.md:16-19`;
`README.md:31`

**F-2.17** Screenshots use an independent, killable `window_capture` worker
calling `PrintWindow`, never the UI thread or the normal action lane; a worker
timeout kills it and enters a cooldown. — `taste.md:8`;
`archive/2026-09-29-computer-use-mouse-modes.md:11`

**F-2.18** Everything retired stays out: CULab / NES-T / NMEP / ONNX loader,
artifact discovery, schema emitter, `onnxruntime-node` as a CU dependency, the 16D
ABI validator, `validateCuArtifact()`, `CuArtifactLoadError`,
`TemporalEntityRegistry` / `cue-######` identity minting, `SceneVersion` /
`sceneState`, `perceptionRouter` / `CuCadenceGate`, the keyframe `frameStore`,
`actionTransaction` / `EFFECT_UNCERTAIN`, `grounder` / `verifier`,
`visionCapability`, `legacySenseProvider`, `stableEdgeModelProvider` /
`disabledEdgeModelProvider`, `artifactEligibility`, the CU-Lab-specific
`*Verify` gates, and the `NEWMARK_CU_LAB_ROOT` environment hook. The frozen legacy
source under `archive/20260926-cu-local-model-retirement/legacy-source/` is a
reference shelf, not a port source. — `OVERVIEW.md:59`;
`taste.md:50`, `:53`; `newmark-cu-lab/OVERVIEW.md:7`, `README.md:3`, `STATUS.md:5`
(those three lab files were removed from the working tree 2026-09-30; frozen copies
live in `archive/20260930-001844-culab-purge/source-snapshot/`)

**F-2.19** ComputerUse is **not** covered by the parent's file-write gate, and the
parent explicitly refuses to claim that it is. — `taste.md:1055`; `OVERVIEW.md:35`

**F-2.20** The expected shape of the port's gate: a synthetic visual target with a
read-only action guard, exercising the native input events, the standard key
chords plus literal URL punctuation, a timed UIA failure with recovery, rapid
repeated app observations, and real and virtual drags each reaching a drop target
with the observed down/move/up sequence — with virtual drags additionally proving
the physical cursor and the foreground HWND are unchanged. A synthetic-target pass
is never called a real-desktop acceptance. — `taste.md:17`, `:1057`;
`OVERVIEW.md:16`, `:34`; `archive/2026-09-29-computer-use-mouse-modes.md:23-24`

### F.3 The DSH target's own constraints

These come from the live Harness rather than the parent project, and are recorded
in full in [`01-dsh-plugin-contract.md`](01-dsh-plugin-contract.md).

**F-3.1** A left-column entry and its presentation window are **one id**:
`sidebar.panellist` registration `id` is the `main` slot's `key`. Both seats
carry `replaceRisk: none` (panellist) and an open key domain (`main`), so a fresh
id is additive. `sidebar.panellist`'s icon receives `{ size, active }`.

**F-3.2** A Client half may not import a Harness Client package; it gets React
from the platform module table and everything else from Cordis services or its own
Host half's HTTP route.

**F-3.3** `host.call` is a dynamic-package builtin, not an installed-bundle API.
The Client half reaches its Host half over the `ctx.webServer` prefix route it
registers, and a refused fetch is reported as state rather than as an empty store.

**F-3.4** Installation is not rendering. `application: applied` plus a live slot
occupant proves the registration; without browser control, visual verification
stops exactly there and the record says so.

---

## Adoption checklist

1. `Newmark2DSH/{README.md, OVERVIEW.md, taste.md, archive/}` exist in the parent's
   shape. — `agent.md:11-13`; `newmark-cu-lab/OVERVIEW.md:13-16`
2. Precedence declared in one line: **code > documents; archive append-only;
   conflicts named.** — `cordis.patch.yml:37`
3. Noise gate: no diagnostics, probes, tests, source maps, logs or developer paths
   in the plugin's shipped files, with a discriminating negative assertion. —
   `taste.md:184-189`; `OVERVIEW.md:443-448`; T-6.5
4. Isolation gate: neither plugin references the retired CU-Lab tree; asserted
   mechanically. — `OVERVIEW.md:190`; T-4.1
5. Evidence schema: every claim carries a citation, a gate name, an assertion
   count, and a `## Boundaries` block. — `archive/2026-09-29-*.md:41-47`; T-5.5
6. Claim vocabulary: `PASS` only for a measured gate; `candidate`, `estimate`,
   `untested`, `SKIP`, `BLOCKED` kept separate. — `newmark-cu-lab/taste.md:51`;
   `cordis.patch.yml:41`
7. MemoryLab: one normaliser, one-shot visualisation with a generation token,
   append-only `policy.jsonl` plus `archive/`, `expectedUpdatedAt`, verified
   receipts. — `taste.md:675-676`; `OVERVIEW.md:2715`
8. ComputerUse: all four mode axes, all 19 action verbs, the session-bound mouse
   mode restored to `real` on every exit path, the 350 ms / 50 ms input limits,
   the 120000 ms lease, the virtual-mode prohibition list, and the frozen marquee
   reproduced verbatim. — `taste.md:3-9`; `OVERVIEW.md:3500`, `:4035`; live
   `mode_report`
9. Every gate is enrolled into a named chain. — `DESKTOP/package.json:55,65,115`;
   `OVERVIEW.md:338`
