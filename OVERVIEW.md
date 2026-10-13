# Package overview

0.3.10 packages five independently configurable DSH components. The core composes local entries; separate component dependencies are unnecessary.

| Path | Purpose |
|---|---|
| index.js / client.js | Host composition, configuration, MemoryLab/NewMate panels and native navigation |
| cordis.patch.yml | Core and Dev/rDev loader rows |
| lib/ | User-root resolution, model selection, state, delivery, restart and error handling |
| components/memorylab/ | Tagged memory, relations, short memory and tools |
| components/agent-api/ | Agent execution, DSH model seam, vision metadata and isolation |
| components/newmate/ | Companion state, attention/proactive policy, memory context, MCP and file-reference validation |
| components/heartbeat/ | Scoped restart task creation, delivery and permanent receipts |
| components/computeruse/ | Platform automation, native indicators, shared pet and menu sources/assets |
| components/computeruse/lib/darwin.js | Lazy Mac dispatch and bounded sparse measurement |
| darwin-native.swift / darwin-vm.swift | Unvalidated Mac native CU and isolated Linux VM boot/view prototypes |
| darwin-vm.entitlements.plist | Virtualization entitlement for the manual VM prototype |
| docs/native-model-and-macos.md | Public model boundary and Mac assessment/acceptance limits |
| scripts/check-release-bundle.mjs | Five-component self-contained release guard |
| .github/workflows/publish.yml | Tag/manifest validation, package inventory and npm trusted publishing |
| CHANGELOG-*.md | Public version records |

Development archives, private profiles, session records and machine-specific visual evidence remain outside this repository and npm artifact.
