/**
 * OpenClaw's system/agent credentials, written the way OpenClaw 2026.11.3
 * takes them (docs/cli/models.md, "Auth profiles", in the pinned core).
 *
 * While a gateway owns the state directory, 2026.11.3's CLI refuses every
 * `models auth` command but two: `paste-api-key` WITHOUT `--profile-id`,
 * which it hands to the gateway's `models.authSetApiKey`, and `login`. The
 * rest — `list`, `logout`, `order …`, `paste-token` — "require exclusive
 * offline ownership of the selected local state". 2026.10.9 ran all of them
 * locally beside a running gateway, which is what ClawBox did.
 *
 * So, with the gateway up, ClawBox asks the gateway itself, over the socket
 * it already holds (`gatewayWsCall`, operator.admin):
 *
 *   models.authSetApiKey {provider, apiKey}       the key, into the provider's
 *                                                 API-key profile
 *   models.authLogout    {provider, profileIds}   saved profiles out
 *   models.authOrderSet  {provider, profileIds?}  the order; omitted = clear
 *
 * and only a gateway that is not there to answer — stopped for a sign-in
 * lane or doctor, the installer, the gateway's own pre-start — gets the CLI,
 * offline, exactly as before. A gateway that answered with a refusal is never
 * retried through the CLI: the CLI would be refused for the same state.
 *
 * `paste-token` has no RPC (its credential type and expiry cannot be said
 * through the API-key one), so `withOpenclawGatewayStopped` runs it the way
 * the docs say: the gateway stopped through its service owner, the command
 * run offline, the gateway started again.
 */

import { spawnOpenclawCli, restartGateway, gatewayIsAbsent, gatewayReadyWaitMs } from "@/lib/openclaw-config";
import { gatewayWsCall, GatewayWsUnavailableError, waitForGatewayRpcReady } from "@/lib/openclaw-gateway-ws";
import { readGatewayProviderAuth } from "@/lib/openclaw-auth-store";
import { readUnitState, runUnitJob } from "@/lib/gateway-unit-job";
import { DATA_DIR } from "@/lib/config-store";
import fs from "fs";
import path from "@/lib/runtime-path";

/**
 * On disk while ClawBox holds the gateway stopped for offline work (a memory
 * index pass): a web server that exits in between leaves it behind, and its
 * next start puts the gateway back (`restoreOpenclawGatewayAfterCrash`).
 */
const OFFLINE_HOLD_PATH = path.join(DATA_DIR, ".openclaw-offline-hold.json");


/** One CLI start-up on a Jetson is 10-12 s; the gateway's own write is quicker. */
const AUTH_TIMEOUT_MS = 60_000;

export interface AuthOpsDeps {
  gatewayAuthRpc: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  offlineAuthCli: (args: string[], options: { stdinData?: string; timeoutMs: number }) => Promise<string>;
  /** The provider's profile ids in the gateway's store, or null when it cannot be read. */
  storeProfiles: (provider: string) => string[] | null;
  stopGateway: () => Promise<void>;
  startGateway: () => Promise<void>;
  /**
   * Is a gateway up or coming up, i.e. does one own (or is about to own) the
   * state? Only a unit that is down lets the CLI work offline.
   */
  gatewayUnitUp: () => Promise<boolean>;
  /** Wait for a gateway that is coming up to answer; false when it did not in time. */
  waitForGateway: () => Promise<boolean>;
}

const defaultDeps: AuthOpsDeps = {
  gatewayAuthRpc: (method, params, timeoutMs) => gatewayWsCall(method, params, { timeoutMs }),
  offlineAuthCli: (args, options) => spawnOpenclawCli(args, options),
  storeProfiles: (provider) => {
    const read = readGatewayProviderAuth(provider);
    if (read.kind === "no-store") return [];
    if (read.kind !== "present") return null;
    return read.profiles.map((p) => p.profileId);
  },
  stopGateway: async () => {
    const stop = await runUnitJob("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "stop", "clawbox-gateway.service"], {
      unit: "clawbox-gateway.service",
      timeoutMs: 15_000,
      settleBudgetMs: 45_000,
    });
    if (stop.kind === "in-flight") throw new Error("the gateway is still stopping");
  },
  startGateway: async () => {
    try {
      await restartGateway();
    } catch (err) {
      // The unit was started and is still coming up (a Jetson after heavy work
      // can take longer than the ready wait): not a failure of the offline
      // work, and every gateway request after this waits for a starting
      // gateway anyway (askOpenclawGateway). A refused start still throws.
      // By name, not `instanceof`: every module this one reaches is imported by
      // suites that mock openclaw-config, and a name needs no class there.
      if (err instanceof Error && err.name === "GatewayNotReadyError") {
        console.warn("[openclaw-auth] the gateway was started again and is still coming up");
        return;
      }
      throw err;
    }
  },
  gatewayUnitUp: async () => {
    const state = await readUnitState("clawbox-gateway.service");
    // A unit that cannot be asked is treated as up: the gateway's refusal is
    // honest, a CLI write around a live owner is not.
    if (!state) return true;
    return ["active", "activating", "reloading", "deactivating"].includes(state.activeState);
  },
  waitForGateway: () => waitForGatewayRpcReady(gatewayReadyWaitMs()),
};

let deps: AuthOpsDeps = defaultDeps;

/** Tests only. */
export function _setAuthOpsDepsForTests(next: Partial<AuthOpsDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

/** An agent named for the gateway request, or nothing (the core's default agent). */
function agentParam(agentId: string | undefined): { agentId?: string } {
  return agentId ? { agentId } : {};
}

/** The same agent for the offline CLI. */
function agentArgs(agentId: string | undefined): string[] {
  return agentId ? ["--agent", agentId] : [];
}

export type Online<T> = { answered: true; result: T } | { answered: false };

/** Thrown when a gateway owns the state but did not come up to take the request in time. */
export class OpenclawGatewayNotReadyError extends Error {
  constructor(method: string) {
    super(`The assistant is starting and did not answer ${method} in time. Try again in a minute.`);
    this.name = "OpenclawGatewayNotReadyError";
  }
}

/**
 * The gateway's answer, or `answered: false` when NO gateway owns the state
 * (its unit is down), which is when the offline CLI may run. A socket that
 * does not answer is not proof of that: a gateway that is starting already
 * owns the state (2026.11.3 refuses the CLI then too), so it is waited for and
 * asked again.
 */
async function askGatewayForAuth<T>(method: string, params: Record<string, unknown>): Promise<Online<T>> {
  return askOpenclawGateway<T>(method, params, AUTH_TIMEOUT_MS);
}

/**
 * Any gateway request with the same rule: answered by the gateway, or
 * `answered: false` only when no gateway owns the state (its unit is down);
 * a gateway that is starting is waited for and asked again.
 */
export async function askOpenclawGateway<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Online<T>> {
  if (gatewayIsAbsent()) return { answered: false };
  const ask = async (): Promise<Online<T>> => ({ answered: true, result: (await deps.gatewayAuthRpc(method, params, timeoutMs)) as T });
  try {
    return await ask();
  } catch (err) {
    if (!(err instanceof GatewayWsUnavailableError)) throw err;
  }
  if (!(await deps.gatewayUnitUp())) return { answered: false };
  if (!(await deps.waitForGateway())) throw new OpenclawGatewayNotReadyError(method);
  try {
    return await ask();
  } catch (err) {
    if (err instanceof GatewayWsUnavailableError) throw new OpenclawGatewayNotReadyError(method);
    throw err;
  }
}

export interface SavedApiKey {
  via: "gateway" | "cli";
  /** The profile the key landed in (the gateway picks the provider's API-key profile). */
  profileId: string;
  warning?: string;
}

/**
 * Save an API key for `provider` at `profileId` (ClawBox names
 * `<provider>:default`, the profile the gateway itself picks for a provider
 * with no other API-key profile). The key never touches argv.
 */
export async function saveOpenclawApiKey(provider: string, profileId: string, key: string): Promise<SavedApiKey> {
  // The gateway's models.authSetApiKey takes no profile id: it writes over
  // the provider's API-key profile, or — when the store holds none — creates
  // `<provider>:manual` (2026.11.3's resolveDefaultTokenProfileId), not the id
  // ClawBox names and checks. So the gateway takes the key only when the store
  // already holds `profileId`; a first save at it runs the documented offline
  // way (`paste-api-key --profile-id`), with the gateway stopped and started
  // again around it when one is up.
  const held = gatewayIsAbsent() ? null : deps.storeProfiles(provider);
  if (held === null || held.includes(profileId)) {
    const answer = await askGatewayForAuth<{ profileId?: unknown; warning?: unknown }>("models.authSetApiKey", { provider, apiKey: key });
    if (answer.answered) {
      const landed = typeof answer.result?.profileId === "string" && answer.result.profileId ? answer.result.profileId : profileId;
      const warning = typeof answer.result?.warning === "string" && answer.result.warning ? answer.result.warning : undefined;
      if (landed === profileId) return { via: "gateway", profileId: landed, ...(warning ? { warning } : {}) };
      // A provider with a `models.providers` entry gets `<provider>:manual`
      // from the gateway even beside an existing API-key profile (measured on
      // a board). The copy it just made goes again — never one it held
      // before — and the key is saved at ClawBox's id the offline way.
      console.warn(`[openclaw-auth] the gateway saved the ${provider} key at ${landed}, not ${profileId}; saving it at ${profileId} offline`);
      if (held !== null && !held.includes(landed)) {
        await askGatewayForAuth("models.authLogout", { provider, profileIds: [landed] });
      }
      await withOpenclawGatewayStopped(() => pasteOffline(provider, profileId, key));
      return { via: "cli", profileId };
    }
    await pasteOffline(provider, profileId, key);
    return { via: "cli", profileId };
  }
  if (await deps.gatewayUnitUp()) {
    await withOpenclawGatewayStopped(() => pasteOffline(provider, profileId, key));
  } else {
    await pasteOffline(provider, profileId, key);
  }
  return { via: "cli", profileId };
}

/** `paste-api-key --profile-id`, which 2026.11.3 runs only with no gateway owning the state. */
async function pasteOffline(provider: string, profileId: string, key: string): Promise<void> {
  await deps.offlineAuthCli(["models", "auth", "paste-api-key", "--provider", provider, "--profile-id", profileId], {
    stdinData: key + "\n",
    timeoutMs: AUTH_TIMEOUT_MS,
  });
}

/** The provider a profile id names (`deepseek:default` → `deepseek`). */
export function providerOfProfileId(profileId: string): string {
  return profileId.split(":")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Take saved profiles out of the gateway's store. Ids the store does not hold
 * are left out of the request (the gateway refuses a request naming one); an
 * id held only in openclaw.json metadata is the caller's to unset.
 * Returns the ids asked for.
 */
export async function logoutOpenclawAuthProfiles(provider: string, profileIds: string[], agentId?: string): Promise<string[]> {
  const ids = [...new Set(profileIds.filter((id) => typeof id === "string" && id.trim()))];
  if (ids.length === 0) return [];
  const held = deps.storeProfiles(provider);
  const wanted = held === null ? ids : ids.filter((id) => held.includes(id));
  if (wanted.length === 0) return [];
  const answer = await askGatewayForAuth("models.authLogout", { provider, profileIds: wanted, ...agentParam(agentId) });
  if (answer.answered) return wanted;
  for (const id of wanted) {
    await deps.offlineAuthCli(["models", "auth", "logout", id, "--yes", ...agentArgs(agentId)], { timeoutMs: AUTH_TIMEOUT_MS });
  }
  return wanted;
}

/**
 * Set the provider's profile order (`order` first, in that order), or clear
 * it (`null` or empty). The gateway takes an order only when it names every
 * profile it holds for the provider, so the store's other profiles follow
 * the ones asked for, and ids it does not hold are dropped.
 */
export async function setOpenclawAuthOrder(provider: string, order: string[] | null, agentId?: string): Promise<void> {
  const asked = [...new Set((order ?? []).filter((id) => typeof id === "string" && id.trim()))];
  const held = asked.length > 0 ? deps.storeProfiles(provider) : null;
  const full = asked.length === 0 ? [] : held === null ? asked : [...asked.filter((id) => held.includes(id)), ...held.filter((id) => !asked.includes(id))];
  const answer = await askGatewayForAuth("models.authOrderSet", { provider, ...(full.length > 0 ? { profileIds: full } : {}), ...agentParam(agentId) });
  if (answer.answered) return;
  if (full.length > 0) {
    await deps.offlineAuthCli(["models", "auth", "order", "set", "--provider", provider, ...full, ...agentArgs(agentId)], { timeoutMs: AUTH_TIMEOUT_MS });
  } else {
    await deps.offlineAuthCli(["models", "auth", "order", "clear", "--provider", provider, ...agentArgs(agentId)], { timeoutMs: AUTH_TIMEOUT_MS });
  }
}

/**
 * Stop the gateway through its service owner for offline work that runs on
 * its own lifecycle (a memory index pass); `startOpenclawGatewayAfterOffline`
 * starts it again. Neither does anything on a box with no gateway.
 */
export async function stopOpenclawGatewayForOffline(): Promise<void> {
  if (gatewayIsAbsent()) return;
  // No record, no stop: a gateway held stopped with nothing on disk to say so
  // would stay stopped if this server exited before starting it again.
  fs.writeFileSync(OFFLINE_HOLD_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\n", { mode: 0o600 });
  await deps.stopGateway();
}

/** Start the gateway after `stopOpenclawGatewayForOffline`. */
export async function startOpenclawGatewayAfterOffline(): Promise<void> {
  if (gatewayIsAbsent()) return;
  await deps.startGateway();
  fs.rmSync(OFFLINE_HOLD_PATH, { force: true });
}

/**
 * At the web server's start: an offline hold left by a server that exited
 * during it (its pid is gone) means the gateway may still be stopped, so it is
 * started again. A hold of this very process, or none, does nothing.
 */
export async function restoreOpenclawGatewayAfterCrash(): Promise<boolean> {
  let hold: { pid?: unknown } | null = null;
  try {
    hold = JSON.parse(fs.readFileSync(OFFLINE_HOLD_PATH, "utf8")) as { pid?: unknown };
  } catch {
    return false;
  }
  const pid = typeof hold?.pid === "number" ? hold.pid : 0;
  if (pid === process.pid) return false;
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      /* gone: the hold is an orphan */
    }
  }
  // A server that exited after writing the hold but before (or without)
  // stopping the gateway leaves a running gateway: that one is left alone and
  // only the hold goes.
  if (await deps.gatewayUnitUp()) {
    fs.rmSync(OFFLINE_HOLD_PATH, { force: true });
    return false;
  }
  console.warn("[openclaw-auth] the gateway was held stopped by a web server that has since exited; starting it again");
  await startOpenclawGatewayAfterOffline();
  return true;
}

/**
 * Run `work` (CLI commands that 2026.11.3 accepts only offline) with the
 * gateway stopped through its service owner, and start the gateway again
 * whatever `work` did. A box with no gateway answering runs `work` as it is.
 */
export async function withOpenclawGatewayStopped<T>(work: () => Promise<T>): Promise<T> {
  if (gatewayIsAbsent()) return work();
  // The stop is inside the `try`: a stop that throws (a job still running when
  // its client gave up) may still stop the unit afterwards, and the gateway
  // must be started again on every way out. A start issued while that stop is
  // pending cancels it; `work` then meets a gateway that owns the state, and
  // says so, rather than leaving the assistant stopped.
  let failure: { error: unknown } | null = null;
  try {
    await deps.stopGateway();
    return await work();
  } catch (err) {
    failure = { error: err };
    throw err;
  } finally {
    try {
      await deps.startGateway();
    } catch (startErr) {
      // The first failure is the one to report; the start's is logged.
      if (!failure) throw startErr;
      console.error("[openclaw-auth] the gateway did not start again:", startErr instanceof Error ? startErr.message : startErr);
    }
  }
}
