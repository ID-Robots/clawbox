/**
 * The local-model inventory behind Settings → Local Models.
 *
 * Everything here is a MEASUREMENT of the device, never a claim from a config
 * file. That is the whole point of the tab: `install.sh` printed "On-device TTS
 * configured (Kokoro GPU)" on boxes where Kokoro had never been
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
export type RunState =
  | "running"
  | "idle"
  | "on-demand"
  | "not-installed"
  /**
   * The feature is not part of this device's edition, so there is nothing to
   * install and nothing the customer can do. Distinct from "not-installed" on
   * purpose: that one invites a fix, this one says the fix does not exist here.
   */
  | "not-on-this-edition";

/**
 * The machine-readable twin of each `runtime` line. The panel translates it
 * as `localModels.runtime.<code>` with `params` interpolated; the English
 * `runtime` string stays for readers that have no locale (MCP, the CLI).
 */
export type RuntimeCode =
  | "voiceOnBox"
  | "transcribesOnBox"
  | "runsExtraModels"
  | "answersOnBox"
  | "findsInMemory"
  /** "{model} via {via}", "{model}", "via {via}" — whichever facts are known. */
  | "modelVia"
  | "model"
  | "via";

/** The twin of `detail`, translated as `localModels.detail.<code>`. */
export type DetailCode =
  | "kokoroSpeaking" | "kokoroOff" | "kokoroServiceMissing" | "kokoroNotInstalled"
  | "whisperReady" | "whisperOff" | "whisperNotInstalled"
  | "ollamaNotInstalled" | "ollamaOff" | "ollamaStandby" | "ollamaFailed"
  | "ollamaChecking" | "ollamaServing" | "ollamaNoModels"
  | "llamacppNotInstalled" | "llamacppAnswering" | "llamacppReady" | "llamacppOff"
  | "embeddingsNotOnEdition" | "embeddingsOff" | "embeddingsAsleep" | "embeddingsPaused"
  | "embeddingsLocal" | "embeddingsCloud";

export interface LocalModelEntry {
  id: string;
  name: string;
  /**
   * Set only when `name` is a ClawBox feature name rather than a product name
   * ("Memory search"), translated as `localModels.name.<code>`. Gemma, Qwen,
   * Ollama, Kokoro and Whisper are names in every language.
   */
  nameCode?: "memorySearch";
  kind: ModelKind;
  /** What supplies it, shown as the subtitle: "systemd user service", "Ollama"… */
  runtime: string;
  runtimeCode: RuntimeCode;
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
  detailCode: DetailCode;
  /** The names the `runtime` / `detail` codes interpolate: model names, never paths. */
  params?: Record<string, string>;
  /** Settings section or app that owns this engine's deeper controls. */
  managedBy?: "clawkeep" | "localAi";
}

/** `detailCode` + `detail` (+ `params`) for one branch of an entry, spread into it. */
function line(detailCode: DetailCode, detail: string, params?: Record<string, string>) {
  return params ? { detailCode, detail, params } : { detailCode, detail };
}

export interface LocalModelsSnapshot {
  models: LocalModelEntry[];
  /** Engines whose state could not be read at all, by id. */
  unavailable: string[];
}

const HOME = process.env.CLAWBOX_HOME || os.homedir() || "/home/clawbox";

/** Paths written by scripts/install-voice.sh — see the contract test. */
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
  /** `is-active` says "failed": it exited with an error, it is not merely stopped. */
  failed: boolean;
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
  const activeWord = (isActive ?? "").trim();
  return {
    present,
    active: activeWord === "active",
    enabled: ["enabled", "enabled-runtime", "static", "alias", "indirect"].includes(enabledWord),
    failed: activeWord === "failed",
  };
}

/**
 * Resident bytes of every process whose command line matches `pattern`, minus
 * any whose command line also matches `exclude`.
 *
 * `pgrep -f` matches the WHOLE command line, which is looser than it looks:
 * Ollama ships its own binary literally named `llama-server`
 * (`/usr/local/lib/ollama/llama-server`), so the pattern that finds llama.cpp
 * finds Ollama's too. Without `exclude`, a box running both engines reported
 * Ollama's memory twice — once on its own row and once added to the Local LLM
 * row, which on an 8 GB box turned a real 5.3 GB into a claimed 7.6 GB
 * (TASK-504, measured on the upgraded box; the clean-install box runs only one
 * engine and never showed it).
 *
 * The filter is negative rather than a positive match on the binary path
 * because `LlamaCppLaunchSpec.binPath` is configurable, so a path this file
 * hard-coded could drift out from under it.
 *
 * `include` is the positive half for a row whose executable IS known: it sees
 * the process's argv and keeps only what it accepts. The Ollama row needs it
 * because `pgrep -f ollama` also finds a shell, an editor or a chat turn whose
 * argv merely mentions the word — measured: a python process with "# ollama"
 * in its arguments added its 307 MiB to the row.
 */
export async function processMemoryBytes(
  pattern: string,
  exclude?: RegExp,
  include?: (argv: string[]) => boolean,
): Promise<number | null> {
  const out = await run("/usr/bin/pgrep", ["-f", pattern]);
  const pids = (out ?? "").split("\n").map(s => s.trim()).filter(Boolean);
  if (!pids.length) return null;
  let total = 0;
  let sawAny = false;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (exclude || include) {
        const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
        // The separators only matter for not gluing arguments together, so a
        // space is enough for the negative match.
        if (exclude && exclude.test(argv.join(" "))) continue;
        if (include && !include(argv)) continue;
      }
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

/**
 * Ollama's bundled inference server, which shares a file name with llama.cpp's.
 * Anything running out of an `ollama` directory belongs on the Ollama row.
 */
export const OLLAMA_OWNED_PROCESS = /[/\\]ollama[/\\]/;

/**
 * argv[0] of the ollama server, whatever path it was installed at. Shared with
 * the runtime's stop path so the row and the kill target name the same thing.
 */
export function isOllamaExecutable(argv0: string): boolean {
  return argv0.trim().replace(/ \(deleted\)$/, "").split("/").pop() === "ollama";
}

/** The processes the Ollama row counts: its server, and its bundled runner. */
function isOllamaProcess(argv: string[]): boolean {
  return isOllamaExecutable(argv[0] ?? "") || OLLAMA_OWNED_PROCESS.test(argv[0] ?? "");
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

const MODEL_FAMILIES: [RegExp, string][] = [
  [/^gemma/, "Gemma"],
  [/^qwen/, "Qwen"],
  [/^llama/, "Llama"],
  [/^mistral/, "Mistral"],
  [/^phi/, "Phi"],
  [/^deepseek/, "DeepSeek"],
  [/^nomic/, "Nomic"],
];

/**
 * "gemma4-e2b-it-q4_0" → "Gemma 4", "qwen3-embedding:0.6b" → "Qwen 3".
 *
 * The file name of a model is a recipe (family, size, tuning, quantisation),
 * and the owner asked for the family alone: the rest is what the installer
 * chose for this box, not a decision the owner makes on this screen. An alias
 * that is not a known family keeps its first word, capitalised, so an
 * unfamiliar model is still named rather than blanked.
 */
export function friendlyModelName(raw: string | null | undefined): string | null {
  const alias = (raw ?? "").trim().toLowerCase();
  if (!alias) return null;
  const [head, next = ""] = alias.split(/[-_:/\s]/);
  const family = MODEL_FAMILIES.find(([re]) => re.test(head))?.[1]
    ?? head.replace(/\d.*$/, "").replace(/^./, (c) => c.toUpperCase());
  // "gemma4" carries its version; "llama-3.1-8b" carries it as the next word
  // (a bare number — "8b" is a size, not a version).
  const version = head.replace(/^[a-z]+/, "").match(/^\d+(?:\.\d+)?/)?.[0]
    ?? next.match(/^\d+(?:\.\d+)?$/)?.[0];
  return version ? `${family} ${version}` : family;
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
    runtime: "Voice on this box",
    runtimeCode: "voiceOnBox",
    installed,
    enabled: installed ? unit.enabled : null,
    running: !installed ? "not-installed" : unit.active ? "running" : "idle",
    diskBytes: null,
    memoryBytes,
    control: installed ? "user-unit" : "none",
    ...(installed
      ? unit.active
        ? line("kokoroSpeaking", "Speaking from this box.")
        : line("kokoroOff", "Off. Turn it on from the menu.")
      : stamped
        ? line("kokoroServiceMissing", "Its service is missing, so it cannot speak.")
        : line("kokoroNotInstalled", "Not installed. The cloud voice speaks instead.")),
  };
}

async function whisperEntry(): Promise<LocalModelEntry> {
  const unit = await readUnitState(WHISPER_UNIT, "user");
  const memoryBytes = unit.active ? await processMemoryBytes("whisper-server.py") : null;
  return {
    id: "whisper",
    name: "Whisper",
    kind: "stt",
    runtime: "Transcribes on this box",
    runtimeCode: "transcribesOnBox",
    installed: unit.present,
    enabled: unit.present ? unit.enabled : null,
    running: !unit.present ? "not-installed" : unit.active ? "running" : "idle",
    diskBytes: null,
    memoryBytes,
    control: unit.present ? "user-unit" : "none",
    ...(unit.present
      ? unit.active
        ? line("whisperReady", "Ready to transcribe.")
        : line("whisperOff", "Off. Starts by itself when you speak.")
      : line("whisperNotInstalled", "Not installed. Speech is transcribed in the cloud.")),
  };
}

async function ollamaEntry(baseUrl: string): Promise<LocalModelEntry> {
  const unit = await readUnitState(OLLAMA_UNIT, "system");
  const models = unit.active ? await ollamaModels(baseUrl) : null;
  const memoryBytes = unit.active ? await processMemoryBytes("ollama", undefined, isOllamaProcess) : null;
  const diskBytes = models?.length ? models.reduce((sum, m) => sum + m.size, 0) : null;
  const names = Array.from(new Set((models ?? []).map(m => friendlyModelName(shortModelName(m.name)) ?? m.name)));
  // Enabled but inactive is the runtime's standby: ten idle minutes after the
  // last proxied use it runs `systemctl stop` — never `disable`, precisely so
  // the engine comes back — and the proxy starts it again on the next request.
  // That is what "on-demand" means, and it is not "off": the owner did not turn
  // it off, and the menu's only verb for an enabled unit is Disable. A unit
  // that exited with an error is not asleep and must not read as such.
  const standby = unit.present && unit.enabled && !unit.active && !unit.failed;
  return {
    id: "ollama",
    name: "Ollama",
    kind: "llm",
    runtime: "Runs extra models on this box",
    runtimeCode: "runsExtraModels",
    installed: unit.present,
    enabled: unit.present ? unit.enabled : null,
    running: !unit.present ? "not-installed" : unit.active ? "running" : standby ? "on-demand" : "idle",
    diskBytes,
    memoryBytes,
    control: unit.present ? "system-unit" : "none",
    ...(!unit.present
      ? line("ollamaNotInstalled", "Not installed.")
      : standby
        ? line("ollamaStandby", "Asleep to save memory. Wakes when a model is asked for, or turn it on now from the menu.")
        : unit.failed
          ? line("ollamaFailed", "Stopped after an error. Turn it on from the menu.")
          : !unit.active
            ? line("ollamaOff", "Off. Turn it on from the menu.")
            // The unit is active but /api/tags did not answer: right after
            // Enable the listener is ~1 s behind systemd's "active", and a
            // probe that has not answered is not an empty model list.
            : models === null
              ? line("ollamaChecking", "On. Checking which models are downloaded…")
              : names.length
                ? line("ollamaServing", `Serving ${names.join(", ")}.`, { names: names.join(", ") })
                : line("ollamaNoModels", "On, with no models downloaded yet.")),
  };
}

interface LlamaCppProbe {
  installed: boolean;
  running: boolean;
  model: string | null;
  /**
   * Local AI is wired to it (primary or fallback), so the proxy will wake it.
   * Without this one "idle" covered two facts: an engine that sleeps between
   * requests and one nothing will ever ask for — the first is "starts when
   * needed", the second is off.
   */
  configured: boolean;
}

async function llamaCppEntry(probe: LlamaCppProbe): Promise<LocalModelEntry> {
  const memoryBytes = probe.running
    ? await processMemoryBytes("llama-server", OLLAMA_OWNED_PROCESS)
    : null;
  return {
    id: "llamacpp",
    name: friendlyModelName(probe.model) ?? "Local model",
    kind: "llm",
    runtime: "Answers on this box",
    runtimeCode: "answersOnBox",
    installed: probe.installed,
    enabled: null,
    running: !probe.installed ? "not-installed" : probe.running ? "running" : probe.configured ? "on-demand" : "idle",
    diskBytes: null,
    memoryBytes,
    control: "none",
    managedBy: "localAi",
    ...(!probe.installed
      ? line("llamacppNotInstalled", "Not installed.")
      : probe.running
        ? line("llamacppAnswering", "Answering right now.")
        : probe.configured
          ? line("llamacppReady", "Ready. Sleeps until needed to save memory.")
          : line("llamacppOff", "Off. Make it primary or fallback from the menu.")),
  };
}

interface EmbeddingProbe {
  /**
   * False when this edition has no memory index at all — the index and its
   * embedding provider belong to OpenClaw, and the Hermes SKU ships no
   * openclaw binary. `available` cannot carry that: a Hermes box and an
   * OpenClaw box whose provider is down would both read `available: false`,
   * and only one of them is a fault.
   */
  supported: boolean;
  /**
   * The status has actually been read. False while the background probe is
   * still running, which is NOT the same as "no embedding model is
   * answering" — saying that to a customer whose box was simply not asked yet
   * is the same class of lie as `supported` exists to prevent.
   */
  ready: boolean;
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
  // Edition first, before anything is read off the probe. On a box with no
  // OpenClaw the status call cannot run, so every other field is the shape of a
  // failure rather than a reading — and "No embedding model is answering" would
  // send the customer looking for a model to install that this SKU never had.
  if (!probe.supported) {
    return {
      id: "embeddings",
      name: "Memory search",
      nameCode: "memorySearch",
      kind: "embedding",
      runtime: "Finds things in your memory",
      runtimeCode: "findsInMemory",
      installed: false,
      enabled: null,
      running: "not-on-this-edition",
      diskBytes: null,
      memoryBytes: null,
      control: "none",
      ...line("embeddingsNotOnEdition", "Memory search is an OpenClaw feature. This edition does not include it."),
    };
  }
  const providerId = probe.provider ? probe.provider.toLowerCase() : null;
  const host = providerId ? engines.find(e => e.id === providerId) : undefined;
  // "on-demand" counts as live only when the request that needs the engine is
  // the one that wakes it. The chat reaches llama.cpp through the local-ai
  // proxy, which starts it; OpenClaw's memory search embeds straight at
  // 127.0.0.1:11434 (its journal shows the direct /api/embed calls, none
  // through /setup-api/local-ai/ollama), so a sleeping Ollama is not woken by
  // a search and the row must not claim it is searching.
  const hostAsleep = !!host && host.running === "on-demand" && host.id === "ollama";
  const hostStopped = !!host && (hostAsleep || (host.running !== "running" && host.running !== "on-demand"));
  const running: RunState = !probe.available
    ? "not-installed"
    : hostStopped
      ? "idle"
      : probe.local ? "running" : "on-demand";
  const model = friendlyModelName(probe.model);
  const via = host?.name ?? (probe.provider ? probe.provider.replace(/^./, (c) => c.toUpperCase()) : null);
  const hostName = host?.name ?? "Its engine";
  // One `params` serves the runtime code and the detail code alike.
  const params: Record<string, string> = {};
  if (model) params.model = model;
  if (via) params.via = via;
  if (probe.available && hostStopped) params.host = hostName;
  return {
    id: "embeddings",
    name: "Memory search",
    nameCode: "memorySearch",
    kind: "embedding",
    runtime: [model, via ? `via ${via}` : null].filter(Boolean).join(" ") || "Finds things in your memory",
    runtimeCode: model && via ? "modelVia" : model ? "model" : via ? "via" : "findsInMemory",
    installed: probe.available,
    enabled: null,
    running,
    diskBytes: null,
    memoryBytes: null,
    control: "none",
    managedBy: "clawkeep",
    ...(!probe.available
      ? line("embeddingsOff", "No memory model is answering, so memory search is off.")
      : hostAsleep
        ? line("embeddingsAsleep", `${hostName} is asleep, so memory search is paused until it wakes.`)
        : hostStopped
          ? line("embeddingsPaused", `${hostName} is off, so memory search is paused.`)
          : probe.local
            ? line("embeddingsLocal", "Searching your memory on this box.")
            : line("embeddingsCloud", "Searching your memory in the cloud.")),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

/**
 * Just the speech-out rows.
 *
 * The Voice panel (TASK-434) needs one fact — is there a voice on this box —
 * and it must be the SAME fact the Local Models tab shows, or the two would
 * eventually disagree about whether Kokoro is installed. Building the whole
 * inventory for it would cost an Ollama HTTP probe, a llama.cpp probe and two
 * more systemctl round trips that cannot change the answer.
 */
export async function buildTtsInventory(): Promise<LocalModelEntry[]> {
  try {
    return [await kokoroEntry()];
  } catch {
    // An unreadable engine reads as absent, never as a broken tab.
    return [];
  }
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
  // Concurrent, not sequential: every engine costs at least two systemctl
  // round-trips and some cost an HTTP probe, and on a Jetson a serial pass adds
  // up to seconds on a panel that refreshes every five. The engines do not
  // depend on each other, so nothing is gained by waiting.
  const builders: [string, () => Promise<LocalModelEntry>][] = [
    ["llamacpp", () => llamaCppEntry(probes.llamacpp)],
    ["ollama", () => ollamaEntry(probes.ollamaBaseUrl)],
    ["kokoro", kokoroEntry],
    ["whisper", whisperEntry],
  ];
  const settled = await Promise.all(builders.map(async ([id, build]) => {
    try {
      return { id, entry: await build() };
    } catch {
      return { id, entry: null };
    }
  }));
  const models = settled.map(r => r.entry).filter((e): e is LocalModelEntry => e !== null);
  const unavailable = settled.filter(r => r.entry === null).map(r => r.id);
  // Embeddings last and alone: it is the only row read against another row.
  // And only once the box has been asked — until then the row is not there
  // yet rather than the whole page waiting on an OpenClaw boot for it. Not
  // `unavailable` either: nothing failed, the answer is simply not in yet, and
  // the panel polls.
  if (probes.embeddings.ready || !probes.embeddings.supported) {
    try {
      models.push(embeddingEntry(probes.embeddings, models));
    } catch {
      unavailable.push("embeddings");
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

/** Every engine the inventory can name, so a route can tell "unknown" from "has no switch". */
export const ENGINE_IDS: ReadonlySet<string> = new Set(["llamacpp", "ollama", "kokoro", "whisper", "embeddings"]);

/** The unit and scope a toggleable engine maps to, or null when it has none. */
export function unitForEngine(id: string): { unit: string; scope: "user" | "system" } | null {
  if (id === "kokoro") return { unit: KOKORO_UNIT, scope: "user" };
  if (id === "whisper") return { unit: WHISPER_UNIT, scope: "user" };
  if (id === "ollama") return { unit: OLLAMA_UNIT, scope: "system" };
  return null;
}
