# Newmark2DSH 0.3.14

NewMate scheduled toDoList entries now default to running one conversation turn, using native MemoryLab context. Existing persisted reminders retain their original text-only behavior; new entries can explicitly select reminder mode.

Reading, drafts, active input, host work, quiet hours and snooze defer activation. The existing attention policy selects the current or a new conversation. Stable task/message receipts prevent duplicate model runs after restart; failed or interrupted runs do not retry automatically. Results use the shared pet bubble, and the main window opens on user action.

macOS normal CU now uses the Windows-style clockwise black/white perimeter gradient. The pet crops transparent margins, preserves the sprite aspect ratio and uses an alpha-adjacent animated contour with backing-scale support. CU owns the contour; companion-only and expanded preview states remain steady.

On Windows, enabling companionship during hidden-desktop CU inherits the existing CU target and pet PID rather than rebuilding a Default-desktop pet and losing its preview target.

Validation: Windows official DSH Desktop 0.2.0-rc.2 installed-candidate full gate 200 passed, zero failures/skips; 23 native shared-pet, 5 preferences, 20 GPU preview and 3 menu checks; real authenticated MCP, scheduled model activation, focused-reader protection and heartBeat restart no-replay. Package runtime matches the accepted source, with Git-normalized text line endings.

[ARM macOS 14/15/26 native/browser matrix](https://github.com/positer/newmark2dsh/actions/runs/38394193819) and [real Mission Control Space matrix](https://github.com/positer/newmark2dsh/actions/runs/38395064819) passed. Each native pipeline covers 52 scenarios plus production renderer 1x/2x offscreen contour checks. This does not establish official macOS DSH container installation, physical input timing, multi-display/fullscreen combinations or minimum Neo hardware performance. This Windows round did not independently repeat physical double-click/right-click on the non-activating pet; owned native methods/renderers were tested. Cross-platform styling is aligned, not claimed physically pixel-identical.
