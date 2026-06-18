import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";

const exec = promisify(execFile);

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
  const {
    timeoutMs = 30_000,
    maxAttempts = 4,
    baseBackoffMs = 100,
  } = options;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await spawnOpenclawConfigSet(args, { ...options, timeoutMs });
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
  throw lastError ?? new Error("runOpenclawConfigSet exhausted retries");
}

interface SpawnOpenclawOptions {
  /** Per-call timeout in ms. Default 30_000 (Jetson CLI cold-start is ~10-12s). */
  timeoutMs?: number;
  /** Capture and resolve stdout (needed to read `--json` output). Default false. */
  captureStdout?: boolean;
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
  const bin = findOpenclawBin();
  const { uid, gid, captureStdout = false } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cwd = options.cwd ?? process.env.HOME ?? "/home/clawbox";
  const env = { HOME: "/home/clawbox", ...process.env, ...(options.env ?? {}) };
  const label = `${bin} ${args.join(" ")}`;

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

function spawnOpenclawConfigSet(
  args: string[],
  options: OpenclawConfigSetOptions & { timeoutMs: number },
): Promise<void> {
  return spawnOpenclaw(["config", "set", ...args], {
    timeoutMs: options.timeoutMs,
    uid: options.uid,
    gid: options.gid,
    cwd: options.cwd,
    env: options.env,
  }).then(() => undefined);
}
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
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
      dmPolicy?: string;
      allowFrom?: string[];
      streaming?: { mode?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
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
      models?: Array<{ id?: string; name?: string }>;
      [key: string]: unknown;
    }>;
  };
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
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

export async function restartGateway(): Promise<void> {
  try {
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"], {
      timeout: 60000,
    });
  } catch (err) {
    console.error(
      "[openclaw-config] Failed to restart gateway:",
      err instanceof Error ? err.message : err
    );
    throw err;
  }
}

/** Send SIGUSR1 to the gateway so it restarts and picks up newly-installed skills. */
export async function reloadGateway(): Promise<void> {
  try {
    // The gateway process renames its argv to just "openclaw", so the old
    // `pgrep -f "openclaw-gateway"` matched nothing and SIGUSR1 was never sent —
    // installing a skill left the gateway untouched and the chat's reload
    // overlay hung forever. Resolve the PID deterministically from systemd,
    // falling back to an exact process-name match for dev / non-systemd runs.
    let pid = 0;
    try {
      const { stdout } = await exec("systemctl", ["show", "clawbox-gateway.service", "-p", "MainPID", "--value"], { timeout: 5_000 });
      pid = parseInt(stdout.trim(), 10);
    } catch { /* not under systemd — fall through to pgrep */ }
    if (!Number.isFinite(pid) || pid <= 0) {
      const { stdout } = await exec("pgrep", ["-x", "openclaw"], { timeout: 5_000 });
      pid = parseInt(stdout.trim().split("\n")[0], 10);
    }
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, "SIGUSR1");
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.warn("[openclaw-config] reloadGateway failed:", err instanceof Error ? err.message : err);
    }
  }
}

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
