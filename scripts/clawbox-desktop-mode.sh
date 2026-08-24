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
# WHY set-default and not `systemctl disable gdm`: on the shipped JetPack image
# gdm.service is a STATIC unit (measured on the QA box: `systemctl is-enabled
# gdm` -> static, `gdm3` -> alias). `disable` on a static unit is a silent
# no-op, so it is the boot target that actually decides. gdm is still disabled
# best-effort below for the images where it is not static, but the target is
# the authoritative bit and the one --check reports.
#
# Must run as root for --enable/--disable. --check needs no privileges.

set -euo pipefail

GRAPHICAL_TARGET="graphical.target"
CONSOLE_TARGET="multi-user.target"

# Display managers we switch off alongside the target, in the order they are
# tried. Best-effort: a box with none of them installed is fine.
DISPLAY_MANAGERS=(gdm3.service gdm.service lightdm.service sddm.service)

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

display_manager_state() {
  have_systemctl || { echo "unknown"; return; }
  local dm
  for dm in "${DISPLAY_MANAGERS[@]}"; do
    if systemctl list-unit-files "$dm" >/dev/null 2>&1 \
      && [ -n "$(systemctl list-unit-files "$dm" --no-legend 2>/dev/null)" ]; then
      echo "${dm%.service}:$(systemctl is-enabled "$dm" 2>/dev/null || echo unknown)"
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

set_display_managers() {
  local action="$1" dm
  have_systemctl || return 0
  for dm in "${DISPLAY_MANAGERS[@]}"; do
    [ -n "$(systemctl list-unit-files "$dm" --no-legend 2>/dev/null)" ] || continue
    # Static units (gdm on stock JetPack) have no [Install] section, so this is
    # a no-op there and the boot target carries the whole change. Never fatal.
    if systemctl "$action" "$dm" >/dev/null 2>&1; then
      echo "$action $dm"
    else
      echo "$action $dm skipped (static or not installable)"
    fi
  done
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
