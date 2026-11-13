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

import { spawnOpenclawCli, restartGateway, gatewayIsAbsent } from "@/lib/openclaw-config";
import { gatewayWsCall, GatewayWsUnavailableError } from "@/lib/openclaw-gateway-ws";
import { readGatewayProviderAuth } from "@/lib/openclaw-auth-store";
import { runUnitJob } from "@/lib/gateway-unit-job";


/** One CLI start-up on a Jetson is 10-12 s; the gateway's own write is quicker. */
const AUTH_TIMEOUT_MS = 60_000;

export interface AuthOpsDeps {
  rpc: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  cli: (args: string[], options: { stdinData?: string; timeoutMs: number }) => Promise<string>;
  /** The provider's profile ids in the gateway's store, or null when it cannot be read. */
  storeProfiles: (provider: string) => string[] | null;
  stopGateway: () => Promise<void>;
  startGateway: () => Promise<void>;
}

const defaultDeps: AuthOpsDeps = {
  rpc: (method, params, timeoutMs) => gatewayWsCall(method, params, { timeoutMs }),
  cli: (args, options) => spawnOpenclawCli(args, options),
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
  startGateway: () => restartGateway(),
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

type Online<T> = { answered: true; result: T } | { answered: false };

/** The gateway's answer, or `answered: false` when no gateway is there to give one. */
async function online<T>(method: string, params: Record<string, unknown>): Promise<Online<T>> {
  if (gatewayIsAbsent()) return { answered: false };
  try {
    return { answered: true, result: (await deps.rpc(method, params, AUTH_TIMEOUT_MS)) as T };
  } catch (err) {
    if (err instanceof GatewayWsUnavailableError) return { answered: false };
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
  const answer = await online<{ profileId?: unknown; warning?: unknown }>("models.authSetApiKey", { provider, apiKey: key });
  if (answer.answered) {
    const landed = typeof answer.result?.profileId === "string" && answer.result.profileId ? answer.result.profileId : profileId;
    if (landed !== profileId) {
      console.warn(`[openclaw-auth] the gateway saved the ${provider} key at ${landed}, not ${profileId}`);
    }
    const warning = typeof answer.result?.warning === "string" && answer.result.warning ? answer.result.warning : undefined;
    return { via: "gateway", profileId: landed, ...(warning ? { warning } : {}) };
  }
  await deps.cli(["models", "auth", "paste-api-key", "--provider", provider, "--profile-id", profileId], {
    stdinData: key + "\n",
    timeoutMs: AUTH_TIMEOUT_MS,
  });
  return { via: "cli", profileId };
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
  const answer = await online("models.authLogout", { provider, profileIds: wanted, ...agentParam(agentId) });
  if (answer.answered) return wanted;
  for (const id of wanted) {
    await deps.cli(["models", "auth", "logout", id, "--yes", ...agentArgs(agentId)], { timeoutMs: AUTH_TIMEOUT_MS });
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
  const answer = await online("models.authOrderSet", { provider, ...(full.length > 0 ? { profileIds: full } : {}), ...agentParam(agentId) });
  if (answer.answered) return;
  await deps.cli(
    [...(full.length > 0 ? ["models", "auth", "order", "set", "--provider", provider, ...full] : ["models", "auth", "order", "clear", "--provider", provider]), ...agentArgs(agentId)],
    { timeoutMs: AUTH_TIMEOUT_MS },
  );
}

/**
 * Stop the gateway through its service owner for offline work that runs on
 * its own lifecycle (a memory index pass); `startOpenclawGatewayAfterOffline`
 * starts it again. Neither does anything on a box with no gateway.
 */
export async function stopOpenclawGatewayForOffline(): Promise<void> {
  if (gatewayIsAbsent()) return;
  await deps.stopGateway();
}

/** Start the gateway after `stopOpenclawGatewayForOffline`. */
export async function startOpenclawGatewayAfterOffline(): Promise<void> {
  if (gatewayIsAbsent()) return;
  await deps.startGateway();
}

/**
 * Run `work` (CLI commands that 2026.11.3 accepts only offline) with the
 * gateway stopped through its service owner, and start the gateway again
 * whatever `work` did. A box with no gateway answering runs `work` as it is.
 */
export async function withOpenclawGatewayStopped<T>(work: () => Promise<T>): Promise<T> {
  if (gatewayIsAbsent()) return work();
  await deps.stopGateway();
  try {
    return await work();
  } finally {
    await deps.startGateway();
  }
}
