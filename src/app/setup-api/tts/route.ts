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
  PIPER_BINARY,
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
  failedVoiceCheck,
  isVoiceChoice,
  localCommandPath,
  parseVoiceCheck,
  providerIdForChoice,
  selectionError,
  type LocalVoiceProbe,
  type VoiceOutputStatus,
} from "@/lib/voice-output";
import { readVoiceState, writeVoiceState } from "@/lib/voice-output-store";

/**
 * GET  /setup-api/tts            → who speaks for this box, and who actually did
 * POST /setup-api/tts {select}   → pick Auto / On this box / ClawBox cloud
 * POST /setup-api/tts {check}    → synthesise a real phrase and record the result
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

async function status(): Promise<VoiceOutputStatus> {
  const [config, state] = await Promise.all([readConfig(), readVoiceState()]);
  const models = await buildTtsInventory();
  const command = localCommandPath(config);
  // The provider entry names a script; if that script is gone the box cannot
  // speak locally however healthy the voices look. Fall back to the installer's
  // own artefacts when no command is configured at all.
  const commandPresent = command
    ? await exists(command)
    : (await exists(PIPER_BINARY)) || (await exists(KOKORO_STAMP));
  return buildVoiceOutputStatus(config, localProbeFrom(config, models, commandPresent), state);
}

export async function GET() {
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

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const action = (body as { action?: unknown })?.action;

  if (action === "check") {
    const state = await readVoiceState();
    const check = await runCheck();
    await writeVoiceState(applyCheck(state, check));
    return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
  }

  if (action !== "select") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const choice = (body as { choice?: unknown })?.choice;
  if (!isVoiceChoice(choice)) {
    return NextResponse.json({ error: "Pick Auto, this box, or ClawBox cloud." }, { status: 400 });
  }

  const before = await status();
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
    try {
      await runOpenclawConfigSet(["messages.tts.provider", providerId]);
    } catch (err) {
      console.warn("[setup-api/tts] could not set the speech provider:", err);
      return NextResponse.json({ error: "Could not change the voice on this box." }, { status: 500 });
    }
  }

  const state = await readVoiceState();
  await writeVoiceState({ ...state, choice });
  return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
}
