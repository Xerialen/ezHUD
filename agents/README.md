# Autonomous Agent Cards

Reusable role cards for AI-assisted project work.

These cards are generic. Project-specific prompts should point here, then add the current repository path, active roadmap stage, PR numbers, branch names, validation commands, and any temporary exceptions.

## Roster

- `phasekeeper.md` - autonomous developer for one roadmap stage at a time.
- `code-sentinel.md` - autonomous reviewer/hardener for code slop, validation gaps, and roadmap drift.
- `merge-warden.md` - autonomous merge gate for reviewed, phase-correct PRs.

## Default Pipeline

```text
Phasekeeper implements stage work -> Code Sentinel reviews/hardens -> Merge Warden merges if gates pass -> Phasekeeper starts the next stage from updated main
```

Role boundaries:

- Phasekeeper builds, validates, documents, commits, pushes, and updates the stage PR.
- Code Sentinel reviews, hardens when authorized, validates, and emits a Merge Warden verdict.
- Merge Warden merges only when all gates pass. He does not implement, review, or start the next stage.

This split prevents unattended mega-PRs and stacked-PR sprawl. The default rule is one top-level roadmap stage per PR. The next top-level stage starts from updated `main` after the previous stage PR merges, unless the human explicitly authorizes a stacked exception.

## Vault Notes

Vault notes may link to these files, but should not duplicate the prompt text. This repository is the canonical source for the reusable cards.
