/**
 * The OpenClaw gateway as a consumer of the box's active Anthropic account
 * (TASK-1260).
 *
 * THREE JOBS.
 *
 *  1. THE SWAP. When the active account moves (src/lib/anthropic-swap.ts), the
 *     gateway's Claude subscription profile — every agent's, so every session,
 *     cron run and heartbeat — gets the new account's access token
 *     (src/lib/anthropic-gateway-auth.ts) and the gateway is restarted on it,
 *     so a turn in flight on the old account is not the only thing that
 *     changes. The write is read back after the restart and repeated once if
 *     it did not survive it.
 *
 *  2. THE KEEPER. The gateway holds an access token and no refresh token (the
 *     pool is the grant's only holder), so every ten minutes the keeper renews
 *     the token through the pool once it is within three hours of its end and
 *     puts the renewal in — no restart, the old token is still good. It also
 *     notices a profile something ELSE wrote since (the owner signing in again
 *     in Settings → Providers) and stands down: the gateway is then on the
 *     owner's own sign-in until the next swap.
 *
 *  3. THE FAILURES. A gateway turn that dies on the limit is invisible to the
 *     server — the gateway reports it to whoever sent it. So: cron runs and
 *     heartbeats (OpenClaw 2 runs heartbeats as cron jobs) are read with
 *     `cron.list` every two minutes, and a run whose last error is an
 *     Anthropic limit or a refused credential is reported and run once more
 *     (`cron.run`, `mode: "force"`) after the swap; the desktop chat reports
 *     its own failed turns through /setup-api/anthropic/failure, and the turn
 *     is sent again into its session.
 *
 * WHEN THE GATEWAY FOLLOWS. Once it has been moved it follows every move. The
 * first time, only for a move a FAILURE or the OWNER caused (a limit, a refused
 * credential, a removal, the owner's new order): connecting a first account
 * must not silently replace the sign-in the chat already runs on.
 *
 * WHAT IT CANNOT CARRY. The profile holds a Claude account's OAuth token; an
 * API-key account or the Terminal's `claude` sign-in (never read by this box)
 * cannot be put there. When the active account is one of those the gateway is
 * left where it is and the swap says so (`not_transferable`).
 */

import { DATA_DIR } from "@/lib/config-store";
import { gatewayIsAbsent, openclawIsAbsent, restartGateway } from "@/lib/openclaw-config";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";
import { processStore } from "@/lib/process-store";
import {
  gatewayCredentialFor,
  readPoolState,
  setGatewayMirror,
  type SwapConsumerOutcome,
} from "@/lib/anthropic-accounts";
import {
  listGatewayAnthropicProfiles,
  tokenFingerprint,
  writeGatewayAnthropicToken,
  type GatewayAnthropicProfile,
  type GatewayWriteResult,
} from "@/lib/anthropic-gateway-auth";
import { registerSwapConsumer, reportAnthropicFailure, type FailureOutcome, type SwapContext } from "@/lib/anthropic-swap";

/** Everything this module touches outside itself — one seam, so the tests can stand in for a gateway. */
export interface GatewayDeps {
  absent: () => boolean;
  list: () => GatewayAnthropicProfile[];
  write: (token: { access: string; expires: number | null }) => GatewayWriteResult;
  restart: () => Promise<void>;
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const defaultDeps: GatewayDeps = {
  absent: () => openclawIsAbsent() || gatewayIsAbsent(),
  list: () => listGatewayAnthropicProfiles(),
  write: (token) => writeGatewayAnthropicToken(token),
  restart: () => restartGateway({ awaitReady: true }),
  // The in-process socket only: a gateway that is not there is skipped this
  // time rather than paid for with a CLI start-up (seconds on a Jetson) every
  // two minutes.
  call: (method, params) => gatewayWsCall(method, params, { timeoutMs: 10_000 }),
};

interface GatewayRuntime {
  deps: GatewayDeps;
  registered: boolean;
  keeper: ReturnType<typeof setInterval> | null;
  watcher: ReturnType<typeof setInterval> | null;
  /** Cron runs older than this have been looked at. */
  cronWatermark: number | null;
  /** One keeper / watcher pass at a time. */
  busy: boolean;
}

function runtime(): GatewayRuntime {
  return processStore<GatewayRuntime>(`anthropic-gateway:${DATA_DIR}`, () => ({
    deps: defaultDeps,
    registered: false,
    keeper: null,
    watcher: null,
    cronWatermark: null,
    busy: false,
  }));
}

const deps = () => runtime().deps;

const KEEPER_MS = 10 * 60_000;
const WATCH_MS = 2 * 60_000;
/** How far back the first look at the crons reaches: a failure just before a restart still counts. */
const FIRST_LOOK_BACK_MS = 15 * 60_000;

/** The causes that move a gateway which has never followed the pool. */
const TAKEOVER_CAUSES = new Set(["limit", "auth", "removed", "owner"]);

function outcome(status: SwapConsumerOutcome["status"], code: string, count: number | null = null): SwapConsumerOutcome {
  return { status, code, count };
}

// ── 1. the swap ─────────────────────────────────────────────────────────────

/** The consumer src/lib/anthropic-swap.ts fans a move out to. */
export async function applyGatewaySwap(ctx: SwapContext): Promise<SwapConsumerOutcome> {
  if (deps().absent()) return outcome("skipped", "no_gateway");
  const { change } = ctx;
  if (!change.toId) return outcome("skipped", "no_account");
  const pool = await readPoolState();
  if (pool.gateway === null && !ctx.takeover && !TAKEOVER_CAUSES.has(change.cause)) return outcome("skipped", "not_following");
  return syncGatewayTo(change.toId, { restart: true });
}

/**
 * Put the gateway on `accountId`: write, restart, read back. Answers what it
 * did in the swap's fixed words. `restart: false` is the keeper's renewal — the
 * token the gateway holds is still good, and the next read picks the new one.
 */
export async function syncGatewayTo(accountId: string, opts: { restart: boolean }): Promise<SwapConsumerOutcome> {
  const d = deps();
  if (d.absent()) return outcome("skipped", "no_gateway");
  const pool = await readPoolState();
  const account = pool.accounts.find((a) => a.id === accountId);
  if (!account) return outcome("skipped", "no_account");
  const profiles = d.list();
  if (profiles.length === 0) return outcome("skipped", "not_subscription");
  if (account.kind !== "oauth") return outcome("skipped", "not_transferable");
  const token = await gatewayCredentialFor(accountId);
  if (!token) return outcome("failed", "credential_unavailable");
  const fingerprint = tokenFingerprint(token.access);
  const alreadyThere = profiles.every((p) => p.fingerprint === fingerprint);
  let written = alreadyThere ? profiles.length : 0;
  if (!alreadyThere) {
    const result = d.write(token);
    if (result.written === 0) return outcome("failed", "write_failed");
    written = result.written;
  }
  await setGatewayMirror({ accountId, fingerprint, expiresAt: token.expires, at: Date.now() });
  if (!opts.restart || alreadyThere) return outcome("ok", alreadyThere ? "already" : "renewed", written);
  try {
    await d.restart();
  } catch (err) {
    console.error("[anthropic-gateway] the gateway did not come back after the account swap:", err instanceof Error ? err.message : err);
    return outcome("failed", "restart_failed", written);
  }
  // The gateway may have flushed its own copy of the store on the way down.
  if (d.list().some((p) => p.fingerprint !== fingerprint)) {
    d.write(token);
    try {
      await d.restart();
    } catch {
      return outcome("failed", "restart_failed", written);
    }
    if (d.list().some((p) => p.fingerprint !== fingerprint)) return outcome("failed", "write_lost", written);
  }
  console.error(`[anthropic-gateway] the gateway now runs on Anthropic account ${accountId} (${written} profile(s))`);
  return outcome("ok", "switched", written);
}

// ── 2. the keeper ───────────────────────────────────────────────────────────

export type KeeperResult = "idle" | "fresh" | "renewed" | "resynced" | "stood_down" | "failed";

/** One keeper pass. Exported for the tests; the timer calls it every ten minutes. */
export async function keepGatewayMirror(): Promise<KeeperResult> {
  const d = deps();
  if (d.absent()) return "idle";
  const pool = await readPoolState();
  const mirror = pool.gateway;
  if (!mirror) return "idle";
  // The active account moved and the swap could not take the gateway with it
  // (a restart that failed): try again.
  if (pool.activeId && mirror.accountId !== pool.activeId) {
    const account = pool.accounts.find((a) => a.id === pool.activeId);
    if (account?.kind === "oauth") return (await syncGatewayTo(pool.activeId, { restart: true })).status === "ok" ? "resynced" : "failed";
  }
  const profiles = d.list();
  if (profiles.length === 0) {
    await setGatewayMirror(null);
    return "stood_down";
  }
  const token = await gatewayCredentialFor(mirror.accountId);
  if (!token) return "failed";
  const fingerprint = tokenFingerprint(token.access);
  if (profiles.some((p) => p.fingerprint !== mirror.fingerprint && p.fingerprint !== fingerprint)) {
    // Not ours: the owner signed the chat in again. It is theirs until the next swap.
    await setGatewayMirror(null);
    console.error("[anthropic-gateway] the gateway's Claude sign-in was replaced outside the account pool; it no longer follows the pool until the next swap");
    return "stood_down";
  }
  if (fingerprint === mirror.fingerprint && profiles.every((p) => p.fingerprint === fingerprint)) return "fresh";
  if (d.write(token).written === 0) return "failed";
  await setGatewayMirror({ ...mirror, fingerprint, expiresAt: token.expires });
  return "renewed";
}

// ── 3. the failures ─────────────────────────────────────────────────────────

interface CronJobView {
  id: string;
  lastStatus: string | null;
  lastError: string | null;
  lastRunAtMs: number | null;
}

/** `cron.list`'s jobs, read defensively: the fields core has used for a job's last run, flat or under `state`. */
export function parseCronJobs(payload: unknown): CronJobView[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(root.jobs) ? root.jobs : Array.isArray(payload) ? payload : [];
  const jobs: CronJobView[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const job = raw as Record<string, unknown>;
    const state = (job.state && typeof job.state === "object" ? job.state : job) as Record<string, unknown>;
    const id = typeof job.id === "string" ? job.id : typeof job.jobId === "string" ? job.jobId : null;
    if (!id) continue;
    const status = state.lastStatus ?? state.lastRunStatus;
    const error = state.lastError;
    const at = state.lastRunAtMs ?? state.lastRunAt;
    jobs.push({
      id,
      lastStatus: typeof status === "string" ? status : null,
      lastError: typeof error === "string" && error ? error : null,
      lastRunAtMs: typeof at === "number" && Number.isFinite(at) ? at : null,
    });
  }
  return jobs;
}

/**
 * Words that make a failure the Anthropic account's rather than some other
 * provider's: the provider named, or Anthropic's own error types and the CLI's
 * own limit lines. A cron on another provider that hit ITS rate limit must not
 * take a Claude account out.
 */
const ANTHROPIC_WORDS_RE = /anthropic|claude|rate_limit_error|authentication_error|x-api-key|hit your (?:session |weekly |usage )?limit|usage limit reached/i;

export function mentionsAnthropic(text: string | null | undefined): boolean {
  return typeof text === "string" && ANTHROPIC_WORDS_RE.test(text.slice(0, 600));
}

/** One look at the gateway's crons. Answers how many failures it reported. */
export async function scanGatewayCrons(now: number = Date.now()): Promise<number> {
  const d = deps();
  const state = runtime();
  if (d.absent()) return 0;
  const pool = await readPoolState();
  if (pool.accounts.length === 0 || d.list().length === 0) return 0;
  let payload: Record<string, unknown>;
  try {
    payload = await d.call("cron.list", { includeDisabled: false });
  } catch {
    return 0;
  }
  const since = state.cronWatermark ?? now - FIRST_LOOK_BACK_MS;
  let newest = since;
  let reported = 0;
  for (const job of parseCronJobs(payload)) {
    if (job.lastRunAtMs === null || job.lastRunAtMs <= since) continue;
    newest = Math.max(newest, job.lastRunAtMs);
    if (job.lastStatus !== "error" || !mentionsAnthropic(job.lastError)) continue;
    const accountId = pool.gateway?.accountId ?? null;
    const result = await reportAnthropicFailure({
      text: job.lastError,
      source: "cron",
      accountId,
      retry: {
        // Per account: a run that fails again on the account it was moved to
        // is a new failure, and earns one retry of its own on the next.
        key: `cron:${job.id}:${accountId ?? "own"}`,
        after: "gateway",
        run: async () => {
          try {
            await d.call("cron.run", { id: job.id, mode: "force" });
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    if (result.handled) reported += 1;
  }
  state.cronWatermark = newest;
  return reported;
}

export interface ChatFailure {
  /** The gateway's own words for the failed turn, and the provider's when it passed them on. */
  errorMessage?: unknown;
  detail?: unknown;
  /** The gateway's failover reason (`rate_limit`, `auth`, `billing`, …). */
  reason?: unknown;
  provider?: unknown;
  model?: unknown;
  /** Where to send the turn again, and what it said. */
  sessionKey?: unknown;
  message?: unknown;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** A desktop-chat turn that failed: an Anthropic one is reported, and sent once more after the swap. */
export async function reportChatFailure(input: ChatFailure): Promise<FailureOutcome | null> {
  const provider = text(input.provider, 80)?.toLowerCase() ?? null;
  const model = text(input.model, 200)?.toLowerCase() ?? null;
  const detail = text(input.detail, 2_000);
  const errorMessage = text(input.errorMessage, 2_000);
  const anthropic = provider === "anthropic" || (model !== null && /^(?:anthropic\/)?claude/.test(model))
    || (provider === null && mentionsAnthropic(`${detail ?? ""} ${errorMessage ?? ""}`));
  if (!anthropic) return null;
  const pool = await readPoolState();
  const accountId = pool.gateway?.accountId ?? null;
  const sessionKey = text(input.sessionKey, 300);
  const message = text(input.message, 32_000);
  const d = deps();
  return reportAnthropicFailure({
    // The provider's own words first: the gateway's copy says "rate limit"
    // without the time the account comes back.
    text: [detail, errorMessage].filter(Boolean).join("\n") || null,
    reason: text(input.reason, 40),
    source: "chat",
    accountId,
    retry: sessionKey && message ? {
      key: `chat:${sessionKey}:${tokenFingerprint(message)}:${accountId ?? "own"}`,
      after: "gateway",
      run: async () => {
        try {
          // Stable for the turn it repeats: the gateway can tell a second
          // delivery of the same retry from a new one.
          await d.call("chat.send", { sessionKey, message, deliver: false, idempotencyKey: `clawbox-swap-${tokenFingerprint(`${sessionKey}:${message}:${accountId ?? "own"}`)}` });
          return true;
        } catch {
          return false;
        }
      },
    } : undefined,
  });
}

// ── wiring ──────────────────────────────────────────────────────────────────

/**
 * At boot (armAnthropicAccounts) and from the chat's report route: register the
 * consumer and start the keeper and the cron watcher, once per process.
 */
export function startGatewaySwap(): void {
  const state = runtime();
  if (!state.registered) {
    state.registered = true;
    registerSwapConsumer({ name: "gateway", apply: applyGatewaySwap });
  }
  if (!state.keeper) {
    state.keeper = setInterval(() => void guarded(() => keepGatewayMirror()), KEEPER_MS);
    state.keeper.unref?.();
  }
  if (!state.watcher) {
    state.watcher = setInterval(() => void guarded(() => scanGatewayCrons()), WATCH_MS);
    state.watcher.unref?.();
  }
}

async function guarded(work: () => Promise<unknown>): Promise<void> {
  const state = runtime();
  if (state.busy) return;
  state.busy = true;
  try {
    await work();
  } catch (err) {
    console.error("[anthropic-gateway] a background pass failed:", err instanceof Error ? err.message : err);
  } finally {
    state.busy = false;
  }
}

/** Test seam: stand in for the gateway, and forget the timers and the watermark. */
export function _setGatewayDepsForTests(overrides: Partial<GatewayDeps> | null): void {
  const state = runtime();
  state.deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  if (state.keeper) clearInterval(state.keeper);
  if (state.watcher) clearInterval(state.watcher);
  state.keeper = null;
  state.watcher = null;
  state.registered = false;
  state.cronWatermark = null;
  state.busy = false;
}
