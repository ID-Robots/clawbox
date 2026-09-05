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
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

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

describe("resolveAppProxyTarget", () => {
  it("takes the registered meta's port first, the project's manifest second, and nothing otherwise", async () => {
    expect(await lib.resolveAppProxyTarget("nothing")).toBeNull();
    fs.mkdirSync(path.join(projects, "site"), { recursive: true });
    fs.writeFileSync(path.join(projects, "site", "clawbox.json"), JSON.stringify({ name: "Site", port: 4230, stripBasePath: true }));
    expect(await lib.resolveAppProxyTarget("site")).toEqual({ id: "site", port: 4230, stripBasePath: true });
    fs.mkdirSync(path.join(root, "data", "webapps", "site"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "webapps", "site", "meta.json"), JSON.stringify({ name: "Site", port: 5000 }));
    expect(await lib.resolveAppProxyTarget("site")).toEqual({ id: "site", port: 5000, stripBasePath: false });
    // A meta without a port is a one-file webapp, and the manifest still answers.
    fs.writeFileSync(path.join(root, "data", "webapps", "site", "meta.json"), JSON.stringify({ name: "Site" }));
    expect(await lib.resolveAppProxyTarget("site")).toEqual({ id: "site", port: 4230, stripBasePath: true });
    // Never a port the box itself listens on, nor an id that is not one.
    fs.writeFileSync(path.join(root, "data", "webapps", "site", "meta.json"), JSON.stringify({ name: "Site", port: 80 }));
    fs.writeFileSync(path.join(projects, "site", "clawbox.json"), JSON.stringify({ name: "Site", port: 80 }));
    expect(await lib.resolveAppProxyTarget("site")).toBeNull();
    expect(await lib.resolveAppProxyTarget("../site")).toBeNull();
  });
});

describe("registerServerApp", () => {
  it("writes the stub and the port, registers the desktop icon on /apps/<id>/, and nudges the desktop", async () => {
    const manifest = { name: "Tinder Clone", description: "Swipe", kind: "server" as const, port: 4230, start: null, stripBasePath: false };
    expect(await lib.registerServerApp({ id: "tinder-clone", manifest })).toBe(true);
    const dir = path.join(root, "data", "webapps", "tinder-clone");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))).toEqual({ name: "Tinder Clone", color: "#f97316", icon: "", port: 4230 });
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
    expect(html).toContain('location.replace("/apps/tinder-clone/")');
    expect(html).not.toMatch(/location\.hostname|:4230/);
    const config = JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8"));
    expect(config["pref:installed_apps"]).toEqual(["tinder-clone"]);
    expect(config["pref:installed_meta"]["tinder-clone"]).toMatchObject({ name: "Tinder Clone", webappUrl: "/apps/tinder-clone/" });
    expect(pushed).toEqual([expect.objectContaining({ type: "register_webapp", appId: "tinder-clone", url: "/apps/tinder-clone/" })]);
    expect(await lib.resolveAppProxyTarget("tinder-clone")).toEqual({ id: "tinder-clone", port: 4230, stripBasePath: false });
  });

  it("keeps an earlier registration's colour and icon, and does nothing for a manifest without a port", async () => {
    const dir = path.join(root, "data", "webapps", "site");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: "Old", color: "#123456", icon: "/x.png" }));
    const manifest = { name: "Site", description: null, kind: null, port: 3000, start: null, stripBasePath: true };
    expect(await lib.registerServerApp({ id: "site", manifest })).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))).toEqual({ name: "Site", color: "#123456", icon: "/x.png", port: 3000, stripBasePath: true });
    expect(await lib.registerServerApp({ id: "plain", manifest: { ...manifest, port: null } })).toBe(false);
    expect(fs.existsSync(path.join(root, "data", "webapps", "plain"))).toBe(false);
  });

  it("escapes the name in the stub", () => {
    expect(lib.serverAppStubHtml("<b>&'\"", "x")).toContain("<title>&lt;b&gt;&amp;&#39;&quot;</title>");
  });
});
