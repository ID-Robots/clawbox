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

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/test-data",
  CONFIG_ROOT: "/tmp/test-data",
}));

vi.mock("@/lib/openclaw-config", () => ({
  reloadGateway: vi.fn().mockResolvedValue(undefined),
  getSkillsDir: vi.fn().mockReturnValue("/home/clawbox/.openclaw/workspace"),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("/setup-api/apps/install", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { promisify } = await import("util");
    vi.mocked(promisify).mockReturnValue(vi.fn().mockResolvedValue({ stdout: "installed", stderr: "" }) as never);
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsMod.default.writeFile).mockResolvedValue(undefined);
    const { reloadGateway, getSkillsDir } = await import("@/lib/openclaw-config");
    vi.mocked(reloadGateway).mockResolvedValue(undefined);
    vi.mocked(getSkillsDir).mockReturnValue("/home/clawbox/.openclaw/workspace");
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) });
    const mod = await import("@/app/setup-api/apps/install/route");
    POST = mod.POST;
  });

  it("installs an app successfully", async () => {
    const req = new Request("http://localhost/setup-api/apps/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "test-app" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("test-app");
  });

  it("rejects invalid appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/install", {
      method: "POST",
      body: JSON.stringify({ appId: "../hack" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects missing appId", async () => {
    const req = new Request("http://localhost/setup-api/apps/install", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles icon download failure gracefully", async () => {
    mockFetch.mockResolvedValue({ ok: false });
    const req = new Request("http://localhost/setup-api/apps/install", {
      method: "POST",
      body: JSON.stringify({ appId: "test-app" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.iconSaved).toBe(false);
  });
});
