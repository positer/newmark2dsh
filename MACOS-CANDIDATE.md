# macOS 0.3.12 source candidate

Apple Silicon only: macOS 14, 15, 26 ARM64. Not installed or published.

[Full render/operation matrix](https://github.com/positer/newmark2dsh/actions/runs/38353313760) passes 93 JS contracts, 45 native scenarios and 28 real React DOM Chromium/WebKit scenarios per OS. [Distinct Mission Control Space matrix](https://github.com/positer/newmark2dsh/actions/runs/38353318075) passes five additional actual two-Space groups per OS. Both tested runtime commit: cfa732271e729450c215972e1c9addbc6b967a65.

Visual and AX routes work independently, with optional geometry cross-check. Off-Space AX binding is guarded by the native lease and 100ms user idle; validated window references survive AXWindows omission. Explicit activate_for_observation may briefly switch for pixels and restore the exact foreground window/cursor. Default observation and pet preview never activate a Space. Input/observation wait for Space transitions to settle and restore requires actual original window visibility. New user input always wins.

Native evidence covers pixels, AX effects, Unicode/scroll/key delivery, independent cursor sampling, shared pet/preview/menu, theme bubbles and normal border visual/click-through/teardown. Browser uses actual client.js + React, with explicit DSH backend/document-renderer/model fixtures. No actual Mac DSH container installation, physical keyboard/mouse timing, multi-screen/fullscreen combination or Neo minimum-hardware performance claim. No private Space API, TCC edits, remote server or paid runner. Historical Intel runs are retained only; future CI excludes Intel.
