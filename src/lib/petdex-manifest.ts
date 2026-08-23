// ── Where a pet's spritesheet actually lives ──
//
// The sheet URL is NOT derivable from the slug. Petdex serves its curated pets
// from `assets.petdex.dev/curated/<slug>/`, but under two different filenames:
// seven of the thirteen are `sprite-v2.webp` and six are `spritesheet.webp`.
// Hardcoding either one 404s the other half of the picker, which is exactly
// what shipped before this module existed.
//
// Upstream does not guess either — `agent/pet/manifest.py` reads
// `spritesheetUrl` straight out of `https://petdex.dev/api/manifest`. So do we.
//
// The manifest is ~1.6 MB of JSON describing ~4600 pets, which is far too much
// to hold or re-fetch per thumbnail on a Jetson, so this module keeps only what
// ClawBox can actually ask for — the curated slugs' sheet URLs — behind three
// layers:
//
//   1. an in-process memo, good for the TTL;
//   2. a small JSON file under the ClawBox cache dir, which also survives a
//      restart and is used STALE when the network is down;
//   3. the offline fallback in `pet-curated.ts`, so a box that has never had
//      internet still renders thumbnails once it gets some.
//
// Nothing here downloads or stores sprite bytes — only addresses.
//
// And not even the addresses are stored as the network sent them. Every URL
// that reaches the disk cache is REBUILT from things this repository already
// knows — the pinned host, the curated slug being looked up — with the file
// name as the single piece taken from the response, matched against a strict
// pattern and length-capped first. The body is parsed, reduced to
// `slug -> sheet URL` for the thirteen slugs the picker can ask for, and
// re-serialised; no raw response text is ever written out.

import fsp from "fs/promises";
import path from "path";
import { CURATED_PETS, curatedFallbackSheetUrl } from "@/lib/pet-curated";

const HOME_DIR = process.env.HOME || "/home/clawbox";
const HERMES_HOME = process.env.HERMES_HOME || path.join(HOME_DIR, ".hermes");
const CACHE_FILE = path.join(HERMES_HOME, "cache", "clawbox-pets", "sheet-urls.json");

/** Same entry point `agent/pet/manifest.py` uses; it 307s to the asset host. */
const MANIFEST_URL = "https://petdex.dev/api/manifest";

/** Sheet URLs change when a pet is re-uploaded, which is rare. A day is plenty. */
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 20_000;
/** The live manifest is ~1.6 MB. Ten times that is a manifest we do not want. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Mirrors `store.py`'s host pin — a redirect may not walk us off Petdex. */
export const PETDEX_ASSET_HOSTS = new Set(["assets.petdex.dev", "petdex.dev"]);

/** Maps a slug off the wire onto OUR copy of that string, so everything
 *  downstream — cache keys, rebuilt URLs — is a constant from this repo. */
const CURATED_SLUG_CONSTANTS = new Map(CURATED_PETS.map((p) => [p.slug, p.slug] as const));
const CURATED_SLUGS = new Set(CURATED_PETS.map((p) => p.slug));
const PETDEX_ASSET_HOST_LIST = [...PETDEX_ASSET_HOSTS];

/** No real sheet URL is anywhere near this long; anything that is, is not one. */
const MAX_URL_CHARS = 512;
/** ~4.6k pets today. Well past that is a body we should stop walking. */
const MAX_MANIFEST_ENTRIES = 50_000;
/** Every curated sheet upstream is `<slug>/sprite-v2.webp` or `<slug>/spritesheet.webp`. */
const SHEET_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(?:webp|png)$/i;

interface SheetUrlCache {
  fetchedAt: number;
  /** slug -> absolute https URL on a Petdex host. Curated slugs only. */
  urls: Record<string, string>;
}

let memo: SheetUrlCache | null = null;
/** One manifest fetch at a time, however many thumbnails are being cropped. */
let inFlight: Promise<SheetUrlCache | null> | null = null;

function isPetdexUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && PETDEX_ASSET_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Rebuild a curated pet's sheet URL out of parts we trust, or reject it.
 *
 * The host comes from the pinned allow-list, the slug from the curated table
 * and `/curated/` is a literal — so the only text that survives from the
 * manifest is the file name, and only if it is a plain `.webp`/`.png` name of
 * sane length. Query strings, fragments, credentials, ports and any path that
 * is not exactly `/curated/<slug>/<file>` do not come through, which is what
 * keeps unvetted response text out of the disk cache.
 *
 * A URL that fails here is simply not recorded: `petdexSheetUrl` then answers
 * with the offline fallback, so the picker degrades to the hardcoded curated
 * address rather than to blank tiles.
 */
function canonicalSheetUrl(raw: unknown, slug: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const host = PETDEX_ASSET_HOST_LIST.find((known) => known === parsed.hostname);
  if (!host) return null;
  // `pathname` stays percent-encoded, so a smuggled `%2e%2e` or slash fails
  // the file-name pattern below instead of being decoded into a traversal.
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return null;
  if (segments[0] !== "curated" || segments[1] !== slug) return null;
  if (!SHEET_FILE_RE.test(segments[2])) return null;
  return `https://${host}/curated/${slug}/${segments[2]}`;
}

function isFresh(cache: SheetUrlCache | null): cache is SheetUrlCache {
  return cache !== null && Date.now() - cache.fetchedAt < MANIFEST_TTL_MS;
}

async function readDiskCache(): Promise<SheetUrlCache | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(CACHE_FILE, "utf-8")) as SheetUrlCache;
    if (!parsed || !Number.isFinite(parsed.fetchedAt) || !parsed.urls) return null;
    // Re-validated on read through the same gate as the wire: the file is
    // ours, but it is the one input here that a later code change (or a hand
    // edit) could point somewhere else.
    return { fetchedAt: Number(parsed.fetchedAt), urls: reduceToCuratedUrls(parsed.urls) };
  } catch {
    return null;
  }
}

/**
 * `slug -> sheet URL` for the curated slugs present in `source`, and nothing
 * else. Keys are this repo's own strings and values are rebuilt by
 * `canonicalSheetUrl`, so the result shares no text with its input beyond a
 * vetted file name. Anything else in `source` — other slugs, other fields,
 * junk — is dropped rather than carried to disk.
 */
function reduceToCuratedUrls(source: unknown): Record<string, string> {
  const urls: Record<string, string> = {};
  if (!source || typeof source !== "object") return urls;
  const raw = source as Record<string, unknown>;
  for (const [, slug] of CURATED_SLUG_CONSTANTS) {
    if (!Object.prototype.hasOwnProperty.call(raw, slug)) continue;
    const url = canonicalSheetUrl(raw[slug], slug);
    if (url) urls[slug] = url;
  }
  return urls;
}

async function writeDiskCache(cache: SheetUrlCache): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    // Built here, not passed through: a fresh object whose keys are the
    // curated slugs and whose values have been through `canonicalSheetUrl`.
    // Never a stringify of anything the manifest handed us.
    const body = JSON.stringify({
      fetchedAt: Math.trunc(cache.fetchedAt),
      urls: reduceToCuratedUrls(cache.urls),
    });
    await fsp.writeFile(CACHE_FILE, body, "utf-8");
  } catch {
    // A cache we cannot write costs one fetch per TTL, not a failure.
  }
}

interface ManifestEntry {
  slug?: unknown;
  spritesheetUrl?: unknown;
}

/**
 * Pull the curated slugs' sheet URLs out of a manifest body — two fields of
 * the eight each entry carries, for the thirteen slugs of ~4600 ClawBox can
 * offer, rebuilt rather than copied.
 */
function extractUrls(body: unknown): Record<string, string> {
  const pets = (body as { pets?: unknown })?.pets;
  if (!Array.isArray(pets)) return {};
  const urls: Record<string, string> = {};
  const scanned = pets.slice(0, MAX_MANIFEST_ENTRIES) as ManifestEntry[];
  for (const entry of scanned) {
    const slug = typeof entry?.slug === "string" ? CURATED_SLUG_CONSTANTS.get(entry.slug) : undefined;
    if (!slug) continue;
    // First occurrence wins — the manifest is append-ordered and a duplicate
    // slug later in the file is a re-upload we have no way to rank.
    if (slug in urls) continue;
    const url = canonicalSheetUrl(entry?.spritesheetUrl, slug);
    if (url) urls[slug] = url;
  }
  return urls;
}

async function fetchManifest(): Promise<SheetUrlCache | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const res = await fetch(MANIFEST_URL, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return null;
    // The 307 lands on assets.petdex.dev; anywhere else and we stop.
    if (!isPetdexUrl(res.url || MANIFEST_URL)) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_MANIFEST_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_MANIFEST_BYTES) return null;
    const urls = extractUrls(JSON.parse(buf.toString("utf-8")));
    if (Object.keys(urls).length === 0) return null;
    return { fetchedAt: Date.now(), urls };
  } catch (err) {
    console.warn("[pets] could not read the Petdex manifest:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The curated slug -> sheet URL map, from the freshest source available.
 *
 * Never throws and never returns null: a box with no internet and no cache
 * still gets the offline fallback, so the picker is thumbnails rather than
 * name-only tiles.
 */
async function sheetUrls(): Promise<Record<string, string>> {
  if (isFresh(memo)) return memo.urls;

  if (!inFlight) {
    inFlight = (async () => {
      const disk = await readDiskCache();
      if (isFresh(disk)) return disk;
      const fetched = await fetchManifest();
      if (fetched) {
        await writeDiskCache(fetched);
        return fetched;
      }
      // Offline: a stale cache is a far better answer than no answer. It is
      // NOT re-dated, so the next call retries the network.
      return disk;
    })();
    // Clearing here rather than in the caller: every waiter shares this one
    // promise, and the next call after it settles starts a fresh attempt.
    inFlight.finally(() => { inFlight = null; });
  }

  const resolved = await inFlight;
  if (resolved) {
    if (isFresh(resolved)) memo = resolved;
    return resolved.urls;
  }
  return {};
}

/**
 * Where to fetch `slug`'s spritesheet from, or null for a slug ClawBox does
 * not offer. Manifest-driven, with the curated fallback underneath.
 */
export async function petdexSheetUrl(slug: string): Promise<string | null> {
  if (!CURATED_SLUGS.has(slug)) return null;
  try {
    const fromManifest = (await sheetUrls())[slug];
    if (fromManifest) return fromManifest;
  } catch (err) {
    console.warn("[pets] sheet URL lookup failed for", slug, err);
  }
  return curatedFallbackSheetUrl(slug);
}

/** Test seam — drops the in-process memo so the next call re-resolves. */
export function resetPetdexManifestCache(): void {
  memo = null;
  inFlight = null;
}
