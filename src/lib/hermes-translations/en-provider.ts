/**
 * HermesProviderConfig — the Hermes edition's AI-provider step (wizard) and the
 * same panel embedded in Settings. It is the one step where the user has to
 * FOLLOW instructions (open a tab, copy a code, paste a key) rather than click,
 * so leaving it in English was the most expensive gap of TASK-458.
 *
 * Not here, on purpose: provider display names and model ids (data, passed in
 * as `{provider}` / rendered verbatim), and anything the server worded —
 * `scope.warning`, OAuth `error_message`, a route's `error` field.
 */
export const providerEn: Record<string, string> = {
  // === Panel chrome ===
  "hermesProvider.title": "Hermes models",
  "hermesProvider.intro":
    "This device runs on Hermes. Choose an inference provider and default model — they switch through Hermes natively, no dashboard needed.",
  "hermesProvider.radioGroupLabel": "AI Provider",
  "hermesProvider.continue": "Continue",

  // === Provider rows ===
  // The registry (hermes-providers.ts) is shared with server routes and cannot
  // call `t`, so its row descriptions are keyed by provider id and resolved at
  // the render site. Provider `name` stays as the vendor wrote it.
  "hermesProvider.row.desc.openrouter": "300+ models behind one API key",
  "hermesProvider.row.desc.anthropic": "Claude — sign in or use an API key",
  "hermesProvider.row.desc.openaiCodex": "Sign in with OpenAI (Codex)",
  "hermesProvider.row.desc.gemini": "Gemini models, direct",
  "hermesProvider.row.desc.zai": "Zhipu GLM models",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi (coding)",
  "hermesProvider.row.desc.copilot": "Sign in with GitHub",
  "hermesProvider.row.desc.nous": "Sign in with Nous",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "Active",
  "hermesProvider.clawai.switching": "Switching…",
  "hermesProvider.clawai.switchTo": "Switch to {tier}",
  "hermesProvider.clawai.inUse": "ClawBox AI in use",
  "hermesProvider.clawai.modelLabel": "Model:",
  "hermesProvider.clawai.finishingSetup": "Finishing setup on this device…",
  "hermesProvider.clawai.nowActive": "ClawBox AI is now your active model",
  "hermesProvider.clawai.switchFailed": "Couldn't switch to ClawBox AI",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "Sign in with {provider}",
  "hermesProvider.oauth.connectedDesc": "Connected. OAuth credentials active.",
  "hermesProvider.oauth.cliOnlyDesc": "This provider signs in through the Hermes CLI.",
  "hermesProvider.oauth.availableDesc": "OAuth through Hermes (no API key needed).",
  "hermesProvider.oauth.connectedBadge": "Connected",
  "hermesProvider.oauth.signIn": "Sign in",
  "hermesProvider.oauth.tryAgain": "Try again",
  "hermesProvider.oauth.cliInstructions": "Run this in the device terminal, then reopen this panel:",
  "hermesProvider.oauth.starting": "Starting sign-in with {provider}...",
  "hermesProvider.oauth.pkceInstructions":
    "A {provider} sign-in tab has opened. Approve access there, copy the code it shows, and paste it here.",
  "hermesProvider.oauth.reopenSignInPage": "Reopen the sign-in page",
  "hermesProvider.oauth.codeLabel": "Paste the code from {provider}",
  "hermesProvider.oauth.submitting": "Submitting...",
  "hermesProvider.oauth.submitCode": "Submit code",
  "hermesProvider.oauth.startOver": "Start over",
  "hermesProvider.oauth.deviceInstructions":
    "Enter this code on the {provider} verification page. This panel updates by itself once you approve.",
  "hermesProvider.oauth.copyCode": "Copy code",
  "hermesProvider.oauth.copied": "Copied",
  "hermesProvider.oauth.openVerificationPage": "Open the verification page",
  "hermesProvider.oauth.waitingApproval": "Waiting for approval...",
  "hermesProvider.oauth.orPasteKey": "…or paste an API key below instead.",
  "hermesProvider.oauth.advancedLabel": "Advanced:",
  "hermesProvider.oauth.dashboardLink": "Hermes dashboard (LAN only)",

  // === Provider sign-in failures raised by this panel ===
  // Only the ones WE word; a message Hermes sent is shown as it arrived.
  "hermesProvider.oauth.unexpectedResponse": "Unexpected response from Hermes",
  "hermesProvider.oauth.startFailed": "Could not start sign-in",
  "hermesProvider.oauth.codeRejected": "Code was not accepted",
  "hermesProvider.oauth.expired": "The sign-in request expired. Try again.",
  "hermesProvider.oauth.failed": "Sign-in failed. Try again.",

  // === Model picker ===
  "hermesProvider.model.label": "Default model",
  "hermesProvider.model.loading": "Loading…",
  "hermesProvider.model.noCredentials": "No credentials for this provider yet",
  "hermesProvider.model.noModels": "No models available",
  // Interleaved with a <span> for the provider label, hence the split.
  "hermesProvider.model.savedElsewherePrefix": "This device is currently using",
  "hermesProvider.model.savedElsewhereSuffix": ". Saving switches it to {provider}.",
  "hermesProvider.model.staleColdStart": "Hermes hasn't published a model list yet — showing a minimal fallback.",
  "hermesProvider.model.staleCached": "Showing a cached model list; Hermes' live catalogue is unreachable.",

  // === API key + save ===
  "hermesProvider.key.label": "{provider} API key",
  "hermesProvider.key.placeholder": "Paste API key (optional if already set)",
  "hermesProvider.save.button": "Save model & provider",
  "hermesProvider.save.saving": "Saving…",
  "hermesProvider.save.ok": "Saved",
  "hermesProvider.save.keySavedOk": "Key saved — provider & model updated",
  "hermesProvider.save.failed": "Save failed",
  "hermesProvider.save.keySavedNoCatalog":
    "Key saved for {provider}, but it hasn't published a model list yet — reopen this panel in a moment and pick a model.",
  "hermesProvider.save.noCredentials": "{provider} has no credentials yet — sign in or paste an API key first.",
  "hermesProvider.save.catalogUnavailable":
    "Hermes' model list is unreachable right now, so {provider}'s models can't be checked. Try again in a moment.",
};
