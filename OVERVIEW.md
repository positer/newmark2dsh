# Package overview

0.3.14 packages five independently configurable DSH components. The core composes local entries; separate component dependencies are unnecessary.

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
| CHANGELOG-*.md | Public version records |

Development archives, private profiles, session records and machine-specific visual evidence remain outside this repository and npm artifact.

## 0.3.13 acceptance additions

components/newmate/lib/todo-list.js validates future zoned timestamps and durably reconciles delivery. The client owns the manual form and reminder status panel. scripts/verify-newmate-todo*.mjs cover kernel, HTTP and Chromium/WebKit interaction. .github/workflows/macos-validation.yml compiles actual Swift helpers and runs native render/input and real two-Space fixtures on ARM64 macOS 14/15/26. Public archives exclude profile backups and private data.

0.3.14 scheduled activation is implemented in components/newmate/component.js and lib/todo-list.js, with MCP and page mode selection. darwin-native.swift implements the perimeter marquee; desktop-pet-darwin.swift crops the sprite and renders backing-scale alpha contours; desktop-pet.js preserves active CU ownership on companion startup. Windows regression scripts accept installed package roots. CHANGELOG-0.3.14.md records validation and platform boundaries.
