# Newmark2DSH 0.3.10

Five independently configurable components in one DSH plugin: MemoryLab, ComputerUse, Agent API, NewMate and heartBeat. This release includes the NewMate/heartBeat additions and subsequent fixes since the previous public 0.2.39.

- NewMate provides a persistent companion chat, read-only history, MemoryLab-driven personalization, short message bubbles and an MCP interface. It cannot autonomously delete files. User input steers the current run instead of queuing another turn. Proactive contact respects attention, cooldowns and quiet periods; unprompted capability reports are suppressed. NewMate messages use the shared desktop pet, without OS notifications or a separate tray.
- heartBeat restores the current conversation's provider/model context after restart. Delivered restart tasks are consumed permanently. Conversation tools can create tasks only for their own conversation and request a global DSH restart.
- MemoryLab shortMemory stores numbered, timestamped short items, with a seven-day default expiry. NewMate receives tag relationships and recent short memories before its first model request.
- Agent API uses DSH public resolveModelInfo, prepareCall and BlockAssembler. Provider plugins own authentication and protocol adaptation; no provider-name special cases. Same-name models remain provider-isolated, including opaque replay state. Real installed DSH runtime/parser checks used in-memory adapters; third-party provider plugins were not installed or live-tested.
- File references use the current DSH document-preview registry and native sidebar, with file-manager reveal fallback. Future registered preview types need no NewMate suffix list. Links are borderless, bold and underlined. Read-only history scrolling and draft preservation are fixed.
- Windows pet menus follow DSH theme/font, prewarm their WebView and reuse the loaded document. An isolated production-source integration probe opened in 38 ms after warm-up; user-pet physical right-click was not part of this acceptance.

699 related checks passed. Windows native Markdown sidebar navigation and file-manager reveal were exercised in the official DSH desktop. Source, final local package and installation matched for all 89 shipped files.

## macOS prototype boundary

Public AppKit/CoreGraphics/Accessibility/ScreenCaptureKit source prototypes provide bounded observation, sparse measurement and basic input. Interactive native takeover requires macOS 14+; it does not block human physical input. A Virtualization.framework Linux VM boot/view prototype requires user-provided boot assets. Neither Mac native compilation nor hardware/VM boot has been validated. Guest CU transport/routing is not connected; virtual requests explicitly refuse physical-desktop fallback. Mac NewMate pet parity is not implemented. See [implementation assessment](docs/native-model-and-macos.md).
