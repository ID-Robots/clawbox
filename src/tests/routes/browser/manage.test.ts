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
  // enable/disable now route their config writes through this helper instead
  // of shelling out directly; default it to a successful no-op.
  runOpenclawConfigSet: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  // Default to a device that ships the OpenClaw CLI — the edition where the
  // integration is a switch. The Hermes block below flips this.
  openclawIsAbsent: vi.fn().mockReturnValue(false),
  restartGateway: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
}));

// The Playwright runtime lookup is the shared finder in src/lib/cdp-probe.ts
// (unit-tested there against a real directory); here it reads the real
// ~/.cache/ms-playwright, so it must be stubbed or the box's own install
// leaks into "not installed".
vi.mock("@/lib/cdp-probe", () => ({
  findPlaywrightChromium: vi.fn().mockReturnValue(null),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { openclawIsAbsent, readConfig, restartGateway, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import { findPlaywrightChromium } from "@/lib/cdp-probe";
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
    vi.mocked(openclawIsAbsent).mockReturnValue(false);
    vi.mocked(restartGateway).mockResolvedValue(undefined);
    vi.mocked(runOpenclawConfigSet).mockResolvedValue({ stdout: "", stderr: "" } as never);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(findPlaywrightChromium).mockReturnValue(null);
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

    /**
     * TASK-515 regression: the agent's own headless browser answers the CDP
     * port, but no process on the clawbox-browser profile exists. That must
     * be reported as agentBrowsing, never as a running desktop browser.
     */
    it("reports a CDP answerer without a desktop-profile process as agentBrowsing, not running", async () => {
      mockFetch.mockResolvedValue({ ok: true } as never);

      const res = await GET();
      const body = await res.json();

      expect(body.browser.running).toBe(false);
      expect(body.browser.agentBrowsing).toBe(true);
      expect(body.browser.pid).toBeUndefined();
    });

    it("returns enabled true when tools profile is full", async () => {
      const res = await GET();
      const body = await res.json();
      expect(body.enabled).toBe(true);
    });

    it("reports the integration as a switch on an edition that ships the CLI", async () => {
      vi.mocked(readConfig).mockResolvedValue({ tools: { profile: "coding" } } as never);

      const res = await GET();
      const body = await res.json();

      expect(body.alwaysOn).toBe(false);
      expect(body.enabled).toBe(false);
    });

    it("detects the Playwright Chromium runtime when it is installed", async () => {
      const chrome = "/home/clawbox/.cache/ms-playwright/chromium-1180/chrome-linux/chrome";
      vi.mocked(findPlaywrightChromium).mockReturnValue(chrome);
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
      expect(body.chromium.version).toBe("Chromium 146.0.0");
      // The desktop window needs a full chrome: a headless shell is no answer here.
      expect(findPlaywrightChromium).toHaveBeenCalledWith(expect.stringContaining("ms-playwright"), { preferHeadless: false });
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

    /**
     * TASK-515 regression: open-browser used to short-circuit to
     * "alreadyRunning" whenever ANYTHING answered the CDP port — including the
     * agent's headless browser — making the button a no-op that reported
     * success. With the port answering but no desktop-profile process, the
     * route must proceed as "not running" (here: fail on missing Chromium
     * rather than pretend a desktop browser exists).
     */
    it("open-browser does not claim alreadyRunning off the agent's headless browser", async () => {
      mockFetch.mockResolvedValue({ ok: true } as never);
      mockExec.mockRejectedValue(new Error("not found"));
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "open-browser" }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(body.alreadyRunning).toBeUndefined();
      expect(res.status).toBe(400);
      expect(body.error).toContain("Chromium not installed");
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

    it("bounces the gateway through the shared helper, not a hand-rolled systemctl", async () => {
      mockExec.mockResolvedValue({ stdout: "", stderr: "" });
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "disable" }),
      });

      await POST(req);

      // The helper knows which editions have a clawbox-gateway to restart and
      // no-ops on the ones that don't; a raw exec here did not.
      expect(restartGateway).toHaveBeenCalledTimes(1);
      const systemctlCalls = mockExec.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args.includes("clawbox-gateway"),
      );
      expect(systemctlCalls).toHaveLength(0);
    });
  });

  // The Hermes SKU ships no `openclaw` binary, so every one of these actions
  // used to end in "The OpenClaw CLI is not available on this edition." for a
  // capability that was already working: the ClawBox browser_* tools are
  // registered on this edition at every boot. The route must therefore answer
  // "already on" here and never reach for the CLI.
  describe("on an edition with no OpenClaw CLI", () => {
    const chromiumPresent = () => {
      vi.mocked(fs.access).mockResolvedValue(undefined as never);
      mockExec.mockImplementation(async (...args: unknown[]) => {
        const [command, commandArgs] = args as [string, string[]];
        if (command === "/usr/bin/chromium-browser" && commandArgs[0] === "--version") {
          return { stdout: "Chromium 146.0.0", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
    };

    beforeEach(() => {
      vi.mocked(openclawIsAbsent).mockReturnValue(true);
    });

    it("GET reports the integration as on, and flags that there is no switch", async () => {
      const res = await GET();
      const body = await res.json();

      expect(body.enabled).toBe(true);
      expect(body.alwaysOn).toBe(true);
    });

    it("GET does not read an OpenClaw config this edition never writes", async () => {
      await GET();
      expect(readConfig).not.toHaveBeenCalled();
    });

    it("GET stays on even when the OpenClaw switch was once persisted as off", async () => {
      vi.mocked(sqliteGet).mockResolvedValue("false");

      const res = await GET();
      const body = await res.json();

      expect(body.enabled).toBe(true);
    });

    it("enable succeeds without ever calling the OpenClaw CLI", async () => {
      chromiumPresent();
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "enable" }),
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.enabled).toBe(true);
      expect(body.alwaysOn).toBe(true);
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    it("enable still refuses when Chromium is missing", async () => {
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "enable" }),
      });

      const res = await POST(req);

      expect(res.status).toBe(400);
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    });

    it("disable says plainly that there is nothing to turn off", async () => {
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "disable" }),
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.enabled).toBe(true);
      expect(body.error).not.toMatch(/OpenClaw CLI/i);
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(sqliteSet).not.toHaveBeenCalled();
    });

    it("leaves the desktop browser controls alone", async () => {
      mockExec.mockResolvedValue({ stdout: "", stderr: "" });
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "close-browser" }),
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });
});
