/**
 * Signing the box out of its ClawBox AI account — Settings → AI, the ClawBox
 * AI row's "Sign out" (POST /setup-api/ai-models/clawai/sign-out).
 *
 * ClawBox AI is the box's default provider out of the box, and until this
 * there was no way to sign out of it short of the Terminal: the provider list
 * only has a switch, locked on the default, and the configure route only ever
 * WRITES the credential. Signing out removes every copy of the device's
 * ClawBox AI credential and every record ClawBox keeps about the account
 * behind it, so the next sign-in starts from nothing:
 *
 *  1. The gateway's auth profile, NATIVELY: `openclaw models auth logout
 *     deepseek:default --yes` removes it from the store the gateway reads and
 *     drops it from `auth.profiles` and every `auth.order` (docs/cli/models.md,
 *     the pinned core). What it leaves — an `auth.profiles` entry with no store
 *     row behind it, the token inline in `models.providers.deepseek.apiKey`, the
 *     copy the image provider reads at `models.providers.litellm.apiKey` — goes
 *     with `config unset`. The provider definition itself stays: the default
 *     model still names ClawBox AI, and the chat answers a turn on it with the
 *     "Sign in to ClawBox AI again" line rather than a provider it cannot find.
 *  2. ClawBox's own records of the account, in ONE store write: the token
 *     (`clawai_token`), the device badge and the plan (`clawai_tier`,
 *     `clawai_plan_tier`, the pair the boot scripts read), and the owner's
 *     ClawBox AI model pick. Left behind, they are the stale profile: a
 *     re-login with another account kept the old account's plan until the
 *     portal next answered, and its model pick.
 *  3. The memory of a refused credential (`forgetClawaiCredentialRefusal`,
 *     which also retires any plan lookup still in flight for the old token),
 *     and a finished device-login session, whose `complete` answer would tell
 *     an open sign-in card that the account it just left is signed in.
 *
 * Then the gateway is brought onto it the way the configure route does — hot
 * applied and confirmed, a restart otherwise — and the result is READ BACK:
 * a credential still on the box afterwards is a failure, never a success.
 *
 * OpenClaw only. A Hermes box keeps the credential in Hermes' own config,
 * whose `providers.clawai` block is also what says "configured" there; that
 * edition's sign-out is not built, and the route says so rather than clearing
 * half of it.
 *
 * SERVER ONLY.
 */

import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { CLAWAI_PLAN_TIER_KEY } from "@/lib/clawai-plan-tier";
import { clearClawAiSession, isClawAiSessionExpired, readClawAiSession } from "@/lib/clawai-connect";
import { get as getConfigValue, setMany } from "@/lib/config-store";
import { EXPLICIT_MODEL_PICKS_KEY, explicitPicksFrom, picksWithoutProvider } from "@/lib/explicit-model-pick";
import { awaitGatewayHotApply, diffConfigPaths, readGatewayConfigBaseline, restartGatewayAnsweringEarly } from "@/lib/gateway-hot-apply";
import { getActiveHarness } from "@/lib/harness";
import { forgetClawaiCredentialRefusal, resolveClawaiToken } from "@/lib/harness/credentials";
import { logSafe } from "@/lib/log-safe";
import { readGatewayAuthProfile } from "@/lib/openclaw-auth-store";
import { flushConfigWrites, readConfig, runOpenclawConfigUnset, spawnOpenclawCli, type OpenClawConfig } from "@/lib/openclaw-config";

/** The auth profile the configure route writes the device's key to. */
export const CLAWAI_AUTH_PROFILE_ID = `${CLAWBOX_AI_PROVIDER}:default`;

/** ClawBox's own config-store keys about the account (see the configure route). */
const CLAWAI_TOKEN_KEY = "clawai_token";
const CLAWAI_DEVICE_TIER_KEY = "clawai_tier";

const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;

export type ClawaiSignOutResult =
  | {
    ok: true;
    /** False when there was nothing to sign out of: the answer is the same. */
    changed: boolean;
    /** The gateway is restarting to drop the credential; the chat is back in a minute. */
    gatewayRestarting: boolean;
  }
  | {
    ok: false;
    kind: "not_supported" | "sign_in_in_progress" | "still_signed_in";
    error: string;
  };

async function readConfigOrNull(): Promise<OpenClawConfig | null> {
  try {
    return await readConfig();
  } catch {
    return null;
  }
}

function hasProfileEntry(config: OpenClawConfig | null): boolean {
  const profiles = config?.auth?.profiles;
  return !!profiles && Object.hasOwn(profiles, CLAWAI_AUTH_PROFILE_ID);
}

/** The config paths that still hold the account once `models auth logout` has run. */
function leftoverConfigPaths(config: OpenClawConfig | null, token: string | null): string[] {
  const providers = config?.models?.providers;
  const paths: string[] = [];
  if (hasProfileEntry(config)) paths.push(`auth.profiles.${CLAWAI_AUTH_PROFILE_ID}`);
  if (providers?.[CLAWBOX_AI_PROVIDER]?.apiKey !== undefined) paths.push(`models.providers.${CLAWBOX_AI_PROVIDER}.apiKey`);
  // Only OUR copy: the image provider's slot may hold an owner's own LiteLLM key.
  if (token && providers?.litellm?.apiKey === token) paths.push("models.providers.litellm.apiKey");
  return paths;
}

/** `getCodingAgentStatus().ready`, or undefined when it cannot be read (see the configure route). */
async function codingAgentReady(): Promise<boolean | undefined> {
  try {
    const { getCodingAgentStatus } = await import("@/lib/coding-agent");
    return (await getCodingAgentStatus()).ready;
  } catch {
    return undefined;
  }
}

/** Sign the box out of ClawBox AI — see the file header. Never throws. */
export async function signOutOfClawboxAi(): Promise<ClawaiSignOutResult> {
  if ((await getActiveHarness()) !== "openclaw") {
    return {
      ok: false,
      kind: "not_supported",
      error: "Signing out of ClawBox AI here is not available on this edition yet.",
    };
  }
  // A device login that is writing its token right now would land it after
  // this sign-out, and the box would be signed in to that account after all.
  const session = await readClawAiSession().catch(() => null);
  if (session?.status === "configuring" && !isClawAiSessionExpired(session)) {
    return {
      ok: false,
      kind: "sign_in_in_progress",
      error: "A ClawBox AI sign-in is finishing on this box. Wait for it to finish, then sign out.",
    };
  }

  const before = await readConfigOrNull();
  const token = await resolveClawaiToken();
  const storedToken = await getConfigValue(CLAWAI_TOKEN_KEY).catch(() => undefined);
  const stored = readGatewayAuthProfile(CLAWAI_AUTH_PROFILE_ID);
  const held = stored.kind === "present"
    || leftoverConfigPaths(before, token).length > 0
    || storedToken !== undefined
    || token !== null;
  // Every writer of `clawai_token` samples the coding agent's readiness before
  // its write (coding-agent-mcp-refresh.ts): a box with no ClawBox AI account
  // loses the coding tools, and the running agent must hear it.
  const readyBefore = held ? await codingAgentReady() : undefined;
  const baseline = held ? await readGatewayConfigBaseline() : null;

  // 1. The gateway's auth profile, natively, then what logout leaves behind.
  if (stored.kind === "present" || hasProfileEntry(before)) {
    try {
      // Unpinned, like the configure route's paste and its take-over: the core
      // resolves the same agent store for both.
      await spawnOpenclawCli(["models", "auth", "logout", CLAWAI_AUTH_PROFILE_ID, "--yes"], { timeoutMs: 60_000 });
    } catch (err) {
      // Not the answer: what is still there is removed below, and read back.
      console.warn(`[clawai/sign-out] models auth logout ${CLAWAI_AUTH_PROFILE_ID} failed:`, err instanceof Error ? logSafe(err.message) : err);
    }
  }
  for (const configPath of leftoverConfigPaths(await readConfigOrNull(), token)) {
    try {
      await runOpenclawConfigUnset(configPath, { uid: CLAWBOX_UID, gid: CLAWBOX_GID });
    } catch (err) {
      console.warn(`[clawai/sign-out] could not unset ${configPath}:`, err instanceof Error ? logSafe(err.message) : err);
    }
  }
  await flushConfigWrites().catch(() => undefined);

  // 2. ClawBox's records of the account, in one write. `undefined` deletes.
  const picks = explicitPicksFrom(await getConfigValue(EXPLICIT_MODEL_PICKS_KEY).catch(() => undefined));
  const withoutClawai = picksWithoutProvider(picks, "clawai");
  const withoutEither = picksWithoutProvider(withoutClawai ?? picks, CLAWBOX_AI_PROVIDER) ?? withoutClawai;
  try {
    await setMany({
      [CLAWAI_TOKEN_KEY]: undefined,
      [CLAWAI_DEVICE_TIER_KEY]: undefined,
      [CLAWAI_PLAN_TIER_KEY]: undefined,
      ...(withoutEither ? { [EXPLICIT_MODEL_PICKS_KEY]: withoutEither } : {}),
    });
  } catch (err) {
    console.warn("[clawai/sign-out] could not clear the account's records:", err instanceof Error ? logSafe(err.message) : err);
  }

  // 3. What the box remembers about the old credential.
  await forgetClawaiCredentialRefusal().catch(() => undefined);
  await clearClawAiSession().catch(() => undefined);

  // The gateway, onto the change: hot-applied and confirmed, else restarted.
  let gatewayRestarting = false;
  if (held) {
    const after = await readConfigOrNull();
    const hot = await awaitGatewayHotApply({
      baseline,
      configChanged: diffConfigPaths(before ?? {}, after ?? {}).length > 0,
      credentialsWritten: stored.kind === "present",
    });
    if (!hot.applied) {
      if (hot.why === "gateway-restarting") {
        gatewayRestarting = true;
      } else {
        console.log(`[clawai/sign-out] restarting the gateway: it did not confirm the sign-out (${hot.why})`);
        try {
          await restartGatewayAnsweringEarly();
          gatewayRestarting = true;
        } catch (err) {
          console.error("[clawai/sign-out] the gateway restart was refused:", err instanceof Error ? logSafe(err.message) : err);
        }
      }
    }
  }

  // Read back: never a success over a credential that is still here.
  const left: string[] = [];
  if (readGatewayAuthProfile(CLAWAI_AUTH_PROFILE_ID).kind === "present") left.push("the gateway's auth store");
  if (leftoverConfigPaths(await readConfigOrNull(), token).length > 0) left.push("openclaw.json");
  if ((await getConfigValue(CLAWAI_TOKEN_KEY).catch(() => undefined)) !== undefined) left.push("the ClawBox config store");
  if (left.length > 0) {
    return {
      ok: false,
      kind: "still_signed_in",
      error: `The ClawBox AI sign-in could not be removed from ${left.join(" and ")}. Try again; if it stays, restart the box and sign out again.`,
    };
  }

  if (readyBefore !== undefined) {
    const readyAfter = await codingAgentReady();
    if (readyAfter !== undefined) {
      try {
        const { refreshCodingAgentToolsIfReadinessChanged } = await import("@/lib/coding-agent-mcp-refresh");
        await refreshCodingAgentToolsIfReadinessChanged(readyBefore, readyAfter);
      } catch (err) {
        console.warn("[clawai/sign-out] could not refresh the coding agent's tools:", err instanceof Error ? err.message : err);
      }
    }
  }
  return { ok: true, changed: held, gatewayRestarting };
}
