/**
 * A model switch WITHOUT a gateway restart (TASK-1535).
 *
 * The pinned OpenClaw core runs config reload in its default `hybrid` mode: it
 * watches openclaw.json and applies every change it classifies as hot — agents,
 * models, auth.order, auth.profiles, plugins.entries.*, tools, session,
 * messages — while the process keeps serving. Restarting clawbox-gateway on top
 * of that cost a model save 50-60 s of dead chat (the stop, the ~20 s
 * gateway-pre-start.sh, the ~30 s core start-up) to apply what the gateway had
 * already applied on its own about a second after the write. The chat model
 * picker has worked that way for a while (`/setup-api/chat/model`); this module
 * is what lets the other switch paths do the same.
 *
 * It answers the two questions a route has to ask before it drops a restart:
 *
 *  1. DOES THIS SAVE NEED ONE? {@link restartRequiredPaths} diffs openclaw.json
 *     from before the save against after it and classifies every changed path
 *     with the core's own reload table, failing safe to "restart" for a path no
 *     rule names, exactly as the core does.
 *  2. HAS THE GATEWAY APPLIED IT? {@link awaitGatewayHotApply} polls
 *     `config.get` until the runtime's `appliedConfigHash` equals the file's
 *     `configRevisionHash` — the check `openclaw models auth activate` makes
 *     itself — and then asks `models.authRefresh` to rebuild the auth state a
 *     CLI wrote outside the gateway.
 *
 * Whatever it cannot confirm within a few seconds is answered `applied: false`,
 * and the caller restarts as it used to. The restart is the fallback; it is
 * never skipped on hope.
 *
 * SERVER ONLY.
 */

import { isDeepStrictEqual } from "node:util";
import { gatewayReadyWaitMs, restartGateway } from "@/lib/openclaw-config";
import {
  GatewayRpcError,
  GatewayWsUnavailableError,
  gatewayWsCall,
  waitForGatewayRpcReady,
} from "@/lib/openclaw-gateway-ws";
import { envPort, isPortOpen } from "@/lib/port-probe";
import { gatewayRestartInFlight } from "@/lib/gateway-restart-tracker";

const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);

export type GatewayReloadKind = "restart" | "hot" | "none";

/**
 * The core's reload table (`src/gateway/config-reload-plan.ts` in the pinned
 * 2026.10.2), longest prefix wins. A path no rule names is a restart, which is
 * the core's own default. The rules a loaded channel or plugin registers on top
 * are hot or none in the core; `channels` and `plugins` below stand for them.
 *
 * ONE deliberate departure: `plugins.load` and `plugins.installs` are hot in the
 * core table and restart here. Plugin code arriving on or leaving the disk is
 * the change the gateway has been measured answering with a restart of its own
 * (TASK-1302, see `awaitGatewayRestartAfter` in `@/lib/gateway-health`), and the
 * one save that writes them — the first ClawBox AI link on a box without the
 * provider plugin — is rare enough to keep its restart.
 */
const RELOAD_RULES: ReadonlyArray<readonly [prefix: string, kind: GatewayReloadKind]> = [
  ["gateway.remote", "none"],
  ["gateway.reload", "none"],
  ["gateway.auth.token", "restart"],
  ["gateway.auth.password", "restart"],
  ["mcp.apps", "restart"],
  ["secrets.egressProxy", "restart"],
  ["gateway.portals", "restart"],
  ...[
    "gateway.http.endpoints",
    "gateway.http.securityHeaders.strictTransportSecurity",
    "gateway.tools",
    "gateway.uploads",
    "gateway.cliAgents",
    "gateway.controlUi.enabled",
    "gateway.controlUi.environment",
    "gateway.controlUi.communityInvite",
    "gateway.controlUi.newSessionModelDefaults",
    "gateway.controlUi.github",
    "gateway.controlUi.sessionObserver",
    "gateway.controlUi.embedSandbox",
    "gateway.controlUi.allowExternalEmbedUrls",
    "gateway.controlUi.automaticallyFetchFavicons",
    "gateway.controlUi.experimental.customPlugins",
    "gateway.controlUi.allowedOrigins",
    "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
    "gateway.nodes.browser",
    "gateway.nodes.pairing",
    "gateway.nodes.commands",
    "gateway.nodes.pluginTools.enabled",
    "gateway.nodes.allowSkills",
    "gateway.push.apns.relay",
    "gateway.terminal",
    "gateway.auth.rateLimit",
    "gateway.roles",
    "gateway.trustedProxies",
    "gateway.allowRealIpFallback",
    "gateway.auth.allowTailscale",
    "gateway.auth.identityScopes",
    "gateway.auth.trustedProxy",
    "gateway.publicOrigin",
    "diagnostics.enabled",
    "diagnostics.flags",
    "discovery.mdns.mode",
    "mcp.apps.sandboxOrigin",
    "mcp",
    "desktop.host",
    "cloudWorkers",
    "hooks",
    "cron",
    "transcripts",
    "agents.defaults",
    "agents.entries",
    "agents.ownership",
    "agent.heartbeat",
    "models",
    "skills.workshop.autonomous.mode",
    "talk.provider",
    "talk.realtime.provider",
    "session.scope",
    "session.store",
    "channels",
    "commands",
    "accessGroups",
    "tts",
    "surfaces",
    "acp",
    "tools",
    "approvals.exec",
    "approvals.plugin",
    "auth.order",
    "auth.profiles",
    "broadcast",
    "memory.citations",
    "worktreeRoot",
    "worktreeAcceleration",
    "security.audit.suppressions",
    "security.installPolicy",
    "diagnostics.cacheTrace.enabled",
    "attachments.ttlHours",
    "update.checkOnStart",
    "update.channel",
    "update.auto.enabled",
    "telemetry.enabled",
    "telemetry.consentedAt",
    "plugins",
  ].map((prefix) => [prefix, "hot"] as const),
  ["plugins.load", "restart"],
  ["plugins.installs", "restart"],
  ...[
    "meta",
    "identity",
    "wizard",
    "logging",
    "agents",
    "bindings",
    "audio",
    "agent",
    "routing",
    "messages",
    "session",
    "talk",
    "skills",
    "secrets",
    "tui",
    "ui",
  ].map((prefix) => [prefix, "none"] as const),
  ["gateway", "restart"],
  ["discovery", "restart"],
];

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** How the running gateway applies a change at this dotted config path. */
export function gatewayReloadKind(path: string): GatewayReloadKind {
  let kind: GatewayReloadKind = "restart";
  let depth = -1;
  for (const [prefix, ruleKind] of RELOAD_RULES) {
    if (!matchesPrefix(path, prefix)) continue;
    const ruleDepth = prefix.split(".").length;
    if (ruleDepth > depth) {
      depth = ruleDepth;
      kind = ruleKind;
    }
  }
  return kind;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectChangedPaths(prev: unknown, next: unknown, prefix: string, out: string[]): void {
  if (prev === next) return;
  const prevIsObject = isPlainObject(prev);
  const nextIsObject = isPlainObject(next);
  if (prevIsObject || nextIsObject) {
    const prevRecord = prevIsObject ? prev : {};
    const nextRecord = nextIsObject ? next : {};
    const found = out.length;
    for (const key of new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])) {
      collectChangedPaths(prevRecord[key], nextRecord[key], prefix ? `${prefix}.${key}` : key, out);
    }
    // An object that appeared, vanished or replaced a scalar without a single
    // leaf to show for it (`{}`) is still a change at its own path.
    if (!(prevIsObject && nextIsObject) && out.length === found) out.push(prefix || "<root>");
    return;
  }
  // Arrays are values, as in the core's diff: one path for the whole list.
  if (isDeepStrictEqual(prev, next)) return;
  out.push(prefix || "<root>");
}

/** Dotted paths whose values differ between two openclaw.json snapshots. */
export function diffConfigPaths(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  collectChangedPaths(before, after, "", out);
  return out;
}

/**
 * The changed paths of a save that only a gateway restart applies. Empty means
 * every change hot-applies (or nothing changed at all).
 *
 * The snapshots are openclaw.json as this server reads it, before and after the
 * save. A snapshot that could not be read comes in as `{}`, so the diff names
 * everything in the other one — the `gateway` block included — and the answer
 * fails safe to a restart, which is also what a first-boot save with no config
 * on disk yet gets.
 */
export function restartRequiredPaths(before: unknown, after: unknown): string[] {
  return diffConfigPaths(before, after).filter((path) => gatewayReloadKind(path) === "restart");
}

/**
 * How long a save waits for the gateway to confirm a hot apply before it falls
 * back to restarting it.
 *
 * Measured on a device (TASK-1535): the chat model picker's whole switch —
 * the config write, the reload and the session sweep — took 1.5-2.8 s. Ten
 * seconds is several times the reload alone and still a fraction of the 50-60 s
 * a restart costs. `GATEWAY_HOT_APPLY_WAIT_MS` is an operator escape hatch, read
 * per call and guarded like `GATEWAY_READY_WAIT_MS`.
 */
export function gatewayHotApplyWaitMs(): number {
  const override = Number(process.env.GATEWAY_HOT_APPLY_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? override : 10_000;
}

const CONFIG_GET_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 250;
const AUTH_REFRESH_TIMEOUT_MS = 5_000;

/** What the gateway reported about its config BEFORE the save wrote anything. */
export interface GatewayConfigBaseline {
  /** `config.get`'s hash of the raw file, or null when it named none. */
  hash: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the running gateway for its config revision before a save writes.
 *
 * Needed because `config.get` answers from a cache keyed on the APPLIED
 * revision: until the file watcher has noticed a write, a fresh call can still
 * return the old answer — in which the file and the runtime agree, about the old
 * file. A reply whose raw hash is still the baseline's is that stale answer and
 * is not taken as an acknowledgment.
 *
 * Null when the gateway did not answer at all (down, starting, or busy past the
 * deadline). Never throws.
 */
export async function readGatewayConfigBaseline(): Promise<GatewayConfigBaseline | null> {
  try {
    const current = await gatewayWsCall("config.get", {}, { timeoutMs: CONFIG_GET_TIMEOUT_MS });
    return { hash: typeof current.hash === "string" && current.hash ? current.hash : null };
  } catch (err) {
    console.warn("[gateway-hot-apply] the gateway did not answer config.get before the save:", messageOf(err));
    return null;
  }
}

function isAppliedAnswer(current: Record<string, unknown>, baselineHash: string | null): boolean {
  const revision = current.configRevisionHash;
  if (typeof revision !== "string" || !revision) return false;
  if (revision !== current.appliedConfigHash) return false;
  // The file the gateway describes must be one written after the baseline.
  return !(baselineHash && current.hash === baselineHash);
}

/**
 * Rebuild the gateway's model auth state from the store on disk.
 *
 * `openclaw models auth paste-api-key` already calls this itself once it has
 * written the store, and prints a warning — not an error — when the gateway
 * would not take it; a config hot apply re-activates the stores as well. This
 * call is the confirmation: the core's documented answer for "a credential
 * changed outside the gateway" (`models.authRefresh`, the call `openclaw models
 * auth` makes), with the older cores' `models.authStatus { refresh: true }` as
 * the fallback the CLI itself uses on "unknown method".
 */
export async function refreshGatewayModelAuth(timeoutMs = AUTH_REFRESH_TIMEOUT_MS): Promise<boolean> {
  try {
    await gatewayWsCall("models.authRefresh", { operation: "update" }, { timeoutMs });
    return true;
  } catch (err) {
    if (err instanceof GatewayRpcError && /unknown method/i.test(err.message)) {
      try {
        await gatewayWsCall("models.authStatus", { refresh: true }, { timeoutMs });
        return true;
      } catch (fallbackErr) {
        console.warn("[gateway-hot-apply] models.authStatus refresh failed:", messageOf(fallbackErr));
        return false;
      }
    }
    console.warn("[gateway-hot-apply] models.authRefresh failed:", messageOf(err));
    return false;
  }
}

/** Why a hot apply could not be confirmed. */
export type HotApplyFailure =
  /** Nothing was listening before or after the save: there is no gateway to apply it. */
  | "gateway-down"
  /** It answered, then its port closed: the gateway is restarting by itself. */
  | "gateway-restarting"
  /** It never reported the new revision applied within the budget. */
  | "not-confirmed"
  /** The revision applied, but the auth state could not be rebuilt. */
  | "auth-refresh-failed";

export type HotApplyResult =
  | { applied: true; how: "hot-reload" | "nothing-to-apply" }
  | { applied: false; why: HotApplyFailure };

export interface HotApplyRequest {
  /** From {@link readGatewayConfigBaseline}, taken before the save wrote anything. */
  baseline: GatewayConfigBaseline | null;
  /** Did openclaw.json change at all? */
  configChanged: boolean;
  /** Did the save write the credential store from outside the gateway (a CLI paste)? */
  credentialsWritten: boolean;
  /** Defaults to {@link gatewayHotApplyWaitMs}. */
  budgetMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait, bounded, until the running gateway serves what the save wrote.
 *
 * Only for a save whose every changed path hot-applies — ask
 * {@link restartRequiredPaths} first. Never throws: a failure is an answer, and
 * the caller's answer to it is the restart it used to make unconditionally.
 */
export async function awaitGatewayHotApply(request: HotApplyRequest): Promise<HotApplyResult> {
  if (!request.configChanged && !request.credentialsWritten) return { applied: true, how: "nothing-to-apply" };
  const deadline = Date.now() + (request.budgetMs ?? gatewayHotApplyWaitMs());

  // No answer before the save. A gateway whose port is closed is down (or still
  // starting), and a restart is what brings it up on the new config; one that
  // listens but did not answer is busy, and is polled like any other.
  let answered = request.baseline !== null;
  if (!answered && !(await isPortOpen(GATEWAY_PORT, "127.0.0.1", 1_000))) {
    return { applied: false, why: "gateway-down" };
  }

  if (request.configChanged) {
    const baselineHash = request.baseline?.hash ?? null;
    let confirmed = false;
    while (!confirmed) {
      const left = deadline - Date.now();
      if (left <= 0) {
        console.warn("[gateway-hot-apply] the gateway did not confirm the new config revision in time");
        return { applied: false, why: "not-confirmed" };
      }
      try {
        const current = await gatewayWsCall("config.get", {}, {
          timeoutMs: Math.max(POLL_INTERVAL_MS, Math.min(CONFIG_GET_TIMEOUT_MS, left)),
        });
        answered = true;
        confirmed = isAppliedAnswer(current, baselineHash);
      } catch (err) {
        if (err instanceof GatewayWsUnavailableError) {
          // No token this server can use (a SecretRef, an `${ENV}` value): the
          // gateway cannot be asked at all, so there is nothing to wait for.
          if (err.message === "no gateway token") return { applied: false, why: "not-confirmed" };
          if (answered && !(await isPortOpen(GATEWAY_PORT, "127.0.0.1", 1_000))) {
            return { applied: false, why: "gateway-restarting" };
          }
        }
        // Busy or transient: the next poll asks again.
      }
      if (!confirmed) await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  if (request.credentialsWritten) {
    const left = Math.max(1_000, deadline - Date.now());
    if (!(await refreshGatewayModelAuth(Math.min(AUTH_REFRESH_TIMEOUT_MS, left)))) {
      return { applied: false, why: "auth-refresh-failed" };
    }
  }
  return { applied: true, how: "hot-reload" };
}

/** Where a route's config write left the running gateway. */
export type ConfigWriteSettlement =
  /** It serves the write now. */
  | "applied"
  /** It is restarting by itself to apply it; a restart of ours would only add one. */
  | "gateway-restarting"
  /** Only a restart applies it, or the gateway could not confirm it: restart. */
  | "restart-required";

/**
 * The whole decision for a route whose writes are model selections (the
 * Local-only switch, turning Local AI off): classify the diff, and when every
 * change hot-applies, wait for the gateway to confirm it. `before` and `after`
 * are openclaw.json as the route read it around its writes; `baseline` was
 * taken before them. Never throws.
 */
export async function settleConfigWrite(options: {
  before: unknown;
  after: unknown;
  baseline: GatewayConfigBaseline | null;
  /** Names the caller in the log line. */
  label: string;
}): Promise<ConfigWriteSettlement> {
  const restartPaths = restartRequiredPaths(options.before, options.after);
  if (restartPaths.length > 0) {
    console.log(`[${options.label}] only a gateway restart applies ${restartPaths.join(", ")}`);
    return "restart-required";
  }
  const hot = await awaitGatewayHotApply({
    baseline: options.baseline,
    configChanged: diffConfigPaths(options.before, options.after).length > 0,
    credentialsWritten: false,
  });
  if (hot.applied) return "applied";
  console.warn(`[${options.label}] the gateway did not apply the change live (${hot.why})`);
  return hot.why === "gateway-restarting" ? "gateway-restarting" : "restart-required";
}

/**
 * How long a restart may take to be REFUSED. A masked unit, a missing one or a
 * sudoers grant that is not there all come back from `systemctl` in well under
 * a second; a restart systemd took blocks for the stop and the whole
 * `gateway-pre-start.sh` (20-50 s on a board). Five seconds tells the two apart
 * on a loaded Jetson without holding the request for the second.
 */
const RESTART_REFUSAL_WINDOW_MS = 5_000;

export interface EarlyRestart {
  /**
   * Resolves true once the restarted gateway answers RPCs, false when it did
   * not within the budget or the restart failed late. Never rejects.
   */
  back: Promise<boolean>;
}

/**
 * Restart clawbox-gateway and return as soon as systemd has TAKEN the restart,
 * not when the gateway is back.
 *
 * A request that waited for the stop, the pre-start, the core start-up and an
 * RPC answer took two minutes on a board (TASK-1535) — past what the browser and
 * the tunnel in front of this box will hold open — and then reported a save
 * that had landed as a gateway that "did not come back". The page waits for the
 * gateway instead, through `/setup-api/gateway/health`, which reports a restart
 * still in flight as not available (`@/lib/gateway-restart-tracker`).
 *
 * Throws only when the restart is refused within the window: that is the one
 * failure the owner has to act on. Whatever has to follow the gateway (a
 * session sweep, the cloud defaults) chains on `back`.
 */
export async function restartGatewayAnsweringEarly(options: {
  /**
   * How long `back` waits for the restarted gateway to answer. Defaults to
   * twice `gatewayReadyWaitMs()`: nobody holds a request open for it.
   */
  readyWaitMs?: number;
  refusalWindowMs?: number;
} = {}): Promise<EarlyRestart> {
  const readyWaitMs = options.readyWaitMs ?? gatewayReadyWaitMs() * 2;
  const restart = restartGateway({ awaitReady: false });
  const windowMs = options.refusalWindowMs ?? RESTART_REFUSAL_WINDOW_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const window = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, windowMs);
    timer.unref?.();
  });
  try {
    await Promise.race([restart, window]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const back = restart.then(
    () => waitForGatewayRpcReady(readyWaitMs),
    (err: unknown) => {
      // Past the window this is almost always the client's own deadline on a
      // slow pre-start; systemd carries on with the restart regardless.
      console.warn("[gateway-hot-apply] the gateway restart failed after it was taken:", messageOf(err));
      return false;
    },
  );
  return { back };
}

/**
 * Wait until a restart this server issued is over and the gateway answers
 * again. For a caller that holds a stream open and can show progress while it
 * waits (the llama.cpp install). Never throws.
 */
export async function waitForGatewayBack(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (gatewayRestartInFlight()) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
  }
  return waitForGatewayRpcReady(Math.max(0, deadline - Date.now()));
}
