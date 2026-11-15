/**
 * The OpenClaw gateway as a consumer of the box's Anthropic account pool
 * (TASK-1260; the gateway leg proven on the box 2026-10-14).
 *
 * WHAT IT DOES. While the chat runs on a Claude model, EVERY Claude account of
 * the pool is in the gateway as an auth profile of its own, and core does the
 * rest — the same in every turn it runs: the desktop chat, Telegram and the
 * other channels, cron runs and heartbeats, the CLI. A limit in an embedded
 * turn makes core cool that account's profile down and try the next one
 * INSIDE the same turn, instead of falling back to another provider; the box
 * reads what core recorded and moves the pool with it, so coding runs, the
 * accounts card and the owner's notice agree with the chat. A Claude CLI run
 * on OpenClaw 2026.11.3 records no such cooldown: the box asks Anthropic about
 * the accounts it holds instead (lookAtLeadUsage), and names the account an
 * automation it bound died on (scanGatewayCrons).
 *
 * WHY. Until now the gateway held ONE Claude profile and the box overwrote it
 * with whichever account was active, then restarted the gateway. On the box a
 * real 429 in the chat logged `rotations=0` — core had nothing to rotate to —
 * and core answered from ClawBox AI while the pool still called the account
 * fine: the box only heard of chat failures through the desktop chat's own
 * report and a cron scan, never of a Telegram turn or of a turn core rescued
 * with a model fallback.
 *
 * HARNESS FIRST — every mechanism here is core's own (OpenClaw 2026.10.2;
 * the order filtering below read in 2026.10.3 and 2026.10.6; the Claude CLI
 * session and automation rules read in 2026.11.3, the pin now):
 *  - THE PROFILES: `anthropic:clawbox-<pool id>`, written by core's own writer,
 *    `openclaw models auth paste-token --provider anthropic --profile-id <id>
 *    --expires-in <n>s`, the token on stdin. A `token` profile is a bearer core
 *    uses and never refreshes — the pool stays the ONLY holder of each refresh
 *    token, and the keeper below puts a renewed access token in before the old
 *    one ends. `models auth logout <id> --yes` takes one out, with its order
 *    and config entries. The CLI tells the running gateway; nothing restarts.
 *  - THE ORDER: core's stored per-agent order, `openclaw models auth order set
 *    --provider anthropic <ids…>`: the active account first, then the pool's
 *    other accounts that can answer, in the owner's order, then every other
 *    Anthropic profile the store holds. An explicit order is the WHOLE
 *    candidate list, so nothing the owner put there is dropped — and a
 *    LIMITED account is OUT OF THE GATEWAY while one that can answer is held,
 *    or the owner's own subscription sign-in leads (TASK-2533). Out of the
 *    order was enough for an embedded turn's automatic pin ("Explicit auth
 *    order filtering" in docs/auth-credential-semantics.md), but on OpenClaw
 *    2026.11.3 a Claude CLI session keeps the account its CLI session was
 *    bound to whatever the order says, unless that profile is gone
 *    (`selectCliExecutionAuthProfile`, read in the 2026.11.3 package:
 *    "Preserve the session account unless the user selects another or it was
 *    removed"; docs/gateway/cli-backends.md: "Existing sessions keep their
 *    account until you select another or remove its saved profile"). So it is
 *    taken out with core's own logout (no restart) — once an account that
 *    answers is in with its current token, else it stays (syncLocked) — and
 *    by that rule the session takes the order's lead on its next turn. When a
 *    renewal's window has the gateway stopped, it goes out in that window,
 *    before the gateway starts again: a paste resets the CLI binding of every
 *    session on the profile it renews, and the fresh pick takes the session's
 *    own earlier pick while the store still holds that profile (the owner's
 *    box, 2026-11-14 20:05).
 *    It goes back in when it can answer: at once when it is the only one that can, else with the next
 *    window the pool opens anyway (a renewal) — never a gateway stop of its
 *    own while another answers. With none that can answer, the owner's own
 *    subscription sign-in leads (THE OWNER'S OWN SIGN-IN, below), and the
 *    limited accounts are out for it too. An API key of the owner's is out of that order too: the turn's one
 *    rotation would land on it when the sign-in is spent as well, and a box
 *    whose accounts are all out answers with the limit, never on a key. Both
 *    are back with the first account that can answer, because every profile
 *    the store holds is read again for each order (otherProfiles). Only with
 *    no such sign-in — an API key, a profile whose kind the
 *    store does not say, or nothing — do the limited ones stay in, by their
 *    reset, ahead of the rest, because an order is never emptied: an empty
 *    one falls back to openclaw.json's order or profiles and re-admits every
 *    pool account. In that state a session pinned to a limited account still
 *    meets its limit until a reset; an API key is never moved ahead of one.
 *    Written with `models.authOrderSet` (the CLI's `order set` when no
 *    gateway answers, src/lib/openclaw-auth-ops.ts). `paste-token` registers
 *    each profile in openclaw.json's `auth.profiles`, and beside an
 *    `anthropic:default` sign-in of another mode it also writes a CONFIG
 *    `auth.order.anthropic`. Core takes the stored order, else that one; with
 *    no stored order it refuses to store one over the config one ("controlled
 *    by auth configuration"), and openclaw.json's order is then the one that
 *    carries the pool's (syncLocked). On 2026.11.3 new automations were also
 *    seen captured onto the config order's head while a stored order was there
 *    (the owner's box, 2026-11-14), so the pass keeps openclaw.json's order
 *    equal to the stored one in any case.
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
 * rewritten or deleted. While an account of the pool can answer it goes LAST
 * in the order: the box cannot tell which account it is — on the box it was a
 * second grant of a pool account — and ahead of the pool's accounts the one
 * rotation a turn gets could land on the same spent subscription and fall
 * back to another provider. When every account the gateway holds is limited,
 * a subscription sign-in (an `oauth` profile, or a static `token` that has not
 * run out) LEADS, and the limited accounts are out of the gateway until their
 * reset — onLimitReset and the keeper put them back as before. It is the only
 * Claude credential left that may still answer; were it the same spent
 * subscription, its refusal is the limit and its reset, as before.
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

import { logoutOpenclawAuthProfiles, setOpenclawAuthOrder, withOpenclawGatewayStopped } from "@/lib/openclaw-auth-ops";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { gatewayIsAbsent, gatewayReadyWaitMs, openclawIsAbsent, readConfigForWrite, readConfigStrict, runOpenclawConfigSet, runOpenclawConfigUnset, spawnOpenclawCli, writeConfig } from "@/lib/openclaw-config";
import { gatewayWsCall, waitForGatewayRpcReady } from "@/lib/openclaw-gateway-ws";
import { processStore } from "@/lib/process-store";
import { createSerialLock, type SerialLock } from "@/lib/serial-lock";
import {
  gatewayCredentialFor,
  OAUTH_REFRESH_MARGIN_MS,
  markLimited,
  onLimitReset,
  probeAccountCredential,
  readAccountUsage,
  readPoolState,
  setGatewayMirror,
  type AnthropicAccount,
  type PoolState,
  type SwapConsumerOutcome,
} from "@/lib/anthropic-accounts";
import { tokenFingerprint } from "@/lib/anthropic-gateway-auth";
import { classifyAnthropicFailure, DEFAULT_LIMIT_MS, effectiveStatus, type AnthropicLimitKind } from "@/lib/anthropic-limit";
import { fetchAnthropicUsage, type AnthropicUsageReading } from "@/lib/anthropic-usage";
import { readGatewayProviderAuth, type GatewayProviderAuthRead, type ProfileFailureState, type ProviderAuthProfile } from "@/lib/openclaw-auth-store";
import { registerSwapConsumer, reportAnthropicFailure, throttleSeenRecently, type FailureOutcome, type SwapContext } from "@/lib/anthropic-swap";
import { verifyAnthropicKey } from "@/lib/coding-anthropic";
import { bindCronsToTarget, splitModelRef, type CronBindingRecords, type CronBindingResult, type CronBindingTarget, type CronLostRunReports, type CronRefusals } from "@/lib/anthropic-cron-binding";

const PROVIDER = "anthropic";
const POOL_PROFILE_PREFIX = "anthropic:clawbox-";

/** The gateway profile one pool account is held under. */
function poolProfileId(accountId: string): string {
  return `${POOL_PROFILE_PREFIX}${accountId}`;
}

const isPoolProfile = (profileId: string) => profileId.startsWith(POOL_PROFILE_PREFIX);

/** The mirror's fingerprint for an account the gateway holds no token of (every account out for the owner's sign-in). */
const NO_TOKEN_HELD = "0".repeat(16);

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
  /** The same for any provider: the account a job the box gives back is bound to (bindCronsLocked). */
  readProvider?: (provider: string) => GatewayProviderAuthRead;
  /** Core's writer: one `token` profile, the access token on stdin. `agent`: the `--agent` arguments (ChatConfig). */
  paste: (profileId: string, token: { access: string; expires: number | null }, agent: readonly string[]) => Promise<void>;
  /**
   * Run the pass's token pastes (`paste-token`, which OpenClaw 2026.11.3 takes
   * only offline: it has no gateway RPC) with the gateway stopped through its
   * service owner, and started again after. Absent: the pastes run as they are.
   */
  offline?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Core's removal of one profile, its order and config entries. */
  logout: (profileId: string, agent: readonly string[]) => Promise<void>;
  /** Core's stored order for Anthropic; an empty list clears it. */
  order: (profileIds: readonly string[], agent: readonly string[]) => Promise<void>;
  /** Drop openclaw.json's `auth.order.anthropic` — only ever one the pool wrote or its own pastes created. */
  unsetConfigOrder: () => Promise<void>;
  /** Write openclaw.json's `auth.order.anthropic` (hot-reloaded by the gateway: no restart). */
  setConfigOrder?: (profileIds: readonly string[]) => Promise<void>;
  /** The same, straight into the file, while an offline window has the gateway stopped. */
  setConfigOrderOffline?: (profileIds: readonly string[]) => Promise<void>;
  /** Anthropic's usage windows for one account. Null: could not be asked. */
  usage: (access: string) => Promise<AnthropicUsageReading | null>;
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * Wait for a gateway that was just started again to answer requests: false
   * when it did not in time. Absent: nothing is waited for.
   */
  ready?: () => Promise<boolean>;
  /** What the box adopted for each automation (src/lib/anthropic-cron-binding.ts), kept in the config store. */
  cronBindings?: { read: () => Promise<CronBindingRecords>; write: (records: CronBindingRecords) => Promise<void> };
}

/** A Jetson CLI cold start is 5-14 s; a busy one is given room. */
const CLI_TIMEOUT_MS = 60_000;
/** After the gateway answers its startup probe, the box's own socket to it is given this long to come back. */
const POST_START_SETTLE_MS = 3_000;
/** How many times the binding after a window waits for the gateway and asks again. */
const POST_WINDOW_BIND_ATTEMPTS = 3;

/** openclaw.json, as far as this module reads it. */
export interface ChatConfig {
  /** The chat's primary model is an Anthropic one. */
  onAnthropic: boolean;
  /** There is a CONFIG `auth.order.anthropic`. */
  configOrder: boolean;
  /** That order's ids (null: none); absent when the reader does not say. */
  configOrderIds?: string[] | null;
  /**
   * The `--agent` arguments every `models auth` verb needs to write the store
   * this module reads — the `main` agent's — or null when the CLI's agent is
   * not `main` (a roster without it), which this module does not write.
   */
  agent: string[] | null;
  /**
   * The `main` agent's default model without any `@profile` — what an
   * automation with no model of its own runs on — or null when none is set.
   */
  model?: string | null;
  /** A job with no agent of its own runs on `main`; false when openclaw.json names another default agent. */
  defaultIsMain?: boolean;
}

/**
 * Does a job with no `agentId` run on `main`? Core takes the configured
 * system agent, else a roster entry marked default, else the sole agent; with
 * several and none named, `main` when it is the first, as core lists them.
 */
function defaultIsMainOf(config: Record<string, unknown>): boolean {
  const agents = config.agents && typeof config.agents === "object" ? (config.agents as Record<string, unknown>) : {};
  const defaults = agents.defaults && typeof agents.defaults === "object" ? (agents.defaults as Record<string, unknown>) : {};
  const system = defaults.systemAgent && typeof defaults.systemAgent === "object" ? (defaults.systemAgent as { agentId?: unknown }).agentId : undefined;
  if (typeof system === "string" && system.trim()) return system.trim().toLowerCase() === "main";
  const entries = agents.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries) ? (agents.entries as Record<string, unknown>) : null;
  const roster: { id: string; isDefault: boolean }[] = entries
    ? Object.entries(entries).map(([id, e]) => ({ id, isDefault: !!e && typeof e === "object" && (e as { default?: unknown }).default === true }))
    : Array.isArray(agents.list)
      ? agents.list.flatMap((e) => (e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" ? [{ id: (e as { id: string }).id, isDefault: (e as { default?: unknown }).default === true }] : []))
      : [];
  if (roster.length === 0) return true;
  const chosen = roster.find((r) => r.isDefault) ?? roster[0];
  return chosen.id.toLowerCase() === "main";
}

/** The `main` agent's default model as openclaw.json sets it: its own entry's, else the defaults'. */
function mainModelOf(config: Record<string, unknown>): string | null {
  const primaryOf = (v: unknown): string | null => {
    const raw = typeof v === "string" ? v : v && typeof v === "object" ? (v as { primary?: unknown }).primary : undefined;
    return typeof raw === "string" && raw.trim() ? splitModelRef(raw.trim()).base : null;
  };
  const agents = config.agents && typeof config.agents === "object" ? (config.agents as Record<string, unknown>) : {};
  const entries = agents.entries && typeof agents.entries === "object" ? (agents.entries as Record<string, unknown>) : {};
  const fromEntry = entries.main && typeof entries.main === "object" ? primaryOf((entries.main as { model?: unknown }).model) : null;
  const listed = Array.isArray(agents.list) ? agents.list.find((a) => a && typeof a === "object" && (a as { id?: unknown }).id === "main") : undefined;
  const fromList = listed ? primaryOf((listed as { model?: unknown }).model) : null;
  const defaults = agents.defaults && typeof agents.defaults === "object" ? (agents.defaults as { model?: unknown }).model : undefined;
  return fromEntry ?? fromList ?? primaryOf(defaults);
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

/** The agent `agentArgsOf` named (`--agent main`), for the gateway request. */
function agentIdOf(agent: readonly string[]): string | undefined {
  const i = agent.indexOf("--agent");
  return i >= 0 && typeof agent[i + 1] === "string" ? agent[i + 1] : undefined;
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
        configOrderIds: order && typeof order === "object" && Array.isArray(order[PROVIDER])
          ? (order[PROVIDER] as unknown[]).filter((id): id is string => typeof id === "string")
          : null,
        agent: agentArgsOf(config.agents),
        model: mainModelOf(config as Record<string, unknown>),
        defaultIsMain: defaultIsMainOf(config as Record<string, unknown>),
      };
    } catch {
      return null;
    }
  },
  read: () => readGatewayProviderAuth(PROVIDER),
  readProvider: (provider) => readGatewayProviderAuth(provider),
  paste: async (profileId, token, agent) => {
    const args = ["paste-token", "--provider", PROVIDER, "--profile-id", profileId];
    // Core stores the end itself, so it stops offering the profile at the
    // moment the token stops working — whatever the keeper is doing.
    if (token.expires !== null) args.push("--expires-in", `${Math.max(60, Math.floor((token.expires - Date.now()) / 1000))}s`);
    await modelsAuth(args, agent, `${token.access}\n`);
  },
  // OpenClaw 2026.11.3 refuses the CLI's `logout` and `order` while the
  // gateway owns the state: the gateway's own models.authLogout /
  // models.authOrderSet then, the CLI only when no gateway answers.
  // The stop is waited out however long the gateway takes over it (up to its
  // unit's TimeoutStopSec=330, when it is in the middle of answering): by the
  // time the window opens the pool has renewed a token and Anthropic refuses
  // the gateway's copy of it, so a pass that gave up after a minute started
  // the assistant again with nothing pasted, and the next pass stopped it
  // again (the owner's box, 2026-11-14: two stops of seven, five minutes
  // down each).
  offline: (work) => withOpenclawGatewayStopped(work, { waitOutStop: true }),
  logout: async (profileId, agent) => {
    await logoutOpenclawAuthProfiles(PROVIDER, [profileId], agentIdOf(agent));
  },
  order: (profileIds, agent) => setOpenclawAuthOrder(PROVIDER, profileIds.length > 0 ? [...profileIds] : null, agentIdOf(agent)),
  unsetConfigOrder: async () => {
    try {
      await runOpenclawConfigUnset(`auth.order.${PROVIDER}`);
    } catch (err) {
      // Already gone — core's logouts took its last entries with them (seen on
      // a lab board): what was asked for is done.
      if (/Config path not found/i.test(err instanceof Error ? err.message : String(err))) return;
      throw err;
    }
  },
  setConfigOrder: (profileIds) => runOpenclawConfigSet([`auth.order.${PROVIDER}`, JSON.stringify([...profileIds]), "--strict-json"]),
  // The gateway is stopped: its config route is not there, and a CLI start-up
  // would keep it stopped for seconds more. The box's own writer, which waits
  // out a gateway that is starting.
  setConfigOrderOffline: async (profileIds) => {
    const config = (await readConfigForWrite()) as Record<string, unknown>;
    const auth = config.auth && typeof config.auth === "object" ? (config.auth as Record<string, unknown>) : {};
    const order = auth.order && typeof auth.order === "object" ? (auth.order as Record<string, unknown>) : {};
    config.auth = { ...auth, order: { ...order, [PROVIDER]: [...profileIds] } };
    await writeConfig(config as Awaited<ReturnType<typeof readConfigForWrite>>);
  },
  usage: (access) => fetchAnthropicUsage(access),
  // The in-process socket only: a gateway that is not there is skipped this
  // time rather than paid for with a CLI start-up every minute.
  call: (method, params) => gatewayWsCall(method, params, { timeoutMs: 10_000 }),
  // Its HTTP side first, then a moment for the box's own socket to it to come
  // back up (a Jetson takes most of a minute to start the gateway).
  ready: async () => {
    const up = await waitForGatewayRpcReady(gatewayReadyWaitMs() * 3);
    if (up) await new Promise((resolve) => setTimeout(resolve, POST_START_SETTLE_MS));
    return up;
  },
  cronBindings: {
    read: async () => {
      const raw = await configGet(CRON_BINDINGS_KEY);
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CronBindingRecords) : {};
    },
    write: (records) => configSet(CRON_BINDINGS_KEY, Object.keys(records).length > 0 ? records : undefined),
  },
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
  /**
   * Per account, when it was last renewed AHEAD of its margin (syncLocked): a
   * window that keeps opening beside a token that ends far later than a
   * renewed one ever does (a long-lived token the owner signs in again and
   * again) would otherwise renew every other account each time.
   */
  earlyRenewedAt: Map<string, number>;
  /** When the watcher last asked Anthropic about any held account (one a tick). */
  leadUsageAt: number;
  /** Per account, when Anthropic last ANSWERED the watcher about its usage. */
  usageAnsweredAt: Map<string, number>;
  /** Per account, when the watcher's ask about its usage last got no answer (429, 401, nothing). */
  usageFailedAt: Map<string, number>;
  /** Per automation, core's refusals of its re-binding (src/lib/anthropic-cron-binding.ts). */
  cronRefusals: CronRefusals;
  /** Per automation the box does not bind, the last run lost to its account that was already reported. */
  cronReported: CronLostRunReports;
  /**
   * The watcher's minute passes in a row that left the gateway still owing
   * (gatewayOwesLocked), and when the last one ran: a write core keeps
   * refusing is asked again on a widening interval, not every minute.
   */
  owedPasses: number;
  owedPassAt: number;
  /** What the last of those passes left owing (gatewayOwesLocked's key). */
  owedKey: string | null;
  /**
   * Per pool profile, core's refusals of a paste that would have put a
   * logged-out account back (syncLocked): while another account answers, one
   * core keeps refusing waits for a window the pool opens anyway instead of a
   * gateway stop of its own at every keeper pass.
   */
  pasteRefusals: Map<string, { count: number; at: number }>;
  /**
   * The pool profiles this process logged out for a limit (syncLocked), until
   * one is pasted back: the paste-backs that wait for a window the pool opens
   * anyway. An account the owner just added is not one of them — it goes in
   * at once, as it always did.
   */
  limitedOut: Set<string>;
  /** A pass's offline window started the gateway again: the binding that follows waits for it to answer (bindCronsLocked). */
  windowRan: boolean;
  /** The profiles the automations were last said not to follow because core does not hold the pool's current token of them (said once, not every minute). */
  bindSkipped: string | null;
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
    earlyRenewedAt: new Map(),
    leadUsageAt: 0,
    usageAnsweredAt: new Map(),
    usageFailedAt: new Map(),
    cronRefusals: new Map(),
    cronReported: new Map(),
    owedPasses: 0,
    owedPassAt: 0,
    owedKey: null,
    pasteRefusals: new Map(),
    limitedOut: new Set(),
    windowRan: false,
    bindSkipped: null,
  }));
}

const deps = () => runtime().deps;

const KEEPER_MS = 10 * 60_000;
const WATCH_MS = 60_000;
/**
 * How often the watcher asks Anthropic about the account the gateway leads
 * with — the pool's own reading life (ROOM_TTL_MS in anthropic-accounts.ts).
 */
const LEAD_USAGE_MS = 10 * 60_000;
/** An ask about an account's usage that got no answer is made again after this, not after a whole LEAD_USAGE_MS. */
const USAGE_RETRY_MS = 2 * 60_000;
/** At most one usage ask a watcher tick. */
const USAGE_TICK_MS = 50_000;
/**
 * Tokens that end within this of each other are taken as ending together: the
 * pool renews them in one pass or the next few (a window that failed and was
 * tried again, a keeper that backed off), and renewing one of them again only
 * to move its end by minutes would refuse the copy a coding run holds for nothing.
 */
const ALIGN_SLACK_MS = 3 * KEEPER_MS;
/**
 * How long the offline window spends ASKING Anthropic for renewals: the
 * gateway is down while it does, and each is a request (under a second; twenty
 * at its timeout). The pastes are not counted — one is a CLI start-up, 5-14 s
 * on a Jetson, and counting them left the fifth account of a pool for a window
 * of its own. An account not reached comes due on its own.
 */
const WINDOW_RENEWAL_BUDGET_MS = 30_000;
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
/** Which account the box gave each automation (config store, src/lib/anthropic-cron-binding.ts). */
const CRON_BINDINGS_KEY = "anthropic_cron_bindings";

function outcome(status: SwapConsumerOutcome["status"], code: string, count: number | null = null): SwapConsumerOutcome {
  return { status, code, count };
}

// ── putting the pool in ─────────────────────────────────────────────────────

/**
 * Core refused to take this logged-out profile back lately: twenty minutes
 * after the first refusal, forty after the second, … up to two hours.
 */
function pasteBackedOff(profileId: string, now: number): boolean {
  const refused = runtime().pasteRefusals.get(profileId);
  return !!refused && now - refused.at < Math.min(KEEPER_MS * 2 ** refused.count, MAX_KEEPER_BACKOFF_MS);
}

/** The pool's accounts the gateway holds that cannot answer now, the first back first. */
function limitedByReset(pool: PoolState, held: ReadonlySet<string>, now: number): AnthropicAccount[] {
  return pool.accounts
    .filter((a) => a.kind === "oauth" && held.has(poolProfileId(a.id)) && effectiveStatus(a, now) === "limited")
    .sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0));
}

/**
 * A sign-in of the owner's own on a Claude subscription (header, THE OWNER'S
 * OWN SIGN-IN): a profile that is not the pool's, of the `oauth` kind core
 * refreshes itself, or a static `token` that has not run out. An API key is
 * not one, and neither is a profile whose kind the store does not say.
 */
function isOwnSubscription(profile: ProviderAuthProfile, now: number): boolean {
  if (isPoolProfile(profile.profileId) || profile.fenced || profile.fingerprint === null) return false;
  if (profile.type === "oauth") return true;
  return profile.type === "token" && (profile.expires === null || profile.expires > now);
}

/**
 * The order core should try the Anthropic profiles in: the active account,
 * the pool's other accounts that can answer in the owner's order — then every
 * profile that is not the pool's, in the order core has them, the owner's own
 * sign-in among them. The limited accounts are left out while one that can
 * answer is held (header, THE ORDER); with none, they are left out for the
 * owner's own subscription sign-in, which leads — with an API key out too,
 * where the turn's one rotation would otherwise spend it — and only with no
 * such sign-in do they stay in, by their reset, ahead of what else there is.
 */
function gatewayOrder(pool: PoolState, held: ReadonlySet<string>, others: readonly ProviderAuthProfile[], now: number): string[] {
  const usable = pool.accounts.filter((a) => a.kind === "oauth" && held.has(poolProfileId(a.id)) && effectiveStatus(a, now) === "ok");
  const active = usable.find((a) => a.id === pool.activeId);
  const otherIds = others.map((p) => p.profileId);
  if (usable.length > 0) return [...(active ? [active] : []), ...usable.filter((a) => a !== active)].map((a) => poolProfileId(a.id)).concat(otherIds);
  const limited = limitedByReset(pool, held, now);
  const signIns = others.filter((p) => isOwnSubscription(p, now));
  const anyLimited = pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) === "limited");
  if ((limited.length > 0 || anyLimited) && signIns.length > 0) {
    return [...signIns, ...others.filter((p) => !signIns.includes(p) && p.type !== "api_key")].map((p) => p.profileId);
  }
  return limited.map((a) => poolProfileId(a.id)).concat(otherIds);
}

/** The profiles that are not the pool's: in core's stored order first, then as the store lists them. */
function otherProfiles(store: Extract<GatewayProviderAuthRead, { kind: "present" }> | null): ProviderAuthProfile[] {
  if (!store) return [];
  const profiles = store.profiles.filter((p) => !isPoolProfile(p.profileId));
  const ordered = (store.order ?? []).flatMap((id) => profiles.filter((p) => p.profileId === id));
  return [...ordered, ...profiles.filter((p) => !ordered.includes(p))];
}

/**
 * Does core hold the token the pool holds for this profile NOW? A profile that
 * is not the pool's (the owner's own sign-in) is core's own to keep current.
 * One of the pool's holds an older token while its paste is owed (refused, or
 * not yet made): the pool renewed it, Anthropic refuses the one core still
 * has, and the paste that lands next gives the profile a new authorization
 * lifetime — so an automation bound to it before is refused again after
 * (renewal path (a), see the header of src/lib/anthropic-cron-binding.ts).
 * The pool's token is read as it is, never renewed here. False when the pool
 * cannot say.
 */
async function coreHoldsCurrentToken(profile: ProviderAuthProfile): Promise<boolean> {
  if (!isPoolProfile(profile.profileId)) return true;
  try {
    const current = await gatewayCredentialFor(profile.profileId.slice(POOL_PROFILE_PREFIX.length), { renew: false });
    return !!current && tokenFingerprint(current.access) === profile.fingerprint;
  } catch {
    return false;
  }
}

/**
 * Does the stored order lead with `wanted`? OpenClaw 2026.11.3 takes an order
 * only when it names every profile the store holds for the provider, so the
 * gateway keeps the pool's order first and the provider's other profiles
 * after it (src/lib/openclaw-auth-ops.ts); an empty `wanted` is a cleared one.
 */
const leadsWith = (stored: readonly string[] | null, wanted: readonly string[]) => wanted.length === 0
  ? stored === null || stored.length === 0
  : stored !== null && stored.length >= wanted.length && wanted.every((id, i) => id === stored[i]);

interface OrderMarker {
  /** The pool wrote core's stored order. */
  stored: boolean;
  /** The pool's pastes created openclaw.json's `auth.order.anthropic` (there was none before). */
  config: boolean;
  /** openclaw.json's `auth.order.anthropic` as the owner had it before the pool first wrote over it. */
  ownerConfig?: string[];
}

async function readOrderMarker(): Promise<OrderMarker> {
  const raw = await configGet(ORDER_MARKER_KEY).catch(() => null);
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const owner = Array.isArray(v.ownerConfig) && v.ownerConfig.every((id) => typeof id === "string") ? (v.ownerConfig as string[]) : undefined;
  return { stored: v.stored === true, config: v.config === true, ...(owner ? { ownerConfig: owner } : {}) };
}

/**
 * Never throws: a marker that could not be written is said, and never fails a
 * move that landed. Answers whether the marker now says `next` — a caller
 * about to write over something only the marker can give back asks first.
 */
async function writeOrderMarker(next: OrderMarker): Promise<boolean> {
  try {
    const before = await readOrderMarker();
    const sameOwner = JSON.stringify(before.ownerConfig ?? null) === JSON.stringify(next.ownerConfig ?? null);
    if (before.stored === next.stored && before.config === next.config && sameOwner) return true;
    await configSet(ORDER_MARKER_KEY, next.stored || next.config || next.ownerConfig ? { ...next } : undefined);
    return true;
  } catch (err) {
    console.error("[anthropic-gateway] could not record which account orders the pool wrote:", err instanceof Error ? err.message : err);
    return false;
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
 *
 * `noWindow`: the watcher's minute pass (gatewayOwesLocked) — logouts, the
 * orders, openclaw.json's order, but never a gateway stop and never a renewal:
 * a paste it finds owed stays owed for the keeper, whose back-off covers a
 * paste core keeps refusing. Without it, a refused renewal beside a limited
 * account still held would stop the assistant every minute.
 */
async function syncLocked(opts: { force?: boolean; noWindow?: boolean } = {}): Promise<SwapConsumerOutcome> {
  const d = deps();
  if (d.absent()) return outcome("skipped", "no_gateway");
  const before = d.read();
  if (before.kind === "unreadable") return outcome("failed", "store_unreadable");
  const ours = before.kind === "present" ? before.profiles.filter((p) => isPoolProfile(p.profileId)) : [];
  const pool = await readPoolState();
  const now = Date.now();
  // A LIMITED account is out of the gateway altogether while another can
  // answer (TASK-2533): out of the order was not enough on OpenClaw 2026.11.3,
  // whose Claude CLI runs keep a session on the account its CLI session was
  // bound to whatever the order says, unless that profile is gone
  // (`selectCliExecutionAuthProfile`: "Preserve the session account unless the
  // user selects another or it was removed") — and that version records no
  // cooldown for a CLI limit, so nothing else moves them. With its profile
  // out, such a session moves to the order's lead on its next turn. The
  // account is pasted back when it can answer again: its reset costs one
  // offline window, shared with any renewal due then. Only once the gateway
  // HOLDS an account that can answer: with none held (none can answer, or the
  // one that can is not in yet), the limited ones stay in, as before (THE ORDER).
  const answersHeld = pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) === "ok" && ours.some((p) => p.profileId === poolProfileId(a.id) && !p.fenced && p.fingerprint !== null));
  const wanted = pool.accounts.filter((a) => a.kind === "oauth" && (effectiveStatus(a, now) === "ok" || (!answersHeld && effectiveStatus(a, now) === "limited")));
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

  // Every account's current access token, in where it is not already, and
  // every paste the pass owes in ONE offline window (`d.offline`).
  //
  // The window stops the assistant and cuts off whatever it was answering, so
  // a pass that has to open one leaves no account behind for a window of its
  // own. The pool renews each account as ITS token nears its end, and accounts
  // signed in at different times come due at different passes: five accounts
  // were five stops at every renewal (the owner's box, 2026-11-14, the
  // gateway down every ten minutes for an hour). So every account whose token
  // ends before the freshest one going in is renewed and goes in beside it.
  // Their tokens then end together, they come due in the same pass, and the
  // gateway is stopped once a renewal, however many accounts there are.
  //
  // Anthropic refuses a token the moment its renewal replaced it, so a renewal
  // takes that account away from the gateway until the paste lands. Only ONE
  // is made with the gateway still up — the one that tells the pass a window
  // is needed at all, and that Anthropic can be reached. The rest are made
  // inside the window (`pasteAll`), the gateway already stopped, each pasted
  // before the next is renewed, none after one of them could not be pasted: a
  // stop that cannot be made, or that takes minutes while the gateway finishes
  // what it is answering, costs the chat one account, as it always did; a
  // window that cannot write costs it at most one more a pass, and only one
  // that was due anyway — never an account that still has hours left.
  const tokens = new Map<string, { fingerprint: string; expires: number | null }>();
  const toPaste: { id: string; account: string; token: { access: string; expires: number | null } }[] = [];
  let offlineFailed = false;
  let pasted = 0;
  // The owner's own subscription sign-in, usable now: with every pool account
  // limited it leads, and it is what answers (THE OWNER'S OWN SIGN-IN).
  const signInUsable = otherProfiles(before.kind === "present" ? before : null).some((p) => isOwnSubscription(p, now));
  // One of the pool's accounts stays in the gateway (not one this pass logs
  // out): the order is not empty without the ones out (THE ORDER).
  const poolHeld = ours.some((p) => wanted.some((a) => poolProfileId(a.id) === p.profileId));
  // The minute pass opens no window (`noWindow`), so it renews nothing either:
  // a renewal replaces the token the gateway answers with.
  const noWindow = opts.noWindow === true && !!d.offline;
  // Pasting means stopping the gateway (OpenClaw 2026.11.3 takes `paste-token`
  // only offline), and every live chat with it. So an account that is NOT in
  // the gateway goes in only when it is worth that (TASK-2533):
  //  - a limited one never while the gateway holds another of the pool's or
  //    the owner's sign-in answers — it would only answer with its limit; it is
  //    back when it can answer;
  //  - one back from its limit (logged out for it, limitedOut), not the
  //    active one, while another answers, waits for a window the pass opens
  //    anyway (a renewal; the alignment below brings every account's renewal
  //    into one), instead of a stop of its own at every reset — an account
  //    the owner just added goes in at once;
  //  - so does the active one while another answers, once core refused to
  //    take it back (pasteBackedOff): asked again on a widening interval, not
  //    with a stop at every keeper pass;
  //  - and a limited one only when no account that can answer goes in with
  //    this window (the pool going in from nothing: none is held yet). Pasted
  //    beside one, it was taken out again in the same window — a paste and a
  //    CLI logout with the gateway stopped, for an account that could only
  //    have answered with its limit.
  const deferred: AnthropicAccount[] = [];
  const limitedLater: AnthropicAccount[] = [];
  const admit = async (account: AnthropicAccount): Promise<void> => {
    const id = poolProfileId(account.id);
    // Null: the pool could not hand one out (a store outage, a renewal that
    // could not be made) — what the gateway holds stays, and is owed.
    const token = await gatewayCredentialFor(account.id, noWindow || (toPaste.length > 0 && d.offline) ? { renew: false } : {});
    if (!token) return;
    const fingerprint = tokenFingerprint(token.access);
    tokens.set(id, { fingerprint, expires: token.expires });
    if (ours.some((p) => p.profileId === id && p.fingerprint === fingerprint)) return;
    // Read as it is, a token can be past its end (the chat was elsewhere for
    // hours and nobody asked for it). That one is never pasted: the window
    // renews it, or it stays owed.
    if (token.expires !== null && token.expires <= now) return;
    toPaste.push({ id, account: account.id, token });
  };
  for (const account of wanted) {
    const id = poolProfileId(account.id);
    const inGateway = ours.some((p) => p.profileId === id);
    if (!inGateway && effectiveStatus(account, now) === "limited" && (answersHeld || signInUsable || poolHeld)) continue;
    if (effectiveStatus(account, now) === "limited") {
      limitedLater.push(account);
      continue;
    }
    const backFromLimit = runtime().limitedOut.has(id) && account.id !== pool.activeId;
    if (!inGateway && answersHeld && (backFromLimit || pasteBackedOff(id, now))) {
      deferred.push(account);
      continue;
    }
    await admit(account);
  }
  if (!toPaste.some((p) => wanted.some((a) => a.id === p.account && effectiveStatus(a, now) === "ok"))) {
    for (const account of limitedLater) await admit(account);
  }
  // The minute pass: what is owed stays owed for the keeper's window.
  if (noWindow && toPaste.length > 0) {
    console.error(`[anthropic-gateway] ${toPaste.length} token paste(s) owed; left for the keeper's next pass rather than a gateway stop from the watcher`);
    toPaste.length = 0;
  }
  // A window opens anyway: the deferred accounts go in with it.
  if (toPaste.length > 0) {
    for (const account of deferred) {
      const id = poolProfileId(account.id);
      const token = await gatewayCredentialFor(account.id, d.offline ? { renew: false } : {});
      if (!token || (token.expires !== null && token.expires <= now)) continue;
      tokens.set(id, { fingerprint: tokenFingerprint(token.access), expires: token.expires });
      toPaste.push({ id, account: account.id, token });
    }
  }
  // The limited accounts a window takes out before the gateway starts again (pasteAll).
  const outInWindow = new Set<string>();
  if (toPaste.length > 0) {
    const ends = toPaste.flatMap((p) => (p.token.expires === null ? [] : [p.token.expires]));
    // Without a window to share (`d.offline` absent) or an end among the
    // tokens going in, there is nothing to bring the others to.
    const renewBefore = d.offline && ends.length > 0 ? Math.max(...ends) - ALIGN_SLACK_MS : Number.NEGATIVE_INFINITY;
    const behind = (id: string): boolean => {
      const held = tokens.get(id);
      return !!held && held.expires !== null && held.expires < renewBefore;
    };
    /** Inside the pool's renewal margin (an account read as it is may be: nothing renewed it). */
    const due = (id: string): boolean => {
      const held = tokens.get(id);
      return !!held && held.expires !== null && held.expires - now < OAUTH_REFRESH_MARGIN_MS;
    };
    // Before the gateway starts again, a LIMITED account still held goes
    // out — by the test the logout after the window makes (an account that
    // answers is in with its current token, or else the owner's own sign-in
    // answers), read from the store the pastes just wrote. Each paste gives
    // the profile it renews a new credential, so a Claude CLI session bound
    // to that profile starts again on its next turn
    // (`reuse=invalidated:auth-epoch`), and that fresh pick puts the
    // session's own earlier automatic pick first while the store still
    // holds that profile (`prependAuthProfilePin`, OpenClaw 2026.11.3).
    // Logged out only after the restart, a limited account was there for
    // every turn in between: on the owner's box (2026-11-14 20:05) a chat's
    // first turn after a renewal ran on a spent account. Rare (the
    // watcher's minute takes a limited account out), and the gateway is
    // stopped, so core's CLI does it.
    const takeLimitedOutInWindow = async (): Promise<void> => {
      const inWindow = d.read();
      if (inWindow.kind !== "present") return;
      const answersInWindow = wanted.some((a) => {
        if (effectiveStatus(a, now) !== "ok") return false;
        const held = inWindow.profiles.find((p) => p.profileId === poolProfileId(a.id));
        const token = tokens.get(poolProfileId(a.id));
        return !!held && !held.fenced && !!token && held.fingerprint === token.fingerprint && (held.expires === null || held.expires > Date.now());
      });
      const signInInWindow = !pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) === "ok" && inWindow.profiles.some((p) => p.profileId === poolProfileId(a.id)))
        && otherProfiles(inWindow).some((p) => isOwnSubscription(p, now));
      if (!answersInWindow && !signInInWindow) return;
      for (const profile of inWindow.profiles) {
        const account = isPoolProfile(profile.profileId) ? pool.accounts.find((a) => poolProfileId(a.id) === profile.profileId) : undefined;
        if (!account || account.kind !== "oauth" || effectiveStatus(account, now) !== "limited") continue;
        if (await attempt(`taking ${profile.profileId} out before the gateway starts again`, () => d.logout(profile.profileId, agent))) outInWindow.add(profile.profileId);
      }
      if (outInWindow.size > 0) console.error(`[anthropic-gateway] took ${outInWindow.size} limited account(s) out with the gateway stopped, before it starts again: ${[...outInWindow].join(", ")}`);
    };
    // ...and openclaw.json's order is the pool's again before the gateway
    // reads it: each paste put its own profile at that order's head, and with
    // no stored order it IS core's order (the pass after the window is the
    // same write, made again only when what landed differs). Without this,
    // the gateway came back from a renewal of three accounts led by the last
    // one pasted for half a minute (seen on a lab board). A straight write
    // of the file: the gateway is stopped. Never over an owner's order the
    // pool has not recorded yet (the pass after the window records it first).
    const alignConfigOrderInWindow = async (): Promise<void> => {
      if (pasted === 0 || !d.setConfigOrderOffline || chat.configOrderIds === undefined) return;
      const inWindow = d.read();
      if (inWindow.kind !== "present") return;
      const current = (await d.chat())?.configOrderIds;
      if (!Array.isArray(current)) return;
      const recorded = await readOrderMarker();
      if ((chat.configOrderIds ?? []).some((id) => !isPoolProfile(id)) && !recorded.config && !recorded.ownerConfig) return;
      const heldNow = new Set(wanted.map((a) => poolProfileId(a.id)).filter((id) => !outInWindow.has(id) && inWindow.profiles.some((p) => p.profileId === id)));
      const base = gatewayOrder(pool, heldNow, otherProfiles(inWindow), now);
      const storeIds = new Set(inWindow.profiles.map((p) => p.profileId));
      const want = [...base, ...current.filter((id) => !storeIds.has(id) && !base.includes(id) && !isPoolProfile(id))];
      if (want.length === 0 || (current.length === want.length && current.every((id, i) => id === want[i]))) return;
      const write = d.setConfigOrderOffline;
      await attempt("openclaw.json's account order before the gateway starts again", () => write(want));
    };
    const pasteAll = async () => {
      const paste = async (id: string, account: string, token: { access: string; expires: number | null }): Promise<boolean> => {
        // Asked HERE, not at the pass's start: the stop before this can take
        // minutes, and a token that ended meanwhile is not written (core would
        // offer it for a minute more). It stays owed.
        if (token.expires !== null && token.expires <= Date.now()) return false;
        const landed = await attempt(`account ${account}'s token`, () => d.paste(id, token, agent));
        if (landed) pasted += 1;
        // A logged-out account core would not take back (pasteBackedOff).
        const refusals = runtime().pasteRefusals;
        if (landed) {
          refusals.delete(id);
          runtime().limitedOut.delete(id);
        }
        else if (!ours.some((p) => p.profileId === id)) refusals.set(id, { count: (refusals.get(id)?.count ?? 0) + 1, at: Date.now() });
        return landed;
      };
      // What is owed and goes in as it stands first — the freshest token is
      // one of these. An owed token that is behind or due is renewed below,
      // and pasted once.
      for (const { id, account, token } of toPaste) {
        if (!behind(id) && !due(id)) await paste(id, account, token);
      }
      // A token renewed in this window that core then did not take: that
      // account is off the chat until a later pass, and nothing more is
      // renewed here. A paste refused for a token that was owed anyway stops
      // nothing — one profile core keeps refusing must not keep every other
      // account from ever being renewed.
      let lost = false;
      let renewalMs = 0;
      const renewed: string[] = [];
      for (const account of wanted) {
        const id = poolProfileId(account.id);
        const held = tokens.get(id);
        if (!held || held.expires === null) continue;
        // `behind` picks the accounts to bring forward; one that is DUE is
        // renewed here whether it is behind or not. It was read as it is, so
        // nothing else renews it: beside an owed token that itself ends soon
        // (and so sets no end to be behind of), or one with no end at all, it
        // would be passed over on every pass and run out.
        const isDue = due(id);
        if (!behind(id) && !isDue) continue;
        // Owed: it goes in as it stands when it is not renewed here.
        let token = toPaste.find((p) => p.id === id)?.token ?? null;
        let fresh = false;
        // Inside its margin the pool renews it whoever asks; ahead of it, once
        // a margin at most, whatever keeps the window opening.
        const lately = now - (runtime().earlyRenewedAt.get(account.id) ?? Number.NEGATIVE_INFINITY) < OAUTH_REFRESH_MARGIN_MS;
        // ...and never before this window has written a token: a window that
        // cannot write (the store busy, a gateway that did not stay stopped)
        // would otherwise spend one more account with hours left on every
        // pass, until the gateway held a refused token for each of them. A
        // due account is renewed either way, as it always was.
        const ahead = !lately && pasted > 0;
        if (!lost && (isDue || ahead) && renewalMs < WINDOW_RENEWAL_BUDGET_MS) {
          // The same token back: no grant to renew with, or Anthropic could
          // not be asked. It stays as it is and comes due on its own.
          const asked = Date.now();
          const answer = await gatewayCredentialFor(account.id, { renewBefore });
          renewalMs += Date.now() - asked;
          const fingerprint = answer ? tokenFingerprint(answer.access) : held.fingerprint;
          if (answer && fingerprint !== held.fingerprint) {
            tokens.set(id, { fingerprint, expires: answer.expires });
            token = answer;
            fresh = true;
            if (!isDue) runtime().earlyRenewedAt.set(account.id, now);
            renewed.push(account.id);
          }
        }
        if (token && !(await paste(id, account.id, token)) && fresh) lost = true;
      }
      if (renewed.length > 0) {
        console.error(`[anthropic-gateway] renewed ${renewed.length} more account(s) with the gateway stopped (${renewed.join(", ")}): one stop takes every account's token`);
      }
      await takeLimitedOutInWindow();
      await alignConfigOrderInWindow();
    };
    try {
      if (d.offline) runtime().windowRan = true;
      await (d.offline ? d.offline(pasteAll) : pasteAll());
    } catch (err) {
      // Stored credentials do not prove the gateway is answering again: the
      // pass fails below, whatever the read-back shows.
      offlineFailed = true;
      console.error("[anthropic-gateway] the gateway could not be stopped and started again around the token pastes:", err instanceof Error ? err.message : err);
    }
  }
  // What the pool wrote, recorded the moment it is seen, so taking the pool
  // out later undoes exactly that: a CONFIG order core's paste created beside
  // a sign-in of another mode (there was none before).
  const marker = await readOrderMarker();
  if (!marker.config && !chat.configOrder && pasted > 0 && (await d.chat())?.configOrder === true) {
    marker.config = true;
    await writeOrderMarker(marker);
  }
  // Out: accounts that left the pool or can no longer answer (needs the
  // owner) — and the limited ones, but only while an account that answers is
  // in the gateway NOW, with its current token: a renewal that was refused in
  // the window above left that one's old token refused by Anthropic.
  const mid = d.read();
  const answersNow = mid.kind === "present" && wanted.some((a) => {
    if (effectiveStatus(a, now) !== "ok") return false;
    const held = mid.profiles.find((p) => p.profileId === poolProfileId(a.id));
    const token = tokens.get(poolProfileId(a.id));
    return !!held && !held.fenced && !!token && held.fingerprint === token.fingerprint && (held.expires === null || held.expires > Date.now());
  });
  // With no pool account that answers in the gateway, the owner's own sign-in
  // answers for them — it leads the order then (gatewayOrder, by the same
  // test) — so a limited account is out for it too, and a Claude CLI session
  // bound to that account moves to the sign-in.
  const signInNow = mid.kind === "present"
    && !pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) === "ok" && mid.profiles.some((p) => p.profileId === poolProfileId(a.id)))
    && otherProfiles(mid).some((p) => isOwnSubscription(p, now));
  // Those the window already took out are out for their limit too (one core
  // still holds is asked again here, and owed if it stays).
  const takenOut = new Set<string>(outInWindow);
  const unwanted = ours.filter((p) => {
    if (outInWindow.has(p.profileId)) return mid.kind === "present" && mid.profiles.some((q) => q.profileId === p.profileId);
    const account = pool.accounts.find((a) => poolProfileId(a.id) === p.profileId);
    if (account && account.kind === "oauth" && effectiveStatus(account, now) === "limited") {
      const out = answersNow || signInNow;
      if (out) takenOut.add(p.profileId);
      return out;
    }
    return !wanted.includes(account as AnthropicAccount);
  });
  for (const profile of unwanted) await attempt(`taking ${profile.profileId} out`, () => d.logout(profile.profileId, agent));

  // Read back. A profile still holding an older token stays in the order —
  // that token answers until it ends, and an explicit order is core's whole
  // candidate list — and its write is owed.
  const after = d.read();
  if (after.kind !== "present") return outcome("failed", "write_lost", changed);
  for (const id of takenOut) {
    if (!after.profiles.some((p) => p.profileId === id)) runtime().limitedOut.add(id);
  }
  const owed: string[] = [];
  const held = new Set<string>();
  for (const account of wanted) {
    const id = poolProfileId(account.id);
    const stored = after.profiles.find((p) => p.profileId === id);
    if (stored) held.add(id);
    // Out on purpose (limited, or waiting for a window): not owed.
    if (takenOut.has(id) || (!stored && !tokens.has(id) && (deferred.includes(account) || effectiveStatus(account, now) === "limited"))) continue;
    if (!tokens.has(id) || stored?.fingerprint !== tokens.get(id)?.fingerprint) owed.push(id);
  }
  for (const profile of unwanted) {
    if (after.profiles.some((p) => p.profileId === profile.profileId)) owed.push(profile.profileId);
  }
  const order = gatewayOrder(pool, held, otherProfiles(after), now);
  let final = after;
  // openclaw.json's order as it is now, the pass's pastes and logouts in it
  // (undefined: the reader cannot say).
  const configNow = chat.configOrderIds !== undefined && d.setConfigOrder ? (await d.chat())?.configOrderIds : undefined;
  // Core said it wrote the order: whatever the read-back shows, taking the
  // pool out later clears it (an order that is not there clears without fuss).
  let orderWritten = false;
  if (!leadsWith(after.order, order)) {
    if (await attempt("the account order", () => d.order(order, agent))) orderWritten = true;
    const reread = d.read();
    if (reread.kind !== "present") return outcome("failed", "write_lost", changed);
    final = reread;
  }
  const storedLanded = leadsWith(final.order, order);
  // With no stored order, a config `auth.order.anthropic` IS core's order (it
  // takes the stored one, else the configured one), and core refuses to store
  // one over it: "profile priority for provider anthropic is controlled by
  // auth configuration" (`models.authOrderSet`, OpenClaw 2026.11.3 — seen on a
  // lab board once logouts had left openclaw.json an order and the store
  // none). openclaw.json's order, below, carries it then.
  const configControls = !storedLanded && !(final.order && final.order.length > 0) && Array.isArray(configNow);

  if ((storedLanded || orderWritten) && !marker.stored) {
    marker.stored = true;
    await writeOrderMarker(marker);
  }

  // openclaw.json's order says the same (TASK-2533). Observed on OpenClaw
  // 2026.11.3 (the owner's box, 2026-11-14, and reproduced on a lab board):
  // new automations were captured onto the head of openclaw.json's
  // `auth.order.anthropic` — which each `paste-token` beside a sign-in of
  // another mode rewrites to lead with the profile it pasted, so the LAST
  // account pasted — or, with none, onto the first profile registered,
  // whatever the stored order said. Why that path reads it is core's; kept
  // equal to the stored order (`auth.order` is hot-reloaded: no restart), a
  // path that reads either leads with the same account once both landed — a
  // write that did not leaves the move `pending`, and the watcher's minute
  // asks again (gatewayOwesLocked). Ids the config names that the store does
  // not hold are the owner's and stay, after the pool's (THE OWNER'S CONFIG
  // ORDER, takeOut gives it back). Only while the reader says what is there.
  let configOk = true;
  // openclaw.json's order once this pass is done with it.
  let configAfter: string[] | null = Array.isArray(configNow) ? configNow : null;
  if (chat.configOrderIds !== undefined && d.setConfigOrder) {
    // The stored order as it landed; else the order the pass wanted — never
    // the head the last paste left.
    const base = storedLanded && final.order ? [...final.order] : order;
    const current = configNow;
    if (current === undefined) {
      configOk = false;
      owed.push("config order");
    } else {
      const stored = new Set(final.profiles.map((p) => p.profileId));
      const extras = (current ?? []).filter((id) => !stored.has(id) && !base.includes(id) && !isPoolProfile(id));
      const wantConfig = [...base, ...extras];
      const same = Array.isArray(current) && current.length === wantConfig.length && current.every((id, i) => id === wantConfig[i]);
      if (wantConfig.length > 0 && !same) {
        // The owner's own order, before the pool first writes over it: as the
        // pass found it, without what this pass's own pastes put at its head.
        const found = (chat.configOrderIds ?? []).filter((id) => !isPoolProfile(id));
        let snapshotOk = true;
        if (chat.configOrderIds && found.length > 0 && !marker.config && !marker.ownerConfig) {
          marker.ownerConfig = found;
          // Not written over until it is recorded: takeOut gives it back from there.
          snapshotOk = await writeOrderMarker(marker);
          if (!snapshotOk) delete marker.ownerConfig;
        }
        const setConfig = d.setConfigOrder;
        if (snapshotOk && await attempt("openclaw.json's account order", () => setConfig(wantConfig))) {
          configAfter = wantConfig;
          // One the pool created is the pool's to take out again (takeOut).
          if (current === null && !marker.config) {
            marker.config = true;
            await writeOrderMarker(marker);
          }
        } else {
          configOk = false;
          owed.push("config order");
        }
      }
    }
  }

  // The order core goes by: the stored one, else openclaw.json's.
  const effective = final.order && final.order.length > 0 ? final.order : configControls ? configAfter : final.order;
  const orderLanded = storedLanded || (configControls && leadsWith(configAfter, order));
  if (!orderLanded) owed.push("order");

  // The account the gateway must lead with: the active one, when the gateway
  // can hold it; else the first it holds (an API key or the Terminal sign-in
  // is active, or none can answer).
  const active = pool.accounts.find((a) => a.id === pool.activeId) ?? null;
  const target = active && wanted.includes(active) && effectiveStatus(active, now) === "ok"
    ? active
    : pool.accounts.find((a) => order[0] === poolProfileId(a.id)) ?? null;
  // None to lead with: every account the gateway holds is limited and left
  // out for the owner's own sign-in, which the order leads with
  // (gatewayOrder). What has to land is that order.
  const limitedAll = pool.accounts
    .filter((a) => a.kind === "oauth" && effectiveStatus(a, now) === "limited")
    .sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0));
  const onSignIn = !target && limitedAll.length > 0 && order.length > 0 && !order.some((id) => held.has(id)) && !isPoolProfile(order[0]);
  const targetId = target ? poolProfileId(target.id) : null;
  const targetHeld = targetId ? final.profiles.find((p) => p.profileId === targetId) : undefined;
  const targetToken = targetId ? tokens.get(targetId) : undefined;
  // ...and openclaw.json's order with it: a config head left on the last
  // paste is a lead that has not landed for the paths that read it.
  const leadOk = configOk && (onSignIn
    ? orderLanded
    : !!targetHeld && orderLanded && effective?.[0] === targetId && (!targetToken || targetHeld.fingerprint === targetToken.fingerprint));
  // The mirror names the pool account core's stored order actually leads
  // with — the target once its write and the order have landed — `pending`
  // until they have; with the owner's sign-in leading, the account back
  // first, which the chat is still on the pool for. Null only when the
  // gateway holds none of the pool's accounts at all.
  const backFirst = onSignIn ? limitedAll[0] : undefined;
  const leadingId = (effective ?? []).find((id) => held.has(id)) ?? (targetHeld ? targetId : null) ?? (backFirst ? poolProfileId(backFirst.id) : null) ?? [...held][0] ?? null;
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
  } else if (onSignIn && backFirst) {
    // Every account out for the owner's sign-in: the chat is still the
    // pool's, on the account back first.
    const mirror = pool.gateway;
    const pending = !leadOk;
    if (!mirror || mirror.accountId !== backFirst.id || mirror.pending !== pending) {
      await setGatewayMirror({ accountId: backFirst.id, fingerprint: mirror?.accountId === backFirst.id ? mirror.fingerprint : NO_TOKEN_HELD, expiresAt: null, at: mirror && mirror.accountId === backFirst.id ? mirror.at : now, pending });
    }
  } else if (pool.gateway) {
    await setGatewayMirror(null);
  }
  if (changed > 0 || owed.length > 0) {
    const first = target ? `${target.id} first` : onSignIn ? `none of them in the order, every one limited: the owner's own sign-in (${order[0]}) first` : "none first";
    console.error(`[anthropic-gateway] the gateway holds ${held.size} Anthropic account(s) of the pool, ${first}${owed.length > 0 ? `; still owed: ${owed.join(", ")}` : ""}`);
  }
  if (offlineFailed) return outcome("failed", "gateway_restart_failed", held.size);
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
  if (ours.length === 0 && !marker.stored && !marker.config && !marker.ownerConfig) {
    if (pool.gateway) await setGatewayMirror(null);
    return outcome("skipped", why);
  }
  for (const profile of ours) await attempt(`taking ${profile.profileId} out`, () => d.logout(profile.profileId, agent));
  if (marker.stored) {
    const now = d.read();
    if (now.kind === "present" && now.order !== null) await attempt("clearing the account order", () => d.order([], agent));
  }
  if (marker.config) await attempt("openclaw.json's account order", () => d.unsetConfigOrder());
  // The owner's own config order, as it was before the pool wrote over it.
  let ownerLeft = false;
  if (marker.ownerConfig && d.setConfigOrder) {
    const setConfig = d.setConfigOrder;
    const back = marker.ownerConfig;
    ownerLeft = !(await attempt("giving openclaw.json's account order back", () => setConfig(back)));
  }
  const left = d.read();
  if (left.kind === "unreadable") return outcome("failed", "write_lost", changed());
  const owed = left.kind === "present" ? left.profiles.filter((p) => isPoolProfile(p.profileId)).map((p) => p.profileId) : [];
  const storedLeft = marker.stored && left.kind === "present" && left.order !== null;
  const configLeft = marker.config && (await d.chat())?.configOrder !== false;
  await writeOrderMarker({ stored: storedLeft, config: configLeft, ...(ownerLeft && marker.ownerConfig ? { ownerConfig: marker.ownerConfig } : {}) });
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
    const result = await syncLocked();
    await bindCronsLocked();
    return result;
  });
}

/** Bring the gateway in line with the pool now — after the owner changed it. Never throws. */
export async function syncGatewayNow(): Promise<SwapConsumerOutcome> {
  try {
    return await runtime().lock(async () => {
      const result = await syncLocked();
      await bindCronsLocked();
      return result;
    });
  } catch (err) {
    console.error("[anthropic-gateway] could not bring the gateway in line with the pool:", err instanceof Error ? err.message : err);
    return outcome("failed", "error");
  }
}

export type UseForChatResult =
  /** `warning`: the model route failed, yet the chat's model is on Claude (landed, or was already) — what it reported. */
  | { ok: true; outcome: SwapConsumerOutcome; warning?: string }
  /**
   * `model_not_set`: the chat did not move and the accounts are out again.
   * `model_unknown`: the model route failed and openclaw.json could not be
   * read to tell whether the chat moved — the accounts are left in, for the
   * keeper to settle.
   */
  | { ok: false; code: "no_gateway" | "no_claude_account" | "agent_unsupported" | "gateway_write_failed" | "model_not_set" | "model_unknown"; error: string; status: number };

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
    const result = await putChatOnPoolLocked(setModel);
    // Its passes can paste (a renewal that was due goes in with the accounts),
    // and the chat's model has moved: the automations follow in the same step,
    // as after every other pass — not a watcher minute later, when a paste's
    // new lifetime has already refused their next run (TASK-2533).
    if (!(result.ok === false && result.code === "no_claude_account")) await bindCronsLocked();
    return result;
  });
}

/** putChatOnPool's work, under the gateway lock. */
async function putChatOnPoolLocked(setModel: () => Promise<{ ok: true } | { ok: false; error: string; status: number }>): Promise<UseForChatResult> {
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
  // A throw is a refusal too: the accounts are already in, and the same
  // re-read below must decide whether they stay.
  const set = await setModel().catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err), status: 500 }));
  if (!set.ok) {
    // A refusal is not proof the chat stayed where it was: the model route
    // can fail after `agents.defaults.model.primary` landed. openclaw.json
    // decides. On Claude, the accounts are what the chat now runs on, so the
    // move is done — taken out, they could leave it with no credential at all.
    const chat = await deps().chat();
    if (chat?.onAnthropic) {
      console.error(`[anthropic-gateway] the chat's model landed on Claude though the model route answered ${set.status}; the accounts stay`);
      return { ok: true, outcome: synced, warning: `The chat now runs on these accounts, but setting its model reported: ${set.error}` } as const;
    }
    // Unknown is not "off": nothing is taken out, and the keeper settles it.
    if (chat === null) {
      return { ok: false, code: "model_unknown", error: `Whether the chat moved could not be read, so the accounts stay in until it can be. Setting its model reported: ${set.error}`, status: set.status } as const;
    }
    // The chat did not move: take the accounts out again rather than leave
    // the card saying the chat runs on them, with nothing to press.
    await syncLocked();
    return { ok: false, code: "model_not_set", error: set.error, status: set.status } as const;
  }
  console.error("[anthropic-gateway] the owner put the chat on the box's Claude accounts");
  return { ok: true, outcome: synced } as const;
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

/**
 * Something the last pass owes that cannot wait for the keeper's ten minutes
 * (TASK-2533) — two cheap reads, each watcher minute:
 *  - a limited pool account still in the gateway while one that answers (or
 *    the owner's sign-in) is: its CLI-bound sessions stay on it until it is
 *    out. The pool records such a limit without moving the active account
 *    (a usage reading, a coding run), and then no swap comes;
 *  - openclaw.json's order not leading with the stored order's head (a config
 *    write that was refused, or a paste since).
 * Answers what is owed, as a key the minute's back-off compares (null: nothing).
 */
async function gatewayOwesLocked(now: number): Promise<string | null> {
  const d = deps();
  const store = d.read();
  if (store.kind !== "present") return null;
  const pool = await readPoolState();
  const inGateway = (a: AnthropicAccount) => store.profiles.some((p) => p.profileId === poolProfileId(a.id));
  const oauth = pool.accounts.filter((a) => a.kind === "oauth");
  // The same tests syncLocked's logout makes (signInNow): an account of the
  // pool that answers in the gateway, else the owner's own sign-in.
  const answers = oauth.some((a) => effectiveStatus(a, now) === "ok" && inGateway(a))
    || otherProfiles(store).some((p) => isOwnSubscription(p, now));
  const limitedIn = answers ? oauth.filter((a) => effectiveStatus(a, now) === "limited" && inGateway(a)).map((a) => a.id).sort() : [];
  if (limitedIn.length > 0) return `out:${limitedIn.join(",")}`;
  if (!store.profiles.some((p) => isPoolProfile(p.profileId)) || !store.order?.length) return null;
  const chat = await d.chat();
  if (!chat?.onAnthropic || chat.configOrderIds === undefined || !d.setConfigOrder) return null;
  const head = chat.configOrderIds === null ? null : chat.configOrderIds[0] ?? null;
  return head !== store.order[0] ? `config:${head ?? "none"}>${store.order[0]}` : null;
}

/**
 * Look at what core recorded, act on it, and bring the gateway's order in line
 * if anything changed — or if the gateway still owes something the minute
 * can do without a stop (gatewayOwesLocked; `noWindow`). A minute pass that
 * leaves the SAME thing owing (core refused the write, or what it needs is a
 * paste the keeper makes) waits two minutes, then four, … up to the keeper's
 * ten; anything newly owed — an account limited since — is acted on at once.
 */
export function noteGatewayCooldowns(now: number = Date.now()): Promise<number> {
  return runtime().lock(async () => {
    const acted = await noteCooldownsLocked(now);
    const state = runtime();
    if (acted > 0) {
      await syncLocked();
      await bindCronsLocked();
      return acted;
    }
    const owed = await gatewayOwesLocked(now);
    if (owed === null) {
      state.owedPasses = 0;
      state.owedKey = null;
      return acted;
    }
    if (owed === state.owedKey && state.owedPasses > 0 && now - state.owedPassAt < Math.min(WATCH_MS * 2 ** state.owedPasses, KEEPER_MS)) return acted;
    await syncLocked({ noWindow: true });
    await bindCronsLocked();
    const still = await gatewayOwesLocked(Date.now());
    state.owedPasses = still === null ? 0 : still === owed ? state.owedPasses + 1 : 1;
    state.owedPassAt = still === null ? 0 : now;
    state.owedKey = still;
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
    await bindCronsLocked();
    const failing = result.status === "failed" || result.code === "order_owed";
    state.keeperFailures = failing ? state.keeperFailures + 1 : 0;
    state.keeperFailedAt = failing ? now : 0;
    if (result.status === "failed") return "failed";
    if (result.code === "switched" || result.code === "switched_partly") return "synced";
    if (result.status === "ok") return "fresh";
    return result.count ? "synced" : "idle";
  });
}

// ── the automations ─────────────────────────────────────────────────────────

/**
 * Every automation that runs on Anthropic bound to the profile core's stored
 * order leads with — the account that can answer — after a move, a renewal's
 * paste, or a job the box has not adopted yet (src/lib/anthropic-cron-binding.ts).
 * Under the gateway lock, so it never reads the order halfway through a pass.
 * Only while the pool is in the gateway: with none of its accounts there, the
 * automations' accounts are the owner's business. Never throws; null when
 * there was nothing to bind to.
 */
async function bindCronsLocked(): Promise<CronBindingResult | null> {
  // Right after a pass's offline window the gateway was started again, and
  // its requests can find no answer yet: the automations of the profiles that
  // window pasted then stayed on the lifetime the paste replaced until the
  // watcher's next look, and a run in between was refused "account was
  // replaced" (seen on a lab board). The binding in the same step as the
  // paste waits for the gateway to answer and asks again.
  const state = runtime();
  const afterWindow = state.windowRan;
  state.windowRan = false;
  let result = await bindCronsOnce();
  const d = deps();
  for (let attempt = 1; afterWindow && d.ready && !d.absent() && (result === null || result.unread) && attempt <= POST_WINDOW_BIND_ATTEMPTS; attempt += 1) {
    if (!(await d.ready())) break;
    result = await bindCronsOnce();
  }
  if (afterWindow && result?.unread) console.error("[anthropic-gateway] the automations could not be read after the gateway started again; the watcher's next look binds them");
  return result;
}

/** One look at the automations (bindCronsLocked). */
async function bindCronsOnce(): Promise<CronBindingResult | null> {
  try {
    const d = deps();
    if (d.absent() || !d.cronBindings) return null;
    const store = d.read();
    if (store.kind !== "present") return null;
    const chat = await d.chat();
    if (!chat || chat.agent === null) return null;
    // The pool is the chat's: its accounts in the gateway, or every one of
    // them out for the owner's sign-in while they are limited.
    const now = Date.now();
    const pool = await readPoolState();
    const poolIn = store.profiles.some((p) => isPoolProfile(p.profileId))
      || (chat.onAnthropic && pool.accounts.some((a) => a.kind === "oauth" && effectiveStatus(a, now) === "limited"));
    // A static token past its end is no lead (an oauth sign-in core refreshes itself).
    const usable = (id: string) => store.profiles.find((p) => p.profileId === id && !p.fenced && p.fingerprint !== null
      && !(p.type === "token" && p.expires !== null && p.expires <= now));
    // The order a turn resolves: the stored one, else openclaw.json's, else the store's own.
    const order = store.order ?? chat.configOrderIds ?? store.profiles.map((p) => p.profileId);
    // A limited account of the pool's is no lead while another is usable: an
    // order write that did not land can leave one at the head (it is still in
    // the store when its logout waits for an account that answers).
    const limitedPool = (id: string) => isPoolProfile(id)
      && pool.accounts.some((a) => poolProfileId(a.id) === id && effectiveStatus(a, now) === "limited");
    // ...and only an account core HOLDS THE POOL'S CURRENT TOKEN of (TASK-2533,
    // the owner's box 2026-11-15 08:37: "still owed" after a refused paste). A
    // binding captures the profile's authorization lifetime, and the paste still
    // owed gives the profile a new one — an automation bound before it would be
    // refused again the moment it lands. Such an account is skipped: the jobs
    // go to the first account in the order whose token is in, and follow the
    // lead in the same pass as its paste once it is.
    const skipped: string[] = [];
    const pick = async (accept: (id: string) => boolean): Promise<ProviderAuthProfile | undefined> => {
      for (const id of order) {
        const profile = usable(id);
        if (!profile || !accept(id)) continue;
        if (await coreHoldsCurrentToken(profile)) return profile;
        skipped.push(id);
      }
      return undefined;
    };
    const lead = chat.onAnthropic ? (await pick((id) => !limitedPool(id))) ?? (await pick(() => true)) : undefined;
    const skippedIds = [...new Set(skipped)];
    const skippedKey = skippedIds.join(",") || null;
    if (skippedKey !== runtime().bindSkipped) {
      runtime().bindSkipped = skippedKey;
      if (skippedKey) console.error(`[anthropic-gateway] automations are not bound to ${skippedKey} yet: core does not hold the pool's current token of ${skippedIds.length > 1 ? "them" : "it"} (a paste is owed), and a binding made now would be replaced when it lands${lead ? `; they follow ${lead.profileId} meanwhile` : ""}`);
    }
    // With the pool in, every Anthropic job is the box's to bind. With it out,
    // only the ones the box adopted: onto what leads now, or given back.
    if (poolIn && !lead) return null;
    if (!poolIn && Object.keys(await d.cronBindings.read().catch(() => ({}))).length === 0) return null;
    const target: CronBindingTarget | null = lead ? { profileId: lead.profileId, authorization: lead.authorization ?? lead.fingerprint } : null;
    // Given back (the pool left): the account a job's model runs on now — the
    // first profile core holds for that provider that is not the pool's (for
    // Anthropic, the owner's own sign-in). The pool's profile it was bound to
    // is gone, and core changes a job's account only on a `model@profile`.
    const accountFor = (model: string): string | null => {
      const slash = model.indexOf("/");
      // A bare Claude model (`claude-sonnet-5-5`) is Anthropic's, as the planner takes it.
      const provider = slash > 0 ? model.slice(0, slash) : /^claude/i.test(model.trim()) ? PROVIDER : null;
      if (!provider) return null;
      const read = provider === PROVIDER ? store : d.readProvider?.(provider);
      if (!read || read.kind !== "present") return null;
      const fit = (id: string) => !isPoolProfile(id) && read.profiles.some((p) => p.profileId === id && !p.fenced && p.fingerprint !== null
        && !(p.type === "token" && p.expires !== null && p.expires <= now));
      return (read.order ?? []).find(fit) ?? read.profiles.map((p) => p.profileId).find(fit) ?? null;
    };
    return await bindCronsToTarget(
      { call: d.call, readRecords: d.cronBindings.read, writeRecords: d.cronBindings.write },
      {
        target,
        defaultModel: chat.model ?? null,
        isPoolProfile,
        onlyAdopted: !poolIn,
        accountFor,
        defaultIsMain: chat.defaultIsMain !== false,
        refused: runtime().cronRefusals,
        reported: runtime().cronReported,
        heldProfiles: new Set(store.profiles.map((p) => p.profileId)),
      },
    );
  } catch (err) {
    console.error("[anthropic-gateway] could not give the automations the account the gateway leads with:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The watcher's look at the automations: a job made since, or an adoption a restarting gateway refused. */
export function bindGatewayCrons(): Promise<CronBindingResult | null> {
  return runtime().lock(() => bindCronsLocked());
}

/**
 * Anthropic's own word on every pool account the gateway holds that is meant
 * to answer (TASK-2533). OpenClaw 2026.11.3 records no cooldown when a Claude
 * CLI run hits a five-hour or weekly limit, so core's failure state — what
 * noteGatewayCooldowns reads — never says it; and a CLI session stays on the
 * account it was bound to, so ANY held account, not only the lead, can run out
 * through its own sessions. The pool's own usage reading records a spent
 * window as the account's limit until its reset and moves the active account
 * off it (readAccountUsage); the gateway follows that like any other move.
 *
 * One ask a watcher tick, the lead first: each held account is asked once in
 * LEAD_USAGE_MS when Anthropic answered — the endpoint sees no more than the
 * pool's own reading life — and again after USAGE_RETRY_MS when it did not
 * (429, 401, nothing). A reading someone else took is no stand-in: the box asks.
 * Never throws.
 */
export async function lookAtLeadUsage(now: number = Date.now()): Promise<void> {
  const state = runtime();
  const d = deps();
  if (d.absent() || now - state.leadUsageAt < USAGE_TICK_MS) return;
  try {
    const store = d.read();
    if (store.kind !== "present") return;
    const pool = await readPoolState();
    const lead = pool.gateway?.accountId ?? null;
    const lastAsked = (id: string) => Math.max(state.usageAnsweredAt.get(id) ?? 0, state.usageFailedAt.get(id) ?? 0);
    const held = pool.accounts.filter((a) => a.kind === "oauth" && effectiveStatus(a, now) === "ok"
      && store.profiles.some((p) => p.profileId === poolProfileId(a.id) && !p.fenced && p.fingerprint !== null));
    const due = held
      .filter((a) => now - (state.usageAnsweredAt.get(a.id) ?? Number.NEGATIVE_INFINITY) >= LEAD_USAGE_MS
        && now - (state.usageFailedAt.get(a.id) ?? Number.NEGATIVE_INFINITY) >= USAGE_RETRY_MS)
      // The lead first, then the one asked longest ago, whatever it answered:
      // accounts that keep failing must not keep another from ever being asked.
      .sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : lastAsked(a.id) - lastAsked(b.id)));
    const account = due[0];
    if (!account) return;
    state.leadUsageAt = now;
    const reading = await readAccountUsage(account.id, 0);
    if (reading) {
      state.usageAnsweredAt.set(account.id, now);
      state.usageFailedAt.delete(account.id);
    } else {
      state.usageFailedAt.set(account.id, now);
    }
  } catch (err) {
    console.error("[anthropic-gateway] could not ask Anthropic about the accounts the gateway holds:", err instanceof Error ? err.message : err);
  }
}

/**
 * A gateway turn died on an Anthropic limit and no account can be named: ask
 * Anthropic about every held account that is meant to answer, now (TASK-2533,
 * the same reading the watcher spreads over its ticks). Never throws.
 */
async function readHeldUsageNow(): Promise<void> {
  try {
    const d = deps();
    const store = d.read();
    if (store.kind !== "present") return;
    const now = Date.now();
    const pool = await readPoolState();
    const state = runtime();
    const held = pool.accounts.filter((a) => a.kind === "oauth" && effectiveStatus(a, now) === "ok"
      && store.profiles.some((p) => p.profileId === poolProfileId(a.id)));
    await Promise.all(held.map(async (a) => {
      // Asked now: a reading taken before the turn failed says nothing about
      // it (an ask already in flight is shared, readAccountUsage).
      const reading = await readAccountUsage(a.id, 0);
      if (reading) {
        state.usageAnsweredAt.set(a.id, now);
        state.usageFailedAt.delete(a.id);
      } else {
        state.usageFailedAt.set(a.id, now);
      }
    }));
  } catch {
    // The watcher's ticks ask again.
  }
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
  // The account each automation the box bound runs on (TASK-2533): a run that
  // died on its limit names that account, so the pool records the limit at
  // once — 2026.11.3 records no cooldown for a Claude CLI limit.
  const bindings = await (d.cronBindings?.read() ?? Promise.resolve({} as CronBindingRecords)).catch(() => ({} as CronBindingRecords));
  let heldRead = false;
  let unnamed = false;
  for (const job of parseCronJobs(payload)) {
    if (job.lastRunAtMs === null || job.lastRunAtMs <= since) continue;
    newest = Math.max(newest, job.lastRunAtMs);
    if (job.lastStatus !== "error" || !mentionsAnthropic(job.lastError)) continue;
    // The account THAT run used: only an adoption core had confirmed before
    // it started names it. A provisional record names the account the job is
    // being moved to, and a re-binding after the run (the swap that the same
    // limit caused) names the account it was moved to — neither ran it.
    const record = bindings[job.id];
    const bound = record && !record.provisional && (record.boundAt ?? record.at) <= job.lastRunAtMs ? record.profileId : null;
    const boundAccount = bound && isPoolProfile(bound) ? pool.accounts.find((a) => poolProfileId(a.id) === bound) ?? null : null;
    // A limit no account can be named for: Anthropic's word on every held
    // account first (once a scan), so a spent active account is the pool's
    // limit — and the swap under way — before the retry below can be sent. A
    // bare rate limit (a throttle, as the swap reads it) keeps its retry a
    // minute later on the same account, so its ask comes after the report —
    // but not a second one inside the throttle window: the swap takes that
    // one the limit's way, and its retry may drain at once.
    if (!boundAccount) {
      unnamed = true;
      const throttle = classifyAnthropicFailure(job.lastError, now, { transientRate: true })?.type === "throttled"
        && !throttleSeenRecently(null, now);
      if (!throttle && !heldRead) {
        heldRead = true;
        await readHeldUsageNow();
      }
    }
    const on = heldRead ? (await readPoolState()).activeId : pool.activeId;
    const result = await reportAnthropicFailure({
      text: job.lastError,
      source: "cron",
      accountId: boundAccount ? boundAccount.id : null,
      retry: {
        // Per account the pool is on once core's record is in (the watcher
        // reads it first): a run that fails again on the account it was moved
        // to is a new failure, and earns one retry of its own on the next.
        key: `cron:${job.id}:${on ?? "none"}`,
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
  if (unnamed && !heldRead) await readHeldUsageNow();
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
  // The turn names no account, and a Claude CLI limit leaves no cooldown on
  // OpenClaw 2026.11.3: Anthropic's word on every held account first (a
  // session can be bound to one that is not the lead), so a spent one is the
  // pool's limit — and out of the gateway in the pass below — before the
  // retry is sent to the same session.
  await readHeldUsageNow();
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
    // A limited account is out of the gateway until its reset (syncLocked):
    // at the pool's reset wake it goes back in when it is the one that can
    // answer, not at the keeper's next pass.
    onLimitReset(() => void syncGatewayNow());
  }
  if (!state.keeper) {
    state.keeper = setInterval(() => void guarded(() => keepGatewayMirror()), KEEPER_MS);
    state.keeper.unref?.();
  }
  if (!state.watcher) {
    state.watcher = setInterval(() => void guarded(async () => {
      await noteGatewayCooldowns();
      await lookAtLeadUsage();
      await scanGatewayCrons();
      await bindGatewayCrons();
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
  state.earlyRenewedAt.clear();
  state.leadUsageAt = 0;
  state.usageAnsweredAt.clear();
  state.usageFailedAt.clear();
  state.cronRefusals.clear();
  state.cronReported.clear();
  state.owedPasses = 0;
  state.owedPassAt = 0;
  state.owedKey = null;
  state.pasteRefusals.clear();
  state.limitedOut.clear();
  state.windowRan = false;
}
