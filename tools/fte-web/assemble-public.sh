#!/usr/bin/env bash
# Assemble the public FTE-web site — the artifact that gets deployed.
#
# A sibling of assemble.sh, not a mode of it. The dev loop wants symlinks into
# hud_web_ui/ and a site dir that already holds the owner's own files; this one
# has to be able to state exactly what it shipped. So it builds from scratch
# (rm -rf first) and copies one explicit list of names.
#
# Never "the site minus the bad parts". The dev site sits next to
# id1/pak1.pak (registered Quake, not ours to distribute) and the owner's
# owner-config.cfg / owner-textures.pk3 / xerial-hud-art.pk3; a denylist ships
# whatever nobody thought to name, an allowlist cannot. See
# spikes/fte-web/PUBLISH.md.
#
# No network: every input is a local directory, so CI and a laptop run this the
# same way.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

dist_dir=${DIST_DIR:-$workspace/dist}
engine_dir=${ENGINE_DIR:-$workspace/fteqw/engine/release}
# Laid out exactly like the game-data half of the dist. In CI the workflow
# fills it with hash-pinned downloads; locally tools/fte-web/stage-game-data.sh
# seeds it from the dev site. Never the dev site itself: this script must not
# be pointed at a directory that also contains pak1 and the owner's files.
game_data_dir=${GAME_DATA_DIR:-$workspace/game-data}
base_path=${BASE_PATH:-/}
ui_dir=$repo_dir/hud_web_ui

# The base path ends up spliced into an import map, where a missing trailing
# slash silently produces "/ez-hudcore/bridge.js" -- a key that matches nothing
# and a page that half-works. Refuse the input instead.
case $base_path in
	/*/) ;;
	/) ;;
	*)
		echo "assemble-public.sh: BASE_PATH must start and end with '/' (got '$base_path')" >&2
		exit 1
		;;
esac

# This script's first act is rm -rf and DIST_DIR is an environment variable.
case $dist_dir in
	"" | / | "$HOME" | "$repo_dir" | "$workspace")
		echo "assemble-public.sh: refusing to rm -rf '$dist_dir'" >&2
		exit 1
		;;
esac

for dir in "$engine_dir" "$game_data_dir"; do
	if [ ! -d "$dir" ]; then
		echo "assemble-public.sh: no such directory: $dir" >&2
		echo "  Engine: build with 'make webcl-rel' (spikes/fte-web/NOTES.md)." >&2
		echo "  Game data: seed with tools/fte-web/stage-game-data.sh." >&2
		exit 1
	fi
done

# Missing inputs are fatal, never skipped. A dist that is quietly short one pak
# boots into a black canvas, which looks like an engine bug rather than a build
# that did not have the file.
copy() { # copy <src> <path-relative-to-dist>
	local src=$1 rel=$2
	if [ ! -f "$src" ]; then
		echo "assemble-public.sh: missing $src" >&2
		exit 1
	fi
	mkdir -p "$dist_dir/$(dirname "$rel")"
	cp "$src" "$dist_dir/$rel"
}

rm -rf "$dist_dir"
mkdir -p "$dist_dir"

# ---- the editor -----------------------------------------------------------

copy "$ui_dir/index-fte.html" index.html
copy "$ui_dir/ui.css" ui.css
copy "$ui_dir/favicon.svg" favicon.svg

# A glob at this level, not `cp -R core`, because core/tests/ is a directory
# and so cannot match *.js -- the unit tests are structurally unable to ship.
for src in "$ui_dir"/core/*.js; do
	copy "$src" "core/$(basename "$src")"
done

# These two are entirely ours (no game data, no personal files), so a
# recursive copy is honest here; tools/tests/tier1_public_dist.sh asserts the
# resulting name list, which is what stops a stray file riding along.
cp -R "$ui_dir/view" "$dist_dir/view"
cp -R "$ui_dir/fte" "$dist_dir/fte"

# ---- the engine -----------------------------------------------------------

# ftewebglcl.html is deliberately absent: it is the stock FTE shell and our
# index.html replaces it. Shipping it would publish a second entry point that
# boots the engine with no editor attached and no ezhud plugin arguments.
for name in ftewebglcl.js ftewebglcl.wasm; do
	copy "$engine_dir/$name" "$name"
done

# ---- game data ------------------------------------------------------------

# In the repo rather than generated, because it is a 6-line text manifest that
# the engine reads by name (-manifest default.fmf, fte/boot.js) and a build
# artifact nobody can diff is the wrong shape for something that decides which
# gamedirs mount.
copy "$repo_dir/tools/fte-web/default.fmf" default.fmf

# gpl_maps.pk3 is load-bearing: both bundled demos are on dm3, which the
# shareware pak0 does not contain and FTE cannot download at runtime from a
# Pages origin (no id maps and no CORS on the community map repo). The GPL
# remake nQuake ships is what makes the demos playable at all.
# qrp-dm3.pk3: QRP's replacements for exactly the textures dm3 names, so the
# GPL remake reads as real dm3 rather than bare walls. Built by
# tools/fte-web/build-qrp-subset.py; shipped from our web-assets release.
for rel in id1/pak0.pak id1/nquake.pk3 id1/gpl_maps.pk3 id1/qrp-dm3.pk3 qw/demos/hudtest_src.mvd qw/demos/tb4gf_book_vs_s.mvd; do
	copy "$game_data_dir/$rel" "$rel"
done

# ---- the import map -------------------------------------------------------

# Import-map keys and values are resolved URLs, not the text of a specifier
# (see index-fte.html's own comment). The dev page's "/core/bridge.js" only
# matches what view/app.js's '../core/bridge.js' resolves to when the page is
# served from the site root; under a GitHub Pages project prefix it stops
# matching, the real core/bridge.js loads instead, and the editor reports a
# lost ezQuake connection rather than a broken deploy. The map's *value* needs
# the same treatment for the same reason -- "/core/fte-adapter.js" resolves to
# the domain root, which is a 404 under a prefix.
#
# Exact-string replacement with a hard count check, deliberately: a marker
# comment could be edited away, and a sed that matched nothing would ship a
# dist that half-works.
python3 - "$dist_dir/index.html" "$base_path" <<'PY'
import sys

path, base = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    html = f.read()

for name in ('bridge.js', 'fte-adapter.js'):
    old = '"/core/%s"' % name
    new = '"%score/%s"' % (base, name)
    found = html.count(old)
    if found != 1:
        sys.exit('assemble-public.sh: expected %s exactly once in index.html, found %d.\n'
                 '  The import map in hud_web_ui/index-fte.html changed shape; '
                 'this rewrite must be updated with it.' % (old, found))
    html = html.replace(old, new)

with open(path, 'w', encoding='utf-8') as f:
    f.write(html)
PY

files=$(find "$dist_dir" -type f | wc -l)
echo "assemble-public.sh: $dist_dir ready ($files files, BASE_PATH=$base_path)."
