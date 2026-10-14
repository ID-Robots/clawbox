/**
 * Prime Radiant's settings: `<prime-radiant root>/settings.json`, beside the
 * state database and outside the vault (they are not knowledge).
 *
 * This module owns the ingest half — the exclude list, the model-call
 * parallelism — and the cost rates. Keys it does not know are kept on every
 * write, so a section another module adds survives an ingest setting being
 * changed. A read never creates the file; a file that cannot be parsed reads
 * as the defaults (and is logged), so a bad edit cannot stop an ingest.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { DEFAULT_INGEST_EXCLUDES, readExcludeList } from "./ingest-exclude";
import { mergeCostRates, readRateOverrides, type CostRates, type ModelRate } from "./cost-rates";
import { primeRadiantRoot } from "./paths";

export const SETTINGS_FILE = "settings.json";

/** Model calls in flight at once, by default: where the proxy's 429 ceiling sits. */
export const DEFAULT_INGEST_PARALLEL = 128;
export const MIN_INGEST_PARALLEL = 1;
export const MAX_INGEST_PARALLEL = 256;

export interface IngestSettings {
  /** Folder-name patterns never walked into. */
  exclude: string[];
  /** Model calls in flight at once. */
  parallel: number;
}

export interface PrimeRadiantSettings {
  ingest: IngestSettings;
  /** The owner's rate overrides, model by model (empty = the defaults). */
  costRates: Record<string, ModelRate>;
}

export function defaultSettings(): PrimeRadiantSettings {
  return { ingest: { exclude: [...DEFAULT_INGEST_EXCLUDES], parallel: DEFAULT_INGEST_PARALLEL }, costRates: {} };
}

export function settingsPath(root: string = primeRadiantRoot()): string {
  return path.join(root, SETTINGS_FILE);
}

function readParallel(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_INGEST_PARALLEL && v <= MAX_INGEST_PARALLEL ? v : null;
}

function readRaw(root: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath(root), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* logged below */
  }
  console.error("[prime-radiant] settings: the settings file is not a JSON object; using the defaults.");
  return {};
}

/** The settings in force: the file's valid sections over the defaults. Never creates anything. */
export function readSettings(root: string = primeRadiantRoot()): PrimeRadiantSettings {
  const raw = readRaw(root);
  const out = defaultSettings();
  const ingest = (raw.ingest && typeof raw.ingest === "object" ? raw.ingest : {}) as Record<string, unknown>;
  if (ingest.exclude !== undefined) {
    const list = readExcludeList(ingest.exclude);
    if (list.ok) out.ingest.exclude = list.patterns;
  }
  const parallel = readParallel(ingest.parallel);
  if (parallel !== null) out.ingest.parallel = parallel;
  const rates = readRateOverrides(raw.costRates);
  if (rates.ok) out.costRates = rates.models;
  return out;
}

/** The cost rates in force: defaults with the owner's overrides. */
export function effectiveCostRates(root: string = primeRadiantRoot()): CostRates {
  return mergeCostRates(readSettings(root).costRates);
}

export interface SettingsPatch {
  ingest?: { exclude?: unknown; parallel?: unknown };
  costRates?: unknown;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/**
 * Apply a patch: each field given is validated strictly and replaces the
 * stored one (`exclude: null` / `costRates: null` put the defaults back).
 * A bad field refuses the whole patch ({@link SettingsError}) and writes
 * nothing. Written atomically, 0600.
 */
export function writeSettings(patch: SettingsPatch, root: string = primeRadiantRoot()): PrimeRadiantSettings {
  const raw = readRaw(root);
  const next: Record<string, unknown> = { ...raw };
  const ingest = { ...((raw.ingest && typeof raw.ingest === "object" ? raw.ingest : {}) as Record<string, unknown>) };
  if (patch.ingest) {
    if (patch.ingest.exclude === null) delete ingest.exclude;
    else if (patch.ingest.exclude !== undefined) {
      const list = readExcludeList(patch.ingest.exclude);
      if (!list.ok) throw new SettingsError(list.error);
      ingest.exclude = list.patterns;
    }
    if (patch.ingest.parallel === null) delete ingest.parallel;
    else if (patch.ingest.parallel !== undefined) {
      const parallel = readParallel(patch.ingest.parallel);
      if (parallel === null) {
        throw new SettingsError(`parallel must be a whole number from ${MIN_INGEST_PARALLEL} to ${MAX_INGEST_PARALLEL}.`);
      }
      ingest.parallel = parallel;
    }
    next.ingest = ingest;
  }
  if (patch.costRates === null) delete next.costRates;
  else if (patch.costRates !== undefined) {
    const rates = readRateOverrides(patch.costRates);
    if (!rates.ok) throw new SettingsError(rates.error);
    next.costRates = rates.models;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = settingsPath(root);
  const tmp = untraced(`${file}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return readSettings(root);
}
