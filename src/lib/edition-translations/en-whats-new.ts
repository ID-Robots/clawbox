/**
 * English copy for the desktop's "What's new in 4.0" card (TASK-1059).
 *
 * The highlights are taken from RELEASE-NOTES-4.0.0.md, trimmed to fit a
 * 320 px card. They name only what the release shipped. When the release notes
 * change, change this too.
 *
 * WHERE THE EDITIONS DIFFER: the plan section's edition-switch line. An
 * OpenClaw box can be switched to Hermes, and a Hermes box can be switched
 * back to OpenClaw. Both need the Max plan. They are two keys, and the card
 * picks between them. The catalogue never branches on the edition.
 */
export const whatsNewEn: Record<string, string> = {
  "whatsNew.title": "What's new in 4.0",
  "whatsNew.subtitle": "This box now runs ClawBox {version}.",
  "whatsNew.highlightsLabel": "Highlights of ClawBox 4.0",

  "whatsNew.codingAgentTitle": "Coding Agent",
  "whatsNew.codingAgentBody":
    "Delegate a whole task to a headless Claude Code run. It works in a copy of your project, opens a pull request, and reviews its own diff before it calls itself done.",
  "whatsNew.hostnameTitle": "A hostname that stays",
  "whatsNew.hostnameBody":
    "A provisioned box answers on its own address under clawbox.tech, through a named Cloudflare tunnel, instead of a fresh random URL after every restart.",
  "whatsNew.phoneChatTitle": "Chat that fits a phone",
  "whatsNew.phoneChatBody":
    "A phone opens straight into the chat, with a thumb-sized microphone and the pickers folded behind one control.",
  "whatsNew.modelPillsTitle": "Change model without restarting anything",
  "whatsNew.modelPillsBody":
    "Provider, model and reasoning effort are pills under the message box and apply to the running agent.",

  "whatsNew.readMore": "Read what's new in 4.0",

  // The plan section: only the lines the box's plan does not cover yet.
  "whatsNew.planTitle": "Unlock with a ClawBox AI plan",
  "whatsNew.planPaidFeatures": "Coding Agent and Memory Shard need the Pro or Max plan.",
  "whatsNew.planSwitchToHermes": "Switching this box to Hermes in Settings → Harness needs the Max plan.",
  // Hermes edition wording.
  "whatsNew.planSwitchToOpenclaw": "Switching this box back to OpenClaw in Settings → Harness needs the Max plan.",
  "whatsNew.seePlans": "See plans",

  "whatsNew.gotIt": "Got it",
  "whatsNew.dismiss": "Dismiss What's new in 4.0",
};
