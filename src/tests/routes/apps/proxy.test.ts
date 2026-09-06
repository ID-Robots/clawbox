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
import zlib from "zlib";
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

/** Register the app on the test's own server: this process listens, from the repository, so the "project" is the working directory. */
function meta(id: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(root, "data", "webapps", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: id, color: "#f97316", icon: "", port, directory: process.cwd(), ...extra }));
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
  (await import("@/lib/app-proxy"))._resetListenerCacheForTests();
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

  it("serves every response under the CSP sandbox — a document whatever its declared type — and framed", async () => {
    meta("site");
    handler = (r, res) => {
      if (r.url?.endsWith(".json")) { res.writeHead(200, { "content-type": "application/json", "x-frame-options": "DENY" }); res.end("{}"); return; }
      // An app may spell its type any way it likes; the sandbox does not depend on reading it.
      res.writeHead(200, { "content-type": "Text/HTML; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "img-src 'self'" });
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
    expect(json.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(json.headers.get("x-frame-options")).toBeNull();
  });

  it("does not label a body Node's fetch has already decompressed", async () => {
    // The other half of the blank window. The proxy relays `upstream.body`,
    // which fetch has already gunzipped, so passing the app's own
    // `content-encoding: gzip` through told the browser to gunzip plain text:
    // ERR_CONTENT_DECODING_FAILED on the stylesheet and the module script,
    // and an empty #root again — this time with CORS answered.
    meta("site");
    const zipped = zlib.gzipSync(Buffer.from("body{color:red}"));
    handler = (_r, res) => {
      res.writeHead(200, {
        "content-type": "text/css",
        "content-encoding": "gzip",
        "content-length": String(zipped.length),
      });
      res.end(zipped);
    };
    const res = await routes.GET(req("/apps/site/a.css"), ctx("site", ["a.css"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("body{color:red}");
    // And it asked for none in the first place: this hop is loopback.
    expect(seen[0].headers["accept-encoding"]).toBe("identity");
  });

  it("leaves an encoding fetch did NOT unwrap alone", async () => {
    // Dropping the header on a body that really is still encoded would be the
    // same defect pointing the other way.
    meta("site");
    handler = (_r, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "custom-thing" });
      res.end("raw");
    };
    const res = await routes.GET(req("/apps/site/a.bin"), ctx("site", ["a.bin"]));
    expect(res.headers.get("content-encoding")).toBe("custom-thing");
  });

  it("answers the CORS its own sandbox causes, so a module script and a crossorigin stylesheet load", async () => {
    // The window was an empty white panel: both of a Vite build's assets died
    // with "from origin 'null' has been blocked by CORS policy: No
    // 'Access-Control-Allow-Origin' header is present". The sandbox is what
    // makes the origin opaque, so the proxy has to answer for it.
    meta("site");
    handler = (_r, res) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end("export default 1"); };
    const script = await routes.GET(
      req("/apps/site/assets/index-BpDL3fMp.js", { headers: { origin: "null", "sec-fetch-dest": "script" } }),
      ctx("site", ["assets", "index-BpDL3fMp.js"]),
    );
    expect(script.headers.get("access-control-allow-origin")).toBe("null");
    expect(script.headers.get("vary")?.toLowerCase()).toContain("origin");
    // Never credentialed: the owner's cookie is stripped on the way in, and an
    // allowed origin WITH credentials is the hole this is not.
    expect(script.headers.get("access-control-allow-credentials")).toBeNull();

    // A request that is not from the sandbox is answered as before.
    const same = await routes.GET(req("/apps/site/assets/index-BpDL3fMp.js"), ctx("site", ["assets", "index-BpDL3fMp.js"]));
    expect(same.headers.get("access-control-allow-origin")).toBeNull();
    const elsewhere = await routes.GET(
      req("/apps/site/assets/index-BpDL3fMp.js", { headers: { origin: "https://evil.example" } }),
      ctx("site", ["assets", "index-BpDL3fMp.js"]),
    );
    expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull();

    // An app that answers CORS itself keeps its own policy.
    handler = (_r, res) => { res.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "https://studio.example" }); res.end("body{}"); };
    const styled = await routes.GET(req("/apps/site/assets/a.css", { headers: { origin: "null" } }), ctx("site", ["assets", "a.css"]));
    expect(styled.headers.get("access-control-allow-origin")).toBe("https://studio.example");
  });

  it("gives the app's DATA no CORS answer, only its code", async () => {
    // `Origin: null` proves nothing — any page on the web can send it from a
    // sandboxed iframe of its own, and over plain HTTP no second header tells
    // the two apart. So the answer reaches the types that are CORS-fetched by
    // construction and carry no per-request data; a notes app's notes are
    // JSON, and JSON stays unreadable to another origin.
    meta("site");
    for (const type of ["application/json", "text/html", "text/plain", "image/png"]) {
      handler = (_r, res) => { res.writeHead(200, { "content-type": type }); res.end("{}"); };
      const res = await routes.GET(req("/apps/site/api/notes", { headers: { origin: "null" } }), ctx("site", ["api", "notes"]));
      expect(res.headers.get("access-control-allow-origin"), type).toBeNull();
    }
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

  it("answers 404 for a name nothing registers, 502 when the listener is not the project's own, and 502 with the remedy when the app is not listening", async () => {
    const missing = await routes.GET(req("/apps/nothing/"), ctx("nothing"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("clawbox.json");
    // Registered for a folder this process does not run from — a manifest
    // pointing the proxy at somebody else's port.
    meta("site", { directory: path.join(base, "elsewhere") });
    const foreign = await routes.GET(req("/apps/site/"), ctx("site"));
    expect(foreign.status).toBe(502);
    expect(await foreign.text()).toContain("not served by the project");
    (await import("@/lib/app-proxy"))._resetListenerCacheForTests();
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
