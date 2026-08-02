#!/usr/bin/env bash
# Seed a GAME_DATA_DIR for tools/fte-web/assemble-public.sh from the dev site.
#
# Local convenience only. In CI the same directory is filled by hash-pinned
# downloads (spikes/fte-web/PUBLISH.md) and the dev site does not exist at all;
# this script is what lets the public build be exercised offline.
#
# The dev site is the one place the distributable game data and the
# non-distributable game data sit side by side: id1/pak1.pak is registered
# Quake, and owner-config.cfg / owner-textures.pk3 / xerial-hud-art.pk3 are the
# owner's personal files, staged for parity testing. So this copies by name,
# one literal at a time -- it has no way to express "everything except", which
# is the point.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

site_dir=${SITE_DIR:-$workspace/site}
game_data_dir=${GAME_DATA_DIR:-$workspace/game-data}

if [ ! -d "$site_dir" ]; then
	echo "stage-game-data.sh: no site directory at $site_dir" >&2
	echo "  It is the dev site tools/fte-web/assemble.sh builds; set SITE_DIR to override." >&2
	exit 1
fi

# nquake.pk3 has two homes. The dev site keeps it at the root, where it is
# inert -- fte/boot.js's Module.files never lists it -- while the dist puts it
# under id1/, the gamedir FTE actually scans for packages. Accept either as the
# source so a site laid out the new way still stages.
find_source() { # find_source <dist-relative-path>
	local rel=$1
	if [ -f "$site_dir/$rel" ]; then
		printf '%s\n' "$site_dir/$rel"
		return 0
	fi
	local base=${rel##*/}
	if [ -f "$site_dir/$base" ]; then
		printf '%s\n' "$site_dir/$base"
		return 0
	fi
	return 1
}

staged=0
missing=0
for rel in id1/pak0.pak id1/nquake.pk3 qw/demos/hudtest_src.mvd qw/demos/tb4gf_book_vs_s.mvd; do
	if ! src=$(find_source "$rel"); then
		echo "stage-game-data.sh: $site_dir has no $rel" >&2
		missing=$((missing + 1))
		continue
	fi
	mkdir -p "$game_data_dir/$(dirname "$rel")"
	# -u: these are tens of megabytes each and re-staging is the common case.
	cp -u "$src" "$game_data_dir/$rel"
	staged=$((staged + 1))
done

# The destination is not wiped. It is the same directory CI populates from
# pinned downloads, and a helper that deletes whatever it did not put there is
# a bad neighbour to that; assemble-public.sh copies by name anyway, so a stray
# file here cannot reach the dist.
echo "stage-game-data.sh: $game_data_dir seeded ($staged file(s) from $site_dir)."

if [ "$missing" -gt 0 ]; then
	echo "stage-game-data.sh: $missing file(s) missing — assemble-public.sh will refuse to build." >&2
	exit 1
fi
