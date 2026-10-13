# Newmark2DSH

A self-contained plugin bringing persistent memory, desktop automation and a personalized companion to DeepSeek Harness. Five independent switches control MemoryLab, ComputerUse, Agent API, NewMate and heartBeat over the shared ~/.Newmark store.

## Current release: 0.3.14

NewMate's durable toDoList can run a scheduled conversation using MemoryLab context, or deliver an explicit text-only reminder. Create entries in its page, any DSH conversation, NewMate or authenticated MCP with newmate_todo_add/list/cancel. Reading, drafts, user input, host activity, quiet hours and snooze defer activation. Stable task/message receipts prevent restart replay; failures never retry automatically. Existing reminders keep their original behavior. Replies arrive through the shared pet bubble; the window opens when the user clicks.

NewMate supports steering, read-only history, inline generated HTML, registered native document previews, scoped memory writes and themed shared-pet bubbles. Agent API uses the DSH public model resolver and parser with exact provider/model isolation. heartBeat owns Windows desktop restart and permanently consumes post-restart tasks.

CU uses a clockwise black/white screen marquee and a proportional alpha-contour pet. macOS crops transparent image margins and supports backing scale; Windows companionship inherits an active CU desktop without replacing its pet PID.

## Install

Install newmark2dsh@0.3.14 through the DSH plugin manager and enable desired components. Loaded backend/native updates require a host restart. Explicit versions avoid the official host package-age policy selecting older releases. Full automatic desktop restart currently targets the official Windows container.

## Platforms and validation

Windows helpers compile using system .NET Framework and cache by source hash. Installed Windows candidate validation passed the 200-check full gate plus native lifecycle, preview, menu, preferences and real scheduled model/MCP/restart checks.

Apple Silicon macOS 14/15/26 uses visual and Accessibility channels plus Mission Control Spaces, a 100ms user-input idle guard, foreground/cursor restoration, a shared pet and normal CU border. [Native/browser matrix](https://github.com/positer/newmark2dsh/actions/runs/38394193819) · [Mission Control two-Space matrix](https://github.com/positer/newmark2dsh/actions/runs/38395064819).

Cloud validation uses owned native fixtures and the actual NewMate client with explicit host/model fixtures. It does not prove official macOS DSH installation, physical keyboard/mouse timing, multi-display/fullscreen combinations or minimum Neo hardware performance. Spaces share user input; they are not complete isolation. Native styling and proportions align across platforms; physical pixels and native menu widgets can differ.

Linux/WSLg uses isolated X11 sessions (xvfb, xauth, openbox, xdotool, wmctrl, python3-xlib, python3-pil, python3-pyqt5); native Wayland control is unsupported.

[Release notes](CHANGELOG-0.3.14.md) · [Package layout](OVERVIEW.md) · [Engineering conventions](taste.md) · [Mac acceptance](MACOS-CANDIDATE.md)
