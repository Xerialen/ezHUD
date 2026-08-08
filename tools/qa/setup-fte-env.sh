#!/usr/bin/env bash
# tools/qa/setup-fte-env.sh — provision the full FTE-web QA environment locally.
#
# The same recipe .github/workflows/pages.yml runs in CI, as one script a human
# (or agent sandbox) can run without root: pinned fteqw + fteqw.diff, emsdk,
# hash-pinned game data, assembled public dist. Everything lands in the
# workspace (the repo's parent directory), exactly where the assemble/test
# scripts' defaults already look:
#
#   <workspace>/emsdk      the pinned emscripten toolchain
#   <workspace>/fteqw      engine source at FTEQW_SHA with fteqw.diff applied
#   <workspace>/game-data  hash-verified id1/ + qw/demos/ layout
#   <workspace>/dist       the assembled public site (ENGINE + UI + data)
#
# Idempotent: every step checks its outcome first, so re-running after a
# failure resumes rather than redoes. No sudo anywhere.
#
# Pins live in ONE place each: FTEQW_SHA/EMSDK_VERSION here must match
# .github/workflows/pages.yml, and the data hashes are tools/fte-web/game-data.sha256.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)
cd "$workspace"

FTEQW_SHA=41e13638d62779b79e27defe74fe961910a260d3
EMSDK_VERSION=6.0.5
QUAKE106_URL=https://ftp.gwdg.de/pub/misc/ftp.idsoftware.com/idstuff/quake/quake106.zip
NQUAKE_PK3_URL=https://raw.githubusercontent.com/nQuake/distfiles/d93997920e028343eee24377f75b2addff066990/non-gpl/qw/nquake.pk3
GPL_MAPS_URL=https://raw.githubusercontent.com/nQuake/distfiles/d93997920e028343eee24377f75b2addff066990/gpl/id1/gpl_maps.pk3
WEB_ASSETS_BASE=https://github.com/Xerialen/ezHUD/releases/download/web-assets-v1

say() { echo "== $*"; }

# No root: hosts without make get a user-local GNU make via micromamba
# (conda-forge), kept under ~/.local/opt so nothing touches the system.
if ! command -v make >/dev/null; then
	if [ ! -x "$HOME/.local/opt/buildtools/bin/make" ]; then
		say "installing user-local make (micromamba/conda-forge)"
		mkdir -p "$HOME/.local/opt"
		(cd "$HOME/.local/opt" && curl -fsSL https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj bin/micromamba)
		"$HOME/.local/opt/bin/micromamba" create -y -q -p "$HOME/.local/opt/buildtools" -c conda-forge make
	fi
	export PATH="$HOME/.local/opt/buildtools/bin:$PATH"
fi

# ---- 1. emsdk --------------------------------------------------------------
if [ ! -f emsdk/emsdk_env.sh ]; then
	say "installing emsdk $EMSDK_VERSION"
	git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
fi
if ! (unset CFLAGS CXXFLAGS LDFLAGS; source emsdk/emsdk_env.sh >/dev/null 2>&1 && command -v emcc >/dev/null); then
	./emsdk/emsdk install "$EMSDK_VERSION"
	./emsdk/emsdk activate "$EMSDK_VERSION"
fi

# ---- 2. fteqw at the pin, patched ------------------------------------------
if [ ! -d fteqw/.git ]; then
	say "cloning fteqw @ $FTEQW_SHA"
	git init fteqw
	git -C fteqw remote add origin https://github.com/Xerialen/fteqw.git
	git -C fteqw fetch --depth 1 origin "$FTEQW_SHA"
	git -C fteqw checkout FETCH_HEAD
fi
if ! git -C fteqw apply --reverse --check "$repo_dir/spikes/fte-web/fteqw.diff" 2>/dev/null; then
	say "applying fteqw.diff"
	git -C fteqw apply --verbose "$repo_dir/spikes/fte-web/fteqw.diff"
fi

# ---- 3. build ftewebglcl ----------------------------------------------------
if [ ! -f fteqw/engine/release/ftewebglcl.js ]; then
	say "building ftewebglcl (this is the long step)"
	(
		cd fteqw/engine
		# -march=native in an inherited profile is meaningless to wasm and
		# fails the build with an error that never mentions your profile.
		unset CFLAGS CXXFLAGS LDFLAGS
		set +u; source "$workspace/emsdk/emsdk_env.sh"; set -u
		rm -f release/ftewebglcl.js release/ftewebglcl.wasm release/ftewebglcl.html
		make webcl-rel -j"$(nproc)"
	)
fi
# Both of these have shipped missing and only fail in a browser; grep instead.
grep -q _EZHud_StateJSON fteqw/engine/release/ftewebglcl.js
grep -qF 'Module["UTF8ToString"]' fteqw/engine/release/ftewebglcl.js
grep -qF 'addRunDependency' fteqw/engine/release/ftewebglcl.js
say "engine ok: fteqw/engine/release/ftewebglcl.js"

# ---- 4. game data, hash-pinned ---------------------------------------------
pins=$repo_dir/tools/fte-web/game-data.sha256
mkdir -p downloads game-data/id1 game-data/qw/demos
(
	cd downloads
	verify() { grep -E "  $1\$" "$pins" | sha256sum -c - >/dev/null; }
	fetch() { [ -f "$2" ] && verify "$2" 2>/dev/null || { curl -fsSL --retry 3 --retry-delay 5 -o "$2" "$1"; verify "$2"; }; }

	fetch "$QUAKE106_URL" quake106.zip
	if ! { [ -f pak0.pak ] && verify pak0.pak 2>/dev/null; }; then
		unzip -oq quake106.zip resource.1
		sevenzip=$(command -v 7z || command -v 7zz || command -v 7za)
		"$sevenzip" e -y -o. resource.1 ID1/PAK0.PAK > /dev/null
		mv PAK0.PAK pak0.pak
		verify pak0.pak
	fi
	fetch "$NQUAKE_PK3_URL" nquake.pk3
	fetch "$GPL_MAPS_URL" gpl_maps.pk3
	for asset in hudtest_src.mvd tb4gf_book_vs_s.mvd qrp-dm3.pk3; do
		fetch "$WEB_ASSETS_BASE/$asset" "$asset"
	done
)
cp downloads/pak0.pak downloads/nquake.pk3 downloads/gpl_maps.pk3 downloads/qrp-dm3.pk3 game-data/id1/
cp downloads/hudtest_src.mvd downloads/tb4gf_book_vs_s.mvd game-data/qw/demos/
say "game data staged in game-data/"

# ---- 5. assemble the public dist -------------------------------------------
BASE_PATH=${BASE_PATH:-/} "$repo_dir/tools/fte-web/assemble-public.sh"
say "dist assembled: $workspace/dist"
say "next: npm run test:tier4:fte  (or tools/qa/run.sh once a bridge exists)"
