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
