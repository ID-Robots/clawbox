/**
 * The ClawBox Improvement Program card (Settings → System).
 *
 * The copy carries the whole consent, so it is written to be read rather than
 * skimmed: what goes out, what never does, and the fact that the redaction
 * happens ON THE DEVICE before anything is sent. A card that said only "helps
 * us improve ClawBox" would be asking for a signature on a blank page.
 *
 * The three modes are named for what the BOX does, not for a level of
 * enthusiasm: off sends nothing, ask means the assistant offers, automatic
 * means the box files by itself.
 */
export const improvementEn: Record<string, string> = {
  "improvement.title": "ClawBox Improvement Program",
  "improvement.intro":
    "When something in ClawBox's own software goes wrong — a coding run that fails, an update step that will not finish, a page that errors — this box can send a short technical report to the developers as a public issue on GitHub. It is off until you turn it on.",

  "improvement.sendsTitle": "What is sent",
  "improvement.sends1": "The error message and where in ClawBox's code it happened.",
  "improvement.sends2": "This box's ClawBox version, its OpenClaw version and which edition it runs.",
  "improvement.sends3": "How many times it happened, and when it was first and last seen.",

  "improvement.neverTitle": "What is never sent",
  "improvement.never1": "Your conversations, your prompts, and anything you or the assistant wrote.",
  "improvement.never2": "The contents of your files, your settings and your environment.",
  "improvement.never3":
    "Your keys, tokens and passwords, your email address, your network addresses, your home folder name and the name of this box. These are removed on the device, before anything leaves it.",

  "improvement.modeTitle": "When to send",
  "improvement.modeOff": "Off",
  "improvement.modeOffHint": "Nothing leaves this box. Errors are still noted here, so you can show them to support.",
  "improvement.modeAsk": "Ask me",
  "improvement.modeAskHint": "The assistant tells you when something went wrong and offers to report it. Nothing is sent until you say yes.",
  "improvement.modeAuto": "Automatic",
  "improvement.modeAutoHint": "This box reports new errors by itself, up to {n} a day.",

  "improvement.statusTitle": "On this box",
  "improvement.pending": "{n} waiting",
  "improvement.reported": "{n} reported",
  "improvement.none": "Nothing has gone wrong on this box yet.",
  "improvement.repo": "Reports go to {repo}.",
  "improvement.remaining": "{n} reports left today.",

  "improvement.githubMissing": "Connect GitHub to send reports. Until then, errors just wait here.",
  "improvement.githubConnected": "GitHub connected as {login}.",

  "improvement.recentTitle": "Recent errors",
  "improvement.seen": "seen {n}×",
  "improvement.issue": "Issue #{n}",
  "improvement.report": "Report",
  "improvement.reporting": "Reporting…",
  "improvement.reportFailed": "Could not send the report.",
  "improvement.reportedNow": "Reported as issue #{n}.",
  "improvement.commentedNow": "Already known — added a note to issue #{n}.",

  "improvement.loadFailed": "Could not read the Improvement Program state.",
  "improvement.saveFailed": "Could not change the Improvement Program.",
};
