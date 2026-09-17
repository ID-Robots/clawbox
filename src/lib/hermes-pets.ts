// ── The mascot's pets, from ClawBox's side ──
//
// Hermes ships a first-class pet subsystem: a `hermes pets` CLI, a store under
// `$HERMES_HOME/pets/<slug>/`, and `display.pet.*` in config.yaml. On a box
// with the Hermes harness ClawBox does not reimplement any of it — it reads the
// same store and writes through the same CLI, so the desktop mascot, the TUI,
// the `hermes pets` command and the upstream Electron app always agree on
// which pet is active.
//
// On an OPENCLAW box there is no `hermes` binary and no config.yaml, and until
// 2026-09-07 there were no pets either — the crab was the only body. The owner
// asked for the same picker there, so the store has a second arm: the same
// directory layout under ClawBox's own `data/pets/<slug>/`, the sheet fetched
// by `installPetDirect` (the curated-only download the Hermes arm already
// falls back to), and the selection in ClawBox's config store (`mascot_pet`)
// instead of Hermes' config.yaml. Which arm is live is the edition's
// (`hasHermesHarness`), asked per call rather than at import, so the routes
// and the mascot follow a harness swap without a restart. With no pet picked
// an OpenClaw box keeps the crab; a Hermes box wears the egg (see Mascot.tsx).
//
// Since 2026-09-17 THE CRAB IS A PET. `vibrant-clawd` — ClawBox's own artwork,
// shipped in `public/pets/` (src/lib/pet-builtin.ts) — is what an OpenClaw or
// dual box wears with nothing picked, resolved by `brandPetSlug()` and rendered
// by the same `PetSprite` every other pet uses. So there is one mascot renderer
// on this device rather than two, the still PNG is the fail-open body, and a
// box that has never had a network still gets nine animated states.
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
// No PETDEX sprite bytes are bundled — see src/lib/pet-curated.ts for why that
// is a hard constraint and not a preference. Our own are, and only our own.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { CONFIG_ROOT, DATA_DIR, get as getConfig, set as setConfig } from "@/lib/config-store";
import { hasHermesHarness, readEdition } from "@/lib/edition-source";
import { runHermesCli } from "@/lib/hermes-cli";
import { hermesConfigGetMany } from "@/lib/hermes-config-cache";
import { PETDEX_ASSET_HOSTS, petdexSheetUrl } from "@/lib/petdex-manifest";
import { BUILTIN_PETS, isBuiltinPet, VIBRANT_CLAWD_SLUG } from "@/lib/pet-builtin";
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
/** Read per call: the tests move it, and nothing here may pin it at import. */
function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(HOME_DIR, ".hermes");
}
/** The config-store key the OpenClaw arm keeps its selection under. */
export const MASCOT_PET_KEY = "mascot_pet";

/**
 * Where the pets live. Hermes: `$HERMES_HOME/pets`, mirroring
 * `agent.pet.store.pets_dir()` (profile-scoped, not petdex's own dir), so the
 * CLI and the desktop see one store. OpenClaw: ClawBox's own `data/pets`.
 */
export function petsDir(): string {
  return hasHermesHarness() ? path.join(hermesHome(), "pets") : path.join(DATA_DIR, "pets");
}

/**
 * Where the pets ClawBox SHIPS live: `public/pets/<slug>/`.
 *
 * `public/` rather than a new asset root because that directory is already the
 * one place a bundled sprite sheet is known to survive the build — it is what
 * `public/pet-egg-sheet.png` uses, and `scripts/postbuild.sh` copies the whole
 * of it next to the standalone entry. Nothing had to be added to Next's file
 * tracing, no route downloads anything, and both editions read the same bytes
 * off the same disk. The pet is served through the ORDINARY sprite route, not
 * as a static `/pets/...` URL, so the auth gate, the `{mtime}:{size}` cache
 * buster and the measured geometry cache all keep working unchanged.
 *
 * Resolved PER CALL against two roots and never memoised: the tests move
 * `CLAWBOX_ROOT`, a dev server runs from the checkout, and the production
 * server runs from `.next/standalone` — where postbuild put a second copy of
 * `public/`. A root probed once at import is the exact shape of this repo's
 * "probe-once" defect, and here it would silently leave the desktop crab-less.
 */
function builtinPetsRoots(): string[] {
  return [path.join(CONFIG_ROOT, "public", "pets"), path.join(process.cwd(), "public", "pets")];
}

/** The on-disk directory of a bundled pet, or null when this build has none. */
export function builtinPetDir(rawSlug: string): string | null {
  const slug = safePetSlug(rawSlug);
  if (!slug || !isBuiltinPet(slug)) return null;
  for (const root of builtinPetsRoots()) {
    const dir = path.join(root, slug);
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // Not this root. A missing copy is not an error until every root misses.
    }
  }
  return null;
}

/** ClawBox-owned scratch space. Never written into a pet's own directory. */
function cacheDir(): string {
  return hasHermesHarness() ? path.join(hermesHome(), "cache", "clawbox-pets") : path.join(DATA_DIR, "pets-cache");
}

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
  /** Loaded from `public/pets/` — shipped with ClawBox, never downloaded. */
  builtin: boolean;
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
  /**
   * This is ClawBox's OWN crab wearing the mascot, not a pet the owner picked.
   *
   * The body is identical — the same sheet through the same renderer — but two
   * things follow the brand rather than the sprite: the mascot keeps calling
   * itself `data-mascot="crab"`, and it keeps the crab's voice. Filtering
   * crab-literal lines out of the CRAB would be the filter firing on the one
   * body it was written to protect.
   */
  brand: boolean;
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
  // The owner's own store first, the shipped pack second: a slug the owner
  // installed or generated himself must keep winning over a bundled one of the
  // same name, exactly as it would over a curated one.
  const ownDir = path.join(petsDir(), slug);
  const dir = fs.existsSync(ownDir) ? ownDir : (builtinPetDir(slug) ?? ownDir);
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
    // A property of the SLUG, not of the directory it happened to load from:
    // the Hermes arm copies the pack into its own store when the pet is picked
    // (see selectPet), and that copy is still the pet ClawBox ships.
    builtin: isBuiltinPet(slug),
  };
}

/** Mirrors `installed_pets()` — dirs that contain a usable spritesheet. */
export function installedPets(): InstalledPet[] {
  let names: string[];
  try {
    names = fs.readdirSync(petsDir()).sort();
  } catch {
    return []; // fresh box: the pets directory does not exist yet
  }
  const out: InstalledPet[] = [];
  for (const name of names) {
    const pet = loadPet(name);
    if (pet) out.push(pet);
  }
  return out;
}

/**
 * The packs this build ships, as installed pets.
 *
 * Deliberately NOT folded into `installedPets()`. That function mirrors
 * upstream's `installed_pets()` — what is in the harness's OWN store — and two
 * of its readers depend on exactly that meaning: `resolveActivePet`, whose
 * alphabetical fallback would otherwise hand a Hermes box the ClawBox crab the
 * moment its own pet went missing, and `selectPet`, which asks the store
 * whether it still has to install something. The gallery is the caller that
 * wants both lists, and it asks for both.
 *
 * A bundled pet the owner has ALSO installed under the same slug is returned
 * once, from his own copy — `loadPet` prefers it.
 */
export function builtinInstalledPets(): InstalledPet[] {
  const out: InstalledPet[] = [];
  for (const { slug } of BUILTIN_PETS) {
    const pet = loadPet(slug);
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

/**
 * What the desktop wears with NO pet picked.
 *
 * The crab wherever ClawBox's own harness runs (`openclaw`, `dual`), the egg on
 * a Hermes-only box — the crab is ClawBox's brand and is not a stand-in on
 * someone else's harness. The EDITION decides, not the active harness: a dual
 * box is a ClawBox whichever harness it is running at the moment.
 *
 * One function rather than the literal the route carried, because the brand
 * body below has to agree with the `placeholder` that route reports: two copies
 * of that ternary is how a box ends up telling the picker "crab" while the
 * mascot resolves nothing.
 */
export function mascotPlaceholder(): "crab" | "egg" {
  return readEdition() === "hermes" ? "egg" : "crab";
}

/**
 * The slug the crab placeholder is DRAWN FROM, or null where there is no crab.
 *
 * Since 2026-09-17 the ClawBox crab is not a still PNG on the desktop: it is
 * `vibrant-clawd`, a nine-state pack shipped in this repo, rendered by the same
 * `PetSprite` every other pet uses. So "the crab" and "a pet" stopped being two
 * renderers — there is one, and this names which sheet the brand wears.
 */
export function brandPetSlug(): string | null {
  return mascotPlaceholder() === "crab" ? VIBRANT_CLAWD_SLUG : null;
}

/** The brand body as an installed pet, or null (Hermes, or a build whose
 *  bundled pack is missing — in which case the still PNG crab is drawn). */
function brandPet(): InstalledPet | null {
  const slug = brandPetSlug();
  return slug ? loadPet(slug) : null;
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
  if (!hasHermesHarness()) return readClawboxPetConfig();
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

/** The OpenClaw arm's selection: `mascot_pet` in ClawBox's own config store. */
async function readClawboxPetConfig(): Promise<PetConfig> {
  try {
    const raw = await getConfig(MASCOT_PET_KEY);
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return { enabled: d.enabled === true, slug: safePetSlug(d.slug) ?? "" };
  } catch {
    return { enabled: false, slug: "" };
  }
}

async function writeClawboxPetConfig(config: PetConfig): Promise<void> {
  await setConfig(MASCOT_PET_KEY, { enabled: config.enabled, slug: config.slug });
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

  const cacheFile = path.join(cacheDir(), `${pet.slug}-${pet.revision.replace(/:/g, "_")}.json`);
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
    await fsp.mkdir(cacheDir(), { recursive: true });
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
    // The owner's pick, then — where the crab is the placeholder — the brand
    // body. "Pets off" lands here too, and that is the point: turning the pet
    // off puts the ClawBox crab back, and the ClawBox crab IS `vibrant-clawd`.
    const pet = (config.enabled ? resolveActivePet(config.slug) : null) ?? brandPet();
    if (!pet) return null;
    const geometry = await readPetGeometry(pet);
    return {
      ...geometry,
      slug: pet.slug,
      displayName: pet.displayName,
      submittedBy: submittedBy(pet.slug),
      revision: pet.revision,
      // The BODY, not how it was reached: picking the crab from the gallery
      // and landing on it by default must read the same to the mascot.
      brand: pet.slug === VIBRANT_CLAWD_SLUG,
    };
  } catch (err) {
    console.warn("[pets] could not resolve the active pet:", err);
    return null;
  }
}

/**
 * Is SOMEONE ELSE'S pet wearing the mascot's body right now?
 *
 * The cheap half of `activePetDescriptor`: the config memo plus a directory
 * listing, with none of sharp's geometry work. Callers that only need "crab or
 * pet?" — the phrase route, for one — should use this.
 *
 * `vibrant-clawd` answers FALSE, picked or not. It is the crab: running the
 * crab-literal phrases through the pet filter would strip "claws", "shell" and
 * "crab" out of the voice of the one body they were written for.
 */
export async function isPetActive(): Promise<boolean> {
  try {
    const config = await readPetConfig();
    if (!config.enabled) return false;
    const pet = resolveActivePet(config.slug);
    return pet !== null && pet.slug !== VIBRANT_CLAWD_SLUG;
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
/** Redirect hops the direct download will follow — each hop is re-checked
 *  against the sprite-host allow-list, so a redirect cannot leave it. */
const MAX_SHEET_REDIRECTS = 3;

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
  // A pet we ship is never downloaded. If `loadPet` could not find it the
  // bundled copy is missing from this build, and reaching Petdex for a slug
  // Petdex has never heard of would 404 slowly and then write someone else's
  // art under our name if it ever stopped 404ing.
  if (isBuiltinPet(slug)) return false;
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
  const dir = path.join(petsDir(), slug);
  const sheetName = /\.png(?:[?#]|$)/i.test(url) ? "spritesheet.png" : "spritesheet.webp";
  const tmp = path.join(dir, `.${sheetName}.download`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_SHEET_TIMEOUT_MS);
  try {
    // Redirects are followed by hand: every hop must stay on an allow-listed
    // sprite host, otherwise a redirect could bounce the download to a host
    // the allow-list never approved.
    let target = url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      const hopRes = await fetch(target, { signal: controller.signal, redirect: "manual" });
      const location = hopRes.headers.get("location");
      if (hopRes.status >= 300 && hopRes.status < 400 && location) {
        void hopRes.body?.cancel().catch(() => {});
        if (hop >= MAX_SHEET_REDIRECTS) return false;
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          return false;
        }
        if (!PETDEX_ASSET_HOSTS.has(next.hostname)) return false;
        target = next.toString();
        continue;
      }
      res = hopRes;
      break;
    }
    if (!res.ok) return false;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_DIRECT_SHEET_BYTES) return false;
    // Enforce the cap WHILE reading: a missing or lying content-length must
    // not let a huge download sit in memory before the size check happens.
    const reader = res.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DIRECT_SHEET_BYTES) {
        await reader.cancel().catch(() => {});
        return false;
      }
      chunks.push(value);
    }
    if (received === 0) return false;
    const body = Buffer.concat(chunks);
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
 * Copy a bundled pack into the harness's OWN pets directory.
 *
 * Only the Hermes arm needs this. `hermes pets select` refuses a slug that is
 * not in `$HERMES_HOME/pets` — it has no idea ClawBox ships one — so a pet the
 * owner picks has to exist there before the CLI is asked. Copied, never
 * downloaded, and the copy is what makes the TUI and the upstream desktop app
 * show the same pet as this desktop.
 *
 * The directory lands under a dot-prefixed temp name and is renamed, so a torn
 * copy is never mistaken for an installed pet (`installedPets` skips dot names
 * only by way of `loadPet`'s slug charset, which forbids a leading dot).
 */
async function materialiseBuiltinPet(slug: string): Promise<boolean> {
  const src = builtinPetDir(slug);
  if (!src) return false;
  const dest = path.join(petsDir(), slug);
  const tmp = path.join(petsDir(), `.${slug}.copy`);
  try {
    await fsp.mkdir(petsDir(), { recursive: true });
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.cp(src, tmp, { recursive: true });
    await fsp.rename(tmp, dest);
    return loadPet(slug) !== null;
  } catch (err) {
    console.warn(`[pets] could not copy the bundled pack for ${slug}:`, err instanceof Error ? err.message : String(err));
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    // A rename that lost a race with another writer is still a success for the
    // caller: what matters is that the pet is readable now, not who wrote it.
    return loadPet(slug) !== null;
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

  if (!hasHermesHarness()) {
    // The OpenClaw arm: the curated download straight into data/pets, then
    // the selection into ClawBox's own store. No CLI exists to ask.
    if (!loadPet(safe) && !(await installPetDirect(safe))) {
      return cliFailure("install-failed", `install ${safe}`, "no spritesheet after the direct download");
    }
    try {
      await writeClawboxPetConfig({ enabled: true, slug: safe });
    } catch (err) {
      return cliFailure("select-failed", `select ${safe}`, err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }

  // A pack we ship is copied into the Hermes store rather than installed: the
  // CLI resolves every install through petdex.dev, which has never heard of
  // `vibrant-clawd`. `loadPet` would find the bundled copy and skip the install
  // entirely, and `pets select` would then refuse a slug that is not in ITS
  // store — a false success ending in a pet nothing can activate.
  if (isBuiltinPet(safe) && !fs.existsSync(path.join(petsDir(), safe))) {
    if (!(await materialiseBuiltinPet(safe))) {
      return cliFailure("install-failed", `install ${safe}`, "could not copy the bundled pack into the harness store");
    }
  }

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

/** `hermes pets off` — clears `display.pet.enabled`, keeps the pet on disk. On
 *  the OpenClaw arm the same fact goes into ClawBox's store; the crab is back. */
export async function disablePet(): Promise<PetCliOutcome> {
  if (!hasHermesHarness()) {
    try {
      const current = await readClawboxPetConfig();
      await writeClawboxPetConfig({ enabled: false, slug: current.slug });
      return { ok: true };
    } catch (err) {
      return cliFailure("select-failed", "pets off", err instanceof Error ? err.message : String(err));
    }
  }
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

const thumbDir = () => path.join(cacheDir(), "thumbs");
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
  const cacheFile = path.join(thumbDir(), `${cacheKey}.png`);
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
    await fsp.mkdir(thumbDir(), { recursive: true });
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
