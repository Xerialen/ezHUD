# QA matrix, first real-engine run — findings (2026-08-04)

Environment: the FTE-web fork built from scratch in the agent sandbox by
`tools/qa/setup-fte-env.sh` (fteqw@9d8aa38 + fteqw.diff, emsdk 6.0.5,
hash-pinned game data, public dist), engine running headless in system Chrome,
exposed to the matrix through `tools/qa/wasm_bridge.mjs`. Tier 4 FTE passed
in full against the same dist before the matrix ran.

Cell examined in depth: `newhud.modern.1440-1080`
(artifacts: scratchpad `qa-real1`/`qa-real2`; report.json has every number).

## Finding 1 — `/state` screen dims go stale after a resize (real bug)

After the canvas is resized, `EZHud_StateJSON` keeps reporting the old console
size while the rects are laid out against the new one. Measured live:
`screen: {vid_width: 853, vid_height: 480}` with drawn rects extending to
**x+w = 1002, y+h = 859** — 62 of 75 elements "outside" a screen they are
visibly inside. Containment fails across the board for exactly this reason.

Why it matters beyond QA: the editor computes its handle scale from these
fields (`geometry.js scaleFactors`), so after a window resize every overlay
box is drawn at the wrong scale until something else refreshes the cached
dims. Suspect: the plugin's vid snapshot in the fork's `EZHud_StateJSON`
(fteqw.diff, plugins/ezhud) is taken once rather than per call, or reads a
different vid struct than the layout path uses.

Also observed: the plugin export has no `physical` field (`null`), which the
protocol says must come from the same source as the frame capture.

## Finding 2 — `ping` is content-sized in a way no snapshot can pin

`hud_ping` renders a rolling readout whose text length changes in real time
(not demo time: freezing the demo with `demo_setspeed 0` did not stop it), so
its rect width moves between any two snapshots (176 → 136 measured). The
metamorphic invariant will always flag it.

Resolution for the matrix: a small dynamic-elements list (`ping`, and any
future element whose width is content-driven) judged on position only. Not
done yet — listed here so the exemption is a reviewed decision, not a silent
tolerance.

## What held

Worth stating because it is the point of the matrix: **proportionality,
alignment and cvar round-trip all PASS against the real engine** — resize
scales every element within one glyph, flush edges stay flush, and exported
cvar strings survive re-import byte-identically. The demo-freeze step
(`demo_setspeed 0`) is now part of every cell.

## Follow-ups

All three closed by Release 1 (epic #39; evidence `docs/release-1/index.html`):

1. ~~Stale screen dims~~ — **root cause corrected and fixed in PR #45** (#40).
   The export was honest all along; the page's self-referential canvas CSS
   froze the canvas, so resizes never reached the engine and the QA resize
   step was a no-op. Finding 1's "62 outside" containment failures were the
   master cfg's deliberate off-screen placements, fixed in the same PR.
2. ~~Dynamic-width `ping`~~ — **fixed in PR #47** (#42): exported
   `DYNAMIC_WIDTH` list, position still judged, exemption visible per report.
3. ~~Emit `physical`~~ — **fixed in PR #46** (#41): one `GetVideoSize`
   snapshot, integer pair, torn-read-safe with `screen`.

## Full 12-cell run (same day, later)

`6/12 PASS` at face value — but neither half of that number means what it says:

- **Every `classic.*` PASS was vacuous.** `scr_newhud 0` hides all plugin
  elements, zero rects are drawn, and every geometric invariant passes over an
  empty set. Fixed in the matrix: a `non-vacuous` invariant (≥10 drawn
  elements) now fails such a cell outright. The classic axis needs its own
  expectations (the engine's sbar is not a plugin element) — open design item.
- **Every `newhud.*` FAIL reduces to the two findings above.** Containment: 62
  identical stale-screen-dims failures per cell. Proportionality/metamorphic:
  `ping`'s realtime width. No third defect appeared in any of the 12 cells.
- **Finding 1 also blinds proportionality**: with `screen` frozen at the old
  value the computed resize ratio is 1.0, so the invariant compares before
  against before. The stale-dims bug must be fixed before proportionality can
  measure anything real. It is the single highest-value fix this run points at.

Full artifacts: one directory per cell (snapshots, report.json with every
number, engine log) from the run's `--artifacts` root.
