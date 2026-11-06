/**
 * `clawbox.json` — the file that makes a folder a ClawBox app.
 *
 * The owner asked for "a special file for ClawBox apps, similar to
 * package.json", so their repositories can be recognised as apps wherever
 * they are seen: the Coding Agent's project list (a chip on the row), the
 * GitHub import (a repository carrying one is flagged before it is cloned),
 * and the box itself — a manifest that names a `port` tells the box which
 * local server to reach under `/apps/<folder>/`, so the desktop icon opens
 * the app on whatever host the desktop is viewed from (LAN address, mDNS
 * name, a tunnel that changes every time it restarts — see
 * src/app/apps/[id]/[[...path]]/route.ts).
 *
 * The schema is deliberately small and every field but `name` optional:
 *
 *   {
 *     "name": "Tinder Clone",                 // shown under the icon (≤ 60 chars)
 *     "description": "Swipe on profiles…",    // for the list and the icon prompt (≤ 300)
 *     "kind": "server",                       // server | webapp | site | tool
 *     "port": 4230,                           // a server app's local port; the box proxies /apps/<folder>/ to it
 *     "start": "bun run dev",                 // how to start it (≤ 200): the box runs it in the project folder when a run settles and nothing listens on the port
 *     "stripBasePath": false,                 // true: the proxy sends "/" upstream instead of "/apps/<folder>/"
 *     "slug": "tinder-clone"                  // the app's id in the ClawBox Store (≤ 64, a-z 0-9 and inner dashes); derived from `name` when absent
 *   }
 *
 * `parseClawboxManifest` never throws and never repairs: a manifest that is
 * not an object, or whose `name` is missing, is `null`, and a field of the
 * wrong shape is dropped rather than guessed at. Reading is best-effort too
 * (`readClawboxManifest`): a folder without one is simply not an app.
 *
 * Kept free of server imports so the desktop bundle and the MCP server can
 * read the shape as well.
 */
import fs from "fs";
import path from "./runtime-path";

export const CLAWBOX_MANIFEST_FILE = "clawbox.json";
export const MANIFEST_NAME_MAX = 60;
export const MANIFEST_DESCRIPTION_MAX = 300;
export const MANIFEST_START_MAX = 200;
export const MANIFEST_SLUG_MAX = 64;
/** A ClawBox Store slug: lowercase letters and digits, dashes inside, at most 64. */
export const MANIFEST_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** The largest manifest read: anything past this is not one of ours. */
export const MANIFEST_MAX_BYTES = 16 * 1024;

export const MANIFEST_KINDS = ["server", "webapp", "site", "tool"] as const;
export type ClawboxAppKind = (typeof MANIFEST_KINDS)[number];

export interface ClawboxManifest {
  name: string;
  description: string | null;
  kind: ClawboxAppKind | null;
  /** A server app's local port, when it declares one. */
  port: number | null;
  start: string | null;
  /** True when the proxy should send `/` upstream rather than `/apps/<folder>/`. */
  stripBasePath: boolean;
  /** The app's ClawBox Store slug — present only when the manifest names a valid one (`manifestSlug` derives it otherwise). */
  slug?: string;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** A port a local server can actually listen on for the owner: never the box's own. */
export function isProxyablePort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** Parse manifest text. `null` when it is not a manifest at all. */
export function parseClawboxManifest(text: string): ClawboxManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const name = cleanText(m.name, MANIFEST_NAME_MAX);
  if (!name) return null;
  const kind = typeof m.kind === "string" && (MANIFEST_KINDS as readonly string[]).includes(m.kind) ? (m.kind as ClawboxAppKind) : null;
  const slug = typeof m.slug === "string" && MANIFEST_SLUG_RE.test(m.slug) ? m.slug : null;
  return {
    name,
    description: cleanText(m.description, MANIFEST_DESCRIPTION_MAX),
    kind,
    port: isProxyablePort(m.port) ? m.port : null,
    start: cleanText(m.start, MANIFEST_START_MAX),
    stripBasePath: m.stripBasePath === true,
    ...(slug ? { slug } : {}),
  };
}

/**
 * A Store slug made from free text — "Tinder Clone!" is `tinder-clone`.
 * Accents are folded to their letter; anything else outside a-z 0-9 becomes
 * one dash. Null when nothing usable is left (a name written only in another
 * script): the caller asks for a slug rather than inventing one.
 */
export function slugFromName(text: string): string | null {
  const folded = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let slug = "";
  for (const ch of folded) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) slug += ch;
    else if (slug && !slug.endsWith("-")) slug += "-";
    if (slug.length > MANIFEST_SLUG_MAX) break;
  }
  slug = slug.slice(0, MANIFEST_SLUG_MAX);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return MANIFEST_SLUG_RE.test(slug) ? slug : null;
}

/** The app's Store slug: the manifest's own, else one derived from its name, else from the folder. */
export function manifestSlug(manifest: ClawboxManifest, folder?: string): string | null {
  return manifest.slug ?? slugFromName(manifest.name) ?? (folder ? slugFromName(folder) : null);
}

/**
 * The manifest in `directory`, or null when there is none worth the name.
 * Read through ONE open handle — the size is checked on the handle, never
 * on a separate stat the file could change under — and never past the cap.
 */
export async function readClawboxManifest(directory: string): Promise<ClawboxManifest | null> {
  const file = path.join(directory, CLAWBOX_MANIFEST_FILE);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) return null;
    const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MANIFEST_MAX_BYTES) return null;
    return parseClawboxManifest(buffer.subarray(0, bytesRead).toString("utf-8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The synchronous read for the one caller that cannot await (production-server.js's upgrade router mirrors it). */
export function readClawboxManifestSync(directory: string): ClawboxManifest | null {
  const file = path.join(directory, CLAWBOX_MANIFEST_FILE);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) return null;
    const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > MANIFEST_MAX_BYTES) return null;
    return parseClawboxManifest(buffer.subarray(0, bytesRead).toString("utf-8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** The path the box serves a project's server app under. */
export function appProxyPath(folder: string): string {
  return `/apps/${folder}/`;
}
