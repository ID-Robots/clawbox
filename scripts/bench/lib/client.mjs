// The bench's view of the box: one way to call owner routes and, when the
// desktop's Chrome is reachable, one way to run code inside the signed-in page.
//
//   mode "cdp"   — every HTTP call is a `fetch` evaluated inside the desktop
//                  page (same-origin, the page's own session); the page and
//                  new pages are available for UI scenarios.
//   mode "token" — plain Node `fetch` with the box's MCP bearer
//                  (data/.mcp-token, the same credential the on-device suite
//                  in scripts/nano-tests uses); no page, no gateway socket.
import fs from "node:fs";
import path from "node:path";
import { connectTarget, findDesktopTarget, openPage } from "./cdp.mjs";

/** Installed once per page: a timed fetch that returns a plain object. */
const PAGE_HELPERS = `
(() => {
  if (window.__clawboxBench) return 'present';
  window.__clawboxBench = {
    async http(path, init) {
      init = init || {};
      const headers = Object.assign({}, init.headers || {});
      let body = init.body;
      if (body !== undefined && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = headers['Content-Type'] || 'application/json'; }
      const t0 = performance.now();
      let res, text = '', error = null;
      try {
        res = await fetch(path, { method: init.method || 'GET', headers, body, cache: 'no-store', credentials: 'same-origin' });
        text = await res.text();
      } catch (e) { error = String(e && e.message || e); }
      const ms = performance.now() - t0;
      if (error) return { ok: false, status: 0, ms, bytes: 0, text: '', json: null, headers: {}, error };
      let json = null; try { json = JSON.parse(text); } catch {}
      const h = {}; for (const k of ['content-type', 'content-encoding', 'cache-control', 'etag', 'content-length']) { const v = res.headers.get(k); if (v) h[k] = v; }
      return { ok: res.ok, status: res.status, ms, bytes: text.length, text: json === null ? text.slice(0, 4000) : '', json, headers: h, error: null };
    },
  };
  return 'installed';
})()`;

export async function createClient(opts) {
  const baseUrl = (opts.baseUrl || "http://localhost:3005").replace(/\/$/, "");
  if (opts.auth === "token") return tokenClient(baseUrl, opts);
  return cdpClient(baseUrl, opts);
}

async function cdpClient(baseUrl, opts) {
  const port = opts.cdpPort;
  const target = await findDesktopTarget(port, opts.urlMatch ?? null);
  if (!target) {
    throw new Error(`No signed-in desktop page on DevTools port ${port} (a localhost page at "/"). Is the kiosk Chrome running, or pass --auth token.`);
  }
  const page = await connectTarget(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable").catch(() => null);
  await page.evaluate(PAGE_HELPERS);
  const pageOrigin = new URL(target.url).origin;
  const http = async (p, init = {}) => {
    const expr = `window.__clawboxBench.http(${JSON.stringify(p)}, ${JSON.stringify(init)})`;
    return page.evaluate(expr, { timeoutMs: init.timeoutMs ?? 120_000 });
  };
  // A page the bench opens itself (shown on screen until closed).
  const newPage = async (url) => {
    const full = /^https?:/.test(url) ? url : pageOrigin + url;
    const p = await openPage(port, full);
    await p.send("Page.enable").catch(() => null);
    await p.send("Runtime.enable").catch(() => null);
    return p;
  };
  return {
    mode: "cdp",
    baseUrl: pageOrigin,
    http,
    page,
    newPage,
    close: () => page.close(),
  };
}

function tokenClient(baseUrl, opts) {
  const root = opts.repoRoot;
  const tokenPath = path.join(root, "data", ".mcp-token");
  if (!fs.existsSync(tokenPath)) throw new Error(`--auth token needs ${tokenPath} to be readable on this box`);
  const token = fs.readFileSync(tokenPath, "utf8").replace(/[\r\n]/g, "");
  const http = async (p, init = {}) => {
    const headers = { Authorization: `Bearer ${token}`, ...(init.headers || {}) };
    let body = init.body;
    if (body !== undefined && typeof body !== "string") { body = JSON.stringify(body); headers["Content-Type"] ||= "application/json"; }
    const t0 = performance.now();
    let res; let text = "";
    try {
      res = await fetch(baseUrl + p, { method: init.method || "GET", headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
      text = await res.text();
    } catch (e) {
      return { ok: false, status: 0, ms: performance.now() - t0, bytes: 0, text: "", json: null, headers: {}, error: String(e?.message || e) };
    }
    const ms = performance.now() - t0;
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    const h = {}; for (const k of ["content-type", "content-encoding", "cache-control", "etag", "content-length"]) { const v = res.headers.get(k); if (v) h[k] = v; }
    return { ok: res.ok, status: res.status, ms, bytes: text.length, text: json === null ? text.slice(0, 4000) : "", json, headers: h, error: null };
  };
  return { mode: "token", baseUrl, http, page: null, newPage: null, close: () => {} };
}
