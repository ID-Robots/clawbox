import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { get } from "@/lib/config-store";
import { readConfig } from "@/lib/openclaw-config";

/**
 * The one place that knows where each edition keeps the device's ClawBox AI
 * credential. SERVER ONLY — nothing here may be imported by a client component.
 *
 * It exists because the same credential has two homes and every route that
 * looked in only one of them was dark on the other edition. Voice input is the
 * worked example: `/setup-api/chat/transcribe` read `openclaw.json`
 * unconditionally, so on a Hermes box — which stores the SAME token somewhere
 * else — the route could only ever answer "not configured", and the microphone
 * was hidden to cover for it. Nothing about transcription is OpenClaw-specific;
 * the lookup was.
 */

export { CLAWBOX_AI_PROXY_URL } from "@/lib/hermes-clawai";

/** The config-store key the Hermes flow writes the device token under. */
const HERMES_TOKEN_KEY = "clawai_token";

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The device's ClawBox AI token, wherever this edition keeps it, or null.
 *
 * Read per request rather than cached, for the reason the transcribe route
 * already documented before this moved: the gateway rewrites `openclaw.json`
 * on restart and the portal can re-mint a token at any time, so a value
 * captured at module load goes stale exactly when someone re-links the device
 * and least expects to have to reboot it.
 *
 * OpenClaw's store is consulted first because it is the historical home and is
 * present on a dual box; the Hermes store is the fallback. On a box that has
 * both, the two hold the same credential — they are written by the same portal
 * hand-off — so the order only decides which read answers first, never which
 * token is used.
 *
 * Never logged, never echoed, never returned to a browser. Callers that only
 * need to know whether one EXISTS should send a boolean (see
 * `/setup-api/chat/capabilities`), not the value.
 */
export async function resolveClawaiToken(): Promise<string | null> {
  try {
    const config = await readConfig();
    const key = trimmedString(config.models?.providers?.[CLAWBOX_AI_PROVIDER]?.apiKey);
    if (key) return key;
  } catch {
    // A Hermes SKU has no OpenClaw config to read. That is not a failure here,
    // it is the whole reason this function has a second place to look.
  }
  try {
    return trimmedString(await get(HERMES_TOKEN_KEY));
  } catch {
    return null;
  }
}

/** Whether this box holds a ClawBox AI credential at all. */
export async function hasClawaiToken(): Promise<boolean> {
  return (await resolveClawaiToken()) !== null;
}
