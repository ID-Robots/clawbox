import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The ClawKeep mutations that are the OWNER's alone: unpairing the device,
 * and deleting, labelling or locking a snapshot.
 *
 * src/middleware.ts admits the MCP bearer to every /setup-api route so the
 * agent can reach the device's own API — and no MCP tool exists for any of
 * these, yet the bearer reached them all the same. Each route now re-checks
 * with `hasOwnerSession` (the cookie, never the bearer) and
 * `isSameOriginRequest` (our page, not another site's POST riding the cookie),
 * the same pair clawkeep/setup uses. `backup` is deliberately NOT in this file:
 * the `backup_now` MCP tool posts it with the bearer, so gating it would break
 * a tool that is meant to exist.
 *
 * Driven through the real route handlers with the lib mocked, because what
 * matters is what crosses the HTTP boundary: a 403 with a stable `code`, and
 * the lib never being called on the refused path.
 */

const h = vi.hoisted(() => ({
  ownerSession: true,
  sameOrigin: true,
  calls: [] as string[],
}));

vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn(async () => h.ownerSession),
}));
vi.mock("@/lib/same-origin", () => ({
  isSameOriginRequest: vi.fn(() => h.sameOrigin),
}));

vi.mock("@/lib/clawkeep", () => ({
  ClawKeepError: class ClawKeepError extends Error {
    status = 500;
  },
  SnapshotLockedError: class SnapshotLockedError extends Error {
    status = 409;
    kind = "locked";
  },
  clawKeepErrorBody: (err: unknown, fallback: string) => ({
    error: err instanceof Error ? err.message : fallback,
  }),
  unpairLocal: vi.fn(async () => { h.calls.push("unpair"); }),
  deleteSnapshot: vi.fn(async (name: string) => { h.calls.push(`delete:${name}`); }),
  setSnapshotLabel: vi.fn(async (name: string, label: string) => { h.calls.push(`label:${name}:${label}`); }),
  lockSnapshot: vi.fn(async (name: string) => { h.calls.push(`lock:${name}`); }),
  unlockSnapshot: vi.fn(async (name: string) => { h.calls.push(`unlock:${name}`); }),
  resetRunningState: vi.fn(async () => { h.calls.push("reset-state"); }),
  setPassphrase: vi.fn(async (p: string) => { h.calls.push(`passphrase:${p.length}`); }),
  clearPassphrase: vi.fn(async () => { h.calls.push("clear-passphrase"); return { removed: true }; }),
  isEncryptionConfigured: vi.fn(async () => true),
}));

import { POST as unpairPOST } from "@/app/setup-api/clawkeep/unpair/route";
import { POST as deletePOST } from "@/app/setup-api/clawkeep/snapshots/delete/route";
import { POST as labelPOST } from "@/app/setup-api/clawkeep/snapshots/label/route";
import { POST as lockPOST } from "@/app/setup-api/clawkeep/snapshots/lock/route";
import { POST as resetStatePOST } from "@/app/setup-api/clawkeep/reset-state/route";
import { POST as encryptionPOST, DELETE as encryptionDELETE } from "@/app/setup-api/clawkeep/encryption/route";

const SNAPSHOT = "2026-08-28T00-00-00.000Z-openclaw-backup.tar.gz.enc";

function req(path: string, body: unknown): NextRequest {
  return new Request(`http://localhost/setup-api/clawkeep/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// Every gated route, with the call that proves the lib ran.
const ROUTES: { name: string; post: () => Promise<Response>; expectCall: string }[] = [
  { name: "unpair", post: () => unpairPOST(req("unpair", {})), expectCall: "unpair" },
  { name: "snapshots/delete", post: () => deletePOST(req("snapshots/delete", { name: SNAPSHOT })), expectCall: `delete:${SNAPSHOT}` },
  { name: "snapshots/label", post: () => labelPOST(req("snapshots/label", { name: SNAPSHOT, label: "before the move" })), expectCall: `label:${SNAPSHOT}:before the move` },
  { name: "snapshots/lock", post: () => lockPOST(req("snapshots/lock", { name: SNAPSHOT, locked: true })), expectCall: `lock:${SNAPSHOT}` },
  // The "Reset stuck backup" button, and the passphrase — setting it changes
  // what every later backup is encrypted with; clearing it makes the next one
  // plaintext, restorable by anyone who can read the account's storage.
  { name: "reset-state", post: () => resetStatePOST(req("reset-state", {})), expectCall: "reset-state" },
  { name: "encryption (POST)", post: () => encryptionPOST(req("encryption", { passphrase: "correct horse", confirm: "correct horse" })), expectCall: "passphrase:13" },
  { name: "encryption (DELETE)", post: () => encryptionDELETE(req("encryption", {})), expectCall: "clear-passphrase" },
];

beforeEach(() => {
  h.ownerSession = true;
  h.sameOrigin = true;
  h.calls.length = 0;
});

describe.each(ROUTES)("POST /setup-api/clawkeep/$name — who may ask", ({ post, expectCall }) => {
  it("refuses the MCP bearer (no session cookie) with 403 owner_only and touches nothing", async () => {
    h.ownerSession = false;
    const res = await post();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("owner_only");
    // `kind` too: the field every other clawkeep refusal is keyed on.
    expect(body.kind).toBe("owner_only");
    expect(typeof body.error).toBe("string");
    expect(h.calls).toEqual([]);
  });

  it("refuses a cookie-bearing POST from another origin", async () => {
    h.sameOrigin = false;
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(h.calls).toEqual([]);
  });

  it("lets the owner's own page through to the lib", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(h.calls).toEqual([expectCall]);
  });
});

describe("the refusal comes before the body is read", () => {
  it("answers 403 rather than 400 to a bearer POST with no name at all", async () => {
    // A gate that validated the body first would tell the agent which fields
    // the route wants. The gate is the first thing the handler does.
    h.ownerSession = false;
    const res = await deletePOST(req("snapshots/delete", {}));
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });
});
