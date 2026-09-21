export const dynamic = "force-dynamic";

import { getActiveHarness } from "@/lib/harness";
import { hermesProviderFor, readHermesVoice, speakWithHermes } from "@/lib/hermes-tts";
import { readConfig } from "@/lib/openclaw-config";
import { refuse, speakInCloud, speakLocally, withSpeechLock } from "@/lib/voice-speak";
import { readLocalVoice } from "@/lib/voice-output-store";
import { DEFAULT_CLOUD_VOICE, DEFAULT_LOCAL_VOICE, isCloudVoiceFor, SAMPLE_MAX_CHARS } from "@/lib/voice-catalog";

/**
 * POST /setup-api/tts/sample {text, engine, voice?} → the audio, for the browser.
 *
 * The Voice tab's "hear it" button. This does not go through the gateway's
 * chain — the owner is auditioning ONE engine with ONE voice, and a chain that
 * quietly fell through to the other engine would play them the wrong one. The
 * engines themselves live in src/lib/voice-speak.ts, shared with the reply
 * route (`tts/speak`), which DOES walk the chain; on a box running Hermes the
 * audition goes through Hermes' own speech route instead (below).
 *
 * The text is spoken and forgotten: never logged, never written to state.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no sound and can break a command line.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > SAMPLE_MAX_CHARS) return null;
  return text;
}

/**
 * The refusal codes said in terms of the engine that was auditioned.
 *
 * `speakWithHermes` names the TRANSPORT's failure, and on Hermes that
 * transport carries both engines — so a Kokoro refusal came back as
 * `cloud_refused`, which the panel renders as "The ClawBox cloud voice
 * refused" on a box with no cloud voice at all. An audition must fail in the
 * words of the thing the owner pressed play on.
 */
const LOCAL_CODE_FOR: Record<string, string> = {
  cloud_no_answer: "local_failed",
  cloud_refused: "local_failed",
  cloud_no_audio: "local_failed",
  no_voice: "no_local_voice",
};

/**
 * The audition on a box running Hermes.
 *
 * `/api/audio/speak` speaks with whatever `tts.provider` names — it takes no
 * per-request engine or voice — so the ONE thing this must not do is accept an
 * audition of the engine the box is not set to. The owner would press play
 * beside "This box" and hear the cloud voice under a 200, which is worse than
 * a refusal: it is the panel describing a different box. So a mismatch is
 * refused, and the sample the owner does get is by construction the same voice
 * their real replies are spoken in.
 */
async function speakWithHermesEngine(
  text: string,
  engine: "local" | "cloud",
  requestedVoice: unknown,
): Promise<Response> {
  const probe = await readHermesVoice();
  if (probe.provider !== hermesProviderFor(engine)) {
    return refuse(
      "This box is not set to speak with that voice — choose it under Speak from first.",
      "not_available",
      409,
    );
  }
  // The VOICE, for the same reason as the engine. `/api/audio/speak` takes no
  // per-request voice — it speaks with the one persisted for the provider — so
  // auditioning a voice the box is not set to would play a different one under
  // a 200, which is exactly what an audition must never do. The cloud voice
  // lives in Hermes' own key; the on-device one is the file `clawbox-tts.sh`
  // reads, which is what `readLocalVoice` answers.
  if (typeof requestedVoice === "string" && requestedVoice) {
    // The voice the PANEL SHOWS, which is `cloudVoiceFrom`'s rule applied to
    // the probe: the stored voice when the configured model actually has it,
    // and the default when it does not (tts-1 has no `verse`). Comparing
    // against the raw stored value would 409 naming a voice the dropdown is
    // displaying — refusing the owner for agreeing with us.
    //
    // The rule is applied DIRECTLY rather than by building a config view and
    // asking `cloudVoiceFrom`. That was tried and was much worse: the view's
    // cloud provider entry only exists `if (token)`, so passing a null token
    // dropped voice, model and baseUrl and the comparison collapsed to
    // `alloy` for every box — turning a narrow refusal into Play refusing
    // every cloud voice but the default, including the one on screen.
    const active = engine === "cloud"
      ? (isCloudVoiceFor(probe.cloudModel, probe.cloudVoice) ? probe.cloudVoice : DEFAULT_CLOUD_VOICE)
      : (await readLocalVoice()) ?? DEFAULT_LOCAL_VOICE;
    if (requestedVoice !== active) {
      return refuse(
        "This box is not set to speak with that voice — choose it under Voice first.",
        "not_available",
        409,
      );
    }
  }
  const spoken = await speakWithHermes(text);
  if (!spoken.ok) {
    const code = engine === "local" ? LOCAL_CODE_FOR[spoken.code] ?? spoken.code : spoken.code;
    return refuse(
      engine === "local"
        ? "The voice on this box could not speak that."
        : "The cloud voice could not speak that.",
      code,
      spoken.status,
      spoken.reason ? { reason: spoken.reason } : {},
    );
  }
  return new Response(spoken.audio, { headers: { "Content-Type": spoken.mime, ...NO_STORE } });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const { text: rawText, engine, voice } = (body ?? {}) as Record<string, unknown>;
  const text = cleanText(rawText);
  if (!text) return refuse(`Type something to hear, up to ${SAMPLE_MAX_CHARS} characters.`, "bad_text", 400);
  if (engine !== "local" && engine !== "cloud") return refuse("Pick the voice on this box or the cloud voice.", "unknown_engine", 400);
  // One synthesis at a time on the box; an audition is refused, never queued
  // (voice-speak.ts).
  return withSpeechLock(async () => {
    try {
      // On a box running Hermes the audition goes through Hermes' own
      // `/api/audio/speak`, which resolves the very `tts.provider` the Voice tab
      // just wrote. Auditioning through a chain we built ourselves would be
      // auditioning a different box than the one that answers the customer.
      if ((await getActiveHarness()) === "hermes") return await speakWithHermesEngine(text, engine, voice);
      const config = await readConfig();
      return engine === "local"
        ? await speakLocally(config, voice, text)
        : await speakInCloud(config, voice, text);
    } catch (err) {
      console.warn("[setup-api/tts/sample] failed:", err instanceof Error ? err.message : err);
      return refuse("Could not speak that on this box.", "failed", 500);
    }
  });
}
