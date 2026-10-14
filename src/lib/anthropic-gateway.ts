/**
 * The OpenClaw gateway as a consumer of the box's Anthropic account pool
 * (TASK-1260; the gateway leg proven on the box 2026-10-14).
 *
 * WHAT IT DOES. While the chat runs on a Claude model, EVERY Claude account of
 * the pool is in the gateway as an auth profile of its own, and core does the
 * rest — the same in every turn it runs: the desktop chat, Telegram and the
 * other channels, cron runs and heartbeats, the CLI. A limit in a turn makes
 * core cool that account's profile down and try the next one INSIDE the same
 * turn, instead of falling back to another provider; the box reads what core
 * recorded and moves the pool with it, so coding runs, the accounts card and
 * the owner's notice agree with the chat.
 *
 * WHY. Until now the gateway held ONE Claude profile and the box overwrote it
 * with whichever account was active, then restarted the gateway. On the box a
 * real 429 in the chat logged `rotations=0` — core had nothing to rotate to —
 * and core answered from ClawBox AI while the pool still called the account
 * fine: the box only heard of chat failures through the desktop chat's own
 * report and a cron scan, never of a Telegram turn or of a turn core rescued
 * with a model fallback.
 *
 * HARNESS FIRST — every mechanism here is core's own (OpenClaw 2026.10.2):
 *  - THE PROFILES: `anthropic:clawbox-<pool id>`, written by core's own writer,
 *    `openclaw models auth paste-token --provider anthropic --profile-id <id>
 *    --expires-in <n>s`, the token on stdin. A `token` profile is a bearer core
 *    uses and never refreshes — the pool stays the ONLY holder of each refresh
 *    token, and the keeper below puts a renewed access token in before the old
 *    one ends. `models auth logout <id> --yes` takes one out, with its order
 *    and config entries. The CLI tells the running gateway; nothing restarts.
 *  - THE ORDER: core's stored per-agent order, `openclaw models auth order set
 *    --provider anthropic <ids…>`: the active account first, then the pool's
 *    other accounts that can answer, in the owner's order, then the limited
 *    ones by their reset, then every other Anthropic profile the store holds.
 *    An explicit order is the WHOLE candidate list, so nothing the owner put
 *    there is dropped. The CLI's `order set`, not the `models.authOrderSet`
 *    RPC: `paste-token` registers each profile in openclaw.json's
 *    `auth.profiles`, and beside an `anthropic:default` sign-in of another
 *    mode that also writes a CONFIG `auth.order.anthropic`, over which the
 *    RPC refuses ("controlled by auth configuration") while the stored order
 *    still outranks it for selection.
 *  - ROTATION AND COOLDOWNS: core's. On a rate limit it allows ONE same-provider
 *    profile rotation per turn before model fallback
 *    (`MAX_RATE_LIMIT_PROFILE_ROTATIONS`), so the order matters: the next
 *    profile must be an account that can answer.
 *  - WHAT CORE SAW: its per-profile failure state (`usageStats`, in the store's
 *    state row), read here and never written. Core's window is its own backoff,
 *    not the account's reset, so a rate-limit cooldown is checked against
 *    Anthropic's usage windows for that account (src/lib/anthropic-usage.ts):
 *    a spent window is the pool's limit until Anthropic's reset; a window that
 *    is not spent was a throttle, core's cooldown handles it, and the pool is
 *    left alone.
 *
 * THE OWNER'S OWN SIGN-IN. A Claude sign-in made for the chat in Settings → AI
 * Models (`anthropic:default`, which core owns and refreshes) is never
 * rewritten or deleted. It goes LAST in the order: the box cannot tell which
 * account it is — on the box it was a second grant of a pool account — and
 * ahead of the pool's accounts the one rotation a turn gets could land on the
 * same spent subscription and fall back to another provider. At the end it is
 * still what answers when every pool account is out.
 *
 * WHEN. While the pool has a Claude account and openclaw.json's primary model
 * is a Claude one. The owner turns the chat onto the pool from the accounts
 * card (`useAccountsForChat`, which sets the model through Settings → AI
 * Models' own path); a chat on another provider is never switched by itself,
 * and when the owner moves it off Claude the pool's profiles are taken out.
 *
 * WHAT IT CANNOT CARRY. An API key or the Terminal's `claude` sign-in is not a
 * Claude account this box holds the grant of; with one of those active the
 * chat stays on the pool's Claude accounts (`not_transferable`).
 */

import { DATA_DIR } from "@/lib/config-store";
import { gatewayIsAbsent, openclawIsAbsent, readConfigStrict, spawnOpenclawCli } from "@/lib/openclaw-config";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";
import { processStore } from "@/lib/process-store";
import { createSerialLock, type SerialLock } from "@/lib/serial-lock";
import {
  gatewayCredentialFor,
  markLimited,
  probeAccountCredential,
  readPoolState,
  setGatewayMirror,
  type AnthropicAccount,
  type PoolState,
  type SwapConsumerOutcome,
} from "@/lib/anthropic-accounts";
import { tokenFingerprint } from "@/lib/anthropic-gateway-auth";
import { DEFAULT_LIMIT_MS, effectiveStatus, type AnthropicLimitKind } from "@/lib/anthropic-limit";
import { fetchAnthropicUsage, type AnthropicUsageReading } from "@/lib/anthropic-usage";
import { readGatewayProviderAuth, type GatewayProviderAuthRead, type ProfileFailureState } from "@/lib/openclaw-auth-store";
import { registerSwapConsumer, reportAnthropicFailure, type FailureOutcome, type SwapContext } from "@/lib/anthropic-swap";
import { verifyAnthropicKey } from "@/lib/coding-anthropic";

const PROVIDER = "anthropic";
const POOL_PROFILE_PREFIX = "anthropic:clawbox-";

/** The gateway profile one pool account is held under. */
function poolProfileId(accountId: string): string {
  return `${POOL_PROFILE_PREFIX}${accountId}`;
}

const isPoolProfile = (profileId: string) => profileId.startsWith(POOL_PROFILE_PREFIX);

/** Everything this module touches outside itself — one seam, so the tests can stand in for a gateway. */
export interface GatewayDeps {
  absent: () => boolean;
  /** Is the chat's primary model a Claude one? Null when openclaw.json could not be read. */
  chatOnClaude: () => Promise<boolean | null>;
  /** What core's store holds for Anthropic: the profiles, the stored order, the failures. */
  read: () => GatewayProviderAuthRead;
  /** Core's writer: one `token` profile, the access token on stdin. */
  paste: (profileId: string, token: { access: string; expires: number | null }) => Promise<void>;
  /** Core's removal of one profile, its order and config entries. */
  logout: (profileId: string) => Promise<void>;
  /** Core's stored order for Anthropic; an empty list clears it. */
  order: (profileIds: readonly string[]) => Promise<void>;
  /** Anthropic's usage windows for one account. Null: could not be asked. */
  usage: (access: string) => Promise<AnthropicUsageReading | null>;
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** A Jetson CLI cold start is 5-14 s; a busy one is given room. */
const CLI_TIMEOUT_MS = 60_000;

const defaultDeps: GatewayDeps = {
  absent: () => openclawIsAbsent() || gatewayIsAbsent(),
  chatOnClaude: async () => {
    try {
      const primary = (await readConfigStrict()).agents?.defaults?.model?.primary;
      return typeof primary === "string" && primary.trim().toLowerCase().startsWith(`${PROVIDER}/`);
    } catch {
      return null;
    }
  },
  read: () => readGatewayProviderAuth(PROVIDER),
  paste: async (profileId, token) => {
    const args = ["models", "auth", "paste-token", "--provider", PROVIDER, "--profile-id", profileId];
    // Core stores the end itself, so it stops offering the profile at the
    // moment the token stops working — whatever the keeper is doing.
    if (token.expires !== null) args.push("--expires-in", `${Math.max(60, Math.floor((token.expires - Date.now()) / 1000))}s`);
    await spawnOpenclawCli(args, { stdinData: `${token.access}\n`, timeoutMs: CLI_TIMEOUT_MS });
  },
  logout: async (profileId) => {
    await spawnOpenclawCli(["models", "auth", "logout", profileId, "--yes"], { timeoutMs: CLI_TIMEOUT_MS });
  },
  order: async (profileIds) => {
    const args = profileIds.length > 0
      ? ["models", "auth", "order", "set", "--provider", PROVIDER, ...profileIds]
      : ["models", "auth", "order", "clear", "--provider", PROVIDER];
    await spawnOpenclawCli(args, { timeoutMs: CLI_TIMEOUT_MS });
  },
  usage: (access) => fetchAnthropicUsage(access),
  // The in-process socket only: a gateway that is not there is skipped this
  // time rather than paid for with a CLI start-up every minute.
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
  /**
   * Every write to the gateway's profiles and order, and every decision made
   * from reading them, one after the other: the swap queue, the keeper, the
   * watcher and the owner's "use these accounts for the chat" are four writers.
   */
  lock: SerialLock;
  /** Failures of core's already acted on, by account and failure time: one failure is one limit. */
  noted: Set<string>;
}

function runtime(): GatewayRuntime {
  return processStore<GatewayRuntime>(`anthropic-gateway:${DATA_DIR}`, () => ({
    deps: defaultDeps,
    registered: false,
    keeper: null,
    watcher: null,
    cronWatermark: null,
    busy: false,
    lock: createSerialLock(),
    noted: new Set(),
  }));
}

const deps = () => runtime().deps;

const KEEPER_MS = 10 * 60_000;
const WATCH_MS = 60_000;
/** How far back the first look at the crons reaches: a failure just before a restart still counts. */
const FIRST_LOOK_BACK_MS = 15 * 60_000;
/** A bound on the failures remembered as acted on. */
const MAX_NOTED = 200;

function outcome(status: SwapConsumerOutcome["status"], code: string, count: number | null = null): SwapConsumerOutcome {
  return { status, code, count };
}

// ── putting the pool in ─────────────────────────────────────────────────────

/**
 * The order core should try the Anthropic profiles in: the active account,
 * the pool's other accounts that can answer in the owner's order, the limited
 * ones by their reset — then every profile that is not the pool's, in the
 * order core has them, the owner's own sign-in among them.
 */
function gatewayOrder(pool: PoolState, held: ReadonlySet<string>, others: readonly string[], now: number): string[] {
  const inGateway = pool.accounts.filter((a) => a.kind === "oauth" && held.has(poolProfileId(a.id)));
  const usable = inGateway.filter((a) => effectiveStatus(a, now) === "ok");
  const active = usable.find((a) => a.id === pool.activeId);
  const limited = inGateway
    .filter((a) => effectiveStatus(a, now) === "limited")
    .sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0));
  return [...(active ? [active] : []), ...usable.filter((a) => a !== active), ...limited].map((a) => poolProfileId(a.id)).concat(others);
}

/** The profiles that are not the pool's: in core's stored order first, then as the store lists them. */
function otherProfiles(store: Extract<GatewayProviderAuthRead, { kind: "present" }> | null): string[] {
  if (!store) return [];
  const ids = store.profiles.map((p) => p.profileId).filter((id) => !isPoolProfile(id));
  const ordered = (store.order ?? []).filter((id) => ids.includes(id));
  return [...ordered, ...ids.filter((id) => !ordered.includes(id))];
}

const sameList = (a: readonly string[] | null, b: readonly string[]) => a !== null && a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Put the pool in the gateway — or take it out — as it stands now. Under the
 * gateway lock. `force`: the owner is putting the chat on the pool, so the
 * chat's model is about to be a Claude one.
 */
async function syncLocked(opts: { force?: boolean } = {}): Promise<SwapConsumerOutcome> {
  const d = deps();
  if (d.absent()) return outcome("skipped", "no_gateway");
  const before = d.read();
  if (before.kind === "unreadable") return outcome("failed", "store_unreadable");
  const ours = before.kind === "present" ? before.profiles.filter((p) => isPoolProfile(p.profileId)) : [];
  const pool = await readPoolState();
  const now = Date.now();
  const wanted = pool.accounts.filter((a) => a.kind === "oauth" && (effectiveStatus(a, now) === "ok" || effectiveStatus(a, now) === "limited"));
  const onClaude = opts.force ? true : await d.chatOnClaude();
  // Unknown is not "off": a config that could not be read must not take the
  // chat's accounts away.
  if (onClaude === null) return outcome("failed", "config_unreadable");
  let changed = 0;
  // What a CLI call answered is not the proof — `paste-token` ends by telling
  // the running gateway, and that can fail over a profile it did write. The
  // store read back afterwards is what decides what landed.
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
      changed += 1;
    } catch (err) {
      console.error(`[anthropic-gateway] core did not confirm ${what}:`, err instanceof Error ? err.message : err);
    }
  };

  if (!onClaude || wanted.length === 0) {
    const why = !onClaude ? "not_subscription" : pool.accounts.some((a) => a.kind === "oauth") ? "no_account" : "not_transferable";
    for (const profile of ours) await attempt(`taking ${profile.profileId} out`, () => d.logout(profile.profileId));
    const left = ours.length > 0 ? d.read() : before;
    if (left.kind === "present" && left.profiles.some((p) => isPoolProfile(p.profileId))) return outcome("failed", "write_failed", changed);
    if (left.kind === "unreadable") return outcome("failed", "write_lost", changed);
    if (pool.gateway) await setGatewayMirror(null);
    return outcome("skipped", why, changed > 0 ? changed : null);
  }

  // Every account's current access token, in where it is not already.
  const tokens = new Map<string, { fingerprint: string; expires: number | null }>();
  for (const account of wanted) {
    const id = poolProfileId(account.id);
    // Null: the pool could not hand one out (a store outage, a renewal that
    // could not be made) — what the gateway holds stays, and is owed.
    const token = await gatewayCredentialFor(account.id);
    if (!token) continue;
    const fingerprint = tokenFingerprint(token.access);
    tokens.set(id, { fingerprint, expires: token.expires });
    if (ours.some((p) => p.profileId === id && p.fingerprint === fingerprint)) continue;
    await attempt(`account ${account.id}'s token`, () => d.paste(id, token));
  }
  // Out: accounts that left the pool or can no longer answer (needs the owner).
  const unwanted = ours.filter((p) => !wanted.some((a) => poolProfileId(a.id) === p.profileId));
  for (const profile of unwanted) await attempt(`taking ${profile.profileId} out`, () => d.logout(profile.profileId));

  // Read back. A profile still holding an older token stays in the order —
  // that token answers until it ends, and an explicit order is core's whole
  // candidate list — and the write is owed.
  const after = d.read();
  if (after.kind !== "present") return outcome("failed", "write_lost", changed);
  const owed: string[] = [];
  const held = new Set<string>();
  for (const account of wanted) {
    const id = poolProfileId(account.id);
    const stored = after.profiles.find((p) => p.profileId === id);
    if (stored) held.add(id);
    if (stored?.fingerprint !== tokens.get(id)?.fingerprint || !tokens.has(id)) owed.push(id);
  }
  for (const profile of unwanted) {
    if (after.profiles.some((p) => p.profileId === profile.profileId)) owed.push(profile.profileId);
  }
  const order = gatewayOrder(pool, held, otherProfiles(after), now);
  if (!sameList(after.order, order)) {
    await attempt("the account order", () => d.order(order));
    const final = d.read();
    if (final.kind !== "present" || !sameList(final.order ?? (order.length === 0 ? [] : null), order)) owed.push("order");
  }

  const lead = pool.accounts.find((a) => order[0] === poolProfileId(a.id)) ?? null;
  const leadToken = lead ? tokens.get(poolProfileId(lead.id)) ?? null : null;
  const leadHeld = lead ? after.profiles.find((p) => p.profileId === poolProfileId(lead.id)) : undefined;
  const fingerprint = leadToken?.fingerprint ?? leadHeld?.fingerprint ?? null;
  if (lead && fingerprint) {
    const mirror = pool.gateway;
    const expiresAt = leadToken?.expires ?? leadHeld?.expires ?? null;
    const pending = owed.length > 0;
    // When the gateway's order started leading with THIS account: kept while
    // it does, so the card's "since" means what it says. Written only when it
    // changed — the keeper passes every ten minutes.
    if (!mirror || mirror.accountId !== lead.id || mirror.fingerprint !== fingerprint || mirror.expiresAt !== expiresAt || mirror.pending !== pending) {
      const at = mirror && mirror.accountId === lead.id ? mirror.at : now;
      await setGatewayMirror({ accountId: lead.id, fingerprint, expiresAt, at, pending });
    }
  } else if (pool.gateway) {
    await setGatewayMirror(null);
  }
  if (changed > 0) console.error(`[anthropic-gateway] the gateway holds ${held.size} Claude account(s) of the pool, ${lead ? `${lead.id} first` : "none first"}${owed.length > 0 ? `; ${owed.length} owed` : ""}`);
  if (owed.length > 0) return outcome("failed", "write_failed", held.size);
  const active = pool.accounts.find((a) => a.id === pool.activeId);
  if (active && active.kind !== "oauth") return outcome("skipped", "not_transferable", held.size);
  return outcome("ok", changed > 0 ? "switched" : "already", held.size);
}

/** The consumer src/lib/anthropic-swap.ts fans a move out to: the order follows the pool. */
export async function applyGatewaySwap(ctx: SwapContext): Promise<SwapConsumerOutcome> {
  if (deps().absent()) return outcome("skipped", "no_gateway");
  return runtime().lock(async () => {
    // Waited behind another writer: a target that is no longer the active
    // account is history; the newer move is queued behind this one.
    if (ctx.change.toId !== null && (await readPoolState()).activeId !== ctx.change.toId) return outcome("skipped", "superseded");
    return syncLocked();
  });
}

/** Bring the gateway in line with the pool now — after the owner changed it. Never throws. */
export async function syncGatewayNow(): Promise<SwapConsumerOutcome> {
  try {
    return await runtime().lock(() => syncLocked());
  } catch (err) {
    console.error("[anthropic-gateway] could not bring the gateway in line with the pool:", err instanceof Error ? err.message : err);
    return outcome("failed", "error");
  }
}

export type UseForChatResult =
  | { ok: true; outcome: SwapConsumerOutcome }
  | { ok: false; code: "no_gateway" | "no_claude_account" | "gateway_write_failed" | "model_not_set"; error: string; status: number };

/**
 * The accounts card's "Use these accounts for the chat too": the pool's Claude
 * accounts into the gateway, then the chat's model onto Claude through
 * `setModel` — Settings → AI Models' own path, the caller's to pass. One
 * gesture of the owner's, under the gateway lock so no keeper pass in between
 * takes the accounts out again for a chat that is not on Claude yet.
 */
export async function useAccountsForChat(setModel: () => Promise<{ ok: true } | { ok: false; error: string; status: number }>): Promise<UseForChatResult> {
  if (deps().absent()) return { ok: false, code: "no_gateway", error: "This ClawBox's chat does not run on OpenClaw.", status: 409 };
  return runtime().lock(async () => {
    const pool = await readPoolState();
    const now = Date.now();
    if (!pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) !== "expired" && effectiveStatus(a, now) !== "revoked")) {
      return { ok: false, code: "no_claude_account", error: "No Claude account on this box can answer: the chat can only use a Claude account signed in here.", status: 409 } as const;
    }
    const synced = await syncLocked({ force: true });
    if (synced.status !== "ok" && synced.code !== "not_transferable") {
      return { ok: false, code: "gateway_write_failed", error: "The Claude accounts could not be given to the chat. See the box's log.", status: 502 } as const;
    }
    const set = await setModel();
    if (!set.ok) return { ok: false, code: "model_not_set", error: set.error, status: set.status } as const;
    console.error("[anthropic-gateway] the owner put the chat on the box's Claude accounts");
    return { ok: true, outcome: synced } as const;
  });
}

// ── what core saw ───────────────────────────────────────────────────────────

/** Core's failure state for a pool profile, as the pool reads it: a limit, a refused credential, or nothing worth acting on. */
function coreFailureOf(failure: ProfileFailureState, now: number): { kind: "limit"; limitKind: AnthropicLimitKind; until: number; at: number } | { kind: "auth"; at: number } | null {
  const active = (until: number | null): until is number => until !== null && until > now;
  if (active(failure.blockedUntil)) return { kind: "limit", limitKind: "session", until: failure.blockedUntil, at: failure.lastFailureAt ?? failure.blockedUntil };
  if (active(failure.disabledUntil)) {
    if (failure.disabledReason === "billing") return { kind: "limit", limitKind: "credit", until: failure.disabledUntil, at: failure.lastFailureAt ?? failure.disabledUntil };
    if (failure.disabledReason === "auth_permanent") return { kind: "auth", at: failure.lastFailureAt ?? failure.disabledUntil };
  }
  if (active(failure.cooldownUntil)) {
    if (failure.cooldownReason === "rate_limit") return { kind: "limit", limitKind: "rate", until: failure.cooldownUntil, at: failure.lastFailureAt ?? failure.cooldownUntil };
    if (failure.cooldownReason === "auth") return { kind: "auth", at: failure.lastFailureAt ?? failure.cooldownUntil };
  }
  return null;
}

/**
 * Record in the pool what core recorded against the pool's profiles since the
 * last look: a limit until Anthropic's own reset (which moves the active
 * account, and with it every consumer), a refused credential confirmed with
 * the pool's own check. Answers how many it acted on. Under the gateway lock.
 */
async function noteCooldownsLocked(now: number): Promise<number> {
  const d = deps();
  if (d.absent()) return 0;
  const store = d.read();
  if (store.kind !== "present") return 0;
  const state = runtime();
  const pool = await readPoolState();
  let acted = 0;
  for (const account of pool.accounts) {
    if (account.kind !== "oauth") continue;
    const failure = store.failures[poolProfileId(account.id)];
    const seen = failure ? coreFailureOf(failure, now) : null;
    if (!seen) continue;
    const key = `${account.id}:${seen.at}`;
    if (state.noted.has(key)) continue;
    state.noted.add(key);
    if (state.noted.size > MAX_NOTED) state.noted.delete(state.noted.values().next().value as string);
    try {
      if (seen.kind === "auth") {
        // Renewed when the grant is alive — the next sync puts the fresh
        // token in — and out of the pool when Anthropic refuses the grant.
        const verdict = await probeAccountCredential(account.id, verifyAnthropicKey, { source: "chat" });
        console.error(`[anthropic-gateway] core saw account ${account.id}'s credential refused in a gateway turn; asked again, it is ${verdict}`);
        acted += 1;
      } else {
        acted += await recordLimit(account, seen, now);
      }
    } catch (err) {
      // Not acted on — the pool could not be written: the next look tries
      // again rather than calling this failure handled.
      state.noted.delete(key);
      console.error(`[anthropic-gateway] could not record what the gateway saw on account ${account.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return acted;
}

/** One limit core saw, in the pool until Anthropic's reset — or nothing, for a window that is not spent. */
async function recordLimit(account: AnthropicAccount, seen: { limitKind: AnthropicLimitKind; until: number }, now: number): Promise<number> {
  if (effectiveStatus(account, now) === "limited" && (account.limitedUntil ?? 0) >= seen.until) return 0;
  let until = seen.until;
  let kind = seen.limitKind;
  if (kind === "rate") {
    const token = await gatewayCredentialFor(account.id);
    const reading = token ? await deps().usage(token.access) : null;
    if (reading && !reading.exhausted) {
      // Anthropic says no window is spent: a throttle core's own cooldown
      // already covers. Set aside for hours, the account would be lost for nothing.
      console.error(`[anthropic-gateway] core cooled account ${account.id} down on a rate limit, but none of its usage windows is spent; left in`);
      return 0;
    }
    if (reading?.exhausted) {
      kind = reading.kind;
      until = reading.resetsAt !== null && reading.resetsAt > now ? reading.resetsAt : now + DEFAULT_LIMIT_MS;
    } else {
      // Anthropic could not be asked: core's own window, never longer than
      // the longest session window — core's backoff grows past a day.
      until = Math.min(seen.until, now + DEFAULT_LIMIT_MS);
    }
  }
  await markLimited(account.id, until, kind, { source: "chat" });
  console.error(`[anthropic-gateway] core rotated off account ${account.id} on a ${kind} limit; set aside until ${new Date(until).toISOString()}`);
  return 1;
}

/** Look at what core recorded, act on it, and bring the gateway's order in line if anything changed. */
export function noteGatewayCooldowns(now: number = Date.now()): Promise<number> {
  return runtime().lock(async () => {
    const acted = await noteCooldownsLocked(now);
    if (acted > 0) await syncLocked();
    return acted;
  });
}

// ── the keeper ──────────────────────────────────────────────────────────────

export type KeeperResult = "idle" | "fresh" | "synced" | "failed";

/**
 * One keeper pass, under the gateway lock: what core saw, then the pool put
 * in as it stands — a renewed token where the pool renewed one (well before
 * the old one ends; no restart), an account in or out, the order. Exported
 * for the tests; the timer calls it every ten minutes.
 */
export function keepGatewayMirror(): Promise<KeeperResult> {
  return runtime().lock(async (): Promise<KeeperResult> => {
    if (deps().absent()) return "idle";
    await noteCooldownsLocked(Date.now());
    const result = await syncLocked();
    if (result.status === "failed") return "failed";
    if (result.code === "switched") return "synced";
    if (result.status === "ok") return "fresh";
    return result.count ? "synced" : "idle";
  });
}

// ── the failures ────────────────────────────────────────────────────────────

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

/**
 * A gateway turn that reached its sender as a failure has already been through
 * core's rotation: every account it could try is in core's failure state,
 * which is the evidence of WHICH accounts failed (noteGatewayCooldowns). The
 * report itself blames no pool account — on the box a session could be pinned
 * to an account other than the one the order leads with, and a turn rescued by
 * another provider never reaches anyone at all — it holds the turn for one
 * retry and makes sure the gateway is on the active account.
 */

/** One look at the gateway's crons. Answers how many failures it reported. */
export async function scanGatewayCrons(now: number = Date.now()): Promise<number> {
  const d = deps();
  const state = runtime();
  if (d.absent()) return 0;
  const pool = await readPoolState();
  const store = d.read();
  if (pool.accounts.length === 0 || store.kind !== "present" || store.profiles.length === 0) return 0;
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
    const result = await reportAnthropicFailure({
      text: job.lastError,
      source: "cron",
      accountId: null,
      retry: {
        // Per account the pool is on once core's record is in (the watcher
        // reads it first): a run that fails again on the account it was moved
        // to is a new failure, and earns one retry of its own on the next.
        key: `cron:${job.id}:${pool.activeId ?? "none"}`,
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
  const anthropic = provider === PROVIDER || (model !== null && /^(?:anthropic\/)?claude/.test(model))
    || (provider === null && mentionsAnthropic(`${detail ?? ""} ${errorMessage ?? ""}`));
  if (!anthropic) return null;
  // What core recorded for this very turn, into the pool first: the move it
  // causes is the swap the retry below waits for.
  await noteGatewayCooldowns().catch((err: unknown) => {
    console.error("[anthropic-gateway] could not read what the gateway recorded:", err instanceof Error ? err.message : err);
  });
  const sessionKey = text(input.sessionKey, 300);
  const message = text(input.message, 32_000);
  const d = deps();
  // Per account the pool is on now, as for a cron run: one retry per account.
  const on = (await readPoolState()).activeId ?? "none";
  return reportAnthropicFailure({
    // The provider's own words first: the gateway's copy says "rate limit"
    // without the time the account comes back.
    text: [detail, errorMessage].filter(Boolean).join("\n") || null,
    reason: text(input.reason, 40),
    source: "chat",
    accountId: null,
    retry: sessionKey && message ? {
      key: `chat:${sessionKey}:${tokenFingerprint(message)}:${on}`,
      after: "gateway",
      run: async () => {
        try {
          // Stable for the turn it repeats: the gateway can tell a second
          // delivery of the same retry from a new one.
          await d.call("chat.send", { sessionKey, message, deliver: false, idempotencyKey: `clawbox-swap-${tokenFingerprint(`${sessionKey}:${message}:${on}`)}` });
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
 * consumer and start the keeper and the watcher, once per process.
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
    state.watcher = setInterval(() => void guarded(async () => {
      await noteGatewayCooldowns();
      await scanGatewayCrons();
    }), WATCH_MS);
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

/** Test seam: stand in for the gateway, and forget the timers, the watermark and what was noted. */
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
  state.lock = createSerialLock();
  state.noted.clear();
}
