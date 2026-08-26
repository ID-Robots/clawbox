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

  // Shown in the chat while a delegated run is actually in flight — the tool
  // pill for `coding_agent_run` is long gone by then.
  "codingAgent.chatWorking": "Coding agent working",
  "codingAgent.chatWorkingOwner": "Your coding run is working",
  "codingAgent.chatFinished": "Coding agent finished",
  "codingAgent.chatFailed": "Coding agent did not finish",
  "codingAgent.chatStopped": "Coding agent stopped",
  "codingAgent.chatOpenApp": "open",

  // The desktop card a finished run raises, top-right with the others.
  "codingAgent.noticeOpen": "Open the coding agent",
  "codingAgent.noticeDismiss": "Dismiss",

  "codingAgent.switchLabel": "Let the assistant delegate coding work",
  "codingAgent.switchHelp":
    "When on, your assistant can hand a coding task to Claude Code, which works in the background inside a project folder on your ClawBox AI plan and reports back. Off by default.",

  "codingAgent.readiness": "What a run needs",
  "codingAgent.readyLine": "Claude Code, claude-ds and ClawBox AI are all ready.",

  "codingAgent.folderLabel": "Default project folder",
  "codingAgent.folderPlaceholder": "/home/clawbox/Projects",
  "codingAgent.folderHelp":
    "Where a run works when your assistant does not name a code project. Must be a folder inside the ClawBox home — not the ClawBox OS folder itself, and not one holding credentials. Leave empty to require a project every time.",
  "codingAgent.folderSave": "Save",
  "codingAgent.folderFailed": "Could not save the default folder.",
  "codingAgent.claudeCode": "Claude Code",
  "codingAgent.wrapper": "claude-ds",
  "codingAgent.clawai": "ClawBox AI",
  "codingAgent.installed": "installed",
  "codingAgent.connected": "connected",
  "codingAgent.missing": "missing",
  "codingAgent.notConnected": "not connected",

  // Real Claude Code settings: --effort, and whether the Task tool is in
  // --tools at all. There is no "ultracode" setting in the CLI, so the app
  // does not pretend there is one.
  "codingAgent.effortLabel": "Thinking effort",
  "codingAgent.effortHelp":
    "How hard the coding agent thinks on each step. Higher is more thorough but slower and costs more. Max is the default, because a delegated run works unattended.",
  "codingAgent.effort.low": "Low",
  "codingAgent.effort.medium": "Medium",
  "codingAgent.effort.high": "High",
  "codingAgent.effort.xhigh": "Very high",
  "codingAgent.effort.max": "Max",
  "codingAgent.effortFailed": "Could not change the thinking effort.",

  "codingAgent.subagentsLabel": "Let a run use sub-agents",
  "codingAgent.subagentsHelp":
    "A run can split wide work across helper agents that search or edit in parallel. Each one is a whole extra conversation, so this costs more and uses more memory. Off by default; worth it for work spanning many files.",
  "codingAgent.subagentsFailed": "Could not change the sub-agent setting.",
  "codingAgent.thinking": "thinking · {n} tokens",
  "codingAgent.subagentsActive": "{n} sub-agents working",
  "codingAgent.subagentsUsed": "{n} sub-agents",

  "codingAgent.turnsLabel": "Steps per run",
  "codingAgent.turnsFailed": "Could not change the step limit.",
  "codingAgent.tokensLabel": "Token limit (optional)",
  "codingAgent.tokensPlaceholder": "no limit",
  "codingAgent.tokensFailed": "Could not change the token limit.",
  "codingAgent.limitsHelp":
    "A run ends when it finishes, runs out of steps, or reaches the token limit if you set one. There is no time limit and no cost limit — a long project may work for hours, and only stops on its own if it goes quiet for a long stretch.",
  "codingAgent.recentRuns": "Recent runs",
  "codingAgent.clearRuns": "Clear history",
  "codingAgent.clearConfirm": "Clear — tap again",
  "codingAgent.clearFailed": "Could not clear the run history.",
  "codingAgent.noRuns": "No runs yet. Ask your assistant to build or change something in a code project.",
  "codingAgent.statusRunning": "Running",
  "codingAgent.statusCompleted": "Finished",
  "codingAgent.statusFailed": "Did not finish",
  "codingAgent.statusStopped": "Stopped",
  "codingAgent.startedByAgent": "started by the assistant",
  "codingAgent.startedByOwner": "started by you",
  "codingAgent.runMeta": "{turns} turns · {files} files changed · {duration}",
  "codingAgent.denials": "{n} actions were not allowed",
  "codingAgent.deniedTitle": "Not allowed",
  "codingAgent.deniedHelp":
    "The coding agent may only run a fixed set of commands inside its own folder. This is the safety limit working, not a fault — the run usually finds another way.",
  "codingAgent.stop": "Stop",
  "codingAgent.openLive": "Watch live",
  "codingAgent.openResume": "Open in terminal",
  "codingAgent.showDetails": "Show details",
  "codingAgent.hideDetails": "Hide details",

  "codingAgent.loadFailed": "Could not read the coding agent settings.",
  "codingAgent.toggleFailed": "Could not change the coding agent setting.",
  "codingAgent.stopFailed": "Could not stop the run.",
};
