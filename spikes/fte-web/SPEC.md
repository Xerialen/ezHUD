# FTE-web backend spike — implementation spec

Issue: https://github.com/Xerialen/ez-hud/issues/4 (read it; this spec assumes it).
Branch: `spike/fte-web` (already checked out here). Work happens on minimain.

## Ground rules

- **Never write** under `~/quake`, `~/quake-afterquake`, `~/.ezquake`. Reading is fine.
- No system packages, no `apt`, no sudo. `gh` does not exist. Everything user-local.
- GNU make lives at `~/tools/local/usr/bin/make`; emsdk at `~/tools/emsdk`
  (`source ~/tools/emsdk/emsdk_env.sh`). **`~/.profile` exports
  `CFLAGS/CXXFLAGS/LDFLAGS="-pipe -march=native -O3"` which breaks wasm builds —
  `unset CFLAGS CXXFLAGS LDFLAGS` in any shell that builds FTE.**
- Engine binaries are never committed. FTE patches are captured as diffs under
  `spikes/fte-web/` (see Deliverables).
- `core/` and `view/` in `hud_web_ui/` are backend-agnostic; **`view/app.js`,
  `core/bridge.js`, `core/model.js`, `core/geometry.js` must not be modified.**
  The FTE backend is a *sibling adapter* plus a *host page*.

## What already exists (do not redo, but fix where told)

| Path | State |
|---|---|
| `/home/xerial/Dev/ez-hud-fte/fteqw/` | shallow clone, patched, **builds successfully** via `make webcl-rel -j20` from `fteqw/engine/` (with the env fixes above). Output: `fteqw/engine/release/ftewebglcl.{html,js,wasm}` |
| fteqw patch 1 | `engine/common/config_fteqw.h`: `-DLINK_EZHUD` uncommented (line 237) — ezhud statically linked |
| fteqw patch 2 | `engine/common/pr_bgcmd.c`: `svprogfuncs` NULL-stub under `CLIENTONLY` + `PF_Fork` uses `prinst->callargc` (upstream link failure at HEAD otherwise) |
| fteqw patch 3 | `engine/web/ftejslib.js`: `window.FTEC = FTEC;` exposed at event-callback registration (command channel for the page; hub.quakeworld.nu precedent) |
| fteqw patch 4 | `engine/Makefile`: `EMCC_LDFLAGS+=-s EXPORTED_RUNTIME_METHODS=UTF8ToString` |
| fteqw patch 5 | `plugins/ezhud/hud.c`: `EZHud_StateJSON()` appended at end of file — `EMSCRIPTEN_KEEPALIVE`, returns the `/state`-shaped JSON (docs/PROTOCOL.md) minus `physical`. Verified present in the built js (`Module._EZHud_StateJSON`). |
| `/home/xerial/Dev/ez-hud-fte/site/` | static site dir: `ftewebglcl.{html,js,wasm}` (current build), `default.fmf`, `id1/pak0.pak`, `id1/pak1.pak`, `qw/demos/hudtest_src.mvd`, `qw/demos/tb4gf_book_vs_s.mvd` |
| `hud_web_ui/core/quake-palette.js` | generated id1 palette (256 `#rrggbb`), done |
| `hud_web_ui/core/fte-adapter.js` | first draft, **needs the fixes listed below** |

Machine: 24 cores, Debian testing, python3 + node present. ICMP filtered; test
reachability with TCP.

## Architecture (decided — do not redesign)

`view/app.js` imports `../core/bridge.js` and drives everything through the
`Bridge` class (`state/fonts/configs/palette/save/backupEnabled/loadFace/frameUrl/send/setCvar`,
`configured`, plus `BridgeError`). Read `view/app.js` and `docs/PROTOCOL.md`
before writing code — the adapter must satisfy exactly what app.js consumes.

1. **Import map swap.** The host page uses an import map to map the resolved
   URL `/core/bridge.js` → `/core/fte-adapter.js`, so `app.js` ships
   byte-identical. (Import-map keys are resolved absolute URL paths.)
2. **Live canvas, no frame capture.** FTE renders into its own `<canvas
   id="canvas">` inside `.stage__frame`. On top of it sits a transparent
   `<div id="frame">` (pointer isolation: clicks must reach the editor, never
   the game), and on top of that the editor's `#overlay`. app.js believes
   `#frame` is an `<img>`; the host page shims the div before `app.js` loads:
   - `naturalWidth`/`naturalHeight` getters → `canvas.width/height`
   - `src` setter → no-op that async-dispatches a `load` event on the div
     (app.js's `requestFrame` swap then completes and sets `frameReady`)
   - `clientWidth`/`getBoundingClientRect` are native and correct because the
     div is `position:absolute; inset:0` over the canvas.
   `frameUrl()` returns a 1×1 transparent GIF data URI so `new Image()` in
   app.js loads instantly. This is already in the adapter draft.
3. **Commands**: `FTEC.cbufadd(line + "\n")`, allowlist mirroring PROTOCOL.md
   (already drafted). Host-page chrome (demo picker, import pipeline) may call
   `FTEC.cbufadd` directly for commands outside the editor allowlist
   (`playdemo`, `demo_jump`, `vid_reloadtextures`, `exec` is still forbidden).
4. **State**: `JSON.parse(Module.UTF8ToString(Module._EZHud_StateJSON()))`,
   then inject `state.physical = [canvas.width, canvas.height]`. The plugin's
   `vid_width/vid_height` are the **console-pixel** size ezhud draws in;
   verify at runtime that rect coordinates are in that space (they should be —
   `EZHud_UpdateVideo` receives the virtual 2D size).

## Work items

### A. Fix `core/fte-adapter.js`

1. `exportFullCfg()` has a broken additions filter (a ternary inside a
   `.filter` that returns `false` for the no-defaults case in a confusing
   way). Rewrite: if `this.defaults` is missing, append nothing extra; else
   append every cvar whose current value differs from `defaults` **and** that
   was not already written via a retained line. Keep the comment honest.
2. `state()` should throw `BridgeError('FTE is still starting')` until the
   engine is up — app.js maps that to `Status.LOST` and keeps polling. Verify
   the retry loop actually recovers (applyError → next poll succeeds). If
   app.js stops polling on DENIED only, LOST is fine.
3. Add JSDoc-level comments sparingly in the file's existing voice.
4. Unit tests: `hud_web_ui/core/tests/fte-adapter.test.js` in the style of
   `core/tests/bridge.test.js` (node:test + assert/strict), with a fake
   `engine` injected via the constructor (`{module: {...}, ftec: {...}}`):
   - state() parses, injects physical from the fake canvas, stores lastState
   - send() refuses `;`, `$`, newlines, non-allowlisted commands, `hud_web*`
   - setCvar quotes values with spaces
   - exportHudCfg emits sorted `cvar "value"` lines from lastState
   - lossless round-trip: retainedLines with a mix of applied/unapplied lines
     reproduces unapplied lines byte-identical and rewrites applied ones
   - captureDefaults + a changed cvar → exportFullCfg appends it under
     `// added in ez-hud`

### B. Host page — `hud_web_ui/index-fte.html` + `hud_web_ui/fte/`

New files only (plus the css below). Keep app.js's markup contract: every id
in `view/app.js`'s `el` table must exist. Copy `index.html`'s structure; the
stage section becomes:

```html
<div class="stage__frame" id="stage">
  <canvas id="canvas" ...></canvas>   <!-- FTE draws here -->
  <div id="frame"></div>              <!-- shimmed; transparent; absolute inset:0 -->
  <div class="overlay" id="overlay"></div>
  <div class="stage__empty" id="empty" hidden>…</div>
</div>
```

- Import map before the module script:
  `{"imports": {"/core/bridge.js": "/core/fte-adapter.js"}}` — confirm the
  key matches how the browser resolves `../core/bridge.js` from
  `/view/app.js` when served from the site root.
- `hud_web_ui/fte/fte.css`: canvas + #frame layering, drop-zone styling,
  drift-report styling. Link it after `ui.css`. Do not edit `ui.css`.
- `hud_web_ui/fte/boot.js` (a classic script, not a module, or a module —
  your call; it must run before `ftewebglcl.js`):
  - Builds `var Module = { canvas, files, autostart: true, arguments: [...] }`.
  - `files`: `{"default.fmf": "default.fmf", "id1/pak0.pak": "id1/pak0.pak",
    "id1/pak1.pak": "id1/pak1.pak", "qw/demos/<demo>.mvd": "qw/demos/<demo>.mvd"}`
    — study `fteqw/engine/web/fteshell.html` for the contract (string values
    are URLs fetched pre-run; ArrayBuffers/promises also accepted).
  - Merges persisted user files from the Cache API (cache name `user`, keys
    `/_/<fs-path>` — same convention as the stock shell) into `Module.files`
    as ArrayBuffer promises, so imported paks/demos survive reloads.
  - `arguments`: `["-manifest","default.fmf","+plug_sbar","3","+scr_newhud","1","+playdemo","<initial demo>"]`.
    plug_sbar=3 = always let the hud plugin draw (`plugin.c:31`). If
    `+playdemo` at boot races the filesystem, fall back to sending
    `playdemo …` via `FTEC.cbufadd` once state polling shows the engine up.
  - Installs the `#frame` shim (naturalWidth/naturalHeight getters, src
    setter dispatching `load`).
  - Then injects `<script src="ftewebglcl.js">` (see `begin()` in
    fteshell.html) — or a static script tag ordered after boot.js.
- Host chrome (small, host-page-owned, NOT inside app.js's panels):
  - Demo picker: the two bundled demos + any dropped `.mvd`s + a "custom URL"
    entry; switching sends `playdemo` via cbufadd. Note in a code comment that
    hub URL playback is stretch scope and CORS findings go in NOTES.md.
  - Import drop zone: whole stage accepts drag-and-drop.

### C. Import pipeline — `hud_web_ui/fte/import.js`

File-type dispatch on drop:

- **`.cfg`** → parse client-side, never exec:
  - Tokenise each line; recognise `<cvar> <value>`, `set <cvar> <value>`,
    `seta <cvar> <value>` forms (value possibly quoted).
  - Allowlist for *applying*: `hud_*` (except `hud_web*`), `scr_newhud`,
    `cl_sbar`, `vid_conwidth`, `vid_conheight`, `vid_conautoscale` (con-size
    family). Everything else (binds, aliases, other cvars, comments, blanks)
    is retained verbatim, unapplied.
  - Apply via the adapter's `setCvar` (so the same refusal path runs), then
    one `hud_recalculate`, then a state refresh.
  - Record every line into `bridge.retainedLines` as
    `{raw, cvar: <name or null>, applied: <bool>}` in file order, set
    `bridge.importedName`, and call `bridge.captureDefaults()` **before**
    applying anything (defaults must be pre-import).
  - **Drift report** (requirement 5): after the post-apply state refresh,
    compare: (a) config cvars naming elements absent from `state.elements`
    → "element not in FTE preview" (the 11 missing ones land here);
    (b) applied cvars absent from the state's cvar snapshot → "cvar not
    previewed"; (c) lines retained-unapplied → counted, not listed
    individually unless `hud_*`. Render into a host-page panel
    (`<details>` under the stage is fine) — honest, never silently dropped.
- **`.pak` / `.pk3` / `.zip`** → store raw bytes in the Cache API under
  `/_/id1/<filename>` (pk3/zip keep their extension; FTE mounts both), then
  `location.reload()` — boot merges cached files into `Module.files`. Show a
  "reloading with your textures" note first. (This is the persisted,
  one-time-step path from the issue; runtime `vid_reloadtextures` without a
  reload is a bonus if `sys_openfile` turns out reachable, not required.)
- **`.mvd`** → cache under `/_/qw/demos/<filename>`, remember the name in
  `localStorage`, reload; boot plays it. (Runtime `playdemo` after cache-write
  without reload may work since FTE reads through its FS layer — try it, keep
  whichever is reliable, note the finding.)

### D. Site assembly + serving — `tools/fte-web/`

- `tools/fte-web/assemble.sh`: idempotent; copies/symlinks
  `hud_web_ui/{index-fte.html,ui.css,favicon.svg,core,view,fte}` into
  `/home/xerial/Dev/ez-hud-fte/site/` (symlinks fine — python http.server
  follows them), and copies the three engine files from
  `fteqw/engine/release/` if newer.
- `tools/fte-web/serve.sh`: `python3 -m http.server <port> -d site` (default
  port 8618). Print the URL. `.wasm` gets the right MIME from python ≥3.9.

### E. Capture the fteqw patches

`cd fteqw && git diff > ../ez-hud/spikes/fte-web/fteqw.diff` (all five patches
are uncommitted working-tree changes in the fteqw clone). Add
`spikes/fte-web/NOTES.md`: build prerequisites (emsdk, user-local make, the
CFLAGS trap), the exact build command, what each patch does and why, and any
findings from B/C (playdemo-at-boot behaviour, CORS, runtime-FS results).

### F. Verification (definition of done for this task)

1. `npm run test:tier1` passes (it runs `node --check` on all core files —
   including the new adapter — plus the existing unit tests and the new
   fte-adapter tests). Playwright tiers 3/4 are out of scope; do not install
   browsers.
2. `bash tools/fte-web/assemble.sh && bash tools/fte-web/serve.sh` serves; all
   of these URLs return 200 with plausible content-types:
   `/index-fte.html`, `/core/fte-adapter.js`, `/view/app.js`,
   `/ftewebglcl.js`, `/ftewebglcl.wasm`, `/id1/pak0.pak`,
   `/qw/demos/hudtest_src.mvd`.
3. Static sanity: `node --check` every new js file; the import map key
   matches the served path of bridge.js exactly.
4. Do **not** attempt interactive browser testing — the reviewer does that.
   Leave the server stopped when done.

Commit everything on `spike/fte-web` in logical commits (adapter+tests, host
page+import, tools, spikes docs). Do not push.

## Voice

Match the repo's comment style: comments explain *why*, cite engine facts with
file:line where they matter, and never claim more certainty than the code has.
