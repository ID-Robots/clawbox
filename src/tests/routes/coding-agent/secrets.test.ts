/**
 * /setup-api/coding-agent/secrets — the owner's stored credentials.
 *
 * The property under test: **the agent cannot plant, read or take away a
 * credential of the owner's.** Middleware admits the MCP bearer to every
 * /setup-api/* path and the agent holds that bearer, so this route refuses it
 * in-handler with the real cookie verifier, the way `enable` and `permissions`
 * do. The two writes carry a same-origin check on top, so another page in the
 * owner's browser cannot save a secret while they read it.
 *
 * Below that: NO verb answers with a value — not the list, not the POST that
 * has just written one, not an error — and the agent's own narrower door
 * (`secrets/names`) answers names alone while admitting the bearer, which is
 * the one fact it legitimately needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

const listSecrets = vi.hoisted(() => vi.fn());
const setSecret = vi.hoisted(() => vi.fn());
const setSecretInject = vi.hoisted(() => vi.fn());
const deleteSecret = vi.hoisted(() => vi.fn());
const getInjectSecrets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/project-secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-secrets")>()),
  listSecrets,
  setSecret,
  setSecretInject,
  deleteSecret,
  getInjectSecrets,
}));

// The real error class, so the route's `instanceof` is the one a device takes.
import { MAX_SECRET_VALUE_CHARS, SecretStoreError } from "@/lib/project-secrets";

const SESSION_SECRET = "a".repeat(64);
/** A bearer that really verifies, so "the agent" in these tests is the agent. */
const MCP_TOKEN = "c".repeat(48);
const TOKEN = "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC";
const VIEW = {
  name: "VERCEL_TOKEN",
  scope: "box",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  inject: true,
  readable: true,
};

let route: typeof import("@/app/setup-api/coding-agent/secrets/route");
let names: typeof import("@/app/setup-api/coding-agent/secrets/names/route");
let restore: () => void;

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(init: {
  method?: string;
  cookie?: string;
  bearer?: string;
  body?: unknown;
  raw?: string;
  query?: string;
  origin?: string | null;
  path?: string;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  const method = init.method ?? "GET";
  const path = init.path ?? "/setup-api/coding-agent/secrets";
  return new Request(`http://clawbox.local${path}${init.query ?? ""}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: init.raw ?? JSON.stringify(init.body ?? { name: VIEW.name, value: TOKEN }) }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  listSecrets.mockResolvedValue([VIEW]);
  setSecret.mockResolvedValue(VIEW);
  setSecretInject.mockResolvedValue({ ...VIEW, inject: false });
  deleteSecret.mockResolvedValue([]);
  getInjectSecrets.mockResolvedValue(false);
  route = await import("@/app/setup-api/coding-agent/secrets/route");
  names = await import("@/app/setup-api/coding-agent/secrets/names/route");
});

afterEach(() => restore());

describe("who may read and change the store", () => {
  it("refuses the MCP bearer on every verb — the agent is the party this gates", async () => {
    for (const [name, call] of [
      ["GET", () => route.GET(request({ bearer: MCP_TOKEN }))],
      ["POST", () => route.POST(request({ method: "POST", bearer: MCP_TOKEN }))],
      ["DELETE", () => route.DELETE(request({ method: "DELETE", bearer: MCP_TOKEN, query: "?name=VERCEL_TOKEN" }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("owner_only");
    }
    expect(setSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
    // Not even the list: which projects hold deploy tokens is the owner's.
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential with the identical answer", async () => {
    const withBearer = await route.POST(request({ method: "POST", bearer: MCP_TOKEN }));
    const bare = await route.POST(request({ method: "POST" }));
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await withBearer.json());
  });

  it("refuses a forged cookie", async () => {
    const cookie = `clawbox_session=${createSessionCookie(3600, "b".repeat(64), 0)}`;
    expect((await route.GET(request({ cookie }))).status).toBe(403);
  });

  it("refuses a WRITE from another origin, even with the owner's own cookie", async () => {
    for (const [name, call] of [
      ["POST", () => route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "http://evil.example" }))],
      ["DELETE", () => route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), origin: "http://evil.example", query: "?name=VERCEL_TOKEN" }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("cross_origin");
    }
    expect(setSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("refuses a write from a sandboxed frame's opaque origin", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "null" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("cross_origin");
  });

  it("lets the owner READ from anywhere their session reaches", async () => {
    // GET changes nothing, so it carries the owner gate alone.
    const res = await route.GET(request({ cookie: ownerCookie(), origin: "http://evil.example" }));
    expect(res.status).toBe(200);
  });
});

describe("no verb answers with a value", () => {
  it("answers the list, the bounds and the switch — and no value", async () => {
    const res = await route.GET(request({ cookie: ownerCookie() }));
    const body = await res.json();
    expect(body.secrets).toEqual([VIEW]);
    expect(body.max).toBeGreaterThan(0);
    expect(body.maxValueChars).toBe(MAX_SECRET_VALUE_CHARS);
    expect(body.injectSecrets).toBe(false);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("does not echo the value it has just been given", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { name: "VERCEL_TOKEN", value: TOKEN } }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it("does not put the value in a refusal either", async () => {
    setSecret.mockRejectedValue(new SecretStoreError("invalid_value", "A secret needs a value."));
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { name: "VERCEL_TOKEN", value: TOKEN } }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });
});

describe("the two writes", () => {
  it("saves a value, ticked, in the scope the owner chose", async () => {
    await route.POST(request({
      method: "POST",
      cookie: ownerCookie(),
      body: { name: "SHOP_TOKEN", value: TOKEN, scope: "shop", inject: true },
    }));
    expect(setSecret).toHaveBeenCalledWith({ name: "SHOP_TOKEN", value: TOKEN, scope: "shop", inject: true });
    expect(setSecretInject).not.toHaveBeenCalled();
  });

  it("takes a body with no value as the per-entry tick, not as a save", async () => {
    const res = await route.POST(request({
      method: "POST",
      cookie: ownerCookie(),
      body: { name: "VERCEL_TOKEN", scope: "box", inject: false },
    }));
    expect(res.status).toBe(200);
    expect(setSecretInject).toHaveBeenCalledWith({ name: "VERCEL_TOKEN", scope: "box", inject: false });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("refuses a body that is neither, rather than guessing", async () => {
    for (const body of [{ name: "VERCEL_TOKEN" }, {}]) {
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("malformed");
    }
    const notAnObject = await route.POST(request({ method: "POST", cookie: ownerCookie(), raw: '"a string"' }));
    expect(notAnObject.status).toBe(400);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("refuses an over-long value at the door, before the store reads it", async () => {
    const res = await route.POST(request({
      method: "POST",
      cookie: ownerCookie(),
      body: { name: "BIG_ONE", value: "x".repeat(MAX_SECRET_VALUE_CHARS + 1) },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("value_too_long");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("removes by name and scope from the query, and from a body too", async () => {
    await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), query: "?name=SHOP_TOKEN&scope=shop" }));
    expect(deleteSecret).toHaveBeenCalledWith({ name: "SHOP_TOKEN", scope: "shop" });

    deleteSecret.mockClear();
    await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), body: { name: "OTHER_TOKEN", scope: "box" } }));
    expect(deleteSecret).toHaveBeenCalledWith({ name: "OTHER_TOKEN", scope: "box" });
  });

  it("reads an absent ?scope= as the whole box, not as an empty label", async () => {
    await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), query: "?name=VERCEL_TOKEN" }));
    expect(deleteSecret).toHaveBeenCalledWith({ name: "VERCEL_TOKEN", scope: undefined });
  });

  it("answers with the whole re-read payload, so the card shows the box's own list", async () => {
    const res = await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), query: "?name=VERCEL_TOKEN" }));
    const body = await res.json();
    // The list comes from listSecrets, re-read after the write — not from
    // whatever deleteSecret happened to return.
    expect(body.secrets).toEqual([VIEW]);
    expect(body).toHaveProperty("injectSecrets");
  });
});

describe("how a refusal reaches the caller", () => {
  it("carries the store's own code beside the HTTP kind, so the card can word it", async () => {
    setSecret.mockRejectedValue(new SecretStoreError("reserved_name", "PATH is a name this ClawBox uses itself."));
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { name: "PATH", value: TOKEN } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reserved_name", kind: "invalid" });
  });

  it("answers 404 for a name that is not in the store", async () => {
    deleteSecret.mockRejectedValue(new SecretStoreError("not_found", "There is no secret called MISSING."));
    const res = await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), query: "?name=MISSING" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found", kind: "not_found" });
  });

  it("answers 500 when the box itself is the problem, not the request", async () => {
    for (const code of ["store_unreadable", "store_unwritable", "key_unavailable"] as const) {
      setSecret.mockRejectedValue(new SecretStoreError(code, "the box is broken"));
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie() }));
      expect(res.status, code).toBe(500);
      expect((await res.json()).code, code).toBe(code);
    }
  });
});

describe("secrets/names — the agent's own narrower door", () => {
  it("admits the MCP bearer, which is the whole point of it", async () => {
    // The SAME token the owner-only route above refuses. This is the one door
    // the agent has into the store, and it answers names alone.
    const res = await names.GET(request({ path: "/setup-api/coding-agent/secrets/names", bearer: MCP_TOKEN }));
    expect(res.status).toBe(200);
    expect((await res.json()).names).toHaveLength(1);
  });

  it("answers names, scopes and the two facts that change what a run finds — never a value", async () => {
    listSecrets.mockResolvedValue([
      VIEW,
      { ...VIEW, name: "SHOP_TOKEN", scope: "shop", inject: false },
      { ...VIEW, name: "OLD_TOKEN", readable: false },
    ]);
    const res = await names.GET(request({ path: "/setup-api/coding-agent/secrets/names", cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.names).toEqual([
      { name: "VERCEL_TOKEN", scope: "box", inject: true, readable: true },
      { name: "SHOP_TOKEN", scope: "shop", inject: false, readable: true },
      { name: "OLD_TOKEN", scope: "box", inject: true, readable: false },
    ]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    // No `value`, no `iv`, no `tag` — not even an empty one a caller could
    // read as "there is a field here that is sometimes filled".
    for (const row of body.names) expect(Object.keys(row).sort()).toEqual(["inject", "name", "readable", "scope"]);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await names.GET(request({ path: "/setup-api/coding-agent/secrets/names" }));
    expect(res.status).toBe(401);
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it("says the store could not be read rather than answering an empty list", async () => {
    listSecrets.mockRejectedValue(new SecretStoreError("store_unreadable", "not readable JSON"));
    const res = await names.GET(request({ path: "/setup-api/coding-agent/secrets/names", cookie: ownerCookie() }));
    expect(res.status).toBe(500);
    // An empty list would have the agent promise a run credentials that are
    // there, or tell the owner they have stored none.
    expect((await res.json()).code).toBe("store_unreadable");
  });
});
