/**
 * Public app links (TASK-1478) — the owner's half.
 *
 * The owner publishes ONE desktop app to the internet from its icon's context
 * menu. This module keeps the list: data/public-links/links.json (0600),
 * written only here. The other half, scripts/public-app-links.js (inside
 * production-server.js), only READS it — every request is checked against it,
 * so removing a link here is the revocation, effective on the next request —
 * and runs one loopback listener plus one Cloudflare quick tunnel per live
 * link, reporting each tunnel's URL in runtime.json.
 *
 * The security model is documented there; what matters here:
 *   - the token is 32 random bytes (base64url) per link, and a new link is a
 *     new token: nothing is ever re-enabled;
 *   - expiry is a timestamp the serving side enforces on every request, not a
 *     timer that has to fire;
 *   - one link per app, at most MAX_LINKS at once (each is a tunnel process on
 *     an 8 GB board);
 *   - the app's `/api` tree and every write stay closed unless a prefix is in
 *     `apiAllow`. A new link lists `/api` itself unless the owner chose
 *     otherwise (`apiAccess`: an app that cannot reach its own
 *     API is a blank page for the visitor), and `apiReadOnly` keeps the
 *     listed prefixes to GET/HEAD. A new link is read-only unless the owner
 *     chose "read and write": a visitor can load the app's data but not
 *     change it;
 *   - a link may carry a password of its own (TASK-1515). Only its salted
 *     scrypt hash is stored, next to a random key the serving side signs
 *     unlock cookies with. Setting, changing or removing it never touches the
 *     link's id or token, so the address stays the same; a change makes a new
 *     key, so everyone who had typed the old password is asked again.
 */
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { APP_ID_RE, webappPath } from "@/lib/code-projects";
import { isReservedAppId } from "@/lib/webapp-registry";
import { createSerialLock } from "@/lib/serial-lock";
import { PASSWORD_CONTROL_CHAR_RE, verifyPassword } from "@/lib/auth";

export const MAX_LINKS = 5;
export const MIN_TTL_MINUTES = 1;
export const MAX_TTL_MINUTES = 30 * 24 * 60;
export const MAX_API_ALLOW = 16;
const API_ALLOW_RE = /^\/[A-Za-z0-9._~\-/]{0,200}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
/** scrypt cost of a link password: 32 MB and three passes per guess (an OWASP-listed setting). */
const SCRYPT = { N: 32768, r: 8, p: 3, keyLength: 32, saltLength: 16 } as const;

export type PublicLinkMode = "temporary" | "permanent";

/**
 * What visitors may do with the app's own `/api` tree: use it (`full`, the
 * default — a new link lists `/api`), read it (`read`: GET/HEAD only), or
 * nothing beyond the prefixes the owner typed (`none`).
 */
export type PublicLinkApiAccess = "full" | "read" | "none";
export const API_ACCESS_VALUES: readonly PublicLinkApiAccess[] = ["full", "read", "none"];
/** The prefix a new link opens by default: the app's own API, under its base path. */
export const DEFAULT_API_PREFIX = "/api";

export interface StoredPublicLink {
  id: string;
  appId: string;
  mode: PublicLinkMode;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  apiAllow: string[];
  /** When true the allow-listed prefixes answer GET/HEAD only; absent means writes are allowed under them. */
  apiReadOnly?: boolean;
  /** Present when visitors must type a password. Never the password itself. */
  password?: StoredLinkPassword | null;
}

export interface StoredLinkPassword {
  /** `scrypt$N$r$p$<salt>$<key>`, salt and key base64url. */
  hash: string;
  /** What the serving side signs unlock cookies with. New with every password. */
  key: string;
  setAt: number;
}

/** What the desktop is told about a link. */
export interface PublicLinkView {
  appId: string;
  mode: PublicLinkMode;
  createdAt: number;
  expiresAt: number | null;
  apiAllow: string[];
  apiReadOnly: boolean;
  /** Whether visitors are asked for a password. The password itself is not kept anywhere. */
  passwordProtected: boolean;
  /** `starting` until the tunnel has a hostname; `offline` when the serving side has no record of it. */
  state: "starting" | "live" | "restarting" | "offline";
  /** The full link to hand out — tunnel origin, the app's path and the token — once there is one. */
  url: string | null;
}

export class PublicLinkError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

function dir(): string {
  return path.join(DATA_DIR, "public-links");
}
function linksFile(): string {
  return path.join(dir(), "links.json");
}
function runtimeFile(): string {
  return path.join(dir(), "runtime.json");
}
function auditFile(): string {
  return path.join(dir(), "audit.log");
}

/** The `apiAllow` list as given, normalised — or a PublicLinkError naming the bad entry. */
export function parseApiAllow(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new PublicLinkError("apiAllow must be a list of paths.", 400, "bad_api_allow");
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") throw new PublicLinkError("apiAllow must be a list of paths.", 400, "bad_api_allow");
    const p = raw.trim();
    if (!p) continue;
    if (!API_ALLOW_RE.test(p) || p.split("/").some((seg) => seg === ".." || seg === ".")) {
      throw new PublicLinkError(`"${p.slice(0, 80)}" is not a path below the app, like /api/scores.`, 400, "bad_api_allow");
    }
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_API_ALLOW) throw new PublicLinkError(`At most ${MAX_API_ALLOW} API paths.`, 400, "bad_api_allow");
  return out;
}

/**
 * A stored link, or null. At least as lenient as the serving side's
 * validLink (a missing `apiAllow` is an empty one there too): every entry it
 * would serve must be one this side sees, or the owner could never disable it.
 */
function asStored(raw: unknown): StoredPublicLink | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  if (!(typeof l.id === "string" && typeof l.appId === "string" && (l.mode === "temporary" || l.mode === "permanent")
    && typeof l.token === "string" && typeof l.createdAt === "number")) return null;
  const apiAllow = l.apiAllow === undefined || l.apiAllow === null ? [] : l.apiAllow;
  if (!Array.isArray(apiAllow)) return null;
  if (l.apiReadOnly !== undefined && l.apiReadOnly !== null && typeof l.apiReadOnly !== "boolean") return null;
  return { ...(l as unknown as StoredPublicLink), apiAllow: apiAllow as string[], ...(l.apiReadOnly === true ? { apiReadOnly: true } : {}) };
}

/** `apiAccess` as given (nothing is `read`, the safe default), or a PublicLinkError. */
export function parseApiAccess(input: unknown): PublicLinkApiAccess {
  if (input === undefined || input === null) return "read";
  if (typeof input === "string" && (API_ACCESS_VALUES as readonly string[]).includes(input)) return input as PublicLinkApiAccess;
  throw new PublicLinkError("apiAccess must be full, read or none.", 400, "bad_api_access");
}

/** Does this prefix open the app's own /api tree? "/" opens everything, "/api/" is "/api". */
export function opensAppApi(prefix: string): boolean {
  const p = prefix.replace(/\/+$/, "");
  return p === "" || p === DEFAULT_API_PREFIX;
}

/**
 * The prefixes a link opens: the app's `/api` for `full` and `read`, plus
 * whatever the owner typed. The cap counts the `/api` added here too: the
 * serving side refuses a longer list, and a link it refuses is never served.
 */
export function apiAllowFor(access: PublicLinkApiAccess, typed: string[]): string[] {
  // "Off" closes the app's own /api, so a typed path may not open it again:
  // the serving side matches by prefix, and "/" or "/api/" covers that tree.
  if (access === "none" && typed.some(opensAppApi)) {
    throw new PublicLinkError("With the app's API off, a path cannot open the app's own /api or the whole app.", 400, "bad_api_allow");
  }
  const out = access === "none" || typed.includes(DEFAULT_API_PREFIX) ? typed : [DEFAULT_API_PREFIX, ...typed];
  if (out.length > MAX_API_ALLOW) {
    throw new PublicLinkError(`At most ${MAX_API_ALLOW} API paths, the app's own /api included.`, 400, "bad_api_allow");
  }
  return out;
}

/**
 * The stored links. No file is no links. A file that is not a link list is
 * none either — the serving side serves nothing from it, and the next write
 * replaces it, so none of its records can come back. A file that cannot be
 * READ throws: it may hold a live link, and saying "nothing here" would let
 * an uninstall go ahead with that link still stored.
 */
async function readStored(): Promise<StoredPublicLink[]> {
  let text: string;
  try {
    text = await fs.readFile(linksFile(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as { links?: unknown };
    if (!Array.isArray(parsed?.links)) return [];
    return parsed.links.map(asStored).filter((l): l is StoredPublicLink => l !== null);
  } catch {
    return [];
  }
}

async function writeStored(links: StoredPublicLink[]): Promise<void> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${linksFile()}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, links }, null, 2), { mode: 0o600 });
  await fs.rename(tmp, linksFile());
}

function hasPassword(link: StoredPublicLink): boolean {
  return link.password !== undefined && link.password !== null;
}

/**
 * A link password as the owner typed it, checked — or a PublicLinkError.
 *
 * It must not be the ClawBox password: a link password is handed to
 * strangers. The check is the login page's own (unix_chkpwd for the box
 * account), asked by the owner's session only; when the helper cannot answer
 * it says "no match" and the password is accepted, so this is a courtesy on
 * top of the dialog's warning and not a gate anything else depends on.
 */
async function checkedPassword(input: unknown): Promise<string> {
  if (typeof input !== "string") throw new PublicLinkError("The password must be text.", 400, "bad_password");
  const password = input.normalize("NFC");
  if (PASSWORD_CONTROL_CHAR_RE.test(password)) throw new PublicLinkError("The password contains characters that cannot be typed.", 400, "bad_password");
  if (password.length < MIN_PASSWORD_LENGTH) throw new PublicLinkError(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`, 400, "password_too_short");
  if (password.length > MAX_PASSWORD_LENGTH) throw new PublicLinkError(`The password can have at most ${MAX_PASSWORD_LENGTH} characters.`, 400, "password_too_long");
  if (await verifyPassword(password).catch(() => false)) {
    throw new PublicLinkError("That is your ClawBox password. A link password must be a different one.", 400, "password_is_system");
  }
  return password;
}

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const STORED_HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/**
 * Does `password` hash to the stored `hash`? The same derivation the serving
 * side runs on a visitor's answer (scripts/public-app-links.js,
 * verifyPasswordHash), kept here so what the owner's dialog stores can be
 * checked against it before it is written. False for a record
 * that is not one of ours.
 */
export async function verifyLinkPasswordHash(password: string, hash: string): Promise<boolean> {
  const m = STORED_HASH_RE.exec(hash);
  if (!m) return false;
  const key = Buffer.from(m[5], "base64url");
  const derived = await scryptAsync(password.normalize("NFC"), Buffer.from(m[4], "base64url"), Number(m[1]), Number(m[2]), Number(m[3]), key.length).catch(() => null);
  return derived !== null && derived.length === key.length && timingSafeEqual(derived, key);
}

/**
 * The record stored for a password: a fresh salt, the slow hash, a fresh
 * unlock key — and the hash checked against the password it is for before
 * anything is written, the way the serving side will check a visitor's
 * answer. A record that would not verify is never stored: the owner would
 * hand out a password nobody can use.
 */
async function hashedPassword(password: string, now: number): Promise<StoredLinkPassword> {
  const salt = randomBytes(SCRYPT.saltLength);
  const derived = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLength);
  const hash = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  if (!(await verifyLinkPasswordHash(password, hash))) {
    throw new PublicLinkError("The password could not be stored in a form that verifies. Try again.", 500, "password_unverifiable");
  }
  return { hash, key: randomBytes(32).toString("base64url"), setAt: now };
}

async function audit(event: string, fields: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
    await fs.appendFile(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
  } catch {
    // A record, not a gate.
  }
}

interface RuntimeEntry {
  url?: unknown;
  state?: unknown;
}

async function readRuntime(): Promise<Record<string, RuntimeEntry>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(runtimeFile(), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, RuntimeEntry>) : {};
  } catch {
    return {};
  }
}

const QUICK_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

/** The link a visitor opens: the tunnel's origin, the app's own path, the token. */
export function publicLinkUrl(origin: string, link: Pick<StoredPublicLink, "appId" | "token">, isServerApp: boolean): string {
  const base = isServerApp ? `/apps/${link.appId}/` : "/";
  return `${origin}${base}?k=${link.token}`;
}

async function isServerApp(appId: string): Promise<boolean> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(webappPath(appId), "meta.json"), "utf-8")) as { port?: unknown };
    return typeof meta.port === "number";
  } catch {
    return false;
  }
}

const withLinks = createSerialLock();

/** Expired links are dropped from the file (the serving side already refuses them). */
async function pruneExpired(links: StoredPublicLink[], now: number): Promise<StoredPublicLink[]> {
  const live = links.filter((l) => !(l.mode === "temporary" && typeof l.expiresAt === "number" && l.expiresAt <= now));
  if (live.length !== links.length) {
    for (const l of links) if (!live.includes(l)) await audit("expired", { link: l.id, app: l.appId });
    await writeStored(live);
  }
  return live;
}

export async function listPublicLinks(now = Date.now()): Promise<PublicLinkView[]> {
  return withLinks(async () => {
    const links = await pruneExpired(await readStored(), now);
    const runtime = await readRuntime();
    const out: PublicLinkView[] = [];
    for (const l of links) {
      const rt = runtime[l.id];
      const origin = typeof rt?.url === "string" && QUICK_ORIGIN_RE.test(rt.url) ? rt.url : null;
      const state = rt?.state === "live" || rt?.state === "starting" || rt?.state === "restarting" ? rt.state : (rt ? "starting" : "offline");
      out.push({
        appId: l.appId,
        mode: l.mode,
        createdAt: l.createdAt,
        expiresAt: l.expiresAt,
        apiAllow: l.apiAllow,
        apiReadOnly: l.apiReadOnly === true,
        passwordProtected: hasPassword(l),
        state: origin && state === "live" ? "live" : state === "live" ? "starting" : state,
        url: origin && state === "live" ? publicLinkUrl(origin, l, await isServerApp(l.appId)) : null,
      });
    }
    return out;
  });
}

export interface CreatePublicLinkInput {
  appId: unknown;
  mode: unknown;
  ttlMinutes?: unknown;
  /** Extra prefixes below the app's base path, on top of what `apiAccess` opens. */
  apiAllow?: unknown;
  /** `full` (default), `read` or `none` — see PublicLinkApiAccess. */
  apiAccess?: unknown;
  /** A password for this link, or nothing for an open one. */
  password?: unknown;
}

/** Publish an app. One link per app; a desktop webapp (data/webapps/<id>/) only. */
export async function createPublicLink(input: CreatePublicLinkInput, now = Date.now()): Promise<PublicLinkView> {
  const appId = typeof input.appId === "string" ? input.appId : "";
  if (!APP_ID_RE.test(appId) || isReservedAppId(appId)) throw new PublicLinkError("Unknown app.", 400, "bad_app");
  if (input.mode !== "temporary" && input.mode !== "permanent") throw new PublicLinkError("Choose a temporary or a permanent link.", 400, "bad_mode");
  const mode: PublicLinkMode = input.mode;
  let expiresAt: number | null = null;
  if (mode === "temporary") {
    const ttl = typeof input.ttlMinutes === "number" ? input.ttlMinutes : Number.NaN;
    if (!Number.isInteger(ttl) || ttl < MIN_TTL_MINUTES || ttl > MAX_TTL_MINUTES) {
      throw new PublicLinkError(`A temporary link lasts between ${MIN_TTL_MINUTES} minute and ${MAX_TTL_MINUTES / 1440} days.`, 400, "bad_ttl");
    }
    expiresAt = now + ttl * 60_000;
  }
  const apiAccess = parseApiAccess(input.apiAccess);
  const apiAllow = apiAllowFor(apiAccess, parseApiAllow(input.apiAllow));
  const apiReadOnly = apiAccess === "read";
  // Hashed before the lock is taken: it is slow, and nothing it needs is shared.
  const password = input.password === undefined || input.password === null ? null : await hashedPassword(await checkedPassword(input.password), now);

  // Only an app that is on the desktop as a webapp — a one-file app or a
  // registered server app — has a folder here. Built-ins and store skills
  // have none and cannot be published.
  // Checked under the lock that uninstall also holds while it removes the
  // folder, so a link can never be stored for an app that is going away.
  return withLinks(async () => {
    const index = await fs.stat(path.join(webappPath(appId), "index.html")).catch(() => null);
    if (!index?.isFile()) throw new PublicLinkError("Only an app the Coding Agent built can be shared.", 404, "not_shareable");
    const links = await pruneExpired(await readStored(), now);
    if (links.some((l) => l.appId === appId)) throw new PublicLinkError("This app already has a public link.", 409, "exists");
    if (links.length >= MAX_LINKS) throw new PublicLinkError(`At most ${MAX_LINKS} apps can be public at once.`, 409, "too_many");
    const link: StoredPublicLink = {
      id: randomBytes(8).toString("hex"),
      appId,
      mode,
      token: randomBytes(32).toString("base64url"),
      createdAt: now,
      expiresAt,
      apiAllow,
      ...(apiReadOnly ? { apiReadOnly: true } : {}),
      ...(password ? { password } : {}),
    };
    await writeStored([...links, link]);
    await audit("created", { link: link.id, app: appId, mode, expiresAt, apiAllow, apiReadOnly, password: password !== null });
    return { appId, mode, createdAt: now, expiresAt, apiAllow, apiReadOnly, passwordProtected: password !== null, state: "starting", url: null };
  });
}

/**
 * Set, change (a string) or remove (null) the password of an app's link. The
 * link itself — id, token, address, expiry — is untouched. True when the link
 * is password-protected afterwards.
 */
export async function setPublicLinkPassword(appId: unknown, input: unknown, now = Date.now()): Promise<boolean> {
  if (typeof appId !== "string" || !APP_ID_RE.test(appId)) throw new PublicLinkError("Unknown app.", 400, "bad_app");
  const password = input === null ? null : await hashedPassword(await checkedPassword(input), now);
  return withLinks(async () => {
    const links = await pruneExpired(await readStored(), now);
    const link = links.find((l) => l.appId === appId);
    if (!link) throw new PublicLinkError("This app has no public link.", 404, "no_link");
    const had = hasPassword(link);
    if (!password && !had) return false;
    const { password: _old, ...rest } = link;
    void _old;
    const next: StoredPublicLink = password ? { ...rest, password } : rest;
    await writeStored(links.map((l) => (l === link ? next : l)));
    await audit(password ? (had ? "password_changed" : "password_set") : "password_removed", { link: link.id, app: appId });
    return password !== null;
  });
}

/**
 * Disable an app's link. Immediate: the serving side refuses it on the next
 * request. True when there was one. `during`, when given, runs under the same
 * lock right after (uninstall removes the app's folder there), so no link can
 * be created for the app in between.
 *
 * When the list cannot be read or rewritten, this throws BEFORE `during`: an
 * uninstall that went ahead would leave the link stored, and an app deployed
 * again under the same id would be public on the old token.
 */
export async function disablePublicLink(appId: string, reason = "disabled", during?: () => Promise<void>): Promise<boolean> {
  if (!APP_ID_RE.test(appId)) {
    if (during) await during();
    return false;
  }
  return withLinks(async () => {
    const links = await readStored();
    const gone = links.filter((l) => l.appId === appId);
    if (gone.length > 0) {
      await writeStored(links.filter((l) => l.appId !== appId));
      for (const l of gone) await audit(reason, { link: l.id, app: appId });
    }
    if (during) await during();
    return gone.length > 0;
  });
}
