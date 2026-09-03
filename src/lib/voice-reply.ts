/**
 * Replying with voice to a voice message.
 *
 * One switch, Settings → Voice → "Reply with voice to voice messages", on by
 * default, reaching two surfaces that must agree:
 *
 *  - a CHANNEL voice note (Telegram and friends) is answered by the gateway:
 *    OpenClaw's `tts.auto: "inbound"` sends audio only after an inbound voice
 *    message, through the same speech chain the Voice tab orders (cloud →
 *    Kokoro or the reverse). Off is `tts.auto: "off"`. Never "always": a typed
 *    question gets a typed answer.
 *  - a voice message in the DESKTOP chat is transcribed on the box and sent as
 *    text, so the gateway cannot know it was spoken. The chat asks
 *    /setup-api/tts/speak for the reply's audio itself and plays it.
 *
 * The switch lives in ClawBox's own config store, like the transcription
 * preference: the Hermes edition has no openclaw.json and its desktop chat
 * still has a switch to honour. openclaw.json carries only the mode the
 * gateway reads, written by the tts route on a change and, once, by the
 * boot-time repair for a box that predates the switch.
 *
 * SERVER ONLY.
 */
import { get, set } from "@/lib/config-store";
import { readConfig, writeConfig, type OpenClawConfig } from "@/lib/openclaw-config";

/** The config-store key. */
export const VOICE_AUTO_REPLY_KEY = "voice_auto_reply";

export type TtsAutoMode = "inbound" | "off";

/** On unless the owner switched it off: a voice message gets a voice back. */
export async function getVoiceAutoReply(): Promise<boolean> {
  const stored = await get(VOICE_AUTO_REPLY_KEY);
  return stored !== false;
}

export async function setVoiceAutoReply(enabled: boolean): Promise<void> {
  await set(VOICE_AUTO_REPLY_KEY, enabled);
}

/** The gateway's auto-TTS mode for the switch's position. */
export function ttsAutoModeFor(enabled: boolean): TtsAutoMode {
  return enabled ? "inbound" : "off";
}

/**
 * Where the speech block lives — OpenClaw 2's top-level `tts`, or the legacy
 * `messages.tts` while that is where the providers still are. The same rule
 * the tts route writes with, so the mode can never land beside the wrong
 * generation's block.
 */
export function ttsHomeOf(config: OpenClawConfig): "tts" | "messages.tts" {
  const top = config.tts;
  if (top && typeof top === "object" && top.providers) return "tts";
  const legacy = (config as { messages?: { tts?: { providers?: unknown } } }).messages?.tts;
  if (legacy && typeof legacy === "object" && legacy.providers) return "messages.tts";
  return "tts";
}

function ttsBlockOf(config: OpenClawConfig, home: "tts" | "messages.tts"): Record<string, unknown> | undefined {
  if (home === "tts") return config.tts && typeof config.tts === "object" ? (config.tts as Record<string, unknown>) : undefined;
  const messages = (config as { messages?: Record<string, unknown> }).messages;
  const legacy = messages?.tts;
  return legacy && typeof legacy === "object" ? (legacy as Record<string, unknown>) : undefined;
}

/**
 * Boot-time repair: a box that predates the switch has no `tts.auto` at all,
 * and the switch's default — on — means nothing to the gateway until the
 * mode is in the file. Written only when the key is ABSENT: a value that is
 * there is either this switch's own last write or the owner's hand edit
 * ("always", "tagged"), and neither is overwritten at boot. Answers whether
 * it wrote, so the caller knows whether a gateway restart is owed.
 */
export async function ensureVoiceAutoReplyMode(): Promise<boolean> {
  const config = await readConfig();
  const home = ttsHomeOf(config);
  const block = ttsBlockOf(config, home);
  if (block && typeof block.auto === "string" && block.auto) return false;
  const mode = ttsAutoModeFor(await getVoiceAutoReply());
  if (home === "tts") {
    config.tts = { ...(block ?? {}), auto: mode };
  } else {
    const messages = ((config as { messages?: Record<string, unknown> }).messages ?? {}) as Record<string, unknown>;
    messages.tts = { ...(block ?? {}), auto: mode };
    (config as { messages?: Record<string, unknown> }).messages = messages;
  }
  await writeConfig(config);
  return true;
}
