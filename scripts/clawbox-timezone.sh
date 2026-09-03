#!/usr/bin/env bash
#
# Read and set the ClawBox system timezone. TASK-514.
#
# The box shipped with `timedatectl` on Etc/UTC and nothing ever asked. The
# desktop clock looked right because it is rendered by the BROWSER, while the
# agent — which reads the OS clock — answered three hours off on the same
# screen. Everything time-shaped (reminders, "this morning", day boundaries,
# self-scheduled jobs) silently inherited that offset.
#
#   --check          print the current state as JSON; change nothing
#   --list           print every IANA zone the box knows, one per line
#   --set <zone>     set the system timezone to <zone>
#
# --check and --list need NO privileges and are run without sudo. Only --set
# is granted in config/clawbox-sudoers, and the grant is deliberately
# ARGUMENT-LESS:
#
#   clawbox ALL=(root) NOPASSWD: /usr/local/libexec/clawbox/clawbox-timezone.sh
#
# sudoers(5) matches a command's arguments as one concatenated string and has
# no way to say "set-timezone followed by exactly one IANA zone" — the spelling
# that would come closest, `/usr/bin/timedatectl set-timezone *`, is a wildcard,
# and `*` spans whitespace (see the TASK-445 note in config/clawbox-sudoers).
# Granting the bare binary instead would hand over `set-time`, `set-ntp` and
# `set-local-rtc` along with it. So the grant names THIS script, which takes the
# zone and validates it in root-owned code before letting it near timedatectl —
# the same shape as the clawbox-run-root-step.sh grant, and the reason that one
# has no argument spec either.
#
# The validation below is the privilege boundary. It is repeated in
# src/lib/timezone.ts so a bad zone is refused with a 400 before it ever gets
# here, but this copy is the one that matters: it holds even if the caller is
# not the web server.

set -euo pipefail

ZONEINFO_DIR="/usr/share/zoneinfo"

usage() {
  echo "Usage: $(basename "$0") --check | --list | --set <zone>" >&2
  exit 2
}

have_timedatectl() {
  command -v timedatectl >/dev/null 2>&1
}

# Every zone the box will accept. `timedatectl list-timezones` is the
# authoritative answer and is what we validate against; it needs no privilege.
# The zoneinfo walk is the fallback for an image where timedatectl is absent or
# systemd-timedated will not answer (containers, CI) — it is the same data,
# minus systemd's own filtering.
list_zones() {
  if have_timedatectl && timedatectl list-timezones --no-pager 2>/dev/null | grep -q .; then
    timedatectl list-timezones --no-pager 2>/dev/null
    return 0
  fi
  [ -d "$ZONEINFO_DIR" ] || return 0
  # posix/ and right/ are alternate copies of the same zones; zone.tab and the
  # other data files are not zones at all.
  find "$ZONEINFO_DIR" -type f -not -path "*/posix/*" -not -path "*/right/*" \
    -printf '%P\n' 2>/dev/null \
    | grep -E '^[A-Za-z0-9][A-Za-z0-9/_+-]*$' \
    | grep -vE '^(posix|right)$|^(leap-seconds|tzdata|iso3166|zone1970?|zone)\.' \
    | sort
}

# The privilege boundary. Refuses anything that is not a plain relative IANA
# zone name, THEN refuses anything not in the list above.
#
# The character class is the first gate rather than the only one because it is
# what stops a path from being a path: no leading slash, so it cannot be
# absolute; no "." at all, so "../../etc" and every other traversal is gone
# before the filesystem is consulted; no whitespace, quotes, $ or backslash, so
# it cannot grow a second argument or survive a shell that re-splits it.
validate_zone() {
  local zone="$1"
  case "$zone" in
    "") echo "timezone is empty" >&2; return 1 ;;
    *[!A-Za-z0-9/_+-]*) echo "timezone contains characters that are not valid in an IANA zone name" >&2; return 1 ;;
    /*) echo "timezone must not be an absolute path" >&2; return 1 ;;
    */) echo "timezone must not end in a slash" >&2; return 1 ;;
  esac
  if [ "${#zone}" -gt 64 ]; then
    echo "timezone is too long" >&2
    return 1
  fi
  if ! list_zones | grep -qxF -- "$zone"; then
    echo "unknown timezone: $zone" >&2
    return 1
  fi
  return 0
}

current_zone() {
  if have_timedatectl; then
    timedatectl show --property=Timezone --value 2>/dev/null || echo ""
  else
    # No systemd: /etc/localtime is a symlink into the zoneinfo tree.
    readlink -f /etc/localtime 2>/dev/null | sed "s|^$ZONEINFO_DIR/||" || echo ""
  fi
}

ntp_synchronized() {
  have_timedatectl || { echo "false"; return; }
  if [ "$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || echo no)" = "yes" ]; then
    echo "true"
  else
    echo "false"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

print_status() {
  local zone supported local_time utc_offset
  zone="$(current_zone || true)"
  [ -n "$zone" ] || zone="Etc/UTC"
  if have_timedatectl; then supported="true"; else supported="false"; fi
  # date reads the zone we just set, so this is the box's real wall clock and
  # the thing the UI echoes back to the owner as confirmation.
  local_time="$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "")"
  utc_offset="$(date '+%z' 2>/dev/null || echo "")"
  printf '{"supported":%s,"timezone":"%s","localTime":"%s","utcOffset":"%s","ntpSynchronized":%s}\n' \
    "$supported" \
    "$(json_escape "$zone")" \
    "$(json_escape "$local_time")" \
    "$(json_escape "$utc_offset")" \
    "$(ntp_synchronized)"
}

set_zone() {
  local zone="$1"
  validate_zone "$zone" || exit 3
  if ! have_timedatectl; then
    echo "timedatectl is not available on this system" >&2
    exit 4
  fi
  # No --adjust-system-clock: the RTC stays on UTC (RTC in local TZ is a
  # dual-boot workaround and systemd warns against it), and the box is
  # NTP-synchronised anyway, so only the DISPLAYED zone changes here.
  if ! timedatectl set-timezone "$zone" >/dev/null 2>&1; then
    echo "timedatectl set-timezone failed for $zone" >&2
    exit 5
  fi
  print_status
}

[ $# -ge 1 ] || usage

case "$1" in
  --check) print_status ;;
  --list)  list_zones ;;
  --set)
    [ $# -eq 2 ] || usage
    set_zone "$2"
    ;;
  *) usage ;;
esac
