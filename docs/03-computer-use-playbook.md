# The ComputerUse operating guide (measured)

How to drive this desktop with `computer_use`, and what a caller must know that the
parameter list cannot tell them. The short form of this file is the `computer_use`
tool description itself (`packages/newmark-core/components/computeruse/component.js:335-350`),
because that is what a model reads before it chooses an action. This is the record
behind it: each rule, the receipt field that carries it, the source line that
implements it, and the assertion that holds it.

**Evidence classes, kept apart.** *Measured* means observed on this machine during a
real ComputerUse session; *read* means verified against the source at the cited line
during this write-up. A rule that is only read is labelled read, and one that is only
measured is labelled measured. Nothing here is a convention this workspace invented:
where a rule comes from a defect, the defect is named.

Every rule below is also an assertion in `scripts/verify-computeruse-win32.mjs`
(checks 23-25), and each assertion is falsified by a planted mutation in
`scripts/measure-cu-guide-mutations.mjs` — §3 is that table.

---

## 1. Opening an application

### 1.1 The Windows key does not work, and it fails silently

**Measured.** `key: "win"` returns `ok: true` and `focus_changed: true`, and nothing
happens. `key: "win+r"` behaves the same way. Four delivery variants were tried —
`VK_LWIN` held across a dummy stroke, held across a `VK_CONTROL` stroke, the older
`keybd_event` path, and `VK_RWIN` — and every one of them was **proved to have really
held the key** by reading `GetAsyncKeyState & 0x8000` back. All four left the
foreground window unchanged, produced no window, and moved 1–15 of the 62,832 sampled
pixels in the region the Start menu covers (the clock). The keys were delivered; the
shell ignored them.

The receipt no longer hides that. `windows_key_effect` is written from a measurement
taken after the delivery — `"foreground-or-window-changed"` when the foreground or the
window set really changed, `"not-observed"` when it did not, and `"not-measured"` for a
chord, whose effect this backend may not open on a caller's desktop to check
(`lib/win32.js:3068`; the reasoning is `lib/win32.js:3052-3067`). Before that field
existed, `ok: true` was the whole answer, and it was wrong.

The delivery itself is real: the Windows keys resolve (`lib/win32.js:389-401`), a lone
one is held across a dummy key because Windows swallows an unaccompanied down/up pair
(`lib/win32.js:3023-3112`), and the chords are built from virtual-key codes rather than
handed to `SendKeys`, which cannot express a Windows key at all.

### 1.2 The recipe that works

**Measured end to end**, by launching Edge:

```
1. key   ctrl+esc          -> opens the Start menu
2. type  <application name> -> lands in the Start menu search box
3. key   enter             -> launches
```

The foreground became `edge浏览器 - 搜索 - 个人 - Microsoft Edge Beta`, a **new**
window (pid 27448), and the `type` receipt carried
`focus_target_class: "Windows.UI.Core.CoreWindow"`.

`ctrl+esc` is an ordinary chord and that is why it works. It resolves to
`["ctrl", "esc"]` with `windowsKey: false`, normalises to `^{ESC}`, and is delivered
through .NET `SendKeys` (`lib/win32.js:3004-3021`) — the same mechanism every other
chord uses. It never touches the Windows-key path at all.

### 1.3 `app_activate` binds an existing window; it never launches a process

**Read, and advertised by the module itself.** `appActivateAction` opens by resolving a
target and fails when there is none:

* `appActivateAction` → `resolveApplication` → `failure(action, 'app_target_not_found')`
  (`lib/win32.js:4144-4148`);
* `resolveApplication` accepts an explicit handle first, then a title substring, then a
  class-name substring, and answers `app_target_not_found` when none matches
  (`lib/win32.js:2787-2829`);
* `lib/win32.js` contains **no process-creation call at all** — no `Start-Process`, no
  `ShellExecute`, no `CreateProcess`, no `Win32_Process` create. The only process this
  component starts is the overlay host (`lib/overlay-win32.js:213`, `:652`, `:658`),
  which draws the takeover indicator and is not an application launcher;
* `mode_report` says so in its own advertisement: *"app_activate with app_target or
  window_handle (binds the target; it never activates anything)"* (`lib/win32.js:4520`).

The word "activate" reads like "start". It is not. To open an application: `ctrl+esc`
(§1.2).

---

## 2. The operating habits

### 2.1 Take the lease before the first input, release it in a `finally`

`takeover_start` acquires a lease that is **exclusive to one owner**, and it is the only
action that can set the session's mouse mode (`lib/win32.js:3722-3771`, `:3800-3814`).
`takeover_stop` **refuses without the exact `owner_id`**:

```
failure(action, 'takeover_lease_owned_by_another_owner',
        `The takeover lease belongs to ${existing.owner_id}; ${ownerId} cannot release it.`,
        { takeover: false, lock_owner: existing.owner_id, requested_owner: ownerId })
        // lib/win32.js:3773-3783
```

**Both failures were hit in one session**: a lease leaked by an early return, and a
`takeover_stop` sent without the owner id, refused exactly as above.

What a leaked lease leaves behind is not just state. `takeover_start` calls
`startTakeoverOverlay`, whose product is **one borderless, topmost, click-through
WinForms window whose bounds are the whole virtual screen** (`lib/overlay-win32.js:5`,
`:806-846`), created with `WS_EX_TRANSPARENT |
WS_EX_TOOLWINDOW` and re-asserted topmost with
`SetWindowPos(HWND_TOPMOST, … | SWP_NOACTIVATE)` (`:261`, `:512-513`). Its safety net is
the **owning process dying** — a 1 s watchdog that closes a window whose owner is gone
(`lib/overlay-win32.js:40`, `:833-843`, `lifecycle: 'owner-process-bound'`) — and a
leaked lease inside a live process never triggers it. The module states the risk in its
own words: *"a topmost click-through window outliving its owner would cover the user
screen with no in-app way to remove it"* (`lib/overlay-win32.js:843`).

So: `takeover_start`, then your actions, then `takeover_stop` with the same `owner_id`
in a `finally`.

### 2.2 `ok: true` does not mean it happened

This is the most expensive habit to lack, and it is why the receipt carries measurement
fields at all. `key: "win"` returned `ok: true` **and** `focus_changed: true` while
doing nothing whatsoever (§1.1).

Read the receipt's own fields, and treat them as the evidence:

| Field | What it measures |
|---|---|
| `focus_changed`, `focus_verified`, `focus_target_class` | which window the keystroke would reach, and whether the focus step changed anything (`lib/win32.js:2966-2976`) |
| `windows_key_effect` | whether a Windows-key delivery changed the foreground or the window set (`:3068`) |
| `capture_scope`, `target_scope`, `capture_method` | what a capture actually covers (`:2272-2336`) |
| `foreground_verified`, `foreground_is_target`, `foreground_handle` | what `app_activate` measured after its attempt (`:3125-3138`) |
| `foreground_changed_by_key`, `background_changed_by_key` | the two independent reads behind `windows_key_effect` |
| `text_delivery`, `composed_by_ime`, `clipboard_used` | how text was delivered (`:3000`) |

Where those fields are inconclusive, **verify from outside** — `app_list`, or a fresh
foreground read — rather than trusting the return value of the action.

### 2.3 `observe` captures a window; `screen_capture` with `target: "desktop"` captures the screen

**Measured, and then repaired.** `observe` captures the **foreground window** (or the
window you name), not the desktop: `capture_method: "PrintWindow(hwnd,hdc,2)"`,
`target_scope` = the window handle, `capture_scope: "window"`
(`lib/win32.js:2000`, `:2297-2335`).

The defect: a request for a desktop capture was answered with a window capture and **the
payload did not say so** — it carried a window handle and a `PrintWindow`, and a caller
could not tell what it had been given. The payload is now self-describing
(`lib/win32.js:2321-2335`):

| Request | `capture_scope` | `target_scope` | `capture_method` |
|---|---|---|---|
| `computer_use observe` | `"window"` | the window handle | `PrintWindow(hwnd,hdc,2)` |
| `screen_capture target "desktop"` | `"virtual-screen"` | `"screen"` | `BitBlt(screen-dc,virtual-screen)` |

`screen_capture` reaches the screen through its own internal action `capture_screen`,
which resolves no window at all and carries the virtual screen's own bounds
(`component.js:433`, `lib/win32.js:2240-2251`). Check the field before you believe a
picture covers the screen.

### 2.4 Prefer `window_handle` to `app_target`

**Measured:** `app_observe` with `app_target: "Microsoft Edge"` answered
`app_target_not_found` **immediately after `app_list` had listed that window with
`Microsoft Edge` in its title**.

**Read:** `resolveApplication` tries an explicit handle first, then
`title.toLowerCase().includes(wanted)`, then the class name, and only then fails
(`lib/win32.js:2816-2826`). A title match is a *substring* match against an enumeration
that excludes shell windows, windows under 40 px on either side, and anything invisible
or occluded (`lib/win32.js:1477-1539`). A handle has none of that slack.

Use `window_handle` when you have one — `app_list` gives you one.

### 2.5 `foreground_window_unavailable` usually means the Start menu is open

**Measured:** with the Start menu open, `app_list` returned `applications: []` and
`observe` failed `foreground_window_unavailable`, while the foreground really was the
Start menu (`title 搜索`, `class Windows.UI.Core.CoreWindow`).

**Read:** the error is produced in exactly one place — `resolveApplication`, when no
enumerated window carries `foreground: true` (`lib/win32.js:2806-2810`). The enumeration
skips the shell's own windows by class (`Progman`, `WorkerW`, `Shell_TrayWnd`,
`Shell_SecondaryTrayWnd`, `:1497`), anything 40 px or smaller on a side (`:1504`), and
anything invisible or occluded (`:1514`). So that error means *"the window that holds
the foreground is one this enumeration excludes"* — and the Start menu is the common
case.

Do not conclude that the desktop is empty, and do not conclude that there are no
windows: **confirm from outside** — a foreground-window read through the lane, or a
`screen_capture` — instead of acting on the empty list.

### 2.6 `scroll` requires `x` and `y`

There is no "scroll whatever has focus". A `scroll` with only `scroll_y` answers:

```
if (!target && !Number.isFinite(Number(options.x))) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
if (!target && !Number.isFinite(Number(options.y))) return failure(action, 'point_required', 'x and y are required pixel coordinates or provide target_id.', { ...header });
                                                                    // lib/win32.js:4247-4248
```

The guard sits **before** the scroll script is composed (`:4257`), so a coordinate-less
scroll is refused rather than delivered somewhere unexpected. Give `x`/`y`, or a
`target_id` from a prior observation.

### 2.7 `type` is delivered as unicode key events, so non-ASCII text works

`type` sends the characters themselves through `SendUnicodeText`, one press and release
per UTF-16 code unit, and reports `text_delivery: "unicode-key-events"`,
`composed_by_ime: false`, `clipboard_used: false` (`lib/win32.js:2989-3001`). **Measured:**
typing `历史上的今天发生了什么` reported 11 chars and 11 UTF-16 units. An active IME
cannot compose unicode key events, which is why this path replaced the keystroke path —
the recorded defect put a pinyin-syllable rendering of `new` into a field
(`lib/win32.js:2978-2988`).

### 2.8 The Windows key is absent from the chord surface by design, not by oversight

`virtualKeyCodes` accepts `ctrl`/`alt`/`shift`, and the Windows keys resolve like any
other name. What is refused is *delivery*, and for two different reasons:

* a **lone** Windows key cannot be delivered as an unaccompanied down/up pair, because
  Windows waits to see whether a chord follows; the key is held across a dummy stroke
  instead (`lib/win32.js:3023-3037`);
* a **Windows chord in virtual mode** is refused outright —
  `windows_key_requires_real_delivery` — because a posted `WM_KEYDOWN` reaches one
  window and does not open the Start menu or the Run dialog (`lib/win32.js:3404-3412`).

And in real mode the shell ignores it anyway (§1.1). **Use `ctrl+esc`.**

---

## 3. What asserts each rule, and how each assertion can fail

Checks 23-25 of `scripts/verify-computeruse-win32.mjs` assert the shipped tool
description — read from the component itself, never from a copy of the text — against
behaviour measured in the same run. Which check holds which rule:

| Rule (§) | Held by | What the check measures, in the same run | Asserted in the description |
|---|---|---|---|
| 1.1 silent Windows key | 23 | the lone-Windows-key receipt really writes `windows_key_effect` next to `ok=$true`, with `"not-observed"` for the measured-nothing case | the field is named, with its value |
| 1.2 the recipe | 23 | `ctrl+esc` resolves with `windowsKey: false`, normalises to `^{ESC}`, delivers through `SendKeys`, and never touches the virtual-key path | `ctrl+esc` opens the Start menu; `enter` launches |
| 1.3 `app_activate` | 24 | no process-creation call in `win32.js`; `mode_report` advertises bind-only; a live dispatch with an unmatchable `app_target` refuses | "NEVER launches a process", `app_target_not_found` |
| 2.1 the lease | 25 | the refusal site carries `lock_owner`/`requested_owner`; the overlay contract is topmost, click-through, owner-process-bound | release in a `finally`, exact `owner_id`, the refusal code |
| 2.2 `ok: true` | 24 | each named field is carried by the receipts the source composes | the field list, and "verify from outside" |
| 2.3 capture scope | 25 (window), 21 (screen) | a live `observe` reports `capture_scope: "window"` + `PrintWindow`; a live `capture_screen` reports `"screen"` + `BitBlt` | both scopes and both methods |
| 2.4 `window_handle` | 25 | the resolver matches the handle before the title, and the class name last | prefer `window_handle` over `app_target` |
| 2.5 `foreground_window_unavailable` | 25 | the error has exactly one site, and it is the enumeration reporting no foreground window | the shell windows are not enumerated |
| 2.6 `scroll` | 25 | a live `scroll` with only `scroll_y` answers `point_required`, and the guard precedes the script | requires `x` and `y` |
| 2.7 `type` | 25 | the receipt line carries `text_delivery="unicode-key-events"` | the mechanism is named |
| 2.8 Windows keys | 25 (virtual), 22 (delivery shape) | `previewVirtualKeyScript(…, 'win+r')` returns `windows_key_requires_real_delivery` | the refusal code and its reason |
| this document | 25 | the file exists, carries the rules above, and ends with its boundaries | the description points at it |

Each assertion was then falsified by planting one defect at a time — in the code, in the
description, or in the document — and requiring the named check to go red. **Measured,
12/12 as expected, with every file restored byte-for-byte by sha256:**

| id | the defect planted | expected | observed | checks that went red | restored |
|---|---|---|---|---|---|
| G1 | the description stops naming `ctrl+esc` as the way to open an application | RED | RED | 23 | yes |
| G2 | the receipt field the description names is renamed in the code that writes it | RED | RED | 22, 23, 24 | yes |
| G3 | the description claims `app_activate` starts an application | RED | RED | 24 | yes |
| G4 | an `app_target` that matches nothing stops being `app_target_not_found` | RED | RED | 24 | yes |
| G5 | a process-launch primitive appears in the module that never launches | RED | RED | 24 | yes |
| G6 | the lease refusal stops carrying the code the guide names | RED | RED | 25 | yes |
| G7 | the description stops saying `observe` captures a window | RED | RED | 25 | yes |
| G8 | the virtual-mode Windows-key refusal stops returning its named code | RED | RED | 22, 25 | yes |
| G9 | CONTROL — a bullet reworded without changing any fact | GREEN | GREEN | — | yes |
| G10 | CONTROL — a comment-only edit beside the receipt | GREEN | GREEN | — | yes |
| G11 | the record the description points at is gone | RED | RED | 25 | yes |
| G12 | the record stops carrying the rule it is the record for | RED | RED | 25 | yes |

Two entries are controls, and they matter more than the red rows: G9 rewords a bullet
without changing a fact and G10 edits a comment. Both must stay green, and do — an
assertion that went red there would be measuring the edit rather than the property.
The measured table as data, including each mutation's gate summary and the sha256
before and after: `evidence/computeruse-guide/mutations/mutation-table.json`; the full
transcript is `evidence/computeruse-guide/mutation-harness.log`.

---

## 4. Boundaries — what this guide does not claim

* **The Windows-key measurement is not re-run by any gate.** Delivering a lone Windows
  key opens the Start menu on the machine the user is sitting at, so the gate asserts
  the *receipt field and the delivery shape* (`windows_key_effect` and the conditional
  that writes it) and never presses the key. The pixel-block measurement above is a
  session observation, recorded as such; it is not reproducible unattended.
* **`ctrl+esc` itself is asserted structurally, not by launching an application.** The
  gate proves the chord composes to `SendKeys '^{ESC}'` and that no Windows key is
  involved. It does not open the Start menu, because that would take the foreground
  from the user.
* **Why `app_target: "Microsoft Edge"` missed a window that `app_list` had just listed
  is not reproduced** (§2.4). What is asserted is the resolution order and the
  enumeration's exclusions, both read; the specific miss is a session observation.
* **The Start-menu enumeration result** (`applications: []` with the Start menu open) is
  a session observation. The gate asserts the single site that can produce
  `foreground_window_unavailable` and the enumeration's exclusion rules; it cannot
  reproduce the Start-menu state without opening it.
* **The leaked-lease incident is not reproduced.** What is asserted is the refusal site
  and the overlay's own contract (`topmost`, `WS_EX_TRANSPARENT`,
  `lifecycle: 'owner-process-bound'`); the incident itself was a live session.
* **Virtual mode itself is asserted from the source and from `mode_report`** — checks 12
  and 19 of the same gate — rather than by delivering a posted message to a window the
  user owns. §2.8 quotes the refusal code measured there. §5 records the one virtual path
  that *is* measured end to end, and why it is safe to measure.
* **No screenshot in this document.** Everything above is a field name, a source line or
  a numeric measurement; no observation frame was stored, per `00-governance.md` C-3.1.

---

## 5. Working on a hidden desktop (measured end to end)

The lane can be pointed at a desktop of its own instead of this one. That is a second
endpoint, not a second implementation: a resident agent (`lib/hidden-agent.js`) lives on
a hidden desktop and posts its own messages there, and the lane relays the ordinary
app-scoped actions to it over a named pipe. The lane opens no desktop and makes no
cross-desktop call — three phases tried that and all three came back negative.

**Arming it.** `takeover_start` with `mouse_mode: "virtual"` **and** `desktop: "hidden"`.
The second parameter is required on purpose: virtual mode without it is exactly what it
was before, posted window messages to a window on this desktop, so nothing silently takes
a path away from a caller. `launch: "<command line>"` on the same call starts a program
on that desktop. `desktop` is read in one place (`lib/win32.js`, `takeoverStart`), and an
unknown value is refused (`desktop_unsupported`) rather than ignored.

**What routes.** `app_list`, `app_observe`, `app_activate`, `app_click`, `app_type`,
`app_scroll`, `app_key`, and therefore both capture paths behind `screen_capture with
target: "application"` and `computer_use.app_observe`. `app_drag` is refused by name
(`hidden_agent_action_unsupported`: the agent has no drag primitive), a horizontal-only
`app_scroll` is refused (`hidden_agent_horizontal_wheel_unsupported`: the agent posts
`WM_MOUSEWHEEL` and nothing else), and `app_key` accepts one key and refuses a chord
(`hidden_agent_single_key_only`: one posted down/up pair cannot hold a modifier). The
desktop-scoped actions — `observe`, `capture_screen`, `move`, `click`, `drag`, `sweep`,
`scroll`, `type`, `key`, `sequence` — are not routed: they keep exactly the behaviour
virtual mode already had for them, which is the existing refusal where there is one.

**`sweep` is refused on a hidden desktop by name** (`sweep_unsupported_on_hidden_desktop`),
and that is a measurement, not a policy. The system keeps no pointer on a hidden desktop and
emits no relative-motion stream there. Measured 2026-10-18: a probe registered for raw
packets on that desktop (and self-publishing 15 → 38 times across the gesture) received **0**
packets and sums of (0,0) from a `dx=300`, 16-step injection whose every call returned
success, while this desktop's pointer and foreground were unchanged. The agent's own `sweep`
primitive is kept in the payload as the instrument of that negative result; nothing on the
tool surface can reach it. §7 has the real-mode feature itself.

**What a receipt says.** Every routed answer carries `delivery:
"hidden-desktop-agent"`, `target_desktop` (the desktop's name), `routed_to.agent_pid`,
`routed_to.cross_desktop_reach_used: false`, `physical_delivery_used: false`,
`system_cursor_moved: false` and `fallback_to_real_delivery: false`. `queued` is `true`
only where the agent's own post call answered, and `action_completed` stays `false` — a
posted message is not a completed action.

**Ending it.** `takeover_stop` asks the agent for its last state, sends `exit`, waits for
the agent and every hosted pid to be gone, and then asks whether the desktop is still
openable. A desktop is held by any handle **or** any process assigned to it, so that
question is the only one that separates "the processes are gone" from "the desktop is
gone". The job object is what makes the first half true: the agent assigns itself to a
job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so every process it launches dies with it.

**Where the measurement is.** `scripts/measure-cu-hidden-route.mjs` runs the sequence
above through the real `computer_use` tool and takes its evidence from the probe
application's own state: a click counter, a wheel counter, a key counter and its own edit
field, published to a file *and* to its own window title. It also asserts that the
interactive desktop is untouched (the probe's handle never appears in this desktop's
window list; foreground and pointer unchanged), plants the removal of the routing to show
the sequence then fails (`app_target_not_found`, counters 0 → 0), restores the file byte
for byte, and re-runs it green. Receipts live under `evidence/cu-hidden-route/<stamp>/`.

**What is not verified.** The routed path is measured in one continuous session per
phase; it is not exercised concurrently with a real mode lease, and no gate runs it
unattended — it needs a desktop, a spawned agent and a real application. The application
used is a probe built by the measurement itself, so the evidence is about a WinForms
window and not about a browser's renderer child. A program that draws nothing until it is
activated will not be observed to change, which is a property of the application and not
of the route.

## 6. Two gaps a browser on a hidden desktop exposed

Measured on 2026-10-02 by driving Edge through the route end to end (declared 历史上的今天
and read the result back from a capture). Both are capability limits rather than defects,
and both cost a caller time when they are not known in advance.

**`launch` needs an absolute path, and the refusal does not say so.** Measured:

```
launch: "msedge.exe --no-first-run --new-window about:blank"
  → ok:false, error_code "hidden_desktop_launch_failed",
    error "CreateProcessW refused the launch"
launch: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  → ok:true, launched[0].held true, ownership "inherited"
```

`notepad.exe` succeeds only because it sits in `System32` and therefore resolves on `PATH`.
**A failed launch does not reap what it already created**: the desktop and the resident agent
are already up when the launch is refused, and because no lease was taken (`takeover:false`)
there is nothing to release them — the pids have to be terminated by hand, then the desktop
follows the last process off it. Prefer an absolute path, and when a launch is refused, look
for the agent's pid in the same receipt before moving on.

**`app_key` accepts one key and refuses chords**, so there is no `ctrl+l` and no `ctrl+esc`
on a hidden desktop. For a browser that means focusing the address bar by clicking it:

```
app_click  window_handle=<the browser window>  x=400  y=60   (client-relative)
app_type   window_handle=<the same>            text="<the query>"
app_key    window_handle=<the same>            key="enter"
```

The click posts `down`/`moved`/`up` to the target thread's queue; `point_source` reports
`offset from the client origin`, and the window's own coordinate space is the one
`app_list` reports for it. `app_type` posts one `WM_CHAR` per character and reports
`posted == characters`; on a Chromium window `used_edit_child` is `false`, because there is
no Win32 `EDIT` child to find, and the text still lands.

**A page that has not finished loading is not a frozen page.** Two consecutive captures of a
Chromium window came back byte-identical, which reads as a stalled renderer on a desktop with
no composition. It was not: the capture after a scroll differed, and the content had simply
been below the fold. **Compare a capture's sha256 after an action before concluding a hidden
desktop has stopped updating** — and scroll before deciding a page is empty.

---

## 7. Relative motion: `sweep` (2026-10-18)

A caller that needs *continuous* pointer motion — steering a view, orbiting a camera — had
only `drag`, and `drag` cannot express it: its only positioning call is `SetCursorPos`, and
the probe measured what that means (below). `sweep` is the missing primitive, and its
arguments are the question it answers: **`direction`, `speed`, `duration_ms`**, plus
`button` (held for the whole gesture), `inject_steps` and `restore_cursor`.

The A/B, measured on one probe window that registers raw input and counts `WM_INPUT` in its
own window procedure:

| Call | Pointer | Raw packets | Raw delta sum |
|---|---|---|---|
| `drag` start → end (the old way) | **moved** | **0** | (0,0) |
| `SetCursorPos` twice, directly | **moved** | **0** | (0,0) |
| `mouse_event(MOUSEEVENTF_MOVE, 120, -60)` | moved | 1 | **(120, −60)** |
| `sweep` direction 0, speed 1200, duration_ms 250 | moved, then restored | 16 | **(300, 0)** |

That table is the whole defect and the whole fix: **moving the cursor is not delivering
motion.** A raw-motion consumer sees nothing from an absolute move, which is why an absolute
drag can never steer a view however far it travels, and it sees exactly the injected delta
from a relative one.

Two habits follow, both measured on this station:

* **Assert on the injected delta, never on cursor travel.** `dx`/`dy` are the raw delta; the
  cursor travels `gain × delta` because pointer acceleration applies (`MouseSpeed=1` here,
  measured gain 3.08 on a 300 px sweep). The receipt carries both (`dx` and
  `cursor_displacement`), and the one that answers "did the motion go out" is `dx`.
* **Do not hold a steering gesture to a screen.** A `sweep` is a delta plus a duration; it has
  no end point, so a turn longer than the screen is `speed` × `duration_ms`, and repeating it
  is how a view keeps turning. `restore_cursor` puts the pointer back each time (through the
  absolute call, which adds no raw motion), so repeated sweeps do not walk the pointer away.

**A refusal that names the platform.** `sweep` is Windows-only in this round: the Linux
backend does not advertise it (`unknown_action` with its own action list), macOS has no
physical relative injection, and a hidden desktop refuses it by name (§5).

**What this does not claim.** No game was driven: the probe is the raw-motion consumer here.
A game that filters synthetic input, or that runs at a higher integrity level, is out of
scope. The button-held path was measured on this desktop's own probe; its exception-path
release is covered by the script's `finally` and the lane-level release guard, not by a
separately injected failure.

