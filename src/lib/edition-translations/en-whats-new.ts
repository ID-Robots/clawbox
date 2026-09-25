/**
 * English copy for the desktop's "What's new in 4.1" card (TASK-1059, TASK-1195).
 *
 * The highlights are taken from RELEASE-NOTES-4.1.0.md, trimmed to fit a
 * 320 px card. They name only what the release shipped. When the release notes
 * change, change this too.
 *
 * WHERE THE EDITIONS DIFFER: the plan section's edition-switch line. An
 * OpenClaw box can be switched to Hermes, and a Hermes box can be switched
 * back to OpenClaw. Both need the Max plan. They are two keys, and the card
 * picks between them. The catalogue never branches on the edition.
 */
export const whatsNewEn: Record<string, string> = {
  "whatsNew.title": "What's new in 4.1",
  "whatsNew.subtitle": "This box now runs ClawBox {version}.",
  "whatsNew.highlightsLabel": "Highlights of ClawBox 4.1",

  "whatsNew.phoneFullscreenTitle": "More of the phone for the chat",
  "whatsNew.phoneFullscreenBody":
    "On a phone the chat opens full screen, its header and the message box's options fold away, and the text can be set from 85% to 150%. Both choices are remembered on that phone.",
  "whatsNew.chatRestoreTitle": "A conversation that cannot reopen says why",
  "whatsNew.chatRestoreBody":
    "Reopening a conversation no longer waits without end. When the box cannot bring it back, the chat says why and offers Try again.",
  "whatsNew.webappDataTitle": "Web apps from before 4.0 find their data",
  "whatsNew.webappDataBody":
    "An app you built on an earlier release opens with what it had saved. The box copies that data into the app's own storage and deletes nothing.",
  "whatsNew.autoMergeTitle": "Coding Agent pull requests merge when green",
  "whatsNew.autoMergeBody":
    "With merging switched on, a run hands its pull request to GitHub's auto-merge, so it lands as soon as its required checks pass. A pull request labelled hold, or one into main, is never merged.",

  "whatsNew.readMore": "Read what's new in 4.1",

  // The plan section: only the lines the box's plan does not cover yet.
  "whatsNew.planTitle": "Unlock with a ClawBox AI plan",
  "whatsNew.planPaidFeatures": "Coding Agent and Memory Shard need the Pro or Max plan.",
  "whatsNew.planSwitchToHermes": "Switching this box to Hermes in Settings → Harness needs the Max plan.",
  // Hermes edition wording.
  "whatsNew.planSwitchToOpenclaw": "Switching this box back to OpenClaw in Settings → Harness needs the Max plan.",
  "whatsNew.seePlans": "See plans",

  "whatsNew.gotIt": "Got it",
  "whatsNew.dismiss": "Dismiss What's new in 4.1",
};
