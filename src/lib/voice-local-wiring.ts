/**
 * Wiring the box's own voice into OpenClaw — the `tts-local-cli` provider
 * entry that points the gateway at scripts/openclaw/clawbox-tts.sh.
 *
 * install.sh writes this entry in step_openclaw_tts. It did NOT write it on a
 * box whose speech provider was already something else (the cloud voice the
 * gateway-pre-start seeds, or an owner's own choice): the step preserved the
 * selection and returned before defining the provider. On such a box Kokoro
 * is installed — stamp, unit, plugin all there — yet the Local AI tab's "Make
 * primary" answered "That voice is not available on this box", because the
 * tts route judges the local engine by this entry and the script it names.
 *
 * So the route repairs the wiring itself when the engine is installed and only
 * the entry is missing. The provider JSON is the one install.sh writes, built
 * the same way (the timeout is asked of the script, never copied), so the two
 * writers cannot drift.
 *
 * SERVER ONLY: runs the script and the openclaw CLI.
 */
import path from "path";
import { promises as fs } from "fs";
import { runChild } from "@/lib/child-run";
import { runOpenclawConfigSet } from "@/lib/openclaw-config";
import { LOCAL_TTS_PROVIDER_ID } from "@/lib/voice-output";

/**
 * The entrypoint OpenClaw execs for on-device speech, in the checkout.
 *
 * The checkout root is config-store's rule, restated rather than imported:
 * read at call time, and without a module-scope import of config-store, so
 * the tts route can be loaded under a test that mocks that store narrowly.
 */
export function localTtsScriptPath(): string {
  const root = process.env.CLAWBOX_ROOT || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "scripts", "openclaw", "clawbox-tts.sh");
}

/** Where the speech block lives in openclaw.json — see the tts route's ttsConfigHome(). */
export type TtsConfigHome = "tts" | "messages.tts";

export interface LocalTtsProvider {
  command: string;
  args: string[];
  outputFormat: "wav";
  timeoutMs: number;
}

/** The provider entry, byte-for-byte what install.sh's step_openclaw_tts writes. */
export function buildLocalTtsProvider(command: string, timeoutMs: number): LocalTtsProvider {
  return { command, args: ["--", "{{Text}}", "{{OutputPath}}"], outputFormat: "wav", timeoutMs };
}

/**
 * The provider timeout the script derives from its own engine slices. Asked,
 * not hardcoded: a second copy of the number here is how install.sh once
 * killed the process at the instant Kokoro gave up, with no diagnostic.
 */
export async function readLocalTtsTimeoutMs(script: string = localTtsScriptPath()): Promise<number | null> {
  const run = await runChild("bash", [script, "--provider-timeout-ms"], {
    timeoutMs: 10_000,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/home/clawbox" },
  });
  if (run.code !== 0) return null;
  // Decimal digits only, positive, a safe integer: `1.5` and `100ms` are not
  // timeouts, and `0` would let OpenClaw kill the script at once. The same
  // rule install.sh's helper applies, so both writers refuse the same output.
  const raw = run.stdout.trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type WireLocalVoiceResult =
  | { ok: true; provider: LocalTtsProvider }
  | { ok: false; reason: "script_missing" | "no_timeout" | "write_failed" };

/**
 * Write the `tts-local-cli` provider entry so the gateway can speak through
 * the script. Never points OpenClaw at a command that is not there — that is
 * the silent failure the whole entry exists to avoid — and never selects the
 * provider: selection stays the tts route's decision.
 */
export async function wireLocalVoice(home: TtsConfigHome, script: string = localTtsScriptPath()): Promise<WireLocalVoiceResult> {
  try {
    await fs.access(script, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "script_missing" };
  }
  const timeoutMs = await readLocalTtsTimeoutMs(script);
  if (timeoutMs === null) return { ok: false, reason: "no_timeout" };
  const provider = buildLocalTtsProvider(script, timeoutMs);
  try {
    await runOpenclawConfigSet([`${home}.providers.${LOCAL_TTS_PROVIDER_ID}`, JSON.stringify(provider), "--json"]);
  } catch (err) {
    console.warn("[voice-local-wiring] could not write the local voice provider:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, provider };
}
