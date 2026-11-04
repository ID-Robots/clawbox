# OpenClaw: gateway reports live but every session call fails with "SQLite session reclamation commit checkpoint expired" until restarted

A report for upstream OpenClaw, written from one field occurrence on a ClawBox
device. ClawBox's own workaround is described at the end.

## Versions

- OpenClaw core: upgraded **2026.8.1 → 2026.10.9** as part of a ClawBox update.
- The gateway runs as a systemd service on the device, reached by the ClawBox
  web server and the chat UI over its loopback WebSocket.

## Symptom

After the upgrade, the gateway came up and looked healthy, but the chat was dead
for about 22 minutes, until the gateway was restarted by hand.

1. The **old** gateway (2026.8.1) did not stop cleanly when the update stopped
   it: its journal says `Gateway shutdown did not complete cleanly` and the
   process exited with status 1.
2. The **new** gateway (2026.10.9) started and answered
   `GET /healthz` with `{"ok":true,"status":"live"}`.
3. A session reclamation worker (session canonical validation over a large
   per-agent SQLite database) ran for **33.9 s** and was then rejected.
4. From then on, **every session-level RPC failed** with the same error:

   ```
   errorCode=UNAVAILABLE  "SQLite session reclamation commit checkpoint expired"
   ```

   This was seen on `chat.history`, `sessions.messages.subscribe`,
   `sessions.patch`, `models.list` and `agent`.
5. It **never recovered by itself**. Every session call failed the same way
   for the roughly 22 minutes before the manual restart.
6. One `systemctl restart` of the gateway fixed it **at once**: session calls
   worked again right after.

## Expected

Any one of these would have avoided the outage:

- A rejected or expired reclamation checkpoint is retried, or the worker starts
  over, instead of leaving the session store unavailable for the rest of the
  process's life.
- While the session store cannot serve, the gateway's health surface says so
  (`/healthz` or `/readyz` not `live`/ready), so a supervisor or an updater can
  tell this state apart from a working gateway and restart it.
- `UNAVAILABLE` from a session RPC is a transient state that clears without a
  process restart.

## Notes for reproducing

Seen once so far. What came before it, in order:

- a core upgrade (2026.8.1 → 2026.10.9);
- the old process exiting with status 1 during shutdown;
- a reclamation pass over a large agent database that ran 33.9 s and was
  rejected.

We have not shown which of these is the cause. A plain process restart was
enough to clear it. That suggests state held inside the process (for example a
checkpoint that expired and was never renewed) rather than damage on disk.

## Workaround (ClawBox)

Restart the gateway: `sudo systemctl restart clawbox-gateway.service`.

ClawBox's updater now checks this itself. After an update, "Verifying gateway
health" no longer trusts the open port and `/healthz` alone:

- It makes one `chat.history` call on the main session over the gateway's RPC.
- If that call answers `UNAVAILABLE`, or names the session reclamation
  checkpoint, it restarts the gateway once and asks again.
- If the call still fails after that restart, the update fails with a message
  for the owner instead of reporting success.

The old gateway exiting non-zero when the update stops it is also shown as a
warning on the update result.
