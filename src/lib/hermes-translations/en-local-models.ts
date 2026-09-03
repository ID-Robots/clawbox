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
  "localModels.ollama.title": "Ollama library",
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
  "localModels.runtime.runsExtraModels": "Runs extra models on this box",
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
  "localModels.detail.ollamaNotInstalled": "Not installed.",
  "localModels.detail.ollamaOff": "Off. Turn it on from the menu.",
  "localModels.detail.ollamaStandby": "Asleep to save memory. Wakes when a model is asked for, or turn it on now from the menu.",
  "localModels.detail.ollamaFailed": "Stopped after an error. Turn it on from the menu.",
  "localModels.detail.ollamaChecking": "On. Checking which models are downloaded…",
  "localModels.detail.ollamaServing": "Serving {names}.",
  "localModels.detail.ollamaNoModels": "On, with no models downloaded yet.",
  "localModels.detail.llamacppNotInstalled": "Not installed.",
  "localModels.detail.llamacppAnswering": "Answering right now.",
  "localModels.detail.llamacppReady": "Ready. Sleeps until needed to save memory.",
  "localModels.detail.llamacppOff": "Off. Make it primary or fallback from the menu.",
  "localModels.detail.embeddingsNotOnEdition": "Memory search is an OpenClaw feature. This edition does not include it.",
  "localModels.detail.embeddingsOff": "No memory model is answering, so memory search is off.",
  "localModels.detail.embeddingsAsleep": "{host} is asleep, so memory search is paused until it wakes.",
  "localModels.detail.embeddingsPaused": "{host} is off, so memory search is paused.",
  "localModels.detail.embeddingsLocal": "Searching your memory on this box.",
  "localModels.detail.embeddingsCloud": "Searching your memory in the cloud.",

  // === Errors ===
  "localModels.error.changeFailed": "Could not change that model.",
  "localModels.error.unreachable": "Could not reach the box to change that model.",
  "localModels.notice.voiceFallback": "Kokoro could not be made the primary voice, so the default voice stays.",
};
