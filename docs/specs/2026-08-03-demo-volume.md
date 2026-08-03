# Spec: demo mute button + subtle volume control (#10)

Owner intent: the demo behind the editor plays at full blast with no control.
Add a mute toggle and a subtle volume slider to the FTE bar, and cut the
default playback volume hard (owner: "cut the default volume of the mvd by
300%" — read as: about a third of what it was; FTE's engine default is
`volume 0.7`, the new editor default is **0.175** (4× lower than 0.7, owner decision), one constant, trivially
adjustable).

Scope: the FTE page only (`index-fte.html` + `fte/`). The ezQuake-bridge dev
page has no audio path — frames come over HTTP; nothing to mute.

## UI (`hud_web_ui/index-fte.html` + `hud_web_ui/fte/chrome.js`)

- In `.fte-bar`, after the demo picker: a mute button (speaker glyph, `aria-pressed`,
  two inline SVG symbols in the existing sprite block: `i-sound` / `i-muted`)
  and `input[type=range]` 0–1 step 0.05, class kept small/subtle in `fte/fte.css`
  (that file is ours to edit — ui.css is NOT, per the comment in index-fte.html).
- Behaviour (all in `fte/chrome.js`, which already talks to the shared adapter):
  - slider input → `volume <v>` via the adapter (`setCvar('volume', v)`),
    throttled with requestAnimationFrame-style coalescing like drag writes if
    trivially reusable; a plain 'change'+'input' listener is acceptable.
  - mute click → remember current slider value, send `volume 0`, flip icon;
    unmute → restore remembered value (never restore to 0 — fall back to 0.175).
  - moving the slider while muted unmutes.
- Persistence: `localStorage` keys `ezhud.fte.volume` and `ezhud.fte.muted`.
  On boot, chrome.js applies the stored state as soon as the engine is live
  (reuse the existing engineLive/poll hook it uses for the demo picker).

## Default (`hud_web_ui/fte/boot.js`)

- Launch args gain `+volume 0.175` — unless localStorage holds a value, in which
  case that value (or `0` when muted) is used. Keep the arg next to
  `+scr_newhud 1` with a comment naming the owner decision.

## Allowlist + export honesty (`hud_web_ui/core/fte-adapter.js`)

- `commandAllowed`: accept exact cvar `volume` (NOT a prefix).
- `volume` must NOT enter the ledger, `cvarSnapshot()`, or any export path:
  it is editor chrome, not HUD state. An imported cfg containing a `volume`
  line is retained verbatim and NOT applied (do not add it to APPLY_EXACT) —
  the user's exported config keeps their own line untouched, and the preview
  keeps the editor's volume.

## Tests

- `core/tests/fte-adapter.test.js`: `volume` allowed; `volumefoo`/`vol` refused;
  `volume` absent from `cvarSnapshot()` and from the appended-export block even
  after `setCvar('volume', …)`.
- `tools/tests/tier3_fte.mjs`, new case: mute button sends `volume 0` via
  cbufadd and flips `aria-pressed`; unmute restores the prior value; slider
  sends `volume 0.4`; localStorage carries volume+muted across a reload
  (the harness already reloads pages — if a reload subcase is awkward, assert
  the keys are written and read instead); an imported cfg line `volume "1"` is
  NOT applied (engine stays at the editor's volume) and survives export
  byte-identical; boot args contain `+volume 0.175` when storage is empty.
- No index.html / embed changes ⇒ no `hud_web_assets.c` regen; no new files ⇒
  no dist-allowlist changes (verify tier1 passes untouched).

## Out of scope

- ezQuake-bridge page audio (none exists).
- Per-demo volume memory, fade curves.
