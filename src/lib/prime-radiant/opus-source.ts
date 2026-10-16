/**
 * Who answers the Opus tier, and the client for the owner's Claude
 * SUBSCRIPTION.
 *
 * ORDER. An Anthropic API key from the box's account pool first (opus.ts, the
 * Messages API, priced and held to the dollar cap); otherwise the `claude`
 * sign-in the owner made on this box — the pool's `login` account, usable
 * (not limited, not refused) and still signed in — through the `claude` CLI
 * run headless, exactly as the coding agent runs it; neither → a client whose
 * every call is unavailable, so the tier leaves its pages `opus_pending`.
 *
 * THE SUBSCRIPTION IS USED THE WAY CLAUDE CODE USES IT. The CLI reads its own
 * credential under `~/.claude`; this module never reads, copies or forwards
 * that credential, and never calls the Messages API with it.
 *
 * THE OWNER'S PLAN COMES FIRST. A call:
 *  - is a pure text completion: no tools (`--tools ""`), no MCP servers (an
 *    empty strict config), no settings, hooks or CLAUDE.md (`--setting-sources
 *    ""`, an empty temporary working folder), one turn, no saved session;
 *  - runs one at a time (the tier is sequential) under a bounded timeout, and
 *    its whole process group is ended when that runs out;
 *  - YIELDS ({@link OpusYieldError}) when a coding-agent run is working — the
 *    two share the same plan and the run is the owner's — or the box is short
 *    of memory for a second Claude Code process;
 *  - STOPS the night ({@link OpusLimitError}) on the CLI's usage-limit or
 *    rate-limit answer, read with the coding agent's own detector
 *    (anthropic-limit.ts).
 * The nightly page cap (settings `opus.maxPages`) bounds how much one night
 * can spend of the plan.
 *
 * SERVER ONLY.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "@/lib/runtime-path";
import { classifyAnthropicFailure } from "@/lib/anthropic-limit";
import {
  createAnthropicOpusClient,
  opusClientOverride,
  OpusLimitError,
  OpusUnavailableError,
  OpusYieldError,
  type OpusClient,
  type OpusKeyReader,
  type OpusSource,
} from "./opus";
import { DEFAULT_OPUS_MODEL } from "./settings";

/** One subscription call may take this long before its process group is ended. */
export const OPUS_CLI_TIMEOUT_MS = 6 * 60_000;
/** Below this much available memory a second Claude Code process is not started. */
export const OPUS_CLI_MIN_AVAILABLE_MB = 1_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs the CLI once: argv, stdin, a working folder, an environment, a deadline. */
export type CliRunner = (
  bin: string,
  args: readonly string[],
  input: string,
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<CliRun>;

export interface SubscriptionClientDeps {
  /** The absolute path of `claude`. */
  claudePath: string;
  runner?: CliRunner;
  /** Why the tier must step aside right now, or null. */
  yieldReason?: () => Promise<string | null>;
  /** The PATH the CLI runs with. */
  pathValue?: string;
  now?: () => number;
  timeoutMs?: number;
}

/** The CLI's argv for one completion. The tool flag is variadic, so it comes last. */
export function subscriptionArgs(model: string, system: string): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--max-turns", "1",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--system-prompt", system,
    "--tools", "",
  ];
}

/**
 * The environment the CLI runs with, built from nothing: a home (where its own
 * sign-in lives), a PATH, a locale. No API key, so the subscription answers;
 * no `CLAUDE_CONFIG_DIR`, so it is the owner's own `~/.claude`.
 */
export function subscriptionEnv(home: string, pathValue: string, maxTokens: number): Record<string, string> {
  return {
    HOME: home,
    PATH: pathValue,
    LANG: process.env.LANG || "C.UTF-8",
    USER: process.env.USER || os.userInfo().username,
    TMPDIR: os.tmpdir(),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
    CLAUDE_CODE_EFFORT_LEVEL: "medium",
  };
}

const defaultRunner: CliRunner = (bin, args, input, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, [...args], { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    // The tail, not the head: the JSON result line comes last.
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
      if (stdout.length > MAX_STDOUT_BYTES) stdout = stdout.slice(stdout.length - MAX_STDOUT_BYTES);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      done(null);
    });
    child.on("close", (code) => done(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

interface CliResult {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  api_error_status?: unknown;
  usage?: Record<string, unknown>;
}

/** The `--output-format json` object, or null when stdout carries none. */
export function parseCliResult(stdout: string): CliResult | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as CliResult).type === "result") return parsed as CliResult;
    } catch {
      /* not this line */
    }
  }
  return null;
}

/** Turn a failed call into the error the tier acts on. */
function failureOf(text: string, apiStatus: unknown, now: number): OpusUnavailableError {
  const head = text.replace(/\s+/g, " ").trim().slice(0, 400);
  const failure = classifyAnthropicFailure(head, now);
  if (failure?.type === "limit") return new OpusLimitError(`${failure.limit.kind} limit`, failure.limit.resetsAt);
  if (apiStatus === 429) return new OpusLimitError("rate limit");
  if (failure?.type === "auth") return new OpusUnavailableError("the Claude sign-in was refused");
  return new OpusUnavailableError(head ? `the claude CLI failed: ${head.slice(0, 100)}` : "the claude CLI failed");
}

/** Opus on the owner's Claude subscription, through the `claude` CLI. */
export function createSubscriptionOpusClient(model: string, deps: SubscriptionClientDeps): OpusClient {
  const runner = deps.runner ?? defaultRunner;
  const clock = deps.now ?? Date.now;
  return {
    model,
    source: "subscription",
    async complete(request) {
      const busy = await (deps.yieldReason ?? defaultYieldReason)().catch(() => null);
      if (busy) throw new OpusYieldError(busy);
      if (request.signal?.aborted) throw new OpusUnavailableError("the night was stopped");
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-opus-"));
      let run: CliRun;
      try {
        run = await runner(deps.claudePath, subscriptionArgs(model, request.system), request.user, {
          cwd,
          env: subscriptionEnv(os.homedir(), deps.pathValue ?? process.env.PATH ?? "/usr/bin:/bin", request.maxTokens),
          timeoutMs: deps.timeoutMs ?? OPUS_CLI_TIMEOUT_MS,
          signal: request.signal,
        });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
      if (run.timedOut) throw new OpusUnavailableError("the claude CLI did not answer in time");
      const parsed = parseCliResult(run.stdout);
      if (!parsed) throw failureOf(`${run.stdout}\n${run.stderr}`, null, clock());
      const text = typeof parsed.result === "string" ? parsed.result : "";
      if (parsed.is_error === true || parsed.subtype !== "success" || run.code !== 0) {
        throw failureOf(text || run.stderr, parsed.api_error_status, clock());
      }
      if (text.trim() === "") throw new OpusUnavailableError("Opus answered with no text");
      const u = parsed.usage ?? {};
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      const cacheRead = num(u.cache_read_input_tokens);
      return {
        text,
        model,
        usage: {
          promptTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + cacheRead,
          completionTokens: num(u.output_tokens),
          cacheHitTokens: cacheRead,
        },
      };
    },
  };
}

/** A client with no account behind it: every call is unavailable, so pages wait. */
export function unavailableOpusClient(model: string, reason: string): OpusClient {
  return {
    model,
    source: "none",
    async complete() {
      throw new OpusUnavailableError(reason);
    },
  };
}

// ── the box's own answers (each replaceable in tests) ───────────────────────

async function poolApiKey(): Promise<string | null> {
  try {
    const { readUsableApiKey } = await import("@/lib/anthropic-accounts");
    return await readUsableApiKey();
  } catch {
    return null;
  }
}

/** The pool's `claude` sign-in, usable now, and still signed in. */
async function subscriptionUsable(): Promise<boolean> {
  try {
    const { readAccounts, isUsable } = await import("@/lib/anthropic-accounts");
    const { hasAnthropicLogin } = await import("@/lib/claude-login");
    const now = Date.now();
    return hasAnthropicLogin() && (await readAccounts()).some((a) => a.kind === "login" && isUsable(a, now));
  } catch {
    return false;
  }
}

async function claudeOnPath(): Promise<{ path: string; pathValue: string } | null> {
  try {
    const { findExecutableOnPath, runnerPath } = await import("@/lib/coding-agent");
    const pathValue = runnerPath();
    const found = await findExecutableOnPath("claude", pathValue);
    return found ? { path: found, pathValue } : null;
  } catch {
    return null;
  }
}

async function defaultYieldReason(): Promise<string | null> {
  try {
    const { runningCount } = await import("@/lib/coding-agent");
    if (runningCount() > 0) return "a coding-agent run is working";
  } catch {
    /* no coding agent here: nothing to yield to */
  }
  try {
    const { memAvailableMb } = await import("@/lib/mem-available");
    const mb = await memAvailableMb();
    if (mb !== null && mb < OPUS_CLI_MIN_AVAILABLE_MB) return `only ${mb} MB of memory is free`;
  } catch {
    /* unknown memory is not a reason to stop */
  }
  return null;
}

export interface OpusSourceDeps {
  readKey?: OpusKeyReader;
  subscriptionUsable?: () => Promise<boolean>;
  claude?: () => Promise<{ path: string; pathValue: string } | null>;
}

export interface OpusSourceAnswer {
  source: OpusSource;
  /** Why the subscription is not used, when it is not and no key answers. */
  reason: string | null;
}

/** Which account the next night's second opinion would use. Reads; spends nothing. */
export async function detectOpusSource(deps: OpusSourceDeps = {}): Promise<OpusSourceAnswer & { key: string | null; claude: { path: string; pathValue: string } | null }> {
  const key = await (deps.readKey ?? poolApiKey)().catch(() => null);
  if (key) return { source: "api_key", reason: null, key, claude: null };
  const signedIn = await (deps.subscriptionUsable ?? subscriptionUsable)().catch(() => false);
  if (!signedIn) return { source: "none", reason: "no Anthropic API key and no usable Claude sign-in on this box", key: null, claude: null };
  const claude = await (deps.claude ?? claudeOnPath)().catch(() => null);
  if (!claude) return { source: "none", reason: "the claude CLI is not installed", key: null, claude: null };
  return { source: "subscription", reason: null, key: null, claude };
}

/**
 * The client tonight's tier uses: a test's override, else an API key, else
 * the subscription, else an unavailable client. Resolved once per night, so
 * one night never mixes two accounts.
 */
export async function resolveOpusClient(model: string = DEFAULT_OPUS_MODEL, deps: OpusSourceDeps & { yieldReason?: () => Promise<string | null>; runner?: CliRunner } = {}): Promise<OpusClient> {
  const override = opusClientOverride();
  if (override) return override;
  const found = await detectOpusSource(deps);
  if (found.source === "api_key") {
    const key = found.key;
    return createAnthropicOpusClient(model, fetch, async () => key);
  }
  if (found.source === "subscription" && found.claude) {
    return createSubscriptionOpusClient(model, {
      claudePath: found.claude.path,
      pathValue: found.claude.pathValue,
      yieldReason: deps.yieldReason,
      runner: deps.runner,
    });
  }
  return unavailableOpusClient(model, found.reason ?? "no account can answer");
}
