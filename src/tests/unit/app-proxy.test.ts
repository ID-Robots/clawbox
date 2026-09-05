/**
 * @vitest-environment node
 *
 * `/apps/<id>/…` — a project's own server reached on the box's origin, so
 * its link survives a tunnel reset (src/lib/app-proxy.ts). The port
 * resolution, the registration a settling run performs, and the two
 * questions the middleware asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { saveEnv } from "@/tests/helpers/env";

// Starts real listeners and asks `ss` about them: not a 5 s job on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** A listener of THIS process — whose working directory is the repository — on a free port. */
async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => { res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const pushed = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: async (a: Record<string, unknown>) => { pushed.push(a); return a; } }));
// The registry draws an icon for every app that reaches the desktop; not here.
vi.mock("@/lib/webapp-icon", () => ({ ensureWebappIcon: async () => undefined }));

let lib: typeof import("@/lib/app-proxy");
let base: string;
let root: string;
let projects: string;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "app-proxy-"));
  root = path.join(base, "clawbox");
  projects = path.join(base, "Projects");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ coding_agent_default_directory: projects }));
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  pushed.length = 0;
  vi.resetModules();
  lib = await import("@/lib/app-proxy");
  lib._resetListenerCacheForTests();
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the path and the request", () => {
  it("reads the id out of /apps/<id>/… and refuses anything else", () => {
    expect(lib.parseAppProxyPath("/apps/tinder-clone/")).toEqual({ id: "tinder-clone", rest: "/" });
    expect(lib.parseAppProxyPath("/apps/tinder-clone/api/x")).toEqual({ id: "tinder-clone", rest: "/api/x" });
    expect(lib.parseAppProxyPath("/apps/tinder-clone")).toEqual({ id: "tinder-clone", rest: "" });
    expect(lib.parseAppProxyPath("/apps/")).toBeNull();
    expect(lib.parseAppProxyPath("/apps/../etc")).toBeNull();
    expect(lib.parseAppProxyPath("/setup-api/apps/icon/x")).toBeNull();
  });

  it("tells a document from the requests a document makes", () => {
    expect(lib.isDocumentRequest(new Headers({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(lib.isDocumentRequest(new Headers({ "sec-fetch-dest": "iframe" }))).toBe(true);
    expect(lib.isDocumentRequest(new Headers({ "sec-fetch-dest": "empty", accept: "text/html" }))).toBe(false);
    expect(lib.isDocumentRequest(new Headers({ "sec-fetch-dest": "script" }))).toBe(false);
    // No fetch metadata: a navigation asks for HTML, an API call does not.
    expect(lib.isDocumentRequest(new Headers({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(lib.isDocumentRequest(new Headers({ accept: "application/json" }))).toBe(false);
    expect(lib.isDocumentRequest(new Headers())).toBe(false);
  });

  it("names the same config key the runner does", async () => {
    const { CODING_AGENT_DIR_CONFIG_KEY } = await import("@/lib/coding-agent");
    expect(lib.PROJECT_FOLDER_CONFIG_KEY).toBe(CODING_AGENT_DIR_CONFIG_KEY);
  });
});

describe("whose listener it is", () => {
  it("owns a listener of this process running from the project folder, and refuses everything else", async () => {
    const mine = await listen();
    try {
      // The repository is this process's working directory: a "project" that
      // contains it is owned, one that does not is not.
      expect(await lib.listenerOwnedBy(mine.port, process.cwd())).toBe("owned");
      lib._resetListenerCacheForTests();
      expect(await lib.listenerOwnedBy(mine.port, projects)).toBe("not_owned");
    } finally {
      await mine.close();
    }
    lib._resetListenerCacheForTests();
    // Nothing listens there now.
    expect(await lib.listenerOwnedBy(mine.port, process.cwd())).toBe("not_listening");
    expect(lib.listenerRefusal("not_listening", mine.port)).toContain(`port ${mine.port}`);
  });

  it("remembers an owned verdict, and forgets a refusal quickly", async () => {
    const mine = await listen();
    try {
      expect(await lib.listenerOwnedBy(mine.port, process.cwd())).toBe("owned");
      await mine.close();
      // Cached: still owned within the TTL, even though the server is gone.
      expect(await lib.listenerOwnedBy(mine.port, process.cwd())).toBe("owned");
    } finally {
      await mine.close().catch(() => undefined);
    }
  });
});

describe("resolveAppProxyTarget", () => {
  it("serves a REGISTERED app whose listener is the project's own, and nothing on a manifest alone", async () => {
    expect(await lib.resolveAppProxyTarget("nothing")).toMatchObject({ ok: false, reason: "unregistered" });
    // A manifest naming a port is not a registration: a repository could
    // carry one pointing at any local service.
    fs.mkdirSync(path.join(projects, "site"), { recursive: true });
    fs.writeFileSync(path.join(projects, "site", "clawbox.json"), JSON.stringify({ name: "Site", port: 4230 }));
    expect(await lib.resolveAppProxyTarget("site")).toMatchObject({ ok: false, reason: "unregistered" });

    const mine = await listen();
    try {
      fs.mkdirSync(path.join(root, "data", "webapps", "site"), { recursive: true });
      fs.writeFileSync(path.join(root, "data", "webapps", "site", "meta.json"), JSON.stringify({ name: "Site", port: mine.port, directory: process.cwd(), stripBasePath: true }));
      expect(await lib.resolveAppProxyTarget("site")).toEqual({ ok: true, target: { id: "site", port: mine.port, stripBasePath: true, directory: process.cwd() } });
      // Registered for a folder the listener does not run from: refused.
      lib._resetListenerCacheForTests();
      fs.writeFileSync(path.join(root, "data", "webapps", "site", "meta.json"), JSON.stringify({ name: "Site", port: mine.port, directory: projects }));
      expect(await lib.resolveAppProxyTarget("site")).toMatchObject({ ok: false, reason: "not_owned" });
    } finally {
      await mine.close();
    }
    // Never a port the box itself listens on, nor an id that is not one.
    fs.writeFileSync(path.join(root, "data", "webapps", "site", "meta.json"), JSON.stringify({ name: "Site", port: 80, directory: process.cwd() }));
    expect(await lib.resolveAppProxyTarget("site")).toMatchObject({ ok: false, reason: "unregistered" });
    expect(await lib.resolveAppProxyTarget("../site")).toMatchObject({ ok: false, reason: "unregistered" });
  });

  it("falls back to the project folder of the id for a registration without one", async () => {
    const mine = await listen();
    try {
      fs.mkdirSync(path.join(root, "data", "webapps", "old"), { recursive: true });
      fs.writeFileSync(path.join(root, "data", "webapps", "old", "meta.json"), JSON.stringify({ name: "Old", port: mine.port }));
      // No such project folder: nothing to own it.
      expect(await lib.resolveAppProxyTarget("old")).toMatchObject({ ok: false, reason: "not_owned" });
      expect(await lib.projectFolderFor("old")).toBeNull();
      fs.mkdirSync(path.join(projects, "old"), { recursive: true });
      expect(await lib.projectFolderFor("old")).toBe(path.join(projects, "old"));
      // …and a code project of that id counts too.
      fs.mkdirSync(path.join(root, "data", "code-projects", "cp"), { recursive: true });
      expect(await lib.projectFolderFor("cp")).toBe(path.join(root, "data", "code-projects", "cp"));
    } finally {
      await mine.close();
    }
  });
});

describe("registerServerApp", () => {
  const manifest = (port: number) => ({ name: "Tinder Clone", description: "Swipe", kind: "server" as const, port, start: null, stripBasePath: false });

  it("writes the stub, the port and the folder, registers the desktop icon on /apps/<id>/, and nudges the desktop", async () => {
    const mine = await listen();
    try {
      expect(await lib.registerServerApp({ id: "tinder-clone", directory: process.cwd(), manifest: manifest(mine.port) })).toEqual({ ok: true });
      const dir = path.join(root, "data", "webapps", "tinder-clone");
      expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))).toEqual({ name: "Tinder Clone", color: "#f97316", icon: "", port: mine.port, directory: process.cwd() });
      const html = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
      expect(html).toContain('location.replace("/apps/tinder-clone/")');
      expect(html).not.toMatch(/location\.hostname|:4230/);
      const config = JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8"));
      expect(config["pref:installed_apps"]).toEqual(["tinder-clone"]);
      expect(config["pref:installed_meta"]["tinder-clone"]).toMatchObject({ name: "Tinder Clone", webappUrl: "/apps/tinder-clone/" });
      expect(pushed).toEqual([expect.objectContaining({ type: "register_webapp", appId: "tinder-clone", url: "/apps/tinder-clone/" })]);
      expect(await lib.resolveAppProxyTarget("tinder-clone")).toEqual({ ok: true, target: { id: "tinder-clone", port: mine.port, stripBasePath: false, directory: process.cwd() } });
    } finally {
      await mine.close();
    }
  });

  it("registers nothing when the port is not the project's own, and says which way it is not", async () => {
    const mine = await listen();
    try {
      const out = await lib.registerServerApp({ id: "other", directory: projects, manifest: manifest(mine.port) });
      expect(out).toMatchObject({ ok: false, reason: "not_owned" });
    } finally {
      await mine.close();
    }
    lib._resetListenerCacheForTests();
    expect(await lib.registerServerApp({ id: "quiet", directory: process.cwd(), manifest: manifest(mine.port) })).toMatchObject({ ok: false, reason: "not_listening" });
    expect(fs.existsSync(path.join(root, "data", "webapps", "other"))).toBe(false);
    expect(fs.existsSync(path.join(root, "data", "webapps", "quiet"))).toBe(false);
    expect(pushed).toEqual([]);
    expect(await lib.registerServerApp({ id: "plain", directory: process.cwd(), manifest: { ...manifest(3000), port: null } })).toMatchObject({ ok: false, reason: "failed" });
  });

  it("keeps an earlier registration's colour and icon", async () => {
    const mine = await listen();
    try {
      const dir = path.join(root, "data", "webapps", "site");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: "Old", color: "#123456", icon: "/x.png" }));
      expect(await lib.registerServerApp({ id: "site", directory: process.cwd(), manifest: { ...manifest(mine.port), stripBasePath: true } })).toEqual({ ok: true });
      expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))).toEqual({ name: "Tinder Clone", color: "#123456", icon: "/x.png", port: mine.port, directory: process.cwd(), stripBasePath: true });
    } finally {
      await mine.close();
    }
  });

  it("escapes the name in the stub", () => {
    expect(lib.serverAppStubHtml("<b>&'\"", "x")).toContain("<title>&lt;b&gt;&amp;&#39;&quot;</title>");
  });
});
