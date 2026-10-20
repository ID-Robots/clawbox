/**
 * Prime Radiant's settings: `<prime-radiant root>/settings.json`, beside the
 * state database and outside the vault (they are not knowledge).
 *
 * This module owns every section: ingest (the exclude list, whether code
 * projects are skipped, the model-call parallelism, the folders the nightly
 * pass re-reads), the cost rates, the
 * nightly schedule, the optional Opus tier, the contradiction pass, the
 * search index's size limit and the domains with their owners. Keys it does not know are kept on every
 * write, so a section another module adds survives an ingest setting being
 * changed. A read never creates the file; a file that cannot be parsed reads
 * as the defaults (and is logged), so a bad edit cannot stop an ingest.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path, { untraced } from "@/lib/runtime-path";
import { DEFAULT_INGEST_EXCLUDES, EXCLUDE_DEFAULTS_GENERATION, isDefaultExcludeList, readExcludeList } from "./ingest-exclude";
import { mergeCostRates, readRateOverrides, type CostRates, type ModelRate } from "./cost-rates";
import { DAILY_LANGUAGES, DEFAULT_DAILY_PER_OWNER, isDailyLanguage, MAX_DAILY_PER_OWNER, MIN_DAILY_PER_OWNER, type DailyLanguage } from "./daily";
import { primeRadiantRoot } from "./paths";

export const SETTINGS_FILE = "settings.json";

/** Model calls in flight at once, by default: where the proxy's 429 ceiling sits. */
export const DEFAULT_INGEST_PARALLEL = 128;
export const MIN_INGEST_PARALLEL = 1;
export const MAX_INGEST_PARALLEL = 256;

/** Folders the nightly pass ingests again (new and changed documents only: hash-first dedupe). */
export const MAX_INGEST_FOLDERS = 20;
const MAX_FOLDER_CHARS = 4096;

/** The nightly pass, by default: on, at 03:00 local time. */
export const DEFAULT_NIGHTLY_TIME = "03:00";

/** The Opus tier: off until the owner turns it on, and never past its cap. */
export const DEFAULT_OPUS_MODEL = "claude-opus-5-5";
export const DEFAULT_OPUS_CAP_USD = 2;
export const MIN_OPUS_CAP_USD = 0.01;
export const MAX_OPUS_CAP_USD = 1000;
/** The share of flash-checked pages a night samples beyond the ones that are owed a check. */
export const DEFAULT_OPUS_SAMPLE_RATE = 0.02;
/**
 * The most pages one night sends to Opus, whichever account answers — the
 * cap that holds on a Claude SUBSCRIPTION, where a dollar figure means nothing
 * and the owner's own allowance is what a night spends. Pages past it stay
 * `opus_pending` for the next night.
 */
export const DEFAULT_OPUS_MAX_PAGES = 100;
export const MIN_OPUS_MAX_PAGES = 4;
export const MAX_OPUS_MAX_PAGES = 2000;

/**
 * How big the vault's search index may grow, in MB (MiB: 1 MB = 1,048,576
 * bytes): what its 8-bit vectors take on disk, and about what search holds in
 * memory. 160 MB holds ~160k chunks at 1,024-d and is safe on an 8 GB box;
 * past the limit, page vectors are kept before claim vectors (shard-index.ts).
 */
export const DEFAULT_SEARCH_INDEX_LIMIT_MB = 160;
export const MIN_SEARCH_INDEX_LIMIT_MB = 32;
export const MAX_SEARCH_INDEX_LIMIT_MB = 4096;
export const BYTES_PER_MB = 1024 * 1024;

export const MAX_DOMAINS = 100;
const MAX_OWNER_CHARS = 80;

/** The golden questions' nightly check: on, at most this many questions a night (the ones asked longest ago first). */
export const DEFAULT_GOLDEN_MAX_QUESTIONS = 50;
export const MIN_GOLDEN_MAX_QUESTIONS = 1;
export const MAX_GOLDEN_MAX_QUESTIONS = 500;
/** Owners with a language of their own for the daily questions. */
export const MAX_OWNER_LANGUAGES = 100;
/**
 * The structure pass (structure.ts): on by default in the nightly pass. The
 * owner's company names the root page; the top entities by inbound links get
 * claims worked out from their pages; the cheap model may type at most
 * `modelFallback` record pages a night that the rules could not (0: never).
 */
export const DEFAULT_STRUCTURE_ENRICH_TOP = 25;
export const MAX_STRUCTURE_ENRICH_TOP = 200;
export const DEFAULT_STRUCTURE_MODEL_FALLBACK = 25;
export const MAX_STRUCTURE_MODEL_FALLBACK = 500;
export const MAX_COMPANY_CHARS = 80;

/**
 * The summaries pass (node-summary.ts): on by default in the nightly pass.
 * The cheap model writes at most `maxPages` summaries a night, never past
 * `capUsd` of estimated spend; the rest are written from their facts' own
 * words (0 pages: never the model).
 */
export const DEFAULT_SUMMARIES_MAX_PAGES = 150;
export const MAX_SUMMARIES_MAX_PAGES = 2000;
export const DEFAULT_SUMMARIES_CAP_USD = 0.25;
export const MAX_SUMMARIES_CAP_USD = 100;

export interface IngestSettings {
  /**
   * Folder-name patterns never walked into. A stored list that is a default
   * list (today's or an earlier one) reads as today's defaults, and saving the
   * defaults stores nothing, so the list keeps following ClawBox until the
   * owner changes it; a list the owner changed is kept as it is.
   */
  exclude: string[];
  /** Leave out code projects a walk comes across (a picked folder is always read). */
  skipCodeProjects: boolean;
  /** Model calls in flight at once. */
  parallel: number;
  /** Absolute folders the nightly pass re-reads (empty = no nightly ingest). */
  folders: string[];
}

export interface NightlySettings {
  enabled: boolean;
  /** Local time of day, `HH:MM` (24 h). */
  time: string;
}

export interface OpusSettings {
  enabled: boolean;
  /** Hard ceiling on one night's estimated Opus spend, USD. */
  capUsd: number;
  /** 0..1 — the random share of flash-checked pages sampled each night. */
  sampleRate: number;
  model: string;
  /** Hard ceiling on the pages one night sends to Opus (any account). */
  maxPages: number;
}

export interface ContradictionSettings {
  enabled: boolean;
}

export interface SearchSettings {
  /** The vault search index's size limit, MB (whole number). */
  indexLimitMb: number;
}

export interface StructureSettings {
  enabled: boolean;
  /** The owner's company: the root page's title (empty: "Company overview"). */
  company: string;
  /** Entities enriched a night, the most linked first; 0 switches enrichment off. */
  enrichTop: number;
  /** Record pages the cheap model may type a night where the rules could not; 0 switches it off. */
  modelFallback: number;
}

export interface SummariesSettings {
  enabled: boolean;
  /** Summaries the cheap model writes a night, entities first; 0 leaves them all to the facts. */
  maxPages: number;
  /** Hard ceiling on one night's estimated model spend for summaries, USD. */
  capUsd: number;
}

export interface DomainSetting {
  /** Lowercase kebab, as a page's `domain`. */
  name: string;
  owner: string;
}

export interface GoldenSettings {
  /** Check the golden questions every night. */
  enabled: boolean;
  /** Questions one night asks at most (each one a share of a cheap model call). */
  maxQuestions: number;
}

export interface OwnerLanguage {
  owner: string;
  language: DailyLanguage;
}

export interface VerificationSettings {
  /** Daily questions an owner gets at most. */
  perOwner: number;
  /**
   * Whether the assistant may SEND an owner their daily questions over chat.
   * Off by default: until the owner turns it on, the questions are only shown
   * — in the app, and to the assistant when someone asks for them. Nothing is
   * ever sent on a timer.
   */
  outbound: boolean;
  /** The language each owner's questions are written in (English when not listed). */
  languages: OwnerLanguage[];
}

export interface PrimeRadiantSettings {
  ingest: IngestSettings;
  /** The owner's rate overrides, model by model (empty = the defaults). */
  costRates: Record<string, ModelRate>;
  nightly: NightlySettings;
  opus: OpusSettings;
  contradictions: ContradictionSettings;
  search: SearchSettings;
  structure: StructureSettings;
  summaries: SummariesSettings;
  domains: DomainSetting[];
  golden: GoldenSettings;
  verification: VerificationSettings;
}

export function defaultSettings(): PrimeRadiantSettings {
  return {
    ingest: { exclude: [...DEFAULT_INGEST_EXCLUDES], skipCodeProjects: true, parallel: DEFAULT_INGEST_PARALLEL, folders: [] },
    costRates: {},
    nightly: { enabled: true, time: DEFAULT_NIGHTLY_TIME },
    opus: { enabled: false, capUsd: DEFAULT_OPUS_CAP_USD, sampleRate: DEFAULT_OPUS_SAMPLE_RATE, model: DEFAULT_OPUS_MODEL, maxPages: DEFAULT_OPUS_MAX_PAGES },
    contradictions: { enabled: true },
    search: { indexLimitMb: DEFAULT_SEARCH_INDEX_LIMIT_MB },
    structure: { enabled: true, company: "", enrichTop: DEFAULT_STRUCTURE_ENRICH_TOP, modelFallback: DEFAULT_STRUCTURE_MODEL_FALLBACK },
    summaries: { enabled: true, maxPages: DEFAULT_SUMMARIES_MAX_PAGES, capUsd: DEFAULT_SUMMARIES_CAP_USD },
    domains: [],
    golden: { enabled: true, maxQuestions: DEFAULT_GOLDEN_MAX_QUESTIONS },
    verification: { perOwner: DEFAULT_DAILY_PER_OWNER, outbound: false, languages: [] },
  };
}

export function settingsPath(root: string = primeRadiantRoot()): string {
  return path.join(root, SETTINGS_FILE);
}

function readParallel(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_INGEST_PARALLEL && v <= MAX_INGEST_PARALLEL ? v : null;
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

function section(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
}

function readFolders(v: unknown): Read<string[]> {
  if (!Array.isArray(v) || v.length > MAX_INGEST_FOLDERS) {
    return { ok: false, error: `folders must be a list of at most ${MAX_INGEST_FOLDERS} folders.` };
  }
  const out: string[] = [];
  for (const f of v) {
    if (typeof f !== "string" || !path.isAbsolute(f) || f.length > MAX_FOLDER_CHARS || f.includes("\0")) {
      return { ok: false, error: "Every folder must be an absolute path." };
    }
    const norm = path.resolve(f);
    if (!out.includes(norm)) out.push(norm);
  }
  return { ok: true, value: out };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseNightlyTime(time: string): { hour: number; minute: number } | null {
  const m = TIME_RE.exec(time);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

function readBool(v: unknown, field: string): Read<boolean> {
  return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: `${field} must be true or false.` };
}

function readNumber(v: unknown, min: number, max: number, field: string): Read<number> {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? { ok: true, value: v }
    : { ok: false, error: `${field} must be a number from ${min} to ${max}.` };
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const DOMAIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readDomains(v: unknown): Read<DomainSetting[]> {
  if (!Array.isArray(v) || v.length > MAX_DOMAINS) return { ok: false, error: `domains must be a list of at most ${MAX_DOMAINS}.` };
  const out: DomainSetting[] = [];
  for (const d of v) {
    const o = section(d);
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const owner = typeof o.owner === "string" ? o.owner.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (!DOMAIN_RE.test(name) || name.length > 64) return { ok: false, error: "A domain name must be lowercase kebab-case (e.g. sales-ops)." };
    if (owner === "" || owner.length > MAX_OWNER_CHARS) return { ok: false, error: `A domain owner must be 1 to ${MAX_OWNER_CHARS} characters.` };
    if (out.some((x) => x.name === name)) return { ok: false, error: `The domain ${name} is listed twice.` };
    out.push({ name, owner });
  }
  return { ok: true, value: out };
}

function readOwnerLanguages(v: unknown): Read<OwnerLanguage[]> {
  if (!Array.isArray(v) || v.length > MAX_OWNER_LANGUAGES) return { ok: false, error: `verification.languages must be a list of at most ${MAX_OWNER_LANGUAGES}.` };
  const out: OwnerLanguage[] = [];
  for (const entry of v) {
    const o = section(entry);
    const owner = typeof o.owner === "string" ? o.owner.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (owner === "" || owner.length > MAX_OWNER_CHARS) return { ok: false, error: `An owner must be 1 to ${MAX_OWNER_CHARS} characters.` };
    if (!isDailyLanguage(o.language)) return { ok: false, error: `A language must be one of ${DAILY_LANGUAGES.join(", ")}.` };
    if (out.some((x) => x.owner.toLowerCase() === owner.toLowerCase())) return { ok: false, error: `The owner ${owner} is listed twice.` };
    out.push({ owner, language: o.language });
  }
  return { ok: true, value: out };
}

/**
 * Each field a section may carry, read strictly. The same readers serve the
 * file (a bad field reads as its default) and a patch (a bad field refuses
 * the whole patch).
 */
const FIELDS = {
  nightly: {
    enabled: (v: unknown) => readBool(v, "nightly.enabled"),
    time: (v: unknown): Read<string> =>
      typeof v === "string" && parseNightlyTime(v) ? { ok: true, value: v } : { ok: false, error: "nightly.time must be HH:MM (24 h)." },
  },
  opus: {
    enabled: (v: unknown) => readBool(v, "opus.enabled"),
    capUsd: (v: unknown) => readNumber(v, MIN_OPUS_CAP_USD, MAX_OPUS_CAP_USD, "opus.capUsd"),
    sampleRate: (v: unknown) => readNumber(v, 0, 1, "opus.sampleRate"),
    model: (v: unknown): Read<string> =>
      typeof v === "string" && MODEL_RE.test(v) ? { ok: true, value: v } : { ok: false, error: "opus.model is not a model id." },
    maxPages: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= MIN_OPUS_MAX_PAGES && v <= MAX_OPUS_MAX_PAGES
        ? { ok: true, value: v }
        : { ok: false, error: `opus.maxPages must be a whole number from ${MIN_OPUS_MAX_PAGES} to ${MAX_OPUS_MAX_PAGES}.` },
  },
  contradictions: {
    enabled: (v: unknown) => readBool(v, "contradictions.enabled"),
  },
  search: {
    indexLimitMb: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= MIN_SEARCH_INDEX_LIMIT_MB && v <= MAX_SEARCH_INDEX_LIMIT_MB
        ? { ok: true, value: v }
        : { ok: false, error: `search.indexLimitMb must be a whole number of MB from ${MIN_SEARCH_INDEX_LIMIT_MB} to ${MAX_SEARCH_INDEX_LIMIT_MB}.` },
  },
  golden: {
    enabled: (v: unknown) => readBool(v, "golden.enabled"),
    maxQuestions: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= MIN_GOLDEN_MAX_QUESTIONS && v <= MAX_GOLDEN_MAX_QUESTIONS
        ? { ok: true, value: v }
        : { ok: false, error: `golden.maxQuestions must be a whole number from ${MIN_GOLDEN_MAX_QUESTIONS} to ${MAX_GOLDEN_MAX_QUESTIONS}.` },
  },
  verification: {
    perOwner: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= MIN_DAILY_PER_OWNER && v <= MAX_DAILY_PER_OWNER
        ? { ok: true, value: v }
        : { ok: false, error: `verification.perOwner must be a whole number from ${MIN_DAILY_PER_OWNER} to ${MAX_DAILY_PER_OWNER}.` },
    outbound: (v: unknown) => readBool(v, "verification.outbound"),
    languages: (v: unknown) => readOwnerLanguages(v),
  },
  structure: {
    enabled: (v: unknown) => readBool(v, "structure.enabled"),
    company: (v: unknown): Read<string> => {
      const clean = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : null;
      return clean !== null && clean.length <= MAX_COMPANY_CHARS
        ? { ok: true, value: clean }
        : { ok: false, error: `structure.company must be text of at most ${MAX_COMPANY_CHARS} characters.` };
    },
    enrichTop: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_STRUCTURE_ENRICH_TOP
        ? { ok: true, value: v }
        : { ok: false, error: `structure.enrichTop must be a whole number from 0 to ${MAX_STRUCTURE_ENRICH_TOP}.` },
    modelFallback: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_STRUCTURE_MODEL_FALLBACK
        ? { ok: true, value: v }
        : { ok: false, error: `structure.modelFallback must be a whole number from 0 to ${MAX_STRUCTURE_MODEL_FALLBACK}.` },
  },
  summaries: {
    enabled: (v: unknown) => readBool(v, "summaries.enabled"),
    maxPages: (v: unknown): Read<number> =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_SUMMARIES_MAX_PAGES
        ? { ok: true, value: v }
        : { ok: false, error: `summaries.maxPages must be a whole number from 0 to ${MAX_SUMMARIES_MAX_PAGES}.` },
    capUsd: (v: unknown) => readNumber(v, 0, MAX_SUMMARIES_CAP_USD, "summaries.capUsd"),
  },
} as const;

type SectionName = keyof typeof FIELDS;

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
    if (list.ok && !isDefaultExcludeList(list.patterns, ingest.excludeSavedWith)) out.ingest.exclude = list.patterns;
  }
  if (typeof ingest.skipCodeProjects === "boolean") out.ingest.skipCodeProjects = ingest.skipCodeProjects;
  const parallel = readParallel(ingest.parallel);
  if (parallel !== null) out.ingest.parallel = parallel;
  if (ingest.folders !== undefined) {
    const folders = readFolders(ingest.folders);
    if (folders.ok) out.ingest.folders = folders.value;
  }
  const rates = readRateOverrides(raw.costRates);
  if (rates.ok) out.costRates = rates.models;
  for (const name of Object.keys(FIELDS) as SectionName[]) {
    const stored = section(raw[name]);
    const target = out[name] as unknown as Record<string, unknown>;
    for (const [key, reader] of Object.entries(FIELDS[name]) as Array<[string, (v: unknown) => Read<unknown>]>) {
      if (stored[key] === undefined) continue;
      const r = reader(stored[key]);
      if (r.ok) target[key] = r.value;
    }
  }
  if (raw.domains !== undefined) {
    const domains = readDomains(raw.domains);
    if (domains.ok) out.domains = domains.value;
  }
  return out;
}

/** The cost rates in force: defaults with the owner's overrides. */
export function effectiveCostRates(root: string = primeRadiantRoot()): CostRates {
  return mergeCostRates(readSettings(root).costRates);
}

export interface SettingsPatch {
  ingest?: { exclude?: unknown; skipCodeProjects?: unknown; parallel?: unknown; folders?: unknown };
  costRates?: unknown;
  nightly?: { enabled?: unknown; time?: unknown } | null;
  opus?: { enabled?: unknown; capUsd?: unknown; sampleRate?: unknown; model?: unknown; maxPages?: unknown } | null;
  contradictions?: { enabled?: unknown } | null;
  search?: { indexLimitMb?: unknown } | null;
  structure?: { enabled?: unknown; company?: unknown; enrichTop?: unknown; modelFallback?: unknown } | null;
  summaries?: { enabled?: unknown; maxPages?: unknown; capUsd?: unknown } | null;
  domains?: unknown;
  golden?: { enabled?: unknown; maxQuestions?: unknown } | null;
  verification?: { perOwner?: unknown; outbound?: unknown; languages?: unknown } | null;
}

/** The keys a patch may carry, per section — anything else is refused, never stored. */
const PATCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  ingest: ["exclude", "skipCodeProjects", "parallel", "folders"],
  nightly: Object.keys(FIELDS.nightly),
  opus: Object.keys(FIELDS.opus),
  contradictions: Object.keys(FIELDS.contradictions),
  search: Object.keys(FIELDS.search),
  golden: Object.keys(FIELDS.golden),
  verification: Object.keys(FIELDS.verification),
  structure: Object.keys(FIELDS.structure),
  summaries: Object.keys(FIELDS.summaries),
};

/** The vault search index's size limit in force, in bytes (shard-index.ts reads it at every run). */
export function searchIndexLimitBytes(root: string = primeRadiantRoot(), totalMem: number = os.totalmem()): number {
  const asked = readSettings(root).search.indexLimitMb * BYTES_PER_MB;
  // Search holds the whole index in memory: never more than a quarter of the
  // box's RAM, whatever was saved (a 4,096 MB limit on an 8 GB box stays 2 GB).
  const ceiling = Math.max(MIN_SEARCH_INDEX_LIMIT_MB * BYTES_PER_MB, Math.floor(totalMem / 4));
  return Math.min(asked, ceiling);
}

/** A patch as a route received it: only known sections and keys. Throws {@link SettingsError}. */
export function readSettingsPatch(body: unknown): SettingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsError("Send the settings to change as an object.");
  const b = body as Record<string, unknown>;
  const allowed = new Set([...Object.keys(PATCH_KEYS), "costRates", "domains"]);
  for (const key of Object.keys(b)) if (!allowed.has(key)) throw new SettingsError(`Unknown setting: ${key.slice(0, 40)}.`);
  for (const [name, keys] of Object.entries(PATCH_KEYS)) {
    const v = b[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object" || Array.isArray(v)) throw new SettingsError(`${name} must be an object.`);
    for (const key of Object.keys(v)) if (!keys.includes(key)) throw new SettingsError(`Unknown setting: ${name}.${key.slice(0, 40)}.`);
  }
  if (b.ingest === null) throw new SettingsError("ingest cannot be reset as a whole; reset its fields.");
  return b as SettingsPatch;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/**
 * Apply a patch: each field given is validated strictly and replaces the
 * stored one (`exclude: null` / `costRates: null` put the defaults back; an
 * exclude list equal to a default list does too).
 * A bad field refuses the whole patch ({@link SettingsError}) and writes
 * nothing. Written atomically, 0600.
 */
export function writeSettings(patch: SettingsPatch, root: string = primeRadiantRoot()): PrimeRadiantSettings {
  const raw = readRaw(root);
  const next: Record<string, unknown> = { ...raw };
  const ingest = { ...((raw.ingest && typeof raw.ingest === "object" ? raw.ingest : {}) as Record<string, unknown>) };
  if (patch.ingest) {
    if (patch.ingest.exclude === null) {
      delete ingest.exclude;
      delete ingest.excludeSavedWith;
    } else if (patch.ingest.exclude !== undefined) {
      const list = readExcludeList(patch.ingest.exclude);
      if (!list.ok) throw new SettingsError(list.error);
      // Today's defaults are not stored: they keep following ClawBox's list.
      // Any other list — an earlier default included — is the owner's choice
      // now, and says so, so it is never read as an untouched copy.
      if (isDefaultExcludeList(list.patterns, EXCLUDE_DEFAULTS_GENERATION)) {
        delete ingest.exclude;
        delete ingest.excludeSavedWith;
      } else {
        ingest.exclude = list.patterns;
        ingest.excludeSavedWith = EXCLUDE_DEFAULTS_GENERATION;
      }
    }
    if (patch.ingest.skipCodeProjects === null) delete ingest.skipCodeProjects;
    else if (patch.ingest.skipCodeProjects !== undefined) {
      const r = readBool(patch.ingest.skipCodeProjects, "ingest.skipCodeProjects");
      if (!r.ok) throw new SettingsError(r.error);
      ingest.skipCodeProjects = r.value;
    }
    if (patch.ingest.parallel === null) delete ingest.parallel;
    else if (patch.ingest.parallel !== undefined) {
      const parallel = readParallel(patch.ingest.parallel);
      if (parallel === null) {
        throw new SettingsError(`parallel must be a whole number from ${MIN_INGEST_PARALLEL} to ${MAX_INGEST_PARALLEL}.`);
      }
      ingest.parallel = parallel;
    }
    if (patch.ingest.folders === null) delete ingest.folders;
    else if (patch.ingest.folders !== undefined) {
      const folders = readFolders(patch.ingest.folders);
      if (!folders.ok) throw new SettingsError(folders.error);
      ingest.folders = folders.value;
    }
    next.ingest = ingest;
  }
  for (const name of Object.keys(FIELDS) as SectionName[]) {
    const p = patch[name];
    if (p === undefined) continue;
    if (p === null) {
      delete next[name];
      continue;
    }
    const stored = { ...section(raw[name]) };
    for (const [key, reader] of Object.entries(FIELDS[name]) as Array<[string, (v: unknown) => Read<unknown>]>) {
      const v = (p as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (v === null) {
        delete stored[key];
        continue;
      }
      const r = reader(v);
      if (!r.ok) throw new SettingsError(r.error);
      stored[key] = r.value;
    }
    next[name] = stored;
  }
  if (patch.domains === null) delete next.domains;
  else if (patch.domains !== undefined) {
    const domains = readDomains(patch.domains);
    if (!domains.ok) throw new SettingsError(domains.error);
    next.domains = domains.value;
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
