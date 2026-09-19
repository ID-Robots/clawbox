/**
 * /setup-api/anthropic/accounts — the box's Anthropic account pool (TASK-902).
 *
 * The route's own rules, with the pool mocked at its module boundary (its
 * storage and order are pinned in src/tests/unit/anthropic-accounts.test.ts):
 *
 *  - GET is readable by the owner AND the agent's MCP bearer — it is what the
 *    `anthropic_accounts` tool reads so a queue knows when to wait;
 *  - every write is the owner's alone, from the box's own pages;
 *  - a Claude account comes from the box's EXISTING sign-in flow, through the
 *    handoff file, and the handoff is consumed only once the account is stored;
 *  - nothing it answers ever carries a credential;
 *  - the test hook interrupts live runs through the runner, and marks the
 *    account itself only when there was no run to move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const pool = vi.hoisted(() => ({
  describePool: vi.fn(),
  addOAuthAccount: vi.fn(),
  addApiKeyAccount: vi.fn(),
  replaceCredential: vi.fn(),
  relistLogin: vi.fn(),
  renameAccount: vi.fn(),
  reorderAccounts: vi.fn(),
  removeAccount: vi.fn(),
  clearLimit: vi.fn(),
  markLimited: vi.fn(),
  readAccounts: vi.fn(),
}));
vi.mock("@/lib/anthropic-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/anthropic-accounts")>()),
  ...pool,
}));

const simulateAnthropicLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", () => ({ simulateAnthropicLimit }));

const announceAnthropicLimit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceAnthropicLimit }));

const handoff = vi.hoisted(() => ({ readHandoffTokens: vi.fn(), clearHandoffTokens: vi.fn() }));
vi.mock("@/lib/oauth-handoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oauth-handoff")>()),
  ...handoff,
}));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const ACCESS = "sk-ant-oat01-access-token-never-answered";
const REFRESH = "sk-ant-ort01-refresh-token-never-answered";

const VIEW = {
  accounts: [
    { id: "aaaaaaaa", label: "Work", email: "work@example.com", kind: "oauth", status: "limited", limitedUntil: 2_000, limitKind: "session", priority: 1, active: false, addedAt: 1, lastUsedAt: null, lastLimitedAt: 1 },
    { id: "bbbbbbbb", label: "Personal", email: "me@example.com", kind: "oauth", status: "ok", limitedUntil: null, limitKind: null, priority: 2, active: true, addedAt: 1, lastUsedAt: null, lastLimitedAt: null },
  ],
  health: { total: 2, healthy: 1, limited: 1, needsAttention: 0, allLimited: false, nextResetAt: 2_000 },
  activeAccountId: "bbbbbbbb",
  loginAvailable: false,
  now: 1_000,
};

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

function req(method: "GET" | "POST", init: { body?: unknown; auth?: "cookie" | "bearer" | "none"; site?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  const auth = init.auth ?? "cookie";
  if (auth === "cookie") headers.cookie = session.cookie;
  if (auth === "bearer") headers.authorization = `Bearer ${MCP_TOKEN}`;
  if (init.site !== undefined) headers["sec-fetch-site"] = init.site;
  return new Request("http://localhost/setup-api/anthropic/accounts", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(init.body ?? {}) } : {}),
  });
}

const post = (body: unknown, init: { auth?: "cookie" | "bearer" | "none"; site?: string } = {}) => POST(req("POST", { body, ...init }));

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  pool.describePool.mockResolvedValue(VIEW);
  pool.addOAuthAccount.mockResolvedValue({ id: "cccccccc" });
  pool.addApiKeyAccount.mockResolvedValue({ id: "dddddddd" });
  pool.replaceCredential.mockResolvedValue({ id: "aaaaaaaa" });
  pool.relistLogin.mockResolvedValue({ id: "eeeeeeee" });
  pool.readAccounts.mockResolvedValue([
    { id: "aaaaaaaa", label: "Work", status: "ok", limitedUntil: null },
    { id: "bbbbbbbb", label: "Personal", status: "ok", limitedUntil: null },
  ]);
  pool.markLimited.mockResolvedValue({ newlyLimited: true, becameAllLimited: false, health: VIEW.health, account: {} });
  simulateAnthropicLimit.mockReturnValue([]);
  handoff.readHandoffTokens.mockResolvedValue({
    ok: true,
    tokens: { provider: "anthropic", accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 28_800, accountEmail: "max2@example.com", createdAt: Date.now() },
  });
  handoff.clearHandoffTokens.mockResolvedValue(undefined);
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const route = await import("@/app/setup-api/anthropic/accounts/route");
  GET = route.GET;
  POST = route.POST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.cleanup();
  restore();
});

describe("reading the pool", () => {
  it("answers the owner and the agent's MCP bearer alike — the queue needs it", async () => {
    for (const auth of ["cookie", "bearer"] as const) {
      const res = await GET(req("GET", { auth }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.health).toMatchObject({ healthy: 1, allLimited: false });
      expect(body.accounts.map((a: { label: string }) => a.label)).toEqual(["Work", "Personal"]);
    }
  });

  it("answers nobody else", async () => {
    expect((await GET(req("GET", { auth: "none" }))).status).toBe(401);
  });
});

describe("changing the pool", () => {
  it("refuses the agent's bearer on every write, and touches nothing", async () => {
    for (const body of [{ action: "connect_oauth" }, { action: "add_key", apiKey: KEY }, { action: "remove", id: "aaaaaaaa" }, { action: "simulate_limit", id: "aaaaaaaa" }]) {
      const res = await post(body, { auth: "bearer" });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
    expect(pool.addOAuthAccount).not.toHaveBeenCalled();
    expect(pool.addApiKeyAccount).not.toHaveBeenCalled();
    expect(pool.removeAccount).not.toHaveBeenCalled();
    expect(simulateAnthropicLimit).not.toHaveBeenCalled();
  });

  it("refuses a write fired from another site, even with the owner's cookie", async () => {
    const res = await post({ action: "remove", id: "aaaaaaaa" }, { site: "cross-site" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(pool.removeAccount).not.toHaveBeenCalled();
  });

  it("takes a second Claude account from the box's own sign-in flow, and consumes the handoff only once it is stored", async () => {
    const res = await post({ action: "connect_oauth", label: "Max #2" });
    expect(res.status).toBe(200);
    expect(pool.addOAuthAccount).toHaveBeenCalledWith({
      label: "Max #2",
      email: "max2@example.com",
      tokens: { access: ACCESS, refresh: REFRESH, expires: expect.any(Number) },
    });
    const { tokens } = pool.addOAuthAccount.mock.calls[0][0] as { tokens: { expires: number } };
    expect(tokens.expires).toBeGreaterThan(Date.now() + 7 * 60 * 60_000);
    expect(handoff.clearHandoffTokens).toHaveBeenCalledTimes(1);
    const text = await res.text();
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(REFRESH);
    expect(JSON.parse(text).accountId).toBe("cccccccc");
  });

  it("keeps the handoff for a retry when the account could not be stored", async () => {
    const { AnthropicAccountError } = await import("@/lib/anthropic-accounts");
    pool.addOAuthAccount.mockRejectedValue(new AnthropicAccountError("store_unavailable", "The store would not write."));
    const res = await post({ action: "connect_oauth" });
    expect(res.status).toBe(503);
    expect(handoff.clearHandoffTokens).not.toHaveBeenCalled();
  });

  it("refuses a sign-in that was not Anthropic's, or that is not there", async () => {
    handoff.readHandoffTokens.mockResolvedValueOnce({ ok: true, tokens: { provider: "openai", accessToken: "x", refreshToken: null, expiresIn: null, accountEmail: null, createdAt: Date.now() } });
    expect((await (await post({ action: "connect_oauth" })).json()).code).toBe("wrong_provider");
    handoff.readHandoffTokens.mockResolvedValueOnce({ ok: false, error: "No pending sign-in. Start it again." });
    const res = await post({ action: "connect_oauth" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_sign_in");
    expect(pool.addOAuthAccount).not.toHaveBeenCalled();
  });

  it("refuses a handoff that does not say it is Anthropic's — the device flow's older shape meant OpenAI", async () => {
    handoff.readHandoffTokens.mockResolvedValueOnce({ ok: true, tokens: { provider: null, accessToken: "x", refreshToken: null, expiresIn: null, accountEmail: null, createdAt: Date.now() } });
    const res = await post({ action: "connect_oauth" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("wrong_provider");
    expect(pool.addOAuthAccount).not.toHaveBeenCalled();
    expect(handoff.clearHandoffTokens).not.toHaveBeenCalled();
  });

  it("re-authenticates an account in place", async () => {
    await post({ action: "reauth_oauth", id: "aaaaaaaa" });
    expect(pool.replaceCredential).toHaveBeenCalledWith("aaaaaaaa", { kind: "oauth", tokens: expect.objectContaining({ access: ACCESS }), email: "max2@example.com" });
    expect(pool.addOAuthAccount).not.toHaveBeenCalled();
    expect(handoff.clearHandoffTokens).toHaveBeenCalledTimes(1);
  });

  it("answers a sign-in for a DIFFERENT Claude account with 409, stores nothing, and drops that account's handoff", async () => {
    const { AnthropicAccountError } = await import("@/lib/anthropic-accounts");
    for (const code of ["wrong_account", "duplicate"] as const) {
      handoff.clearHandoffTokens.mockClear();
      const details = { signedIn: "max2@example.com", expected: "work@example.com", label: "Work" };
      pool.replaceCredential.mockRejectedValueOnce(new AnthropicAccountError(code, "That sign-in is max2@example.com, not work@example.com.", details));
      const res = await post({ action: "reauth_oauth", id: "aaaaaaaa" });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(code);
      // The facts go with it, so the owner's card can say it in their language.
      expect(body.details).toEqual(details);
      expect(JSON.stringify(body)).not.toContain(ACCESS);
      // It can never renew this row; left behind it would only hold a live token.
      expect(handoff.clearHandoffTokens).toHaveBeenCalledTimes(1);
    }
    expect(pool.addOAuthAccount).not.toHaveBeenCalled();
  });

  it("keeps the handoff for a retry when a re-authentication could not be stored", async () => {
    const { AnthropicAccountError } = await import("@/lib/anthropic-accounts");
    pool.replaceCredential.mockRejectedValueOnce(new AnthropicAccountError("store_unavailable", "The store would not write."));
    const res = await post({ action: "reauth_oauth", id: "aaaaaaaa" });
    expect(res.status).toBe(503);
    expect(handoff.clearHandoffTokens).not.toHaveBeenCalled();
  });

  it("sends each key action to its own operation", async () => {
    let res = await post({ action: "replace_key", id: "dddddddd", apiKey: KEY });
    expect(res.status).toBe(200);
    expect(pool.replaceCredential).toHaveBeenCalledWith("dddddddd", { kind: "api_key", key: KEY });
    expect(pool.addApiKeyAccount).not.toHaveBeenCalled();
    res = await post({ action: "add_key", apiKey: KEY });
    expect(res.status).toBe(200);
    expect(pool.addApiKeyAccount).toHaveBeenCalledTimes(1);
    expect(pool.replaceCredential).toHaveBeenCalledTimes(1);
  });

  it("adds an API key only once it has the shape of one, and refuses one Anthropic rejects", async () => {
    let res = await post({ action: "add_key", apiKey: "hunter2" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    res = await post({ action: "add_key", apiKey: KEY });
    expect((await res.json()).code).toBe("rejected");
    expect(pool.addApiKeyAccount).not.toHaveBeenCalled();
    res = await post({ action: "add_key", apiKey: KEY, label: "CI key" });
    expect(res.status).toBe(200);
    expect(pool.addApiKeyAccount).toHaveBeenCalledWith({ label: "CI key", key: KEY });
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("answers a pool refusal with its own status and code", async () => {
    const { AnthropicAccountError } = await import("@/lib/anthropic-accounts");
    pool.removeAccount.mockRejectedValue(new AnthropicAccountError("not_found", "There is no Anthropic account with that id on this ClawBox."));
    const res = await post({ action: "remove", id: "zzzzzzzz" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
    expect((await post({ action: "nope" })).status).toBe(400);
  });

  it("passes the order, the label and a limit's removal through", async () => {
    await post({ action: "reorder", ids: ["bbbbbbbb", "aaaaaaaa"] });
    expect(pool.reorderAccounts).toHaveBeenCalledWith(["bbbbbbbb", "aaaaaaaa"]);
    await post({ action: "rename", id: "aaaaaaaa", label: "Office" });
    expect(pool.renameAccount).toHaveBeenCalledWith("aaaaaaaa", "Office");
    await post({ action: "clear_limit", id: "aaaaaaaa" });
    expect(pool.clearLimit).toHaveBeenCalledWith("aaaaaaaa");
  });
});

describe("the test hook", () => {
  it("interrupts the live runs on that account through the runner, and leaves the recording to their settle", async () => {
    simulateAnthropicLimit.mockReturnValue(["run-abc123"]);
    const res = await post({ action: "simulate_limit", id: "aaaaaaaa", minutes: 20 });
    expect(res.status).toBe(200);
    expect((await res.json()).interrupted).toEqual(["run-abc123"]);
    const [id, until] = simulateAnthropicLimit.mock.calls[0] as [string, number];
    expect(id).toBe("aaaaaaaa");
    expect(until - Date.now()).toBeGreaterThan(19 * 60_000);
    // The run's own settle records the limit and sends the one notice.
    expect(pool.markLimited).not.toHaveBeenCalled();
    expect(announceAnthropicLimit).not.toHaveBeenCalled();
  });

  it("marks the account itself when no run was on it, and says the box moved on", async () => {
    await post({ action: "simulate_limit", id: "aaaaaaaa" });
    expect(pool.markLimited).toHaveBeenCalledWith("aaaaaaaa", expect.any(Number), "session");
    await vi.waitFor(() => expect(announceAnthropicLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "switched", fromLabel: "Work" })));
  });

  it("refuses an account that is not there", async () => {
    const res = await post({ action: "simulate_limit", id: "zzzzzzzz" });
    expect(res.status).toBe(404);
    expect(simulateAnthropicLimit).not.toHaveBeenCalled();
  });
});
