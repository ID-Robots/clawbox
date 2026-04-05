import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/test-data",
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import fs from "fs/promises";

describe("/setup-api/apps/icon/[appId]", () => {
  let GET: (req: Request, ctx: { params: Promise<{ appId: string }> }) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const mod = await import("@/app/setup-api/apps/icon/[appId]/route");
    GET = mod.GET;
  });

  it("returns cached local icon", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("PNG") as never);
    const res = await GET(
      new Request("http://localhost/setup-api/apps/icon/test"),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("proxies and caches from remote when local not found", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
    const res = await GET(
      new Request("http://localhost/setup-api/apps/icon/test"),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("returns 404 when icon not found anywhere", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    mockFetch.mockResolvedValue({ ok: false });
    const res = await GET(
      new Request("http://localhost/setup-api/apps/icon/test"),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(res.status).toBe(404);
  });
});
