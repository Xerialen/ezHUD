# Spec: killfeed/tracker support (#11) + HUD-system switch on the FTE page (#12)

Owner intent: the killfeed must be editable as a first-class thing (where kills
appear, which style, the `tracker` element itself), and the classic/new HUD
choice (`scr_newhud 0/1/2`) must be visible and usable **on the public FTE page**,
not only on the ezQuake-bridge dev page. Honesty rules the FTE preview: what the
plugin cannot draw is *said*, never faked.

Verified cvar semantics (ezquake-source master 2026-06):
- Element `tracker` (`hud_common.c`): `hud_tracker_*` — already flows generically.
- Killfeed placement: `r_tracker` (dedicated feed on/off), `con_fragmessages`
  (frag messages among normal console/notify messages), `r_tracker_inconsole`.
- Style: `cl_useimagesinfraglog` 0 = classic text obituaries, 1 = weapon-image feed.
- Content/format: `r_tracker_{frags,flags,streaks,pickups,time,messages,scale,align_right}`
  (+ colours/strings — NOT in scope for dedicated UI; they remain generic cvars).
- HUD system: `scr_newhud` 0 classic / 1 new / 2 both; `cl_sbar`, `viewsize` couple.

## A. ezQuake bridge (engine side, C)

1. `engine/src/hud_web_state.c`: emit a `killfeed` block alongside `hud_modes`:
   `{r_tracker, con_fragmessages, cl_useimagesinfraglog, r_tracker_inconsole,
   r_tracker_time, r_tracker_messages, r_tracker_frags, r_tracker_streaks,
   r_tracker_flags, r_tracker_pickups, r_tracker_scale, r_tracker_align_right}`.
   Look each cvar up defensively (`Cvar_Find`); if `r_tracker` itself is absent,
   omit the whole block — the UI treats absence as "engine doesn't expose it".
2. `engine/src/hud_web.c` write-allowlist (:746-766): add prefix `r_tracker` and
   exact names `con_fragmessages`, `cl_useimagesinfraglog`. The existing
   must-be-a-real-cvar guard (:769) stays and covers typos.
3. `tools/tests/tier2_engine_contract.py`: positive cases (set `r_tracker 0/1`,
   `con_fragmessages 0`, `cl_useimagesinfraglog 1` accepted and visible in state)
   and negative (`r_trackerfoo` non-cvar refused; allowlist still refuses `r_speeds`).

## B. Model (`hud_web_ui/core/model.js`)

- `get killfeed()` → `state.killfeed ?? null`.
- `get killfeedSummary()` — one sentence, same spirit as `modeSummary`:
  e.g. "Kills go to the dedicated tracker, icon style, and also to the console." /
  "Kills appear only among console messages (classic obituaries)."
  Derive from `r_tracker`, `con_fragmessages`, `cl_useimagesinfraglog`.
- Unit tests in `core/tests/model.test.js` (extend the inline state, mirror the
  ':118 hud modes' test): block present, block absent, summary wording for the
  3 canonical combos (separate+icons, integrated-only+classic text, both).

## C. Inspector UI (`hud_web_ui/view/app.js` + both HTML pages)

New section `renderKillfeed()` following `renderModes()`'s exact shape, in a new
container `<div id="killfeed">` placed directly after `#hudmodes` in **both**
`index.html` and `index-fte.html`. Renders nothing when `model.killfeed` is null.

Controls (plain language first, cvar in the tooltip):
1. "Where kills appear" — seg control:
   - Dedicated killfeed → `r_tracker 1`, `con_fragmessages 0`
   - Console messages   → `r_tracker 0`, `con_fragmessages 1`
   - Both               → `r_tracker 1`, `con_fragmessages 1`
   (state→segment mapping is exactly those two cvars; use `applyAll` for the pair)
2. "Style" — seg control: Classic text (`cl_useimagesinfraglog 0`) /
   Weapon icons (`cl_useimagesinfraglog 1`).
3. Small fields (reuse `field()`): show frags / streaks / flags / pickups
   (checkbox each), "seconds on screen" (`r_tracker_time`), "max lines"
   (`r_tracker_messages`), scale (`r_tracker_scale`), align right toggle.
4. Summary line = `model.killfeedSummary` (`.font-state`, like modeSummary).

Extract the duplicated segmented-button pattern into a shared `seg(options,
current, onPick)` helper and use it from `renderModes()`, `directionGroup()` and
`renderKillfeed()` — three call sites now justify it (scout: app.js :772, :1112).

The `tracker` element's own `hud_tracker_*` params need **no** UI work (generic
inspector already handles them via the state's `cvars{}`).

Stale-guards: follow `renderModes()`'s `stale()` snapshot pattern so a
frame-only tick doesn't rebuild the DOM (tier3 asserts DOM identity).

## D. FTE backend (adapter + import + boot)

The FTE plugin's `EZHud_StateJSON` has no `hud_modes` and no killfeed cvars, and
we cannot rebuild the wasm in this workstream. The adapter therefore keeps a
**local cvar ledger** and synthesizes both blocks:

1. `core/fte-adapter.js`:
   - Track a `Map` of known-global cvar values (`scr_newhud, cl_sbar, viewsize,
     cl_hud, scr_compacthud` + the killfeed set from §A). Seed with ezQuake
     defaults (`scr_newhud 0` is ezQuake's default, but boot.js forces
     `+scr_newhud 1` for the preview — seed with what boot actually set, see 3).
     Update the ledger in `setCvar()`/`send()` when a tracked cvar goes out, and
     from import when `importCfg` applies/retains one.
   - `state()`: after parsing engine JSON, inject `hud_modes` (same field names
     and derivations as `hud_web_state.c:275` — `classic_drawn`, `new_drawn`,
     `standard_bar` computed with the same formulas) and `killfeed` from the
     ledger, plus `hud_modes.synthetic: true` / `killfeed.synthetic: true`.
   - Allowlist `PREFIXES`: add `'r_tracker'`; exact set: `con_fragmessages`,
     `cl_useimagesinfraglog`, `cl_sbar`, `viewsize` (scout says today only
     `cl_sbar`/`viewsize`… verify — `scr_` prefix already covers scr_newhud).
   - Honesty: because the plugin ignores these cvars, the preview will not
     change. The UI must say so: when `synthetic` is set, `renderModes()` /
     `renderKillfeed()` append one muted line: "Preview can't mirror this on
     the FTE backend — the setting still lands in your exported config."
     (PARITY.md:93 is the citation.)
2. `fte/import.js`: add the killfeed cvars + `viewsize` to `APPLY_EXACT` so an
   imported config seeds the ledger (the engine-side `set` is harmless in FTE —
   unknown cvars are created — and keeps the export honest). No TRANSLATE
   entries: FTE has no equivalent.
3. `fte/boot.js`: keep `+scr_newhud 1`; after boot, tell the adapter its ledger
   seed (or have the adapter read boot's launch args) so the switch shows "New"
   as active initially — never a lie like "Classic".
4. Export: the existing paths already round-trip — applied-unchanged lines
   verbatim, applied-changed as `cvar "value"`. Editor-set killfeed/newhud cvars
   with no imported line must land in the appended `// added in ez-hud` block.
   Add adapter/export tests proving: import a cfg with `r_tracker 0` → flip to
   dedicated in the UI → export contains `r_tracker "1"` and `con_fragmessages`,
   everything else byte-identical.

## E. Tests (all must pass — tier1 through tier3_fte on pinnacle, engine tiers in CI)

- `core/tests/model.test.js` — §B cases.
- `core/tests/fte-adapter.test.js` — ledger: setCvar updates synthetic state;
  allowlist accepts `r_tracker*`/exacts, still refuses `r_speeds`, `exec`, etc.;
  synthetic flags present.
- `core/tests/fte-import.test.js` — `appliable()` accepts the new cvars; import
  seeds ledger; drift report counts them as applied (not retained).
- `tools/tests/tier3.mjs` — extend fixture state with a `killfeed` block; assert
  the section renders, the "Where kills appear" seg sends the right *pair* of
  set commands, and DOM identity survives a frame tick.
- `tools/tests/tier3_fte.mjs` — assert: HUD system section **renders** on the
  FTE page (it must not today), shows "New" active after boot, clicking Classic
  sends `scr_newhud 0` via cbufadd and the synthetic note is visible; killfeed
  section renders with the honesty note; export test extended per §D4.
- `tools/tests/tier2_engine_contract.py` — §A3 (runs in CI on pinnacle runner).
- `engine/src/libhud/tests` untouched unless placement logic changes (it doesn't).

## F. Sync obligations (tier-1 guards)

- `index.html` changes ⇒ regenerate `engine/src/hud_web_assets.c`
  (`python3 engine/tools/embed_hud_web_ui.py`) **in the same commit**.
- No new files under `hud_web_ui/` (keep `renderKillfeed` in app.js) so neither
  `embed_hud_web_ui.py SOURCES` nor `tier1_public_dist.sh`'s allowlist changes.
- `node --check` runs on all touched JS; keep ES-module syntax consistent.

## Out of scope (say so in the PR)

- FTE plugin work (registering `tracker`, honouring `scr_newhud`) — separate
  engine workstream; the drift panel + synthetic notes carry honesty until then.
- Dedicated UI for `r_tracker_color_*` / `r_tracker_string_*` — they remain
  reachable as raw cvars and round-trip losslessly.
