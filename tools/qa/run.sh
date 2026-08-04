#!/usr/bin/env bash
# tools/qa/run.sh — golden-matrix QA entrypoint.
#
# Same convention as tools/tests/tier4.sh: preflight and refuse, never build.
# Exit 2 means "the inputs are not here", which is not a failing test.
#
#   tools/qa/run.sh                  # real engine: needs a running bridge
#   BRIDGE_URL=... BRIDGE_TOKEN=...  #   (start ezQuake, hud_web 1, copy both)
#   tools/qa/run.sh --selftest       # fake engine: proves the matrix machinery
#                                    #   catches a planted fault, no engine needed
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_dir"

if [[ "${1:-}" == "--selftest" ]]; then
	echo "QA selftest: clean matrix must pass..."
	node tools/qa/matrix.mjs --fake --determinism --artifacts "${QA_ARTIFACTS:-tools/qa/artifacts/selftest-clean}"
	echo "QA selftest: planted fault (teaminfo keeps its size on resize) must FAIL..."
	if node tools/qa/matrix.mjs --fake --fault teaminfo \
			--cells newhud.modern.1440-1080 \
			--artifacts "${QA_ARTIFACTS:-tools/qa/artifacts}/selftest-fault" >/dev/null; then
		echo "QA SELFTEST ERROR: the planted fault was not detected." >&2
		exit 1
	fi
	echo "QA selftest: planted fault detected. Matrix machinery is sound."
	exit 0
fi

if [[ -z "${BRIDGE_URL:-}" || -z "${BRIDGE_TOKEN:-}" ]]; then
	echo "QA ERROR: BRIDGE_URL and BRIDGE_TOKEN must point at a running bridge." >&2
	echo "          Start the engine, 'hud_web 1', and copy the printed origin/token." >&2
	echo "          (No engine on this host? tools/qa/run.sh --selftest)" >&2
	exit 2
fi

node tools/qa/gen_master_cfg.mjs "$BRIDGE_URL/state?t=$BRIDGE_TOKEN" \
	--check tools/qa/golden/master_1440p.cfg
node tools/qa/matrix.mjs --bridge "$BRIDGE_URL" --token "$BRIDGE_TOKEN" --determinism "$@"
