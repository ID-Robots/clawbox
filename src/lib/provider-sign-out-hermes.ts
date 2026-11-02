/**
 * The Hermes half of a provider sign-out (src/lib/provider-sign-out.ts):
 * every copy of one provider's credential Hermes keeps, through Hermes' own
 * tools where it has them.
 *
 * WHERE HERMES KEEPS ONE (pinned agent, read on a box):
 *
 *  - An API key or a sign-in is a row of `~/.hermes/auth.json`'s
 *    `credential_pool.<slug>` (`hermes auth add`, the configure route and the
 *    Hermes provider panel), and an OAuth sign-in also its
 *    `providers.<slug>` block. `hermes auth remove <slug> <id>` is the native
 *    removal: it drops the row AND does its source's own cleanup — an
 *    env-seeded key is cleared from `.env`, Hermes' own Anthropic sign-in file
 *    is deleted — and marks a source that belongs to ANOTHER tool (Claude
 *    Code's login, the Codex CLI's, `gh`) as not to be re-seeded, leaving that
 *    tool's file alone. `hermes auth logout <slug>` then clears an OAuth block;
 *    it knows only OAuth providers, and answers "Unknown provider" for a key.
 *  - A provider defined in config.yaml keeps its key in
 *    `providers.<slug>.api_key`. Hermes seeds a `custom:<slug>` pool row from
 *    it that holds only a fingerprint and is pruned once the key is gone.
 *  - ClawBox AI is such a provider (src/lib/hermes-clawai.ts): its token in
 *    `providers.clawai.api_key`, in the cloud voice it arms
 *    (`tts.openai.api_key`) and in `.env`'s `CLAWBOX_AI_TOKEN`, which the
 *    image plugin reads. The block itself STAYS — base URL and models — so a
 *    box whose default it is keeps a provider Hermes can resolve, and its row
 *    reads "Needs sign-in" rather than every turn failing on an unknown
 *    provider (src/lib/hermes-local-ai.ts says what that costs).
 *  - Rotating copies: Hermes' last good parses (`backups/config/config.yaml.
 *    good.*`) and ClawBox's own `config.yaml.bak` (src/lib/credential-copies.ts).
 *
 * The running agent read `.env` when it started and may hold a client for the
 * key, so a sign-out that removed anything restarts the dashboard (under the
 * shared claim) and the messaging gateway when one is running.
 *
 * SERVER ONLY.
 */

import fs from "node:fs/promises";
import path from "@/lib/runtime-path";
import { isClawboxAiToken } from "@/lib/clawai-token";
import { copiesHolding, isScrubbableSecret, listCopies, scrubCopies, stillLive } from "@/lib/credential-copies";
import { hermesConfigPath, patchHermesConfig, resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import { runHermesCli } from "@/lib/hermes-cli";
import { clearHermesEnvValues, getHermesEnvValue, hermesEnvPath, hermesHome } from "@/lib/hermes-env";
import { HERMES_IMAGE_TOKEN_ENV } from "@/lib/hermes-image-plugin";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { logSafe } from "@/lib/log-safe";
import { forgetClawaiKeyProbe } from "@/lib/provider-status";
import type { HarnessSignOut } from "@/lib/provider-sign-out-types";

const CLAWAI = "clawai";

/** Where a ClawBox AI token is written besides its own block (hermes-clawai.ts, hermes-tts.ts). */
const CLAWAI_KEY_COPIES = ["model.api_key", "tts.openai.api_key"] as const;

/** An entry id `hermes auth remove` can be handed as an argument (never one that reads as a flag). */
const SAFE_ENTRY_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** The rotating copies Hermes and ClawBox keep of config.yaml. */
const GOOD_COPY_NAME = /^config\.yaml\.good\./;
const BAK_COPY_NAME = /^config\.yaml\.bak$/;

interface PoolEntry {
  id: string | null;
  /**
   * The row is a credential of the pool's own: anything but a row Hermes
   * seeded from config.yaml (`config:<name>`, `model_config`), which carries
   * a fingerprint of the key there and is pruned once that key is gone. An
   * env-seeded or another tool's login (`env:*`, `claude_code`,
   * `device_code`, `gh_cli`) counts whether or not the row copies the
   * secret: `hermes auth remove` is what clears it from `.env` or stops it
   * being seeded again.
   */
  holdsSecret: boolean;
}

interface AuthRead {
  /** Pool rows per pool key (`<slug>`, `custom:<slug>`). */
  pools: Record<string, PoolEntry[]>;
  /** An OAuth block under `providers.<slug>`. */
  oauthBlock: boolean;
}

function authJsonPath(): string {
  return path.join(hermesHome(), "auth.json");
}

function poolKeysFor(slug: string): string[] {
  return [slug, `custom:${slug}`];
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : !!value && typeof value === "object";
}

/**
 * The row's part of `auth.json`, or null when the file is there and cannot be
 * read — never "nothing" over a store nobody could look at. A missing file is
 * a box nothing was ever added to.
 */
async function readAuth(slug: string): Promise<AuthRead | null> {
  let raw: string;
  try {
    raw = await fs.readFile(authJsonPath(), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { pools: {}, oauthBlock: false } : null;
  }
  try {
    const parsed = JSON.parse(raw) as { credential_pool?: unknown; providers?: unknown };
    const pool = parsed.credential_pool && typeof parsed.credential_pool === "object" ? parsed.credential_pool as Record<string, unknown> : {};
    const pools: Record<string, PoolEntry[]> = {};
    for (const key of poolKeysFor(slug)) {
      const rows = Array.isArray(pool[key]) ? pool[key] as unknown[] : [];
      pools[key] = rows.map((row) => {
        const entry = row && typeof row === "object" ? row as Record<string, unknown> : {};
        const source = typeof entry.source === "string" ? entry.source : "";
        const configSeeded = source.startsWith("config:") || source === "model_config";
        return {
          id: typeof entry.id === "string" && SAFE_ENTRY_ID.test(entry.id) ? entry.id : null,
          holdsSecret: !configSeeded || nonEmpty(entry.access_token) || nonEmpty(entry.api_key) || nonEmpty(entry.refresh_token),
        };
      });
    }
    const providers = parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
      ? parsed.providers as Record<string, unknown>
      : {};
    return { pools, oauthBlock: Object.hasOwn(providers, slug) };
  } catch {
    return null;
  }
}

function heldInAuth(auth: AuthRead | null): boolean {
  return !!auth && (auth.oauthBlock || Object.values(auth.pools).some((rows) => rows.some((row) => row.holdsSecret)));
}

/** config.yaml keys holding the row's key, with their values: ClawBox AI's homes, or a defined provider's own. */
async function configKeysFor(slug: string, token: string | null): Promise<{ keys: string[]; values: string[]; unreadable: boolean }> {
  const keys: string[] = [];
  const values: string[] = [];
  let unreadable = false;
  const candidates = slug === CLAWAI ? [`providers.${CLAWAI}.api_key`, ...CLAWAI_KEY_COPIES] : [`providers.${slug}.api_key`];
  for (const key of candidates) {
    const read = await resolveHermesConfigValue(key);
    if (read.state === "unreadable") {
      unreadable = true;
      continue;
    }
    if (read.state === "absent") continue;
    const value = read.state === "value" ? read.value : null;
    // The block's own key goes whatever it holds; a copy elsewhere only when
    // it IS ClawBox AI's — the owner's own voice key is theirs.
    const ours = key.startsWith("providers.") || (value !== null && (value === token || isClawboxAiToken(value)));
    if (!ours) continue;
    keys.push(key);
    if (isScrubbableSecret(value)) values.push(value);
  }
  return { keys, values, unreadable };
}

/** The files Hermes reads its credentials from: a value still in one is not gone. */
function liveFiles(): string[] {
  return [hermesConfigPath(), authJsonPath(), hermesEnvPath()];
}

async function hermesCopies(): Promise<{ files: string[]; unlisted: boolean }> {
  const good = await listCopies(path.join(hermesHome(), "backups", "config"), GOOD_COPY_NAME);
  const bak = await listCopies(path.dirname(hermesConfigPath()), BAK_COPY_NAME);
  return { files: [...good.files, ...bak.files], unlisted: good.unlisted || bak.unlisted };
}

async function hermesCli(args: string[], what: string): Promise<void> {
  try {
    const res = await runHermesCli(args, { timeoutMs: 30_000 });
    if (res.code !== 0) console.warn(`[provider-sign-out] hermes ${what} exited ${res.code}`);
  } catch (err) {
    console.warn(`[provider-sign-out] hermes ${what} failed:`, err instanceof Error ? logSafe(err.message) : err);
  }
}

/**
 * Read what the row holds on Hermes and say what its sign-out is. `slug` is
 * Hermes' own provider id (the row's id on this harness); `token` is ClawBox
 * AI's, for recognising its copies; `active` is whether Hermes answers the
 * chat — an inactive one (the other half of a dual box) is cleaned and read
 * back, never restarted.
 */
export async function prepareHermesSignOut(slug: string, token: string | null, active: boolean): Promise<HarnessSignOut> {
  const auth = await readAuth(slug);
  const config = await configKeysFor(slug, token);
  let envToken: string | null = null;
  let envUnreadable = false;
  if (slug === CLAWAI) {
    try {
      envToken = await getHermesEnvValue(HERMES_IMAGE_TOKEN_ENV);
    } catch {
      envUnreadable = true;
    }
  }
  const held = heldInAuth(auth) || config.keys.length > 0 || envToken !== null;
  const secrets = [...new Set([
    ...config.values,
    ...(isScrubbableSecret(envToken) ? [envToken] : []),
    ...(slug === CLAWAI && isScrubbableSecret(token) ? [token] : []),
  ])];

  return {
    harness: "hermes",
    held,
    async remove() {
      // 1. The pool's rows, natively — the last first, so an index stays good.
      if (auth) {
        for (const key of poolKeysFor(slug)) {
          const rows = auth.pools[key] ?? [];
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (!rows[i].holdsSecret) continue;
            await hermesCli(["auth", "remove", key, rows[i].id ?? String(i + 1)], `auth remove ${key}`);
          }
        }
        if (auth.oauthBlock) await hermesCli(["auth", "logout", slug], `auth logout ${slug}`);
      }
      // 2. The key in config.yaml, and ClawBox AI's in `.env`.
      if (config.keys.length > 0) {
        try {
          await patchHermesConfig({ unset: config.keys });
        } catch (err) {
          console.warn("[provider-sign-out] could not take the key out of Hermes' config:", err instanceof Error ? logSafe(err.message) : err);
        }
      }
      if (envToken !== null) {
        await clearHermesEnvValues([HERMES_IMAGE_TOKEN_ENV]).catch((err) => {
          console.warn("[provider-sign-out] could not clear Hermes' .env:", err instanceof Error ? logSafe(err.message) : err);
        });
      }
      // The row's readers re-ask rather than answer from before.
      invalidateModelOptions();
      forgetClawaiKeyProbe();
    },
    async apply() {
      if (!held || !active) return { restarting: false, refused: false };
      const { bounceHermesDashboardShared } = await import("@/lib/hermes-bounce-claim");
      const outcome = await bounceHermesDashboardShared(`a provider sign-out removed the ${slug} credential`);
      try {
        const { restartHermesGatewayIfRunning } = await import("@/lib/clawbox-mcp-registration");
        await restartHermesGatewayIfRunning();
      } catch (err) {
        console.warn("[provider-sign-out] could not restart Hermes' messaging gateway:", err instanceof Error ? logSafe(err.message) : err);
      }
      if (outcome === "failed") {
        console.error("[provider-sign-out] the Hermes dashboard restart was refused");
        return { restarting: false, refused: true };
      }
      return { restarting: outcome !== "restarted", refused: false };
    },
    async scrubCopies() {
      const live = await stillLive(liveFiles(), secrets);
      const gone = secrets.filter((secret) => !live.has(secret));
      if (gone.length === 0) return;
      const { files } = await hermesCopies();
      await scrubCopies(files, gone);
    },
    async readBack() {
      const left: string[] = [];
      const unread: string[] = [];
      const after = await readAuth(slug);
      if (after === null) unread.push("Hermes' auth store");
      else if (heldInAuth(after)) left.push("Hermes' auth store");
      const again = await configKeysFor(slug, token);
      if (again.keys.length > 0) left.push("Hermes' config.yaml");
      else if (again.unreadable || config.unreadable) unread.push("Hermes' config.yaml");
      if (slug === CLAWAI) {
        try {
          if ((await getHermesEnvValue(HERMES_IMAGE_TOKEN_ENV)) !== null) left.push("Hermes' .env");
          else if (envUnreadable) unread.push("Hermes' .env");
        } catch {
          unread.push("Hermes' .env");
        }
      }
      const live = await stillLive(liveFiles(), secrets);
      const gone = secrets.filter((secret) => !live.has(secret));
      if (gone.length > 0) {
        const { files, unlisted } = await hermesCopies();
        const copies = await copiesHolding(files, gone);
        if (copies.holding.length > 0) left.push("Hermes' config backups");
        else if (unlisted || copies.unreadable.length > 0) unread.push("Hermes' config backups");
      }
      return { left, unread };
    },
  };
}
