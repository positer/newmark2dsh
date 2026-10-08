# Release engineering conventions

- Keep runtime bytes synchronized with the accepted development package. Change product code in the development workspace, with appropriate verification, before publishing.
- Keep the bundle self-contained and component versions aligned. The core loads components through local paths; no separate component dependency is required.
- NewMate previews are read-only. Contour state reflects visible preview windows, animations are reversible, and size preferences load before the first displayed frame.
- Preserve user-root configuration and atomically store preferences. Isolate test stores and release a test lease when acceptance is complete.
- Distinguish source, packed, published and installed evidence. A successful publish command is insufficient without registry retrieval and byte comparison.
- Publish only the package and public documentation. Local profile backups, session records, private paths and development archives do not belong in Git or npm.
- Read README/OVERVIEW/taste before work, update current documentation afterward, and retain timestamped operation records in the local archive.

## 0.2.26 rendering
Separate animation presentation from source capture and report measured frame intervals by phase. Reuse DIB/DC/Graphics, batch alpha-contour updates and coalesce UI frames; never grow an unbounded render queue. Keep native viewer bounds fixed and animate GPU transforms, preserving input isolation and explicit process cleanup. Retain DSH tokens and plugin CSS overrides in both settings surfaces.

## Process-preserving presentation transfers
Never claim HWND-thread migration: receipts expose original identity and presentation identity separately. Reserve both desktop modes during crossing. Bind ownership to the trusted DSH session. Preserve exported application jobs, clean only unexported job members using retained process handles, restore imports, and test abrupt host/broker death independently from normal stop. GPU callback cadence is distinct from source capture cadence.

## Process transfer presentation

Process push/pull flights follow source-window z-order and the live expanded-preview layer without forcing a collapse or unconditional topmost activation. Native animation receipts expose layer, preview_expanded and topmost. Empty virtual desktops use pure black; no fixture application is launched by default.

## 0.2.30 display pacing and Linux

`components/computeruse/lib/linux-desktop.js` launches the isolated X11 host; `linux-desktop.py` owns leases, authenticated Xvfb, mappings, GPU presentation and independent capture. `linux-process-guard.py` guards virtual process lifetime. Windows `desktop-pet.cs` and `desktop-transfer.cs` use output vblank pacing with bounded pending frames. Preserve input isolation and original process identity; distinguish render callbacks from physical scanout.
