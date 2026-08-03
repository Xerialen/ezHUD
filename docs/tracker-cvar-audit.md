# Tracker cvar audit (#tracker-cvar-wiring)

Owner ask: every tracker-related cvar must be changeable in the editor, take
effect live in the engine preview, and land in the exported config.

Verified against the FTE-web preview (fork `~/dev/fteqw-ezhud` @ 9d8aa3815 +
this branch's `HUD_ResetLayout_f` port) using a real `chromium` + real wasm
build, driving `FTEC.cbufadd` directly and reading `EZHud_StateJSON()` back —
not just reading the source. Script used: a throwaway Playwright probe (not
checked in), reproduced against `~/dev/dist` on pinnacle.

| Setting | Storage | Editor write path | Live in preview? | In export? |
|---|---|---|---|---|
| `r_tracker` | engine cvar (plugin-registered, `vx_tracker.c`) | killfeed "Where kills appear" segmented control → `set r_tracker <0/1>` | yes | yes (ledger, full export only) |
| `con_fragmessages` | engine cvar (plugin) | same control → `set con_fragmessages <0/1>` | yes | yes (ledger) |
| `cl_useimagesinfraglog` | engine cvar (plugin) | killfeed "Style" control | yes | yes (ledger) |
| `r_tracker_frags` | engine cvar (plugin) | killfeed "Show frags" toggle | yes | yes (ledger) |
| `r_tracker_streaks` | engine cvar (plugin) | killfeed "Show streaks" toggle | yes | yes (ledger) |
| `r_tracker_flags` | engine cvar (plugin) | killfeed "Show flag events" toggle | yes | yes (ledger) |
| `r_tracker_pickups` | engine cvar (plugin) | killfeed "Show pickups" toggle | yes | yes (ledger) |
| `r_tracker_align_right` | engine cvar (plugin, global) | killfeed "Align right" toggle | yes | yes (ledger) |
| `r_tracker_time` | engine cvar (plugin) | killfeed "Seconds on screen" field | yes | yes (ledger) |
| `r_tracker_messages` | engine cvar (plugin) | killfeed "Max lines" field | yes (clamped, #15 P2 FIX4) | yes (ledger) |
| `r_tracker_scale` | engine cvar (plugin, global) | killfeed "Scale" field | yes | yes (ledger) |
| `r_tracker_inconsole` | engine cvar — **not registered by the plugin at all** (`vx_tracker.c` never calls `GetNVFDG` for it) | none — not surfaced in the inspector or killfeed panel | n/a (nothing to preview) | ledger-only, never actually applies to the engine | 
| `hud_tracker_scale` | plugin per-element param cvar (`HUD_Register` params) | element inspector "scale" field | yes | yes (`cvarSnapshot()`) |
| `hud_tracker_align_right` | plugin per-element param cvar | element inspector "align_right" field | yes | yes |
| `hud_tracker_frame` / `hud_tracker_frame_color` / `hud_tracker_item_opacity` | plugin per-element cvars (common to all elements, `HUD_Register`) | element inspector | yes | yes |
| `hud_tracker_place` | plugin per-element cvar (`hud->place`) | inspector "Placement" group / drag-to-group | yes (`place`/`set` both work) | yes |
| `hud_tracker_align_x` / `hud_tracker_align_y` | plugin per-element cvar | inspector alignment pickers | yes | yes |
| `hud_tracker_pos_x` / `hud_tracker_pos_y` | plugin per-element cvar (`hud->pos_x`/`pos_y`) | drag, numeric inspector fields, `move tracker <x> <y>` | **yes — confirmed live, see root cause below** | yes |
| `hud_tracker_show` | plugin per-element cvar (`hud->show`) | inspector visibility toggle | yes | yes |
| "Reset positions…" (dialog → `hud_reset_layout`) | bare engine command | Inspector footer button | **was broken on FTE-web: `Unknown command`** — fixed by this branch | n/a (a command, not a cvar) |

## Root cause of the reported position-write asymmetry

Reproduced with a direct probe against the built FTE-web engine (pin
9d8aa3815, before this branch's fix):

```
BEFORE tracker pos: 0 0.2 place top     rect {x:533,y:0,w:320,h:64}
set hud_tracker_pos_x 100            -> pos_x 100   rect {x:633,...}   (worked)
move tracker 150 60                  -> pos 150,60  rect {x:683,y:60}  (worked)
hud_tracker_pos_x 175 (bare)         -> pos_x 175    rect {x:708,...}  (worked)
place tracker screen; align tracker left top; move tracker 60 200
                                      -> place screen, align left/top, pos 60,200 (worked)
```

**`hud_tracker_pos_x`/`pos_y` writes were never actually broken.** They are
real, plugin-registered cvars (`HUD_CreateVar` in `plugins/ezhud/hud.c`,
`hud_%s_%s` = `hud_tracker_pos_x`), read directly off `hud->pos_x->value`
every frame in `SCR_HUD_DrawTracker`/`HUD_DrawElement`, with no recalculate
needed. `set`, a bare `move`, and a bare `<cvar> <value>` line all reach the
same cvar and all take effect within a frame. `place`/`align`/`move` as a
three-line sequence also works — `place` accepts `"top"` because it's one of
the engine's own `snap_strings` (screen/top/view/sbar/ibar/hbar/sfree/ifree/
hfree), not only a group name, which is what the live test that reportedly
failed most likely mis-assumed.

The one write path that **was** genuinely and reproducibly broken is
`hud_reset_layout`: `plugins/ezhud/hud.c` never implemented it. It only
exists in the real ezQuake C client (`engine/engine-integration.diff`,
`HUD_ResetLayout_f`, added for this project). The FTE fork's plugin only
registered `show`, `hide`, `move`, `place`, `reset` (single-element, centers
it — a different command), `order`, `togglehud`, `align`, `hud_recalculate`
and `hud_export`. The editor's "Reset positions…" button
(`hud_web_ui/view/app.js` → `bridge.send('hud_reset_layout')`) has always
sent a command the FTE plugin didn't know, so it printed `Unknown command`
to the console and did nothing — which is exactly item 3 in the mission
brief ("stuck at x=-374" after a drag off-screen).

This matches the P3 FIX1 bug class in spirit ("write looks accepted but
binds to the wrong storage") but the actual mechanism here is simpler:
the command was accepted as *unrecognized input*, not shadowed by a second
cvar — FTE's console just logs the miss and moves on, which reads as "did
nothing" from the UI with no visible error.

A secondary, previously-invisible bug: even after wiring the command, the
editor's Reset dialog counted "how many values would change" from
`element.defaults`, a field only the ezQuake bridge's `/state` populates.
`EZHud_StateJSON()` (FTE plugin) never emits per-element defaults, so the
dialog always computed 0 changes and permanently disabled the Reset button
on the FTE-web backend — a second, independent way "Reset positions" could
never do anything on this preview, regardless of the command being fixed.

## Fixes in this branch

1. **`~/dev/fteqw-ezhud` (fork, branch `ezhud-base`), `plugins/ezhud/hud.c`**:
   ported `HUD_ResetLayout_f` from `engine/engine-integration.diff` (the real
   ezQuake patch) and registered it as `hud_reset_layout`. Restores
   `show`/`place`/`align_x`/`align_y`/`pos_x`/`pos_y` to each element's
   `cvar_t.defaultstr` and calls `HUD_Recalculate()`. Verified live: resets
   `tracker` from a dragged `place screen / align left top / pos 60,200` back
   to its registered `place top / align right,top / pos 0,0.2`.
2. **`hud_web_ui/core/model.js`**: added `resetDefaultsKnown` — true iff any
   element reports `.defaults` (only the ezQuake bridge does). Lets the view
   tell "nothing to reset" apart from "this backend can't say".
3. **`hud_web_ui/view/app.js`**: the Reset dialog's Reset button is now
   disabled only when defaults are known AND confirm zero changes; on the
   FTE-web backend (defaults unknown) it stays enabled and clicking it still
   sends the idempotent `hud_reset_layout` — no more permanently-disabled
   button on the one backend that most needed the fix.
4. **`tools/tests/tier3_fte.mjs`**: taught the fake engine's `cbufadd` to
   honor `hud_reset_layout` the same way the real plugin now does (restore
   from a snapshot taken at fixture setup), and added case 9: drag `health`
   away, click Reset, assert `hud_reset_layout` was sent and the element's
   `pos_x`/`pos_y` came back to their registered fixture values.

## Not changed / not needed

- `hud_tracker_pos_x`/`pos_y`/`place`/`align_x`/`align_y` write paths: already
  correct end-to-end (drag, numeric inspector fields and raw console writes
  all go through the same `bridge.setCvar` → `wireLine` → `set <cvar> <value>`
  path already verified live above). No engine or adapter change needed.
- `r_tracker_inconsole`: registered nowhere in the plugin and not exposed in
  the editor UI. It is carried in the FTE adapter's `LEDGER_SEED`/
  `KILLFEED_CVARS` purely as an export-time passthrough placeholder; since
  the plugin doesn't read it, writing it has no engine effect on either
  backend and the mission's inventory doesn't ask for a UI control for it.
  Flagged here rather than silently left out of the table.

## Test results (pinnacle, this branch)

- `tools/tests/tier1.sh`: pass (57/57 node tests + dist checks; asset embed
  regenerated via `engine/tools/embed_hud_web_ui.py` after touching
  `core/model.js`/`view/app.js`).
- `tools/tests/tier2.sh`: bridge unit tests pass (7/7); `tier2_engine.sh`
  reports its expected "no built ezQuake binary" skip — this rig has no real
  ezQuake C client, only the FTE fork, matching the environment note in the
  mission brief.
- `tools/tests/tier3.mjs` (ezQuake-bridge fake-engine suite): pass.
- `tools/tests/tier3_fte.mjs` (FTE fake-engine suite): pass, 10/10 cases
  including the new reset-layout case.
- Live verification against the real wasm build (pinnacle `~/dev/dist`,
  rebuilt with the `hud_reset_layout` port): `hud_reset_layout` now restores
  `tracker`'s `place`/`align_x`/`align_y`/`pos_x`/`pos_y` to their registered
  defaults; direct `set`/`move`/`place`/`align` writes to tracker position
  were already working and remain so.
- tier3F/tier4/tier4F (real-browser tiers over the assembled public dist):
  not run here per the mission's note that CI handles those; the reviewer's
  lane.
