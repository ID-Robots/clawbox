#!/usr/bin/env bash
# Guake — the drop-down terminal of the "ClawBox Desktop" session — in the
# ClawBox look, on Win+Down.
#
#   sudo scripts/x64-migration/kiosk/install-guake.sh                # packages + the desktop user's settings
#   scripts/x64-migration/kiosk/install-guake.sh --user-config       # only this account's settings, no sudo
#
# Installs `guake`, then, as the account GDM logs in (CLAWBOX_KIOSK_USER, else
# AutomaticLogin, else the sudo caller):
#   - Guake's settings from guake/clawbox-guake.dconf (`dconf load
#     /org/guake/`): the ClawBox Terminal's GitHub-dark palette on the desktop
#     window's ground, the system monospace, tabs on top, opaque, no tray icon
#     or start-up notification (the session has neither);
#   - guake/guake.css into ~/.config/gtk-3.0/gtk.css between markers, every
#     rule scoped to Guake's own window — the tab strip of the ClawBox Terminal;
#   - Win+Down in ~/.config/clawbox-desktop/keybinds.xml and Guake started
#     with the session in ~/.config/clawbox-desktop/autostart (the session's
#     own hooks, see clawbox-desktop-browser), each added only when missing.
#
# Idempotent. A running Guake takes the settings at once; the tab strip's
# stylesheet when Guake next starts (it is read once, at start-up) — this
# script never restarts Guake, which may be the very terminal it runs in.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$HERE/guake"
DCONF="${CLAWBOX_DCONF:-dconf}"
CSS_BEGIN="/* >>> clawbox-guake >>> (install-guake.sh; edits between these markers are replaced) */"
CSS_END="/* <<< clawbox-guake <<< */"

for f in clawbox-guake.dconf guake.css keybinds.xml; do
  [ -f "$ASSETS/$f" ] || { echo "$ASSETS/$f not found; run from the clawbox checkout" >&2; exit 1; }
done

# ── This account's settings ──────────────────────────────────────────────────
user_config() {
  local conf="${XDG_CONFIG_HOME:-$HOME/.config}"

  # Guake's own keys. dconf needs the session bus; with none (the user is not
  # logged in) a private one writes the same database.
  if [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [ -n "${CLAWBOX_DCONF:-}" ]; then
    "$DCONF" load /org/guake/ < "$ASSETS/clawbox-guake.dconf"
  else
    dbus-run-session -- "$DCONF" load /org/guake/ < "$ASSETS/clawbox-guake.dconf"
  fi
  echo "guake settings: ClawBox look (dconf /org/guake/)"

  # The tab strip, between markers in the account's GTK stylesheet: anything
  # else in that file is the owner's and stays as it is.
  local css="$conf/gtk-3.0/gtk.css" tmp
  mkdir -p "$conf/gtk-3.0"
  tmp="$(mktemp "$css.XXXXXX")"
  if [ -f "$css" ]; then
    awk -v b="$CSS_BEGIN" -v e="$CSS_END" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      !skip { print }
    ' "$css" > "$tmp"
  fi
  # One blank line between the owner's rules and ours, never a growing gap.
  if [ -s "$tmp" ] && [ -n "$(tail -c 1 "$tmp")" ]; then echo >> "$tmp"; fi
  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$tmp"
  [ -s "$tmp" ] && echo >> "$tmp"
  { echo "$CSS_BEGIN"; cat "$ASSETS/guake.css"; echo "$CSS_END"; } >> "$tmp"
  mv -f "$tmp" "$css"
  echo "guake tab strip: $css"

  # Win+Down, unless the owner already bound the key to something.
  local local_dir="$conf/clawbox-desktop" keys
  mkdir -p "$local_dir"
  keys="$local_dir/keybinds.xml"
  if [ ! -f "$keys" ]; then
    cp "$ASSETS/keybinds.xml" "$keys"
    echo "Win+Down: guake ($keys)"
  elif grep -q 'key="W-Down"' "$keys"; then
    echo "Win+Down: already bound in $keys (left as it is)"
  else
    { echo; cat "$ASSETS/keybinds.xml"; } >> "$keys"
    echo "Win+Down: guake (added to $keys)"
  fi

  # Guake waiting in the background from the start of the session, so the
  # first Win+Down shows it at once.
  local auto="$local_dir/autostart"
  if [ ! -f "$auto" ]; then
    printf '#!/bin/sh\n# Started once at the start of each ClawBox Desktop session.\n# Guake, hidden, so Win+Down shows it at once.\nguake &\n' > "$auto"
    echo "autostart: guake ($auto)"
  elif grep -qw guake "$auto"; then
    echo "autostart: already starts guake ($auto)"
  else
    printf '\n# Guake, hidden, so Win+Down shows it at once.\nguake &\n' >> "$auto"
    echo "autostart: guake (added to $auto)"
  fi
  chmod +x "$auto"

  if pgrep -u "$(id -u)" -f '/guake( |$)' >/dev/null 2>&1; then
    echo "Guake is running: the colours and font apply now, the tab strip the next time it starts"
  fi
}

if [ "${1:-}" = "--user-config" ]; then
  user_config
  exit 0
fi
[ $# -eq 0 ] || { echo "unknown option: $1" >&2; exit 1; }

# ── Packages, then the desktop user's settings ───────────────────────────────
[ "$(id -u)" -eq 0 ] || { echo "run with sudo (or --user-config for this account's settings only)" >&2; exit 1; }

KIOSK_USER="${CLAWBOX_KIOSK_USER:-$(sed -n 's/^AutomaticLogin *= *//p' /etc/gdm3/custom.conf 2>/dev/null | head -1)}"
KIOSK_USER="${KIOSK_USER:-${SUDO_USER:-}}"
[ -n "$KIOSK_USER" ] && id "$KIOSK_USER" >/dev/null 2>&1 || { echo "cannot tell which account the desktop logs in (set CLAWBOX_KIOSK_USER)" >&2; exit 1; }

missing=()
command -v guake >/dev/null || missing+=(guake)
command -v dconf >/dev/null || missing+=(dconf-cli)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
fi

uid="$(id -u "$KIOSK_USER")"
home="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
bus_env=()
[ -S "/run/user/$uid/bus" ] && bus_env=(DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" XDG_RUNTIME_DIR="/run/user/$uid")
runuser -u "$KIOSK_USER" -- env HOME="$home" "${bus_env[@]}" bash "$HERE/install-guake.sh" --user-config
