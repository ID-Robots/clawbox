import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn().mockReturnValue(vi.fn().mockRejectedValue(new Error("not found"))),
}));

vi.mock("fs/promises", () => ({
  default: {
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn().mockResolvedValue({ tools: { profile: "full" } }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readConfig } from "@/lib/openclaw-config";
import fs from "fs/promises";
import { promisify } from "util";

describe("/setup-api/browser/manage", () => {
  let GET: () => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(readConfig).mockResolvedValue({ tools: { profile: "full" } } as never);
    vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    mockFetch.mockRejectedValue(new Error("connection refused"));
    const mockExec = vi.fn();
    vi.mocked(promisify).mockReturnValue(mockExec as never);
    // checkChromium: "which chromium-browser" etc will all fail
    mockExec.mockRejectedValue(new Error("not found"));
    const mod = await import("@/app/setup-api/browser/manage/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  describe("GET", () => {
    it("returns status when chromium not installed and browser not running", async () => {
      const res = await GET();
      const body = await res.json();
      expect(body.chromium).toBeDefined();
      expect(body.chromium.installed).toBe(false);
      expect(body.browser).toBeDefined();
      expect(body.cdpPort).toBe(18800);
    });

    it("returns enabled true when tools profile is full", async () => {
      const res = await GET();
      const body = await res.json();
      expect(body.enabled).toBe(true);
    });

    it("handles errors gracefully", async () => {
      vi.mocked(readConfig).mockRejectedValue(new Error("file not found"));
      const res = await GET();
      expect(res.status).toBe(500);
    });
  });

  describe("POST", () => {
    it("returns error for unknown action", async () => {
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "unknown" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("handles install-chromium action", async () => {
      const mockExec = vi.fn();
      vi.mocked(promisify).mockReturnValue(mockExec as never);
      mockExec.mockRejectedValue(new Error("install failed"));
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "install-chromium" }),
      });
      const res = await POST(req);
      // Will fail since all install methods fail
      expect(res.status).toBe(500);
    });

    it("handles enable action without chromium", async () => {
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "enable" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("handles disable action", async () => {
      const mockExec = vi.fn().mockRejectedValue(new Error("not found"));
      vi.mocked(promisify).mockReturnValue(mockExec as never);
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "disable" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.enabled).toBe(false);
    });

    it("handles close-browser action", async () => {
      const mockExec = vi.fn().mockRejectedValue(new Error("not running"));
      vi.mocked(promisify).mockReturnValue(mockExec as never);
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "close-browser" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("handles open-browser without chromium", async () => {
      mockFetch.mockRejectedValue(new Error("refused"));
      const mockExec = vi.fn().mockRejectedValue(new Error("not found"));
      vi.mocked(promisify).mockReturnValue(mockExec as never);
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "open-browser" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("handles invalid JSON", async () => {
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: "not json",
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });
});
