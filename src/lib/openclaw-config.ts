import fs from "fs/promises";
import { listAgentIds, readSessionEntries, sessionStorePath } from "./openclaw-session-store";
import { isPatchableSession, patchSessionModels, type GatewayRpcCall } from "./openclaw-session-model";
import { clearPairingState, readPairingAllowEntries, readPairingRequests } from "./openclaw-state-store";
import fsSync from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { isDeepStrictEqual, promisify } from "util";
import { getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import { getLocalAiProxyRootUrl } from "@/lib/local-ai-proxy-url";
import { readEdition } from "@/lib/edition-source";
import { getProviderReasoningConfig, isThinkingLevel } from "@/lib/chat-reasoning";
import { get as getConfigStoreValue } from "@/lib/config-store";
import { DISABLED_PROVIDERS_KEY, parseDisabledProviders } from "@/lib/provider-status";
import { ANTHROPIC_PLUGIN_ENABLED_KEY } from "@/lib/provider-plugin-ops";
import { isSafeDiscordToken } from "@/lib/discord-api";
import { envPort, waitForPortOpen } from "@/lib/port-probe";

const exec = promisify(execFile);

/**
 * Thrown when the OpenClaw CLI is asked to run on an edition that does not ship
 * it. The Hermes SKU has no `openclaw` binary at all (see `openclawIsAbsent`),
 * so a spawn would fail deep inside a request with a raw `spawn openclaw
 * ENOENT` — a confusing, un-actionable error. Callers that have a Hermes-native
 * equivalent should route to it *before* reaching the CLI; this typed error is
 * the backstop for the paths that don't, so they can fail cleanly and honestly
 * instead of blaming the user's credentials.
 */
export class OpenclawUnavailableError extends Error {
  constructor(message = "The OpenClaw CLI is not available on this edition.") {
    super(message);
    this.name = "OpenclawUnavailableError";
  }
}

/**
 * The CLI was still running at its deadline and was SIGKILLed.
 *
 * A distinct type because it says something the other spawn failures do not:
 * NOTHING was observed. An exit code is the CLI's own answer — 0 wrote, 1
 * refused — but a kill leaves the question open, and `openclaw config set`
 * writes the config early and then spends seconds validating catalogs, so on a
 * Jetson the value routinely lands inside the window we kill in. Callers that
 * know what they asked for read the config back rather than guessing (see
 * {@link runOpenclawConfigSet}).
 */
export class OpenclawSpawnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenclawSpawnTimeoutError";
  }
}

/**
 * True when this device ships no `openclaw` binary — i.e. the Hermes edition.
 * openclaw is present on the `openclaw` and `dual` SKUs; only `hermes` removes
 * it. Keyed on the edition (a root-owned env read) rather than a filesystem
 * probe so it is synchronous and cannot be spoofed by a user-writable path.
 */
export function openclawIsAbsent(): boolean {
  return readEdition() === "hermes";
}

/**
 * Options for {@link runOpenclawConfigSet}.
 */
export interface OpenclawConfigSetOptions {
  /**
   * Per-attempt timeout in ms. Default: 30_000.
   *
   * OpenClaw's CLI is a full Node.js program that loads the whole gateway
   * SDK, parses plugins, and validates the config schema on every
   * invocation. On a NVIDIA Jetson Orin Nano this startup cost alone is
   * 10-12 s per call — measured consistently with three sequential runs
   * when the box was otherwise idle. A 30 s per-attempt budget gives a
   * healthy safety margin on the target hardware. Callers on faster
   * machines (dev boxes, CI) can override down to 10 s if they want
   * stricter bounds.
   */
  timeoutMs?: number;
  /** Maximum attempts including the first try. Default: 4. */
  maxAttempts?: number;
  /** Linear backoff base — delay between attempts is `baseBackoffMs * attempt`. Default: 100. */
  baseBackoffMs?: number;
  /** Spawn uid (for cases where the calling process runs as a different user). */
  uid?: number;
  /** Spawn gid (paired with `uid`). */
  gid?: number;
  /** Working directory for the spawned process. Default: `/home/clawbox`. */
  cwd?: string;
  /** Extra env overrides merged over the default `{ HOME: "/home/clawbox", ...process.env }`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `openclaw config set <args>` with automatic retry on
 * `ConfigMutationConflictError`.
 *
 * OpenClaw's config writer uses optimistic concurrency (content-hash based)
 * and its gateway process reloads on file changes. When ClawBox issues
 * multiple `config set` calls back-to-back, or a `config set` races with the
 * gateway touching `meta.lastTouchedAt` during a reload, one of the writes
 * can fail with `ConfigMutationConflictError: config changed since last
 * load`. The mutation itself is safe to retry — the next attempt re-reads
 * the fresh hash and converges.
 *
 * This helper retries *only* on that specific error (other failures bubble
 * up immediately) with a short linear backoff, so callers don't need to
 * handle the race individually.
 *
 * ONE failure is not simply rethrown: a spawn killed at its deadline. The CLI
 * writes the config early and then spends seconds validating catalogs, so on a
 * Jetson the value lands inside the window we kill in — and a SIGKILL carries
 * no exit code to read. The assignments are looked for in the config on disk,
 * and only a write this process can SEE there is reported as success; every
 * other failure, including an unreadable config, still throws. See
 * {@link configSetLanded}.
 */
export async function runOpenclawConfigSet(
  args: string[],
  options: OpenclawConfigSetOptions = {},
): Promise<void> {
  await runConfigSetVerified([args], options, () =>
    withConfigMutationRetry(
      (timeoutMs) => spawnOpenclawConfigSet(args, { ...options, timeoutMs }),
      options,
      "runOpenclawConfigSet",
    ),
  );
}

/**
 * Retry `attempt` while it fails with `ConfigMutationConflictError`.
 *
 * Shared by {@link runOpenclawConfigSet} and {@link runOpenclawConfigSetBatch}
 * so both forms of the write survive the same race. Any other failure is
 * rethrown on the first try — a schema rejection does not become valid by
 * being repeated.
 *
 * Retrying is all this does. A rethrown timeout is then settled by the config
 * on disk, one level up in {@link runConfigSetVerified}, because a SIGKILL is
 * the only failure that carries no answer about whether the write happened.
 */
async function withConfigMutationRetry(
  attemptFn: (timeoutMs: number) => Promise<void>,
  options: OpenclawConfigSetOptions,
  label: string,
): Promise<void> {
  const {
    timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
    maxAttempts = 4,
    baseBackoffMs = 100,
  } = options;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await attemptFn(timeoutMs);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isConflict = /ConfigMutationConflictError/i.test(lastError.message);
      if (!isConflict || attempt === maxAttempts) {
        throw lastError;
      }
      const delayMs = baseBackoffMs * attempt;
      console.warn(
        `[openclaw-config] ConfigMutationConflictError on attempt ${attempt}/${maxAttempts}; retrying after ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error(`${label} exhausted retries`);
}

export interface SpawnOpenclawOptions {
  /** Per-call timeout in ms. Default {@link DEFAULT_SPAWN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Capture and resolve stdout (needed to read `--json` output). Default false. */
  captureStdout?: boolean;
  /**
   * Write this to the child's stdin and close it. The one way to hand the CLI
   * a secret without putting it in argv (`models auth paste-api-key` reads the
   * key from stdin). Callers passing one should set labelArgs anyway — the
   * value never appears in the label, but argv hygiene is theirs to keep.
   */
  stdinData?: string;
  /**
   * Argv to name the process by in error messages, when the real argv must not
   * appear in one. Defaults to `args`. See {@link spawnOpenclawConfigSet}.
   */
  labelArgs?: string[];
  uid?: number;
  gid?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn the `openclaw` CLI with a per-call timeout and uniform error handling,
 * resolving with stdout (empty unless `captureStdout` is set).
 *
 * stdout is left "ignore" unless a caller asks for it: OpenClaw's CLI can emit a
 * lot of stdout under verbose/debug modes and, with a full kernel pipe buffer
 * and no one draining it, the child would deadlock. stderr is always captured —
 * it carries the ConfigMutationConflictError signature used for retry.
 */
function spawnOpenclaw(args: string[], options: SpawnOpenclawOptions = {}): Promise<string> {
  // Chokepoint guard: on an edition with no openclaw binary, refuse with a
  // typed error rather than spawn the bare `"openclaw"` fallback (findOpenclawBin
  // returns that string when no real path resolves) and surface a raw ENOENT
  // from inside a request. Every config-set / pairing call funnels through here.
  if (openclawIsAbsent()) {
    return Promise.reject(new OpenclawUnavailableError());
  }
  const bin = findOpenclawBin();
  const { uid, gid, captureStdout = false, stdinData } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  const cwd = options.cwd ?? process.env.HOME ?? "/home/clawbox";
  const env = { HOME: "/home/clawbox", ...process.env, ...(options.env ?? {}) };
  const label = `${bin} ${(options.labelArgs ?? args).join(" ")}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, args, {
      stdio: [stdinData !== undefined ? "pipe" : "ignore", captureStdout ? "pipe" : "ignore", "pipe"],
      cwd,
      ...(uid !== undefined ? { uid } : {}),
      ...(gid !== undefined ? { gid } : {}),
      env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (stdinData !== undefined) {
      // EPIPE when the child exits before reading — close() reports the truth.
      child.stdin?.on("error", () => {});
      child.stdin?.write(stdinData);
      child.stdin?.end();
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      // `kill(2)` returns when the signal is QUEUED, not when the process is
      // gone, and a `config set` sitting in its final rename can still land the
      // write. The caller reads the config back to decide whether a killed
      // write landed, so answering before the child is reaped would read the
      // file on the wrong side of that rename. Bounded: a process that will not
      // die must not hold the request open either.
      const error = new OpenclawSpawnTimeoutError(`${label} timed out after ${timeoutMs}ms`);
      let answered = false;
      const answer = () => {
        if (answered) return;
        answered = true;
        clearTimeout(reapTimer);
        reject(error);
      };
      const reapTimer = setTimeout(answer, KILL_REAP_WAIT_MS);
      child.once("close", answer);
    }, timeoutMs);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || stdout.trim() || `${label} exited with code ${code}`));
      }
    });
  });
}

/**
 * Public face of {@link spawnOpenclaw} for other libs in this repo.
 *
 * Exported as a named wrapper rather than by exporting `spawnOpenclaw` itself
 * so the edition guard, the timeout and the stdio rules stay in ONE place: a
 * caller that wants `--json` output gets the same "drain stdout or the child
 * deadlocks" handling every internal caller already has, and the
 * OpenclawUnavailableError guard cannot be routed around.
 */
export function spawnOpenclawCli(
  args: string[],
  options: SpawnOpenclawOptions = {},
): Promise<string> {
  return spawnOpenclaw(args, options);
}

/** Bound on the gateway round trip itself; the spawn budget adds the CLI's own start-up on top. */
const GATEWAY_RPC_TIMEOUT_MS = 20_000;
const GATEWAY_RPC_SPAWN_ALLOWANCE_MS = 30_000;

/** Default per-call deadline. A Jetson CLI cold start is ~10-12s. */
const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;

/** How long a SIGKILLed child is given to actually exit before we answer anyway. */
const KILL_REAP_WAIT_MS = 1_000;

/**
 * One gateway RPC through the CLI: `openclaw gateway call <method> --params
 * <json> --json`. The CLI is the gateway's own client — it holds the device
 * identity, the token and the protocol version, so nothing here can drift
 * from what the gateway accepts. With `--json` it prints the method's result
 * object and nothing else on success; a failure is written as an error
 * payload with exit 1, which `spawnOpenclaw` turns into a rejection carrying
 * that text. The `ok === false` check is for a build that reports a refusal
 * on exit 0.
 *
 * Costs one CLI start-up (10-12 s on a Jetson), so callers batch: a sweep
 * over N sessions is one `sessions.patchMany`, not N calls.
 */
export async function callGatewayRpc(
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? GATEWAY_RPC_TIMEOUT_MS;
  const out = await spawnOpenclaw(
    ["gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeoutMs)],
    {
      captureStdout: true,
      timeoutMs: timeoutMs + GATEWAY_RPC_SPAWN_ALLOWANCE_MS,
      // Session keys are not secrets, but a 100-target params blob is not a log line either.
      labelArgs: ["gateway", "call", method, "--params", "<json>", "--json"],
    },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`${method} returned no JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${method} returned no object`);
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.ok === false) {
    const error = payload.error as { message?: unknown } | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : `${method} failed`);
  }
  return payload;
}

/**
 * Argv for a `config set` call with the *value* elided, for use in a log line.
 *
 * `openclaw config set <path> <value>` carries the secret in argv — the ClawBox
 * AI portal token, a provider API key, the Telegram bot token, the gateway
 * token. `spawnOpenclaw` names the process in the two errors it can reject with
 * (timeout, and a non-zero exit that produced no output), and every caller of
 * `runOpenclawConfigSet` logs that message. Naming the config path is what makes
 * such a line diagnosable; the value never adds anything a reader needs, and
 * writing it puts a live credential in the journal (CWE-532).
 *
 * Flags keep their literal form — they are part of the command's shape, not its
 * payload — so a reader still sees `--json` and can reproduce the call.
 */
export function configSetLabelArgs(args: string[]): string[] {
  const [configPath, ...rest] = args;
  return [
    "config",
    "set",
    ...(configPath === undefined ? [] : [configPath]),
    ...rest.map((arg) => (arg.startsWith("--") ? arg : "<redacted>")),
  ];
}

function spawnOpenclawConfigSet(
  args: string[],
  options: OpenclawConfigSetOptions & { timeoutMs: number },
): Promise<void> {
  return spawnOpenclaw(["config", "set", ...args], {
    labelArgs: configSetLabelArgs(args),
    timeoutMs: options.timeoutMs,
    uid: options.uid,
    gid: options.gid,
    cwd: options.cwd,
    env: options.env,
  }).then(() => undefined);
}

/**
 * One `openclaw config set` assignment, in the same argv form
 * {@link runOpenclawConfigSet} takes: `[path, value]`, optionally followed by
 * `--json` when `value` is already JSON text.
 */
export type OpenclawConfigSetArgs = string[];

/**
 * Turn one `config set` argv into the `{ path, value }` entry the CLI's batch
 * mode wants.
 *
 * The CLI's own two value modes are reproduced exactly, because a batch has to
 * write the same config a sequence of single calls would:
 *  - with `--json` (aka `--strict-json`) the value text is parsed as JSON and a
 *    parse failure is an error;
 *  - without it the CLI tries to parse the text and silently falls back to the
 *    raw string, which is how `"24000"` becomes the number 24000 and
 *    `"deepseek/deepseek-v4-pro"` stays a string.
 *
 * (The CLI reaches for JSON5 rather than JSON on the lenient path. Every value
 * this repo writes without `--json` is a plain model id, a mode word, a token
 * or a decimal integer, for which the two parsers agree; JSON5 is not a
 * dependency here and pulling one in to cover values we never send would be
 * cost without benefit.)
 */
export function parseConfigSetArgs(args: OpenclawConfigSetArgs): { path: string; value: unknown } {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [path, raw] = positional;
  if (!path) throw new Error("config set batch entry is missing a path");
  if (raw === undefined) throw new Error(`config set batch entry for ${path} is missing a value`);
  const strictJson = flags.includes("--json") || flags.includes("--strict-json");
  if (strictJson) return { path, value: JSON.parse(raw) };
  try {
    return { path, value: JSON.parse(raw) };
  } catch {
    return { path, value: raw };
  }
}

/**
 * Split a `config set` path into the segments the CLI addresses, or null when
 * this code cannot say for certain what they are.
 *
 * `.` separates, and a bracket-quoted segment is ONE key however many dots it
 * contains — `agents.defaults.models["openai/gpt-5.5"].agentRuntime.id`, the
 * Codex runtime arm, is the path that made this necessary. Null for anything
 * else (an unterminated bracket, an unquoted index, an empty DOTTED segment —
 * `[""]` is a legal key and parses as one), because
 * the only caller uses this to decide that a write it did not see finish
 * actually landed, and a path it cannot read must not become that claim.
 */
function configPathSegments(configPath: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  while (i < configPath.length) {
    if (configPath[i] === "[") {
      const quote = configPath[i + 1];
      if (quote !== '"' && quote !== "'") return null;
      const end = configPath.indexOf(`${quote}]`, i + 2);
      if (end < 0) return null;
      const segment = configPath.slice(i + 2, end);
      // The CLI builds these with JSON.stringify, so a quoted segment can carry
      // escapes; this reader does not unescape, and a segment it would match
      // against the wrong key must be a null rather than a guess.
      if (segment.includes("\\")) return null;
      segments.push(segment);
      i = end + 2;
    } else {
      const rest = configPath.slice(i);
      const dot = rest.indexOf(".");
      const bracket = rest.indexOf("[");
      const stops = [dot, bracket].filter((n) => n >= 0);
      const end = i + (stops.length ? Math.min(...stops) : rest.length);
      if (end === i) return null;
      segments.push(configPath.slice(i, end));
      i = end;
    }
    if (configPath[i] === ".") {
      i += 1;
      if (i === configPath.length) return null; // trailing separator
    } else if (i < configPath.length && configPath[i] !== "[") {
      return null;
    }
  }
  return segments.length > 0 ? segments : null;
}

/**
 * The value at a dotted config path, or `undefined` when the path is absent.
 *
 * OWN properties only. A plain `current[segment]` walks the prototype chain, so
 * `constructor` or `toString` would answer with something that is not in
 * `openclaw.json` — and the one job here is to say what the file holds.
 */
function valueAtConfigPath(config: unknown, segments: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The config areas this module is willing to NAME in a log line.
 *
 * A config path is caller text. The two request bodies CodeQL traced into the
 * journal line below (js/log-injection, alert #473) are `POST
 * /setup-api/chat/model`, whose model reference becomes
 * `agents.defaults.models[<ref>].agentRuntime` through
 * `chatgptRuntimeEntryPath`, and `POST /setup-api/tts`, whose provider id
 * becomes `<tts|messages.tts>.providers.<id>.voice`. (`models.providers.<id>`
 * is the same shape, from `POST /setup-api/ai-models/configure`.) Escaping that
 * text is not enough to make the record ours: a caller who chooses the content,
 * and with it the length, of what one API call writes to the journal can forge
 * entries inside a line as well as across two.
 *
 * So the path is mapped onto one of these literals and the caller's own text
 * never reaches the line. The write is still diagnosable — which subsystem was
 * being configured is the part an operator reads — and a path under anything
 * else is named "other" rather than quoted.
 */
const LOGGED_CONFIG_AREAS = [
  "agents",
  "channels",
  "gateway",
  "memory",
  "messages",
  "models",
  "plugins",
  "tools",
  "tts",
] as const;

/**
 * The path a `config set` entry assigns: the first non-flag argv element, the
 * same rule {@link parseConfigSetArgs} reads it by. Total where that one throws
 * — an entry this cannot read yields `""`, which {@link loggedConfigAreas}
 * names "other". A log line describing a success must not be able to turn it
 * into a failure.
 */
function configSetEntryPath(args: OpenclawConfigSetArgs): string {
  return args.find((arg) => !arg.startsWith("--")) ?? "";
}

/**
 * Name the areas some config paths write to, using only the literals above.
 *
 * `find`, not a membership test: what is returned is the element of
 * {@link LOGGED_CONFIG_AREAS}, so nothing derived from the caller's path is
 * what gets logged. `LOGGED_CONFIG_AREAS.includes(root) ? root : "other"` would
 * read the same and put the request's text straight back into the record.
 */
function loggedConfigAreas(configPaths: readonly string[]): string {
  const areas = new Set<string>();
  for (const configPath of configPaths) {
    const root = configPathSegments(configPath)?.[0];
    areas.add(LOGGED_CONFIG_AREAS.find((area) => area === root) ?? "other");
  }
  return [...areas].sort().join(", ");
}

/**
 * Did the assignments of a killed `config set` actually reach the file?
 *
 * Measured on the OpenClaw box (TASK-654): `POST /setup-api/chat/model`
 * answered 500 with `openclaw config set agents.defaults.model.primary
 * <redacted> timed out after 30000ms` — and `agents.defaults.model.primary`
 * was the new model. The owner was told the switch failed over a switch that
 * had happened.
 *
 * The read is STRICT and every failure answers false: an EACCES or a file
 * caught half-written proves nothing, and `readConfig`'s `{}` for those would
 * be indistinguishable from a config that genuinely lacks the value. False
 * here means the caller's original timeout is rethrown, which is the safe
 * direction — a real failure stays a failure, and only a write this process
 * can SEE on disk is forgiven.
 */
async function configSetLanded(batch: readonly OpenclawConfigSetArgs[]): Promise<boolean> {
  let config: OpenClawConfig;
  try {
    config = await readConfigStrict();
  } catch {
    return false;
  }
  for (const args of batch) {
    let entry: { path: string; value: unknown };
    try {
      entry = parseConfigSetArgs(args);
    } catch {
      return false;
    }
    const segments = configPathSegments(entry.path);
    if (!segments) return false;
    if (!isDeepStrictEqual(valueAtConfigPath(config, segments), entry.value)) return false;
  }
  return true;
}

/**
 * Run a `config set` and, if it is killed at its deadline, let the config on
 * disk settle whether it landed.
 *
 * A SIGKILL is the one failure that carries no answer, and this is the only
 * place that can ask the question cheaply: the CLI has already been paid for,
 * and `readConfigStrict` is a file read. Every other failure — an exit code, a
 * spawn error, `OpenclawUnavailableError` — is the CLI's own verdict and is
 * rethrown untouched.
 */
async function runConfigSetVerified(
  batch: readonly OpenclawConfigSetArgs[],
  options: OpenclawConfigSetOptions,
  attempt: () => Promise<void>,
): Promise<void> {
  try {
    await attempt();
  } catch (err) {
    if (!(err instanceof OpenclawSpawnTimeoutError)) throw err;
    if (!(await configSetLanded(batch))) throw err;
    // Not `err.message`: the spawn label carries the caller's config path. (The
    // VALUES are already elided by configSetLabelArgs / configSetBatchLabelArgs;
    // the paths are not, and they are the half built from a request body.) The
    // deadline is read off the caller's options and NOT off the error, every
    // field of which hangs on an object built from that same path.
    const areas = loggedConfigAreas(batch.map(configSetEntryPath));
    console.warn(
      `[openclaw-config] a config set (${areas}) was killed at its ${options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS}ms deadline, but every assignment is on disk — the write landed, reporting success`,
    );
  }
}

/**
 * The unset half of {@link configSetLanded}: is the path gone from the file?
 *
 * Same deadline, same kill, same false failure — a removal reported as a
 * failure sends the caller to repair what is already repaired (the configure
 * route answers 502 and tells the owner to run the command by hand). An
 * unreadable config still answers false, for the reason given there.
 */
async function configUnsetLanded(configPath: string): Promise<boolean> {
  const segments = configPathSegments(configPath);
  if (!segments) return false;
  // An ABSENT config answers `{}` from readConfigStrict, and "the path is not
  // in `{}`" is not evidence of a removal — it is the one shape where the
  // "every failure answers false" rule would otherwise fail OPEN. The callers
  // only unset a path they have just seen, so a file that is now missing is a
  // state to report, not to bless.
  if (!fsSync.existsSync(CONFIG_PATH)) return false;
  try {
    return valueAtConfigPath(await readConfigStrict(), segments) === undefined;
  } catch {
    return false;
  }
}

/**
 * Argv for a batched `config set`, with every *value* elided, for use in a log
 * line — the batch counterpart of {@link configSetLabelArgs}.
 *
 * Batch mode puts the whole payload in a single argv element, so the values
 * that {@link configSetLabelArgs} carefully keeps out of the journal (the
 * ClawBox AI portal token, provider API keys, the gateway token) would all ride
 * into an error message inside one JSON blob. Name the paths, which is what
 * makes such a line diagnosable, and nothing else.
 */
export function configSetBatchLabelArgs(batch: readonly OpenclawConfigSetArgs[]): string[] {
  return [
    "config",
    "set",
    "--batch-json",
    `[${batch.map((args) => `${configSetEntryPath(args) || "<no path>"}=<redacted>`).join(",")}]`,
  ];
}

/**
 * Apply several `config set` assignments in ONE `openclaw` invocation.
 *
 * Why this exists: the CLI is a full Node program that loads the gateway SDK,
 * parses plugins and validates the config schema on every run, so on a Jetson
 * Orin Nano a single `config set` costs ~8 s of startup and does milliseconds
 * of work. First-run setup wrote ~18 keys one at a time and spent about two and
 * a half minutes doing it, with the wizard sitting on "Almost ready" for the
 * last two of them (TASK-483). `--batch-json` applies N assignments in one
 * validated read-modify-write, so N keys cost one startup instead of N.
 *
 * Semantics match a sequence of `config set --json` calls: the CLI applies the
 * entries in order against one snapshot, runs the same non-destructive
 * replacement guard per entry, and writes once. The difference that matters is
 * atomicity — a batch either lands whole or not at all — so a caller that needs
 * two failures kept apart must issue two batches, not one.
 *
 * A single-entry batch is sent through {@link runOpenclawConfigSet} unchanged:
 * there is nothing to save, and the plain form is the one every other caller
 * has been using.
 */
export async function runOpenclawConfigSetBatch(
  batch: readonly OpenclawConfigSetArgs[],
  options: OpenclawConfigSetOptions = {},
): Promise<void> {
  if (batch.length === 0) return;
  if (batch.length === 1) {
    await runOpenclawConfigSet(batch[0], options);
    return;
  }
  const payload = JSON.stringify(batch.map(parseConfigSetArgs));
  await runConfigSetVerified(batch, options, () =>
    withConfigMutationRetry(
      (timeoutMs) =>
        spawnOpenclaw(["config", "set", "--batch-json", payload], {
          labelArgs: configSetBatchLabelArgs(batch),
          timeoutMs,
          uid: options.uid,
          gid: options.gid,
          cwd: options.cwd,
          env: options.env,
        }).then(() => undefined),
      options,
      "runOpenclawConfigSetBatch",
    ),
  );
}

/**
 * Run `openclaw config unset <path>`, with the same conflict retry as
 * {@link runOpenclawConfigSet}.
 *
 * `config set` has no way to say "remove this key": a `null` or `{}` value
 * leaves the path present, and a present-but-empty `models.providers.<p>` is
 * still read by the gateway as a provider definition. Removal needs the CLI's
 * own `unset` verb — and it races the gateway's config reload exactly like a
 * set does, so it gets the same retry rather than a bare spawn.
 *
 * NOT safe to call unconditionally: verified against OpenClaw 2026.7.1-2, the
 * CLI exits 1 with "Config path not found: <path>. Nothing was changed." when
 * the path is absent. Callers must check the config first and only unset a path
 * that is actually there, so a real removal failure stays loud.
 *
 * Like {@link runOpenclawConfigSet}, a spawn killed at its deadline is settled
 * by the file rather than assumed failed: the removal is reported as done only
 * when the path is provably gone from a config this process could read. See
 * {@link configUnsetLanded}.
 */
export async function runOpenclawConfigUnset(
  configPath: string,
  options: OpenclawConfigSetOptions = {},
): Promise<void> {
  try {
    await withConfigMutationRetry(
      (timeoutMs) =>
        spawnOpenclaw(["config", "unset", configPath], {
          timeoutMs,
          uid: options.uid,
          gid: options.gid,
          cwd: options.cwd,
          env: options.env,
        }).then(() => undefined),
      options,
      "runOpenclawConfigUnset",
    );
  } catch (err) {
    if (!(err instanceof OpenclawSpawnTimeoutError)) throw err;
    if (!(await configUnsetLanded(configPath))) throw err;
    // The path is the caller's text here too — see {@link LOGGED_CONFIG_AREAS}.
    console.warn(
      `[openclaw-config] a config unset (${loggedConfigAreas([configPath])}) was killed at its ${options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS}ms deadline, but the path is gone from the config — the removal landed, reporting success`,
    );
  }
}

/**
 * OpenClaw's home directory, resolved from the environment.
 *
 * ONE expression for it, called from the constants below and from the
 * skills-root readers at the end of this file — which resolve per call, the
 * way `getSkillsDir()` has always read `HOME` per call. Identical answers on a
 * device, where the environment does not change under a running server; the
 * point is that there is no second, hard-coded spelling of the path to drift
 * from this one (the wrong-directory delete of TASK-551 started as two).
 */
function openclawHome(): string {
  return process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(process.env.HOME || "/home/clawbox", ".openclaw");
}

export const OPENCLAW_HOME = openclawHome();
const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(OPENCLAW_HOME, "agents");
export const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
export const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 24000;
// Smallest reserve worth keeping — roughly one summary's worth of headroom.
const MIN_COMPACTION_RESERVE_TOKENS_FLOOR = 4096;

// Size the compaction reserve to a model's context window. The 24000 default
// suits large-context cloud models, but it swallows most of a small local
// window — Ollama caps at 32K, so a flat 24000 leaves only ~8.7K of usable
// input, less than the agent's ~20K-token system prompt + tool schemas. Every
// turn then fails before the model runs ("context overflow" / unrecoverable
// auto-compaction). A quarter of the window, clamped to [MIN, default], keeps
// small local models usable while large windows still get the full default.
export function compactionReserveFloorForContext(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR;
  }
  return Math.min(
    DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
    Math.max(MIN_COMPACTION_RESERVE_TOKENS_FLOOR, Math.round(contextWindow / 4)),
  );
}

// Fields on each entry of `<agents-dir>/<agent>/sessions/sessions.json`
// that OpenClaw reads to decide which provider/model a running session
// uses. These are *independent* of `agents.defaults.model.primary` —
// that's just the seed for newly-opened sessions. Existing sessions
// use whichever values are baked into this per-session record, and
// OpenClaw's own auto-picker will re-populate them at chat time unless
// `modelOverrideSource` is already "manual".
//
// Exported for downstream callers (e.g. exclusive/route.ts) that need
// to snapshot + restore the raw per-field state.
export const SESSION_OVERRIDE_FIELDS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "authProfileOverride",
  "authProfileOverrideSource",
  "modelProvider",
  "model",
] as const;

interface SessionOverrideUpdate {
  /** Provider id, e.g. "llamacpp", "deepseek", "openai". */
  provider: string;
  /** Model id within the provider, e.g. "gemma4-e2b-it-q4_0". */
  modelId: string;
  /**
   * Source tag stored alongside the override. Pass **"user"** for any
   * user-initiated choice (UI clicks, explicit Local-only toggle).
   * OpenClaw's per-turn model resolver returns early when it sees
   * `modelOverrideSource === "user"` on an existing entry, which is
   * the only reliable way to make an override stick against the
   * auto-picker. `"manual"` is *not* a sticky value — OpenClaw's
   * resolver doesn't special-case it and will happily overwrite it
   * back to `"auto"` on the next turn. Pass `"auto"` only when the
   * caller is the resolver itself (not us).
   */
  source?: "user" | "manual" | "auto";
  /** Auth profile key. Defaults to `<provider>:default`. */
  authProfile?: string;
}

interface ApplyModelOverrideOpts {
  agentsDir?: string;
  /**
   * When true, sessions whose `modelOverrideSource === "user"` AND whose
   * existing override differs from the new target are LEFT ALONE — the
   * user explicitly picked a model on those sessions and we treat that
   * as sticky intent. Sessions tagged `auto`/`manual`/missing get the
   * normal sweep.
   *
   * Defaults to `false`. Routes that represent a user's *current global*
   * model preference — the chat-popup header dropdown, the wizard, and
   * the Settings AI-provider configure flow — all pass `false` (or omit
   * it). Clicking those dropdowns IS the user's current pick, so prior
   * `source: "user"` tags shouldn't make repeat clicks no-op.
   *
   * `true` is reserved for a future *per-session* model picker: a UI
   * affordance that targets a specific session and intentionally
   * preserves existing per-session user picks (e.g. parallel chats
   * deliberately running Sonnet for code review + Haiku for casual
   * chat). No such surface ships today, so this branch currently has
   * no production caller — kept for the test contract and as the
   * obvious extension point.
   *
   * Before that surface ships, note the contract is now backend-dependent:
   * on an OpenClaw 2 agent the gateway records "pinned to the new default"
   * by clearing the override (no `modelOverrideSource: "user"` survives),
   * so a later soft sweep would not see that session as sticky, where the
   * legacy file path leaves the tag in place.
   */
  skipUserTagged?: boolean;
  /**
   * The gateway transport for OpenClaw 2 agents (their sessions live in a
   * store only the gateway may write). Defaults to the CLI-backed
   * {@link callGatewayRpc}; tests inject a fake.
   */
  callGateway?: GatewayRpcCall;
}

export interface ApplyModelOverrideResult {
  /** Agents whose sessions changed: one per store or sessions.json touched. */
  filesUpdated: number;
  sessionsUpdated: number;
  /**
   * OpenClaw 2 sessions the gateway would not repoint (each one logged with
   * the gateway's reason). They keep their previous model; nothing else is
   * tried, because the only other way to change them is the store rewrite
   * that invalidates every row.
   */
  sessionsSkipped: number;
}

async function listAgentSessionsFiles(agentsDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const candidate = path.join(agentsDir, entry, "sessions", "sessions.json");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) results.push(candidate);
    } catch {
      // No sessions directory for this agent — skip.
    }
  }
  return results;
}

async function atomicWriteSessionsFile(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Repoint every existing session, across every agent on disk, to the given
 * model, so the switch reaches the chats that are already open and not only
 * the sessions born after it.
 *
 * Two store generations, two mechanisms:
 *   - OpenClaw 2 agents (an `agent/openclaw-agent.sqlite`) are patched through
 *     the gateway — `sessions.patchMany { model }` — which writes the override
 *     fields itself, tags them `modelOverrideSource: "user"` and normalises a
 *     stale `thinkingLevel`. The store is only READ, to learn the session keys.
 *     A session the gateway refuses is counted in `sessionsSkipped` and left
 *     alone; there is no fallback, because a direct `session_nodes` write is
 *     what bricked chat on every switch (finding M-03).
 *   - Legacy agents (`sessions/sessions.json`) get the atomic file rewrite,
 *     with the fields below written by hand. `source: "user"` (the default) is
 *     the only value OpenClaw's per-turn resolver treats as sticky; `"manual"`
 *     is not special-cased anywhere and is overwritten back to `"auto"` on the
 *     next turn.
 *
 * One bad agent — an unreadable store, a corrupt file — is logged and the
 * sweep continues with the rest.
 */
export async function applyModelOverrideToAllAgentSessions(
  update: SessionOverrideUpdate,
  opts: ApplyModelOverrideOpts = {},
): Promise<ApplyModelOverrideResult> {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const source = update.source ?? "user";
  const authProfile = update.authProfile ?? `${update.provider}:default`;
  const skipUserTagged = opts.skipUserTagged === true;
  const callGateway = opts.callGateway ?? callGatewayRpc;

  let filesUpdated = 0;
  let sessionsUpdated = 0;
  let sessionsSkipped = 0;

  /**
   * The soft sweep's exclusion: a session the user pinned to something else.
   * A pin that already matches the target is still swept so its source and
   * auth profile converge.
   */
  const keepsUserPick = (session: Record<string, unknown>): boolean => {
    if (!skipUserTagged || session.modelOverrideSource !== "user") return false;
    const sameProvider =
      session.providerOverride === update.provider ||
      session.modelProvider === update.provider;
    const sameModel =
      session.modelOverride === update.modelId ||
      session.model === update.modelId;
    return !sameProvider || !sameModel;
  };

  /** The legacy-file mutation. */
  const applyToSession = (session: Record<string, unknown>): boolean => {
    if (keepsUserPick(session)) return false;
    session.providerOverride = update.provider;
    session.modelOverride = update.modelId;
    session.modelOverrideSource = source;
    session.authProfileOverride = authProfile;
    session.authProfileOverrideSource = source;
    session.modelProvider = update.provider;
    session.model = update.modelId;
    // Normalise the sticky reasoning-effort override to the new model's
    // capability. `thinkingLevel` is a per-session sticky the gateway keeps
    // (set via `sessions.patch`); repointing the session to a model that
    // can't honour the old level would otherwise leave e.g. a DeepSeek
    // `high` on a local llama.cpp Gemma session, and the gateway rejects the
    // next turn with `thinkingLevel "high" is not supported for llamacpp/…
    // (use off)`. Only rewrite when the existing level is actually
    // unsupported, so a compatible level (e.g. cloud→cloud) is left intact.
    if (isThinkingLevel(session.thinkingLevel)) {
      const reasoning = getProviderReasoningConfig(update.provider, `${update.provider}/${update.modelId}`);
      if (!reasoning.levels.includes(session.thinkingLevel)) {
        session.thinkingLevel = reasoning.default;
      }
    }
    return true;
  };

  // OpenClaw 2 agents: the store names the sessions, the gateway changes them.
  // An agent with a store is served from it whatever else is on disk — its
  // (absent or archived) sessions.json is an archive the gateway no longer
  // reads, and is left alone below.
  const migratedAgents = new Set<string>();
  const model = `${update.provider}/${update.modelId}`;
  for (const agentId of listAgentIds(agentsDir)) {
    if (!sessionStorePath(agentId, agentsDir)) continue;
    migratedAgents.add(agentId);
    const rows = readSessionEntries(agentId, agentsDir);
    if (!rows) {
      console.warn(`[openclaw-config] could not list the sessions of agent ${agentId}; they keep their previous model`);
      continue;
    }
    const targets = rows
      .filter(({ entry }) => isPatchableSession(entry) && !keepsUserPick(entry))
      .map(({ key }) => ({ key, agentId }));
    if (targets.length === 0) continue;
    let patched = 0;
    for (const outcome of await patchSessionModels(targets, model, { call: callGateway })) {
      if (outcome.ok) {
        patched += 1;
        continue;
      }
      sessionsSkipped += 1;
      console.warn(
        `[openclaw-config] session ${outcome.key} (agent ${agentId}) keeps its previous model:`,
        outcome.error,
      );
    }
    sessionsUpdated += patched;
    if (patched > 0) filesUpdated += 1;
  }

  const files = (await listAgentSessionsFiles(agentsDir)).filter(
    (file) => !migratedAgents.has(path.basename(path.dirname(path.dirname(file)))),
  );
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf-8"));
    } catch (err) {
      console.error(`[openclaw-config] Skipping unreadable sessions file ${file}:`, err);
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const sessions = parsed as Record<string, Record<string, unknown>>;
    let touchedInFile = 0;
    for (const session of Object.values(sessions)) {
      if (!session || typeof session !== "object") continue;
      if (!applyToSession(session)) continue;
      touchedInFile += 1;
    }

    if (touchedInFile === 0) continue;
    try {
      await atomicWriteSessionsFile(file, sessions);
      filesUpdated += 1;
      sessionsUpdated += touchedInFile;
    } catch (err) {
      console.error(`[openclaw-config] Failed to write patched sessions file ${file}:`, err);
    }
  }

  return { filesUpdated, sessionsUpdated, sessionsSkipped };
}

/**
 * Parse a fully-qualified model id "<provider>/<modelId>" (e.g.
 * "llamacpp/gemma4-e2b-it-q4_0"). Returns null when the format is
 * unrecognised — callers should fall back to skipping the session
 * sweep rather than writing a broken override.
 */
export function parseFullyQualifiedModel(fq: string): { provider: string; modelId: string } | null {
  const idx = fq.indexOf("/");
  if (idx <= 0 || idx === fq.length - 1) return null;
  return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
}

export interface OpenClawConfig {
  [key: string]: unknown;
  /** OpenClaw 2's home for speech output (was messages.tts before 2026.8). */
  tts?: {
    provider?: string;
    providers?: Record<string, unknown>;
    [key: string]: unknown;
  };
  channels?: {
    [name: string]: {
      enabled?: boolean;
      botToken?: string;
      /** Indirect credential ("read it from this env var"). Discord uses this
       *  form rather than a literal `botToken` — see setDiscordToken. */
      token?: { source?: string; provider?: string; id?: string };
      dmPolicy?: string;
      allowFrom?: string[];
      streaming?: { mode?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
  };
  /**
   * Where a `token: {source, provider, id}` reference is resolved FROM.
   * OpenClaw looks the `provider` name up in here; there is no implicit
   * default, so a reference without a matching entry is unresolvable at
   * runtime. See {@link envSecretRef}.
   */
  secrets?: {
    providers?: Record<string, { source?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  /**
   * Plugin registry. `entries.<id>.enabled` is what makes the gateway TRUST an
   * external (non-bundled) plugin; without it a configured channel is refused
   * even though the package is installed. See {@link trustChannelPlugin}.
   */
  plugins?: {
    entries?: Record<string, { enabled?: boolean; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  tools?: {
    profile?: string;
    web?: { search?: { enabled?: boolean } };
    // Media understanding — the surface a channel voice note is transcribed
    // through. Not a models[] row: it has its own endpoint and its own ordered
    // list of engines (src/lib/stt-preference.ts builds the audio one).
    media?: {
      audio?: { baseUrl?: string; models?: unknown[]; [key: string]: unknown };
      /** OpenClaw 2's shared media-model list (audio rows carry capabilities: ["audio"]). */
      models?: unknown[];
      [key: string]: unknown;
    };
  };
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string }>;
  };
  models?: {
    mode?: string;
    providers?: Record<string, {
      // `baseUrl` appears at both levels and the model-level one wins:
      // OpenClaw resolves a row's endpoint as `model.baseUrl ?? provider.baseUrl`
      // and only then falls back to the provider's own default host. Callers
      // deciding where a configured row actually points need to see both.
      baseUrl?: string;
      models?: Array<{ id?: string; name?: string; baseUrl?: string; api?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    }>;
  };
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
      // Which model the `image_generate` tool draws with. Same shape as
      // `model`, entirely separate key — and distinct again from `imageModel`,
      // which selects the vision (image *understanding*) model.
      imageGenerationModel?: { primary?: string; fallbacks?: string[] };
      /** OpenClaw 2's home for the same choice: mediaModels.image. */
      mediaModels?: { image?: { primary?: string; fallbacks?: string[] }; [key: string]: unknown };
      // Which model *looks at* an image — the vision model OpenClaw resolves
      // when a text-only session model is handed a picture and the `image`
      // tool has to describe it. Same shape, separate key from
      // `imageGenerationModel`; nothing aliases the two.
      imageModel?: { primary?: string; fallbacks?: string[] };
      workspace?: string;
      compaction?: { reserveTokensFloor?: number };
    };
  };
}

function getOllamaProxyBaseUrl(): string {
  return `${getLocalAiProxyRootUrl()}/setup-api/local-ai/ollama`;
}

function normalizeLocalProvider(provider: string | null | undefined): "llamacpp" | "ollama" | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  if (normalized.startsWith("llamacpp")) return "llamacpp";
  if (normalized.startsWith("ollama")) return "ollama";
  return null;
}

function toLocalModel(provider: "llamacpp" | "ollama", modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  return `${provider}/${trimmed}`;
}

export function inferConfiguredLocalModel(config: OpenClawConfig): { provider: "llamacpp" | "ollama"; model: string } | null {
  const modelDefaults = config.agents?.defaults?.model;
  const localCandidates = [
    ...(Array.isArray(modelDefaults?.fallbacks) ? modelDefaults.fallbacks : []),
    modelDefaults?.primary,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => {
      const [provider, ...rest] = value.split("/");
      const normalizedProvider = normalizeLocalProvider(provider);
      if (!normalizedProvider || rest.length === 0) return null;
      return { provider: normalizedProvider, model: value };
    })
    .filter((value): value is { provider: "llamacpp" | "ollama"; model: string } => value !== null);

  if (localCandidates.length > 0) {
    return localCandidates[0];
  }

  const providerDefs = config.models?.providers ?? {};
  for (const provider of ["llamacpp", "ollama"] as const) {
    const candidate = toLocalModel(provider, providerDefs[provider]?.models?.[0]?.id);
    if (candidate) {
      return { provider, model: candidate };
    }
  }

  return null;
}

/** A JSON value that can hold named keys — i.e. not an array, null or a primitive. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readConfig(): Promise<OpenClawConfig> {
  // Same file, same root rule as the writers' reader — an unreadable file is
  // the one place they differ: a reader gets `{}`, a writer gets the throw.
  try {
    return await readConfigForWrite();
  } catch {
    return {};
  }
}

/**
 * {@link readConfig}, except that only an ENOENT is allowed to mean "there is
 * no config".
 *
 * `readConfig` answers `{}` to every failure alike — a missing file, an EACCES,
 * a file caught half-written by a concurrent `config set`. That is the right
 * default for the many callers asking "is X switched on?", where UNKNOWN and NO
 * lead to the same harmless place.
 *
 * It is the wrong default for a caller that is about to SKIP a repair because
 * the thing it repairs reads as already absent. There, `{}` from an unreadable
 * file is indistinguishable from a genuinely clean config, so the repair is
 * quietly declared unnecessary and the route reports success while the state it
 * promised to remove is still on disk.
 *
 * So: ENOENT returns `{}` (there is nothing to read, and nothing to repair),
 * and every other read or parse failure throws.
 */
export async function readConfigStrict(): Promise<OpenClawConfig> {
  const parsed = await parseConfigFileIfPresent();
  if (parsed === undefined) return {};
  // Deliberately the OPPOSITE of readConfig's answer for the same file. This
  // function exists so a caller about to skip a repair cannot be told "already
  // clean" by a config it could not read, and a root array or primitive is
  // exactly that: parseable, and not a config. Normalising it to `{}` here
  // would hand back the false "nothing to remove" this variant was written to
  // prevent.
  if (!isPlainObject(parsed)) {
    throw new Error("openclaw.json does not contain a configuration object");
  }
  return parsed as OpenClawConfig;
}

/**
 * The read half of a read-modify-write.
 *
 * `readConfig` answers `{}` to every failure alike, and a writer that starts
 * from that `{}` and saves has just replaced the whole file with the one block
 * it was asked to add — every model provider, auth profile and gateway setting
 * gone, and the route answers 200. That is exactly what a momentarily
 * unreadable file produces: an EACCES, a file caught half-written by a
 * concurrent `openclaw config set`. So here a file that cannot be read or
 * parsed THROWS, the route answers 500, and the config on disk is untouched.
 *
 * Two shapes are still forgiven, deliberately. ENOENT is the first-run
 * contract: there is nothing to lose. And a parseable non-object root (`[]`,
 * `"nope"`, `3`, `null`) is a file OpenClaw cannot load at all — the gateway
 * exits 78/CONFIG on it — so there is no working configuration to protect, and
 * the writers repair it inside the same atomic write (see
 * {@link ensurePlainObject}). That last case is the one difference from
 * {@link readConfigStrict}, whose callers are about to SKIP a repair and must
 * not be told "already clean" by a root that is not a config.
 */
export async function readConfigForWrite(): Promise<OpenClawConfig> {
  const parsed = await parseConfigFileIfPresent();
  // The ROOT is a container too, and it is the one every helper below stands
  // on. A file holding `[]` parses fine, so without this the writers attach
  // their keys to an array and `JSON.stringify` drops all of them; a root
  // string or number makes the first assignment throw in strict mode. See
  // {@link ensurePlainObject}.
  return isPlainObject(parsed) ? (parsed as OpenClawConfig) : {};
}

/**
 * openclaw.json exists but could not be read or parsed. The message is the
 * one the owner sees — the Telegram routes answer it as the 500 body — so it
 * says what happened and what was (not) done, never the parser's internals or
 * the file's absolute path. The underlying error is kept on `cause`.
 */
export class OpenclawConfigUnreadableError extends Error {
  readonly code = "config_unreadable";

  constructor(cause: unknown) {
    const reason =
      cause instanceof SyntaxError
        ? "it is not valid JSON"
        : (cause as NodeJS.ErrnoException)?.code ?? "read failed";
    super(
      `OpenClaw's configuration file (openclaw.json) could not be read (${reason}), so nothing was saved. Check the file and try again.`,
      { cause },
    );
    this.name = "OpenclawConfigUnreadableError";
  }
}

/**
 * The file's parsed JSON, or `undefined` when there is no file (JSON.parse
 * never yields `undefined`, so the sentinel cannot collide with content).
 * Every other read error and every parse error surfaces as
 * {@link OpenclawConfigUnreadableError} — the callers above exist to tell "no
 * config" apart from "could not read the config".
 */
async function parseConfigFileIfPresent(): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new OpenclawConfigUnreadableError(err);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new OpenclawConfigUnreadableError(err);
  }
}

/**
 * Return `container[key]` as a plain object, REPLACING first whatever else is
 * there — an array, a string, a number, a boolean.
 *
 * `??=` is not enough for this, and the difference does not show up until the
 * write has already been reported as successful:
 *
 *   * `[]` is not nullish, so `config.plugins ??= {}` keeps the array. The next
 *     assignment attaches a NAMED PROPERTY to it, and `JSON.stringify` — which
 *     is how every config write in this module reaches disk — drops named
 *     properties of arrays. The save writes a config missing the very key it
 *     was called to add, and answers 200.
 *   * `[].entries` is not nullish either: it is `Array.prototype.entries`. So
 *     `plugins.entries ??= {}` keeps the intrinsic and the channel's trust
 *     entry is written onto a shared JS function. Measured: after one such
 *     save, an unrelated `[].entries.discord` reads `{"enabled":true}` for the
 *     rest of the server process's life.
 *   * a string or a number is worse again — assigning a property to a
 *     primitive THROWS in strict mode (ES modules always are), so the save dies
 *     halfway as an opaque 500.
 *
 * Replacing rather than refusing is deliberate, and it is the opposite of the
 * choice {@link envSecretRef} makes one screen down. A non-object `secrets` is
 * the operator's own credential wiring: we cannot interpret it, and overwriting
 * it would break channels that resolve through it today, so that path refuses
 * and writes nothing. A non-object `plugins`/`channels`/`agents`/`gateway` is
 * not a shape OpenClaw's schema can load at all — the gateway exits 78/CONFIG
 * on it — so there is no working configuration to protect, and refusing would
 * only leave the box stuck in the state it is already broken in. Normalising
 * repairs it inside the same atomic write.
 */
function ensurePlainObject(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = container[key];
  if (isPlainObject(existing)) return existing;
  const replacement: Record<string, unknown> = {};
  container[key] = replacement;
  return replacement;
}

/** The config as a bag of keys, for the container helpers above. */
function asBag(config: OpenClawConfig): Record<string, unknown> {
  return config as Record<string, unknown>;
}

/**
 * The existing block for one channel, as something safe to spread.
 *
 * Every channel writer here rebuilds the block as `{...existing, enabled, …}`
 * so it can drop the keys it re-secures. Spreading a STRING splits it into
 * indexed characters (`"on"` becomes `{"0":"o","1":"n"}`), and one key OpenClaw
 * does not know takes the whole gateway down with exit 78/CONFIG — every other
 * channel with it. A block that is not a plain object carries nothing worth
 * merging, so it is treated as absent.
 */
function existingChannelBlock(
  channels: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  const existing = channels[channelId];
  return isPlainObject(existing) ? existing : {};
}

export async function writeConfig(config: OpenClawConfig): Promise<void> {
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmpPath, CONFIG_PATH);
}

const OPENCLAW_CONFIG_LOCK_STALE_MS = 30_000;
const OPENCLAW_CONFIG_LOCK_MAX_BYTES = 1024 * 1024;

type FileStat = Awaited<ReturnType<typeof fs.lstat>>;
type LockOwnerPayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
  clawboxOwnerToken?: string;
};
type LockSnapshot = { raw: string; payload: LockOwnerPayload | null; stat: FileStat };

/** True only when both stats name the same filesystem object. */
function sameFileIdentity(left: FileStat, right: FileStat): boolean {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

/** Normalize Stats/BigIntStats' millisecond timestamp overload to a number. */
function fileMtimeMs(stat: FileStat): number {
  return Number(stat.mtimeMs);
}

/** Read Linux's process-start identity, which disambiguates a reused PID. */
async function processStarttime(pid: number): Promise<number | null> {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commEnd = raw.lastIndexOf(")");
    if (commEnd < 0) return null;
    const fields = raw.slice(commEnd + 1).trimStart().split(/\s+/);
    const value = Number(fields[19]);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Prove a PID dead without treating EPERM or an unreadable procfs as death. */
async function pidIsDefinitelyDead(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (process.platform !== "linux") return false;
  try {
    return /^State:\s+Z\b/m.test(await fs.readFile(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Read one stable, bounded snapshot of a sidecar without following symlinks.
 * A changed inode or oversized/malformed payload is retained, never guessed
 * stale; fail-closed is the safe direction for another process's lock.
 */
async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  const noFollow = typeof fsSync.constants.O_NOFOLLOW === "number" ? fsSync.constants.O_NOFOLLOW : 0;
  const nonBlock = typeof fsSync.constants.O_NONBLOCK === "number" ? fsSync.constants.O_NONBLOCK : 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    // Open first, with symlink following disabled, then inspect and read only
    // through that pinned descriptor. A pathname lstat before open is a TOCTOU:
    // another process can replace the sidecar between the check and use. The
    // post-read lstat below is only an identity proof that this still-pinned
    // file remains the path's current owner.
    handle = await fs.open(lockPath, fsSync.constants.O_RDONLY | noFollow | nonBlock);
    const opened = await handle.stat();
    if (!opened.isFile()) return null;
    const capacity = Math.min(opened.size, OPENCLAW_CONFIG_LOCK_MAX_BYTES) + 1;
    const buffer = Buffer.alloc(capacity);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > OPENCLAW_CONFIG_LOCK_MAX_BYTES) return null;
    const after = await fs.lstat(lockPath).catch(() => null);
    if (!after?.isFile() || !sameFileIdentity(opened as FileStat, after)) return null;
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    let payload: LockOwnerPayload | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as LockOwnerPayload;
      }
    } catch {
      // OpenClaw's ownership token is whitespace, so its payload remains valid
      // JSON. Any other trailing content is not an owner we can safely judge.
    }
    return { raw, payload, stat: after };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Apply OpenClaw's dead-PID/expired-owner stale policy to one snapshot. */
async function lockIsStale(snapshot: LockSnapshot): Promise<boolean> {
  const payload = snapshot.payload;
  const pid = typeof payload?.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
    ? payload.pid
    : null;
  if (pid !== null) {
    if (typeof payload?.starttime === "number" && Number.isInteger(payload.starttime) && payload.starttime >= 0) {
      const current = await processStarttime(pid);
      if (current !== null && current !== payload.starttime) return true;
    }
    // A valid, live PID wins over an old createdAt, exactly as OpenClaw's own
    // shouldRemoveDeadOwnerOrExpiredLock policy does.
    return pidIsDefinitelyDead(pid);
  }
  const createdAt = typeof payload?.createdAt === "string" ? Date.parse(payload.createdAt) : Number.NaN;
  // A crash can leave the exclusively-created sidecar empty, before its owner
  // payload is written. Missing/malformed owner data ages by the file itself;
  // otherwise that zero-byte lock can never be reclaimed.
  const ownerTimestamp = Number.isFinite(createdAt) ? createdAt : fileMtimeMs(snapshot.stat);
  return Number.isFinite(ownerTimestamp) && Date.now() - ownerTimestamp > OPENCLAW_CONFIG_LOCK_STALE_MS;
}

type ReclaimGuardState = "missing" | "active" | "reclaimed";

/**
 * Inspect OpenClaw's reclaim guard through a pinned directory descriptor.
 * A recent guard is live and retained. An abandoned guard ages out after the
 * same 30 s as its lock. Reclamation first atomically renames the path to an
 * unpredictable quarantine: a successor created at the canonical path is
 * never removed, and the moved directory is deleted only when its descriptor
 * identity is the stale directory we observed.
 */
async function inspectReclaimGuard(guardPath: string): Promise<ReclaimGuardState> {
  const noFollow = typeof fsSync.constants.O_NOFOLLOW === "number" ? fsSync.constants.O_NOFOLLOW : 0;
  const nonBlock = typeof fsSync.constants.O_NONBLOCK === "number" ? fsSync.constants.O_NONBLOCK : 0;
  const directory = typeof fsSync.constants.O_DIRECTORY === "number" ? fsSync.constants.O_DIRECTORY : 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(guardPath, fsSync.constants.O_RDONLY | noFollow | nonBlock | directory);
    const opened = await handle.stat() as FileStat;
    if (!opened.isDirectory()) return "active";
    const guardMtimeMs = fileMtimeMs(opened);
    if (!Number.isFinite(guardMtimeMs) || Date.now() - guardMtimeMs <= OPENCLAW_CONFIG_LOCK_STALE_MS) {
      return "active";
    }
    const quarantinePath = `${guardPath}.quarantine-${randomUUID()}`;
    try {
      await fs.rename(guardPath, quarantinePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      if (code === "EEXIST" || code === "ENOTEMPTY") return "active";
      throw err;
    }

    let movedHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      movedHandle = await fs.open(quarantinePath, fsSync.constants.O_RDONLY | noFollow | nonBlock | directory);
      const moved = await movedHandle.stat() as FileStat;
      if (!moved.isDirectory() || !sameFileIdentity(opened, moved)) {
        // The canonical path was replaced between open and rename. Retain the
        // moved successor under quarantine and restore guard *presence* with
        // an exclusive mkdir; never rename over a newer live guard.
        await fs.mkdir(guardPath).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        });
        return "active";
      }
      try {
        await fs.rmdir(quarantinePath);
        return "reclaimed";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return "reclaimed";
        if (code === "EEXIST" || code === "ENOTEMPTY") {
          await fs.mkdir(guardPath).catch((mkdirErr) => {
            if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirErr;
          });
          return "active";
        }
        throw err;
      }
    } finally {
      await movedHandle?.close().catch(() => {});
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ELOOP" || code === "ENOTDIR") return "active";
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Remove only the exact inode and bytes represented by `snapshot`. */
async function unlinkUnchangedSnapshot(lockPath: string, snapshot: LockSnapshot): Promise<boolean> {
  const current = await readLockSnapshot(lockPath);
  if (!current || !sameFileIdentity(snapshot.stat, current.stat) || snapshot.raw !== current.raw) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Reclaim one proven-stale lock under OpenClaw's `.reclaim` hand-off guard. */
async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  const observed = await readLockSnapshot(lockPath);
  if (!observed || !(await lockIsStale(observed))) return false;
  const guardPath = `${lockPath}.reclaim`;
  try {
    await fs.mkdir(guardPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    const current = await readLockSnapshot(lockPath);
    if (!current
      || !sameFileIdentity(observed.stat, current.stat)
      || observed.raw !== current.raw
      || !(await lockIsStale(current))) return false;
    return unlinkUnchangedSnapshot(lockPath, current);
  } finally {
    await fs.rmdir(guardPath).catch(() => {});
  }
}

/** Release our sidecar only while its inode or unique owner token is ours. */
async function releaseOwnedLock(lockPath: string, heldStat: FileStat | null, ownerToken: string): Promise<void> {
  const current = await readLockSnapshot(lockPath).catch(() => null);
  if (!current) return;
  const owns = heldStat
    ? sameFileIdentity(heldStat, current.stat)
    : current.payload?.clawboxOwnerToken === ownerToken;
  if (owns) await unlinkUnchangedSnapshot(lockPath, current).catch(() => {});
}

/**
 * Run one direct config mutation under OpenClaw 2's cross-process sidecar
 * lock. The core CLI uses an exclusive `openclaw.json.lock` regular file for
 * the same purpose, so holding it serializes this exceptional unvalidated
 * write with gateway and CLI mutations as well as concurrent setup requests.
 */
async function withOpenclawConfigSidecarLock<T>(mutate: () => Promise<T>): Promise<T> {
  const lockPath = `${CONFIG_PATH}.lock`;
  const reclaimGuardPath = `${lockPath}.reclaim`;
  const deadline = Date.now() + 30_000;
  let attempt = 0;
  let lockHandle: Awaited<ReturnType<typeof fs.open>>;
  let heldStat: FileStat | null = null;
  const ownerToken = randomUUID();
  const starttime = await processStarttime(process.pid);
  const ownerRaw = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...(starttime === null ? {} : { starttime }),
    clawboxOwnerToken: ownerToken,
  }) + "\n";

  // `readConfigStrict` deliberately treats ENOENT as a fresh `{}` config and
  // `writeConfig` creates this directory. The lock has to preserve that same
  // first-run contract rather than failing one step earlier when even the
  // OpenClaw home directory does not exist yet.
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });

  while (true) {
    try {
      const guardState = await inspectReclaimGuard(reclaimGuardPath);
      if (guardState === "active") {
        throw Object.assign(new Error(`config lock reclamation is active: ${reclaimGuardPath}`), { code: "EEXIST" });
      }
      if (guardState === "reclaimed") continue;
      lockHandle = await fs.open(lockPath, "wx", 0o600);
      let acquisitionError: unknown = null;
      try {
        heldStat = await lockHandle.stat() as FileStat;
      } catch (err) {
        acquisitionError = err;
      }
      try {
        await lockHandle.writeFile(ownerRaw, "utf8");
      } catch (err) {
        acquisitionError ??= err;
      }
      if (acquisitionError) {
        await lockHandle.close().catch(() => {});
        await releaseOwnedLock(lockPath, heldStat, ownerToken);
        throw acquisitionError;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (await reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) throw err;
      const delayMs = Math.min(250, Math.round(25 * (1.2 ** attempt)));
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  try {
    return await mutate();
  } finally {
    await lockHandle.close().catch(() => {});
    await releaseOwnedLock(lockPath, heldStat, ownerToken);
  }
}

/**
 * Set only `agents.defaults.model.primary` without catalog validation.
 *
 * This is reserved for the setup contract that accepts a placeholder API key:
 * OpenClaw 2's CLI rejects the model when its live catalog cannot authenticate,
 * even though the gateway may keep that unresolved reference at rest. The
 * complete-file fallback must nevertheless use the core's sidecar lock so it
 * cannot overwrite a concurrent provider, auth, or gateway mutation.
 */
export async function setPrimaryModelWithoutCatalogValidation(modelRef: string): Promise<void> {
  if (!parseFullyQualifiedModel(modelRef)) {
    throw new Error(`Invalid fully-qualified model reference: ${modelRef}`);
  }
  await withOpenclawConfigSidecarLock(async () => {
    const config = await readConfigStrict();
    const agents = (config.agents ??= {});
    const defaults = (agents.defaults ??= {}) as Record<string, unknown>;
    const model = (defaults.model ??= {}) as Record<string, unknown>;
    model.primary = modelRef;
    await writeConfig(config);
  });
}

/**
 * `skills.entries.<id>.enabled` — the switch the installed-app window flips.
 *
 * Written directly rather than through `openclaw config set`: that CLI costs
 * 10–17 s per call on the Jetson (the App Store's toggle used to spend a 10 s
 * budget on it and answer 500 after the value had already landed), while the
 * gateway hot-reloads exactly this key from the file, so a JSON write is the
 * same change without the wait. Absent means enabled, which is OpenClaw's
 * default too.
 */
export async function readSkillEnabled(skillId: string): Promise<boolean> {
  const config = await readConfig();
  const skills = config.skills;
  const entries = isPlainObject(skills) ? skills.entries : undefined;
  const entry = isPlainObject(entries) ? entries[skillId] : undefined;
  return !(isPlainObject(entry) && entry.enabled === false);
}

export async function setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
  // Guarded here, not only in the apps/settings route: `__proto__` would
  // resolve to Object.prototype in ensurePlainObject and write `enabled` onto
  // every object in the process without ever reaching the file, and a second
  // caller (an MCP tool, a CLI path) must not be able to reintroduce that.
  if (skillId === "__proto__" || skillId === "constructor" || skillId === "prototype") {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  const config = await readConfigStrict();
  const skills = ensurePlainObject(asBag(config), "skills");
  const entries = ensurePlainObject(skills, "entries");
  const entry = ensurePlainObject(entries, skillId);
  entry.enabled = enabled;
  await writeConfig(config);
}

/**
 * Drop `skills.entries.<id>` when an app is uninstalled, so a later install
 * under the same id does not inherit a stale `enabled: false`. Answers whether
 * anything was written; a config with no such entry is left untouched.
 */
export async function clearSkillEntry(skillId: string): Promise<boolean> {
  const config = await readConfigStrict();
  const skills = config.skills;
  const entries = isPlainObject(skills) ? skills.entries : undefined;
  if (!isPlainObject(entries) || !Object.prototype.hasOwnProperty.call(entries, skillId)) return false;
  delete entries[skillId];
  await writeConfig(config);
  return true;
}

/**
 * Keep Microsoft's bundled Edge TTS out of the speech chain.
 *
 * OpenClaw's fallback order is every registered speech provider sorted by a
 * hard-coded rank, and Microsoft (rank 30) sits between our cloud voice and
 * the on-device voice (rank 1000). Measured on this box: a failing ClawBox AI
 * call fell back to Microsoft's public web endpoint — a second cloud the
 * privacy notice never named — before Kokoro ever got the text. Nothing
 * reorders that rank; the documented switch is `providers.microsoft.enabled`,
 * which the provider's own isConfigured() honours everywhere: synthesis, the
 * auto-selected primary, the gateway's startup scope and `tts.status`.
 *
 * Two guards keep this a default, not a decree: an explicit boolean either way
 * is the owner's and is left alone, and the switch is only written on a box
 * that HAS its own voice (`tts-local-cli` registered). A box with no local
 * voice and no cloud entitlement would otherwise have no voice at all.
 */
export async function ensureMicrosoftTtsExcluded(): Promise<boolean> {
  const config = await readConfig();
  // OpenClaw 2 home first (top-level tts), then the pre-2026.8 messages.tts.
  // The switch is written back into whichever home the providers were found
  // in — writing the other one would be a key the running gateway refuses.
  const topLevel = (config as { tts?: Record<string, unknown> }).tts;
  const messages = (config as { messages?: Record<string, unknown> }).messages;
  const legacy = messages?.tts as { providers?: Record<string, unknown> } | undefined;
  const tts = (topLevel && typeof topLevel === "object" ? topLevel : undefined) ?? legacy;
  const providers = (tts as { providers?: Record<string, unknown> } | undefined)?.providers;
  if (!providers || typeof providers !== "object") return false;
  if (!providers["tts-local-cli"]) return false;
  const microsoft = providers.microsoft;
  const entry = microsoft && typeof microsoft === "object" ? (microsoft as Record<string, unknown>) : {};
  if (typeof entry.enabled === "boolean") return false;
  providers.microsoft = { ...entry, enabled: false };
  await writeConfig(config);
  return true;
}

export async function ensureLocalAiProxyUrls(): Promise<boolean> {
  const config = await readConfig();
  const providers = config.models?.providers;
  if (!providers) {
    return false;
  }

  let changed = false;

  const llamaProvider = providers.llamacpp;
  if (llamaProvider && llamaProvider.baseUrl !== getLlamaCppProxyBaseUrl()) {
    llamaProvider.baseUrl = getLlamaCppProxyBaseUrl();
    changed = true;
  }

  const ollamaProvider = providers.ollama;
  if (ollamaProvider && ollamaProvider.baseUrl !== getOllamaProxyBaseUrl()) {
    ollamaProvider.baseUrl = getOllamaProxyBaseUrl();
    changed = true;
  }

  if (changed) {
    await writeConfig(config);
  }

  return changed;
}

/**
 * Set the OpenClaw gateway control-UI allowed origins to include the given
 * mDNS hostname. Always preserves the standard local origins so the device
 * remains reachable via IP and the AP captive portal even after a rename.
 */
export async function setControlUiAllowedOrigins(hostname: string): Promise<void> {
  const config = await readConfigForWrite();
  const gateway = ensurePlainObject(asBag(config), "gateway");
  const controlUi = ensurePlainObject(gateway, "controlUi");
  const existing = Array.isArray(controlUi.allowedOrigins)
    ? (controlUi.allowedOrigins as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const origins = new Set<string>([
    ...existing,
    `http://${hostname}.local`,
    "http://localhost",
    "http://127.0.0.1",
    "http://10.42.0.1",
    "http://10.43.0.1", // alt subnet when home network collides with 10.42.0.0/24
  ]);
  controlUi.allowedOrigins = Array.from(origins);
  await writeConfig(config);
}

/** OpenClaw's id for the Telegram channel — the config key's, and the plugin's. */
const TELEGRAM_CHANNEL_ID = "telegram";

export async function setTelegramToken(botToken: string): Promise<void> {
  const config = await readConfigForWrite();
  const channels = ensurePlainObject(asBag(config), "channels");
  // Do NOT set `dmPolicy` or `allowFrom` here. OpenClaw's default
  // (`dmPolicy: "pairing"`) requires the owner to approve every new sender
  // via an in-Telegram pairing code before the agent responds. Writing
  // `dmPolicy: "open"` + `allowFrom: ["*"]` would open the bot — and with it
  // the agent's shell/file/system_power tools — to any Telegram user who
  // finds the handle. Reconfiguring a bot token on a device with those
  // values already stored should re-secure the channel, so strip them here
  // too rather than merging on top of the stale insecure config.
  const {
    dmPolicy: _dmPolicy,
    allowFrom: _allowFrom,
    ...rest
  } = existingChannelBlock(channels, TELEGRAM_CHANNEL_ID);
  channels[TELEGRAM_CHANNEL_ID] = {
    ...rest,
    enabled: true,
    botToken,
  };
  await writeConfig(config);
}

// Whether the Telegram bot streams live tool/research progress ("Bubbling…"
// drafts) while it works. OpenClaw gates the progress draft on the channel's
// streaming mode: `mode: "off"` suppresses all intermediate drafts (the bot
// delivers the final answer only), and the absence of a `streaming` key falls
// back to OpenClaw's default (progress shown). So "enabled" == not explicitly
// turned off.
export async function getTelegramProgressStreaming(): Promise<boolean> {
  const config = await readConfig();
  return config.channels?.telegram?.streaming?.mode !== "off";
}

export async function setTelegramProgressStreaming(enabled: boolean): Promise<void> {
  const config = await readConfigForWrite();
  const channels = ensurePlainObject(asBag(config), "channels");
  const existing = existingChannelBlock(channels, TELEGRAM_CHANNEL_ID);
  if (enabled) {
    // Restore OpenClaw's default by dropping our override entirely.
    const { streaming: _streaming, ...rest } = existing;
    channels[TELEGRAM_CHANNEL_ID] = { ...rest };
  } else {
    // Final-answer-only: suppress the progress/preview draft.
    channels[TELEGRAM_CHANNEL_ID] = { ...existing, streaming: { mode: "off" } };
  }
  // Note: unlike setTelegramToken this does not strip dmPolicy/allowFrom — it's
  // a preference toggle, not a token re-secure; gateway-pre-start.sh already
  // strips those on every boot.
  await writeConfig(config);
}

// === Discord ===
//
// Discord differs from Telegram in one structural way that is easy to miss:
// OpenClaw's Discord channel takes its credential as an env REFERENCE
// (`token: {source:"env", provider:"default", id:"DISCORD_BOT_TOKEN"}`), not as
// a literal string like `channels.telegram.botToken`. So writing the config is
// only half the job — DISCORD_BOT_TOKEN also has to be present in the gateway
// PROCESS environment, and `secrets.providers.default` has to exist for the
// reference to resolve at all (see envSecretRef below), or the config
// validates, the gateway starts, and the bot silently never logs in.
//
// That is what `data/discord.env` is for: clawbox-gateway.service loads it with
// `EnvironmentFile=-`, the same mechanism it already uses for network.env.
// systemd re-reads EnvironmentFile on every start, so the restart that follows
// a save is what picks the value up.

// === Env-backed credentials (SecretRefs) ====================================
//
// A channel whose credential lives in the gateway's PROCESS environment is
// configured with a reference, not a literal:
//
//     token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" }
//
// OpenClaw resolves that through `resolveProviderRefs()`, which switches on
// `secrets.providers[<provider>].source`. THERE IS NO IMPLICIT DEFAULT
// PROVIDER — grepping the shipped runtime for one finds nothing. A config that
// carries the reference and no `secrets` block therefore validates, starts the
// channel, and then kills it on first use:
//
//     Discord bot token configured for account "default" is unavailable;
//     resolve SecretRefs against the active runtime snapshot before using this
//     account.
//
// which on a live box was a restart loop behind a panel reporting success.
// Adding the provider and restarting fixed it immediately.

/** The single provider name every env SecretRef this repo writes points at. */
export const ENV_SECRET_PROVIDER = "default";

/**
 * Mint an env SecretRef for `envVar`, installing the provider it resolves
 * through into `config` as a side effect.
 *
 * THE CHOKEPOINT. The reference and the provider that makes it resolvable are
 * produced by one call, so a channel added later cannot repeat this bug by
 * writing the reference and forgetting the provider — the two cannot be
 * written apart. Grep `source: "env"` across `src/` and this is the only
 * production writer of one; `gateway-proxy.ts` only ever READS the shape.
 *
 * CREATE-IF-ABSENT, never rewrite, and REFUSE on a conflict.
 *
 * `secrets.providers` is shared config: the name is a plain map key and
 * OpenClaw resolves purely on the entry's `source` (resolveProviderRefs
 * switches on it and uses the name only for the lookup and the error text). So
 * an entry already there was put there by whoever administers the box, and
 * silently repointing it at the environment because one channel wanted that is
 * how a change that "fixed Discord" would quietly break somebody else's file-
 * or exec-backed secrets.
 *
 * Writing the reference anyway is not the safe fallback either. It produces a
 * channel that is configured, enabled, and cannot start — the exact state this
 * change exists to remove — and it does it to a config the operator owns, on a
 * box where their other secrets already resolve. Refusing costs the owner one
 * actionable message; writing costs them a channel that lies about itself.
 *
 * The caller turns this into `token_unresolved` for the panel, having written
 * nothing.
 *
 * (A malformed provider entry is a separate and harsher failure: OpenClaw
 * validates the whole config on boot, so one out-of-schema `secrets` value
 * makes the gateway exit 78/CONFIG and roll openclaw.json back to
 * `.last-good` — taking every other channel with it. We never write that shape;
 * the note is here because it is what makes `secrets` worth leaving alone.)
 */
export class EnvSecretProviderConflictError extends Error {
  constructor(
    readonly provider: string,
    readonly conflictingSource: string,
  ) {
    super(
      `Secret provider "${provider}" has source "${conflictingSource}", so an environment-backed ` +
        `reference cannot resolve through it.`,
    );
    this.name = "EnvSecretProviderConflictError";
  }
}

export function envSecretRef(
  config: OpenClawConfig,
  envVar: string,
): { source: "env"; provider: string; id: string } {
  // Everything here came off disk via readConfig(), which returns whatever the
  // file parsed to. A `secrets` that is a string, or a provider entry that is
  // null, must produce the typed refusal the caller already handles — not a
  // TypeError that becomes an opaque 500 halfway through a save.
  if (config.secrets !== undefined && !isPlainObject(config.secrets)) {
    throw new EnvSecretProviderConflictError(ENV_SECRET_PROVIDER, typeof config.secrets);
  }
  const secrets = (config.secrets ??= {});
  if (secrets.providers !== undefined && !isPlainObject(secrets.providers)) {
    throw new EnvSecretProviderConflictError(ENV_SECRET_PROVIDER, typeof secrets.providers);
  }
  const providers = (secrets.providers ??= {});

  const existing = providers[ENV_SECRET_PROVIDER];
  if (existing === undefined) {
    providers[ENV_SECRET_PROVIDER] = { source: "env" };
  } else if (!isPlainObject(existing)) {
    throw new EnvSecretProviderConflictError(ENV_SECRET_PROVIDER, existing === null ? "null" : typeof existing);
  } else if (existing.source !== "env") {
    throw new EnvSecretProviderConflictError(ENV_SECRET_PROVIDER, String(existing.source));
  }
  return { source: "env", provider: ENV_SECRET_PROVIDER, id: envVar };
}

/** Env var the gateway resolves the Discord credential from. */
export const DISCORD_TOKEN_ENV_VAR = "DISCORD_BOT_TOKEN";

/** OpenClaw's id for the Discord channel — the config key's, and the plugin's. */
const DISCORD_CHANNEL_ID = "discord";

// The data dir is re-derived here rather than imported from config-store, and
// that is load-bearing, not a style choice. This module is imported (via
// updater.ts and the setup-api routes) by test files that replace
// "@/lib/config-store" with a factory mock listing only the store functions
// they use. `DATA_DIR` is then `undefined`, and a top-level
// `path.join(DATA_DIR, …)` throws while merely IMPORTING this file — killing
// whole unrelated test files. The resolution below matches config-store.ts
// exactly, so both still write under the same root; every other lib that needs
// the data dir without depending on the store does the same (tunnel.ts,
// sqlite-store.ts, mcp-token.ts).
const DATA_DIR = path.join(
  process.env.CLAWBOX_ROOT ||
    (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox"),
  "data",
);

/** EnvironmentFile the gateway unit loads the Discord token from. */
export const DISCORD_ENV_PATH = path.join(DATA_DIR, "discord.env");

/**
 * Write `data/discord.env` at 0600.
 *
 * Written temp-then-rename, and chmod'ed explicitly: `writeFile`'s `mode` is
 * only honoured when it CREATES the file, so a rewrite over an existing 0644
 * would silently keep the loose mode (same reasoning as config-store.ts).
 *
 * The value is interpolated unquoted, which is safe because this function
 * itself restricts the token to `[A-Za-z0-9._-]` (isSafeDiscordToken) before
 * writing — no newline can split the line, no quote can escape it.
 *
 * That guard is also the answer to "a request body ends up in a file here". The
 * destination is DISCORD_ENV_PATH, a module constant, so nothing request-derived
 * chooses where this lands; the only request-derived part is the token, which
 * has to BE the credential for the write to be worth doing at all. The configure
 * route rejects anything outside that charset far earlier with an actionable
 * message, and Discord itself has to accept the token before the write happens
 * — but the charset invariant no longer depends on either of them holding.
 */
export async function writeDiscordGatewayEnv(botToken: string): Promise<void> {
  // Enforced HERE, not just trusted from the caller. The unquoted interpolation
  // below is only safe while the token cannot contain a newline or a quote, and
  // an exported writer whose safety lives entirely in whoever calls it is one
  // future caller away from an env-file injection. The configure route still
  // rejects a bad token far earlier, with a message the owner can act on; this
  // is the guarantee that the file format cannot be broken even if it doesn't.
  if (!isSafeDiscordToken(botToken)) {
    throw new Error("Refusing to write an unsafe Discord token to the gateway env file");
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${DISCORD_ENV_PATH}.tmp`;
  const body =
    "# Written by ClawBox. Loaded by clawbox-gateway.service (EnvironmentFile).\n" +
    "# Do not edit by hand — the Discord section of Settings rewrites this file.\n" +
    `${DISCORD_TOKEN_ENV_VAR}=${botToken}\n`;
  await fs.writeFile(tmpPath, body, { mode: 0o600, encoding: "utf-8" });
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, DISCORD_ENV_PATH);
}

/**
 * Register the Discord channel with the OpenClaw gateway.
 *
 * Deliberately writes the smallest config that can work:
 *   * `enabled` + the env-reference `token`, and nothing else. OpenClaw refuses
 *     to start on an unknown key or an out-of-schema value, and a refusal takes
 *     the WHOLE config down — including a working Telegram bot. Every optional
 *     knob we could write here (groupPolicy, guilds, commands, streaming) is a
 *     value we would be guessing at, so we let OpenClaw's own defaults stand.
 *   * `dmPolicy`/`allowFrom` are STRIPPED, never written. OpenClaw defaults to
 *     `dmPolicy: "pairing"`, i.e. the owner approves each new sender. Writing
 *     "open"/["*"] would expose the agent's shell/file/system_power tools to
 *     anyone who finds the bot — the exact bug the Telegram path carries a boot-
 *     time migration for (scripts/gateway-pre-start.sh), which now covers this
 *     channel too.
 *   * a literal `botToken` left by any other writer is dropped, so the env
 *     reference is the only credential path and a stale copy cannot outlive it.
 */
/**
 * Mark the channel plugin `channelId` as trusted, in whatever config object the
 * caller is about to write.
 *
 * INSTALLATION AND TRUST ARE DIFFERENT FACTS. `openclaw plugins install` puts
 * the package in OpenClaw's own store AND writes `plugins.entries.<id>` — but
 * that entry lives in the same openclaw.json every other route in this repo
 * read-modify-writes. A route that read the file before a channel save and
 * wrote it after drops the entry without touching anything it meant to, and the
 * gateway then refuses the channel it is still configured for:
 *
 *     channels.discord: channel is configured, but external plugin "discord" is
 *     installed without explicit trust. Add plugins.entries.discord.enabled=true.
 *
 * Measured on a live box: the channel connected, a config write two minutes
 * later dropped the entry, and `channels status` answered `unknown channel:
 * discord` from then on while the panel's card sat at "unknown". Restoring the
 * entry brought it back to connected across a full restart.
 *
 * So ClawBox writes the trust entry ITSELF, in the same atomic write as the
 * channel block — the same reasoning as {@link envSecretRef}: the facts that
 * have to be true together are written together, and cannot be separated by a
 * concurrent writer.
 *
 * Merges rather than replaces, because the entry is shared config and may carry
 * keys this repo knows nothing about.
 */
export function trustChannelPlugin(config: OpenClawConfig, channelId: string): void {
  // `??=` cannot be used for either container: `"plugins": []` is not nullish
  // and neither is `[].entries` (it is `Array.prototype.entries`), so the entry
  // would be attached to an array — dropped by `JSON.stringify` on the way to
  // disk — or onto a JS intrinsic. Both look like a successful save and leave
  // the gateway answering `unknown channel` for a channel it is configured for,
  // which is the failure this whole function exists to prevent. See
  // {@link ensurePlainObject}.
  const plugins = ensurePlainObject(asBag(config), "plugins");
  const entries = ensurePlainObject(plugins, "entries");
  const existing = entries[channelId];
  entries[channelId] = { ...(isPlainObject(existing) ? existing : {}), enabled: true };
}

export async function setDiscordToken(botToken: string): Promise<void> {
  const config = await readConfigForWrite();
  const channels = ensurePlainObject(asBag(config), "channels");
  const {
    dmPolicy: _dmPolicy,
    allowFrom: _allowFrom,
    botToken: _legacyLiteralToken,
    ...rest
  } = existingChannelBlock(channels, DISCORD_CHANNEL_ID);
  channels[DISCORD_CHANNEL_ID] = {
    ...rest,
    enabled: true,
    // envSecretRef also installs `secrets.providers.default`, without which
    // this reference is unresolvable at runtime — see its doc comment.
    token: envSecretRef(config, DISCORD_TOKEN_ENV_VAR),
  };
  // Same write, deliberately: an installed-but-untrusted plugin is a channel
  // the gateway refuses, and leaving the entry to survive on its own is what
  // let a later read-modify-write silently take Discord back down.
  trustChannelPlugin(config, DISCORD_CHANNEL_ID);
  await writeConfig(config);
  // Config first, secret second: a half-applied save that has the reference but
  // not the value is a bot that does not log in, which the status route reports
  // honestly. The reverse — a token on disk for a channel nothing reads — is
  // the failure mode that made the Hermes Telegram bug so hard to see.
  await writeDiscordGatewayEnv(botToken);
}

// === Telegram pairing (DM sender approval) ===
//
// OpenClaw's default `dmPolicy: "pairing"` makes an unknown Telegram sender's
// first message inert until the owner approves their 8-char code. OpenClaw 2
// persists approvals and pending codes in `~/.openclaw/state/openclaw.sqlite`
// (see openclaw-state-store.ts); OpenClaw 1 kept them in
// `~/.openclaw/credentials/telegram-<account>-allowFrom.json` (a string array
// of user ids) + `telegram-pairing.json`, which the readers below still serve
// on a box that has not migrated. Either way it is a *different* store from
// `openclaw.json`, so the boot-time `channels.telegram.allowFrom` strip in
// gateway-pre-start.sh never touches them. We only ever approve specific
// senders; we never widen dmPolicy.

const CREDENTIALS_DIR = path.join(OPENCLAW_HOME, "credentials");
export const PAIRING_CODE_RE = /^[A-Z0-9]{8}$/;

export interface TelegramPairingRequest {
  /** The 8-char pairing code. */
  code?: string;
  /** Sender id — the Telegram user id that lands in the allowlist on approval. */
  id?: string;
  /** Sender metadata OpenClaw attaches — `firstName`/`lastName` are the Telegram name. */
  meta?: { firstName?: string; lastName?: string; [key: string]: unknown };
  /** Display name, derived from `meta` once at the read boundary so callers (the
   *  popup, Settings list, and approve route) don't each re-derive it. */
  name?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** Build a display name from a pairing request's meta (Telegram first/last name). */
function deriveTelegramName(meta: TelegramPairingRequest["meta"]): string | undefined {
  const name = [meta?.firstName, meta?.lastName]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  return name || undefined;
}

/** Normalise a raw `requests` array, attaching a derived `name` to each entry. */
function withDerivedNames(requests: unknown): TelegramPairingRequest[] {
  if (!Array.isArray(requests)) return [];
  return (requests as TelegramPairingRequest[]).map((r) => ({
    ...r,
    name: r.name ?? deriveTelegramName(r.meta),
  }));
}

/** Pending Telegram DM pairing requests, via `openclaw pairing list telegram --json` (authoritative). */
export async function listTelegramPairingRequests(): Promise<TelegramPairingRequest[]> {
  const out = await spawnOpenclaw(["pairing", "list", "telegram", "--json"], { captureStdout: true });
  try {
    const parsed = JSON.parse(out) as { requests?: unknown };
    return withDerivedNames(parsed.requests);
  } catch {
    return [];
  }
}

/**
 * Pending Telegram DM pairing requests read straight from OpenClaw's pairing
 * store — a plain read with no CLI cold-start, so it's cheap enough to poll
 * for the desktop "new request" popup. OpenClaw 2 answers from the state
 * database; the legacy file path mirrors the allowFrom store, with the default
 * account unsuffixed (`telegram-pairing.json`).
 */
export async function readTelegramPairingRequests(account = "default"): Promise<TelegramPairingRequest[]> {
  const fromStore = readPairingRequests("telegram", account);
  if (fromStore) return withDerivedNames(fromStore);
  const file = path.join(
    CREDENTIALS_DIR,
    account === "default" ? "telegram-pairing.json" : `telegram-${account}-pairing.json`,
  );
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as { requests?: unknown };
    return withDerivedNames(parsed.requests);
  } catch {
    return [];
  }
}

/**
 * Approve a pending pairing code and notify the requester on Telegram
 * (`openclaw pairing approve telegram <CODE> --notify`). The `--notify` flag
 * makes OpenClaw send the "you're approved" confirmation to the user itself.
 * Throws on an invalid format or a non-zero CLI exit (e.g. expired/unknown code).
 */
export async function approveTelegramPairing(code: string): Promise<void> {
  const normalized = code.trim().toUpperCase();
  if (!PAIRING_CODE_RE.test(normalized)) {
    throw new Error("Invalid pairing code format");
  }
  await spawnOpenclaw(["pairing", "approve", "telegram", normalized, "--notify"]);
}

/**
 * Approved Telegram sender ids, read from the allowFrom store (empty on any
 * failure). `account` is OpenClaw's channel account id; ClawBox is single-account
 * so it defaults to "default". The v2 state database wins whenever it exists:
 * it is what the gateway enforces, and a migrated box's leftover JSON is a
 * stale copy that must not shadow it. Without one, the legacy file
 * (`telegram-default-allowFrom.json`) is the store.
 */
export async function readTelegramAllowFrom(account = "default"): Promise<string[]> {
  const fromStore = readPairingAllowEntries("telegram", account);
  if (fromStore) return fromStore;
  const file = path.join(CREDENTIALS_DIR, `telegram-${account}-allowFrom.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as { allowFrom?: unknown };
    if (!Array.isArray(parsed.allowFrom)) return [];
    return parsed.allowFrom.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/**
 * Wipe the per-account Telegram allowlist + pending stores. Used when the bot
 * token changes: previously-approved senders belong to the old bot, so a new
 * bot should start with a fresh allowlist. Clears the v2 state database rows
 * when the store exists, then the legacy files, so no copy survives for a
 * later migration to carry back in. A missing store or file is fine. A store
 * that exists but could not be cleared is not: its approvals are still what
 * the gateway enforces, so this throws — before the legacy files are touched,
 * leaving the state exactly as it was — and the caller must not report a
 * reset that did not happen.
 */
export async function clearTelegramPairingState(account = "default"): Promise<void> {
  if (!clearPairingState("telegram", account)) {
    throw new Error(
      "Could not clear the previous Telegram approvals from OpenClaw's state store; they are still in force",
    );
  }
  const files = [
    path.join(CREDENTIALS_DIR, `telegram-${account}-allowFrom.json`),
    path.join(CREDENTIALS_DIR, account === "default" ? "telegram-pairing.json" : `telegram-${account}-pairing.json`),
  ];
  await Promise.all(files.map((f) => fs.rm(f, { force: true }).catch(() => {})));
}

// === The anthropic plugin, around the primary write =========================
//
// `plugins.entries.anthropic.enabled` is on whenever the box could use it: the
// primary is anthropic, or an Anthropic credential exists that the owner has
// not switched off. It used to follow the active provider alone — every
// enabled plugin loads its tool schemas synchronously on the gateway's main
// loop during agent prep (5-8 s for anthropic on a Jetson, an old measurement
// TASK-654 re-takes on 2026.8.1), so the plugin was switched off whenever the
// owner was not on Claude. On OpenClaw 2 that starves the catalog: measured on
// a 2026.8.1 box, `openclaw models list --provider anthropic --all --json` with
// the plugin disabled answers ONE row (the configured primary) against eleven
// with it enabled, and that one row is the three-model picker owners saw. A
// credentialed provider's plugin therefore stays on; the prep-latency saving
// only applies where nothing could use the plugin anyway. Other plugins
// (openai) are shared across providers and stay enabled.
//
// The toggle is two halves around the `agents.defaults.model.primary` write:
//
//   enableProviderPluginOps(refs)   IN the same batch as the write, before it
//                                   (src/lib/provider-plugin-ops.ts)
//   setProviderPlugins(provider)    AFTER it
//
// OpenClaw 2 validates a model reference on `config set` against the captured
// catalogs of the ENABLED plugins only. With the plugin off, every
// `anthropic/*` reference is refused: "Unknown model: anthropic/claude-sonnet-5.
// Run openclaw models list to list available models." Both callers used to
// write first and toggle after, and on a 2026.8.1 core the chat popup showed
// the owner exactly that line on every switch back to Claude (2026.7.x
// answered from the bundled catalog whatever the plugin state, which is why
// the order never mattered before). The OFF half stays AFTER the write on
// purpose: a plugin whose model is the CURRENT primary is never switched off
// underneath it. It is idempotent and non-fatal, and a plugin enabled by the
// batch loads on the next gateway start ("Restart the gateway to apply"), so
// the caller's restart has to follow.

/**
 * Does this box hold an Anthropic credential the owner has not switched off —
 * an auth profile or the inline override key, and `anthropic` not in the
 * owner's disabled-providers set (the switch takes the provider out of every
 * place the box picks a model, so a credential behind it is one nothing can
 * route to).
 *
 * Read off openclaw.json's `auth.profiles` METADATA, not the agent's SQLite
 * credential store the core resolves a usable profile from. Unverified on a
 * box (no device in this run): whether `openclaw models auth logout` also
 * drops the metadata entry. If it does not, a logged-out box keeps the plugin
 * on until the owner switches the provider off — the cost is prep latency,
 * never a broken box.
 */
function hasUsableAnthropicCredential(config: OpenClawConfig, disabledProviders: ReadonlySet<string>): boolean {
  if (disabledProviders.has("anthropic")) return false;
  const profiles = Object.entries(config.auth?.profiles ?? {});
  if (profiles.some(([key, entry]) => {
    const provider = typeof entry?.provider === "string" && entry.provider.trim()
      ? entry.provider
      : key.split(":")[0];
    return provider.trim().toLowerCase() === "anthropic";
  })) return true;
  const override = config.models?.providers?.anthropic as { apiKey?: unknown } | undefined;
  return typeof override?.apiKey === "string" && override.apiKey.trim().length > 0;
}

/**
 * Does the config still POINT at an Anthropic model — the default primary or
 * any of its fallbacks? A configured reference outranks every other signal,
 * the owner's provider switch included: the gateway will try to route there,
 * and the plugin is what resolves it. The core does not protect this by
 * itself — a batch whose only operation is the plugin flag touches no model
 * ref, so `collectTouchedTextModelRefs` validates nothing and the disable
 * lands (read on 2026.8.1); the fallback then fails when it is next selected.
 *
 * Prefix match on the provider segment, the shape ClawBox writes everywhere.
 * A model ALIAS that resolves to anthropic is not seen here — resolving one
 * needs the core's own resolver, and nothing in ClawBox writes aliases.
 */
function configReferencesAnthropic(config: OpenClawConfig): boolean {
  const modelDefaults = config.agents?.defaults?.model;
  return [
    modelDefaults?.primary,
    ...(Array.isArray(modelDefaults?.fallbacks) ? modelDefaults.fallbacks : []),
  ].some((ref) => typeof ref === "string" && ref.trim().toLowerCase().startsWith("anthropic/"));
}

/**
 * AFTER the primary write: keep the anthropic plugin on while the config still
 * names an Anthropic model (primary or fallback) or a usable Anthropic
 * credential exists; off only when nothing on the box could use it. Pass the
 * provider segment of `agents.defaults.model.primary`. Idempotent and
 * non-fatal.
 */
export async function setProviderPlugins(activeProvider: string): Promise<string | null> {
  // Strict, because the decision below is about ABSENCE: `readConfig` answers
  // `{}` to an unreadable file, and that would read as "no Anthropic
  // credential" and switch the plugin off on a box that has one — the very
  // starvation this gate exists to avoid. An unreadable config leaves the
  // plugin where it is; the next switch or save re-applies the gate.
  let config: OpenClawConfig;
  try {
    config = await readConfigStrict();
  } catch (err) {
    console.warn(
      "[openclaw-config] Leaving the anthropic plugin as it is — could not read the config:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const disabled = parseDisabledProviders(await getConfigStoreValue(DISABLED_PROVIDERS_KEY).catch(() => undefined));
  const wanted = activeProvider === "anthropic"
    || configReferencesAnthropic(config)
    || hasUsableAnthropicCredential(config, disabled);
  // An absent flag IS enabled: the plugin declares `enabledByDefault: true`,
  // so a fresh box needs no write to be on.
  const current = (config.plugins as { entries?: Record<string, { enabled?: boolean }> } | undefined)
    ?.entries?.anthropic?.enabled ?? true;
  if (current === wanted) return null;
  try {
    await runOpenclawConfigSet([ANTHROPIC_PLUGIN_ENABLED_KEY, wanted ? "true" : "false", "--json"]);
    // WHICH provider's catalogue just changed, for the caller to pass on. This
    // gate governs exactly one plugin, and switching it off is what empties
    // `openclaw models list --provider anthropic`; returning the id keeps that
    // fact here rather than hand-copied into every call site, and returning
    // `null` on the no-op paths means a caller cannot announce a change that
    // did not happen.
    return "anthropic";
  } catch (err) {
    // Non-fatal: a gate left wrong costs prep seconds or one catalog refresh,
    // never correctness, and the next switch or save re-applies it.
    console.warn(
      "[openclaw-config] Failed to toggle anthropic plugin:",
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

/**
 * True when this device has no OpenClaw gateway to restart.
 *
 * The Hermes edition removes it: `clawbox-gateway.service` is MASKED and port
 * 18789 is closed. Hermes has no equivalent daemon — the CLI is invoked per
 * request and reads its config each time — so there is nothing to bounce after
 * a model change, and treating that as a failure is what produced "AI model
 * configured but gateway failed to restart. Try rebooting the device." on a
 * device where the configuration had in fact been written correctly.
 */
export function gatewayIsAbsent(): boolean {
  return readEdition() === "hermes";
}

/**
 * OpenClaw 2 keeps auth profiles in `state/openclaw.sqlite` and refuses to
 * hydrate plaintext credentials found in openclaw.json — the gateway exits
 * with AuthProfileMigrationRequiredError until `doctor --fix` migrates them.
 * Every `config set auth.profiles.*` recreates that condition, so the
 * configure route runs this right before its gateway restart, mirroring
 * install.sh: gateway stopped first (doctor migrates the store the gateway
 * holds open), safe migrations only, and the caller's restart starts it
 * again. On OpenClaw 1 there is nothing to migrate and doctor answers fast.
 */
export async function runOpenclawDoctorFix(): Promise<void> {
  if (gatewayIsAbsent()) return;
  try {
    await exec("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "stop", "clawbox-gateway.service"], {
      timeout: 30000,
    });
  } catch {
    /* older sudoers or already stopped — doctor itself reports real trouble */
  }
  await spawnOpenclaw(["doctor", "--fix", "--non-interactive"], { timeoutMs: 180_000 });
}

/**
 * Thrown when the gateway was restarted but never started listening again.
 *
 * A distinct type because it is not a failed restart: the config write landed,
 * `systemctl restart` succeeded, and the box may still recover on its own. What
 * it is NOT is a finished save — callers answer 502 rather than `{success:true}`.
 */
export class GatewayNotReadyError extends Error {
  constructor(message = "gateway did not come back") {
    super(message);
    this.name = "GatewayNotReadyError";
  }
}

/**
 * How long a restarted gateway has to bind its port before the restart is
 * called a failure.
 *
 * 30 s is the repo's own normal-path figure: `GATEWAY_HEALTH_WAIT_MS` in
 * updater.ts waits exactly that for a gateway to come up, install.sh's
 * post-restart recovery check settles for `sleep 8`, and the updater keeps its
 * longer 45 s (`GATEWAY_RECOVERY_WAIT_MS`) for the harder case of a restart
 * that follows a repair. It is also triple what OpenClaw itself allows a
 * respawned gateway (`UPDATE_RESPAWN_HEALTH_TIMEOUT_MS`, 10 s) — deliberately,
 * because that budget is written for a desktop and this one for a cold Jetson.
 * Erring long is the point: a slow but healthy restart reported as a failure
 * would be the exact inverse of the bug this wait exists to fix.
 *
 * The wait begins AFTER `systemctl restart` returns, so it covers only the new
 * process's startup — not the drain (`TimeoutStopSec=30`) and not the pre-start
 * (`TimeoutStartSec=600`, already bounded by this call's own 60 s exec budget).
 *
 * Read per call rather than frozen at import, so a box that needs longer can be
 * given it without a rebuild. Nothing in the repo sets `GATEWAY_READY_WAIT_MS`
 * today; it is an operator escape hatch, not a test seam (the tests mock the
 * wait itself).
 */
export function gatewayReadyWaitMs(): number {
  // Guarded exactly as respawnWaitMs() guards its Hermes twin: a typo in the
  // escape hatch above must not become a budget. `waitForPortOpen` reads a
  // non-finite budget as a single probe, so an unguarded NaN would turn a 30 s
  // wait into one connect attempt — and the diagnostic would say "nothing is
  // listening after NaNms", which names neither the cause nor the typo.
  const override = Number(process.env.GATEWAY_READY_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? override : 30000;
}

// Validated: this is the port awaitGatewayReady hands to waitForPortOpen, and
// `net.Socket.connect` throws ERR_SOCKET_BAD_PORT synchronously on a malformed
// or out-of-range one — which would surface as "the gateway failed to restart"
// over a restart that worked.
export const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);

export interface RestartGatewayOptions {
  /**
   * Wait for the gateway to listen again before resolving. Default true.
   *
   * Only a caller that runs its own readiness wait afterwards may turn this
   * off, and the updater is the one that does: it waits 45 s itself and reads
   * the unit's journal when that fails, so a throw from here would skip the
   * legacy-state recovery it exists to perform.
   */
  awaitReady?: boolean;
}

/**
 * Block until the gateway is listening again, or say it never came back.
 *
 * One TCP connect to :18789, polled — which is OpenClaw's OWN answer to this
 * question, not a ClawBox invention: upstream's `waitForHealthyGatewayChild`
 * polls `waitForGatewayPortReady`, a bare `net.createConnection` to the gateway
 * port, to decide whether a respawned gateway is serving. It is also already
 * this repo's answer, in `updater.ts` `waitForGateway` and
 * `/setup-api/gateway/health`, which is why this reuses their loop rather than
 * writing a second one.
 *
 * The CLI verbs that answer the same question — `openclaw gateway status
 * --require-rpc`, `openclaw gateway probe`, `openclaw health` — are not usable
 * as a poll: each is a full CLI cold start (10-12 s on a Jetson, measured; see
 * runOpenclawConfigSet) plus a WebSocket handshake, so one poll would outlast
 * the whole wait and would inherit the gateway's own event-loop stalls. The
 * kernel completes a TCP handshake without the target process's event loop,
 * which is the reason /setup-api/gateway/health probes the port too.
 *
 * Nothing is remembered between calls: a readiness answer describes one moment
 * of one process, and a cached one is how the next probe-once bug starts.
 */
async function awaitGatewayReady(options: RestartGatewayOptions): Promise<void> {
  if (options.awaitReady === false) return;
  const budgetMs = gatewayReadyWaitMs();
  // 250 ms, not the updater's 1 500 ms: a person is waiting on this one, and
  // OpenClaw polls the same port at 200 ms for the same question. A loopback
  // connect that is refused costs nothing.
  if (await waitForPortOpen(GATEWAY_PORT, "127.0.0.1", { timeoutMs: budgetMs, intervalMs: 250 })) return;
  console.error(
    `[openclaw-config] Gateway restarted but nothing is listening on ${GATEWAY_PORT} after ${budgetMs}ms`,
  );
  throw new GatewayNotReadyError();
}

export async function restartGateway(options: RestartGatewayOptions = {}): Promise<void> {
  if (gatewayIsAbsent()) return;
  // Best effort, before the restart: a unit that crash-looped through its
  // StartLimitBurst (20/hour — one bad config during an update is enough)
  // refuses every restart for the rest of the window with "Start request
  // repeated too quickly", and nothing else running as the clawbox user can
  // clear that state. Ignored wherever sudoers has not learned the verb yet.
  try {
    await exec("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "reset-failed", "clawbox-gateway.service"], {
      timeout: 15000,
    });
  } catch {
    /* older sudoers, or nothing to reset — the restart below tells the truth */
  }
  try {
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"], {
      timeout: 60000,
    });
    await awaitGatewayReady(options);
    return;
  } catch (err) {
    if (err instanceof GatewayNotReadyError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // Fall back only when this installation genuinely has no ClawBox system
    // unit. A runtime mask is an update/factory-reset lock: starting the legacy
    // user unit through it would defeat the lock and recreate concurrent
    // gateway/SQLite writers.
    const systemGatewayMasked = /clawbox-gateway\.service[^\n]*\bmasked\b/i.test(message);
    const systemGatewayMissing =
      /clawbox-gateway\.service[^\n]*(?:not found|could not be found)/i.test(message);
    if (!systemGatewayMasked && systemGatewayMissing) {
      try {
        await exec("systemctl", ["--user", "restart", "openclaw-gateway.service"], {
          timeout: 60000,
          env: {
            ...process.env,
            HOME: process.env.HOME || "/home/clawbox",
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
          },
        });
        // The legacy user unit serves the same port, so it owes the same proof.
        await awaitGatewayReady(options);
        return;
      } catch (fallbackErr) {
        // A gateway that was restarted but never came back must not be reported
        // as the missing-unit error that sent us down this branch.
        if (fallbackErr instanceof GatewayNotReadyError) throw fallbackErr;
        console.error(
          "[openclaw-config] Failed to restart fallback OpenClaw user gateway:",
          fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
        );
      }
    }
    console.error(
      "[openclaw-config] Failed to restart gateway:",
      message
    );
    throw err;
  }
}

/*
 * There is deliberately no reloadGateway() here.
 *
 * Installing a skill needs no gateway bounce at all. OpenClaw watches its skill
 * roots itself — `skills.load.watch` defaults to true, and `<workspace>/skills`
 * (where `openclaw skills install` writes, and where getSkillsDir() points) is
 * one of the roots it watches. A write there bumps the skills snapshot version,
 * and the next agent turn rebuilds the snapshot from disk. The gateway's own
 * `skills.status` handler re-reads the workspace on every call, so the App Store
 * and the CLI see a new skill immediately without any signal being sent.
 *
 * The previous implementation sent SIGUSR1 to the gateway's MainPID. To OpenClaw
 * that signal does not mean "reload" — it means "restart", and under a detected
 * supervisor (systemd sets INVOCATION_ID/JOURNAL_STREAM, so always here) OpenClaw
 * services it by exiting 0 and handing off to the supervisor. Every skill install
 * therefore stopped the gateway and left it to systemd to bring back.
 */
/** Find the openclaw binary — checks common locations including nvm, caches result. */
let _openclawBinCache: string | null = null;
export function findOpenclawBin(): string {
  if (_openclawBinCache) return _openclawBinCache;
  const nodeDir = path.dirname(process.execPath);
  const home = process.env.HOME || "/home/clawbox";
  const candidates = [
    path.join(nodeDir, "openclaw"),
    path.join(home, ".npm-global", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  const nvmDir = path.join(home, ".nvm", "versions", "node");
  try {
    const versions = fsSync.readdirSync(nvmDir) as string[];
    for (const v of versions.sort().reverse()) {
      candidates.push(path.join(nvmDir, v, "bin", "openclaw"));
    }
  } catch {}
  for (const p of candidates) {
    if (fsSync.existsSync(p)) {
      _openclawBinCache = p;
      return p;
    }
  }
  return "openclaw";
}

/**
 * The OpenClaw skills root — `<workspace>/skills`, the directory a store app's
 * skill lives in and the one OpenClaw watches.
 *
 * THREE answers, deliberately distinct, because two of them used to be one
 * `null` and every caller read it as the harmless one:
 *
 *   - a PATH — this device has OpenClaw, and this is where its skills are;
 *   - `null` — the `hermes` SKU: there is no OpenClaw here to have a skills
 *     root, so there is nothing to remove and nothing has gone wrong;
 *   - a thrown {@link OpenclawConfigUnreadableError} — openclaw.json EXISTS and
 *     could not be read or parsed, so WHERE the skills are is unknown right
 *     now. That is not "there is no OpenClaw here", and a caller told the two
 *     apart by one `null` acts on the wrong one: `apps/uninstall` dropped the
 *     desktop entry, the preferences and the KV, left the skill on disk and
 *     still loaded, and answered `{ok:true}` (TASK-551).
 *
 * The unreadable case is real and transient: `openclaw config set` rewrites the
 * file in place, so a half-written read is the documented race (see
 * {@link readConfigForWrite}), and an EACCES reads the same way. `getSkillsDir()`
 * below swallows it and falls through to a well-known path — a good enough
 * guess for the `stat` its own caller makes, and never a delete target, because
 * on a box whose workspace is not the well-known one it redirects the delete.
 *
 * Keyed on the EDITION rather than the active harness, deliberately. On `dual`
 * the OpenClaw workspace exists and its skills are real whichever harness is
 * running, so an app installed there stays removable; only the `hermes` SKU
 * genuinely has no OpenClaw.
 */
export function openclawSkillRoot(): string | null {
  if (openclawIsAbsent()) return null;
  // ONE read answers both "can the config be read at all" and "what does it
  // say": a probe followed by getSkillsDir()'s own read reopened the in-place
  // rewrite race in the gap between them.
  return path.resolve(readConfiguredWorkspace() ?? wellKnownWorkspace(), "skills");
}

/**
 * `agents.defaults.workspace`, or `undefined` when no config names one.
 *
 * Throws {@link OpenclawConfigUnreadableError} when openclaw.json exists and
 * cannot be read or parsed — the discipline {@link readConfigStrict} states at
 * length, for the same reason: a caller about to act on "there is nothing here"
 * must not be told that by a file it could not read. ENOENT is not a failure —
 * there is no config, and the well-known paths are the answer.
 */
function readConfiguredWorkspace(): string | undefined {
  let raw: string;
  try {
    raw = fsSync.readFileSync(path.join(openclawHome(), "openclaw.json"), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new OpenclawConfigUnreadableError(err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OpenclawConfigUnreadableError(err);
  }
  const workspace = (parsed as { agents?: { defaults?: { workspace?: unknown } } } | null)
    ?.agents?.defaults?.workspace;
  return typeof workspace === "string" && workspace ? workspace : undefined;
}

/** The workspace when the config names none: the current path, else the legacy one. */
function wellKnownWorkspace(): string {
  // Under OpenClaw's home, the same one the config was read from — not a
  // second `$HOME/.openclaw` spelling. install.sh sets `HOME` and
  // `CLAWBOX_OPENCLAW_HOME` side by side, so the two agree on a shipped box by
  // convention only; keyed on `$HOME` this line would resolve a DELETE target
  // from a directory the box's own config does not live in.
  const openclawWorkspace = path.join(openclawHome(), "workspace");
  if (fsSync.existsSync(openclawWorkspace)) return openclawWorkspace;
  // The legacy workspace is a HOME-relative path in its own right, never a
  // child of OpenClaw's home.
  return path.join(process.env.HOME || "/home/clawbox", "clawd");
}

/**
 * Resolve the OpenClaw workspace/skills directory from config or well-known
 * paths. Lenient on purpose — an unreadable config falls through to the
 * well-known paths — because its caller only `stat`s the answer, where a miss
 * costs a cache rescan and nothing else. Anything that DELETES under the root
 * goes through {@link openclawSkillRoot}, which refuses to guess.
 */
export function getSkillsDir(): string {
  try {
    const configured = readConfiguredWorkspace();
    if (configured) return configured;
  } catch {
    // See above: a stat under the wrong root is a miss, not damage.
  }
  return wellKnownWorkspace();
}
