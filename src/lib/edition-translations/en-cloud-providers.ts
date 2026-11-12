// "Hide cloud AI providers" and the local-first AI providers page (TASK-2497,
// src/components/CloudProvidersPanel.tsx). Other locales: the per-locale files
// beside this one.
export const cloudProvidersEn: Record<string, string> = {
  "cloudProviders.hideTitle": "Hide cloud AI providers",
  "cloudProviders.hideHint": "Takes ClawBox AI, OpenAI, Anthropic and the other cloud services off Settings, the setup wizard and the chat's model picker. It does not change the active AI model. To keep conversations on this box or your own network, switch the active model to the local AI.",
  "cloudProviders.autoOn": "On automatically: this is an organisation box and its AI is an external engine. You can still turn it off.",
  "cloudProviders.failed": "The setting could not be saved.",
  "cloudProviders.localAi": "Local AI",
  "cloudProviders.default": "Default",
  "cloudProviders.externalEngineHint": "External engine you configured: your conversations go to the address you entered for it.",
  "cloudProviders.localModelHint": "Runs on this box — your conversations do not go to a cloud AI service.",
  "cloudProviders.noLocalAi": "No Local AI is set up yet. Set one up in Local AI.",
  "cloudProviders.openLocalAi": "Local AI settings",
  "cloudProviders.optionalSection": "Cloud providers (optional, send data off this box)",
  "cloudProviders.hiddenNote": "Cloud AI providers are hidden on this box.",
  "cloudProviders.wizardTitle": "Cloud AI providers are hidden",
  "cloudProviders.wizardBody": "Your assistant uses your external engine, or the model it already uses.",
  "cloudProviders.continue": "Continue",
};
