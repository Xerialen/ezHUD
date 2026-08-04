# Spec — #41: plugin export emits `physical`

Status: approved for implementation (Sol). Reviewer: Claude.
Parent: #39. Depends on #40 (same code region; build on its branch order).

## Where

Same hunk as #40: `EZHud_StateJSON` in `spikes/fte-web/fteqw.diff`. The
current comment says `physical` is "deliberately absent" — that decision is
reversed by protocol (docs/PROTOCOL.md requires `physical` from the same
source as the frame capture). Delete the stale comment when implementing.

## Requirement

Emit `"physical":[W,H]` (integers) in the top level of the state JSON, read
in the same call as `screen` (no torn read). Source: the dims the wasm
frame capture actually uses — in the emscripten build that is the canvas
backing store the renderer draws to (`vid.pixelwidth/pixelheight` or
whatever the fork names the true framebuffer dims — verify against the
capture path, name the variable in the PR).

## Cases → tests (issue #41 Cases 1–4)

- Case 1: tier-2/tier-3F state-shape assertion — `physical` is a 2-int array
  on the FTE backend (extend the existing state contract test where /state
  shape is checked; observe it fail first against the pre-fix engine build).
- Case 2: wasm path — assert `physical` equals `canvas.width/height` in the
  page (tier-3F or QA wasm bridge, both visible there).
- Case 3: resize → one snapshot where `physical` and `screen` both reflect
  the new mode (QA matrix snapshot after resize; assert consistency).
- Case 4: ezQuake backend regression — tier-2 engine contract unchanged
  (`renderer.ScreenshotWidth/Height` source); no edit to hud_web.c expected.

## Out of scope

Any consumer change; the page already tolerates `physical` being present.
