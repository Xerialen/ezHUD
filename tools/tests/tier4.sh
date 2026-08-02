#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
engine_bin=${EZQUAKE_BIN:-}

if [[ -z "$engine_bin" || ! -x "$engine_bin" ]]; then
	echo "TIER 4 ERROR: EZQUAKE_BIN must name an executable built ezQuake binary." >&2
	echo "This host has no built engine; the full end-to-end suite was not run." >&2
	exit 2
fi
basedir_probe=${EZQUAKE_BASEDIR:-$(cd "$(dirname "$engine_bin")" && pwd)}
# +playdemo resolves against the gamedir, but the existence check has to happen on
# the filesystem. Accept either form: an absolute path, or one relative to
# <basedir>/qw the way the engine will read it.
if [[ -z "${EZQUAKE_TEST_DEMO:-}" ]]; then
	echo "TIER 4 ERROR: EZQUAKE_TEST_DEMO must name a demo that draws the new HUD." >&2
	exit 2
fi
if [[ ! -f "${EZQUAKE_TEST_DEMO}" && ! -f "$basedir_probe/qw/${EZQUAKE_TEST_DEMO}" ]]; then
	echo "TIER 4 ERROR: demo not found as '${EZQUAKE_TEST_DEMO}' or" >&2
	echo "              '$basedir_probe/qw/${EZQUAKE_TEST_DEMO}'." >&2
	exit 2
fi
if ! command -v xvfb-run >/dev/null 2>&1; then
	echo "TIER 4 ERROR: xvfb-run is required; a real display is deliberately unsupported." >&2
	exit 2
fi
if ! node -e "import('playwright')" >/dev/null 2>&1; then
	echo "TIER 4 ERROR: Playwright is not installed; run npm install and npx playwright install chromium." >&2
	exit 2
fi

export EZQUAKE_BIN="$engine_bin"
export HUD_WEB_REPO_DIR="$repo_dir"
export EZQUAKE_BASEDIR=${EZQUAKE_BASEDIR:-$(cd "$(dirname "$engine_bin")" && pwd)}
export HUD_WEB_TEST_PORT=${HUD_WEB_TEST_PORT:-27792}
export HUD_WEB_ARTIFACT_DIR=${HUD_WEB_ARTIFACT_DIR:-/tmp/ezquake-hud-tier4-artifacts}

# Xvfb forces software rendering, which is the honest default: it is reproducible
# and needs no display. A host with a real GPU can offer one instead by setting
# EZHUD_USE_DISPLAY -- on native Ubuntu Desktop (pinnacle since its 2026
# reinstall) that is the session's own display, ":0" under Xorg or XWayland.
# (Historical, kept because the fallback logic below was shaped by it: when
# pinnacle ran WSL, ":0" came from WSLg and reaching the discrete card also
# needed GALLIUM_DRIVER=d3d12 + MESA_D3D12_DEFAULT_ADAPTER_NAME, because Mesa
# otherwise picked llvmpipe even with the display attached. None of that
# applies to a native install.)
#
# When Xvfb is used the screen must be stated. Plain `xvfb-run -a` defaults to
# 1280x1024 at a depth that leaves the engine with a 0-bit z-buffer, and renders at
# a size the -width/-height arguments did not ask for.
if [[ -n "${EZHUD_USE_DISPLAY:-}" ]]; then
	# Prove the display answers before committing to it. A desktop display is
	# tied to a login session -- it can be absent after a reboot or logoff
	# (and on the old WSL setup, WSLg vanished with the Windows session) even
	# though the runner itself is perfectly healthy. Falling back keeps the
	# nightly meaningful instead of failing on a missing X server, and says
	# which mode it actually used.
	if DISPLAY="$EZHUD_USE_DISPLAY" timeout 20 xdpyinfo >/dev/null 2>&1; then
		echo "tier 4: display ${EZHUD_USE_DISPLAY}, GALLIUM_DRIVER=${GALLIUM_DRIVER:-default}" >&2
		export DISPLAY="$EZHUD_USE_DISPLAY"
		exec bash "$repo_dir/tools/tests/tier4_under_xvfb.sh"
	fi
	echo "tier 4: EZHUD_USE_DISPLAY=${EZHUD_USE_DISPLAY} is set but not reachable;" \
	     "falling back to Xvfb (software rendering)" >&2
fi
exec xvfb-run -a -s "-screen 0 1280x720x24" bash "$repo_dir/tools/tests/tier4_under_xvfb.sh"
