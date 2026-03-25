import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/config-store", () => ({
  getAll: vi.fn(),
}));

vi.mock("@/lib/gateway-proxy", () => ({
  redirectToSetup: vi.fn(),
  serveGatewayHTML: vi.fn(),
}));

import { getAll } from "@/lib/config-store";
import { redirectToSetup, serveGatewayHTML } from "@/lib/gateway-proxy";
import { NextResponse } from "next/server";

const mockGetAll = vi.mocked(getAll);
const mockRedirectToSetup = vi.mocked(redirectToSetup);
const mockServeGatewayHTML = vi.mocked(serveGatewayHTML);

describe("GET / (root route — served by catch-all)", () => {
  let rootGet: (req: NextRequest) => Promise<Response>;

  function createRequest(url: string = "http://localhost/"): NextRequest {
    return new NextRequest(new URL(url));
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetAll.mockResolvedValue({ setup_complete: false });
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

  function createRequest(url: string = "http://localhost/chat"): NextRequest {
    return new NextRequest(new URL(url));
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

  it("returns 500 on error", async () => {
    mockGetAll.mockRejectedValue(new Error("Config read failed"));

    const res = await gatewayGet(createRequest("http://localhost/chat"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });
});
