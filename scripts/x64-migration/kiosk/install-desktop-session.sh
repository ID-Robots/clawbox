#!/usr/bin/env bash
# The x64 laptop's "ClawBox Desktop" session — MONITOR MODE: the ClawBox
# desktop page as the DESKTOP across every monitor, with native Chrome windows
# on top of it.
#
# install-kiosk-tabs.sh keeps the display a kiosk — cage shows ONE Chrome
# window, so every page the desktop opens is a tab beside it. This session
# replaces cage with labwc, a stacking Wayland compositor:
#   - the desktop is a Chrome app window (no tab strip, no address bar) laid
#     over every enabled monitor, under every other window — one desktop
#     across the row; Settings → Monitors arranges the monitors left to right
#     and sets each one's resolution, refresh rate, scale and rotation
#     (wlr-randr, through the web server: src/lib/monitors.ts), and a monitor
#     plugged in later gets its saved settings back;
#   - a page the desktop opens with window.open is an ordinary Chrome window
#     above it — tabs, address bar, native speed, movable and resizable;
#   - a maximized window stops above the desktop's shelf on the main monitor
#     (labwc <margin>, following the desktop's page zoom), so the shelf stays
#     reachable, and fills any other monitor whole;
#   - Super+D puts every browser window away, Alt+Tab switches between them,
#     Ctrl+Alt+Backspace ends the session.
# Monitor mode lives and dies with that labwc: the session names its PID in
# $XDG_RUNTIME_DIR/clawbox-monitor-mode, and the web server touches the
# monitors only while that process is alive — never under the cage kiosk.
#
# Installs (root-owned copies; the session never runs anything out of the
# checkout except the extension Chrome loads):
#   /usr/local/bin/clawbox-desktop-session     GDM's Exec
#   /usr/local/bin/clawbox-desktop-browser     the Chrome launcher + watchdog
#   /usr/local/lib/clawbox/clawbox-desktop-span.mjs
#   /etc/clawbox/labwc/rc.xml.in               the labwc config template
#   /usr/share/wayland-sessions/clawbox-desktop.desktop
# and makes it the autologin user's session. The cage session ("ClawBox
# Kiosk") is left installed as the fallback:
#
#   sudo scripts/x64-migration/kiosk/install-desktop-session.sh            # install, reboot
#   sudo scripts/x64-migration/kiosk/install-desktop-session.sh --no-restart
#   sudo scripts/x64-migration/kiosk/install-desktop-session.sh --revert   # back to the cage kiosk
#
# Idempotent; run it again after any change to the files it installs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
EXT="${CLAWBOX_KIOSK_EXTENSION:-$REPO/kiosk/extension}"
ENV_FILE=/etc/clawbox/kiosk.env
SESSION=clawbox-desktop
RESTART=1
REVERT=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    --revert) REVERT=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found; is this the kiosk laptop?" >&2; exit 1; }

# The account GDM logs in: its saved session is what autologin starts.
KIOSK_USER="${CLAWBOX_KIOSK_USER:-$(sed -n 's/^AutomaticLogin *= *//p' /etc/gdm3/custom.conf 2>/dev/null | head -1)}"
KIOSK_USER="${KIOSK_USER:-${SUDO_USER:-}}"
[ -n "$KIOSK_USER" ] && id "$KIOSK_USER" >/dev/null 2>&1 || { echo "cannot tell which account the kiosk logs in (set CLAWBOX_KIOSK_USER)" >&2; exit 1; }
ACCOUNT_FILE="/var/lib/AccountsService/users/$KIOSK_USER"

# set_session NAME — the autologin session, in the file GDM reads at login.
set_session() {
  local name="$1"
  if [ -f "$ACCOUNT_FILE" ] && grep -q '^Session=' "$ACCOUNT_FILE"; then
    sed -i "s/^Session=.*/Session=$name/" "$ACCOUNT_FILE"
  elif [ -f "$ACCOUNT_FILE" ]; then
    sed -i "s/^\[User\]$/[User]\nSession=$name/" "$ACCOUNT_FILE"
  else
    printf '[User]\nSession=%s\nSystemAccount=false\n' "$name" > "$ACCOUNT_FILE"
  fi
  # The running accounts daemon holds its own copy and writes it back.
  busctl call org.freedesktop.Accounts "/org/freedesktop/Accounts/User$(id -u "$KIOSK_USER")" \
    org.freedesktop.Accounts.User SetSession s "$name" >/dev/null 2>&1 || true
  echo "autologin session for $KIOSK_USER: $name"
}

offer_reboot() {
  [ "$RESTART" -eq 1 ] || { echo "reboot (or log out) for the session to change"; return; }
  echo "rebooting in 5s so the session changes (Ctrl+C to skip; then reboot later)"
  sleep 5
  systemctl reboot
}

# --revert only changes the session; the monitors need nothing undone. Monitor
# mode belongs to the labwc session itself — the web server arranges the
# monitors only while the labwc that session started is alive (its PID in
# $XDG_RUNTIME_DIR/clawbox-monitor-mode, written by clawbox-desktop-session),
# never under cage, which answers wlr-randr too. And what wlr-randr set lived
# in that labwc alone: the next cage session starts from its own default
# layout, every connected monitor on at its preferred mode, side by side, the
# way it did before this session was installed. kiosk.env and the saved
# arrangement (data/monitors.json) stay, for when this session comes back.
if [ "$REVERT" -eq 1 ]; then
  [ -f /usr/share/wayland-sessions/clawbox-kiosk.desktop ] || { echo "the cage kiosk session is not installed; nothing to go back to" >&2; exit 1; }
  set_session clawbox-kiosk
  echo "monitors: the kiosk starts with every connected monitor on at its own default; the saved arrangement is kept for the desktop session"
  [ "$RESTART" -eq 1 ] || echo "until then the running desktop session keeps its monitors as they are"
  offer_reboot
  exit 0
fi

for f in clawbox-desktop-session clawbox-desktop-browser clawbox-desktop-span.mjs; do
  [ -f "$HERE/$f" ] || { echo "$HERE/$f not found; run from the clawbox checkout" >&2; exit 1; }
done
[ -f "$REPO/kiosk/labwc/rc.xml.in" ] || { echo "$REPO/kiosk/labwc/rc.xml.in not found" >&2; exit 1; }
[ -f "$EXT/manifest.json" ] || { echo "$EXT/manifest.json not found" >&2; exit 1; }
bash -n "$HERE/clawbox-desktop-session"
bash -n "$HERE/clawbox-desktop-browser"

missing=()
command -v labwc >/dev/null || missing+=(labwc)
command -v wlrctl >/dev/null || missing+=(wlrctl)
command -v wlr-randr >/dev/null || missing+=(wlr-randr)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
fi

install -D -o root -g root -m 0755 "$HERE/clawbox-desktop-session" /usr/local/bin/clawbox-desktop-session
install -D -o root -g root -m 0755 "$HERE/clawbox-desktop-browser" /usr/local/bin/clawbox-desktop-browser
install -D -o root -g root -m 0644 "$HERE/clawbox-desktop-span.mjs" /usr/local/lib/clawbox/clawbox-desktop-span.mjs
rm -f /usr/local/lib/clawbox/clawbox-desktop-fullscreen.mjs
install -D -o root -g root -m 0644 "$REPO/kiosk/labwc/rc.xml.in" /etc/clawbox/labwc/rc.xml.in

# set_env KEY VALUE — one line of the env file both sessions share.
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
# The extension path the cage session's launcher loads. This session loads
# none (native windows carry their own tabs) unless CLAWBOX_DESKTOP_EXTENSION
# is set by hand.
set_env CLAWBOX_KIOSK_EXTENSION "$EXT"
# Where the web server records the layout it applied: the session reads the
# main monitor from it, for the shelf's margin.
set_env CLAWBOX_MONITORS_FILE "$REPO/data/monitors.json"

cat > /usr/share/wayland-sessions/clawbox-desktop.desktop <<'DESKTOP'
[Desktop Entry]
Name=ClawBox Desktop
Comment=The ClawBox desktop with native browser windows on top
Exec=/usr/local/bin/clawbox-desktop-session
TryExec=/usr/local/bin/clawbox-desktop-session
Type=Application
DesktopNames=ClawBox
DESKTOP

# Chrome draws its own title bar and takes the buttons from the GTK setting;
# "appmenu:close" leaves a window with no minimize or maximize.
uid="$(id -u "$KIOSK_USER")"
if [ -S "/run/user/$uid/bus" ]; then
  runuser -u "$KIOSK_USER" -- env DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    gsettings set org.gnome.desktop.wm.preferences button-layout ':minimize,maximize,close' 2>/dev/null \
    && echo "window buttons: minimize, maximize, close" || true
fi

set_session "$SESSION"
echo "installed: ClawBox Desktop session (labwc), extension $EXT"
offer_reboot
