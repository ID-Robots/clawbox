#!/usr/bin/env bash
# Shim for devices whose deployed clawbox-root-update@.service still names this
# path. Once install.sh runs again it rewrites the unit to point straight at
# /usr/local/libexec/clawbox/clawbox-root-step.sh and this file is unused.
#
# It must NOT exec install.sh directly. This path is reached as root, and going
# to /home/clawbox/clawbox/install.sh from here would skip everything the
# root-owned dispatcher exists to do — the step allow-list, the self-update
# pinning, and the integrity check on the tree root is about to run — leaving
# any field device still on the old unit outside the whole fix. TASK-445.
DISPATCHER=/usr/local/libexec/clawbox/clawbox-root-step.sh
LIBEXEC_DIR=/usr/local/libexec/clawbox

if [ -x "$DISPATCHER" ]; then
  exec "$DISPATCHER" "$1"
fi

# No dispatcher. Two very different devices land here, and they get different
# answers:
#
#   * $LIBEXEC_DIR does not exist at all — a device provisioned before the
#     root-owned entrypoint existed. Its unit names this file precisely because
#     nothing newer has been installed yet, and the update that installs the
#     dispatcher has to be able to run. Refusing would strand exactly the
#     devices this shim exists for, so fall through to install.sh, loudly.
#   * $LIBEXEC_DIR exists but the dispatcher is missing or not executable — a
#     half-installed or tampered device. Do not paper over that with a root exec;
#     an operator can repair it with `sudo bash install.sh`.
if [ -d "$LIBEXEC_DIR" ]; then
  echo "root-update-step: $LIBEXEC_DIR exists but $DISPATCHER is missing or not executable." >&2
  echo "root-update-step: refusing to run install.sh unguarded. Repair with: sudo bash /home/clawbox/clawbox/install.sh" >&2
  exit 65
fi

echo "root-update-step: no root-owned dispatcher on this device yet; running the legacy path once." >&2
exec bash /home/clawbox/clawbox/install.sh --step "$1"
