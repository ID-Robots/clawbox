export const localModelsEn: Record<string, string> = {
  // === Kind of model ===
  "localModels.kind.llm": "Language",
  "localModels.kind.tts": "Speech out",
  "localModels.kind.stt": "Speech in",
  "localModels.kind.embedding": "Memory",

  // === Run state ===
  // One state, one sentence — see the comment on RUN_LABEL_KEY in
  // LocalModelsPanel for why "not installed" must not read as "off", and why
  // "not on this edition" is kept apart from it.
  "localModels.run.running": "Running",
  "localModels.run.idle": "Stopped",
  "localModels.run.onDemand": "On demand",
  "localModels.run.notInstalled": "Not installed",
  "localModels.run.notOnThisEdition": "Not on this edition",

  // === Panel ===
  "localModels.intro": "Everything that can run on the box itself, and what it is doing right now. Anything shown as not installed is genuinely absent — it is not a setting you can switch on here.",
  "localModels.unavailable": "Could not read the state of: {list}.",
  "localModels.disk": "Disk {size}",
  "localModels.memoryInUse": "Memory in use {size}",
  "localModels.managedInClawKeep": "Managed in ClawKeep.",
  // "Settings → Local AI" names a section of this app's own settings, so the
  // section name is translated with it; the arrow is the path separator.
  "localModels.managedInLocalAi": "Managed in Settings → Local AI.",
  "localModels.toggleLabel": "{name} enabled",
  "localModels.footer": "Turning a model off stops it now and keeps it off after a reboot.",
  // The grouped list (LocalAiPanel): one row per engine, the actions behind a
  // "more" menu, and each row's role read from the surface that decides it.
  "localModels.group.llm": "AI agent model",
  "localModels.group.tts": "Voice (text to speech)",
  "localModels.group.stt": "Speech to text",
  "localModels.group.other": "Other",
  "localModels.role.primary": "Primary",
  "localModels.role.fallback": "Fallback",
  "localModels.menu.more": "More actions for {name}",
  "localModels.menu.install": "Install",
  "localModels.menu.enable": "Enable",
  "localModels.menu.disable": "Disable",
  "localModels.menu.makePrimary": "Make primary",
  "localModels.menu.useAsFallback": "Use as fallback",
  "localModels.menu.turnOffLocalAi": "Turn off Local AI",
  "localModels.menu.manageInClawKeep": "Manage in ClawKeep",
  "localModels.localOnly.title": "Local-only mode",
  "localModels.localOnly.hint": "Route everything to the local model. Disables all cloud AI providers, fallbacks included.",

  // === Errors ===
  "localModels.error.changeFailed": "Could not change that model.",
  "localModels.error.unreachable": "Could not reach the box to change that model.",
};
