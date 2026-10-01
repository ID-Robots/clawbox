// Who a `clawbox_session` cookie speaks for — TASK-1256 (multi-user ClawBox OS).
//
// The signed payload used to be `{ exp, gen }` and every valid cookie was the
// owner's. It now also carries `u` (the Linux username it was issued to) and,
// for a user other than the owner, `sv` (that user's session version from the
// registry below). The rule that turns those claims into a person lives HERE,
// once, and every verifier applies it: src/middleware.ts, src/lib/route-auth.ts,
// src/lib/owner-session.ts, and — in CommonJS, because WebSocket upgrades never
// reach Next.js — scripts/session-cookie.js, which session-identity.test.ts
// runs against the same table.
//
//   no `u`              → the owner. Every cookie minted before this change
//                         has none, so an existing box keeps its sessions.
//   `u` = the owner     → the owner.
//   `u` = a registered  → that user, but only while the registry still lists
//   user                  them with the SAME `sv`. Removing the user drops the
//                         entry, and re-creating the name mints a new `sv`, so
//                         a cookie from before either is dead on arrival.
//   anything else       → nobody: the request is treated as unauthenticated.
//
// Pure and dependency-free (no `os`, no `fs`) so the edge of every caller can
// hand it the facts it already read.

import { USERNAME_RE } from "./username-rules";

/** Top-level data/config.json key holding the non-owner users (the owner is never listed). */
export const USERS_CONFIG_KEY = "clawbox_users";

export interface ClawboxUserRecord {
  username: string;
  /** ISO timestamp the account was created through Settings → Users. */
  createdAt: string;
  /** Session version: a random token every cookie for this user must carry. */
  sv: string;
}

export interface SessionIdentity {
  username: string;
  isOwner: boolean;
}

const SV_RE = /^[0-9a-f]{8,64}$/;

/**
 * Read the registry defensively: a hand-edited or damaged value yields the
 * entries that are well-formed and nothing else, and an entry naming the
 * owner is dropped — the owner's identity never depends on this list.
 */
export function parseUserRegistry(raw: unknown, owner?: string): ClawboxUserRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ClawboxUserRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { username, createdAt, sv } = item as Record<string, unknown>;
    if (typeof username !== "string" || !USERNAME_RE.test(username)) continue;
    if (typeof sv !== "string" || !SV_RE.test(sv)) continue;
    if (username === owner || seen.has(username)) continue;
    seen.add(username);
    out.push({ username, createdAt: typeof createdAt === "string" ? createdAt : "", sv });
  }
  return out;
}

/** username → session version, the only part a cookie check needs. */
export function registryVersions(records: readonly ClawboxUserRecord[]): ReadonlyMap<string, string> {
  return new Map(records.map((r) => [r.username, r.sv]));
}

/**
 * Turn a VERIFIED cookie payload (signature, expiry and generation already
 * checked by the caller) into the person it speaks for, or `null` when it
 * speaks for no one this box still knows.
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  owner: string,
  users: ReadonlyMap<string, string>,
): SessionIdentity | null {
  const u = claims.u;
  if (u === undefined) return { username: owner, isOwner: true };
  if (typeof u !== "string") return null;
  if (u === owner) return { username: owner, isOwner: true };
  const sv = users.get(u);
  if (sv === undefined) return null;
  if (typeof claims.sv !== "string" || claims.sv !== sv) return null;
  return { username: u, isOwner: false };
}
