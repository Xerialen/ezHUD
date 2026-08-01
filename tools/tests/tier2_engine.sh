#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
engine_bin=${EZQUAKE_BIN:-}

if [[ -z "$engine_bin" || ! -x "$engine_bin" ]]; then
	echo "TIER 2 ENGINE ERROR: EZQUAKE_BIN must name an executable built ezQuake binary." >&2
	echo "This host has no built engine; the C bridge contract was not run." >&2
	exit 2
fi
if ! command -v xvfb-run >/dev/null 2>&1; then
	echo "TIER 2 ENGINE ERROR: xvfb-run is required to start ezQuake headlessly." >&2
	exit 2
fi

engine_base=${EZQUAKE_BASEDIR:-$(cd "$(dirname "$engine_bin")" && pwd)}
if [[ ! -d "$engine_base" ]]; then
	echo "TIER 2 ENGINE ERROR: EZQUAKE_BASEDIR is not a directory: $engine_base" >&2
	exit 2
fi

port=${HUD_WEB_TEST_PORT:-27791}
run_dir=$(mktemp -d /tmp/ezquake-hud-tier2.XXXXXX)
engine_log="$run_dir/engine.log"
engine_pid=

cleanup() {
	if [[ -n "$engine_pid" ]] && kill -0 "$engine_pid" 2>/dev/null; then
		kill "$engine_pid" 2>/dev/null || true
		wait "$engine_pid" 2>/dev/null || true
	fi
	rm -f "$engine_log"
	rmdir "$run_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
	cd "$engine_base"
	# cl_maxfps_menu MUST be set. It defaults to 0, and CL_MinFrameTime then falls
	# through to `1 / atoi(r_displayRefresh)` (cl_main.c:2398). Xvfb reports 0 Hz,
	# that divides to infinity, and `extratime < minframetime` stays true forever --
	# the entire tail of CL_Frame, including Sys_ReadIPC, never executes. The engine
	# looks alive and answers the bridge (which is serviced before the gate) while
	# silently ignoring every console command sent to it.
	#
	# Console 320x200 on a 640x480 framebuffer: kx=2.0, ky=2.4. Deliberately not
	# equal -- see TESTING.md.
	# State the screen: plain `xvfb-run -a` picks 1280x1024 at a depth that leaves
	# the engine with a 0-bit z-buffer, and renders at a size -width/-height did
	# not ask for.
	exec xvfb-run -a -s "-screen 0 640x480x24" "$engine_bin" \
		-basedir "$engine_base" -window -width 640 -height 480 \
		-condebug "$engine_log" \
		+cl_maxfps_menu 250 \
		+vid_conwidth 320 +vid_conheight 200 \
		+hud_web_port "$port" +hud_web_frame_interval 10000 \
		+alias hud_contract_alias "echo HUD_CONTRACT_ALIAS_RAN" \
		+hud_web 1
) >"$run_dir/stdout.log" 2>&1 &
engine_pid=$!

if ! python3 "$repo_dir/tools/tests/tier2_engine_contract.py" \
		--log "$engine_log" --port "$port" --engine-pid "$engine_pid"; then
	echo "--- ezQuake log (last 80 lines) ---" >&2
	tail -n 80 "$engine_log" >&2 2>/dev/null || true
	exit 1
fi
