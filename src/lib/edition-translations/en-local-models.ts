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
  "localModels.detail.embeddingsFailedBecause": "Stopped after an error: {reason}",
  "localModels.detail.embeddingsLocal": "Searching your memory on this box.",
  "localModels.detail.embeddingsCloud": "Searching your memory in the cloud.",
  "localModels.detail.embeddingsCloudLocalFailed": "Searching your memory in the cloud. The model on this box stopped after an error: {reason}",

  // === Errors ===
  "localModels.error.changeFailed": "Could not change that model.",
  // The box lost a race with its own config writer. Nothing is broken and
  // there is nothing to repair — so the banner names the state and the wait,
  // never the config file and never a command to re-run.
  //
  // "that change", not "the switch": this banner is shared by the Local-only
  // switch AND the row actions, and `providers/default` forwards
  // `chat/model`'s config_busy answer verbatim — so "Use as fallback" reaches
  // it too, on a row where there is no switch to name.
  "localModels.error.configBusy": "The box was saving its settings, so that change did not finish. Try again in a moment.",
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
  "localModels.install.refusal.removing": "That is being removed right now. Try again in a moment.",
  "localModels.uninstall.switchChatFirst": "Switch the chat to another model first",
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

  // === Chat while Local AI answers ===
  // The note at the top of the chat, until the owner closes it, and the
  // status line's words while the turn waits for its first token: a local
  // model is loaded into memory on the first reply, which can take a minute.
  "localModels.chatBannerTitle": "Running on this box.",
  "localModels.chatBannerBody": "The first reply can take up to a minute while the local model loads. After that it's faster.",
  "localModels.chatBannerDismiss": "Dismiss this note",
  "localModels.chatLoading": "Loading the local model…",
  "localModels.chatCompacting": "Shortening the conversation for the local model…",

  // === A long conversation switched to Local AI (TASK-2127) ===
  // The card in the chat when the conversation is larger than the local
  // model's window: a new chat (one click, the waiting message goes with it)
  // or a summary first. {tokens} and {window} are short counts such as "100k".
  "localModels.longChat.title": "This conversation is too long for the local model",
  "localModels.longChat.body": "It holds about {tokens} tokens; the local model reads up to {window}. A new chat answers in seconds. Shortening this one summarizes it first, which takes longer.",
  "localModels.longChat.pending": "Your message waits here and goes to the chat you pick.",
  "localModels.longChat.newChat": "Start a new chat with Local AI",
  "localModels.longChat.recommended": "Recommended",
  "localModels.longChat.shorten": "Shorten this conversation first",
  "localModels.longChat.timeoutTitle": "Still shortening after {seconds} seconds",
  "localModels.longChat.timeoutBody": "The local model could not shorten this long conversation in time, so the reply was stopped. Start a new chat with Local AI to get an answer in seconds.",
  "localModels.longChat.failed": "This conversation could not be shortened. A new chat with Local AI answers in seconds.",
  "localModels.longChat.shortened": "Conversation shortened for the local model.",

  // === External engine (TASK-2376) ===
  // Settings → Local AI → External engine: an OpenAI-compatible server the
  // owner runs, used as Local AI instead of the model on the box.
  "localModels.external.title": "External engine",
  "localModels.external.hint": "Use an OpenAI-compatible server you run — an inference cluster, or vLLM, SGLang or llama.cpp on a computer on your network — as Local AI instead of the model on this box.",
  "localModels.external.notConfigured": "No external engine is set up.",
  "localModels.external.readFailed": "The external engine's settings could not be read.",
  "localModels.external.retry": "Retry",
  "localModels.external.setUp": "Set up",
  "localModels.external.baseUrl": "Base URL",
  "localModels.external.baseUrlHint": "The address of the OpenAI-compatible API, usually ending in /v1.",
  "localModels.external.httpKeyWarning": "This address is plain HTTP: the API key will travel unencrypted to the engine. Use https:// unless the engine is on a network you trust.",
  "localModels.external.httpKeyConfirm": "Send the key over this unencrypted connection",
  "localModels.external.apiKey": "API key",
  "localModels.external.apiKeyHint": "Leave empty if the engine needs none",
  "localModels.external.apiKeyKeep": "A key is saved — leave empty to keep it",
  "localModels.external.clearKey": "Remove the saved key",
  "localModels.external.model": "Model id",
  "localModels.external.modelHint": "Exactly as the engine lists it under /models.",
  "localModels.external.contextWindow": "Context window (tokens)",
  "localModels.external.maxTokens": "Max output tokens",
  "localModels.external.imageInput": "The model accepts images",
  "localModels.external.test": "Test",
  "localModels.external.testing": "Testing…",
  "localModels.external.save": "Save and use",
  "localModels.external.saving": "Saving…",
  "localModels.external.cancel": "Cancel",
  "localModels.external.edit": "Edit",
  "localModels.external.remove": "Remove",
  "localModels.external.removeConfirm": "Remove and go back to the previous Local AI",
  "localModels.external.removing": "Removing…",
  "localModels.external.inUse": "Local AI answers with {model}.",
  "localModels.external.endpoint": "Engine: {url}",
  "localModels.external.window": "Context window {context} tokens, replies up to {max} tokens.",
  "localModels.external.windowOnly": "Context window {context} tokens.",
  "localModels.external.status.checking": "Checking the engine…",
  "localModels.external.status.unread": "The engine could not be checked just now.",
  "localModels.external.status.ok": "The engine answers and lists the model ({ms} ms).",
  "localModels.external.status.problem": "The engine has a problem right now: {problem}",
  "localModels.external.onDeviceIdle": "The model on this box is not started for chat while this engine is selected.",
  "localModels.external.testOk": "The engine answers and lists {model} ({ms} ms).",
  "localModels.external.listed": "It lists:",
  "localModels.external.saved": "Saved. The chat now uses {model}.",
  "localModels.external.removed": "Removed. Local AI is back to what it was before.",
  "localModels.external.localOnly": "Local-only mode is on. It keeps every conversation on this box, so turn it off before you use an external engine.",
  "localModels.external.hermesNote": "On Hermes the context window must be at least {min} tokens. Hermes decides the reply length and image handling itself.",
  "localModels.external.subtitle": "{model} (external engine)",
  "localModels.external.wizard.connected": "External AI engine, connected",
  "localModels.external.wizard.hint": "ClawBox answers with your own OpenAI-compatible server. Nothing is installed or started on this box.",
  "localModels.external.wizard.continue": "Continue with {model}",
  "localModels.external.wizard.useOther": "Connect a different AI provider instead",
  "localModels.external.wizard.backToEngine": "Use {model} (external engine) instead",
  "localModels.external.wizard.failed": "{model} could not be made the chat's model. Try again, or check it in Settings → Local AI.",
  "localModels.external.error.unreachable": "Could not reach the engine. Check the address and that the server is running and reachable from this box.",
  "localModels.external.error.unauthorized": "The engine refused the API key. Check it — or, if the engine needs no key, tick “Remove the saved key” (or leave the field empty when none is saved).",
  "localModels.external.error.modelNotListed": "The engine does not list this model id.",
  "localModels.external.error.badResponse": "That address answers, but not like an OpenAI-compatible API (no model list at /models).",
  "localModels.external.error.addressRefused": "That address is link-local or a cloud metadata service (169.254.0.0/16, fe80::/10, 0.0.0.0), which is never an AI engine. Use the address of the server itself.",
  "localModels.external.error.baseUrl": "Enter the engine's address, starting with http:// or https://, with no user name, password or query in it.",
  "localModels.external.error.model": "Enter the model id exactly as the engine lists it.",
  "localModels.external.error.contextWindow": "The context window must be a whole number of tokens, at least 1024.",
  "localModels.external.error.maxTokens": "Max output tokens must be a whole number between 256 and the context window.",
  "localModels.external.error.apiKey": "The API key must be one line with no spaces.",
  "localModels.external.error.hermesWindow": "Hermes needs a context window of at least {min} tokens.",
  "localModels.external.error.generic": "That did not work. Try again in a moment.",
};
