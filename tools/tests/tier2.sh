#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_dir"

node tools/tests/tier2_bridge.test.js
bash tools/tests/tier2_engine.sh
