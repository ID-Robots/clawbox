#!/usr/bin/env bash
# Fixed-scope root helper: a /run unit mask loses to an /etc unit file.
# A runtime drop-in condition also applies to units installed in /etc, and
# survives daemon-reload/unit replacement without touching the owner's masks.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exit 77
[ "$#" -eq 1 ] || exit 64
case "$1" in enter|leave) ;; *) exit 64 ;; esac
guard=/run/clawbox-gateway-maintenance
dropin=/run/systemd/system/clawbox-gateway.service.d/99-clawbox-maintenance.conf
if [ "$1" = enter ]; then
  install -d -o root -g root -m 0755 "$guard" "$(dirname "$dropin")"
  tmp=$(mktemp "${dropin}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  printf '[Unit]\nConditionPathExists=!/run/clawbox-gateway-maintenance\n' > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dropin"
else
  rm -f "$dropin"
  rmdir "$guard" 2>/dev/null || { [ ! -e "$guard" ] || exit 1; }
fi
/usr/bin/systemctl daemon-reload
if [ "$1" = enter ]; then
  /usr/bin/systemctl show clawbox-gateway.service -p DropInPaths --value | grep -Fq "$dropin"
fi
