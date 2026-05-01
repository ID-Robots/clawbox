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
    readdir: vi.fn().mockRejectedValue(new Error("ENOENT")),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn().mockResolvedValue({ tools: { profile: "full" } }),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
}));

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readConfig } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import fs from "fs/promises";
import { promisify } from "util";

describe("/setup-api/browser/manage", () => {
  let GET: () => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(readConfig).mockResolvedValue({ tools: { profile: "full" } } as never);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    mockFetch.mockRejectedValue(new Error("connection refused"));
    mockExec = vi.fn();
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

    it("detects the Playwright Chromium runtime when it is installed", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: "chromium-1180", isDirectory: () => true },
      ] as never);
      vi.mocked(fs.access).mockImplementation((async (target: unknown) => {
        if (String(target).includes("chrome-linux/chrome")) return undefined as never;
        throw new Error("ENOENT");
      }) as typeof fs.access);
      mockExec.mockImplementation(async (...args: unknown[]) => {
        const [command, commandArgs] = args as [string, string[]];
        if (String(command).includes("chrome-linux/chrome") && commandArgs[0] === "--version") {
          return { stdout: "Chromium 146.0.0", stderr: "" };
        }
        throw new Error("not found");
      });

      const res = await GET();
      const body = await res.json();

      expect(body.chromium.installed).toBe(true);
      expect(body.chromium.path).toContain("chrome-linux/chrome");
    });

    it("returns the persisted enabled state from sqlite when present", async () => {
      vi.mocked(readConfig).mockResolvedValue({ tools: { profile: "coding" } } as never);
      vi.mocked(sqliteGet).mockResolvedValue("true");

      const res = await GET();
      const body = await res.json();

      expect(body.enabled).toBe(true);
    });

    it("returns the persisted disabled state from sqlite when present", async () => {
      vi.mocked(sqliteGet).mockResolvedValue("false");

      const res = await GET();
      const body = await res.json();

      expect(body.enabled).toBe(false);
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
      mockExec.mockResolvedValue({ stdout: "", stderr: "" });
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "disable" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.enabled).toBe(false);
      expect(sqliteSet).toHaveBeenCalledWith("browser:integration-enabled", "false");
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
      mockExec.mockRejectedValue(new Error("not found"));
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

    it("persists the enabled state to sqlite when browser integration is enabled", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined as never);
      mockExec.mockImplementation(async (...args: unknown[]) => {
        const [command, commandArgs] = args as [string, string[]];
        if (command === "/usr/bin/chromium-browser" && commandArgs[0] === "--version") {
          return { stdout: "Chromium 146.0.0", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "enable" }),
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.enabled).toBe(true);
      expect(sqliteSet).toHaveBeenCalledWith("browser:integration-enabled", "true");
    });
  });
});
