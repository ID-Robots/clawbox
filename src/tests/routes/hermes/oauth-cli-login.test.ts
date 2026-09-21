import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * The OAuth routes for a provider Hermes' dashboard marks "external"
 * (Anthropic, Copilot): the box drives the provider's own CLI login and
 * answers in the dashboard's session shape, so the panel cannot tell the two
 * apart. The dashboard is never asked for such a provider.
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardFetch: vi.fn() }));
vi.mock("@/lib/provider-mcp-refresh", () => ({
  readUsableProviderIds: vi.fn(async () => null),
  refreshProviderToolsIfSetChanged: vi.fn(async () => false),
}));
vi.mock("@/lib/provider-verified", () => ({ forgetProviderVerified: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/hermes-cli-login", () => ({
  cliLoginDriverFor: vi.fn((id: string) => (id === "anthropic" ? "pkce" : id === "copilot-acp" ? "device_code" : null)),
  cliLoginAvailable: vi.fn(async (id: string) => id === "anthropic"),
  startCliLogin: vi.fn(),
  submitCliLoginCode: vi.fn(),
  readCliLogin: vi.fn(),
  cancelCliLogin: vi.fn(() => false),
}));

const SESSION_ID = "cli_0123456789abcdefghij";
let cookie = "";
let session: SessionFixture;

function req(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost/setup-api/hermes/oauth/${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let cli: Record<string, ReturnType<typeof vi.fn>>;
let dashboardFetch: ReturnType<typeof vi.fn>;
let catalogGET: () => Promise<Response>;
let startPOST: (r: Request) => Promise<Response>;
let submitPOST: (r: Request) => Promise<Response>;
let pollGET: (r: Request) => Promise<Response>;
let cancelDELETE: (r: Request) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  session = installSessionFixture();
  cookie = session.cookie;
  cli = (await import("@/lib/hermes-cli-login")) as unknown as Record<string, ReturnType<typeof vi.fn>>;
  dashboardFetch = vi.mocked((await import("@/lib/hermes-dashboard-auth")).dashboardFetch) as unknown as ReturnType<typeof vi.fn>;
  ({ GET: catalogGET } = await import("@/app/setup-api/hermes/oauth/route"));
  ({ POST: startPOST } = await import("@/app/setup-api/hermes/oauth/start/route"));
  ({ POST: submitPOST } = await import("@/app/setup-api/hermes/oauth/submit/route"));
  ({ GET: pollGET } = await import("@/app/setup-api/hermes/oauth/poll/route"));
  ({ DELETE: cancelDELETE } = await import("@/app/setup-api/hermes/oauth/cancel/route"));
});

afterEach(() => {
  session.cleanup();
  vi.clearAllMocks();
});

const catalogue = (anthropicFlow: string) => new Response(JSON.stringify({ providers: [
  { id: "anthropic", name: "Anthropic", flow: anthropicFlow, status: { logged_in: false } },
  { id: "copilot-acp", name: "GitHub Copilot", flow: "external", status: { logged_in: false } },
  { id: "openai-codex", name: "OpenAI", flow: "device_code", status: { logged_in: true } },
] }), { status: 200, headers: { "content-type": "application/json" } });

const pending = {
  id: SESSION_ID, providerId: "anthropic", flow: "pkce", status: "pending",
  authUrl: "https://claude.ai/oauth/authorize?code=true&state=s", userCode: "", verificationUrl: "", error: "",
  expiresAt: Date.now() + 600_000,
};

describe("start", () => {
  it("drives the CLI login when the dashboard's catalogue says external, answering the dashboard's pkce shape", async () => {
    dashboardFetch.mockResolvedValue(catalogue("external"));
    cli.startCliLogin.mockResolvedValue(pending);
    const res = await startPOST(req("start", "POST", { providerId: "anthropic" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ session_id: SESSION_ID, flow: "pkce", auth_url: pending.authUrl });
    expect(body.expires_in).toBeGreaterThan(500);
    expect(cli.startCliLogin).toHaveBeenCalledWith("anthropic");
    // The catalogue was read; the dashboard's own start was never asked.
    expect(dashboardFetch).not.toHaveBeenCalledWith("/api/providers/oauth/anthropic/start", expect.anything());
  });

  it("leaves the login to the dashboard on a Hermes build that still runs it itself (flow pkce)", async () => {
    dashboardFetch.mockImplementation(async (path: string) => path === "/api/providers/oauth"
      ? catalogue("pkce")
      : new Response(JSON.stringify({ session_id: "dash", flow: "pkce", auth_url: "https://claude.ai/oauth/authorize?x" }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await startPOST(req("start", "POST", { providerId: "anthropic" }));
    expect(res.status).toBe(200);
    expect(cli.startCliLogin).not.toHaveBeenCalled();
    expect(dashboardFetch).toHaveBeenCalledWith("/api/providers/oauth/anthropic/start", expect.anything());
  });

  it("answers approved at once when the tool was already signed in — no link, no code", async () => {
    dashboardFetch.mockResolvedValue(catalogue("external"));
    cli.startCliLogin.mockResolvedValue({ ...pending, status: "approved", authUrl: "" });
    const res = await startPOST(req("start", "POST", { providerId: "anthropic" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: SESSION_ID, flow: "pkce", status: "approved" });
  });

  it("answers 409 cli_missing, not a failure, when the tool is not on the box", async () => {
    dashboardFetch.mockResolvedValue(catalogue("external"));
    cli.cliLoginAvailable.mockResolvedValueOnce(false);
    const res = await startPOST(req("start", "POST", { providerId: "anthropic" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("cli_missing");
    expect(cli.startCliLogin).not.toHaveBeenCalled();
  });

  it("answers 502 with the scrubbed reason when the CLI printed no link", async () => {
    dashboardFetch.mockResolvedValue(catalogue("external"));
    cli.startCliLogin.mockResolvedValue({ ...pending, status: "failed", error: "The sign-in tool printed no link." });
    const res = await startPOST(req("start", "POST", { providerId: "anthropic" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "The sign-in tool printed no link.", code: "cli_login_failed" });
  });

  it("still relays a dashboard-run provider to the dashboard", async () => {
    dashboardFetch.mockResolvedValue(new Response(JSON.stringify({ session_id: "d", flow: "device_code", user_code: "AB-12" }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await startPOST(req("start", "POST", { providerId: "openai-codex" }));
    expect(res.status).toBe(200);
    expect(cli.startCliLogin).not.toHaveBeenCalled();
    expect(dashboardFetch).toHaveBeenCalledWith("/api/providers/oauth/openai-codex/start", expect.anything());
  });
});

describe("submit", () => {
  beforeEach(() => cli.readCliLogin.mockReturnValue(pending));

  it("hands the code to the CLI and reports approved with the post-connect refreshes", async () => {
    cli.submitCliLoginCode.mockResolvedValue({ ...pending, status: "approved" });
    const res = await submitPOST(req("submit", "POST", { providerId: "anthropic", sessionId: SESSION_ID, code: "abc#def" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "approved" });
    expect(cli.submitCliLoginCode).toHaveBeenCalledWith(SESSION_ID, "abc#def");
    const { invalidateModelOptions } = await import("@/lib/hermes-model-options");
    expect(invalidateModelOptions).toHaveBeenCalled();
    const { forgetProviderVerified } = await import("@/lib/provider-verified");
    expect(forgetProviderVerified).toHaveBeenCalledWith("anthropic");
  });

  it("relays a refusal as 400 with the reason, so the panel shows it", async () => {
    cli.submitCliLoginCode.mockResolvedValue({ ...pending, status: "failed", error: "invalid_grant" });
    const res = await submitPOST(req("submit", "POST", { providerId: "anthropic", sessionId: SESSION_ID, code: "bad#x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, status: "failed", message: "invalid_grant", code: "code_rejected" });
  });

  it("relays a session it did not mint to the dashboard", async () => {
    cli.readCliLogin.mockReturnValue(null);
    dashboardFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, status: "approved" }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await submitPOST(req("submit", "POST", { providerId: "anthropic", sessionId: SESSION_ID, code: "abc#def" }));
    expect(res.status).toBe(200);
    expect(cli.submitCliLoginCode).not.toHaveBeenCalled();
    expect(dashboardFetch).toHaveBeenCalledWith("/api/providers/oauth/anthropic/submit", expect.anything());
  });
});

describe("poll", () => {
  it("says error — the panel's terminal word — for a login that failed, with the reason", async () => {
    cli.readCliLogin.mockReturnValue({ ...pending, providerId: "copilot-acp", flow: "device_code", status: "failed", error: "GitHub refused" });
    const res = await pollGET(new Request(`http://localhost/setup-api/hermes/oauth/poll?providerId=copilot-acp&sessionId=${SESSION_ID}`));
    expect(await res.json()).toMatchObject({ status: "error", error_message: "GitHub refused" });
  });

  it("reads the CLI session and maps starting → pending, cancelled → expired", async () => {
    cli.readCliLogin.mockReturnValueOnce({ ...pending, providerId: "copilot-acp", flow: "device_code", status: "starting" });
    let res = await pollGET(new Request(`http://localhost/setup-api/hermes/oauth/poll?providerId=copilot-acp&sessionId=${SESSION_ID}`));
    expect((await res.json()).status).toBe("pending");
    cli.readCliLogin.mockReturnValueOnce({ ...pending, providerId: "copilot-acp", flow: "device_code", status: "cancelled" });
    res = await pollGET(new Request(`http://localhost/setup-api/hermes/oauth/poll?providerId=copilot-acp&sessionId=${SESSION_ID}`));
    expect((await res.json()).status).toBe("expired");
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("runs the post-connect refreshes once the CLI reports approved", async () => {
    cli.readCliLogin.mockReturnValue({ ...pending, providerId: "copilot-acp", flow: "device_code", status: "approved" });
    const res = await pollGET(new Request(`http://localhost/setup-api/hermes/oauth/poll?providerId=copilot-acp&sessionId=${SESSION_ID}`));
    expect((await res.json()).status).toBe("approved");
    const { forgetProviderVerified } = await import("@/lib/provider-verified");
    expect(forgetProviderVerified).toHaveBeenCalledWith("copilot-acp");
  });
});

describe("cancel and catalogue", () => {
  it("cancels a CLI session in this process without asking the dashboard", async () => {
    cli.cancelCliLogin.mockReturnValueOnce(true);
    const res = await cancelDELETE(req("cancel", "DELETE", { sessionId: SESSION_ID }));
    expect(await res.json()).toEqual({ ok: true, status: "cancelled" });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("tells the panel which external providers the box can drive, and how they read", async () => {
    dashboardFetch.mockResolvedValue(new Response(JSON.stringify({ providers: [
      { id: "anthropic", name: "Anthropic", flow: "external", cli_command: "hermes auth add anthropic", status: { logged_in: false } },
      { id: "copilot-acp", name: "GitHub Copilot", flow: "external", cli_command: "copilot login", status: { logged_in: false } },
      { id: "openai-codex", name: "OpenAI", flow: "device_code", status: { logged_in: true } },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = await (await catalogGET()).json();
    expect(body.providers).toEqual([
      expect.objectContaining({ id: "anthropic", cliAvailable: true, cliFlow: "pkce" }),
      expect.objectContaining({ id: "copilot-acp", cliAvailable: false, cliFlow: "device_code" }),
      expect.objectContaining({ id: "openai-codex", cliAvailable: false }),
    ]);
  });
});
