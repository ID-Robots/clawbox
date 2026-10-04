#!/usr/bin/env bash
# timeout: 420
#
# The box rides out memory pressure: an 8 GB Jetson runs the gateway, the
# dashboard, a browser and a local model side by side, and a coding run or a
# `next build` can take the rest.
#
#   * Swap is on and holds at least 1 GB (install.sh step_swapfile; zram too
#     on a stock image).
#   * A throwaway hog on the board takes memory until MemAvailable is down to
#     ~350 MB and holds it for 45 s. It marks itself the OOM killer's first
#     choice (oom_score_adj 1000), so if anything must die it is the hog.
#   * While it holds, the gateway's /healthz and the dashboard's /login are
#     asked every few seconds; each must answer most of the time (a few slow
#     answers under pressure are expected, a dead service is not).
#   * Afterwards clawbox-gateway and clawbox-setup are the SAME processes as
#     before (no OOM kill, no restart), the gateway settles again, and swap
#     was actually used — i.e. the pressure was real.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# "<swap total MB> <swap devices> <gw pid> <gw restarts> <setup pid> <setup restarts> <oom kills>"
# shellcheck disable=SC2016  # expanded on the board
snapshot() {
  board '
    swap=$(awk "/^SwapTotal:/ {print int(\$2/1024)}" /proc/meminfo)
    devs=$(tail -n +2 /proc/swaps | wc -l)
    gw=$(systemctl show clawbox-gateway.service -p MainPID --value)
    gwr=$(systemctl show clawbox-gateway.service -p NRestarts --value)
    st=$(systemctl show clawbox-setup.service -p MainPID --value)
    str=$(systemctl show clawbox-setup.service -p NRestarts --value)
    oom=$(awk "/^oom_kill / {print \$2}" /proc/vmstat)
    echo "$swap $devs $gw ${gwr:-0} $st ${str:-0} ${oom:-0}"
  ' | tail -n 1
}

read -r SWAP_MB SWAP_DEVS GW_PID GW_RESTARTS ST_PID ST_RESTARTS OOM_BEFORE <<<"$(snapshot)"
if [ -z "${SWAP_MB:-}" ]; then
  not_ok "could not read the board's memory state"
  finish
fi
if [ "$SWAP_MB" -ge 1024 ]; then
  ok "swap is on: ${SWAP_MB} MB on $SWAP_DEVS device(s)"
else
  not_ok "swap is ${SWAP_MB} MB (want at least 1024 MB): the box has no cushion under memory pressure"
fi

# The hog and the watcher run ON the board; the answer is one summary line.
# shellcheck disable=SC2016  # expanded on the board
RESULT=$(board '
  hog=$(mktemp /tmp/nano-ci-hog.XXXXXX.py)
  cat > "$hog" <<"PY"
import os, time
open("/proc/self/oom_score_adj", "w").write("1000")
def meminfo(key):
    for line in open("/proc/meminfo"):
        if line.startswith(key + ":"):
            return int(line.split()[1]) // 1024
avail = lambda: meminfo("MemAvailable")
# Random bytes, so zram cannot compress the pressure away; capped at the
# size of RAM so a box with a large swap is pushed into it, not buried.
chunks, floor, cap, deadline = [], 350, meminfo("MemTotal"), time.time() + 120
while avail() > floor + 64 and len(chunks) * 64 < cap and time.time() < deadline:
    chunks.append(bytearray(os.urandom(64 << 20)))
print("held_mb=%d avail_mb=%d" % (len(chunks) * 64, avail()), flush=True)
time.sleep(45)
PY
  swap_used() { awk "/^SwapTotal:/ {t=\$2} /^SwapFree:/ {f=\$2} END {print int((t-f)/1024)}" /proc/meminfo; }
  swap0=$(swap_used)
  python3 "$hog" > /tmp/nano-ci-hog.out 2>&1 &
  pid=$!
  probes=0 gw_bad=0 web_bad=0 peak=$swap0
  while kill -0 "$pid" 2>/dev/null; do
    probes=$((probes + 1))
    curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:18789/healthz || gw_bad=$((gw_bad + 1))
    curl -fsS -o /dev/null --max-time 10 "$DASHBOARD/login" || web_bad=$((web_bad + 1))
    s=$(swap_used); [ "$s" -gt "$peak" ] && peak=$s
    sleep 3
  done
  wait "$pid"; rc=$?
  rm -f "$hog"
  echo "RESULT rc=$rc probes=$probes gw_bad=$gw_bad web_bad=$web_bad swap_before=$swap0 swap_peak=$peak $(tr "\n" " " < /tmp/nano-ci-hog.out)"
  rm -f /tmp/nano-ci-hog.out
' | grep '^RESULT ' | tail -n 1)
note "${RESULT:-no result from the board}"
val() { sed -n -E "s/.* $1=([0-9-]+).*/\\1/p" <<<"$RESULT"; }
PROBES=$(val probes) GW_BAD=$(val gw_bad) WEB_BAD=$(val web_bad)
SWAP0=$(val swap_before) SWAP_PEAK=$(val swap_peak) HELD=$(val held_mb) HOG_RC=$(val rc)
if [ -z "$PROBES" ] || [ "$PROBES" -lt 5 ]; then
  not_ok "the pressure run did not complete (${RESULT:-no answer})"
  finish
fi
case "$HOG_RC" in
  0) ok "the hog held ${HELD:-?} MB for 45 s" ;;
  137|-9) note "the OOM killer took the hog (as intended: it volunteers first)" ;;
  *) note "the hog exited $HOG_RC" ;;
esac
# Most answers must come back: a quarter of the probes may be slow under pressure.
for pair in "gateway /healthz:$GW_BAD" "dashboard /login:$WEB_BAD"; do
  what=${pair%:*} bad=${pair##*:}
  if [ "$((bad * 4))" -le "$PROBES" ]; then
    ok "$what answered under pressure ($((PROBES - bad))/$PROBES)"
  else
    not_ok "$what failed $bad of $PROBES probes under memory pressure"
  fi
done
if [ "${SWAP_PEAK:-0}" -gt "${SWAP0:-0}" ]; then
  note "swap in use went from ${SWAP0} MB to ${SWAP_PEAK} MB: the pressure was real"
else
  note "swap use did not rise (${SWAP0} MB): the hog never got the box to swap"
fi

read -r _ _ GW_PID2 GW_RESTARTS2 ST_PID2 ST_RESTARTS2 OOM_AFTER <<<"$(snapshot)"
note "OOM kills during the test: $(( ${OOM_AFTER:-0} - ${OOM_BEFORE:-0} ))"
if [ "$GW_PID2" = "$GW_PID" ] && [ "$GW_RESTARTS2" = "$GW_RESTARTS" ]; then
  ok "clawbox-gateway survived as the same process ($GW_PID)"
else
  not_ok "clawbox-gateway was killed or restarted under pressure (PID $GW_PID -> $GW_PID2, restarts $GW_RESTARTS -> $GW_RESTARTS2)"
fi
if [ "$ST_PID2" = "$ST_PID" ] && [ "$ST_RESTARTS2" = "$ST_RESTARTS" ]; then
  ok "clawbox-setup survived as the same process ($ST_PID)"
else
  not_ok "clawbox-setup was killed or restarted under pressure (PID $ST_PID -> $ST_PID2, restarts $ST_RESTARTS -> $ST_RESTARTS2)"
fi
if wait_gateway_settled 120; then
  ok "gateway settled again after the pressure (${SETTLE_WAITED}s)"
else
  not_ok "gateway not settled 120 s after the pressure: ${SETTLE_STATE:-unknown}"
fi
finish
