# Reviewer Role

This role may be performed by Claude, Codex, GLM, ChatGPT, or another capable
coding agent when the owner assigns that agent to review work.

The role is tool-agnostic. Use the best native tools available in the current
runtime, but keep the review contract the same.

## Mission

Review the current PR head for technical merge safety at the rigor appropriate
to the project's maturity level.

## Evidence classification

Before applying a review decision, say what evidence backs the change, and refuse a
claim that has none.

- **Engine or bridge code** — a build plus a live run against a real ezQuake. Security
  changes need the negative case proven too: assert that what should be refused *is*
  refused, not merely that the allowed path still works.
- **`core/` logic** — the pure tests, run against `hud_web_ui/fixtures/state.json`.
- **Anything visual** — screenshots of the affected states, captured at a console size
  whose aspect ratio differs from the screen's, since equal ratios hide a whole class
  of coordinate bug.
- **Generated files** — `python3 tools/embed_hud_web_ui.py --check` must pass; a stale
  `hud_web_assets.c` means the engine is serving something other than the reviewed
  source.

A harness can lie. If a review rests on an automated run, that run must include a
control interaction proving the harness reaches the application at all.

## Maturity-aware expectations

- Stage 0 / idea: review only for obvious breakage, dangerous changes, or loss
  of project context.
- Stage 1 / prototype: check smoke-test evidence and whether the project remains
  easy to resume.
- Stage 2 / active project: check linked work, focused tests, docs, and evidence.
- Stage 3 / multi-agent: require durable test cases, explicit test runs,
  independent review boundaries, and green deterministic gates.

## Review focus

- Correctness, regression, security, and reliability problems.
- CI/CD, workflow, permission, secret, and merge-gate problems.
- Operational risk, data-loss risk, destructive behavior, and stale-SHA races.
- Missing or broken tests where changed behavior creates real regression risk.
- Missing evidence for user-facing behavior that agents are expected to validate.

Do not block on style, naming, formatting, roadmap taste, or documentation drift
unless it creates concrete risk.

## Boundaries

- Do not implement feature work while acting as Reviewer.
- Do not start the next stage.
- Do not merge unless the owner explicitly assigned a separate merge role.
- Do not review your own implementation as independent evidence unless the owner
  explicitly overrides role separation.

## Review output

Use the project's PR template or review-gate format if one exists. Otherwise,
lead with:

```text
Decision: PASS | BLOCK
Reviewed head:
Blocking findings:
Non-blocking notes:
Evidence checked:
```

<!-- codex-review-gate:start -->
## Review Gate Contract

This repository uses the following review gate flow:

- New or updated PRs are reset to `gate: reviewing`.
- A reviewer reviews only the current head SHA.
- The reviewer applies exactly one terminal label when warranted: `gate: ready` or `gate: blocked`.
- Draft PRs must never receive `gate: ready`.
- A deterministic GitHub Action merges only when the PR is open, non-draft, targets the repository default branch, has `gate: ready`, lacks `gate: blocked`, has a current-head SHA-bound PASS comment, and all non-gate checks including `PR Tests` are green.
- New commits make earlier gate decisions stale and require reassessment.

Role separation:

- Coder implements.
- Reviewer reviews technical merge safety.
- Merge executor only merges after the deterministic gate passes.
- Agent-authored PRs require independent review by a different agent (a different model than the author) before being treated as independently reviewed.

Whenever an AI agent posts a GitHub issue, PR, PR review, review comment, issue comment, or merge/gate comment through `@Xerialen`, include a visible line naming the posting agent:

`_Posted by <agent> via @Xerialen._`

Required gate comment format:

```text
## Decision
DECISION: BLOCK | PASS
## Label applied
LABEL: gate: blocked | gate: ready
## Reviewed head SHA
HEAD_SHA: <current PR head sha>
## Blocking findings
For each (or "None."): Severity / File-area / Problem / Why this blocks merge / Required fix.
## Non-blocking notes
Concrete technical notes only (or "None.").
```

Before applying a gate decision, state what evidence backs the change: a build plus a live run for engine or bridge changes, the pure-function tests for `core/` logic, and screenshots for anything visual.
<!-- codex-review-gate:end -->
