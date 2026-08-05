# ezHUD Release 1 — Trust the geometry

ezHUD now follows the browser window, reports the real size of the picture, and lets you pause a demo while you line up the HUD. Exports remain byte-compatible ezQuake configs, with untouched lines preserved byte-for-byte. A real-engine geometry matrix and the F9 session log provide sturdier ground for every change that follows.

## Features

### The game view follows your window
Resize the browser and the live game view grows or shrinks with it while every overlay handle stays on its element. The engine now reports both the virtual console size and the true backing-store pixels, so the editing-size readout cannot drift from the picture on screen.

Evidence: img/window-follow-focused-annotated.png

### Pause while you line things up
Pause and Resume now sit beside the demo selector, letting you stop on a quiet frame before adjusting the HUD. The control follows the engine's real state: pausing from the console updates its label, while a backend that cannot pause disables it with an honest reason.

Evidence: img/pause-resume-focused-annotated.png

## Discord payload

```json
{
  "content": "**ezHUD Release 1 — Trust the geometry**\n\nThe browser HUD editor now stays aligned as you resize and lets you stop the demo on the exact frame you want. Your exported ezQuake config remains compatible, and untouched lines still survive byte-for-byte.\n\nTry ezHUD: <https://xerialen.github.io/ezHUD/>\nFull release notes: <https://xerialen.github.io/ezHUD/release-1/release-notes.html>\nEvidence report: <https://xerialen.github.io/ezHUD/release-1/>",
  "embeds": [
    {
      "title": "The game view follows your window",
      "description": "Make the browser larger or smaller and the live game view follows it. Marker 1 identifies the canvas-size readout that updates from engine state.",
      "image": {
        "url": "attachment://window-follow-focused-annotated.png"
      }
    },
    {
      "title": "Pause while you line things up",
      "description": "Pause and Resume sit beside the demo selector. Marker 1 identifies the control whose label follows the engine's paused or running state.",
      "image": {
        "url": "attachment://pause-resume-focused-annotated.png"
      }
    }
  ],
  "allowed_mentions": {
    "parse": []
  },
  "attachments": [
    {
      "name": "window-follow-focused-annotated.png",
      "path": "img/window-follow-focused-annotated.png"
    },
    {
      "name": "pause-resume-focused-annotated.png",
      "path": "img/pause-resume-focused-annotated.png"
    }
  ]
}
```
