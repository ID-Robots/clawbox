# shellcheck shell=bash
# What may act on clawbox-gateway.service, and when. SOURCED, never executed.
#
# Two root-owned scripts restart the OpenClaw gateway on their own initiative:
#
#   * gateway-restart-when-online.sh — the NetworkManager waiter (GH #529,
#     #1111): restarts it once a real outage is over and a route is proven.
#   * gateway-watchdog.sh — the liveness watchdog (TASK-2490): restarts it when
#     the process is alive but has stopped answering HTTP.
#
# Both have to ask the same first question — is there a gateway on this box
# that systemd would act on at all — and both must answer it the same way, so
# the answer lives here once. Installed ROOT-OWNED beside them in
# /usr/local/libexec/clawbox by install.sh (install_root_libexec and
# step_nm_dispatcher, BEFORE either consumer), for the reason every file there
# is: root sources it, so the copy that runs must not be one clawbox can write.
#
# Nothing here writes, restarts or logs: it answers, and the caller decides
# what the answer means for it.

# A number from the environment that is not one must not become an unset value
# and a `set -u` death three lines later. Prints the value, or the default.
positive_int() {
  case "${1:-}" in
    ''|*[!0-9]*) printf '%s' "$2" ;;
    *) [ "$1" -gt 0 ] 2>/dev/null && printf '%s' "$1" || printf '%s' "$2" ;;
  esac
}

# Seconds since boot, and NOT `date +%s`: these boards have no RTC, so
# systemd-timesyncd steps the clock the moment a route comes up. A window
# measured on the wall clock can collapse or stretch by years across that step.
# /run is cleared on boot, so state kept there and this counter share a
# lifetime by construction. Fails (no output) when /proc/uptime is unreadable.
monotonic_seconds() {
  local up=""
  read -r up _ < /proc/uptime 2>/dev/null || return 1
  case "$up" in ''|*[!0-9.]*) return 1 ;; esac
  printf '%s' "${up%%.*}"
}

# The unit's LoadState, printed, with the verdict in the exit status:
#
#   0  `loaded` — a unit systemd would act on (the OpenClaw and dual editions)
#   1  anything else: `masked` is the Hermes edition, which stops, disables and
#      MASKS clawbox-gateway.service (install.sh step_edition_gateway_state);
#      `not-found` is a box where it was never installed (an edition not yet
#      chosen). There is nothing to restart, and it is not an error.
#   2  systemctl did not answer at all — a `daemon-reexec` (install.sh and the
#      updater both trigger one), a bus hiccup, no systemd. NOT evidence that
#      this edition has no gateway; src/lib/gateway-health.ts states the same
#      rule for the same property: "null means systemctl did not answer, which
#      is not evidence either way."
#
# `list-unit-files` is the wrong question: it LISTS a masked unit, so it answers
# "present" on the one edition this exists for. Measured read-only on the
# Hermes box: `clawbox-gateway.service masked enabled`, exit 0. The LoadState is
# systemd's own answer about the unit the caller would act on, which needs no
# second source of truth about the edition.
gateway_unit_load_state() {
  local unit="${1:-clawbox-gateway.service}" state
  state="$(systemctl show -p LoadState --value "$unit" 2>/dev/null)"
  printf '%s' "$state"
  [ -n "$state" ] || return 2
  [ "$state" = "loaded" ] || return 1
  return 0
}
