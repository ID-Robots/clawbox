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
import path from "./runtime-path";
import crypto from "crypto";
import { runChild } from "./child-run";
import { createSerialLock } from "./serial-lock";
import { sanitizeErrorMessage } from "./safe-error-text";
import { getActiveHarness } from "./harness";
import { speakWithHermes } from "./hermes-tts";
import { buildTtsInventory, KOKORO_STAMP } from "./local-models";
import { readVoiceConfig } from "./voice-box";
import { buildVoiceOutputStatus, cloudSpeechTarget, localCommandPath, cloudVoiceFrom, resolvePreferredEngine, type LocalVoiceProbe, type VoiceConfigView, type VoiceEngine, type VoiceEngineId } from "./voice-output";
import { readLocalVoice, readVoiceState } from "./voice-output-store";
import { DEFAULT_LOCAL_VOICE, isCloudVoiceFor, isLocalVoice } from "./voice-catalog";
import { compressSpeech } from "./tts-compress";
import { MIN_WAV_BYTES, minAudioBytesFor, REPLY_FORMAT_MIME, sniffAudioMime, type ReplyAudioFormat } from "./voice-reply-format";

const NO_STORE = { "Cache-Control": "no-store" };

export function refuse(error: string, code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, code, ...extra }, { status, headers: NO_STORE });
}

const LOCAL_TIMEOUT_MS = 90_000;
/**
 * How long one cloud request may take to answer AT ALL — its response headers.
 * An OpenAI-compatible speech route streams: the headers leave as soon as the
 * synthesis has started, long before the last byte. A server that accepted the
 * connection and has said nothing after this long is not going to; the chat
 * used to show "Speaking the reply…" for a whole minute over exactly that.
 */
export const CLOUD_FIRST_BYTE_TIMEOUT_MS = 10_000;
/**
 * One cloud request, from asking to its last byte. Once the headers are in,
 * the body has whatever is left of this: room for the longest reply the chat
 * sends (SPEECH_MAX_CHARS, a minute and a half of speech), and still an end to
 * a stream that stalls halfway.
 */
export const CLOUD_RESPONSE_TIMEOUT_MS = 45_000;
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini-tts";

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
    // The script only ever writes WAV; a reply is compressed after the chain
    // (`inReplyFormat`), so this floor is the WAV one.
    if (!audio || audio.byteLength < MIN_WAV_BYTES) {
      if (run.timedOut) return refuse("The voice on this box took too long.", "local_timeout", 502);
      return localRefusal(run.stderr);
    }
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": REPLY_FORMAT_MIME.wav, ...NO_STORE } });
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

/** `<base>/audio/speech`, or null when the base is not https or loopback http. */
function speechEndpoint(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return `${url.origin}${url.pathname.replace(/\/$/, "")}/audio/speech`;
}

/**
 * A refusal that says "not that format" rather than "not you" or "not now".
 * Opus is in OpenAI's own list, but an OpenAI-compatible proxy is only bound
 * to its default (MP3); a 401, 403 or 429 would refuse MP3 just the same.
 */
function refusedTheFormat(status: number): boolean {
  return status === 400 || status === 404 || status === 415 || status === 422;
}

/** The cloud did not answer one request. `started`: its headers had come, and the body never finished. */
class CloudSilence extends Error {
  constructor(readonly started: boolean) {
    super(started ? "the cloud voice stopped sending" : "the cloud voice did not answer");
  }
}

/** Rejects once `signal` aborts; never settles otherwise. */
function whenAborted(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // Raced below, and a race that has already settled still owns it; this is
  // for the one path that never reaches a race (a fetch that throws at once).
  aborted.catch(() => {});
  return aborted;
}

type CloudAnswer = { res: Response; audio: Uint8Array<ArrayBuffer> };

/**
 * One request to the cloud's speech route, held to both deadlines: its
 * headers within CLOUD_FIRST_BYTE_TIMEOUT_MS, the whole answer within
 * CLOUD_RESPONSE_TIMEOUT_MS. A 2xx comes back with its bytes read; a refusal
 * comes back with none, its body cancelled — only its status is ever used.
 * Throws `CloudSilence` when the cloud did not answer in time or the
 * connection failed.
 *
 * The deadlines are RACED as well as handed to `fetch` as its signal: the
 * signal tears a real request down, and the race makes sure nothing waits on
 * one that does not listen to it.
 */
async function askCloudOnce(endpoint: string, init: RequestInit): Promise<CloudAnswer> {
  const controller = new AbortController();
  const gaveUp = whenAborted(controller.signal);
  const firstByte = setTimeout(() => controller.abort(), CLOUD_FIRST_BYTE_TIMEOUT_MS);
  const whole = setTimeout(() => controller.abort(), CLOUD_RESPONSE_TIMEOUT_MS);
  let started = false;
  try {
    const res = await Promise.race([fetch(endpoint, { ...init, signal: controller.signal }), gaveUp]);
    started = true;
    clearTimeout(firstByte);
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { res, audio: new Uint8Array(0) };
    }
    return { res, audio: new Uint8Array(await Promise.race([res.arrayBuffer(), gaveUp])) };
  } catch {
    controller.abort();
    throw new CloudSilence(started);
  } finally {
    clearTimeout(firstByte);
    clearTimeout(whole);
  }
}

/**
 * Speak `text` with the cloud voice, in `format`.
 *
 * WAV unless told otherwise, and the audition never tells it otherwise: an
 * audition is one short clip on a click, so the bytes are cheap — and PCM is
 * the one format no browser can decline to decode, which an audition of a
 * voice must never be lost to. A REPLY asks for the compressed format the chat
 * said it can play (src/lib/voice-reply-format.ts), so the cloud does the
 * compressing and nothing is transcoded on the box.
 *
 * A cloud that does not answer is given up on quickly, and said so
 * (`cloud_no_answer`): the chat shows "Speaking the reply…" for exactly as
 * long as this takes, and a server that took the connection and sent nothing
 * used to hold that line for a silent minute. Each request has to start
 * answering within CLOUD_FIRST_BYTE_TIMEOUT_MS and finish within
 * CLOUD_RESPONSE_TIMEOUT_MS (askCloudOnce); one that never answered at all is
 * asked again ONCE, for the whole call. Worst case, then: at most three
 * requests — the one asked for, the single retry, and the MP3 one a refused
 * Opus earns — of which only the last can run past its headers, since a
 * refusal ends at its headers and an answer that started is never asked
 * again. That is at most 2 × 10 s + 45 s = 65 s, against 2 × 60 s before; a
 * cloud that never answers is given up on after 2 × 10 s = 20 s.
 */
export async function speakInCloud(
  config: VoiceConfigView,
  requestedVoice: unknown,
  text: string,
  format: ReplyAudioFormat = "wav",
): Promise<Response> {
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
  // The endpoint is the box's own configuration, but it is still checked
  // before a credential goes to it: https, or plain http on the loopback
  // only — the same rule the coding harness applies to its proxy URL.
  const endpoint = speechEndpoint(target.baseUrl);
  if (!endpoint) return refuse("The cloud voice's endpoint is not one this box will send its credential to.", "cloud_not_set_up", 409);
  const request = (responseFormat: ReplyAudioFormat): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json" },
    // WAV for an audition, the reply's own format for a reply — see above.
    body: JSON.stringify({ model: target.model ?? DEFAULT_CLOUD_MODEL, input: text, voice, response_format: responseFormat }),
  });
  // The one retry, shared by every request below so it cannot multiply with
  // the format fallback. Only for a request the cloud never started answering
  // (no headers in time, or the connection failed): a refusal is an answer,
  // and a body that stalled has already had its generous share.
  let retried = false;
  const ask = async (responseFormat: ReplyAudioFormat): Promise<CloudAnswer> => {
    try {
      return await askCloudOnce(endpoint, request(responseFormat));
    } catch (err) {
      if (retried || (err instanceof CloudSilence && err.started)) throw err;
      retried = true;
      return await askCloudOnce(endpoint, request(responseFormat));
    }
  };
  let answer: CloudAnswer;
  let asked = format;
  try {
    answer = await ask(format);
    // A proxy that does not do Opus is asked once more for MP3, which every
    // browser plays and every OpenAI-compatible speech route must serve.
    if (!answer.res.ok && format === "opus" && refusedTheFormat(answer.res.status)) {
      asked = "mp3";
      answer = await ask(asked);
    }
  } catch {
    return refuse("The cloud voice did not answer.", "cloud_no_answer", 502);
  }
  const { res, audio } = answer;
  if (!res.ok) return refuse(`The cloud voice refused (HTTP ${res.status}).`, "cloud_refused", 502, { status: res.status });
  // Labelled by what the bytes ARE, then by what the cloud said, then by what
  // was asked for: a proxy that ignored `response_format` still gets the
  // player the right type, and the floor for the format it actually sent.
  const stated = res.headers.get("content-type")?.split(";")[0].trim();
  const type = sniffAudioMime(audio) ?? (stated?.startsWith("audio/") ? stated : REPLY_FORMAT_MIME[asked]);
  if (audio.byteLength < minAudioBytesFor(type)) return refuse("The cloud voice sent no audio.", "cloud_no_audio", 502);
  return new Response(audio, { headers: { "Content-Type": type, ...NO_STORE } });
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
/**
 * Every synthesis ADMITTED and not yet finished — the one speaking and the
 * ones behind it. Counted at admission, before the serial lock schedules
 * anything, so a burst of simultaneous asks is judged by what was admitted
 * and not by an in-flight flag that none of them has set yet.
 */
let admitted = 0;
/** One speaking, plus this many waiting. */
const MAX_WAITING = 3;

async function asTheOneSynthesis(work: () => Promise<Response>): Promise<Response> {
  admitted += 1;
  try {
    return await speechQueue(work);
  } finally {
    admitted -= 1;
  }
}

/** Run `work` as the one synthesis; answers 429 `busy` when anything is speaking or waiting to. */
export async function withSpeechLock(work: () => Promise<Response>): Promise<Response> {
  if (admitted > 0) return refuse("Still speaking the last sample — try again in a moment.", "busy", 429);
  return asTheOneSynthesis(work);
}

/** Run `work` as the one synthesis once the ones before it are done; 429 `busy` only when the queue is full. */
export async function withSpeechQueue(work: () => Promise<Response>): Promise<Response> {
  if (admitted > MAX_WAITING) return refuse("The box is still speaking earlier replies — try again in a moment.", "busy", 429);
  return asTheOneSynthesis(work);
}

/** For tests: how many syntheses are admitted right now. */
export function admittedSyntheses(): number {
  return admitted;
}

/**
 * Speak a reply through the chain: the engine the Voice tab put first, then
 * the other, so a box whose cloud voice is down still answers from itself
 * and a box whose Kokoro is cold still answers quickly. The answer names the
 * engine that spoke in `X-ClawBox-Voice-Engine`; when neither could, the
 * PRIMARY's refusal is the one returned — that is the engine the owner
 * chose, and its message names their next step.
 */
export type Speaker = (config: VoiceConfigView, requestedVoice: unknown, text: string, format?: ReplyAudioFormat) => Promise<Response>;

export async function speakThroughChain(
  config: VoiceConfigView,
  engines: VoiceEngine[],
  choice: "auto" | "local" | "cloud",
  text: string,
  speakers: Record<VoiceEngineId, Speaker> = { local: speakLocally, cloud: speakInCloud },
  format: ReplyAudioFormat = "wav",
): Promise<Response> {
  const preferred = resolvePreferredEngine(choice, engines);
  const order: VoiceEngineId[] = preferred
    ? [preferred, ...(["local", "cloud"] as VoiceEngineId[]).filter((id) => id !== preferred)]
    : ["cloud", "local"];
  const usable = order.filter((id) => engines.some((e) => e.id === id && e.configured));
  if (usable.length === 0) return refuse("This box has no voice it can use.", "no_voice", 409);
  let first: Response | null = null;
  for (const engine of usable) {
    const res = await speakers[engine](config, null, text, format);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set("X-ClawBox-Voice-Engine", engine);
      return new Response(res.body, { status: res.status, headers });
    }
    first ??= res;
  }
  return first ?? refuse("Could not speak that on this box.", "failed", 500);
}

/**
 * Speak a reply with whatever engine this box can speak with right now.
 *
 * The assembly that used to sit inside `POST /setup-api/tts/speak`: read what
 * the box has, work out which engines are configured, and hand the text to the
 * chain. It moved here because a SECOND caller needed exactly it — the coding
 * agent's `generate_audio`, which writes a clip into a run's project — and the
 * two must not be able to synthesise differently: a run whose narration came
 * out in a different voice from the chat's spoken replies would be a fault
 * nobody could see until they heard it.
 *
 * What is deliberately NOT here is the two gates the speak route keeps: its
 * same-origin check and the owner's spoken-replies switch. Both are about the
 * CHAT — "does the owner want the box talking back" — and neither is the right
 * question to ask of a file being written into a project folder, which has its
 * own switch.
 *
 * The caller decides whether to queue (`withSpeechQueue`) or refuse while the
 * box is already speaking (`withSpeechLock`); this does neither.
 *
 * `speakers` is the same injection point `speakThroughChain` already offers,
 * passed through so a test can watch the ORDER the engines are tried in
 * without a real script or a real cloud key. Nothing on the box passes it.
 *
 * `format` is what the CHAT's reply travels in (`tts/speak`, from what the
 * browser said it can play — src/lib/voice-reply-format.ts): the cloud is
 * asked for it directly, and a WAV from any engine is compressed into it on
 * the way out (`inReplyFormat`). Absent, the engines answer as they always
 * have — which is what `generate_audio` wants: it names its own file and
 * checks the bytes against the extension the run asked for.
 *
 * Never throws: every failure is one of this module's own `refuse()`
 * responses, so a caller can relay the code and the sentence as they are.
 */
export async function speakReply(
  text: string,
  speakers?: Record<VoiceEngineId, Speaker>,
  { format }: { format?: ReplyAudioFormat } = {},
): Promise<Response> {
  try {
    // On a box running Hermes the reply is spoken by Hermes' own speech route,
    // with the provider the Voice tab wrote — the same voice its channel
    // replies would have, and not necessarily a WAV.
    if ((await getActiveHarness()) === "hermes") {
      const spoken = await speakWithHermes(text);
      if (!spoken.ok) return refuse("Could not speak that on this box.", spoken.code, spoken.status, spoken.reason ? { reason: spoken.reason } : {});
      const answer = new Response(spoken.audio, { headers: { "Content-Type": spoken.mime, ...NO_STORE } });
      return format ? await inReplyFormat(answer, format) : answer;
    }
    // Through the plan, like the Voice panel: a plan on record without the
    // cloud voice speaks from the box, not through a proxy that refuses it.
    const [config, models, state] = await Promise.all([readVoiceConfig("openclaw"), buildTtsInventory(), readVoiceState()]);
    const installed = models.filter((m) => m.kind === "tts" && m.installed);
    const command = localCommandPath(config);
    const probe: LocalVoiceProbe = {
      providerConfigured: Boolean(command),
      commandPresent: command ? await fileExists(command) : await fileExists(KOKORO_STAMP),
      engineInstalled: installed.length > 0,
      engineNames: installed.map((m) => m.name),
    };
    const status = buildVoiceOutputStatus(config, probe, state);
    const chain = speakers ?? { local: speakLocally, cloud: speakInCloud };
    if (!format) return await speakThroughChain(config, status.engines, state.choice, text, chain);
    return await inReplyFormat(await speakThroughChain(config, status.engines, state.choice, text, chain, format), format);
  } catch (err) {
    console.warn("[voice-speak] speakReply failed:", err instanceof Error ? err.message : err);
    return refuse("Could not speak that on this box.", "failed", 500);
  }
}

/**
 * A spoken reply in the format it is going out in.
 *
 * A WAV — Kokoro's only output, and whatever a cloud or Hermes provider that
 * ignored the ask sent — is compressed into `format` with ffmpeg; anything
 * else is already as small as its engine made it and passes untouched. The
 * Content-Type is set from the bytes either way, so the player is never told
 * one format and handed another. When the compression cannot happen (no
 * ffmpeg on the box, a missing encoder, a timeout) the WAV goes out as it
 * came: a larger reply, never a lost one. Every other header — the engine
 * that spoke, `no-store` — rides along unchanged. Refusals pass straight
 * through.
 */
export async function inReplyFormat(res: Response, format: ReplyAudioFormat): Promise<Response> {
  if (!res.ok) return res;
  let audio = new Uint8Array(await res.arrayBuffer());
  const stated = res.headers.get("content-type")?.split(";")[0].trim();
  const sniffed = sniffAudioMime(audio);
  let type = sniffed ?? (stated?.startsWith("audio/") ? stated : REPLY_FORMAT_MIME.wav);
  // Only bytes that ARE a WAV go to ffmpeg; a label alone is not worth a spawn.
  if (sniffed === REPLY_FORMAT_MIME.wav && format !== "wav") {
    const compressed = await compressSpeech(audio, format);
    if (compressed) {
      audio = compressed;
      type = REPLY_FORMAT_MIME[format];
    }
  }
  const headers = new Headers(res.headers);
  headers.set("Content-Type", type);
  headers.delete("Content-Length");
  return new Response(audio, { status: res.status, headers });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
