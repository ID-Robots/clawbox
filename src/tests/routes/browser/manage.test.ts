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
    // The snap test (is this a small wrapper script or a real browser?) reads
    // size and bytes through ONE handle, so the route opens rather than stats.
    open: vi.fn().mockRejectedValue(new Error("ENOENT")),
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
    // The start page handed to scripts/launch-browser.sh.
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    writeFile: vi.fn().mockResolvedValue(undefined),
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
import path from "path";
import { promisify } from "util";
import { CONFIG_ROOT } from "@/lib/config-store";

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
    vi.mocked(fs.open).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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

    /**
     * The owner's three decisions ride on the SAME answer the app already
     * polls, so the face it shows and the state it shows cannot come from two
     * different moments.
     */
    it("carries the wizard flag and the owner's settings", async () => {
      const res = await GET();
      const body = await res.json();

      expect(body).toHaveProperty("setupComplete");
      expect(body.autoOpen).toBe(true);
      expect(body.startUrl).toBe("https://www.google.com");
    });

    /**
     * "Installed" was never enough to promise a window: scripts/launch-browser.sh
     * refuses the snap wrapper because snap's confinement makes Chromium fail
     * under systemd, so a box with only the snap build answered the panel with
     * a green tick and then a 500 ten seconds after the owner pressed Open.
     */
    it("reports the snap build as installed but not service-safe", async () => {
      vi.mocked(fs.access).mockImplementation(async (p: unknown) => {
        if (String(p) === "/snap/bin/chromium") return undefined;
        throw new Error("ENOENT");
      });

      const res = await GET();
      const body = await res.json();

      expect(body.chromium.installed).toBe(true);
      expect(body.chromium.path).toBe("/snap/bin/chromium");
      expect(body.chromium.serviceSafe).toBe(false);
    });

    it("reports a system binary that only WRAPS the snap as not service-safe", async () => {
      vi.mocked(fs.access).mockImplementation(async (p: unknown) => {
        if (String(p) === "/usr/bin/chromium-browser") return undefined;
        throw new Error("ENOENT");
      });
      vi.mocked(fs.open).mockResolvedValue({
        stat: async () => ({ size: 512 }),
        readFile: async () => "#!/bin/sh\nexec /snap/bin/chromium\n",
        close: async () => undefined,
      } as never);

      const res = await GET();
      const body = await res.json();

      expect(body.chromium.serviceSafe).toBe(false);
    });

    it("reports the Playwright runtime as service-safe", async () => {
      vi.mocked(findPlaywrightChromium).mockReturnValue("/home/clawbox/.cache/ms-playwright/chromium-1180/chrome-linux/chrome");

      const res = await GET();
      const body = await res.json();

      expect(body.chromium.serviceSafe).toBe(true);
      // The browser binary itself is never read to answer this: it is a
      // hundred megabytes and cannot be a snap shim.
      expect(fs.readFile).not.toHaveBeenCalled();
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

    /**
     * TASK-682 — the Playwright CLI is looked for in the CHECKOUT, not the cwd.
     *
     * In production the cwd is `.next/standalone` (Next's standalone server.js
     * chdirs there) and scripts/postbuild.sh copies only the `playwright` and
     * `playwright-core` PACKAGES into that tree — no `node_modules/.bin`. So
     * `path.join(process.cwd(), "node_modules", ".bin", "playwright")` was a
     * guaranteed ENOENT on every box, the failure was swallowed into a
     * console.warn, and the route still answered `{ ok: true }` off whatever
     * apt/snap Chromium was around. Measured read-only on the OpenClaw box
     * 2026-09-05: `node_modules/.bin/playwright` is present and executable in
     * the checkout, and absent under `.next/standalone`.
     */
    it("looks for the Playwright CLI in the checkout, not in the build output", async () => {
      const mockExec = vi.fn().mockRejectedValue(new Error("install failed"));
      vi.mocked(promisify).mockReturnValue(mockExec as never);
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "install-chromium" }),
      });
      await POST(req);

      const looked = vi.mocked(fs.access).mock.calls.map(([p]) => String(p));
      expect(looked).toContain(
        path.join(CONFIG_ROOT, "node_modules", ".bin", "playwright"),
      );
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

    /**
     * The refusal has to be immediate and NAMED. Starting the service anyway
     * meant a ten-second wait for a CDP port that would never open, ending in
     * "Browser failed to start. Check /tmp/clawbox-browser.log" — true, and
     * the wrong remedy.
     */
    it("open-browser refuses a snap-only Chromium in no time, with a reason", async () => {
      vi.mocked(fs.access).mockImplementation(async (p: unknown) => {
        if (String(p) === "/snap/bin/chromium") return undefined;
        throw new Error("ENOENT");
      });
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "open-browser" }),
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe("chromium_not_service_safe");
      // Nothing was started: the service is what would have failed.
      expect(mockExec).not.toHaveBeenCalledWith("/usr/bin/sudo", expect.arrayContaining(["start", "clawbox-browser.service"]), expect.anything());
    });

    it("open-browser hands the start page to the launch script before starting it", async () => {
      vi.mocked(findPlaywrightChromium).mockReturnValue("/home/clawbox/.cache/ms-playwright/chromium-1180/chrome-linux/chrome");
      mockExec.mockResolvedValue({ stdout: "Chromium 146", stderr: "" });
      // Nothing answers the port when the route looks; the browser it starts
      // does, on the readiness poll's first probe.
      let probes = 0;
      mockFetch.mockImplementation(async () => {
        probes += 1;
        if (probes === 1) throw new Error("connection refused");
        return { ok: true, json: async () => ({ Browser: "Chrome/146" }) } as never;
      });
      const req = new Request("http://localhost/setup-api/browser/manage", {
        method: "POST",
        body: JSON.stringify({ action: "open-browser" }),
      });

      const res = await POST(req);
      expect((await res.json()).cdpReady).toBe(true);

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const [file, body] = vi.mocked(fs.writeFile).mock.calls[0] as unknown as [string, string];
      expect(String(file)).toMatch(/\.cache\/clawbox\/browser\.env$/);
      expect(String(body)).toContain("CLAWBOX_BROWSER_START_URL='https://www.google.com'");
      // Before the unit is started, not after: systemd is what reads it.
      const startCall = mockExec.mock.calls.findIndex((call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes("clawbox-browser.service"));
      expect(startCall).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(fs.writeFile).mock.invocationCallOrder[0])
        .toBeLessThan(mockExec.mock.invocationCallOrder[startCall]);
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
