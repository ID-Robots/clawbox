/**
 * English copy for the desktop's "What's new in 4.2" card (TASK-1059, TASK-1195).
 *
 * The highlights are taken from RELEASE-NOTES-4.2.0.md, trimmed to fit a
 * 320 px card. They name only what the release shipped. When the release notes
 * change, change this too.
 *
 * WHERE THE EDITIONS DIFFER: the plan section's edition-switch line. An
 * OpenClaw box can be switched to Hermes, and a Hermes box can be switched
 * back to OpenClaw. Both need the Max plan. They are two keys, and the card
 * picks between them. The catalogue never branches on the edition.
 */
export const whatsNewEn: Record<string, string> = {
  "whatsNew.title": "What's new in 4.2",
  "whatsNew.subtitle": "This box now runs ClawBox {version}.",
  "whatsNew.highlightsLabel": "Highlights of ClawBox 4.2",

  "whatsNew.multiUserTitle": "Several people, one ClawBox",
  "whatsNew.multiUserBody":
    "The owner adds users in Settings → Users. Each person signs in with their own name and password, and gets a desktop and a Terminal of their own. Settings and installed apps stay with the owner.",
  "whatsNew.monitorModeTitle": "Monitor mode, with a drop-down terminal",
  "whatsNew.monitorModeBody":
    "On an x64 ClawBox running the ClawBox desktop session, one desktop spans a row of monitors, arranged in Settings → Monitors. Win+Down drops a terminal down from the top of the screen.",
  "whatsNew.githubBackupTitle": "Back up project folders to GitHub",
  "whatsNew.githubBackupBody":
    "In Files → Projects, Back up copies a folder to a private GitHub repository, with a daily backup if you want one. Files that look like passwords or keys are left out, and you are told which.",
  "whatsNew.kioskTitle": "Kiosk mode",
  "whatsNew.kioskBody":
    "On an x64 ClawBox that shows its desktop full screen, every page the desktop opens gets a ClawBox bar with tabs, back, forward, reload and an address field, so the desktop is always one click away.",
  "whatsNew.clawkeepTitle": "ClawKeep backups fixed",
  "whatsNew.clawkeepBody":
    "Snapshots no longer carry old backup archives along, a link that cannot be archived is skipped and named instead of failing the backup, and a full account no longer turns auto-backup off for good.",
  "whatsNew.hardwareFixesTitle": "Fixes from hardware testing",
  "whatsNew.hardwareFixesBody":
    "Testing 4.2 on real ClawBox hardware found and fixed problems with voice input, spoken replies, the ClawBox AI plugin's Retry, and updating a box left on an older build.",

  "whatsNew.readMore": "Read what's new in 4.2",

  // The plan section: only the lines the box's plan does not cover yet.
  "whatsNew.planTitle": "Unlock with a ClawBox AI plan",
  "whatsNew.planPaidFeatures": "Coding Agent and Memory Shard need the Pro or Max plan.",
  "whatsNew.planSwitchToHermes": "Switching this box to Hermes in Settings → Harness needs the Max plan.",
  // Hermes edition wording.
  "whatsNew.planSwitchToOpenclaw": "Switching this box back to OpenClaw in Settings → Harness needs the Max plan.",
  "whatsNew.seePlans": "See plans",

  "whatsNew.gotIt": "Got it",
  "whatsNew.dismiss": "Dismiss What's new in 4.2",
};
