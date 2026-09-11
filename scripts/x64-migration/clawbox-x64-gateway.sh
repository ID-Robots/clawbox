#!/usr/bin/env bash
# The system bridge controls the pre-existing user unit, preserving its state,
# configuration, Node runtime and channels. This script is never sudo-granted.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
. /etc/clawbox/x64-integration.env
userctl() {
  /usr/sbin/runuser -u "$INSTALL_USER" -- /usr/bin/env \
    XDG_RUNTIME_DIR="/run/user/$INSTALL_UID" \
    /usr/bin/systemctl --user "$@"
}
case "${1:-}" in
  start)
    userctl reset-failed openclaw-gateway.service || true
    userctl start openclaw-gateway.service
    userctl is-active --quiet openclaw-gateway.service
    ;;
  stop) userctl stop openclaw-gateway.service ;;
  is-active) userctl is-active --quiet openclaw-gateway.service ;;
  reload) userctl daemon-reload ;;
  *) exit 64 ;;
esac
