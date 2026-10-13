# Newmark2DSH

A self-contained plugin that brings persistent memory, desktop automation and a personalized companion to DeepSeek Harness. Five independent switches control MemoryLab, ComputerUse, Agent API, NewMate and heartBeat over the shared `~/.Newmark` user store.

## Current release: 0.3.10

NewMate supports persistent chat, MemoryLab personalization, steering during a run, read-only history and low-frequency proactive messages through a shared desktop pet. heartBeat owns desktop restart and one-time post-restart delivery. Agent API follows the DSH public model resolver and stream parser, so provider integrations stay in the host adapter layer. File links prefer registered native sidebar previews and otherwise reveal files in the file manager.

Windows acceptance includes native document navigation, menu integration probes and 699 related checks. macOS CU and isolated VM code are **source prototypes awaiting native compilation and hardware acceptance**; guest CU is not connected. [Release details and limits](CHANGELOG-0.3.10.md).

## Install

Install `newmark2dsh` through the DSH plugin manager and enable the required components in configuration. Updating loaded backend/native modules requires a host restart. Official DSH's package-age policy can select an older version for a bare package name; explicit version selection is preferable when requesting this release. Full automatic desktop restart currently supports the official Windows container.

## Components

- MemoryLab: persistent tagged memory, relationship trees and shortMemory tools.
- ComputerUse: bounded observation/input, takeover indication and supported isolated desktop backends.
- Agent API: model-backed agent execution using DSH public services; no bundled credentials.
- NewMate: personalized companion core, current chat, read-only history, bubbles and MCP access.
- heartBeat: restart tasks, scoped conversation delivery and permanent consumption receipts.

## Platforms

Windows helpers are compiled from bundled source using system .NET Framework and cached by source hash. Linux/WSLg uses isolated X11 sessions; dependencies include xvfb, xauth, openbox, xdotool, wmctrl, python3-xlib, python3-pil and python3-pyqt5. Native Wayland control is not supported. Mac prototypes and their explicit limits are documented in [the platform assessment](docs/native-model-and-macos.md).

[Package layout](OVERVIEW.md) · [Engineering conventions](taste.md)
