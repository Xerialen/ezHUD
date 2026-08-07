---
name: Release / user-visible change
about: Plan player-facing notes, evidence, Discord payload, and observable test cases
title: ""
labels: user-visible
assignees: ""
---

## What changes for players

<!-- Describe the player-visible result without implementation jargon. -->

## Canonical document

<!-- Replace <slug>; repeat this exact path in the implementing PR body. -->
Canonical document: `docs/<slug>/NOTES.md`

Every player-facing feature block in that document carries all three fields, plus its evidence mapping:

```markdown
### <Feature name>
Before: what the player could do before.
After: what is different now.
Value: why they should care.

Evidence: img/<file>.png
```

## Release checklist

- [ ] Canonical notes document written
- [ ] Every feature block states `Before:`, `After:` and `Value:`
- [ ] Evidence images mapped with `Evidence: img/<file>.png`
- [ ] Discord payload and explicit attachment mappings prepared
- [ ] Reviewed by the release lead against the current head SHA
- [ ] Owner Go received

## Internal-only exemption

<!-- Check only when there is no user-visible effect, add the internal-only label, and repeat this record in the PR body. -->
- [ ] This change has no user-visible effect and requires no player notes, images, or Discord payload.
Reason: <!-- Required when the exemption is checked. -->

## Cases

<!--
1. <operate the release/change workflow> → <observable result>
2. <missing or invalid release artifact> → <specific gate failure>
-->

Test-plan convention: see `docs/TESTING.md`.
