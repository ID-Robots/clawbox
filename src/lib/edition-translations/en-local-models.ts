export const localModelsEn: Record<string, string> = {
  // === Run state ===
  // One state, one word — see RUN_LABEL_KEY in LocalAiPanel for why "not
  // installed" must not read as "off", and why "not on this edition" is kept
  // apart from it.
  "localModels.run.running": "On",
  "localModels.run.idle": "Off",
  "localModels.run.onDemand": "Starts when needed",
  "localModels.run.notInstalled": "Not installed",
  "localModels.run.notOnThisEdition": "Not on this edition",

  // === Panel ===
  "localModels.intro": "AI that runs on this box, and what each part is doing right now.",
  "localModels.unavailable": "Could not read the state of: {list}.",
  "localModels.disk": "Disk {size}",
  "localModels.memoryInUse": "Memory in use {size}",
  // "Disable", the menu's own verb: Ollama's idle standby also turns it OFF,
  // and that one comes back by itself, so "turn off" promised the wrong thing.
  "localModels.footer": "Anything you disable stays off after a restart.",
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
  // For an enabled engine that is not running right now (Ollama's standby).
  "localModels.menu.turnOn": "Turn on now",
  "localModels.menu.disable": "Disable",
  "localModels.menu.makePrimary": "Make primary",
  "localModels.menu.useAsFallback": "Use as fallback",
  "localModels.menu.turnOffLocalAi": "Turn off Local AI",
  "localModels.menu.manageInMemoryShard": "Manage in Memory Shard",
  "localModels.localOnly.title": "Local-only mode",
  "localModels.localOnly.hint": "Route everything to the local model. Disables all cloud AI providers, fallbacks included.",

  // === Row copy ===
  // Each row's name, runtime line and detail line come from the inventory
  // route as a code (`nameCode`, `runtimeCode`, `detailCode` + `params`) beside
  // the English sentence; the panel renders the code through these keys and
  // shows the English only when a code has no key. The English here must stay
  // word for word what src/lib/local-models.ts sends, so the screen and an
  // MCP reader say the same thing.
  "localModels.name.memorySearch": "Memory search",
  "localModels.runtime.voiceOnBox": "Voice on this box",
  "localModels.runtime.transcribesOnBox": "Transcribes on this box",
  "localModels.runtime.answersOnBox": "Answers on this box",
  "localModels.runtime.findsInMemory": "Finds things in your memory",
  "localModels.runtime.modelVia": "{model} via {via}",
  "localModels.runtime.model": "{model}",
  "localModels.runtime.via": "via {via}",
  "localModels.detail.kokoroSpeaking": "Speaking from this box.",
  "localModels.detail.kokoroOff": "Off. Turn it on from the menu.",
  "localModels.detail.kokoroServiceMissing": "Its service is missing, so it cannot speak.",
  "localModels.detail.kokoroNotInstalled": "Not installed. The cloud voice speaks instead.",
  "localModels.detail.whisperReady": "Ready to transcribe.",
  "localModels.detail.whisperOff": "Off. Starts by itself when you speak.",
  "localModels.detail.whisperNotInstalled": "Not installed. Speech is transcribed in the cloud.",
  "localModels.detail.llamacppNotInstalled": "Not installed.",
  "localModels.detail.llamacppAnswering": "Answering right now.",
  "localModels.detail.llamacppReady": "Ready. Sleeps until needed to save memory.",
  "localModels.detail.llamacppOff": "Off. Make it primary or fallback from the menu.",
  "localModels.detail.embeddingsNotOnEdition": "Memory search is an OpenClaw feature. This edition does not include it.",
  "localModels.detail.embeddingsOff": "Memory search is not pointed at it yet. Set it up in Memory Shard.",
  "localModels.detail.embeddingsNotInstalled": "Not installed. Set it up in Memory Shard.",
  "localModels.detail.embeddingsReady": "Ready. Wakes when you search, then sleeps to save memory.",
  "localModels.detail.embeddingsFailed": "Stopped after an error. It starts again on the next search.",
  "localModels.detail.embeddingsLocal": "Searching your memory on this box.",
  "localModels.detail.embeddingsCloud": "Searching your memory in the cloud.",

  // === ClawBox AI cloud defaults (the owner's decision of 2026-09-14) ===
  // One row per capability that has both a cloud and an on-device engine, with
  // the reason beside it when the cloud is not the one answering. The reasons
  // are kept apart because their fixes are: no subscription, a plan that does
  // not cover it, a route that has not shipped, an edition that indexes on the
  // box, and the owner's own pin.
  "localModels.cloud.title": "ClawBox AI cloud",
  "localModels.cloud.intro": "Speech and memory search use your ClawBox AI subscription when it covers them, and the engines on this box when it does not.",
  "localModels.cloud.capability.tts": "Voice (text to speech)",
  "localModels.cloud.capability.stt": "Speech to text",
  "localModels.cloud.capability.embeddings": "Memory search",
  "localModels.cloud.onCloud": "Cloud",
  "localModels.cloud.onBox": "This box",
  "localModels.cloud.useLocal": "Use this box",
  "localModels.cloud.useCloud": "Use the cloud",
  "localModels.cloud.notConnected": "This box has no ClawBox AI subscription, so everything here runs on the box itself.",
  "localModels.cloud.connect": "Connect one",
  "localModels.cloud.reason.notLinked": "No ClawBox AI subscription on this box.",
  "localModels.cloud.reason.plan": "Your plan does not include this one.",
  "localModels.cloud.reason.routeUnavailable": "The cloud is not serving this yet, so the box does it.",
  "localModels.cloud.reason.edition": "This edition searches memory on the box itself.",
  "localModels.cloud.reason.owner": "You chose the engine on this box.",

  // === Errors ===
  "localModels.error.changeFailed": "Could not change that model.",
  "localModels.error.unreachable": "Could not reach the box to change that model.",
  "localModels.notice.voiceFallback": "Kokoro could not be made the primary voice, so the default voice stays.",
};
