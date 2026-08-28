export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { runChild } from "@/lib/child-run";
import { openclawIsAbsent, readConfig } from "@/lib/openclaw-config";
import { cloudSpeechTarget, localCommandPath, cloudVoiceFrom, type VoiceConfigView } from "@/lib/voice-output";
import { readLocalVoice } from "@/lib/voice-output-store";
import { DEFAULT_LOCAL_VOICE, isCloudVoice, isLocalVoice, SAMPLE_MAX_CHARS } from "@/lib/voice-catalog";

/**
 * POST /setup-api/tts/sample {text, engine, voice?} → the audio, for the browser.
 *
 * The Voice tab's "hear it" button. Unlike the voice check this does not go
 * through the gateway's chain — the owner is auditioning ONE engine with ONE
 * voice, and a chain that quietly fell through to the other engine would play
 * them the wrong one. So the local engine is the same script the gateway runs
 * (`clawbox-tts.sh`, with `--voice`), and the cloud engine is the same
 * OpenAI-compatible speech route OpenClaw posts to, with the same credential
 * (`cloudSpeechTarget` — the rule the status card's "configured" uses).
 *
 * The text is spoken and forgotten: never logged, never written to state.
 */

const LOCAL_TIMEOUT_MS = 90_000;
const CLOUD_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini-tts";
/** Below this a WAV is a header and nothing else — the script's own floor. */
const MIN_AUDIO_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no sound and can break a command line.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > SAMPLE_MAX_CHARS) return null;
  return text;
}

async function speakLocally(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
  const command = localCommandPath(config);
  if (!command) return refuse("No voice is installed on this box.", 409);
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
      return refuse(run.timedOut ? "The voice on this box took too long." : "The voice on this box could not speak that.", 502);
    }
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", ...NO_STORE } });
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

async function speakInCloud(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
  const target = cloudSpeechTarget(config);
  if (!target) return refuse("The cloud voice is not set up on this box.", 409);
  const voice = isCloudVoice(requestedVoice) ? requestedVoice : cloudVoiceFrom(config);
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
    return refuse("The cloud voice did not answer.", 502);
  }
  if (!res.ok) return refuse(`The cloud voice refused (HTTP ${res.status}).`, 502);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength < MIN_AUDIO_BYTES) return refuse("The cloud voice sent no audio.", 502);
  const type = res.headers.get("content-type")?.split(";")[0].trim();
  return new Response(audio, { headers: { "Content-Type": type?.startsWith("audio/") ? type : "audio/wav", ...NO_STORE } });
}

/**
 * One sample at a time. Two local syntheses at once would fight over the GPU
 * on an 8 GB board, and the second press is almost always the first one heard
 * as "nothing happened".
 */
let inFlight = false;

export async function POST(req: Request) {
  if (openclawIsAbsent()) return refuse("Voice output is not part of this edition.", 409);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", 400);
  }
  const { text: rawText, engine, voice } = (body ?? {}) as Record<string, unknown>;
  const text = cleanText(rawText);
  if (!text) return refuse(`Type something to hear, up to ${SAMPLE_MAX_CHARS} characters.`, 400);
  if (engine !== "local" && engine !== "cloud") return refuse("Pick the voice on this box or the cloud voice.", 400);
  if (inFlight) return refuse("Still speaking the last sample — try again in a moment.", 429);
  inFlight = true;
  try {
    const config = await readConfig();
    return engine === "local"
      ? await speakLocally(config, voice, text)
      : await speakInCloud(config, voice, text);
  } catch (err) {
    console.warn("[setup-api/tts/sample] failed:", err instanceof Error ? err.message : err);
    return refuse("Could not speak that on this box.", 500);
  } finally {
    inFlight = false;
  }
}
