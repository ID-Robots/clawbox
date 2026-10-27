/**
 * @vitest-environment node
 *
 * POST /setup-api/apps/uninstall for a ClawBox app with a server of its own:
 * the server the box started for it is stopped BEFORE its folder goes. It used
 * to keep running from a deleted folder, holding the app's port, and the next
 * install of the same app found the port taken and started nothing.
 *
 * A real server on a real port, asked about through `ss`, as in
 * src/tests/unit/app-server-start.test.ts.
 */
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-uninstall-server-"));
const PREVIOUS_ROOT = process.env.CLAWBOX_ROOT;
process.env.CLAWBOX_ROOT = ROOT;
const PROJECTS = path.join(ROOT, "projects");
const SKILLS_ROOT = path.join(ROOT, "openclaw-workspace", "skills");
const APP_ID = "audio-app";

vi.mock("@/lib/openclaw-config", () => ({
  openclawSkillRoot: vi.fn(() => SKILLS_ROOT),
  clearSkillEntry: vi.fn(async () => false),
  OpenclawConfigUnreadableError: class OpenclawConfigUnreadableError extends Error {
    readonly code = "config_unreadable";
  },
}));
vi.mock("@/lib/openclaw-skill-info", () => ({ refreshSkillsCache: vi.fn() }));
vi.mock("@/lib/kv-store", () => ({ kvDelete: vi.fn() }));
vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: vi.fn(async (a: unknown) => a) }));
vi.mock("@/lib/webapp-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webapp-icon")>()),
  ensureWebappIcon: async () => undefined,
}));
const setPreferences = vi.hoisted(() => vi.fn());
vi.mock("@/lib/preference-store", () => ({ setPreferences }));
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return {
    ...actual,
    getAll: vi.fn(async () => ({
      "pref:installed_apps": [APP_ID],
      "pref:installed_meta": { [APP_ID]: { name: "Audio App", color: "#f97316", iconUrl: "", webappUrl: `/apps/${APP_ID}/` } },
    })),
  };
});
vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory: vi.fn(async () => PROJECTS) }));
const removeFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@/lib/store-install-receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store-install-receipt")>();
  return {
    ...actual,
    removeStoreInstalledFolder: vi.fn(async (appId: string) => {
      if (removeFailure.error) throw removeFailure.error;
      return actual.removeStoreInstalledFolder(appId);
    }),
  };
});

const SERVER_JS = `
const http = require("http");
const fs = require("fs");
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
http.createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const searchPath = `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
/** Outside the app's folder, so the pid is still there to read once the folder is gone. */
const PID_FILE = path.join(ROOT, "server.pid");

function post(appId: string): Request {
  return new Request("http://localhost/setup-api/apps/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId }) });
}

/** What the Store's install leaves: the package, its receipt, and a manifest with a port and a start. */
function storeServerApp(port: number): { dir: string; manifest: { name: string; description: null; kind: "server"; port: number; start: string; stripBasePath: false } } {
  const dir = path.join(PROJECTS, APP_ID);
  fs.mkdirSync(path.join(dir, ".clawbox"), { recursive: true });
  const start = `PID_FILE='${PID_FILE}' node server.js`;
  const manifest = { name: "Audio App", description: null, kind: "server" as const, port, start, stripBasePath: false as const };
  fs.writeFileSync(path.join(dir, "clawbox.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "server.js"), SERVER_JS);
  fs.writeFileSync(path.join(dir, ".clawbox", "store-app.json"), JSON.stringify({ source: "clawbox", slug: APP_ID, version: "1.0.0", sha256: "a".repeat(64), installedAt: "2026-10-01T00:00:00.000Z" }));
  return { dir, manifest };
}

function serverPid(): number {
  return Number(fs.readFileSync(PID_FILE, "utf-8"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let POST: (req: Request) => Promise<Response>;
let start: typeof import("@/lib/app-server-start");
let proxy: typeof import("@/lib/app-proxy");

beforeEach(async () => {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, "data", "webapps"), { recursive: true, force: true });
  fs.rmSync(PID_FILE, { force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  removeFailure.error = null;
  setPreferences.mockReset();
  setPreferences.mockResolvedValue(undefined);
  vi.resetModules();
  proxy = await import("@/lib/app-proxy");
  proxy._resetListenerCacheForTests();
  start = await import("@/lib/app-server-start");
  POST = (await import("@/app/setup-api/apps/uninstall/route")).POST;
});

afterEach(() => {
  // Whatever the test left running, by the pid it wrote.
  try { process.kill(serverPid(), "SIGKILL"); } catch { /* never started, or already gone */ }
});

afterAll(() => {
  if (PREVIOUS_ROOT === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = PREVIOUS_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("uninstalling a Store app that runs a server", () => {
  it("stops the app's server before its folder goes", async () => {
    const port = await freePort();
    const { dir, manifest } = storeServerApp(port);
    expect(await start.registerOrStartServerApp({ id: APP_ID, directory: dir, manifest, searchPath, noScope: true })).toEqual({ ok: true });
    const pid = serverPid();
    expect(await proxy.listenerOwnedBy(port, dir, { fresh: true })).toBe("owned");

    const res = await POST(post(APP_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, appId: APP_ID, projectRemoved: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(await proxy.listenerOwnedBy(port, dir, { fresh: true })).toBe("not_listening");
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("removes nothing, and says it may be retried, when the server will not stop", async () => {
    const port = await freePort();
    const { dir, manifest } = storeServerApp(port);
    expect(await start.registerOrStartServerApp({ id: APP_ID, directory: dir, manifest, searchPath, noScope: true })).toEqual({ ok: true });
    const pid = serverPid();
    // The registration above wrote the desktop's preferences; the uninstall must not.
    setPreferences.mockClear();
    // Signals that do nothing: the server outlives every request to stop.
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
      if (signal === undefined || signal === 0) return realKill(target, 0);
      return true;
    }) as typeof process.kill);
    try {
      const res = await POST(post(APP_ID));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, code: "server_stop_failed", retryable: true, appId: APP_ID });
    } finally {
      kill.mockRestore();
    }
    expect(fs.existsSync(path.join(dir, "clawbox.json"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "data", "webapps", APP_ID, "meta.json"))).toBe(true);
    expect(setPreferences).not.toHaveBeenCalled();
    expect(alive(pid)).toBe(true);
  });
});
