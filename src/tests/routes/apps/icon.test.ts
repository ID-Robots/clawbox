import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    stat: vi.fn(),
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

/** A local icon on disk, as `fs.stat` would describe it. */
function localIcon(size: number, mtimeMs: number) {
  vi.mocked(fs.stat).mockResolvedValue({ size, mtimeMs } as never);
  vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("PNG") as never);
}

function noLocalIcon() {
  vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
}

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
    localIcon(1234, 1756000000000);
    const res = await GET(
      new Request("http://localhost/setup-api/apps/icon/test"),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("serves the local icon revalidatable, not immutable: the file under an id can change", async () => {
    // A generated web-app icon goes with its app on uninstall, and the next
    // app to take the id gets a different picture. A browser must ask.
    localIcon(1234, 1756000000000);
    const res = await GET(
      new Request("http://localhost/setup-api/apps/icon/test"),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(res.headers.get("Cache-Control")).toBe("public, no-cache");
    const etag = res.headers.get("ETag");
    expect(etag).toMatch(/^".+"$/);

    // Asking again with that tag costs a stat and answers 304 without a body.
    const again = await GET(
      new Request("http://localhost/setup-api/apps/icon/test", { headers: { "If-None-Match": etag! } }),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(1);

    // A different file under the same id is a different tag.
    localIcon(9876, 1756000005000);
    const changed = await GET(
      new Request("http://localhost/setup-api/apps/icon/test", { headers: { "If-None-Match": etag! } }),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
  });

  it("proxies and caches from remote when local not found", async () => {
    noLocalIcon();
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
    noLocalIcon();
    mockFetch.mockResolvedValue({ ok: false });
    const res = await GET(
      new Request("http://localhost/setup-api/apps/icon/test"),
      { params: Promise.resolve({ appId: "test" }) }
    );
    expect(res.status).toBe(404);
  });
});
