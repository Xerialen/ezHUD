# Test setup plan

How ez-hud is tested, which tier runs when, and how CI executes each one.
The split is by **determinism and cost**: the cheaper and more deterministic a
tier is, the more often it runs and the more freely an LLM agent may extend it.

---

## Tier overview

| Tier | Layer | Deterministic | Needs | Runs on | Gate |
|------|-------|---------------|-------|---------|------|
| 1 | Pure core (`hud_web_ui/core/`, `src/libhud/`) | Yes | Node + C compiler | Every push/PR | Merge |
| 2 | Bridge contract (`hud_web.c`, `hud_web_state.c`, `bridge.js`) | Yes | Built engine (C half) / Node stub (JS half) | PRs touching `engine/` or protocol | Merge |
| 3 | View layer (`view/app.js`) | Mostly | Headless Chromium | PRs touching `hud_web_ui/` | Release |
| 4 | Full end-to-end | No (flaky by nature) | Real engine + GPU host + browser | Release tags, nightly, manual | Release |

**Rule of thumb:** an agent must run tiers 1–2 before reporting any change done.
Tier 4 failures require human interpretation and never block small changes.

---

## Tier 1 — Pure core (unit)

**What:** geometry transforms, resize transfer ratios, colour parsing, model
derivation — everything in `hud_web_ui/core/`, plus the extracted placement core
in `src/libhud/`.

**How:**

```
make -C src/libhud/tests check        # placement core
node --check hud_web_ui/core/*.js     # syntax
node --test hud_web_ui/core/tests/    # logic, against fixtures/state.json
python3 tools/embed_hud_web_ui.py --check   # generated UI freshness
```

Fully offline: the fixture (`hud_web_ui/fixtures/state.json`, a real capture)
stands in for the engine. No browser, no game, sub-minute total.

**Rules:**
- Every coordinate-space test must use a console size whose horizontal and
  vertical ratios to the physical size **differ**. Equal ratios (e.g. 512×288
  on 2560×1440) hide the single largest class of bug in this project.
- New logic in `core/` lands with tests in the same commit. This is the tier
  the LLM extends aggressively — there is no downside to more cases here.

## Tier 2 — Bridge contract (integration)

**What:** token auth, endpoint routing, save semantics, and above all the
command allowlist.

**JS half** (no engine needed): drive `core/bridge.js` against a tiny local
HTTP stub serving the fixture. Assert request shapes, token handling, and
error paths.

**C half** (needs a built engine): start ezQuake under Xvfb with `hud_web 1`,
then fire plain HTTP requests (curl or a small script) at the bridge and
assert on responses.

**Security cases are the point of this tier.** Every non-obvious rule recorded
in `HUD_Web_CommandAllowed` gets a **negative** test proving the bad input is
refused — not merely that the allowed path works:

- `$` in a command is refused (`Cmd_ExpandString` runs after the check)
- an allowlisted name that only exists as a user alias is refused
- requests without the token, or with a stale token after `hud_web 0`, get 401/403
- `hud_web*` cvars cannot be set through the bridge
- `hud_export` path traversal stays inside the configs directory
- listener is bound to `127.0.0.1`, never `INADDR_ANY`

A change that touches the allowlist without touching its tests is incomplete.

## Tier 3 — View layer (headless browser)

**What:** `view/app.js` — that the DOM reflects the model. Rectangles drawn
where `core/geometry.js` says, drag and corner-resize update state correctly,
`kx`/`ky` applied separately, percentage-sized elements refused a corner drag.

**How:** Playwright, headless Chromium, UI served from a static file server
with the fixture standing in for the engine. No live game required.

Same aspect-ratio rule as tier 1 applies to every visual assertion.

## Tier 4 — Full end-to-end (release smoke)

**What:** real engine, real browser, the person-mimicking flow:
`hud_web 1` → open printed URL → drag an element → resize → recolour →
save config → assert the written cfg contains the expected placement.
Plus screenshots of affected states, uploaded as artifacts.

**Hard-won rules (see README):**
- **Playwright, never hand-rolled CDP.** Raw `Input.dispatchMouseEvent` can
  silently deliver nothing while reporting no error.
- **Run a control interaction first** — click something known to work and
  assert it took effect. If the control fails, every negative result in the
  run is worthless.
- Run under **Xvfb**, not a real display server; a vanishing display looks
  exactly like an engine crash.

---

## CI wiring (GitHub Actions)

Public repo → GitHub-hosted runner minutes are free. Self-hosted runners are
free from GitHub's side in all cases.

| Workflow | Runner | Trigger |
|----------|--------|---------|
| `tier1.yml` — core + freshness | `ubuntu-latest` | every push / PR |
| `tier2-js.yml` — bridge stub tests | `ubuntu-latest` | every push / PR |
| `tier2-engine.yml` — engine build (ccache) + curl contract tests | self-hosted (home) | PRs touching `engine/**` |
| `tier3.yml` — Playwright headless vs fixture | `ubuntu-latest` (Playwright container) | PRs touching `hud_web_ui/**` |
| `tier4.yml` — full e2e + screenshots | self-hosted (GPU host) | release tags, nightly schedule, `workflow_dispatch` |

Notes:
- Cache the ezQuake build with **ccache** so only ez-hud files recompile;
  tier 2 engine runs then take seconds, not minutes.
- Use `paths:` filters so tiers only run when their layer changed.
- On failure, print **only failing test names** to the job summary and attach
  full logs/screenshots as artifacts — keeps agent context small and humans sane.
- Nightly tier 4 exists so flakiness surfaces before a release, not during one.

## Agent workflow

1. Local hook: tier 1 runs on every edit before the agent even commits.
2. Agent pushes a branch; tiers 1–3 run automatically.
3. Agent reads check results (summaries, not raw logs) before declaring
   `VERDICT: PASS`.
4. Tier 4 stays behind manual dispatch / tags so an agent cannot burn GPU
   hours on a flaky loop.

## Validating a change (evidence rules)

Match the evidence to the change; do not report "done" without it:

- **Bridge or engine code** — build, run, exercise the endpoint; prove the
  negative case for anything security-relevant.
- **`core/` logic** — pure tests against the fixture.
- **Anything visual** — screenshots at a console size whose aspect ratio
  differs from the screen's.
