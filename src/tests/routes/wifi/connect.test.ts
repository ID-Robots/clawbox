import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

// vi.mock is hoisted above this file's top-level code, so the auth-error class
// the factory returns must be built inside vi.hoisted() to exist when it runs.
const { FakeWifiAuthError, FakeWifiRadioOffError } = vi.hoisted(() => {
  class FakeWifiAuthError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "WifiAuthError";
    }
  }
  class FakeWifiRadioOffError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "WifiRadioOffError";
    }
  }
  return { FakeWifiAuthError, FakeWifiRadioOffError };
});

vi.mock("@/lib/network", () => ({
  switchToClient: vi.fn(),
  setConnectStatus: vi.fn(),
  WifiAuthError: FakeWifiAuthError,
  WifiRadioOffError: FakeWifiRadioOffError,
}));

// config.json in memory; data/hotspot.env for real, under a temp CLAWBOX_ROOT,
// because that file is what the AP scripts obey (#1517).
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
  set: vi.fn(async (key: string, value: unknown) => applyToStore({ [key]: value })),
  setMany: vi.fn(applyToStore),
  get: vi.fn(async (key: string) => store[key]),
  getAll: vi.fn(async () => ({ ...store })),
  getKnownMany: vi.fn(async (keys: string[]) => ({
    values: Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
    known: true,
  })),
}));

import { switchToClient, setConnectStatus, WifiAuthError, WifiRadioOffError } from "@/lib/network";
import { set } from "@/lib/config-store";

const mockSwitchToClient = vi.mocked(switchToClient);
const mockSetConnectStatus = vi.mocked(setConnectStatus);
const mockSet = vi.mocked(set);

// Runs the shipped AP scripts: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
const envFile = () => path.join(root, "data", "hotspot.env");

describe("POST /setup-api/wifi/connect", () => {
  let wifiConnectPost: (req: Request) => Promise<Response>;
  let session: SessionFixture;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    session = installSessionFixture();

    mockSwitchToClient.mockResolvedValue({ message: "connected", ip: null });
    for (const k of Object.keys(store)) delete store[k];
    root = mkdtempSync(path.join(tmpdir(), "clawbox-wifi-connect-"));
    mkdirSync(path.join(root, "data"), { recursive: true });
    vi.stubEnv("CLAWBOX_ROOT", root);

    const mod = await import("@/app/setup-api/wifi/connect/route");
    wifiConnectPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const k of Object.keys(store)) delete store[k];
    session.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  // The single-radio handoff tears down the setup hotspot mid-connect, so the
  // route is fire-and-forget: it records a "connecting" status, returns
  // immediately, and a background task reports the real outcome via
  // setConnectStatus (which the wizard polls through /wifi/connect-status).

  it("returns connecting and records a connecting status", async () => {
    // Fake timers: the background join never runs, so it cannot land in a later test.
    vi.useFakeTimers();
    const res = await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("connecting");
    expect(mockSet).toHaveBeenCalledWith("wifi_ssid", "MyNetwork");
    expect(mockSetConnectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "connecting", ssid: "MyNetwork", reason: null }),
    );
  });

  it("returns connecting for an open network (no password)", async () => {
    // Fake timers: the background join never runs, so it cannot land in a later test.
    vi.useFakeTimers();
    const res = await wifiConnectPost(jsonRequest({ ssid: "OpenNetwork" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("connecting");
  });

  it("records connected and marks configured after a successful background switch", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockResolvedValue({ message: "ok", ip: "192.0.2.23" });

    await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSwitchToClient).toHaveBeenCalledWith("MyNetwork", "secret123", expect.any(Function));
    expect(store).toMatchObject({ wifi_configured: true, hotspot_enabled: false });
    // The address the box got on that network: the "Connected" dialog shows it.
    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "connected", ssid: "MyNetwork", ip: "192.0.2.23" }),
    );
  });

  it("records each step of the switch while it is connecting", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mockSwitchToClient.mockImplementation(async (_ssid, _password, onStep) => {
      onStep?.("radio-on");
      onStep?.("switching");
      await new Promise<void>((resolve) => { finish = resolve; });
      return { message: "ok", ip: null };
    });

    await wifiConnectPost(jsonRequest({ ssid: "MyNetwork", password: "secret123" }));
    await vi.advanceTimersByTimeAsync(1600);

    const steps = mockSetConnectStatus.mock.calls.map(([s]) => s).filter((s) => s.phase === "connecting");
    expect(steps.map((s) => s.step ?? null)).toEqual([null, "radio-on", "switching"]);
    expect(steps.every((s) => s.ssid === "MyNetwork" && s.reason === null)).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("records reason=radio-off, with why, when the radio could not be turned on", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockRejectedValue(new WifiRadioOffError("Not authorized to perform this operation"));

    await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSet).toHaveBeenCalledWith("wifi_configured", false);
    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", reason: "radio-off", message: "Not authorized to perform this operation" }),
    );
  });

  it("records reason=wrong-password when the background switch throws a WifiAuthError", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockRejectedValue(new WifiAuthError("bad key"));

    await wifiConnectPost(jsonRequest({ ssid: "Network", password: "wrong" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSet).toHaveBeenCalledWith("wifi_configured", false);
    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", reason: "wrong-password" }),
    );
  });

  it("records reason=other when the background switch fails otherwise", async () => {
    vi.useFakeTimers();
    mockSwitchToClient.mockRejectedValue(new Error("Connection refused"));

    await wifiConnectPost(jsonRequest({ ssid: "Network", password: "pass" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(mockSetConnectStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", reason: "other", message: "Connection refused" }),
    );
  });

  it("skips WiFi setup when skip=true", async () => {
    const res = await wifiConnectPost(jsonRequest({ skip: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toContain("Ethernet only");
    expect(mockSet).toHaveBeenCalledWith("wifi_configured", true);
    expect(mockSwitchToClient).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: "not json",
    });
    const res = await wifiConnectPost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for missing SSID", async () => {
    const res = await wifiConnectPost(jsonRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("SSID is required");
  });

  it("returns 400 for empty SSID", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "  " }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("SSID is required");
  });

  it("returns 400 for non-string SSID", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: 123 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("SSID is required");
  });

  it("returns 400 for non-string password", async () => {
    const res = await wifiConnectPost(jsonRequest({ ssid: "Network", password: 123 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Password must be a string");
  });

  // GitHub #1517. A join used to write only config's `hotspot_enabled: false`.
  // The AP scripts read data/hotspot.env, never config, so Settings said
  // "off" while start-ap.sh raised the AP again at the next boot on Ethernet
  // (and took the radio from the WiFi it had just joined).
  describe("the hotspot switch a join leaves behind is the one the AP scripts read", () => {
    const REPO = process.cwd();

    /** The background task ends by recording its outcome; the hotspot write
     *  comes before that and does real file I/O, which fake timers do not flush. */
    async function settled(phase: "connected" | "failed") {
      await vi.advanceTimersByTimeAsync(1600);
      await vi.waitFor(() => {
        expect(mockSetConnectStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase }));
      }, { timeout: 5_000 });
    }

    /** Run the shipped start-ap.sh against `root`, with stubs that record any radio call. */
    function runStartAp(): { status: number | null; stdout: string; touchedRadio: boolean } {
      const bin = path.join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const witness = path.join(root, "RADIO-TOUCHED");
      for (const tool of ["nmcli", "iw", "iptables", "sysctl"]) {
        writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\ntouch "${witness}"\nexit 1\n`, { mode: 0o755 });
      }
      writeFileSync(path.join(bin, "ip"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of ["HOTSPOT_SSID", "HOTSPOT_PASSWORD", "HOTSPOT_DISABLED"]) delete env[k];
      const res = spawnSync("bash", [path.join(REPO, "scripts", "start-ap.sh")], {
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CLAWBOX_ROOT: root,
          CLAWBOX_RADIO_RUN_DIR: path.join(root, "radio-run"),
          CLAWBOX_AP_SUPERVISED: "1",
          NETWORK_INTERFACE: "wlP1p1s0",
          NM_READY_TIMEOUT: "1",
        },
        encoding: "utf-8",
        timeout: 20_000,
      });
      return { status: res.status, stdout: res.stdout ?? "", touchedRadio: existsSync(witness) };
    }

    /** Run the shipped ap-watchdog.sh against `root` with an idle radio; did it ask for the AP? */
    function runWatchdogOnIdleRadio(): boolean {
      const bin = path.join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const started = path.join(root, "AP-STARTED");
      writeFileSync(path.join(bin, "nmcli"), "#!/usr/bin/env bash\necho \"wlP1p1s0:disconnected\"\n", { mode: 0o755 });
      writeFileSync(
        path.join(bin, "systemctl"),
        `#!/usr/bin/env bash\n[ "$*" = "--job-mode=fail --no-block restart clawbox-ap.service" ] && touch "${started}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const startAp = path.join(root, "start-ap-witness.sh");
      writeFileSync(startAp, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      spawnSync("bash", [path.join(REPO, "scripts", "ap-watchdog.sh")], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CLAWBOX_ROOT: root,
          CLAWBOX_START_AP: startAp,
          CLAWBOX_RADIO_RUN_DIR: path.join(root, "radio-run"),
          NETWORK_INTERFACE: "wlP1p1s0",
        },
        encoding: "utf-8",
        timeout: 20_000,
      });
      return existsSync(started);
    }

    it("after setup, a join switches the hotspot off in data/hotspot.env, and start-ap.sh then skips the AP", async () => {
      // The reported box: set up, hotspot on, on Ethernet; the owner joins
      // their WiFi from Settings.
      vi.useFakeTimers();
      writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ setup_complete: true }));
      Object.assign(store, { setup_complete: true, hotspot_enabled: true, hotspot_password: "hotspot-key-1" });
      writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_PASSWORD='hotspot-key-1'\n");

      await wifiConnectPost(jsonRequest({ ssid: "HomeNet", password: "home-pass-1" }));
      await settled("connected");

      const env = readFileSync(envFile(), "utf8");
      expect(env).toContain("HOTSPOT_DISABLED=1");
      // Name and key untouched: switching it back on brings back the same AP.
      expect(env).toContain("HOTSPOT_SSID='ClawBox-Setup'");
      expect(env).toContain("HOTSPOT_PASSWORD='hotspot-key-1'");
      expect(store).toMatchObject({ wifi_configured: true, hotspot_enabled: false });

      // The next boot: the shipped start-ap.sh reads that file and leaves the
      // radio to the WiFi network.
      const boot = runStartAp();
      expect(boot.stdout).toContain("Hotspot disabled in settings");
      expect(boot.status).toBe(0);
      expect(boot.touchedRadio).toBe(false);
    });

    it("a failed join leaves the hotspot switch alone", async () => {
      vi.useFakeTimers();
      Object.assign(store, { setup_complete: true, hotspot_enabled: true });
      writeFileSync(envFile(), "HOTSPOT_SSID='ClawBox-Setup'\n");
      mockSwitchToClient.mockRejectedValue(new Error("Connection refused"));

      await wifiConnectPost(jsonRequest({ ssid: "HomeNet", password: "home-pass-1" }));
      await settled("failed");

      expect(readFileSync(envFile(), "utf8")).toBe("HOTSPOT_SSID='ClawBox-Setup'\n");
      expect(store.hotspot_enabled).toBe(true);
    });

    it("before setup (the wizard's WiFi step) the env file is left alone, so the setup hotspot still comes back if that WiFi drops", async () => {
      // First-boot setup is unchanged: the wizard's hotspot step still
      // defaults to off after a join (config), and ap-watchdog.sh, which
      // honours HOTSPOT_DISABLED=1 before setup, still heals an idle radio.
      vi.useFakeTimers();
      writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ setup_complete: false }));

      await wifiConnectPost(jsonRequest({ ssid: "HomeNet", password: "home-pass-1" }));
      await settled("connected");

      expect(existsSync(envFile())).toBe(false);
      expect(store).toMatchObject({ wifi_configured: true, hotspot_enabled: false });
      expect(runWatchdogOnIdleRadio()).toBe(true);
    });
  });
});
