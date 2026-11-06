// @vitest-environment node
import { createRequire } from "module";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real processes (a node child and `ss`): see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * scripts/app-port.js — "is this port the project's own listener", which the
 * WebSocket proxy and the public app links (TASK-1478) ask before forwarding.
 * Real processes, real sockets: a yes must not outlive the socket it was
 * given for.
 */
const require_ = createRequire(import.meta.url);
const { appListenerOwned } = require_("../../../scripts/app-port.js") as {
  appListenerOwned: (port: number, directory: string) => boolean;
};

const children: ChildProcess[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** A listener on `port` in a child process whose cwd is `cwd` — a project's server. */
function projectServer(port: number, cwd: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1", () => console.log("up"))`], { cwd, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`exited ${code}`)));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

describe("appListenerOwned", () => {
  it("a cached yes does not survive the app's exit: whatever binds the port next is refused at once", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "app-port-"));
    const port = await freePort();
    const app = await projectServer(port, project);
    expect(appListenerOwned(port, project)).toBe(true);
    // Reused while it is still the same socket.
    expect(appListenerOwned(port, project)).toBe(true);

    app.kill("SIGKILL");
    await exited(app);
    // Something that is not the project takes the port well inside the old 30 s cache.
    const other = net.createServer();
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", () => resolve()));
    expect(process.cwd().startsWith(fs.realpathSync(project))).toBe(false);
    expect(appListenerOwned(port, project)).toBe(false);
  });

  it("is no to a server left running in a subfolder of a removed project, once a folder of the same name is back", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "app-port-"));
    fs.mkdirSync(path.join(project, "sub"));
    const port = await freePort();
    await projectServer(port, path.join(project, "sub"));
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project);
    try {
      // Its cwd reads `<project>/sub (deleted)`: inside the new folder by its spelling only.
      expect(appListenerOwned(port, project)).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
