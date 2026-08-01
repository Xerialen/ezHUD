# FTE-web preview vs real ezQuake — side-by-side evidence

Phase 5 of issue #4, run on minimain 2026-08-01. Everything below was measured,
not assumed; where the two engines disagree it says so.

## Setup

Identical on both sides:

- **Config:** the owner's real `config.cfg` (1575 lines, 543 hud-relevant),
  imported into the FTE editor through the drop pipeline, `exec`'d natively by
  ezQuake.
- **Demo:** `tb4gf_book_vs_s.mvd` (4on4, dm3), `demo_jump 9:00`, frozen with
  `demo_setspeed 0.01` / `cl_demospeed 0.01`. The jump lands on a keyframe, so
  the two engines sit 1–3 seconds apart (game clock 08:53 vs 08:55/56) —
  close enough that the tracked player's values match across the pair that
  shares a POV.
- **Video:** 640×480 window, `vid_conwidth/conheight 640×480` on both, so
  console pixels are physical pixels and positions compare 1:1.
- **Textures:** the owner's `textures.pk3` installed on both sides (Cache API
  → wasm FS in FTE, `qw/textures.pk3` for ezQuake).
- ezQuake is the owner's own static build (`~/quake/ezquake-linux`), run
  against a throwaway basedir — nothing in the real Quake install was touched.

Evidence in `shots/`: `fte-owner-hud.png` (08:56, tracking bps) vs
`ezquake-owner-hud.png` (08:53, tracking bps); `fte-roundtrip.png` /
`ezquake-roundtrip.png` for the round-trip pair.

## Element table

FTE reported 74 registered / 27 placed with this config; rect values are the
engine's own (`EZHud_StateJSON`). "Position/size/texture" are judged from the
frozen screenshot pair. ✓ = matches ezQuake, ✗ = does not, — = not assessable
from these shots.

| element | FTE rect (console px) | position | size | texture | notes |
|---|---|---|---|---|---|
| health | 325,337 60×20 (scale 2.5) | ✓ | ✓ | ✓ | big sbar digits, right of centre; moved element in the round-trip pair, +100 px on both sides |
| armor | left of centre, scale 2.5 | ✓ | ✓ | ✗ | ezQuake colours the number by armour type (yellow for YA); FTE draws it white |
| armordamage | under armor | ✓ | ✓ | ✓ | red damage streak present on both |
| ammo3 (active ammo) | 307,305 32×16 | ✓ | ✓ | ✓ | small "20" above the numbers on both |
| bar_armor | teal bar | ✓ | ✓ | ✓ | same spot right of the numbers |
| bar_health | 394,338 50×20 | ✓ | ✓ | — | present both sides |
| gameclock | top-right, red | ✓ | ✓ | ✓ | 08:56 / 08:53 |
| democlock | right edge (FTE: 22:13) | — | — | — | visible in FTE, not visible in the frozen ezQuake shot; not investigated further |
| frags | centre "17" | ✓ | ✓ | ✓ | |
| face | 337,111 48×48, top-centre | ✗ | ✓ | ✓ | FTE draws it top-centre; ezQuake does not show it there. Position semantics differ for this element |
| teaminfo | 483,308 156×56, right side | ✗ | — | — | FTE draws a persistent right-side panel; ezQuake shows teaminfo lines mid-left and only transiently. Biggest visible layout divergence |
| itemsclock | 1,278 208×8 | n/a | n/a | n/a | FTE's plugin draws the literal text "ITEMSCLOCK NOT IMPLEMENTED" — honest, and exactly the kind of gap the drift report exists for |
| iammo1–4, gun3–8, ammo1–4 | small, various | ✓ | ✓ | — | weapon/ammo strip lands in the same arrangement |
| notify area | top-left | ✓ | — | ✗ | FTE renders console text in its own font; visibly different glyphs |

**Missing elements with this config** (drift report, all named to the user on
import): `centerprint, frametime, gamesummary, netgraph, radar, scoreclock,
static_text, teamstackbar, tracker_image, tracker` — ten, not the eleven
predicted in the issue (`framestats`, `qtv_buffer`, `scoremapname` are absent
from ezQuake's set that this config uses; `radar` is registered upstream but
did not register in this build and **is** in the missing list; `tracker_image`
was not on the issue's list at all). 29 applied cvars are set but never
reported back (`scr_*`/`cl_*`/`vid_*` families — the export still cannot lose
them, because unchanged lines are written back verbatim).

## Round trip: import → edit → export → exec in real ezQuake

1. Owner's config imported into the FTE editor (543 lines applied, 864
   retained verbatim, 0 refused).
2. One deliberate edit: `hud_health_pos_x` 35.34293 → 135.34293 (+100 px).
3. `exportFullCfg()` diffed against the original, line by line:
   **1 difference in 1575 lines** — the edited line. Every untouched line,
   including 480 other applied hud lines with their original column alignment
   and full float precision, survived **byte-identical**.
4. The exported config `exec`'d in real ezQuake over the same frozen demo:
   the health element renders exactly 100 px right of its owner-config
   position (`ezquake-owner-hud.png` vs `ezquake-roundtrip.png`); nothing
   else moved.

Two bugs had to die to get there, both now regression-tested: the C export
printed positions through `%g` and truncated `"200.288666"` to `"200.289"`
(fixed: placement cvars export their string, not their float), and the JS
export rewrote every applied line even when unchanged, churning 481 lines of
formatting (fixed: unchanged values write the user's own line back).

## Verdict: **go, with caveats**

The core promise of the spike holds: a live demo plays behind the real editor
UI, dragging an element writes the same cvars ezQuake reads, the owner's real
config imports losslessly, and the export drops into real ezQuake with
element positions intact. The engine-side surface is ~150 lines of C plus
four small build patches (`fteqw.diff`).

The caveats, in order of user-visible weight:

1. **Font rendering differs** throughout (FTE's own font system) — the layout
   is right, the glyphs are not ezQuake's. Known going in.
2. **teaminfo and face place differently** than ezQuake with the same cvars —
   per-element porting debt in the plugin, worth a ticket each.
3. **Ten elements have no preview** (plus `itemsclock`'s placeholder). The
   drift report names them per config; the export cannot lose them.
4. **Per-element colour semantics drift** in places (armour-type colouring).
5. FTE persists its own cvar state in the browser cache across reloads, which
   can shadow an import (`hud_ammo_order` came back as `9999999827968` from a
   float round-trip on FTE's side once). An import re-applies over it, but a
   "reset to clean engine" control is wanted.
6. `plug_sbar 3` + `scr_newhud 1` + gamedir-relative `playdemo` paths and the
   emscripten export flags are all load-bearing and all documented in
   NOTES.md; none of it is fragile once written down.

None of these block the follow-up build; 2 and 5 are the ones that need
tickets before anyone edits their real HUD in it.
