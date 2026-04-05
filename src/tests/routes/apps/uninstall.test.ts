import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  reloadGateway: vi.fn().mockResolvedValue(undefined),
  getSkillsDir: vi.fn().mockReturnValue("/home/clawbox/.openclaw/workspace"),
}));

describe("/setup-api/apps/uninstall", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { reloadGateway, getSkillsDir } = await import("@/lib/openclaw-config");
    vi.mocked(reloadGateway).mockResolvedValue(undefined);
    vi.mocked(getSkillsDir).mockReturnValue("/home/clawbox/.openclaw/workspace");
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.rm).mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/apps/uninstall/route");
    POST = mod.POST;
  });

  it("uninstalls an app successfully", async () => {
    const req = new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body).toEqual({ ok: true, appId: "test-app" });
  });

  it("rejects invalid appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId: "../hack" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects missing appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles uninstall error gracefully", async () => {
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.rm).mockRejectedValue(new Error("Permission denied"));
    const req = new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
