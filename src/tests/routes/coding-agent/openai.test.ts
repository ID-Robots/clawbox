/**
 * /setup-api/coding-agent/openai — the owner's OWN OpenAI access for coding
 * runs, which run on the Codex CLI.
 *
 * The rules are the Anthropic route's: OWNER-ONLY on every verb (the agent's
 * bearer is refused like no credential at all), OUR PAGE ONLY on the writes —
 * a key, a sign-in started, a sign-out — and NOTHING here ever answers with
 * the credential. The connection's own file and secret-store rules are pinned
 * in coding-openai.test.ts; here only what the route does with them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const getOpenAIConnection = vi.hoisted(() => vi.fn());
const setOpenAIKey = vi.hoisted(() => vi.fn());
const clearOpenAIKey = vi.hoisted(() => vi.fn());
const startCodexLogin = vi.hoisted(() => vi.fn());
const readCodexLogin = vi.hoisted(() => vi.fn());
const cancelCodexLogin = vi.hoisted(() => vi.fn());
const signOutCodex = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-openai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-openai")>()),
  getOpenAIConnection,
  setOpenAIKey,
  clearOpenAIKey,
  startCodexLogin,
  readCodexLogin,
  cancelCodexLogin,
  signOutCodex,
}));

const BASE = { limitedUntil: null, codexInstalled: true };
const NOTHING = { ...BASE, connected: false, hasKey: false, hasLogin: false, source: null, status: "disconnected" };
const VIA_KEY = { ...BASE, connected: true, hasKey: true, hasLogin: false, source: "key", status: "connected" };
const VIA_CHATGPT = { ...BASE, connected: true, hasKey: false, hasLogin: true, source: "chatgpt", status: "connected" };

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
/** A placeholder in the shape of an OpenAI project key — not a real credential. */
const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const PENDING = { id: "login-abc123", status: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "AB1C-DEFGH", error: null, expiresAt: 1 };

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

function req(
  method: "GET" | "POST" | "DELETE",
  init: { body?: unknown; auth?: "cookie" | "bearer" | "none"; origin?: string; query?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  const auth = init.auth ?? "cookie";
  if (auth === "cookie") headers.cookie = session.cookie;
  if (auth === "bearer") headers.authorization = `Bearer ${MCP_TOKEN}`;
  if (init.origin !== undefined) headers.origin = init.origin;
  return new Request(`http://localhost/setup-api/coding-agent/openai${init.query ?? ""}`, {
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
  getOpenAIConnection.mockResolvedValue(NOTHING);
  setOpenAIKey.mockResolvedValue(undefined);
  clearOpenAIKey.mockResolvedValue(undefined);
  startCodexLogin.mockResolvedValue(PENDING);
  readCodexLogin.mockReturnValue(PENDING);
  cancelCodexLogin.mockReturnValue(true);
  signOutCodex.mockResolvedValue(undefined);
  // OpenAI says the key is good unless a case says otherwise.
  fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const route = await import("@/app/setup-api/coding-agent/openai/route");
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
    expect(setOpenAIKey).not.toHaveBeenCalled();
    expect(clearOpenAIKey).not.toHaveBeenCalled();
    expect(startCodexLogin).not.toHaveBeenCalled();
  });

  it("refuses a write fired from another site — a key, a sign-in, a sign-out — even with the owner's cookie", async () => {
    for (const body of [{ apiKey: KEY }, { action: "login-start" }]) {
      const res = await POST(req("POST", { body, origin: "https://evil.example" }));
      expect(res.status).toBe(403);
      expect((await res.json()).kind).toBe("cross_origin");
    }
    expect((await DELETE(req("DELETE", { origin: "https://evil.example", query: "?what=login" }))).status).toBe(403);
    expect(setOpenAIKey).not.toHaveBeenCalled();
    expect(startCodexLogin).not.toHaveBeenCalled();
    expect(signOutCodex).not.toHaveBeenCalled();
  });
});

describe("the state it answers", () => {
  it("says whether OpenAI is connected and how — and offers the Codex models — never with the key", async () => {
    getOpenAIConnection.mockResolvedValue(VIA_KEY);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-");
    expect(JSON.parse(text)).toMatchObject({ connected: true, hasKey: true, source: "key", status: "connected", defaultModel: "gpt-6-astra" });
    expect(JSON.parse(text).models).toContain("gpt-5.6-luna");
  });

  it("passes a limit through as its own status, with when it is over", async () => {
    getOpenAIConnection.mockResolvedValue({ ...VIA_CHATGPT, status: "limited", limitedUntil: 1_900_000_000_000 });
    expect(await (await GET(req("GET"))).json()).toMatchObject({ status: "limited", limitedUntil: 1_900_000_000_000, source: "chatgpt" });
  });
});

describe("saving a key", () => {
  it("checks it with OpenAI first, then stores it, and says it was checked", async () => {
    getOpenAIConnection.mockResolvedValue(VIA_KEY);
    const res = await POST(req("POST"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(setOpenAIKey).toHaveBeenCalledWith(KEY);
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body)).toMatchObject({ verified: true, hasKey: true });
  });

  it("refuses what cannot be a key BEFORE anything leaves the box — an Anthropic key in the wrong field included", async () => {
    for (const apiKey of ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "hunter2", "sk-has spaces in it 0123456789", "x".repeat(600), ""]) {
      const res = await POST(req("POST", { body: { apiKey } }));
      expect(res.status, apiKey.slice(0, 20)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setOpenAIKey).not.toHaveBeenCalled();
  });

  it("does not store a key OpenAI refused, in its own JSON", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }));
    const res = await POST(req("POST"));
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("rejected");
    expect(setOpenAIKey).not.toHaveBeenCalled();
  });

  it("stores a key it could not check — offline, or a portal's page — and says so", async () => {
    for (const answer of [() => Promise.reject(new TypeError("fetch failed")), () => Promise.resolve(new Response("<html>login</html>", { status: 403 }))]) {
      setOpenAIKey.mockClear();
      fetchMock.mockImplementation(answer);
      const res = await POST(req("POST"));
      expect(res.status).toBe(200);
      expect((await res.json()).verified).toBe(false);
      expect(setOpenAIKey).toHaveBeenCalledWith(KEY);
    }
  });

  it("refuses a body that is not an object", async () => {
    const bad = new Request("http://localhost/setup-api/coding-agent/openai", { method: "POST", headers: { cookie: session.cookie, host: "localhost", "content-type": "application/json" }, body: "[1]" });
    expect((await POST(bad)).status).toBe(400);
  });
});

describe("the ChatGPT sign-in", () => {
  it("starts Codex's device flow and answers OpenAI's page and the one-time code", async () => {
    const res = await POST(req("POST", { body: { action: "login-start" } }));
    expect(res.status).toBe(200);
    expect(startCodexLogin).toHaveBeenCalledTimes(1);
    expect((await res.json()).login).toEqual(PENDING);
    // Starting a sign-in sends no key anywhere.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers how a sign-in stands, and the account with it once it is done", async () => {
    readCodexLogin.mockReturnValue({ ...PENDING, status: "approved" });
    getOpenAIConnection.mockResolvedValue(VIA_CHATGPT);
    const res = await POST(req("POST", { body: { action: "login-poll", id: PENDING.id } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ login: { status: "approved" }, connected: true, source: "chatgpt" });
    expect(readCodexLogin).toHaveBeenCalledWith(PENDING.id);
  });

  it("says a sign-in it no longer has is gone, rather than inventing a state", async () => {
    readCodexLogin.mockReturnValue(null);
    const res = await POST(req("POST", { body: { action: "login-poll", id: "login-gone" } }));
    expect(res.status).toBe(404);
  });

  it("cancels the one it is told to", async () => {
    const res = await POST(req("POST", { body: { action: "login-cancel", id: PENDING.id } }));
    expect(res.status).toBe(200);
    expect(cancelCodexLogin).toHaveBeenCalledWith(PENDING.id);
  });

  it("refuses an action it does not know, and an id that is not one", async () => {
    expect((await POST(req("POST", { body: { action: "login-steal" } }))).status).toBe(400);
    expect((await POST(req("POST", { body: { action: "login-poll", id: "../../etc" } }))).status).toBe(400);
    expect((await POST(req("POST", { body: { action: "login-poll" } }))).status).toBe(400);
    expect(readCodexLogin).not.toHaveBeenCalled();
  });
});

describe("taking access back", () => {
  it("removes the key on a plain DELETE, and leaves the sign-in alone", async () => {
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(clearOpenAIKey).toHaveBeenCalledTimes(1);
    expect(signOutCodex).not.toHaveBeenCalled();
  });

  it("signs the coding agent's Codex out on ?what=login, and leaves the key alone", async () => {
    const res = await DELETE(req("DELETE", { query: "?what=login" }));
    expect(res.status).toBe(200);
    expect(signOutCodex).toHaveBeenCalledTimes(1);
    expect(clearOpenAIKey).not.toHaveBeenCalled();
  });

  it("refuses to remove something it has no name for", async () => {
    expect((await DELETE(req("DELETE", { query: "?what=everything" }))).status).toBe(400);
    expect(clearOpenAIKey).not.toHaveBeenCalled();
    expect(signOutCodex).not.toHaveBeenCalled();
  });
});
