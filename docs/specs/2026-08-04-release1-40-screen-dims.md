# Spec — #40: `EZHud_StateJSON` screen dims go stale after resize

Status: approved for implementation (Sol). Reviewer: Claude.
Parent: #39. Evidence: `docs/qa-findings-2026-08-04.md` finding 1.

## Where the code is

The export lives in the fteqw fork's patch: `spikes/fte-web/fteqw.diff`
(hunk adding `EZHud_StateJSON` to the hud plugin) applied to
`Xerialen/fteqw` at the `FTEQW_SHA` pin in `tools/qa/setup-fte-env.sh`
(header) and `.github/workflows/pages.yml`. **The two pins and the diff move
together** — a fix here means: edit the diff (mind CRLF: the file mixes
line endings; edit in binary-safe mode, see commit b6dfbf6), rebuild via the
setup script, and if the fork itself needs a commit, push it to
Xerialen/fteqw and bump both pins in the same PR.

## Root-cause constraint (from reading the current code)

`EZHud_StateJSON` already reads `vid.width`/`vid.height` **per call** — there
is no snapshot cache in the export itself. Measured behaviour (853×480
reported while rects extend to 1002×859) therefore means the FTE web build's
`vid.width/height` is not the surface the HUD layout ran against (FTE
distinguishes virtual 2D dims from `vid.pixelwidth/pixelheight`, and the
emscripten canvas-resize path updates them on different schedules).

Sol must find, in the fork source, the exact dims `HUD_Recalculate`/the draw
path use to compute `hud->lx/ly/lw/lh`, and export **those same variables**
in the same snapshot. Do not export a third source that happens to agree
today. Name the variable(s) in the PR description.

## Cases → tests (issue #40 Cases 1–5)

- Case 1/3 (rects and screen agree): the QA matrix containment invariant IS
  the test — currently RED on every `newhud.*` cell (62 elements "outside").
  GREEN = full matrix run with containment passing on all `newhud.*` cells.
- Case 2/4 (resize follows, both directions, no latch): the matrix resize
  step (1440→1080, 1440→720 and metamorphic there-and-back) covers both
  directions; proportionality must measure a ratio ≠ 1.0 (report.json shows
  the measured ratio — quote it in the PR).
- Case 5 (editor-level): `geometry.js scaleFactors` consumes `screen` —
  covered indirectly by containment; no new editor code.

RED evidence requirement: before the fix, run one matrix cell and keep its
report.json (containment failures, ratio 1.0) as the observed-failing state;
after, the same cell green. Both artifact paths go in the PR.

## Out of scope

`physical` export (#41 — separate PR), classic-HUD sbar expectations,
any editor/UI change.

## Revision 2 (after Sol's investigation + reviewer verification)

Sol's honest stop was correct. Verified independently (canvas/style probes
against the assembled dist):

- `EZHud_StateJSON` already exports the exact variables the layout uses
  (`plugvid.width/height` via `#define vid plugvid`). No engine bug.
- The real defect is in the page: `#canvas` width is
  `min(1920px, 100%, calc((100vh − …) * 16/9))` where `100%` resolves against
  `.stage__frame`, whose width is derived from the canvas — self-referential,
  so the canvas freezes at its initial size (704×396 at 1280×720 boot) and
  never follows the window. FTE's glue (`ftejslib.js onresize`) reads the
  canvas rect, so the engine never sees any resize: `screen` stays 853×480,
  QA's resize step is a no-op, proportionality measures 1.0.
- The 62 containment failures are the master cfg deliberately placing
  elements off-screen (generator artifact), not stale dims.

### Revised requirement

1. `hud_web_ui/fte/fte.css`: break the circular constraint — the canvas's
   size limits must derive from the viewport/stage, never from a parent that
   shrink-wraps the canvas. After a window resize, `canvas.width/height` and
   `/state.screen` must follow (ftejslib glue already handles the rest).
2. `tools/qa/gen_master_cfg.mjs`: generated placements stay within the
   1440p frame so containment is meaningful; regenerate the golden.
3. Matrix cell GREEN with a measured resize ratio ≠ 1.0 in report.json, and
   containment passing over ≥10 drawn elements.

Issue #40's Cases 1–5 stand — they were always phrased against observable
behaviour, which is why they survive the root-cause correction.
