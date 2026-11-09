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

  it("never lets the app write the box's cookie jar — clawbox_session least of all", async () => {
    // A page the window reopens goes out WITH the owner's session and is
    // same-site, so a Set-Cookie on its answer would be stored for the box's
    // origin: an app could sign the owner out, or shadow their cookie on its
    // own path. No app cookie ever comes back through this proxy anyway.
    meta("site");
    handler = (_r, res) => {
      res.setHeader("set-cookie", ["clawbox_session=evil; Path=/; HttpOnly; SameSite=Lax", "clawbox_session=shadow; Path=/apps/site/", "theme=dark; Path=/apps/site/"]);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>page</p>");
    };
    const res = await routes.GET(req("/apps/site/", { headers: { accept: "text/html" }, cookie: "clawbox_session=owner" }), ctx("site"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toBe("<p>page</p>");
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

  it("gives the app's pages and files no CORS answer beyond its code", async () => {
    // `Origin: null` proves nothing — any page on the web can send it from a
    // sandboxed iframe of its own, and over plain HTTP no second header tells
    // the two apart. So outside the app's own /api tree the answer reaches
    // the types that are CORS-fetched by construction and carry no
    // per-request data; a JSON file or an HTML page stays unreadable.
    meta("site");
    for (const type of ["application/json", "text/html", "text/plain", "image/png"]) {
      handler = (_r, res) => { res.writeHead(200, { "content-type": type }); res.end("{}"); };
      const res = await routes.GET(req("/apps/site/data/notes", { headers: { origin: "null" } }), ctx("site", ["data", "notes"]));
      expect(res.headers.get("access-control-allow-origin"), type).toBeNull();
    }
  });

  it("answers the sandboxed document's calls to the app's OWN /api: any type, no credentials, range headers readable, preflight 204", async () => {
    // The document the proxy serves has the origin `null` (its CSP sandbox),
    // so the app's fetch of its own API was a CORS request its server never
    // answered: every app with an API loaded and then did nothing.
    meta("site");
    handler = (_r, res) => { res.writeHead(206, { "content-type": "audio/mpeg", "content-range": "bytes 0-3/4", "accept-ranges": "bytes" }); res.end("abcd"); };
    const res = await routes.GET(req("/apps/site/api/track/1", { headers: { origin: "null", range: "bytes=0-3" } }), ctx("site", ["api", "track", "1"]));
    expect(res.status).toBe(206);
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-expose-headers")).toContain("Content-Range");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");

    handler = (_r, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };
    expect((await routes.GET(req("/apps/site/api/notes", { headers: { origin: "null" } }), ctx("site", ["api", "notes"]))).headers.get("access-control-allow-origin")).toBe("null");
    // Only the opaque origin the proxy itself makes — no other page's.
    expect((await routes.GET(req("/apps/site/api/notes", { headers: { origin: "https://evil.example" } }), ctx("site", ["api", "notes"]))).headers.get("access-control-allow-origin")).toBeNull();
    expect((await routes.GET(req("/apps/site/api/notes"), ctx("site", ["api", "notes"]))).headers.get("access-control-allow-origin")).toBeNull();
    // An app that sets its own policy keeps it.
    handler = (_r, res) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "https://partner.example" }); res.end("{}"); };
    expect((await routes.GET(req("/apps/site/api/notes", { headers: { origin: "null" } }), ctx("site", ["api", "notes"]))).headers.get("access-control-allow-origin")).toBe("https://partner.example");
    // …and the range and paging headers are readable whenever the final answer
    // admits the caller, merged into whatever the app chose to expose.
    handler = (_r, res) => { res.writeHead(206, { "content-type": "audio/mpeg", "content-range": "bytes 0-3/4", "access-control-allow-origin": "*" }); res.end("abcd"); };
    expect((await routes.GET(req("/apps/site/api/track/1", { headers: { origin: "null" } }), ctx("site", ["api", "track", "1"]))).headers.get("access-control-expose-headers")).toContain("Content-Range");
    handler = (_r, res) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "null", "access-control-expose-headers": "X-Request-Id" }); res.end("{}"); };
    const merged = (await routes.GET(req("/apps/site/api/notes", { headers: { origin: "null" } }), ctx("site", ["api", "notes"]))).headers.get("access-control-expose-headers") ?? "";
    expect(merged.split(", ")[0]).toBe("X-Request-Id");
    expect(merged).toContain("Content-Range");
    // An app answer that does not admit the caller exposes nothing extra.
    handler = (_r, res) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "https://partner.example" }); res.end("{}"); };
    expect((await routes.GET(req("/apps/site/api/notes", { headers: { origin: "null" } }), ctx("site", ["api", "notes"]))).headers.get("access-control-expose-headers")).toBeNull();

    // A JSON POST preflights; the proxy answers it so a server that never
    // heard of OPTIONS still works from inside the frame. Nothing reaches it.
    seen.length = 0;
    const preflight = await routes.OPTIONS(req("/apps/site/api/notes", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }), ctx("site", ["api", "notes"]));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(seen).toHaveLength(0);
    // A preflight for anything but the API, or from any other origin, goes to the app as before.
    handler = (_r, res) => { res.writeHead(200, { allow: "GET" }); res.end(); };
    const other = await routes.OPTIONS(req("/apps/site/page", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST" } }), ctx("site", ["page"]));
    expect(other.status).toBe(200);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("answers the App Router's own fetches from the sandboxed document — a link click, a prefetch, a server action — so a Next app's window navigates in place", async () => {
    // A Next.js <Link> click is a fetch with `RSC: 1` (+ Next-Router-State-Tree);
    // from the opaque origin it preflights. The preflight went to the app,
    // which never answers one; the fetch failed, Next fell back to a full
    // page load made by the frame itself, with no cookie: the login screen.
    meta("site");
    seen.length = 0;
    const preflight = await routes.OPTIONS(req("/apps/site/books/2", {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "GET", "access-control-request-headers": "next-router-state-tree,next-url,rsc" },
    }), ctx("site", ["books", "2"]));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("next-router-state-tree,next-url,rsc");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST, OPTIONS");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(seen).toHaveLength(0);

    handler = (_r, res) => { res.writeHead(200, { "content-type": "text/x-component", vary: "rsc, next-router-state-tree, next-router-prefetch", "x-nextjs-postponed": "1" }); res.end("0:{}"); };
    const nav = await routes.GET(req("/apps/site/books/2?_rsc=abc", { headers: { origin: "null", rsc: "1", "next-router-state-tree": "%5B%5D" } }), ctx("site", ["books", "2"]));
    expect(nav.status).toBe(200);
    expect(nav.headers.get("access-control-allow-origin")).toBe("null");
    expect(nav.headers.get("access-control-allow-credentials")).toBeNull();
    // The router reads Vary and its own x-nextjs-* headers off the answer.
    expect(nav.headers.get("access-control-expose-headers")).toBe("*");
    expect(nav.headers.get("vary")).toContain("Origin");
    expect(nav.headers.get("content-security-policy")).toContain("sandbox");
    // The request reached the app as the router sent it — and never with a cookie.
    expect(seen.at(-1)?.headers.rsc).toBe("1");
    expect(seen.at(-1)?.headers.origin).toBe("null");
    expect(seen.at(-1)?.headers.cookie).toBeUndefined();

    // The box's own Next.js deletes Next-Url before this handler runs; the
    // middleware carries it under x-clawbox-next-url and it reaches the app
    // under its own name again — the app hashes it into `_rsc`.
    await routes.GET(req("/apps/site/books/2?_rsc=abc", { headers: { origin: "null", rsc: "1", "x-clawbox-next-url": "/books" } }), ctx("site", ["books", "2"]));
    expect(seen.at(-1)?.headers["next-url"]).toBe("/books");
    expect(seen.at(-1)?.headers["x-clawbox-next-url"]).toBeUndefined();

    // A server action: a POST with Next-Action to the page's own path.
    const actionPreflight = await routes.OPTIONS(req("/apps/site/books/new", {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type, next-action, next-router-state-tree" },
    }), ctx("site", ["books", "new"]));
    expect(actionPreflight.status).toBe(204);
    expect(actionPreflight.headers.get("access-control-allow-origin")).toBe("null");
    handler = (_r, res) => { res.writeHead(303, { "content-type": "text/x-component", "x-action-redirect": "/apps/site/books;push", "access-control-expose-headers": "X-Request-Id" }); res.end(); };
    const action = await routes.POST(req("/apps/site/books/new", { method: "POST", body: "[]", headers: { origin: "null", "next-action": "7f00", accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" } }), ctx("site", ["books", "new"]));
    expect(action.status).toBe(303);
    expect(action.headers.get("access-control-allow-origin")).toBe("null");
    expect(action.headers.get("access-control-expose-headers")).toBe("X-Request-Id, *");
    expect(seen.at(-1)?.body).toBe("[]");
    // Next.js refuses an action from `Origin: null` (its CSRF guard), and this
    // hop carries no cookie for that guard to protect: the action arrives from
    // the origin the browser is on. Nothing else has its Origin touched.
    expect(seen.at(-1)?.headers.origin).toBe("http://box.local");
    await routes.POST(req("/apps/site/api/notes", { method: "POST", body: "{}", headers: { origin: "null", "content-type": "application/json" } }), ctx("site", ["api", "notes"]));
    expect(seen.at(-1)?.headers.origin).toBe("null");

    // Only for the opaque origin the proxy itself makes, and only for the router's own fetches.
    expect((await routes.GET(req("/apps/site/books/2?_rsc=abc", { headers: { origin: "https://evil.example", rsc: "1" } }), ctx("site", ["books", "2"]))).headers.get("access-control-allow-origin")).toBeNull();
    handler = (_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>page</p>"); };
    const page = await routes.GET(req("/apps/site/books/2", { headers: { origin: "null" } }), ctx("site", ["books", "2"]));
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("access-control-expose-headers")).toBeNull();
    // An app that sets its own policy keeps it, and exposes what it chose.
    handler = (_r, res) => { res.writeHead(200, { "content-type": "text/x-component", "access-control-allow-origin": "https://partner.example" }); res.end("0:{}"); };
    const own = await routes.GET(req("/apps/site/books/2?_rsc=abc", { headers: { origin: "null", rsc: "1" } }), ctx("site", ["books", "2"]));
    expect(own.headers.get("access-control-allow-origin")).toBe("https://partner.example");
    expect(own.headers.get("access-control-expose-headers")).toBeNull();
    // A preflight that asks for no router header still goes to the app.
    seen.length = 0;
    handler = (_r, res) => { res.writeHead(200, { allow: "GET" }); res.end(); };
    const plainPreflight = await routes.OPTIONS(req("/apps/site/books/2", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "PUT", "access-control-request-headers": "x-custom" } }), ctx("site", ["books", "2"]));
    expect(plainPreflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toHaveLength(1);
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

  it("answers an app whose start failed with what failed, as a 503 — a page for its window, a sentence for its fetches — not the 404 (TASK-2323)", async () => {
    const failures = await import("@/lib/app-start-failure");
    const detail = "its start command stopped with exit code 1 before listening: Build error occurred ./app/favicon.ico Error: Processing image failed (The PNG is not in RGBA format!)";
    // Never registered: a Store install whose own build failed.
    await failures.recordAppStartFailure({ id: "books", name: "Books", command: "bun run serve", port: 4240, directory: process.cwd(), stage: "start", exitCode: 1, detail, output: "> Build error occurred\n./app/favicon.ico\n" });

    const page = await routes.GET(req("/apps/books/", { headers: { "sec-fetch-dest": "iframe", accept: "text/html" } }), ctx("books"));
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    const html = await page.text();
    expect(html).toContain('data-clawbox-app-start-failed="books"');
    expect(html).toContain("The PNG is not in RGBA format!");
    expect(html).toContain("<code>bun run serve</code>");

    // The App Router's own fetch and its preflight, which reach the proxy with
    // no session: one sentence that names nothing the start printed.
    const rsc = await routes.GET(req("/apps/books/?_rsc=1", { headers: { rsc: "1", accept: "*/*" } }), ctx("books"));
    expect(rsc.status).toBe(503);
    expect(rsc.headers.get("content-type")).toContain("text/plain");
    expect(await rsc.text()).toBe("Books is not running: its server did not start. Its window on the desktop says why.");
    // A "frame" asking from the sandbox's opaque origin passes the middleware
    // without a session too: never the page.
    const opaque = await routes.GET(req("/apps/books/", { headers: { origin: "null", "sec-fetch-dest": "iframe", accept: "text/html" } }), ctx("books"));
    expect(opaque.status).toBe(503);
    expect(opaque.headers.get("content-type")).toContain("text/plain");
    expect(await opaque.text()).not.toContain("favicon");
    const preflight = await routes.OPTIONS(req("/apps/books/", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "GET", "access-control-request-headers": "rsc,next-router-state-tree,next-url" } }), ctx("books"));
    expect(preflight.status).toBe(503);

    // Registered, and nothing listens (the boot pass could not bring it back): the same.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    meta("books");
    const down = await routes.GET(req("/apps/books/", { headers: { "sec-fetch-dest": "document" } }), ctx("books"));
    expect(down.status).toBe(503);
    expect(await down.text()).toContain("did not start");

    // Forgotten (an uninstall, a start that came up): the listener's own answer again.
    await failures.clearAppStartFailure("books");
    const plain = await routes.GET(req("/apps/books/", { headers: { "sec-fetch-dest": "document" } }), ctx("books"));
    expect(plain.status).toBe(502);
    expect(await plain.text()).toContain(`port ${port}`);
    server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("keeps the 404 for a name nothing registers and no start ever failed for", async () => {
    const missing = await routes.GET(req("/apps/nothing/", { headers: { "sec-fetch-dest": "iframe" } }), ctx("nothing"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("No app is served under this name");
  });
});
