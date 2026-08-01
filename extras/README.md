# Extras — opt-in document pack

These are **opt-in** Tier 1 and Tier 2 document templates. They are NOT alive by
default — only the root agent contract/role files plus `docs/current-stage.md`,
`docs/findings-log.md`, and `docs/decision-log.md` (Tier 0) ship ready-to-use.

The rule is simple: **copy the doc you need from `extras/docs/` into `docs/` when
the project earns it — not before.** Unpaid docs rot into lies, so add ceremony
only when it actually helps (match ceremony to project size).

## Tier 1 — add when the project earns it

Create these the moment they'd actually help.

```text
extras/docs/vision.md                  # why this exists / north-star question (add once goal is non-obvious)
extras/docs/project-brief.md           # current hypothesis + first milestone
extras/docs/success-criteria.md        # what counts as success / what doesn't
extras/docs/scope.md                   # in-scope, non-goals, tempting distractions
extras/docs/roadmap.md                 # Mermaid stage map (add when there are >2 stages)
extras/docs/open-questions.md          # unresolved questions table
extras/docs/risks-and-assumptions.md
```

Add `success-criteria.md` as soon as you have any real "done" definition — the
verification workflow (Hook 1 in `AGENTS.md`) depends on it.

## Tier 2 — add only for real engineering / data work

```text
extras/docs/technical-context.md       # source maps, architecture, key files
extras/docs/environment.md             # runbook: OS, paths, deps, commands, ports, secrets policy
extras/docs/data-and-inputs.md         # datasets, APIs, media, validation rules
extras/docs/testing-and-validation.md  # test commands, expected outputs, regression tests
extras/docs/maturity-model.md          # progressive rigor / promotion ladder
extras/docs/test-cases-and-evidence.md # durable test cases and logged test runs
extras/docs/agent-web-testing.md       # real-browser agent validation for web apps
```

## How to adopt a doc

```text
cp extras/docs/vision.md docs/vision.md
```

Then fill it in. Reference docs by their stable name — there are no number
prefixes, so nothing breaks when you add a doc later.
