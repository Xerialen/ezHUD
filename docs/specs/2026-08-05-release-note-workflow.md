# Spec — standardised release/change notes workflow (#57)

Status: approved for implementation (Sol). Reviewer: Opus 5 (release lead).
Exemplar: `docs/release-1` (#55 / PR #56) must satisfy this standard.

## 1. The canonical document

One file per user-visible release or change: **`docs/<slug>/NOTES.md`**.
Required structure — the guard parses exactly this, so keep it literal:

```markdown
# <Human title>

<one-paragraph summary for players>

## Features

### <Feature name>
<two or three sentences, player-facing: what you can now do, why it matters.
No issue numbers, no internal jargon.>

Evidence: img/<file>.png

### <Next feature>
...

## Discord payload

​```json
{
  "content": "...",
  "embeds": [
    { "title": "...", "description": "...", "image": { "url": "attachment://<name>.png" } }
  ],
  "allowed_mentions": { "parse": [] },
  "attachments": [ { "name": "<name>.png", "path": "img/<file>.png" } ]
}
​```
```

Rules the guard enforces:

- every `Evidence:` path resolves to a file that exists;
- the payload block is parseable JSON with a non-empty `content`, at least one
  embed, and every embed carrying `title`, `description` and an
  `image.url` of the form `attachment://<name>`;
- every `attachment://<name>` has a matching entry in `attachments`, whose
  `path` resolves to an existing file;
- non-image links inside `content` are wrapped in `<…>` (preview suppression);
- no `/home/`, `/Users/`, `$USER`, hostname or `file://` anywhere in the file.

`attachments` exists so the coordinator knows exactly which local file to
upload under which filename — that is the whole point of the payload being
prepared rather than described.

## 2. Internal-only exemption

A change with no user-visible effect needs no images and no payload. It must
say so explicitly in its ticket, and the PR carries the `internal-only` label.
The guard then passes with a notice. The exemption is recorded, never implied.

## 3. Ticket template

`.github/ISSUE_TEMPLATE/release-change.md`, pre-filled with:

- the canonical document path field (`docs/<slug>/NOTES.md`);
- a checklist: notes document written · evidence images mapped · Discord
  payload prepared · reviewed by release lead · owner Go received;
- an internal-only exemption box with a reason field;
- a `## Cases` section, because the existing convention (#35) still applies.

## 4. The guard

`tools/ci/release_note_gate.mjs`, following the shape of `cases_gate.mjs`:
a pure `decideReleaseNoteGate({ prBody, labels, repoRoot })` returning
`{ ok, reason, notice }`, plus a thin `main()` doing the I/O. Unit-tested in
`tools/tests/release_note_gate.test.mjs` (tier 1) covering issue #57's Cases
1–6, each observed RED first.

Trigger: `.github/workflows/release-note-gate.yml` on `pull_request`
[opened, edited, synchronize, labeled, unlabeled], and the gate only *applies*
when the PR carries the `user-visible` or `release` label. Any other PR passes
untouched — this must not become a tax on ordinary changes.

## 5. The flow document

`docs/RELEASE-NOTE-WORKFLOW.md`, short and concrete:

spec → RED gate → Sol implements → **Opus independently reviews the current
head SHA** (never a reused PASS from a superseded commit) → green CI plus
browser validation at desktop and phone width → private one-message #outbox
draft for owner review → owner Go → merge → Pages deploy → live verification.

State plainly that merging to `main` auto-deploys Pages, so merge *is*
publication and waits for Go.

## 6. Make release-1 the exemplar

Consolidate into `docs/release-1/NOTES.md`: the player-facing content
currently in `RELEASE-NOTES.md` plus the message in `ANNOUNCEMENT-discord.md`,
restructured into the shape above, with the corrected focused annotated assets
mapped per feature. Retire the two old files and update any reference to them.
`release-notes.html` stays as the published Pages page; keep it consistent with
the canonical document. Move the announcement assertions out of
`tier1_release_annotations.mjs` into the new gate's unit tests where they now
belong, leaving the annotation guard about images.

## Out of scope

Merging, publishing, posting to Discord, and any change to unrelated tickets.
