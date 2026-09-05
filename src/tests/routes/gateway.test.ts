import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/config-store", () => ({
  getAll: vi.fn(),
}));

vi.mock("@/lib/gateway-proxy", () => ({
  redirectToSetup: vi.fn(),
  serveGatewayHTML: vi.fn(),
  proxyGatewayRequest: vi.fn(),
}));

// PINNED, not inherited. The route's Hermes gate answers 404 for EVERY path,
// so on a runner whose /etc/clawbox/edition.env or CLAWBOX_EDITION says hermes
// every 404 assertion below would pass from that gate — even with the
// namespace check deleted. The branch under test is the OpenClaw one.
vi.mock("@/lib/edition-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/edition-source")>()),
  readEdition: () => "openclaw" as const,
}));

import { getAll } from "@/lib/config-store";
import { proxyGatewayRequest, redirectToSetup, serveGatewayHTML } from "@/lib/gateway-proxy";
import { NextResponse } from "next/server";

const mockGetAll = vi.mocked(getAll);
const mockRedirectToSetup = vi.mocked(redirectToSetup);
const mockServeGatewayHTML = vi.mocked(serveGatewayHTML);
const mockProxyGatewayRequest = vi.mocked(proxyGatewayRequest);

describe("GET / (root route — served by catch-all)", () => {
  let rootGet: (req: NextRequest) => Promise<Response>;

  // The catch-all serves the SPA shell only to a NAVIGATION now: it was
  // answering every unmatched path that way, including the resources the app
  // fetches for itself (/control-ui-config.json, /avatar/*, /health), which
  // then got HTML that parses as nothing. So the default request here is
  // shaped like the browser page-load these tests are about.
  function createRequest(url: string = "http://localhost/", headers?: Record<string, string>): NextRequest {
    return new NextRequest(new URL(url), {
      headers: new Headers({ accept: "text/html,application/xhtml+xml", ...headers }),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetAll.mockResolvedValue({ setup_complete: false });
    mockRedirectToSetup.mockReturnValue(NextResponse.redirect(new URL("http://localhost/setup"), 302));
    mockServeGatewayHTML.mockResolvedValue(new NextResponse("<html></html>", { status: 200 }));
    mockProxyGatewayRequest.mockResolvedValue(new NextResponse("{}", { status: 200 }));

    const mod = await import("@/app/[...gateway]/route");
    rootGet = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to setup when not complete", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: false });

    await rootGet(createRequest());

    expect(mockRedirectToSetup).toHaveBeenCalled();
  });

  it("serves gateway HTML when setup is complete", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await rootGet(createRequest());

    expect(mockServeGatewayHTML).toHaveBeenCalled();
    expect(mockRedirectToSetup).not.toHaveBeenCalled();
  });

  it("proxies a non-navigation request instead of answering with the shell", async () => {
    // /control-ui-config.json is fetched twice per page load, /avatar/<agent>
    // by the sidebar, /health by an uptime monitor. Each was answered 200
    // text/html with the 19 KB app shell; the JSON ones failed to parse and
    // the monitor saw a 200 that meant nothing.
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await rootGet(createRequest("http://localhost/control-ui-config.json", { accept: "*/*" }));

    expect(mockServeGatewayHTML).not.toHaveBeenCalled();
    expect(mockProxyGatewayRequest).toHaveBeenCalled();
  });

  it("returns 500 on error", async () => {
    mockGetAll.mockRejectedValue(new Error("Config read failed"));

    const res = await rootGet(createRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });
});

describe("GET /[...gateway] (catch-all route)", () => {
  let gatewayGet: (req: NextRequest) => Promise<Response>;

  // Same rule as above: the shell is for navigations, so this is shaped like
  // the browser deep-link (/chat/main) these tests describe.
  function createRequest(url: string = "http://localhost/chat", headers?: Record<string, string>): NextRequest {
    return new NextRequest(new URL(url), {
      headers: new Headers({ accept: "text/html,application/xhtml+xml", ...headers }),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetAll.mockResolvedValue({ setup_complete: false });
    mockRedirectToSetup.mockReturnValue(NextResponse.redirect(new URL("http://localhost/setup"), 302));
    mockServeGatewayHTML.mockResolvedValue(new NextResponse("<html></html>", { status: 200 }));

    const mod = await import("@/app/[...gateway]/route");
    gatewayGet = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to setup when not complete", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: false });

    await gatewayGet(createRequest());

    expect(mockRedirectToSetup).toHaveBeenCalled();
  });

  it("serves gateway HTML when setup is complete", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await gatewayGet(createRequest());

    expect(mockServeGatewayHTML).toHaveBeenCalled();
  });

  it("proxies a script fetch that asks for text/html but says sec-fetch-mode: cors", async () => {
    // Fetch metadata is the authority when the browser sends it: a `fetch()`
    // from a script says `cors` whatever its Accept header, and it wants the
    // resource, not the shell. The Accept sniff is only for clients that send
    // no metadata at all.
    mockGetAll.mockResolvedValue({ setup_complete: true });
    mockProxyGatewayRequest.mockResolvedValue(new NextResponse("{}", { status: 200 }));

    await gatewayGet(
      createRequest("http://localhost/control-ui-config.json", { "sec-fetch-mode": "cors", accept: "text/html" }),
    );

    expect(mockProxyGatewayRequest).toHaveBeenCalled();
    expect(mockServeGatewayHTML).not.toHaveBeenCalled();
  });

  it("answers 404 for a /setup-api path no route handler matched", async () => {
    // /setup-api/ is ClawBox's own namespace and the gateway serves nothing
    // under it, so an unmatched path there is a missing route — not something
    // to proxy (502 from a gateway that never heard of it) or to answer with
    // the SPA shell. A client probing for an endpoint must be able to tell
    // "not here" from "down".
    mockGetAll.mockResolvedValue({ setup_complete: true });

    const res = await gatewayGet(createRequest("http://localhost/setup-api/ai-models/providers", { accept: "*/*" }));

    expect(res.status).toBe(404);
    expect(mockProxyGatewayRequest).not.toHaveBeenCalled();
    expect(mockServeGatewayHTML).not.toHaveBeenCalled();
  });

  /**
   * TASK-631 (F-29). The guard above tested `startsWith("/setup-api/")`, with
   * the slash, so ClawBox's own namespace ROOT fell through it — and a
   * navigation is answered with the Control UI shell, into which
   * `serveGatewayHTML` injects the gateway token for an owner session.
   *
   * Measured on an OpenClaw box at beta head c2b1a44b, owner-authenticated:
   *
   *   GET /setup-api        -> 200 text/html, Control UI, token script present
   *   GET /setup-api/       -> 308 to /setup-api, then the same
   *   GET /portal           -> 200 text/html, Control UI, token script present
   *   GET /portal/nope      -> same
   *   GET /login-api/nope   -> same
   *   GET /setup-api/nope   -> 404 text/plain   (the half already fixed)
   *
   * `/api` and `/assets` are deliberately NOT in this list: those are the
   * GATEWAY's namespaces, which this route exists to serve.
   */
  const CLAWBOX_OWNED_UNMATCHED: [string, "api" | "page"][] = [
    ["http://localhost/setup-api", "api"],
    ["http://localhost/setup-api/nope", "api"],
    ["http://localhost/Setup-Api/nope", "api"],
    ["http://localhost/login-api/nope", "api"],
    ["http://localhost/portal", "page"],
    ["http://localhost/portal/nope", "page"],
    ["http://localhost/Portal/nope", "page"],
    ["http://localhost/setup/nope", "page"],
    ["http://localhost/login/nope", "page"],
    ["http://localhost/updating/nope", "page"],
    ["http://localhost/app", "page"],
    ["http://localhost/app/x/y", "page"],
    // Percent-encoded separators. Measured anonymously on BOTH boxes:
    // `GET /setup-api/nope` answers 401 application/json from the middleware's
    // own /setup-api gate and `GET /setup-api%2Fnope` answers 307 to /login,
    // so that gate did not recognise it — the platform does not decode `%2F`.
    // These stay one segment, match no route, and reached the catch-all, which
    // answered a navigation with the shell and the injected gateway token.
    ["http://localhost/setup-api%2Fnope", "api"],
    ["http://localhost/setup-api%2fnope", "api"],
    ["http://localhost/Setup-Api%2Fnope", "api"],
    ["http://localhost/login-api%2Fnope", "api"],
    ["http://localhost/portal%2Fnope", "page"],
    ["http://localhost/app%2fx", "page"],
    // Double-encoded: one decode leaves `%2F` behind, so the match has to go
    // to a fixpoint.
    ["http://localhost/setup%252Fnope", "page"],
  ];

  it.each(CLAWBOX_OWNED_UNMATCHED)(
    "answers 404 for %s rather than the gateway shell",
    async (url, kind) => {
      mockGetAll.mockResolvedValue({ setup_complete: true });

      // The browser's own navigation metadata — the shape that gets the shell
      // and therefore the token.
      const res = await gatewayGet(
        createRequest(url, { "sec-fetch-mode": "navigate", accept: "text/html" }),
      );

      expect(res.status).toBe(404);
      expect(mockServeGatewayHTML).not.toHaveBeenCalled();
      expect(mockProxyGatewayRequest).not.toHaveBeenCalled();
      // The SHAPE, not just the status: code asked for the endpoint
      // namespaces, so code is answered.
      if (kind === "api") {
        expect(res.headers.get("content-type")).toContain("application/json");
        await expect(res.json()).resolves.toEqual({ error: "Not found" });
      } else {
        expect(res.headers.get("content-type")).toContain("text/plain");
        await expect(res.text()).resolves.toBe("Not found");
      }
    },
  );

  it("still serves the shell for the gateway's OWN namespaces", async () => {
    // The other half of the boundary: a prefix test that swallowed /api or
    // /assets would break the Control UI this route exists to serve.
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await gatewayGet(
      createRequest("http://localhost/chat/main", { "sec-fetch-mode": "navigate" }),
    );

    expect(mockServeGatewayHTML).toHaveBeenCalled();
  });

  /**
   * The other side of the probe, recorded because each of these is a RESULT
   * and not an oversight: nothing here belongs to ClawBox, decoded or not, so
   * the catch-all must go on serving it.
   */
  it.each([
    // `/apps` is the Control UI's OWN page — the pinned 2026.8.1 bundle
    // registers `apps:{path:`/apps`}` and ships apps-page-*.js/.css — so the
    // shell is the RIGHT answer here and a 404 would break a working page.
    // Everything BELOW it is ClawBox's and is matched by a real route
    // (`[[...path]]` is an optional catch-all), so it never arrives here.
    "http://localhost/apps",
    "http://localhost/apps/",
    "http://localhost/apps%2Fzzz",
    // `%2e%2e` decodes to `..` inside the SAME segment: `/apps%2e%2e` is
    // `/apps..`, no more ClawBox's than `/appsomething`. A real `/apps/..` is
    // normalised to `/` by the platform before anything here sees it.
    "http://localhost/setup%2e%2e",
    "http://localhost/setup%2E%2E",
    "http://localhost/setupsomething%2Fx",
  ])("leaves %s with the gateway, decoded or not", async (url) => {
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await gatewayGet(createRequest(url, { "sec-fetch-mode": "navigate" }));

    expect(mockServeGatewayHTML).toHaveBeenCalled();
  });

  it("does not swallow a path that merely STARTS with an owned prefix", async () => {
    // `/setupsomething` is not under `/setup`. The match is on a segment
    // boundary, which is also why `/setup-api` never folded into `/setup`.
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await gatewayGet(
      createRequest("http://localhost/setupsomething", { "sec-fetch-mode": "navigate" }),
    );

    expect(mockServeGatewayHTML).toHaveBeenCalled();
  });

  it("returns 500 on error", async () => {
    mockGetAll.mockRejectedValue(new Error("Config read failed"));

    const res = await gatewayGet(createRequest("http://localhost/chat"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });
});
