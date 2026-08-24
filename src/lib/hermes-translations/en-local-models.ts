export const localModelsEn: Record<string, string> = {
  // === Kind of model ===
  "localModels.kind.llm": "Language",
  "localModels.kind.tts": "Speech out",
  "localModels.kind.stt": "Speech in",
  "localModels.kind.embedding": "Memory",

  // === Run state ===
  // Four states, four different sentences — see the comment on RUN_LABEL_KEY
  // in LocalModelsPanel for why "not installed" must not read as "off".
  "localModels.run.running": "Running",
  "localModels.run.idle": "Stopped",
  "localModels.run.onDemand": "On demand",
  "localModels.run.notInstalled": "Not installed",

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

  // === Errors ===
  "localModels.error.changeFailed": "Could not change that model.",
  "localModels.error.unreachable": "Could not reach the box to change that model.",
};
