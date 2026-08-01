# Agent Instructions

This file is the shared instruction contract for all coding agents working in
this repository. Tool-specific files (CLAUDE.md, codex.md) are thin and defer here.

## 1. Read before changing anything

Always read docs/current-stage.md first — it is the re-entry point.
Then, if they exist, read in this order:

1. docs/vision.md
2. docs/project-brief.md
3. docs/roadmap.md
4. docs/current-stage.md  (re-read; this is the operative file)

If a doc does not exist yet, that is fine — this project may be at Tier 0.

## 1.5. Role and maturity model

This template is agent-agnostic. Claude, Codex, GLM, ChatGPT, or another
capable agent may act as Coder or Reviewer when the owner assigns that role.

- Coder role: `coder.md`
- Reviewer role: `reviewer.md`

Do not assume a tool brand owns a role. The same agent must not act as both
Coder and independent Reviewer for the same PR unless the owner explicitly
overrides role separation.

Before choosing process weight, read the maturity line in
`docs/current-stage.md`:

```text
maturity: stage-0-idea | stage-1-prototype | stage-2-active | stage-3-multi-agent
```

Start light. Add rigor only when the project earns it. If the maturity level
and the requested workflow disagree, state the mismatch and suggest a promotion
instead of inventing ad hoc ceremony.

## 2. Documentation contract

Documentation is a first-class deliverable.

Any meaningful change to code, scripts, configs, experiments, architecture,
environment, or assumptions must update at least one relevant document.

Before finishing any task, answer:

- What changed?
- What evidence was produced?
- Which docs were updated?
- If no docs were updated, why not?
- What is the next smallest useful step?

Prefer small, reversible changes over large speculative rewrites.
Prefer measurement before optimization.
Record uncertainty explicitly.

## 3. Verification workflow (no theoretical code; everything must be proven)

You are trusted to execute autonomously. Do not stop for approval on every
small step. But you must prove your work against the documented reality of
this project. "It seems to work" is not acceptable.

### Hook 1 — Ground truth (no fake criteria)
- Before writing code, extract the ACTUAL current success metric from
  docs/success-criteria.md and the current objective from docs/current-stage.md.
- Do not invent your own completion criteria.
- If those docs are missing or dangerously ambiguous, STOP and ask the human
  to define them. Do not proceed on a guessed goal.

### Hook 2 — Validation loop (anti-slop)
- Before modifying source, define exactly how the change will be validated,
  based on docs/testing-and-validation.md (or state the method inline if that
  doc doesn't exist yet).
- Where applicable, run the validation FIRST to confirm it fails — establish a
  baseline.
- Implement the strict minimum to pass. No speculative features, no
  "future-proofing" slop.

### Hook 3 — Self-correction with surfaced evidence
- Run the validation again after implementing.
- If it fails, self-correct the implementation — but SURFACE the correction
  and why it was needed. Never silently patch over a failure; silent guessing
  is a failure mode, not a feature.
- Do not declare a task done until real environment output proves it.
- Paste the actual terminal output, logs, or metrics as hard evidence into
  docs/findings-log.md. For UI work, attach screenshots of the affected states
  (the golden path and at least one edge/regression case).

## 4. Quality gate

Non-trivial implementations, design docs, significant refactors, and PRs get an
independent review when the maturity level requires it. Do not self-review in
place of that. If review tooling is unavailable, say so — do not skip it.

Use `reviewer.md` for review work.

For pull requests that touch generated evidence,
model evaluation, data contracts, feature pipelines, or model-serving behavior,
specialized reviewer layer, not a second merge gate or extra label system.

## 4.5. Test cases and web evidence

At Stage 0, a quick smoke check may be enough. At Stage 2 and above, meaningful
user-facing behavior should be covered by durable test cases and logged test
runs. Copy `extras/docs/test-cases-and-evidence.md` into `docs/` when the
project needs this workflow.

For web apps, every meaningful UI change should be validated by an agent in a
real browser once the project reaches active development. Copy
`extras/docs/agent-web-testing.md` into `docs/` when browser validation becomes
repeated enough to standardize.

## 5. Memory: don't build a second knowledge base

This repo's findings-log and decision-log are PROJECT-LOCAL working memory and
die with the repo. Anything with durable, cross-project value (a reusable
finding, a decision that affects other work) is promoted to the owner's
long-term knowledge base / notes rather than living only here. Do not create a
parallel memory system that competes with what the owner already maintains.

## 6. Re-entry rule (docs are claims, not truth)

When resuming, do not trust docs/current-stage.md blindly. Reconcile it against
the live state of the repo (git log, file state, test results). If they
disagree, trust the live state and correct the doc before doing anything else.

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

Before applying a gate decision, state what evidence backs the change: for engine or bridge changes, a build plus a live run against a real ezQuake; for UI logic, the pure-function tests; for anything visual, screenshots of the affected states.
<!-- codex-review-gate:end -->
