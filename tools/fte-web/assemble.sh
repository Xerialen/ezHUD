#!/usr/bin/env bash
# Assemble the FTE-web preview site.
#
# The site is a directory of engine files (which are never committed -- see
# spikes/fte-web/NOTES.md) plus the editor's own sources. The editor half is
# symlinked rather than copied, so editing hud_web_ui/ and reloading the page
# is the whole iteration loop; python's http.server follows symlinks. The
# engine half is copied, because those files come from a build tree that gets
# rebuilt and cleaned underneath us.
#
# Idempotent: run it as often as you like.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

site_dir=${SITE_DIR:-$workspace/site}
engine_dir=${FTE_RELEASE_DIR:-$workspace/fteqw/engine/release}
ui_dir=$repo_dir/hud_web_ui

# The site holds the user's paks and demos. Creating it empty would be a lie by
# omission: the page would load and then fail to boot with no explanation.
if [ ! -d "$site_dir" ]; then
	echo "assemble.sh: no site directory at $site_dir" >&2
	echo "  It holds the game data the engine loads: default.fmf, id1/pak0.pak," >&2
	echo "  id1/pak1.pak and qw/demos/*.mvd. Create it and put those there first." >&2
	exit 1
fi

link() {
	local src=$1 name=$2
	if [ ! -e "$src" ]; then
		echo "assemble.sh: missing $src" >&2
		exit 1
	fi
	# -n so that relinking a directory replaces the link instead of dropping a
	# new link *inside* the directory it already points at.
	ln -sfn "$src" "$site_dir/$name"
}

for name in index-fte.html ui.css favicon.svg core view fte; do
	link "$ui_dir/$name" "$name"
done

copied=0
missing=0
for name in ftewebglcl.html ftewebglcl.js ftewebglcl.wasm; do
	if [ ! -f "$engine_dir/$name" ]; then
		missing=$((missing + 1))
		continue
	fi
	# -u: only if newer. A wasm rebuild is 4.7MB and the common case is that
	# nothing changed.
	if cp -u "$engine_dir/$name" "$site_dir/$name"; then
		copied=$((copied + 1))
	fi
done

if [ "$missing" -gt 0 ]; then
	echo "assemble.sh: $missing engine file(s) not in $engine_dir — keeping what the site already has." >&2
	echo "  Build with: cd $workspace/fteqw/engine && unset CFLAGS CXXFLAGS LDFLAGS && make webcl-rel -j20" >&2
fi

echo "assemble.sh: $site_dir ready ($copied engine file(s) up to date, editor sources symlinked)."
