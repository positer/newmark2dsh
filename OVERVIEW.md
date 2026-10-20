# Package overview

0.3.20 packages five independently configurable DSH components. The core composes local entries; separate component dependencies are unnecessary.

| Path | Purpose |
|---|---|
| index.js / client.js | Host composition, configuration, MemoryLab/NewMate panels and native navigation |
| cordis.patch.yml | Core and Dev/rDev loader rows |
| lib/ | User-root resolution, model selection, state, delivery, restart and error handling |
| components/memorylab/ | Tagged memory, relations, short memory and tools |
| components/agent-api/ | Agent execution, DSH model seam, vision metadata and isolation |
| components/newmate/ | Companion state, attention/proactive policy, memory context, durable toDoList, MCP and file-reference validation |
| components/heartbeat/ | Scoped restart task creation, delivery and permanent receipts |
| components/computeruse/ | Platform automation, native indicators, shared pet and menu sources/assets |
| components/computeruse/lib/darwin.js | Lazy Mac dispatch and bounded sparse measurement |
| darwin-native.swift / darwin-vm.swift | Apple Silicon visual/AX/Space CU; historical VM prototype is not the chosen backend |
| darwin-vm.entitlements.plist | Virtualization entitlement for the manual VM prototype |
| docs/native-model-and-macos.md | Public model boundary and Mac assessment/acceptance limits |
| scripts/check-release-bundle.mjs | Five-component self-contained release guard |
| .github/workflows/publish.yml | Tag/manifest validation, package inventory and npm trusted publishing |
| GitHub Releases | Public version history and release notes |

Development archives, private profiles, session records and machine-specific visual evidence remain outside this repository and npm artifact.

## 0.3.13 acceptance additions

components/newmate/lib/todo-list.js validates future zoned timestamps and durably reconciles delivery. The client owns the manual form and reminder status panel. scripts/verify-newmate-todo*.mjs cover kernel, HTTP and Chromium/WebKit interaction. .github/workflows/macos-validation.yml compiles actual Swift helpers and runs native render/input and real two-Space fixtures on ARM64 macOS 14/15/26. Public archives exclude profile backups and private data.

0.3.14 scheduled activation is implemented in components/newmate/component.js and lib/todo-list.js, with MCP and page mode selection. darwin-native.swift implements the perimeter marquee; desktop-pet-darwin.swift crops the sprite and renders backing-scale alpha contours; desktop-pet.js preserves active CU ownership on companion startup. Windows regression scripts accept installed package roots. The 0.3.14 GitHub Release records validation and platform boundaries.


## 2026-10-14 GitHub 产品首页整理

README.md 按定位、场景、五组件详解、Dev/rDev、快速开始、平台、数据协作、结构、版本、许可重构。taste.md 新增持续适用的 README 格式契约。旧首页中的组件数量、外置依赖安装和历史候选叙述不再作为当前使用说明；原文完整保存在本地 before 快照中。本次仅修改文档与 GitHub About，不改变 0.3.14 运行版本。

README.md 负责当前用户介绍，taste.md 负责格式和验证约束，OVERVIEW.md 继续记录文件职责与状态；GitHub Releases 保存公开版本历史。开发操作档案不进入公开 Git 或 npm。


## 2026-10-14 README 润色与远端读校验

README 保留五组件首页结构，简化术语、完善工具全名，增加阅读导航；taste 补充导航、术语与推送后读校验要求。仅修改文档，运行版本保持 0.3.14。


## 2026-10-14 Historical changelog archival

All 18 root CHANGELOG markdown files are preserved byte-identically under local archive/20261014-104450-changelogs/ and removed from Git tracking. archive/ remains ignored; README links GitHub Releases for public history. Existing tags and Git history remain intact; runtime version stays 0.3.14.


## 0.3.19 (2026-10-20, published)

The package line above advances from 0.3.14 to 0.3.19. MemoryLab's model-facing descriptions now state the two stores' division on every tool: `LONG_TERM_ROLE` opens the nine `memory_lab_*` tools (durable, tag-tree knowledge shared across conversations — a user profile and a knowledge graph; nothing there expires) and `SHORT_TERM_ROLE` opens the four `shortMemory_*` tools (a flat list that expires on its own, seven days by default, kept for cross-conversation task handoff). `memory_lab_read`'s instructions carry the same split. The memory-tool gate grew from 168 to 176 assertions, and five planted mutations were detected and restored byte-for-byte.

Published to npm as 0.3.19 from tag v0.3.19 (publish run 39440904853): registry `latest` moved to 0.3.19, the downloaded tarball matched the published integrity, and 93 files checked out as 78 byte-identical plus 15 normalized to LF (zero substantive differences). Versions 0.3.15–0.3.18 were local-only and never published; 0.3.19 is the first release since 0.3.14 and carries their runtime fixes. This page keeps the public documentation policy: the release commit's package content is identical here, root changelogs stay archived, and version history stays in GitHub Releases.

## 0.3.20 (2026-10-20, published)

NewMate's initialization payload now carries four things in one system prefix: the persona (`NEWMATE_PERSONA`), the complete MemoryLab tag tree (every tag plus each memory node's slug/name/tags, no bodies), every short-memory row with its own expiry flag, and the schema of the run tool group. The tool group is the run allow list resolved against the live registry — a read-only projection that executes nothing — so plugin-provided tools are described by their registered schema and any group name the current exposure lacks is reported in `toolsMissing` instead of being offered. The per-turn prompt keeps only time, task, history and output protocols. Measured prefix: 24,626 characters (14,438 at 0.3.19).

Published to npm as 0.3.20 from tag v0.3.20; the package content is the release tree and this branch keeps its public documentation policy (archived changelogs, version history in GitHub Releases).
