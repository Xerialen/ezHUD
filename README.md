# ezHUD

**Edit your Quake HUD by dragging it — on a live game, in your browser.**

Every QuakeWorld player has been through it: tuning a HUD means memorizing
dozens of `hud_*` cvars, typing coordinates into the console, squinting at the
result, and repeating until it stops being wrong. ezHUD replaces that loop.
You get a live picture of the actual game with every HUD element outlined —
health, armor, ammo, clocks, trackers, all ~74 of them. Drag them where you
want them. Resize from the corners. Click a colour and pick from the real
Quake palette. Group elements so they move together. When it looks right, hit
Save and you have a normal ezQuake config, byte-compatible with the one you
already run.

**Try it right now, nothing to install:** <https://xerialen.github.io/ezHUD/>
— a full Quake engine boots in the tab and plays a demo behind the editor.
Drop your own `config.cfg` on the page and it applies instantly, with a report
of exactly what applied; drop your texture pk3s and `.mvd` demos too, and edit
*your* HUD over *your* frag movie. Export writes back a config where every
line you didn't touch survives byte-for-byte.

What you never have to think about, because the tool does:

- **What a pixel is worth.** The HUD lives in console pixels; your screen
  doesn't. The editor shows "editing at 853×480 · 1 px = 2.25× on screen" and
  warns you when your setup is stretching the layout.
- **Which cvar means what.** Every drag and toggle *is* a cvar change,
  written through the engine's own console — the inspector shows the values,
  and parameters the engine would currently ignore are marked as such instead
  of silently doing nothing.
- **Losing your config.** Overwrites warn first, backups are handled, and
  nothing is written until you say so.

## Two ways to run it

- **In the browser (FTE-web).** The deployed instance above. FTEQW compiled
  to WebAssembly plays a demo behind the editor UI; everything stays in your
  browser, and the export is an ezQuake config.
- **Inside ezQuake itself.** Run `hud_web 1` in the console and the engine
  prints a URL; open it and edit your real, running game. No second process,
  no folder of files next to the binary — the editor is compiled into the
  engine.

The editor never reimplements HUD placement. Every rectangle it draws a handle on
is the engine's own layout, and every change goes back through the console. The
engine stays the single source of truth for both geometry and rendering, which is
the whole reason for this approach over a standalone tool that would have to model
ezQuake's placement rules and inevitably drift from them.

**Status:** the ezQuake backend is working and independently reviewed, not yet
merged upstream. The FTE-web backend shipped from a spike
([`spikes/fte-web/`](spikes/fte-web/) — spec, findings, parity evidence) and is
deployed. See [Known gaps](#known-gaps) for what is known to be unproven.

---

## Architecture

```
        ezQuake process                              browser
 ┌──────────────────────────────────┐        ┌────────────────────────┐
 │  HUD subsystem (hud.c, hud_*.c)  │        │   hud_web_ui/          │
 │      83 registered elements      │        │                        │
 │              ▲                   │        │   core/   pure logic,  │
 │              │ cvars via Cbuf    │        │           no DOM       │
 │  ┌───────────┴───────────────┐   │        │   view/   the only     │
 │  │ hud_web.c    transport    │◄──┼─ HTTP ─┼─►         DOM writer   │
 │  │ hud_web_state.c  payload  │   │  loop- │                        │
 │  │ hud_web_assets.c  the UI, │   │  back  │  served from the       │
 │  │              baked in     │   │ +token │  engine's own memory   │
 │  └───────────────────────────┘   │        └────────────────────────┘
 │   serviced once per frame,       │
 │   next to Sys_ReadIPC()          │
 └──────────────────────────────────┘
```

The bridge must be serviced **after** the frame has rendered. `/state` reports an
element's rect only when its draw stamp matches the current screen-update count, so
building the payload before the render makes every one of the 83 elements report
`rect: null` — the editor answers, captures a frame, and draws no boxes at all. That
mistake was made and reverted here; tier 4 is what caught it.

### The three boundaries that matter

**Engine ↔ browser is a loopback HTTP bridge.** It binds `127.0.0.1` explicitly and
never `INADDR_ANY`, and every request that touches the engine carries a 128-bit token
minted at startup. Binding to localhost is *not* an authorization boundary — any page
the user visits can reach `127.0.0.1` — so the token is the real one. The service is
non-blocking and runs once per client frame beside `Sys_ReadIPC()`; the engine is
single-threaded and the bridge must never stall the render loop.

`POST /cmd` feeds `Cbuf_AddText`, which can do anything the console can, so it is
gated by an allowlist. That allowlist is narrower than it looks and the reasons are
recorded in `HUD_Web_CommandAllowed` — several are non-obvious enough that removing a
check "because it looks redundant" would reopen a real hole. Two examples: `$` is
refused because `Cmd_ExpandString` runs *after* the check, and an allowlisted name
must also exist as a real command, because otherwise the dispatcher falls through to
whatever alias the user happens to have under that name.

**`core/` ↔ `view/` is a no-DOM boundary.** Everything in `hud_web_ui/core/` is pure:
placement maths, resize transfer ratios, colour parsing, the model. It never touches
`document`, which is what makes it testable without a browser and replaceable without
a rewrite. `view/app.js` is the only file allowed to write to the DOM.

**The FTE-web backend swaps the transport, not the editor.** `index-fte.html`
uses an import map to resolve `core/bridge.js` to `core/fte-adapter.js`, so
`view/app.js` ships byte-identical between backends. The adapter speaks to an
in-page wasm FTEQW (built with the ezhud plugin plus ~150 lines of C exports,
patches in `spikes/fte-web/fteqw.diff`): state comes from an
`EZHud_StateJSON()` export, commands go through the same allowlist shape as the
HTTP bridge, and "save" is a download of the reconstructed ezQuake config. The
host page's own chrome (demo picker, drop-zone imports, the drift report that
names everything the preview cannot show) lives in `hud_web_ui/fte/` and never
touches `view/`.

**The UI is one design system, shared by both backends.** The visual language
(the EZHUD overhaul, issue #5) is a token system in `ui.css`: colours sampled
from the id1 palette (warm soot neutrals, one ember accent reserved for the
committing action), Space Grotesk for the interface and JetBrains Mono for
every value the engine owns, near-zero radii, a scanlined top bar and a
checker stage. The shell is a three-pane editor — family-tinted element tree,
the game render as the hero, an inspector — under a top bar with the scale
readout and over a status bar with the live console-space cursor. The design
source is the mockup in `docs/mockups/gui-overhaul.html`; `fte/fte.css` only
ever *adds* page-specific chrome on top of the shared tokens.

**The UI is a build artifact that is committed.** `tools/embed_hud_web_ui.py` bakes
`hud_web_ui/` into a generated C file. That keeps the Windows and Linux builds free of
any new build-time dependency — nothing but a C compiler is needed, same as before —
at the cost of having to regenerate after every UI edit. CI checks freshness with
`--check`.

### Coordinate spaces

The single largest source of bugs in this project. ezQuake reports HUD rects in
**console pixels** (`vid_conwidth` × `vid_conheight`, e.g. 512×288) while the frame it
renders is **physical** (e.g. 2560×1440), and the browser then draws that image at
some third **display** width. `core/geometry.js` owns all three and is the only place
allowed to convert between them.

`vid_conwidth` and `vid_conheight` are independently configurable, so the horizontal
and vertical ratios are **not** always equal. Anything positional must use
`scaleFactors()` and apply `kx` and `ky` separately. A single-ratio shortcut is
invisible at 512×288 on 2560×1440 — both ratios are 5 — and wrong for everyone else.
It has caused two separate defects already.

### Repository layout

```
hud_web_ui/          the editor
  core/              pure logic — no DOM access, ever
    bridge.js        HTTP client, token handling, save semantics (ezQuake backend)
    fte-adapter.js   same interface, wasm transport (FTE-web backend)
    geometry.js      console ↔ physical ↔ display transforms
    model.js         editor state derived from engine state
  view/app.js        the only DOM writer, byte-identical on both backends
  fte/               FTE host page: boot, imports, demo picker, drift report
  index-fte.html     the FTE page; its import map is the whole backend swap
  fixtures/          a real /state capture and frame, for offline work
engine/
  src/hud_web.c            transport: listener, HTTP parse, auth, routing, allowlist
  src/hud_web_state.c      payload: /state, /frame.png, /fonts, /configs, /palette
  src/libhud/              placement core extracted from hud.c, with tests
  tools/                   the embedding script
  engine-integration.diff  changes to files ezQuake already has
tools/fte-web/       dev-site assembly, the sanitized public build, its pins
spikes/fte-web/      the FTE spike: SPEC, NOTES, PARITY evidence, fteqw.diff
docs/PROTOCOL.md     the bridge contract; read before changing an endpoint
docs/DESIGN-BRIEF.md the GUI overhaul brief (issues #5–#7)
docs/FONTS.md        how fonts, proportional and the charset interact (issue #8)
docs/mockups/        the design source the UI is built from
```

The engine-side files live under `engine/` because they are not a standalone program —
they are files that belong in an ezQuake checkout.

---

## Runbook

### Building it into ezQuake

This repository is not buildable on its own. To get a working binary:

```bash
git clone https://github.com/QW-Group/ezquake-source
cd ezquake-source

# 1. Drop the bridge and the UI in. ezQuake has no tools/ of its own.
mkdir -p tools
cp -r  /path/to/ez-hud/hud_web_ui        .
cp     /path/to/ez-hud/engine/src/*.c    src/
cp     /path/to/ez-hud/engine/src/*.h    src/
cp -r  /path/to/ez-hud/engine/src/libhud src/
cp     /path/to/ez-hud/engine/tools/*.py tools/
cp -r  /path/to/ez-hud/tools/tests       tools/    # optional: the test suite
cp     /path/to/ez-hud/package.json      .         # optional: its entry points

# 2. Apply the changes to files ezQuake already has.
git apply /path/to/ez-hud/engine/engine-integration.diff

# 3. Generate the baked-in UI, then build as normal.
python3 tools/embed_hud_web_ui.py
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
```

CI performs exactly these steps against a fresh upstream clone on every change, so
the runbook is executable documentation rather than a description that drifts.

The patch touches `CMakeLists.txt` (compiles the three bridge files), `hud.c` (adds
`hud_reset_layout`), `cl_main.c` (calls
`HUD_Web_Frame`), `image.c`/`image.h` (adds an in-memory PNG encoder), and several
`hud_*.c` files that gained correct `HUD_NEEDS_POV` flags.

### Running it

```
hud_web 1
```

The engine prints `HUD bridge: editor at http://127.0.0.1:27700/?t=<token>`. Open it.
The editor can only place elements the engine is actually drawing, so join a server or
play a demo first — otherwise it correctly tells you there is no HUD to edit.

| cvar | default | what it does |
|---|---|---|
| `hud_web` | `0` | opt-in; `0` closes the listener and invalidates the token |
| `hud_web_port` | `27700` | loopback port |
| `hud_web_frame_interval` | `250` | minimum ms between frame captures, shared across clients |

`hud_web*` cvars are deliberately **not** settable through the bridge itself.

### The FTE-web editor

The deployed instance is <https://xerialen.github.io/ezHUD/> — open it, wait a
few seconds for the wasm engine to boot into the bundled demo, then drop your
own `config.cfg`, a pk3/zip of textures, or an `.mvd` anywhere on the stage.
Imports persist in the browser's cache; the drift report under the stage names
every line the preview could not apply, and export writes them all back.

Locally there are two builds:

```bash
tools/fte-web/assemble.sh        # dev site: symlinks into hud_web_ui/, uses ../site
tools/fte-web/serve.sh           # serve it from the site root (the import map needs that)

tools/fte-web/stage-game-data.sh    # seed ../game-data from the dev site (allowlisted names only)
tools/fte-web/assemble-public.sh    # the deployable dist/ — built from an explicit allowlist
tools/fte-web/serve-public.sh       # serve dist/ under the /ez-hud/ prefix Pages uses
```

The engine itself is built from a pinned FTEQW commit plus
`spikes/fte-web/fteqw.diff` (`make webcl-rel` under emsdk;
`spikes/fte-web/NOTES.md` records every trap, starting with why you must
`unset CFLAGS CXXFLAGS LDFLAGS` first).

**Publishing is CI's job, not a hand-run.** `.github/workflows/pages.yml`
builds the engine from source, downloads every game-data file against sha256
pins (`tools/fte-web/game-data.sha256`), assembles the dist from the allowlist,
runs the test tiers against the exact artifact, and deploys on `main`. Nothing
is ever copied out of the dev site: the sanitization is structural
(`spikes/fte-web/PUBLISH.md` argues why), and a guard test fails the build on
any extra *or* missing file — registered Quake data and personal configs cannot
reach a deploy by construction.

### After changing the UI

```bash
python3 tools/embed_hud_web_ui.py          # regenerate
python3 tools/embed_hud_web_ui.py --check  # what CI runs; fails if stale
```

Forgetting this is the most common way to be confused by a change that appears to do
nothing: the engine serves the *generated* file, not your edited source.

### Testing

Four tiers, split by determinism and cost. `docs/TESTING.md` is the full spec.

```bash
npm run test:tier1        # placement core, editor logic, baked-UI freshness, public-dist guard
npm run test:tier2:js     # bridge client against a local HTTP stub
npm run test:tier3        # the DOM, headless Chromium, against the fixture
npm run test:tier3:fte    # the FTE page against a scripted fake engine (no wasm)
npm run test:tier4:fte    # the assembled public dist, end to end in a real browser
npm run test:tier2:engine # bridge security contract   (needs a built engine)
npm run test:tier4        # full end-to-end, ezQuake   (needs an engine + a demo)
```

The first five need nothing but Node and a system Chrome (both FTE lanes launch
it via Playwright's `channel: 'chrome'` — no browser downloads), and run on
every push and pull request; tier 4F additionally wants an assembled `dist/`
and is the deploy gate in `pages.yml`. The last two need `EZQUAKE_BIN` and an
isolated Quake tree; they exit `2` with a clear message rather than passing
when those are absent.

Tiers 1–3 lean on `hud_web_ui/fixtures/state.json`, a real capture from a live
engine: 83 elements, 25 of them drawn, a 320×200 console on a 1280×720 framebuffer.
Those dimensions are deliberate — the horizontal and vertical ratios are 4.0 and
3.6, so any coordinate assertion fails the moment someone reintroduces a
single-ratio shortcut. A square fixture would hide the largest class of bug in this
project.

Tier 2's engine half is where the security rules are enforced, and it tests the
**negatives**: that `$` expansion is refused, that a name existing only as a user
alias is refused, that a token stale after `hud_web 0` is refused, that `hud_web*`
cannot be set through the bridge, and that `hud_export` cannot escape the configs
directory. A change to the allowlist without a change here is incomplete.

### End-to-end testing, and one hard-won warning

Driving the real thing needs a running engine and a browser. **Use Playwright, not
hand-rolled CDP.** On at least one test host, raw `Input.dispatchMouseEvent` delivers
nothing to the page while keyboard events work fine and CDP reports no error — a
hand-rolled harness will confidently tell you the product is broken when it is not.
That cost a great deal of time chasing a bug that did not exist.

Whatever harness you use, **run a control interaction first**: click something known
to work and assert it took effect. If the control fails, every negative result in that
run is worthless.

Run headless under Xvfb rather than a real display server where you can — a display
that vanishes mid-run looks exactly like an engine crash in whatever you just changed.

### Validating a change

Match the evidence to the change, and do not report "done" without it:

- **Bridge or engine code** — build it, run it, exercise the endpoint. Security
  changes need the negative case proven too: assert that what should be refused *is*
  refused, not merely that the allowed path still works.
- **`core/` logic** — the pure tests, against the fixture.
- **Anything visual** — screenshots of the affected states, at a console size whose
  aspect ratio differs from the screen's. Equal ratios hide an entire class of bug.

---

## Known gaps

Honest list; none believed to be dangerous.

- The frame rate limiter now has a test, but it only proves the 503 and its
  `Retry-After`. On a software renderer a capture takes longer than the interval, so
  the limiter never actually binds; `250` may be too low to be meaningful on a GPU.
- Percentage-sized elements (`radar` ships `width "30%"`) are correctly refused a
  corner drag. Tier 3 covers it against the fixture, but no live engine has been seen
  to ship a percentage-sized element — the lab config overrides `radar` to absolute.
- `hud_export ..` writes a file literally named `..cfg` inside the configs directory.
  Contained junk; traversal itself is tested and does not escape.
- A placement cycle (`group1` → `group2` → `group1`) leaves both elements undrawable.
  The engine stays stable, the tree still lists them, and it is recoverable — but the
  place picker will happily let you create one.
- A non-null `rect` means "the engine laid this element out this frame", not "you can
  see it". `HUD_PrepareDraw` stamps its sequence before the caller draws any pixels,
  and some elements call it before their own visibility condition. Making it stronger
  would need every draw function to signal completion.
- The self-hosted engine tiers (2-engine and 4) are re-enabled and green.
  Tier 4 runs on the host's real GPU when the runner sets
  `EZHUD_USE_DISPLAY` (falling back to Xvfb software rendering otherwise),
  and `tier4.sh` seeds `cl_onload console` into the test basedir — the
  engine reads that cvar before the command line's `+set` queue executes,
  so a fresh basedir would otherwise open the menu over the demo and no
  HUD element would ever get a rect.
- The FTE-web preview has known parity gaps against real ezQuake, all named in
  [`spikes/fte-web/PARITY.md`](spikes/fte-web/PARITY.md): FTE renders its own
  fonts, ten elements have no preview (the drift report lists them per config
  and the export cannot lose them), `teaminfo`/`face` place differently, and
  per-element colour tints drift in places. The verdict there is "go, with
  caveats", and the caveats are the ticket backlog.

## License

GPL-2.0, matching ezQuake. This contains and derives from ezQuake source; the
FTE-web backend builds on FTEQW (GPL-2.0, patches in
`spikes/fte-web/fteqw.diff`). The deployed site additionally ships shareware
Quake 1.06 game data, nQuake community content including GPL map remakes, and
a subset of the Quake Retexturing Project's textures (redistribution with
attribution — their readme rides inside the pk3); every one of those files is
hash-pinned in `tools/fte-web/game-data.sha256` with its source recorded.
