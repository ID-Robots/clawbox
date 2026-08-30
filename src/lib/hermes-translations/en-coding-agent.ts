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
  // The app's header, now that the switch lives in Settings: a read-only
  // chip saying what the route said, and the link to where it is changed.
  "codingAgent.stateOn": "On",
  "codingAgent.stateOff": "Off",
  "codingAgent.openSettings": "Settings",

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
  // The picker offers three levels, but a box that stored "medium" or "high"
  // before it narrowed still has to name what is in force.
  "codingAgent.effort.medium": "Medium",
  "codingAgent.effort.high": "High",
  "codingAgent.effort.xhigh": "Very high",
  "codingAgent.effort.max": "Max",
  "codingAgent.effortFailed": "Could not change the thinking effort.",
  // The ceilings a run stops at. Neither has a time or a price behind it.
  "codingAgent.turnsLabel": "Steps per run",
  "codingAgent.turnsFailed": "Could not change the step limit.",
  "codingAgent.tokensLabel": "Token limit (optional)",
  "codingAgent.tokensPlaceholder": "no limit",
  "codingAgent.tokensFailed": "Could not change the token limit.",
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
  "codingAgent.back": "Back",
  "codingAgent.createNewProject": "Create app",
  "codingAgent.projectRuns": "Runs",
  "codingAgent.otherRuns": "Other runs",
  "codingAgent.gitTitle": "Git repository",
  // Count-neutral on purpose: "1 commits" would be wrong and the catalogue
  // has no plural mechanism.
  "codingAgent.gitCommits": "Commits: {n}",
  "codingAgent.gitNoRemote": "Not on GitHub yet",
  "codingAgent.pause": "Pause",
  "codingAgent.resume": "Resume",
  "codingAgent.startDraft": "Start",
  "codingAgent.discardDraft": "Discard",
  "codingAgent.pauseFailed": "The run could not be paused.",
  "codingAgent.resumeFailed": "The run could not be resumed.",
  "codingAgent.startFailed": "The drafted run could not be started.",
  "codingAgent.discardFailed": "The draft could not be discarded.",
  "codingAgent.statusPaused": "Paused",
  "codingAgent.statusDraft": "Draft",
  "codingAgent.chatPaused": "Coding agent paused",
  "codingAgent.chatDraft": "Coding run drafted",
  // Follows "≈ 12 min" under a live run's progress bar.
  "codingAgent.timeLeft": "left",
  "codingAgent.openLive": "Watch live",
  "codingAgent.openResume": "Open in terminal",
  "codingAgent.showDetails": "Show details",
  "codingAgent.hideDetails": "Hide details",

  "codingAgent.loadFailed": "Could not read the coding agent settings.",
  "codingAgent.toggleFailed": "Could not change the coding agent setting.",
  "codingAgent.stopFailed": "Could not stop the run.",

  // The Projects section — every folder with a git history of its own in
  // the owner's project folder — and the New app wizard, which ends in the
  // mascot chat: the assistant scaffolds, delegates and verifies, and the
  // owner carries on there. `newHanded` is the last thing the card says.
  "codingAgent.projectsTitle": "Projects",
  "codingAgent.projectFolderUnset": "Choose a project folder in Settings, and every project with its own git history will be listed here.",
  "codingAgent.noProjects": "No projects yet. Tap New app, or ask your assistant to build something in {folder}.",
  "codingAgent.onDesktop": "on desktop",
  "codingAgent.runInProgress": "run in progress",
  "codingAgent.open": "Open",
  "codingAgent.copyFolder": "Copy the folder name",
  "codingAgent.copied": "Copied",
  "codingAgent.noCommits": "No commits yet",
  "codingAgent.newApp": "New app",
  "codingAgent.newTitle": "A new app for your desktop",
  "codingAgent.newNameLabel": "Name",
  "codingAgent.newNamePlaceholder": "Pomodoro timer",
  "codingAgent.newWhatLabel": "What should it do?",
  "codingAgent.newWhatPlaceholder": "A timer with 25-minute work blocks and 5-minute breaks, and a sound when each one ends.",
  "codingAgent.newTemplateLabel": "Start from",
  "codingAgent.newTemplateApp": "Starter app — HTML, CSS and JS files",
  "codingAgent.newTemplateBlank": "Blank page — one HTML file",
  "codingAgent.newTemplateNextjs": "Next.js full-stack app — pages, API routes, TypeScript (default)",
  "codingAgent.newTemplateReact": "React app — Vite, TypeScript",
  "codingAgent.newCreate": "Create",
  "codingAgent.newNameRequired": "Give the app a name.",
  "codingAgent.newNameTooLong": "The name can be at most {max} characters.",
  "codingAgent.newWhatRequired": "Say what the app should do.",
  "codingAgent.newWhatTooLong": "Keep the description to {max} characters.",
  "codingAgent.newHanded": "Handed to the assistant — continue in the chat.",
  // Shown on the standalone /app/coding page instead of the New button:
  // there is no chat there to hand the message to.
  "codingAgent.newNeedsDesktop": "A new app starts in the chat, which lives on the desktop. Open the Coding agent there to ask for one.",
  "codingAgent.codeProject": "code project",
};
