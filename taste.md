# Release engineering conventions

- Keep runtime bytes synchronized with the accepted development package. Change product code in the development workspace, with appropriate verification, before publishing.
- Keep the bundle self-contained and component versions aligned. The core loads components through local paths; no separate component dependency is required.
- NewMate previews are read-only. Contour state reflects visible preview windows, animations are reversible, and size preferences load before the first displayed frame.
- Preserve user-root configuration and atomically store preferences. Isolate test stores and release a test lease when acceptance is complete.
- Distinguish source, packed, published and installed evidence. A successful publish command is insufficient without registry retrieval and byte comparison.
- Publish only the package and public documentation. Local profile backups, session records, private paths and development archives do not belong in Git or npm.
- Read README/OVERVIEW/taste before work, update current documentation afterward, and retain timestamped operation records in the local archive.
