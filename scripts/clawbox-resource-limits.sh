#!/usr/bin/env bash
#
# Install the cgroup v2 memory guards for the three units that can eat an 8 GB
# Jetson on their own: ollama, the automation browser and the GNOME session.
# TASK-455.
#
# Every number comes from config/clawbox-resource-limits.env — see that file for
# why each one is what it is. Nothing is hardcoded here.
#
#   --check    print the resolved limits and what WOULD be written; touch nothing
#   --apply    write the drop-ins and daemon-reload
#
# Idempotent and reversible: --apply only ever writes three files named
# 50-clawbox-memory.conf, so removing those three files and reloading systemd
# restores stock behaviour exactly.
#
# Must run as root for --apply. --check needs no privileges at all, which is the
# point: the setup-api route and the unit tests both drive it.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The three unit-name -> variable-prefix pairs this script manages.
DESKTOP_UID="${CLAWBOX_DESKTOP_UID:-1000}"

DROPIN_NAME="50-clawbox-memory.conf"
SYSTEMD_DIR="${CLAWBOX_SYSTEMD_DIR:-/etc/systemd/system}"

usage() {
  echo "Usage: $(basename "$0") --check | --apply" >&2
  exit 2
}

# ── Reading the limits ───────────────────────────────────────────────────────
#
# Deliberately a parser, NOT `source`. The fallback location is the repo copy
# under /home/clawbox/clawbox/config, which is clawbox-owned and
# clawbox-writable; this script runs as root via a NOPASSWD sudoers grant, so
# sourcing that file would hand root to anything with clawbox-level code
# execution. Only `KEY=value` lines whose KEY is one we asked for are read, and
# the value must be a bare systemd size or an integer.
limits_file() {
  local candidates=()
  [ -n "${CLAWBOX_RESOURCE_LIMITS_FILE:-}" ] && candidates+=("$CLAWBOX_RESOURCE_LIMITS_FILE")
  candidates+=("/etc/clawbox/resource-limits.env")
  candidates+=("$SCRIPT_DIR/../config/clawbox-resource-limits.env")
  local f
  for f in "${candidates[@]}"; do
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}

# read_limit <KEY> — echo the value, or exit non-zero if absent/malformed.
read_limit() {
  local key="$1" file value
  file="$(limits_file)" || {
    echo "Error: no resource-limits env file found" >&2
    return 1
  }
  value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\([0-9][0-9]*[KMGT]\{0,1\}\)[[:space:]]*$/\1/p" "$file" | tail -1)"
  if [ -z "$value" ]; then
    # Absent and malformed are different failures. A key that is not in the
    # file at all is an env file older than this script — the root-owned copy
    # on a box mid-update, before step_resource_limits reinstalls it — and the
    # unit it belongs to is skipped (rc 2) so the others still get their cap.
    # A key that IS there and does not parse is a broken file, and nothing is
    # written from it (rc 1).
    if ! grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
      echo "Warning: ${key} is not in ${file} (older than this script?) — skipping its unit" >&2
      return 2
    fi
    echo "Error: ${key} missing or malformed in ${file}" >&2
    return 1
  fi
  echo "$value"
}

# ── Drop-in rendering ────────────────────────────────────────────────────────

# dropin_body <High> <Max> <why>
dropin_body() {
  cat <<EOF
# Written by clawbox-resource-limits.sh (TASK-455). Do not edit by hand — edit
# config/clawbox-resource-limits.env in the ClawBox repo and re-run
# \`sudo /usr/local/libexec/clawbox/clawbox-resource-limits.sh --apply\`.
#
# $3
[Service]
MemoryAccounting=yes
MemoryHigh=$1
MemoryMax=$2
EOF
}

# One row per managed unit: unit-dir-name | High var | Max var | rationale
managed_units() {
  echo "ollama.service|CLAWBOX_OLLAMA_MEMORY_HIGH|CLAWBOX_OLLAMA_MEMORY_MAX|Local inference server: a resident 3B model plus two parallel slots."
  echo "clawbox-embed.service|CLAWBOX_EMBED_MEMORY_HIGH|CLAWBOX_EMBED_MEMORY_MAX|Memory-search embedder: one 0.6B Q8_0 model, one slot, a 1024-token batch."
  echo "clawbox-browser.service|CLAWBOX_BROWSER_MEMORY_HIGH|CLAWBOX_BROWSER_MEMORY_MAX|Chromium under CDP automation: caps a runaway renderer, not normal browsing."
  echo "user@${DESKTOP_UID}.service|CLAWBOX_DESKTOP_MEMORY_HIGH|CLAWBOX_DESKTOP_MEMORY_MAX|The GNOME desktop session. Backstop against a leaking shell extension."
}

main() {
  local mode="${1:-}"
  [ "$mode" = "--check" ] || [ "$mode" = "--apply" ] || usage

  local file
  file="$(limits_file)" || {
    echo "Error: no resource-limits env file found" >&2
    exit 1
  }

  if [ "$mode" = "--apply" ] && [ "$(id -u)" != "0" ]; then
    echo "Error: --apply must run as root" >&2
    exit 1
  fi

  echo "source: $file"
  echo "mode: ${mode#--}"

  local unit high_var max_var why high max dir dest rc
  while IFS='|' read -r unit high_var max_var why; do
    [ -n "$unit" ] || continue
    # rc 2 is "this env file predates the unit": skip it, cap the rest. rc 1
    # is a malformed file, and nothing is written from one of those.
    rc=0; high="$(read_limit "$high_var")" || rc=$?
    [ "$rc" -eq 2 ] && { echo "unit: $unit SKIPPED ($high_var not in $file)"; continue; }
    [ "$rc" -eq 0 ] || exit 1
    rc=0; max="$(read_limit "$max_var")" || rc=$?
    [ "$rc" -eq 2 ] && { echo "unit: $unit SKIPPED ($max_var not in $file)"; continue; }
    [ "$rc" -eq 0 ] || exit 1
    dir="$SYSTEMD_DIR/${unit}.d"
    dest="$dir/$DROPIN_NAME"
    echo "unit: $unit MemoryHigh=$high MemoryMax=$max -> $dest"
    if [ "$mode" = "--apply" ]; then
      mkdir -p "$dir"
      dropin_body "$high" "$max" "$why" > "$dest"
      chown root:root "$dest" 2>/dev/null || true
      chmod 0644 "$dest"
    fi
  done < <(managed_units)

  if [ "$mode" = "--apply" ]; then
    systemctl daemon-reload 2>/dev/null || true
    # Re-apply to already-running units so the guards are live without a
    # reboot. `set-property --runtime` is a no-op for a unit that is not
    # running, which is the normal state for the browser and often for ollama.
    while IFS='|' read -r unit high_var max_var _why; do
      [ -n "$unit" ] || continue
      high="$(read_limit "$high_var" 2>/dev/null)" || continue
      max="$(read_limit "$max_var" 2>/dev/null)" || continue
      systemctl set-property --runtime "$unit" "MemoryAccounting=yes" "MemoryHigh=$high" "MemoryMax=$max" \
        >/dev/null 2>&1 || true
    done < <(managed_units)
    echo "result: applied"
  else
    echo "result: no changes made (--check)"
  fi
}

main "$@"
