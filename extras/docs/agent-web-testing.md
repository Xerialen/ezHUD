# Agent Web Testing

Use this document when the project is a web app or has important browser-based
workflows.

## Default rule

Every meaningful web/UI change should be validated by an agent in a real browser
before it is called done.

Builds and unit tests are necessary, but they do not prove the visible workflow.

## Evidence to record

```text
URL tested:
Commit SHA:
Viewport(s):
Browser/tool used:
Console errors:
Network failures:
Screenshots/video/geometry:
Test cases run:
Result:
```

## Tooling pattern

Use the best browser tool available in the current runtime:

- Chrome DevTools / CDP for console, network, DOM, and performance debugging.
- Playwright for repeatable flows, screenshots, and viewport checks.
- The active in-app browser when it is the user-facing surface being debugged.

## Repeatable automation path

When a manual browser case is repeated often or protects important behavior,
promote it to Playwright or an equivalent browser test.

Suggested scripts for web packages:

```json
{
  "test:web": "playwright test",
  "test:web:headed": "playwright test --headed",
  "test:web:report": "playwright show-report"
}
```

Do not add these dependencies to every new spike by default. Add them when the
project reaches the maturity level where repeated UI regressions are more
expensive than the test harness.

## Agent checklist

- Did the browser open the exact URL the user will use?
- Did the visible workflow work, not just the component render?
- Did console or network errors point to the changed code?
- Did the layout work at relevant viewport sizes?
- Is the result tied to a durable test case or clearly marked exploratory?
