import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import { readEdition } from "@/lib/edition-source";
import { getProviderReasoningConfig, isThinkingLevel } from "@/lib/chat-reasoning";
import { isSafeDiscordToken } from "@/lib/discord-api";

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
 */
export async function runOpenclawConfigSet(
  args: string[],
  options: OpenclawConfigSetOptions = {},
): Promise<void> {
  await withConfigMutationRetry(
    (timeoutMs) => spawnOpenclawConfigSet(args, { ...options, timeoutMs }),
    options,
    "runOpenclawConfigSet",
  );
}

/**
 * Retry `attempt` while it fails with `ConfigMutationConflictError`.
 *
 * Shared by {@link runOpenclawConfigSet} and {@link runOpenclawConfigSetBatch}
 * so both forms of the write survive the same race. Any other failure is
 * rethrown on the first try — a schema rejection does not become valid by
 * being repeated.
 */
async function withConfigMutationRetry(
  attemptFn: (timeoutMs: number) => Promise<void>,
  options: OpenclawConfigSetOptions,
  label: string,
): Promise<void> {
  const {
    timeoutMs = 30_000,
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
  /** Per-call timeout in ms. Default 30_000 (Jetson CLI cold-start is ~10-12s). */
  timeoutMs?: number;
  /** Capture and resolve stdout (needed to read `--json` output). Default false. */
  captureStdout?: boolean;
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
  const { uid, gid, captureStdout = false } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cwd = options.cwd ?? process.env.HOME ?? "/home/clawbox";
  const env = { HOME: "/home/clawbox", ...process.env, ...(options.env ?? {}) };
  const label = `${bin} ${(options.labelArgs ?? args).join(" ")}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
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

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }
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
    `[${batch.map((args) => `${args.filter((arg) => !arg.startsWith("--"))[0] ?? "<no path>"}=<redacted>`).join(",")}]`,
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
  await withConfigMutationRetry(
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
 */
export async function runOpenclawConfigUnset(
  configPath: string,
  options: OpenclawConfigSetOptions = {},
): Promise<void> {
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
}

export const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
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
   */
  skipUserTagged?: boolean;
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
 * Rewrite every session's per-session model/provider override across
 * every agent on disk to the given target, tagged with the given
 * source. Returns how many sessions were touched.
 *
 * Use `source: "user"` (also the default) when the caller is acting
 * on a direct user choice — chat-panel model dropdown, Local-only
 * toggle, etc. OpenClaw's per-turn model resolver explicitly returns
 * early for entries whose `modelOverrideSource === "user"`, which is
 * the only value that survives the auto-picker re-evaluating on
 * every message. `"manual"` looks reasonable but is not special-cased
 * anywhere in the OpenClaw dist and gets silently overwritten back
 * to `"auto"` on the next turn.
 *
 * Writes are atomic (temp + rename). If any individual sessions.json
 * fails to parse/write, the error is logged and the sweep continues —
 * one bad file should not block the rest.
 */
export async function applyModelOverrideToAllAgentSessions(
  update: SessionOverrideUpdate,
  opts: ApplyModelOverrideOpts = {},
): Promise<{ filesUpdated: number; sessionsUpdated: number }> {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const source = update.source ?? "user";
  const authProfile = update.authProfile ?? `${update.provider}:default`;
  const skipUserTagged = opts.skipUserTagged === true;

  let filesUpdated = 0;
  let sessionsUpdated = 0;

  const files = await listAgentSessionsFiles(agentsDir);
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
      // Preserve sticky per-session user choices when the caller asked
      // for a soft sweep. A session whose existing override matches
      // the new target is still touched so its source/authProfile
      // converge with the target — only diverging user picks stay put.
      if (skipUserTagged && session.modelOverrideSource === "user") {
        const sameProvider =
          session.providerOverride === update.provider ||
          session.modelProvider === update.provider;
        const sameModel =
          session.modelOverride === update.modelId ||
          session.model === update.modelId;
        if (!sameProvider || !sameModel) {
          continue;
        }
      }
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
        // Model-qualified: ClawBox AI's default depends on the tier the target
        // model belongs to, so a stale level folds to the RIGHT default.
        const reasoning = getProviderReasoningConfig(update.provider, `${update.provider}/${update.modelId}`);
        if (!reasoning.levels.includes(session.thinkingLevel)) {
          session.thinkingLevel = reasoning.default;
        }
      }
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

  return { filesUpdated, sessionsUpdated };
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

const DEFAULT_LOCAL_AI_PROXY_ROOT_URL = "http://127.0.0.1";

function getOllamaProxyBaseUrl(): string {
  const root = (process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL || DEFAULT_LOCAL_AI_PROXY_ROOT_URL).trim().replace(/\/+$/, "");
  return `${root}/setup-api/local-ai/ollama`;
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

export async function readConfig(): Promise<OpenClawConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
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
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw);
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmpPath, CONFIG_PATH);
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

export async function ensureCompactionReserveFloor(
  reserveTokensFloor = DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR
): Promise<void> {
  const config = await readConfig();
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.compaction ??= {};
  if (
    typeof config.agents.defaults.compaction.reserveTokensFloor !== "number" ||
    config.agents.defaults.compaction.reserveTokensFloor < reserveTokensFloor
  ) {
    config.agents.defaults.compaction.reserveTokensFloor = reserveTokensFloor;
    await writeConfig(config);
  }
}

/**
 * Set the OpenClaw gateway control-UI allowed origins to include the given
 * mDNS hostname. Always preserves the standard local origins so the device
 * remains reachable via IP and the AP captive portal even after a rename.
 */
export async function setControlUiAllowedOrigins(hostname: string): Promise<void> {
  const config = await readConfig();
  const gateway = (config.gateway ?? {}) as Record<string, unknown>;
  const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>;
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
  gateway.controlUi = controlUi;
  config.gateway = gateway;
  await writeConfig(config);
}

export async function setTelegramToken(botToken: string): Promise<void> {
  const config = await readConfig();
  if (!config.channels) {
    config.channels = {};
  }
  // Do NOT set `dmPolicy` or `allowFrom` here. OpenClaw's default
  // (`dmPolicy: "pairing"`) requires the owner to approve every new sender
  // via an in-Telegram pairing code before the agent responds. Writing
  // `dmPolicy: "open"` + `allowFrom: ["*"]` would open the bot — and with it
  // the agent's shell/file/system_power tools — to any Telegram user who
  // finds the handle. Reconfiguring a bot token on a device with those
  // values already stored should re-secure the channel, so strip them here
  // too rather than merging on top of the stale insecure config.
  const { dmPolicy: _dmPolicy, allowFrom: _allowFrom, ...rest } = config.channels.telegram ?? {};
  config.channels.telegram = {
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
  const config = await readConfig();
  if (!config.channels) {
    config.channels = {};
  }
  const existing = config.channels.telegram ?? {};
  if (enabled) {
    // Restore OpenClaw's default by dropping our override entirely.
    const { streaming: _streaming, ...rest } = existing;
    config.channels.telegram = { ...rest };
  } else {
    // Final-answer-only: suppress the progress/preview draft.
    config.channels.telegram = { ...existing, streaming: { mode: "off" } };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const plugins = (config.plugins ??= {});
  const entries = (plugins.entries ??= {});
  entries[channelId] = { ...entries[channelId], enabled: true };
}

export async function setDiscordToken(botToken: string): Promise<void> {
  const config = await readConfig();
  if (!config.channels) {
    config.channels = {};
  }
  const {
    dmPolicy: _dmPolicy,
    allowFrom: _allowFrom,
    botToken: _legacyLiteralToken,
    ...rest
  } = config.channels.discord ?? {};
  config.channels.discord = {
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
// first message inert until the owner approves their 8-char code. OpenClaw
// persists approvals in `~/.openclaw/credentials/telegram-<account>-allowFrom.json`
// (a string array of user ids) — a *different* file from `openclaw.json`, so the
// boot-time `channels.telegram.allowFrom` strip in gateway-pre-start.sh never
// touches them. We only ever approve specific senders; we never widen dmPolicy.

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
 * store file — a plain read with no CLI cold-start, so it's cheap enough to poll
 * for the desktop "new request" popup. The store path mirrors the allowFrom
 * store; the default account is unsuffixed (`telegram-pairing.json`).
 */
export async function readTelegramPairingRequests(account = "default"): Promise<TelegramPairingRequest[]> {
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
 * so it defaults to "default" (file `telegram-default-allowFrom.json`).
 */
export async function readTelegramAllowFrom(account = "default"): Promise<string[]> {
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
 * bot should start with a fresh allowlist. Best-effort — missing files are fine.
 */
export async function clearTelegramPairingState(account = "default"): Promise<void> {
  const files = [
    path.join(CREDENTIALS_DIR, `telegram-${account}-allowFrom.json`),
    path.join(CREDENTIALS_DIR, account === "default" ? "telegram-pairing.json" : `telegram-${account}-pairing.json`),
  ];
  await Promise.all(files.map((f) => fs.rm(f, { force: true }).catch(() => {})));
}

// Toggles `plugins.entries.anthropic.enabled` in lock-step with the active
// provider. Every enabled plugin loads its tool schemas synchronously on
// the gateway's main loop during agent prep (~5-8s for anthropic on Jetson),
// so leaving it on while the user is not using Claude is pure waste. Other
// plugins (openai) are shared across providers and stay enabled. Pass the
// provider segment of `agents.defaults.model.primary`.
export async function setProviderPlugins(activeProvider: string): Promise<void> {
  const wantAnthropic = activeProvider === "anthropic";
  try {
    const config = await readConfig();
    const current = (config.plugins as { entries?: Record<string, { enabled?: boolean }> } | undefined)
      ?.entries?.anthropic?.enabled;
    if (current === wantAnthropic) return;
  } catch {
    // Fall through and write — readConfig already swallows errors.
  }
  try {
    await runOpenclawConfigSet(
      ["plugins.entries.anthropic.enabled", wantAnthropic ? "true" : "false", "--json"],
    );
  } catch (err) {
    // Non-fatal: the gateway will still work, just with the heavier prep cost.
    console.warn(
      "[openclaw-config] Failed to toggle anthropic plugin:",
      err instanceof Error ? err.message : err,
    );
  }
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

export async function restartGateway(): Promise<void> {
  if (gatewayIsAbsent()) return;
  try {
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"], {
      timeout: 60000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "is masked" is the other way this unit says "I am not running here" — a
    // masked unit is a deliberate removal, not an error to surface. Without it
    // the message fell past this branch to the throw below.
    if (/clawbox-gateway\.service.*(?:not found|is masked)|Unit clawbox-gateway\.service not found|could not be found/i.test(message)) {
      try {
        await exec("systemctl", ["--user", "restart", "openclaw-gateway.service"], {
          timeout: 60000,
          env: {
            ...process.env,
            HOME: process.env.HOME || "/home/clawbox",
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
          },
        });
        return;
      } catch (fallbackErr) {
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

/** Resolve the OpenClaw workspace/skills directory from config or well-known paths. */
export function getSkillsDir(): string {
  const home = process.env.HOME || "/home/clawbox";
  const openclawConfig = path.join(home, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fsSync.readFileSync(openclawConfig, "utf-8"));
    const workspace = config?.agents?.defaults?.workspace;
    if (typeof workspace === "string" && workspace) return workspace;
  } catch {}
  const openclawWorkspace = path.join(home, ".openclaw", "workspace");
  if (fsSync.existsSync(openclawWorkspace)) return openclawWorkspace;
  return path.join(home, "clawd");
}
