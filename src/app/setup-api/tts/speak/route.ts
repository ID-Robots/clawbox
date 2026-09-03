export const dynamic = "force-dynamic";

import { promises as fs } from "fs";
import { getActiveHarness } from "@/lib/harness";
import { speakWithHermes } from "@/lib/hermes-tts";
import { buildTtsInventory, KOKORO_STAMP } from "@/lib/local-models";
import { readConfig } from "@/lib/openclaw-config";
import { speechTextFor, SPEECH_MAX_CHARS } from "@/lib/speech-text";
import { getVoiceAutoReply } from "@/lib/voice-reply";
import { isSameOriginRequest } from "@/lib/same-origin";
import { refuse, speakThroughChain, withSpeechQueue } from "@/lib/voice-speak";
import { buildVoiceOutputStatus, localCommandPath, type LocalVoiceProbe } from "@/lib/voice-output";
import { readVoiceState } from "@/lib/voice-output-store";

/**
 * POST /setup-api/tts/speak {text} → the reply, spoken, for the desktop chat.
 *
 * A voice message in the desktop chat is transcribed on the box and sent as
 * text, so the gateway never learns it was spoken and its own `tts.auto:
 * "inbound"` cannot answer it. The chat asks here instead, with the reply's
 * text, and plays what comes back beside the bubble. Through the CHAIN — the
 * engine the Voice tab put first, then the other — because the owner wants to
 * hear the answer, not audition an engine (that is `tts/sample`).
 *
 * The Markdown is lifted off the text here as well as in the chat, so a
 * caller that sends the raw reply still gets words rather than asterisks, and
 * the result is capped at SPEECH_MAX_CHARS. Refused while the owner's switch
 * is off: the chat does not ask then, and nothing else should get a spoken
 * reply out of a box whose owner turned them off.
 */

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!(await getVoiceAutoReply())) return refuse("Spoken replies are switched off in Settings → Voice.", "switched_off", 409);
  // From OUR page only: the owner's cookie rides on a POST any other site
  // fires at the box, and a spoken reply through the cloud voice is billed
  // per character (same-origin.ts). curl and the MCP server send no Origin
  // and pass; they are gated by their own credential.
  if (!isSameOriginRequest(req)) return refuse("Spoken replies only work from this ClawBox's own pages.", "cross_origin", 403);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const raw = (body as { text?: unknown } | null)?.text;
  const text = typeof raw === "string" ? speechTextFor(raw, SPEECH_MAX_CHARS) : "";
  if (!text) return refuse("Nothing to say.", "bad_text", 400);

  // Waits for an earlier reply rather than refusing: see withSpeechQueue.
  return withSpeechQueue(async () => {
    try {
      // On a box running Hermes the reply is spoken by Hermes' own speech
      // route, with the provider the Voice tab wrote — the same voice its
      // channel replies would have.
      if ((await getActiveHarness()) === "hermes") {
        const spoken = await speakWithHermes(text);
        if (!spoken.ok) return refuse("Could not speak that on this box.", spoken.code, spoken.status, spoken.reason ? { reason: spoken.reason } : {});
        return new Response(spoken.audio, { headers: { "Content-Type": spoken.mime, "Cache-Control": "no-store" } });
      }
      const [config, models, state] = await Promise.all([readConfig(), buildTtsInventory(), readVoiceState()]);
      const installed = models.filter((m) => m.kind === "tts" && m.installed);
      const command = localCommandPath(config);
      const probe: LocalVoiceProbe = {
        providerConfigured: Boolean(command),
        commandPresent: command ? await exists(command) : await exists(KOKORO_STAMP),
        engineInstalled: installed.length > 0,
        engineNames: installed.map((m) => m.name),
      };
      const status = buildVoiceOutputStatus(config, probe, state);
      return await speakThroughChain(config, status.engines, state.choice, text);
    } catch (err) {
      console.warn("[setup-api/tts/speak] failed:", err instanceof Error ? err.message : err);
      return refuse("Could not speak that on this box.", "failed", 500);
    }
  });
}
