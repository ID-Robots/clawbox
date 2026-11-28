/**
 * The weekly update check (TASK-2260, src/lib/update-notice.ts): the switch in
 * Settings → System Update (src/components/WeeklyUpdateCheckCard.tsx) and the notice
 * itself.
 *
 * Everything but the card is read on the SERVER, in the box's language
 * (`pref:ui_language`) — the Telegram message, its Update button, the replies
 * to /update and the desktop notice — the way `jobAlerts.notice.*` is, so a
 * German box is not told about its update in English. `{version}` and
 * `{current}` are version strings the updater produced (`4.3.1`, or
 * `4.3.0 (beta@1a2b3c4)` on a branch without a newer tag); `{time}` and
 * `{date}` are formatted by the card in the owner's locale.
 */
export const updateNoticeEn: Record<string, string> = {
  "updateNotice.title": "Weekly update check",
  "updateNotice.helper":
    "Every Monday around 10:00 (this box's time), ClawBox looks for a newer version on the branch it follows and tells you once per version — in Telegram with an Update button, or on this desktop when no Telegram bot is connected. You can also send /update to the bot at any time.",
  "updateNotice.switch": "Check for updates every week",
  "updateNotice.next": "Next check: {time}",
  "updateNotice.lastNotified": "Last told you about {version} on {date}.",
  "updateNotice.off": "Off: the box does not look for updates on its own.",
  "updateNotice.saveFailed": "The setting could not be saved. Try again.",
  "updateNotice.available": "ClawBox {version} is available — this box runs {current}.",
  "updateNotice.whatsNew": "What's new:",
  "updateNotice.tapUpdate": "Tap Update to install it. The box asks you to confirm first and is offline for a few minutes while it updates.",
  "updateNotice.button": "Update",
  "updateNotice.openSettings": "To install it, open Settings → System Update on the ClawBox desktop.",
  "updateNotice.upToDate": "ClawBox is up to date ({current}).",
  "updateNotice.couldNotCheck": "ClawBox could not reach the update server just now. Send /update again later.",
  "updateNotice.ownerOnly": "Only this ClawBox's owner can do that.",
  "updateNotice.privateOnly": "Send /update in your private chat with this bot, not in a group.",
  "updateNotice.confirmOnDesktop": "Update requested. Confirm it on the ClawBox desktop within 2 minutes.",
  "updateNotice.confirmInApprovals": "Update requested. Confirm it with the button the ClawBox approvals bot just sent you, or on the desktop, within 2 minutes.",
  "updateNotice.nothingToInstall": "Nothing to install — ClawBox is already up to date ({current}).",
  "updateNotice.alreadyUpdating": "An update is already running on this box.",
  "updateNotice.waitingOnAnother": "The box is already waiting for you to confirm something else, or you just declined. Try again in a minute.",
  "updateNotice.busy": "Agents are working right now ({count} active), and the update would stop them mid-task. Tap Update again when they finish, or use Update anyway in Settings → System Update.",
};
