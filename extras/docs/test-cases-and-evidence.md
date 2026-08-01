# Test Cases and Evidence

Use this document when the project has matured beyond one-off exploration and
needs repeatable validation.

## Core model

```text
User Story
  owns acceptance criteria and user value

Test Case
  durable reusable check for one behavior

Test Run
  one execution of a test case against a PR, commit, build, or environment

Evidence
  logs, screenshots, command output, browser results, CI links, generated artifacts
```

The test case survives. The test run records what happened this time.

## Lifecycle

```text
draft -> active -> automated | retired
             \-> superseded
```

- `draft`: proposed but not yet trusted.
- `active`: reusable and expected to be run when relevant code changes.
- `automated`: covered by a committed test; keep the case as traceability.
- `retired`: behavior no longer exists or no longer matters.
- `superseded`: replaced by a newer case; link the replacement.

## Result states

- `passed`: observed behavior matched expected behavior.
- `failed`: observed behavior did not match expected behavior.
- `blocked`: setup/tooling/environment prevented execution.
- `skipped`: intentionally not run, with reason.

## Test case template

```md
## TC-AREA-001: Behavior name

Area:
Story:
Type: Manual / Browser / Unit / Integration / Regression
Priority:
Status:

### Preconditions

### Steps
1.
2.
3.

### Expected result

### Evidence required
- Commit SHA
- Environment
- Command output, screenshot, log, metric, or browser check
```

## Test run template

```md
## Test Run Evidence

Test run:
PR:
Commit:
Date:
Environment:

### Results
- [x] TC-AREA-001 passed
- [ ] TC-AREA-002 failed

### Evidence
- Command/browser/log output:
- Links:
- Follow-up bugs:
```

## Storage

- Durable stories: GitHub issues.
- Durable test cases: GitHub issues or `docs/`.
- PR-specific test runs: PR body or PR comment.
- Long-term findings: `docs/findings-log.md`.
- Decisions: `docs/decision-log.md`.
- Automated regressions: committed test files.
