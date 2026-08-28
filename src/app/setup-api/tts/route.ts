export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  buildTtsInventory,
  KOKORO_STAMP,
  type LocalModelEntry,
} from "@/lib/local-models";
import {
  findOpenclawBin,
  openclawIsAbsent,
  readConfig,
  runOpenclawConfigSet,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import {
  applyCheck,
  buildVoiceOutputStatus,
  cloudSpeechTarget,
  forgetEngineCheck,
  failedVoiceCheck,
  isVoiceChoice,
  localCommandPath,
  parseVoiceCheck,
  providerIdForChoice,
  selectionError,
  type LocalVoiceProbe,
  type VoiceChoice,
  type VoiceOutputStatus,
} from "@/lib/voice-output";
import { readLocalVoice, readVoiceState, writeLocalVoice, writeVoiceState } from "@/lib/voice-output-store";
import { isCloudVoice, isLocalVoice, isVoiceLanguage } from "@/lib/voice-catalog";

/**
 * GET  /setup-api/tts            → who speaks for this box, and who actually did
 * POST /setup-api/tts {select}   → pick Auto / On this box / ClawBox cloud
 * POST /setup-api/tts {check}    → synthesise a real phrase and record the result
 * POST /setup-api/tts {voice}    → which voice an engine speaks with
 * POST /setup-api/tts {language} → the sample sentence's language on the Voice tab
 *
 * GET touches only the filesystem. The openclaw CLI costs 8-12 s of cold start
 * on an Orin Nano (see runOpenclawConfigSet's note), which is fine for an
 * explicit button and completely wrong for a panel the customer just opened.
 */

const CHECK_PHRASE = "ClawBox voice check.";
// The on-device chain alone measured 14.9 s on a Nano, and a cloud attempt in
// front of it adds a round trip before it fails over. 30 s would time out a
// working box and report it as broken.
const CHECK_TIMEOUT_MS = 120_000;

function localProbeFrom(config: OpenClawConfig, models: LocalModelEntry[], commandPresent: boolean): LocalVoiceProbe {
  const installedTts = models.filter(m => m.kind === "tts" && m.installed);
  return {
    providerConfigured: Boolean(localCommandPath(config)),
    commandPresent,
    engineInstalled: installedTts.length > 0,
    engineNames: installedTts.map(m => m.name),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function probeBox() {
  const [config, models] = await Promise.all([readConfig(), buildTtsInventory()]);
  const command = localCommandPath(config);
  // The provider entry names a script; if that script is gone the box cannot
  // speak locally however healthy the voices look. Fall back to the installer's
  // own artefacts when no command is configured at all.
  const commandPresent = command
    ? await exists(command)
    : await exists(KOKORO_STAMP);
  return { config, probe: localProbeFrom(config, models, commandPresent) };
}

async function status(): Promise<VoiceOutputStatus> {
  const [{ config, probe }, state, localVoice] = await Promise.all([probeBox(), readVoiceState(), readLocalVoice()]);
  return buildVoiceOutputStatus(config, probe, state, localVoice);
}

/**
 * Every branch below runs through the openclaw CLI — `capability tts convert`
 * for the check, `config set messages.tts.provider` for the selection. The
 * Hermes SKU ships no openclaw binary at all, so the panel offered a Check that
 * spawned nothing and a Select the route then refused with a 409. Say the true
 * thing once, here, instead of letting the customer discover it a button at a
 * time. Same shape ClawKeep reports for the same reason (lib/clawkeep.ts).
 */
const EDITION_UNSUPPORTED = {
  supportedOnEdition: false,
  error: "Voice output is an OpenClaw feature and is not part of this edition.",
} as const;

export async function GET() {
  if (openclawIsAbsent()) {
    return NextResponse.json(EDITION_UNSUPPORTED, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.warn("[setup-api/tts] could not read voice status:", err);
    return NextResponse.json({ error: "Could not read the voice settings." }, { status: 500 });
  }
}

function runVoiceConvert(outputPath: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = findOpenclawBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      "capability", "tts", "convert",
      "--text", CHECK_PHRASE,
      "--output", outputPath,
      "--json",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.env.HOME ?? "/home/clawbox",
      env: { HOME: "/home/clawbox", ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("The voice check took too long and was stopped."));
    }, CHECK_TIMEOUT_MS);
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
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

/**
 * Speak a short phrase through the real chain and record what happened.
 *
 * Deliberately not pinned to one provider: the question the customer is asking
 * is "what happens when my box talks", and the answer includes the fallback.
 * The CLI reports every provider it tried in order, so a cloud primary that
 * fails and an on-device voice that then speaks are both in the record.
 */
async function runCheck() {
  const outputPath = path.join(os.tmpdir(), `clawbox-voice-check-${crypto.randomBytes(6).toString("hex")}.wav`);
  const at = Date.now();
  try {
    const result = await runVoiceConvert(outputPath);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
    if (parsed) return parseVoiceCheck(parsed, at);
    return failedVoiceCheck(result.stderr.trim() || result.stdout.trim(), at);
  } catch (err) {
    return failedVoiceCheck(err instanceof Error ? err.message : null, at);
  } finally {
    // The audio itself is worthless — it exists only to prove a provider
    // produced bytes — and a box that leaves one behind per check fills its
    // own disk.
    await fs.unlink(outputPath).catch(() => {});
  }
}

/**
 * One check at a time, per box.
 *
 * A check spawns a real synthesis that can run for a minute and a half on an
 * Orin. Two of them at once means two engines competing for the same GPU on an
 * 8 GB board, and the client-side busy flag cannot prevent it — a second tab,
 * a reload mid-check or a stray retry all bypass it. Callers join the run in
 * flight instead of starting another.
 */
let checkInFlight: Promise<Awaited<ReturnType<typeof runCheck>>> | null = null;

function currentCheck() {
  if (!checkInFlight) {
    checkInFlight = runCheck().finally(() => { checkInFlight = null; });
  }
  return checkInFlight;
}

async function handleCheck() {
  const check = await currentCheck();
  // Read the state AFTER the run, not before it. A check holds no snapshot
  // across its own 90 seconds: a customer who changes the voice while it is
  // running would otherwise have that choice overwritten by the stale copy this
  // handler started with. The box is probed once and reused, rather than read a
  // third time for a status this function can already assemble.
  const [state, { config, probe }, localVoice] = await Promise.all([readVoiceState(), probeBox(), readLocalVoice()]);
  const next = applyCheck(state, check);
  await writeVoiceState(next);
  return NextResponse.json(buildVoiceOutputStatus(config, probe, next, localVoice), {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Which voice an engine speaks with. The on-device voice is the file the local
 * script reads, so the gateway's next utterance uses it with no restart; the
 * cloud voice is OpenClaw's own `providers.<cloud>.voice`, written the way the
 * provider itself is. Both are validated against the catalogue the engine
 * accepts, so an unknown id is refused here instead of failing at speech time.
 */
async function handleVoice(engine: unknown, voice: unknown) {
  if (engine === "local") {
    if (!isLocalVoice(voice)) {
      return NextResponse.json({ error: "That voice is not on this box." }, { status: 400 });
    }
    await writeLocalVoice(voice);
  } else if (engine === "cloud") {
    if (!isCloudVoice(voice)) {
      return NextResponse.json({ error: "The cloud voice does not have that voice." }, { status: 400 });
    }
    const target = cloudSpeechTarget(await readConfig());
    if (!target) {
      return NextResponse.json({ error: "That voice is not available on this box." }, { status: 409 });
    }
    await runOpenclawConfigSet([`messages.tts.providers.${target.providerId}.voice`, voice]);
  } else {
    return NextResponse.json({ error: "Pick the voice on this box or the cloud voice." }, { status: 400 });
  }
  return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
}

async function handleLanguage(language: unknown) {
  if (!isVoiceLanguage(language)) {
    return NextResponse.json({ error: "That language is not offered." }, { status: 400 });
  }
  await writeVoiceState({ ...(await readVoiceState()), language });
  return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
}

async function handleSelect(choice: VoiceChoice) {
  const { config, probe } = await probeBox();
  const state = await readVoiceState();
  const before = buildVoiceOutputStatus(config, probe, state);

  // Refuse rather than write a primary the box cannot honour, and refuse rather
  // than quietly substitute the other engine: an engine that is not installed
  // must read as not installed, not as a selected option that never speaks.
  const refusal = selectionError(choice, before.engines);
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 409 });
  }
  const providerId = providerIdForChoice(choice, before.engines);
  if (!providerId) {
    return NextResponse.json(
      { error: "That voice is not available on this box." },
      { status: 409 },
    );
  }

  if (providerId !== before.activeProviderId) {
    if (openclawIsAbsent()) {
      return NextResponse.json({ error: "This box cannot change the voice." }, { status: 409 });
    }
    await runOpenclawConfigSet(["messages.tts.provider", providerId]);
  }

  // Picking an engine again is a request to retry it, so this box stops
  // reporting what it observed last time until the next check says otherwise.
  const next = choice === "auto"
    ? { ...state, choice }
    : { ...forgetEngineCheck(state, choice), choice };
  await writeVoiceState(next);
  return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  // Refuse before the body is even read: on this edition there is no binary to
  // spawn, so a check would have burned 120 s waiting on a process that never
  // started and reported a blank reason.
  if (openclawIsAbsent()) {
    return NextResponse.json(EDITION_UNSUPPORTED, { status: 409 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { action, choice, engine, voice, language } = (body ?? {}) as Record<string, unknown>;

  if (action !== "check" && action !== "select" && action !== "voice" && action !== "language") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  if (action === "select" && !isVoiceChoice(choice)) {
    return NextResponse.json({ error: "Pick Auto, this box, or ClawBox cloud." }, { status: 400 });
  }

  // One boundary for every branch. Every step here is filesystem work or a
  // spawn: a full disk, a read-only data dir or a missing CLI must come back as
  // a message the panel can show, not as a framework error page that leaves the
  // box with nothing in its log.
  try {
    if (action === "check") return await handleCheck();
    if (action === "voice") return await handleVoice(engine, voice);
    if (action === "language") return await handleLanguage(language);
    return await handleSelect(choice as VoiceChoice);
  } catch (err) {
    console.warn(`[setup-api/tts] ${action} failed:`, err);
    return NextResponse.json({ error: "Could not change the voice on this box." }, { status: 500 });
  }
}
