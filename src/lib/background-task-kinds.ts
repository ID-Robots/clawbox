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
/**
 * The box's half of connecting an AI provider, once the owner's half (a key,
 * an approval) is done: save it, wait out the assistant's restart, check it
 * (POST /setup-api/ai-models/configure {background: true}; the ClawBox AI
 * device login once its token lands, POST /setup-api/ai-models/clawai/poll).
 */
export const PROVIDER_SIGN_IN_KIND = "provider-sign-in";
/** Signing the box out of an AI provider (POST /setup-api/providers/sign-out). */
export const PROVIDER_SIGN_OUT_KIND = "provider-sign-out";
/**
 * Both provider kinds share ONE group: every one of them rewrites the
 * harness's credentials and restarts it, so one provider sign-in or sign-out
 * runs on the box at a time (src/lib/provider-auth-tasks.ts).
 */
export const PROVIDER_AUTH_GROUP = "provider-auth";
export const PROVIDER_AUTH_KINDS: readonly string[] = [PROVIDER_SIGN_IN_KIND, PROVIDER_SIGN_OUT_KIND];
/**
 * Setting up a messaging channel, or taking it down: Telegram, Discord, Email,
 * WhatsApp (POST/DELETE /setup-api/<channel>/configure, /telegram/streaming,
 * /whatsapp/unpair with `background: true`). One at a time on the box: every
 * one of them restarts the harness's gateway or rewrites its channel config.
 */
export const CHANNEL_SETUP_KIND = "channel-setup";
export const CHANNEL_SETUP_GROUP = "channel-setup";
/**
 * Every kind that is a Settings action run as a job (src/lib/settings-jobs.ts):
 * `meta` carries `subject`/`action`/`label`, and the desktop's corner card
 * draws it with a turning ring.
 */
export const SETTINGS_JOB_KINDS: readonly string[] = [...PROVIDER_AUTH_KINDS, CHANNEL_SETUP_KIND];
