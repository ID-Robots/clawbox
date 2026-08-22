/**
 * The local-model inventory behind Settings → Local Models.
 *
 * Everything here is a MEASUREMENT of the device, never a claim from a config
 * file. That is the whole point of the tab: `install.sh` printed "On-device TTS
 * configured (Kokoro GPU, Piper fallback)" on boxes where Kokoro had never been
 * installed, and nothing in the UI could contradict it (TASK-420). So an engine
 * is "installed" only when the artefact it needs is on disk, and "running" only
 * when systemd or the process table says so.
 *
 * The paths and unit names below are the ones `scripts/install-voice.sh`
 * actually writes; `src/tests/unit/local-models-installer-contract.test.ts`
 * reads that script and fails if they drift apart.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

export type ModelKind = "llm" | "tts" | "stt" | "embedding";

/**
 * How a customer may act on the engine.
 *  - "user-unit"   : a systemd --user unit; the web server can toggle it itself
 *  - "system-unit" : a system unit reachable through the scoped sudoers grants
 *  - "none"        : nothing to toggle (on-demand binaries, or not installed)
 */
export type ControlKind = "none" | "user-unit" | "system-unit";

/**
 * Deliberately NOT a boolean. "Not installed" and "installed but idle" are
 * different facts and the tab must not collapse them — a crashed or absent
 * model reading as merely "off" is the failure this task exists to remove.
 */
export type RunState = "running" | "idle" | "on-demand" | "not-installed";

export interface LocalModelEntry {
  id: string;
  name: string;
  kind: ModelKind;
  /** What supplies it, shown as the subtitle: "systemd user service", "Ollama"… */
  runtime: string;
  installed: boolean;
  /** null when the engine has no unit, so "enabled" is not a meaningful question. */
  enabled: boolean | null;
  running: RunState;
  /** Bytes on disk for the model artefacts, or null when nothing was found. */
  diskBytes: number | null;
  /** Resident bytes of the engine's processes right now, null when not running. */
  memoryBytes: number | null;
  control: ControlKind;
  /** One line the customer can act on. Never a command line, never a path. */
  detail: string;
  /** Settings section or app that owns this engine's deeper controls. */
  managedBy?: "clawkeep" | "localAi";
}

export interface LocalModelsSnapshot {
  models: LocalModelEntry[];
  /** Engines whose state could not be read at all, by id. */
  unavailable: string[];
}

const HOME = process.env.CLAWBOX_HOME || os.homedir() || "/home/clawbox";

/** Paths written by scripts/install-voice.sh — see the contract test. */
export const PIPER_DIR = path.join(HOME, ".local/share/piper");
export const PIPER_BINARY = path.join(PIPER_DIR, "piper");
export const PIPER_VOICE_DIR = path.join(PIPER_DIR, "voices");
export const KOKORO_STAMP = path.join(HOME, ".cache/clawbox/kokoro-installed");
export const SYSTEMD_USER_DIR = path.join(HOME, ".config/systemd/user");
export const KOKORO_UNIT = "kokoro-server.service";
export const WHISPER_UNIT = "whisper-server.service";
export const OLLAMA_UNIT = "ollama.service";

/** Units this module is ever allowed to name to systemctl. */
const USER_UNITS = new Set([KOKORO_UNIT, WHISPER_UNIT]);
const SYSTEM_UNITS = new Set([OLLAMA_UNIT]);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirBytes(dir: string): Promise<number | null> {
  let total = 0;
  let sawAnything = false;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          total += st.size;
          sawAnything = true;
        } catch {
          /* a file that vanished mid-scan is not a failure */
        }
      }
    }
  };
  await walk(dir, 0);
  return sawAnything ? total : null;
}

async function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout });
    return stdout;
  } catch (err) {
    // systemctl exits non-zero for "inactive"/"disabled" and still prints the
    // word we want, so a failure with usable stdout is a real answer.
    const out = (err as { stdout?: string })?.stdout;
    return typeof out === "string" && out.trim() ? out : null;
  }
}

function userSystemctlEnv(): NodeJS.ProcessEnv {
  // A `--user` call from a system service has no bus address unless we point it
  // at the user's runtime dir; without this every answer is "Failed to connect".
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
  };
}

async function runUserSystemctl(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/systemctl", ["--user", ...args], {
      timeout: 5000,
      env: userSystemctlEnv(),
    });
    return stdout;
  } catch (err) {
    const out = (err as { stdout?: string })?.stdout;
    return typeof out === "string" && out.trim() ? out : null;
  }
}

export interface UnitState {
  /** The unit file exists at all. */
  present: boolean;
  active: boolean;
  enabled: boolean;
}

export async function readUnitState(unit: string, scope: "user" | "system"): Promise<UnitState> {
  const isActive = scope === "user"
    ? await runUserSystemctl(["is-active", unit])
    : await run("/usr/bin/systemctl", ["is-active", unit]);
  const isEnabled = scope === "user"
    ? await runUserSystemctl(["is-enabled", unit])
    : await run("/usr/bin/systemctl", ["is-enabled", unit]);
  const enabledWord = (isEnabled ?? "").trim();
  // `is-enabled` answers with an error string, not a state, when the unit file
  // is missing — that is how "absent" is told apart from "installed but off".
  const present = enabledWord !== "" && !enabledWord.toLowerCase().includes("no such file");
  return {
    present,
    active: (isActive ?? "").trim() === "active",
    enabled: ["enabled", "enabled-runtime", "static", "alias", "indirect"].includes(enabledWord),
  };
}

/** Resident bytes of every process whose command line matches `pattern`. */
export async function processMemoryBytes(pattern: string): Promise<number | null> {
  const out = await run("/usr/bin/pgrep", ["-f", pattern]);
  const pids = (out ?? "").split("\n").map(s => s.trim()).filter(Boolean);
  if (!pids.length) return null;
  let total = 0;
  let sawAny = false;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^VmRSS:\s+(\d+) kB$/m);
      if (m) {
        total += Number(m[1]) * 1024;
        sawAny = true;
      }
    } catch {
      /* the process exited between pgrep and the read */
    }
  }
  return sawAny ? total : null;
}

async function ollamaModels(baseUrl: string): Promise<{ name: string; size: number }[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data?.models) ? data.models : [];
    return list
      .filter((m: unknown): m is { name: string; size: number } =>
        !!m && typeof (m as { name?: unknown }).name === "string")
      .map((m: { name: string; size?: number }) => ({ name: m.name, size: Number(m.size) || 0 }));
  } catch {
    return null;
  }
}

function shortModelName(name: string): string {
  return name.replace(/:latest$/, "");
}

async function piperEntry(): Promise<LocalModelEntry> {
  const [binary, voiceBytes] = await Promise.all([exists(PIPER_BINARY), dirBytes(PIPER_VOICE_DIR)]);
  const voices = await listVoices();
  // Piper is a binary invoked per utterance, not a server. "idle" would imply
  // something that could be running and isn't; on-demand is the truth.
  const installed = binary && voices.length > 0;
  return {
    id: "piper",
    name: "Piper",
    kind: "tts",
    runtime: "On-demand binary",
    installed,
    enabled: null,
    running: installed ? "on-demand" : "not-installed",
    diskBytes: voiceBytes,
    memoryBytes: null,
    control: "none",
    detail: installed
      ? `Speaks on demand. ${voices.length} voice${voices.length === 1 ? "" : "s"} installed: ${voices.join(", ")}.`
      : binary
        ? "The Piper program is installed but no voice is, so it cannot speak yet."
        : "Not installed on this box.",
  };
}

async function listVoices(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PIPER_VOICE_DIR);
    return entries.filter(f => f.endsWith(".onnx")).map(f => f.replace(/\.onnx$/, "")).sort();
  } catch {
    return [];
  }
}

async function kokoroEntry(): Promise<LocalModelEntry> {
  const [stamped, unit] = await Promise.all([
    exists(KOKORO_STAMP),
    readUnitState(KOKORO_UNIT, "user"),
  ]);
  // BOTH have to be true. The weights alone are not an installation: on the
  // loop's own test box the 82M Kokoro weights sit in the HuggingFace cache
  // from a run that failed afterwards, with no unit and no stamp. Reporting
  // that as installed is precisely the lie this tab removes.
  const installed = stamped && unit.present;
  const memoryBytes = unit.active ? await processMemoryBytes("kokoro-server.py") : null;
  return {
    id: "kokoro",
    name: "Kokoro",
    kind: "tts",
    runtime: "systemd user service",
    installed,
    enabled: installed ? unit.enabled : null,
    running: !installed ? "not-installed" : unit.active ? "running" : "idle",
    diskBytes: null,
    memoryBytes,
    control: installed ? "user-unit" : "none",
    detail: installed
      ? unit.active
        ? "Running as the GPU voice."
        : "Installed and stopped."
      : stamped
        ? "Marked as installed but its service is missing, so it cannot speak."
        : "Not installed on this box. Speech falls back to Piper.",
  };
}

async function whisperEntry(): Promise<LocalModelEntry> {
  const unit = await readUnitState(WHISPER_UNIT, "user");
  const memoryBytes = unit.active ? await processMemoryBytes("whisper-server.py") : null;
  return {
    id: "whisper",
    name: "Whisper",
    kind: "stt",
    runtime: "systemd user service",
    installed: unit.present,
    enabled: unit.present ? unit.enabled : null,
    running: !unit.present ? "not-installed" : unit.active ? "running" : "idle",
    diskBytes: null,
    memoryBytes,
    control: unit.present ? "user-unit" : "none",
    detail: unit.present
      ? unit.active
        ? "Running and ready to transcribe."
        : "Installed and stopped. It starts on demand when you speak."
      : "Not installed on this box. Speech is transcribed in the cloud.",
  };
}

async function ollamaEntry(baseUrl: string): Promise<LocalModelEntry> {
  const unit = await readUnitState(OLLAMA_UNIT, "system");
  const models = unit.active ? await ollamaModels(baseUrl) : null;
  const memoryBytes = unit.active ? await processMemoryBytes("ollama") : null;
  const diskBytes = models?.length ? models.reduce((sum, m) => sum + m.size, 0) : null;
  const names = (models ?? []).map(m => shortModelName(m.name));
  return {
    id: "ollama",
    name: "Ollama",
    kind: "llm",
    runtime: "System service",
    installed: unit.present,
    enabled: unit.present ? unit.enabled : null,
    running: !unit.present ? "not-installed" : unit.active ? "running" : "idle",
    diskBytes,
    memoryBytes,
    control: unit.present ? "system-unit" : "none",
    detail: !unit.present
      ? "Not installed on this box."
      : !unit.active
        ? "Installed and stopped."
        : names.length
          ? `Serving ${names.length} model${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`
          : "Running with no models pulled yet.",
  };
}

interface LlamaCppProbe {
  installed: boolean;
  running: boolean;
  model: string | null;
}

async function llamaCppEntry(probe: LlamaCppProbe): Promise<LocalModelEntry> {
  const memoryBytes = probe.running ? await processMemoryBytes("llama-server") : null;
  return {
    id: "llamacpp",
    name: probe.model ? `Local LLM (${probe.model})` : "Local LLM",
    kind: "llm",
    runtime: "llama.cpp",
    installed: probe.installed,
    enabled: null,
    running: !probe.installed ? "not-installed" : probe.running ? "running" : "idle",
    diskBytes: null,
    memoryBytes,
    control: "none",
    managedBy: "localAi",
    detail: !probe.installed
      ? "Not installed on this box."
      : probe.running
        ? "Answering on the box right now."
        : "Installed and in standby to free memory until it is needed.",
  };
}

interface EmbeddingProbe {
  available: boolean;
  provider: string | null;
  model: string | null;
  local: boolean;
}

/**
 * `engines` are the rows already built, so the embedding row can be checked
 * against the thing that actually serves it.
 *
 * This matters: ClawKeep's memory status answers `available: true, health:
 * healthy` from the index and the configured provider, NOT from a live embed
 * call — verified on a box where Ollama had been stopped and it still said
 * healthy. Passing that straight through would put "Embedding your memory on
 * the box" one row below "Ollama — Stopped", which is precisely the
 * "must not read as available" case this tab exists to remove.
 */
function embeddingEntry(probe: EmbeddingProbe, engines: LocalModelEntry[]): LocalModelEntry {
  const providerId = probe.provider ? probe.provider.toLowerCase() : null;
  const host = providerId ? engines.find(e => e.id === providerId) : undefined;
  const hostStopped = !!host && host.running !== "running" && host.running !== "on-demand";
  const running: RunState = !probe.available
    ? "not-installed"
    : hostStopped
      ? "idle"
      : probe.local ? "running" : "on-demand";
  return {
    id: "embeddings",
    name: probe.model ? `Memory embeddings (${probe.model})` : "Memory embeddings",
    kind: "embedding",
    runtime: probe.provider ?? "unknown",
    installed: probe.available,
    enabled: null,
    running,
    diskBytes: null,
    memoryBytes: null,
    control: "none",
    managedBy: "clawkeep",
    detail: !probe.available
      ? "No embedding model is answering, so memory search cannot run."
      : hostStopped
        ? `${host?.name ?? "Its engine"} is stopped, so memory cannot be embedded until you turn it back on.`
        : probe.local
          ? "Embedding your memory on the box. Manage it in ClawKeep."
          : "Embedding your memory in the cloud. Manage it in ClawKeep.",
  };
}

export interface InventoryProbes {
  ollamaBaseUrl: string;
  llamacpp: LlamaCppProbe;
  embeddings: EmbeddingProbe;
}

/**
 * Build the inventory. Every entry is produced independently so one engine that
 * cannot be read never costs the customer the whole tab — the same failure mode
 * a subordinate panel caused in ClawKeep on TASK-398.
 */
export async function buildLocalModelInventory(probes: InventoryProbes): Promise<LocalModelsSnapshot> {
  // Order matters for one reason only: the embedding row is checked against the
  // engine that serves it, so that engine's row has to exist by then.
  const builders: [string, (built: LocalModelEntry[]) => Promise<LocalModelEntry>][] = [
    ["llamacpp", () => llamaCppEntry(probes.llamacpp)],
    ["ollama", () => ollamaEntry(probes.ollamaBaseUrl)],
    ["kokoro", kokoroEntry],
    ["piper", piperEntry],
    ["whisper", whisperEntry],
    ["embeddings", async built => embeddingEntry(probes.embeddings, built)],
  ];
  const models: LocalModelEntry[] = [];
  const unavailable: string[] = [];
  for (const [id, build] of builders) {
    try {
      models.push(await build(models));
    } catch {
      unavailable.push(id);
    }
  }
  return { models, unavailable };
}

export interface ToggleResult {
  ok: boolean;
  error?: string;
}

/**
 * Turn an engine on or off for good: `--now` so the change takes effect
 * immediately, and enable/disable so it survives a reboot. TASK-435 asked
 * whether "disable" should mean stop now or stop at next boot; doing both is
 * the only answer under which neither reading is violated.
 */
export async function setEngineEnabled(
  unit: string,
  scope: "user" | "system",
  enabled: boolean,
): Promise<ToggleResult> {
  const allowed = scope === "user" ? USER_UNITS : SYSTEM_UNITS;
  if (!allowed.has(unit)) return { ok: false, error: "Unknown service." };
  const verb = enabled ? "enable" : "disable";
  try {
    if (scope === "user") {
      await execFileAsync("/usr/bin/systemctl", ["--user", verb, "--now", unit], {
        timeout: 30_000,
        env: userSystemctlEnv(),
      });
    } else {
      // sudo is scoped per exact argument list in config/clawbox-sudoers, so the
      // verb and the unit are literals here, never interpolated user input.
      await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", verb, "--now", unit], {
        timeout: 30_000,
      });
    }
    return { ok: true };
  } catch (err) {
    // Never surface the command line: it carries absolute paths, and scope 10
    // of the parent epic forbids that reaching the customer.
    const raw = err instanceof Error ? err.message : "";
    const denied = /sudo|password|not allowed|permission/i.test(raw);
    return {
      ok: false,
      error: denied
        ? "This box does not allow the web interface to change that service."
        : `Could not ${verb} the service.`,
    };
  }
}

/** The unit and scope a toggleable engine maps to, or null when it has none. */
export function unitForEngine(id: string): { unit: string; scope: "user" | "system" } | null {
  if (id === "kokoro") return { unit: KOKORO_UNIT, scope: "user" };
  if (id === "whisper") return { unit: WHISPER_UNIT, scope: "user" };
  if (id === "ollama") return { unit: OLLAMA_UNIT, scope: "system" };
  return null;
}
