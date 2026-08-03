# Automated testing design — LLM-gated full suite (fable, ported 2026-08-03)

> **Provenance:** written by Fable 5 on 2026-08-03 in the *ezhud-legacy* codebase
> (branch `codex/1080-hud-cli`), commissioned by the owner to design fully automated
> testing for ezHUD. Ported here because **this repo is the live one**. Architecture-
> specific references below (`window.__ezhud`, `bin/ezhud.mjs serve`, `src/public/`
> canvas editor) name the legacy app — the equivalents here are `hud_web_ui/core/*`
> (geometry/model), `core/bridge.js` + the engine `hud_web` bridge, and `view/app.js`.
> The *design* (tiers, scenario specs, pixel goldens, LLM final gate) is
> architecture-neutral and applies unchanged.
>
> **Gap analysis vs this repo's `docs/TESTING.md` (what this design adds):**
> 1. **Tier 5 — the LLM visual review gate (owner-mandated).** TESTING.md has no LLM
>    gate at all. Here: after all deterministic tiers are green, an LLM reviews the
>    scenario screenshots against a fixed rubric, emits machine-parseable verdict
>    JSON, and drives an adjust-and-rerun loop (3-iteration cap, escalation rules).
>    No merge until verdicts are PASS on the same commit as green deterministic CI.
> 2. **Scenario spec format (`*.scenario.json`)** — predefined use-cases (cfg +
>    resolution + frozen mock moment + exact expected con-space rects/visibility)
>    consumed by tiers 3, 3V and 5. TESTING.md's tier 3 is ad-hoc assertions; this
>    makes expected output explicit, reviewable, and reusable across tiers.
> 3. **Tier 3V — pixel goldens** (`toHaveScreenshot`, committed baselines,
>    `maxDiffPixelRatio 0.01`, pinned Playwright container). Note the deliberate
>    tension with this repo's system-Chrome policy (TESTING.md tier overview) —
>    goldens need a *pinned* rendering environment; resolve before P2.
> 4. **Regression-class → test-layer mapping** (section 5) — which slipped-through
>    bug class is caught where, so gaps are visible.
> 5. **Seeded-defect exit criteria** per rollout phase — a phase is done when CI
>    catches its designated planted bug, not when it is merely green.
>
> What this repo already has that the legacy design lacked: the tier-2 *security*
> negative doctrine (allowlist), the 3F/4F FTE lanes, and the ccache/path-filter CI
> wiring. Keep both documents; TESTING.md stays the tier authority, this file is the
> scenario-spec + LLM-gate extension.

---

# ezhud automated testing — design

**Date:** 2026-08-03 · **Status:** design, ready to implement · **Scope:** this branch's app (standalone editor `src/server.mjs` + `src/public/` canvas editor + `bin/ezhud.mjs` CLI)

Owner mandate: *maximize determinism* — everything machine-checkable is a plain assertion; an
**LLM visual review is the mandatory final gate** after the deterministic suite is green, with an
adjust-and-rerun loop until the review is clean. LLM judgment is reserved for that final role only.

## 1. What exists already (build on it, don't reinvent)

| Where | What | Reused here as |
|---|---|---|
| this branch `test/` | 3 unit suites (`cfg`, `layout`, `profile`) via `node --test`, zero deps | Tier 1 seed |
| `src/public/js/editor.mjs:296` | `window.__ezhud` — live `elements`, `layout.rects` (per-element con-space rects), `screen`, `changes` | the Tier-3 introspection surface; all scenario assertions read it |
| repo main (`claude/intelligent-shannon-6KB6H`) | 15 Playwright specs in `tests/e2e/`, `playwright.config.js`, workflows `test.yml`/`pr-tests.yml`/`review-gate-merge.yml`/`review-gate-reset.yml`/`gate-draft-guard.yml`, `reviewer.md` | harness + CI + gate conventions to port onto this branch's app |
| `docs/superpowers/specs/2026-05-29-ezhud-fidelity-loop-design.md` (main) | the A/B/C triangle: **A** = editor preview, **B** = real-engine render (oracle), **C** = human ground truth; per-element con-box differ; two-speed triage; loop-until-dry | Tier 4 is exactly its L0–L3, unchanged in spirit |
| sister repo `Xerialen/ezHUD` `docs/TESTING.md` + issue #18 | four-tier determinism/cost doctrine, "every control proves its intended effect", aspect-ratio rule, control-interaction-first rule | tier vocabulary, hard-won rules adopted verbatim |
| `Xerialen/ezquake-render-runner` + vault `headless-hud-capture.md` | validated headless engine capture on servexeri (llvmpipe, `demo_jump_skip_messages 0`, IEND polling, region checks) | the image-B producer for Tier 4 |
| `tools/engine-shot`, `tools/extract-rects.py` (this branch) | engine screenshot + con-rect blob measurement (used for `docs/verification.md`) | Tier-4 measurement half |

External practice this design is anchored in (researched 2026-08-03):
Playwright `toHaveScreenshot` (pixelmatch) with committed baselines is the self-hosted standard;
`maxDiffPixelRatio ≈ 0.01`, never `0` ([playwright.dev/docs/test-snapshots](https://playwright.dev/docs/test-snapshots),
[testquality.com guide](https://testquality.com/playwright-visual-regression-guide/)); pin the
`mcr.microsoft.com/playwright:<version>` Docker image for baseline generation *and* CI or fonts/AA
diverge ([Enin, Medium](https://adequatica.medium.com/operating-system-independent-screenshot-testing-with-playwright-and-docker-6e2251a9eb32)).
Canvas editors converge on two tiers: logic tests against mocked canvas (Excalidraw,
`vitest-canvas-mock`) + Playwright pixel goldens on the live canvas with committed `baselines/`
(tldraw `apps/examples/e2e`); command-log snapshots are considered too brittle to gate on.
LLM-as-judge for UI runs **after** deterministic checks, with a fixed structured rubric and
machine-parseable verdict; judges reach ~human agreement but are biased, so they gate only what
machines can't ([deepeval.com/blog/llm-as-a-judge](https://deepeval.com/blog/llm-as-a-judge),
[anthropic.com/engineering/demystifying-evals-for-ai-agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
Agentic repair loops cap at 3–5 iterations with no-progress detection and human escalation
([agentic loops guide](https://datasciencedojo.com/blog/agentic-loops-explained-from-react-to-loop-engineering-2026-guide/)).

## 2. Spike result (validated 2026-08-03 on this VPS, headless)

Proven end to end with Playwright 1.62 + headless Chromium, no display: boot
`bin/ezhud.mjs serve` against a scratch cfg and a real id1 tree, open the page, freeze the mock
clock (`#pause`), read `window.__ezhud.layout.rects`, assert exact con-space geometry
(`health.x + health.w === 512 − 10` for `align_x right, pos_x −10`; conW/conH 512×288;
`pixelPerCon 3.75`; `hud_armor_show 0` ⇒ no armor rect; zero page errors), screenshot the canvas.
All assertions passed; screenshot shows the labeled render. **Machine-checkable browser assertions
work today with zero app changes.**

Two determinism findings the harness must handle:

1. `src/public/js/elements.mjs:205,232` call `new Date()` (scoreclock/democlock) — wall clock
   leaks into pixels. Pixel tests must fix time via Playwright's clock API
   (`page.clock.setFixedTime(...)`) *and* freeze the mock timeline (`#pause` freezes `t`, not `Date`).
2. `sizeCanvas()` derives `view` (canvas px per con px) from the window size — pixel tests must
   pin the viewport and assert the resulting integer `view`, or force a scale, before any screenshot.

## 3. Test layers (determinism ladder)

Tier numbering deliberately matches `ezHUD:docs/TESTING.md` so the two repos share one vocabulary.

### Tier 1 — pure logic (`node --test`, no browser) — *merge gate, every push*
What: `cfg.mjs` parse/patch/injection-refusal, `layout.mjs` resolve + placement, `profile.mjs`
conversion math, `quakefs.mjs` pak/pk3/wad indexing against tiny committed fixture archives,
`images.mjs` lmp/tga→RGBA against golden byte outputs.
Rules (adopted from ezHUD TESTING.md): every coordinate test uses a console size whose horizontal
and vertical ratios to the physical size **differ** (equal ratios hide the largest bug class);
new `core` logic lands with tests in the same commit.

### Tier 2 — server API contract (`node --test` + real `server.mjs` on a port) — *merge gate*
What: `/api/model` shape and cvar override order; `/api/save` **negative** cases are the point —
refuses overwriting the source cfg, refuses targets outside the configs dir, refuses non
`hud_*`/`vid_*` cvars, refuses quote/newline injection; asset routes decode the fixture pak/wad to
byte-identical PNGs (golden sha256); 404 paths. Also the CLI: `convert` round-trip equals
`docs/verification.md` maths, refuses aspect changes, `--force` semantics, `inspect --json` schema.

### Tier 3 — scenario suite, headless Playwright (state assertions) — *merge gate*
The heart of the design: **use-case specs** — predefined cfg + resolution + frozen mock moment,
each with explicit machine-checkable expected output, asserted from `window.__ezhud` (exact
integer equality in con space, no pixels involved, therefore fully deterministic).

Interaction cases live here too, one per editor control (the issue-#18 principle "every control
proves its intended effect"): drag element ⇒ `pos_x/pos_y` deltas match the engine's `move`
semantics; arrow keys ± shift ⇒ ±1/±10; property edit ⇒ `changes` map and re-layout; resolution
switch ⇒ `profileChanges` equal `preserveHudProfile()`'s output; save ⇒ the written file diff
contains exactly the changed cvars (read the file back). Per ezHUD's hard-won rule, every spec
runs a **control interaction first** and asserts it took effect before trusting any negative.

### Tier 3V — pixel goldens (visual regression) — *merge gate, tolerant*
`expect(canvas).toHaveScreenshot()` against committed `test/e2e/baselines/`, generated and run
**only** inside the pinned `mcr.microsoft.com/playwright` image (version-locked to the npm dep).
Determinism kit: fixed viewport, forced integer `view`, `page.clock.setFixedTime`, `#pause`-frozen
mock `t`, `animations: 'disabled'`, assets fixture pinned by sha256. Tolerance
`maxDiffPixelRatio: 0.01` (research consensus; `0` is an anti-pattern). Scope: one golden per
scenario + a few close-ups (charset text, sbar digits, face) — catches asset-pipeline and draw
regressions that state assertions can't see.

### Tier 4 — engine oracle (A vs B fidelity) — *nightly / manual, release gate*
Straight from the fidelity-loop design: capture **B** with the servexeri rig
(`ezquake-render-runner/runner/capture-linux.sh`, all engine gotchas already solved), capture
**A** from the editor at the same cfg/resolution/moment, crop per element using
`__ezhud.layout.rects` scaled by `K = B_width / conW` (zero resampling), compare per-element
(SSIM ≥ 0.90, posΔ < 4 con-px, sizeΔ < 5%, presence). `tools/extract-rects.py` is the measuring
half already used for `docs/verification.md`. Never blocks small changes; failures produce
findings, not auto-fixes (two-speed triage per the fidelity design).

### Tier 5 — LLM visual review gate — *mandatory, last, after all green*
See §7.

## 4. Use-case spec format

Directory layout (this branch):

```
test/
  unit/            # tier 1 (move existing 3 files here)
  api/             # tier 2
  e2e/
    scenarios/     # *.scenario.json  (tier 3 + 3V + 5 all consume these)
    baselines/     # tier 3V goldens (committed, Docker-generated)
    harness/       # scenario-runner.spec.mjs, drivers
  fixtures/
    quake/         # minimal id1 tree: palette.lmp, tiny pak with the HUD lumps, sha256 manifest
    cfgs/          # the scenario cfgs
llm-review/
  rubric.md        # fixed review rubric
  runs/            # verdict JSONs + contact sheets (artifacts, gitignored)
```

`*.scenario.json` — one file per use case, consumed by tiers 3/3V/5:

```json
{
  "name": "xerial-1080-bottombar",
  "cfg": "fixtures/cfgs/xerial-1080.cfg",
  "resolution": "1920x1080",
  "mock": { "t": 12.5, "fixedDate": "2026-01-15T12:00:00Z" },
  "expect": {
    "screen": { "conW": 512, "conH": 288, "pixelPerCon": 3.75 },
    "elements": {
      "health":  { "visible": true, "rect": [430, 259, 72, 24] },
      "armor":   { "visible": true, "rect": [203, 241, 45, 20] },
      "gameclock": { "visible": true, "rect": [396, 0, 116, 32] },
      "teamfrags": { "visible": false }
    },
    "pageErrors": 0
  },
  "interactions": [
    { "do": { "drag": "health", "byCon": [8, -4] },
      "expect": { "changes": { "hud_health_pos_x": "-2", "hud_health_pos_y": "-9" } } },
    { "do": { "save": "out.cfg" },
      "expect": { "fileContains": { "hud_health_pos_x": "-2" }, "sourceUnchanged": true } }
  ],
  "golden": "baselines/xerial-1080-bottombar.png",
  "llmReview": { "focus": ["bottom bar composition", "digit rendering"] }
}
```

`rect` is `[x, y, w, h]` in **con pixels**, compared with exact integer equality (the layout engine
is integer-deterministic — the spike proved it). Seed rects for a new scenario are proposed by
running the harness in `--record` mode, then **human-reviewed against the engine tables in
`docs/verification.md` before commit** — a golden nobody checked is a bug preserved forever.

Harness pseudocode (tier 3/3V):

```js
for (const s of scenarios) {
  server = spawn('bin/ezhud.mjs serve', { cfg: s.cfg, quakedir: FIXTURE, resolution: s.resolution });
  page = await chromium.launch().newPage({ viewport: PINNED });
  await page.clock.setFixedTime(s.mock.fixedDate);
  await page.goto(url); await page.waitForFunction(() => __ezhud?.layout.rects.size > 0);
  freezeMock(page, s.mock.t);                       // #pause + set t
  await controlInteraction(page);                   // must succeed or the run is void
  assertScreen(await read(page, '__ezhud.screen'), s.expect.screen);
  assertRects (await read(page, '__ezhud.layout.rects'), s.expect.elements);   // exact ints
  for (const step of s.interactions) await drive(page, step);                  // state asserts
  if (s.golden) await expect(page.locator('#stage')).toHaveScreenshot(s.golden,
      { maxDiffPixelRatio: 0.01 });                                            // tier 3V
}
```

## 5. Regression classes → layer that catches them

| Slipped-through class | Deterministic catcher | Backstop |
|---|---|---|
| layout/alignment/order math wrong | T1 layout units (aspect-differing ratios) + T3 exact rects | T4 A-vs-B |
| resolution conversion drift (conscale, 1440→1080) | T1 profile units + a T3 scenario per supported resolution pair | T4 at both resolutions |
| cfg parsing (last-assignment wins, comments, CRLF, injection) | T1 cfg units + T2 save round-trip | — |
| profile/resolution switching in the editor | T3 interaction case (`#res` switch ⇒ exact `profileChanges`) | T3V golden |
| asset pipeline (pak/pk3/wad/lmp/tga decode, charset) | T2 golden-hash decodes | T3V close-up goldens |
| drag/keyboard/save semantics | T3 interaction cases per control | — |
| element draw functions diverge from engine | T3V goldens (once correct) | **T4 per-element diff (the designed catcher)** |
| "renders but looks wrong to a human" (composition, overlap, readability) | — (not machine-checkable) | **T5 LLM gate** |

## 6. Cvar coverage strategy — schema-driven, not per-cvar

The surface is ~83 HUD elements × ~1132 `hud_*` cvars. Writing a test per cvar is the wrong
unit of work: it doesn't scale, it rots, and it encodes today's expected values instead of the
properties that make any value correct. This section generalizes §5 — six mechanisms, each
covering the whole cvar surface at once. The **hand-written** tests stay scoped to the ~9 real
user-facing use-cases (README/PRODUCT.md: boot into the "no HUD to edit" state, drag-edit over
the live render, cfg import with apply/drift report, asset import (pk3/mvd), export
byte-fidelity, save/overwrite safety, `hud_web 1` live-edit, scale-readout honesty, CLI/profile
conversion) — those are the tier-3 scenarios of §4. Everything below is the machinery that
extends that backbone to full cvar/element coverage without another hand-written case.

### 6.1 Schema-driven generative tests

ezQuake ships a machine-readable cvar schema — `help_variables.json` in the upstream repo root
(type, default, bounds, enum values per cvar). Don't hand-write cases; **generate** them:

```js
const schema = load('fixtures/cvar-schema.json');          // extracted from the pinned engine clone
for (const cvar of schema.filter(c => c.name.startsWith('hud_'))) {
  for (const v of batteryFor(cvar))                        // min, max, min−1, max+1, default,
    it(`${cvar.name} = ${v}`, async () => {                //  "", "abc" into numeric, "30%",
      await engine.set(cvar.name, v);                      //  quote/newline injection
      const state = await engine.state();                  // must never crash, never 500,
      assertSane(state, cvar);                             //  value clamped or refused per schema
      assertRoundTrip(await engine.get(cvar.name), cvar);  // default restore ⇒ default readback
    });
}
```

One generic battery, every cvar gets it, coverage follows the schema. **Schema provenance in
CI:** do *not* vendor a copy that drifts — the CI job already clones `ezquake-source` at the
pinned commit (the runbook is executable CI), so extract `help_variables.json` from that clone
at build time and sha256 it into the fixture manifest. The element↔cvar mapping needs no
extraction at all: the bridge's `/state` reports each element's registered parameters (PRODUCT.md
— "driven generically from what the bridge reports"), so the mapping is always exactly the built
engine's. This repo carries no schema copy today; the pinned clone is the source of truth.

### 6.2 Metamorphic invariants over all elements

Where 6.1 checks each cvar in isolation, invariants check *relations* that must hold for every
element, with no per-cvar expected value:

```js
for (const el of state.elements) {                          // all 83, from /state
  await engine.set(`hud_${el.name}_show`, 0);
  assert((await engine.state())[el.name].rect === null);    // show 0 ⇒ no rect, ∀ el
  await engine.set(`hud_${el.name}_show`, 1);
  const before = rect(el); await editor.drag(el, dx, dy);
  assertMoveSemantics(before, rect(el), dx, dy);            // drag Δ ⇒ engine move semantics, ∀ el
}
```

Same shape for: `pos_x += n` ⇒ rect shifts by the engine's truncation of `n·scale`; `scale`
doubled ⇒ rect grows per the element's grow rules; `place` change ⇒ rect re-anchors and nothing
*else* moves. One loop, no per-element table.

### 6.3 Round-trip as universal oracle

cfg in → apply → export → **the byte diff touches only the intended lines** (README's
export-byte-fidelity promise, mechanized). Import direction: dropped cfg → editor state ==
engine `/state`. One assertion pair covers every cvar any cfg can contain, including ones no
scenario ever names.

### 6.4 Differential testing — the engine is the oracle

The architecture's core property (PRODUCT.md "Positioning"): the editor never models placement.
So after *every* generated command in 6.1–6.3, assert editor state against the engine's own
`/state`. Divergence editor↔engine **is** the bug, by definition — no encoded right answers
anywhere. This is tier 4's A-vs-B logic promoted into the cheap tiers: same oracle, state
instead of pixels.

### 6.5 One deep representative per behavior class

The 1132 cvars collapse into a handful of behavior classes. Each class gets **one** hand-written
deep scenario at its known edges; the rest of the class rides the 6.1 battery + 6.2 invariants:

| Class | Deep representative (its known edges) |
|---|---|
| position (`pos_x/pos_y/align`) | negative offsets, right/bottom align, engine truncation of fractions |
| scale | kx≠ky resolutions (the two-defect single-ratio class, README) |
| style enums | full enum sweep from schema + one out-of-range |
| colour | palette index bounds, named vs index forms |
| place/anchor chains | place cycle group1→group2→group1 |
| frame/alpha | 0, 1, fractional, stacked over frame |
| percentage sizing | radar's `width "30%"`, corner-drag refusal |

### 6.6 Mutation testing as coverage proof

Extends §9's seeded-defect doctrine from phases to classes: seed one defect **per class of 6.5**
(single-ratio shortcut, ignored `HUD_NO_GROW`, wrong truncation, off-by-one clamp, dropped
export line) and require the net — battery, invariants, round-trip, differential — to catch each
one in CI. Coverage is *measured* by kills, not hoped for.

### 6.7 LLM role

Unchanged from §7's doctrine: the LLM never reviews per-cvar. It reads the **aggregated**
drift/anomaly reports and screenshots from the invariant runs and escalates what looks wrong —
judgment on the residue the machines surfaced, not enumeration.

## 7. The LLM final gate and adjust loop

Runs only after tiers 1–3V are green (and 4, when scheduled). Input per scenario: the current
screenshot, the scenario's `expect` summary, and `llm-review/rubric.md` (fixed categories: element
presence/placement sanity, text/digit legibility, overlap/clipping, palette/asset sanity, overall
faithfulness to an ezQuake HUD). Output is machine-parseable:

```json
{ "scenario": "...", "verdict": "PASS|FAIL",
  "findings": [{ "element": "health", "category": "clipping", "severity": "block|warn",
                 "evidence": "…", "suggestedKnob": "cfg:hud_health_pos_y | code:elements.mjs draw" }] }
```

Adjust loop (per the agentic-loop research: hard caps, no-progress detection, escalation):

1. LLM reviews all scenario screenshots → verdict JSONs.
2. Any `block` finding ⇒ the agent classifies it: **cfg/scenario knob** (fix the scenario cfg or an
   expected value that was wrong — requires updating the spec *and* saying so) vs **code defect**
   (fix `src/`, which must first add/extend a failing deterministic test that reproduces it —
   the finding is thereby promoted down the ladder so the LLM never has to catch it twice).
3. Re-run the full deterministic suite, regenerate screenshots, re-review.
4. Stop conditions: verdict clean (**pass**) · **3 iterations** without the finding count strictly
   decreasing ⇒ escalate to the owner with the verdict JSONs + contact sheet · the same finding
   flip-flopping (fixed then re-reported) ⇒ escalate immediately (judge instability, don't chase it).
5. Merge rule: the branch may not merge until the last run's verdicts are all PASS **and**
   deterministic suites are green on the same commit. The verdict JSON is posted as the gate
   comment, riding the existing `review-gate-merge.yml` DECISION/LABEL/HEAD_SHA convention from
   main — no new gating machinery.

The LLM never overrides a deterministic failure, never edits baselines or expected rects to make
itself pass, and warn-level findings are recorded but non-blocking.

## 8. CI (GitHub Actions sketch)

Every push/PR (`pr-tests.yml`, extend the existing one on main):

```yaml
jobs:
  deterministic:
    runs-on: ubuntu-latest
    container: mcr.microsoft.com/playwright:v1.62.1-jammy   # pin = baseline environment
    steps:
      - uses: actions/checkout@v4
      - run: sha256sum -c test/fixtures/quake/manifest.sha256
      - run: npm test                                       # tier 1 + 2
      - run: node test/e2e/harness/run.mjs --all            # tier 3 + 3V
      - if: failure()
        uses: actions/upload-artifact@v4                    # diffs + screenshots only
        with: { path: test-results/ }
```

Nightly + release tags (`fidelity.yml`): tier 4 on the self-hosted lane (servexeri capture via the
render-runner, differ on the runner), then tier 5 LLM review of the night's screenshots; failures
open/refresh a single tracking issue with the contact sheet. PR-time tier 5 runs on the *changed*
scenarios only (screenshots are already produced by the deterministic job as artifacts), keeping
the gate cheap; the full sweep is nightly. Job summaries print failing test names only, full logs
as artifacts (ezHUD TESTING.md rule — keeps agent context small).

## 9. Phased rollout

1. **P1 — harness + first scenarios (lands first):** move `test/*.mjs` → `test/unit/`; commit the
   quake fixture (palette + minimal pak + sha256 manifest); scenario runner from the spike; 3
   scenarios (default cfg, xerial-1080 from `docs/verification.md` — its engine-measured table
   becomes the first `expect.elements` for free, hidden-elements case); interaction cases for
   drag/keys/save; `pr-tests.yml`. P1 is deliberately **use-case-first**: hand-written scenarios
   only, drawn from the ~9 real use-cases (§6 preamble) — no generative machinery yet.
   *Exit: a seeded layout bug fails CI.*
2. **P2 — tier 2 + 3V + cvar coverage machinery (§6):** API-contract suite incl. save negatives;
   Docker-generated baselines; `--record` mode with human-review rule; schema extraction from the
   pinned engine clone, the generative battery (6.1), the invariant loops (6.2), round-trip
   oracle (6.3). *Exit: a 1-px palette or charset change fails CI with a visual diff artifact,
   **and** one seeded defect per behavior class of 6.5 is killed (6.6).*
3. **P3 — LLM gate:** rubric, verdict schema, review runner (screenshots from CI artifacts),
   gate comment wiring, adjust-loop runbook. *Exit: a deliberately mis-positioned element passes
   tiers 1–3V (expectations doctored) and is caught and blocked by the LLM review.*
4. **P4 — tier 4 nightly:** wire the servexeri capture + per-element differ per the fidelity-loop
   design (its L0/L1/L2 unchanged); nightly workflow + tracking issue. *Exit: one full A-vs-B
   nightly run producing the per-element table.*

Each phase's exit criterion is itself the validation evidence — no phase is "done" on green alone;
it must catch its designated seeded defect.
