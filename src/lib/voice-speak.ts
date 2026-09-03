/**
 * Speaking a sentence with ONE engine, and speaking a reply through the chain.
 *
 * The Voice tab's "hear it" auditions one engine with one voice, deliberately
 * not the fall-through chain: an audition of the cloud voice that quietly
 * played Kokoro would be the wrong answer. A spoken REPLY is the opposite: the
 * owner wants to hear the answer, from whichever engine can speak right now,
 * in the order the Voice tab put them. Both live here so the two routes
 * (`tts/sample`, `tts/speak`) synthesise the same way — the local engine is
 * the same script the gateway runs (`clawbox-tts.sh`, with `--voice`), and the
 * cloud engine is the same OpenAI-compatible speech route OpenClaw posts to,
 * with the same credential (`cloudSpeechTarget`, the rule the status card's
 * "configured" uses).
 *
 * The text is spoken and forgotten: never logged, never written to state.
 *
 * Every refusal carries a stable `code` beside its English `error` (and, for
 * the memory guard, the numbers), so a panel can say it in the owner's
 * language; the sentence stays for whoever reads the JSON directly.
 *
 * SERVER ONLY: runs the script and calls the cloud.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { runChild } from "@/lib/child-run";
import { createSerialLock } from "@/lib/serial-lock";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { cloudSpeechTarget, localCommandPath, cloudVoiceFrom, resolvePreferredEngine, type VoiceConfigView, type VoiceEngine, type VoiceEngineId } from "@/lib/voice-output";
import { readLocalVoice } from "@/lib/voice-output-store";
import { DEFAULT_LOCAL_VOICE, isCloudVoiceFor, isLocalVoice } from "@/lib/voice-catalog";

const NO_STORE = { "Cache-Control": "no-store" };

export function refuse(error: string, code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, code, ...extra }, { status, headers: NO_STORE });
}

const LOCAL_TIMEOUT_MS = 90_000;
const CLOUD_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini-tts";
/** Below this a WAV is a header and nothing else — the script's own floor. */
const MIN_AUDIO_BYTES = 1024;


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

export async function speakLocally(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
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

export async function speakInCloud(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
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
 * One synthesis at a time, box-wide. Two local syntheses at once would fight
 * over the GPU on an 8 GB board. Everything speaks through one queue; the
 * two callers differ in what they do while it is taken:
 *
 *  - an AUDITION (`tts/sample`) is refused at once with 429 `busy` — the
 *    second press of Play is almost always the first one heard as "nothing
 *    happened", and a queued audition would play over the owner's next
 *    click;
 *  - a REPLY (`tts/speak`) WAITS its turn. Two questions spoken back to back
 *    have their replies land seconds apart, inside the window a cold Kokoro
 *    takes for the first, and a reply refused there was simply never heard
 *    (the chat had nothing to show for it either). A queue that piles up
 *    beyond a few replies is refused after all: a box that far behind is
 *    not going to catch up.
 */
const speechQueue = createSerialLock();
let inFlight = false;
let waiting = 0;
const MAX_WAITING = 3;

async function asTheOneSynthesis(work: () => Promise<Response>): Promise<Response> {
  return speechQueue(async () => {
    inFlight = true;
    try {
      return await work();
    } finally {
      inFlight = false;
    }
  });
}

/** Run `work` as the one synthesis; answers 429 `busy` when another is speaking. */
export async function withSpeechLock(work: () => Promise<Response>): Promise<Response> {
  if (inFlight || waiting > 0) return refuse("Still speaking the last sample — try again in a moment.", "busy", 429);
  return asTheOneSynthesis(work);
}

/** Run `work` as the one synthesis once the ones before it are done; 429 `busy` only when the queue is full. */
export async function withSpeechQueue(work: () => Promise<Response>): Promise<Response> {
  // `waiting` counts every reply that has entered the queue, the one being
  // spoken included; the ones actually waiting are the rest.
  const queued = waiting - (inFlight ? 1 : 0);
  if (queued >= MAX_WAITING) return refuse("The box is still speaking earlier replies — try again in a moment.", "busy", 429);
  waiting += 1;
  try {
    return await asTheOneSynthesis(work);
  } finally {
    waiting -= 1;
  }
}

/**
 * Speak a reply through the chain: the engine the Voice tab put first, then
 * the other, so a box whose cloud voice is down still answers from itself
 * and a box whose Kokoro is cold still answers quickly. The answer names the
 * engine that spoke in `X-ClawBox-Voice-Engine`; when neither could, the
 * PRIMARY's refusal is the one returned — that is the engine the owner
 * chose, and its message names their next step.
 */
export type Speaker = (config: VoiceConfigView, requestedVoice: unknown, text: string) => Promise<Response>;

export async function speakThroughChain(
  config: VoiceConfigView,
  engines: VoiceEngine[],
  choice: "auto" | "local" | "cloud",
  text: string,
  speakers: Record<VoiceEngineId, Speaker> = { local: speakLocally, cloud: speakInCloud },
): Promise<Response> {
  const preferred = resolvePreferredEngine(choice, engines);
  const order: VoiceEngineId[] = preferred
    ? [preferred, ...(["local", "cloud"] as VoiceEngineId[]).filter((id) => id !== preferred)]
    : ["cloud", "local"];
  const usable = order.filter((id) => engines.some((e) => e.id === id && e.configured));
  if (usable.length === 0) return refuse("This box has no voice it can use.", "no_voice", 409);
  let first: Response | null = null;
  for (const engine of usable) {
    const res = await speakers[engine](config, null, text);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set("X-ClawBox-Voice-Engine", engine);
      return new Response(res.body, { status: res.status, headers });
    }
    first ??= res;
  }
  return first ?? refuse("Could not speak that on this box.", "failed", 500);
}
