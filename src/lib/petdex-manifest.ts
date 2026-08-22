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

const CURATED_SLUGS = new Set(CURATED_PETS.map((p) => p.slug));

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

function isFresh(cache: SheetUrlCache | null): cache is SheetUrlCache {
  return cache !== null && Date.now() - cache.fetchedAt < MANIFEST_TTL_MS;
}

async function readDiskCache(): Promise<SheetUrlCache | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(CACHE_FILE, "utf-8")) as SheetUrlCache;
    if (!parsed || typeof parsed.fetchedAt !== "number" || !parsed.urls) return null;
    // Re-pin on read: the file is ours, but it is the one input here that a
    // later code change (or a hand edit) could point somewhere else.
    const urls: Record<string, string> = {};
    for (const [slug, url] of Object.entries(parsed.urls)) {
      if (typeof url === "string" && isPetdexUrl(url)) urls[slug] = url;
    }
    return { fetchedAt: parsed.fetchedAt, urls };
  } catch {
    return null;
  }
}

async function writeDiskCache(cache: SheetUrlCache): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fsp.writeFile(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch {
    // A cache we cannot write costs one fetch per TTL, not a failure.
  }
}

interface ManifestEntry {
  slug?: unknown;
  spritesheetUrl?: unknown;
}

/** Pull the curated slugs' sheet URLs out of a manifest body. */
function extractUrls(body: unknown): Record<string, string> {
  const pets = (body as { pets?: unknown })?.pets;
  if (!Array.isArray(pets)) return {};
  const urls: Record<string, string> = {};
  for (const entry of pets as ManifestEntry[]) {
    const slug = entry?.slug;
    const url = entry?.spritesheetUrl;
    if (typeof slug !== "string" || !CURATED_SLUGS.has(slug)) continue;
    if (typeof url !== "string" || !isPetdexUrl(url)) continue;
    // First occurrence wins — the manifest is append-ordered and a duplicate
    // slug later in the file is a re-upload we have no way to rank.
    if (!(slug in urls)) urls[slug] = url;
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
