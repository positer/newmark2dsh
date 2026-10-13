# Newmark2DSH

A self-contained plugin bringing persistent memory, desktop automation and a personalized companion to DeepSeek Harness. Five independent switches control MemoryLab, ComputerUse, Agent API, NewMate and heartBeat over the shared ~/.Newmark store.

## Current release: 0.3.13

NewMate adds a durable toDoList: choose activation time and message in its page, or create reminders from any DSH conversation, NewMate or authenticated MCP through newmate_todo_add/list/cancel. Due messages follow attention protection and automatic conversation handoff without an extra model call. Companion-off postpones delivery; quiet/snooze/bubble limits suppress interruption. Stable message IDs and permanent delivery state prevent restart replay.

NewMate supports steering, read-only history, inline generated HTML, registered native document previews, scoped memory writes and themed shared-pet bubbles. Agent API uses the DSH public model resolver and parser with exact provider/model isolation. heartBeat owns Windows desktop restart and permanently consumes post-restart tasks.

## Install

Install newmark2dsh@0.3.13 through the DSH plugin manager and enable desired components. Loaded backend/native updates require a host restart. Explicit versions avoid the official host package-age policy selecting older releases. Full automatic desktop restart currently targets the official Windows container.

## Platforms and validation

Windows helpers compile using system .NET Framework and cache by source hash. Apple Silicon macOS 14/15/26 uses visual and Accessibility channels plus Mission Control Spaces, a 100ms user-input idle guard, foreground/cursor restoration, a shared pet and normal CU border. [Native and browser matrix](https://github.com/positer/newmark2dsh/actions/runs/38360580407) · [Mission Control two-Space matrix](https://github.com/positer/newmark2dsh/actions/runs/38360583039).

Cloud validation uses owned native fixtures and the actual NewMate client with explicit host/model fixtures. It does not prove official macOS DSH installation, physical keyboard/mouse timing, multi-display/fullscreen combinations or minimum Neo hardware performance. Spaces share user input; they are not complete isolation.

Linux/WSLg uses isolated X11 sessions (xvfb, xauth, openbox, xdotool, wmctrl, python3-xlib, python3-pil, python3-pyqt5); native Wayland control is unsupported.

[Release notes](CHANGELOG-0.3.13.md) · [Package layout](OVERVIEW.md) · [Engineering conventions](taste.md) · [Mac acceptance](MACOS-CANDIDATE.md)
