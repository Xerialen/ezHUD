# ezHUD Release 1 — "Trust the geometry"

*2026-08-04 · epic #39 · evidence: [docs/release-1/index.html](index.html)*

What's new for you as a player:

- **The editor finally follows your window.** Resize the browser and the game
  view grows and shrinks with it, and every overlay handle stays exactly on
  its element. Before this release the game view silently stayed at whatever
  size the page booted at — on a big monitor you got a small frozen picture
  and, after any resize, subtly misplaced editing handles.
- **Pause the demo while you edit.** A Pause button sits next to the volume
  control. Pause, line up your HUD against a quiet scene, resume. The button
  always shows what the engine is actually doing — if you pause from the
  console instead, the button flips by itself; if a backend can't pause, the
  button says so instead of pretending.
- **Sharper resolution honesty.** The engine now reports both its virtual
  console size and the true pixel size of the picture, so the "editing at
  … · 1 px = N× on screen" readout (and everything built on it) can't drift
  from reality.
- **Sturdier ground under every future change.** Each release is now gated by
  a 12-cell geometry matrix run against the real engine — element containment,
  resize proportionality (with a measured, non-fake ratio), edge alignment,
  and byte-identical config round-trips — plus a session log (press F9) that
  makes "something felt off" reportable with one copy-paste.

Nothing about your configs changes: exports remain byte-compatible ezQuake
configs, and untouched lines still survive byte-for-byte.
