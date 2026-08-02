#!/usr/bin/env bash
# Tier 4, FTE backend: the public dist, the real wasm engine, a real browser.
#
# This preflights and refuses; it never builds. The artifact under test is the
# one Pages will serve, and a suite that quietly rebuilt it would be testing
# whatever it just made rather than what was assembled and reviewed -- so a
# missing dist is an error with the command to run, not a step this script
# takes. Same convention as tools/tests/tier4.sh: exit 2 means "the inputs are
# not here", which is not the same as a failing test.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

dist_dir=${DIST_DIR:-$workspace/dist}
base_path=${BASE_PATH:-/ez-hud/}

case $base_path in
	/*/ | /) ;;
	*)
		echo "TIER 4 FTE ERROR: BASE_PATH must start and end with '/' (got '$base_path')." >&2
		exit 2
		;;
esac

if [[ ! -d "$dist_dir" ]]; then
	echo "TIER 4 FTE ERROR: no dist at '$dist_dir'." >&2
	echo "              Assemble one first: BASE_PATH=$base_path tools/fte-web/assemble-public.sh" >&2
	echo "              (or point DIST_DIR at an existing public dist)." >&2
	exit 2
fi
if [[ ! -f "$dist_dir/index.html" ]]; then
	echo "TIER 4 FTE ERROR: '$dist_dir' has no index.html, so it is not a dist." >&2
	echo "              Run: BASE_PATH=$base_path tools/fte-web/assemble-public.sh" >&2
	exit 2
fi
# The engine is the point of this tier. A dist without the wasm would still
# serve the editor and still fail every case here for a reason the failure
# messages would blame on the browser.
if [[ ! -f "$dist_dir/ftewebglcl.wasm" ]]; then
	echo "TIER 4 FTE ERROR: '$dist_dir' has no ftewebglcl.wasm; the engine was never staged." >&2
	echo "              Build the engine ('make webcl-rel', spikes/fte-web/NOTES.md) and re-run" >&2
	echo "              assemble-public.sh." >&2
	exit 2
fi
# assemble-public.sh bakes BASE_PATH into the import map's resolved URLs, and a
# resolved URL only matches when the page really is served under that prefix.
# Serving a dist built for a different prefix loads core/bridge.js instead of
# the FTE adapter and the page sits at "Connecting..." forever -- a failure that
# looks like a dead engine. Catch it here, where the fix is one command.
if ! grep -q "\"${base_path}core/bridge.js\"" "$dist_dir/index.html"; then
	echo "TIER 4 FTE ERROR: '$dist_dir/index.html' has no import-map key for '${base_path}core/bridge.js'," >&2
	echo "              so it was assembled for a different BASE_PATH than this run serves." >&2
	echo "              Re-run: BASE_PATH=$base_path tools/fte-web/assemble-public.sh" >&2
	exit 2
fi

if ! node -e "import('playwright')" >/dev/null 2>&1; then
	echo "TIER 4 FTE ERROR: Playwright is not installed; run npm install." >&2
	exit 2
fi
# channel:'chrome' deliberately, so no browser is ever downloaded: this machine
# has Google Chrome and GitHub's ubuntu runners ship it preinstalled. WebGL
# comes from Chrome's own SwiftShader fallback when there is no GPU. The names
# below are the ones Playwright itself probes for the 'chrome' channel on Linux.
if ! command -v google-chrome >/dev/null 2>&1 \
	&& ! command -v google-chrome-stable >/dev/null 2>&1 \
	&& [[ ! -x /opt/google/chrome/chrome ]]; then
	echo "TIER 4 FTE ERROR: no system Google Chrome (google-chrome / google-chrome-stable)." >&2
	echo "              Install Chrome from the distribution's own packaging." >&2
	echo "              'npx playwright install' is deliberately not the fix here: this tier" >&2
	echo "              runs channel:'chrome' so CI and this machine use the same browser." >&2
	exit 2
fi

export DIST_DIR="$dist_dir"
export BASE_PATH="$base_path"
export HUD_WEB_ARTIFACT_DIR=${HUD_WEB_ARTIFACT_DIR:-/tmp/ezhud-tier4-fte-artifacts}

exec node "$repo_dir/tools/tests/tier4_fte.mjs"
