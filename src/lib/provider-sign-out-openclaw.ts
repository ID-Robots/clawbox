/**
 * The OpenClaw half of a provider sign-out (src/lib/provider-sign-out.ts):
 * every copy of one provider's credential the gateway and `openclaw.json`
 * hold, and nothing of any other provider's.
 *
 *  1. The gateway's auth profiles, NATIVELY: `openclaw models auth logout
 *     <id> --yes` for every profile the row is made of — each one filed in
 *     `auth.profiles` under the provider and each one the gateway's store
 *     holds for it (an API key, a sign-in, the Anthropic pool's mirrored
 *     `anthropic:clawbox-<id>` accounts; ClawBox AI's `deepseek:default`).
 *     Logout drops a profile from the store, from `auth.profiles` and from
 *     every `auth.order` (docs/cli/models.md, the pinned core), and the CLI
 *     tells the running gateway.
 *  2. What logout leaves, with `config unset`: an `auth.profiles` entry with
 *     no store row behind it, the row's `auth.order`, and the key INLINE in
 *     `models.providers.<p>.apiKey` (OpenRouter, Google and an Anthropic key
 *     ride there as well as in the store — `credentialedProviders` counts
 *     either, so a sign-out that left one would leave the row connected). A
 *     ClawBox AI key in the `openai` slot (its image route) is ClawBox AI's,
 *     not OpenAI's, and is left to that sign-out. For ClawBox AI every other
 *     copy of its key in the file goes too: the image provider's `litellm`
 *     slot, the legacy `openai` image slot, the memory search's remote
 *     embedder and the cloud voice the boot script arms with the token
 *     (`tts.providers.openai`, stamped `clawboxManaged`, whole — a voice
 *     pointed at the proxy with no key is no voice; `messages.tts` on an
 *     older core), which it never withdraws once the token is gone.
 *  3. The key's copies in the config's own backups (src/lib/credential-
 *     copies.ts), once the writes above have rotated them.
 *
 * The provider DEFINITIONS stay, and so does the default: the sign-out never
 * re-routes the chat (src/lib/provider-sign-out.ts refuses the default of
 * anything but ClawBox AI, and ClawBox AI's chat answers a turn with "Sign in
 * to ClawBox AI again" rather than a provider it cannot find).
 *
 * NOT TOUCHED: credentials another setting holds for the same vendor — the
 * cloud voice's own key (Settings → Voice), the coding agent's OpenAI key and
 * ChatGPT sign-in (its own CODEX_HOME) and its Anthropic accounts (the pool
 * itself, `anthropic_accounts`, whose mirror the gateway only carries while the
 * chat is on Claude). Those are other features' sign-ins with their own
 * controls, and an owner's key is never removed because it looks like one.
 *
 * SERVER ONLY.
 */

import path from "node:path";
import { profileProviderId } from "@/lib/chatgpt-subscription";
import { isClawboxAiToken } from "@/lib/clawai-token";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { copiesHolding, isScrubbableSecret, listCopies, scrubCopies, stillLive } from "@/lib/credential-copies";
import { awaitGatewayHotApply, diffConfigPaths, readGatewayConfigBaseline, restartGatewayAnsweringEarly } from "@/lib/gateway-hot-apply";
import { logSafe } from "@/lib/log-safe";
import { readGatewayAuthProfile, readGatewayProviderAuth } from "@/lib/openclaw-auth-store";
import {
  CONFIG_PATH,
  flushConfigWrites,
  readConfig,
  readConfigStrict,
  runOpenclawConfigUnset,
  spawnOpenclawCli,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { credentialedProviders, normalizeProviderId } from "@/lib/provider-status";
import type { HarnessSignOut } from "@/lib/provider-sign-out-types";

const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;

const CLAWAI_ROW = "clawai";

/**
 * The wire ids a row's profiles are filed under besides the ones its
 * `auth.profiles` entries name: ClawBox AI is `deepseek` on the wire, and the
 * ChatGPT sign-in has been filed as `openai-codex` by older cores.
 */
const ROW_WIRES: Readonly<Record<string, readonly string[]>> = {
  clawai: [CLAWBOX_AI_PROVIDER],
  openai: ["openai", "openai-codex"],
};

/** A path segment `config unset` can name: a profile id carries a colon, never a dot. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SAFE_PROFILE_ID = /^[A-Za-z0-9_@+][A-Za-z0-9_@+-]*(:[A-Za-z0-9_@+-]+)?$/;

/** The rotating copies `openclaw.json` keeps beside itself. */
const CONFIG_COPY_NAME = /^openclaw\.json\.(bak(\.\d+)?|last-good)$/;

async function readConfigOrNull(): Promise<OpenClawConfig | null> {
  try {
    return await readConfig();
  } catch {
    return null;
  }
}

/** `node[key]` when it is a plain object, else null. */
function child(node: unknown, key: string): Record<string, unknown> | null {
  const next = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
  return next && typeof next === "object" && !Array.isArray(next) ? next as Record<string, unknown> : null;
}

/** A ClawBox AI key: the box's token, or any portal token (`claw_`, the shape `provider-status.ts` counts). */
function isClawaiKey(value: unknown, token: string | null): boolean {
  return typeof value === "string" && (value === token || isClawboxAiToken(value));
}

/** The `auth.profiles` ids filed under the row's provider. */
function configProfileIds(rowId: string, config: OpenClawConfig | null): string[] {
  const ids: string[] = [];
  for (const [profileId, entry] of Object.entries(config?.auth?.profiles ?? {})) {
    if (normalizeProviderId(profileProviderId(profileId, entry as { provider?: string })) === rowId) ids.push(profileId);
  }
  return ids;
}

/** Every wire id the gateway's store may file the row's profiles under. */
function wiresFor(rowId: string, config: OpenClawConfig | null): string[] {
  const wires = new Set<string>(ROW_WIRES[rowId] ?? [rowId]);
  for (const [profileId, entry] of Object.entries(config?.auth?.profiles ?? {})) {
    const wire = profileProviderId(profileId, entry as { provider?: string });
    if (wire && normalizeProviderId(wire) === rowId) wires.add(wire);
  }
  return [...wires];
}

/**
 * Every ClawBox AI key in the file outside `models.providers.deepseek`: walked
 * through plain objects (an array element cannot be named as a dotted path),
 * in the file's own order. Our own stamped voice entry goes whole; a key of
 * ours in any other entry goes alone, and the entry stays.
 */
function clawaiKeyCopies(config: OpenClawConfig | null, token: string | null): string[] {
  const paths: string[] = [];
  const walk = (node: Record<string, unknown>, at: string[], depth: number) => {
    if (depth > 8) return;
    if (at.length > 0 && isClawaiKey(node.apiKey, token)) {
      const here = at.join(".");
      // models.providers.deepseek.apiKey is taken whatever it holds, below.
      if (here !== `models.providers.${CLAWBOX_AI_PROVIDER}`) {
        paths.push(node.clawboxManaged === true ? here : `${here}.apiKey`);
        if (node.clawboxManaged === true) return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!SAFE_SEGMENT.test(key)) continue;
      const next = child(node, key);
      if (next) walk(next, [...at, key], depth + 1);
    }
  };
  if (config) walk(config as Record<string, unknown>, [], 0);
  return paths;
}

/** The config paths that still hold the row's credential once logout has run — see the file header. */
export function openclawLeftoverPaths(rowId: string, config: OpenClawConfig | null, token: string | null): string[] {
  const paths: string[] = [];
  for (const profileId of configProfileIds(rowId, config)) {
    if (SAFE_PROFILE_ID.test(profileId)) paths.push(`auth.profiles.${profileId}`);
  }
  const order = child(child(config, "auth"), "order") ?? {};
  for (const wire of Object.keys(order)) {
    if (SAFE_SEGMENT.test(wire) && normalizeProviderId(wire) === rowId) paths.push(`auth.order.${wire}`);
  }
  const providers = child(child(config, "models"), "providers") ?? {};
  for (const id of Object.keys(providers)) {
    // An id that is not a plain word cannot be named as a dotted path.
    if (!SAFE_SEGMENT.test(id)) continue;
    const apiKey = child(providers, id)?.apiKey;
    if (apiKey === undefined) continue;
    const ours = rowId === CLAWAI_ROW
      ? id === CLAWBOX_AI_PROVIDER || isClawaiKey(apiKey, token)
      // A ClawBox AI key in another provider's slot is ClawBox AI's.
      : normalizeProviderId(id) === rowId && !isClawaiKey(apiKey, token);
    if (ours) paths.push(`models.providers.${id}.apiKey`);
  }
  if (rowId === CLAWAI_ROW) {
    for (const copy of clawaiKeyCopies(config, token)) {
      if (!paths.includes(copy)) paths.push(copy);
    }
  }
  return paths;
}

/** The string values at `paths` (and inside a whole entry): what the backups must lose too. */
function valuesAt(config: OpenClawConfig | null, paths: readonly string[]): string[] {
  const values: string[] = [];
  for (const dotted of paths) {
    const node = dotted.split(".").reduce<unknown>((at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), config);
    const value = node && typeof node === "object" ? (node as Record<string, unknown>).apiKey : node;
    if (isScrubbableSecret(value)) values.push(value);
  }
  return values;
}

/** The profiles the gateway's store holds for the row, or null when it could not be read. */
function storeProfileIds(wires: readonly string[]): string[] | null {
  const ids: string[] = [];
  for (const wire of wires) {
    const read = readGatewayProviderAuth(wire);
    if (read.kind === "unreadable") return null;
    if (read.kind === "present") ids.push(...read.profiles.map((p) => p.profileId));
  }
  return ids;
}

/**
 * Read what the row holds on OpenClaw and say what its sign-out is. `token`
 * is ClawBox AI's own, for recognising its copies; `active` is whether this
 * harness answers the chat — an inactive one (the other half of a dual box) is
 * cleaned and read back, never applied.
 */
export async function prepareOpenclawSignOut(rowId: string, token: string | null, active: boolean): Promise<HarnessSignOut> {
  const before = await readConfigOrNull();
  const wires = wiresFor(rowId, before);
  const stored = storeProfileIds(wires);
  // The store could not be listed: what the config names is still tried, and
  // the read-back says the store could not be checked.
  const profileIds = [...new Set([...(stored ?? []), ...configProfileIds(rowId, before)])];
  // Each id the store holds, read on its own too: the listing and the one-id
  // reader are the gateway's two views, and a profile either shows is held.
  const storeHeld = (stored?.length ?? 0) > 0
    || profileIds.some((id) => readGatewayAuthProfile(id).kind === "present");
  const leftovers = openclawLeftoverPaths(rowId, before, token);
  const held = storeHeld || profileIds.length > 0 || leftovers.length > 0;
  const secrets = [...new Set([...valuesAt(before, leftovers), ...(rowId === CLAWAI_ROW && isScrubbableSecret(token) ? [token] : [])])];
  const baseline = held && active ? await readGatewayConfigBaseline() : null;
  const copiesDir = path.dirname(CONFIG_PATH);

  return {
    harness: "openclaw",
    held,
    async remove() {
      // 1. The gateway's auth profiles, natively.
      for (const profileId of profileIds) {
        // Never an argument the CLI could read as a flag; what is left is read back.
        if (!SAFE_PROFILE_ID.test(profileId)) continue;
        try {
          // Unpinned, like the configure route's paste and its take-over: the
          // core resolves the same agent store for both.
          await spawnOpenclawCli(["models", "auth", "logout", profileId, "--yes"], { timeoutMs: 60_000 });
        } catch (err) {
          // Not the answer: what is still there is removed below, and read back.
          console.warn(`[provider-sign-out] models auth logout ${profileId} failed:`, err instanceof Error ? logSafe(err.message) : err);
        }
      }
      // 2. What logout leaves behind.
      for (const configPath of openclawLeftoverPaths(rowId, await readConfigOrNull(), token)) {
        try {
          await runOpenclawConfigUnset(configPath, { uid: CLAWBOX_UID, gid: CLAWBOX_GID });
        } catch (err) {
          console.warn(`[provider-sign-out] could not unset ${configPath}:`, err instanceof Error ? logSafe(err.message) : err);
        }
      }
      await flushConfigWrites().catch(() => undefined);
    },
    async apply() {
      // The gateway, onto the change: hot-applied and confirmed, else restarted.
      if (!held || !active) return { restarting: false, refused: false };
      const after = await readConfigOrNull();
      const hot = await awaitGatewayHotApply({
        baseline,
        configChanged: diffConfigPaths(before ?? {}, after ?? {}).length > 0,
        credentialsWritten: storeHeld,
      });
      if (hot.applied) return { restarting: false, refused: false };
      if (hot.why === "gateway-restarting") return { restarting: true, refused: false };
      console.log(`[provider-sign-out] restarting the gateway: it did not confirm the sign-out (${hot.why})`);
      try {
        await restartGatewayAnsweringEarly();
        return { restarting: true, refused: false };
      } catch (err) {
        console.error("[provider-sign-out] the gateway restart was refused:", err instanceof Error ? logSafe(err.message) : err);
        return { restarting: false, refused: true };
      }
    },
    async scrubCopies() {
      const live = await stillLive([CONFIG_PATH], secrets);
      const gone = secrets.filter((secret) => !live.has(secret));
      if (gone.length === 0) return;
      const { files } = await listCopies(copiesDir, CONFIG_COPY_NAME);
      await scrubCopies(files, gone);
    },
    async readBack() {
      // The readers that say when they could not read: never a success over a
      // credential that is still here, or one nobody could check.
      const left: string[] = [];
      const unread: string[] = [];
      let storeLeft = false;
      let storeUnread = stored === null;
      for (const profileId of profileIds) {
        const row = readGatewayAuthProfile(profileId);
        if (row.kind === "present") storeLeft = true;
        else if (row.kind === "unreadable") storeUnread = true;
      }
      const relisted = storeProfileIds(wires);
      if (relisted === null) storeUnread = true;
      else if (relisted.length > 0) storeLeft = true;
      if (storeLeft) left.push("the gateway's auth store");
      else if (storeUnread) unread.push("the gateway's auth store");
      try {
        const config = await readConfigStrict();
        // Our own leftovers, and the row's own reader: a credential this file
        // still holds in a shape the plan did not name is still a sign-in.
        if (openclawLeftoverPaths(rowId, config, token).length > 0 || credentialedProviders(config).has(rowId)) left.push("openclaw.json");
      } catch {
        unread.push("openclaw.json");
      }
      const live = await stillLive([CONFIG_PATH], secrets);
      const gone = secrets.filter((secret) => !live.has(secret));
      if (gone.length > 0) {
        const { files, unlisted } = await listCopies(copiesDir, CONFIG_COPY_NAME);
        const copies = await copiesHolding(files, gone);
        if (copies.holding.length > 0) left.push("openclaw.json's backups");
        else if (unlisted || copies.unreadable.length > 0) unread.push("openclaw.json's backups");
      }
      return { left, unread };
    },
  };
}
