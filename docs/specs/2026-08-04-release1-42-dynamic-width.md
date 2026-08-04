# Spec — #42: QA matrix position-only judgement for content-sized elements

Status: approved for implementation (Sol). Reviewer: Claude.
Parent: #39. Independent of #40/#41 (pure JS, tools/qa only).

## Requirement (issue #42 spec is already precise — follow it)

- `export const DYNAMIC_WIDTH = ['ping']` in `tools/qa/invariants.mjs`.
- `proportionality` and `metamorphic` judge listed elements on x/y (and h)
  but never w. Element name matching must use the same name field the
  invariants already use for reporting (`hud_`-stripped or not — match the
  existing convention in the file, don't invent a second normalizer).
- The exemption must appear in the per-cell report.json (e.g.
  `exempt_width: ["ping"]`) so a reviewer of artifacts sees it was applied.
- docs/TESTING.md (Golden-matrix section): name the list and the rule —
  extending it requires naming the element in a PR.

## Cases → tests (issue #42 Cases 1–4) — TDD order

RED first in `tools/qa/tests/invariants.test.js`:
- Case 1: ping rect w 176→136 passes proportionality and metamorphic; same
  delta on `health` fails both.
- Case 2: ping position drift fails despite the exemption (x moved, w held).
- Case 3: real run — `newhud.*` cells green with ping drawn (this lands with
  the full matrix once #40 is merged; if #40 isn't merged yet, quote the
  cell report showing ping no longer among the failures).
- Case 4: docs/TESTING.md wording (review check, `untested: docs` line ok).

`npm run test:qa` (unit + selftest incl. planted-fault) must stay green —
the planted fault (teaminfo keeps size) must STILL fail, proving the
exemption didn't widen past its list.
