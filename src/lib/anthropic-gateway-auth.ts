/**
 * Where the OpenClaw gateway keeps its auth profiles, and the read-only
 * helpers both of ClawBox's readers of that store share (TASK-1260).
 *
 * The account pool used to WRITE the gateway's Claude subscription profile
 * here, overwriting every `anthropic` profile with the active account's token.
 * Since the gateway leg of 2026-10-14 the pool's accounts are profiles of
 * their own, written by core's own writer (`openclaw models auth paste-token`,
 * src/lib/anthropic-gateway.ts); what is left is the layout knowledge:
 *
 * THE STORES, as core 2026.10.2 resolves them:
 *   - `agents/<id>/agent/openclaw-agent.sqlite`, table `auth_profile_store`,
 *     row `primary` — the per-agent store;
 *   - `<stateDir>/state/openclaw.sqlite`, table `config_machine_state`, row
 *     `authProfiles.store` — the gateway-wide store, and ONLY when
 *     `auth.sharedStore` says `state-db`; otherwise core never consults it.
 * Each keeps its usage stats, cooldowns and stored order in a STATE row of its
 * own beside the credentials (`auth_profile_state` / `authProfiles.state`),
 * which core merges over them when it loads the store.
 *
 * src/lib/openclaw-auth-store.ts is the reader and the one writer
 * (`putGatewayOAuthProfile`, the Settings sign-in's) built on these.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import path from "@/lib/runtime-path";

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

export function parseBlob(json: unknown): StoreBlob | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoreBlob) : null;
  } catch {
    return null;
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

/** One JSON cell of an OpenClaw store: its table, its row, and the statements that read and replace it. */
export interface AuthStoreCell {
  table: string;
  key: string;
  select: string;
  update: string;
}

/** Per sqlite store, the row its usage stats and cooldowns are in (see the header). */
export const AUTH_STATE_CELLS: Record<"shared" | "agent", AuthStoreCell> = {
  shared: {
    table: "config_machine_state",
    key: "authProfiles.state",
    select: "SELECT value_json AS json, updated_at_ms AS at FROM config_machine_state WHERE state_key = ?",
    update: "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
  },
  agent: {
    table: "auth_profile_state",
    key: "primary",
    select: "SELECT state_json AS json, updated_at AS at FROM auth_profile_state WHERE state_key = ?",
    update: "UPDATE auth_profile_state SET state_json = ?, updated_at = ? WHERE state_key = ?",
  },
};

/** One row of an OpenClaw store: its JSON text and the timestamp column beside it. */
export interface StoredRow {
  json: unknown;
  at: unknown;
}

/**
 * The cell's row, or undefined when its table or its row is not there — asked
 * of sqlite_master first, the way core does, so "no such table" is an answer
 * and only a database that cannot be asked throws.
 */
export function readRow(db: DatabaseSyncType, cell: Pick<AuthStoreCell, "table" | "key" | "select">): StoredRow | undefined {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(cell.table) as { type?: unknown } | undefined;
  if (table?.type !== "table") return undefined;
  return db.prepare(cell.select).get(cell.key) as StoredRow | undefined;
}

/**
 * Drop `profileIds`' usage stats from a store's state row, inside the caller's
 * transaction. The stats under an id are the credential's that was there:
 * left in place, its cooldown keeps the new one unused until it runs out.
 * Writes nothing when the row holds none of them, and creates no table or row.
 */
export function clearUsageStats(db: DatabaseSyncType, cell: AuthStoreCell, profileIds: readonly string[], now: number): void {
  const state = parseBlob(readRow(db, cell)?.json);
  const stats = state?.usageStats;
  if (!state || !stats || typeof stats !== "object") return;
  const held = profileIds.filter((id) => Object.hasOwn(stats, id));
  if (held.length === 0) return;
  for (const id of held) delete stats[id];
  db.prepare(cell.update).run(JSON.stringify(state), now, cell.key);
}
