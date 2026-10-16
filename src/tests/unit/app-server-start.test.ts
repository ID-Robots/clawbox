/**
 * @vitest-environment node
 *
 * A run stops the server it started before it finishes, so the settle used to
 * find nothing on the manifest's port and the app never reached the desktop.
 * The box now starts it from the manifest's `start` (src/lib/app-server-start.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { saveEnv } from "@/tests/helpers/env";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";

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
  it("is named from the validated id, and the command stays one argument", () => {
    expect(start.buildAppScopeArgv("/usr/bin/systemd-run", "hello-app", "abc123", "bun run preview --port 4173")).toEqual({
      bin: "/usr/bin/systemd-run",
      argv: ["--user", "--scope", "--unit=clawbox-app-hello-app-abc123", "--collect", "--quiet", "--", "/bin/sh", "-c", "bun run preview --port 4173"],
    });
    expect(start.buildAppScopeArgv("/usr/bin/systemd-run", "../etc", "abc", "true")).toBeNull();
    expect(start.buildAppScopeArgv("/usr/bin/systemd-run", "hello-app", "a b", "true")).toBeNull();
  });
});
