/**
 * English copy for the desktop's "What's new in 4.4" card (TASK-1059, TASK-1195).
 *
 * The highlights are taken from RELEASE-NOTES-4.4.0.md. They name only what
 * the release shipped. When the release notes change, change this too. Each
 * has a full body (the /updating screen's panel) and a short summary (one
 * slide of the desktop card).
 *
 * The 4.3 highlights below them are no longer on the card. They stay because
 * the /updating screen's showcase still carries the live demos made for them,
 * keyed by their title keys, and its tests run those demos on this copy.
 *
 * WHERE THE EDITIONS DIFFER: the plan section's edition-switch line. An
 * OpenClaw box can be switched to Hermes, and a Hermes box can be switched
 * back to OpenClaw. Both need the Max plan. They are two keys, and the card
 * picks between them. The catalogue never branches on the edition.
 */
export const whatsNewEn: Record<string, string> = {
  "whatsNew.title": "What's new in 4.4",
  "whatsNew.subtitle": "This box now runs ClawBox {version}.",
  "whatsNew.highlightsLabel": "Highlights of ClawBox 4.4",

  "whatsNew.vaultTitle": "ClawBox Vault, passwords built in",
  "whatsNew.vaultBody":
    "A password manager built into ClawBox, opened by the owner from its desktop icon. Once you choose a vault PIN, the box's browser offers to save your logins and fills them in, and the assistant can log in to a site for you without ever seeing the password.",
  "whatsNew.orgModeTitle": "Organisation mode, for a company's staff",
  "whatsNew.orgModeBody":
    "A switch in Settings → System → Users gives other users only Chat, Files and their own settings, each with a limited assistant and a memory of their own. The owner picks the tools staff may use, sets upload, storage and chat limits, and reads an audit log.",
  "whatsNew.externalEngineTitle": "Your own AI engine as Local AI",
  "whatsNew.externalEngineBody":
    "Settings → Local AI → External engine runs the chat on an OpenAI-compatible server you run on your network, such as vLLM, SGLang or llama.cpp, instead of the model on the box. Without a ClawBox AI sign-in, Prime Radiant, picture descriptions and the Memory Shard index use it too.",
  "whatsNew.weeklyUpdateTitle": "A weekly update check, on Telegram too",
  "whatsNew.weeklyUpdateBody":
    "Every Monday morning the box looks for a newer ClawBox and tells you once per version: on Telegram, with an Update button, when a bot is connected, otherwise on the desktop. You can send /update to the bot at any time, and the update still waits for you to confirm it on the desktop.",
  "whatsNew.clawaiModelTitle": "One ClawBox AI model",
  "whatsNew.clawaiModelBody":
    "ClawBox AI is DeepSeek V4 Flash on every plan, for chat and for pictures. The update moves every setting that named a retired ClawBox AI model, such as the Max plan's own model, to deepseek-v4-flash. A model you chose from another provider stays.",
  "whatsNew.openclawMoveTitle": "OpenClaw 2026.11.5, a one-way move",
  "whatsNew.openclawMoveBody":
    "On the OpenClaw edition the update takes OpenClaw from 2026.10.9 to 2026.11.5 and moves the assistant's data to its newer format. The move is one-way: after the update an older OpenClaw core cannot open the data any more.",
  "whatsNew.checkInsJobTitle": "Check-ins become an automation job",
  "whatsNew.checkInsJobBody":
    "On OpenClaw 2026.11.5 the assistant's periodic check-in is an ordinary automation job. If your box had a check-in, the update turns it into a job, on or off as it was, and Unprompted check-ins in Settings → Harness switches that job without restarting the assistant.",

  // The card's slides: one highlight each, so each gets a one- or two-line
  // summary. The bodies above stay whole for the /updating screen's panel.
  "whatsNew.vaultSummary":
    "A password manager built into ClawBox: the browser saves and fills your logins, and the assistant logs in without seeing a password.",
  "whatsNew.orgModeSummary":
    "Give a company's staff only Chat, Files and their own settings, each with a limited assistant and a memory of their own.",
  "whatsNew.externalEngineSummary":
    "Run the chat on an OpenAI-compatible AI server on your own network, such as vLLM, SGLang or llama.cpp.",
  "whatsNew.weeklyUpdateSummary":
    "Every Monday the box looks for a newer ClawBox and tells you, on Telegram with an Update button when a bot is connected.",
  "whatsNew.clawaiModelSummary":
    "ClawBox AI is DeepSeek V4 Flash on every plan. Settings that named a retired model now use deepseek-v4-flash.",
  "whatsNew.openclawMoveSummary":
    "On OpenClaw, the assistant's data moved to OpenClaw 2026.11.5's format. An older OpenClaw cannot open it any more.",
  "whatsNew.checkInsJobSummary":
    "On OpenClaw, a check-in your box had becomes an automation job, switched by Unprompted check-ins in Settings → Harness.",

  // 4.3's highlights, kept for the /updating showcase's demos (see above).
  "whatsNew.screenshotTitle": "Screenshots, built in",
  "whatsNew.screenshotBody":
    "The new Screenshot app captures the whole screen, an area or one window, and lets you mark the picture up before it is saved to the Screenshots folder in Files. Print Screen, Ctrl+Shift+S or the Screenshot button beside the clock takes one in a single step.",
  "whatsNew.sharedBrowserTitle": "One browser for you and your assistant",
  "whatsNew.sharedBrowserBody":
    "The browser your assistant uses is now the one on the box's own desktop, shown in Agent Browser. Sign in to a site there once and the assistant can use it, and you can watch it work. It opens and closes only its own tabs.",
  "whatsNew.publicLinksTitle": "Share an app with a public link",
  "whatsNew.publicLinksBody":
    "Right-click an app the Coding Agent built and choose Create public link. Visitors reach only that app, for a set time or until you disable the link, and you can ask them for a password.",
  "whatsNew.grokTitle": "xAI Grok, and model changes without a restart",
  "whatsNew.grokBody":
    "On OpenClaw, xAI Grok can be set up with an API key or a SuperGrok or X Premium sign-in. Changing the model, or switching Local AI on or off, no longer restarts the assistant in most cases, so the chat carries on.",
  "whatsNew.holdToTalkTitle": "Hold to talk",
  "whatsNew.holdToTalkBody":
    "Hold the chat's microphone button, or F8, while you speak, and let go to send. Spoken replies download several times smaller, and Settings → Voice can play every reply aloud, including replies to questions you typed.",
  "whatsNew.agentChartTitle": "The Coding Agent, on a live chart",
  "whatsNew.agentChartBody":
    "The Coding Agent opens on a chart of its agents at work. You can message a run while it works, extra runs and teams wait in line instead of being refused, and Fix CI sends a pull request whose checks failed back to be fixed.",
  "whatsNew.primeRadiantTitle": "Prime Radiant, a living wiki",
  "whatsNew.primeRadiantBody":
    "A new app that keeps a wiki for you. Point it at your documents and it writes a page for each one, listing the facts it found with where each came from and how sure it is. Every night it tidies the wiki, looks for facts that contradict each other, and asks you about anything it cannot settle alone.",
  "whatsNew.runReportsTitle": "Coding runs report back in the chat",
  "whatsNew.runReportsBody":
    "When the assistant starts a coding run for you, the chat hears how it ended and the assistant tells you without being asked, including a deliverable that is missing or work still running. While it works, a run can send the assistant a question, a blocker or a milestone.",
  "whatsNew.updateAsksTitle": "Updates that ask before they stop your agents",
  "whatsNew.updateAsksBody":
    "While coding runs or assistant tasks are working, Update asks first: Cancel waits for them, Update anyway goes ahead. The box reboots only when the update needs a boot, and the update screen shows what is new while you wait.",
  "whatsNew.installQueueTitle": "Local AI installs wait in line",
  "whatsNew.installQueueBody":
    "Start a Local AI install while another one runs and it waits its turn instead of being refused. Its card says what it is waiting for, it starts by itself, and you can cancel it.",
  "whatsNew.jobAlertsTitle": "Alerts for scheduled jobs",
  "whatsNew.jobAlertsBody":
    "When one of the assistant's scheduled jobs fails, keeps being skipped or does not run when it is due, the desktop tells you, and Telegram too when a bot is connected. Settings → Harness lists the jobs in trouble.",

  // The card's slides: one highlight each, under a screenshot of it, so each
  // gets a one- or two-line summary. The bodies above stay whole for the
  // /updating screen's panel, which has the room.
  "whatsNew.screenshotSummary": "Capture the whole screen, an area or a window. Print Screen or Ctrl+Shift+S.",
  "whatsNew.sharedBrowserSummary":
    "Your assistant now uses the browser on the box's own desktop. Sign in once in Agent Browser and watch it work.",
  "whatsNew.publicLinksSummary":
    "Right-click an app the Coding Agent built and choose Create public link, for a set time and with an optional password.",
  "whatsNew.grokSummary":
    "On OpenClaw, set up xAI Grok with an API key or a SuperGrok or X Premium sign-in. Most model changes no longer restart the assistant.",
  "whatsNew.holdToTalkSummary": "Hold the chat's microphone button, or F8, while you speak, and let go to send.",
  "whatsNew.agentChartSummary":
    "Watch the Coding Agent's runs at work on a live chart, and message a run while it works.",
  "whatsNew.primeRadiantSummary":
    "A new app that turns your documents into a wiki of facts, each with its source, and tidies it every night.",
  "whatsNew.runReportsSummary":
    "The chat that asked for a coding run hears how it ended, and a run can send the assistant a question or a milestone.",
  "whatsNew.updateAsksSummary": "Update asks first while agents are working, and the box reboots only when the update needs it.",
  "whatsNew.installQueueSummary": "A second Local AI install waits its turn instead of being refused, and starts by itself.",
  "whatsNew.jobAlertsSummary": "The box tells you when a scheduled job fails, keeps being skipped or does not run when it is due.",
  // The carousel's controls. {current} and {total} are slide numbers.
  "whatsNew.slideLabel": "{current} of {total}",
  "whatsNew.goToSlide": "Show highlight {number}",
  "whatsNew.back": "Back",
  "whatsNew.next": "Next",
  // The slide's screenshot, full screen. {title} is the highlight's title.
  "whatsNew.openFullscreen": "View screenshot full screen",
  "whatsNew.fullscreenLabel": "Screenshot: {title}",
  "whatsNew.closeFullscreen": "Close full screen",
  "whatsNew.previousScreenshot": "Previous screenshot",
  "whatsNew.nextScreenshot": "Next screenshot",

  "whatsNew.readMore": "Read what's new in 4.4",

  // The plan section: only the lines the box's plan does not cover yet.
  "whatsNew.planTitle": "Unlock with a ClawBox AI plan",
  "whatsNew.planPaidFeatures": "Coding Agent and Memory Shard need the Pro or Max plan.",
  "whatsNew.planSwitchToHermes": "Switching this box to Hermes in Settings → Harness needs the Max plan.",
  // Hermes edition wording.
  "whatsNew.planSwitchToOpenclaw": "Switching this box back to OpenClaw in Settings → Harness needs the Max plan.",
  "whatsNew.seePlans": "See plans",

  "whatsNew.gotIt": "Got it",
  "whatsNew.dismiss": "Dismiss What's new in 4.4",
};
