// @vitest-environment node
import { createRequire } from "module";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * TASK-1515 — a public app link with a password of its own, attacked for
 * real: the actual listener (scripts/public-app-links.js) in front of an
 * actual HTTP "app", over real sockets. What the owner's half writes is
 * covered in src/tests/routes/apps/public-link.test.ts.
 */
const require_ = createRequire(import.meta.url);
const links = require_("../../../scripts/public-app-links.js") as {
  COOKIE_NAME: string;
  UNLOCK_COOKIE_NAME: string;
  UNLOCK_PATH: string;
  PASSWORD_TRIES_PER_VISITOR: number;
  PASSWORD_TRIES_PER_LINK: number;
  PASSWORD_WINDOW_MS: number;
  linkPaths: (root: string) => { dir: string; links: string; audit: string };
  validLink: (raw: unknown) => { password: { hash: string; key: string } | null } | null;
  verifyPasswordHash: (password: string, hash: string) => Promise<boolean>;
  createLinkServer: (id: string, opts: Record<string, unknown>) => http.Server;
};

const TOKEN = "A".repeat(43);
const LINK_ID = "0123456789abcdef";
const APP = "notes";
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another one entirely";

/** A stored password record, at the cheapest cost the serving side accepts (the tests hash a lot). */
function record(password: string) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize("NFC"), salt, 32, { N: 16384, r: 8, p: 1 });
  return { hash: `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`, key: crypto.randomBytes(32).toString("base64url"), setAt: 1 };
}

const STORED = record(PASSWORD);

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

let root: string;
let appServer: http.Server;
let appPort: number;
let seen: Seen[];
let linkServer: http.Server;
let linkPort: number;
let clock: number | null = null;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

function writeLinks(list: unknown[]) {
  const p = links.linkPaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(`${p.links}.tmp`, JSON.stringify({ version: 1, links: list }));
  fs.renameSync(`${p.links}.tmp`, p.links);
}

function link(over: Record<string, unknown> = {}) {
  return { id: LINK_ID, appId: APP, mode: "permanent", token: TOKEN, createdAt: 1, expiresAt: null, apiAllow: [], password: STORED, ...over };
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

interface AskOptions { method?: string; headers?: Record<string, string>; body?: string; token?: boolean; unlock?: string; ip?: string; port?: number }

function ask(pathname: string, opts: AskOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "x-forwarded-proto": "https", ...(opts.headers ?? {}) };
    const cookies: string[] = [];
    if (opts.token !== false) cookies.push(`${links.COOKIE_NAME}=${TOKEN}`);
    if (opts.unlock) cookies.push(`${links.UNLOCK_COOKIE_NAME}=${opts.unlock}`);
    if (cookies.length && !("cookie" in headers)) headers.cookie = cookies.join("; ");
    if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
    if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
    const req = http.request({ host: "127.0.0.1", port: opts.port ?? linkPort, method: opts.method ?? "GET", path: pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Type a password into the password page. */
function unlock(password: string, opts: AskOptions & { next?: string } = {}): Promise<Reply> {
  const form = new URLSearchParams({ next: opts.next ?? `/apps/${APP}/`, password });
  return ask(links.UNLOCK_PATH, { method: "POST", ...opts, headers: { "content-type": "application/x-www-form-urlencoded", ...(opts.headers ?? {}) }, body: form.toString() });
}

/** The unlock cookie's value out of a Set-Cookie header. */
function unlockCookie(res: Reply): string {
  const header = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${links.UNLOCK_COOKIE_NAME}=`));
  if (!header) throw new Error("no unlock cookie was set");
  return header.split(";")[0].slice(links.UNLOCK_COOKIE_NAME.length + 1);
}

function serve(over: Record<string, unknown> = {}): http.Server {
  return links.createLinkServer(LINK_ID, {
    root,
    now: () => clock ?? Date.now(),
    resolveApp: (_root: string, id: string) => (id === APP ? { id, port: appPort, strip: false } : null),
    ...over,
  });
}

beforeAll(async () => {
  seen = [];
  appServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf-8") });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`app:${req.method}:${req.url}`);
    });
  });
  appPort = await listen(appServer);
});

afterAll(async () => {
  await new Promise((r) => appServer.close(r));
});

beforeEach(async () => {
  seen.length = 0;
  clock = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "public-links-pw-"));
  fs.mkdirSync(path.join(root, "data", "webapps", APP), { recursive: true });
  writeLinks([link()]);
  linkServer = serve();
  linkPort = await listen(linkServer);
});

afterEach(async () => {
  linkServer.closeAllConnections?.();
  await new Promise((r) => linkServer.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a link with a password asks for it first", () => {
  it("shows the password page instead of the app, and nothing reaches the app", async () => {
    const res = await ask(`/apps/${APP}/?tab=2`);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("<form method=\"post\" action=\"/.link/unlock\">");
    expect(res.body).toContain("name=\"password\" type=\"password\"");
    expect(res.body).toContain(`name="next" value="/apps/${APP}/?tab=2"`);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(seen).toHaveLength(0);
  });

  it("the page says nothing about the box: no product name, host, version, script or outside asset", async () => {
    const res = await ask("/");
    const page = res.body.replace(/name="next" value="[^"]*"/, "");
    expect(page).not.toMatch(/clawbox|openclaw|jetson|nvidia|tegra/i);
    expect(page).not.toContain(os.hostname());
    expect(page).not.toContain(APP);
    expect(page).not.toMatch(/<script|<link|<img|<iframe|src=|href=|url\(|@import/i);
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers.server).toBeUndefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toMatch(/clawbox|next\.js/i);
  });

  /**
   * TASK-1746 — the address copied from the browser's bar after the app
   * opened has no token in it (the redirect took it out). On a link with a
   * password that address still opens: the password is the secret.
   */
  it("is shown to a visitor without the link's token too, and the password lets them in — with both cookies, nothing of either in the address", async () => {
    const locked = await ask(`/apps/${APP}/?tab=2`, { token: false });
    expect(locked.status).toBe(401);
    expect(locked.body).toContain("<form method=\"post\" action=\"/.link/unlock\">");
    expect(locked.headers["set-cookie"]).toBeUndefined();
    expect((await ask(`/apps/${APP}/api/x`, { token: false })).status).toBe(401);
    expect(seen).toHaveLength(0);

    expect((await unlock("not it", { token: false })).status).toBe(401);
    const res = await unlock(PASSWORD, { token: false, next: `/apps/${APP}/?tab=2` });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/apps/${APP}/?tab=2`);
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies).toHaveLength(2);
    expect(cookies.find((c) => c.startsWith(`${links.COOKIE_NAME}=`))).toMatch(new RegExp(`^${links.COOKIE_NAME}=${TOKEN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
    expect(cookies.find((c) => c.startsWith(`${links.UNLOCK_COOKIE_NAME}=`))).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

    // A cold client that holds exactly what the browser would now: both cookies.
    const jar = cookies.map((c) => c.split(";")[0]).join("; ");
    const open = await ask(`/apps/${APP}/?tab=2`, { headers: { cookie: jar } });
    expect(open.status).toBe(200);
    expect(open.body).toBe(`app:GET:/apps/${APP}/?tab=2`);
    expect(seen[0].headers.cookie).toBeUndefined();
    // The unlock cookie alone (a signed proof of this link's password) is enough as well.
    expect((await ask(`/apps/${APP}/`, { token: false, unlock: unlockCookie(res) })).status).toBe(200);
  });

  it("without the token, a visitor is not counted as a token guesser — a bare address is not an attack", async () => {
    for (let i = 0; i < 15; i += 1) expect((await ask(`/apps/${APP}/`, { token: false, ip: "203.0.113.77" })).status).toBe(401);
    expect((await unlock(PASSWORD, { token: false, ip: "203.0.113.77" })).status).toBe(303);
  });

  it("the token-less way in exists only for a link with a password: an open link's bare address is still a 404", async () => {
    writeLinks([link({ password: undefined })]);
    expect((await ask(`/apps/${APP}/`, { token: false })).status).toBe(404);
    expect((await unlock(PASSWORD, { token: false })).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("a cookieless client walks the whole flow the way a new device does: ?k= → password → app → its API", async () => {
    writeLinks([link({ apiAllow: ["/api"] })]);
    const first = await ask(`/apps/${APP}/?k=${TOKEN}`, { token: false });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe(`/apps/${APP}/`);
    let jar = ([] as string[]).concat(first.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
    const page = await ask(`/apps/${APP}/`, { headers: { cookie: jar } });
    expect(page.status).toBe(401);
    expect(page.body).toContain("<form");
    const form = new URLSearchParams({ next: `/apps/${APP}/`, password: PASSWORD }).toString();
    const unlockRes = await ask(links.UNLOCK_PATH, { method: "POST", headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded" }, body: form });
    expect(unlockRes.status).toBe(303);
    jar = `${jar}; ${([] as string[]).concat(unlockRes.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ")}`;
    expect((await ask(`/apps/${APP}/`, { headers: { cookie: jar } })).status).toBe(200);
    const api = await ask(`/apps/${APP}/api/items`, { headers: { cookie: jar } });
    expect(api.status).toBe(200);
    expect(api.body).toBe(`app:GET:/apps/${APP}/api/items`);
    const post = await ask(`/apps/${APP}/api/items`, { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: "{\"n\":1}" });
    expect(post.status).toBe(200);
    // Read-only: the same link, reads only.
    writeLinks([link({ apiAllow: ["/api"], apiReadOnly: true })]);
    expect((await ask(`/apps/${APP}/api/items`, { headers: { cookie: jar } })).status).toBe(200);
    expect((await ask(`/apps/${APP}/api/items`, { method: "POST", headers: { cookie: jar, "content-type": "application/json" }, body: "{\"n\":2}" })).status).toBe(403);
  });

  it("stands in front of everything the link serves: allow-listed API paths and writes too", async () => {
    writeLinks([link({ apiAllow: ["/api/scores"] })]);
    expect((await ask(`/apps/${APP}/api/scores`)).status).toBe(401);
    const post = await ask(`/apps/${APP}/api/scores`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"n\":1}" });
    expect(post.status).toBe(401);
    expect(post.body).not.toContain("<form");
    expect((await ask(`/apps/${APP}/style.css`)).status).toBe(401);
    expect((await ask("/")).status).toBe(401);
    expect((await ask(`/apps/${APP}/`, { method: "HEAD" })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("stands in front of a one-file webapp's files as well", async () => {
    fs.writeFileSync(path.join(root, "data", "webapps", APP, "index.html"), "<p>the app</p>");
    const server = serve({ resolveApp: () => null });
    const port = await listen(server);
    try {
      const locked = await ask("/", { port });
      expect(locked.status).toBe(401);
      expect(locked.body).not.toContain("the app");
      const cookie = unlockCookie(await unlock(PASSWORD, { port, next: "/" }));
      const open = await ask("/", { port, unlock: cookie });
      expect(open.status).toBe(200);
      expect(open.body).toBe("<p>the app</p>");
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  it("speaks the visitor's language when it has it, English otherwise", async () => {
    expect((await ask("/", { headers: { "accept-language": "bg-BG,bg;q=0.9,en;q=0.8" } })).body).toContain("Нужна е парола");
    expect((await ask("/", { headers: { "accept-language": "de" } })).body).toContain("<html lang=\"de\">");
    expect((await ask("/", { headers: { "accept-language": "xx, <script>" } })).body).toContain("<html lang=\"en\">");
  });
});

describe("typing the password", () => {
  it("refuses a wrong password, sets no cookie, and the app stays closed", async () => {
    const res = await unlock("not the password");
    expect(res.status).toBe(401);
    expect(res.body).toContain("Wrong password");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await unlock("")).status).toBe(401);
    expect((await unlock("x".repeat(500))).status).toBe(401);
    expect((await ask(`/apps/${APP}/`)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("opens the app after the right password, with a cookie bound to this origin only", async () => {
    const res = await unlock(PASSWORD, { next: `/apps/${APP}/page?x=1` });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/apps/${APP}/page?x=1`);
    const header = String(res.headers["set-cookie"]);
    expect(header).toMatch(new RegExp(`^${links.UNLOCK_COOKIE_NAME}=v1\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
    expect(header).not.toMatch(/Domain=/i);
    expect(header).not.toContain(PASSWORD);
    expect(header).not.toContain(STORED.key);

    const open = await ask(`/apps/${APP}/page?x=1`, { unlock: unlockCookie(res) });
    expect(open.status).toBe(200);
    expect(open.body).toBe(`app:GET:/apps/${APP}/page?x=1`);
    // Neither of the link's cookies, nor the password, ever reaches the app.
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain(PASSWORD);
  });

  it("still applies the app's own limits after the password: /api and writes stay closed unless allow-listed", async () => {
    const cookie = unlockCookie(await unlock(PASSWORD));
    expect((await ask(`/apps/${APP}/api/x`, { unlock: cookie })).status).toBe(403);
    expect((await ask(`/apps/${APP}/x`, { unlock: cookie, method: "POST", body: "a=1" })).status).toBe(403);
    expect((await ask("/setup-api/preferences", { unlock: cookie })).status).toBe(404);
    expect((await ask("/login", { unlock: cookie })).status).toBe(404);
  });

  it("only ever redirects into this origin", async () => {
    for (const next of ["//evil.example/", "https://evil.example/", "/\\evil.example", "/a/../b", "javascript:alert(1)", "", links.UNLOCK_PATH]) {
      const res = await unlock(PASSWORD, { next, ip: `198.51.100.${next.length}` });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/");
    }
  });

  it("accepts only a same-origin form post of sane size", async () => {
    expect((await unlock(PASSWORD, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await unlock(PASSWORD, { headers: { "content-type": "application/json" } })).status).toBe(415);
    expect((await ask(links.UNLOCK_PATH, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${"x".repeat(5000)}` })).status).toBe(413);
    expect((await ask(links.UNLOCK_PATH)).status).toBe(405);
    expect((await unlock(PASSWORD, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(303);
  });

  it("once unlocked, the form's address leads back into the app", async () => {
    const cookie = unlockCookie(await unlock(PASSWORD));
    const res = await ask(links.UNLOCK_PATH, { unlock: cookie });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
  });
});

describe("attempt limiting", () => {
  it("locks a visitor out after repeated wrong passwords — the right one included — and tells them so", async () => {
    for (let i = 0; i < links.PASSWORD_TRIES_PER_VISITOR; i += 1) {
      expect((await unlock(`wrong-${i}`, { ip: "203.0.113.7" })).status).toBe(401);
    }
    const res = await unlock(PASSWORD, { ip: "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe(String(links.PASSWORD_WINDOW_MS / 1000));
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body).toContain("Too many attempts");
    const page = await ask(`/apps/${APP}/`, { ip: "203.0.113.7" });
    expect(page.status).toBe(401);
    expect(page.body).toContain("Too many attempts");
    expect(page.body).toContain("disabled");
    expect(seen).toHaveLength(0);
    // Another visitor of the same link is not locked out by it.
    expect((await unlock(PASSWORD, { ip: "203.0.113.8" })).status).toBe(303);
  });

  it("lets the visitor back in when the window has passed", async () => {
    clock = 1_000_000;
    for (let i = 0; i < links.PASSWORD_TRIES_PER_VISITOR; i += 1) await unlock("wrong", { ip: "203.0.113.9" });
    expect((await unlock(PASSWORD, { ip: "203.0.113.9" })).status).toBe(429);
    clock += links.PASSWORD_WINDOW_MS + 1;
    expect((await unlock(PASSWORD, { ip: "203.0.113.9" })).status).toBe(303);
  });

  it("caps wrong passwords per link, whatever address they come from", async () => {
    for (let i = 0; i < links.PASSWORD_TRIES_PER_LINK; i += 1) {
      expect((await unlock("wrong", { ip: `192.0.2.${i + 1}` })).status).toBe(401);
    }
    expect((await unlock(PASSWORD, { ip: "192.0.2.200" })).status).toBe(429);
  });

  it("does not count right passwords against the link", async () => {
    for (let i = 0; i < links.PASSWORD_TRIES_PER_LINK + 5; i += 1) {
      expect((await unlock(PASSWORD, { ip: `192.0.2.${i + 1}` })).status).toBe(303);
    }
  });

  it("counts parallel guesses before it hashes them", async () => {
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => unlock(`guess-${i}`, { ip: "203.0.113.50" })));
    const refused = replies.filter((r) => r.status === 429).length;
    expect(replies.filter((r) => r.status === 401).length).toBeLessThanOrEqual(links.PASSWORD_TRIES_PER_VISITOR);
    expect(refused).toBeGreaterThanOrEqual(12 - links.PASSWORD_TRIES_PER_VISITOR);
  });
});

describe("the unlock belongs to one link and one password", () => {
  it("a changed password drops everyone who had typed the old one, and the old one stops working", async () => {
    const cookie = unlockCookie(await unlock(PASSWORD));
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(200);

    writeLinks([link({ password: record(NEW_PASSWORD) })]);
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(401);
    expect((await unlock(PASSWORD)).status).toBe(401);
    const fresh = await unlock(NEW_PASSWORD);
    expect(fresh.status).toBe(303);
    expect((await ask(`/apps/${APP}/`, { unlock: unlockCookie(fresh) })).status).toBe(200);
  });

  it("setting the same password again still drops the earlier unlocks", async () => {
    const cookie = unlockCookie(await unlock(PASSWORD));
    writeLinks([link({ password: record(PASSWORD) })]);
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(401);
  });

  it("a removed password opens the link again, on the same token", async () => {
    expect((await ask(`/apps/${APP}/`)).status).toBe(401);
    writeLinks([link({ password: undefined })]);
    const res = await ask(`/apps/${APP}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`app:GET:/apps/${APP}/`);
  });

  it("a password added to an open link closes it on the next request", async () => {
    writeLinks([link({ password: undefined })]);
    expect((await ask(`/apps/${APP}/`)).status).toBe(200);
    writeLinks([link()]);
    expect((await ask(`/apps/${APP}/`)).status).toBe(401);
  });

  it("an unlock from another link is worth nothing here, even with the same password", async () => {
    const other = "fedcba9876543210";
    const otherToken = "B".repeat(43);
    fs.mkdirSync(path.join(root, "data", "webapps", "other"), { recursive: true });
    writeLinks([link(), link({ id: other, appId: "other", token: otherToken, password: record(PASSWORD) })]);
    const server = links.createLinkServer(other, { root, resolveApp: () => ({ id: "other", port: appPort, strip: false }) });
    const port = await listen(server);
    try {
      const form = new URLSearchParams({ next: "/apps/other/", password: PASSWORD }).toString();
      const res = await ask(links.UNLOCK_PATH, { port, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${links.COOKIE_NAME}=${otherToken}` }, body: form });
      expect(res.status).toBe(303);
      expect((await ask(`/apps/${APP}/`, { unlock: unlockCookie(res) })).status).toBe(401);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  it("refuses forged, tampered and outlived unlock cookies", async () => {
    clock = 2_000_000_000_000;
    const cookie = unlockCookie(await unlock(PASSWORD));
    const [version, exp, mac] = cookie.split(".");
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(200);
    for (const forged of [`${version}.${Number(exp) + 1}.${mac}`, `${version}.${exp}.${"A".repeat(43)}`, `v2.${exp}.${mac}`, `${exp}.${mac}`, "v1", STORED.key, TOKEN, STORED.hash]) {
      expect((await ask(`/apps/${APP}/`, { unlock: forged })).status).toBe(401);
    }
    // The server, not the browser, decides how long an unlock lasts.
    clock += 12 * 60 * 60 * 1000 + 1000;
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(401);
  });
});

describe("disable and expiry win over a correct password", () => {
  it("a disabled link answers 410 to the right password and to an unlocked visitor", async () => {
    const cookie = unlockCookie(await unlock(PASSWORD));
    writeLinks([]);
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(410);
    const res = await unlock(PASSWORD);
    expect(res.status).toBe(410);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("an expired link answers 410 to the right password and to an unlocked visitor", async () => {
    clock = 1_000_000;
    writeLinks([link({ mode: "temporary", expiresAt: clock + 60_000 })]);
    const res = await unlock(PASSWORD);
    expect(res.status).toBe(303);
    // The unlock never outlives the link.
    expect(String(res.headers["set-cookie"])).toMatch(/Max-Age=60$/);
    const cookie = unlockCookie(res);
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(200);
    clock += 60_001;
    expect((await ask(`/apps/${APP}/`, { unlock: cookie })).status).toBe(410);
    expect((await unlock(PASSWORD)).status).toBe(410);
    expect(seen).toHaveLength(1);
  });

  it("an app that was removed answers 410, password or not", async () => {
    fs.rmSync(path.join(root, "data", "webapps", APP), { recursive: true });
    expect((await unlock(PASSWORD)).status).toBe(410);
  });
});

describe("what is stored", () => {
  it("keeps the setting across a restart: a new listener asks for the same password", async () => {
    const before = unlockCookie(await unlock(PASSWORD));
    const server = serve();
    const port = await listen(server);
    try {
      expect((await ask(`/apps/${APP}/`, { port })).status).toBe(401);
      expect((await unlock("wrong", { port })).status).toBe(401);
      expect((await unlock(PASSWORD, { port })).status).toBe(303);
      // Signed with the stored key, not with anything the old process held.
      expect((await ask(`/apps/${APP}/`, { port, unlock: before })).status).toBe(200);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  it("never serves a link whose password record is damaged as an open one", async () => {
    for (const password of [{}, { hash: STORED.hash }, { hash: "plain", key: STORED.key }, { hash: STORED.hash.replace("scrypt$16384", "scrypt$2"), key: STORED.key }, { hash: STORED.hash.replace("scrypt$16384", "scrypt$16385"), key: STORED.key }, { hash: STORED.hash, key: "short" }, "hunter2", 1, []]) {
      expect(links.validLink(link({ password }))).toBeNull();
      writeLinks([link({ password })]);
      expect((await ask(`/apps/${APP}/`)).status).toBe(410);
    }
    expect(links.validLink(link({ password: null }))?.password).toBeNull();
    expect(links.validLink(link())?.password).toEqual({ hash: STORED.hash, key: STORED.key });
    expect(seen).toHaveLength(0);
  });

  it("verifies against the salted hash only, in constant time for equal lengths", async () => {
    expect(await links.verifyPasswordHash(PASSWORD, STORED.hash)).toBe(true);
    expect(await links.verifyPasswordHash(`${PASSWORD} `, STORED.hash)).toBe(false);
    expect(await links.verifyPasswordHash(PASSWORD, record(PASSWORD).hash)).toBe(true);
    expect(await links.verifyPasswordHash(PASSWORD, "not a hash")).toBe(false);
    expect(STORED.hash).not.toContain(PASSWORD);
    // Two records of one password share nothing.
    expect(record(PASSWORD).hash).not.toBe(STORED.hash);
  });

  it("writes nothing about password attempts to disk", async () => {
    await unlock("a wrong guess");
    await unlock(PASSWORD);
    const files = fs.readdirSync(links.linkPaths(root).dir).map((f) => fs.readFileSync(path.join(links.linkPaths(root).dir, f), "utf-8")).join("\n");
    expect(files).not.toContain("a wrong guess");
    expect(files).not.toContain(PASSWORD);
  });
});

describe("a link without a password is what it was", () => {
  beforeEach(() => {
    writeLinks([link({ password: undefined })]);
  });

  it("serves the app on the token alone and never shows a password page", async () => {
    const res = await ask(`/apps/${APP}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`app:GET:/apps/${APP}/`);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("has no unlock address: it is one more path outside the app", async () => {
    expect((await unlock("anything")).status).toBe(404);
    expect((await ask(links.UNLOCK_PATH)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("still keeps an unlock cookie a visitor carries away from the app", async () => {
    const res = await ask(`/apps/${APP}/`, { unlock: "v1.9999999999.whatever" });
    expect(res.status).toBe(200);
    expect(seen[0].headers.cookie).toBeUndefined();
  });
});
