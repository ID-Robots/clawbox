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
  // The grouped list (LocalAiPanel): one row per engine, its four verbs as
  // the row's own buttons, the role actions behind a "more" menu, and each
  // row's role read from the surface that decides it.
  "localModels.group.llm": "AI agent model",
  "localModels.group.tts": "Voice (text to speech)",
  "localModels.group.stt": "Speech to text",
  "localModels.group.other": "Other",
  "localModels.role.primary": "Primary",
  "localModels.role.fallback": "Fallback",
  "localModels.menu.more": "More actions for {name}",
  "localModels.menu.install": "Install",
  "localModels.menu.uninstall": "Uninstall",
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
  // The Uninstall confirm. Gemma's extra line is there because install.sh
  // re-caches it on every update, so a removal here lasts until the next one.
  "localModels.uninstall.title": "Uninstall {name}?",
  "localModels.uninstall.body": "{name} and its files are removed from this box. You can install it again from here.",
  "localModels.uninstall.gemmaNote": "The next system update puts Gemma back: it is the one model ClawBox installs on every box.",
  "localModels.uninstall.confirm": "Uninstall",

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

  // === Errors ===
  "localModels.error.changeFailed": "Could not change that model.",
  "localModels.error.unreachable": "Could not reach the box to change that model.",
  "localModels.notice.voiceFallback": "Kokoro could not be made the primary voice, so the default voice stays.",
  "localModels.notice.voiceReleased": "Kokoro was the voice this box spoke with; the default voice speaks now.",

  // === Install on click (owner's decision, 2026-09-14) ===
  // Settings → Local AI is the one place a local model is installed from, so
  // every card below says three things: what the download costs against what
  // the box has, what it is doing while it runs, and how it ended.
  "localModels.install.download": "Download",
  "localModels.install.downloading": "Downloading…",
  "localModels.install.remove": "Remove",
  "localModels.install.removing": "Removing…",
  "localModels.install.installed": "Installed.",
  "localModels.install.failed": "Failed: {reason}",
  "localModels.install.freed": "Freed {size}.",
  "localModels.install.diskBoth": "{need} to download · {free} free",
  "localModels.install.diskNeed": "{need} to download",
  // The one refusal with figures in it. "Not enough space" on its own is the
  // sentence that sends somebody to look at the wrong disk.
  "localModels.install.diskShort": "Not enough room: needs {need}, only {free} free.",
  "localModels.install.refusal.busy": "Something else is being downloaded right now.",
  "localModels.install.refusal.notInstalled": "That part is not installed on this box yet.",
  "localModels.install.refusal.noDownloader": "The downloader is not on this box yet. Install the local model first.",
  "localModels.install.refusal.alreadyHere": "That is already on this box.",
  "localModels.install.refusal.inUse": "That is the one this box is using. Pick another one first.",

  // The speech-to-text size. The weights are fetched whole BEFORE the engine is
  // pointed at them, so the microphone keeps working throughout.
  "localModels.whisper.title": "Speech model size",
  "localModels.whisper.hint": "Bigger is more accurate and slower. This box keeps using the current one until the new one is here.",
  "localModels.whisper.active": "In use",
  "localModels.whisper.use": "Use this one",
  "localModels.whisper.notInstalled": "Speech on this box is not installed yet.",

  // The memory-search model: the one download that still happens on its own,
  // because the memory index is unusable without it. Shown here so its state is
  // visible, with the repair that used to be a terminal job; the row above it
  // owns Install and Uninstall.
  "localModels.embed.title": "Memory search model",
  "localModels.embed.hint": "What your memory is searched with. It is fetched in the background on a new box; these are here for when that did not finish.",
  "localModels.embed.present": "{model} is on this box ({size}).",
  "localModels.embed.missing": "{model} is not on this box.",
  "localModels.embed.again": "Download again",
};
