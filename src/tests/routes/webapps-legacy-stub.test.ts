/**
 * @vitest-environment node
 *
 * A legacy `location.hostname:<port>` stub, and what the owner sees when the
 * server behind it is not running.
 *
 * Before `/apps/<id>/` existed (src/lib/app-proxy.ts) an app with a server of
 * its own was put on the desktop as a one-file redirect to `host:port`. Those
 * stubs are still on disk on every box that shipped. With the server down the
 * window was an empty white rectangle (ERR_CONNECTION_REFUSED, rendered by
 * Chromium inside the frame) and nothing on the desktop said whether the app
 * was broken, gone, or merely not started — the sweep found two of them,
 * Tinder Clone blank and Cool Game showing an upstream's bare "Not Found".
 *
 * These cases run the real route against a real temp box: real files, a real
 * listener, the real `ss` check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { NextRequest } from "next/server";
import { saveEnv } from "@/tests/helpers/env";

// One case spawns a real server from inside a project folder (the only way to
// earn an "owned" verdict), and every case shells out to `ss`.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: async () => undefined }));
// Registering an app draws it a picture; not on a test box.
vi.mock("@/lib/webapp-icon", () => ({
  ensureWebappIcon: async () => undefined,
  htmlHint: () => "",
  safeAppId: (id: string) => (/^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null),
}));

let GET: (req: NextRequest) => Promise<Response>;
let appProxy: typeof import("@/lib/app-proxy");
let base: string;
let root: string;
let projects: string;
let restore: () => void;

/** The stub the box used to write: a redirect to the box's hostname and a port. */
function legacyStub(port: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cool Game</title></head><body><script>location.replace(location.protocol+'//'+location.hostname+':${port}/');</script></body></html>`;
}

function installApp(id: string, name: string, html: string): void {
  const dir = path.join(root, "data", "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name, color: "#f97316", icon: "" }));
}

function get(id: string): Promise<Response> {
  return GET(new NextRequest(new URL(`http://localhost/setup-api/webapps?app=${id}`)));
}

/** A listener of THIS process, whose working directory is the repository. */
async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A listener that really runs FROM `cwd` — what the proxy calls the project's own. */
async function listenFrom(cwd: string): Promise<{ port: number; kill: () => void }> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["-e", "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let seen = "";
    child.stdout?.on("data", (d: Buffer) => {
      seen += d.toString();
      // Wait for the newline the child's console.log writes. A pipe promises
      // no chunk boundaries, so resolving on the first non-empty chunk read a
      // split "4230\n" as "42" and the case then probed a port nothing was
      // listening on — a flake that only ever showed up on a loaded runner.
      const end = seen.indexOf("\n");
      if (end !== -1) resolve(Number(seen.slice(0, end).trim()));
    });
    child.on("exit", () => reject(new Error("the project's server exited before it listened")));
  });
  return { port, kill: () => child.kill("SIGKILL") };
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-stub-"));
  root = path.join(base, "clawbox");
  projects = path.join(base, "Projects");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ coding_agent_default_directory: projects }),
  );
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  appProxy = await import("@/lib/app-proxy");
  appProxy._resetListenerCacheForTests();
  GET = (await import("@/app/setup-api/webapps/route")).GET;
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("a legacy stub whose server is not running", () => {
  it("answers in the box's own words instead of a blank frame", async () => {
    // A port nothing has ever listened on for this box.
    const free = await listen();
    await free.close();
    appProxy._resetListenerCacheForTests();
    installApp("cool-game", "Cool Game", legacyStub(free.port));

    const res = await get("cool-game");
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("Cool Game");
    // The same sentence /apps/<id>/ answers with — one box, one explanation.
    expect(body).toContain(appProxy.listenerRefusal("not_listening", free.port));
    // And nothing of the stub: no redirect for the frame to follow into
    // Chromium's error page.
    expect(body).not.toContain("location.hostname");
  });

  it("leaves the stub alone while something is answering on the port", async () => {
    // The listener is not the project's own, so the proxy would refuse it —
    // but the redirect still reaches it on the LAN, exactly as it does today.
    const other = await listen();
    try {
      const html = legacyStub(other.port);
      installApp("tinder-clone", "Tinder Clone", html);
      const res = await get("tinder-clone");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(html);
    } finally {
      await other.close();
    }
  });

  it("serves a real one-file app that merely reads its own hostname", async () => {
    const app = `<!doctype html><html><body><h1>Notes</h1><script>document.title=location.hostname;</script></body></html>`;
    installApp("notes", "Notes", app);
    const res = await get("notes");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(app);
  });
});

describe("a legacy stub whose project declares its port", () => {
  it("is migrated to /apps/<id>/ once, on disk and on the desktop", async () => {
    const directory = path.join(projects, "tinder-clone");
    fs.mkdirSync(directory, { recursive: true });
    const server = await listenFrom(directory);
    try {
      fs.writeFileSync(
        path.join(directory, "clawbox.json"),
        JSON.stringify({ name: "Tinder Clone", kind: "server", port: server.port }),
      );
      // The stub points at a port nothing serves; the manifest is the truth.
      installApp("tinder-clone", "Tinder Clone", legacyStub(4230));

      const body = await (await get("tinder-clone")).text();
      expect(body).toContain("/apps/tinder-clone/");
      expect(body).not.toContain("location.hostname");

      // Written through, so the next open costs no listener check…
      const onDisk = fs.readFileSync(path.join(root, "data", "webapps", "tinder-clone", "index.html"), "utf-8");
      expect(onDisk).toContain("/apps/tinder-clone/");
      const meta = JSON.parse(fs.readFileSync(path.join(root, "data", "webapps", "tinder-clone", "meta.json"), "utf-8"));
      expect(meta).toMatchObject({ name: "Tinder Clone", port: server.port, directory });
      // …and the desktop icon now opens a path, not a host and a port.
      const config = JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8"));
      expect(config["pref:installed_meta"]["tinder-clone"].webappUrl).toBe("/apps/tinder-clone/");
    } finally {
      server.kill();
    }
  });

  it("keeps the stub when the manifest's port has nothing on it but the stub's does", async () => {
    const directory = path.join(projects, "half-moved");
    fs.mkdirSync(directory, { recursive: true });
    const running = await listen();
    try {
      const dead = await listen();
      await dead.close();
      appProxy._resetListenerCacheForTests();
      fs.writeFileSync(
        path.join(directory, "clawbox.json"),
        JSON.stringify({ name: "Half Moved", port: dead.port }),
      );
      const html = legacyStub(running.port);
      installApp("half-moved", "Half Moved", html);
      // A migration that cannot be verified must not take a working app away.
      const res = await get("half-moved");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(html);
    } finally {
      await running.close();
    }
  });
});
