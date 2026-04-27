#!/usr/bin/env bash
# Run the full-install e2e suite:
#   - build the ARM64 container image
#   - boot it, wait for install.sh to finish
#   - run playwright happy-path + upgrade tests against it
#   - tear down (unless KEEP=1)
#
# Env:
#   CLAWBOX_PORT               host port to expose (default 8080)
#   CLAWBOX_UPGRADE_TARGET_BRANCH  branch for the upgrade test (default beta)
#   CLAWBOX_E2E_SKIP_SETUP=1   reuse an already-running container
#   CLAWBOX_E2E_REBUILD=1      force `docker compose build` before up
#   KEEP=1                     leave the container + volume up after tests
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f e2e-install/docker-compose.test.yml"

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "[e2e-install] KEEP=1, leaving container + volume up"
    return
  fi
  # CLAWBOX_E2E_SKIP_SETUP means the test run is reusing an externally-
  # managed container/volume — tearing it down would wipe state a caller
  # still needs. Skip teardown in that mode; the caller owns lifecycle.
  if [ "${CLAWBOX_E2E_SKIP_SETUP:-0}" = "1" ]; then
    echo "[e2e-install] CLAWBOX_E2E_SKIP_SETUP=1, leaving container + volume up for caller"
    return
  fi
  echo "[e2e-install] tearing down..."
  $COMPOSE down -v || true
}
trap cleanup EXIT

bunx playwright test --config e2e-install/playwright.config.ts "$@"
