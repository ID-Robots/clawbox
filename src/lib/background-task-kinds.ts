/**
 * The kinds of background task (src/lib/background-tasks.ts) the box runs, as
 * one list both halves share: the route that starts a task names its kind, and
 * the Settings row that re-attaches to it asks for the same name.
 *
 * Client-safe: strings only. Route files may export only handlers and route
 * config, so the names cannot live beside the routes that use them.
 */

/** Gemma 4 through llama.cpp: install, start, configure (POST /setup-api/llamacpp/install). */
export const LLAMACPP_INSTALL_KIND = "llamacpp-install";
/** faster-whisper and its CUDA build (POST /setup-api/whisper {action: "install-engine"}). */
export const WHISPER_ENGINE_INSTALL_KIND = "whisper-engine-install";
/** The box's own voice, Kokoro (POST /setup-api/tts/install). */
export const KOKORO_INSTALL_KIND = "voice-kokoro-install";
/** The memory-search model, the Qwen3-Embedding GGUF (POST /setup-api/embed/install). */
export const EMBED_MODEL_DOWNLOAD_KIND = "embed-model-download";
/** One Whisper size: fetch it, point the unit at it, restart (POST /setup-api/whisper {size}). */
export const WHISPER_SIZE_DOWNLOAD_KIND = "whisper-size-download";
