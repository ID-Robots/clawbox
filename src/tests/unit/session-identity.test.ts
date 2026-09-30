import { afterEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import { createRequire } from "module";
import {
  identityFromClaims as tsIdentity,
  parseUserRegistry,
  registryVersions,
} from "@/lib/session-identity";
import { createSessionCookie, readSessionClaims, verifySessionCookie } from "@/lib/auth";

// TASK-1256. The rule that turns a verified cookie payload into a person is
// written twice — src/lib/session-identity.ts for Next.js and
// scripts/session-cookie.js for the WebSocket proxy, which cannot import
// TypeScript. One table, run against both, keeps them from drifting.

const require = createRequire(import.meta.url);
const cjs = require("../../../scripts/session-cookie.js") as {
  identityFromClaims: typeof tsIdentity;
  parseUserRegistry: (raw: unknown, owner: string) => Map<string, string>;
  sessionIdentityFromCookieHeader: (
    header: string | undefined,
    facts: { secret?: string; sessionGen: number; users: Map<string, string>; owner: string },
  ) => { username: string; isOwner: boolean } | null;
  ownerUsername: () => string;
};

const OWNER = "clawbox";
const ALICE_SV = "a1b2c3d4e5f60718";
const REGISTRY = [
  { username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: ALICE_SV },
  { username: "bob", createdAt: "2026-09-27T11:00:00.000Z", sv: "ffffffffffffffff" },
];
const USERS = registryVersions(parseUserRegistry(REGISTRY, OWNER));

const TABLE: Array<[string, Record<string, unknown>, { username: string; isOwner: boolean } | null]> = [
  ["a pre-multi-user cookie (no u) is the owner", { exp: 1, gen: 0 }, { username: OWNER, isOwner: true }],
  ["u = the owner is the owner", { u: OWNER }, { username: OWNER, isOwner: true }],
  ["the owner's cookie needs no sv", { u: OWNER, sv: "anything" }, { username: OWNER, isOwner: true }],
  ["a registered user with the right sv", { u: "alice", sv: ALICE_SV }, { username: "alice", isOwner: false }],
  ["a registered user with a stale sv", { u: "alice", sv: "0000000000000000" }, null],
  ["a registered user with no sv", { u: "alice" }, null],
  ["a removed (never registered) user", { u: "carol", sv: ALICE_SV }, null],
  ["a system account", { u: "root" }, null],
  ["a non-string u", { u: 42 }, null],
  ["a null u", { u: null }, null],
];

describe("identityFromClaims — the same answers in TypeScript and in the CJS mirror", () => {
  it.each(TABLE)("%s", (_label, claims, expected) => {
    expect(tsIdentity(claims, OWNER, USERS)).toEqual(expected);
    expect(cjs.identityFromClaims(claims, OWNER, cjs.parseUserRegistry(REGISTRY, OWNER))).toEqual(expected);
  });
});

describe("parseUserRegistry", () => {
  it("keeps only well-formed entries, never the owner, never a duplicate", () => {
    const raw = [
      { username: "alice", createdAt: "x", sv: ALICE_SV },
      { username: "alice", createdAt: "y", sv: "1111111111111111" },
      { username: OWNER, createdAt: "z", sv: ALICE_SV },
      { username: "Bad Name", sv: ALICE_SV },
      { username: "nosv" },
      { username: "shortsv", sv: "abc" },
      "alice",
      null,
    ];
    expect(parseUserRegistry(raw, OWNER).map((u) => u.username)).toEqual(["alice"]);
    expect([...cjs.parseUserRegistry(raw, OWNER).keys()]).toEqual(["alice"]);
  });

  it("treats an absent or damaged key as no other users", () => {
    for (const raw of [undefined, null, {}, "alice", 7]) {
      expect(parseUserRegistry(raw, OWNER)).toEqual([]);
      expect(cjs.parseUserRegistry(raw, OWNER).size).toBe(0);
    }
  });
});

describe("cookie backward compatibility", () => {
  const SECRET = "test-session-secret-0123456789abcdef";

  function legacyCookie(exp: number, gen = 0): string {
    const payload = Buffer.from(JSON.stringify({ exp, gen })).toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
    return `${payload}.${sig}`;
  }

  it("a cookie minted before multi-user still verifies and is the owner's", () => {
    const cookie = legacyCookie(Math.floor(Date.now() / 1000) + 600);
    const claims = readSessionClaims(cookie, SECRET, 0);
    expect(claims).not.toBeNull();
    expect(tsIdentity(claims!, OWNER, USERS)).toEqual({ username: OWNER, isOwner: true });
    expect(verifySessionCookie(cookie, SECRET, 0)).toBe(true);
    expect(
      cjs.sessionIdentityFromCookieHeader(`clawbox_session=${cookie}`, { secret: SECRET, sessionGen: 0, users: new Map(), owner: OWNER }),
    ).toEqual({ username: OWNER, isOwner: true });
  });

  it("createSessionCookie without an identity keeps the old payload shape", () => {
    const cookie = createSessionCookie(600, SECRET, 3);
    const claims = readSessionClaims(cookie, SECRET, 3)!;
    expect(Object.keys(claims).sort()).toEqual(["exp", "gen"]);
  });

  it("a second user's cookie carries u and sv and resolves to them", () => {
    const cookie = createSessionCookie(600, SECRET, 0, { u: "alice", sv: ALICE_SV });
    const claims = readSessionClaims(cookie, SECRET, 0)!;
    expect(claims.u).toBe("alice");
    expect(claims.sv).toBe(ALICE_SV);
    expect(tsIdentity(claims, OWNER, USERS)).toEqual({ username: "alice", isOwner: false });
    expect(
      cjs.sessionIdentityFromCookieHeader(`other=1; clawbox_session=${encodeURIComponent(cookie)}`, {
        secret: SECRET,
        sessionGen: 0,
        users: cjs.parseUserRegistry(REGISTRY, OWNER),
        owner: OWNER,
      }),
    ).toEqual({ username: "alice", isOwner: false });
  });

  it("the u claim is covered by the signature — editing it breaks the cookie", () => {
    const cookie = createSessionCookie(600, SECRET, 0, { u: "alice", sv: ALICE_SV });
    const [, sig] = cookie.split(".");
    const forged = `${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, u: OWNER })).toString("base64url")}.${sig}`;
    expect(readSessionClaims(forged, SECRET, 0)).toBeNull();
    expect(
      cjs.sessionIdentityFromCookieHeader(`clawbox_session=${forged}`, { secret: SECRET, sessionGen: 0, users: new Map(), owner: OWNER }),
    ).toBeNull();
  });

  it("a removed user's cookie stops resolving the moment the registry drops them", () => {
    const cookie = createSessionCookie(600, SECRET, 0, { u: "alice", sv: ALICE_SV });
    const claims = readSessionClaims(cookie, SECRET, 0)!;
    expect(tsIdentity(claims, OWNER, new Map())).toBeNull();
  });

  it("a password change (generation bump) revokes every user's cookie", () => {
    const cookie = createSessionCookie(600, SECRET, 0, { u: "alice", sv: ALICE_SV });
    expect(readSessionClaims(cookie, SECRET, 1)).toBeNull();
    expect(
      cjs.sessionIdentityFromCookieHeader(`clawbox_session=${cookie}`, { secret: SECRET, sessionGen: 1, users: cjs.parseUserRegistry(REGISTRY, OWNER), owner: OWNER }),
    ).toBeNull();
  });
});

describe("ownerUsername (CJS) resolves the owner the way getSystemUsername does", () => {
  const saved = process.env.CLAWBOX_USER;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAWBOX_USER;
    else process.env.CLAWBOX_USER = saved;
  });

  it("prefers CLAWBOX_USER", async () => {
    process.env.CLAWBOX_USER = "boxowner";
    const { getSystemUsername } = await import("@/lib/auth");
    expect(cjs.ownerUsername()).toBe("boxowner");
    expect(getSystemUsername()).toBe("boxowner");
  });
});
