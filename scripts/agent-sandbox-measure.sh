#!/usr/bin/env bash
#
# Measure what the agent tool sandbox costs on THIS box: the numbers its
# default waits on. Run it as the clawbox user on a box whose sandbox runtime
# is provisioned (switch on in Settings -> Harness, or
# `sudo bash install.sh --step openclaw_config` after switching it on):
#
#   bash scripts/agent-sandbox-measure.sh [runs]       default: 5 start-time runs
#
# Prints one JSON object. Every container is started with the posture's caps
# from config/agent-sandbox.json and the flags OpenClaw starts a sandbox with
# (--init, no network, read-only root, every capability dropped), and removed
# again; nothing is left running. The verdict compares against the posture's
# budget: the memory cap must actually be ENFORCED (rootless Podman on a
# cgroup without a delegated memory controller accepts --memory and ignores
# it), and the image, the container store and the sandbox workspaces together
# must fit the disk budget.

set -euo pipefail

RUNS="${1:-5}"
ROOT="${CLAWBOX_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}"
POSTURE="$ROOT/config/agent-sandbox.json"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
command -v podman >/dev/null 2>&1 || { echo "agent-sandbox-measure: podman is not installed" >&2; exit 3; }
command -v python3 >/dev/null 2>&1 || { echo "agent-sandbox-measure: python3 is needed" >&2; exit 3; }

posture() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v:=v[k] for k in sys.argv[2].split(".")]; print(v)' "$POSTURE" "$1"; }
IMAGE="$(posture sandbox.docker.image)"
MEMORY="$(posture sandbox.docker.memory)"
MEMORY_SWAP="$(posture sandbox.docker.memorySwap)"
PIDS="$(posture sandbox.docker.pidsLimit)"
MEMORY_BUDGET="$(posture budget.memoryBytes)"
DISK_BUDGET="$(posture budget.diskBytes)"

podman image exists "$IMAGE" || { echo "agent-sandbox-measure: the sandbox image $IMAGE is not built" >&2; exit 4; }

FLAGS=(--init --network none --read-only --cap-drop ALL --memory "$MEMORY" --memory-swap "$MEMORY_SWAP" --pids-limit "$PIDS")
NAME="clawbox-sandbox-measure-$$"
cleanup() { podman rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

bytes_of() { [ -e "$1" ] && du -sb "$1" 2>/dev/null | awk '{print $1}' || echo 0; }

podman_version="$(podman version --format '{{.Client.Version}}' 2>/dev/null || podman --version | awk '{print $NF}')"
cgroup_fs="$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)"
image_bytes="$(podman image inspect --format '{{.Size}}' "$IMAGE")"
graph_root="$(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null || true)"
store_bytes="$(bytes_of "$graph_root")"
workspace_bytes="$(bytes_of "$OPENCLAW_HOME/sandboxes")"

# Cold-ish start to first exit, the cost every sandboxed command pays when its
# container is not already up. Milliseconds, one per run.
starts=()
for _ in $(seq 1 "$RUNS"); do
  t0=$(date +%s%N)
  podman run --rm "${FLAGS[@]}" "$IMAGE" true >/dev/null
  t1=$(date +%s%N)
  starts+=($(( (t1 - t0) / 1000000 )))
done

# The limit the kernel will hold the container to, read from inside it.
memory_max="$(podman run --rm "${FLAGS[@]}" "$IMAGE" sh -c 'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown' | tr -d '[:space:]')"

# What an idle sandbox holds while it waits for the next command.
podman run -d --name "$NAME" "${FLAGS[@]}" "$IMAGE" >/dev/null
sleep 2
idle_mem="$(podman stats --no-stream --format '{{.MemUsage}}' "$NAME" 2>/dev/null | head -1 || echo unknown)"
cleanup

# Does the gateway, the process that actually starts the sandboxes, have the
# user session rootless Podman needs for the cap? This shell has one, so every
# number above can be right while the gateway's own containers go uncapped.
# Read from the gateway's environment, which this user can read because the
# gateway runs as it; "unknown" when the unit has no main process here.
gateway_session="unknown"
gateway_pid="$(systemctl show -p MainPID --value "${CLAWBOX_GATEWAY_UNIT:-clawbox-gateway.service}" 2>/dev/null || echo 0)"
if [ "${gateway_pid:-0}" -gt 0 ] 2>/dev/null && [ -r "/proc/$gateway_pid/environ" ]; then
  gateway_runtime_dir="$(tr '\0' '\n' < "/proc/$gateway_pid/environ" | sed -n 's/^XDG_RUNTIME_DIR=//p' | head -1)"
  if [ -n "$gateway_runtime_dir" ] && [ -S "$gateway_runtime_dir/bus" ]; then
    gateway_session="yes"
  else
    gateway_session="no"
  fi
fi

python3 - "$podman_version" "$cgroup_fs" "$image_bytes" "$store_bytes" "$workspace_bytes" "$memory_max" "$idle_mem" "$gateway_session" "$MEMORY_BUDGET" "$DISK_BUDGET" "${starts[@]}" <<'PY'
import json, statistics, sys
(version, cgroup, image, store, workspaces, memory_max, idle, gateway_session, mem_budget, disk_budget, *starts) = sys.argv[1:]
mem_budget, disk_budget = int(mem_budget), int(disk_budget)
starts = [int(s) for s in starts]
disk = int(store) + int(workspaces)
enforced = memory_max.isdigit() and 0 < int(memory_max) <= mem_budget
print(json.dumps({
    "podman": version,
    "cgroup": cgroup,
    "imageBytes": int(image),
    "containerStoreBytes": int(store),
    "sandboxWorkspaceBytes": int(workspaces),
    "diskBytes": disk,
    "diskBudgetBytes": disk_budget,
    "memoryLimitSeenInContainer": memory_max,
    "memoryBudgetBytes": mem_budget,
    "memoryLimitEnforced": enforced,
    "idleContainerMemory": idle,
    "gatewayHasUserSession": {"yes": True, "no": False}.get(gateway_session),
    "startMs": starts,
    "startMsMedian": statistics.median(starts) if starts else None,
    "withinBudget": enforced and disk <= disk_budget,
}, indent=2))
PY
