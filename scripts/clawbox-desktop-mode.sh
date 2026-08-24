#!/usr/bin/env bash
#
# Turn the GNOME desktop on or off on a ClawBox. TASK-455.
#
# The desktop is a SHIPPED, DEFAULT-ON feature (Krasi's ruling, 2026-08-24).
# This script exists so an owner who wants the ~691 MiB PSS the GNOME session
# holds can have it back, WITHOUT a separate headless image and without
# uninstalling anything: nothing here removes GNOME, gdm or snapd, and every
# change is one command away from being undone.
#
#   --check      print the current state as JSON; change nothing (dry run)
#   --enable     desktop on   (default.target = graphical.target)
#   --disable    desktop off  (default.target = multi-user.target)
#
# Applies at the NEXT BOOT by design. Tearing the graphical session down under
# a logged-in user mid-session would kill their VNC view and any Chromium the
# agent is driving; `systemctl isolate multi-user.target` on a box whose only
# console is that desktop is also how you lock yourself out of a device with no
# keyboard. So we change the boot target and report "reboot required".
#
# WHY set-default and not `systemctl disable gdm`: the boot target is the
# authoritative bit and the one --check reports. An earlier revision ALSO
# disabled the display manager "best-effort", believing `disable` to be a no-op
# on the shipped JetPack image because `systemctl is-enabled gdm` answers
# `static`. On hardware that is false and it cost the desktop permanently — see
# dm_is_installable below for the measurement and the trap. Display managers are
# now only enabled/disabled when their [Install] symlinks are genuinely ours.
#
# Must run as root for --enable/--disable. --check needs no privileges.

set -euo pipefail

GRAPHICAL_TARGET="graphical.target"
CONSOLE_TARGET="multi-user.target"

# Display managers we switch off alongside the target, in the order they are
# tried. Best-effort: a box with none of them installed is fine.
DISPLAY_MANAGERS=(gdm3.service gdm.service lightdm.service sddm.service)

# The symlink that actually starts the desktop. On Ubuntu/JetPack the display
# manager package installs it as an alias of the real unit, and
# `graphical.target` pulls it in via `Wants=display-manager.service`. If the
# link is missing the target still activates — with nothing under it — so the
# box boots to a black screen no matter what `set-default` says.
DISPLAY_MANAGER_ALIAS="/etc/systemd/system/display-manager.service"

usage() {
  echo "Usage: $(basename "$0") --check | --enable | --disable" >&2
  exit 2
}

have_systemctl() {
  command -v systemctl >/dev/null 2>&1
}

current_target() {
  if have_systemctl; then
    systemctl get-default 2>/dev/null || echo "unknown"
  else
    echo "unknown"
  fi
}

# Is the graphical stack up RIGHT NOW? This is what makes "reboot required"
# honest: the boot target is the persisted intent, the active target is what
# the box is actually doing, and they disagree exactly between a toggle and the
# next reboot.
graphical_active() {
  have_systemctl || return 1
  [ "$(systemctl is-active "$GRAPHICAL_TARGET" 2>/dev/null || true)" = "active" ]
}

# Does graphical.target actually pull the display manager in on this image?
#
# Wants, not Requires: on stock JetPack graphical.target has
# `Requires=multi-user.target` and reaches the display manager through
# `Wants=display-manager.service`. Asking only about Requires made both the
# repair and the --check warning silent no-ops on the very box they were
# written for. Ask for both, once, from one place.
graphical_target_wants_display_manager() {
  systemctl show "$GRAPHICAL_TARGET" -p Wants -p Requires 2>/dev/null \
    | grep -q 'display-manager\.service'
}

display_manager_state() {
  have_systemctl || { echo "unknown"; return; }
  local dm suffix=""
  # `is-enabled` on an alias answers "alias" whether or not the alias symlink
  # still exists, so it reads identically on a healthy box and on one whose
  # display-manager.service link was deleted. Say so explicitly, or --check
  # cannot tell "desktop off" from "desktop broken". Free-form string by
  # contract (src/lib/system-profile.ts reads it as an opaque label), so this
  # adds no schema.
  if [ ! -e "$DISPLAY_MANAGER_ALIAS" ] && graphical_target_wants_display_manager; then
    suffix=":missing-alias"
  fi
  for dm in "${DISPLAY_MANAGERS[@]}"; do
    if systemctl list-unit-files "$dm" >/dev/null 2>&1 \
      && [ -n "$(systemctl list-unit-files "$dm" --no-legend 2>/dev/null)" ]; then
      echo "${dm%.service}:$(systemctl is-enabled "$dm" 2>/dev/null || echo unknown)${suffix}"
      return
    fi
  done
  echo "none"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

report() {
  local target enabled active pending dm
  target="$(current_target)"
  if [ "$target" = "$GRAPHICAL_TARGET" ]; then enabled=true; else enabled=false; fi
  if graphical_active; then active=true; else active=false; fi
  if [ "$enabled" = "$active" ]; then pending=false; else pending=true; fi
  dm="$(display_manager_state)"
  printf '{"supported":%s,"enabled":%s,"active":%s,"rebootRequired":%s,"defaultTarget":"%s","displayManager":"%s"}\n' \
    "$(have_systemctl && echo true || echo false)" \
    "$enabled" "$active" "$pending" \
    "$(json_escape "$target")" "$(json_escape "$dm")"
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "Error: this action must run as root" >&2
    exit 1
  fi
}

set_target() {
  local target="$1"
  have_systemctl || { echo "Error: systemctl not available" >&2; exit 1; }
  # Idempotent: set-default on the target that is already default is a no-op
  # that still exits 0, but skipping it keeps the log honest.
  if [ "$(current_target)" = "$target" ]; then
    echo "default target already $target"
  else
    systemctl set-default "$target" >/dev/null
    echo "default target set to $target"
  fi
}

# May `systemctl <action>` be run on this unit, or would it do damage?
#
# The original code disabled every name in DISPLAY_MANAGERS "best-effort, never
# fatal", on the stated reasoning that "disable on a static unit is a silent
# no-op". On hardware it is not: `systemctl disable` removes every symlink that
# enables the unit, and on stock JetPack one of them is
# /etc/systemd/system/display-manager.service — what graphical.target pulls in
# via Wants=. `enable` cannot put it back (the real unit is static: no
# [Install]/Alias= to install from), so turning the desktop off destroyed it
# permanently while the API went on answering {"enabled":true}.
#
# The trap that makes this so easy to get wrong — measured on the QA box,
# 2026-08-24, with `bash -x`:
#
#   symlink present:  systemctl is-enabled gdm.service -> indirect
#   symlink deleted:  systemctl is-enabled gdm.service -> static
#
# So `static` is what the box reports AFTER the damage is done. Anyone probing
# a box that has already been through one --disable sees `static`, concludes
# "disable is a no-op here", and ships the loop that broke it. Only `indirect`
# — the state that means "enabled through a symlink" — is visible beforehand,
# and it is exactly the state where disable is destructive.
#
# Hence a WHITELIST, not a blacklist of known-bad states. systemd's vocabulary
# also includes generated/transient/masked/linked/indirect, and guessing which
# of those are safe is how this bug happened twice. Only `enabled`,
# `enabled-runtime` and `disabled` describe a unit whose [Install] symlinks are
# ours to add or remove; for everything else the boot target carries the
# change, which is what this script was designed around anyway.
#
# NOTE on the exit status: `systemctl is-enabled` prints the state on stdout
# but exits NON-ZERO for several of these. `$(systemctl is-enabled "$1" || echo
# unknown)` therefore captures BOTH words — "static\nunknown" — matching no arm
# and falling through to the destructive branch. Keep status handling separate
# from the capture.
dm_is_installable() {
  local state
  state="$(systemctl is-enabled "$1" 2>/dev/null)" || true
  case "$state" in
    enabled|enabled-runtime|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

set_display_managers() {
  local action="$1" dm
  have_systemctl || return 0
  for dm in "${DISPLAY_MANAGERS[@]}"; do
    [ -n "$(systemctl list-unit-files "$dm" --no-legend 2>/dev/null)" ] || continue
    if ! dm_is_installable "$dm"; then
      # The boot target carries the whole change here, which is what this
      # script was always designed around.
      echo "$action $dm skipped ($(systemctl is-enabled "$dm" 2>/dev/null || true) — the boot target decides)"
      continue
    fi
    if systemctl "$action" "$dm" >/dev/null 2>&1; then
      echo "$action $dm"
    else
      echo "$action $dm skipped (not installable)"
    fi
  done
}

# Put back a display-manager.service alias that an earlier --disable deleted.
#
# Needed for every device already shipped with the bug above: `set-default
# graphical.target` alone leaves them black-screened, because the unit the
# target requires no longer resolves. Idempotent, and does nothing on a healthy
# box or on an image that never had the alias.
repair_display_manager_alias() {
  local dm unit
  have_systemctl || return 0
  [ -e "$DISPLAY_MANAGER_ALIAS" ] && return 0
  graphical_target_wants_display_manager || return 0

  for dm in "${DISPLAY_MANAGERS[@]}"; do
    # Resolve through the alias to the unit file that actually exists, so the
    # link points at gdm.service rather than at another symlink.
    unit="$(systemctl show "$dm" -p FragmentPath --value 2>/dev/null || true)"
    [ -n "$unit" ] && [ -f "$unit" ] || continue
    ln -sf "$unit" "$DISPLAY_MANAGER_ALIAS"
    systemctl daemon-reload >/dev/null 2>&1 || true
    echo "repaired $DISPLAY_MANAGER_ALIAS -> $unit"
    return 0
  done
  echo "warning: $DISPLAY_MANAGER_ALIAS is missing and no display manager unit was found" >&2
}

main() {
  case "${1:-}" in
    --check)
      report
      ;;
    --enable)
      require_root
      set_target "$GRAPHICAL_TARGET"
      set_display_managers enable
      # Before reporting success: a box that was turned headless by an older
      # build of this script has no display-manager.service left, and would
      # otherwise reboot into a graphical.target with nothing under it while
      # this command exits 0 saying the desktop is on.
      repair_display_manager_alias
      report
      ;;
    --disable)
      require_root
      set_target "$CONSOLE_TARGET"
      set_display_managers disable
      # The automation browser is on-demand only (clawbox-browser.service is a
      # static unit with no [Install], and install.sh explicitly skips it in the
      # enable loop), so there is nothing to switch off for it here. Stop it if
      # it happens to be up: without a desktop there is no X display for it to
      # draw on, and leaving ~1 GB of Chromium resident on a box whose owner
      # just asked for the memory back would defeat the point.
      systemctl stop clawbox-browser.service >/dev/null 2>&1 || true
      report
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
