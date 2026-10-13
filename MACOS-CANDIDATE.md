# macOS 0.3.12 candidate

Source candidate for Space + AX, 100ms user-idle gating, cursor/focus restoration, shared native pet preview and normal CU borders. Not installed or published.

[Native cloud validation](https://github.com/positer/newmark2dsh/actions/runs/38334868446) passed on macOS 14.8.9 and 15.7.9 ARM64: CU/pet SDK compilation, isolated contracts, read-only protocol, and AXPress against owned AppKit fixture windows. The original foreground fixture became active/key again; cursor restore was reported by the native helper. Normal border creation and Space border absence passed runtime checks. Tested runtime commit: 1a3082fbbe7fc36847174262c76a698fb07beb88.

Only owned fixture PIDs receive actions. No TCC edits, permission bypass, remote server/tunnel, paid larger runner or package publication. Public standard runners are free.

Actual distinct Mission Control Spaces, physical user-input priority/100ms timing, pet click and DSH reopen, multi-screen visual geometry and Neo A18 Pro/8GB performance remain unverified. CI is not a permanent interactive Mac server.
