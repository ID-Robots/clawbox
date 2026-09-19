/**
 * Settings → AI providers → Anthropic accounts (TASK-902): more than one
 * Anthropic account on the box, in the owner's order, with automatic fallback
 * when one hits its usage limit. English source; every other locale carries its
 * own copy in its edition-translations file.
 */
export const anthropicAccountsEn: Record<string, string> = {
  "settings.anthropicAccounts.title": "Anthropic accounts",
  "settings.anthropicAccounts.intro":
    "Coding runs use the first account in this list that can answer. When it hits its usage limit, the run moves to the next account and carries on where it was; the first account is used again as soon as its limit resets.",
  "settings.anthropicAccounts.summaryReady": "{ready} of {total} ready",
  "settings.anthropicAccounts.summaryAllLimited": "All limited · back at {time}",
  "settings.anthropicAccounts.summaryNone": "Not connected",
  "settings.anthropicAccounts.loading": "Loading the accounts…",
  "settings.anthropicAccounts.loadFailed": "The accounts could not be loaded.",
  "settings.anthropicAccounts.empty": "No Anthropic account is connected yet. Coding runs use ClawBox AI until you connect one.",
  "settings.anthropicAccounts.kindOauth": "Claude account",
  "settings.anthropicAccounts.kindApiKey": "API key",
  "settings.anthropicAccounts.kindLogin": "Claude Code sign-in",
  "settings.anthropicAccounts.statusInUse": "In use",
  "settings.anthropicAccounts.statusReady": "Ready",
  "settings.anthropicAccounts.statusLimited": "Limited until {time}",
  "settings.anthropicAccounts.statusExpired": "Sign-in expired",
  "settings.anthropicAccounts.statusRevoked": "Needs re-authentication",
  "settings.anthropicAccounts.moveUp": "Move up",
  "settings.anthropicAccounts.moveDown": "Move down",
  "settings.anthropicAccounts.rename": "Rename",
  "settings.anthropicAccounts.renameLabel": "Account name",
  "settings.anthropicAccounts.renameSave": "Save name",
  "settings.anthropicAccounts.reauth": "Re-authenticate",
  "settings.anthropicAccounts.remove": "Remove",
  "settings.anthropicAccounts.removeConfirm": "Tap again to remove",
  "settings.anthropicAccounts.connectFirst": "Connect an account",
  "settings.anthropicAccounts.connectAnother": "Connect another account",
  "settings.anthropicAccounts.connectTitle": "Connect a Claude account",
  "settings.anthropicAccounts.keyTitle": "Add an Anthropic API key",
  "settings.anthropicAccounts.reauthTitle": "Re-authenticate {label}",
  "settings.anthropicAccounts.labelField": "Name (optional)",
  "settings.anthropicAccounts.labelPlaceholder": "Name it, e.g. Work Max",
  "settings.anthropicAccounts.stepSignIn": "1. Sign in with the Claude account you want to add. Anthropic then shows you a code.",
  "settings.anthropicAccounts.stepSignInReauth": "1. Sign in with the same Claude account as before. A different account is refused. Anthropic then shows you a code.",
  "settings.anthropicAccounts.openSignIn": "Sign in with Claude",
  "settings.anthropicAccounts.stepPaste": "2. Paste that code here.",
  "settings.anthropicAccounts.codePlaceholder": "Paste the code",
  "settings.anthropicAccounts.connect": "Connect",
  "settings.anthropicAccounts.connecting": "Connecting…",
  "settings.anthropicAccounts.useApiKey": "Use an API key instead",
  "settings.anthropicAccounts.useSignIn": "Sign in with a Claude account instead",
  "settings.anthropicAccounts.apiKeyLabel": "Anthropic API key",
  "settings.anthropicAccounts.apiKeyPlaceholder": "sk-ant-…",
  "settings.anthropicAccounts.saveKey": "Save key",
  "settings.anthropicAccounts.savedUnchecked":
    "Saved. Anthropic could not be reached to check the key, so the first run that uses it will.",
  "settings.anthropicAccounts.addLogin": "Add this box's Claude Code sign-in",
  "settings.anthropicAccounts.loginNote":
    "Renewed with `claude` in the Terminal app. Removing it here only takes it off this list.",
  "settings.anthropicAccounts.cancel": "Cancel",
  "settings.anthropicAccounts.actionFailed": "The accounts could not be changed.",
};
