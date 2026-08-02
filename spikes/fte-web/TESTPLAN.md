# Test-tier update for the FTE-web backend

The tier system (docs/TESTING.md) was built for the ezQuake-bridge version:
tier 2 asserts an HTTP contract the FTE page does not have, tiers 3–4 drive
view/app.js against that bridge. The FTE backend currently has tier 1 unit
coverage only; every GUI flow (drag, import, drift, export, demo picker) has
been verified by hand in a browser and never by a machine. This plan closes
that gap, and it is the gate the publish fixes must pass before anything is
deployed.

## What stays, what changes

- Tiers 1–4 as they exist keep testing the ezQuake backend, untouched. The
  ezQuake bridge is still the deliverable target; its tests are not stale.
- Two new lanes are added for the FTE backend, mirroring the existing split:
  - **tier 3 FTE** — deterministic: real DOM, real adapter/import/chrome
    modules, *fake* engine. Runs everywhere, merge-gate cheap.
  - **tier 4 FTE** — the real wasm engine in a real browser against the
    **public dist**, i.e. the exact artifact Pages will serve. Slower,
    network-free, still headless.
- Browser strategy for both: Playwright with `channel: 'chrome'` (the system
  Google Chrome). No Playwright browser downloads — the dev machine has
  Chrome, and GitHub's ubuntu runners ship it preinstalled. Headless; WebGL
  in tier 4 comes from Chrome's own SwiftShader fallback.
- Environment notes referencing "pinnacle WSL" (docs/PROTOCOL.md:248, the
  WSLg/`GALLIUM_DRIVER=d3d12` block in tools/tests/tier4.sh) are updated:
  pinnacle now runs native Ubuntu Desktop, so the WSL workarounds are
  historical. Keep them as history, do not delete behaviour: tier4.sh's
  `EZHUD_USE_DISPLAY` path must keep working on a native X/XWayland display.

## Deliverable T3F — `tools/tests/tier3_fte.mjs` (+ `npm run test:tier3:fte`)

Deterministic FTE-page suite. Serve `hud_web_ui/` at a site root the way
index-fte.html requires (the import map keys on `/core/bridge.js`; follow
tier3.mjs's static-server pattern). Load `index-fte.html`. `ftewebglcl.js`
does not exist under hud_web_ui/ and must 404 — that is the point: the page
must be drivable with **no wasm at all**.

The fake engine: after load, install into the page
- `Module._EZHud_StateJSON` / `Module.UTF8ToString` returning a mutable
  state object (fte/boot.js already created `window.Module`; attach to it,
  the adapter reads both lazily), and
- `window.FTEC = { cbufadd(line) { ... } }` whose implementation *parses*
  the cvar-set lines the editor sends and folds them back into that state
  (`hud_<el>_pos_x` etc. onto the matching element / its cvars object) and
  records every line verbatim for assertions.

That closed loop — editor sends, fake engine applies, editor re-reads —
is what makes drag/inspector tests real rather than "the right string was
sent". Base the state fixture on the shapes in
`hud_web_ui/core/tests/fte-adapter.test.js` (they mirror the C export in
`plugins/ezhud/hud.c`); include at least two placed elements with rects, one
percentage-sized, and screen/physical sizes whose horizontal and vertical
ratios **differ** (TESTING.md's aspect-ratio rule — equal ratios hide the
project's single largest bug class).

Cases, each proven through the DOM (no reaching into module internals except
`currentBridge()` where noted):

1. **Control first** (TESTING.md rule): the tree renders the fixture's
   elements and clicking one selects it and opens the inspector.
2. Drag the selected element on the stage → FTEC received allowlisted
   placement commands only → the overlay rectangle lands where
   core/geometry.js says for those cvar values (assert numerically).
3. Allowlist negative: `currentBridge().send('quit')` and
   `send('hud_web_port 99')` reject; nothing reaches FTEC.
4. Import via a real DataTransfer drop of a synthetic .cfg (build it in the
   test: a few applying lines, a bind, an unknown hud_ element, a
   gl_consolefont line): applied count lands in the note, drift panel names
   the missing element, the unpreviewed cvar, the translation
   (gl_consolefont → gl_font) and the retained count.
5. Export after one deliberate edit: `exportFullCfg()` differs from the
   imported text in exactly the edited line; everything else byte-identical.
6. Demo picker: choosing the other bundled demo calls the host `play` path
   (observe FTEC's playdemo line, gamedir-relative — no `qw/` prefix).
7. Reload guard: after the fake engine exists, `beforeunload`/key listeners
   are released — dispatch a keydown and assert the page's own handler saw
   it (tier reproduces the boot race fix's contract, not its timing).

Skip cleanly (exit 0 with a loud SKIP line) when playwright or Chrome is
absent, exactly like tier3.mjs does.

## Deliverable T4F — `tools/tests/tier4_fte.sh` + `tier4_fte.mjs` (+ `npm run test:tier4:fte`)

The public dist, end to end, offline. tier4_fte.sh preflights and refuses
with actionable errors (exit 2, tier4.sh's convention) when inputs are
missing; it does NOT build things itself:

- `DIST_DIR` (default `<workspace>/dist`) must exist and contain
  `index.html` + `ftewebglcl.wasm` — pointing at a dist assembled with
  `BASE_PATH=/ez-hud/`. The suite serves it under that prefix (reuse
  serve-public.sh or its temp-symlink trick) on an ephemeral port.
- playwright + system Chrome required (no download, no install attempts).

tier4_fte.mjs, against `http://127.0.0.1:<port>/ez-hud/index.html`:

1. **Boot**: within 60s the adapter reports a state whose elements have
   rects (the engineLive condition) — this single assertion proves the wasm
   engine, pak0, gpl_maps' dm3 and the bundled demo end to end. Assert the
   page title carries the demo name and `#engine` says the backend is FTE.
2. **Control interaction**: click an element in the tree, inspector opens.
3. **Drag**: mouse-drag the health element ~50px on the stage; poll state
   until `hud_health_pos_x` changed; assert direction and that the value is
   a number, then drag back.
4. **Import over live engine**: DataTransfer-drop a small synthetic cfg
   (one pos_x edit on a registered element + one bind); assert the note
   reports applied/lines and state reflects the new pos_x.
5. **Export**: exportFullCfg returns the bind byte-identical and the edited
   line rewritten.
6. **Demo picker**: switch to the second bundled demo; engineLive again
   within 60s (playdemo through the GUI path).
7. Artifacts: on any failure, screenshot + page console log to
   `HUD_WEB_ARTIFACT_DIR` (default `/tmp/ezhud-tier4-fte-artifacts`); on
   success one final screenshot for the record.

Timeouts generous (wasm + SwiftShader is slow), every wait condition-based,
none sleep-based. Known flake surface documented at the top of the file
(TESTING.md tier-4 policy: failures need human eyes, never auto-block).

## Deliverable DOCS (reviewer's own)

- docs/TESTING.md: FTE lanes in the tier table, run commands, the
  channel-chrome decision, tier-4-FTE = "the deploy artifact, tested".
- docs/PROTOCOL.md:248 and tier4.sh's WSL block: pinnacle is native Ubuntu
  Desktop now; WSL guidance marked historical.
- .github/workflows/pages.yml: run tier1 + tier3-fte + tier4-fte in the
  build job between assemble and deploy — the publish fixes then literally
  cannot deploy without passing the new tests.

## Constraints (all prior ones apply)

- No system packages, no sudo, no Playwright browser downloads. `npm
  install` of declared devDependencies is fine and already done.
- Never write outside the workspace; ~/quake* read-only.
- Run what you write: both suites must pass on this machine before you
  report done. tier3_fte must finish < 30s, tier4_fte < 4 min.
- Commit in logical commits, do not push. Repo comment voice: explain why,
  cite the fact that forced the choice.
