#!/usr/bin/env bash
#
# Choose the Jetson power profile. TASK-455.
#
# WHY this exists. clawbox-performance.service used to run, unconditionally at
# every boot:
#
#     nvpmodel -m <MAXN id> && jetson_clocks
#
# `nvpmodel -m MAXN_SUPER` on its own is only a CEILING and costs nothing when
# the box is quiet. `jetson_clocks` is the expensive half: it pins every CPU's
# scaling_min_freq to scaling_max_freq, pins the GPU the same way and DISABLES
# the cpuidle states, so the board sits at 1,728 MHz x6 + 1,020 MHz GPU at 4%
# utilisation. Measured on the QA box: 7.21 W and ~58 C doing nothing, and
# median Tj 74.8 C (max 75.4 C) under sustained 3B inference — over the 74 C
# passive-cooling trip, in a fanless-by-default appliance that sits in a
# living room.
#
# So: BALANCED is the default (a real nvpmodel cap, DVFS left alone, idle
# states on), and PERFORMANCE — the old pinned behaviour, verbatim — is an
# opt-in setting the owner turns on when they want it.
#
#   --check         print current state as JSON; change nothing (dry run)
#   --balanced      persist + apply the balanced profile
#   --performance   persist + apply the pinned profile
#   --apply         apply whatever is persisted (clawbox-performance.service)
#   --restore       undo the pinning (unit ExecStop)
#
# Takes effect IMMEDIATELY — no reboot, unlike the desktop toggle.
# --check needs no privileges; everything else must run as root.

set -euo pipefail

STATE_DIR="${CLAWBOX_STATE_DIR:-/etc/clawbox}"
STATE_FILE="$STATE_DIR/power-mode"
NVPMODEL_CONF="${CLAWBOX_NVPMODEL_CONF:-/etc/nvpmodel.conf}"
DEFAULT_MODE="balanced"

usage() {
  echo "Usage: $(basename "$0") --check | --balanced | --performance | --apply | --restore" >&2
  exit 2
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── Persisted intent ─────────────────────────────────────────────────────────
#
# Root-owned, next to /etc/clawbox/edition.env and for the same reason: the web
# server runs as `clawbox` and its whole config tree is clawbox-writable, so the
# thing root acts on at boot must not be. The only values ever written are the
# two literals below.
read_mode() {
  local raw=""
  [ -f "$STATE_FILE" ] && raw="$(tr -d '[:space:]' < "$STATE_FILE" 2>/dev/null || true)"
  case "$raw" in
    balanced|performance) echo "$raw" ;;
    *) echo "$DEFAULT_MODE" ;;
  esac
}

write_mode() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$1" > "$STATE_FILE"
  chown root:root "$STATE_FILE" 2>/dev/null || true
  chmod 0644 "$STATE_FILE"
}

# ── nvpmodel mode resolution ─────────────────────────────────────────────────
#
# Read the IDs out of /etc/nvpmodel.conf rather than hardcoding them: the map is
# per-module. On the shipped Orin Nano Super it is
#   ID=0 NAME=15W, ID=1 NAME=25W, ID=2 NAME=MAXN_SUPER
# but the same script has to do something sane on any other Jetson.
nvp_modes() {
  [ -f "$NVPMODEL_CONF" ] || return 0
  sed -n 's/^[[:space:]]*<[[:space:]]*POWER_MODEL[[:space:]]\+ID=\([0-9]\+\)[[:space:]]\+NAME=\([^[:space:]>]\+\).*/\1 \2/p' "$NVPMODEL_CONF"
}

# Highest-numbered MAXN mode — the ceiling profile.
performance_mode_id() {
  nvp_modes | awk '$2 ~ /MAXN/ {id=$1} END {if (id != "") print id}'
}

# Balanced = the highest mode that is NOT MAXN (25W on the shipped module).
# Falling back to the MAXN id is deliberate: on a module whose only mode is
# MAXN, "balanced" still means "the cap nvpmodel gives us, with jetson_clocks
# OFF" — the pinning is the part we are actually removing.
balanced_mode_id() {
  local id
  id="$(nvp_modes | awk '$2 !~ /MAXN/ {id=$1} END {if (id != "") print id}')"
  [ -n "$id" ] || id="$(performance_mode_id)"
  echo "${id:-0}"
}

mode_name_for_id() {
  nvp_modes | awk -v want="$1" '$1 == want {print $2; exit}'
}

current_nvpmodel_id() {
  have nvpmodel || { echo ""; return; }
  nvpmodel -q 2>/dev/null | awk 'NR>1 && /^[0-9]+$/ {print; exit}'
}

# ── Clock pinning ────────────────────────────────────────────────────────────

# True when the CPUs are pinned, i.e. jetson_clocks (or equivalent) has left
# scaling_min_freq == scaling_max_freq so the governor has nothing to scale.
clocks_pinned() {
  local policy min max seen=0
  for policy in /sys/devices/system/cpu/cpufreq/policy*; do
    [ -d "$policy" ] || continue
    min="$(cat "$policy/scaling_min_freq" 2>/dev/null || echo)"
    max="$(cat "$policy/scaling_max_freq" 2>/dev/null || echo)"
    [ -n "$min" ] && [ -n "$max" ] || continue
    seen=1
    # One policy the governor can still move is enough to say "not pinned".
    [ "$min" = "$max" ] || return 1
  done
  [ "$seen" = "1" ]
}

# jetson_clocks also switches the cpuidle states off, and nothing in nvpmodel
# turns them back on — so unpinning has to do it explicitly or the cores never
# reach C7 again and the idle-power win never materialises.
enable_cpuidle() {
  local f
  for f in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
    [ -w "$f" ] || continue
    echo 0 > "$f" 2>/dev/null || true
  done
}

# Hand the governor its range back. `nvpmodel -m` rewrites the min/max caps for
# the selected mode already; this is the belt-and-braces half, because a box
# that was pinned by jetson_clocks BEFORE nvpmodel ran can end up with
# scaling_min still at the ceiling.
unpin_cpu_freq() {
  local policy floor
  for policy in /sys/devices/system/cpu/cpufreq/policy*; do
    [ -d "$policy" ] || continue
    floor="$(cat "$policy/cpuinfo_min_freq" 2>/dev/null || echo)"
    [ -n "$floor" ] || continue
    [ -w "$policy/scaling_min_freq" ] || continue
    echo "$floor" > "$policy/scaling_min_freq" 2>/dev/null || true
  done
}

apply_balanced() {
  local id name
  id="$(balanced_mode_id)"
  name="$(mode_name_for_id "$id")"
  if have nvpmodel; then
    nvpmodel -m "$id" >/dev/null 2>&1 || echo "warning: nvpmodel -m $id failed" >&2
    echo "nvpmodel mode $id (${name:-unknown})"
  else
    echo "nvpmodel not present, skipping mode select"
  fi
  # No jetson_clocks. That is the whole point of this profile.
  unpin_cpu_freq
  enable_cpuidle
  echo "jetson_clocks: not applied (DVFS + cpuidle left to the kernel)"
}

apply_performance() {
  local id name
  id="$(performance_mode_id)"
  [ -n "$id" ] || id="$(balanced_mode_id)"
  name="$(mode_name_for_id "$id")"
  if have nvpmodel; then
    nvpmodel -m "$id" >/dev/null 2>&1 || echo "warning: nvpmodel -m $id failed" >&2
    echo "nvpmodel mode $id (${name:-unknown})"
  else
    echo "nvpmodel not present, skipping mode select"
  fi
  if have jetson_clocks; then
    jetson_clocks >/dev/null 2>&1 || echo "warning: jetson_clocks failed" >&2
    echo "jetson_clocks: applied (clocks pinned)"
  else
    echo "jetson_clocks not present"
  fi
}

report() {
  local mode id name pinned supported perf
  mode="$(read_mode)"
  id="$(current_nvpmodel_id)"
  name="$(mode_name_for_id "${id:-}")"
  if clocks_pinned; then pinned=true; else pinned=false; fi
  if have nvpmodel; then supported=true; else supported=false; fi
  perf="$(performance_mode_id)"
  printf '{"supported":%s,"mode":"%s","nvpmodelId":%s,"nvpmodelName":"%s","clocksPinned":%s,"balancedId":%s,"performanceId":%s}\n' \
    "$supported" "$mode" \
    "${id:-null}" "${name:-unknown}" "$pinned" \
    "$(balanced_mode_id)" "${perf:-null}"
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "Error: this action must run as root" >&2
    exit 1
  fi
}

main() {
  case "${1:-}" in
    --check)
      report
      ;;
    --balanced)
      require_root
      write_mode balanced
      apply_balanced
      report
      ;;
    --performance)
      require_root
      write_mode performance
      apply_performance
      report
      ;;
    --apply)
      require_root
      if [ "$(read_mode)" = "performance" ]; then apply_performance; else apply_balanced; fi
      report
      ;;
    --restore)
      require_root
      # ExecStop path. Always unpins, whatever the persisted mode is: stopping
      # the unit means "stop holding the clocks up".
      apply_balanced
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
