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
import { constants as fsConstants, promises as fs } from "fs";
import os from "os";
import path from "path";
import { EMBED_MODEL_ALIAS, EMBED_UNIT, isEmbeddingServerArgv } from "./embed-runtime-ids";

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
  | "llamacppNotInstalled" | "llamacppAnswering" | "llamacppReady" | "llamacppOff"
  | "embeddingsNotOnEdition" | "embeddingsNotInstalled" | "embeddingsOff" | "embeddingsReady"
  | "embeddingsFailed" | "embeddingsLocal" | "embeddingsCloud";

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

async function executable(bin: string): Promise<boolean> {
  try {
    // X_OK on its own is not "can be run": on POSIX it is also what a
    // SEARCHABLE directory answers, so a folder called `ffmpeg` on the PATH
    // had this box reporting an encoder it could never start. `stat` follows
    // the link, which is right — a symlink to a real binary is a real binary.
    if (!(await fs.stat(bin)).isFile()) return false;
    await fs.access(bin, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this box actually RUN the command a local TTS provider names?
 *
 * One fact, asked by both surfaces that depend on it — Settings → Voice's
 * `commandPresent` and the chat's spoken-reply capability — because two
 * spellings of it is how they came to describe one box differently.
 *
 * Two provider shapes reach here and the answer must be the same for both.
 * OpenClaw's `tts-local-cli` holds a bare `command` beside a separate `args`
 * array; Hermes' `clawbox-local` holds a whole command LINE, because Hermes
 * substitutes its own placeholders into it
 * (`<script> --text-file={input_path} -- {output_path}`). So the string is
 * tried whole first — a bare command may legitimately contain spaces — and
 * then as its first word, which is the executable in the command-line shape.
 *
 * X_OK, not the default F_OK: the harness EXECUTES this. A script that is
 * present but not executable — a tree copied without modes, an archive
 * restored with the bits stripped — leaves every other condition saying yes,
 * so "the file is there" reported a voice the box could not produce.
 * `install.sh` refuses to register a command that is not `-x`; this asks the
 * same question again at read time, because the file can lose the bit long
 * after the config was written.
 *
 * Fails CLOSED, like every other fact behind a capability.
 */
export async function localTtsCommandRunnable(command: string): Promise<boolean> {
  const line = command.trim();
  if (!line) return false;
  const first = line.split(/\s+/, 1)[0];
  return (await executable(line)) || (first !== line && (await executable(first)));
}

/**
 * Can this box turn its own speech into a voice note?
 *
 * Kokoro emits WAV and the desktop chat plays WAV, so the box's voice works
 * perfectly well without ffmpeg — but a voice note on a CHANNEL is Opus, and
 * the encoder is ffmpeg: OpenClaw's Local CLI provider forces the `opus`
 * format for that target and converts our WAV with `ffmpeg -c:a libopus`.
 * Without it the local attempt throws for every Telegram voice note and the
 * gateway falls through to the cloud voice — which the owner has no way to
 * see, because every screen and every `capability tts status` still says the
 * box speaks for itself.
 *
 * The PATH is walked rather than a shell asked, because this is read on the
 * Voice tab's status: a spawn per panel load, for a question that is three
 * stat calls, is not a trade worth making. Fails CLOSED like every other fact
 * behind a capability, and the answer is never cached — the whole point is
 * that it flips to true the moment the voice install has run.
 */
export async function ffmpegPresent(): Promise<boolean> {
  const dirs = (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await executable(path.join(dir, "ffmpeg"))) return true;
  }
  return false;
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
  /**
   * Did systemd ANSWER, or did the question fail?
   *
   * `is-enabled` prints a word for every unit it knows about and an error
   * string naming the missing file for one it does not — so an EMPTY answer is
   * neither: a 5 s timeout, a SIGKILL, or "Failed to connect to bus" on a
   * wedged user bus, all of which arrive here as `present: false`.
   *
   * A cosmetic false negative is right for a panel that reloads. It is wrong
   * for a writer that runs once: the ClawBox AI link path reads this to decide
   * whether a box can still speak for itself, and moving it off its on-device
   * voice is permanent (`step_openclaw_tts` then preserves the new value as
   * the owner's choice). That caller asks `probeLocalTtsEngine`, which reports
   * "could not ask" rather than "no".
   */
  answered: boolean;
}

export async function readUnitState(unit: string, scope: "user" | "system"): Promise<UnitState> {
  // Concurrent, not sequential. The two answers are independent, and each call
  // carries its own 5 s timeout — awaited one after the other a wedged systemd
  // bus cost 10 s, which the Voice tab has always paid but the chat turn now
  // pays too (the spoken-reply capability reads this inventory per reply,
  // ahead of the reply's own speech budget rather than inside it). Asked
  // together the worst case is one timeout, not two.
  const [isActive, isEnabled] = await Promise.all([
    scope === "user"
      ? runUserSystemctl(["is-active", unit])
      : run("/usr/bin/systemctl", ["is-active", unit]),
    scope === "user"
      ? runUserSystemctl(["is-enabled", unit])
      : run("/usr/bin/systemctl", ["is-enabled", unit]),
  ]);
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
    // An error string naming the missing unit file IS an answer — "absent" —
    // which is exactly what `present` reads it as above. Silence is not.
    answered: enabledWord !== "",
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

/**
 * THE rule: does this box have an on-device speech engine?
 *
 * BOTH the stamp and the unit. The weights alone are not an installation: on
 * the loop's own test box the 82M Kokoro weights sit in the HuggingFace cache
 * from a run that failed afterwards, with no unit and no stamp. Reporting that
 * as installed is precisely the lie the Voice tab removes.
 *
 * Written ONCE, here, beside `kokoroEntry`: the panel's row, the chat turn's
 * spoken-reply capability and the ClawBox AI link path all reach it, so they
 * cannot drift into giving one box two answers. Not exported — the callers
 * want one of the two functions below, which do the reading as well.
 */
function localTtsEngineInstalled(stamped: boolean, unitPresent: boolean): boolean {
  return stamped && unitPresent;
}

/**
 * The rule, over a fresh sample, with "I could not ask" kept distinct from "no".
 *
 * `null` means the question failed — a wedged user systemd bus, a 5 s timeout,
 * a SIGKILL — on a box that does hold the Kokoro stamp, so nothing here is
 * evidence either way. Only a caller whose write is PERMANENT needs that
 * distinction, and there is exactly one: the ClawBox AI link path moves a box
 * off its on-device voice for good (`step_openclaw_tts` afterwards sees the
 * new value and preserves it as the owner's choice), so a false negative there
 * costs the owner the engine they paid for. Everything else wants
 * `hasLocalTtsEngine` and its fail-closed `false`.
 *
 * No stamp and no answer is still a real `false`: the stamp is a required half
 * of the rule and `exists()` answers it on its own.
 */
export async function probeLocalTtsEngine(): Promise<boolean | null> {
  try {
    const [stamped, unit] = await Promise.all([
      exists(KOKORO_STAMP),
      readUnitState(KOKORO_UNIT, "user"),
    ]);
    if (!unit.answered) return stamped ? null : false;
    return localTtsEngineInstalled(stamped, unit.present);
  } catch {
    return null;
  }
}

/**
 * Does this box have an on-device speech engine, fail-closed?
 *
 * "Could not ask" answers "no engine", which for a panel is a cosmetic false
 * negative that the next load corrects, and for the chat turn is one reply
 * without a player rather than a player that plays nothing.
 */
export async function hasLocalTtsEngine(): Promise<boolean> {
  return (await probeLocalTtsEngine()) === true;
}

async function kokoroEntry(): Promise<LocalModelEntry> {
  // ONE sample of each fact, and the rule applied to it. Calling
  // `hasLocalTtsEngine()` here instead would run the stamp read and the
  // `systemctl --user` pair a SECOND time — measured 2 → 4 spawns — on the path
  // whose own comment says the spoken-reply capability reads this inventory per
  // reply; and `installed` would then come from a different sample than the one
  // filling `enabled`, `running` and `memoryBytes`, so a unit that moved between
  // them would produce a row that contradicts itself.
  //
  // `stamped` is a third question — are the WEIGHTS there — and only the
  // wording below needs it, to tell "its service is missing" from "nothing was
  // ever installed".
  const [stamped, unit] = await Promise.all([
    exists(KOKORO_STAMP),
    readUnitState(KOKORO_UNIT, "user"),
  ]);
  const installed = localTtsEngineInstalled(stamped, unit.present);
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
  // Two exclusions: ollama's bundled `llama-server`, and the memory embedder,
  // which runs the SAME binary from the same path and is counted on its own
  // row — the one flag only it carries is what tells the two instances apart.
  const memoryBytes = probe.running
    ? await processMemoryBytes("llama-server", OLLAMA_OWNED_PROCESS, (argv) => !isEmbeddingServerArgv(argv))
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
  /**
   * The embedder on this box — clawbox-embed.service and its GGUF — as the
   * route measured them. Read whether or not OpenClaw is pointed at it: the
   * row is the engine's, and "not installed" is a fact about the box, not
   * about the config.
   */
  engine: {
    installed: boolean;
    /** Bytes of the GGUF on disk, null when it is not there. */
    modelBytes: number | null;
  };
}

/**
 * The Memory search row IS the engine row: Qwen 3 on ClawBox's own llama.cpp,
 * run as clawbox-embed.service and woken by the local-AI proxy.
 *
 * It used to be read against the Ollama row, because OpenClaw's memory search
 * embedded straight at 127.0.0.1:11434 and a sleeping ollama was not woken by
 * a search — the row had to say "paused" over an engine that would never come.
 * The embedder is reached through the proxy now, so a sleeping unit is exactly
 * what "starts when needed" means, and the unit's own state is the reading.
 */
async function embeddingEntry(probe: EmbeddingProbe): Promise<LocalModelEntry> {
  const base = {
    id: "embeddings",
    name: "Memory search",
    nameCode: "memorySearch" as const,
    kind: "embedding" as const,
    enabled: null,
    control: "none" as const,
  };
  // Edition first, before anything is read off the probe. On a box with no
  // OpenClaw the status call cannot run, so every other field is the shape of a
  // failure rather than a reading — and "No embedding model is answering" would
  // send the customer looking for a model to install that this SKU never had.
  if (!probe.supported) {
    return {
      ...base,
      runtime: "Finds things in your memory",
      runtimeCode: "findsInMemory",
      installed: false,
      running: "not-on-this-edition",
      diskBytes: null,
      memoryBytes: null,
      ...line("embeddingsNotOnEdition", "Memory search is an OpenClaw feature. This edition does not include it."),
    };
  }
  // An embedder the owner pointed OpenClaw at that is not this box: named,
  // never measured — there is nothing here to measure.
  if (probe.available && !probe.local) {
    const model = friendlyModelName(probe.model);
    const via = probe.provider ? probe.provider.replace(/^./, (c) => c.toUpperCase()) : null;
    const params: Record<string, string> = {};
    if (model) params.model = model;
    if (via) params.via = via;
    return {
      ...base,
      runtime: [model, via ? `via ${via}` : null].filter(Boolean).join(" ") || "Finds things in your memory",
      runtimeCode: model && via ? "modelVia" : model ? "model" : via ? "via" : "findsInMemory",
      installed: true,
      running: "on-demand",
      diskBytes: null,
      memoryBytes: null,
      managedBy: "clawkeep",
      ...line("embeddingsCloud", "Searching your memory in the cloud."),
      ...(Object.keys(params).length ? { params } : {}),
    };
  }
  // Ours. The unit is what says whether it is up; the flag it alone carries
  // is what keeps its memory off the Gemma row that runs the same binary.
  const unit = await readUnitState(EMBED_UNIT, "system");
  const installed = probe.engine.installed && unit.present;
  const memoryBytes = unit.active
    ? await processMemoryBytes("llama-server", OLLAMA_OWNED_PROCESS, isEmbeddingServerArgv)
    : null;
  const model = friendlyModelName(probe.model) ?? friendlyModelName(EMBED_MODEL_ALIAS) ?? "Qwen 3";
  const params = { model, via: "llama.cpp" };
  return {
    ...base,
    runtime: `${model} via llama.cpp`,
    runtimeCode: "modelVia",
    installed,
    running: !installed ? "not-installed" : unit.active ? "running" : unit.failed ? "idle" : "on-demand",
    diskBytes: probe.engine.modelBytes,
    memoryBytes,
    managedBy: "clawkeep",
    ...(!installed
      ? line("embeddingsNotInstalled", "Not installed. Set it up in Memory Shard.")
      : !probe.available
        ? line("embeddingsOff", "Memory search is not pointed at it yet. Set it up in Memory Shard.")
        : unit.active
          ? line("embeddingsLocal", "Searching your memory on this box.")
          : unit.failed
            ? line("embeddingsFailed", "Stopped after an error. It starts again on the next search.")
            : line("embeddingsReady", "Ready. Wakes when you search, then sleeps to save memory.")),
    params,
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
  // The Ollama row is gone: nothing that ships needs it now that the memory
  // embedder runs on llama.cpp (its chat-provider path stays reachable by API
  // for boxes configured before it was retired from the picker).
  const builders: [string, () => Promise<LocalModelEntry>][] = [
    ["llamacpp", () => llamaCppEntry(probes.llamacpp)],
    ["kokoro", kokoroEntry],
    ["whisper", whisperEntry],
  ];
  // Embeddings only once the box has been asked — until then the row is not
  // there yet rather than the whole page waiting on an OpenClaw boot for it.
  // Not `unavailable` either: nothing failed, the answer is simply not in yet,
  // and the panel polls.
  if (probes.embeddings.ready || !probes.embeddings.supported) {
    builders.push(["embeddings", () => embeddingEntry(probes.embeddings)]);
  }
  const settled = await Promise.all(builders.map(async ([id, build]) => {
    try {
      return { id, entry: await build() };
    } catch {
      return { id, entry: null };
    }
  }));
  const models = settled.map(r => r.entry).filter((e): e is LocalModelEntry => e !== null);
  const unavailable = settled.filter(r => r.entry === null).map(r => r.id);
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

/**
 * Bring a user engine up NOW, and leave the boot setting alone.
 *
 * `setEngineEnabled` is the owner's standing decision — it enables the unit so
 * the engine also comes back after a reboot. This is the other thing entirely:
 * a warm-up. The Kokoro server holds the model on the GPU and stops itself
 * after five idle minutes, so the first utterance after a quiet spell pays a
 * 13-19 s cold start; whoever knows a spoken reply is coming (the chat's
 * microphone, the Voice tab's own engine pick) starts it here a few seconds
 * ahead and the reply is spoken in two. Nothing about the box's configuration
 * changes, so this must never reach `enable`: an engine the owner switched off
 * for good would come back at the next boot because a chat turn warmed it.
 *
 * `--no-block` because the caller is waiting on a person, not on systemd, and
 * a model load is not something to hold an HTTP request open for.
 */
export async function startUserEngine(unit: string): Promise<ToggleResult> {
  if (!USER_UNITS.has(unit)) return { ok: false, error: "Unknown service." };
  try {
    await execFileAsync("/usr/bin/systemctl", ["--user", "start", "--no-block", unit], {
      timeout: 10_000,
      env: userSystemctlEnv(),
    });
    return { ok: true };
  } catch {
    // Never the command line, and never a reason worth acting on: a warm-up
    // that failed costs the next reply a cold start and nothing else.
    return { ok: false, error: "Could not start the service." };
  }
}

/** Every engine the inventory can name, so a route can tell "unknown" from "has no switch". */
export const ENGINE_IDS: ReadonlySet<string> = new Set(["llamacpp", "kokoro", "whisper", "embeddings"]);

/** The unit and scope a toggleable engine maps to, or null when it has none. */
export function unitForEngine(id: string): { unit: string; scope: "user" | "system" } | null {
  if (id === "kokoro") return { unit: KOKORO_UNIT, scope: "user" };
  if (id === "whisper") return { unit: WHISPER_UNIT, scope: "user" };
  if (id === "ollama") return { unit: OLLAMA_UNIT, scope: "system" };
  return null;
}
