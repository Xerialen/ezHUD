# Spec — publish Release 1 evidence + notes as rendered Pages

Status: approved for implementation (Sol). Reviewer: Claude.
Owner report: the GitHub blob links to `docs/release-1/*` show HTML source;
the evidence is unusable in a browser.

## Desired public URLs (after merge + Pages deploy)

- `https://xerialen.github.io/ezHUD/release-1/` — the evidence report,
  rendered, all screenshots loading.
- `https://xerialen.github.io/ezHUD/release-1/release-notes.html` — polished
  player-facing release notes.

## Requirements

1. **Assembly, allowlist-style.** `tools/fte-web/assemble-public.sh` copies an
   explicit list of files from `docs/release-1/` into `dist/release-1/`
   (index.html, release-notes.html, `img/` by exact filenames). No wildcard
   over `docs/`, no `cp -R docs`. A file added to `docs/release-1/` later must
   NOT ship until named — same review-step philosophy as the dist allowlist.
2. **`docs/release-1/index.html` stays offline-usable** from a checkout
   (relative `img/` paths as today). Whatever lands in `dist/release-1/` must
   keep those links working under the `/ezHUD/release-1/` prefix (relative
   links already do; do not absolutize).
3. **`release-notes.html`**: a hand-written static HTML page (no runtime JS,
   no CDN, self-contained CSS like index.html). `NOTES.md` is the canonical
   source; the HTML page carries the same content, player-voiced, plus
   links: evidence report (`./`), the app (`../`), the repo. Evidence report
   gains a link to the notes and to the app. Cross-links must be relative so
   they work both offline and under the Pages prefix.
4. **README**: replace repo-relative doc links for the report/notes with the
   public URLs (keep one source link to `docs/release-1/` for the checkout
   reader).
5. **Guards, RED first:**
   - Extend `tools/tests/tier1_public_dist.sh` expected allowlist with the
     exact new dist paths (`release-1/index.html`,
     `release-1/release-notes.html`, each `release-1/img/*` by name) — this
     test must FAIL before the assembler change and pass after.
   - A deterministic link/asset check (tier 1, node or bash): for both HTML
     files, every `src`/`href` that is relative resolves to an existing file
     in the assembled dist; both pages non-empty; every expected image
     non-empty. Observe RED (e.g. before release-notes.html exists).
   - Update the Pages workflow's real-dist guard (pages.yml step that checks
     the built dist) if it enumerates files.
6. **No scope creep**: do not touch `docs/release-1/img/*` sources, QA
   artifacts, unrelated branches, or the engine.

## Cases

1. Assembled dist contains exactly the named `release-1/` files —
   tier1_public_dist (RED before assembler change).
2. A poison file dropped into `docs/release-1/` (test fixture) does NOT reach
   the dist — allowlist proof, tier 1.
3. Both pages' relative links/images resolve inside the dist; pages and
   images non-empty — new tier-1 check (RED before release-notes.html).
4. README points at the public URLs — review check (`untested: docs`).
5. Live after merge: both URLs render with all screenshots HTTP 200 and zero
   console errors — reviewer's browser verification against the deployed
   site (this case is verified post-merge by Claude, not in CI).
