// Server-only (fs) enumeration of installed Hermes skills. Kept apart from the
// pure `hermes-skills.ts` validators so the client component can import the
// types without pulling `fs` into the browser bundle.
//
// On-disk sources (all verified against a real device):
//   (a) ~/.hermes/skills/.hub/lock.json — AUTHORITATIVE for hub-installed
//       skills. Keyed by skill name; each entry carries source, identifier,
//       trust_level, scan_verdict, content_hash, install_path, files[],
//       metadata{}, scan_provenance{} (the FULL scan report, findings and all),
//       installed_at and updated_at.
//   (b) ~/.hermes/skills/<category>/**/SKILL.md — bundled + agent-created
//       skills, with YAML frontmatter. Nesting can exceed 2 levels, so we walk
//       for SKILL.md up to a small max depth.
//   (c) ~/.hermes/skills/.bundled_manifest — `name:hash` per line, the list of
//       skills that SHIPPED with the device. It's what separates a built-in
//       skill from one the agent wrote itself.
//   (d) ~/.hermes/hermes-agent/optional-skills/** — the on-disk copy of every
//       `official` skill, installed or not. Lets the detail view show a real,
//       untruncated SKILL.md for official skills without touching the CLI.
// Internal dot-dirs (.hub) and the dotfiles are skipped by the walk.

import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import type { InstalledHermesSkill, ScanFinding, SkillOrigin } from '@/lib/hermes-skills';
import { parseSkillFrontmatter, type SkillFrontmatter } from '@/lib/hermes-skill-frontmatter';
import { getActiveHarness } from '@/lib/harness';

/**
 * Defense-in-depth gate for the skills-store routes: the store is a Hermes
 * feature, so refuse when the active harness isn't Hermes. Returns a 404
 * response to return early, or null to proceed. (On a dual box Hermes is
 * installed, so without this the CLI would run even with the store UI hidden.)
 */
export async function hermesSkillsGuard(): Promise<NextResponse | null> {
  if ((await getActiveHarness()) !== 'hermes') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return null;
}

export const HERMES_HOME =
  process.env.HERMES_HOME || path.join(process.env.HOME || '/home/clawbox', '.hermes');
export const SKILLS_DIR = path.join(HERMES_HOME, 'skills');
const HUB_DIR = path.join(SKILLS_DIR, '.hub');
const HUB_LOCK_PATH = path.join(HUB_DIR, 'lock.json');
const SCAN_CACHE_DIR = path.join(HUB_DIR, 'scan-cache');
const BUNDLED_MANIFEST_PATH = path.join(SKILLS_DIR, '.bundled_manifest');
// Root of the Hermes agent checkout — `official` skills live under
// <root>/optional-skills/<category>/<skill>/SKILL.md and the catalog index
// stores exactly that relative path.
const AGENT_ROOT = path.join(HERMES_HOME, 'hermes-agent');

const MAX_MD_BYTES = 512 * 1024;
const MAX_DIR_ENTRIES = 2000;
const MAX_DIR_DEPTH = 4;

export interface HubLockEntry {
  source?: string;
  identifier?: string;
  trust_level?: string;
  scan_verdict?: string;
  content_hash?: string;
  install_path?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
  scan_provenance?: Record<string, unknown>;
  installed_at?: string;
  updated_at?: string;
  name?: string;
}

interface HubLock {
  version?: number;
  installed?: Record<string, HubLockEntry>;
}

/** Read the authoritative hub lock file. Missing/unparsable → empty. */
export async function readHubLock(): Promise<Record<string, HubLockEntry>> {
  try {
    const raw = await fs.readFile(HUB_LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw) as HubLock;
    return parsed && typeof parsed.installed === 'object' && parsed.installed ? parsed.installed : {};
  } catch {
    return {};
  }
}

/** True when a skill matching `name` OR `identifier` is present in the lock. */
export async function isInHubLock(name: string, identifier?: string): Promise<boolean> {
  const installed = await readHubLock();
  if (Object.prototype.hasOwnProperty.call(installed, name)) return true;
  if (identifier) {
    for (const e of Object.values(installed)) {
      if (e.identifier === identifier) return true;
    }
  }
  return false;
}

/** Resolve the lock key (the `uninstall` argument) for an identifier or name. */
export async function resolveLockKey(idOrName: string): Promise<string | null> {
  const lock = await readHubLock();
  if (Object.prototype.hasOwnProperty.call(lock, idOrName)) return idOrName;
  for (const [key, entry] of Object.entries(lock)) {
    if (entry.identifier === idOrName) return key;
  }
  return null;
}

/**
 * Names of the skills that shipped with the device (`.bundled_manifest` is
 * `name:hash` per line). Anything on disk that is neither here nor in the lock
 * was created locally — usually by the agent itself.
 */
export async function readBundledManifestNames(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const raw = await fs.readFile(BUNDLED_MANIFEST_PATH, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const name = line.split(':')[0].trim();
      if (name) out.add(name);
    }
  } catch {
    /* no manifest → nothing is provably bundled */
  }
  return out;
}

// readdir(withFileTypes) that yields [] instead of throwing on a missing dir.
async function readDirSafe(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readTextCapped(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_MD_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// Resolve a path that came from lock data / the catalog index INSIDE a root,
// refusing anything that escapes it. Both inputs are attacker-controlled in
// principle (a poisoned lock entry, a hostile 41 MB registry index), so this is
// the only way either value is allowed to touch the filesystem.
function resolveInside(root: string, relative: string): string | null {
  const rel = relative.replace(/^[/\\]+/, '');
  if (!rel) return null;
  const abs = path.resolve(root, rel);
  const prefix = path.resolve(root) + path.sep;
  return abs === path.resolve(root) || abs.startsWith(prefix) ? abs : null;
}

export interface SkillDirStats {
  files: number;
  bytes: number;
  /** Sub-directories that carry the skill's payload (references/, scripts/…). */
  supportDirs: string[];
}

/**
 * Size a skill directory. Depth- and entry-capped so a pathological tree can't
 * stall a request; only ever called for ONE skill (the detail view), never per
 * card.
 */
export async function statSkillDir(absDir: string): Promise<SkillDirStats> {
  const stats: SkillDirStats = { files: 0, bytes: 0, supportDirs: [] };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DIR_DEPTH || stats.files >= MAX_DIR_ENTRIES) return;
    for (const entry of await readDirSafe(dir)) {
      if (stats.files >= MAX_DIR_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && !entry.name.startsWith('.')) stats.supportDirs.push(entry.name);
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        stats.files++;
        try {
          stats.bytes += (await fs.stat(full)).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  await walk(absDir, 0);
  stats.supportDirs.sort();
  return stats;
}

/**
 * Read the on-disk SKILL.md of an `official` skill using the catalog index's
 * relative `path` (e.g. `optional-skills/security/1password`). Lets the detail
 * view show the FULL text of an official skill before it's installed — no CLI,
 * no truncation. Returns null when the path escapes the agent root or is absent.
 */
export async function readOfficialSkillMarkdown(indexPath: string): Promise<string | null> {
  if (typeof indexPath !== 'string' || !indexPath || indexPath.length > 300) return null;
  const dir = resolveInside(AGENT_ROOT, indexPath);
  if (!dir) return null;
  return readTextCapped(path.join(dir, 'SKILL.md'));
}

/** One `official` skill as it exists on THIS device, not as the index saw it. */
export interface OfficialSkillOnDisk {
  /** Registry identifier — `official/<category>/<name>`. */
  id: string;
  /** Path the index stores — `optional-skills/<category>/<name>`. */
  path: string;
  name: string;
  category: string;
  description?: string;
  tags: string[];
}

const OFFICIAL_ROOT = path.join(AGENT_ROOT, 'optional-skills');
const MAX_OFFICIAL_SKILLS = 400;

/**
 * Enumerate the `official` skills from the agent checkout
 * (`optional-skills/<category>/<skill>/SKILL.md`). The catalog index is
 * published upstream and lags this directory: on a real device 9 official
 * skills exist on disk but not in the index (invisible in Browse) and 1 index
 * row points at a directory that is gone, while 70 of the 104 shared rows carry
 * a description Hermes hard-truncated at 200 chars. The files are the truth for
 * all three, and reading ~110 of them costs about as much as the installed walk.
 */
export async function enumerateOfficialSkills(): Promise<OfficialSkillOnDisk[]> {
  const out: OfficialSkillOnDisk[] = [];
  for (const cat of await readDirSafe(OFFICIAL_ROOT)) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue;
    const catDir = path.join(OFFICIAL_ROOT, cat.name);
    for (const skill of await readDirSafe(catDir)) {
      if (!skill.isDirectory() || skill.name.startsWith('.')) continue;
      if (out.length >= MAX_OFFICIAL_SKILLS) return out;
      const md = await readTextCapped(path.join(catDir, skill.name, 'SKILL.md'));
      if (md === null) continue;
      const fm = parseSkillFrontmatter(md);
      out.push({
        id: `official/${cat.name}/${skill.name}`,
        path: `optional-skills/${cat.name}/${skill.name}`,
        name: fm.name || skill.name,
        category: cat.name,
        description: fm.description,
        tags: fm.tags.slice(0, 8),
      });
    }
  }
  return out;
}

export interface ScanReport {
  verdict?: string;
  scannerVersion?: string;
  scannedAt?: string;
  summary?: string;
  findings: ScanFinding[];
}

function normalizeFindings(raw: unknown): ScanFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanFinding[] = [];
  for (const item of raw.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    out.push({
      patternId: typeof f.pattern_id === 'string' ? f.pattern_id.slice(0, 80) : undefined,
      severity: typeof f.severity === 'string' ? f.severity.slice(0, 20) : undefined,
      category: typeof f.category === 'string' ? f.category.slice(0, 40) : undefined,
      file: typeof f.file === 'string' ? f.file.slice(0, 200) : undefined,
      line: typeof f.line === 'number' && f.line >= 0 ? f.line : undefined,
      description: typeof f.description === 'string' ? f.description.slice(0, 300) : undefined,
    });
  }
  return out;
}

function toScanReport(raw: Record<string, unknown> | undefined): ScanReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const findings = normalizeFindings(raw.findings);
  const verdict = typeof raw.verdict === 'string' ? raw.verdict.slice(0, 40) : undefined;
  if (!verdict && findings.length === 0) return null;
  return {
    verdict,
    scannerVersion: typeof raw.scanner_version === 'string' ? raw.scanner_version.slice(0, 40) : undefined,
    scannedAt: typeof raw.scanned_at === 'string' ? raw.scanned_at.slice(0, 40) : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 300) : undefined,
    findings,
  };
}

/** The lock's own `scan_provenance` — the installer's full report, verbatim. */
export function scanReportFromLock(entry: HubLockEntry | undefined): ScanReport | null {
  return toScanReport(entry?.scan_provenance);
}

/**
 * Fallback scan report from ~/.hermes/skills/.hub/scan-cache. Files are named
 * `<full-content-digest>-<source-identity>.json`; the lock's `content_hash` is
 * `sha256:<first 16 hex of that same digest>`, so a prefix match finds it. The
 * hash is charset-validated before it is used to filter names — never
 * interpolated into a path.
 */
export async function readScanReport(contentHash: string | undefined): Promise<ScanReport | null> {
  if (!contentHash) return null;
  const hex = contentHash.replace(/^sha256:/i, '').toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(hex)) return null;
  for (const entry of await readDirSafe(SCAN_CACHE_DIR)) {
    if (!entry.isFile() || !entry.name.startsWith(hex) || !entry.name.endsWith('.json')) continue;
    const raw = await readTextCapped(path.join(SCAN_CACHE_DIR, entry.name));
    if (!raw) continue;
    try {
      return toScanReport(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  return null;
}

const COMMAND_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Is each prerequisite command actually on PATH? Uses fs.access(X_OK) over the
 * PATH entries — deliberately NOT `which`/spawn, so a frontmatter value can
 * never reach a process. Names are charset-validated first.
 */
export async function probeCommands(commands: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const dirs = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter).filter(Boolean);
  for (const raw of commands.slice(0, 12)) {
    const cmd = raw.trim();
    if (!COMMAND_RE.test(cmd)) continue;
    let found = false;
    for (const dir of dirs.slice(0, 32)) {
      try {
        await fs.access(path.join(dir, cmd), fs.constants.X_OK);
        found = true;
        break;
      } catch {
        /* keep looking */
      }
    }
    out[cmd] = found;
  }
  return out;
}

// ── Installed-skill enumeration ─────────────────────────────────────────────

interface DiskSkill {
  name: string;
  dir: string;
  category: string;
  frontmatter: SkillFrontmatter;
}

async function walkForSkillMd(
  dir: string,
  topCategory: string,
  depth: number,
  out: DiskSkill[],
): Promise<void> {
  if (depth > MAX_DIR_DEPTH) return;
  const entries = await readDirSafe(dir);
  const hasSkill = entries.some((e) => e.isFile() && e.name === 'SKILL.md');
  if (hasSkill) {
    const md = await readTextCapped(path.join(dir, 'SKILL.md'));
    out.push({
      name: path.basename(dir),
      dir,
      category: topCategory,
      frontmatter: parseSkillFrontmatter(md || ''),
    });
    return; // a skill dir is a leaf — don't descend into its references/
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue; // skip .hub and other dot-dirs
    await walkForSkillMd(path.join(dir, e.name), topCategory, depth + 1, out);
  }
}

// The walk reads ~77 SKILL.md files. That is ~15 ms and fine per request, but
// the installed tab and a detail open can ask for it twice in a row, so the
// result is cached briefly and dropped explicitly after an install/uninstall.
let walkCache: { key: string; value: DiskSkill[] } | null = null;
let walkCacheAt = 0;

async function walkAllSkillDirs(): Promise<DiskSkill[]> {
  const key = await installedCacheKey();
  if (walkCache && walkCache.key === key && Date.now() - walkCacheAt < INSTALLED_TTL_MS) {
    return walkCache.value;
  }
  const found: DiskSkill[] = [];
  for (const d of await readDirSafe(SKILLS_DIR)) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    await walkForSkillMd(path.join(SKILLS_DIR, d.name), d.name, 1, found);
  }
  walkCache = { key, value: found };
  walkCacheAt = Date.now();
  return found;
}

function platformIncompatible(platforms: string[]): boolean {
  // No declaration means "anywhere". A declaration that omits linux means the
  // skill cannot run on this device — the single most useful card-level fact.
  return platforms.length > 0 && !platforms.includes('linux');
}

let installedCache: { key: string; value: InstalledHermesSkill[] } | null = null;
const INSTALLED_TTL_MS = 10_000;
let installedCacheAt = 0;

/** Drop the installed-skill caches — called right after an install/uninstall. */
export function invalidateInstalledCache(): void {
  installedCache = null;
  installedCacheAt = 0;
  walkCache = null;
  walkCacheAt = 0;
}

async function installedCacheKey(): Promise<string> {
  const stat = async (p: string) => {
    try {
      const s = await fs.stat(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '-';
    }
  };
  return `${await stat(HUB_LOCK_PATH)}|${await stat(SKILLS_DIR)}`;
}

/**
 * Enumerate every installed skill with the detail the cards show. The disk walk
 * supplies frontmatter (description, platforms, tags); the hub lock overlays
 * identifier/trust/scan-verdict/timestamps for anything installed from the
 * store; `.bundled_manifest` decides builtin vs local.
 *
 * Cached on (lock mtime, skills-dir mtime) for a few seconds so the tab switch
 * and the post-install refresh don't re-walk the tree twice in a row.
 */
export async function enumerateInstalledSkills(): Promise<InstalledHermesSkill[]> {
  const key = await installedCacheKey();
  if (installedCache && installedCache.key === key && Date.now() - installedCacheAt < INSTALLED_TTL_MS) {
    return installedCache.value;
  }

  const [disk, lock, bundled] = await Promise.all([
    walkAllSkillDirs(),
    readHubLock(),
    readBundledManifestNames(),
  ]);

  const byName = new Map<string, InstalledHermesSkill>();
  for (const s of disk) {
    const fm = s.frontmatter;
    const isBundled = bundled.has(s.name);
    byName.set(s.name, {
      id: s.name,
      name: fm.name || s.name,
      // The install directory is the truth for category (100 % coverage);
      // metadata.hermes.category only fills in when the dir is uninformative.
      category: s.category || fm.category || 'other',
      description: fm.description,
      source: 'builtin',
      // A skill that SHIPPED with the device is as trusted as it gets. Without
      // this the card badges "Unknown" while its own detail page (which applies
      // exactly this default) badges "Official" — the same skill, two answers.
      trust: isBundled ? 'builtin' : undefined,
      origin: isBundled ? 'builtin' : 'local',
      platforms: fm.platforms.length ? fm.platforms : undefined,
      tags: fm.tags.length ? fm.tags.slice(0, 6) : undefined,
      incompatible: platformIncompatible(fm.platforms),
      enabled: true,
    });
  }

  for (const [name, entry] of Object.entries(lock)) {
    const existing = byName.get(name);
    const report = scanReportFromLock(entry);
    const category = entry.install_path ? entry.install_path.split('/')[0] : existing?.category || 'hub';
    byName.set(name, {
      id: name,
      name: entry.name || existing?.name || name,
      category: existing?.category || category,
      description: existing?.description,
      source: entry.source || 'hub',
      identifier: entry.identifier,
      trust: entry.trust_level,
      scanVerdict: entry.scan_verdict,
      scanFindingCount: report ? report.findings.length : undefined,
      origin: 'hub',
      installedAt: entry.installed_at,
      updatedAt: entry.updated_at,
      fileCount: Array.isArray(entry.files) ? entry.files.length : existing?.fileCount,
      platforms: existing?.platforms,
      tags: existing?.tags,
      incompatible: existing?.incompatible,
      enabled: true,
    });
  }

  const value = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  installedCache = { key, value };
  installedCacheAt = Date.now();
  return value;
}

export interface InstalledSkillLocation {
  /** lock.json key / directory name — the `uninstall` argument. */
  name: string;
  dir: string;
  category: string;
  markdown: string;
  origin: SkillOrigin;
  lock?: HubLockEntry;
}

/**
 * Locate an installed skill by identifier OR name and read its FULL SKILL.md
 * off disk (the `inspect` CLI preview is truncated and drops list fields).
 * Returns null when the skill isn't installed — the caller falls back to the
 * catalog record and, only then, to the CLI.
 *
 * `allowNameFallback` decides whether a bare NAME may resolve to a skill
 * directory of that name. It must only be set when the caller already knows the
 * value came from the installed list, because registry identifiers collide with
 * directory names: 69 150 clawhub rows carry a bare identifier and 40 of them
 * are byte-identical to a bundled skill's directory (`notion`, `arxiv`, `pdf`…).
 * Resolving those by basename would paint a bundled skill's version, author,
 * license and "Official" trust badge onto an unrelated community skill.
 */
export async function findInstalledSkill(
  idOrName: string,
  { allowNameFallback = false }: { allowNameFallback?: boolean } = {},
): Promise<InstalledSkillLocation | null> {
  const lock = await readHubLock();

  let key: string | undefined;
  let entry: HubLockEntry | undefined;
  if (Object.prototype.hasOwnProperty.call(lock, idOrName)) {
    key = idOrName;
    entry = lock[idOrName];
  } else {
    for (const [k, e] of Object.entries(lock)) {
      if (e.identifier === idOrName) {
        key = k;
        entry = e;
        break;
      }
    }
  }

  if (entry?.install_path) {
    const dir = resolveInside(SKILLS_DIR, entry.install_path);
    if (dir) {
      const markdown = await readTextCapped(path.join(dir, 'SKILL.md'));
      if (markdown !== null) {
        return {
          name: key || idOrName,
          dir,
          category: entry.install_path.split('/')[0] || 'hub',
          markdown,
          origin: 'hub',
          lock: entry,
        };
      }
    }
  }

  // Not in the lock (or its path is stale) → look for a leaf skill dir whose
  // basename matches. A lock hit (`key`) always earns this; a raw request only
  // does when the caller vouched that it is an installed-skill name.
  if (!key && !allowNameFallback) return null;
  const target = key || idOrName.split('/').pop() || idOrName;
  const disk = await walkAllSkillDirs();
  const hit = disk.find((s) => s.name === target);
  if (!hit) return null;
  const markdown = await readTextCapped(path.join(hit.dir, 'SKILL.md'));
  if (markdown === null) return null;
  const bundled = await readBundledManifestNames();
  return {
    name: hit.name,
    dir: hit.dir,
    category: hit.category,
    markdown,
    origin: bundled.has(hit.name) ? 'builtin' : 'local',
  };
}

/**
 * Back-compat wrapper kept for callers that only need the markdown + overlay.
 * (The store's inspect route uses findInstalledSkill directly.)
 */
export async function readInstalledSkillMarkdown(idOrName: string): Promise<{
  markdown: string;
  source?: string;
  trust?: string;
  scanVerdict?: string;
  category?: string;
} | null> {
  // Name-based by contract, so the basename fallback is in scope here.
  const hit = await findInstalledSkill(idOrName, { allowNameFallback: true });
  if (!hit) return null;
  return {
    markdown: hit.markdown,
    source: hit.lock?.source || (hit.origin === 'builtin' ? 'builtin' : 'local'),
    trust: hit.lock?.trust_level,
    scanVerdict: hit.lock?.scan_verdict,
    category: hit.category,
  };
}
