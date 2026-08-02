#!/usr/bin/env bash
# Serve the public dist under its BASE_PATH prefix, the way Pages will.
#
# Serving the dist directly at / would not test the thing most likely to be
# wrong. assemble-public.sh rewrites the import map's resolved URLs to
# "${BASE_PATH}core/...", and a resolved URL is only right if the page really
# is under that prefix -- so the prefix has to exist as a path segment on the
# server. Hence a throwaway root with ./ez-hud (or whatever BASE_PATH says)
# symlinked at the dist; python's http.server follows symlinks, and this way
# the dist itself is never restructured to be served.
#
# Not port 8618: that is tools/fte-web/serve.sh's dev site, and the two are
# routinely up at once to compare them.
#
# python >= 3.9 already serves .wasm as application/wasm, which the browser's
# streaming compile requires.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

dist_dir=${DIST_DIR:-$workspace/dist}
base_path=${BASE_PATH:-/ezHUD/}
port=${1:-${PORT:-8619}}

if [ ! -f "$dist_dir/index.html" ]; then
	echo "serve-public.sh: $dist_dir/index.html is not there. Run tools/fte-web/assemble-public.sh first." >&2
	exit 1
fi

case $base_path in
	/*/ | /) ;;
	*)
		echo "serve-public.sh: BASE_PATH must start and end with '/' (got '$base_path')" >&2
		exit 1
		;;
esac

dist_dir=$(cd "$dist_dir" && pwd)
prefix=${base_path#/}
prefix=${prefix%/}

if [ -z "$prefix" ]; then
	root=$dist_dir
else
	# Beside the dist rather than in /tmp: this root lives for as long as the
	# server does, and keeping it in the workspace means a stale one after a
	# kill -9 is somewhere the next person will actually see it.
	root=$(mktemp -d "$dist_dir.serve.XXXXXX")
	trap 'rm -rf "$root"' EXIT INT TERM
	mkdir -p "$root/$(dirname "$prefix")"
	ln -s "$dist_dir" "$root/$prefix"
fi

echo "Editor:  http://127.0.0.1:$port$base_path"
echo "Serving $dist_dir under $base_path — Ctrl-C to stop."

# Loopback only. There is no token on this backend -- the engine is in the
# page, so there is nothing to authorise -- which makes the bind address the
# only thing keeping the site off the network.
#
# Not exec'd, unlike serve.sh: exec would replace this shell and take the EXIT
# trap with it, leaving the throwaway root behind on every Ctrl-C.
python3 -m http.server "$port" --bind 127.0.0.1 -d "$root"
