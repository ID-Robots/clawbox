/**
 * /setup-api/coding-agent/anthropic — the owner's OWN Anthropic access.
 *
 * OWNER-ONLY on all three verbs: this route decides which account a delegated
 * shell spends, and the party that would do the spending (the agent, whose
 * bearer the middleware otherwise accepts) must not be the party that can
 * grant it. OUR PAGE ONLY on the writes, for the same reason github-login is:
 * the owner's browser attaches its session cookie to a POST any other site
 * fires at the box.
 *
 * And the rule the whole file exists for: NOTHING here ever answers with the
 * credential — not the stored key, not a masked form of it, not its length.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  set: configSet,
}));

// The connection probe reads two files in the owner's home. Mocked at the
// module boundary the ROUTE actually calls, so these cases are about the
// route and never about whether the developer running them happens to have a
// ~/.claude of their own — its own filesystem rules are pinned separately, in
// src/tests/unit/coding-anthropic.test.ts.
const getAnthropicConnection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-anthropic")>()),
  getAnthropicConnection,
}));

const NOTHING = { connected: false, hasKey: false, hasLogin: false, source: null };
const VIA_KEY = { connected: true, hasKey: true, hasLogin: false, source: "key" };
const VIA_LOGIN = { connected: true, hasKey: false, hasLogin: true, source: "login" };
const KEY_AND_LOGIN = { connected: true, hasKey: true, hasLogin: true, source: "key" };

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

function req(
  method: "GET" | "POST" | "DELETE",
  init: { body?: unknown; auth?: "cookie" | "bearer" | "none"; origin?: string; site?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  const auth = init.auth ?? "cookie";
  if (auth === "cookie") headers.cookie = session.cookie;
  if (auth === "bearer") headers.authorization = `Bearer ${MCP_TOKEN}`;
  if (init.origin !== undefined) headers.origin = init.origin;
  if (init.site !== undefined) headers["sec-fetch-site"] = init.site;
  return new Request("http://localhost/setup-api/coding-agent/anthropic", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(init.body ?? { apiKey: KEY }) } : {}),
  });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  configGet.mockResolvedValue(undefined);
  configSet.mockResolvedValue(undefined);
  getAnthropicConnection.mockResolvedValue(NOTHING);
  // Anthropic says the key is good unless a case says otherwise.
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const route = await import("@/app/setup-api/coding-agent/anthropic/route");
  GET = route.GET;
  POST = route.POST;
  DELETE = route.DELETE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.cleanup();
  restore();
});

describe("the owner gate", () => {
  it("refuses the agent's bearer on every verb, exactly as it refuses nothing at all", async () => {
    for (const [method, fn] of [["GET", GET], ["POST", POST], ["DELETE", DELETE]] as const) {
      for (const auth of ["bearer", "none"] as const) {
        const res = await fn(req(method, { auth }));
        expect(res.status, `${method} / ${auth}`).toBe(403);
        expect((await res.json()).kind).toBe("owner_only");
      }
    }
    expect(configSet).not.toHaveBeenCalled();
  });

  it("refuses a write fired from another site, even with the owner's cookie", async () => {
    const post = await POST(req("POST", { origin: "https://evil.example" }));
    expect(post.status).toBe(403);
    expect((await post.json()).kind).toBe("cross_origin");
    const del = await DELETE(req("DELETE", { origin: "https://evil.example" }));
    expect(del.status).toBe(403);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("still answers the GET for the owner's own page", async () => {
    expect((await GET(req("GET"))).status).toBe(200);
  });
});

describe("what the route will say about the credential", () => {
  it("never returns the key, in any form, even when one is stored", async () => {
    configGet.mockResolvedValue(KEY);
    getAnthropicConnection.mockResolvedValue(VIA_KEY);
    const body = await (await GET(req("GET"))).text();
    expect(body).not.toContain(KEY);
    expect(body).not.toContain("sk-ant");
    // It says THAT there is one, which is the whole job.
    expect(JSON.parse(body)).toMatchObject({ connected: true, hasKey: true, source: "key" });
  });

  it("reports a `claude` login the owner made themselves as its own kind of access", async () => {
    getAnthropicConnection.mockResolvedValue(VIA_LOGIN);
    const body = await (await GET(req("GET"))).json();
    expect(body).toMatchObject({ connected: true, hasKey: false, hasLogin: true, source: "login" });
  });

  it("says a key outranks a login, because that is what the wrapper exports", async () => {
    getAnthropicConnection.mockResolvedValue(KEY_AND_LOGIN);
    expect((await (await GET(req("GET"))).json()).source).toBe("key");
  });

  it("answers the models a run may name, so the picker never guesses", async () => {
    const body = await (await GET(req("GET"))).json();
    expect(body.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(body.defaultModel).toBe("claude-opus-5");
  });
});

describe("saving a key", () => {
  it("stores it and says the check passed", async () => {
    configGet.mockResolvedValue(undefined);
    const res = await POST(req("POST"));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("anthropic_api_key", KEY);
    expect((await res.json()).verified).toBe(true);
  });

  it("refuses something that is not an Anthropic key, and writes nothing", async () => {
    const res = await POST(req("POST", { body: { apiKey: "hunter2" } }));
    expect(res.status).toBe(400);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("refuses a key Anthropic itself rejects", async () => {
    // Storing a 401'd key buys a run that fails several minutes in with a
    // message the owner cannot act on.
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const res = await POST(req("POST"));
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("rejected");
    expect(configSet).not.toHaveBeenCalled();
  });

  it("STORES a key it could not check, and says the check did not happen", async () => {
    // This appliance is regularly offline or behind a captive portal. A
    // correctly pasted key must still be storable there — and the panel must
    // not be told a test ran that did not.
    fetchMock.mockRejectedValue(new Error("ENOTFOUND"));
    const res = await POST(req("POST"));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("anthropic_api_key", KEY);
    expect((await res.json()).verified).toBe(false);
  });

  it("bounds the paste before anything is done with it", async () => {
    const res = await POST(req("POST", { body: { apiKey: `sk-ant-${"x".repeat(5_000)}` } }));
    expect(res.status).toBe(400);
    // Not even a network call: the cap is checked before the live probe.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();
  });

  it("answers 400 rather than 500 on a body it cannot read", async () => {
    for (const body of [{}, { apiKey: 5 }, { apiKey: "  " }]) {
      expect((await POST(req("POST", { body }))).status).toBe(400);
    }
    expect(configSet).not.toHaveBeenCalled();
  });

  it("does not put the key on the wire anywhere but Anthropic's own host", async () => {
    await POST(req("POST"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\//);
    // In a header, never in the URL — a query string is what ends up in logs.
    expect(String(url)).not.toContain(KEY);
    expect(init.headers["x-api-key"]).toBe(KEY);
  });
});

describe("removing the key", () => {
  it("clears it and answers the re-read state", async () => {
    configGet.mockResolvedValue(KEY);
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("anthropic_api_key", undefined);
  });

  it("leaves a `claude` login the owner made themselves alone", async () => {
    // That credential is theirs, made outside this app. A button about the key
    // this box holds must not end somebody's session as a side effect — and
    // the answer has to say the account is still reachable.
    configGet.mockResolvedValue(KEY);
    // After the clear: no key, but the login is still there and still works.
    getAnthropicConnection.mockResolvedValue(VIA_LOGIN);
    const body = await (await DELETE(req("DELETE"))).json();
    expect(body).toMatchObject({ hasKey: false, hasLogin: true, connected: true });
    // Exactly one write, and it is the key's.
    expect(configSet).toHaveBeenCalledTimes(1);
  });
});
