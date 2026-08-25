// ── Hermes pets, from ClawBox's side ──
//
// Hermes ships a first-class pet subsystem: a `hermes pets` CLI, a store under
// `$HERMES_HOME/pets/<slug>/`, and `display.pet.*` in config.yaml. ClawBox does
// not reimplement any of it — it reads the same store and writes through the
// same CLI, so the desktop mascot, the TUI, the `hermes pets` command and the
// upstream Electron app always agree on which pet is active.
//
// Two deliberate non-choices:
//
//   - We do NOT speak the gateway's `pet.*` JSON-RPC. Those methods are
//     WebSocket-only (there is no HTTP bridge in tui_gateway/transport.py), and
//     standing up a WS client for a cosmetic feature is not worth the coupling.
//   - We do NOT keep a ClawBox-side "selected pet" of our own. `display.pet.*`
//     in config.yaml is the single source of truth; the gateway repolls it
//     every 2 s and every other surface follows it. A second store would drift
//     the moment someone typed `hermes pets select boba` in the in-UI terminal.
//
// No sprite bytes are bundled — see src/lib/pet-curated.ts for why that is a
// hard constraint and not a preference.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { runHermesCli } from "@/lib/hermes-cli";
import { hermesConfigGetMany } from "@/lib/hermes-config-cache";
import { PETDEX_ASSET_HOSTS, petdexSheetUrl } from "@/lib/petdex-manifest";
import { curatedPet } from "@/lib/pet-curated";
import {
  FRAME_H,
  FRAME_W,
  FRAMES_PER_STATE,
  LOOP_MS,
  stateRowsForGrid,
} from "@/lib/pet-state-map";
import {
  fallbackRowMetrics,
  scanRowMetrics,
  type PetRowMetrics,
  type SheetGrid,
} from "@/lib/pet-sheet-metrics";

const HOME_DIR = process.env.HOME || "/home/clawbox";
const HERMES_HOME = process.env.HERMES_HOME || path.join(HOME_DIR, ".hermes");

/** Mirrors `agent.pet.store.pets_dir()` — profile-scoped, not petdex's own dir. */
export const PETS_DIR = path.join(HERMES_HOME, "pets");
/** ClawBox-owned scratch space. Never written into a pet's own directory. */
const CACHE_DIR = path.join(HERMES_HOME, "cache", "clawbox-pets");

/** `hermes pets install` downloads ~2.2 MB; the CLI default of 30 s is not enough. */
const INSTALL_TIMEOUT_MS = 120_000;

const SHEET_NAMES = ["spritesheet.webp", "spritesheet.png", "sprite.webp", "sprite.png"];

export interface InstalledPet {
  slug: string;
  displayName: string;
  description: string;
  sheetPath: string;
  /** `{mtimeMs}:{size}` — mirrors the gateway's `_pet_sheet_revision`. */
  revision: string;
  createdBy: string;
}

export interface PetGeometry {
  frameW: number;
  frameH: number;
  cols: number;
  rows: number;
  framesPerState: number;
  loopMs: number;
  /** Per animation ROW: how many frames are really drawn, and how far the art
   *  sits from the cell's edges. See src/lib/pet-sheet-metrics.ts. */
  rowMetrics: PetRowMetrics[];
}

/** What the mascot needs to render a pet. */
export interface PetDescriptor extends PetGeometry {
  slug: string;
  displayName: string;
  submittedBy: string;
  revision: string;
}

/**
 * Normalise a slug to a single bare path segment, or null.
 *
 * A slug arrives from the browser and then indexes into a filesystem path AND
 * becomes an argv element for the `hermes` CLI, so it gets both guards:
 *
 *   - the path guard is a port of `agent.pet.store._safe_slug` — `path.basename`
 *     plus a `.`/`..` reject, so a value can only ever name a direct child of
 *     the pets directory;
 *   - the argv guard is the charset: `runHermesCli` passes args straight to
 *     spawn (no shell, so no command injection), but a value starting with `-`
 *     would still be read as a FLAG. The charset forbids a leading hyphen.
 */
export function safePetSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) return null;
  // Belt and braces: the charset already excludes separators, but assert the
  // property we actually depend on rather than inferring it from the regex.
  if (path.basename(trimmed) !== trimmed) return null;
  if (trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

function sheetRevision(sheetPath: string): string {
  try {
    const st = fs.statSync(sheetPath);
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return "0:0";
  }
}

function resolveSheet(dir: string, meta: Record<string, unknown>): string | null {
  const declared = typeof meta.spritesheetPath === "string" ? meta.spritesheetPath : "";
  // The path comes out of a pet.json we did not write; keep it inside the dir.
  if (declared && path.basename(declared) === declared) {
    const p = path.join(dir, declared);
    if (fs.existsSync(p)) return p;
  }
  for (const name of SHEET_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** One installed pet, or null when the directory has no usable spritesheet. */
export function loadPet(rawSlug: string): InstalledPet | null {
  const slug = safePetSlug(rawSlug);
  if (!slug) return null;
  const dir = path.join(PETS_DIR, slug);
  let meta: Record<string, unknown> = {};
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    meta = JSON.parse(fs.readFileSync(path.join(dir, "pet.json"), "utf-8"));
  } catch {
    // A pet.json that is missing or malformed is not fatal — upstream
    // synthesises the metadata too. The spritesheet is what makes a pet real.
    if (!fs.existsSync(dir)) return null;
    meta = {};
  }
  const sheetPath = resolveSheet(dir, meta);
  if (!sheetPath) return null;
  return {
    slug,
    displayName: String(meta.displayName || slug),
    description: String(meta.description || ""),
    sheetPath,
    revision: sheetRevision(sheetPath),
    createdBy: String(meta.createdBy || ""),
  };
}

/** Mirrors `installed_pets()` — dirs that contain a usable spritesheet. */
export function installedPets(): InstalledPet[] {
  let names: string[];
  try {
    names = fs.readdirSync(PETS_DIR).sort();
  } catch {
    return []; // fresh box: ~/.hermes/pets does not exist yet
  }
  const out: InstalledPet[] = [];
  for (const name of names) {
    const pet = loadPet(name);
    if (pet) out.push(pet);
  }
  return out;
}

/**
 * Which pet to display: the configured slug if installed, else the first
 * installed alphabetically, else none. Mirrors `resolve_active_pet`.
 */
export function resolveActivePet(configuredSlug: string): InstalledPet | null {
  if (configuredSlug) {
    const pet = loadPet(configuredSlug);
    if (pet) return pet;
  }
  return installedPets()[0] ?? null;
}

export interface PetConfig {
  enabled: boolean;
  slug: string;
}

/**
 * `display.pet.*` as Hermes has it.
 *
 * Read through the mtime-keyed config memo, so the mascot's poll is one `stat`
 * once the answer is warm rather than two ~600 ms Python spawns.
 *
 * `display.pet.scale` is deliberately NOT read: it is Hermes' single master
 * scalar, tuned to 0.33 for a terminal corner sprite. ClawBox sizes the pet to
 * match the crab with its own multiplier instead of fighting the CLI and TUI
 * over a shared number.
 */
export async function readPetConfig(): Promise<PetConfig> {
  try {
    const got = await hermesConfigGetMany(["display.pet.enabled", "display.pet.slug"]);
    return {
      enabled: (got["display.pet.enabled"] || "").trim().toLowerCase() === "true",
      slug: safePetSlug(got["display.pet.slug"]) ?? "",
    };
  } catch {
    return { enabled: false, slug: "" };
  }
}

const geometryMemo = new Map<string, PetGeometry>();

/** The canonical Codex atlas, with no measurements — what an unreadable sheet
 *  falls back to. Built fresh each call so no caller can mutate the default. */
function defaultGeometry(): PetGeometry {
  const grid: SheetGrid = {
    frameW: FRAME_W,
    frameH: FRAME_H,
    cols: 8,
    rows: 9,
    framesPerState: FRAMES_PER_STATE,
  };
  return { ...grid, loopMs: LOOP_MS, rowMetrics: fallbackRowMetrics(grid) };
}

/**
 * Where the art is inside every cell of a sheet.
 *
 * One decode of the ALPHA channel only — a 1536x1872 sheet is 2.9 MB as one
 * byte per pixel, against ~11.5 MB for RGBA and against upstream's 72 separate
 * PIL cell extractions. The scan itself is a plain loop over the first six
 * columns of each row. Runs once per sheet revision and is cached to disk, so a
 * Jetson pays it on install and never again.
 */
async function readRowMetrics(sheetPath: string, grid: SheetGrid): Promise<PetRowMetrics[] | null> {
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(sheetPath)
      .ensureAlpha()
      .extractChannel("alpha")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 1 || info.width <= 0 || info.height <= 0) return null;
    return scanRowMetrics({ data, width: info.width, height: info.height }, grid);
  } catch (err) {
    console.warn("[pets] could not measure sheet insets:", err);
    return null;
  }
}

/**
 * Cell grid of a sheet, derived from its real pixel size.
 *
 * Atlases come in at least three shapes (8x9 Codex, 9x8 legacy, 8x11 "v2"), so
 * the row taxonomy has to be inferred rather than assumed — exactly what
 * `state_rows_for_grid` does upstream. `framesPerState` is capped at 6 for the
 * same reason upstream caps it: a sheet may physically carry more columns, and
 * only the first six are animation frames.
 *
 * `rowMetrics` measures the same thing upstream's PIL trim does — how many
 * frames a row really has, and where the drawing sits inside each cell — but
 * from ONE alpha-channel decode rather than 72 cell extractions. Without it the
 * renderer aligns the CELL to the taskbar (feet float 3-30 px) and steps six
 * frames over rows that only carry four or five (the pet vanishes for 183-367
 * ms at a time, every loop).
 *
 * Cached on disk under the ClawBox cache dir, keyed by the sheet revision, so a
 * re-install re-derives and nothing else does.
 */
export async function readPetGeometry(pet: InstalledPet): Promise<PetGeometry> {
  const key = `${pet.slug}:${pet.revision}`;
  const memo = geometryMemo.get(key);
  if (memo) return memo;

  const cacheFile = path.join(CACHE_DIR, `${pet.slug}-${pet.revision.replace(/:/g, "_")}.json`);
  try {
    const cached = JSON.parse(await fsp.readFile(cacheFile, "utf-8")) as PetGeometry;
    // A cache file an older build wrote has no `rowMetrics`; re-derive rather
    // than serve a pet whose feet float. The revision key cannot catch this —
    // the sheet did not change, our reading of it did.
    if (
      cached &&
      cached.cols > 0 &&
      cached.rows > 0 &&
      Array.isArray(cached.rowMetrics) &&
      cached.rowMetrics.length === cached.rows
    ) {
      geometryMemo.set(key, cached);
      return cached;
    }
  } catch {
    // no cache yet
  }

  let geometry = defaultGeometry();
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(pet.sheetPath).metadata();
    const cols = Math.max(1, Math.floor((meta.width || 0) / FRAME_W));
    const rows = Math.max(1, Math.floor((meta.height || 0) / FRAME_H));
    const grid: SheetGrid = {
      frameW: FRAME_W,
      frameH: FRAME_H,
      cols,
      rows,
      framesPerState: Math.max(1, Math.min(FRAMES_PER_STATE, cols)),
    };
    geometry = {
      ...grid,
      loopMs: LOOP_MS,
      rowMetrics: (await readRowMetrics(pet.sheetPath, grid)) ?? fallbackRowMetrics(grid),
    };
  } catch (err) {
    // An unreadable sheet must not break the desktop: fall back to the
    // canonical geometry, which is right for every sheet Petdex serves today.
    console.warn("[pets] could not read sheet geometry for", pet.slug, err);
  }

  geometryMemo.set(key, geometry);
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(geometry), "utf-8");
  } catch {
    // A cache we cannot write is a slower path, not a failure.
  }
  return geometry;
}

/** Row taxonomy for a resolved geometry — convenience for callers. */
export function rowsFor(geometry: PetGeometry): readonly string[] {
  return stateRowsForGrid(geometry.rows);
}

/**
 * The active pet as the mascot needs it, or null.
 *
 * Fail-open in every branch, mirroring upstream's `pet.info` ("returns
 * enabled=False on any error rather than erroring the surface"). This is
 * cosmetic; nothing here may ever be the reason a desktop fails to paint.
 */
export async function activePetDescriptor(
  submittedBy: (slug: string) => string,
): Promise<PetDescriptor | null> {
  try {
    const config = await readPetConfig();
    if (!config.enabled) return null;
    const pet = resolveActivePet(config.slug);
    if (!pet) return null;
    const geometry = await readPetGeometry(pet);
    return {
      ...geometry,
      slug: pet.slug,
      displayName: pet.displayName,
      submittedBy: submittedBy(pet.slug),
      revision: pet.revision,
    };
  } catch (err) {
    console.warn("[pets] could not resolve the active pet:", err);
    return null;
  }
}

/**
 * Is a pet wearing the mascot's body right now?
 *
 * The cheap half of `activePetDescriptor`: the config memo plus a directory
 * listing, with none of sharp's geometry work. Callers that only need "crab or
 * pet?" — the phrase route, for one — should use this.
 */
export async function isPetActive(): Promise<boolean> {
  try {
    const config = await readPetConfig();
    if (!config.enabled) return false;
    return resolveActivePet(config.slug) !== null;
  } catch {
    return false;
  }
}

export interface PetCliOutcome {
  ok: boolean;
  /** A short, already-safe reason for the UI. CLI stderr is logged, not shown. */
  reason?: "not-installed" | "install-failed" | "select-failed" | "hermes-missing";
}

function cliFailure(kind: PetCliOutcome["reason"], where: string, detail: string): PetCliOutcome {
  console.warn(`[pets] ${where} failed:`, detail);
  return { ok: false, reason: kind };
}

/** Direct-download ceiling: a curated sheet is ~2.0-2.4 MB; same cap as the
 *  thumbnail path's remote fetch. */
const MAX_DIRECT_SHEET_BYTES = 8 * 1024 * 1024;
const DIRECT_SHEET_TIMEOUT_MS = 60_000;

/**
 * Install a curated pet WITHOUT `hermes pets install`.
 *
 * The CLI resolves every install through `https://petdex.dev/api/manifest` and
 * hard-fails when that endpoint is down — observed live on 2026-08-25: the
 * manifest API answered 500 while `assets.petdex.dev` (where the sprites
 * actually live) served fine. That outage turned every first-pet pick on a
 * fresh box into a dead 502 — the egg could not hatch and the picker could not
 * pick, over a third-party API ClawBox does not even need for curated pets.
 *
 * `petdexSheetUrl` already answers a curated slug without the manifest (its
 * offline fallback is the pinned `assets.petdex.dev/curated/…` URL), so this
 * writes the same install the CLI would have: the sheet plus a minimal
 * `pet.json`, into `~/.hermes/pets/<slug>/`. `hermes pets select` accepts a
 * directory installed this way — verified on the hardware box (select exits 0,
 * `pets doctor` reports ready) — because upstream, like `loadPet` here, treats
 * "directory with a usable spritesheet" as installed.
 *
 * Curated pets only: for anything else the manifest is the sole source of
 * truth and there is nothing safe to fall back to. The sheet lands under a
 * temp name and is renamed, so a torn download never counts as installed.
 */
async function installPetDirect(slug: string): Promise<boolean> {
  const curated = curatedPet(slug);
  if (!curated) return false;
  let url: string | null = null;
  try {
    url = await petdexSheetUrl(slug);
  } catch {
    url = null;
  }
  if (!url) return false;
  try {
    if (!PETDEX_ASSET_HOSTS.has(new URL(url).hostname)) return false;
  } catch {
    return false;
  }
  const dir = path.join(PETS_DIR, slug);
  const sheetName = /\.png(?:[?#]|$)/i.test(url) ? "spritesheet.png" : "spritesheet.webp";
  const tmp = path.join(dir, `.${sheetName}.download`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_SHEET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return false;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_DIRECT_SHEET_BYTES) return false;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_DIRECT_SHEET_BYTES) return false;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, path.join(dir, sheetName));
    await fsp.writeFile(
      path.join(dir, "pet.json"),
      JSON.stringify(
        {
          id: slug,
          displayName: curated.displayName,
          spritesheetPath: sheetName,
          createdBy: "clawbox-direct",
        },
        null,
        2,
      ),
    );
    return true;
  } catch (err) {
    console.warn(`[pets] direct install failed for ${slug}:`, err instanceof Error ? err.message : String(err));
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Install a pet if it is not already on disk, then make it active.
 *
 * `hermes pets select` refuses a slug that is not installed, so the two steps
 * are separate calls rather than one — `install --select` exists but only
 * selects when the install actually ran, which would silently no-op for a pet
 * that is present but not active.
 */
export async function selectPet(slug: string): Promise<PetCliOutcome> {
  const safe = safePetSlug(slug);
  if (!safe) return { ok: false, reason: "not-installed" };

  if (!loadPet(safe)) {
    let cliDetail = "";
    try {
      const r = await runHermesCli(["pets", "install", safe], { timeoutMs: INSTALL_TIMEOUT_MS });
      if (r.code !== 0) cliDetail = r.stderr || r.stdout || `exit ${r.code}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No hermes binary means `pets select` cannot work either; a direct
      // download would land a pet nothing can activate, so stop here.
      if (msg.includes("not installed on this device")) {
        return cliFailure("hermes-missing", `install ${safe}`, msg);
      }
      cliDetail = msg;
    }
    // The download can time out mid-flight and leave a partial directory, so
    // trust the store rather than the exit code — and when the CLI could not
    // deliver at all (its manifest source can be down while the sprite CDN is
    // fine), try the direct curated download before giving up.
    if (!loadPet(safe) && (await installPetDirect(safe))) {
      console.warn(`[pets] CLI install failed (${cliDetail || "no spritesheet"}); recovered ${safe} via direct download`);
    }
    if (!loadPet(safe)) {
      return cliFailure("install-failed", `install ${safe}`, cliDetail || "no spritesheet after install");
    }
  }

  try {
    const r = await runHermesCli(["pets", "select", safe]);
    if (r.code !== 0) return cliFailure("select-failed", `select ${safe}`, r.stderr || r.stdout);
  } catch (err) {
    return cliFailure("select-failed", `select ${safe}`, err instanceof Error ? err.message : String(err));
  }
  return { ok: true };
}

/** `hermes pets off` — clears `display.pet.enabled`, keeps the pet on disk. */
export async function disablePet(): Promise<PetCliOutcome> {
  try {
    const r = await runHermesCli(["pets", "off"]);
    if (r.code !== 0) return cliFailure("select-failed", "pets off", r.stderr || r.stdout);
  } catch (err) {
    return cliFailure("select-failed", "pets off", err instanceof Error ? err.message : String(err));
  }
  return { ok: true };
}

// ── Thumbnails ──
//
// The picker cannot point an <img> at the CDN: the sheets are 2.0-2.4 MB each,
// thirteen of them is ~27 MB over a home link onto a Jetson, and hotlinking
// third-party art from our own UI is exactly the redistribution posture we are
// avoiding. So the server crops cell (0,0) — the idle frame — to a ~5 KB PNG
// and caches that. Same trick as upstream's `pet.thumb` RPC.

const THUMB_DIR = path.join(CACHE_DIR, "thumbs");
const REMOTE_SHEET_TIMEOUT_MS = 20_000;
const MAX_REMOTE_SHEET_BYTES = 8 * 1024 * 1024;
/** A Jetson decoding several 1536x1872 webps at once is how you spike its RAM. */
const MAX_CONCURRENT_REMOTE = 3;

let remoteInFlight = 0;
const remoteQueue: (() => void)[] = [];

async function withRemoteSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (remoteInFlight >= MAX_CONCURRENT_REMOTE) {
    await new Promise<void>((resolve) => remoteQueue.push(resolve));
  }
  remoteInFlight++;
  try {
    return await fn();
  } finally {
    remoteInFlight--;
    remoteQueue.shift()?.();
  }
}

async function cropIdleFrame(input: Buffer | string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(input)
    .extract({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * A PNG of the pet's idle frame, or null.
 *
 * Installed pets are cropped from the local sheet. A pet that is NOT installed
 * yet still needs a preview — otherwise the picker is thirteen name-only tiles —
 * so its sheet is fetched once from Petdex, cropped, and the 2.2 MB body
 * discarded. Only the thumbnail is kept on disk; the full sheet is never
 * cached, because caching unlicensed art we were not asked to install is the
 * one thing this design is built to avoid.
 */
export async function petThumbnail(rawSlug: string): Promise<Buffer | null> {
  const slug = safePetSlug(rawSlug);
  if (!slug) return null;

  const installed = loadPet(slug);
  const cacheKey = installed ? `${slug}-${installed.revision.replace(/:/g, "_")}` : `${slug}-remote`;
  const cacheFile = path.join(THUMB_DIR, `${cacheKey}.png`);
  try {
    return await fsp.readFile(cacheFile);
  } catch {
    // not cached yet
  }

  let png: Buffer | null = null;
  try {
    if (installed) {
      png = await cropIdleFrame(installed.sheetPath);
    } else {
      png = await withRemoteSlot(() => fetchRemoteThumb(slug));
    }
  } catch (err) {
    console.warn("[pets] thumbnail failed for", slug, err);
    return null;
  }
  if (!png) return null;

  try {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    await fsp.writeFile(cacheFile, png);
  } catch {
    // Serving an uncached thumbnail is fine; it just costs the fetch again.
  }
  return png;
}

async function fetchRemoteThumb(slug: string): Promise<Buffer | null> {
  // Resolved from the Petdex manifest, never composed from the slug: the
  // curated pets are split across `sprite-v2.webp` and `spritesheet.webp`
  // with no rule connecting the two, so guessing 404s six of thirteen.
  const url = await petdexSheetUrl(slug);
  if (!url || !PETDEX_ASSET_HOSTS.has(new URL(url).hostname)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_SHEET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return null;
    // A slug can be taken down between the manifest and the fetch, and the
    // response is third-party — cap it before it reaches memory.
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_REMOTE_SHEET_BYTES) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength > MAX_REMOTE_SHEET_BYTES) return null;
    return await cropIdleFrame(body);
  } finally {
    clearTimeout(timer);
  }
}
