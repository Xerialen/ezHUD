#!/usr/bin/env bash
# Acceptance test: the screenshot harness is deterministic at three
# resolutions. Each run must produce a PNG that measures exactly what was
# asked for; the harness itself verifies dimensions and exits non-zero
# otherwise, so this is three assertions and a summary.
#
# Needs a display, real ezQuake and a staged basedir — this is an acceptance
# tier, not CI. See ezquake_screenshot.sh for the env knobs.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

: "${EZQ_BASEDIR:?EZQ_BASEDIR must point at the throwaway basedir}"

fails=0
for spec in "1280 720 xerial_hud_720p" "1920 1080 xerial_hud_1080p" "2560 1440 xerial_hud_1440p"; do
	set -- $spec
	if bash "$here/ezquake_screenshot.sh" "$1" "$2" "$3"; then
		echo "PASS ${1}x${2}"
	else
		echo "FAIL ${1}x${2}"
		fails=$((fails + 1))
	fi
done

[ "$fails" -eq 0 ] || { echo "$fails resolution(s) failed"; exit 1; }
echo "all resolutions ok"
