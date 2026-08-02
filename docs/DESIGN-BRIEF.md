# ezHUD — design brief (GUI overhaul, issues #5–#7)

**What it is.** A single-page editor where a live Quake demo plays in the
center and every HUD element (health, armor, ammo, clocks, trackers — ~74 of
them) can be selected, dragged, resized and configured on top of the running
game. Users are competitive Quake players customizing their in-game interface;
the output is a config file for the real game engine. A wasm build of the
engine renders the actual game behind the editor, so what you see is what you
get. Live reference: https://xerialen.github.io/ezHUD/

**Overall shape today (to be redesigned).** Dark three-column layout: element
tree (left), game stage (center), inspector with placement/parameter fields
(right). A header bar holds status and Save. Below the stage: a demo picker, a
file-drop hint, and a collapsible "import report". It works but reads as
developer tooling — raw telemetry, hint-text-as-UI, layout rows that pop in
and out.

## Design goals

1. **The game is the hero.** The stage should dominate; panels support.
   First-time visitors must understand within seconds that elements on the
   game screen are directly draggable, and that dropping files on the page
   imports them.

2. **Make scale legible — one real model, not three numbers** (issue #6).
   Everything is positioned in "console pixels", which map to screen pixels by
   a factor per axis. Today the header dumps
   `canvas 853×480 render 1920×1080 scale 2.25×/2.25×`. Design a single
   readable presentation: *"editing at 853×480 · 1 px = 2.25 on screen"*,
   expanding only when horizontal and vertical factors differ — because then
   the layout is stretched and the user must notice. It should update smoothly
   on window resize (no flash of empty state), and the inspector should be
   able to answer "how big is this element actually on screen, and why".

3. **Make importing your own stuff a visible, reversible feature** (issue #7).
   Users bring three kinds of files: a config (applies instantly, produces a
   report), texture packs (.pk3/.zip — needs a page reload), and demos (.mvd).
   Design: an explicit Import button beside drag-and-drop; inline guidance on
   what an archive must contain (a game-directory root: `textures/wad/…`,
   `textures/charsets/…`, `crosshairs/…`); a manageable list of everything
   currently imported with per-item remove; one "reset to a clean engine"
   action; and post-import feedback ("charset loaded, 14 wad images replaced")
   instead of leaving the user to eyeball the render. The reload step should
   feel intentional, not abrupt.

4. **Honest reporting, promoted.** After a config import, a report says what
   applied, what has no preview, and what is carried through untouched
   (nothing is ever silently dropped). Today it is a collapsed details-box;
   give it a real place — a dismissible summary with drill-down.

5. **States to design for:** engine booting (takes seconds — needs a calm
   loading state, currently shows a misleading "not responding"), no HUD drawn
   yet, element selected vs nothing selected, drag in progress (live
   coordinates), import in progress, import report, error (bad file).

## Constraints

Dark theme fits the audience; monospace accents are on-brand but should not
carry the whole UI. Desktop-first (this is a PC game). The center canvas
renders the game and cannot be styled, only framed and sized (16:9). Keep the
tree filterable — 74 elements. No accounts, no server: everything lives in
the browser. Implementation constraint that survives any redesign:
`view/app.js` ships byte-identical between the ezQuake and FTE backends, and
`core/` never touches the DOM; FTE-only chrome lives in `hud_web_ui/fte/`.
