import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const CLAWHUB = "https://clawhub.ai/api/v1/skills/";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** The store answers the detail; ClawHub answers (or fails) the publisher lookup. */
function upstream(store: unknown, clawhub?: unknown) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith(CLAWHUB)) {
      if (clawhub === undefined) throw new Error("fetch failed");
      return clawhub;
    }
    return store;
  });
}

const AMBIGUOUS = {
  code: "AMBIGUOUS_SKILL_SLUG",
  matches: [
    { ownerHandle: "steipete", slug: "weather", ref: "@steipete/weather", url: "https://clawhub.ai/steipete/skills/weather" },
    { ownerHandle: "thcjp", slug: "weather", ref: "@thcjp/weather", url: "https://clawhub.ai/thcjp/skills/weather" },
  ],
};

describe("/setup-api/apps/store", () => {
  let GET: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/apps/store/route");
    GET = mod.GET;
  });

  it("proxies store API with default limit", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ apps: [{ id: "test" }] }),
    });
    const req = new Request("http://localhost/setup-api/apps/store");
    const res = await GET(req);
    const body = await res.json();
    expect(body.apps).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("limit=50"),
      expect.anything()
    );
  });

  it("passes category and search params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ apps: [] }),
    });
    const req = new Request("http://localhost/setup-api/apps/store?category=tools&q=test");
    await GET(req);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/category=tools.*q=test|q=test.*category=tools/),
      expect.anything()
    );
  });

  it("returns error on store API failure", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const req = new Request("http://localhost/setup-api/apps/store");
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("returns 502 on network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const req = new Request("http://localhost/setup-api/apps/store");
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  describe("?slug= detail", () => {
    const detail = (slug: string) => GET(new Request(`http://localhost/setup-api/apps/store?slug=${slug}`));

    it("names the publisher ClawHub has and rewrites clawhubUrl to the real page", async () => {
      // The store lists weather-forecast under "weatherpro"; ClawHub's owner
      // is alex098929, and only that page exists.
      upstream(
        jsonResponse(200, { slug: "weather-forecast", developer: "weatherpro", clawhubUrl: "https://clawhub.ai/skills/weather-forecast" }),
        jsonResponse(200, { skill: { slug: "weather-forecast" }, owner: { handle: "alex098929" } }),
      );
      const res = await detail("weather-forecast");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.developer).toBe("weatherpro");
      expect(body.ownerHandle).toBe("alex098929");
      expect(body.clawhubUrl).toBe("https://clawhub.ai/alex098929/skills/weather-forecast");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    });

    it("settles an ambiguous slug by the store's developer and lists every publisher", async () => {
      upstream(
        jsonResponse(200, { slug: "weather", developer: "Steipete", clawhubUrl: "https://clawhub.ai/skills/weather" }),
        jsonResponse(409, AMBIGUOUS),
      );
      const body = await (await detail("weather")).json();
      expect(body.ownerHandle).toBe("steipete");
      expect(body.clawhubUrl).toBe("https://clawhub.ai/steipete/skills/weather");
      // The lookup normalises ClawHub's rows to the documented { ownerHandle,
      // ref, url } shape; whatever else ClawHub sends does not pass through.
      expect(body.clawhubMatches).toEqual(AMBIGUOUS.matches.map(({ ownerHandle, ref, url }) => ({ ownerHandle, ref, url })));
    });

    it("names no publisher for an ambiguous slug the store does not settle, and drops the dead clawhubUrl", async () => {
      upstream(
        jsonResponse(200, { slug: "weather", developer: "ClawHub Community", clawhubUrl: "https://clawhub.ai/skills/weather" }),
        jsonResponse(409, AMBIGUOUS),
      );
      const body = await (await detail("weather")).json();
      expect(body.ownerHandle).toBeNull();
      expect(body.clawhubUrl).toBeUndefined();
      expect(body.clawhubMatches).toHaveLength(2);
    });

    it("still answers the store's record when ClawHub is unreachable", async () => {
      upstream(jsonResponse(200, { slug: "x", developer: "someone", clawhubUrl: "https://clawhub.ai/skills/x" }));
      const res = await detail("x");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ownerHandle).toBeNull();
      expect(body.clawhubUrl).toBeUndefined();
    });

    it("forwards a store miss as-is", async () => {
      upstream(jsonResponse(404, null), jsonResponse(404, "Skill not found"));
      expect((await detail("nope")).status).toBe(404);
    });

    it("rejects a slug that is not one", async () => {
      expect((await detail("../x")).status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
