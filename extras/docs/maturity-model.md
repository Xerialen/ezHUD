# Maturity Model

Use progressive rigor: start light enough that ideas can breathe, then add
structure only when the project earns it.

## Stage 0: Idea / Spike

Use when the question is "is this idea worth exploring?"

Required:

- `README.md`
- `AGENTS.md`
- `docs/current-stage.md`
- `docs/findings-log.md`
- `docs/decision-log.md`

Avoid:

- strict PR gates
- full issue-template ceremony
- durable test-case lifecycle
- project-board administration

Rule:

```text
Capture intent. Make it runnable. Do not optimize the process yet.
```

## Stage 1: Prototype

Use when the idea may become real.

Add when useful:

- lightweight PR description
- basic smoke test
- `docs/success-criteria.md`
- `docs/testing-and-validation.md`

Testing expectation:

```text
At least one agent-runnable smoke test, plus browser evidence for UI apps.
```

## Stage 2: Active Project

Use when work is repeated across sessions.

Add:

- user-story and bug issues
- focused automated tests
- test-case methodology for important behavior
- CI for build/test
- agent web-testing standard for web apps

Testing expectation:

```text
Every meaningful change links to a story or bug and produces evidence.
```

## Stage 3: Multi-Agent / Serious

Use when agents work independently or changes can regress important behavior.

Add:

- durable test cases
- explicit test-run evidence
- independent coder/reviewer role separation
- stricter CI and merge gates
- GitHub Project views if they reduce mental load

Testing expectation:

```text
No merge without deterministic tests plus agent browser validation for UI changes.
```

## Promotion rule

Do not promote the project just because a template offers more process. Promote
when the current amount of process fails to preserve context, safety, or evidence.

Good promotion triggers:

- You cannot remember what was tested.
- Agents repeat the same discovery work.
- A visual/UI regression slips through.
- More than one agent is working the repo.
- PRs need repeated human clarification.

Record promotions in `docs/decision-log.md` and update the maturity line in
`docs/current-stage.md`.
