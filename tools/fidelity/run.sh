#!/usr/bin/env bash
# tools/fidelity/run.sh — the fidelity gate (#84).
#
# "ezHUD should feel like the Quake you actually play" had exactly one piece of
# evidence: spikes/fte-web/PARITY.md, hand-run once on 2026-08-01. A hand-run
# table cannot tell you whether the gap list moved since. This makes the same
# measurement a command, and writes a dated report whose element table is
# generated rather than typed.
#
#   tools/fidelity/run.sh --selftest       # no engine: proves the machinery
#                                          #   catches a planted divergence
#   tools/fidelity/run.sh                  # the real measurement
#
# WHERE IT RUNS — stated, not left ambiguous. The real run needs a native
# ezQuake build, a demo, and the owner's config. GitHub's runners have none of
# those and never will, so this is deliberately NOT a CI job: it is an
# owner-machine command whose report is reviewed in git like any other file.
# The selftest half has no such dependency and can run anywhere, which is why
# it exists separately.
#
# Exit 0 measured, 1 the measurement failed or drifted, 2 the inputs are not
# here. Same convention as tools/qa/run.sh and tools/tests/tier4.sh: exit 2 is
# "no engine on this host", which is not the same as a failing test.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)
cd "$repo_dir"

if [[ "${1:-}" == "--selftest" ]]; then
	exec node tools/fidelity/selftest.mjs
fi

dist_dir=${DIST_DIR:-$workspace/dist}
out_dir=${FIDELITY_OUT:-$repo_dir/docs/fidelity}
console=${FIDELITY_CONSOLE:-640x480}
tolerance=${FIDELITY_TOLERANCE:-0}
# The spike froze on a keyframe so both engines settle within a second or two of
# each other; keep the same point unless you are prepared to re-argue it.
freeze=${FIDELITY_FREEZE:-'demo_setspeed 0.01 ; cl_demospeed 0.01'}

# --- the reference side: real ezQuake, already running with hud_web 1 --------
# Not started here on purpose. A native engine needs a display, a basedir and a
# demo already seeked to the comparison point; a script that guessed at those
# would produce a measurement of its own guesses.
if [[ -z "${REFERENCE_BRIDGE_URL:-}" || -z "${REFERENCE_BRIDGE_TOKEN:-}" ]]; then
	echo "FIDELITY ERROR: REFERENCE_BRIDGE_URL and REFERENCE_BRIDGE_TOKEN must point at a" >&2
	echo "              running *real ezQuake* bridge — that is the reference half of the" >&2
	echo "              comparison and there is no substitute for it." >&2
	echo "              Start ezQuake, playdemo the comparison demo, 'hud_web 1', and copy" >&2
	echo "              the printed origin and token." >&2
	echo "              (No native engine on this host? tools/fidelity/run.sh --selftest)" >&2
	exit 2
fi

if [[ -n "${FIDELITY_CONFIG:-}" && ! -f "${FIDELITY_CONFIG}" ]]; then
	echo "FIDELITY ERROR: FIDELITY_CONFIG='${FIDELITY_CONFIG}' does not exist." >&2
	exit 2
fi

# --- the preview side: the FTE-web editor, driven headless ------------------
if [[ ! -f "$dist_dir/ftewebglcl.wasm" ]]; then
	echo "FIDELITY ERROR: no FTE engine at '$dist_dir/ftewebglcl.wasm'." >&2
	echo "              Assemble a dist first (tools/fte-web/assemble.sh), or point" >&2
	echo "              DIST_DIR at one." >&2
	exit 2
fi
if ! node -e "import('playwright')" >/dev/null 2>&1; then
	echo "FIDELITY ERROR: Playwright is not installed; run npm install." >&2
	exit 2
fi
# wasm_bridge.mjs serves the dist from the origin root, so a dist assembled for
# a BASE_PATH prefix has an import map keyed on '<prefix>core/bridge.js' that
# never matches. core/bridge.js then loads instead of core/fte-adapter.js and
# hud_web_ui/fte/chrome.js dies on a missing 'currentBridge' export -- the page
# chrome is gone, silently. This run reads engine state through page globals
# rather than the adapter, so the measurement itself is unaffected and this is a
# warning rather than a refusal; but a half-loaded page is worth knowing about
# before it is mistaken for an engine fault. Same trap tools/tests/tier4_fte.sh
# preflights for, from the other direction.
if grep -q '"/[^"]*/core/bridge\.js"' "$dist_dir/index.html" 2>/dev/null; then
	echo "FIDELITY NOTE: '$dist_dir' was assembled for a BASE_PATH prefix, but the preview" >&2
	echo "              bridge serves it from the root, so its import map will not match and" >&2
	echo "              the FTE page chrome will fail to load. Engine state still reads" >&2
	echo "              correctly, so the measurement stands. For a clean page, assemble a" >&2
	echo "              root dist: tools/fte-web/assemble.sh" >&2
fi
if ! command -v google-chrome >/dev/null 2>&1 \
	&& ! command -v google-chrome-stable >/dev/null 2>&1 \
	&& [[ ! -x /opt/google/chrome/chrome ]]; then
	echo "FIDELITY ERROR: no system Google Chrome; the preview bridge runs channel:'chrome'." >&2
	exit 2
fi

bridge_log=$(mktemp)
cleanup() {
	[[ -n "${bridge_pid:-}" ]] && kill "$bridge_pid" 2>/dev/null || true
	rm -f "$bridge_log"
}
trap cleanup EXIT

node tools/qa/wasm_bridge.mjs --dist "$dist_dir" >"$bridge_log" 2>&1 &
bridge_pid=$!

# The wasm engine mounts a filesystem and has to actually draw before its state
# means anything (see PARITY.md: a config applied mid-mount half-takes and moved
# health by 119px). wasm_bridge.mjs waits for that and only then prints BRIDGE.
preview_line=""
for _ in $(seq 1 240); do
	if ! kill -0 "$bridge_pid" 2>/dev/null; then
		echo "FIDELITY ERROR: the preview bridge exited before it was ready:" >&2
		cat "$bridge_log" >&2
		exit 2
	fi
	preview_line=$(grep -m1 '^BRIDGE ' "$bridge_log" || true)
	[[ -n "$preview_line" ]] && break
	sleep 1
done
if [[ -z "$preview_line" ]]; then
	echo "FIDELITY ERROR: the preview bridge never reported ready within 240s:" >&2
	cat "$bridge_log" >&2
	exit 2
fi
preview_origin=$(echo "$preview_line" | awk '{print $2}')
preview_token=$(echo "$preview_line" | awk '{print $3}')

exec_args=(
	--reference "$REFERENCE_BRIDGE_URL" --reference-token "$REFERENCE_BRIDGE_TOKEN"
	--preview "$preview_origin" --preview-token "$preview_token"
	--console "$console" --tolerance "$tolerance" --freeze "$freeze"
	--dist "$dist_dir" --out "$out_dir"
)
[[ -n "${FIDELITY_CONFIG:-}" ]] && exec_args+=(--config "$FIDELITY_CONFIG")
[[ -n "${FIDELITY_BASELINE:-}" ]] && exec_args+=(--check "$FIDELITY_BASELINE")
[[ -n "${FIDELITY_DATE:-}" ]] && exec_args+=(--date "$FIDELITY_DATE")

node tools/fidelity/measure.mjs "${exec_args[@]}"
