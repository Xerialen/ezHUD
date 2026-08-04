# Make Release 1 (#39–#43) startable for Sol

## Context

Release 1 "Trust the geometry" is filed (#39 parent, #40–43 subissues, correctly
sub-issue-linked). The ticket *content* is complete — problem, evidence, spec,
Cases per the #35 convention, roles (Sol builds, Claude reviews). But every
artefact the tickets cite exists only as **uncommitted work on minimain**:
`tools/qa/` (matrix, invariants, fake engine, wasm bridge, setup-fte-env.sh,
master cfgs), `hud_web_ui/core/log.js` + instrumentation + debug panel, engine
`hud_web_log`/`/log`, tier-2/3 test additions, `docs/qa-findings-2026-08-04.md`
(the evidence #40/#42 cite), `docs/specs/2026-08-04-logging.md`, TESTING.md/
PROTOCOL.md updates. A builder starting from GitHub finds tickets pointing at
files that do not exist. Current branch is `fix/tracker-cvar-wiring` (unrelated
name, clean of its own work — everything new is uncommitted on top).

## Plan

1. **Branch + commits.** Create branch `qa/logging-and-golden-matrix` from the
   current state. Commit in reviewable slices, message style per git log
   (`fix:`/`test:`/`docs:` prefixes, why-first bodies):
   - `feat(log): core/log.js + bridge/model/view/fte instrumentation + F9 panel`
     (core/log.js, log.test.js, bridge.js, app.js, boot.js, debug.js, ui.css,
     regenerated hud_web_assets.c)
   - `feat(engine): hud_web_log ring + GET /log + X-HUD-Req echo` (hud_web.c,
     PROTOCOL.md, tier2_bridge.test.js, tier2_engine_contract.py, tier3.mjs)
   - `feat(qa): golden matrix — invariants, runner, fake engine, wasm bridge,
     setup-fte-env.sh, master cfgs, selftest` (tools/qa/*, package.json,
     .claude/workflows/qa-matrix.js)
   - `docs(qa): findings from the first real-engine run + TESTING.md QA layer`
     (qa-findings, logging spec, TESTING.md)
   Exclude: `.remote/` (leftover exploration checkout — untracked, stays local),
   scratchpad artifacts.
2. **Push + PR** to `main` titled for the logging+QA foundation, body mapping
   the logging-spec Cases 1–8 to their tests (#35 convention: PR maps Cases).
   This PR is *my* work; Sol reviews nothing here — note in body that it is the
   prerequisite foundation for #39.
3. **Ticket touch-ups** (via the same token flow that filed them — the
   `!`-script pattern — or my API access if the permission rule was added):
   - #39: fix duplicated title ("Release 1: Release 1: …" → one), append a
     "Start here" section: branch/PR link, `npm run test:qa` as the
     zero-engine entry point, `tools/qa/setup-fte-env.sh` for the real-engine
     environment, artifacts convention.
   - #40: add the pointer that the engine fix lands in the **fteqw fork**
     (Xerialen/fteqw + spikes/fte-web/fteqw.diff, pins in
     .github/workflows/pages.yml and setup-fte-env.sh must move together) —
     the one operational fact the ticket body lacks.
   - Assign #40–43 to Sol's account if one exists (ask owner for the handle).
4. **No code changes** to the tickets' actual scope — that is Sol's work.

## Verification

- `git status` clean after commits except `.remote/` and scratchpad.
- CI (tier 1–3) green on the PR; `npm run test:qa` green locally.
- Each of #40–43 readable start-to-finish with every referenced path resolving
  on the PR branch.

## Open question for the owner

- Sol's GitHub handle for assignment (or is Sol invoked another way?).
