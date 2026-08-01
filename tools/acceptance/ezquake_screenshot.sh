#!/usr/bin/env bash
# Deterministic ezQuake screenshot harness.
#
# Launches real ezQuake against a throwaway basedir, jumps a demo to a fixed
# time, tracks a fixed player, clears the console, takes an engine screenshot
# at an exact resolution, and verifies the PNG on disk is that resolution.
# Exit 0 means the file exists and measures WIDTHxHEIGHT; anything else is a
# failure with a reason on stderr. tools/acceptance/test_screenshots.sh runs
# this at three resolutions as the acceptance test.
#
# ezQuake has no scripting channel once running (stdin is swallowed, no rcon
# client-side), so control is: cvars appended to the config the engine execs
# at startup, binds in autoexec.cfg, and X11 keypresses via xkey.py (XTEST).
# Every step below that can race polls for its outcome instead of sleeping
# blind, which is what makes this reproducible enough to be a test.
#
# Usage: ezquake_screenshot.sh WIDTH HEIGHT OUTPUT_BASENAME
# Env (all have defaults for minimain):
#   EZQ_BIN       engine binary          (~/quake/ezquake-linux)
#   EZQ_BASEDIR   throwaway basedir      (required; never a real install)
#   EZQ_CONFIG    config to load         ($EZQ_BASEDIR/../config-owner.cfg)
#   EZQ_DEMO      demo, gamedir-relative (demos/tb4gf_book_vs_s.mvd)
#   EZQ_JUMP      demo_jump target       (9:00)
#   EZQ_TRACK     player to track        (bps)
#   DISPLAY       X display              (:0.0)
set -euo pipefail

W=${1:?width}; H=${2:?height}; NAME=${3:?output basename}
EZQ_BIN=${EZQ_BIN:-$HOME/quake/ezquake-linux}
EZQ_BASEDIR=${EZQ_BASEDIR:?EZQ_BASEDIR must point at the throwaway basedir}
EZQ_CONFIG=${EZQ_CONFIG:-$EZQ_BASEDIR/../config-owner.cfg}
EZQ_DEMO=${EZQ_DEMO:-demos/tb4gf_book_vs_s.mvd}
EZQ_JUMP=${EZQ_JUMP:-9:00}
EZQ_TRACK=${EZQ_TRACK:-bps}
# The owner's config says `vid_conscale 5`, i.e. a 512×288 console on the
# native 2560×1440. conscale divides whatever the framebuffer is, so at any
# other resolution the console shrinks and a layout tuned for 512×288 gets
# cut at the edges (measured: gameclock and health clipped at 1920×1080).
# Pinning conwidth/conheight reproduces the owner's layout at every size;
# conwidth overrides conscale in ezQuake.
EZQ_CONWIDTH=${EZQ_CONWIDTH:-512}
EZQ_CONHEIGHT=${EZQ_CONHEIGHT:-288}
export DISPLAY=${DISPLAY:-:0.0}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

fail() { echo "ezquake_screenshot: $*" >&2; exit 1; }

[ -x "$EZQ_BIN" ] || fail "no engine at $EZQ_BIN"
[ -d "$EZQ_BASEDIR/id1" ] || fail "$EZQ_BASEDIR does not look like a basedir (no id1/)"
[ -f "$EZQ_CONFIG" ] || fail "no config at $EZQ_CONFIG"
command -v xwininfo >/dev/null || fail "xwininfo missing"
command -v identify >/dev/null || fail "imagemagick identify missing"

# Refuse to run against a real install: this harness writes configs and
# autoexecs into the basedir and kills every running ezquake.
case "$EZQ_BASEDIR" in
	"$HOME/quake"*|"$HOME/.ezquake"*) fail "refusing to touch $EZQ_BASEDIR" ;;
esac

# ---- no stale engines ------------------------------------------------------
# Two separate patterns on purpose: the wrapper binary and the AppImage's
# inner process. (A single quoted 'a\|b' pattern matches neither — that bug
# cost an evening: every "new" run was keying a survivor from the last one.)
pkill -9 -f 'ezquake-linux' 2>/dev/null || true
pkill -9 -f 'mount_ezquak' 2>/dev/null || true
for _ in $(seq 20); do
	pgrep -f 'ezquake-linux|mount_ezquak' >/dev/null || break
	sleep 0.5
done
pgrep -f 'ezquake-linux|mount_ezquak' >/dev/null && fail "stale ezquake will not die"

# ---- windowed or fullscreen ------------------------------------------------
# A window taller than the monitor minus its decorations gets clamped by the
# WM (2560×1440 came back 2560×1390) and the engine screenshots the clamped
# drawable. Modes that cannot fit in a window run fullscreen instead — the
# engine owns the mode there and the framebuffer is exact.
FS=0
mon_h=$(xrandr --listmonitors 2>/dev/null \
	| sed -nE 's|.* [0-9]+/[0-9]+x([0-9]+)/.*|\1|p' | sort -n | tail -1)
if [ -n "$mon_h" ] && [ "$H" -gt $((mon_h - 50)) ]; then
	FS=1
fi

# ---- stage config + binds --------------------------------------------------
# Resolution goes at the END of the config the engine execs at startup, so it
# wins over whatever the config itself says and needs no vid_restart. The
# original config file is never modified.
#
# Both cvar families, deliberately: vid_width/vid_height set the fullscreen
# mode, vid_win_width/vid_win_height the windowed one, and a windowed engine
# ignores the former entirely — every capture came out 640×480 (the windowed
# default) until the win_ pair was set too. (The owner's own config contains
# the misspellings `vid_win_widt` and `win_vid_height`, which ezQuake ignores;
# left untouched, as always.)
mkdir -p "$EZQ_BASEDIR/ezquake/configs"
{
	cat "$EZQ_CONFIG"
	printf '\nvid_width %s\nvid_height %s\nvid_win_width %s\nvid_win_height %s\nvid_fullscreen %s\nvid_conwidth %s\nvid_conheight %s\nvolume 0\n' \
		"$W" "$H" "$W" "$H" "$FS" "$EZQ_CONWIDTH" "$EZQ_CONHEIGHT"
} > "$EZQ_BASEDIR/ezquake/configs/config.cfg"

for d in id1 qw ezquake; do
	mkdir -p "$EZQ_BASEDIR/$d"
	printf 'bind F5 "demo_jump %s"\nbind F6 "cl_demospeed 0.01"\nbind F7 "screenshot %s"\nbind F10 "track %s"\nbind F11 "clear"\nbind F12 "toggleconsole"\n' \
		"$EZQ_JUMP" "$NAME" "$EZQ_TRACK" > "$EZQ_BASEDIR/$d/autoexec.cfg"
done

shots="$EZQ_BASEDIR/qw/matchinfo/screenshots"
rm -f "$shots/$NAME.png"

# ---- launch and wait for the window ---------------------------------------
setsid "$EZQ_BIN" -basedir "$EZQ_BASEDIR" \
	+set vid_width "$W" +set vid_height "$H" \
	+set vid_win_width "$W" +set vid_win_height "$H" \
	+set vid_fullscreen "$FS" +set volume 0 \
	+playdemo "$EZQ_DEMO" > /tmp/ezquake_screenshot.log 2>&1 < /dev/null &

WID=
for _ in $(seq 60); do
	WID=$(xwininfo -root -tree 2>/dev/null | grep -iE 'ezquake' | grep -oE '0x[0-9a-f]+' | head -1 || true)
	[ -n "$WID" ] && break
	sleep 0.5
done
[ -n "$WID" ] || fail "engine window never appeared (see /tmp/ezquake_screenshot.log)"
sleep 6	# demo connect + config exec settle; the window exists before the demo runs

key() { python3 "$here/xkey.py" "$WID" "$1"; }

# ---- choreography ----------------------------------------------------------
# The console starts DOWN when the engine boots into +playdemo and nothing
# raises it, so exactly one toggle is deterministic — every earlier capture
# had conback across the top half because this step was missing. `toggle`
# rather than `set`: there is no command to set the console state directly.
key F5;  sleep 3      # jump (lands on the nearest keyframe)
key F10; sleep 0.5    # track the agreed player
key F6;  sleep 2      # freeze
key F12; sleep 1      # raise the console (down since boot; see above)
key F11; sleep 1.5    # clear the notify lines
key F7                # engine screenshot: full framebuffer, WM-clipping-proof

# The engine writes the PNG asynchronously; the file exists before it is
# complete, and killing the engine mid-write leaves a truncated PNG that
# identify rejects. Complete = two consecutive size samples agree AND
# identify can parse it. Only then may the engine die.
out="$shots/$NAME.png"
dims=
last=-1
for _ in $(seq 40); do
	if [ -f "$out" ]; then
		size=$(stat -c %s "$out")
		if [ "$size" -gt 0 ] && [ "$size" = "$last" ] && dims=$(identify -format '%wx%h' "$out" 2>/dev/null); then
			break
		fi
		last=$size
	fi
	sleep 0.5
done

pkill -9 -f 'ezquake-linux' 2>/dev/null || true
pkill -9 -f 'mount_ezquak' 2>/dev/null || true

[ -f "$out" ] || fail "no screenshot appeared in $shots"
[ -n "$dims" ] || fail "$out never became a complete PNG"
[ "$dims" = "${W}x${H}" ] || fail "$out is $dims, wanted ${W}x${H}"
echo "$out ${W}x${H} ok"
