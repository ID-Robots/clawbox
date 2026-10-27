/**
 * Settings → System → Agent databases: OpenClaw's SQLite databases, the
 * nightly compaction and "Run now" (src/components/DbMaintenancePanel.tsx).
 *
 * Owner-facing words say "the assistant", not "the gateway", as the rest of
 * Settings does: what the owner notices is the assistant pausing. The
 * `outcome.*` keys are the `lastRun.outcome` values
 * scripts/openclaw-db-maintenance.py records, camelCased (`gateway_busy` is
 * `outcome.gatewayBusy`; the panel's OUTCOMES maps one to the other).
 */
export const dbMaintenanceEn: Record<string, string> = {
  "dbMaintenance.title": "Agent databases",
  "dbMaintenance.total": "{size} in {count} databases",
  "dbMaintenance.help":
    "OpenClaw keeps conversations, transcripts and its memory index in these SQLite databases. When one is holding space it no longer uses, maintenance compacts it with OpenClaw's own tool — only while the assistant is idle and only when there is enough free disk. The assistant is stopped for those minutes and starts again by itself.",
  "dbMaintenance.unsupported": "This OpenClaw version cannot compact its databases offline. Update ClawBox to get it.",
  "dbMaintenance.stateDb": "Shared state",
  "dbMaintenance.agentDb": "Agent {id}",
  "dbMaintenance.freePages": "{percent}% unused",
  "dbMaintenance.needsCompaction": "Needs compacting",

  "dbMaintenance.running": "Maintenance is running — {phase}",
  "dbMaintenance.phaseMeasuring": "checking the databases",
  "dbMaintenance.phaseWaiting": "waiting for the assistant to be idle",
  "dbMaintenance.phaseStopping": "pausing the assistant",
  "dbMaintenance.phaseCompacting": "compacting",
  "dbMaintenance.phaseRestarting": "starting the assistant again",
  "dbMaintenance.phaseRunning": "working",

  "dbMaintenance.lastRun": "Last run {when}: {result}",
  "dbMaintenance.outcome.compacted": "{before} → {after}, {reclaimed} reclaimed",
  "dbMaintenance.outcome.partial": "partly done, {before} → {after}",
  "dbMaintenance.outcome.failed": "failed — the databases were left as they were",
  "dbMaintenance.outcome.nothingToDo": "nothing needed compacting",
  "dbMaintenance.outcome.skipped": "skipped — not enough free disk space or time",
  "dbMaintenance.outcome.gatewayBusy": "skipped — the assistant was busy",
  "dbMaintenance.outcome.gatewayStarting": "skipped — the assistant was starting",
  "dbMaintenance.outcome.updateInProgress": "skipped — an update was running",
  "dbMaintenance.outcome.unsupportedCore": "skipped — this OpenClaw version cannot do it",
  "dbMaintenance.outcome.noDatabases": "no databases yet",
  "dbMaintenance.outcome.holdFailed": "failed — the assistant could not be paused",
  "dbMaintenance.outcome.stopFailed": "failed — the assistant did not stop",
  "dbMaintenance.outcome.dryRun": "checked only, nothing changed",
  "dbMaintenance.gatewayDown": "The assistant did not start again after the last run. Restart it from the OpenClaw app.",

  "dbMaintenance.scheduleLabel": "Nightly maintenance",
  "dbMaintenance.time": "Time",
  "dbMaintenance.nextRun": "Next check: {when}",
  "dbMaintenance.scheduleHelp": "Every night at this time ClawBox checks the databases and compacts only the ones that need it.",
  "dbMaintenance.runNow": "Run now",
  "dbMaintenance.started": "Maintenance started. If a database needs compacting, chats pause until the assistant is back.",
  "dbMaintenance.alreadyRunning": "Maintenance is already running.",
  "dbMaintenance.updateRunning": "An update is running. Try again when it has finished.",
  "dbMaintenance.startFailed": "Could not start maintenance.",
  "dbMaintenance.saveFailed": "Could not save the schedule.",
};
