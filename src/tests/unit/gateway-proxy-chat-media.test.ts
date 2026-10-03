import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import { NextRequest } from "next/server";

// TASK-892. A file the agent sends in the web chat is a root-relative gateway
// URL (/api/chat/media/outgoing/<session>/<id>/full). The gateway serves it only
// with its bearer, which the browser never holds, so every download through the
// /api proxy came back 401 — and the proxy dropped Content-Length besides.
const ownerSession = vi.fn<() => Promise<boolean>>();
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: () => ownerSession(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

const mockFs = vi.mocked(fsp);

const MEDIA_PATH = "/api/chat/media/outgoing/agent%3Amain%3Amain/7c9e6679-7425-40de-944b-e07fc1f90ae7/full";
const CSV = "a,b\n1,2\n";

function gatewayFileResponse(method: string): Response {
  return new Response(method === "HEAD" ? null : CSV, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="report.csv"',
      "content-length": String(CSV.length),
    },
  });
}

describe("proxyGatewayRequest — chat media the agent sends", () => {
  let gatewayProxy: typeof import("@/lib/gateway-proxy");
  let mockFetch: ReturnType<typeof vi.fn>;

  function request(path: string, method = "GET", headers?: Record<string, string>): NextRequest {
    return new NextRequest(new URL(`http://clawbox.local${path}`), {
      method,
      headers: new Headers({ cookie: "clawbox_session=abc", ...headers }),
    });
  }

  function upstreamCall(): { url: string; init: RequestInit & { headers: Headers } } {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    return { url, init };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ownerSession.mockResolvedValue(true);
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      gateway: { auth: { token: "gateway-secret-token" } },
    }));
    mockFetch = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(gatewayFileResponse(String(init.method))),
    );
    vi.stubGlobal("fetch", mockFetch);
    gatewayProxy = await import("@/lib/gateway-proxy");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends the gateway bearer for the owner and keeps the download headers", async () => {
    const res = await gatewayProxy.proxyGatewayRequest(request(MEDIA_PATH));

    const { url, init } = upstreamCall();
    expect(url).toBe(`http://127.0.0.1:18789${MEDIA_PATH}`);
    expect(init.headers.get("authorization")).toBe("Bearer gateway-secret-token");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(CSV.length));
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.csv"');
    expect(await res.text()).toBe(CSV);
  });

  it("keeps the query, so ?download=1 reaches the gateway with the bearer", async () => {
    await gatewayProxy.proxyGatewayRequest(request(`${MEDIA_PATH}?download=1`));

    const { url, init } = upstreamCall();
    expect(url).toBe(`http://127.0.0.1:18789${MEDIA_PATH}?download=1`);
    expect(init.headers.get("authorization")).toBe("Bearer gateway-secret-token");
  });

  it("answers HEAD with the size and name and no body", async () => {
    const res = await gatewayProxy.proxyGatewayRequest(request(MEDIA_PATH, "HEAD"));

    const { init } = upstreamCall();
    expect(init.method).toBe("HEAD");
    expect(init.headers.get("authorization")).toBe("Bearer gateway-secret-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(CSV.length));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.csv"');
    expect(res.body).toBeNull();
  });

  it("sends no bearer without an owner session, and the gateway's 401 stands", async () => {
    ownerSession.mockResolvedValue(false);
    mockFetch.mockResolvedValue(new Response('{"error":{"message":"Unauthorized"}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    const res = await gatewayProxy.proxyGatewayRequest(request(MEDIA_PATH, "GET", { cookie: "" }));

    const { init } = upstreamCall();
    expect(init.headers.get("authorization")).toBeNull();
    expect(mockFs.readFile).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("does not pass on a bearer the browser chose for the media path", async () => {
    ownerSession.mockResolvedValue(false);

    await gatewayProxy.proxyGatewayRequest(
      request(MEDIA_PATH, "GET", { authorization: "Bearer attacker-chosen" }),
    );

    expect(upstreamCall().init.headers.get("authorization")).toBeNull();
  });

  it("sends no bearer when the gateway token is not a usable literal", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    }));

    await gatewayProxy.proxyGatewayRequest(request(MEDIA_PATH));

    expect(upstreamCall().init.headers.get("authorization")).toBeNull();
  });

  it("never attaches the bearer to any other gateway path", async () => {
    for (const path of [
      "/api/sessions",
      "/api/chat/media/incoming/s/id/full",
      "/api/chat/media/outgoing",
      "/api/chat/media/outgoing/",
    ]) {
      mockFetch.mockClear();
      await gatewayProxy.proxyGatewayRequest(request(path));
      expect(upstreamCall().init.headers.get("authorization"), path).toBeNull();
    }
    expect(mockFs.readFile).not.toHaveBeenCalled();
  });

  it("never attaches the bearer to a write on the media path", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      mockFetch.mockClear();
      await gatewayProxy.proxyGatewayRequest(request(MEDIA_PATH, method));
      expect(upstreamCall().init.headers.get("authorization"), method).toBeNull();
    }
  });

  it("drops Content-Length on every other path, as before", async () => {
    const res = await gatewayProxy.proxyGatewayRequest(request("/api/sessions"));
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("drops Content-Length when the gateway encoded the body anyway", async () => {
    mockFetch.mockResolvedValue(new Response(CSV, {
      status: 200,
      headers: { "content-encoding": "gzip", "content-length": "5" },
    }));

    const res = await gatewayProxy.proxyGatewayRequest(request(MEDIA_PATH));

    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("isChatMediaOutgoingPath", () => {
  let isChatMediaOutgoingPath: typeof import("@/lib/gateway-proxy").isChatMediaOutgoingPath;

  beforeEach(async () => {
    ({ isChatMediaOutgoingPath } = await import("@/lib/gateway-proxy"));
  });

  it("accepts a file in the outgoing tree", () => {
    expect(isChatMediaOutgoingPath(MEDIA_PATH)).toBe(true);
    expect(isChatMediaOutgoingPath("/api/chat/media/outgoing/agent:main:main/abc/full")).toBe(true);
  });

  it("refuses anything that could walk out of the tree", () => {
    for (const path of [
      "/api/chat/media/outgoing/../../sessions",
      "/api/chat/media/outgoing/s/%2e%2e/x",
      "/api/chat/media/outgoing/s/%2E%2E/x",
      "/api/chat/media/outgoing/s/.",
      "/api/chat/media/outgoing/s/a%2fb",
      "/api/chat/media/outgoing/s/a%5Cb",
      "/api/chat/media/outgoing/s/a%00b",
      "/api/chat/media/outgoing/s//x",
      "/api/chat/media/outgoing/s/x/",
      "/api/chat/media/outgoing/s/%zz",
      "/api/chat/media/outgoing/s",
      "/api/chat/media/outgoingx/s/x",
      "/API/chat/media/outgoing/s/x",
      "/api/chat/media/s/x",
    ]) {
      expect(isChatMediaOutgoingPath(path), path).toBe(false);
    }
  });
});
