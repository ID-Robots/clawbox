/**
 * One profile of the OpenClaw gateway's auth store, read and replaced in the
 * row the gateway resolves (the Claude sign-in incident of 2026-10-10).
 *
 * WHY. A Claude subscription sign-in was landed by writing auth-profiles.json
 * and running `openclaw doctor --fix`, and "completed" was its only proof. But
 * core's JSON → sqlite migration only ADDS profile ids the store does not
 * hold: for an id already there it keeps the stored profile, archives the file
 * and still reports "completed", so every RE-sign-in was discarded (7 of 8 on
 * the box this was found on). What it kept was a failed OAuth refresh FENCE —
 * core swaps a credential for inert marker strings before each refresh, and
 * any refresh error (here a DNS failure right after resume) makes the marker
 * terminal. A fence reads as a stored sign-in and is one the gateway never
 * uses: every turn died with "No API key found for provider anthropic".
 *
 * So ClawBox reads the row to learn what the gateway really holds, and writes
 * the profile itself when the migration did not. That is what the account
 * pool's writer (anthropic-gateway-auth.ts) already does to this row, and what
 * core was proven to honour: a profile written straight in is read at once, a
 * later doctor leaves it alone, and the row carries no integrity signature.
 *
 * WHICH STORE: the one core's `resolveSharedAuthStorePath` answers — the
 * `config_machine_state` row `authProfiles.store` in
 * `<stateDir>/state/openclaw.sqlite` when, and only when, `auth.sharedStore`
 * is exactly `{location: "state-db"}`; otherwise (core's `legacy-main`) the
 * main agent's `auth_profile_store` row `primary`. Usage stats and cooldowns
 * are a SEPARATE row of the same database, and a replace clears the
 * profile's: a cooldown the credential that was there earned keeps a good
 * one unused.
 *
 * AND THE MAIN AGENT'S OWN COPY. Under `state-db` ownership core still merges
 * the main agent's `auth_profile_store` row OVER the shared one, id by id
 * (`mergeAuthProfileStores`), and its usage stats the same way. Proven on
 * 2026.9.4 in isolated homes: with a fenced copy there the resolver throws the
 * incident's sentence whatever the shared row holds, core's own writes for
 * the main agent go to the shared row and leave that copy standing, and
 * `doctor --fix` leaves it too. No core verb was found that creates such a
 * copy; the one producer found is ClawBox's own v1-gated
 * `scripts/migrate-auth-profiles.js`, and whether a box in the field carries
 * one is not known. So where that row holds the id, the READ answers that
 * copy — what a turn resolves — with the shared row's beside it as
 * `sharedCopy` (core hands out the shared one instead when it is usable and
 * expires later, so a sign-in has landed only when BOTH are it), and the PUT
 * replaces it after the shared write. Only a copy that is already there: a
 * row without the id, a missing row, table or database is left exactly as it
 * was.
 *
 * TWO RULES for whoever calls or edits this:
 *  1. THE GATEWAY MUST BE STOPPED when the write runs. A running gateway may
 *     flush its own copy of the store on the way down (syncLocked in
 *     anthropic-gateway.ts writes a second time for exactly that), and its
 *     copy is the one with the fence in it.
 *  2. READ BACK AFTER WRITING. `ok: true` says the transaction committed, not
 *     that the gateway's store holds the sign-in; readGatewayAuthProfile's
 *     fingerprint is what says that.
 *
 * Creates nothing — no database, table or row: a store that is not there is
 * core's to make, and `no-store` is the caller's to act on. Nothing here
 * throws, and no token leaves it: a fingerprint stands in for one.
 */

import path from "./runtime-path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { openSqlite } from "./openclaw-session-store";
import {
  gatewayAuthPaths,
  isFile,
  ownsSharedStore,
  parseBlob,
  tokenFingerprint,
  type GatewayAuthPaths,
} from "./anthropic-gateway-auth";

export type GatewayAuthStoreKind = "shared" | "agent";

/**
 * The two states of core's refresh marker. `pending` is a renewal IN FLIGHT:
 * core commits it before it calls the token endpoint and swaps the new
 * credential in when that answers, so every healthy sign-in holds one for the
 * length of that round trip, about three times a day (measured on 2026.9.4:
 * visible to an outside reader from the claim until the endpoint answered).
 * `failed` is terminal — the refresh errored and core never uses the profile
 * again. So is a `pending` one whose owner is gone: core waits out its
 * two-minute refresh ceiling on it, throws, and leaves it pending.
 */
export type OAuthRefreshFenceState = "pending" | "failed";

/** One stored profile, as much of it as may leave this module. */
export interface GatewayAuthProfileCopy {
  type: string;
  fingerprint: string | null;
  refreshFingerprint: string | null;
  expires: number | null;
  /** `fence !== null`: either state is a profile that holds no credential NOW. */
  fenced: boolean;
  fence: OAuthRefreshFenceState | null;
}

export type GatewayAuthProfileRead =
  /** No sqlite store the gateway would read: a v1 box, Hermes, a fresh home. */
  | { kind: "no-store" }
  /**
   * A store exists and could not be read: corrupt, locked past the busy
   * timeout, no node:sqlite. `cause` is what threw, in its own words — never
   * logged here, because the Providers strip and the chat header ask on every
   * poll; the caller that needs the reason says it once.
   */
  | { kind: "unreadable"; cause?: string }
  /** The store is there and holds no profile at this id. */
  | { kind: "absent"; store: GatewayAuthStoreKind }
  | (GatewayAuthProfileCopy & {
      kind: "present";
      /** The store the gateway resolves — also when the answer is the main agent's own copy. */
      store: GatewayAuthStoreKind;
      /**
       * When the row this answer was read from was last written, by its own
       * timestamp column (core's `Date.now()`, and this module's). Never
       * earlier than the write that put the profile there, so it bounds a
       * fence's age from below. Null when the column holds no number.
       */
      storeUpdatedAtMs: number | null;
      /**
       * Set only when the answer is the MAIN AGENT'S OWN COPY (see the
       * header): what the shared row holds at the id beside it, or null when
       * it holds nothing there. A sign-in has landed when both are it.
       */
      sharedCopy?: GatewayAuthProfileCopy | null;
    });

export interface GatewayOAuthBundle {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  [extra: string]: unknown;
}

export type GatewayAuthPutResult =
  | { ok: true; store: GatewayAuthStoreKind }
  | { ok: false; reason: "no-store" | "unreadable" | "write-failed" };

const FENCE_PREFIX = "openclaw-oauth-refresh-fence:";
const FENCE_ACCESS = /^openclaw-oauth-refresh-fence:v1:([a-f0-9]{32}):(failed:)?access:[a-f0-9]{64}$/;
const FENCE_REFRESH = /^openclaw-oauth-refresh-fence:v1:([a-f0-9]{32}):(failed:)?refresh:[a-f0-9]{64}$/;

/**
 * The core's own fence rule (`parseOAuthRefreshFence`, 2026.9.4): an oauth
 * profile whose `expires` is exactly 1 and whose access and refresh are both
 * markers of ONE claim in ONE state — and which state that is. Anything short
 * of that core treats as an ordinary credential, so it is no fence here
 * either. Pure.
 */
export function oauthRefreshFenceState(entry: unknown): OAuthRefreshFenceState | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== "oauth" || e.expires !== 1) return null;
  if (typeof e.access !== "string" || typeof e.refresh !== "string") return null;
  const access = FENCE_ACCESS.exec(e.access);
  const refresh = FENCE_REFRESH.exec(e.refresh);
  if (access === null || refresh === null || access[1] !== refresh[1] || access[2] !== refresh[2]) return null;
  return access[2] ? "failed" : "pending";
}

/** A refresh marker in either state: a profile that holds no credential now. Pure. */
export function isOAuthRefreshFence(entry: unknown): boolean {
  return oauthRefreshFenceState(entry) !== null;
}

/** One JSON cell of an OpenClaw store: its table, its row, and the statements that read and replace it. */
interface Cell {
  table: string;
  key: string;
  select: string;
  update: string;
}

const SHARED_SELECT = "SELECT value_json AS json, updated_at_ms AS at FROM config_machine_state WHERE state_key = ?";
const SHARED_UPDATE = "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?";

const OWNERSHIP = { table: "config_machine_state", key: "auth.sharedStore", select: SHARED_SELECT };

/** Per store: the credentials (`store`) and, in the same database, their usage stats and cooldowns (`state`). */
const CELLS: Record<GatewayAuthStoreKind, { store: Cell; state: Cell }> = {
  shared: {
    store: { table: "config_machine_state", key: "authProfiles.store", select: SHARED_SELECT, update: SHARED_UPDATE },
    state: { table: "config_machine_state", key: "authProfiles.state", select: SHARED_SELECT, update: SHARED_UPDATE },
  },
  agent: {
    store: {
      table: "auth_profile_store",
      key: "primary",
      select: "SELECT store_json AS json, updated_at AS at FROM auth_profile_store WHERE store_key = ?",
      update: "UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?",
    },
    state: {
      table: "auth_profile_state",
      key: "primary",
      select: "SELECT state_json AS json, updated_at AS at FROM auth_profile_state WHERE state_key = ?",
      update: "UPDATE auth_profile_state SET state_json = ?, updated_at = ? WHERE state_key = ?",
    },
  },
};

/** One row of an OpenClaw store: its JSON text and the timestamp column beside it. */
interface StoredRow {
  json: unknown;
  at: unknown;
}

/**
 * The cell's row, or undefined when its table or its row is not there — asked
 * of sqlite_master first, the way core does, so "no such table" is an answer
 * and only a database that cannot be asked throws.
 */
function readRow(db: DatabaseSyncType, cell: Pick<Cell, "table" | "key" | "select">): StoredRow | undefined {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(cell.table) as { type?: unknown } | undefined;
  if (table?.type !== "table") return undefined;
  return db.prepare(cell.select).get(cell.key) as StoredRow | undefined;
}

/** A row's timestamp column, when it holds a number. */
const stampOf = (at: unknown): number | null => (typeof at === "number" && Number.isFinite(at) ? at : null);

/** The main agent's own database: the store itself under `legacy-main`, and the home of its own copy under `state-db`. */
const mainAgentDb = (paths: GatewayAuthPaths): string => path.join(paths.agentsDir, "main", "agent", "openclaw-agent.sqlite");

interface Found {
  store: GatewayAuthStoreKind;
  dbPath: string;
  /** The store row's JSON text as it stood. */
  json: unknown;
  /** The store row's timestamp as it stood. */
  at: number | null;
}

/** The store row the gateway resolves, or null when there is none. Throws when a database that is there cannot be asked. */
function findStore(paths: GatewayAuthPaths): Found | null {
  if (isFile(paths.sharedDb)) {
    const db = openSqlite(paths.sharedDb, true);
    try {
      if (ownsSharedStore(readRow(db, OWNERSHIP)?.json)) {
        const row = readRow(db, CELLS.shared.store);
        return row ? { store: "shared", dbPath: paths.sharedDb, json: row.json, at: stampOf(row.at) } : null;
      }
    } finally {
      db.close();
    }
  }
  const dbPath = mainAgentDb(paths);
  if (!isFile(dbPath)) return null;
  const db = openSqlite(dbPath, true);
  try {
    const row = readRow(db, CELLS.agent.store);
    return row ? { store: "agent", dbPath, json: row.json, at: stampOf(row.at) } : null;
  } finally {
    db.close();
  }
}

type Json = Record<string, unknown>;

/** The blob's profile map. None at all is an empty store; one that is not a map is a blob this module will not guess at. */
function profilesOf(blob: Json): Json | null {
  const profiles = blob.profiles;
  if (profiles === undefined) return {};
  return profiles && typeof profiles === "object" && !Array.isArray(profiles) ? (profiles as Json) : null;
}

/** The profile a map holds at `profileId`: its own entry, and an object — anything else is no profile. */
function profileAt(profiles: Json, profileId: string): Json | null {
  const entry = Object.hasOwn(profiles, profileId) ? profiles[profileId] : null;
  return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Json) : null;
}

/**
 * The main agent's OWN profile at `profileId` under shared ownership (see the
 * header), with its row's timestamp — or null when it holds none: no
 * database, table or row, a row that is no profile map, or no profile there.
 * Throws when a database that is there cannot be asked.
 */
function findAgentLocalCopy(paths: GatewayAuthPaths, profileId: string): { entry: Json; at: number | null } | null {
  const dbPath = mainAgentDb(paths);
  if (!isFile(dbPath)) return null;
  const db = openSqlite(dbPath, true);
  try {
    const row = readRow(db, CELLS.agent.store);
    const blob = row ? (parseBlob(row.json) as Json | null) : null;
    const profiles = blob && profilesOf(blob);
    const entry = profiles ? profileAt(profiles, profileId) : null;
    return row && entry ? { entry, at: stampOf(row.at) } : null;
  } finally {
    db.close();
  }
}

/** A marker is not a token: its digest would read as a credential the store does not hold. */
function fingerprintOf(value: unknown): string | null {
  return typeof value === "string" && value && !value.startsWith(FENCE_PREFIX) ? tokenFingerprint(value) : null;
}

/** What may be said of one stored profile: its type, fingerprints in place of its credential, and whether it is a fence. */
function describeCopy(e: Json): GatewayAuthProfileCopy {
  const type = typeof e.type === "string" ? e.type : "";
  const credential = type === "oauth" ? e.access : type === "token" ? e.token : type === "api_key" ? e.key : null;
  const fence = oauthRefreshFenceState(e);
  return {
    type,
    fingerprint: fingerprintOf(credential),
    refreshFingerprint: type === "oauth" ? fingerprintOf(e.refresh) : null,
    expires: typeof e.expires === "number" && Number.isFinite(e.expires) ? e.expires : null,
    fenced: fence !== null,
    fence,
  };
}

/**
 * What the gateway resolves at `profileId`. Never throws. `fingerprint` is
 * tokenFingerprint() of the access token for type "oauth", of `token` for
 * "token", of `key` for "api_key"; null for a fence or any other marker
 * string, or when the field is empty. `refreshFingerprint` likewise for an
 * oauth profile's `refresh`. `expires` as stored when it is a finite number.
 * Where the main agent holds its own copy of the id (see the header), the
 * answer is that copy and `sharedCopy` is the shared row's.
 */
export function readGatewayAuthProfile(profileId: string, paths?: GatewayAuthPaths): GatewayAuthProfileRead {
  try {
    const where = paths ?? gatewayAuthPaths();
    const found = findStore(where);
    if (!found) return { kind: "no-store" };
    const blob = parseBlob(found.json) as Json | null;
    const profiles = blob && profilesOf(blob);
    if (!profiles) return { kind: "unreadable" };
    const stored = profileAt(profiles, profileId);
    const local = found.store === "shared" ? findAgentLocalCopy(where, profileId) : null;
    if (local) {
      return {
        kind: "present",
        store: found.store,
        ...describeCopy(local.entry),
        storeUpdatedAtMs: local.at,
        sharedCopy: stored ? describeCopy(stored) : null,
      };
    }
    if (!stored) return { kind: "absent", store: found.store };
    return { kind: "present", store: found.store, ...describeCopy(stored), storeUpdatedAtMs: found.at };
  } catch (err) {
    return { kind: "unreadable", cause: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A sign-in worth storing: an access token, a refresh STRING (empty is what a
 * sign-in that returned none is written as) and a real expiry. A marker is
 * refused with the rest — writing one would rebuild the incident by hand.
 */
function wellFormed(bundle: unknown): bundle is GatewayOAuthBundle {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  const b = bundle as Json;
  return b.type === "oauth"
    && typeof b.provider === "string" && b.provider !== ""
    && typeof b.access === "string" && b.access !== "" && !b.access.startsWith(FENCE_PREFIX)
    && typeof b.refresh === "string" && !b.refresh.startsWith(FENCE_PREFIX)
    && typeof b.expires === "number" && Number.isFinite(b.expires) && b.expires > 0;
}

/**
 * The read-modify-write, in ONE IMMEDIATE transaction: a concurrent writer
 * waits out the busy timeout instead of being overwritten, and the credential
 * and its cleared cooldown land together or not at all. Throws when the write
 * does not land.
 *
 * `existingOnly` is the main agent's own copy: replaced where it stands, never
 * made — `false` then says the row holds none (any more), with nothing written.
 * Without it `false` is a row this module cannot rewrite.
 */
function replaceProfile(dbPath: string, cells: { store: Cell; state: Cell }, profileId: string, bundle: GatewayOAuthBundle, existingOnly: boolean): boolean {
  const db = openSqlite(dbPath, false);
  let open = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    open = true;
    // Read again under the lock; the look that led here was before it. No blob to rewrite here is no write, and no row is made.
    const blob = parseBlob(readRow(db, cells.store)?.json) as Json | null;
    const profiles = blob && profilesOf(blob);
    if (!blob || !profiles) return false;
    if (existingOnly && !profileAt(profiles, profileId)) return false;
    profiles[profileId] = bundle;
    blob.profiles = profiles;
    const now = Date.now();
    db.prepare(cells.store.update).run(JSON.stringify(blob), now, cells.store.key);
    // The stats under this id are the credential's that was here: left in
    // place, its cooldown keeps the new one unused until it runs out.
    const state = parseBlob(readRow(db, cells.state)?.json) as Json | null;
    const stats = state?.usageStats;
    if (state && stats && typeof stats === "object" && Object.hasOwn(stats, profileId)) {
      delete (stats as Json)[profileId];
      db.prepare(cells.state.update).run(JSON.stringify(state), now, cells.state.key);
    }
    db.exec("COMMIT");
    open = false;
    return true;
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
 * Put `bundle` at `profileId` in the store the gateway resolves, replacing
 * whatever is there — a fence, another account's sign-in, an api_key — or
 * adding it, and drop that id's usage stats from the state row beside it.
 * Then, where the main agent holds its own copy of the id (see the header),
 * the same over that copy and its stats. Every other profile and every other
 * key of the blobs stays as it was. Never throws, creates nothing (a store
 * with no store ROW is `no-store`), and writes nothing for a malformed bundle
 * (`write-failed`). See the two rules in the header: gateway stopped, and read
 * back afterwards.
 *
 * Two databases cannot commit as one, so one answer is not all-or-nothing:
 * `write-failed` from the main agent's copy comes AFTER the shared row took
 * the sign-in, and nothing takes that back — the copy a turn resolves is then
 * still the old one. The journal line says which half it was.
 */
export function putGatewayOAuthProfile(profileId: string, bundle: GatewayOAuthBundle, paths?: GatewayAuthPaths): GatewayAuthPutResult {
  let reason: "unreadable" | "write-failed" = "write-failed";
  let writing = "the gateway's auth store";
  try {
    // `__proto__` would be assigned as the map's prototype and serialise as nothing — an `ok` over no write.
    if (typeof profileId !== "string" || !profileId || profileId === "__proto__" || !wellFormed(bundle)) return { ok: false, reason };
    reason = "unreadable";
    const where = paths ?? gatewayAuthPaths();
    const found = findStore(where);
    if (!found) return { ok: false, reason: "no-store" };
    // Looked for BEFORE anything is written: an agent database that cannot be asked fails the put whole.
    const local = found.store === "shared" && findAgentLocalCopy(where, profileId) !== null;
    reason = "write-failed";
    if (!replaceProfile(found.dbPath, CELLS[found.store], profileId, bundle, false)) return { ok: false, reason: "unreadable" };
    if (local) {
      writing = "the main agent's own copy of the profile (the shared row took the sign-in)";
      replaceProfile(mainAgentDb(where), CELLS.agent, profileId, bundle, true);
    }
    return { ok: true, store: found.store };
  } catch (err) {
    // sqlite's own words (locked, read-only, not a database) are the only clue to WHY; they never carry a bound value.
    console.error(`[auth-store] ${writing} could not be ${reason === "unreadable" ? "read" : "written"}:`, err instanceof Error ? err.message : err);
    return { ok: false, reason };
  }
}
