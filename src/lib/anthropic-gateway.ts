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
 * card (`putChatOnPool`, which sets the model through Settings → AI
 * Models' own path); a chat on another provider is never switched by itself,
 * and when the owner moves it off Claude the pool's profiles are taken out.
 *
 * WHAT IT CANNOT CARRY. An API key or the Terminal's `claude` sign-in is not a
 * Claude account this box holds the grant of; with one of those active the
 * chat stays on the pool's Claude accounts (`not_transferable`).
 */

import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { gatewayIsAbsent, openclawIsAbsent, readConfigStrict, runOpenclawConfigUnset, spawnOpenclawCli } from "@/lib/openclaw-config";
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
  /**
   * openclaw.json, as far as this module reads it: is the chat's primary model
   * an Anthropic one, and is there a CONFIG `auth.order.anthropic`. Null when
   * the file could not be read.
   */
  chat: () => Promise<ChatConfig | null>;
  /** What core's store holds for Anthropic: the profiles, the stored order, the failures. */
  read: () => GatewayProviderAuthRead;
  /** Core's writer: one `token` profile, the access token on stdin. `agent`: the `--agent` arguments (ChatConfig). */
  paste: (profileId: string, token: { access: string; expires: number | null }, agent: readonly string[]) => Promise<void>;
  /** Core's removal of one profile, its order and config entries. */
  logout: (profileId: string, agent: readonly string[]) => Promise<void>;
  /** Core's stored order for Anthropic; an empty list clears it. */
  order: (profileIds: readonly string[], agent: readonly string[]) => Promise<void>;
  /** Drop openclaw.json's `auth.order.anthropic` — only ever one the pool's own pastes created. */
  unsetConfigOrder: () => Promise<void>;
  /** Anthropic's usage windows for one account. Null: could not be asked. */
  usage: (access: string) => Promise<AnthropicUsageReading | null>;
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** A Jetson CLI cold start is 5-14 s; a busy one is given room. */
const CLI_TIMEOUT_MS = 60_000;

/** openclaw.json, as far as this module reads it. */
export interface ChatConfig {
  /** The chat's primary model is an Anthropic one. */
  onAnthropic: boolean;
  /** There is a CONFIG `auth.order.anthropic`. */
  configOrder: boolean;
  /**
   * The `--agent` arguments every `models auth` verb needs to write the store
   * this module reads — the `main` agent's — or null when the CLI's agent is
   * not `main` (a roster without it), which this module does not write.
   */
  agent: string[] | null;
}

/**
 * The agent roster as core reads it (`readAgentRosterProperty`): the keys of
 * `agents.entries` when that is set, else the ids of `agents.list`; none at
 * all is core's implicit `main`. A mutation with several agents and no
 * `--agent` is refused (`resolveSoleAgentId`), and a sole agent other than
 * `main` is written to ITS store while this module reads `main`'s.
 */
function agentArgsOf(agents: unknown): string[] | null {
  const a = agents && typeof agents === "object" ? (agents as Record<string, unknown>) : {};
  const entries = a.entries;
  const ids = entries && typeof entries === "object" && !Array.isArray(entries)
    ? Object.keys(entries)
    : Array.isArray(a.list)
      ? a.list.flatMap((entry) => (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? [(entry as { id: string }).id] : []))
      : [];
  if (ids.length === 0) return [];
  if (!ids.includes("main")) return null;
  return ids.length > 1 ? ["--agent", "main"] : [];
}

async function modelsAuth(args: string[], agent: readonly string[], stdinData?: string): Promise<void> {
  await spawnOpenclawCli(["models", "auth", ...args, ...agent], {
    timeoutMs: CLI_TIMEOUT_MS,
    ...(stdinData !== undefined ? { stdinData } : {}),
  });
}

const defaultDeps: GatewayDeps = {
  absent: () => openclawIsAbsent() || gatewayIsAbsent(),
  chat: async () => {
    try {
      const config = await readConfigStrict();
      const primary = config.agents?.defaults?.model?.primary;
      const order = (config.auth as { order?: Record<string, unknown> } | undefined)?.order;
      return {
        onAnthropic: typeof primary === "string" && primary.trim().toLowerCase().startsWith(`${PROVIDER}/`),
        configOrder: !!order && typeof order === "object" && Object.hasOwn(order, PROVIDER),
        agent: agentArgsOf(config.agents),
      };
    } catch {
      return null;
    }
  },
  read: () => readGatewayProviderAuth(PROVIDER),
  paste: async (profileId, token, agent) => {
    const args = ["paste-token", "--provider", PROVIDER, "--profile-id", profileId];
    // Core stores the end itself, so it stops offering the profile at the
    // moment the token stops working — whatever the keeper is doing.
    if (token.expires !== null) args.push("--expires-in", `${Math.max(60, Math.floor((token.expires - Date.now()) / 1000))}s`);
    await modelsAuth(args, agent, `${token.access}\n`);
  },
  logout: (profileId, agent) => modelsAuth(["logout", profileId, "--yes"], agent),
  order: (profileIds, agent) => modelsAuth(profileIds.length > 0 ? ["order", "set", "--provider", PROVIDER, ...profileIds] : ["order", "clear", "--provider", PROVIDER], agent),
  unsetConfigOrder: () => runOpenclawConfigUnset(`auth.order.${PROVIDER}`),
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
  /**
   * Per pool profile, the newest `lastFailureAt` of core's already acted on:
   * one failure is one limit. Core keeps that time — and the failure's reason,
   * until a success — after its own cooldown has run out, so a failure is seen
   * whenever the next look comes, not only inside core's 30-second window.
   */
  failureSeen: Map<string, number>;
  /** Keeper passes in a row that owed a write, and when the last one did: a box that keeps refusing is not asked every ten minutes for ever. */
  keeperFailures: number;
  keeperFailedAt: number;
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
    failureSeen: new Map(),
    keeperFailures: 0,
    keeperFailedAt: 0,
  }));
}

const deps = () => runtime().deps;

const KEEPER_MS = 10 * 60_000;
const WATCH_MS = 60_000;
/** How far back the first look at the crons reaches: a failure just before a restart still counts. */
const FIRST_LOOK_BACK_MS = 15 * 60_000;
/**
 * The longest the keeper waits between passes whose writes keep failing: under
 * the pool's three-hour renewal margin (OAUTH_REFRESH_MARGIN_MS), so a pass
 * still comes before a held token ends.
 */
const MAX_KEEPER_BACKOFF_MS = 2 * 60 * 60_000;
/**
 * With Anthropic's usage unreadable, the shortest core cooldown — measured
 * from core's newest failure to the window's end — the pool takes for a cap.
 * Core's rate-limit back-off doubles from 30 s (30 s, 1, 2, 4, 8 min …), so a
 * capped account crosses this within a few failures, while a throttle stays
 * core's alone: setting an account aside moves every consumer, and ends a live
 * coding run on it. A failure inside a running window (core probing a cooling
 * profile, a turn on another model) keeps the window and only shortens the
 * measure, so any error leans towards leaving the account to core, and only
 * within a window's last five minutes.
 */
const UNREAD_LIMIT_MIN_MS = 5 * 60_000;
/** Which of the Anthropic orders the pool wrote, so taking the pool out undoes exactly those (config store). */
const ORDER_MARKER_KEY = "anthropic_gateway_order";

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

interface OrderMarker {
  /** The pool wrote core's stored order. */
  stored: boolean;
  /** The pool's pastes created openclaw.json's `auth.order.anthropic` (there was none before). */
  config: boolean;
}

async function readOrderMarker(): Promise<OrderMarker> {
  const raw = await configGet(ORDER_MARKER_KEY).catch(() => null);
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { stored: v.stored === true, config: v.config === true };
}

/** Never throws: a marker that could not be written is said, and never fails a move that landed. */
async function writeOrderMarker(next: OrderMarker): Promise<void> {
  try {
    const before = await readOrderMarker();
    if (before.stored === next.stored && before.config === next.config) return;
    await configSet(ORDER_MARKER_KEY, next.stored || next.config ? { ...next } : undefined);
  } catch (err) {
    console.error("[anthropic-gateway] could not record which account orders the pool wrote:", err instanceof Error ? err.message : err);
  }
}

/**
 * Put the pool in the gateway — or take it out — as it stands now. Under the
 * gateway lock. `force`: the owner is putting the chat on the pool, so the
 * chat's model is about to be an Anthropic one.
 *
 * The answer is about the gateway and the ACTIVE account: `ok` once the order
 * leads with it and its profile holds its current token. Anything else still
 * owed — another account's renewal, a removal — is logged and left to the
 * keeper, and costs no held retry and no "could not be switched".
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
  const chat = await d.chat();
  // Unknown is not "off": a config that could not be read must not take the
  // chat's accounts away.
  if (chat === null) return outcome("failed", "config_unreadable");
  if (chat.agent === null) {
    console.error("[anthropic-gateway] the gateway's agent roster has no `main` agent; the pool's accounts are not written to another agent's store");
    // Whatever the pool put in `main`'s store, the chat does not read it now.
    if (pool.gateway) await setGatewayMirror(null);
    return outcome("skipped", "agent_unsupported");
  }
  const agent = chat.agent;
  let changed = 0;
  // What a CLI call answered is not the proof — `paste-token` ends by telling
  // the running gateway, and that can fail over a profile it did write. The
  // store read back afterwards is what decides what landed.
  const attempt = async (what: string, work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      changed += 1;
      return true;
    } catch (err) {
      console.error(`[anthropic-gateway] core did not confirm ${what}:`, err instanceof Error ? err.message : err);
      return false;
    }
  };

  if (!(opts.force || chat.onAnthropic) || wanted.length === 0) {
    const why = !(opts.force || chat.onAnthropic) ? "not_subscription" : pool.accounts.some((a) => a.kind === "oauth") ? "no_account" : "not_transferable";
    return takeOut(d, ours, pool, why, agent, attempt, () => changed);
  }

  // Every account's current access token, in where it is not already.
  const tokens = new Map<string, { fingerprint: string; expires: number | null }>();
  let pasted = 0;
  for (const account of wanted) {
    const id = poolProfileId(account.id);
    // Null: the pool could not hand one out (a store outage, a renewal that
    // could not be made) — what the gateway holds stays, and is owed.
    const token = await gatewayCredentialFor(account.id);
    if (!token) continue;
    const fingerprint = tokenFingerprint(token.access);
    tokens.set(id, { fingerprint, expires: token.expires });
    if (ours.some((p) => p.profileId === id && p.fingerprint === fingerprint)) continue;
    if (await attempt(`account ${account.id}'s token`, () => d.paste(id, token, agent))) pasted += 1;
  }
  // What the pool wrote, recorded the moment it is seen, so taking the pool
  // out later undoes exactly that: a CONFIG order core's paste created beside
  // a sign-in of another mode (there was none before).
  const marker = await readOrderMarker();
  if (!marker.config && !chat.configOrder && pasted > 0 && (await d.chat())?.configOrder === true) {
    marker.config = true;
    await writeOrderMarker(marker);
  }
  // Out: accounts that left the pool or can no longer answer (needs the owner).
  const unwanted = ours.filter((p) => !wanted.some((a) => poolProfileId(a.id) === p.profileId));
  for (const profile of unwanted) await attempt(`taking ${profile.profileId} out`, () => d.logout(profile.profileId, agent));

  // Read back. A profile still holding an older token stays in the order —
  // that token answers until it ends, and an explicit order is core's whole
  // candidate list — and its write is owed.
  const after = d.read();
  if (after.kind !== "present") return outcome("failed", "write_lost", changed);
  const owed: string[] = [];
  const held = new Set<string>();
  for (const account of wanted) {
    const id = poolProfileId(account.id);
    const stored = after.profiles.find((p) => p.profileId === id);
    if (stored) held.add(id);
    if (!tokens.has(id) || stored?.fingerprint !== tokens.get(id)?.fingerprint) owed.push(id);
  }
  for (const profile of unwanted) {
    if (after.profiles.some((p) => p.profileId === profile.profileId)) owed.push(profile.profileId);
  }
  const order = gatewayOrder(pool, held, otherProfiles(after), now);
  let final = after;
  // Core said it wrote the order: whatever the read-back shows, taking the
  // pool out later clears it (an order that is not there clears without fuss).
  let orderWritten = false;
  if (!sameList(after.order, order)) {
    if (await attempt("the account order", () => d.order(order, agent))) orderWritten = true;
    const reread = d.read();
    if (reread.kind !== "present") return outcome("failed", "write_lost", changed);
    final = reread;
  }
  const orderLanded = sameList(final.order ?? (order.length === 0 ? [] : null), order);
  if (!orderLanded) owed.push("order");

  if ((orderLanded || orderWritten) && !marker.stored) await writeOrderMarker({ ...marker, stored: true });

  // The account the gateway must lead with: the active one, when the gateway
  // can hold it; else the first it holds (an API key or the Terminal sign-in
  // is active, or none can answer).
  const active = pool.accounts.find((a) => a.id === pool.activeId) ?? null;
  const target = active && wanted.includes(active) && effectiveStatus(active, now) === "ok"
    ? active
    : pool.accounts.find((a) => order[0] === poolProfileId(a.id)) ?? null;
  const targetId = target ? poolProfileId(target.id) : null;
  const targetHeld = targetId ? final.profiles.find((p) => p.profileId === targetId) : undefined;
  const targetToken = targetId ? tokens.get(targetId) : undefined;
  const leadOk = !!targetHeld && final.order?.[0] === targetId && (!targetToken || targetHeld.fingerprint === targetToken.fingerprint);
  // The mirror names the pool account core's stored order actually leads
  // with — the target once its write and the order have landed — `pending`
  // until they have. Null only when the gateway holds none of the pool's
  // accounts at all.
  const leadingId = (final.order ?? []).find((id) => held.has(id)) ?? (targetHeld ? targetId : null) ?? [...held][0] ?? null;
  const leading = leadingId ? pool.accounts.find((a) => poolProfileId(a.id) === leadingId) ?? null : null;
  const leadingHeld = leadingId ? final.profiles.find((p) => p.profileId === leadingId) : undefined;
  if (leading && leadingHeld?.fingerprint) {
    const mirror = pool.gateway;
    const fingerprint = leadingHeld.fingerprint;
    const expiresAt = (leadingId === targetId ? targetToken?.expires : tokens.get(leadingId ?? "")?.expires) ?? leadingHeld.expires;
    const pending = !leadOk;
    // When the gateway's order started leading with THIS account: kept while
    // it does, so the card's "since" means what it says. Written only when it
    // changed — the keeper passes every ten minutes.
    if (!mirror || mirror.accountId !== leading.id || mirror.fingerprint !== fingerprint || mirror.expiresAt !== expiresAt || mirror.pending !== pending) {
      await setGatewayMirror({ accountId: leading.id, fingerprint, expiresAt, at: mirror && mirror.accountId === leading.id ? mirror.at : now, pending });
    }
  } else if (pool.gateway) {
    await setGatewayMirror(null);
  }
  if (changed > 0 || owed.length > 0) {
    console.error(`[anthropic-gateway] the gateway holds ${held.size} Anthropic account(s) of the pool, ${target ? `${target.id} first` : "none first"}${owed.length > 0 ? `; still owed: ${owed.join(", ")}` : ""}`);
  }
  if (!leadOk) return outcome("failed", "write_failed", held.size);
  if (active && active.kind !== "oauth") return outcome("skipped", "not_transferable", held.size);
  // `pending` is the keeper's to finish without failing the move it serves.
  if (owed.length > 0) return outcome("ok", "switched_partly", held.size);
  return outcome("ok", changed > 0 ? "switched" : "already", held.size);
}

/**
 * The pool OUT of the gateway: the chat left Anthropic, or no account of the
 * pool can be held. Its profiles go, and so do the orders the pool wrote — a
 * stored order left naming only the owner's own sign-in, or openclaw.json's
 * order its pastes created, is a one-entry candidate list that would hide
 * every Anthropic credential added after it (the trap the configure route
 * clears for OpenAI).
 */
async function takeOut(
  d: GatewayDeps,
  ours: readonly { profileId: string }[],
  pool: PoolState,
  why: string,
  agent: readonly string[],
  attempt: (what: string, work: () => Promise<void>) => Promise<boolean>,
  changed: () => number,
): Promise<SwapConsumerOutcome> {
  const marker = await readOrderMarker();
  if (ours.length === 0 && !marker.stored && !marker.config) {
    if (pool.gateway) await setGatewayMirror(null);
    return outcome("skipped", why);
  }
  for (const profile of ours) await attempt(`taking ${profile.profileId} out`, () => d.logout(profile.profileId, agent));
  if (marker.stored) {
    const now = d.read();
    if (now.kind === "present" && now.order !== null) await attempt("clearing the account order", () => d.order([], agent));
  }
  if (marker.config) await attempt("openclaw.json's account order", () => d.unsetConfigOrder());
  const left = d.read();
  if (left.kind === "unreadable") return outcome("failed", "write_lost", changed());
  const owed = left.kind === "present" ? left.profiles.filter((p) => isPoolProfile(p.profileId)).map((p) => p.profileId) : [];
  const storedLeft = marker.stored && left.kind === "present" && left.order !== null;
  const configLeft = marker.config && (await d.chat())?.configOrder !== false;
  await writeOrderMarker({ stored: storedLeft, config: configLeft });
  if (owed.length > 0) return outcome("failed", "write_failed", changed());
  // The accounts are out: the chat no longer runs on them, whatever is left
  // of the orders, which the marker keeps for the keeper to finish.
  if (pool.gateway) await setGatewayMirror(null);
  if (storedLeft || configLeft) {
    console.error("[anthropic-gateway] the pool's accounts are out of the gateway; the account order it wrote is still owed");
    return outcome("skipped", "order_owed", changed() > 0 ? changed() : null);
  }
  if (changed() > 0) console.error(`[anthropic-gateway] the pool's accounts are out of the gateway (${why})`);
  return outcome("skipped", why, changed() > 0 ? changed() : null);
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
  | { ok: false; code: "no_gateway" | "no_claude_account" | "agent_unsupported" | "gateway_write_failed" | "model_not_set"; error: string; status: number };

/**
 * The accounts card's "Use these accounts for the chat too": the pool's Claude
 * accounts into the gateway, then the chat's model onto Claude through
 * `setModel` — Settings → AI Models' own path, the caller's to pass. One
 * gesture of the owner's, under the gateway lock so no keeper pass in between
 * takes the accounts out again for a chat that is not on Claude yet.
 */
export async function putChatOnPool(setModel: () => Promise<{ ok: true } | { ok: false; error: string; status: number }>): Promise<UseForChatResult> {
  if (deps().absent()) return { ok: false, code: "no_gateway", error: "This ClawBox's chat does not run on OpenClaw.", status: 409 };
  return runtime().lock(async () => {
    const pool = await readPoolState();
    const now = Date.now();
    if (!pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) !== "expired" && effectiveStatus(a, now) !== "revoked")) {
      return { ok: false, code: "no_claude_account", error: "No Anthropic subscription account on this box can answer: the chat can only use one signed in here.", status: 409 } as const;
    }
    const synced = await syncLocked({ force: true });
    if (synced.code === "agent_unsupported") {
      return { ok: false, code: "agent_unsupported", error: "This box's assistant runs as an agent other than main, which the accounts cannot be given to from here.", status: 409 } as const;
    }
    if (synced.status !== "ok" && synced.code !== "not_transferable") {
      return { ok: false, code: "gateway_write_failed", error: "The Anthropic accounts could not be given to the chat. See the box's log.", status: 502 } as const;
    }
    const set = await setModel();
    if (!set.ok) {
      // The chat did not move: take the accounts out again rather than leave
      // the card saying the chat runs on them, with nothing to press.
      await syncLocked();
      return { ok: false, code: "model_not_set", error: set.error, status: set.status } as const;
    }
    console.error("[anthropic-gateway] the owner put the chat on the box's Claude accounts");
    return { ok: true, outcome: synced } as const;
  });
}

// ── what core saw ───────────────────────────────────────────────────────────

/**
 * Core's failure state for a pool profile, as the pool reads it: a limit, a
 * refused credential, or nothing worth acting on. Read from the REASONS core
 * keeps until the profile's next success, not only while a window runs — the
 * first rate limit after a success cools a profile for 30 seconds, and a look
 * that came later must still see it. A window still running says what core is
 * doing about the profile now; with every window over, `cooldownReason` —
 * which core rewrites on every failure that is not a disable — names the
 * newest failure, ahead of a disable or a block left over from an earlier one.
 */
function coreFailureOf(failure: ProfileFailureState, now: number): { kind: "limit"; limitKind: AnthropicLimitKind; until: number } | { kind: "auth" } | null {
  const running = (until: number | null): until is number => until !== null && until > now;
  const disabled = (until: number) => (failure.disabledReason === "billing"
    ? { kind: "limit" as const, limitKind: "credit" as const, until }
    : failure.disabledReason === "auth_permanent" ? { kind: "auth" as const } : null);
  const cooled = (until: number) => (failure.cooldownReason === "rate_limit"
    ? { kind: "limit" as const, limitKind: "rate" as const, until }
    : failure.cooldownReason === "auth" ? { kind: "auth" as const } : null);
  if (running(failure.blockedUntil)) return { kind: "limit", limitKind: "session", until: failure.blockedUntil };
  if (running(failure.disabledUntil)) {
    const seen = disabled(failure.disabledUntil);
    if (seen) return seen;
  }
  if (running(failure.cooldownUntil)) {
    const seen = cooled(failure.cooldownUntil);
    if (seen) return seen;
  }
  if (failure.cooldownUntil !== null) {
    const seen = cooled(failure.cooldownUntil);
    if (seen) return seen;
  }
  if (failure.disabledUntil !== null) {
    const seen = disabled(failure.disabledUntil);
    if (seen) return seen;
  }
  return failure.blockedUntil !== null ? { kind: "limit", limitKind: "session", until: failure.blockedUntil } : null;
}

/**
 * Record in the pool what core recorded against the pool's profiles since the
 * last look: a limit until Anthropic's own reset (which moves the active
 * account, and with it every consumer), a refused credential confirmed with
 * the pool's own check. A failure is new when its `lastFailureAt` is past the
 * last one acted on; the first look at a profile reaches back only
 * FIRST_LOOK_BACK_MS. Answers how many it acted on. Under the gateway lock.
 */
async function noteCooldownsLocked(now: number): Promise<number> {
  const d = deps();
  if (d.absent()) return 0;
  const store = d.read();
  if (store.kind !== "present") return 0;
  const seenBy = runtime().failureSeen;
  const pool = await readPoolState();
  let acted = 0;
  for (const account of pool.accounts) {
    if (account.kind !== "oauth") continue;
    const profileId = poolProfileId(account.id);
    const failure = store.failures[profileId];
    const at = failure?.lastFailureAt ?? null;
    if (!failure || at === null || at <= (seenBy.get(profileId) ?? now - FIRST_LOOK_BACK_MS)) continue;
    const seen = coreFailureOf(failure, now);
    if (!seen) continue;
    try {
      if (seen.kind === "auth") {
        // Renewed when the grant is alive — the next sync puts the fresh
        // token in — and out of the pool when Anthropic refuses the grant.
        const verdict = await probeAccountCredential(account.id, verifyAnthropicKey, { source: "chat" });
        console.error(`[anthropic-gateway] core saw account ${account.id}'s credential refused in a gateway turn; asked again, it is ${verdict}`);
        acted += 1;
      } else {
        acted += await recordLimit(account, seen, at, now);
      }
      seenBy.set(profileId, at);
    } catch (err) {
      // Not acted on — the pool could not be written: the next look tries
      // again rather than calling this failure handled.
      console.error(`[anthropic-gateway] could not record what the gateway saw on account ${account.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return acted;
}

/** One limit core saw, in the pool until Anthropic's reset — or nothing, for a window that is not spent. */
async function recordLimit(account: AnthropicAccount, seen: { limitKind: AnthropicLimitKind; until: number }, failedAt: number, now: number): Promise<number> {
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
      // Anthropic could not be asked: a short window is a throttle core's own
      // cooldown and rotation cover; a long one is core's own window, never
      // longer than the longest session window — core's backoff grows past a
      // day. Measured from core's newest failure, not from this look, so a
      // window first seen late is still judged by its length.
      if (seen.until > now && seen.until - failedAt < UNREAD_LIMIT_MIN_MS) {
        console.error(`[anthropic-gateway] core cooled account ${account.id} down for under five minutes on a rate limit and its usage could not be read; left to core`);
        return 0;
      }
      until = Math.min(seen.until, now + DEFAULT_LIMIT_MS);
    }
  }
  // A window that is already over (and nothing better known) is nothing to set aside.
  if (until <= now) return 0;
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
    const now = Date.now();
    await noteCooldownsLocked(now);
    // A box whose writes keep failing (a CLI that cannot run, a store that
    // stays locked) is asked again on a widening interval — 20 minutes, 40,
    // … up to two hours — not every ten minutes for ever. A move of the
    // pool's still goes through at once (applyGatewaySwap), and one account
    // still owed beside a gateway that is fine costs no back-off.
    const state = runtime();
    if (state.keeperFailures >= 2 && now - state.keeperFailedAt < Math.min(KEEPER_MS * 2 ** (state.keeperFailures - 1), MAX_KEEPER_BACKOFF_MS)) return "failed";
    const result = await syncLocked();
    const failing = result.status === "failed" || result.code === "order_owed";
    state.keeperFailures = failing ? state.keeperFailures + 1 : 0;
    state.keeperFailedAt = failing ? now : 0;
    if (result.status === "failed") return "failed";
    if (result.code === "switched" || result.code === "switched_partly") return "synced";
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

/** Test seam: stand in for the gateway, and forget the timers, the watermarks and the keeper's back-off. */
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
  state.failureSeen.clear();
  state.keeperFailures = 0;
  state.keeperFailedAt = 0;
}
