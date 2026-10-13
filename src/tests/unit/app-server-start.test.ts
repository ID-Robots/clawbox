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

  it("ends a start that is still running and still silent when the wait is over", async () => {
    const port = await freePort();
    const marker = path.join(project, "silent.pid");
    const outcome = await start.startServerApp({ id: "hello-app", directory: project, manifest: manifestFor(port, "echo $$ > silent.pid; exec sleep 300"), searchPath, noScope: true, waitMs: 1_500 });
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
