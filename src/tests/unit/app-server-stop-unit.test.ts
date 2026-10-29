/**
 * @vitest-environment node
 *
 * `stopServerApp` for an app the agent serves from a user `.service` of its
 * own (`~/.config/systemd/user/<app>-app.service`, see app-unit-limits.ts).
 * Ending only the server is not enough there: under `Restart=` systemd starts
 * it again from the same folder, the port is taken again, and the uninstall
 * could never go through. The unit itself is stopped — when its own
 * WorkingDirectory is the app's folder, and only then.
 *
 * The restarting supervisor is real (a shell loop, as `Restart=always`), the
 * server is real and `ss` is asked about it; only systemctl is a stand-in,
 * because a test cannot own a user unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { saveEnv } from "@/tests/helpers/env";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const SYSTEMCTL = "/usr/bin/systemctl-test-stand-in";
const UNIT = "hello-app-app.service";

const systemd = vi.hoisted(() => ({
  /** The user `.service` the listener's cgroup names; null for none. */
  unit: null as string | null,
  /** What `systemctl show -p WorkingDirectory -p MainPID` answers for it. */
  workingDirectory: "",
  mainPid: 0,
  calls: [] as string[][],
  /** What `systemctl stop` does to the unit's processes. */
  stop: async () => undefined as void,
}));

vi.mock("@/lib/app-unit-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-unit-limits")>()),
  foreignUserServiceOf: () => systemd.unit,
}));
vi.mock("@/lib/coding-run-unit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-run-unit")>()),
  findSystemdTool: async (name: string) => (name === "systemctl" ? SYSTEMCTL : null),
}));
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  const answer = (stdout = "") => ({ code: 0, stdout, stderr: "", signal: null, timedOut: false });
  return {
    ...actual,
    runChild: async (...call: Parameters<typeof actual.runChild>) => {
      const [bin, args] = call;
      if (bin !== SYSTEMCTL) return actual.runChild(...call);
      systemd.calls.push([...args]);
      if (args.includes("show")) return answer(`WorkingDirectory=${systemd.workingDirectory}\nMainPID=${systemd.mainPid}\n`);
      if (args.includes("stop")) await systemd.stop();
      return answer();
    },
  };
});

const SERVER_JS = `
const http = require("http");
require("fs").writeFileSync("server.pid", String(process.pid));
http.createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let start: typeof import("@/lib/app-server-start");
let proxy: typeof import("@/lib/app-proxy");
let base: string;
let project: string;
let supervisor: ChildProcess | null;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "app-stop-unit-"));
  project = path.join(base, "Projects", "hello-app");
  fs.mkdirSync(path.join(base, "clawbox", "data"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "server.js"), SERVER_JS);
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = path.join(base, "clawbox");
  supervisor = null;
  systemd.unit = UNIT;
  systemd.workingDirectory = project;
  systemd.mainPid = 0;
  systemd.calls.length = 0;
  // systemd's own stop: the unit's whole cgroup goes, the restart loop with it.
  systemd.stop = async () => {
    const pid = supervisor?.pid;
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  };
  vi.resetModules();
  proxy = await import("@/lib/app-proxy");
  proxy._resetListenerCacheForTests();
  start = await import("@/lib/app-server-start");
});

afterEach(() => {
  if (supervisor?.pid) {
    try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* gone */ }
  }
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

/** The app's server under a supervisor that starts it again whenever it ends, as `Restart=always` does. */
async function serveUnderRestart(): Promise<{ port: number; supervisorPid: number }> {
  const port = await freePort();
  supervisor = spawn("/bin/sh", ["-c", `while :; do "${process.execPath}" server.js; sleep 0.2; done`], {
    cwd: project,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while ((await proxy.listenerOwnedBy(port, project, { fresh: true })) !== "owned") {
    if (Date.now() > deadline) throw new Error("the server never listened");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { port, supervisorPid: supervisor.pid as number };
}

describe("stopping an app served from a user .service of its own", () => {
  it("stops the unit, so its Restart= cannot bring the server back", async () => {
    const { port, supervisorPid } = await serveUnderRestart();

    expect(await start.stopServerApp("hello-app", { port, directory: project })).toEqual({ ok: true, stopped: true, holder: null, units: [UNIT] });

    expect(systemd.calls).toContainEqual(["--user", "stop", "--", UNIT]);
    expect(alive(supervisorPid)).toBe(false);
    // Free for good: well past the supervisor's restart delay, nothing came back.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await proxy.listenerOwnedBy(port, project, { fresh: true })).toBe("not_listening");
    // Stopped, not disabled: that is the uninstall's, once the folder is gone.
    expect(systemd.calls.some((args) => args.includes("disable"))).toBe(false);
  });

  it("disables the units it is given, each by name", async () => {
    await start.disableUserUnits([UNIT, "other-app.service"]);

    expect(systemd.calls).toEqual([
      ["--user", "disable", "--", UNIT],
      ["--user", "disable", "--", "other-app.service"],
    ]);
  });

  it("stops a unit whose main process runs from the app's folder, with no WorkingDirectory there", async () => {
    // An ExecStart that `cd`s into the folder first: the unit runs from it all the same.
    systemd.workingDirectory = base;
    const { port, supervisorPid } = await serveUnderRestart();
    systemd.mainPid = supervisorPid;

    expect(await start.stopServerApp("hello-app", { port, directory: project })).toEqual({ ok: true, stopped: true, holder: null, units: [UNIT] });

    expect(systemd.calls).toContainEqual(["--user", "stop", "--", UNIT]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await proxy.listenerOwnedBy(port, project, { fresh: true })).toBe("not_listening");
  });

  it("never stops a whole unit that merely has a process in the app's folder", async () => {
    // An owner's shell service, a CI runner: neither its WorkingDirectory nor
    // its main process is in the folder. Only the server itself is the app's
    // to end; the unit is not stopped. (Whether the stop then answers before
    // the unit starts the server again is the unit's timing, so the outcome's
    // `ok` is not asserted.)
    systemd.workingDirectory = base;
    const main = spawn("/bin/sh", ["-c", "sleep 60"], { cwd: base, detached: true, stdio: "ignore" });
    try {
      systemd.mainPid = main.pid as number;
      const { port, supervisorPid } = await serveUnderRestart();
      const server = Number(fs.readFileSync(path.join(project, "server.pid"), "utf-8"));

      const outcome = await start.stopServerApp("hello-app", { port, directory: project });

      expect(alive(server)).toBe(false);
      expect(outcome).not.toHaveProperty("units");
      expect(systemd.calls.some((args) => args.includes("stop"))).toBe(false);
      expect(alive(supervisorPid)).toBe(true);
      expect(alive(main.pid as number)).toBe(true);
    } finally {
      try { process.kill(-(main.pid as number), "SIGKILL"); } catch { /* gone */ }
    }
  });
});

describe("a unit's WorkingDirectory as systemctl shows it", () => {
  it("reads the folder, with systemd's marks taken off", () => {
    expect(start.unitWorkingDirectory("/srv/apps/hello-app")).toBe("/srv/apps/hello-app");
    expect(start.unitWorkingDirectory("!/srv/apps/hello-app/")).toBe("/srv/apps/hello-app");
    expect(start.unitWorkingDirectory("/srv/apps/other/../hello-app")).toBe("/srv/apps/hello-app");
    expect(start.unitWorkingDirectory("~")).toBe(os.homedir());
  });

  it("is none when the unit names none", () => {
    expect(start.unitWorkingDirectory("")).toBeNull();
    expect(start.unitWorkingDirectory("relative/dir")).toBeNull();
  });
});
