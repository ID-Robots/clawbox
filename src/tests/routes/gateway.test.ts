import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/config-store", () => ({
  getAll: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionSigningSecret: vi.fn().mockResolvedValue("test-secret"),
  verifySessionCookie: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/gateway-proxy", () => ({
  redirectToSetup: vi.fn(),
  serveGatewayHTML: vi.fn(),
}));

import { getAll } from "@/lib/config-store";
import { getSessionSigningSecret, verifySessionCookie } from "@/lib/auth";
import { redirectToSetup, serveGatewayHTML } from "@/lib/gateway-proxy";
import { NextResponse } from "next/server";

const mockGetAll = vi.mocked(getAll);
const mockGetSessionSigningSecret = vi.mocked(getSessionSigningSecret);
const mockVerifySessionCookie = vi.mocked(verifySessionCookie);
const mockRedirectToSetup = vi.mocked(redirectToSetup);
const mockServeGatewayHTML = vi.mocked(serveGatewayHTML);

describe("GET / (root route — served by catch-all)", () => {
  let rootGet: (req: NextRequest) => Promise<Response>;

  function createRequest(url: string = "http://localhost/", authenticated = true): NextRequest {
    return new NextRequest(new URL(url), {
      headers: authenticated ? { cookie: "clawbox_session=test-cookie" } : undefined,
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetAll.mockResolvedValue({ setup_complete: false });
    mockGetSessionSigningSecret.mockResolvedValue("test-secret");
    mockVerifySessionCookie.mockReturnValue(true);
    mockRedirectToSetup.mockReturnValue(NextResponse.redirect(new URL("http://localhost/setup"), 302));
    mockServeGatewayHTML.mockResolvedValue(new NextResponse("<html></html>", { status: 200 }));

    const mod = await import("@/app/[...gateway]/route");
    rootGet = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to setup when not complete", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: false });

    const res = await rootGet(createRequest());

    expect(mockRedirectToSetup).toHaveBeenCalled();
  });

  it("serves gateway HTML when setup is complete", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: true });

    await rootGet(createRequest());

    expect(mockServeGatewayHTML).toHaveBeenCalled();
    expect(mockRedirectToSetup).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated requests to login", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: true });

    const res = await rootGet(createRequest("http://localhost/", false));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login?redirect=%2F");
    expect(mockServeGatewayHTML).not.toHaveBeenCalled();
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

  function createRequest(url: string = "http://localhost/chat", authenticated = true): NextRequest {
    return new NextRequest(new URL(url), {
      headers: authenticated ? { cookie: "clawbox_session=test-cookie" } : undefined,
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetAll.mockResolvedValue({ setup_complete: false });
    mockGetSessionSigningSecret.mockResolvedValue("test-secret");
    mockVerifySessionCookie.mockReturnValue(true);
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

  it("rejects an invalid session before serving gateway HTML", async () => {
    mockGetAll.mockResolvedValue({ setup_complete: true, session_generation: 4 });
    mockVerifySessionCookie.mockReturnValue(false);

    const res = await gatewayGet(createRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login?redirect=%2Fchat");
    expect(mockVerifySessionCookie).toHaveBeenCalledWith("test-cookie", "test-secret", 4);
    expect(mockServeGatewayHTML).not.toHaveBeenCalled();
  });

  it.each(["/images/missing.png", "/fonts/missing.woff2"])(
    "returns 404 for unresolved static resource %s",
    async (pathname) => {
      mockGetAll.mockResolvedValue({ setup_complete: true });

      const res = await gatewayGet(createRequest(`http://localhost${pathname}`, false));

      expect(res.status).toBe(404);
      expect(mockGetAll).not.toHaveBeenCalled();
      expect(mockServeGatewayHTML).not.toHaveBeenCalled();
    },
  );

  it("returns 500 on error", async () => {
    mockGetAll.mockRejectedValue(new Error("Config read failed"));

    const res = await gatewayGet(createRequest("http://localhost/chat"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });
});
