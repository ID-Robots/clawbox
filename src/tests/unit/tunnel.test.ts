import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SERVER_SETTINGS, stubWebServerSettings, withoutThem } from "@/tests/helpers/capability-drop";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-tunnel-tests-${process.pid}-${Date.now()}`);
const STATE_FILE = path.join(TEST_ROOT, "tunnel-state.json");
const PID_FILE = path.join(TEST_ROOT, "tunnel.pid");
const URL_FILE = path.join(TEST_ROOT, "tunnel-url.txt");
const ISOLATED_CONFIG = path.join(TEST_ROOT, "tunnel-isolated-config.yml");
// tunnel.pid is `<pid>\n<boot id>\n`. Off Linux there is no boot id to compare.
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const thisBoot = () => (existsSync(BOOT_ID_FILE) ? readFileSync(BOOT_ID_FILE, "utf-8").trim() : "");
/** A pid record for this test process, written under this boot: a live tunnel. */
const livePid = () => `${process.pid}\n${thisBoot()}\n`;

// child_process is mocked so isCloudflaredInstalled and startTunnel don't shell out.
const execMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    const result = execMock(cmd);
    if (result?.error) cb(result.error, { stdout: "", stderr: "" });
    else cb(null, { stdout: result?.stdout ?? "", stderr: "" });
  },
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") (cb as (e: Error | null, o: unknown) => void)(null, { stdout: "", stderr: "" });
  },
}));

// The capability drop: the real gate, on a host whose web server holds no
// ambient capabilities unless a case sets `wrap` — so every other assertion
// here pins that such a host spawns exactly as before.
const drop = vi.hoisted(() => ({ wrap: false, calls: [] as unknown[][] }));
vi.mock("@/lib/capability-drop", async (importOriginal) =>
  (await import("@/tests/helpers/capability-drop")).realGate(await importOriginal(), drop));
beforeEach(() => {
  drop.wrap = false;
  drop.calls.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * TASK-453 round 2 — the device's REAL tunnel is clawbox-tunnel.service, and
 * this module only ever knew about a cloudflared it spawned itself. The unit
 * lives behind @/lib/cloudflared, so it is faked here the way the box answers.
 */
const serviceStateMock = vi.fn(async () => "inactive");
const unitUrlMock = vi.fn(async () => null as string | null);
const journalUrlMock = vi.fn(async () => null as string | null);
// data/cloudflared/tunnel.target — where scripts/run-tunnel.sh says the unit forwards.
const unitTargetMock = vi.fn(async () => null as string | null);

vi.mock("@/lib/cloudflared", () => ({
  getTunnelServiceState: () => serviceStateMock(),
  readTunnelUrl: () => unitUrlMock(),
  readTunnelUrlFromJournal: () => journalUrlMock(),
  readTunnelTarget: () => unitTargetMock(),
}));

// Which tunnel scripts/run-tunnel.sh started, and the named credential beside it.
const modeMock = vi.fn(async () => null as "named" | "quick" | null);
const credentialMock = vi.fn(async () => null as { hostname: string; token: string } | null);
vi.mock("@/lib/named-tunnel", () => ({
  readTunnelMode: () => modeMock(),
  readNamedTunnelCredential: () => credentialMock(),
}));

let tunnel: typeof import("@/lib/tunnel");

beforeAll(async () => {
  process.env.CLAWBOX_DATA_DIR = TEST_ROOT;
  await fs.mkdir(TEST_ROOT, { recursive: true });
  vi.resetModules();
  tunnel = await import("@/lib/tunnel");
});

afterAll(async () => {
  delete process.env.CLAWBOX_DATA_DIR;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(STATE_FILE, { force: true });
  await fs.rm(PID_FILE, { force: true });
  await fs.rm(URL_FILE, { force: true });
  execMock.mockReset();
  spawnMock.mockReset();
  serviceStateMock.mockReset();
  serviceStateMock.mockResolvedValue("inactive");
  unitUrlMock.mockReset();
  unitUrlMock.mockResolvedValue(null);
  journalUrlMock.mockReset();
  journalUrlMock.mockResolvedValue(null);
  unitTargetMock.mockReset();
  unitTargetMock.mockResolvedValue(null);
});

describe("tunnel — state persistence", () => {
  it("readState returns disabled defaults when no state file exists", async () => {
    const state = await tunnel.readState();
    expect(state).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
  });

  it("writeState persists JSON round-trip via readState", async () => {
    const startedAt = new Date().toISOString();
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://abc.trycloudflare.com",
      startedAt,
    });
    const state = await tunnel.readState();
    expect(state.enabled).toBe(true);
    expect(state.tunnelUrl).toBe("https://abc.trycloudflare.com");
    expect(state.startedAt).toBe(startedAt);
  });

  it("readState falls back to defaults on malformed JSON", async () => {
    await fs.writeFile(STATE_FILE, "not valid json", "utf-8");
    const state = await tunnel.readState();
    expect(state).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
  });
});

describe("tunnel — pid tracking", () => {
  it("getTunnelPid returns null when no pid file exists", async () => {
    const pid = await tunnel.getTunnelPid();
    expect(pid).toBeNull();
  });

  it("getTunnelPid parses and returns numeric pid", async () => {
    await fs.writeFile(PID_FILE, "42\n", "utf-8");
    const pid = await tunnel.getTunnelPid();
    expect(pid).toBe(42);
  });

  it("isTunnelRunning returns false when no pid file", async () => {
    expect(await tunnel.isTunnelRunning()).toBe(false);
  });

  it("isTunnelRunning returns true for the current process pid", async () => {
    await fs.writeFile(PID_FILE, livePid(), "utf-8");
    expect(await tunnel.isTunnelRunning()).toBe(true);
  });

  it("isTunnelRunning cleans up stale pid file when process is gone", async () => {
    // 0x7FFFFFFF is far above any real pid; process.kill(pid, 0) throws.
    await fs.writeFile(PID_FILE, "2147483646", "utf-8");
    expect(await tunnel.isTunnelRunning()).toBe(false);
    await expect(fs.access(PID_FILE)).rejects.toThrow();
  });
});

describe("tunnel — url tracking", () => {
  it("getTunnelUrl returns null when no url file", async () => {
    expect(await tunnel.getTunnelUrl()).toBeNull();
  });

  it("getTunnelUrl trims trailing whitespace", async () => {
    await fs.writeFile(URL_FILE, "https://abc.trycloudflare.com\n", "utf-8");
    expect(await tunnel.getTunnelUrl()).toBe("https://abc.trycloudflare.com");
  });

  it("getTunnelUrl returns null for empty file", async () => {
    await fs.writeFile(URL_FILE, "   \n", "utf-8");
    expect(await tunnel.getTunnelUrl()).toBeNull();
  });
});

describe("tunnel — isCloudflaredInstalled", () => {
  it("returns true when `which cloudflared` succeeds", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    expect(await tunnel.isCloudflaredInstalled()).toBe(true);
  });

  it("returns false when `which cloudflared` errors", async () => {
    execMock.mockReturnValue({ error: new Error("not found") });
    expect(await tunnel.isCloudflaredInstalled()).toBe(false);
  });
});

describe("tunnel — getTunnelStatus", () => {
  it("reports disabled+not-running when nothing is set up", async () => {
    const status = await tunnel.getTunnelStatus();
    expect(status).toEqual({
      enabled: false,
      running: false,
      tunnelUrl: null,
      error: null,
      service: "inactive",
      managedBy: null,
      mode: null,
      hostname: null,
      target: null,
    });
  });

  it("reports the named mode and its hostname — never the token", async () => {
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue("https://amber-otter-k7m2p9qx4w3n.clawbox.tech");
    modeMock.mockResolvedValue("named");
    credentialMock.mockResolvedValue({
      hostname: "amber-otter-k7m2p9qx4w3n.clawbox.tech",
      token: "eyJzZWNyZXQiOiJkby1ub3Qtc2hvdy1tZSJ9eyJzZWNyZXQiOiJ9",
    });
    try {
      const status = await tunnel.getTunnelStatus();
      expect(status.mode).toBe("named");
      expect(status.hostname).toBe("amber-otter-k7m2p9qx4w3n.clawbox.tech");
      expect(status.tunnelUrl).toBe("https://amber-otter-k7m2p9qx4w3n.clawbox.tech");
      expect(JSON.stringify(status)).not.toContain("eyJzZWNyZXQi");
    } finally {
      modeMock.mockReset().mockResolvedValue(null);
      credentialMock.mockReset().mockResolvedValue(null);
      serviceStateMock.mockReset().mockResolvedValue("inactive");
      unitUrlMock.mockReset().mockResolvedValue(null);
    }
  });

  it("reports quick mode with no hostname even when a credential is on file", async () => {
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue("https://abc.trycloudflare.com");
    modeMock.mockResolvedValue("quick");
    credentialMock.mockResolvedValue({ hostname: "amber-otter-k7m2p9qx4w3n.clawbox.tech", token: "x".repeat(40) });
    try {
      const status = await tunnel.getTunnelStatus();
      expect(status.mode).toBe("quick");
      expect(status.hostname).toBeNull();
    } finally {
      modeMock.mockReset().mockResolvedValue(null);
      credentialMock.mockReset().mockResolvedValue(null);
      serviceStateMock.mockReset().mockResolvedValue("inactive");
      unitUrlMock.mockReset().mockResolvedValue(null);
    }
  });

  it("reports running+url when pid + url + state are present", async () => {
    await fs.writeFile(PID_FILE, livePid(), "utf-8");
    await fs.writeFile(URL_FILE, "https://xyz.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://xyz.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });
    const status = await tunnel.getTunnelStatus();
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.tunnelUrl).toBe("https://xyz.trycloudflare.com");
  });

  it("hides tunnelUrl when process is gone (stale pid)", async () => {
    await fs.writeFile(PID_FILE, "2147483646", "utf-8");
    await fs.writeFile(URL_FILE, "https://xyz.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://xyz.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });
    const status = await tunnel.getTunnelStatus();
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.tunnelUrl).toBeNull();
  });

  /**
   * The smoke finding, verbatim. On the QA box on 2026-08-24:
   *
   *   $ systemctl is-active clawbox-tunnel  -> active
   *   $ cat data/cloudflared/tunnel.url     -> https://stat-door-...trycloudflare.com
   *   $ ls data/tunnel.pid                  -> does not exist
   *   $ curl -b jar .../setup-api/tunnel/status
   *     {"enabled":false,"running":false,"tunnelUrl":null,...}
   *
   * The owner is told remote access is off while the whole desktop is on the
   * public internet behind one password — and is given neither the URL nor a
   * reason to look for an off switch.
   */
  it("sees the systemd tunnel even with no pid file of its own", async () => {
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue("https://stat-door-tournament-resorts.trycloudflare.com");

    const status = await tunnel.getTunnelStatus();

    expect(status.running).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.tunnelUrl).toBe("https://stat-door-tournament-resorts.trycloudflare.com");
    expect(status.service).toBe("active");
    expect(status.managedBy).toBe("systemd");
  });

  it("recovers the URL from the unit journal when tunnel.url is missing", async () => {
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue(null);
    journalUrlMock.mockResolvedValue("https://from-journal.trycloudflare.com");

    const status = await tunnel.getTunnelStatus();

    expect(status.tunnelUrl).toBe("https://from-journal.trycloudflare.com");
    // Never worth denying a live tunnel just because its URL file went missing.
    expect(status.running).toBe(true);
  });

  it("counts a still-activating unit as up rather than flickering to off", async () => {
    serviceStateMock.mockResolvedValue("activating");
    const status = await tunnel.getTunnelStatus();
    expect(status.running).toBe(true);
    expect(status.managedBy).toBe("systemd");
  });

  it("reports not-running for a failed or stopped unit", async () => {
    for (const state of ["failed", "inactive", "unknown"] as const) {
      serviceStateMock.mockResolvedValue(state);
      unitUrlMock.mockResolvedValue("https://stale.trycloudflare.com");
      const status = await tunnel.getTunnelStatus();
      expect(status.running, state).toBe(false);
      expect(status.tunnelUrl, state).toBeNull();
      expect(status.managedBy, state).toBeNull();
    }
  });

  it("still describes a tunnel this module spawned itself", async () => {
    await fs.writeFile(PID_FILE, livePid(), "utf-8");
    await fs.writeFile(URL_FILE, "https://spawned.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://spawned.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });

    const status = await tunnel.getTunnelStatus();
    expect(status.managedBy).toBe("spawned");
    expect(status.tunnelUrl).toBe("https://spawned.trycloudflare.com");
  });
});

describe("tunnel — start/stop cannot lie about the systemd tunnel", () => {
  it("does not spawn a second cloudflared next to a running unit", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue("https://already-up.trycloudflare.com");

    const result = await tunnel.startTunnel();

    expect(result).toEqual({ success: true, tunnelUrl: "https://already-up.trycloudflare.com" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to claim it stopped a unit it cannot stop", async () => {
    serviceStateMock.mockResolvedValue("active");

    const result = await tunnel.stopTunnel();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/clawbox-tunnel/);
    // And it names the control that does work, so the answer is followable.
    expect(result.error).toMatch(/Remote Control|portal\/stop/);
  });
});

describe("tunnel — stopTunnel", () => {
  it("succeeds when nothing is running and clears state file", async () => {
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://old.trycloudflare.com",
      startedAt: new Date().toISOString(),
    });
    const result = await tunnel.stopTunnel();
    expect(result.success).toBe(true);
    const state = await tunnel.readState();
    expect(state).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
  });

  it("removes stale pid and url files", async () => {
    await fs.writeFile(PID_FILE, "2147483646", "utf-8");
    await fs.writeFile(URL_FILE, "https://x.trycloudflare.com", "utf-8");
    const result = await tunnel.stopTunnel();
    expect(result.success).toBe(true);
    await expect(fs.access(PID_FILE)).rejects.toThrow();
    await expect(fs.access(URL_FILE)).rejects.toThrow();
  });
});

describe("tunnel — startTunnel", () => {
  it("rejects when cloudflared is not installed", async () => {
    execMock.mockReturnValue({ error: new Error("not found") });
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not installed/i);
  });

  it("returns existing url when tunnel is already running", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    await fs.writeFile(PID_FILE, livePid(), "utf-8");
    await fs.writeFile(URL_FILE, "https://existing.trycloudflare.com", "utf-8");
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe("https://existing.trycloudflare.com");
  });

  it("captures URL from cloudflared stdout and persists state", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeFakeProc("Visit it at: https://fresh-tunnel-abc.trycloudflare.com"));
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe("https://fresh-tunnel-abc.trycloudflare.com");
    const state = await tunnel.readState();
    expect(state.enabled).toBe(true);
    expect(state.tunnelUrl).toBe("https://fresh-tunnel-abc.trycloudflare.com");
    const url = await fs.readFile(URL_FILE, "utf-8");
    expect(url).toBe("https://fresh-tunnel-abc.trycloudflare.com");
  });

  it("captures URL even when cloudflared writes to stderr", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() =>
      makeFakeProc("", "INF Tunnel ready https://stderr-route.trycloudflare.com"),
    );
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe("https://stderr-route.trycloudflare.com");
  });

  it("never takes the quick-tunnel API endpoint from a failed request for the tunnel's URL", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() =>
      makeFakeProc(
        "failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": dial tcp: lookup api.trycloudflare.com: server misbehaving",
        "INF |  https://the-real-one.trycloudflare.com  |",
      ),
    );
    const result = await tunnel.startTunnel();
    expect(result).toEqual({ success: true, tunnelUrl: "https://the-real-one.trycloudflare.com" });
  });

  it("reports spawn errors", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeErroringProc(new Error("ENOENT")));
    const result = await tunnel.startTunnel();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });
});

/**
 * TASK-2359: startTunnel spawned `cloudflared tunnel --url http://localhost:80`
 * whatever the install. On a PC/workstation installed with install-x64.sh the
 * web UI serves on CLAWBOX_PORT (3005 unless chosen otherwise) — its unit sets
 * PORT=3005 — nothing listens on :80, and the public URL answered 502. The two
 * layouts below are the UI units' own environments.
 */
describe.each([
  { layout: "appliance", env: { PORT: "80" }, target: "http://localhost:80" },
  { layout: "PC install", env: { PORT: "3005" }, target: "http://localhost:3005" },
])("tunnel — forwards to the web UI's own port ($layout)", ({ env, target }) => {
  const saved = { PORT: process.env.PORT, CLAWBOX_PORT: process.env.CLAWBOX_PORT };
  beforeEach(() => {
    delete process.env.CLAWBOX_PORT;
    Object.assign(process.env, env);
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(`spawns cloudflared with --url ${target}`, async () => {
    stubWebServerSettings();
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeFakeProc("Visit it at: https://port-check.trycloudflare.com"));

    const result = await tunnel.startTunnel();

    expect(result).toEqual({ success: true, tunnelUrl: "https://port-check.trycloudflare.com" });
    // The whole call as beta makes it on a host without ambient capabilities:
    // `--config` an empty map, ahead of --url, as scripts/run-tunnel.sh runs it
    // (an owner's ~/.cloudflared/config.yml must not reroute the public URL),
    // and no env of its own, so cloudflared inherits the web server's.
    expect(spawnMock.mock.calls).toStrictEqual([[
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--config", ISOLATED_CONFIG, "--url", target],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    ]]);
    expect(await fs.readFile(ISOLATED_CONFIG, "utf-8")).toBe("{}\n");
    expect((await tunnel.readState()).target).toBe(target);
  });

  it("spawns cloudflared without the web server's capabilities or its own settings on a host that holds them", async () => {
    drop.wrap = true;
    stubWebServerSettings();
    vi.stubEnv("PATH", "/usr/bin:/bin");
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeFakeProc("Visit it at: https://port-check.trycloudflare.com"));

    const result = await tunnel.startTunnel();

    expect(result).toEqual({ success: true, tunnelUrl: "https://port-check.trycloudflare.com" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = spawnMock.mock.calls[0] as [string, string[], { env?: Record<string, string | undefined> }];
    expect(bin).toBe("/usr/bin/setpriv");
    expect(argv).toEqual([
      "--ambient-caps=-all",
      "--inh-caps=-all",
      "--no-new-privs",
      "--",
      "/usr/bin/cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--config",
      ISOLATED_CONFIG,
      "--url",
      target,
    ]);
    // The environment the child gets holds none of the web server's own
    // settings, and everything else the web server has.
    const childEnv = opts.env ?? process.env;
    expect(Object.keys(childEnv).filter((key) => WEB_SERVER_SETTINGS.includes(key))).toEqual([]);
    expect(opts).toStrictEqual({ detached: true, stdio: ["ignore", "pipe", "pipe"], env: withoutThem(process.env) });
    // The web server keeps its own.
    expect(WEB_SERVER_SETTINGS.filter((key) => process.env[key] === undefined)).toEqual([]);
    expect(drop.calls[0]?.[0]).toBe("cloudflared");
    expect((drop.calls[0]?.[2] as { label: string }).label).toBe("the tunnel route's quick tunnel");
    // The pid recorded is the child's.
    expect((await fs.readFile(PID_FILE, "utf-8")).split("\n")[0]).toBe("999999");
  });

  it("reports the target of a tunnel it spawned, and forgets it on disable", async () => {
    await fs.writeFile(PID_FILE, livePid(), "utf-8");
    await fs.writeFile(URL_FILE, "https://spawned.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://spawned.trycloudflare.com",
      startedAt: new Date().toISOString(),
      target,
    });
    expect(await tunnel.getTunnelStatus()).toMatchObject({ managedBy: "spawned", running: true, target });

    // Disable without signalling this test process, which plays the child.
    const kill = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 0) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      expect(await tunnel.stopTunnel()).toEqual({ success: true });
    } finally {
      kill.mockRestore();
    }
    expect(await tunnel.readState()).toEqual({ enabled: false, tunnelUrl: null, startedAt: null });
    expect(await tunnel.getTunnelStatus()).toMatchObject({ running: false, target: null });
  });

  it("reports where the systemd unit forwards, as run-tunnel.sh recorded it", async () => {
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue("https://unit.trycloudflare.com");
    unitTargetMock.mockResolvedValue(target);
    expect(await tunnel.getTunnelStatus()).toMatchObject({ managedBy: "systemd", target });
  });
});

describe("tunnel — status reports no target when nothing runs", () => {
  it("even with a target left in the unit's file or an old state", async () => {
    unitTargetMock.mockResolvedValue("http://localhost:80");
    await tunnel.writeState({ enabled: true, tunnelUrl: null, startedAt: null, target: "http://localhost:80" });
    expect((await tunnel.getTunnelStatus()).target).toBeNull();
  });
});

/**
 * Restart after a reboot. The spawned cloudflared dies with the boot but
 * tunnel.pid survives it, and the number is reused — often by another process
 * of the same user, which `kill(pid, 0)` reports as alive.
 */
describe.skipIf(!existsSync(BOOT_ID_FILE))("tunnel — a pid from an earlier boot is not ours", () => {
  it.each([
    ["an earlier boot", `${process.pid}\n00000000-0000-0000-0000-000000000000\n`],
    // Written before boot ids were recorded: by a server that has stopped since,
    // and the child went with it (the UI unit's control group).
    ["no boot id (written before this change)", `${process.pid}\n`],
  ])("a pid recorded under %s is not reported running, and its file is dropped", async (_label, record) => {
    await fs.writeFile(PID_FILE, record, "utf-8");
    await fs.writeFile(URL_FILE, "https://died-with-the-boot.trycloudflare.com", "utf-8");
    await tunnel.writeState({
      enabled: true,
      tunnelUrl: "https://died-with-the-boot.trycloudflare.com",
      startedAt: new Date().toISOString(),
      target: "http://localhost:3005",
    });

    expect(await tunnel.isTunnelRunning()).toBe(false);
    await expect(fs.access(PID_FILE)).rejects.toThrow();
    expect(await tunnel.getTunnelStatus()).toMatchObject({ enabled: false, running: false, tunnelUrl: null, target: null });
  });

  it("is never signalled by disable", async () => {
    await fs.writeFile(PID_FILE, `${process.pid}\nan-earlier-boot\n`, "utf-8");
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      expect(await tunnel.stopTunnel()).toEqual({ success: true });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("still counts a tunnel spawned under this boot", async () => {
    await fs.writeFile(PID_FILE, livePid(), "utf-8");
    expect(await tunnel.isTunnelRunning()).toBe(true);
    expect(await tunnel.getTunnelPid()).toBe(process.pid);
  });

  it("records this boot's id beside the pid when it spawns", async () => {
    execMock.mockReturnValue({ stdout: "/usr/local/bin/cloudflared" });
    spawnMock.mockImplementation(() => makeFakeProc("https://boot-stamp.trycloudflare.com"));
    await tunnel.startTunnel();
    expect(await fs.readFile(PID_FILE, "utf-8")).toBe(`999999\n${thisBoot()}\n`);
  });
});

// ── helpers ───────────────────────────────────────────────────────────

type Listener = (data: Buffer) => void;
type EventName = "data" | "error" | "exit";

function makeFakeProc(stdoutLine: string, stderrLine = "") {
  const listeners: Record<string, Listener[]> = {};
  const emit = (stream: "stdout" | "stderr", text: string) => {
    if (!text) return;
    queueMicrotask(() => {
      (listeners[`${stream}:data`] ?? []).forEach((cb) => cb(Buffer.from(text)));
    });
  };
  const handler = (stream: "stdout" | "stderr") => ({
    on: (event: EventName, cb: Listener) => {
      listeners[`${stream}:${event}`] = listeners[`${stream}:${event}`] ?? [];
      listeners[`${stream}:${event}`].push(cb);
    },
  });
  emit("stdout", stdoutLine);
  emit("stderr", stderrLine);
  return {
    pid: 999999,
    stdout: handler("stdout"),
    stderr: handler("stderr"),
    on: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  };
}

function makeErroringProc(err: Error) {
  return {
    pid: 999999,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: EventName, cb: (e: Error) => void) => {
      if (event === "error") queueMicrotask(() => cb(err));
    }),
    unref: vi.fn(),
    kill: vi.fn(),
  };
}
