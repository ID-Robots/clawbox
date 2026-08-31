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
  getAll: vi.fn().mockResolvedValue({}),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import fs from "fs/promises";
import { getAll } from "@/lib/config-store";

/** A local icon on disk, as `fs.stat` would describe it. */
function localIcon(size: number, mtimeMs: number) {
  vi.mocked(fs.stat).mockResolvedValue({ size, mtimeMs } as never);
  vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("PNG") as never);
}

function noLocalIcon() {
  vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));
  vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
}

/** Let the fire-and-forget disk write (or its absence) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("/setup-api/apps/icon/[appId]", () => {
  let GET: (req: Request, ctx: { params: Promise<{ appId: string }> }) => Promise<Response>;

  const icon = (appId = "test") =>
    GET(new Request(`http://localhost/setup-api/apps/icon/${appId}`), { params: Promise.resolve({ appId }) });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(getAll).mockResolvedValue({});
    const mod = await import("@/app/setup-api/apps/icon/[appId]/route");
    GET = mod.GET;
  });

  it("returns cached local icon", async () => {
    localIcon(1234, 1756000000000);
    const res = await icon();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("serves the local icon revalidatable, not immutable: the file under an id can change", async () => {
    // A generated web-app icon goes with its app on uninstall, and the next
    // app to take the id gets a different picture. A browser must ask.
    localIcon(1234, 1756000000000);
    const res = await icon();
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

  it("proxies a browsed icon from the store without persisting it", async () => {
    noLocalIcon();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
    const res = await icon();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    await settle();
    // Not installed: one Store session used to leave 62 MB of these behind.
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("persists the proxied icon for an installed app, as the repair for a failed install-time download", async () => {
    noLocalIcon();
    vi.mocked(getAll).mockResolvedValue({ "pref:installed_apps": ["test"] });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
    await icon();
    await settle();
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fs.writeFile).mock.calls[0][0])).toBe("/tmp/test-data/icons/test.png");
  });

  it("remembers an icon the store does not have and stops asking for it", async () => {
    noLocalIcon();
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const first = await icon();
    expect(first.status).toBe(404);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=600");

    const second = await icon();
    expect(second.status).toBe(404);
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // A different id is its own question.
    await icon("other");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not remember a transient failure: a timeout or 5xx is asked again", async () => {
    noLocalIcon();
    mockFetch.mockRejectedValue(new Error("TimeoutError"));
    const first = await icon();
    expect(first.status).toBe(404);
    expect(first.headers.get("Cache-Control")).toBeNull();

    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await icon();
    await icon();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("finds an icon that landed on disk after the store said it had none", async () => {
    noLocalIcon();
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await icon();
    // A generated web-app icon, or an install-time download.
    localIcon(1234, 1756000000000);
    const res = await icon();
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
