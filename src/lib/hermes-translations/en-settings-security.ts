/**
 * English copy for the system-password card in Settings › System, its
 * "write this password down" confirmation dialog, and the saved-Wi-Fi password
 * editor that shares the same status line (TASK-458).
 *
 * Two sentences are split across several keys because the rendered paragraph
 * wraps part of itself in a `<span>` (a `font-mono` `sudo`, an emphasised
 * "web sign-in, SSH, and sudo"). Markup never belongs in a catalogue value, so
 * the component re-assembles prefix + span + suffix; translators get whole
 * clauses and the suffix keys therefore start with the punctuation that
 * follows the span.
 */
export const settingsSecurityEn: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "Local AI",
  "settings.localModels": "Local Models",
  "settings.voice": "Voice",
  // Settings → Coding Agent: the page the Coding Agent app's own settings
  // moved to. The hint is the one sentence under the title.
  "settings.codingAgent": "Coding Agent",
  "settings.codingAgentHint": "Let the assistant hand whole coding tasks to a Claude Code run on this box, and set how far a run may go.",

  // === System password card ===
  "settings.security.passwordLabel": "Password",
  "settings.security.passwordHintPrefix": "Used for web sign-in, SSH, and",
  "settings.security.passwordHintSuffix": ". Updating it here changes all three.",
  "settings.security.currentPassword": "Current password",
  "settings.security.newPassword": "New password",
  "settings.security.newPasswordPlaceholder": "New password (8+ characters)",
  "settings.security.confirmNewPassword": "Confirm new password",
  "settings.security.hideCurrentPassword": "Hide current password",
  "settings.security.showCurrentPassword": "Show current password",
  "settings.security.hideNewPassword": "Hide new password",
  "settings.security.showNewPassword": "Show new password",
  "settings.security.hideConfirmPassword": "Hide confirm password",
  "settings.security.showConfirmPassword": "Show confirm password",
  "settings.security.clearAndReenter": "Clear and re-enter current password",
  "settings.security.reenter": "Re-enter",
  "settings.security.checking": "Checking…",
  "settings.security.verify": "Verify",
  "settings.security.passwordsDontMatchYet": "Passwords don't match yet",
  "settings.security.saving": "Saving…",
  "settings.security.updatePassword": "Update password",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "Write this password down",
  "settings.security.confirmBodyPrefix": "This will change your password for",
  "settings.security.confirmBodyScope": "web sign-in, SSH, and sudo",
  "settings.security.confirmBodySuffix": ". If you forget it, you may be locked out of the device entirely and need a factory reset to recover.",
  "settings.security.hidePassword": "Hide password",
  "settings.security.revealPassword": "Reveal password",
  "settings.security.hide": "Hide",
  "settings.security.reveal": "Reveal",
  "settings.security.confirmChange": "I’ve written it down — change",

  // === Validation and status ===
  "settings.security.errorTooShort": "New password must be at least 8 characters",
  "settings.security.errorMismatch": "New passwords don't match",
  "settings.security.errorSameAsCurrent": "New password must differ from current",
  "settings.security.errorInvalidChars": "Password contains invalid characters",
  "settings.security.verificationFailed": "Verification failed",
  "settings.security.updateSuccess": "Password updated. Use the new password next time you sign in or SSH.",
  "settings.security.failed": "Failed",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "Password must be 8–63 characters",
  "settings.security.wifiPasswordUpdated": "Password updated for {ssid}",
};
