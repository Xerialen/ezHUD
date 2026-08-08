# ezHUD Release 1 — Trust the geometry

ezHUD now follows the browser window, reports the real size of the picture, and lets you pause a demo while you line up the HUD. Exports remain byte-compatible ezQuake configs, with untouched lines preserved byte-for-byte. A real-engine geometry matrix and the F9 session log provide sturdier ground for every change that follows.

## Features

### The game view follows your window
Before: Resizing the browser could leave the game view at its boot size and overlay handles out of alignment.
After: The live game view grows or shrinks with the browser, every overlay handle stays on its element, and the engine reports both virtual console size and true backing-store pixels.
Value: The editing-size readout and the HUD stay aligned with the picture on screen.
Evidence: img/window-follow-focused-annotated.png

### Pause while you line things up
Before: The editor had no Pause or Resume control, so lining up the HUD meant waiting for a useful demo frame.
After: Pause and Resume sit beside the demo selector and follow the engine's real state, including console changes and an honest disabled reason on unsupported backends.
Value: You can stop on a quiet frame and adjust the HUD without losing the moment you wanted.
Evidence: img/pause-resume-focused-annotated.png

## Changedrop declaration

```json
{
  "schema_version": "changedrop-value-summary/1",
  "decision": "render",
  "skip_reason": null,
  "features": [
    {
      "surface": "window-follow",
      "before": "Resizing the browser could leave the game view at its boot size and overlay handles out of alignment.",
      "after": "The live game view grows or shrinks with the browser, every overlay handle stays on its element, and the engine reports both virtual console size and true backing-store pixels.",
      "value": "The editing-size readout and the HUD stay aligned with the picture on screen."
    },
    {
      "surface": "pause-resume",
      "before": "The editor had no Pause or Resume control, so lining up the HUD meant waiting for a useful demo frame.",
      "after": "Pause and Resume sit beside the demo selector and follow the engine's real state, including console changes and an honest disabled reason on unsupported backends.",
      "value": "You can stop on a quiet frame and adjust the HUD without losing the moment you wanted."
    }
  ]
}
```

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
