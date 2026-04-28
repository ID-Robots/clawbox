#!/bin/bash
# Save the clawbox-e2e Docker image to disk so subsequent test runs don't
# have to rebuild from scratch. Two artifacts are produced:
#
#   1. The image layer cache stays in Docker's image store under
#      clawbox-e2e:latest. Subsequent `docker compose build` reuses layers.
#   2. A portable tarball (~900MB) at e2e-install/cache/clawbox-e2e.tar.gz
#      that can be loaded on another machine via `docker load`.
#
# Volume preservation: tests run against the named volume `clawbox-home`,
# which holds the post-install state (.next build, node_modules, data dir,
# etc.). DO NOT call `docker compose down -v` between runs — that wipes
# the volume and forces a 3-15 min reinstall. Use `docker compose stop` to
# pause the container, or `restart` to bounce it. Only use `down -v` when
# install.sh itself changed and you need a clean slate.

set -euo pipefail

cd "$(dirname "$0")/.."

CACHE_DIR="e2e-install/cache"
OUT="${CACHE_DIR}/clawbox-e2e.tar.gz"

mkdir -p "$CACHE_DIR"

if ! docker image inspect clawbox-e2e:latest >/dev/null 2>&1; then
  echo "[save-image] clawbox-e2e:latest not found — run \`docker compose -f e2e-install/docker-compose.test.yml build\` first." >&2
  exit 1
fi

echo "[save-image] saving clawbox-e2e:latest -> $OUT"
docker save clawbox-e2e:latest | gzip -1 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

ls -lh "$OUT"

cat <<EOF

[save-image] done.
Restore on another machine:
    docker load < $OUT

Volume reuse on this machine — keep the volume to skip install.sh next time:
    docker compose -f e2e-install/docker-compose.test.yml stop          # keep volume
    docker compose -f e2e-install/docker-compose.test.yml start         # reuse volume

Force a clean slate (only when install.sh changed):
    docker compose -f e2e-install/docker-compose.test.yml down -v
EOF
