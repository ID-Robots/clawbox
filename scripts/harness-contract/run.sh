#!/usr/bin/env bash
# The harness-contract check, end to end: every OpenClaw and Hermes command,
# flag, config key, RPC method, event, plugin hook and dashboard route ClawBox's
# source uses, checked against the PINNED harnesses themselves. CI runs it
# (.github/workflows/harness-contract.yml); it runs the same way on a dev
# machine and never touches a real ~/.openclaw or ~/.hermes. See
# docs/harness-contract.md.
#
#   scripts/harness-contract/run.sh
#
# HARNESS_CONTRACT_CACHE  where the pinned harnesses are kept between runs
#                         (default ~/.cache/clawbox-harness-contract). The
#                         network is used only for a pin that is not there yet:
#                         npm for OpenClaw, GitHub for Hermes.
#
# Exit 0 pass, 1 contract failures, 2 the check itself could not run.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cache="${HARNESS_CONTRACT_CACHE:-$HOME/.cache/clawbox-harness-contract}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
die() { echo "harness-contract: $*" >&2; exit 2; }

oc_pin="$(node "$repo/scripts/harness-pins.mjs" openclaw)" || die "cannot read the OpenClaw pin"
he_commit="$(node "$repo/scripts/harness-pins.mjs" hermes.commit)" || die "cannot read the Hermes pin"
he_tag="$(node "$repo/scripts/harness-pins.mjs" hermes.tag)" || die "cannot read the Hermes tag"
he_repo="https://github.com/NousResearch/hermes-agent"
mkdir -p "$cache"

echo "harness-contract: scanning ClawBox's source"
node "$here/scan.mjs" "$repo" >"$work/usage.json"

# ── OpenClaw: the published package, installed without running its scripts ──
oc_dir="$cache/openclaw-$oc_pin"
if [ ! -f "$oc_dir/node_modules/openclaw/package.json" ]; then
  echo "harness-contract: openclaw@$oc_pin is not cached — installing it from npm (--ignore-scripts)"
  rm -rf "$oc_dir.part"
  mkdir -p "$oc_dir.part"
  npm install --prefix "$oc_dir.part" --ignore-scripts --no-audit --no-fund --cache "$work/npm-cache" \
    "openclaw@$oc_pin" >"$work/npm.log" 2>&1 || { tail -n 40 "$work/npm.log" >&2; die "npm install openclaw@$oc_pin failed"; }
  rm -rf "$oc_dir"
  mv "$oc_dir.part" "$oc_dir"
fi
echo "harness-contract: reading openclaw@$oc_pin (CLI help, config schema, gateway RPC, events, hooks)"
node "$here/openclaw-surface.mjs" "$oc_dir/node_modules/openclaw" "$work/usage.json" >"$work/openclaw.json" \
  || die "could not read the surface of openclaw@$oc_pin"

# ── Hermes: the pinned commit's source tree, from GitHub ──
# Fetched into .part and moved into place only once the tag named beside the
# pin is proven to point at it, so a failed or cancelled run never leaves
# anything at the path CI caches.
he_dir="$cache/hermes-$he_commit"
he_src="$he_dir"
verified_line="$he_tag -> $he_commit"
trap 'rm -rf "$work" "$he_dir.part"' EXIT
if [ ! -d "$he_dir" ]; then
  echo "harness-contract: hermes-agent@$he_commit is not cached — fetching that one commit from GitHub"
  he_src="$he_dir.part"
  rm -rf "$he_src"
  mkdir -p "$he_src"
  git -C "$he_src" init -q
  git -C "$he_src" fetch -q --depth 1 "$he_repo" "$he_commit" || die "cannot fetch hermes-agent@$he_commit"
  git -C "$he_src" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$he_src" rev-parse HEAD)" = "$he_commit" ] || die "the fetched tree is not $he_commit"
  rm -rf "$he_src/.git"
fi
# The tag is asked of upstream whenever the tree does not record exactly this
# tag -> commit (a new pin, or a tag line edited without moving the commit).
tag_commit=null
if ! grep -qxF "$verified_line" "$he_src/.harness-contract-verified" 2>/dev/null; then
  refs="$(git ls-remote "$he_repo" "refs/tags/$he_tag" "refs/tags/$he_tag^{}")" || die "cannot list hermes-agent's tags"
  tag_commit="\"$(printf '%s\n' "$refs" | awk -v t="refs/tags/$he_tag" '$2 == t"^{}" {p=$1} $2 == t && !p {p=$1} END {print p}')\""
  if [ "$tag_commit" = "\"$he_commit\"" ]; then
    printf '%s\n' "$verified_line" >"$he_src/.harness-contract-verified"
    if [ "$he_src" != "$he_dir" ]; then mv "$he_src" "$he_dir" && he_src="$he_dir"; fi
  fi
fi
py="$(command -v python3)" || die "python3 (3.11 or newer) is required"
"$py" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "python3 is $("$py" -V); 3.11 or newer is required"
echo "harness-contract: reading hermes@$he_tag (argparse, config validator, OpenRPC contract, dashboard routes)"
mkdir -p "$work/hermes-home/tmp"
(cd "$work/hermes-home" && env -i HOME="$work/hermes-home" HERMES_HOME="$work/hermes-home/.hermes" TMPDIR="$work/hermes-home/tmp" PATH=/usr/bin:/bin LANG=C.UTF-8 \
  "$py" -I -S "$here/hermes_surface.py" "$he_src" "$work/usage.json") >"$work/hermes.json" 2>"$work/hermes.err" \
  || { tail -n 40 "$work/hermes.err" >&2; die "could not read the surface of hermes@$he_tag"; }

pin_line="$(grep -n '^HERMES_PIN_COMMIT=' "$repo/install.sh" | cut -d: -f1)"
cat >"$work/meta.json" <<EOF
{"openclawPin": "$oc_pin", "hermesCommit": "$he_commit", "hermesTag": "$he_tag",
 "hermesTagCommit": $tag_commit, "hermesPinSite": "install.sh:$pin_line"}
EOF
node "$here/check.mjs" "$repo" "$work/usage.json" "$work/openclaw.json" "$work/hermes.json" "$work/meta.json"
