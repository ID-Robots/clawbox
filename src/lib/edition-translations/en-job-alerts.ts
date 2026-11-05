/**
 * Scheduled-job alerts (src/lib/job-alerts.ts): the Settings → Harness card
 * (src/components/JobAlertsPanel.tsx) and the notice itself.
 *
 * The `jobAlerts.notice.*` keys are read on the SERVER, in the box's language
 * (`pref:ui_language`), for the desktop notice and the Telegram message — the
 * one place a server template is worded from this catalogue, so a German box
 * is not alerted in English. `{name}` is the job's own name, cleaned to one
 * line (job-alerts-sources.ts `cleanJobName`); the scheduler's error text never
 * reaches a notice, only the Settings card.
 */
export const jobAlertsEn: Record<string, string> = {
  "jobAlerts.title": "Scheduled job alerts",
  "jobAlerts.helper":
    "Tells you when a scheduled job or automation fails, keeps being skipped or does not run when it is due — on this desktop and on Telegram when a bot is connected. Once per problem, and once more when the job runs normally again.",
  "jobAlerts.switch": "Alert me about scheduled jobs",
  "jobAlerts.off": "Alerts are off: nothing is checked.",
  "jobAlerts.offByEnv": "Switched off on this device by its operator (CLAWBOX_JOB_ALERTS).",
  "jobAlerts.saveFailed": "The setting could not be saved. Try again.",
  "jobAlerts.notChecked": "Not checked yet.",
  "jobAlerts.none": "No scheduled jobs on this box yet.",
  "jobAlerts.allGood": "Watching {count} scheduled jobs — all ran as expected.",
  "jobAlerts.allGoodOne": "Watching 1 scheduled job — it ran as expected.",
  "jobAlerts.unreachable": "The scheduler is not answering right now. What it said last is shown.",
  "jobAlerts.checked": "Checked at {time}",
  "jobAlerts.since": "since {time}",
  "jobAlerts.problem.failing": "Failed {count} times in a row",
  "jobAlerts.problem.failedOnce": "Failed",
  "jobAlerts.problem.skipping": "Skipped {count} times in a row",
  "jobAlerts.problem.overdue": "Did not run when it was due",
  "jobAlerts.problem.stopped": "Failed, now switched off",

  "jobAlerts.notice.failedOnce": "Scheduled job “{name}” failed.",
  "jobAlerts.notice.failing": "Scheduled job “{name}” failed {count} times in a row.",
  "jobAlerts.notice.skipping": "Scheduled job “{name}” was skipped {count} times in a row.",
  "jobAlerts.notice.overdue": "Scheduled job “{name}” did not run when it was due.",
  "jobAlerts.notice.stopped": "Scheduled job “{name}” failed and is now switched off.",
  "jobAlerts.notice.many": "{count} scheduled jobs need attention: {names}.",
  "jobAlerts.notice.recovered": "Scheduled job “{name}” is running normally again.",
  "jobAlerts.notice.recoveredMany": "{count} scheduled jobs are running normally again: {names}.",
  "jobAlerts.notice.where": "Details: Settings → {section}.",
};
