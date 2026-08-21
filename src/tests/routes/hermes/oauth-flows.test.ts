import { beforeEach, describe, expect, it, vi } from "vitest";

// The wizard-driven provider-OAuth relay: start / submit / poll / cancel under
// /setup-api/hermes/oauth/. These exist so the browser never has to reach the
// Hermes dashboard's :8090 proxy (unreachable through tunnels) — the routes
// forward to the dashboard API via the server-side dashboardFetch. This suite
// pins the three properties every route must hold: the hermes harness gate,
// input validation before anything touches a dashboard URL, and a whitelisted
// passthrough that can never leak credential material.

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(),
}));

vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: vi.fn(),
}));

const SESSION_ID = "0f6c1c2e-1111-2222-3333-444455556666";

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://localhost/setup-api/hermes/oauth/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dashboardResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hermes provider-OAuth relay routes", () => {
  let catalogGET: () => Promise<Response>;
  let startPOST: (req: Request) => Promise<Response>;
  let submitPOST: (req: Request) => Promise<Response>;
  let pollGET: (req: Request) => Promise<Response>;
  let cancelDELETE: (req: Request) => Promise<Response>;
  let mockGetActiveHarness: ReturnType<typeof vi.fn>;
  let mockDashboardFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const harness = await import("@/lib/harness");
    mockGetActiveHarness = vi.mocked(harness.getActiveHarness) as unknown as ReturnType<typeof vi.fn>;
    mockGetActiveHarness.mockResolvedValue("hermes");

    const dash = await import("@/lib/hermes-dashboard-auth");
    mockDashboardFetch = vi.mocked(dash.dashboardFetch) as unknown as ReturnType<typeof vi.fn>;

    ({ GET: catalogGET } = await import("@/app/setup-api/hermes/oauth/route"));
    ({ POST: startPOST } = await import("@/app/setup-api/hermes/oauth/start/route"));
    ({ POST: submitPOST } = await import("@/app/setup-api/hermes/oauth/submit/route"));
    ({ GET: pollGET } = await import("@/app/setup-api/hermes/oauth/poll/route"));
    ({ DELETE: cancelDELETE } = await import("@/app/setup-api/hermes/oauth/cancel/route"));
  });

  it("404s every route when the active harness is not hermes", async () => {
    mockGetActiveHarness.mockResolvedValue("openclaw");

    const responses = await Promise.all([
      catalogGET(),
      startPOST(jsonRequest("start", "POST", { providerId: "anthropic" })),
      submitPOST(jsonRequest("submit", "POST", { providerId: "anthropic", sessionId: SESSION_ID, code: "abc#def" })),
      pollGET(new Request(`http://localhost/setup-api/hermes/oauth/poll?providerId=anthropic&sessionId=${SESSION_ID}`)),
      cancelDELETE(jsonRequest("cancel", "DELETE", { sessionId: SESSION_ID })),
    ]);

    for (const res of responses) expect(res.status).toBe(404);
    expect(mockDashboardFetch).not.toHaveBeenCalled();
  });

  describe("catalog (GET /setup-api/hermes/oauth)", () => {
    it("maps the dashboard catalog, carrying cli_command for external-flow providers", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(200, {
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            flow: "pkce",
            docs_url: "https://docs.example.com/anthropic",
            status: { logged_in: true },
          },
          {
            id: "copilot-acp",
            name: "GitHub Copilot",
            flow: "external",
            cli_command: "hermes auth login copilot",
            status: { logged_in: false },
          },
        ],
      }));

      const res = await catalogGET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.providers).toEqual([
        {
          id: "anthropic",
          name: "Anthropic",
          flow: "pkce",
          loggedIn: true,
          docsUrl: "https://docs.example.com/anthropic",
        },
        {
          id: "copilot-acp",
          name: "GitHub Copilot",
          flow: "external",
          loggedIn: false,
          cliCommand: "hermes auth login copilot",
        },
      ]);
    });

    it("degrades to an empty catalog when the dashboard is down", async () => {
      mockDashboardFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      const res = await catalogGET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.providers).toEqual([]);
    });
  });

  describe("start", () => {
    it("rejects a provider id that could escape the dashboard URL path", async () => {
      for (const providerId of ["../sessions", "anthropic/start", "Anthropic", "a b", "", 42, null]) {
        const res = await startPOST(jsonRequest("start", "POST", { providerId }));
        expect(res.status).toBe(400);
      }
      expect(mockDashboardFetch).not.toHaveBeenCalled();
    });

    it("rejects a non-JSON body", async () => {
      const res = await startPOST(
        new Request("http://localhost/setup-api/hermes/oauth/start", { method: "POST", body: "nope" }),
      );
      expect(res.status).toBe(400);
    });

    it("relays a pkce start whitelisted — never any credential material", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(200, {
        session_id: SESSION_ID,
        flow: "pkce",
        auth_url: "https://claude.ai/oauth/authorize?x=1",
        expires_in: 600,
        access_token: "LEAKED",
        code_verifier: "LEAKED-TOO",
      }));

      const res = await startPOST(jsonRequest("start", "POST", { providerId: "anthropic" }));
      const body = await res.json();

      expect(mockDashboardFetch).toHaveBeenCalledWith(
        "/api/providers/oauth/anthropic/start",
        expect.objectContaining({ method: "POST" }),
      );
      expect(res.status).toBe(200);
      expect(body).toEqual({
        session_id: SESSION_ID,
        flow: "pkce",
        auth_url: "https://claude.ai/oauth/authorize?x=1",
        expires_in: 600,
      });
    });

    it("relays a device_code start including the user code and poll interval", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(200, {
        session_id: SESSION_ID,
        flow: "device_code",
        user_code: "ABCD-1234",
        verification_url: "https://example.com/activate",
        expires_in: 900,
        poll_interval: 5,
      }));

      const res = await startPOST(jsonRequest("start", "POST", { providerId: "openai-codex" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.user_code).toBe("ABCD-1234");
      expect(body.verification_url).toBe("https://example.com/activate");
      expect(body.poll_interval).toBe(5);
    });

    it("relays a dashboard refusal (flow external) with its status and detail", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(400, {
        detail: "Provider uses an external flow",
      }));

      const res = await startPOST(jsonRequest("start", "POST", { providerId: "copilot-acp" }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Provider uses an external flow");
    });

    it("502s when the dashboard is unreachable", async () => {
      mockDashboardFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      const res = await startPOST(jsonRequest("start", "POST", { providerId: "anthropic" }));
      expect(res.status).toBe(502);
    });
  });

  describe("submit", () => {
    it("rejects bad session ids and codes before touching the dashboard", async () => {
      const bad = [
        { providerId: "anthropic", sessionId: "../sessions", code: "abc#def" },
        { providerId: "anthropic", sessionId: "x", code: "abc#def" },
        { providerId: "anthropic", sessionId: SESSION_ID, code: "has space" },
        { providerId: "anthropic", sessionId: SESSION_ID, code: "" },
        { providerId: "an/thropic", sessionId: SESSION_ID, code: "abc#def" },
      ];
      for (const body of bad) {
        const res = await submitPOST(jsonRequest("submit", "POST", body));
        expect(res.status).toBe(400);
      }
      expect(mockDashboardFetch).not.toHaveBeenCalled();
    });

    it("forwards the pasted code in the dashboard's body shape", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(200, { ok: true }));

      const res = await submitPOST(jsonRequest("submit", "POST", {
        providerId: "anthropic",
        sessionId: SESSION_ID,
        code: "  authcode#state  ",
      }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      const [path, init] = mockDashboardFetch.mock.calls[0];
      expect(path).toBe("/api/providers/oauth/anthropic/submit");
      expect(JSON.parse(init.body)).toEqual({ session_id: SESSION_ID, code: "authcode#state" });
    });

    it("relays a code rejection so the panel can show the dashboard's message", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(400, {
        ok: false,
        status: "error",
        message: "Invalid authorization code",
      }));

      const res = await submitPOST(jsonRequest("submit", "POST", {
        providerId: "anthropic",
        sessionId: SESSION_ID,
        code: "wrongcode",
      }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.message).toBe("Invalid authorization code");
    });
  });

  describe("poll", () => {
    it("validates the query parameters", async () => {
      const urls = [
        `http://localhost/setup-api/hermes/oauth/poll?providerId=anthropic`,
        `http://localhost/setup-api/hermes/oauth/poll?sessionId=${SESSION_ID}`,
        `http://localhost/setup-api/hermes/oauth/poll?providerId=..%2F..&sessionId=${SESSION_ID}`,
        `http://localhost/setup-api/hermes/oauth/poll?providerId=anthropic&sessionId=..%2Fadmin`,
      ];
      for (const url of urls) {
        const res = await pollGET(new Request(url));
        expect(res.status).toBe(400);
      }
      expect(mockDashboardFetch).not.toHaveBeenCalled();
    });

    it("relays the session status from the dashboard's poll endpoint", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(200, {
        session_id: SESSION_ID,
        status: "approved",
        error_message: null,
        expires_at: "2026-08-21T12:00:00Z",
      }));

      const res = await pollGET(new Request(
        `http://localhost/setup-api/hermes/oauth/poll?providerId=openai-codex&sessionId=${SESSION_ID}`,
      ));
      const body = await res.json();

      expect(mockDashboardFetch).toHaveBeenCalledWith(
        `/api/providers/oauth/openai-codex/poll/${SESSION_ID}`,
      );
      expect(res.status).toBe(200);
      expect(body.status).toBe("approved");
      expect(body.expires_at).toBe("2026-08-21T12:00:00Z");
    });

    it("502s when the dashboard is unreachable", async () => {
      mockDashboardFetch.mockRejectedValue(new Error("timeout"));
      const res = await pollGET(new Request(
        `http://localhost/setup-api/hermes/oauth/poll?providerId=anthropic&sessionId=${SESSION_ID}`,
      ));
      expect(res.status).toBe(502);
    });
  });

  describe("cancel", () => {
    it("rejects a malformed session id", async () => {
      const res = await cancelDELETE(jsonRequest("cancel", "DELETE", { sessionId: "../other" }));
      expect(res.status).toBe(400);
      expect(mockDashboardFetch).not.toHaveBeenCalled();
    });

    it("forwards the delete to the dashboard's sessions endpoint", async () => {
      mockDashboardFetch.mockResolvedValue(dashboardResponse(200, { ok: true }));

      const res = await cancelDELETE(jsonRequest("cancel", "DELETE", { sessionId: SESSION_ID }));
      const body = await res.json();

      expect(mockDashboardFetch).toHaveBeenCalledWith(
        `/api/providers/oauth/sessions/${SESSION_ID}`,
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });
});
