# Release evidence annotation convention — Release 1 pilot

**Scope: this release.** These notes make the two pilot proofs reproducible and reviewable; adopting the convention repo-wide remains a separate decision.

The proof must make its changed control obvious without competing with the UI it documents:

- Capture the half of the interface where the control lives, with enough surrounding chrome to establish context. Prefer a 1.6:1–2.2:1 crop and never exceed 3:1; extend the crop vertically rather than shrinking the changed control. `captures.json` owns the assembled page, driven state, viewport, clip, and device scale.
- Capture at `deviceScaleFactor: 2` so the real control is naturally legible. Do not hand-crop and do not manufacture a magnified inset. When a focused proof displays measured state, declare and verify the same state as its full-frame context.
- Ring only the new or changed control: a 3 px accent stroke over a 5 px light stroke leaves a 1 px light hairline on both sides. At most, attach a small numeric badge.
- Never add a prose chip, connector, inset, or behavioural explanation inside the image. Behaviour belongs in the caption, release notes, or announcement beside the proof.
- Keep the focused capture and annotation output separate. Focused captures are source evidence and are never edited in place; `annotations.json` records only badge and target geometry.
- Full-frame screenshots remain byte-unchanged context, not annotation sources. Caption them explicitly as context when they remain in the report.
- Wrap each focused proof in a relative link to its full-size output for phone readers. Alt text describes the UI state and the ring or badge.

From a fresh public dist, regenerate focused sources and then their ring overlays:

```sh
DIST_DIR=../dist BASE_PATH=/ezHUD/ node tools/release/capture.mjs
node tools/release/annotate.mjs
```
