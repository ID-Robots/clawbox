#!/usr/bin/env bash
# Shim: delegates to install.sh --step for backwards compatibility
# with the deployed systemd template that still references this path.
# Once install.sh runs again (which deploys the updated template),
# this shim is no longer needed.
exec bash /home/clawbox/clawbox/install.sh --step "$1"
