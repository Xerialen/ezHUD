#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_dir"

# Two layouts, one script: an ezQuake checkout has src/ and tools/ at the root,
# while the ez-hud repository keeps hud_web_ui/ at the root and the engine files
# under engine/. Resolve rather than duplicating this file into both repos.
libhud_tests=src/libhud/tests
[ -d "$libhud_tests" ] || libhud_tests=engine/src/libhud/tests
embed=tools/embed_hud_web_ui.py
[ -f "$embed" ] || embed=engine/tools/embed_hud_web_ui.py

make -C "$libhud_tests" check
node --check hud_web_ui/core/*.js
# The FTE host page (spike/fte-web). Guarded because tier1 also runs from an
# ezQuake checkout, where hud_web_ui/ arrives without this backend's files.
if [ -d hud_web_ui/fte ]; then node --check hud_web_ui/fte/*.js; fi
node --test hud_web_ui/core/tests/*.test.js
python3 "$embed" --check
