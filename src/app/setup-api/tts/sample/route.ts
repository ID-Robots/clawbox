export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { openclawIsAbsent, readConfig } from "@/lib/openclaw-config";
import {
  cloudCredentialIsUnusable,
  cloudProviderIdFor,
  cloudVoiceFrom,
  localCommandPath,
  type VoiceConfigView,
} from "@/lib/voice-output";
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
 * OpenAI-compatible speech route OpenClaw posts to, with the same credential.
 *
 * The text is spoken and forgotten: never logged, never written to state.
 */

const LOCAL_TIMEOUT_MS = 90_000;
const CLOUD_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_MODEL = "gpt-4o-mini-tts";
/** Below this a WAV is a header and nothing else — the script's own floor. */
const MIN_AUDIO_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no sound and can break a command line.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > SAMPLE_MAX_CHARS) return null;
  return text;
}

function runLocal(command: string, voice: string, text: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // `--` ends the options, so a sentence that starts with a dash is text.
    const child = spawn(command, ["--voice", voice, "--", text, outputPath], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { HOME: os.homedir(), ...process.env },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("The voice on this box took too long."));
    }, LOCAL_TIMEOUT_MS);
    child.stderr?.on("data", () => { /* reasons are the script's business; the outcome is the file */ });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function speakLocally(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
  const command = localCommandPath(config);
  if (!command) {
    return NextResponse.json({ error: "No voice is installed on this box." }, { status: 409, headers: NO_STORE });
  }
  const voice = isLocalVoice(requestedVoice) ? requestedVoice : (await readLocalVoice()) ?? DEFAULT_LOCAL_VOICE;
  const outputPath = path.join(os.tmpdir(), `clawbox-voice-sample-${crypto.randomBytes(6).toString("hex")}.wav`);
  try {
    const ok = await runLocal(command, voice, text, outputPath);
    const audio = ok ? await fs.readFile(outputPath).catch(() => null) : null;
    if (!audio || audio.byteLength < MIN_AUDIO_BYTES) {
      return NextResponse.json({ error: "The voice on this box could not speak that." }, { status: 502, headers: NO_STORE });
    }
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", ...NO_STORE } });
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

interface CloudEntry { apiKey?: unknown; baseUrl?: unknown; model?: unknown }

function cloudEntry(config: VoiceConfigView, providerId: string): CloudEntry {
  const providers = config.messages?.tts?.providers;
  const entry = providers && typeof providers === "object" ? (providers as Record<string, CloudEntry | undefined>)[providerId] : undefined;
  const model = config.models?.providers?.[providerId];
  const pick = (key: "apiKey" | "baseUrl") => {
    const direct = entry?.[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const fallback = model?.[key];
    return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
  };
  return { apiKey: pick("apiKey"), baseUrl: pick("baseUrl"), model: typeof entry?.model === "string" ? entry.model : null };
}

async function speakInCloud(config: VoiceConfigView, requestedVoice: unknown, text: string): Promise<Response> {
  const providerId = cloudProviderIdFor(config);
  const entry = providerId ? cloudEntry(config, providerId) : null;
  if (!providerId || !entry?.apiKey || !entry.baseUrl || cloudCredentialIsUnusable(config, providerId)) {
    return NextResponse.json({ error: "The cloud voice is not set up on this box." }, { status: 409, headers: NO_STORE });
  }
  const voice = isCloudVoice(requestedVoice) ? requestedVoice : cloudVoiceFrom(config);
  const base = String(entry.baseUrl).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: entry.model || DEFAULT_CLOUD_MODEL, input: text, voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "The cloud voice did not answer." }, { status: 502, headers: NO_STORE });
  }
  if (!res.ok) {
    return NextResponse.json({ error: `The cloud voice refused (HTTP ${res.status}).` }, { status: 502, headers: NO_STORE });
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength < MIN_AUDIO_BYTES) {
    return NextResponse.json({ error: "The cloud voice sent no audio." }, { status: 502, headers: NO_STORE });
  }
  const type = res.headers.get("content-type")?.split(";")[0].trim();
  return new Response(audio, { headers: { "Content-Type": type?.startsWith("audio/") ? type : "audio/mpeg", ...NO_STORE } });
}

/**
 * One sample at a time. Two local syntheses at once would fight over the GPU
 * on an 8 GB board, and the second press is almost always the first one heard
 * as "nothing happened".
 */
let inFlight = false;

export async function POST(req: Request) {
  if (openclawIsAbsent()) {
    return NextResponse.json({ error: "Voice output is not part of this edition." }, { status: 409, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }
  const { text: rawText, engine, voice } = (body ?? {}) as Record<string, unknown>;
  const text = cleanText(rawText);
  if (!text) {
    return NextResponse.json({ error: `Type something to hear, up to ${SAMPLE_MAX_CHARS} characters.` }, { status: 400, headers: NO_STORE });
  }
  if (engine !== "local" && engine !== "cloud") {
    return NextResponse.json({ error: "Pick the voice on this box or the cloud voice." }, { status: 400, headers: NO_STORE });
  }
  if (inFlight) {
    return NextResponse.json({ error: "Still speaking the last sample — try again in a moment." }, { status: 429, headers: NO_STORE });
  }
  inFlight = true;
  try {
    const config = await readConfig();
    return engine === "local"
      ? await speakLocally(config, voice, text)
      : await speakInCloud(config, voice, text);
  } catch (err) {
    console.warn("[setup-api/tts/sample] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not speak that on this box." }, { status: 500, headers: NO_STORE });
  } finally {
    inFlight = false;
  }
}
