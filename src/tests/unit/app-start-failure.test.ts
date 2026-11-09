/**
 * @vitest-environment node
 *
 * A server app whose start failed was never registered, and its window got
 * the proxy's 404 "No app is served under this name" — TASK-2323, where the
 * Store's Audiobook Player stopped in its own `next build` and every window,
 * reopen and App Router fetch of it said 404. The box now writes the failed
 * start down (src/lib/app-start-failure.ts) and forgets it once the app is up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { saveEnv } from "@/tests/helpers/env";

// Starts real commands and asks `ss` about their ports.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: async (a: Record<string, unknown>) => a }));
vi.mock("@/lib/webapp-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webapp-icon")>()),
  ensureWebappIcon: async () => undefined,
}));

const BUILD_LOG = path.join(__dirname, "..", "fixtures", "next-build-favicon-rgb.txt");
const SERVER_JS = `
const http = require("http");
const fs = require("fs");
fs.writeFileSync("server.pid", String(process.pid));
http.createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let start: typeof import("@/lib/app-server-start");
let proxy: typeof import("@/lib/app-proxy");
let failures: typeof import("@/lib/app-start-failure");
let base: string;
let root: string;
let project: string;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "app-start-failure-"));
  root = path.join(base, "clawbox");
  project = path.join(base, "Projects", "hello-app");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ coding_agent_default_directory: path.dirname(project) }));
  fs.copyFileSync(BUILD_LOG, path.join(project, "build.log"));
  fs.writeFileSync(path.join(project, "server.js"), SERVER_JS);
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  proxy = await import("@/lib/app-proxy");
  proxy._resetListenerCacheForTests();
  start = await import("@/lib/app-server-start");
  failures = await import("@/lib/app-start-failure");
});

afterEach(() => {
  try { process.kill(Number(fs.readFileSync(path.join(project, "server.pid"), "utf-8")), "SIGKILL"); } catch { /* never started */ }
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

const searchPath = `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;

function manifestFor(port: number, command: string) {
  return { name: "Hello App", description: null, kind: "server" as const, port, start: command, stripBasePath: false };
}

describe("a start that does not come up", () => {
  it("is written down: its command, exit code, the line that says why and the end of what it printed", async () => {
    const port = await freePort();
    // The app's own `next build` stopping on its favicon, as on the board.
    const outcome = await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "cat build.log; exit 1"), searchPath, noScope: true, waitMs: 20_000 });

    expect(outcome.ok).toBe(false);
    const detail = (outcome as { detail: string }).detail;
    expect(detail).toContain("exit code 1");
    expect(detail).toContain("./app/favicon.ico");
    expect(detail).toContain("The PNG is not in RGBA format!");

    const failure = await failures.readAppStartFailure("hello-app");
    expect(failure).toMatchObject({ id: "hello-app", name: "Hello App", command: "cat build.log; exit 1", port, directory: project, stage: "start", exitCode: 1, detail });
    expect(failure!.output).toContain("./app/favicon.ico");
    expect(failure!.output.at(-1)).toBe('error: script "serve" exited with code 1');
    expect(failure!.output.every((line) => line.trim() !== "")).toBe(true);
    expect(Date.parse(failure!.at)).not.toBeNaN();
  });

  it("is forgotten once a start comes up", async () => {
    const port = await freePort();
    await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "exit 3"), searchPath, noScope: true, waitMs: 20_000 });
    expect(await failures.readAppStartFailure("hello-app")).toMatchObject({ exitCode: 3 });

    expect(await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "node server.js"), searchPath, noScope: true })).toEqual({ ok: true });
    expect(await failures.readAppStartFailure("hello-app")).toBeNull();
    expect(fs.existsSync(failures.appStartFailurePath("hello-app"))).toBe(false);
  });

  it("is forgotten when the app is registered, however its server came up", async () => {
    // A server this process runs, from the folder it runs in: the proxy.test pattern.
    const server = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await failures.recordAppStartFailure({ id: "site", name: "Site", command: "npm start", port, directory: process.cwd(), stage: "start", exitCode: 1, detail: "it stopped" });
      expect(await failures.readAppStartFailure("site")).not.toBeNull();
      expect(await proxy.registerServerApp({ id: "site", directory: process.cwd(), manifest: manifestFor(port, "npm start") })).toEqual({ ok: true });
      expect(await failures.readAppStartFailure("site")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("says nothing once the app's folder has gone, and never names a file outside its own folder", async () => {
    await failures.recordAppStartFailure({ id: "hello-app", name: "Hello App", command: "npm start", port: 4321, directory: project, stage: "start", exitCode: 1, detail: "it stopped" });
    expect(await failures.readAppStartFailure("hello-app")).not.toBeNull();
    fs.rmSync(project, { recursive: true, force: true });
    expect(await failures.readAppStartFailure("hello-app")).toBeNull();

    await failures.recordAppStartFailure({ id: "../escape", name: "x", command: "x", port: 4321, directory: base, stage: "start", exitCode: 1, detail: "x" });
    expect(fs.existsSync(path.join(root, "data", "escape.start-failed.json"))).toBe(false);
    expect(await failures.readAppStartFailure("../escape")).toBeNull();
  });
});

describe("the page the app's window shows instead", () => {
  const failure = (over: Partial<import("@/lib/app-start-failure").AppStartFailure> = {}) => ({
    id: "hello-app",
    name: "Hello App",
    at: "2026-11-09T11:25:51.120Z",
    command: "bun run serve",
    port: 4240,
    directory: project,
    stage: "start" as const,
    exitCode: 1,
    detail: "its start command stopped with exit code 1 before listening: Build error occurred ./app/favicon.ico Error: Processing image failed (The PNG is not in RGBA format!)",
    output: ["./app/favicon.ico", "Error: Processing image failed", "<script>alert(1)</script> & more"],
    ...over,
  });

  it("names the app, the reason and the command, shows what it printed escaped, and says whose it is to fix", async () => {
    fs.mkdirSync(path.join(project, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(project, ".clawbox", "store-app.json"), JSON.stringify({ source: "clawbox", slug: "hello-app", version: "1.2.1", sha256: "0".repeat(64), installedAt: "2026-11-09T11:25:40.000Z" }));
    const html = await failures.appStartFailureHtml(failure());
    expect(html).toContain('data-clawbox-app-start-failed="hello-app"');
    expect(html).toContain("Hello App 1.2.1 from the ClawBox Store did not start");
    expect(html).toContain("The PNG is not in RGBA format!");
    expect(html).toContain("<code>bun run serve</code>");
    expect(html).toContain("exit code 1");
    expect(html).toContain("2026-11-09 11:25:51 UTC");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(html).not.toContain("<script>");
    expect(html).toContain("for its publisher to fix");
  });

  it("sends a project the box did not get from the Store to the Coding Agent, and says when the start never ran", async () => {
    const html = await failures.appStartFailureHtml(failure({ stage: "dependencies", exitCode: null, output: [] }));
    expect(html).toContain("Hello App did not start");
    expect(html).toContain("that install failed, so the command was not run");
    expect(html).not.toContain("The end of what it printed");
    expect(html).toContain("Open the project in the Coding Agent");
    expect(failures.appStartFailureText(failure())).toBe(`Hello App is not running: its server did not start. ${failure().detail}`);
  });

  it("keeps the last lines of a long output, without colours or control characters", () => {
    const output = Array.from({ length: 100 }, (_, i) => `\x1b[31mline ${i}\x1b[39m\x07`).join("\n") + "\n\n";
    const lines = failures.failureOutputLines(output);
    expect(lines).toHaveLength(failures.FAILURE_OUTPUT_LINES);
    expect(lines[0]).toBe(`line ${100 - failures.FAILURE_OUTPUT_LINES}`);
    expect(lines.at(-1)).toBe("line 99");
  });
});
