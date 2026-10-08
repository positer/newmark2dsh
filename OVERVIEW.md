# Newmark2DSH release repository

This repository holds the self-contained package published as `newmark2dsh`. Development and Windows acceptance evidence live in the parent development workspace. The product includes MemoryLab, ComputerUse with NewMate, Agent API, and Dev/rDev presets.

| Path | Structure and purpose |
|---|---|
| `package.json` | Version, exports, package files and DSH bundle metadata |
| `index.js`, `client.js` | Host composition, component switches and client panel |
| `lib/` | Shared root resolution, configuration, model selection and error helpers |
| `components/memorylab/` | Component entry, tools, storage and client renderer |
| `components/computeruse/` | Component entry, platform backends, native helper source and mascot asset |
| `components/computeruse/lib/desktop-pet.js` | Hash-addressed helper compilation, lifetime and preference location |
| `components/computeruse/lib/desktop-pet.cs` | Transparent mascot, animation, scale menu/persistence and read-only preview |
| `components/computeruse/assets/desktop-pet.png` | NewMate image |
| `components/agent-api/` | Component entry, API tools and execution modules |
| `locale/` | Interface localization |
| `cordis.patch.yml` | Core, Dev and rDev loader rows |
| `.github/workflows/publish.yml` | Tag/version validation, package checks and OIDC npm publication |
| `README.md`, `taste.md`, `LICENSE` | Product introduction, engineering rules and usage rights |
| `archive/` | Local operation records, excluded from Git and npm |

0.2.24 adds the NewMate desktop indicator, motion and remembered size. All 45 runtime/package files are synchronized from the locally validated development package. Publication and installation receipts are retained in the development workspace's timestamped release archive.

## 0.2.26
Configuration cards group model and NewMate controls. ComputerUse desktop-pet.cs owns persistent DIB drawing, deadline frame pacing and a GPU WebView2 read-only viewer with warm reuse. desktop-menu.cs/html and desktop-menu-client/theme.js share live DSH Menu appearance. lib/newmate-settings.js owns versioned continuous preferences. vendor/webview2 includes pinned SDK binaries, provenance and license.

## 0.2.27
`components/computeruse/lib/desktop-transfer.cs` owns the capture/control proxy, job retention/cleanup, crash guardian and WebView2 flight. Its `.js` partner compiles native code and coordinates identity-checked receipts. `takeover-lock.cs/js` hold one kernel mutex per mode across hosts. `lib/cu-caller.js` preserves DSH session identity through asynchronous Agent API dispatch. `hidden-agent.js` watches the owner lifetime. Acceptance sources and raw source/installed receipts remain in the development archive `20261007-cu-transfer`.

0.2.28 closes presentations independently when source windows disappear, retries temporary capture failures and clears stale frames. Native transfer acceptance now independently checks the presentation process has exited.

## Process transfer presentation

Process push/pull flights follow source-window z-order and the live expanded-preview layer without forcing a collapse or unconditional topmost activation. Native animation receipts expose layer, preview_expanded and topmost. Empty virtual desktops use pure black; no fixture application is launched by default.

## 0.2.30 display pacing and Linux

`components/computeruse/lib/linux-desktop.js` launches the isolated X11 host; `linux-desktop.py` owns leases, authenticated Xvfb, mappings, GPU presentation and independent capture. `linux-process-guard.py` guards virtual process lifetime. Windows `desktop-pet.cs` and `desktop-transfer.cs` use output vblank pacing with bounded pending frames. Preserve input isolation and original process identity; distinguish render callbacks from physical scanout.

0.2.31 separates TransferBroker controlTimer (commands/status) from its PetFrameClock (presentation).
