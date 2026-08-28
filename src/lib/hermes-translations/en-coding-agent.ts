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

  // Shown in the chat while a delegated run is actually in flight — the tool
  // pill for `coding_agent_run` is long gone by then.
  "codingAgent.chatWorking": "Coding agent working",
  "codingAgent.chatWorkingOwner": "Your coding run is working",
  "codingAgent.chatFinished": "Coding agent finished",
  "codingAgent.chatFailed": "Coding agent did not finish",
  "codingAgent.chatStopped": "Coding agent stopped",
  "codingAgent.chatOpenApp": "open",
  // A template the chat's run card fills in — "{n} agents" — shown when a
  // delegated run fans out to sub-agents.
  "codingAgent.chatAgents": "{n} agents",
  // The chat card's live-work panel: what one progress line means, in the
  // owner's words rather than the harness's ("Screenshot", never
  // "mcp__clawbox__browser_screenshot" — see src/lib/coding-agent-progress.ts),
  // and the counted words after a number: "3 files touched", "12 turns".
  "codingAgent.chatLiveWork": "Live work",
  "codingAgent.chatScreenshot": "Screenshot",
  "codingAgent.chatLookingAtPage": "Looking at the page",
  "codingAgent.chatOpeningPage": "Opening a page",
  "codingAgent.chatDrivingPage": "Driving the page",
  "codingAgent.chatClosingPage": "Closing the page",
  "codingAgent.chatWrite": "Writing",
  "codingAgent.chatEdit": "Editing",
  "codingAgent.chatRead": "Reading",
  "codingAgent.chatFilesTouched": "files touched",
  "codingAgent.chatTurns": "turns",
  // The run's own plan (its TodoWrite list) on the card: the checklist's
  // heading, the counted word after "3 of 7", the line that names the item
  // it is on now, the overflow of a long list, and the word beside the
  // three moving dots that say a live run is still working.
  "codingAgent.chatPlan": "Plan",
  "codingAgent.chatDone": "done",
  "codingAgent.chatNow": "Now",
  "codingAgent.chatMore": "+{n} more",
  "codingAgent.chatBusy": "working",

  // The desktop card a finished run raises, top-right with the others.
  "codingAgent.noticeOpen": "Open the coding agent",
  "codingAgent.noticeDismiss": "Dismiss",

  "codingAgent.switchLabel": "Let the assistant delegate coding work",

  "codingAgent.folderLabel": "Project folder",
  "codingAgent.folderPlaceholder": "/home/clawbox/Projects",
  "codingAgent.folderSave": "Save",
  "codingAgent.folderFailed": "Could not save the default folder.",
  "codingAgent.claudeCode": "Claude Code",
  "codingAgent.wrapper": "claude-ds",
  "codingAgent.clawai": "ClawBox AI",
  "codingAgent.missing": "missing",
  "codingAgent.notConnected": "not connected",

  // Real Claude Code settings: --effort, and whether the Task tool is in
  // --tools at all. There is no "ultracode" setting in the CLI, so the app
  // does not pretend there is one.
  "codingAgent.effortLabel": "Effort",
  "codingAgent.effort.low": "Low",
  "codingAgent.effort.xhigh": "Very high",
  "codingAgent.effort.max": "Max",
  "codingAgent.effortFailed": "Could not change the thinking effort.",
  "codingAgent.thinking": "thinking · {n} tokens",
  "codingAgent.tokensWord": "tokens",
  "codingAgent.updated": "updated",
  "codingAgent.githubOff": "not connected",
  "codingAgent.githubUnreachable": "GitHub unreachable",
  "codingAgent.githubNotRunnable": "gh installed but will not start — check its permissions",
  "codingAgent.githubConnect": "Connect",
  "codingAgent.githubReconnect": "Change",
  "codingAgent.githubOut": "Sign out",
  "codingAgent.githubOutConfirm": "Sign out — tap again",
  "codingAgent.githubOutFailed": "Could not disconnect GitHub.",
  "codingAgent.backup": "Back up",
  "codingAgent.backupBusy": "Backing up…",
  "codingAgent.backupDone": "Backed up to {repo}",
  "codingAgent.backupFailed": "Could not back up to GitHub.",
  "codingAgent.recentRuns": "Recent runs",
  "codingAgent.more": "Show more",
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
  "codingAgent.artifactsTitle": "Evidence from this run",
  // The report dialog: a run's report.md (or any .md it wrote) drawn as
  // markdown over the app. {name} is the artifact's file name.
  "codingAgent.reportLoading": "Loading {name}…",
  "codingAgent.reportFailed": "Could not load {name}.",
  "codingAgent.reportOpenText": "Open as text",
  "codingAgent.reportClose": "Close",
  "codingAgent.githubDeviceIntro": "Enter this code on github.com to connect your account:",
  "codingAgent.githubDeviceOpen": "Open github.com/login/device",
  "codingAgent.githubDeviceWaiting": "Waiting for the code to be entered…",
  "codingAgent.githubDeviceCancel": "Cancel",
  "codingAgent.githubDeviceTerminal": "Use the Terminal instead",
  "codingAgent.githubStartFailed": "Could not start the GitHub login",
  "codingAgent.harnessTest": "Test harness",
  "codingAgent.harnessTestFailed": "Could not start the harness test",
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
