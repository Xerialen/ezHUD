# ezHUD Release 2 — Place, don't pixel

Placing a HUD element is now a relationship rather than a pair of coordinates: anchor it to a parent or a screen edge, and let `pos_x`/`pos_y` be the fine-tune they were always meant to be. Drags snap to a grid and to other elements' edges, the editor scales to the screen you actually work on, and named demo moments put a real frame in front of you instead of an empty one. Exports remain byte-compatible ezQuake configs, with untouched lines preserved byte-for-byte.

## Features

### The editor scales to your screen
Before: The editor was cramped at 1440p, and moving the browser to a second monitor could collapse the layout outright.
After: A UI-scale control sets the editor chrome to a size you can work in, and it survives a reload. Moving the window between monitors keeps the layout intact.
Value: You can work at the size your screen deserves, and the editor stays where you put it.
Evidence: img/editor-size-focused-annotated.png

### Anchor first, nudge second
Before: Placement meant typing raw coordinates, and nothing on screen told you what an element was positioned against.
After: The inspector leads with the anchor — a parent element or screen edge, an alignment and an order — and the stage draws the relationship. `pos_x` and `pos_y` become the offsets from that anchor. Raw coordinate entry is still there when you want it.
Value: A drag reads as "re-anchor plus offset" instead of a number you have to reverse-engineer later.
Evidence: img/anchor-focused-annotated.png

### Drags that land where you meant
Before: Lining two elements up was eyeballing, one pixel at a time.
After: Drags snap to a configurable grid and magnet to other elements' edges and centres, with guides showing what they caught. A visible toggle turns it off, and a held modifier bypasses it for one drag.
Value: Alignment stops being a test of patience. The export still contains final positions and nothing else.
Evidence: img/drag-assist-focused-annotated.png

### Demo moments worth aiming at
Before: Pause existed, but you had to wait for a useful frame to appear before there was anything to line the HUD up against.
After: Named preset moments seek the demo to a deterministic point — a frame with full HUD activity, a scoreboard moment, a quiet moment.
Value: The frame you need is one click away instead of a wait, and it is the same frame every time.
Evidence: img/demo-moments-focused-annotated.png


## Discord payload

```json
{
  "content": "**ezHUD Release 2 — Place, don't pixel**\n\nHUD placement is now a relationship instead of a pair of coordinates: anchor an element to a parent or a screen edge and let pos_x/pos_y be the fine-tune. Drags snap to a grid and to other elements, the editor scales to your screen, and named demo moments put a real frame in front of you. Exported configs stay byte-compatible.\n\nTry ezHUD: <https://xerialen.github.io/ezHUD/>\nFull release notes: <https://xerialen.github.io/ezHUD/release-2/release-notes.html>\nEvidence report: <https://xerialen.github.io/ezHUD/release-2/>",
  "embeds": [
    {
      "title": "The editor scales to your screen",
      "description": "The UI-scale control sets the editor chrome to a workable size and survives a reload. Marker 1 identifies the control.",
      "image": {
        "url": "attachment://editor-size-focused-annotated.png"
      }
    },
    {
      "title": "Anchor first, nudge second",
      "description": "The inspector leads with the anchor and the stage draws the relationship. Marker 1 identifies the anchor selector whose choice the stage reflects.",
      "image": {
        "url": "attachment://anchor-focused-annotated.png"
      }
    },
    {
      "title": "Drags that land where you meant",
      "description": "Snap-to-grid and magnet alignment with visible guides. Marker 1 identifies the Grid and Magnet toggles and the grid step they share.",
      "image": {
        "url": "attachment://drag-assist-focused-annotated.png"
      }
    },
    {
      "title": "Demo moments worth aiming at",
      "description": "Named preset moments seek the demo to a deterministic point. Marker 1 identifies the moment selector.",
      "image": {
        "url": "attachment://demo-moments-focused-annotated.png"
      }
    }
  ],
  "allowed_mentions": {
    "parse": []
  },
  "attachments": [
    {
      "name": "editor-size-focused-annotated.png",
      "path": "img/editor-size-focused-annotated.png"
    },
    {
      "name": "anchor-focused-annotated.png",
      "path": "img/anchor-focused-annotated.png"
    },
    {
      "name": "drag-assist-focused-annotated.png",
      "path": "img/drag-assist-focused-annotated.png"
    },
    {
      "name": "demo-moments-focused-annotated.png",
      "path": "img/demo-moments-focused-annotated.png"
    }
  ]
}
```
