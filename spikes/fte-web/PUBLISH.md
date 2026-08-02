# Publishing the FTE-web editor — sanitized public build

Spec for making the FTE-web editor deployable to GitHub Pages without ever
shipping non-distributable or personal files. Written 2026-08-02; the dev
site this sanitizes is described in SPEC.md and NOTES.md.

## The problem

The dev site (`../site/`, outside the repo) mixes four kinds of content:

1. **Ours / GPL** — `hud_web_ui/` sources, the FTE engine build
   (`ftewebglcl.js/.wasm`; FTE is GPLv2+, our patches are in `fteqw.diff`).
2. **Distributable game data** — shareware `id1/pak0.pak` (1.06),
   `nquake.pk3` (community art nQuake itself distributes), the two demos
   (`hudtest_src.mvd` is the owner's own synthetic recording;
   `tb4gf_book_vs_s.mvd` is an openly shared match demo).
3. **Non-distributable** — `id1/pak1.pak` (registered Quake, copyrighted).
4. **Personal** — `owner-config.cfg`, `owner-textures.pk3`,
   `xerial-hud-art.pk3`: the owner's files, staged for parity testing only.

Categories 3 and 4 must be structurally unable to reach a public deploy.

## Design rules

- **Allowlist, never denylist.** The public artifact is assembled from
  scratch (`rm -rf` first) by copying an explicit list of files. Nothing is
  ever "site/ minus the bad parts". `../site/` is *never* a source for game
  data in CI; locally it may seed a game-data dir for offline testing.
- **Binaries never enter git.** Game data reaches CI as pinned-hash
  downloads (a GitHub Release on this repo for the demos; upstream mirrors
  for pak0/nQuake). The engine is built in CI from pinned source + our diff.
- **Every download is hash-pinned** (sha256, computed from the known-good
  local copies) and the build fails loudly on mismatch.
- **The guard is a test, not a habit**: a tier1-runnable check that fails if
  the dist contains anything off the allowlist, or misses anything on it.

## Deliverable A — `tools/fte-web/assemble-public.sh` (+ guard test)

A sibling of `assemble.sh` (which stays as the dev-loop tool; do not break
it). Builds a deployable `dist/` from scratch. No network access — all
inputs are local directories, so it runs identically in CI and offline.

Inputs (env, all with sane defaults relative to the repo):

- `DIST_DIR` — output, default `<workspace>/dist`. Deleted and recreated.
- `ENGINE_DIR` — where `ftewebglcl.js` + `ftewebglcl.wasm` are, default
  `<workspace>/fteqw/engine/release`.
- `GAME_DATA_DIR` — a dir laid out exactly like the game-data half of the
  dist (`id1/pak0.pak`, `id1/nquake.pk3`, `qw/demos/*.mvd`). In CI this is
  populated by the workflow's downloads; locally
  `tools/fte-web/stage-game-data.sh` (small helper, part of this
  deliverable) seeds it from `../site/` — copying ONLY the allowlisted
  names, never pak1 or `owner-*`/`xerial-*`.
- `BASE_PATH` — URL prefix the site will be served under, default `/`.
  For a GitHub Pages project site: `/ez-hud/`. Must start and end with `/`.

The dist allowlist (exhaustive — the script copies exactly this):

    index.html            <- hud_web_ui/index-fte.html, transformed (below)
    ui.css favicon.svg    <- hud_web_ui/
    core/*.js             <- hud_web_ui/core/ WITHOUT core/tests/
    view/**               <- hud_web_ui/view/
    fte/**                <- hud_web_ui/fte/
    ftewebglcl.js ftewebglcl.wasm   <- ENGINE_DIR (ftewebglcl.html is NOT
                                       shipped; our page replaces it)
    default.fmf           <- generated here (copy the dev site's current
                            one into the repo as tools/fte-web/default.fmf
                            first — it is a 10-line text manifest, not a
                            binary — and treat that as the source of truth)
    id1/pak0.pak id1/nquake.pk3 id1/gpl_maps.pk3   <- GAME_DATA_DIR
    qw/demos/hudtest_src.mvd qw/demos/tb4gf_book_vs_s.mvd  <- GAME_DATA_DIR

(`id1/gpl_maps.pk3` was added in review: both bundled demos play on dm3,
which shareware pak0 does not contain — it ships e1/start only — and FTE's
runtime map download cannot work from a Pages origin, since the community
map repo hosts no id maps and sends no CORS headers. nQuake's GPL remakes
of the id maps close the gap without shipping registered content.)

The `index.html` transformation, and the one subtle bit: import-map keys
are resolved URLs, so the dev page's `"/core/bridge.js"` key only matches
when served from the site root. The script rewrites the key to
`"${BASE_PATH}core/bridge.js"`. Do it with a marker-free, exact-string
`sed`/`node` replacement and **fail if the pattern is not found exactly
once** (a silently unrewritten import map = editor half-works in prod).
Everything else already uses relative URLs (verify, don't assume: grep the
shipped html/js for root-absolute `/` references and fix any stragglers the
same way).

Guard test: `tools/tests/tier1_public_dist.sh`, wired into
`tools/tests/tier1.sh`. No network. It builds a throwaway dist from fixture
game data (tiny generated placeholder files are fine — the guard checks
*names*, not content) with `BASE_PATH=/ez-hud/`, then asserts:

1. `find dist -type f | sort` equals the allowlist exactly (fail on extra
   AND on missing).
2. Poison check: seed the fixture GAME_DATA_DIR with `id1/pak1.pak` and
   `owner-config.cfg` too, and assert they do NOT land in dist.
3. The import-map key in dist/index.html is `"/ez-hud/core/bridge.js"` and
   the old `"/core/bridge.js"` key is gone.
4. `stage-game-data.sh`, pointed at a fixture "site" containing both good
   and poison names, copies only the good ones.

Also: a `tools/fte-web/serve-public.sh` that serves the dist under the
BASE_PATH prefix locally (python http.server from a temp dir where
`./ez-hud` symlinks to the dist), so the subpath behaviour is testable in a
real browser before anything is deployed. Print the exact URL to open.

## Deliverable B — CI: `.github/workflows/pages.yml`

Build-and-deploy for GitHub Pages via the Actions artifact flow (no
gh-pages branch, no binaries in git). Triggers: push to `main`, plus
`workflow_dispatch`. Single job sequence:

1. **Engine build.** Checkout `fte-team/fteqw` at the pinned commit
   `f937b9d` (record the full 40-char sha in the workflow), apply
   `spikes/fte-web/fteqw.diff`, install emsdk pinned to the version in
   NOTES.md, `unset CFLAGS CXXFLAGS LDFLAGS`, `make webcl-rel` from
   `engine/`. Cache both the emsdk install and the build tree keyed on
   (emsdk version, fteqw sha, diff hash) — a cold build is minutes, warm
   should be seconds. NOTES.md documents every trap already hit
   (dead-stripped exports, the CFLAGS leak, Makefile relink); read it
   before writing the build steps.
2. **Game data.** Download into `GAME_DATA_DIR`, each with a pinned sha256
   verified before use:
   - `pak0.pak` — shareware 1.06 from a stable public mirror. Compute the
     pin from `../site/id1/pak0.pak`; if no mirror serves a byte-identical
     file, extract from the canonical `quake106` shareware archive in the
     workflow instead. Do not ship anything whose hash we did not pin.
   - `nquake.pk3` — from nQuake's own distribution, same hash-pin rule.
   - the two `.mvd`s — from this repo's GitHub Release tag `web-assets-v1`
     (`releases/download/web-assets-v1/<name>`). Write (but do NOT run)
     `tools/fte-web/upload-web-assets.sh`: creates that release and uploads
     the two local files via the REST API with `curl` — `gh` is not
     installed; token from `$GITHUB_TOKEN`, never echoed. The reviewer
     runs it once, after explicit owner approval.
3. **Assemble + guard.** Run `assemble-public.sh` with
   `BASE_PATH=/ez-hud/`, then the guard test against the REAL dist (the
   name-allowlist assertions; poison-seeding is the fixture test's job).
4. **Deploy.** `actions/upload-pages-artifact` + `actions/deploy-pages`,
   with the standard `pages: write`/`id-token: write` permissions, deploy
   step gated to `github.ref == 'refs/heads/main'`.

Also update NOTES.md with a short "publishing" section: what the workflow
does, where the pins live, how to roll the release tag when demos change.

## Explicitly out of scope (the reviewer does these, with owner approval)

- Running `upload-web-assets.sh` (creates a public release).
- Pushing any of this to `origin` (the workflow going live IS the deploy).
- Enabling Pages in repo settings.
- Interactive browser verification of the served dist.

## Constraints (unchanged from SPEC.md, they all still apply)

- Never write outside `/home/xerial/Dev/ez-hud-fte`; never touch
  `~/quake*` or `~/.ezquake*` (reading is fine).
- No system packages, no sudo, no npm installs. `gh` is not installed.
- Binaries are never committed; `default.fmf` is text and is the one file
  this spec moves into the repo.
- `npm run test:tier1` must pass when you are done, including your new
  guard test. Do not install Playwright browsers.
- Commit on `main` in logical commits. Do not push.
- Match the repo's comment voice: say *why*, cite the fact that forced the
  choice.
