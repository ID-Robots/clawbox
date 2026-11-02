/**
 * Signing the box out of ONE AI provider — Settings → AI, a connected row's
 * "Sign out of <Provider>" (POST /setup-api/providers/sign-out; ClawBox AI's
 * own POST /setup-api/ai-models/clawai/sign-out, PR #1369, is this same call).
 *
 * The provider list used to have a switch and nothing else for every row but
 * ClawBox AI's: a switch takes a provider out of routing and KEEPS its key, and
 * the configure route only ever writes one. Signing out removes every copy of
 * that provider's credential the box and the harness answering its chat keep,
 * and ClawBox's own records about it, so the next sign-in starts from nothing:
 *
 *  1. The harness's copies, through the harness's own tools — OpenClaw's auth
 *     profiles and openclaw.json (src/lib/provider-sign-out-openclaw.ts),
 *     Hermes' credential pool, config.yaml and .env
 *     (src/lib/provider-sign-out-hermes.ts). Each half names what it does and
 *     what it leaves.
 *  2. ClawBox's records, in the config store: the owner's model picks for the
 *     provider, its unavailable-model marks and its "this provider answered"
 *     mark. For ClawBox AI also the token, the device badge and the plan
 *     (`clawai_token`, `clawai_tier`, `clawai_plan_tier`, in ONE write), the
 *     memory of a refused credential and a finished device login, whose
 *     `complete` would tell an open sign-in card that the account it just left
 *     is signed in. Left behind, they are the stale profile: a re-login with
 *     another account kept the old account's plan and its model pick.
 *  3. The running harness brought onto it — OpenClaw hot-applied and
 *     confirmed, a restart otherwise; Hermes restarted — and a restart that was
 *     refused is a failure, because the running harness may still hold the old
 *     sign-in. Then the copies the config's own backups hold
 *     (src/lib/credential-copies.ts).
 *  4. READ BACK with the strict readers: a credential still on the box, or a
 *     store that cannot be read to say it is gone, is `still_signed_in`, never
 *     a success.
 *
 * THE DEFAULT. Signing out must not leave the assistant on a provider nobody
 * signed in to, so the DEFAULT provider's sign-out is refused (`is_default`,
 * the row's button is locked with the same "make another provider the default
 * first" hint as its switch) — for every provider but ClawBox AI, which keeps
 * #1369's rule: it is the box's own provider, the one a box with nothing else
 * would otherwise have no way out of, and its row stays the default reading
 * "Sign in again" while the chat answers with "Sign in to ClawBox AI again".
 * Another provider's sign-out never touches the default, so the chat goes on
 * answering on the one it is on.
 *
 * WHICH HARNESS. The active one. On a dual box ClawBox AI is also signed out
 * of the other one: its token is ClawBox's own account, and a harness switch
 * would otherwise find the old account still linked there. Any other
 * provider's sign-in is the harness's own, made on it and listed for it.
 *
 * Never an owner's other key: each half takes the row's provider's entries and
 * the values it removed, and a key another setting holds for the same vendor
 * (the cloud voice, the coding agent) is that setting's.
 *
 * SERVER ONLY.
 */

import { CLAWAI_PLAN_TIER_KEY } from "@/lib/clawai-plan-tier";
import { clearClawAiSession, isClawAiSessionConfiguring, readClawAiSession } from "@/lib/clawai-connect";
import { get as getConfigValue, getKnown, setMany } from "@/lib/config-store";
import { forgetClawboxAiPick, forgetProviderPicks } from "@/lib/explicit-model-pick";
import { getActiveHarnessSource, type Harness } from "@/lib/harness";
import { forgetClawaiCredentialRefusal, resolveClawaiToken } from "@/lib/harness/credentials";
import { resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import { readConfigStrict } from "@/lib/openclaw-config";
import { forgetUnavailableModels } from "@/lib/provider-model-availability";
import { prepareHermesSignOut } from "@/lib/provider-sign-out-hermes";
import { prepareOpenclawSignOut } from "@/lib/provider-sign-out-openclaw";
import type { HarnessSignOut } from "@/lib/provider-sign-out-types";
import { canonicalProviderId, isLocalProviderRow, normalizeProviderId, providerRowLabel } from "@/lib/provider-status";
import { forgetProviderVerified } from "@/lib/provider-verified";

/** ClawBox AI's row, on both harnesses. */
export const CLAWAI_ROW = "clawai";

/** ClawBox's own config-store keys about the ClawBox AI account (see the configure route). */
const CLAWAI_TOKEN_KEY = "clawai_token";
const CLAWAI_DEVICE_TIER_KEY = "clawai_tier";

/** A row id on either harness: OpenClaw's canonical ids and Hermes' slugs. */
const ROW_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The wire ids OpenClaw files a row's model picks and marks under, besides
 * the row's own: ClawBox AI is `deepseek` on the wire, and OpenAI's ChatGPT
 * sign-in is the picker's `codex` row.
 */
const OPENCLAW_SLOTS: Readonly<Record<string, readonly string[]>> = {
  clawai: ["deepseek"],
  openai: ["openai-codex", "codex"],
};

export type ProviderSignOutRefusal =
  | "unknown_provider"
  | "is_default"
  | "default_unreadable"
  | "sign_in_in_progress"
  | "still_signed_in"
  | "restart_refused";

export type ProviderSignOutResult =
  | {
    ok: true;
    /** False when there was nothing to sign out of: the answer is the same. */
    changed: boolean;
    /** The harness is restarting to drop the credential; the chat is back in a minute. */
    gatewayRestarting: boolean;
  }
  | {
    ok: false;
    kind: ProviderSignOutRefusal;
    error: string;
  };

/** `getCodingAgentStatus().ready`, or undefined when it cannot be read (see the configure route). */
async function codingAgentReady(): Promise<boolean | undefined> {
  try {
    const { getCodingAgentStatus } = await import("@/lib/coding-agent");
    return (await getCodingAgentStatus()).ready;
  } catch {
    return undefined;
  }
}

/**
 * The row the active harness answers the chat on, or `known: false` when its
 * config could not be read to say — which refuses, rather than guess that a
 * provider is not the default and sign the chat out from under itself.
 */
async function readDefaultRow(harness: Harness): Promise<{ known: boolean; row: string | null }> {
  if (harness === "openclaw") {
    try {
      const primary = (await readConfigStrict()).agents?.defaults?.model?.primary;
      return { known: true, row: normalizeProviderId(typeof primary === "string" ? primary.split("/")[0] : null) };
    } catch {
      return { known: false, row: null };
    }
  }
  const read = await resolveHermesConfigValue("model.provider");
  if (read.state === "absent") return { known: true, row: null };
  if (read.state !== "value") return { known: false, row: null };
  return { known: true, row: canonicalProviderId("hermes", read.value) };
}

function prepareHalf(harness: Harness, row: string, token: string | null, active: boolean): Promise<HarnessSignOut> {
  return harness === "openclaw" ? prepareOpenclawSignOut(row, token, active) : prepareHermesSignOut(row, token, active);
}

/**
 * ClawBox's records about the provider (see the file header, 2). Fail-soft
 * like each writer is; the token is what the read-back holds to account.
 */
async function forgetRecords(harness: Harness, row: string): Promise<void> {
  const slots = harness === "openclaw" ? [row, ...(OPENCLAW_SLOTS[row] ?? [])] : [row];
  if (row === CLAWAI_ROW) {
    try {
      await setMany({
        [CLAWAI_TOKEN_KEY]: undefined,
        [CLAWAI_DEVICE_TIER_KEY]: undefined,
        [CLAWAI_PLAN_TIER_KEY]: undefined,
      });
    } catch (err) {
      console.warn("[provider-sign-out] could not clear the ClawBox AI account's records:", err instanceof Error ? err.message : err);
    }
    await forgetClawboxAiPick();
    await forgetClawaiCredentialRefusal().catch(() => undefined);
    await clearClawAiSession().catch(() => undefined);
  } else {
    await forgetProviderPicks((slot) =>
      slots.includes(slot) || (harness === "openclaw" && normalizeProviderId(slot) === row));
    for (const slot of slots) await forgetUnavailableModels(slot);
  }
  await forgetProviderVerified(row).catch(() => undefined);
}

/** Sign the box out of the provider behind row `providerId` — see the file header. Never throws. */
export async function signOutOfProvider(providerId: string): Promise<ProviderSignOutResult> {
  const source = await getActiveHarnessSource();
  const harness = source.active;
  const row = canonicalProviderId(harness, typeof providerId === "string" ? providerId : null) ?? "";
  const label = providerRowLabel(harness, row);
  if (!ROW_ID.test(row) || isLocalProviderRow(row) || row === "auto") {
    return {
      ok: false,
      kind: "unknown_provider",
      error: isLocalProviderRow(row)
        ? "An on-device model has no sign-in: turn it off in Settings → Local AI."
        : "There is no such provider to sign out of.",
    };
  }

  if (row === CLAWAI_ROW) {
    // A device login that is writing its token right now would land it after
    // this sign-out, and the box would be signed in to that account after all.
    const session = await readClawAiSession().catch(() => null);
    if (session && isClawAiSessionConfiguring(session)) {
      return {
        ok: false,
        kind: "sign_in_in_progress",
        error: "A ClawBox AI sign-in is finishing on this box. Wait for it to finish, then sign out.",
      };
    }
  } else {
    const current = await readDefaultRow(harness);
    if (!current.known) {
      return {
        ok: false,
        kind: "default_unreadable",
        error: `The box could not read which provider the chat runs on, so ${label} was not signed out. Try again in a moment.`,
      };
    }
    if (current.row === row) {
      return {
        ok: false,
        kind: "is_default",
        error: `${label} is the default provider. Make another provider the default first, then sign out of it.`,
      };
    }
  }

  const token = row === CLAWAI_ROW ? await resolveClawaiToken() : null;
  const storedToken = row === CLAWAI_ROW ? await getConfigValue(CLAWAI_TOKEN_KEY).catch(() => undefined) : undefined;
  const halves = [await prepareHalf(harness, row, token, true)];
  if (row === CLAWAI_ROW && source.edition === "dual") {
    // The other harness of a dual box, cleaned and read back but never
    // restarted: it does not answer the chat.
    const other: Harness = harness === "openclaw" ? "hermes" : "openclaw";
    halves.push(await prepareHalf(other, row, token, false));
  }
  const held = halves.some((half) => half.held)
    || (row === CLAWAI_ROW && (storedToken !== undefined || token !== null));
  // Every writer of `clawai_token` samples the coding agent's readiness before
  // its write (coding-agent-mcp-refresh.ts): a box with no ClawBox AI account
  // loses the coding tools, and the running agent must hear it.
  const readyBefore = row === CLAWAI_ROW && held ? await codingAgentReady() : undefined;

  // 1. The harness's copies, then 2. ClawBox's records.
  for (const half of halves) await half.remove();
  await forgetRecords(harness, row);

  // 3. The running harness onto the change, then the backups it rotated.
  let gatewayRestarting = false;
  let restartRefused = false;
  for (const half of halves) {
    const applied = await half.apply();
    gatewayRestarting ||= applied.restarting;
    restartRefused ||= applied.refused;
  }
  for (const half of halves) await half.scrubCopies();

  // 4. Read back.
  const left: string[] = [];
  const unread: string[] = [];
  for (const half of halves) {
    const back = await half.readBack();
    left.push(...back.left);
    unread.push(...back.unread);
  }
  if (row === CLAWAI_ROW) {
    const tokenNow = await getKnown(CLAWAI_TOKEN_KEY);
    if (!tokenNow.known) unread.push("the ClawBox config store");
    else if (tokenNow.value !== undefined) left.push("the ClawBox config store");
  }
  if (left.length > 0 || unread.length > 0) {
    const parts = [
      left.length ? `could not be removed from ${left.join(" and ")}` : null,
      unread.length ? `could not be checked in ${unread.join(" and ")}` : null,
    ].filter(Boolean);
    return {
      ok: false,
      kind: "still_signed_in",
      error: `The ${label} sign-in ${parts.join(", and ")}. Try again; if it stays, restart the box and sign out again.`,
    };
  }
  if (restartRefused) {
    return {
      ok: false,
      kind: "restart_refused",
      error: `Signed out of ${label} on this box, but the AI gateway could not be restarted to let go of the old sign-in. Restart the box to finish.`,
    };
  }

  if (readyBefore !== undefined) {
    const readyAfter = await codingAgentReady();
    if (readyAfter !== undefined) {
      try {
        const { refreshCodingAgentToolsIfReadinessChanged } = await import("@/lib/coding-agent-mcp-refresh");
        await refreshCodingAgentToolsIfReadinessChanged(readyBefore, readyAfter);
      } catch (err) {
        console.warn("[provider-sign-out] could not refresh the coding agent's tools:", err instanceof Error ? err.message : err);
      }
    }
  }
  return { ok: true, changed: held, gatewayRestarting };
}
