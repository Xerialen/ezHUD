#!/usr/bin/env bash
# Publish the two demo files the public build downloads, as a GitHub Release.
#
# Run this ONCE, by hand, with the owner's approval -- it creates a public
# release on the repository. CI never runs it: .github/workflows/pages.yml only
# downloads what this uploaded, and fails on a hash it does not recognise.
#
# The demos are here rather than in git because binaries are never committed
# (PUBLISH.md), and they are on our own release rather than a mirror because
# nothing else publishes them: hudtest_src.mvd is a synthetic recording made for
# this editor, tb4gf_book_vs_s.mvd is an openly shared match demo.
#
#   GITHUB_TOKEN=<token with contents:write> bash tools/fte-web/upload-web-assets.sh
#
# `gh` is not installed anywhere this runs, hence curl against the REST API.
set -euo pipefail
# The token is in this shell's environment. Tracing is off and stays off; there
# is no debug mode in this script, because a debug mode is how tokens end up in
# terminal scrollback and CI logs.
set +x

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workspace=$(cd "$repo_dir/.." && pwd)

repo=${REPO:-Xerialen/ez-hud}
tag=${TAG:-web-assets-v1}
# The demos live in the dev site, which is outside this repository.
src_dir=${SRC_DIR:-$workspace/site/qw/demos}
pins=$repo_dir/tools/fte-web/game-data.sha256
assets=(hudtest_src.mvd tb4gf_book_vs_s.mvd)

if [ -z "${GITHUB_TOKEN:-}" ]; then
	echo "upload-web-assets.sh: set GITHUB_TOKEN to a token with contents:write on $repo" >&2
	exit 1
fi

# Upload exactly what CI is pinned to expect. Getting this backwards -- pushing
# a re-recorded demo and only then noticing the pin -- means a released asset
# that every build rejects, and releases assets cannot be quietly replaced.
echo "Checking the local files against $pins"
for name in "${assets[@]}"; do
	if [ ! -f "$src_dir/$name" ]; then
		echo "upload-web-assets.sh: no $name in $src_dir (override with SRC_DIR)" >&2
		exit 1
	fi
	(cd "$src_dir" && grep -E "  $name\$" "$pins" | sha256sum -c -)
done

# The token goes in on stdin, never in argv: anyone else on this machine can
# read /proc/*/cmdline, and this token can write to the repository.
api() {
	local method=$1 url=$2
	shift 2
	curl -sS --fail-with-body -X "$method" --config - "$@" "$url" <<-EOF
	header = "Authorization: Bearer ${GITHUB_TOKEN}"
	header = "Accept: application/vnd.github+json"
	header = "X-GitHub-Api-Version: 2022-11-28"
	EOF
}

# Reading one field out of JSON, without assuming jq is installed.
json_field() {
	python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

echo "Looking for an existing $tag release on $repo"
if release=$(api GET "https://api.github.com/repos/$repo/releases/tags/$tag" 2>/dev/null); then
	release_id=$(printf '%s' "$release" | json_field id)
	echo "  release $tag already exists (id $release_id) -- adding any missing assets to it."
	# Deliberately not deleting anything. A release asset that already exists is
	# either the same bytes (nothing to do) or a different demo under a name CI
	# has pinned, and silently replacing that is how a deploy starts serving
	# something nobody hashed.
	existing=$(printf '%s' "$release" | python3 -c 'import json,sys; print(" ".join(a["name"] for a in json.load(sys.stdin)["assets"]))')
else
	echo "  creating it"
	# The body goes in as an argument, not on stdin: api() has already claimed
	# stdin for the curl config that carries the token.
	body='{"tag_name":"'$tag'","name":"Web assets: demos for the FTE-web editor",'
	body=$body'"body":"Demo files the GitHub Pages build downloads. Their hashes are pinned in tools/fte-web/game-data.sha256; see spikes/fte-web/PUBLISH.md.",'
	body=$body'"draft":false,"prerelease":false}'
	release=$(api POST "https://api.github.com/repos/$repo/releases" --data "$body")
	release_id=$(printf '%s' "$release" | json_field id)
	existing=
fi

for name in "${assets[@]}"; do
	case " $existing " in
		*" $name "*)
			echo "  $name is already on the release -- leaving it alone."
			continue
			;;
	esac
	echo "Uploading $name"
	# Asset uploads go to uploads.github.com, not api.github.com, and the name
	# is a query parameter rather than anything taken from the file.
	asset=$(api POST "https://uploads.github.com/repos/$repo/releases/$release_id/assets?name=$name" \
		-H "Content-Type: application/octet-stream" \
		--data-binary "@$src_dir/$name")
	printf '%s' "$asset" | json_field browser_download_url
done

echo "Done. The workflow downloads these from:"
echo "  https://github.com/$repo/releases/download/$tag/<name>"
