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

  it("returns 500 on error", async () => {
    mockGetAll.mockRejectedValue(new Error("Config read failed"));

    const res = await gatewayGet(createRequest("http://localhost/chat"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });
});
