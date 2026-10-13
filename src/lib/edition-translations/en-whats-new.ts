/**
 * English copy for the desktop's "What's new in 4.3" card (TASK-1059, TASK-1195).
 *
 * The highlights are taken from RELEASE-NOTES-4.3.0.md, trimmed to fit a
 * 320 px card. They name only what the release shipped. When the release notes
 * change, change this too.
 *
 * WHERE THE EDITIONS DIFFER: the plan section's edition-switch line. An
 * OpenClaw box can be switched to Hermes, and a Hermes box can be switched
 * back to OpenClaw. Both need the Max plan. They are two keys, and the card
 * picks between them. The catalogue never branches on the edition.
 */
export const whatsNewEn: Record<string, string> = {
  "whatsNew.title": "What's new in 4.3",
  "whatsNew.subtitle": "This box now runs ClawBox {version}.",
  "whatsNew.highlightsLabel": "Highlights of ClawBox 4.3",

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

  "whatsNew.readMore": "Read what's new in 4.3",

  // The plan section: only the lines the box's plan does not cover yet.
  "whatsNew.planTitle": "Unlock with a ClawBox AI plan",
  "whatsNew.planPaidFeatures": "Coding Agent and Memory Shard need the Pro or Max plan.",
  "whatsNew.planSwitchToHermes": "Switching this box to Hermes in Settings → Harness needs the Max plan.",
  // Hermes edition wording.
  "whatsNew.planSwitchToOpenclaw": "Switching this box back to OpenClaw in Settings → Harness needs the Max plan.",
  "whatsNew.seePlans": "See plans",

  "whatsNew.gotIt": "Got it",
  "whatsNew.dismiss": "Dismiss What's new in 4.3",
};
