"use strict";
/**
 * Public app links (TASK-1478): one desktop app, published to the internet on
 * a hostname of its own, revocable, and unable to reach anything else on the
 * box.
 *
 * THE SHAPE
 *
 * Every link gets
 *   - its own HTTP listener on 127.0.0.1:<ephemeral> — this module's handler
 *     and nothing else. It never hands a request to Next.js, the gateway or
 *     any other route of the box: it can answer exactly one app, or refuse;
 *   - its own `cloudflared` quick tunnel pointing at that listener only, so
 *     the link's origin (`https://<random>.trycloudflare.com`) is a hostname
 *     that has never served the desktop and holds no ClawBox cookie. Two
 *     published apps never share an origin either.
 *
 * The owner's routes (src/app/setup-api/apps/public-link, src/lib/
 * public-app-links.ts) write data/public-links/links.json; this module only
 * READS it — on every request (mtime-cached), which is what makes disabling a
 * link take effect on the very next request, and every second to start or
 * stop tunnels. What it learns (each tunnel's URL) goes to runtime.json,
 * which only this module writes.
 *
 * WHAT A REQUEST MUST PASS, in order — anything else is refused:
 *   1. the link still exists and has not expired (410 otherwise);
 *   2. it arrived over HTTPS (cloudflared's X-Forwarded-Proto);
 *   3. the per-visitor and per-link rate limits;
 *   4. a canonical path: no `..`, `.`, empty segments, backslashes, `;`, NUL
 *      or encoded slashes/dots;
 *   5. the link's secret — `?k=<token>` once (exchanged for a host-only,
 *      Secure, HttpOnly cookie on the link's own origin, then redirected
 *      away so the token leaves the address bar), the cookie afterwards;
 *   6. the link's password, when the owner set one (TASK-1515): until the
 *      visitor has typed it, every request is answered by a small password
 *      page this listener writes itself — never by the app, its files or its
 *      allow-listed API paths;
 *   7. the app's own path (`/apps/<id>/…` for a server app);
 *   8. the method policy: GET/HEAD of anything but the app's `/api` tree by
 *      default; `/api`, and any write, only under a prefix the owner
 *      allow-listed for this link. WebSocket upgrades are refused.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { APP_ID_RE, isProxyablePort, readJsonSync, resolveRegisteredApp } = require("./app-port.js");

const LINK_ID_RE = /^[a-f0-9]{16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const API_ALLOW_RE = /^\/[A-Za-z0-9._~\-/]{0,200}$/;
const COOKIE_NAME = "__Host-cbshare";
const TOKEN_PARAM = "k";
/** The cookie a visitor holds after typing the link's password (TASK-1515). */
const UNLOCK_COOKIE_NAME = "__Host-cbshare-pw";
/** Where the password page posts. A dot segment: no app file or route is ever served from one. */
const UNLOCK_PATH = "/.link/unlock";
const UNLOCK_MAX_AGE_S = 12 * 60 * 60;
const UNLOCK_BODY_MAX = 4096;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_HASH_RE = /^scrypt\$(\d{4,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22,64})\$([A-Za-z0-9_-]{43,86})$/;
const UNLOCK_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** Password attempts, right or wrong, in one window: per visitor of a link, and per link. */
const PASSWORD_WINDOW_MS = 15 * 60_000;
const PASSWORD_TRIES_PER_VISITOR = 5;
const PASSWORD_TRIES_PER_LINK = 20;
/** Hashes waiting behind the one that is running; more than this and the answer is 429. */
const PASSWORD_QUEUE_MAX = 4;
const MAX_URL_LENGTH = 4096;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const HEADERS_TIMEOUT_MS = 120_000;
const RATE_WINDOW_MS = 60_000;
const RATE_PER_VISITOR = 300;
const RATE_PER_LINK = 3000;
const BAD_TOKEN_PER_VISITOR = 10;
const RATE_MAP_MAX = 10_000;
/** How long a disabled or expired link's address keeps answering 410 before its tunnel stops. */
const GONE_GRACE_MS = 10 * 60_000;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "proxy-connection"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
/** Files of a one-file webapp's folder that are the box's, not the app's. */
const STATIC_DENY = new Set(["meta.json"]);

// ── Where things are ─────────────────────────────────────────────────────────

function linkPaths(root) {
  const dir = path.join(root, "data", "public-links");
  return {
    dir,
    links: path.join(dir, "links.json"),
    runtime: path.join(dir, "runtime.json"),
    audit: path.join(dir, "audit.log"),
    emptyConfig: path.join(dir, "cloudflared-empty.yml"),
  };
}

// ── The owner's list, read-only here ─────────────────────────────────────────

function validApiAllow(list) {
  if (!Array.isArray(list) || list.length > 16) return null;
  const out = [];
  for (const p of list) {
    if (typeof p !== "string" || !API_ALLOW_RE.test(p)) return null;
    if (p.split("/").some((seg) => seg === ".." || seg === ".")) return null;
    out.push(p);
  }
  return out;
}

/** A stored link, validated field by field; null for anything malformed (which is then simply not served). */
function validLink(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { id, appId, mode, token, createdAt, expiresAt } = raw;
  if (typeof id !== "string" || !LINK_ID_RE.test(id)) return null;
  if (typeof appId !== "string" || !APP_ID_RE.test(appId)) return null;
  if (mode !== "temporary" && mode !== "permanent") return null;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (mode === "temporary" && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) return null;
  if (mode === "permanent" && expiresAt !== null && expiresAt !== undefined) return null;
  const apiAllow = validApiAllow(raw.apiAllow ?? []);
  if (!apiAllow) return null;
  // A password record that cannot be used makes the whole link unusable: a
  // link the owner protected is never served as an open one.
  let password = null;
  if (raw.password !== undefined && raw.password !== null) {
    password = validPassword(raw.password);
    if (!password) return null;
  }
  return { id, appId, mode, token, createdAt, expiresAt: mode === "temporary" ? expiresAt : null, apiAllow, password };
}

/** `scrypt$N$r$p$salt$key` (base64url salt and key) taken apart, or null. */
function parsePasswordHash(hash) {
  const m = typeof hash === "string" ? PASSWORD_HASH_RE.exec(hash) : null;
  if (!m) return null;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // Bounds on what a file may ask this process to compute: N a power of two
  // up to 2^17, and at most 256 MB of work memory.
  if (N < 16384 || N > 131072 || (N & (N - 1)) !== 0 || r < 8 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(m[4], "base64url");
  const key = Buffer.from(m[5], "base64url");
  if (salt.length < 16 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

/** The stored password of a link: its slow hash and the key its unlock cookies are signed with. */
function validPassword(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { hash, key } = raw;
  if (!parsePasswordHash(hash)) return null;
  if (typeof key !== "string" || !UNLOCK_KEY_RE.test(key)) return null;
  return { hash, key };
}

const linkCache = new Map();

/** Every valid link in links.json — re-read whenever the file changes (one stat per call otherwise). */
function readLinks(root) {
  const file = linkPaths(root).links;
  // One descriptor for both the signature and the read, so what is parsed is
  // exactly what was stat-ed.
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    linkCache.set(file, { sig: "missing", links: [] });
    return [];
  }
  try {
    const st = fs.fstatSync(fd);
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const cached = linkCache.get(file);
    if (cached && cached.sig === sig) return cached.links;
    let links = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(fd, "utf-8"));
      const list = parsed && Array.isArray(parsed.links) ? parsed.links : [];
      links = list.map(validLink).filter(Boolean);
    } catch {
      // An unreadable list serves nothing: fail closed.
      links = [];
    }
    linkCache.set(file, { sig, links });
    return links;
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function isExpired(link, now) {
  return link.mode === "temporary" && link.expiresAt <= now;
}

/** Is the app's desktop folder still there? A link to a removed app is never served. */
function appPresent(root, appId) {
  try {
    return fs.statSync(path.join(root, "data", "webapps", appId)).isDirectory();
  } catch {
    return false;
  }
}

/** The link with this id while it may still be served, else null. */
function liveLink(root, id, now = Date.now()) {
  const link = readLinks(root).find((l) => l.id === id);
  if (!link || isExpired(link, now) || !appPresent(root, link.appId)) return null;
  return link;
}

// ── Audit trail ──────────────────────────────────────────────────────────────

/** One JSON line per event. Never the token — the link id and the app name the link. */
function audit(root, event, fields) {
  try {
    const { dir, audit: file } = linkPaths(root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
  } catch {
    // The audit line is a record, not a gate.
  }
}

// ── Request policy (pure, for the tests) ─────────────────────────────────────

/**
 * The request target split into a canonical path and its query, or null when
 * the path is anything but canonical. Refusing (rather than normalising) is
 * the point: whatever the app's router would make of `a/../b`, `a//b`,
 * `%2e%2e` or `a;b`, the policy below never has to guess.
 */
function canonicalTarget(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.length > MAX_URL_LENGTH) return null;
  const q = rawUrl.indexOf("?");
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const search = q === -1 ? "" : rawUrl.slice(q);
  if (/[\\;\0#]/.test(rawPath)) return null;
  if (/%(2f|5c|2e|00|3b|23|3f)/i.test(rawPath)) return null;
  // Percent-encoded unreserved characters (`%61pi` for `api`) would let the
  // path policy see one route while the app routes another: refuse them.
  if (/%(3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]|2d|5f|7e)/i.test(rawPath)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (/[\\\0]/.test(decoded)) return null;
  const segments = rawPath.split("/").slice(1);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === "." || seg === "..") return null;
    // An empty segment only as the final one (a trailing slash).
    if (seg === "" && i !== segments.length - 1) return null;
  }
  return { path: rawPath, search };
}

/** Is `rest` (the path below the app's base, `/…`) under the allow-listed prefix `prefix`? */
function underPrefix(rest, prefix) {
  if (prefix === "/") return true;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return rest === p || rest.startsWith(`${p}/`);
}

function isApiPath(rest) {
  const lower = rest.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/");
}

/**
 * May `method` reach `rest` (the path below the app's base) on this link?
 * GET/HEAD of the app's pages and assets by default; its `/api` tree and every
 * write only under a prefix the owner allow-listed. Never OPTIONS, CONNECT or
 * TRACE: there is no cross-origin caller this link answers.
 */
function methodAllowed(link, method, rest) {
  const allowed = link.apiAllow.some((prefix) => underPrefix(rest, prefix));
  if (method === "GET" || method === "HEAD") return allowed || !isApiPath(rest);
  if (WRITE_METHODS.has(method)) return allowed;
  return false;
}

function timingSafeTokenEqual(given, expected) {
  if (typeof given !== "string") return false;
  // Byte lengths, not string lengths: timingSafeEqual throws on a mismatch,
  // and a multibyte character makes the two differ.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The request's Cookie header with the link's own cookie (and any ClawBox session a client invents) taken out. */
function isLinkCookie(name) {
  return name === COOKIE_NAME || name === UNLOCK_COOKIE_NAME || name === "clawbox_session";
}

function appCookies(header) {
  if (!header) return null;
  const kept = String(header).split(";").map((p) => p.trim()).filter((p) => {
    const name = p.split("=")[0].trim();
    return p && !isLinkCookie(name);
  });
  return kept.length ? kept.join("; ") : null;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

function createLimiter(now = () => Date.now()) {
  const buckets = new Map();
  function hit(key, max, windowMs = RATE_WINDOW_MS) {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start >= b.windowMs) {
      // Full: the short-lived request counters go first. A password lock-out
      // is only dropped when those alone do not make room.
      if (buckets.size >= RATE_MAP_MAX) {
        for (const [k, old] of buckets) if (old.windowMs <= RATE_WINDOW_MS) buckets.delete(k);
        if (buckets.size >= RATE_MAP_MAX) buckets.clear();
      }
      b = { start: t, count: 0, windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= max;
  }
  function count(key) {
    const b = buckets.get(key);
    return b && now() - b.start < b.windowMs ? b.count : 0;
  }
  /** Take one hit back (a password attempt that turned out right). */
  function refund(key) {
    const b = buckets.get(key);
    if (b && b.count > 0) b.count -= 1;
  }
  return { hit, count, refund };
}

// ── The link's password (TASK-1515) ──────────────────────────────────────────

/** Does `password` hash to the stored `hash`? Slow on purpose; the comparison is constant-time. */
function verifyPasswordHash(password, hash) {
  return new Promise((resolve) => {
    const parsed = parsePasswordHash(hash);
    if (!parsed || typeof password !== "string") return resolve(false);
    const { N, r, p, salt, key } = parsed;
    crypto.scrypt(password.normalize("NFC"), salt, key.length, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, derived) => {
      if (err || !derived || derived.length !== key.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derived, key));
    });
    return undefined;
  });
}

function unlockMac(link, exp) {
  return crypto.createHmac("sha256", Buffer.from(link.password.key, "base64url")).update(`unlock.v1.${link.id}.${exp}`).digest("base64url");
}

/**
 * The unlock cookie: `v1.<expiry, seconds>.<HMAC>`, signed with a key that
 * belongs to this link's CURRENT password. A new password is a new key, so
 * every cookie issued before the change stops verifying; a cookie of another
 * link never verifies here (different key, and the link id is in the MAC).
 */
function unlockCookieValue(link, nowMs) {
  let exp = Math.floor(nowMs / 1000) + UNLOCK_MAX_AGE_S;
  if (link.mode === "temporary") exp = Math.min(exp, Math.ceil(link.expiresAt / 1000));
  return { value: `v1.${exp}.${unlockMac(link, exp)}`, maxAge: Math.max(1, exp - Math.floor(nowMs / 1000)) };
}

function unlocked(link, cookie, nowMs) {
  if (!link.password || typeof cookie !== "string") return false;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{1,12}$/.test(parts[1])) return false;
  const exp = Number(parts[1]);
  if (exp * 1000 <= nowMs) return false;
  return timingSafeTokenEqual(parts[2], unlockMac(link, exp));
}

/** The password page's words. The visitor's browser language picks one; English otherwise. */
const PASSWORD_PAGE_TEXT = {
  en: ["Password required", "This page is protected. Enter the password to continue.", "Password", "Continue", "Wrong password. Try again.", "Too many attempts. Try again later."],
  bg: ["Нужна е парола", "Тази страница е защитена. Въведете паролата, за да продължите.", "Парола", "Продължи", "Грешна парола. Опитайте отново.", "Твърде много опити. Опитайте по-късно."],
  de: ["Passwort erforderlich", "Diese Seite ist geschützt. Geben Sie das Passwort ein, um fortzufahren.", "Passwort", "Weiter", "Falsches Passwort. Versuchen Sie es erneut.", "Zu viele Versuche. Versuchen Sie es später erneut."],
  es: ["Se requiere contraseña", "Esta página está protegida. Introduce la contraseña para continuar.", "Contraseña", "Continuar", "Contraseña incorrecta. Inténtalo de nuevo.", "Demasiados intentos. Inténtalo más tarde."],
  fr: ["Mot de passe requis", "Cette page est protégée. Saisissez le mot de passe pour continuer.", "Mot de passe", "Continuer", "Mot de passe incorrect. Réessayez.", "Trop de tentatives. Réessayez plus tard."],
  it: ["Password richiesta", "Questa pagina è protetta. Inserisci la password per continuare.", "Password", "Continua", "Password errata. Riprova.", "Troppi tentativi. Riprova più tardi."],
  ja: ["パスワードが必要です", "このページは保護されています。続行するにはパスワードを入力してください。", "パスワード", "続行", "パスワードが違います。もう一度お試しください。", "試行回数が多すぎます。しばらくしてからお試しください。"],
  nl: ["Wachtwoord vereist", "Deze pagina is beveiligd. Voer het wachtwoord in om door te gaan.", "Wachtwoord", "Doorgaan", "Onjuist wachtwoord. Probeer het opnieuw.", "Te veel pogingen. Probeer het later opnieuw."],
  sv: ["Lösenord krävs", "Den här sidan är skyddad. Ange lösenordet för att fortsätta.", "Lösenord", "Fortsätt", "Fel lösenord. Försök igen.", "För många försök. Försök igen senare."],
  zh: ["需要密码", "此页面受保护。请输入密码以继续。", "密码", "继续", "密码错误，请重试。", "尝试次数过多，请稍后再试。"],
};

function pageLanguage(header) {
  for (const part of String(header || "").split(",")) {
    const tag = part.split(";")[0].trim().slice(0, 2).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PASSWORD_PAGE_TEXT, tag)) return tag;
  }
  return "en";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The password page. Written here, whole: no asset, script, font or name of
 * the box or of the app, so a visitor without the password learns only that
 * there is one. `problem` is "wrong", "locked" or nothing.
 */
function passwordPage(lang, next, problem) {
  const [title, intro, label, button, wrong, locked] = PASSWORD_PAGE_TEXT[lang] || PASSWORD_PAGE_TEXT.en;
  const note = problem === "wrong" ? wrong : problem === "locked" ? locked : "";
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title>
<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{width:min(22rem,100% - 3rem)}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1rem}label{display:block;font-size:.875rem;margin-bottom:.25rem}input,button{font:inherit;box-sizing:border-box;width:100%;padding:.6rem .7rem;border-radius:.5rem;border:1px solid GrayText}button{margin-top:.75rem;cursor:pointer;font-weight:600}.e{color:#c62828;font-size:.875rem}@media (prefers-color-scheme:dark){.e{color:#ff8a80}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>${note ? `<p class="e" role="alert">${escapeHtml(note)}</p>` : ""}
<form method="post" action="${UNLOCK_PATH}"><input type="hidden" name="next" value="${escapeHtml(next)}"><label for="p">${escapeHtml(label)}</label><input id="p" name="password" type="password" autocomplete="off" maxlength="${PASSWORD_MAX_LENGTH}" required autofocus${problem === "locked" ? " disabled" : ""}><button type="submit"${problem === "locked" ? " disabled" : ""}>${escapeHtml(button)}</button></form></main></body></html>
`;
}

const PASSWORD_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function sendPasswordPage(req, res, status, next, problem, extra = {}) {
  const body = Buffer.from(passwordPage(pageLanguage(req.headers["accept-language"]), next, problem), "utf-8");
  // `connection: close` for the same reason as refuse(): what the visitor sent is not read.
  res.writeHead(status, { ...PASSWORD_PAGE_HEADERS, "content-length": String(body.length), connection: "close", ...SECURITY_HEADERS, ...extra });
  res.end(String(req.method).toUpperCase() === "HEAD" ? undefined : body);
}

/** The request body as text, or null when it is larger than `max` bytes or the connection fails. */
function readSmallBody(req, max) {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] || 0) > max) return resolve(null);
    const chunks = [];
    let seen = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    req.on("data", (chunk) => {
      seen += chunk.length;
      if (seen > max) return finish(null);
      chunks.push(chunk);
      return undefined;
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => finish(null));
    req.on("close", () => finish(null));
    return undefined;
  });
}

/** Where to send the visitor after the password: a canonical path on this origin, or the top. */
function safeNext(raw) {
  const target = typeof raw === "string" ? canonicalTarget(raw) : null;
  if (!target || target.path.startsWith(UNLOCK_PATH)) return "/";
  return `${target.path}${target.search}`;
}

// ── The handler ──────────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

function refuse(res, status, text, extra = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // `connection: close`: a refused request's body is never read, so the
  // connection is not reused for the next one.
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "close", ...SECURITY_HEADERS, ...extra });
  res.end(`${text}\n`);
}

function clientAddress(req) {
  const cf = req.headers["cf-connecting-ip"];
  return (typeof cf === "string" && cf.trim()) || req.socket.remoteAddress || "unknown";
}

/**
 * The request handler for ONE link. `opts.root` is the ClawBox root;
 * `opts.resolveApp(root, id)` and `opts.requireHttps` are seams for the tests.
 */
function createLinkHandler(linkId, opts) {
  const root = opts.root;
  const resolveApp = opts.resolveApp || resolveRegisteredApp;
  const requireHttps = opts.requireHttps !== false;
  const now = opts.now || (() => Date.now());
  const limiter = opts.limiter || createLimiter(now);
  // One password hash at a time per link: each costs tens of megabytes and a
  // noticeable slice of a core, and a visitor must not be able to stack them.
  let hashQueue = Promise.resolve();
  let hashWaiting = 0;

  /**
   * A password typed into the password page. The attempt is counted BEFORE
   * the hash runs (so parallel guesses cannot outrun the limit) and taken back
   * only when it was right. The link is read again after the hash: one that
   * was disabled, expired or given another password in the meantime is not
   * unlocked by an answer to the old one.
   */
  async function unlockAttempt(req, res, link, visitor) {
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") return refuse(res, 403, "Forbidden.");
    if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers["content-type"] || ""))) return refuse(res, 415, "Unsupported media type.");
    const body = await readSmallBody(req, UNLOCK_BODY_MAX);
    if (body === null) return refuse(res, 413, "Request too large.");
    const form = new URLSearchParams(body);
    const next = safeNext(form.get("next"));
    const password = form.get("password") || "";

    const visitorKey = `pw:${link.id}:${visitor}`;
    const linkKey = `pwl:${link.id}`;
    if (limiter.count(visitorKey) >= PASSWORD_TRIES_PER_VISITOR || limiter.count(linkKey) >= PASSWORD_TRIES_PER_LINK || hashWaiting >= PASSWORD_QUEUE_MAX) {
      return sendPasswordPage(req, res, 429, next, "locked", { "retry-after": String(PASSWORD_WINDOW_MS / 1000) });
    }
    limiter.hit(visitorKey, Infinity, PASSWORD_WINDOW_MS);
    limiter.hit(linkKey, Infinity, PASSWORD_WINDOW_MS);

    let ok = false;
    if (password.length > 0 && password.length <= PASSWORD_MAX_LENGTH) {
      hashWaiting += 1;
      const turn = hashQueue.then(() => verifyPasswordHash(password, link.password.hash));
      hashQueue = turn.catch(() => false);
      try {
        ok = await turn;
      } catch {
        ok = false;
      } finally {
        hashWaiting -= 1;
      }
    }
    const current = liveLink(root, linkId, now());
    if (!current) return refuse(res, 410, "This public link has been disabled or has expired.");
    if (!ok || !current.password || current.password.hash !== link.password.hash || current.password.key !== link.password.key) {
      return sendPasswordPage(req, res, 401, next, "wrong");
    }
    limiter.refund(visitorKey);
    limiter.refund(linkKey);
    const cookie = unlockCookieValue(current, now());
    res.writeHead(303, {
      location: next,
      "set-cookie": `${UNLOCK_COOKIE_NAME}=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookie.maxAge}`,
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    });
    return res.end();
  }

  return function handle(req, res) {
    const link = liveLink(root, linkId, now());
    if (!link) return refuse(res, 410, "This public link has been disabled or has expired.");

    if (requireHttps && String(req.headers["x-forwarded-proto"] || "").toLowerCase() !== "https") {
      return refuse(res, 403, "HTTPS only.");
    }

    const visitor = clientAddress(req);
    if (limiter.count(`bad:${link.id}:${visitor}`) >= BAD_TOKEN_PER_VISITOR) {
      return refuse(res, 429, "Too many requests.", { "retry-after": "60" });
    }
    if (!limiter.hit(`v:${link.id}:${visitor}`, RATE_PER_VISITOR) || !limiter.hit(`l:${link.id}`, RATE_PER_LINK)) {
      return refuse(res, 429, "Too many requests.", { "retry-after": "60" });
    }

    const target = canonicalTarget(req.url);
    if (!target) return refuse(res, 400, "Bad request.");
    const method = String(req.method || "GET").toUpperCase();

    // The secret. In the query once, as a cookie afterwards.
    const params = new URLSearchParams(target.search);
    const offered = params.get(TOKEN_PARAM);
    if (offered !== null) {
      if (!timingSafeTokenEqual(offered, link.token)) {
        limiter.hit(`bad:${link.id}:${visitor}`, Infinity);
        return refuse(res, 404, "Not found.");
      }
      if (method !== "GET" && method !== "HEAD") return refuse(res, 405, "Method not allowed.");
      params.delete(TOKEN_PARAM);
      const rest = params.toString();
      const maxAge = link.mode === "temporary" ? Math.max(1, Math.floor((link.expiresAt - now()) / 1000)) : 60 * 60 * 24 * 365;
      res.writeHead(303, {
        location: `${target.path}${rest ? `?${rest}` : ""}`,
        "set-cookie": `${COOKIE_NAME}=${link.token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
      });
      return res.end();
    }
    if (!timingSafeTokenEqual(cookieValue(req.headers.cookie, COOKIE_NAME), link.token)) {
      limiter.hit(`bad:${link.id}:${visitor}`, Infinity);
      return refuse(res, 404, "Not found.");
    }

    // The password, when the owner set one: in front of everything below —
    // the app's pages, its files and its allow-listed API paths alike.
    if (link.password && !unlocked(link, cookieValue(req.headers.cookie, UNLOCK_COOKIE_NAME), now())) {
      if (target.path === UNLOCK_PATH) {
        if (method !== "POST") return refuse(res, 405, "Method not allowed.");
        unlockAttempt(req, res, link, visitor).catch(() => refuse(res, 500, "Something went wrong."));
        return undefined;
      }
      if (method !== "GET" && method !== "HEAD") return refuse(res, 401, "Password required.");
      const locked = limiter.count(`pw:${link.id}:${visitor}`) >= PASSWORD_TRIES_PER_VISITOR || limiter.count(`pwl:${link.id}`) >= PASSWORD_TRIES_PER_LINK;
      return sendPasswordPage(req, res, 401, safeNext(`${target.path}${target.search}`), locked ? "locked" : undefined);
    }
    // Already unlocked (a second tab, the back button): the form's address
    // leads back into the app rather than to a 404.
    if (link.password && target.path === UNLOCK_PATH) {
      res.writeHead(303, { location: "/", "cache-control": "no-store", ...SECURITY_HEADERS });
      return res.end();
    }

    const app = resolveApp(root, link.appId);
    if (app) return proxyToApp(req, res, link, app, target, method);
    // A server app whose server is not (or not verifiably) its own right now
    // is unavailable — never its one-file stub, which only redirects.
    const meta = readJsonSync(path.join(root, "data", "webapps", link.appId, "meta.json"));
    if (meta && isProxyablePort(meta.port)) return refuse(res, 502, "The app is not running right now.");
    return serveStatic(root, res, link, target, method);
  };
}

/** A server app (`/apps/<id>/` on the desktop): forwarded to its own port, its own base path only. */
function proxyToApp(req, res, link, app, target, method) {
  const base = `/apps/${link.appId}`;
  if (target.path === "/" || target.path === base) {
    res.writeHead(302, { location: `${base}/`, "cache-control": "no-store", ...SECURITY_HEADERS });
    return res.end();
  }
  if (!target.path.startsWith(`${base}/`)) return refuse(res, 404, "Not found.");
  const rest = target.path.slice(base.length);
  if (!methodAllowed(link, method, rest)) return refuse(res, 403, "Not available on a public link.");

  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) return refuse(res, 413, "Request too large.");

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || key === "cookie" || key.startsWith("cf-") || key.startsWith("x-forwarded-") || key === "forwarded" || key === "cdn-loop") continue;
    headers[key] = value;
  }
  const cookies = appCookies(req.headers.cookie);
  if (cookies) headers.cookie = cookies;
  headers.host = `127.0.0.1:${app.port}`;
  headers["accept-encoding"] = "identity";
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-prefix"] = base;
  headers["x-forwarded-for"] = clientAddress(req);
  if (req.headers.host) headers["x-forwarded-host"] = String(req.headers.host);
  headers["x-clawbox-public-link"] = "1";

  // The token never travels upstream: it was exchanged for the cookie, and the
  // cookie was taken out above.
  const upstreamPath = app.strip ? (rest || "/") : target.path;
  const upstream = http.request({
    host: "127.0.0.1",
    port: app.port,
    method,
    path: `${upstreamPath}${target.search}`,
    headers,
    timeout: HEADERS_TIMEOUT_MS,
  });
  upstream.on("timeout", () => upstream.destroy(new Error("headers timeout")));
  upstream.on("error", () => refuse(res, 502, "The app is not answering right now."));
  upstream.on("response", (up) => {
    upstream.setTimeout(0);
    const out = {};
    for (const [key, value] of Object.entries(up.headers)) {
      if (HOP_BY_HOP.has(key)) continue;
      if (key === "set-cookie") {
        const kept = (Array.isArray(value) ? value : [value]).filter((c) => {
          const name = String(c).split("=")[0].trim();
          return !isLinkCookie(name);
        });
        if (kept.length) out[key] = kept;
        continue;
      }
      if (key === "location") {
        out[key] = rewriteLocation(String(value), app.port);
        continue;
      }
      out[key] = value;
    }
    Object.assign(out, SECURITY_HEADERS);
    res.writeHead(up.statusCode || 502, out);
    if (method === "HEAD") {
      up.resume();
      res.end();
      return;
    }
    up.pipe(res);
  });
  res.on("close", () => upstream.destroy());

  if (method === "GET" || method === "HEAD") {
    upstream.end();
    return undefined;
  }
  let seen = 0;
  req.on("data", (chunk) => {
    seen += chunk.length;
    if (seen > MAX_BODY_BYTES) {
      upstream.destroy();
      refuse(res, 413, "Request too large.");
      req.destroy();
      return;
    }
    upstream.write(chunk);
  });
  req.on("end", () => upstream.end());
  req.on("error", () => upstream.destroy());
  return undefined;
}

/** An upstream redirect that names the app's loopback address must not leak it: keep the path only. */
function rewriteLocation(location, port) {
  try {
    const u = new URL(location);
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && String(u.port) === String(port)) {
      return `${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    // Relative: already the app's own.
  }
  return location;
}

/** A one-file webapp (data/webapps/<id>/): its own files, read-only, nothing else. */
function serveStatic(clawboxRoot, res, link, target, method) {
  if (method !== "GET" && method !== "HEAD") return refuse(res, 405, "Method not allowed.");
  const root = path.join(clawboxRoot, "data", "webapps", link.appId);
  let rel;
  try {
    rel = decodeURIComponent(target.path).replace(/^\/+/, "");
  } catch {
    return refuse(res, 400, "Bad request.");
  }
  if (rel === "") rel = "index.html";
  if (rel.endsWith("/")) return refuse(res, 404, "Not found.");
  const segments = rel.split("/");
  if (segments.some((seg) => seg.startsWith("."))) return refuse(res, 404, "Not found.");
  if (STATIC_DENY.has(rel)) return refuse(res, 404, "Not found.");
  const type = STATIC_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return refuse(res, 404, "Not found.");
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.join(realRoot, ...segments));
  } catch {
    return refuse(res, 404, "Not found.");
  }
  const relative = path.relative(realRoot, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return refuse(res, 404, "Not found.");
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return refuse(res, 404, "Not found.");
  }
  if (!stat.isFile()) return refuse(res, 404, "Not found.");
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(stat.size),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    ...SECURITY_HEADERS,
  });
  if (method === "HEAD") return res.end();
  fs.createReadStream(real).on("error", () => res.destroy()).pipe(res);
  return undefined;
}

/** An HTTP server for one link, on loopback only. Upgrades (WebSockets) are refused. */
function createLinkServer(linkId, opts) {
  const server = http.createServer(createLinkHandler(linkId, opts));
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  return server;
}

// ── The supervisor: one listener + one tunnel per live link ──────────────────

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function writeRuntime(root, entries) {
  const { dir, runtime } = linkPaths(root);
  const body = {};
  for (const [id, e] of entries) if (e.goneAt === undefined) body[id] = { appId: e.link.appId, url: e.url, state: e.state, updatedAt: e.updatedAt };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${runtime}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, runtime);
  } catch (err) {
    console.warn(`[public-app-links] could not write runtime state: ${err && err.message}`);
  }
}

/**
 * Keep one listener and one quick tunnel per live link, and nothing for any
 * other. Runs inside production-server.js. Returns `{ reconcile, stop }`.
 */
function startPublicAppLinks(options = {}) {
  const root = options.root;
  const bin = options.cloudflaredBin || process.env.CLOUDFLARED_BIN || "/usr/local/bin/cloudflared";
  const pollMs = options.pollMs || 1000;
  const goneGraceMs = options.goneGraceMs ?? GONE_GRACE_MS;
  const spawnTunnel = options.spawnTunnel || ((port, configFile) => spawn(bin, ["tunnel", "--no-autoupdate", "--config", configFile, "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] }));
  const paths = linkPaths(root);
  const entries = new Map();
  let stopped = false;

  function touch(entry, state, url) {
    entry.state = state;
    if (url !== undefined) entry.url = url;
    entry.updatedAt = Date.now();
    writeRuntime(root, entries);
  }

  function launchTunnel(entry) {
    if (stopped || !entries.has(entry.link.id)) return;
    try {
      fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      // An empty config map, so no ~/.cloudflared/config.yml can add ingress
      // rules to this tunnel (the same isolation scripts/run-tunnel.sh uses).
      fs.writeFileSync(paths.emptyConfig, "{}\n", { mode: 0o600 });
    } catch {}
    let child;
    try {
      child = spawnTunnel(entry.port, paths.emptyConfig);
    } catch (err) {
      console.warn(`[public-app-links] cloudflared did not start: ${err && err.message}`);
      return scheduleRestart(entry);
    }
    entry.child = child;
    touch(entry, "starting", null);
    const onData = (buf) => {
      const m = QUICK_URL_RE.exec(String(buf));
      if (m && entry.child === child && !entry.url) {
        touch(entry, "live", m[0]);
        audit(root, "published", { link: entry.link.id, app: entry.link.appId, host: new URL(m[0]).hostname });
      }
    };
    if (child.stdout) child.stdout.on("data", onData);
    if (child.stderr) child.stderr.on("data", onData);
    // `error` (e.g. the binary is missing) and `exit` share one guarded path,
    // so a failed spawn is retried and a restart is never scheduled twice.
    const onGone = (err) => {
      if (entry.child !== child) return;
      entry.child = null;
      if (err) console.warn(`[public-app-links] cloudflared failed: ${err.message}`);
      if (!stopped && entries.has(entry.link.id)) {
        touch(entry, "restarting", null);
        scheduleRestart(entry);
      }
    };
    child.on("error", (err) => onGone(err));
    child.on("exit", () => onGone(null));
    return undefined;
  }

  function scheduleRestart(entry) {
    entry.failures = (entry.failures || 0) + 1;
    const delay = Math.min(60_000, 5_000 * entry.failures);
    clearTimeout(entry.restartTimer);
    entry.restartTimer = setTimeout(() => launchTunnel(entry), delay);
    if (entry.restartTimer.unref) entry.restartTimer.unref();
  }

  function startEntry(link) {
    const server = createLinkServer(link.id, { root, resolveApp: options.resolveApp, requireHttps: options.requireHttps });
    const entry = { link, server, port: null, child: null, url: null, state: "starting", updatedAt: Date.now(), failures: 0 };
    entries.set(link.id, entry);
    server.listen(0, "127.0.0.1", () => {
      entry.port = server.address().port;
      launchTunnel(entry);
    });
    server.on("error", (err) => console.warn(`[public-app-links] listener for ${link.id} failed: ${err && err.message}`));
  }

  function stopEntry(entry, reason) {
    entries.delete(entry.link.id);
    clearTimeout(entry.restartTimer);
    const child = entry.child;
    entry.child = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const t = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000);
      if (t.unref) t.unref();
    }
    try {
      entry.server.close();
      if (entry.server.closeAllConnections) entry.server.closeAllConnections();
    } catch {}
    audit(root, "tunnel_stopped", { link: entry.link.id, app: entry.link.appId, reason });

  }

  function reconcile() {
    if (stopped) return;
    const t = Date.now();
    const all = readLinks(root);
    const live = new Map(all.filter((l) => !isExpired(l, t) && appPresent(root, l.appId)).map((l) => [l.id, l]));
    let changed = false;
    for (const entry of [...entries.values()]) {
      if (live.has(entry.link.id)) continue;
      // A link that just went away keeps its address for a while, answering
      // nothing but 410 (the handler refuses it on the very next request), so
      // a visitor is told it was disabled or expired instead of meeting a dead
      // hostname. Then the listener and the tunnel go.
      if (entry.goneAt === undefined) {
        const stored = all.find((l) => l.id === entry.link.id);
        entry.goneAt = t;
        entry.goneReason = !stored ? "disabled" : isExpired(stored, t) ? "expired" : "app_missing";
        audit(root, entry.goneReason, { link: entry.link.id, app: entry.link.appId });
        changed = true;
      }
      if (t - entry.goneAt >= goneGraceMs) {
        stopEntry(entry, entry.goneReason);
        changed = true;
      }
    }
    for (const link of live.values()) {
      if (!entries.has(link.id)) {
        startEntry(link);
        changed = true;
      }
    }
    if (changed) writeRuntime(root, entries);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const entry of [...entries.values()]) {
      entries.delete(entry.link.id);
      clearTimeout(entry.restartTimer);
      if (entry.child && entry.child.exitCode === null) entry.child.kill("SIGTERM");
      try { entry.server.close(); if (entry.server.closeAllConnections) entry.server.closeAllConnections(); } catch {}
    }
  }

  // Whatever an earlier process recorded is stale: its tunnels died with it.
  writeRuntime(root, entries);
  reconcile();
  const timer = setInterval(reconcile, pollMs);
  if (timer.unref) timer.unref();
  return { reconcile, stop, entries };
}

module.exports = {
  COOKIE_NAME,
  UNLOCK_COOKIE_NAME,
  UNLOCK_PATH,
  PASSWORD_TRIES_PER_VISITOR,
  PASSWORD_TRIES_PER_LINK,
  PASSWORD_WINDOW_MS,
  verifyPasswordHash,
  TOKEN_PARAM,
  MAX_BODY_BYTES,
  BAD_TOKEN_PER_VISITOR,
  GONE_GRACE_MS,
  RATE_PER_VISITOR,
  linkPaths,
  validLink,
  readLinks,
  liveLink,
  canonicalTarget,
  methodAllowed,
  appCookies,
  rewriteLocation,
  createLimiter,
  createLinkHandler,
  createLinkServer,
  startPublicAppLinks,
};
