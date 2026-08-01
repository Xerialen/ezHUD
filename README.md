# ez-hud

A HUD editor for [ezQuake](https://github.com/QW-Group/ezquake-source), served by the
engine itself.

Run `hud_web 1` in the console and ezQuake prints a URL. Open it and you get a live
picture of your own game with every HUD element outlined: drag them, resize them from
the corners, recolour them, group them, switch between ezQuake's several HUD systems,
and save the result as a config. There is no second process to install and no folder
of files to keep next to the binary — the editor is compiled into the engine.

The editor never reimplements HUD placement. Every rectangle it draws a handle on is
the engine's own `hud->lx/ly/lw/lh`, and every change goes back through the console.
The engine stays the single source of truth for both geometry and rendering, which is
the whole reason for this approach over a standalone tool that would have to model
ezQuake's placement rules and inevitably drift from them.

**Status:** working and independently reviewed, not yet merged upstream. See
[Known gaps](#known-gaps) for what is known to be unproven.

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
    bridge.js        HTTP client, token handling, save semantics
    geometry.js      console ↔ physical ↔ display transforms
    model.js         editor state derived from engine state
  view/app.js        the only DOM writer
  fixtures/          a real /state capture and frame, for offline work
engine/
  src/hud_web.c            transport: listener, HTTP parse, auth, routing, allowlist
  src/hud_web_state.c      payload: /state, /frame.png, /fonts, /configs, /palette
  src/libhud/              placement core extracted from hud.c, with tests
  tools/                   the embedding script
  engine-integration.diff  changes to files ezQuake already has
docs/PROTOCOL.md     the bridge contract; read before changing an endpoint
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
npm run test:tier1        # placement core, editor logic, baked-UI freshness
npm run test:tier2:js     # bridge client against a local HTTP stub
npm run test:tier3        # the DOM, headless Chromium, against the fixture
npm run test:tier2:engine # bridge security contract   (needs a built engine)
npm run test:tier4        # full end-to-end            (needs an engine + a demo)
```

The first three need nothing but Node and a browser, and run on every push and pull
request. The last two need `EZQUAKE_BIN` and an isolated Quake tree; they exit `2`
with a clear message rather than passing when those are absent.

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
- Neither test host has a working GPU: one had its card removed, the other renders
  through llvmpipe under WSL. Everything is therefore verified on software GL, where
  a capture costs most of a second instead of a few milliseconds.

## License

GPL-2.0, matching ezQuake. This contains and derives from ezQuake source.
