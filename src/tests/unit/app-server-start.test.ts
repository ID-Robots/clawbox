/**
 * @vitest-environment node
 *
 * A run stops the server it started before it finishes, so the settle used to
 * find nothing on the manifest's port and the app never reached the desktop.
 * The box now starts it from the manifest's `start` (src/lib/app-server-start.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { saveEnv } from "@/tests/helpers/env";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";
import { appMemoryLimits } from "@/lib/box-memory-policy";

// Starts real servers and asks `ss` about them.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const pushed = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: async (a: Record<string, unknown>) => { pushed.push(a); return a; } }));
vi.mock("@/lib/webapp-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webapp-icon")>()),
  ensureWebappIcon: async () => undefined,
}));

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const SERVER_JS = `
const http = require("http");
const fs = require("fs");
fs.writeFileSync("server.pid", String(process.pid));
http.createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

let start: typeof import("@/lib/app-server-start");
let proxy: typeof import("@/lib/app-proxy");
let base: string;
let root: string;
let project: string;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "app-start-"));
  root = path.join(base, "clawbox");
  project = path.join(base, "Projects", "hello-app");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ coding_agent_default_directory: path.dirname(project) }));
  fs.writeFileSync(path.join(project, "server.js"), SERVER_JS);
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  pushed.length = 0;
  vi.resetModules();
  proxy = await import("@/lib/app-proxy");
  proxy._resetListenerCacheForTests();
  start = await import("@/lib/app-server-start");
});

afterEach(() => {
  // End the server the test started, by the pid it wrote.
  try { process.kill(Number(fs.readFileSync(path.join(project, "server.pid"), "utf-8")), "SIGKILL"); } catch { /* never started */ }
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

const searchPath = `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;

function manifestFor(port: number, command: string | null) {
  return { name: "Hello App", description: null, kind: "server" as const, port, start: command, stripBasePath: false };
}

describe("an app whose server the run has already stopped", () => {
  it("is started from the manifest's start command and put on the desktop", async () => {
    const port = await freePort();
    const manifest = manifestFor(port, "node server.js");
    // What the settle saw before: nothing listening, so nothing registered.
    expect(await proxy.registerServerApp({ id: "hello-app", directory: project, manifest })).toMatchObject({ ok: false, reason: "not_listening" });
    expect(pushed).toHaveLength(0);

    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true });

    expect(outcome).toEqual({ ok: true });
    // Registered for the proxy, and announced to the open desktop — the
    // pending action is what makes the icon appear without a reload.
    const meta = JSON.parse(fs.readFileSync(path.join(root, "data", "webapps", "hello-app", "meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "Hello App", port, directory: project });
    expect(pushed).toEqual([expect.objectContaining({ type: "register_webapp", appId: "hello-app", url: "/apps/hello-app/" })]);
    expect(await proxy.resolveAppProxyTarget("hello-app")).toMatchObject({ ok: true, target: { port } });
  });

  it("stays off the desktop, and says why, when the start command brings nothing up", async () => {
    const port = await freePort();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "exit 3"), searchPath, noScope: true });
    expect(outcome).toMatchObject({ ok: false, reason: "not_listening" });
    expect((outcome as { detail: string }).detail).toContain("exit code 3");
    expect(pushed).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "data", "webapps", "hello-app", "meta.json"))).toBe(false);
  });

  it("notices a start command that exits while the box is still closing its log", async () => {
    // The exit used to be listened for only after the start log was closed: a
    // command that failed during that await (a loaded runner, `exit 3`)
    // emitted `exit` with nobody listening, and the box waited the whole wait
    // for a server that had already gone. The close is held here until the
    // command has certainly exited.
    const port = await freePort();
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return close();
      };
      return handle;
    });
    const began = Date.now();
    const outcome = await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "exit 3"), searchPath, noScope: true, waitMs: 20_000 });
    expect(outcome.ok).toBe(false);
    expect((outcome as { detail: string }).detail).toContain("exit code 3");
    expect(Date.now() - began).toBeLessThan(10_000);
  });

  it("ends a start that is still running and still silent when the wait is over", async () => {
    const port = await freePort();
    const marker = path.join(project, "silent.pid");
    const outcome = await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "echo $$ > silent.pid; exec sleep 300"), searchPath, noScope: true, waitMs: 1_500 });
    expect(outcome.ok).toBe(false);
    const pid = Number(fs.readFileSync(marker, "utf-8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills a silent start that ignores the request to stop", async () => {
    const port = await freePort();
    const marker = path.join(project, "stubborn.pid");
    // The shell ignores SIGTERM and stays in the foreground.
    const command = "trap '' TERM; echo $$ > stubborn.pid; while :; do sleep 1; done";
    const outcome = await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, command), searchPath, noScope: true, waitMs: 1_500 });
    expect(outcome.ok).toBe(false);
    const pid = Number(fs.readFileSync(marker, "utf-8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("starts nothing without a start command: the refusal is the old one", async () => {
    const port = await freePort();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, null), searchPath, noScope: true });
    expect(outcome).toMatchObject({ ok: false, reason: "not_listening" });
    expect(fs.existsSync(path.join(project, "server.pid"))).toBe(false);
  });

  it("gives two callers one start", async () => {
    const port = await freePort();
    const input = { id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath, noScope: true };
    const [a, b] = await Promise.all([start.startServerApp(input), start.startServerApp(input)]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });
});

describe("an install again over the app's own server, left running from a removed folder", () => {
  // The pid goes OUTSIDE the project: the folder is removed under the server.
  const PID_SERVER_JS = `
const http = require("http");
require("fs").writeFileSync(process.env.PID_FILE, String(process.pid));
http.createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;
  const started: number[] = [];
  let pidFile: string;

  function writeApp(): void {
    fs.mkdirSync(path.join(project, "sub"), { recursive: true });
    fs.writeFileSync(path.join(project, "server.js"), PID_SERVER_JS);
  }

  function serverPid(): number {
    const pid = Number(fs.readFileSync(pidFile, "utf-8"));
    started.push(pid);
    return pid;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** The Store's uninstall as beta did it: the folder goes, the server stays. Then the install puts the same files back. */
  function removeAndReinstallFolder(): void {
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project, { recursive: true });
    writeApp();
  }

  beforeEach(() => {
    pidFile = path.join(base, "app-server.pid");
    started.length = 0;
    writeApp();
  });

  afterEach(() => {
    for (const pid of started) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("stops the leftover and starts a new server", async () => {
    const port = await freePort();
    const manifest = manifestFor(port, `PID_FILE='${pidFile}' node server.js`);
    expect(await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true })).toEqual({ ok: true });
    const before = serverPid();

    removeAndReinstallFolder();
    // Longer ago than the listener cache remembers, as on the board.
    proxy._resetListenerCacheForTests();
    expect(await proxy.listenerOwnedBy(port, project, { fresh: true })).toBe("not_owned");

    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true });

    expect(outcome).toEqual({ ok: true });
    const after = serverPid();
    expect(after).not.toBe(before);
    expect(alive(before)).toBe(false);
    expect(await proxy.listenerOwnedBy(port, project, { fresh: true })).toBe("owned");
  });

  it("does not take the leftover for the new server within the listener cache's 30 seconds", async () => {
    const port = await freePort();
    const manifest = manifestFor(port, `PID_FILE='${pidFile}' node server.js`);
    expect(await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true })).toEqual({ ok: true });
    const before = serverPid();

    removeAndReinstallFolder();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true });

    expect(outcome).toEqual({ ok: true });
    expect(serverPid()).not.toBe(before);
    expect(alive(before)).toBe(false);
  });

  it("does not take a leftover running in a subfolder of the removed folder for the project's own", async () => {
    const port = await freePort();
    const manifest = manifestFor(port, `cd sub && PID_FILE='${pidFile}' node ../server.js`);
    expect(await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true })).toEqual({ ok: true });
    const before = serverPid();

    removeAndReinstallFolder();
    proxy._resetListenerCacheForTests();
    // Its working directory reads `<project>/sub (deleted)`: lexically inside the new folder, and not in it.
    expect(await proxy.listenerOwnedBy(port, project, { fresh: true })).toBe("not_owned");

    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest, searchPath, noScope: true });

    expect(outcome).toEqual({ ok: true });
    expect(serverPid()).not.toBe(before);
    expect(alive(before)).toBe(false);
  });

  it("refuses a port another process holds, names it, and leaves it running", async () => {
    const port = await freePort();
    // This test's own process: a listener that is not the app's, and must never be signalled.
    const other = net.createServer();
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
    try {
      const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, `PID_FILE='${pidFile}' node server.js`), searchPath, noScope: true });
      expect(outcome).toEqual({ ok: false, reason: "not_owned", detail: `Port ${port} is taken by another process (pid ${process.pid}).` });
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(other.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe("stopping an app's server", () => {
  const PID_SERVER_JS = `
const http = require("http");
require("fs").writeFileSync("server.pid", String(process.pid));
http.createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

  it("stops the server running from the app's folder and forgets that it was listening", async () => {
    fs.writeFileSync(path.join(project, "server.js"), PID_SERVER_JS);
    const port = await freePort();
    expect(await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath, noScope: true })).toEqual({ ok: true });
    const pid = Number(fs.readFileSync(path.join(project, "server.pid"), "utf-8"));
    // Cached as the app's own for the next 30 seconds.
    expect(await proxy.listenerOwnedBy(port, project)).toBe("owned");

    expect(await start.stopServerApp("hello-app", { port, directory: project })).toEqual({ ok: true, stopped: true, holder: null });

    expect(await proxy.listenerOwnedBy(port, project)).toBe("not_listening");
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops nothing that is not the app's, and says who holds the port", async () => {
    const port = await freePort();
    const other = net.createServer();
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
    try {
      expect(await start.stopServerApp("hello-app", { port, directory: project })).toEqual({ ok: true, stopped: false, holder: { pid: process.pid } });
      expect(other.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("ends only the server, never the process group of something the box did not start", async () => {
    // A coding run's agent, working in the project folder, that started the
    // app's server in its own process group: the group's leader is not the
    // app's server, and ending the group would end the run.
    fs.writeFileSync(path.join(project, "server.js"), PID_SERVER_JS);
    const port = await freePort();
    const agent = spawn("/bin/sh", ["-c", "node server.js & while :; do sleep 1; done"], {
      cwd: project,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 10_000;
      while ((await proxy.listenerOwnedBy(port, project, { fresh: true })) !== "owned" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const server = Number(fs.readFileSync(path.join(project, "server.pid"), "utf-8"));

      expect(await start.stopServerApp("hello-app", { port, directory: project })).toEqual({ ok: true, stopped: true, holder: null });

      expect(() => process.kill(server, 0)).toThrow();
      expect(() => process.kill(agent.pid as number, 0)).not.toThrow();
    } finally {
      try { process.kill(-(agent.pid as number), "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("has nothing to do on a port nobody listens on", async () => {
    expect(await start.stopServerApp("hello-app", { port: await freePort(), directory: project })).toEqual({ ok: true, stopped: false, holder: null });
  });

  it("waits for a start of the same app that is still under way", async () => {
    fs.writeFileSync(path.join(project, "server.js"), PID_SERVER_JS);
    const port = await freePort();
    const starting = start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath, noScope: true });
    const stop = await start.stopServerApp("hello-app", { port, directory: project });
    expect(await starting).toEqual({ ok: true });
    expect(stop).toEqual({ ok: true, stopped: true, holder: null });
    expect(await proxy.listenerOwnedBy(port, project, { fresh: true })).toBe("not_listening");
  });

  it("names the owner's own unit when the server comes straight back, and leaves the unit alone", async () => {
    fs.writeFileSync(path.join(project, "server.js"), PID_SERVER_JS);
    const port = await freePort();
    expect(await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath, noScope: true })).toEqual({ ok: true });
    const pid = Number(fs.readFileSync(path.join(project, "server.pid"), "utf-8"));
    // The server as the owner's unit runs it: in that unit, and back as soon
    // as it is ended (here: never ended at all).
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    const readFile = vi.spyOn(fs.promises, "readFile").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (file === `/proc/${pid}/cgroup`) return Promise.resolve("0::/user.slice/user-1000.slice/user@1000.service/app.slice/clawbox-app-hello-app.service\n");
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
      if (signal === undefined || signal === 0) return realKill(target, 0);
      return true;
    }) as typeof process.kill);
    let stop: Awaited<ReturnType<typeof start.stopServerApp>>;
    try {
      stop = await start.stopServerApp("hello-app", { port, directory: project });
    } finally {
      kill.mockRestore();
      readFile.mockRestore();
    }
    try {
      expect(stop.ok).toBe(false);
      expect(!stop.ok && stop.detail).toContain(`(pid ${pid}) is still listening on port ${port}`);
      expect(!stop.ok && stop.detail).toContain("systemctl --user disable --now clawbox-app-hello-app.service");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone already */ }
    }
  });
});

describe("a box whose node is not on the run's fixed PATH", () => {
  // The run's list names the home folders and the FHS ones. node from nvm,
  // or from a tarball the web server's own unit puts on its PATH, is on
  // neither — the run's shell found it through its profile, and `/bin/sh -c`
  // used to answer "node: not found" and exit 127.
  const runPathIn = (home: string) => [".bun/bin", ".npm-global/bin", ".local/bin"].map((dir) => path.join(home, dir)).join(":");

  it("still finds node for the start command", async () => {
    const nvmBin = path.join(base, ".nvm", "versions", "node", "v22.11.0", "bin");
    fs.mkdirSync(nvmBin, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(nvmBin, "node"));
    const port = await freePort();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath: runPathIn(base), noScope: true });
    expect(outcome).toEqual({ ok: true });
  });

  it("runs it on the box's own node, not an older one the run's list names first", async () => {
    // The x64 installer unpacks its own node because the distro's is too old,
    // and leaves that one where it was — in a folder the run's list names.
    const runPath = runPathIn(base);
    const older = path.join(base, ".local", "bin");
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, "node"), "#!/bin/sh\necho \"SyntaxError: Unexpected token '?'\" >&2\nexit 1\n", { mode: 0o755 });
    const port = await freePort();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath: runPath, noScope: true });
    expect(outcome).toEqual({ ok: true });
  });

  it("says what the start command printed when it stopped", async () => {
    const port = await freePort();
    const command = "clawbox-nope run preview --port 4176 --host 127.0.0.1 --base /apps/hello-app/ --strictPort";
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, command), searchPath: runPathIn(base), noScope: true });
    expect(outcome).toMatchObject({ ok: false, reason: "not_listening" });
    const detail = (outcome as { detail: string }).detail;
    expect(detail).toContain("exit code 127");
    // The shell's own words, without the shell's "/bin/sh: 1: " in front.
    expect(detail).toMatch(/: clawbox-nope: (command )?not found$/);
    // And they survive the feed's cap on one line, even behind a long command.
    const line = RUNNER_STEP.notOnDesktop(port, detail);
    expect(line.length).toBeLessThanOrEqual(160);
  });
});

describe("a project's dependencies, installed before its start", () => {
  // A Store package never carries node_modules, so `next build && next start`
  // exited 127 on the box. The stand-ins for bun and npm below record how they
  // were called and do what each test needs.
  let tools: string;
  let calls: string;

  beforeEach(() => {
    tools = path.join(base, "tools");
    calls = path.join(base, "calls.log");
    fs.mkdirSync(tools, { recursive: true });
  });

  function fakeTool(name: string, body: string): void {
    fs.writeFileSync(path.join(tools, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`, { mode: 0o755 });
  }

  const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8").trim().split("\n") : []);
  const withPackage = (extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "next-app", scripts: { serve: "next build && next start" }, dependencies: { next: "15.0.0" }, ...extra }));

  it("picks bun or npm from the lockfile, then packageManager, then what the PATH has", () => {
    fakeTool("bun", "exit 0");
    const empty = path.join(base, "empty");
    fs.mkdirSync(empty);
    const planFor = (files: Record<string, string>, searchPath: string) => {
      const dir = fs.mkdtempSync(path.join(base, "plan-"));
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
      const { tool, args, fallback } = start.dependencyInstallPlan(dir, searchPath);
      return { tool, args, fallback };
    };
    const pkg = "{}";
    const frozenBun = { tool: "bun", args: ["install", "--frozen-lockfile"], fallback: ["install"] };
    expect(planFor({ "package.json": pkg, "bun.lock": "" }, empty)).toEqual(frozenBun);
    expect(planFor({ "package.json": pkg, "bun.lockb": "" }, empty)).toEqual(frozenBun);
    // bun's lockfile wins over npm's.
    expect(planFor({ "package.json": pkg, "bun.lock": "", "package-lock.json": "{}" }, empty)).toEqual(frozenBun);
    expect(planFor({ "package.json": JSON.stringify({ packageManager: "bun@1.2.0" }), "package-lock.json": "{}" }, empty)).toEqual({ tool: "bun", args: ["install"], fallback: null });
    expect(planFor({ "package.json": pkg, "package-lock.json": "{}" }, tools)).toEqual({ tool: "npm", args: ["ci", "--no-audit", "--no-fund"], fallback: ["install", "--no-audit", "--no-fund"] });
    expect(planFor({ "package.json": pkg }, tools)).toEqual({ tool: "bun", args: ["install"], fallback: null });
    expect(planFor({ "package.json": pkg }, empty)).toEqual({ tool: "npm", args: ["install", "--no-audit", "--no-fund"], fallback: null });
    // The bun it runs is the one on the PATH.
    expect(start.dependencyInstallPlan(project, tools).bin).toBe(path.join(tools, "bun"));
  });

  it("installs nothing when node_modules is already there, the package.json declares no dependencies, or there is none", async () => {
    fakeTool("bun", "mkdir -p node_modules");
    const input = { directory: project, searchPath: `${tools}:${searchPath}` };
    expect(await start.installAppDependencies(input)).toEqual({ ok: true, installed: null });
    // npm would only write a package-lock.json here, make no node_modules, and install again on every start.
    withPackage({ dependencies: {}, devDependencies: {} });
    expect(await start.installAppDependencies(input)).toEqual({ ok: true, installed: null });
    withPackage();
    fs.mkdirSync(path.join(project, "node_modules"));
    expect(await start.installAppDependencies(input)).toEqual({ ok: true, installed: null });
    expect(called()).toEqual([]);
  });

  it("installs from bun's lockfile, and falls back to a plain install when package.json has moved past it", async () => {
    withPackage();
    fs.writeFileSync(path.join(project, "bun.lock"), "{}");
    fakeTool("bun", 'if [ "$2" = "--frozen-lockfile" ]; then echo "error: lockfile had changes, but lockfile is frozen" >&2; exit 1; fi\nmkdir -p node_modules/next');
    const outcome = await start.installAppDependencies({ directory: project, searchPath: `${tools}:${searchPath}` });
    expect(outcome).toEqual({ ok: true, installed: "bun" });
    expect(called()).toEqual(["bun install --frozen-lockfile", "bun install"]);
    expect(fs.existsSync(path.join(project, "node_modules", "next"))).toBe(true);
  });

  it("runs npm ci for npm's lockfile, with the same fallback", async () => {
    withPackage();
    fs.writeFileSync(path.join(project, "package-lock.json"), "{}");
    fakeTool("npm", 'if [ "$1" = "ci" ]; then echo "npm error \\`npm ci\\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync." >&2; exit 1; fi\nmkdir -p node_modules');
    expect(await start.installAppDependencies({ directory: project, searchPath: `${tools}:${searchPath}` })).toEqual({ ok: true, installed: "npm" });
    expect(called()).toEqual(["npm ci --no-audit --no-fund", "npm install --no-audit --no-fund"]);
  });

  it("says which tool failed and what it printed last, and leaves no half-made node_modules", async () => {
    withPackage();
    fakeTool("bun", 'mkdir -p node_modules/.cache\necho "bun install v1.2.0"\necho "error: GET https://registry.example/next - 404" >&2\nexit 1');
    const outcome = await start.installAppDependencies({ directory: project, searchPath: `${tools}:${searchPath}` });
    expect(outcome).toEqual({ ok: false, detail: "bun install failed: bun install v1.2.0 · error: GET https://registry.example/next - 404" });
    // So the next try installs again rather than starting into the same 127.
    expect(fs.existsSync(path.join(project, "node_modules"))).toBe(false);
  });

  it("installs again over a node_modules an interrupted install left, and marks a finished one", async () => {
    withPackage();
    fs.mkdirSync(path.join(project, "node_modules"));
    fs.mkdirSync(path.join(project, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(project, ".clawbox", "deps-install-pending"), "1\n");
    fakeTool("bun", "mkdir -p node_modules/next");
    const input = { directory: project, searchPath: `${tools}:${searchPath}` };
    expect(await start.installAppDependencies(input)).toEqual({ ok: true, installed: "bun" });
    expect(fs.existsSync(path.join(project, ".clawbox", "deps-install-pending"))).toBe(false);
    expect(await start.installAppDependencies(input)).toEqual({ ok: true, installed: null });
    expect(called()).toEqual(["bun install"]);
  });

  it("ends an install that does not finish in time, with what it started", async () => {
    withPackage();
    fakeTool("bun", "echo $$ > install.pid\nexec sleep 300");
    const outcome = await start.installAppDependencies({ directory: project, searchPath: `${tools}:${searchPath}`, timeoutMs: 1_000 });
    expect(outcome).toEqual({ ok: false, detail: "bun install failed: it did not finish within 1 s." });
    const pid = Number(fs.readFileSync(path.join(project, "install.pid"), "utf-8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("starts nothing when the install fails, and the answer says why instead of exit code 127", async () => {
    withPackage();
    fakeTool("bun", 'echo "error: GET https://registry.example/next - 404" >&2\nexit 1');
    const port = await freePort();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath: `${tools}:${searchPath}`, noScope: true });
    expect(outcome).toMatchObject({ ok: false, reason: "not_listening", detail: "bun install failed: error: GET https://registry.example/next - 404" });
    expect(fs.existsSync(path.join(project, "server.pid"))).toBe(false);
  });

  it("installs, then starts, on a retry of an app installed without its dependencies", async () => {
    withPackage();
    fakeTool("bun", "mkdir -p node_modules");
    const port = await freePort();
    const outcome = await start.registerOrStartServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath: `${tools}:${searchPath}`, noScope: true });
    expect(outcome).toEqual({ ok: true });
    expect(called()).toEqual(["bun install"]);
  });
});

describe("the last lines an install printed", () => {
  it("leaves out npm's pointer to its log file, colour and blank lines", () => {
    const npm = [
      "\x1b[31mnpm error\x1b[39m code E404",
      "npm error 404 Not Found - GET https://registry.example/nope - Not found",
      "",
      "npm error 404  'nope@*' is not in this registry.",
      "npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/debug-0.log",
    ].join("\n");
    expect(start.installOutputTail(npm)).toBe("npm error code E404 · npm error 404 Not Found - GET https://registry.example/nope - Not found · npm error 404 'nope@*' is not in this registry.");
    expect(start.installOutputTail("\n \n")).toBeNull();
  });

  it("is bounded, and keeps the end", () => {
    const tail = start.installOutputTail(`error: ${"x".repeat(5_000)} the end`)!;
    expect(tail.length).toBeLessThanOrEqual(300);
    expect(tail.endsWith("the end")).toBe(true);
  });
});

describe("the PATH a start command runs with", () => {
  it("keeps the run's own PATH in its order and adds where node and bun live beyond it", () => {
    for (const version of ["v18.20.4", "v22.11.0", "v20.9.0"]) fs.mkdirSync(path.join(base, ".nvm", "versions", "node", version, "bin"), { recursive: true });
    const value = start.startSearchPath("/run/a:/run/b", {
      home: base,
      execPath: "/opt/node/bin/node",
      envPath: "/usr/sbin:/usr/bin:/run/a:/opt/node/bin",
      bunInstall: "/opt/bun",
    });
    const nvm = (version: string) => path.join(base, ".nvm", "versions", "node", version, "bin");
    expect(value.split(":")).toEqual([
      // The node the web server itself runs on, in front when the run's list
      // does not name its folder: an older node in a folder it does name
      // would otherwise win, and npm's `#!/usr/bin/env node` with it.
      "/opt/node/bin",
      "/run/a",
      "/run/b",
      "/opt/bun/bin",
      path.join(base, ".bun", "bin"),
      // Newest first.
      nvm("v22.11.0"),
      nvm("v20.9.0"),
      nvm("v18.20.4"),
      path.join(base, ".npm-global", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      // The web server's own PATH last, and nothing twice.
      "/usr/sbin",
    ]);
  });

  it("leaves the box's node folder where the run's list already has it", () => {
    // The usual box: node in /usr/bin, which the run's list names after the user folders.
    const value = start.startSearchPath("/opt/u/.bun/bin:/usr/local/bin:/usr/bin:/bin", { home: "/opt/u", execPath: "/usr/bin/node", envPath: "" });
    expect(value.split(":").slice(0, 4)).toEqual(["/opt/u/.bun/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  });

  it("drops empty and relative entries, which would resolve against the project folder", () => {
    const value = start.startSearchPath(":/run/a:.:bin", { home: base, execPath: "/run/a/node", envPath: "::./node_modules/.bin" });
    expect(value.split(":")).not.toContain("");
    expect(value.split(":").every((dir) => path.isAbsolute(dir))).toBe(true);
    expect(value.split(":")[0]).toBe("/run/a");
  });
});

describe("what a failed start printed, as one line", () => {
  it("is the shell's complaint, without the shell", () => {
    expect(start.startOutputLine("/bin/sh: 1: bun: not found\n")).toBe("bun: not found");
    expect(start.startOutputLine("bash: line 1: npm: command not found\n")).toBe("npm: command not found");
  });

  it("is the error, not the stack or the version banner after it", () => {
    const crash = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module 'express'",
      "Require stack:",
      "- /srv/app/server.js",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "",
      "Node.js v22.11.0",
    ].join("\n");
    expect(start.startOutputLine(crash)).toBe("Error: Cannot find module 'express'");
  });

  it("follows an error that only introduces the next line", () => {
    expect(start.startOutputLine("\x1b[31merror when starting preview server:\x1b[39m\nError: listen EADDRINUSE: address already in use 127.0.0.1:4176\n"))
      .toBe("error when starting preview server: Error: listen EADDRINUSE: address already in use 127.0.0.1:4176");
  });

  it("is the last line when nothing reads like an error, and nothing when there was no output", () => {
    expect(start.startOutputLine("> app@1.0.0 start\n> node server.js\n\nbye\n")).toBe("bye");
    expect(start.startOutputLine("\n  \n")).toBeNull();
  });

  it("is bounded", () => {
    expect(start.startOutputLine(`Error: ${"x".repeat(5_000)}`)!.length).toBeLessThanOrEqual(200);
  });
});

describe("the scope a started app runs in", () => {
  it("is capped by a share of this board's RAM, yields CPU and disk, and keeps the command one argument", () => {
    const limits = appMemoryLimits();
    expect(start.buildAppScopeArgv("/usr/bin/systemd-run", "hello-app", "abc123", "bun run preview --port 4173")).toEqual({
      bin: "/usr/bin/systemd-run",
      argv: [
        "--user",
        "--scope",
        "--unit=clawbox-app-hello-app-abc123",
        "--collect",
        "--quiet",
        "-p",
        `MemoryHigh=${limits.high}`,
        "-p",
        `MemoryMax=${limits.max}`,
        "-p",
        `CPUWeight=${start.APP_CPU_WEIGHT}`,
        "-p",
        `IOWeight=${start.APP_IO_WEIGHT}`,
        `--nice=${start.APP_NICE}`,
        "--",
        "/bin/sh",
        "-c",
        "bun run preview --port 4173",
      ],
    });
    // Derived, not a literal: the same image ships on 8 GB and 128 GB boards,
    // and a number written for one is wrong on the other.
    expect(limits.maxBytes).toBeLessThan(os.totalmem());
    expect(limits.highBytes).toBeLessThan(limits.maxBytes);
    expect(start.buildAppScopeArgv("/usr/bin/systemd-run", "../etc", "abc", "true")).toBeNull();
    expect(start.buildAppScopeArgv("/usr/bin/systemd-run", "hello-app", "a b", "true")).toBeNull();
  });
});

describe("which scope is an app's own", () => {
  const line = (unit: string) => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;

  it("is exactly the scope the box starts it in", () => {
    expect(start.appScopeOf(line("clawbox-app-audio-app-mh8k2x1q.scope"), "audio-app")).toBe("clawbox-app-audio-app-mh8k2x1q.scope");
    // cgroup v1 names it on the systemd hierarchy's line.
    expect(start.appScopeOf(`12:pids:/user.slice\n1:name=systemd:/user.slice/user@1000.service/app.slice/clawbox-app-audio-app-mh8k2x1q.scope\n`, "audio-app"))
      .toBe("clawbox-app-audio-app-mh8k2x1q.scope");
  });

  it("is never another app's, an owner's own unit, or a name without the box's stamp", () => {
    expect(start.appScopeOf(line("clawbox-app-audio-app-mh8k2x1q.scope"), "audio")).toBeNull();
    expect(start.appScopeOf(line("clawbox-app-audio-mh8k2x1q.scope"), "audio-app")).toBeNull();
    expect(start.appScopeOf(line("clawbox-app-audio-app.service"), "audio-app")).toBeNull();
    expect(start.appScopeOf(line("clawbox-app-audio-app-mh8k2x1q.service"), "audio-app")).toBeNull();
    expect(start.appScopeOf(line("clawbox-app-audio-app.scope"), "audio-app")).toBeNull();
    expect(start.appScopeOf(line("clawbox-app-audio-app-MH8K.scope"), "audio-app")).toBeNull();
    expect(start.appScopeOf(line("clawbox-setup.service"), "audio-app")).toBeNull();
    expect(start.appScopeOf("", "audio-app")).toBeNull();
  });
});

describe("which unit is the owner's own for an app", () => {
  const line = (unit: string) => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;

  it("is exactly the user unit owners wrote for the app", () => {
    expect(start.ownerAppServiceOf(line("clawbox-app-audio-app.service"), "audio-app")).toBe("clawbox-app-audio-app.service");
  });

  it("is never another app's, the box's own scope, the web server or a system unit", () => {
    expect(start.ownerAppServiceOf(line("clawbox-app-audio-app.service"), "audio")).toBeNull();
    expect(start.ownerAppServiceOf(line("clawbox-app-audio-app-mh8k2x1q.scope"), "audio-app")).toBeNull();
    expect(start.ownerAppServiceOf(line("clawbox-setup.service"), "audio-app")).toBeNull();
    expect(start.ownerAppServiceOf("0::/system.slice/clawbox-app-audio-app.service\n", "audio-app")).toBeNull();
    expect(start.ownerAppServiceOf("", "audio-app")).toBeNull();
  });
});

describe("bringing the desktop's app servers back at boot", () => {
  function webapp(id: string, meta: Record<string, unknown>): void {
    const dir = path.join(root, "data", "webapps", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: id, ...meta }));
  }

  it("starts only what the box itself started, from the recorded command", async () => {
    const asked: string[] = [];
    webapp("hello-app", { port: 4230, directory: project, start: "node server.js" });
    webapp("static-site", { port: 4231, directory: project });
    webapp("opted-out", { port: 4232, directory: project, start: "node server.js", autoStart: false });
    webapp("gone", { port: 4233, directory: path.join(base, "nowhere"), start: "node server.js" });
    const started = await start.restartServerAppsAtBoot({
      webappsDir: path.join(root, "data", "webapps"),
      start: async (input) => {
        asked.push(`${input.id}:${input.manifest.start}`);
        return { ok: true };
      },
    });
    expect(started).toEqual(["hello-app"]);
    expect(asked).toEqual(["hello-app:node server.js"]);
  });

  it("does nothing when the owner turned it off", async () => {
    webapp("hello-app", { port: 4230, directory: project, start: "node server.js" });
    const previous = process.env.CLAWBOX_APP_AUTOSTART;
    process.env.CLAWBOX_APP_AUTOSTART = "0";
    try {
      const started = await start.restartServerAppsAtBoot({
        webappsDir: path.join(root, "data", "webapps"),
        start: async () => ({ ok: true }),
      });
      expect(started).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CLAWBOX_APP_AUTOSTART;
      else process.env.CLAWBOX_APP_AUTOSTART = previous;
    }
  });

  it("starts nothing into a port another process holds, and leaves that process alone", async () => {
    const port = await freePort();
    const other = net.createServer();
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
    const asked: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      webapp("hello-app", { port, directory: project, start: "node server.js" });
      const started = await start.restartServerAppsAtBoot({
        webappsDir: path.join(root, "data", "webapps"),
        start: async (input) => {
          asked.push(input.id);
          return { ok: true };
        },
      });
      expect(started).toEqual([]);
      expect(asked).toEqual([]);
      expect(other.listening).toBe(true);
      expect(errors).toHaveBeenCalledWith(`[app-boot] hello-app not started: Port ${port} is taken by another process (pid ${process.pid}).`);
    } finally {
      errors.mockRestore();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("survives a meta.json that is not JSON", async () => {
    const dir = path.join(root, "data", "webapps", "broken-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), "{ nope");
    webapp("hello-app", { port: 4230, directory: project, start: "node server.js" });
    const started = await start.restartServerAppsAtBoot({
      webappsDir: path.join(root, "data", "webapps"),
      start: async () => ({ ok: true }),
    });
    expect(started).toEqual(["hello-app"]);
  });
});
