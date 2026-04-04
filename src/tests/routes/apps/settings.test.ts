import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" })),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("/setup-api/apps/settings", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { promisify } = await import("util");
    vi.mocked(promisify).mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" }) as never);
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsMod.default.writeFile).mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/apps/settings/route");
    POST = mod.POST;
  });

  it("rejects invalid appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "../hack", settings: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects missing settings", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles enable/disable setting", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app", settings: { _setEnabled: true } }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
  });

  it("writes config for home-assistant", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({
        appId: "home-assistant",
        settings: { ha_url: "http://ha.local:8123", ha_token: "token123" },
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.configWritten).toBe(true);
  });

  it("returns ok without config writer for unknown app", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({ appId: "unknown-app", settings: { key: "val" } }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.configWritten).toBe(false);
  });

  it("rejects invalid value types", async () => {
    const req = new Request("http://localhost/setup-api/apps/settings", {
      method: "POST",
      body: JSON.stringify({
        appId: "home-assistant",
        settings: { ha_url: ["array"] },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
