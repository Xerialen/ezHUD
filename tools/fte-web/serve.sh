#!/usr/bin/env bash
# Serve the assembled FTE-web preview site.
#
# From the site root, and that is not a detail: index-fte.html maps the
# absolute path /core/bridge.js to /core/fte-adapter.js with an import map, and
# an import-map key is a resolved URL. Served from anywhere but the root, the
# key stops matching what view/app.js's '../core/bridge.js' resolves to and the
# page silently loads the ezQuake HTTP bridge instead -- which then cannot
# reach an engine, and reports a lost connection rather than a broken setup.
#
# python >= 3.9 already serves .wasm as application/wasm, which the browser's
# streaming compile requires.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

site_dir=${SITE_DIR:-$workspace/site}
port=${1:-${PORT:-8618}}

if [ ! -f "$site_dir/index-fte.html" ]; then
	echo "serve.sh: $site_dir/index-fte.html is not there. Run tools/fte-web/assemble.sh first." >&2
	exit 1
fi

echo "Editor:  http://127.0.0.1:$port/index-fte.html"
echo "Engine:  http://127.0.0.1:$port/ftewebglcl.html   (the stock FTE shell, for comparison)"
echo "Serving $site_dir — Ctrl-C to stop."

# Loopback only. There is no token on this backend -- the engine is in the
# page, so there is nothing to authorise -- which makes the bind address the
# only thing keeping the site off the network.
exec python3 -m http.server "$port" --bind 127.0.0.1 -d "$site_dir"
