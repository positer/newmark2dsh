# newmark2dsh

A single DeepSeek Harness plugin bundle carrying **Newmark's MemoryLab**,
**ComputerUse** and the **Dev agent preset** as four independently switchable
components, over the shared `~/.Newmark` user store.

## What is in it

| Loader row | Package | What it is |
|---|---|---|
| `newmark-core` | `newmark2dsh` | The shared Newmark root and the injected snapshot |
| `newmark-memorylab` | `newmark2dsh-memorylab` | Persistent memory: five `memory_lab_*` tools and the sidebar renderer |
| `newmark-computeruse` | `newmark2dsh-computeruse` | 21 `computer_use` actions and the native screen-wide takeover stroke |
| `preset-dev` | `@deepseek-ai/dsh-agent-preset` | The Dev agent preset, declared and selected by this bundle |

The two component packages live inside this one bundle (`components/<name>/`) and
are declared as its dependencies, so installing the bundle installs them.

## Install

```
plugin_manager action=install_bundle target=newmark2dsh
```

## The takeover stroke

It is a **native, topmost, click-through WinForms window covering the whole virtual
screen** — not a page decoration. It must live outside the DSH window, so the DSH
page neither draws it nor learns about it, and it appears and clears with the lease
rather than with a page load.

```
WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST, no WS_EX_LAYERED
bounds == SystemInformation.VirtualScreen      2 px stroke, 3000 ms lap, 33 ms timer
spawned with CREATE_NO_WINDOW                  stopped by takeover_stop, lease expiry,
                                               stopAll, process exit, owner watchdog
```

## MemoryLab and the shared store

MemoryLab reads and writes the **same** user store the Newmark desktop app uses:
`~/.Newmark/Memory Lab`. The index is version 2 — `#`-prefixed tags, a
`components` object keyed by slug, and `contentHash`/`bytes` per component.
The plugin never rewrites the index on page load: a rebuild is gated on
`relationshipVersion` plus each component's hash, so a store that has not changed
is not written.

## Verification

The plugin is developed against seven gates; the ones a reader can run against this
repository are:

```
node scripts/verify-newmark-core.mjs            # the release gate
node scripts/verify-newmark-core-package.mjs    # publishable and self-contained
node scripts/verify-memorylab-tools.mjs         # all five tools + their pre-exposure
```

## Releasing

Publishing is driven by a version tag, through **npm Trusted Publishing (OIDC)** — no
token lives in this repository and there is nothing to rotate.

```
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/publish.yml` then checks that the tag and `package.json` agree,
checks that the bundle is self-contained (both nested manifests present, both declared
as dependencies, neither declaring `dsh.client`), and publishes with
`--provenance`.

One-time setup on the npm side, at
<https://www.npmjs.com/package/newmark2dsh/access> → **Trusted Publisher**:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Repository | `positer/newmark2dsh` |
| Workflow filename | `publish.yml` |

These must match the workflow exactly, or the registry refuses the OIDC exchange.

A tag can never publish a version other than the one in `package.json`: the mismatch
fails the run instead of shipping something nobody asked for.

## License

Proprietary. See [LICENSE](LICENSE) — all rights reserved by Newmark AI, no licence
granted by publication.
