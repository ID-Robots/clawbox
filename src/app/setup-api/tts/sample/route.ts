export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { runChild } from "@/lib/child-run";
import { getActiveHarness } from "@/lib/harness";
import { speakWithHermes } from "@/lib/hermes-tts";
import { readConfig } from "@/lib/openclaw-config";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { cloudSpeechTarget, localCommandPath, cloudVoiceFrom, type VoiceConfigView } from "@/lib/voice-output";
import { readLocalVoice } from "@/lib/voice-output-store";
import { DEFAULT_LOCAL_VOICE, isCloudVoiceFor, isLocalVoice, SAMPLE_MAX_CHARS } from "@/lib/voice-catalog";

/**
 * POST /setup-api/tts/sample {text, engine, voice?} → the audio, for the browser.
 *
 * The Voice tab's "hear it" button. This does not go through the gateway's
 * chain — the owner is auditioning ONE engine with ONE voice, and a chain that
 * quietly fell through to the other engine would play them the wrong one. So
 * the local engine is the same script the gateway runs (`clawbox-tts.sh`,
 * with `--voice`), and the cloud engine is the same OpenAI-compatible speech
 * route OpenClaw posts to, with the same credential (`cloudSpeechTarget` — the
 * rule the status card's "configured" uses).
 *
 * The text is spoken and forgotten: never logged, never written to state.
 *
 * Every refusal carries a stable `code` beside its English `error` (and, for
 * the memory guard, the numbers), so the Voice tab can say it in the owner's
 * language; the sentence stays for whoever reads the JSON directly.
 */

const LOCAL_TIMEOUT_MS = 90_000;
const CLOUD_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini-tts";
/** Below this a WAV is a header and nothing else — the script's own floor. */
const MIN_AUDIO_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, code, ...extra }, { status, headers: NO_STORE });
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no sound and can break a command line.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > SAMPLE_MAX_CHARS) return null;
  return text;
}

/** Megabytes as the script counts them, said as gigabytes: 2412 → "2.4", 3000 → "3". */
function gigabytes(mb: number): string {
  return (mb / 1000).toFixed(1).replace(/\.0$/, "");
}

/**
 * Why the script refused, in the owner's terms.
 *
 * `clawbox-tts.sh` states every reason it got to exit 1 as a "- kokoro: …"
 * line on stderr, and the most common one on an 8 GB board is its own memory
 * guard: any loaded model leaves less than the 3000 MB Kokoro's CUDA path
 * needs, and the script refuses rather than invite the OOM killer. That is a
 * fact about the box, not about the sentence — the generic "could not speak
 * that" read as a problem with the text. So the memory guard becomes its own
 * code with the numbers, and any other stated reason rides along with the
 * generic line — through sanitizeErrorMessage, because the stderr as a whole
 * is NOT path-free: the install hint names install.sh and the socket reason
 * names /tmp, and neither belongs on the owner's screen.
 */
function localRefusal(stderr: string): Response {
  const base = "The voice on this box could not speak that.";
  const reasons = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- kokoro:"))
    .map((line) => line.slice(2));
  const memory = reasons
    .map((line) => /^kokoro: skipped, (\d+)MB available .*need >=(\d+)MB/.exec(line))
    .find((m): m is RegExpExecArray => m !== null);
  if (memory) {
    const available = gigabytes(Number(memory[1]));
    const needed = gigabytes(Number(memory[2]));
    return refuse(
      `The box is short of memory for its voice right now (${available} GB free, needs ${needed} GB) — try again when less is running.`,
      "local_memory",
      502,
      { available, needed },
    );
  }
  const reason = reasons.map(sanitizeErrorMessage).find((r): r is string => r !== null) ?? null;
  return refuse(reason ? `${base} (${reason})` : base, "local_failed", 502, reason ? { reason } : {});
}

async function speakLocally(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
  const command = localCommandPath(config);
  if (!command) return refuse("No voice is installed on this box.", "no_local_voice", 409);
  const voice = isLocalVoice(requestedVoice) ? requestedVoice : (await readLocalVoice()) ?? DEFAULT_LOCAL_VOICE;
  const outputPath = path.join(os.tmpdir(), `clawbox-voice-sample-${crypto.randomBytes(6).toString("hex")}.wav`);
  try {
    // `--` ends the options, so a sentence that starts with a dash is text.
    // The script finds the Kokoro CLI itself; it needs HOME for the saved voice
    // and the user's runtime dir for the socket — not the server's environment.
    const env: Record<string, string> = {
      HOME: os.homedir(),
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    };
    const run = await runChild(command, ["--voice", voice, "--", text, outputPath], { timeoutMs: LOCAL_TIMEOUT_MS, env });
    const audio = run.code === 0 ? await fs.readFile(outputPath).catch(() => null) : null;
    if (!audio || audio.byteLength < MIN_AUDIO_BYTES) {
      if (run.timedOut) return refuse("The voice on this box took too long.", "local_timeout", 502);
      return localRefusal(run.stderr);
    }
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", ...NO_STORE } });
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

async function speakInCloud(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
  const target = cloudSpeechTarget(config);
  if (!target) return refuse("The cloud voice is not set up on this box.", "cloud_not_set_up", 409);
  // An audition is of ONE voice. A voice this model does not have (tts-1 has
  // no ballad or verse) is refused with the reason, never quietly swapped for
  // the configured one — that would play the owner the wrong voice and call it
  // the one they asked for.
  if (requestedVoice != null && !isCloudVoiceFor(target.model, requestedVoice)) {
    return refuse(`The cloud voice's model (${target.model ?? DEFAULT_CLOUD_MODEL}) does not have that voice.`, "unknown_voice", 400);
  }
  const voice = typeof requestedVoice === "string" ? requestedVoice : cloudVoiceFrom(config);
  let res: Response;
  try {
    res = await fetch(`${target.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json" },
      // WAV, the same format the on-device engine returns. An audition is one
      // short clip on a click, so the bytes are cheap — and PCM is the one
      // format no browser can decline to decode, which an audition of a voice
      // must never be lost to.
      body: JSON.stringify({ model: target.model ?? DEFAULT_CLOUD_MODEL, input: text, voice, response_format: "wav" }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch {
    return refuse("The cloud voice did not answer.", "cloud_no_answer", 502);
  }
  if (!res.ok) return refuse(`The cloud voice refused (HTTP ${res.status}).`, "cloud_refused", 502, { status: res.status });
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength < MIN_AUDIO_BYTES) return refuse("The cloud voice sent no audio.", "cloud_no_audio", 502);
  const type = res.headers.get("content-type")?.split(";")[0].trim();
  return new Response(audio, { headers: { "Content-Type": type?.startsWith("audio/") ? type : "audio/wav", ...NO_STORE } });
}

/**
 * The audition on a box running Hermes.
 *
 * One engine is auditioned, as on the OpenClaw side — but the CHOOSING is
 * Hermes': `/api/audio/speak` speaks with whatever `tts.provider` names, and
 * that key is what the Voice tab's "Speak from" writes. So the sample and the
 * box's real replies can never disagree about which voice this is.
 */
async function speakWithHermesEngine(text: string): Promise<Response> {
  const spoken = await speakWithHermes(text);
  if (!spoken.ok) {
    return refuse(
      "The voice on this box could not speak that.",
      spoken.code,
      spoken.status,
      spoken.reason ? { reason: spoken.reason } : {},
    );
  }
  return new Response(spoken.audio, { headers: { "Content-Type": spoken.mime, ...NO_STORE } });
}

/**
 * One sample at a time. Two local syntheses at once would fight over the GPU
 * on an 8 GB board, and the second press is almost always the first one heard
 * as "nothing happened".
 */
let inFlight = false;

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
  if (inFlight) return refuse("Still speaking the last sample — try again in a moment.", "busy", 429);
  inFlight = true;
  try {
    // On a box running Hermes the audition goes through Hermes' own
    // `/api/audio/speak`, which resolves the very `tts.provider` the Voice tab
    // just wrote. Auditioning through a chain we built ourselves would be
    // auditioning a different box than the one that answers the customer.
    if ((await getActiveHarness()) === "hermes") return await speakWithHermesEngine(text);
    const config = await readConfig();
    return engine === "local"
      ? await speakLocally(config, voice, text)
      : await speakInCloud(config, voice, text);
  } catch (err) {
    console.warn("[setup-api/tts/sample] failed:", err instanceof Error ? err.message : err);
    return refuse("Could not speak that on this box.", "failed", 500);
  } finally {
    inFlight = false;
  }
}
