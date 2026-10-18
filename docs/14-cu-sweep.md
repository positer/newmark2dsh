# 14 · `sweep`: relative mouse motion (direction · speed · duration)

Status: contract fixed 2026-10-18 by the user's own words — *"新增cu/虚拟桌面cu鼠标行为，
向指定方向什么速度移动多久"*. Implemented on Windows; see §7 for the boundary.

## 1. The defect this replaces

A caller that needs *continuous* mouse motion — steering a game's view, orbiting a 3D
camera, turning a character — had only `drag`, and `drag` cannot express it.

* **Real mode.** `drag` walks the pointer from `start_x/start_y` to `end_x/end_y` with
  `NewmarkCuNative.MoveCursorSmooth` (`lib/win32.js` native template), whose only
  positioning call is `SetCursorPos`. `SetCursorPos` changes the cursor position and
  generates **no raw-input (`WM_INPUT`) packets**; a game that steers from relative
  deltas therefore receives nothing at all. The travel is also bounded by the screen, so
  a gesture cannot accumulate more than one screen of turn, and the gesture always ends
  by *releasing*, which is the opposite of what a hold-to-steer control needs.
* **Virtual / hidden desktop.** `app_drag` is refused outright
  (`hidden_agent_action_unsupported`): the resident agent posts clicks, keys,
  characters and one wheel message and has no drag primitive at all.
* **And the absolute drag could not even be called in the documented shape.** The x/y
  point guard in `desktopPhysicalAction` ran before the drag branch, so
  `{action:'drag', start_x, start_y, end_x, end_y}` answered `point_required` unless a
  dummy `x`/`y` was passed as well — measured 2026-10-18 by this feature's own gate,
  which could not run the absolute-drag control at all. Fixed in the same round: `drag`
  is exempt from the point guard and keeps its own `drag_points_required`. The gate's
  A/B is now the whole argument in one run: **`drag` moves the pointer and delivers 0 raw
  packets; `sweep` delivers exactly `dx`,`dy` as raw packets.**

## 2. The action

`sweep` is a **desktop** mouse behaviour (like `move`/`click`/`drag`), not an
`app_*` one, because the motion is relative and needs no window-scoped coordinates.
Its three core arguments are exactly the user's three questions.

| Argument | Type | Range / default | Meaning |
|---|---|---|---|
| `direction` | number (degrees) or name | required | Where to move. Degrees are **screen** degrees, clockwise from the +x axis with y growing downward: `0` = right, `90` = down, `180` = left, `270` = up. Names: `right`, `down-right`, `down`, `down-left`, `left`, `up-left`, `up`, `up-right` (aliases `east`, `southeast`, `south`, `southwest`, `west`, `northwest`, `north`, `northeast`). |
| `speed` | number | `1..8000` px/s | How fast, in **pixels per second along that direction**. |
| `duration_ms` | number | `1..15000` ms | How long the motion lasts. |
| `button` | `"none"` \| `"left"` \| `"right"` | default `"none"` | Held **for the whole sweep** and released in a `finally`. This is the "hold to steer" control. |
| `inject_steps` | integer | `1..240`, default `clamp(round(duration_ms / 16), 1, 240)` | How many injected move records the motion is split into. Named `inject_steps` because `steps` is already the `sequence` argument — one parameter name must not mean two things on one tool. |
| `window_handle` / `app_target` | — | optional | Real mode only: pins the window that must still hold the foreground before the first move. |
| `restore_cursor` | boolean | default `true` | Put the pointer back where the sweep started. |

**The arithmetic is the contract.** Total displacement is

```
dx = round(cos(theta) * speed * duration_ms / 1000)
dy = round(sin(theta) * speed * duration_ms / 1000)
```

and the injected steps must sum **exactly** to `(dx, dy)`: the last step carries the
remainder. A receipt that reports a different sum than the caller asked for is a defect.

## 3. Delivery

* Each step is one `mouse_event(MOUSEEVENTF_MOVE, stepDx, stepDy, 0, 0)` — a **relative**
  injection. This is the path raw-input consumers see, and it is the whole reason the
  action exists; `SetCursorPos` is used only to restore the pointer afterwards, where the
  absence of raw input is the desired property.
* Steps are spread over `duration_ms` against a monotonic start time, so the motion is
  continuous rather than one jump.
* The button (when named) is pressed before the first step and released in a `finally`
  on success, refusal, injection failure and cancellation, and `button_held_ms` is the
  measured hold.
* After the release the pointer is restored with `SetCursorPos` and the receipt carries
  `cursor_before` / `cursor_after` so "restored" is a measurement, not a promise.

## 4. Refusals (named codes, never silent)

| Code | When |
|---|---|
| `sweep_direction_required` | `direction` missing or empty |
| `sweep_direction_unsupported` | a number outside `0..360` after normalisation, or a name that is not in the table |
| `sweep_speed_out_of_range` | `speed` not finite or outside `1..8000` |
| `sweep_duration_out_of_range` | `duration_ms` not finite or outside `1..15000` |
| `sweep_steps_out_of_range` | `inject_steps` outside `1..240` |
| `sweep_button_unsupported` | `button` is not `none`/`left`/`right` |
| `sweep_below_one_pixel` | the plan rounds to `(0,0)` — a 1 px/s sweep lasting 1 ms would inject nothing, and reporting it as delivered would be a lie |
| `sweep_requires_physical_delivery` | virtual mode **without** a hidden desktop: a posted window message cannot produce relative motion, so it is refused rather than delivered as a no-op |
| `foreground_not_granted` | the real-mode foreground guard: the named window no longer holds the foreground |
| `cursor_read_failed` | the pointer position could not be read, so the gesture is refused rather than leaving the pointer somewhere unknown |

**There is no `sweep_injection_refused` code, and that is deliberate.** `mouse_event` returns
`void`: the system does not say whether it consumed the motion, so this action cannot tell an
injection the system refused from a game that holds a pointer lock and reports its own deltas.
What it reports instead are two measurements that do not lie: `injected_steps` (how many move
records were sent) and `cursor_displacement` (how far the pointer actually travelled). A
zero displacement beside a non-zero injection is exactly what both of those cases look like,
and the receipt says the measurement rather than inventing a verdict. The gate's probe is
what distinguishes them, because it reads the raw-motion accounting from the other side.

## 5. Receipt

```
ok, action:"sweep", mouse_mode, delivery, mouse_motion:"relative-injection",
direction_deg, direction_name, direction_source, speed_px_per_s,
duration_ms (requested), elapsed_ms (measured), steps, injected_steps,
dx, dy, button, button_held_ms,
cursor_before:{x,y}, cursor_displacement:{x,y}, cursor_after:{x,y},
cursor_restore_requested, cursor_restored,
raw_motion_delivery:"relative-mouse-event", sweep_release_guard:true
```

`raw_motion_delivery` names the mechanism (the field is not called `raw_input_delivery`:
the letters of that older spelling are forbidden in this module by the on-device-model
anti-coupling rule, and the gate enforces it). Whether a *particular* game consumed the
motion is not something the action can measure, and the action does not claim it.

**Measured, 2026-10-18, this machine.** A `sweep` of `direction 0`, `speed 1200`,
`duration_ms 250` reported `dx 300`, `injected_steps 16`, `elapsed_ms 273`, and a measured
`cursor_displacement` of `(923, 0)` before the restore returned the pointer to `(176, 945)`.
Both numbers are true and they answer different questions: `dx` is the **raw delta** a
raw-motion consumer reads, while the on-screen cursor travelled further because Windows
pointer acceleration applies to injected relative motion. A caller steering a raw-motion
consumer therefore gets exactly the arithmetic in §2; a caller steering something that reads
the cursor position gets a distance scaled by the user's pointer speed setting, and the
receipt's `cursor_displacement` is where that shows up.

## 6. Hidden ("virtual") desktop CU — refused, and the measurement that decided it

**`sweep` is refused on a hidden desktop: `sweep_unsupported_on_hidden_desktop`.**
The first implementation routed it to the resident agent, whose own C# primitive injected
relative motion there and reported success for every step. The probe that lives on that
desktop settled what "success" meant:

| Measurement (2026-10-18, this station) | Value |
|---|---|
| hidden-desktop probe registered for raw input | `registered=1` |
| probe alive across the gesture (it self-publishes each second) | publishes **15 → 38** |
| raw packets received by that probe from a `dx=300`, 16-step injected sweep | **0**, `sum_dx=0, sum_dy=0` |
| the agent's own answer for the same gesture | `injected=16`, every call returned normally |
| this desktop's pointer / foreground before → after | `(245,1217)` / `0x1e60b18` → unchanged |
| hidden desktop's `GetCursorPos` / `SetCursorPos` / `SetForegroundWindow` | unreadable / `false` / refused (`foreground=0x0`) |

The reason is structural, not a bug in the agent: **a hidden desktop is never the input
desktop**, so the system keeps no pointer there to move and emits no raw-motion stream.
The only input a hidden desktop accepts is a posted window message, and a raw-motion
consumer ignores those — which is exactly why the existing `app_*` route posts messages.

So the route now refuses **before injecting anything**, with the measured counters and a
pointer to the real-mode path. `mode_report` advertises it as `not_routed` and names the
code under `hidden_desktop.refused_by_name`; the gate asserts both the refusal and the
zero-packet measurement behind it. Keeping the agent's own `sweep` op (it is compiled and
dialect-gated) preserves the instrument that proved the negative and would re-measure it on
another Windows build; nothing on the model-facing surface can reach it.

## 7. Boundary

* **Windows only in this round, and the other platforms say so by not answering.** The
  action is declared in `component.js` (one shared surface) and implemented in
  `lib/win32.js` only. The Linux backend does not advertise `sweep`, so there the dispatch
  answers `unknown_action` with its own supported-action list; the macOS backend has no
  physical relative injection and no drag at all. Neither was exercised in this round, and
  neither is claimed: an unimplemented route is refused rather than half-delivered.
* Whether a hidden desktop accepts injected motion is **measured, and the answer is no**:
  `scripts/verify-cu-sweep.mjs` runs a probe window that registers raw input and counts
  `WM_INPUT` deltas, on this desktop and on the hidden one. The hidden count was 0 while
  the probe was demonstrably live, which is what turned the route into a named refusal.
* No anti-cheat, no game-specific claim: the gate measures a WinForms probe's raw-input
  accounting. A game that ignores injected input, or that runs at a higher integrity
  level than the agent, is out of scope and will answer nothing.
