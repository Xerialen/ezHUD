# AI-Assisted GitHub Project Template

A tiered, anti-drift project scaffold for AI-assisted software and research
projects with a single owner who needs strong structure, continuity, and
anti-drift safeguards — especially across multi-day breaks and context switches.

The goal is not software-engineering purity. The goal is to help the human and
AI agents identify the real goal, stay aligned with it, preserve context across
sessions, prevent scope creep, make progress through small measurable steps, and
document findings and decisions as first-class deliverables — **without building
a documentation burden that rots.**

This template is especially useful when working with Codex, Claude, ChatGPT,
GLM, or other coding agents.

## The four layers

Every project created from this template has four layers:

```text
1. Purpose layer     -> why are we doing this?
2. Control layer     -> how do we stay on track?
3. Execution layer   -> what should the agent do next?
4. Memory layer      -> what did we learn and decide?
```

The template should make it hard for the agent to start coding before it
understands the project — and hard for the owner to drown in docs they won't
maintain.

### Two principles that resolve every "how much process?" question

1. **Match ceremony to project size.** A throwaway spike does not need a roadmap.
   A multi-month effort does. Start at Tier 0 and add documents only when the
   project genuinely needs them.
2. **Docs are claims to re-verify, not truth to trust.** After a break, the doc
   most likely to be lying is `docs/current-stage.md`. Re-entry means *reconcile
   doc against reality*, then update the doc — never act on a stale claim. If a
   doc contradicts live state, trust live state and fix the doc.

### Progressive rigor

Each project has a maturity line in `docs/current-stage.md`:

```text
maturity: stage-0-idea | stage-1-prototype | stage-2-active | stage-3-multi-agent
```

Start at `stage-0-idea`. Promote only when the current process stops preserving
context, safety, or evidence. The reusable methodology lives in
`extras/docs/maturity-model.md`; copy it into `docs/` when a project needs the
promotion ladder to be explicit.

## The tiering system

Unpaid docs rot into lies. So most documents are opt-in. Only four files are
alive from day one; everything else is created only when a project earns it.

### Tier 0 — the living core (always present)

These four files are the heartbeat. If only these exist and stay current, the
project is healthy. They ship in `docs/` ready to use.

```text
AGENTS.md                    # the shared agent contract (includes the verification workflow)
coder.md                     # tool-agnostic implementation role
reviewer.md                  # tool-agnostic review role
machine-learning-reviewer.md # specialized ML/data review layer, used only when relevant
docs/current-stage.md        # the re-entry file — where are we, what's next, what NOT to do
docs/findings-log.md         # what we tried and learned
docs/decision-log.md         # forks taken and why
```

### Tier 1 — add when the project earns it

Create these the moment they'd actually help — not before. Copy them from
`extras/docs/` into `docs/`.

```text
docs/vision.md               # why this exists / north-star question (add once goal is non-obvious)
docs/project-brief.md        # current hypothesis + first milestone
docs/success-criteria.md     # what counts as success / what doesn't
docs/scope.md                # in-scope, non-goals, tempting distractions
docs/roadmap.md              # Mermaid stage map (add when there are >2 stages)
docs/open-questions.md       # unresolved questions table
docs/risks-and-assumptions.md
```

Add `docs/success-criteria.md` as soon as you have any real "done" definition —
the verification workflow (Hook 1 in `AGENTS.md`) depends on it.

### Tier 2 — add only for real engineering / data work

```text
docs/technical-context.md       # source maps, architecture, key files
docs/environment.md             # runbook: OS, paths, deps, commands, ports, secrets policy
docs/data-and-inputs.md         # datasets, APIs, media, validation rules
docs/testing-and-validation.md  # test commands, expected outputs, regression tests
docs/maturity-model.md          # copy from extras when process promotion matters
docs/test-cases-and-evidence.md # copy when durable test cases are needed
docs/agent-web-testing.md       # copy for active web apps
```

> **No number prefixes.** Files are named by meaning, not order. Renumbering when
> you insert a doc is pure friction, and worse — agent instructions that hardcode
> `docs/02_...` paths silently break the day you renumber. Reference docs by their
> stable name.

## How to start a new project

When creating a new project from this template, **do not start coding**, and
**do not create all the docs.** Start at Tier 0:

1. `AGENTS.md` ships as-is — it includes the verification workflow.
2. `coder.md` / `reviewer.md` define reusable roles; `CLAUDE.md` / `codex.md`
   are thin wrappers, already in place. `machine-learning-reviewer.md` is a
   specialized review layer for ML/data-impacting PRs.
3. Fill in `docs/current-stage.md` — goal, next step, `status: active`,
   `maturity: stage-0-idea`, `last-verified: today`.
4. `docs/findings-log.md` and `docs/decision-log.md` are empty and ready.

Then copy docs from `extras/` into `docs/` **only when the project earns them**
(see `extras/README.md`). Create the first issue (experiment or research
template) and give the agent:

```text
Read AGENTS.md and prompts/INITIAL_AGENT_PROMPT.md.
Then perform the current mission from docs/current-stage.md.
```

## Repository structure

```text
.
├── README.md
├── AGENTS.md
├── coder.md                   # tool-agnostic implementation role
├── reviewer.md                # tool-agnostic review role
├── machine-learning-reviewer.md # specialized ML/data review layer
├── CLAUDE.md                 # thin wrapper -> AGENTS.md
├── codex.md                  # thin wrapper -> AGENTS.md
├── agents/                   # reusable autonomous role cards
├── docs/                     # Tier 0 docs, present and ready
│   ├── current-stage.md
│   ├── findings-log.md
│   └── decision-log.md
├── extras/                   # opt-in Tier 1 + Tier 2 doc templates
│   ├── README.md
│   └── docs/
├── prompts/                  # lifecycle prompts, usable as-is
│   ├── INITIAL_AGENT_PROMPT.md
│   ├── CONTINUE_PROJECT_PROMPT.md
│   ├── REVIEW_PROJECT_STATE_PROMPT.md
│   └── END_SESSION_PROMPT.md
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── pull_request_template.md
│   └── workflows/            # docs-guard + markdown-check (warn-only)
├── experiments/
├── scripts/
└── src/
```

## Autonomous agent cards

The root `coder.md` and `reviewer.md` files are the default role contracts for
normal projects. They are intentionally tool-agnostic: the owner can assign
Claude, Codex, GLM, ChatGPT, or another capable agent to either role.

For ML/data-heavy projects, `machine-learning-reviewer.md` adds a stricter
evidence-chain review layer for data provenance, labels, splits, baselines,
metric meaning, train/serve parity, and claims that need raw artifacts behind
them. It is applied inside the normal review gate rather than as a separate
workflow.

The `agents/` directory contains heavier reusable role cards for unattended
AI-assisted development loops:

- `agents/phasekeeper.md` — developer role for one roadmap stage per PR.
- `agents/code-sentinel.md` — reviewer/hardener role for anti-slop and roadmap alignment.
- `agents/merge-warden.md` — merge-gate role for reviewed, phase-correct PRs.

Project-specific automations should point to these canonical cards and add only
the local repository path, active stage, PR/branch context, validation commands,
and temporary exceptions. Do not copy the full cards into project repos or notes
unless the project intentionally forks the behavior.

## Test cases and web testing

The template includes issue templates for user stories, bugs, experiments,
research, decisions, and durable test cases. For early spikes, ignore what you do
not need. For active projects, use:

- `extras/docs/test-cases-and-evidence.md` for durable test cases and logged
  test runs.
- `extras/docs/agent-web-testing.md` for browser-based agent validation.

The reusable rule is not "every repo gets all process immediately." The reusable
rule is "every repo has the same promotion path when it grows up."

## Parking & abandoning projects

A template for an owner who starts many projects needs an explicit *off-ramp*, or
dead repos masquerade as alive.

- Every `docs/current-stage.md` carries a `status:` field — `active`, `parked`,
  or `abandoned`.
- **Parked:** still intends to return. Set `status: parked`, and write one line:
  what would revive this and what's the first step when it does.
- **Abandoned:** not coming back. Set `status: abandoned`, write one line on
  *why*, and archive the GitHub repo. Don't delete — findings/decisions may
  inform future work.
- Use the `status:parked` / `status:abandoned` labels so a glance across repos
  shows what's actually alive.

## Suggested GitHub setup (not created automatically)

These are recommendations, not created by this template — set them up per project
as needed. Keep the set small; too many labels create noise.

- **Stage labels:** `stage:discovery`, `stage:lab`, `stage:build`,
  `stage:validation`, `stage:decision`
- **Type labels:** `type:research`, `type:experiment`, `type:bug`, `type:docs`,
  `type:decision`, `type:feature`, `type:story`, `type:test-case`
- **Status labels:** `status:inbox`, `status:next`, `status:active`,
  `status:blocked`, `status:needs-human`, `status:parked`, `status:abandoned`,
  `status:done`
- **Risk labels:** `risk:scope-creep`, `risk:unclear-goal`,
  `risk:technical-unknown`, `risk:stale-docs`
- **Milestones (phases, not dates):** `M0 - Understand`, `M1 - Prove Loop`,
  `M2 - Baseline`, `M3 - First Useful Version`, `M4 - Validate`,
  `M5 - Decide Next Track`
- **Project board (one simple board):** Inbox, Next, Doing, Blocked, Done. Do not
  create a complex board — complexity becomes a new project.

## The most important file

```text
docs/current-stage.md
```

It always answers: where are we (and is `last-verified` recent?), why does this
matter, what is the next smallest useful step, what should we not do right now,
what happened last time, is this project active/parked/abandoned, and which docs
need updates. This is the re-entry point after interruptions — **read it, then
verify it against the live repo before trusting it.**

## Operating rule

Every session should make the project easier to resume. If an agent writes code
but leaves the project harder to understand, the session has failed. The final
output of every meaningful session should include code or artifact changes,
evidence (the actual output, not a claim that it works), updated documentation,
and the next smallest useful step.
