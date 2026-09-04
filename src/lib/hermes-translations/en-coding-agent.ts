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
  // --tools at all. "Ultracode" is the CLI's own name for its xhigh-plus-
  // workflow-orchestration mode (`--effort ultracode` since 2.1.x), kept as
  // is so the label matches what the terminal says.
  "codingAgent.effortLabel": "Effort",
  "codingAgent.effort.low": "Low",
  // The picker offers four levels, but a box that stored "medium" or "high"
  // before it narrowed still has to name what is in force.
  "codingAgent.effort.medium": "Medium",
  "codingAgent.effort.high": "High",
  "codingAgent.effort.xhigh": "Very high",
  "codingAgent.effort.max": "Max",
  "codingAgent.effort.ultracode": "Ultracode",
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
  "codingAgent.clearRunsHint": "Removes finished runs and their evidence folders from the list. Runs that are live, paused or drafted are kept — they still hold a session you can resume.",
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
  "codingAgent.harnessTestTitle": "Test harness",
  "codingAgent.harnessTestHint": "Starts one small, real run in a scratch project to prove the delegated shell works end to end: Claude Code launches, writes a file, drives the browser and reports back. It costs a run like any other, and it needs the agent switched on and ready.",
  "codingAgent.harnessTestFailed": "Could not start the harness test",
  // The test runs in a folder inside the owner's project folder, so it has
  // nowhere to go until one is chosen (src/lib/coding-agent-harness-test.ts).
  "codingAgent.harnessTestNoFolder": "Choose a project folder first.",
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
  "codingAgent.noticeOpenRun": "Open the run",
  "codingAgent.liveView": "View",
  "codingAgent.livePreviewTitle": "Live terminal",
  "codingAgent.livePreviewOpenApp": "Open in Terminal",
  "codingAgent.fullTask": "Show the whole task",
  "codingAgent.startedAgo": "started {when}",
  "codingAgent.copyId": "Copy the run id",
  "codingAgent.openReport": "Report",
  "codingAgent.statSteps": "Steps",
  "codingAgent.statFiles": "Files changed",
  "codingAgent.statDuration": "Duration",
  "codingAgent.statTokens": "Tokens",
  "codingAgent.statHelpers": "Helpers",
  "codingAgent.statCommit": "Commit",
  "codingAgent.statModels": "Models",
  "codingAgent.helpersTitle": "Helpers at work",
  "codingAgent.planTitle": "Plan",
  "codingAgent.errorTitle": "What went wrong",
  "codingAgent.summaryTitle": "Summary",
  "codingAgent.noSummaryYet": "No summary yet — the run is still working.",
  "codingAgent.noSummary": "This run left no summary.",
  "codingAgent.filesTitle": "Files changed",
  "codingAgent.activityTitle": "Activity",

  "codingAgent.loadFailed": "Could not read the coding agent settings.",
  "codingAgent.toggleFailed": "Could not change the coding agent setting.",
  "codingAgent.stopFailed": "Could not stop the run.",

  // The Projects section — every folder with a git history of its own in
  // the owner's project folder — and the New app wizard, which ends in the
  // mascot chat: the assistant scaffolds, delegates and verifies, and the
  // owner carries on there. `newHanded` is the last thing the card says.
  "codingAgent.projectsTitle": "Projects",
  "codingAgent.navHome": "Home",
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
  "codingAgent.newNamePlaceholder": "Invoice generator",
  "codingAgent.newWhatLabel": "What should it do?",
  "codingAgent.newWhatPlaceholder": "Create invoices from a customer list with line items and tax, keep them in a list, and export each one as a PDF I can email.",
  "codingAgent.newModeNew": "New app",
  "codingAgent.newModeExisting": "Existing project",
  "codingAgent.newProjectLabel": "Project",
  "codingAgent.newProjectsLoading": "Reading your projects…",
  "codingAgent.newNoProjects": "No projects yet — create a new app first.",
  "codingAgent.newNextLabel": "What should the next run do?",
  "codingAgent.newNextPlaceholder": "Add a search box to the customer list and fix the total on the invoice.",
  "codingAgent.newExistingHint": "The assistant starts a run in that folder, reads its last run and commits first, and tells you what is left afterwards. Follow it in the Coding Agent app.",
  "codingAgent.newContinue": "Continue",
  "codingAgent.newProjectRequired": "Pick a project.",
  "codingAgent.newLastRun": "Last run: {task}",
  "codingAgent.newKindCodeProject": "desktop app",
  "codingAgent.newKindFolder": "git folder",
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

  // The automatic review pass: the owner's switch in the settings card, its
  // one-sentence cost, and the chips that tie a review run to the run it
  // reviewed — the fixed review task reads like any other run otherwise.
  "codingAgent.reviewPassLabel": "Review each finished run",
  "codingAgent.reviewPassHint": "After a run that changed files finishes, one more run in the same session hunts for defects and fixes what it confirms. It costs a second, smaller run and takes the run slot while it works; never after Stop or Pause.",
  "codingAgent.reviewPassFailed": "Could not change the review pass setting.",
  "codingAgent.autoPrLabel": "Open a pull request and merge it when checks pass",
  "codingAgent.autoPrHint": "Each run works on its own branch, opens a pull request into the project's default branch, and waits for GitHub Actions. It merges only when at least one check actually ran and every one passed — a pull request with no checks is never merged. Needs a GitHub remote.",
  "codingAgent.autoPrFailed": "Could not change the pull-request setting.",

  // What a run may SPEND on the project it builds. Both switches are on unless
  // the owner turns them off, and each hint names its own cost — the pictures
  // come out of the ClawBox AI daily allowance, the voice out of the one
  // synthesis slot the chat shares.
  "codingAgent.genImagesLabel": "Let runs draw pictures",
  "codingAgent.genImagesHint": "A run can ask this box to draw artwork for the project it is building, and the box draws the project's desktop icon, favicon.png and favicon.ico by itself shortly after a run starts. Each picture comes out of your ClawBox AI daily allowance; a run gets at most twenty.",
  "codingAgent.genImagesFailed": "Could not change the picture setting.",
  "codingAgent.genAudioLabel": "Let runs record speech",
  "codingAgent.genAudioHint": "A run can have this box speak a line and save it as a sound file in the project — narration, a greeting, a spoken cue. It uses the same voice as your spoken replies and waits its turn behind them; a run gets at most forty clips.",
  "codingAgent.genAudioFailed": "Could not change the speech setting.",

  // A run that finished on its own keeps whatever it started — the way an app
  // that serves itself on a port is meant to work — so the page says so and
  // offers to end it, rather than the device killing it unasked.
  "codingAgent.leftoverRunning": "Something this run started is still running.",
  "codingAgent.killLeftover": "End it",
  "codingAgent.killLeftoverFailed": "Could not end what the run left running.",
  "codingAgent.prOpening": "Opening PR",
  "codingAgent.prWaiting": "Checks {done}/{total}",
  "codingAgent.prMerged": "Merged",
  "codingAgent.prBlocked": "Needs you",
  "codingAgent.reviewOf": "review of {id}",
  "codingAgent.reviewedBy": "reviewed by {id}",
  "codingAgent.reviewPassTitle": "Automatic review pass of {id}",

  // ── First-run setup wizard ────────────────────────────────────────────────
  //
  // Switching the coding agent on is consent for a delegated shell, so the
  // wizard says what it is before it asks for anything, then collects the two
  // settings a run actually needs: the account it pushes with, and the folder
  // it works in. Settings keeps every one of these controls — this is an
  // onboarding path, not the only way in.
  "codingAgent.wizardTitle": "Set up the coding agent",
  "codingAgent.wizardIntro": "The coding agent lets your assistant hand a whole task to Claude Code running on this box: it reads and writes files in one folder, runs commands there, and reports back. Setting it up takes three steps.",
  "codingAgent.wizardEnable": "Enable",
  "codingAgent.wizardStepOf": "Step {n} of {total}",
  "codingAgent.wizardNext": "Next",
  "codingAgent.wizardBack": "Back",
  "codingAgent.wizardSkip": "Skip for now",
  "codingAgent.wizardFinish": "Finish setup",
  "codingAgent.wizardFinishing": "Saving…",
  "codingAgent.wizardFinishFailed": "Could not save the setup.",

  "codingAgent.wizardGithubTitle": "Connect GitHub",
  "codingAgent.wizardGithubHint": "A run pushes its work to GitHub with this account. You can skip this and connect later in Settings — a run still works without it, it just has nowhere to push.",
  "codingAgent.wizardGithubConnect": "Sign in with GitHub",
  "codingAgent.wizardGithubConnected": "GitHub connected",

  "codingAgent.wizardProjectTitle": "Project folder and effort",
  "codingAgent.wizardProjectHint": "The folder a run works in when the assistant names no project. Browse to pick one, or type an absolute path.",
  "codingAgent.wizardBrowse": "Browse",
  "codingAgent.wizardBrowseFailed": "Could not read that folder.",
  "codingAgent.wizardPickerUp": "Up one folder",
  "codingAgent.wizardPickerUse": "Use this folder",
  "codingAgent.wizardPickerClose": "Close",
  "codingAgent.wizardPickerEmpty": "No folders here.",
  "codingAgent.wizardCreateFolder": "Create folder",
  "codingAgent.wizardCreateFolderPlaceholder": "New folder name",
  "codingAgent.wizardCreateFolderSave": "Create",
  "codingAgent.wizardCreateFolderFailed": "Could not create the folder.",
  // Said plainly and up front: Ultracode is the best answer this box can give
  // and the most expensive one, and an owner who finds that out from a bill
  // was told too late.
  "codingAgent.wizardEffortCost": "Ultracode gives the best results and consumes a lot of tokens — it thinks longer and can run several agents for one task. A Business plan is recommended if you use it often. Lower effort costs less and finishes sooner.",
  "codingAgent.wizardHarnessTitle": "Try it once",
  "codingAgent.wizardHarnessHint": "Run a small, real task in a scratch project to prove the whole chain works: Claude Code starts, writes a file, drives the browser and reports back. It costs one run. You can skip this and start it any time from the Test harness card in Settings.",
  "codingAgent.wizardHarnessRun": "Run the test",
  "codingAgent.wizardHarnessStarting": "Starting…",
  "codingAgent.wizardHarnessSkip": "Skip and finish",

  // ── Reset ─────────────────────────────────────────────────────────────────
  "codingAgent.resetTitle": "Start over",
  "codingAgent.resetHint": "Switches the coding agent off and clears the folder, effort and ceilings, then runs the setup wizard again. Your GitHub sign-in and your run history are kept.",
  "codingAgent.resetButton": "Reset",
  "codingAgent.artCoder": "Coder",
  "codingAgent.artReviewer": "Reviewer",
  "codingAgent.artBrowser": "Browser",
  "codingAgent.resetConfirm": "Reset everything — tap again",
  "codingAgent.resetFailed": "Could not reset the coding agent.",
};
