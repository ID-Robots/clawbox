/**
 * /setup-api/coding-agent/permissions — the owner's standing permission rules.
 *
 * The property under test: **the agent cannot widen what its own delegated
 * shell may do.** Middleware admits the MCP bearer to every /setup-api/* path
 * and the agent holds that bearer, so this route refuses it in-handler with the
 * real cookie verifier, the way `enable` refuses it for the switch itself. The
 * two writes carry a same-origin check on top, so another page in the owner's
 * browser cannot add a rule while they read it.
 *
 * Below that: the rule-level `code` reaches the caller beside the HTTP kind
 * (the panel words it in the owner's language), and both writes answer with the
 * re-read status rather than the list the caller hoped for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";
import { MAX_RULE_CHARS } from "@/lib/coding-permission-rules";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

const addRule = vi.hoisted(() => vi.fn());
const removeRule = vi.hoisted(() => vi.fn());
const getRules = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  addAllowRule: addRule,
  removeAllowRule: removeRule,
  getAllowRules: getRules,
  getCodingAgentStatus: getStatus,
}));

// The real error class, so the route's `instanceof` is the one a device takes.
import { AllowRuleError } from "@/lib/coding-agent";

const SESSION_SECRET = "a".repeat(64);
const RULE = "Read(//home/clawbox/Projects/notes/**)";
const STATUS = { enabled: true, ready: true, allowRules: [RULE], maxAllowRules: 32 };

let route: typeof import("@/app/setup-api/coding-agent/permissions/route");
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
  secFetchSite?: string;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  if (init.secFetchSite) headers["sec-fetch-site"] = init.secFetchSite;
  const method = init.method ?? "GET";
  return new Request(`http://clawbox.local/setup-api/coding-agent/permissions${init.query ?? ""}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: init.raw ?? JSON.stringify(init.body ?? { rule: RULE }) }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  getRules.mockResolvedValue([RULE]);
  addRule.mockResolvedValue([RULE]);
  removeRule.mockResolvedValue([]);
  getStatus.mockResolvedValue(STATUS);
  route = await import("@/app/setup-api/coding-agent/permissions/route");
});

afterEach(() => restore());

describe("who may read and change the rules", () => {
  it("refuses the MCP bearer on every verb — the agent is the party this gates", async () => {
    for (const [name, call] of [
      ["GET", () => route.GET(request({ bearer: "a-valid-looking-device-token" }))],
      ["POST", () => route.POST(request({ method: "POST", bearer: "a-valid-looking-device-token" }))],
      ["DELETE", () => route.DELETE(request({ method: "DELETE", bearer: "a-valid-looking-device-token" }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("owner_only");
    }
    expect(addRule).not.toHaveBeenCalled();
    expect(removeRule).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential with the identical answer", async () => {
    const withBearer = await route.POST(request({ method: "POST", bearer: "a-valid-looking-device-token" }));
    const bare = await route.POST(request({ method: "POST" }));
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await withBearer.json());
  });

  it("refuses a forged cookie", async () => {
    const cookie = `clawbox_session=${createSessionCookie(3600, "b".repeat(64), 0)}`;
    expect((await route.GET(request({ cookie }))).status).toBe(403);
  });

  it("refuses a WRITE from another origin, even with the owner's own cookie", async () => {
    // The cookie keeps the agent out; this keeps another page in the owner's
    // browser from adding a rule while they read it.
    for (const [name, call] of [
      ["POST", () => route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "http://evil.example" }))],
      ["DELETE", () => route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), origin: "http://evil.example", query: `?rule=${encodeURIComponent(RULE)}` }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("cross_origin");
    }
    expect(addRule).not.toHaveBeenCalled();
    expect(removeRule).not.toHaveBeenCalled();
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

describe("GET", () => {
  it("answers the list and the cap, and nothing else", async () => {
    const res = await route.GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowRules: [RULE], maxAllowRules: 32 });
  });

  it("reports a store it could not read rather than an empty list", async () => {
    // An empty list would invite the owner to re-add a rule already in force.
    getRules.mockRejectedValue(new Error("config.json is unreadable"));
    const res = await route.GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("unreadable");
  });
});

describe("POST: saving one rule", () => {
  it("saves it and answers the re-read status", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { rule: RULE } }));
    expect(res.status).toBe(200);
    expect(addRule).toHaveBeenCalledWith(RULE);
    expect(await res.json()).toEqual(STATUS);
  });

  it("refuses a body that never names a rule", async () => {
    for (const body of [{}, { rule: 42 }, { rule: null }, { rule: ["a"] }]) {
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe("malformed");
    }
    // A JSON body that is a bare scalar must not throw on the way in.
    for (const raw of ["true", "7", '"Read(//x/y/**)"', "not json at all", ""]) {
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), raw }));
      expect(res.status, raw).toBe(400);
    }
    expect(addRule).not.toHaveBeenCalled();
  });

  it("bounds the body before anything reads it", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { rule: "R".repeat(MAX_RULE_CHARS + 1) } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("too_long");
    expect(addRule).not.toHaveBeenCalled();
  });

  it("passes the rule-level code through beside the HTTP kind", async () => {
    // The panel words `protected` in the owner's language; an older panel
    // still has the box's own sentence.
    addRule.mockRejectedValue(new AllowRuleError("protected", "That path holds credentials."));
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { rule: "Read(//home/clawbox/.ssh/**)" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "That path holds credentials.",
      kind: "invalid",
      code: "protected",
    });
  });

  it("answers a duplicate as its own code rather than as a failure", async () => {
    addRule.mockRejectedValue(new AllowRuleError("duplicate", "That rule is already on the list."));
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie() }));
    expect((await res.json()).code).toBe("duplicate");
  });

  it("reports an unexpected failure without pretending the rule was saved", async () => {
    addRule.mockRejectedValue(new Error("disk full"));
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie() }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("disk full");
  });
});

describe("DELETE: taking one back", () => {
  it("reads the rule from the query, which is where a DELETE carries it", async () => {
    const res = await route.DELETE(request({
      method: "DELETE",
      cookie: ownerCookie(),
      query: `?rule=${encodeURIComponent(RULE)}`,
      raw: "",
    }));
    expect(res.status).toBe(200);
    expect(removeRule).toHaveBeenCalledWith(RULE);
    expect(await res.json()).toEqual(STATUS);
  });

  it("reads it from a JSON body too, so no client is left unable to remove one", async () => {
    const res = await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), body: { rule: RULE } }));
    expect(res.status).toBe(200);
    expect(removeRule).toHaveBeenCalledWith(RULE);
  });

  it("refuses a request that names no rule", async () => {
    const res = await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), raw: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("malformed");
    expect(removeRule).not.toHaveBeenCalled();
  });

  it("removing a rule that is not there is not an error", async () => {
    // Two open desktops poll the same status; the second Remove is the owner
    // asking for a state the box is already in. Narrowing is never refused on
    // a technicality.
    removeRule.mockResolvedValue([RULE]);
    const res = await route.DELETE(request({ method: "DELETE", cookie: ownerCookie(), query: "?rule=Read(//gone/**)" }));
    expect(res.status).toBe(200);
  });
});
