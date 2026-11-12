import fs from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2359 — /setup-api/tunnel/* end to end through the real @/lib/tunnel, on
 * both install layouts. Found on an arm64 workstation installed with
 * install-x64.sh: POST /setup-api/tunnel/enable started
 * `cloudflared tunnel --url http://localhost:80`, but that install's web UI
 * serves on 3005 and nothing listens on :80, so the public URL answered 502.
 *
 * Each layout is the UI unit's own environment: PORT=80 in the appliance's
 * clawbox-setup.service, PORT=$CLAWBOX_PORT (3005 by default) in the one
 * install-x64.sh writes. Only the process boundary is faked: `which`, the
 * spawned cloudflared, and the systemd unit behind @/lib/cloudflared.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-tunnel-port-${process.pid}-${Date.now()}`);
const PUBLIC_URL = "https://port-route-check.trycloudflare.com";
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
/** cloudflared's argv: an isolated empty config ahead of --url, as run-tunnel.sh runs it. */
const argvFor = (target: string) => [
  "tunnel",
  "--no-autoupdate",
  "--config",
  path.join(TEST_ROOT, "tunnel-isolated-config.yml"),
  "--url",
  target,
];

const spawnMock = vi.fn();
vi.mock("child_process", () => ({
  exec: (_cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: "/usr/local/bin/cloudflared\n", stderr: "" }),
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") (cb as (e: Error | null, o: unknown) => void)(null, { stdout: "", stderr: "" });
  },
}));

const serviceStateMock = vi.fn(async () => "inactive");
const unitUrlMock = vi.fn(async () => null as string | null);
const unitTargetMock = vi.fn(async () => null as string | null);
vi.mock("@/lib/cloudflared", () => ({
  getTunnelServiceState: () => serviceStateMock(),
  readTunnelUrl: () => unitUrlMock(),
  readTunnelUrlFromJournal: async () => null,
  readTunnelTarget: () => unitTargetMock(),
}));
vi.mock("@/lib/named-tunnel", () => ({
  readTunnelMode: async () => "quick",
  readNamedTunnelCredential: async () => null,
}));
// A host whose web server holds no ambient capabilities, whatever the shell
// running this suite holds: the capability drop passes the spawn through, so
// the argv assertions below pin that such a host spawns exactly as before.
vi.mock("@/lib/capability-drop", () => ({
  CAPABILITY_DROP_COMMAND: "setpriv",
  CAPABILITY_DROP_ARGS: ["--ambient-caps=-all", "--inh-caps=-all", "--no-new-privs", "--"],
  SETPRIV_PATH: "/usr/bin/setpriv",
  withCapabilityDrop: (bin: string, argv: string[]) => ({ bin, argv, dropped: false }),
}));

type Route = { GET?: () => Promise<Response>; POST?: () => Promise<Response> };
let enable: Route;
let status: Route;
let disable: Route;

const savedEnv = {
  CLAWBOX_DATA_DIR: process.env.CLAWBOX_DATA_DIR,
  PORT: process.env.PORT,
  CLAWBOX_PORT: process.env.CLAWBOX_PORT,
};

beforeAll(async () => {
  process.env.CLAWBOX_DATA_DIR = TEST_ROOT;
  await fs.mkdir(TEST_ROOT, { recursive: true });
  vi.resetModules();
  enable = await import("@/app/setup-api/tunnel/enable/route");
  status = await import("@/app/setup-api/tunnel/status/route");
  disable = await import("@/app/setup-api/tunnel/disable/route");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

/**
 * The spawned child is this test process (a pid that exists), and process.kill
 * is faked so `disable` can "stop" it: signal 0 answers alive until a SIGTERM
 * lands, then ESRCH.
 */
let killed: Array<[number, string | number | undefined]> = [];
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  for (const f of ["tunnel-state.json", "tunnel.pid", "tunnel-url.txt", "tunnel-isolated-config.yml"]) {
    await fs.rm(path.join(TEST_ROOT, f), { force: true });
  }
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeCloudflared(PUBLIC_URL));
  serviceStateMock.mockReset();
  serviceStateMock.mockResolvedValue("inactive");
  unitUrlMock.mockReset();
  unitUrlMock.mockResolvedValue(null);
  unitTargetMock.mockReset();
  unitTargetMock.mockResolvedValue(null);
  killed = [];
  killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) {
      if (killed.some(([p, s]) => p === pid && s !== 0)) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      return true;
    }
    killed.push([pid, signal]);
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  killSpy.mockRestore();
});

const LAYOUTS = [
  { layout: "Jetson appliance", env: { PORT: "80" }, target: "http://localhost:80" },
  { layout: "PC/workstation (install-x64.sh)", env: { PORT: "3005" }, target: "http://localhost:3005" },
];

describe.each(LAYOUTS)("/setup-api/tunnel on the $layout", ({ env, target }) => {
  beforeEach(() => {
    delete process.env.CLAWBOX_PORT;
    Object.assign(process.env, env);
  });

  it(`enable -> status -> disable forwards to ${target}`, async () => {
    const enabled = await enable.POST!();
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ success: true, tunnelUrl: PUBLIC_URL });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toEqual(argvFor(target));

    // The URL the caller shows is the one status keeps answering with.
    const up = await (await status.GET!()).json();
    expect(up).toMatchObject({
      enabled: true,
      running: true,
      managedBy: "spawned",
      tunnelUrl: PUBLIC_URL,
      target,
      cloudflaredInstalled: true,
    });

    const disabled = await disable.POST!();
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ success: true });
    expect(killed).toContainEqual([process.pid, "SIGTERM"]);

    const down = await (await status.GET!()).json();
    expect(down).toMatchObject({ enabled: false, running: false, tunnelUrl: null, target: null });
  });

  it("status reports where clawbox-tunnel.service forwards, and enable does not spawn beside it", async () => {
    serviceStateMock.mockResolvedValue("active");
    unitUrlMock.mockResolvedValue("https://unit-owned.trycloudflare.com");
    unitTargetMock.mockResolvedValue(target);

    expect(await (await status.GET!()).json()).toMatchObject({
      running: true,
      managedBy: "systemd",
      tunnelUrl: "https://unit-owned.trycloudflare.com",
      target,
    });
    expect(await (await enable.POST!()).json()).toEqual({
      success: true,
      tunnelUrl: "https://unit-owned.trycloudflare.com",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(BOOT_ID_FILE))(
    "after a reboot, enable starts a fresh tunnel on the same port instead of trusting the old pid",
    async () => {
      // A pid recorded under the previous boot, now some other process's number.
      await fs.writeFile(path.join(TEST_ROOT, "tunnel.pid"), `${process.pid}\n00000000-0000-0000-0000-000000000000\n`);
      await fs.writeFile(path.join(TEST_ROOT, "tunnel-url.txt"), "https://died-with-the-boot.trycloudflare.com");
      await fs.writeFile(
        path.join(TEST_ROOT, "tunnel-state.json"),
        JSON.stringify({
          enabled: true,
          tunnelUrl: "https://died-with-the-boot.trycloudflare.com",
          startedAt: "2026-11-01T00:00:00.000Z",
          target,
        }),
      );

      expect(await (await status.GET!()).json()).toMatchObject({ running: false, tunnelUrl: null });

      const enabled = await (await enable.POST!()).json();
      expect(enabled).toEqual({ success: true, tunnelUrl: PUBLIC_URL });
      expect(spawnMock.mock.calls[0][1]).toEqual(argvFor(target));
      expect(killed).toEqual([]);
    },
  );
});

/** A spawned cloudflared that prints its quick-tunnel URL on stderr, as the real one does. */
function fakeCloudflared(url: string) {
  const listeners: Array<(data: Buffer) => void> = [];
  queueMicrotask(() => listeners.forEach((cb) => cb(Buffer.from(`INF |  ${url}  |`))));
  return {
    pid: process.pid,
    stdout: { on: vi.fn() },
    stderr: { on: (_event: string, cb: (data: Buffer) => void) => listeners.push(cb) },
    on: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  };
}
