import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSetupJson } from "@/lib/fetch-setup-json";

function response(overrides: Partial<Response>): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: "https://example.test/setup-api/vnc",
    json: async () => ({ available: true }),
    ...overrides,
  } as Response;
}

describe("fetchSetupJson", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests JSON and classifies a 401 as expired authentication", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
      return response({ ok: false, status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSetupJson("/setup-api/vnc");

    expect(result.kind).toBe("auth-expired");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies an already-followed login redirect before parsing HTML", async () => {
    const json = vi.fn(async () => {
      throw new SyntaxError("Unexpected token '<'");
    });
    vi.stubGlobal("fetch", vi.fn(async () => response({
      redirected: true,
      url: "https://example.test/login?redirect=%2Fsetup-api%2Fvnc",
      json,
    })));

    const result = await fetchSetupJson("/setup-api/vnc");

    expect(result.kind).toBe("auth-expired");
    expect(json).not.toHaveBeenCalled();
  });

  it("classifies a base-path login redirect as expired authentication", async () => {
    const json = vi.fn(async () => {
      throw new SyntaxError("Unexpected token '<'");
    });
    vi.stubGlobal("fetch", vi.fn(async () => response({
      redirected: true,
      url: "https://example.test/base/login?redirect=%2Fbase%2Fsetup-api%2Fvnc",
      json,
    })));

    const result = await fetchSetupJson("/base/setup-api/vnc");

    expect(result.kind).toBe("auth-expired");
    expect(json).not.toHaveBeenCalled();
  });
});
