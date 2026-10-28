#!/usr/bin/env bash
# Rebuild the checked-out tree and put the running UI on it — the "after" half
# of a bench loop (docs/clawbox-bench.md) on a box whose UI runs as this user
# under systemd with Restart=always (the x64 dev install; the in-app updater
# restarts the same way, see restartUiProcess in src/lib/x64-install-update.ts).
#
#   bash scripts/bench/rebuild-and-restart.sh            # build, restart, reload the kiosk desktop
#   bash scripts/bench/rebuild-and-restart.sh --no-build # restart + reload only
#
# The build's exit code is checked BEFORE anything is restarted: a failed
# Turbopack build takes the previous build's files with it, so a restart on
# top of one crash-loops the UI (2026-10-27, four minutes of outage). Then the
# UI's main process gets SIGTERM, systemd brings it back on the new build, the
# script waits for /login to answer, and the kiosk's desktop page is reloaded
# over the DevTools port so the page the bench measures runs the new code.
set -euo pipefail
cd "$(dirname "$0")/../.."
UNIT=${CLAWBOX_UI_UNIT:-clawbox-setup.service}
PORT=${PORT:-3005}
CDP_PORT=${CLAWBOX_KIOSK_CDP_PORT:-18801}

if [ "${1:-}" != "--no-build" ]; then
  bun run build || { echo "build failed — nothing restarted" >&2; exit 1; }
  [ -f .next/server/app/index.html ] || { echo ".next/server/app/index.html missing after the build — nothing restarted" >&2; exit 1; }
fi

old=$(systemctl show -p MainPID --value "$UNIT")
[ "$old" != "0" ] || { echo "$UNIT has no main process" >&2; exit 1; }
kill -TERM "$old"
for i in $(seq 1 60); do
  sleep 1
  new=$(systemctl show -p MainPID --value "$UNIT")
  if [ "$new" != "$old" ] && [ "$new" != "0" ] && curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/login"; then
    echo "$UNIT restarted: pid $old -> $new after ${i}s"
    break
  fi
  [ "$i" -lt 60 ] || { echo "$UNIT did not come back in 60 s — check: journalctl -u $UNIT -n 50" >&2; exit 1; }
done

# Reload the desktop page (the one at "/") so it runs the new build.
node - "$CDP_PORT" <<'JS' || echo "no kiosk desktop page to reload (fine without one)"
const port = process.argv[2];
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const desk = targets.find((t) => t.type === "page" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/$/.test(t.url));
if (!desk) process.exit(1);
const ws = new WebSocket(desk.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.send(JSON.stringify({ id: 1, method: "Page.reload", params: { ignoreCache: true } }));
await new Promise((r) => setTimeout(r, 500));
ws.close();
console.log("reloaded", desk.url);
JS
sleep 10
echo "ready — run the bench now"
