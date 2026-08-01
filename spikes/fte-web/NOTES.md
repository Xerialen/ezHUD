# FTE-web backend — build notes and findings

The spike from issue #4: run the ez-hud editor against FTE compiled to wasm, so
the HUD can be laid out in a browser with no ezQuake installed. See `SPEC.md`
for the plan this implements, and `fteqw.diff` for the engine side.

## What this is, and what it is not

`hud_web_ui/core/` and `view/` are backend-agnostic. `view/app.js`,
`core/bridge.js`, `core/model.js` and `core/geometry.js` are byte-identical to
the ezQuake build; the FTE backend is `core/fte-adapter.js` (a sibling of
bridge.js with the same interface) plus a host page under `hud_web_ui/fte/`.
`index-fte.html` swaps one for the other with an import map and nothing else
changes.

It is a **preview**, not ezQuake. FTE's ezhud plugin is a port of a snapshot of
ezQuake's HUD, so the element set differs, fonts differ, and the state export is
narrower than the real bridge's. Every one of those gaps is listed under
[Parity gaps](#parity-gaps) and reported to the user in the import drift panel
rather than left to be discovered.

## Building the engine

Prerequisites, all user-local — nothing here needs root:

| Thing | Where |
|---|---|
| GNU make | `~/tools/local/usr/bin/make` |
| emsdk | `~/tools/emsdk` (`source ~/tools/emsdk/emsdk_env.sh`) |
| fteqw | `/home/xerial/Dev/ez-hud-fte/fteqw` (shallow clone) |

**The trap:** `~/.profile` exports
`CFLAGS/CXXFLAGS/LDFLAGS="-pipe -march=native -O3"`. `-march=native` is
meaningless to a wasm target and emcc fails on it, in a way whose error message
does not mention your profile. Unset them in any shell that builds FTE.

```sh
source ~/tools/emsdk/emsdk_env.sh
export PATH="$HOME/tools/local/usr/bin:$PATH"
unset CFLAGS CXXFLAGS LDFLAGS
cd /home/xerial/Dev/ez-hud-fte/fteqw/engine
make webcl-rel -j20
```

Output: `fteqw/engine/release/ftewebglcl.{html,js,wasm}`. **Engine binaries are
never committed.** `tools/fte-web/assemble.sh` copies them into the site
directory, which is outside this repository.

## The five engine patches

All five are uncommitted working-tree changes in the fteqw clone, captured
whole in `fteqw.diff`. Regenerate with
`cd fteqw && git diff > ../ez-hud/spikes/fte-web/fteqw.diff`. Base commit at
the time of writing: `f937b9d`.

1. **`engine/common/config_fteqw.h:237`** — uncomment `-DLINK_EZHUD`, which
   statically links the ezhud plugin. The comment in the file already says this
   is what the web target wants; it just ships commented out. Without it there
   is no HUD to edit.

2. **`engine/common/pr_bgcmd.c`** — two changes, both needed to *link* a
   client-only build at this commit, neither specific to this spike:
   `svprogfuncs` is stubbed to NULL under `CLIENTONLY` (there is no SSQC
   instance, so the comparisons guarding it are then always false), and
   `PF_Fork` reads `prinst->callargc` rather than `svprogfuncs->callargc` —
   the wrong instance, and a NULL dereference in a client-only build. Worth
   sending upstream independently of anything else here.

3. **`engine/web/ftejslib.js`** — `window.FTEC = FTEC;` where the event
   callbacks are registered. This is the command channel: the page needs
   `FTEC.cbufadd` to say anything to the engine at all. hub.quakeworld.nu does
   the same thing, so it is not a novel shape.

4. **`engine/Makefile`** — two `EMCC_LDFLAGS` additions, all three names found
   the hard way in a live browser:
   - `-s EXPORTED_RUNTIME_METHODS=UTF8ToString,addRunDependency,removeRunDependency`.
     `UTF8ToString` because `EZHud_StateJSON()` returns a `char*` the page has
     to read. The other two because **the stock web build is broken at this
     emscripten (6.0.5) without them**: `prejs.js`'s `loadcachedfiles` calls
     `addRunDependency` at preRun, current emscripten dead-strips it unless
     exported, and the resulting `ReferenceError` aborts preRun — the engine
     comes up with no files mounted and a 0×0 video mode.
   - `-s EXPORTED_FUNCTIONS=_main,_malloc,_free`. `FTEC.cbufadd` allocates
     with `_malloc` and frees with `_free` at runtime (`ftejslib.js`); newer
     emscripten strips `_free` as unreferenced, so every command the page sent
     executed and *then* threw. `_main` is listed because setting the flag
     replaces the default list rather than adding to it.
   Note when relinking: the Makefile does not track itself as a dependency —
   `rm release/ftewebglcl.{js,wasm}` first or the flag change silently does
   nothing. A browser that already has the old `ftewebglcl.js` needs a hard
   reload (Ctrl-Shift-R) on top of that.

5. **`plugins/ezhud/hud.c`** — `EZHud_StateJSON()` appended at the end of the
   file, `EMSCRIPTEN_KEEPALIVE`, returning the `/state` shape from
   `docs/PROTOCOL.md` into a static 256KB buffer. `physical` is deliberately
   absent: the page reads the canvas size itself, exactly as the ezQuake bridge
   reads the framebuffer it is about to capture, so the two cannot disagree
   about the size of the same picture.

Verify the last two landed in a build with:

```sh
grep -c _EZHud_StateJSON  .../site/ftewebglcl.js   # non-zero
grep -c 'Module\["UTF8ToString"\]' .../site/ftewebglcl.js
```

## Running it

```sh
bash tools/fte-web/assemble.sh
bash tools/fte-web/serve.sh          # http://127.0.0.1:8618/index-fte.html
```

The site directory (default `../site`, override with `SITE_DIR`) must already
contain the game data: `default.fmf`, `id1/pak0.pak`, `id1/pak1.pak`, and the
demos under `qw/demos/`. assemble.sh refuses to create it rather than producing
a site that loads and then fails to boot.

**Serve from the site root.** The import map key is the absolute path
`/core/bridge.js`, because an import-map key is a resolved URL and not the text
of the specifier. Served from a subdirectory the key stops matching what
`view/app.js`'s `../core/bridge.js` resolves to, the real `core/bridge.js`
loads instead, and the page reports a lost ezQuake connection rather than a
broken setup.

## Findings

### The Cache API is read exactly once, at preRun

`engine/web/prejs.js` defines `Module['loadcachedfiles']`, which opens the
`user` cache, walks every key beginning `/_/`, and registers each entry in the
engine's own file layer (`FTEH.f`). It is installed as `preRun` and nothing
re-reads the cache afterwards.

Three consequences, and they decide most of the import pipeline's design:

- **Boot must not merge cached files into `Module.files`.** The spec asks for
  it; the engine already does it. Doing both downloads the same bytes twice.
  `Module.files` therefore lists only the bundled site files.
- **An import needs a reload.** Writing the cache and then sending `playdemo`
  cannot work: the demo is in the cache and the cache will not be read again.
  The pipeline is honest about this — it says "reloading so the engine picks it
  up" and reloads.
- **A page cannot push bytes into a running engine.** The buffer-creating
  function `loadcachedfiles` uses (`_emscriptenfte_buf_createfromarraybuf`) is
  module-private, not on `Module`. Adding it to `EXPORTED_FUNCTIONS` would make
  runtime import possible and remove the reload; that is a small sixth patch
  and a good follow-up, but it is not needed for the spike. `vid_reloadtextures`
  without a reload has the same problem for the same reason — the file the
  engine would re-read is not in `FTEH.f`.

### Input has to be split between CSS and JavaScript

`ftejslib.js:600` registers mouse, wheel, touch and drag/drop on the **canvas**
in the capture phase. `#canvas { pointer-events: none }` takes the canvas out
of the event path entirely, so every gesture lands on the transparent `#frame`
above it and the game never sees a click — no pointer lock, no camera drag, and
drops reach the host page's own handler rather than FTE's.

`ftejslib.js:603-608` registers `keypress`/`keydown`/`keyup` on **`document`**,
also in the capture phase. CSS cannot help there, and a capture-phase guard of
our own would have to `stopPropagation()`, which kills the event before
app.js's arrow-key nudge (registered on `window`, and therefore reached on the
way back up). `boot.js` removes those three listeners by reference instead,
once `window.FTEC` exists. Without it Escape opens FTE's menu and `` ` `` its
console, over the editor.

### `+playdemo` at boot

Kept as a command-line argument, with a watchdog: if nothing has a rect eight
seconds after start, `boot.js` sends `playdemo <demo>` once through
`FTEC.cbufadd`, which cannot race the filesystem because the filesystem is up
by then.

Measured live (review run, 2026-08-01): **the command-line one fires** — the
demo is playing well before the watchdog's 8-second mark. What the first runs
actually tripped on was the *path*: a demo has two names. In `Module.files`
and the Cache API it is the FS path `qw/demos/foo.mvd`; to `playdemo` it is
relative to the active gamedir, so `demos/foo.mvd`. `playdemo
qw/demos/foo.mvd` finds nothing and the engine sits in its menu over the
map-less void; `playdemo demos/foo.mvd` plays. `boot.js`'s `demoCmdPath()`
strips the gamedir prefix in the three places a path becomes a command.

Until the demo starts, FTE's main menu is up over the stage. It closes itself
when playback begins; if it ever needs closing by hand, Escape will not reach
the engine (boot.js removed those listeners — see above), but
`FTEC.cbufadd('togglemenu\n')` from the console does it.

### Demo URLs / hub playback — stretch scope, untested

The picker has a "From a URL…" entry that fetches, caches and reloads. Whether
`hub.quakeworld.nu` (or any other host) allows it is entirely down to their
`Access-Control-Allow-Origin`, and `fetch` reports a CORS refusal as a bare
`TypeError` with no detail by design, so the page says what it usually means
and suggests downloading and dropping the file instead. **No CORS result is
recorded here because none was measured** — this environment does no browser
testing. Fill this section in from the browser console on the first real run.

## Parity gaps

What the FTE preview cannot show. The import drift panel reports the first two
per config; the rest are structural.

- **Elements.** FTE's ezhud registers a subset of ezQuake's. A config naming an
  element FTE does not have is kept verbatim and written back on export, and
  the panel names the element rather than silently dropping its settings.
- **`scr_newhud` / `cl_sbar` / `vid_con*`.** Applied, but `EZHud_StateJSON()`
  reports only per-element hud cvars, so nothing reads them back. The editor
  cannot show them and cannot re-export them from the engine.
- **`state.hud_modes` is absent**, so `model.modes` is null and the "HUD system"
  panel renders empty. That whole panel is dark on this backend.
- **Element defaults are absent**, so `model.resetChanges` is empty and the
  reset dialog always says nothing would change. `hud_reset_layout` is an
  ezQuake command and is not expected to exist in FTE's plugin either.
- **`spec_required` / `needs_pov` are hardcoded false**, so the tree's spec/pov
  badges never appear.
- **Fonts.** FTE has its own font system and no `fontload`; the adapter reports
  "no proportional font" truthfully rather than offering a picker that does
  nothing.
- **Palette.** The ezQuake bridge asks the engine, because a pak can replace
  the palette. FTE has no such export, so `core/quake-palette.js` is the id1
  palette baked in — correct unless a loaded pak replaces `gfx/palette.lmp`.
- **Saving is a download**, not a file the engine wrote: the export target is
  ezQuake, and the browser has nowhere else to put it. `/configs` therefore
  lists only what this session exported, and the overwrite warning is about
  that list.

## Verification

`npm run test:tier1` covers the JavaScript: `node --check` on everything under
`core/` and `fte/`, plus the unit tests including `core/tests/fte-adapter.test.js`
and `core/tests/fte-import.test.js`. Playwright tiers 3/4 are out of scope.

Tier 1 also builds and runs the libhud C tests, which needs a host C compiler.
This machine has none (no `cc`, and emsdk's clang has no libc headers to target
Linux with), so that half cannot run here and was not run.
