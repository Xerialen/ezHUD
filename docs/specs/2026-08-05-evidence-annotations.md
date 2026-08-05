# Spec — annotated feature evidence (#55) — **revision 2 (owner correction)**

Status: approved for implementation (Sol). Reviewer: Opus 5 (release lead).

## What changed and why

Revision 1 shipped a full-frame screenshot with a ring, a text chip and a
distant magnified inset. The owner reviewed it and rejected the composition:
the inset competes with the screenshot, the chip carries prose that belongs in
the release text, and the reader still has to search a 1400px frame.

**The corrected visual language:**

1. **Crop to the half of the GUI where the changed control lives**, captured at
   a scale where the control is *naturally* legible — no magnification device
   needed to read it.
2. **Ring only the new or changed control.** Nothing else is marked.
3. **No inset. No prose chip.** Identification is a ring plus, at most, a small
   numeric badge. What the feature *means* is explained in the release/Discord
   text next to the image, never inside it.
4. The full-frame screenshots stay in the repo as unmodified context; they are
   no longer the annotated proof.

## Capture provenance

Focused crops must be produced deterministically, not cropped by hand:

- `docs/release-1/captures.json` — one entry per focused source: the page to
  load from an assembled dist, the state to drive it into (e.g. demo paused),
  the clip rectangle, and `deviceScaleFactor` (use 2 so the crop is crisp).
- `tools/release/capture.mjs` — loads the assembled dist in the repo's
  Playwright Chromium, applies the declared state, screenshots each declared
  clip, writes the focused **sources**. Document the command.
- Those focused captures are *sources*: committed, and never edited afterwards.
- `annotations.json` then rings the control inside the focused source, and
  `tools/release/annotate.mjs` renders the annotated output as before.

## Manifest changes

- `inset` becomes **forbidden** for this release's assets; `label` prose is
  removed. A callout is `{ badge, target }` plus the accent.
- Keep the source→output separation and the "never overwrite a source" rule.

## The two pilot assets

- **Pause/Resume**: focused capture of the demo-bar strip (the bar plus enough
  surrounding chrome to place it), ring on the Pause/Resume button only.
- **Window-follow**: focused capture of the toolbar's right half, ring on the
  live `editing at … · 1 px = …` readout only.

## Tests

Update `tools/tests/tier1_release_annotations.mjs`:

- Case 1–3 as before, against the focused sources.
- **New**: assert no manifest callout declares an `inset` and none carries
  prose `label` — the corrected language is enforced, not just intended.
- **New**: assert each annotated asset is materially smaller than the
  full-frame screenshot it was cropped from (a focused proof, not a full page).
- Case 4: the report references the focused annotated assets for both proofs;
  the full frames may remain as clearly-captioned context.
- Case 6 moves with the canonical notes document (see the standardisation
  spec) if that lands first; otherwise keep it where it is.

Observe the new assertions RED before implementing.

## Gates

`npm run test:tier1`, `npm run test:tier3:fte`, fresh `BASE_PATH=/ezHUD/`
assembly, `npm run test:tier4:fte` (40/40), and a browser review of the
assembled report at 1280px and 390px.

## Out of scope

Merging, publishing Pages, sending anything to Discord.
