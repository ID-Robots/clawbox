# Scheduled-job alerts

TASK-2179. Customer feedback from a heavy user (16 agents, 26 scheduled jobs): *"If a scheduled job dies quietly, nothing raises an alarm."* This note is the design. The code is `src/lib/job-alerts.ts` (the watcher), `src/lib/job-alerts-sources.ts` (what each harness says about its jobs), `src/lib/job-alerts-scheduler.ts` (the timer), `src/app/setup-api/job-alerts/route.ts` and `src/components/JobAlertsPanel.tsx`.

## Where the run state lives

Both harnesses already keep a record of every job's last run. The watcher reads that record and keeps no run history of its own.

| | Store | How ClawBox reads it | Fields used |
|---|---|---|---|
| **OpenClaw** (2026.10.x) | jobs and run history in the shared SQLite state database (`state/openclaw.sqlite`). OpenClaw's docs say to reach it through the CLI or the Gateway API, never the file. | Gateway RPC `cron.list` `{includeDisabled: true, limit: 200, offset}` over the loopback WebSocket (`openclaw-gateway-ws.ts`, about 20 ms; `openclaw cron list --json` costs about 2 s of CLI start-up on a Jetson). Paged with `nextOffset`. | `state.lastRunStatus` (`ok`/`error`/`skipped`), `consecutiveErrors`, `consecutiveSkipped`, `nextRunAtMs`, `runningAtMs`, `autoDisabled`, `lastError`; `schedule.kind`, `payload.kind`, `enabled` |
| **Hermes** (cron in `cron/jobs.py`) | `<HERMES_HOME>/cron/jobs.json`, and one per profile at `<HERMES_HOME>/profiles/<name>/cron/jobs.json`. The ticker runs inside the Hermes gateway (`hermes-gateway.service`). | The JSON files, read directly. That works even when the gateway is down, which is exactly when jobs stop firing. Profile jobs get an id like `coder/daily-brief`. | `last_status` (`ok`/`error`/`delivery_failed`), `failure_streak`, `last_error`, `last_run_at`, `next_run_at`, `fire_claim` (a run in progress), `state` (`scheduled`/`paused`/`completed`/`error`), `enabled`, `schedule.kind` |

Only the **active** harness (`getActiveHarness()`) is watched. After a harness swap, the old harness's open incidents are dropped without a message.

**Not watched:**
- OpenClaw's heartbeat (`payload.kind: "heartbeat"`). Skipping is part of how it works ("no-route", quiet hours, an empty HEARTBEAT.md), and Settings → Working on its own is where it is switched on or off.
- Jobs the owner paused or disabled.
- Finished one-shot jobs.

## What counts as a failure

Each job gets at most one problem. When several apply, the earlier one in this list wins:

1. **stopped**: the scheduler switched the job off by itself. On OpenClaw that is `autoDisabled`, after 10 failures in a row. On Hermes it is `state: error`: a recurring job whose next run could not be computed.
2. **failing**: the last run errored (a non-zero exit, a timeout, a model error). The rule depends on when the next try is:
   - next try more than an hour away (or no next try): alert on the **first** failure, so a daily job is not left broken for a day;
   - next try within the hour: alert on the **second failure in a row**, which filters out one-off glitches.

   A skipped run after failures does not clear the failure streak. OpenClaw counts skips and errors separately.
3. **skipping** (blocked): skipped **3 times in a row**, for example a local model provider that is down, or a run still busy from last time. One skip is often by design.
4. **overdue**: a job on a clock (`at`/`every`/`cron`, or Hermes `once`/`interval`/`cron`) is more than **15 minutes** past its `nextRunAt` and is not running. This catches a ticker that died, a gateway that is down, or a Hermes box whose gateway was never installed (Hermes cron only fires inside `hermes gateway`).

   When the scheduler cannot be read at all (the OpenClaw gateway is down, or `jobs.json` is half-written), its jobs are judged against the due times it last reported, and **no incident is closed**: the scheduler being unreadable doesn't mean anything has recovered.

A run that worked but whose output did not reach the delivery target (Hermes `delivery_failed`, OpenClaw `completionStatus: failed`) is **not** a failed job here. Both harnesses report delivery failures themselves.

## Noise control

- **One notice per job per incident**: a notice when the job goes from fine to a problem, and one more when it runs normally again. The recovery notice is sent only if the failure notice was. A change in the kind of problem (overdue, then failing) belongs to the same incident.
- **Cooldown of 6 hours per job**: a job that goes bad again within 6 h of its last alert shows up in Settings but is not pushed. If it is still bad when the cooldown ends, it is pushed then, so a job that "recovered" and broke again doesn't look healthy forever. A job flapping every 5 minutes costs 2 messages per 6 hours.
- **Batching**: every change found in one check is one message ("3 scheduled jobs need attention: “A”, “B”, “C” +2"), so a gateway dying under 26 jobs sends one alert, not 26.
- **Restart-safe**: incidents are kept in `data/job-alerts.json`, written **before** anything is sent. A crash during a send can lose that notice but never repeat it. A check already in flight is joined, never doubled.
- **Quiet hours and a daily digest: out of scope.** With the rules above an incident costs at most two messages. Quiet hours would hold back exactly the alert this feature exists to send, and Telegram has its own mute.

## How the owner is told

Both paths below already exist on every box:

- **Desktop**: the owner-notice ring (`pending-actions.ts` via `notifyOwner`, the same path the `ui_notify` MCP tool uses), shown as a toast with **Open Settings → Harness** (a new allowlisted notice destination, `OPEN_HARNESS_SETTINGS`). The ring keeps a notice for 60 s, so a desktop that was closed misses it. That is why the Settings card keeps the list.
- **Telegram**, when a bot is connected: the coding agent's fan-out, moved to `src/lib/owner-telegram.ts` so both features share it. On Hermes it uses `hermes send` to the approved users. On OpenClaw it uses the Bot API with the harness's own token, to `allowFrom`. Without a bot it logs `[job-alerts] no Telegram bot is configured on this device; notice not sent`.
- **Wording**: the text comes from a fixed template in the box's language (`jobAlerts.notice.*`, all 10 locales, read on the server from the generated locale chunk). It contains the job's name (cleaned to one line of at most 60 characters, with control and bidi characters removed) and a count. **It never contains the scheduler's error text**, which can quote command output or provider bodies. That text appears only in the owner-only Settings card.
- **Settings → Harness → Scheduled job alerts** (`JobAlertsPanel.tsx`): the switch (**on by default**), "Watching N scheduled jobs — all ran as expected", or the list of jobs in trouble with their problem, since when, and the scheduler's last error. `GET|POST /setup-api/job-alerts` is owner only (403 `owner_only` otherwise). A GET checks again when the last check is older than 30 s.
- **The switch** is the preference `pref:ui_job_alerts`, also writable with `preferences_set`. The operator's environment variable `CLAWBOX_JOB_ALERTS=off` overrides it. A value that cannot be read counts as on.

## Watcher

An in-process timer armed by the boot hook (`src/instrumentation.ts`), like the memory-index and database-maintenance schedules: a first check 90 s after start, then one every 2 minutes. A check is one loopback WebSocket call on OpenClaw, or one small file read per profile on Hermes. The heartbeat's `config/` systemd timer pattern was considered and not chosen. Its unit would only `curl` back into this same web server, which is where the notice ring and the Telegram send live, and a new system unit means a root install step for no extra reliability: if the web server is down, nothing could deliver the alert anyway.

## Out of scope (MVP)

- Watching both harnesses at once on an unlocked dual box. Only the active one is watched.
- Telegram de-duplication against the harness's own failure alerts. An OpenClaw job with an announce route gets OpenClaw's alert after 2 failures; a Hermes job delivering to Telegram gets Hermes' failure notice. Such a job can be reported twice.
- Discord, email or other channels. Per-job mute. Quiet hours and digest (see above).
- System crontab entries, systemd timers and ClawBox's own schedules (Prime Radiant nightly, database maintenance, ClawKeep). These are not the assistant's scheduled jobs and have their own status in their own panels.
- An MCP tool for the assistant to read the alert state. It can already list its own jobs with the harness's cron tools.
