#!/usr/bin/env bash
# Guard for the public build: what assemble-public.sh ships, exactly.
#
# The risk this exists for is a file reaching a public deploy that is not ours
# to publish -- id1/pak1.pak (registered Quake) or the owner's personal configs
# and texture packs. Reviewing the script is not enough; a `cp -R` added later
# in good faith is all it takes. So this asserts the shipped name list against
# a literal allowlist, and re-derives that list here on purpose: a test that
# read the allowlist from the script it is testing would prove nothing.
#
# Fixture-driven and offline. The engine and the paks are tiny placeholder
# files, because the guard is about names, never content.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# Repo convention (tools/tests/tier2_engine.sh, tier4_under_xvfb.sh): a
# prefixed temp dir, removed on the way out. TMPDIR is honoured so a sandbox
# can keep the whole run inside the workspace.
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/ezquake-hud-tier1-public.XXXXXX")
trap 'rm -rf "$run_dir"' EXIT

fail() {
	echo "tier1_public_dist: $*" >&2
	exit 1
}

# The allowlist, as dist-relative paths. Adding a file to hud_web_ui/view/ or
# hud_web_ui/fte/ is expected to fail this test until the name is added here --
# that is the review step, not an accident.
expected="core/bridge.js
core/fte-adapter.js
core/geometry.js
core/log.js
core/model.js
core/quake-palette.js
default.fmf
favicon.svg
fte/boot.js
fte/chrome.js
fte/fte.css
fte/import.js
ftewebglcl.js
ftewebglcl.wasm
id1/gpl_maps.pk3
id1/nquake.pk3
id1/pak0.pak
id1/qrp-dm3.pk3
index.html
qw/demos/hudtest_src.mvd
qw/demos/tb4gf_book_vs_s.mvd
qw/fragfile.dat
release-1/img/after-bar.png
release-1/img/after-paused.png
release-1/img/after-resized-window.png
release-1/img/after-state.json
release-1/img/before-resized-window.png
release-1/img/before-state.json
release-1/img/pause-resume-focused-annotated.png
release-1/img/window-follow-focused-annotated.png
release-1/index.html
release-1/release-notes.html
ui.css
view/app.js
view/debug.js"

# ---- fixtures -------------------------------------------------------------

engine_dir=$run_dir/engine
game_data_dir=$run_dir/game-data
release_docs_dir=$run_dir/docs/release-1
dist_dir=$run_dir/dist

mkdir -p "$engine_dir" "$game_data_dir/id1" "$game_data_dir/qw/demos" "$run_dir/docs"
cp -R "$repo_dir/docs/release-1" "$release_docs_dir"
# ftewebglcl.html exists here and must not be shipped: our index.html replaces
# the stock FTE shell.
for name in ftewebglcl.html ftewebglcl.js ftewebglcl.wasm; do
	echo "placeholder $name" > "$engine_dir/$name"
done
for rel in id1/pak0.pak id1/nquake.pk3 id1/gpl_maps.pk3 id1/qrp-dm3.pk3 qw/demos/hudtest_src.mvd qw/demos/tb4gf_book_vs_s.mvd; do
	echo "placeholder $rel" > "$game_data_dir/$rel"
done
# The poison. Both sit in the real dev site, so a build that scooped up its
# input directory would pick them up here too.
echo "placeholder pak1" > "$game_data_dir/id1/pak1.pak"
echo "placeholder owner config" > "$game_data_dir/owner-config.cfg"
# A normal (non-dotfile) source beside the reviewed release files. A wildcard
# over docs/release-1 would publish it; the explicit document allowlist must not.
echo "release docs poison" > "$release_docs_dir/tier1-poison-do-not-ship.txt"

# ---- build ----------------------------------------------------------------

DIST_DIR=$dist_dir \
ENGINE_DIR=$engine_dir \
GAME_DATA_DIR=$game_data_dir \
RELEASE_DOCS_DIR=$release_docs_dir \
BASE_PATH=/ezHUD/ \
	bash "$repo_dir/tools/fte-web/assemble-public.sh" > "$run_dir/assemble.log" 2>&1 ||
	{ cat "$run_dir/assemble.log" >&2; fail "assemble-public.sh failed"; }

# 1. exactly the allowlist -- extra files and missing files both fail.
actual=$(cd "$dist_dir" && find . -type f -printf '%P\n' | sort)
if [ "$actual" != "$expected" ]; then
	echo "tier1_public_dist: dist contents do not match the allowlist" >&2
	diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") \
		--label allowlist --label dist -u >&2 || true
	fail "update the allowlist in this file if the change is intentional"
fi

# 2. poison, named explicitly so a failure says what leaked rather than "extra
# file". Redundant with 1 by construction; cheap, and it is the assertion the
# whole exercise is for.
for poison in id1/pak1.pak owner-config.cfg release-1/tier1-poison-do-not-ship.txt; do
	[ ! -e "$dist_dir/$poison" ] || fail "$poison reached the dist"
done

# 3. Every local link in the release pages resolves in this exact dist, and
# every page and reviewed release asset has bytes.
node "$repo_dir/tools/tests/tier1_release_pages.mjs" "$dist_dir" ||
	fail "release page integrity check failed"

# 4. the import map is resolved URLs, so an unrewritten key is a page that
# loads the ezQuake bridge under a Pages prefix and reports a lost connection.
grep -qF '"/ezHUD/core/bridge.js"' "$dist_dir/index.html" ||
	fail "index.html has no '/ezHUD/core/bridge.js' import-map key"
grep -qF '"/ezHUD/core/fte-adapter.js"' "$dist_dir/index.html" ||
	fail "index.html import-map value still points outside the base path"
! grep -qF '"/core/bridge.js"' "$dist_dir/index.html" ||
	fail "index.html still carries the root-served '/core/bridge.js' key"

# 5. the seeder filters as hard as the assembler does.
site_dir=$run_dir/site
staged=$run_dir/staged
mkdir -p "$site_dir/id1" "$site_dir/qw/demos"
for rel in id1/pak0.pak id1/gpl_maps.pk3 id1/qrp-dm3.pk3 qw/demos/hudtest_src.mvd qw/demos/tb4gf_book_vs_s.mvd; do
	echo "placeholder $rel" > "$site_dir/$rel"
done
# At the site root, which is where the dev site actually keeps it.
echo "placeholder nquake" > "$site_dir/nquake.pk3"
echo "placeholder pak1" > "$site_dir/id1/pak1.pak"
echo "placeholder owner config" > "$site_dir/owner-config.cfg"
echo "placeholder owner textures" > "$site_dir/owner-textures.pk3"
echo "placeholder hud art" > "$site_dir/xerial-hud-art.pk3"

SITE_DIR=$site_dir GAME_DATA_DIR=$staged \
	bash "$repo_dir/tools/fte-web/stage-game-data.sh" > "$run_dir/stage.log" 2>&1 ||
	{ cat "$run_dir/stage.log" >&2; fail "stage-game-data.sh failed"; }

staged_actual=$(cd "$staged" && find . -type f -printf '%P\n' | sort)
staged_expected="id1/gpl_maps.pk3
id1/nquake.pk3
id1/pak0.pak
id1/qrp-dm3.pk3
qw/demos/hudtest_src.mvd
qw/demos/tb4gf_book_vs_s.mvd"
if [ "$staged_actual" != "$staged_expected" ]; then
	diff <(printf '%s\n' "$staged_expected") <(printf '%s\n' "$staged_actual") \
		--label allowlist --label staged -u >&2 || true
	fail "stage-game-data.sh staged something off the allowlist"
fi

echo "tier1_public_dist: ok (dist allowlist, docs poison, release links/assets, import map, staging)."
