/**
 * The OpenClaw gateway's Claude subscription credential, read and rewritten
 * where the gateway keeps it (TASK-1260).
 *
 * WHAT. When the box's active Anthropic account moves (src/lib/anthropic-swap.ts),
 * the gateway — every agent, so every session, cron run and heartbeat — has to
 * move with it. The gateway reaches Claude through the `anthropic` provider's
 * SUBSCRIPTION profile, `anthropic:default`, which Settings → Providers writes
 * as `{ type: "oauth", provider: "anthropic", access, refresh, expires }`. This
 * module finds every such profile in every store the gateway reads and puts
 * the active account's ACCESS token in it.
 *
 * THE STORES, the three generations `scripts/codex-auth-mirror.js` already
 * reads and writes the ChatGPT profile in, on the same terms:
 *   - `agents/<id>/agent/auth-profiles.json` — the legacy file. Only rewritten
 *     where it already exists (OpenClaw 2 refuses to hydrate a RECREATED one).
 *   - `agents/<id>/agent/openclaw-agent.sqlite`, table `auth_profile_store`,
 *     row `primary` — the per-agent store on 2026.7+.
 *   - `<stateDir>/state/openclaw.sqlite`, table `config_machine_state`, row
 *     `authProfiles.store` — the gateway-wide store every agent reads through
 *     on 2026.8, and ONLY when `auth.sharedStore` says `state-db`; otherwise
 *     core never consults that row.
 * Each sqlite write is one IMMEDIATE transaction, so a concurrent writer waits
 * out the busy timeout instead of being overwritten.
 *
 * ONLY WHAT IS ALREADY THERE. A profile is updated in place — its type, its
 * id and every field but the credential are left as core wrote them — and a
 * store without one is not given one: a gateway that does not run on a Claude
 * subscription is not this module's to put on one.
 *
 * NEVER THE REFRESH TOKEN. The pool renews each grant itself and is its only
 * holder: two holders of one single-use refresh token race, and the loser is
 * signed out. So the gateway gets the access token and an EMPTY refresh token
 * (the shape the configure route already writes when a sign-in returns none);
 * src/lib/anthropic-gateway.ts writes a renewed access token well before the
 * old one ends. Leaving the gateway's old refresh token in place would be
 * worse than empty: core would renew the OLD account with it and quietly swap
 * itself back.
 *
 * AND ITS COOLDOWN GOES. Core records a limited profile's failures under
 * `usageStats[<id>]` and skips the profile until the cooldown ends. The same
 * profile id now holds a different account, so its stats are the old account's
 * and are cleared — otherwise the gateway would sit out the old account's
 * cooldown on the new one.
 *
 * Runs as the web server's own user — the gateway's (see restartGateway) — so
 * a write never leaves a store or its WAL owned by anyone else.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "@/lib/runtime-path";
import { openSqlite } from "@/lib/openclaw-session-store";

export type GatewayStoreKind = "json" | "agent" | "shared";

/** One Claude subscription profile the gateway holds. The fingerprint stands in for the token. */
export interface GatewayAnthropicProfile {
  store: GatewayStoreKind;
  agentId: string | null;
  profileId: string;
  type: "oauth" | "token";
  /** Truncated SHA-256 of the token the profile holds now, or null when it holds none. */
  fingerprint: string | null;
  expires: number | null;
}

export interface GatewayWriteResult {
  /** Profiles now holding the new token. */
  written: number;
  /** Stores that held a profile and could not be written (locked, unreadable). */
  failed: number;
}

export interface GatewayAuthPaths {
  agentsDir: string;
  /** `<stateDir>/state/openclaw.sqlite` */
  sharedDb: string;
}

/** Resolved at call time, the way OpenClaw resolves them (see openclaw-state-store.ts). */
export function gatewayAuthPaths(): GatewayAuthPaths {
  const home = process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(process.env.HOME || "/home/clawbox", ".openclaw");
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  const stateDir = override ? path.resolve(override.replace(/^~(?=$|[\\/])/, () => process.env.HOME || os.homedir())) : home;
  return {
    agentsDir: process.env.OPENCLAW_AGENTS_DIR || path.join(home, "agents"),
    sharedDb: path.join(stateDir, "state", "openclaw.sqlite"),
  };
}

/** What stands in for a token wherever the box needs to compare one: never reversible, never logged as more. */
export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

type Profiles = Record<string, Record<string, unknown>>;
interface StoreBlob {
  profiles?: Profiles;
  usageStats?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An anthropic SUBSCRIPTION profile: the provider by its own field or its id's prefix, and a sign-in or setup token. */
function subscriptionType(key: string, entry: unknown): "oauth" | "token" | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const provider = String(e.provider ?? key.split(":")[0] ?? "").trim().toLowerCase();
  if (provider !== "anthropic") return null;
  const type = String(e.type ?? e.mode ?? "").trim().toLowerCase();
  return type === "oauth" || type === "token" ? type : null;
}

function tokenOf(entry: Record<string, unknown>, type: "oauth" | "token"): string | null {
  const value = type === "oauth" ? entry.access : entry.token;
  return typeof value === "string" && value ? value : null;
}

function expiresOf(entry: Record<string, unknown>): number | null {
  const v = entry.expires;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function describe(blob: StoreBlob | null, store: GatewayStoreKind, agentId: string | null): GatewayAnthropicProfile[] {
  const out: GatewayAnthropicProfile[] = [];
  const profiles = blob?.profiles;
  if (!profiles || typeof profiles !== "object") return out;
  for (const [profileId, entry] of Object.entries(profiles)) {
    const type = subscriptionType(profileId, entry);
    if (!type) continue;
    const token = tokenOf(entry, type);
    out.push({ store, agentId, profileId, type, fingerprint: token ? tokenFingerprint(token) : null, expires: expiresOf(entry) });
  }
  return out;
}

/** Put the token into every subscription profile of one blob; answers how many it changed. */
function rewrite(blob: StoreBlob, token: { access: string; expires: number | null }): number {
  const profiles = blob.profiles;
  if (!profiles || typeof profiles !== "object") return 0;
  let changed = 0;
  for (const [profileId, entry] of Object.entries(profiles)) {
    const type = subscriptionType(profileId, entry);
    if (!type) continue;
    if (type === "oauth") {
      entry.access = token.access;
      entry.refresh = "";
    } else {
      entry.token = token.access;
    }
    if (token.expires !== null) entry.expires = token.expires;
    else delete entry.expires;
    if (blob.usageStats && typeof blob.usageStats === "object") delete blob.usageStats[profileId];
    changed += 1;
  }
  return changed;
}

export function parseBlob(json: unknown): StoreBlob | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoreBlob) : null;
  } catch {
    return null;
  }
}

function agentIds(agentsDir: string): string[] {
  try {
    return fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * core's own rule (`parseSharedAuthStoreOwnership`): exactly `{location: "state-db"}`, else the row is never read.
 * Exported, as parseBlob and isFile are, so openclaw-auth-store.ts resolves the store by this rule and not a copy of it.
 */
export function ownsSharedStore(valueJson: unknown): boolean {
  const parsed = parseBlob(valueJson);
  return parsed !== null && Object.keys(parsed).length === 1 && parsed.location === "state-db";
}

const SHARED_STORE_KEY = "authProfiles.store";
const SHARED_OWNERSHIP_KEY = "auth.sharedStore";

/** Every Claude subscription profile the gateway could read, across every agent and store. */
export function listGatewayAnthropicProfiles(paths: GatewayAuthPaths = gatewayAuthPaths()): GatewayAnthropicProfile[] {
  const found: GatewayAnthropicProfile[] = [];
  for (const agentId of agentIds(paths.agentsDir)) {
    const agentDir = path.join(paths.agentsDir, agentId, "agent");
    const jsonPath = path.join(agentDir, "auth-profiles.json");
    if (isFile(jsonPath)) {
      try {
        found.push(...describe(parseBlob(fs.readFileSync(jsonPath, "utf-8")), "json", agentId));
      } catch {
        /* unreadable: counted by nobody, the next pass reads it again */
      }
    }
    const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
    if (!isFile(dbPath)) continue;
    try {
      const db = openSqlite(dbPath, true);
      try {
        const row = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json?: unknown } | undefined;
        found.push(...describe(parseBlob(row?.store_json), "agent", agentId));
      } finally {
        db.close();
      }
    } catch {
      /* no table, locked, or no node:sqlite */
    }
  }
  if (isFile(paths.sharedDb)) {
    try {
      const db = openSqlite(paths.sharedDb, true);
      try {
        const rows = db.prepare("SELECT state_key, value_json FROM config_machine_state WHERE state_key IN (?, ?)")
          .all(SHARED_OWNERSHIP_KEY, SHARED_STORE_KEY) as { state_key: string; value_json: unknown }[];
        const byKey = new Map(rows.map((r) => [r.state_key, r.value_json]));
        if (ownsSharedStore(byKey.get(SHARED_OWNERSHIP_KEY))) found.push(...describe(parseBlob(byKey.get(SHARED_STORE_KEY)), "shared", null));
      } finally {
        db.close();
      }
    } catch {
      /* no table, locked, or no node:sqlite */
    }
  }
  return found;
}

/** One IMMEDIATE read-modify-write of a JSON blob in a sqlite row; answers the profiles changed, or throws. */
function rewriteRow(dbPath: string, select: string, update: string, key: string, token: { access: string; expires: number | null }, withTimestamp: boolean): number {
  const db = openSqlite(dbPath, false);
  let open = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    open = true;
    const row = db.prepare(select).get(key) as Record<string, unknown> | undefined;
    const blob = parseBlob(row ? Object.values(row)[0] : null);
    const changed = blob ? rewrite(blob, token) : 0;
    if (changed > 0) {
      if (withTimestamp) db.prepare(update).run(JSON.stringify(blob), Date.now(), key);
      else db.prepare(update).run(JSON.stringify(blob), key);
    }
    db.exec("COMMIT");
    open = false;
    return changed;
  } finally {
    if (open) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* closing rolls it back anyway */
      }
    }
    db.close();
  }
}

/**
 * Put `token` in every Claude subscription profile the gateway holds, in every
 * store it reads. Never creates a profile or a store. A store that holds one
 * and cannot be written is counted in `failed`, and the rest are still written.
 */
export function writeGatewayAnthropicToken(
  token: { access: string; expires: number | null },
  paths: GatewayAuthPaths = gatewayAuthPaths(),
): GatewayWriteResult {
  let written = 0;
  let failed = 0;
  for (const agentId of agentIds(paths.agentsDir)) {
    const agentDir = path.join(paths.agentsDir, agentId, "agent");
    const jsonPath = path.join(agentDir, "auth-profiles.json");
    if (isFile(jsonPath)) {
      try {
        const blob = parseBlob(fs.readFileSync(jsonPath, "utf-8"));
        const changed = blob ? rewrite(blob, token) : 0;
        if (changed > 0) {
          const tmp = `${jsonPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
          fs.writeFileSync(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
          fs.renameSync(tmp, jsonPath);
          written += changed;
        }
      } catch {
        failed += 1;
      }
    }
    const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
    if (!isFile(dbPath)) continue;
    try {
      written += rewriteRow(
        dbPath,
        "SELECT store_json FROM auth_profile_store WHERE store_key = ?",
        "UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?",
        "primary",
        token,
        true,
      );
    } catch {
      failed += 1;
    }
  }
  if (isFile(paths.sharedDb)) {
    let owns = false;
    try {
      const db = openSqlite(paths.sharedDb, true);
      try {
        const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?").get(SHARED_OWNERSHIP_KEY) as { value_json?: unknown } | undefined;
        owns = ownsSharedStore(row?.value_json);
      } finally {
        db.close();
      }
    } catch {
      owns = false;
    }
    if (owns) {
      try {
        written += rewriteRow(
          paths.sharedDb,
          "SELECT value_json FROM config_machine_state WHERE state_key = ?",
          "UPDATE config_machine_state SET value_json = ? WHERE state_key = ?",
          SHARED_STORE_KEY,
          token,
          false,
        );
      } catch {
        failed += 1;
      }
    }
  }
  return { written, failed };
}
