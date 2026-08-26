/**
 * The Coding Agent app: the owner's switch for letting the assistant delegate
 * coding work to a headless Claude Code run, what a run needs, and the recent
 * runs.
 *
 * `terminalHint` exists because this icon used to open a terminal already
 * running the harness. An owner who relied on that should be told where it
 * went, once, at the top of the window that replaced it.
 */
export const codingAgentEn: Record<string, string> = {
  "codingAgent.title": "Coding agent",
  "codingAgent.terminalHint":
    "Your assistant's delegated coding runs. For a hands-on session, open the Terminal app and run claude-ds.",

  "codingAgent.switchLabel": "Let the assistant delegate coding work",
  "codingAgent.switchHelp":
    "When on, your assistant can hand a coding task to Claude Code, which works in the background inside a project folder on your ClawBox AI plan and reports back. Off by default.",

  "codingAgent.readiness": "What a run needs",
  "codingAgent.claudeCode": "Claude Code",
  "codingAgent.wrapper": "claude-ds",
  "codingAgent.clawai": "ClawBox AI",
  "codingAgent.installed": "installed",
  "codingAgent.connected": "connected",
  "codingAgent.missing": "missing",
  "codingAgent.notConnected": "not connected",

  "codingAgent.recentRuns": "Recent runs",
  "codingAgent.noRuns": "No runs yet. Ask your assistant to build or change something in a code project.",
  "codingAgent.statusRunning": "Running",
  "codingAgent.statusCompleted": "Finished",
  "codingAgent.statusFailed": "Did not finish",
  "codingAgent.statusStopped": "Stopped",
  "codingAgent.startedByAgent": "started by the assistant",
  "codingAgent.startedByOwner": "started by you",
  "codingAgent.runMeta": "{turns} turns · {files} files changed · {duration}",
  "codingAgent.denials": "{n} actions were not allowed",
  "codingAgent.stop": "Stop",
  "codingAgent.showDetails": "Show details",
  "codingAgent.hideDetails": "Hide details",

  "codingAgent.loadFailed": "Could not read the coding agent settings.",
  "codingAgent.toggleFailed": "Could not change the coding agent setting.",
  "codingAgent.stopFailed": "Could not stop the run.",
};
