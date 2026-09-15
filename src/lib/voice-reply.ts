/**
 * Replying with voice to a voice message.
 *
 * One switch, Settings → Voice → "Spoken replies", OFF by default — a box
 * that has never been asked speaks nothing, on a channel or in the chat, until
 * the owner turns it on (the owner's ruling, 2026-09-15; it was on by default
 * until then) — reaching two surfaces that must agree:
 *
 *  - a CHANNEL voice note (Telegram and friends) is answered by the gateway:
 *    OpenClaw's `tts.auto: "inbound"` sends audio only after an inbound voice
 *    message, through the same speech chain the Voice tab orders (cloud →
 *    Kokoro or the reverse). Off is `tts.auto: "off"`. Never "always": a typed
 *    question gets a typed answer.
 *  - in the DESKTOP chat the gateway speaks nothing at all: a recording is
 *    transcribed on the box and sent as text, so `inboundAudio` is never true
 *    for a turn from this surface and `tts.auto: "inbound"` cannot fire on any
 *    reply here, typed or spoken. The chat asks /setup-api/tts/speak for the
 *    reply's audio itself — playing it when the question was spoken, and
 *    putting it on the bubble to press when it was typed.
 *
 * The switch lives in ClawBox's own config store, like the transcription
 * preference: the Hermes edition has no openclaw.json and its desktop chat
 * still has a switch to honour. openclaw.json carries only the mode the
 * gateway reads, written by the tts route on a change and, once, by the
 * boot-time repair for a box that predates the switch.
 *
 * SERVER ONLY.
 */
import { get, getKnown, set } from "@/lib/config-store";
// TYPE ONLY at module scope. The values this module needs from openclaw-config
// are used by the boot repair alone, and that module reaches the openclaw CLI —
// it pulls `child_process` into the import graph of everything that reads the
// switch, which since the Hermes chat route started reading it means every
// Hermes chat turn. Imported inside the one function that uses them instead.
import { type OpenClawConfig } from "@/lib/openclaw-config";

/** The config-store key. */
export const VOICE_AUTO_REPLY_KEY = "voice_auto_reply";

export type TtsAutoMode = "inbound" | "off";

/**
 * Off unless the owner switched it on: only a stored `true` speaks. Anything
 * else — absent, `false`, a value that is not a boolean — is off, because a
 * reply spoken by a box nobody asked to speak is the worse mistake.
 */
export async function getVoiceAutoReply(): Promise<boolean> {
  const stored = await get(VOICE_AUTO_REPLY_KEY);
  return stored === true;
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
 * and the switch's position — off unless the owner set it — means nothing to
 * the gateway until the mode is in the file (a fresh box is seeded "off", and
 * only the owner's own `true` seeds "inbound"). Written when the key is
 * ABSENT, and once more over the previous build's own seed — `inbound` beside
 * no stored answer, flipped to `off` and recorded (see the body). Any other
 * value is this switch's own last write or the owner's hand edit ("always",
 * "tagged"), and is never overwritten at boot. Answers whether
 * it wrote, so the caller knows whether a gateway restart is owed.
 *
 * Read with the WRITER's reader: `readConfig` answers `{}` to every failure
 * (EACCES, a file caught half-written by a concurrent `config set`, a hand
 * edit with a trailing comma), and writing that `{}` back would replace the
 * whole config with one key. `readConfigForWrite` throws instead, which the
 * boot loop logs. A box with no config yet (`{}` after an ENOENT — nothing
 * to seed into) and the Hermes edition (no openclaw.json at all) are left
 * to onboarding.
 */
export async function ensureVoiceAutoReplyMode(): Promise<boolean> {
  const { openclawIsAbsent, readConfigForWrite, writeConfig } = await import("@/lib/openclaw-config");
  if (openclawIsAbsent()) return false;
  const config = await readConfigForWrite();
  if (Object.keys(config).length === 0) return false;
  const home = ttsHomeOf(config);
  const block = ttsBlockOf(config, home);
  const present = block && typeof block.auto === "string" && block.auto ? (block.auto as string) : null;
  if (present !== null) {
    // ONE migration over a value that is there: the previous build's default
    // was ON, and its first boot seeded `inbound` on every box whose owner
    // never touched the switch. Since 2026-09-15 the switch is OFF unless the
    // owner said otherwise, so that seed — `inbound` with NO stored answer —
    // is ClawBox's own stale write, not a choice, and left in place the
    // gateway would go on answering channel voice notes aloud under a switch
    // that reads Off. It is flipped to `off` and the answer recorded as
    // `false`, which is what makes this run once: the next boot sees a known
    // key and leaves the file alone. A stored answer either way, and any hand
    // edit (`always`, `tagged`), is never touched.
    if (present !== "inbound") return false;
    // `known` says whether the STORE could be read, not whether the key is in
    // it. An unreadable store cannot tell ClawBox's seed from the owner's
    // choice, so nothing is written; a readable one decides by the key itself.
    const stored = await getKnown(VOICE_AUTO_REPLY_KEY).catch(() => ({ value: undefined, known: false }));
    if (!stored.known || stored.value !== undefined) return false;
    writeMode(config, home, block, "off");
    await writeConfig(config);
    await set(VOICE_AUTO_REPLY_KEY, false);
    return true;
  }
  const mode = ttsAutoModeFor(await getVoiceAutoReply());
  writeMode(config, home, block, mode);
  await writeConfig(config);
  return true;
}

function writeMode(
  config: OpenClawConfig,
  home: "tts" | "messages.tts",
  block: Record<string, unknown> | undefined,
  mode: string,
): void {
  if (home === "tts") {
    config.tts = { ...(block ?? {}), auto: mode } as OpenClawConfig["tts"];
  } else {
    const messages = ((config as { messages?: Record<string, unknown> }).messages ?? {}) as Record<string, unknown>;
    messages.tts = { ...(block ?? {}), auto: mode };
    (config as { messages?: Record<string, unknown> }).messages = messages;
  }
}
