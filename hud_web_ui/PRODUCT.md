# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML/CSS/JS as ES modules, no build step (user's choice).

Architected for later replacement: a `core/` layer (engine client, coordinate
transform, selection and edit model, cfg generation) that never touches the DOM, and
a `view/` layer that is the only code allowed to. Swapping to a framework means
rewriting `view/` while `core/` survives. The boundary is a rule, not a convention:
`core/` must not reference `document` or `window`.

No build step also means the engine can serve the UI directly and anyone cloning the
fork can edit it without installing Node.

## Users

Competitive QuakeWorld players running ezQuake, on both Windows and Linux. Technical
enough to run a game client and edit a cfg, but not necessarily developers, and not
willing to install a toolchain or be told to "run a local server".

The first user is the project owner: a Div 1 player and caster who edits his own HUD
and maintains resolution-specific profiles.

## Product Purpose

Let a player arrange their HUD by eye — see it, drag it, toggle it, adjust it — and
end up with a cfg they can actually play with.

ezQuake ships an in-engine HUD editor (`hud_editor.c`, ~2800 lines on the engine's
2000s-era `ez_controls` widget toolkit). It has **no save-to-file capability at all**;
persistence depends on `cfg_save` or config-on-quit. The owner's assessment of the
experience as unusable is the reason this product exists.

## Positioning

The editor drives the real engine rather than modelling it.

ezQuake renders the frame and computes every element rect (`hud->lx/ly/lw/lh` via
`HUD_PrepareDraw`); the UI reads those over a loopback bridge and sends changes back
through the console. It never reimplements placement, so it cannot drift from the
engine.

The predecessor approach — reimplementing ezQuake's layout in JavaScript and drawing
an approximation on a canvas — was measured against the engine and diverged in four
ways (unmodelled `HUD_NO_GROW`, fractional positions the engine truncates, float
content sizes the engine truncates, and 50 of 83 elements reporting a fabricated
24x8 size). That is the mechanism this product exists to avoid, and it is why
"faithful" here is a structural property rather than a claim.

## Operating Context

ezQuake must be running, typically playing a demo, with the browser alongside. The
engine binds `127.0.0.1`, mints a token, and prints a URL; the user opens it.

Element rects exist **only while the engine is actually drawing that element**. At the
menu, nothing is drawn and every rect is absent. "Nothing is being drawn yet" is a
normal first-run state the interface must handle as a state, not an error.

Coordinates arrive in console pixels (e.g. 320x200) while the frame is physical (e.g.
1280x720). The UI is responsible for that transform.

## Capabilities and Constraints

Confirmed for the first version:

- select any of the 83 registered HUD elements, including hidden ones;
- drag and nudge position; toggle visibility;
- edit each element's registered parameters, driven generically from what the bridge
  reports, so all 83 elements are covered without a per-element table.

Save produces a file. Three outcomes were asked for, default first:

1. a new copy of the whole cfg, updated (default);
2. a cfg containing only the HUD elements;
3. overwrite the existing cfg.

**Built as two decisions, not three modes.** The engine has two commands — `cfg_save`
writes everything, `hud_export` writes only the `hud_*` cvars — and overwriting is not a
third command, it is what either one does when the name is already taken. So the dialog
asks what to write and what to call it, and surfaces overwrite as a consequence to
acknowledge. All three outcomes stay reachable and outcome 3 cannot be reached by
accident, which is what "deliberate rather than one click away" was protecting.

`cfg_backup` defaults to `0`, so the engine's own overwrite keeps nothing. The editor
turns it on before it lands on an existing file, and says so in the warning.

Durable constraints:

- Windows and Linux both, always.
- No user-facing "run a server" step; the engine is the endpoint and already running.
- Easy to install and start, for players who are not developers.
- Writes must never litter or modify the user's Quake gamedir as a side effect.
- A separate CLI exists as a secondary surface, intended to be driven by an LLM in
  natural language ("scale my HUD for 1080p"). It is not the primary interface.

Undecided: product name and whether this ships as an ezQuake feature or a
separately-named tool; accessibility commitments.

## Brand Commitments

**Conventional interface, deliberately chosen.** Offered a dealt visual direction and
alternates, the owner took the category standard: the familiar editor shape of an
element tree, a central canvas and a properties inspector. This is a standing
preference, not a fallback, and it is binding on future work: execute the convention at
full fidelity rather than smuggling in expression at its edges.

**Craft bar: the Chrome DevTools element inspector.** Chosen as the single reference
because it solves this exact problem — overlaying precise measurement on top of
rendered output the tool does not own. The bar to meet: hover-to-highlight that feels
instant, box-model readouts that are exact, editing a value and watching the render
respond, and a tree that stays usable at 83 entries.

Lives in the owner's `ezquake-source` fork, with the possibility of being proposed
upstream to the QuakeWorld developers. Any visual world should survive being read as
part of ezQuake rather than as a foreign application.

## Evidence on Hand

A real 1280x720 engine frame and a `/state` payload from a live session: 83 elements,
25 drawn, engine-computed rects in a 320x200 console space. Both are checked in as
design fixtures so the interface is designed against actual engine output rather than
mockups.
