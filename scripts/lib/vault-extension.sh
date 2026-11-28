#!/usr/bin/env bash
# ClawBox Vault's extension, for the box's own browser (scripts/launch-browser.sh).
#
# The vault service builds its extension into ~/.clawbox-vault/extension every
# time it starts (vault/src/server/extensiondir.ts) and leaves that run's
# pairing secret beside it, so the browser the assistant drives fills and saves
# logins with nothing to install and no pairing code to type.
#
# Sourced, never run: it defines one function and does nothing by itself.

# The folder to load, on stdout, or nothing when there is none to load.
#
# Only a COMPLETE folder is named: the manifest and the scripts it loads. A box
# whose vault has never started, or one caught halfway through its first build,
# gets the browser exactly as before rather than a browser that starts with an
# extension error on the screen.
vault_extension_dir() {
  local dir="${CLAWBOX_VAULT_EXTENSION_DIR:-${CLAWBOX_VAULT_HOME:-${HOME}/.clawbox-vault}/extension}"
  local file
  for file in manifest.json build/background.js build/content.js build/popup.js popup.html; do
    [ -f "$dir/$file" ] || return 0
  done
  printf '%s\n' "$dir"
}

# Give a vault that is starting RIGHT NOW the moment it needs to build the
# folder. An update restarts the browser in the same breath as it first starts
# the vault (install.sh restart_services_after_update), and a box boots both
# at once; without this the browser of that start would come up without the
# extension and keep running that way until someone closed it.
#
# Waits a second at a time, at most LIMIT seconds (default 20), and only when a
# folder can still be expected: the vault's unit is starting, has been up for
# less than a minute, or is enabled and about to be started. A vault that has
# been up for a while without building one is not going to, and every browser
# start would pay for it. Never fails: a browser without the extension still
# beats no browser.
vault_extension_wait() {
  local limit="${1:-20}" waited=0 state entered now
  [ -z "$(vault_extension_dir)" ] || return 0
  state="$(systemctl show clawbox-vault.service -p ActiveState --value 2>/dev/null || true)"
  case "$state" in
    activating) ;;
    active)
      entered="$(systemctl show clawbox-vault.service -p ActiveEnterTimestampMonotonic --value 2>/dev/null || true)"
      now="$(awk '{ printf "%d", $1 * 1000000 }' /proc/uptime 2>/dev/null || true)"
      case "$entered" in '' | *[!0-9]*) return 0 ;; esac
      case "$now" in '' | *[!0-9]*) return 0 ;; esac
      [ $((now - entered)) -lt 60000000 ] || return 0
      ;;
    *)
      systemctl is-enabled --quiet clawbox-vault.service 2>/dev/null || return 0
      ;;
  esac
  while [ "$waited" -lt "$limit" ]; do
    sleep 1
    waited=$((waited + 1))
    [ -z "$(vault_extension_dir)" ] || return 0
  done
  return 0
}

# The browser flags that load it, one per line, or nothing.
#
# The path is fixed, so the extension keeps its id, and with it its pairing,
# from one start to the next. Branded Google Chrome ignores --load-extension
# since 137 unless the feature that removed it is switched off, which is what
# the second flag is for; Chromium and Chrome for Testing need only the first.
vault_extension_flags() {
  local dir
  dir="$(vault_extension_dir)"
  [ -n "$dir" ] || return 0
  printf '%s\n' "--load-extension=$dir" "--disable-features=DisableLoadExtensionCommandLineSwitch"
}
