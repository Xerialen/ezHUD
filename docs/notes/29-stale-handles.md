# Issue 29: stale FTE handles

## Evidence available in this checkout

The assembled engine glue is not tracked in this repository. The development assembler copies
`ftewebglcl.js` and its wasm from a sibling FTE release directory into the site
(`tools/fte-web/assemble.sh:17-19`, `tools/fte-web/assemble.sh:48-60`), and the public assembler does
the same from `ENGINE_DIR` (`tools/fte-web/assemble-public.sh:22-24`,
`tools/fte-web/assemble-public.sh:95-102`). Consequently this checkout cannot establish which
Emscripten abort/restart or FTE video-restart path ran in the live incident.

The checked-in engine patch does establish one important hand-off: while FTE's JavaScript event
callbacks are being installed, `ftejslib.js` assigns its current `FTEC` object to `window.FTEC`
(`spikes/fte-web/fteqw.diff:52-63`). The same patch exports `UTF8ToString`, `_malloc`, and `_free`
for the page command/state bridge (`spikes/fte-web/fteqw.diff:5-10`). The plugin state function is
compiled into the wasm instance and returns from an instance-owned static buffer
(`spikes/fte-web/fteqw.diff:128-142`).

## Verified page lifecycle

`index-fte.html` runs the classic boot script before the editor and chrome modules
(`hud_web_ui/index-fte.html:158-167`). Boot constructs one initial `Module` literal and publishes it
once as `window.Module` (`hud_web_ui/fte/boot.js:131-222`). Its `begin()` guard injects one
`ftewebglcl.js` script element (`hud_web_ui/fte/boot.js:226-239`), and the only normal call to
`begin()` is the final autostart check (`hud_web_ui/fte/boot.js:365-367`). The watchdog's demo retry
only sends `playdemo` through the current command channel; it neither creates a script nor calls
`begin()` (`hud_web_ui/fte/boot.js:323-335`). A second runtime therefore is not created by the
retry or by another explicit boot path in this page.

State and commands are two separate instance-bearing handles. State calls execute
`_EZHud_StateJSON` and `UTF8ToString` on a `Module` (`hud_web_ui/fte/boot.js:244-253`), while commands
execute `cbufadd` on an `FTEC` (`hud_web_ui/fte/boot.js:328-332`,
`hud_web_ui/fte/boot.js:354-361`). The live observation records exactly the split failure expected
if those handles refer to different generations: stale `rect: null` state and ineffective command
writes while a newer canvas continues drawing (`spec-29.md:12-16`).

The editor adapter was already mostly resilient: its module and command getters fall back to the
globals on every call (`hud_web_ui/core/fte-adapter.js:185-191`), and polling continues after a
not-ready state rather than treating it as permanent denial (`hud_web_ui/core/fte-adapter.js:280-287`).
Its only optional pinned engine handle is the constructor's injected `this.engine`
(`hud_web_ui/core/fte-adapter.js:141-146`). The replacement listener now drops that handle, the last
instance state, and the boot-argument seed latch while preserving user-session export data
(`hud_web_ui/core/fte-adapter.js:154-173`).

Chrome does not cache `window.Module` or `window.FTEC`. It caches the stable `EZHUD_FTE` facade and
uses `host.play()` for demos (`hud_web_ui/fte/chrome.js:15-19`,
`hud_web_ui/fte/chrome.js:65-72`); volume writes go through the current editor Bridge
(`hud_web_ui/fte/chrome.js:114-118`). No chrome control held an engine handle that needed replacing.

## Plausible second-instance paths

The following are hypotheses because the assembled glue and the upstream engine sources used for
the deployed build are absent from this checkout.

1. **Emscripten recovery/re-entry hypothesis.** An abort/restart path outside `boot.js` may create a
   new wasm runtime and reach the callback/canvas setup again. Reaching that setup would publish a
   new `FTEC` identity because the patched setup assigns its local object to `window.FTEC`
   (`spikes/fte-web/fteqw.diff:52-63`). Boot itself cannot account for the extra evaluation because
   its only script injection is guarded and singular (`hud_web_ui/fte/boot.js:226-239`).

2. **FTE video-restart hypothesis.** An engine-internal restart may recreate the JavaScript canvas
   callback object without re-running page boot. `vid_restart` is a command understood by the FTE
   adapter (`hud_web_ui/core/fte-adapter.js:36-39`), and `FTEC` publication occurs in the callback
   setup hunk (`spikes/fte-web/fteqw.diff:52-63`), but this checkout does not contain the implementation
   needed to prove that `vid_restart` re-enters that hunk. The editor UI has no production call site
   for `vid_restart`; its occurrence in the adapter is an allowlist entry, not evidence that the UI
   triggered the live restart (`hud_web_ui/core/fte-adapter.js:36-39`).

3. **Whole-glue re-evaluation hypothesis.** Some external recovery code may evaluate
   `ftewebglcl.js` again, producing a new wasm `Module` as well as a new `FTEC`. This page has no such
   second injection (`hud_web_ui/fte/boot.js:226-239`), so proving this path requires the missing
   assembled glue. If it occurs, the new page resolver will observe a replaced `window.Module`; if
   Emscripten instead keeps the new module private and replaces only `window.FTEC`, the page cannot
   recover state from a global the glue never publishes. The checked-in patch explicitly publishes
   `FTEC` but contains no corresponding `window.Module` assignment
   (`spikes/fte-web/fteqw.diff:52-63`).

All three hypotheses produce the same handle-lifetime hazard: JavaScript closures can retain the
old objects after the native runtime they address has stopped, while `window.FTEC` can point at the
new object published during setup (`spikes/fte-web/fteqw.diff:52-63`). The exact trigger remains
unproven; the page-side correction therefore keys off observable handle identity instead of trying
to predict an engine restart path.

## Page-side correction and `app.js`

Boot now has one call-time resolver for both globals (`hud_web_ui/fte/boot.js:90-97`), exposes that
resolver on the stable facade (`hud_web_ui/fte/boot.js:340-344`), and uses it for state, keyboard
listener removal, retry commands, and picker commands (`hud_web_ui/fte/boot.js:244-265`,
`hud_web_ui/fte/boot.js:298-335`, `hud_web_ui/fte/boot.js:354-361`). The watchdog compares non-null
`FTEC` identities, emits one replacement event and warning per new identity, and derives `drawn`
from live state before clearing or refreshing the status (`hud_web_ui/fte/boot.js:293-321`). It also
replaces the retry message with a failure after ten further seconds without a rect
(`hud_web_ui/fte/boot.js:327-335`).

No `app.js` change is needed. It constructs the mapped Bridge once and continuously refreshes state
through that Bridge (`hud_web_ui/view/app.js:28-46`); the adapter and boot facade are the layers that
own engine-handle resolution (`hud_web_ui/core/fte-adapter.js:185-191`,
`hud_web_ui/fte/boot.js:90-97`).
