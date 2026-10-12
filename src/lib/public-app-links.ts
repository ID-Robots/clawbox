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
 *   - the app's `/api` tree and every write stay closed unless the owner names
 *     a prefix in `apiAllow`.
 */
import { randomBytes } from "crypto";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { APP_ID_RE, webappPath } from "@/lib/code-projects";
import { isReservedAppId } from "@/lib/webapp-registry";
import { createSerialLock } from "@/lib/serial-lock";

export const MAX_LINKS = 5;
export const MIN_TTL_MINUTES = 1;
export const MAX_TTL_MINUTES = 30 * 24 * 60;
export const MAX_API_ALLOW = 16;
const API_ALLOW_RE = /^\/[A-Za-z0-9._~\-/]{0,200}$/;

export type PublicLinkMode = "temporary" | "permanent";

export interface StoredPublicLink {
  id: string;
  appId: string;
  mode: PublicLinkMode;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  apiAllow: string[];
}

/** What the desktop is told about a link. */
export interface PublicLinkView {
  appId: string;
  mode: PublicLinkMode;
  createdAt: number;
  expiresAt: number | null;
  apiAllow: string[];
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

function isStored(raw: unknown): raw is StoredPublicLink {
  if (!raw || typeof raw !== "object") return false;
  const l = raw as Record<string, unknown>;
  return typeof l.id === "string" && typeof l.appId === "string" && (l.mode === "temporary" || l.mode === "permanent")
    && typeof l.token === "string" && typeof l.createdAt === "number" && Array.isArray(l.apiAllow);
}

async function readStored(): Promise<StoredPublicLink[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(linksFile(), "utf-8")) as { links?: unknown };
    return Array.isArray(parsed.links) ? parsed.links.filter(isStored) : [];
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
  apiAllow?: unknown;
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
  const apiAllow = parseApiAllow(input.apiAllow);

  // Only an app that is on the desktop as a webapp — a one-file app or a
  // registered server app — has a folder here. Built-ins and store skills
  // have none and cannot be published.
  const index = await fs.stat(path.join(webappPath(appId), "index.html")).catch(() => null);
  if (!index?.isFile()) throw new PublicLinkError("Only an app the Coding Agent built can be shared.", 404, "not_shareable");

  return withLinks(async () => {
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
    };
    await writeStored([...links, link]);
    await audit("created", { link: link.id, app: appId, mode, expiresAt, apiAllow });
    return { appId, mode, createdAt: now, expiresAt, apiAllow, state: "starting", url: null };
  });
}

/** Disable an app's link. Immediate: the serving side refuses it on the next request. True when there was one. */
export async function disablePublicLink(appId: string, reason = "disabled"): Promise<boolean> {
  if (!APP_ID_RE.test(appId)) return false;
  return withLinks(async () => {
    const links = await readStored();
    const gone = links.filter((l) => l.appId === appId);
    if (gone.length === 0) return false;
    await writeStored(links.filter((l) => l.appId !== appId));
    for (const l of gone) await audit(reason, { link: l.id, app: appId });
    return true;
  });
}
