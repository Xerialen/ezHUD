#!/usr/bin/env bash
set -euo pipefail

run_dir=$(mktemp -d /tmp/ezquake-hud-tier4.XXXXXX)
engine_log="$run_dir/engine.log"
engine_pid=

cleanup() {
	if [[ -n "$engine_pid" ]] && kill -0 "$engine_pid" 2>/dev/null; then
		kill "$engine_pid" 2>/dev/null || true
		wait "$engine_pid" 2>/dev/null || true
	fi
	rm -f "$engine_log" "$run_dir/stdout.log"
	rmdir "$run_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# An engine left over from a killed run still holds the fixed test port, so the new
# one cannot bind, never prints a URL, and the driver waits for a token that will
# never come. Clear the port before starting rather than diagnosing that again.
if pgrep -f "ezquake-linux-x86_64.*hud_web_port $HUD_WEB_TEST_PORT" >/dev/null 2>&1; then
	echo "tier 4: killing a leftover engine still holding port $HUD_WEB_TEST_PORT" >&2
	pkill -9 -f "ezquake-linux-x86_64.*hud_web_port $HUD_WEB_TEST_PORT" || true
	sleep 2
fi

mkdir -p "$HUD_WEB_ARTIFACT_DIR"
(
	cd "$EZQUAKE_BASEDIR"
	# Console 320x200 against a 1280x720 framebuffer: kx=4.0, ky=3.6. Deliberately
	# not equal -- see TESTING.md. These are cvars (+vid_conwidth), not command-line
	# parameters; -conwidth/-conheight do not exist and were silently ignored.
	#
	# cl_maxfps_menu matters before the demo starts: it defaults to 0, and
	# CL_MinFrameTime then divides by Xvfb's 0 Hz refresh to get an infinite frame
	# time, so the engine never runs a full frame at the menu. Demo playback itself
	# is uncapped, but the engine has to reach it first.
	exec "$EZQUAKE_BIN" -basedir "$EZQUAKE_BASEDIR" -window \
		-width 1280 -height 720 \
		-condebug "$engine_log" \
		+cl_maxfps_menu 250 \
		+vid_conwidth 320 +vid_conheight 200 \
		+hud_web_port "$HUD_WEB_TEST_PORT" +hud_web_frame_interval 0 \
		+scr_newhud 1 +playdemo "$EZQUAKE_TEST_DEMO" +hud_web 1
) >"$run_dir/stdout.log" 2>&1 &
engine_pid=$!

# Hard ceiling on the driver. Every wait inside it has its own timeout, but a
# browser that never launches is outside all of them, and the job then burns its
# whole allowance producing no output at all -- which says nothing about what went
# wrong. Fifteen minutes is far more than a passing run needs (about one).
if ! timeout --signal=TERM --kill-after=30s 15m \
		node "$HUD_WEB_REPO_DIR/tools/tests/tier4.mjs" \
		--log "$engine_log" --port "$HUD_WEB_TEST_PORT" \
		--basedir "$EZQUAKE_BASEDIR" --artifacts "$HUD_WEB_ARTIFACT_DIR"; then
	cp "$engine_log" "$HUD_WEB_ARTIFACT_DIR/engine.log" 2>/dev/null || true
	cp "$run_dir/stdout.log" "$HUD_WEB_ARTIFACT_DIR/engine-stdout.log" 2>/dev/null || true
	echo "--- ezQuake log (last 80 lines) ---" >&2
	tail -n 80 "$engine_log" >&2 2>/dev/null || true
	exit 1
fi
