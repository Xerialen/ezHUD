# Release-note workflow

Use this flow for every change carrying the `user-visible` or `release` label. Ordinary PRs are outside the release-note gate.

1. **Spec.** Record the behaviour and observable Cases in the ticket. Name one canonical `docs/<slug>/NOTES.md` path. If the change is genuinely internal-only, check the exemption, give its reason, and use the `internal-only` label instead of inventing player evidence.
2. **RED gate.** Add the failing release-note gate coverage before implementation. The failure must demonstrate the missing or invalid requirement rather than an unrelated setup error.
3. **Sol implements.** Build the change, canonical notes, mapped evidence files, and complete Discord payload from the approved spec.
4. **Independent review.** Opus independently reviews the **current head SHA**. The review is never a reused PASS from a superseded commit; any changed head receives a new review.
5. **Green validation.** Require green CI plus browser validation at desktop and phone width. Evidence, captions, links, and the assembled public artifact are checked at both widths.
6. **Private draft.** Prepare one private, one-message `#outbox` draft from the canonical JSON payload. Upload each file under the exact attachment name declared in `attachments`; do not redesign the message while posting.
7. **Owner Go.** The owner reviews the current result and explicitly authorises publication.
8. **Merge → Pages deploy → live verification.** After owner Go, merge; then verify the live notes, evidence, attachment rendering, and links after Pages deploys. The PR body must carry a `## Changedrop` section — either form A (`run`/`output`/`sha256`/`publish.state: withheld`/`delivered`) when a film was rendered, or form B (`decision: skip` / `Reason`) when the changedrop analyzer chose not to render one.

Merging `main` auto-deploys Pages. **Merge is publication**, so merging waits for owner Go rather than treating deployment as a later reversible step.
