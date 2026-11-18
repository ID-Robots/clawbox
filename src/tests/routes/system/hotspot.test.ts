import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/root-step-runner", () => ({
  ROOT_STEP_LAUNCHER: "/usr/local/libexec/clawbox/clawbox-run-root-step.sh",
  startRootStep: vi.fn(async () => {}),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// config.json, in memory. The hotspot's env file is written for real, under a
// temp CLAWBOX_ROOT: it is the file the AP scripts obey (#1517).
const { store, applyToStore } = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const applyToStore = async (entries: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) delete store[k];
      else store[k] = v;
    }
  };
  return { store, applyToStore };
});
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store[key]),
  setMany: vi.fn(applyToStore),
  getAll: vi.fn(async () => ({ ...store })),
}));

import { setMany } from "@/lib/config-store";
import { startRootStep } from "@/lib/root-step-runner";

const mockSetMany = vi.mocked(setMany);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockStartRootStep = vi.mocked(startRootStep);

let root: string;
const envFile = () => path.join(root, "data", "hotspot.env");
const readEnv = () => readFileSync(envFile(), "utf8");

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const key = `${cmd} ${args.join(" ")}`;

    let result = results[key];
    if (!result) {
      for (const k of Object.keys(results)) {
        if (key.includes(k) || k.includes(cmd)) {
          result = results[k];
          break;
        }
      }
    }

    // Handle both callback and promisified usage
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }

    // For promisified version, return a thenable object
    const returnObj = {
      then: (resolve: (value: { stdout: string; stderr: string }) => void, reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result || { stdout: "", stderr: "" });
        }
        return returnObj;
      },
      catch: (reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        }
        return returnObj;
      },
    };
    return returnObj as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("/setup-api/system/hotspot", () => {
  let hotspotGet: () => Promise<Response>;
  let hotspotPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    for (const k of Object.keys(store)) delete store[k];
    // A test below makes setMany reject; every test starts on the real store.
    mockSetMany.mockImplementation(applyToStore);
    root = mkdtempSync(path.join(tmpdir(), "clawbox-hotspot-route-"));
    mkdirSync(path.join(root, "data"), { recursive: true });
    vi.stubEnv("CLAWBOX_ROOT", root);
    setupExecFileMock({
      systemctl: { stdout: "", stderr: "" },
      bash: { stdout: "", stderr: "" },
    });

    const mod = await import("@/app/setup-api/system/hotspot/route");
    hotspotGet = mod.GET;
    hotspotPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  describe("GET /setup-api/system/hotspot", () => {
    it("returns default hotspot config", async () => {
      const res = await hotspotGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ssid).toBe("ClawBox-Setup");
      expect(body.hasPassword).toBe(false);
      expect(body.enabled).toBe(true);
    });

    it("returns configured hotspot settings", async () => {
      Object.assign(store, {
        hotspot_ssid: "MyHotspot",
        hotspot_password: "secret123",
        hotspot_enabled: false,
      });

      const res = await hotspotGet();
      const body = await res.json();

      expect(body.ssid).toBe("MyHotspot");
      expect(body.hasPassword).toBe(true);
      expect(body.enabled).toBe(false);
    });

    describe("after setup, the switch is the one the AP scripts obey (#1517)", () => {
      it("says ON for the reported box: config off, env file never told, AP up", async () => {
        // data/config.json hotspot_enabled=false, data/hotspot.env without
        // HOTSPOT_DISABLED, and nmcli showing the AP active on the radio.
        Object.assign(store, { setup_complete: true, hotspot_enabled: false });
        writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\n");
        setupExecFileMock({
          nmcli: { stdout: "ClawBox-Setup:802-11-wireless:wlP1p1s0\nWired connection 1:802-3-ethernet:enP8p1s0\n", stderr: "" },
        });

        const body = await (await hotspotGet()).json();

        expect(body).toMatchObject({ enabled: true, active: true });
      });

      it("says OFF when HOTSPOT_DISABLED=1, even over a stale config flag that says on", async () => {
        Object.assign(store, { setup_complete: true, hotspot_enabled: true });
        writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_DISABLED=1\n");

        const body = await (await hotspotGet()).json();

        expect(body.enabled).toBe(false);
      });
    });

    describe("`active` is the radio, not the profile name", () => {
      it("reports an interface in AP mode as broadcasting even without a ClawBox-Setup row", async () => {
        Object.assign(store, { setup_complete: true });
        writeFileSync(envFile(), "HOTSPOT_DISABLED=1\n");
        setupExecFileMock({
          "nmcli": { stdout: "Wired connection 1:802-3-ethernet:enP8p1s0\n", stderr: "" },
          "iw dev wlP1p1s0 info": { stdout: "Interface wlP1p1s0\n\tifindex 4\n\ttype AP\n", stderr: "" },
        });

        const body = await (await hotspotGet()).json();

        // Off, and still broadcasting: Settings shows both.
        expect(body).toMatchObject({ enabled: false, active: true });
      });

      it("a managed (client) interface is not broadcasting", async () => {
        setupExecFileMock({
          "nmcli": { stdout: "HomeWiFi:802-11-wireless:wlP1p1s0\n", stderr: "" },
          "iw dev wlP1p1s0 info": { stdout: "Interface wlP1p1s0\n\ttype managed\n", stderr: "" },
        });

        const body = await (await hotspotGet()).json();

        expect(body).toMatchObject({ enabled: true, active: false, blockedBy: "HomeWiFi" });
      });
    });
  });

  describe("POST /setup-api/system/hotspot", () => {
    it("saves hotspot settings successfully", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "NewHotspot", password: "password123" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({
        hotspot_ssid: "NewHotspot",
        hotspot_password: "password123",
        hotspot_enabled: true,
      });
      expect(readEnv()).toBe("HOTSPOT_SSID='NewHotspot'\nHOTSPOT_PASSWORD='password123'\n");
    });

    it("returns 400 for invalid JSON", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await hotspotPost(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid JSON");
    });

    it("returns 400 for missing SSID", async () => {
      const res = await hotspotPost(jsonRequest({}));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Hotspot name is required");
    });

    it("returns 400 for empty SSID", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "  " }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Hotspot name is required");
    });

    it("returns 400 for SSID too long", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "a".repeat(33) }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("32 characters");
    });

    it("returns 400 for password too short", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", password: "short" }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("at least 8 characters");
    });

    it("returns 400 for password too long", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", password: "a".repeat(64) }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("63 characters");
    });

    it("saves without password", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "OpenHotspot" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({
        hotspot_ssid: "OpenHotspot",
        hotspot_password: undefined,
        hotspot_enabled: true,
      });
    });

    it("handles enabled flag", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: false }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({
        hotspot_ssid: "MyHotspot",
        hotspot_password: undefined,
        hotspot_enabled: false,
      });
      expect(readEnv()).toBe("HOTSPOT_SSID='MyHotspot'\nHOTSPOT_DISABLED=1\n");
    });

    it("switching off writes the flag the AP scripts read, and runs stop-ap.sh", async () => {
      Object.assign(store, { setup_complete: true, hotspot_enabled: true, hotspot_password: "keep-me-123" });
      writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_PASSWORD='keep-me-123'\n");

      const body = await (await hotspotPost(jsonRequest({ ssid: "ClawBox-Setup", enabled: false }))).json();

      expect(body.apAction).toBe("stopped");
      expect(readEnv()).toContain("HOTSPOT_DISABLED=1");
      // The key is kept: the toggle does not resend it.
      expect(readEnv()).toContain("HOTSPOT_PASSWORD='keep-me-123'");
      expect(mockExecFile).toHaveBeenCalledWith(
        "bash", ["/usr/local/libexec/clawbox/stop-ap.sh"], expect.anything(), expect.anything(),
      );
      expect((await (await hotspotGet()).json()).enabled).toBe(false);
    });

    it("switching on clears the flag and restarts the AP", async () => {
      Object.assign(store, { setup_complete: true, hotspot_enabled: false });
      writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_DISABLED=1\n");

      const body = await (await hotspotPost(jsonRequest({ ssid: "ClawBox-Setup", enabled: true }))).json();

      expect(body.apAction).toBe("restarted");
      expect(readEnv()).not.toContain("HOTSPOT_DISABLED");
      expect(store.hotspot_enabled).toBe(true);
      expect(mockStartRootStep).toHaveBeenCalledWith("restart_ap", expect.anything());
    });

    it("a save without `enabled` keeps the switch where the AP scripts have it, not where stale config says", async () => {
      // The drifted box again. Renaming its hotspot must not quietly switch
      // it off on the strength of a config flag the radio never obeyed.
      Object.assign(store, { setup_complete: true, hotspot_enabled: false });
      writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\n");

      await hotspotPost(jsonRequest({ ssid: "Renamed" }));

      expect(readEnv()).toBe("HOTSPOT_SSID='Renamed'\n");
      expect(store.hotspot_enabled).toBe(true);
    });

    it("starts AP when enabled", async () => {
      await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));

      expect(mockExecFile).toHaveBeenCalled();
    });

    it("stops AP when disabled", async () => {
      await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: false }));

      // Should call bash with stop-ap.sh
      expect(mockExecFile).toHaveBeenCalled();
    });

    it("continues even if AP toggle fails", async () => {
      // The restart runs through the root-step launcher now, so that is where
      // the failure has to be injected — a throwing systemctl no longer
      // reaches this path at all.
      mockStartRootStep.mockRejectedValueOnce(new Error("Service failed"));
      setupExecFileMock({
        systemctl: new Error("Service failed"),
        bash: new Error("Script failed"),
      });

      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));
      const body = await res.json();

      // Should still succeed because AP toggle failure is non-fatal
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
    });

    describe("the AP verdict is a fact, not a leftover boolean", () => {
      /**
       * `{ success: true, apRestarted: false }` was the answer to THREE
       * different things: "we deliberately held off", "we stopped it as asked"
       * and "the toggle threw and nothing happened". The wizard read the same
       * bytes in all three and showed "Settings saved!" — including for the box
       * whose hotspot is not in the state its owner just asked for.
       */

      it("distinguishes a deliberate deferral from a failure", async () => {
        // Deferral: the radio is a client on a real network, so bouncing the AP
        // would sever THIS connection. Nothing failed.
        setupExecFileMock({
          nmcli: { stdout: "HomeWiFi:802-11-wireless:wlP1p1s0", stderr: "" },
          systemctl: { stdout: "", stderr: "" },
        });

        const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.apRestarted).toBe(false);
        expect(body.apAction).toBe("deferred");
        expect(body.warning).toBeUndefined();
      });

      it("names a failed AP restart as failed, and says why", async () => {
        mockStartRootStep.mockRejectedValueOnce(new Error("Service failed"));
        setupExecFileMock({
          systemctl: new Error("Service failed"),
          bash: new Error("Script failed"),
        });

        const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));
        const body = await res.json();

        expect(body.apRestarted).toBe(false);
        expect(body.apAction).toBe("failed");
        expect(body.warning).toMatch(/could not restart/i);
      });

      it("names a failed AP stop as failed, so 'off' is not claimed for a live radio", async () => {
        setupExecFileMock({ bash: new Error("Script failed") });

        const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: false }));
        const body = await res.json();

        expect(body.apAction).toBe("failed");
        expect(body.warning).toMatch(/still be broadcasting/i);
      });

      it("names a clean stop as stopped", async () => {
        const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: false }));
        const body = await res.json();

        expect(body.apAction).toBe("stopped");
        expect(body.apRestarted).toBe(false);
        expect(body.warning).toBeUndefined();
      });

      it("names a real restart as restarted, and keeps apRestarted true for the handoff", async () => {
        const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));
        const body = await res.json();

        expect(body.apAction).toBe("restarted");
        expect(body.apRestarted).toBe(true);
      });

      it("waits on the restart for the AP unit's own bounds, not less", async () => {
        // At 450 s a restart systemd still counted as healthy (TimeoutStartSec
        // is 600 for the start half alone) came back here as `failed`.
        const { RESTART_AP_TIMEOUT_MS } = await import("@/lib/network");
        await hotspotPost(jsonRequest({ ssid: "MyHotspot", enabled: true }));

        expect(mockStartRootStep).toHaveBeenCalledWith("restart_ap", { timeoutMs: RESTART_AP_TIMEOUT_MS });
        expect(RESTART_AP_TIMEOUT_MS).toBeGreaterThan(600_000);
      });
    });

    it("does not answer the next GET out of a cache the save just invalidated", async () => {
      // GET caches for 3s. Without an invalidation the reload that follows a
      // save is answered with the settings it just replaced.
      Object.assign(store, { hotspot_ssid: "OldName", hotspot_enabled: true });
      expect((await (await hotspotGet()).json()).ssid).toBe("OldName");

      await hotspotPost(jsonRequest({ ssid: "NewName" }));

      expect((await (await hotspotGet()).json()).ssid).toBe("NewName");
    });

    it("returns 500 on setMany failure", async () => {
      mockSetMany.mockRejectedValue(new Error("Config write failed"));

      const res = await hotspotPost(jsonRequest({ ssid: "MyHotspot" }));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe("Config write failed");
    });

    it("trims SSID whitespace", async () => {
      const res = await hotspotPost(jsonRequest({ ssid: "  MyHotspot  " }));

      expect(res.status).toBe(200);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ hotspot_ssid: "MyHotspot" })
      );
    });
  });
});
