/**
 * @vitest-environment node
 *
 * `/apps/<id>/…` proxied to the project's own server: a real HTTP server on
 * a free port stands in for the app. The path reaches it unchanged (or
 * stripped when the manifest says so), the owner's cookie never does, an
 * HTML document comes back under the CSP sandbox, and an app that is not
 * listening is a plain 502 with the remedy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { NextRequest } from "next/server";
import { saveEnv } from "@/tests/helpers/env";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let routes: typeof import("@/app/apps/[id]/[[...path]]/route");
let server: http.Server;
let port: number;
let seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
let handler: Handler;
let base: string;
let root: string;
let restore: () => void;

function meta(id: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(root, "data", "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: id, color: "#f97316", icon: "", port, ...extra }));
}

function req(pathname: string, init: { method?: string; body?: string; headers?: Record<string, string>; cookie?: string } = {}): NextRequest {
  const headers = new Headers(init.headers ?? {});
  headers.set("host", "box.local");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new NextRequest(`http://box.local${pathname}`, { method: init.method, body: init.body, headers });
}

function ctx(id: string, rest: string[] = []) {
  return { params: Promise.resolve({ id, path: rest }) };
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "app-proxy-route-"));
  root = path.join(base, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({}));
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  seen = [];
  handler = (_req, res, _body) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); };
  server = http.createServer((r, res) => {
    let body = "";
    r.on("data", (c) => { body += c; });
    r.on("end", () => { seen.push({ method: r.method ?? "", url: r.url ?? "", headers: r.headers, body }); handler(r, res, body); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  vi.resetModules();
  routes = await import("@/app/apps/[id]/[[...path]]/route");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the app proxy", () => {
  it("forwards the path unchanged, with the query, and never the owner's cookie", async () => {
    meta("site");
    const res = await routes.GET(req("/apps/site/api/items?page=2", { cookie: "clawbox_session=secret" }), ctx("site", ["api", "items"]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/apps/site/api/items?page=2");
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.host).toBe(`127.0.0.1:${port}`);
    expect(seen[0].headers["x-forwarded-host"]).toBe("box.local");
    expect(seen[0].headers["x-forwarded-prefix"]).toBe("/apps/site");
  });

  it("strips the base path when the manifest asks", async () => {
    meta("site", { stripBasePath: true });
    await routes.GET(req("/apps/site/"), ctx("site"));
    await routes.GET(req("/apps/site/css/a.css"), ctx("site", ["css", "a.css"]));
    expect(seen.map((s) => s.url)).toEqual(["/", "/css/a.css"]);
  });

  it("serves a document under the CSP sandbox, framed, and leaves other types alone", async () => {
    meta("site");
    handler = (r, res) => {
      if (r.url?.endsWith(".json")) { res.writeHead(200, { "content-type": "application/json", "x-frame-options": "DENY" }); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "img-src 'self'" });
      res.end("<h1>hi</h1>");
    };
    const html = await routes.GET(req("/apps/site/"), ctx("site"));
    expect(html.status).toBe(200);
    expect(html.headers.get("x-frame-options")).toBeNull();
    const csp = html.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).not.toContain("allow-same-origin");
    expect(await html.text()).toBe("<h1>hi</h1>");
    const json = await routes.GET(req("/apps/site/data.json"), ctx("site", ["data.json"]));
    expect(json.headers.get("content-security-policy")).toBeNull();
    expect(json.headers.get("x-frame-options")).toBeNull();
  });

  it("carries a POST body through and hands a redirect back rather than following it", async () => {
    meta("site");
    handler = (r, res, body) => {
      if (r.method === "POST") { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ got: body })); return; }
      res.writeHead(302, { location: "/apps/site/login" }); res.end();
    };
    const posted = await routes.POST(req("/apps/site/api/save", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } }), ctx("site", ["api", "save"]));
    expect(posted.status).toBe(201);
    expect(await posted.json()).toEqual({ got: JSON.stringify({ a: 1 }) });
    expect(seen[0].headers["content-type"]).toBe("application/json");
    const redirected = await routes.GET(req("/apps/site/private"), ctx("site", ["private"]));
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("/apps/site/login");
  });

  it("answers 404 for a name nothing declares, and 502 with the remedy when the app is not listening", async () => {
    const missing = await routes.GET(req("/apps/nothing/"), ctx("nothing"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("clawbox.json");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    meta("site");
    const down = await routes.GET(req("/apps/site/"), ctx("site"));
    expect(down.status).toBe(502);
    expect(await down.text()).toContain(`port ${port}`);
    // afterEach closes again; a closed server closes without complaint.
    server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});
