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
import { matchRemovableSkill } from '@/lib/hermes-skills';
import type { InstalledHermesSkill, ScanFinding, SkillOrigin } from '@/lib/hermes-skills';
import { parseSkillFrontmatter, type SkillFrontmatter } from '@/lib/hermes-skill-frontmatter';
import { removeSkillDir } from '@/lib/hermes-skill-manifest';
import { getActiveHarness } from '@/lib/harness';
import { hermesConfigGet } from '@/lib/hermes-config-cache';
import { isValidSkillName, MAX_FACET_SELECTION, REQUEST_REFUSAL } from '@/lib/hermes-skills';

/**
 * Defense-in-depth gate for the skills-store routes: the store is a Hermes
 * feature, so refuse when the active harness isn't Hermes. Returns a 404
 * response to return early, or null to proceed. (On a dual box Hermes is
 * installed, so without this the CLI would run even with the store UI hidden.)
 *
 * The body carries `code: 'not_hermes'` so a machine caller can tell this 404
 * apart from the ones the handlers themselves raise for an id they could not
 * find. Both are 404 with a JSON `error` string, and the MCP's generic mapping
 * reads any such body as "the id was wrong" — advice that sends the agent
 * round the same guard again, since every skills route sits behind it. The
 * status and the human-readable string are unchanged: the browser and
 * `src/middleware.ts` see exactly what they saw before.
 */
export async function hermesSkillsGuard(): Promise<NextResponse | null> {
  if ((await getActiveHarness()) !== 'hermes') {
    return NextResponse.json({ error: 'Not found', code: 'not_hermes' }, { status: 404 });
  }
  return null;
}

/**
 * The refusal a skills route answers when the CALLER's input is wrong.
 *
 * One shape for all of them, so a client can branch on the code and name the
 * field instead of string-matching the sentence. The sentence itself stays
 * exactly what it was — the browser's fallback, and the log's — and never
 * carries a value the caller sent, so a rejected input cannot be echoed back
 * into the page.
 */
export function invalidArgument(field: string, error: string): NextResponse {
  return NextResponse.json({ error, code: REQUEST_REFUSAL.invalidArgument, field }, { status: 400 });
}

/**
 * Its sibling for the one refusal that is not a bad value but too many good
 * ones. Separate because the remedy is: untick one, not correct one — and
 * because the rail renders up to MAX_FACET_VALUES options per group while the
 * route accepts MAX_FACET_SELECTION, so the owner can reach it by clicking.
 */
export function tooManyFacets(field: string): NextResponse {
  return NextResponse.json(
    {
      error: `Too many ${field} filters — at most ${MAX_FACET_SELECTION} at a time.`,
      code: REQUEST_REFUSAL.tooManyFacets,
      field,
      limit: MAX_FACET_SELECTION,
    },
    { status: 400 },
  );
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

/**
 * Read the authoritative hub lock file, keeping "could not read it" apart from
 * "it lists nothing".
 *
 * The same distinction `pathState` below makes, for the same reason. A lock
 * that is missing, truncated, mid-write, EACCES or EIO carries no information
 * about what is installed, and a caller that reads it as an empty lock
 * concludes that everything was removed. That is survivable behind a clean
 * `exit 0`; it is not behind a SIGKILL, where a partial write is exactly what
 * a deadline lands in the middle of.
 */
export async function readHubLockState(): Promise<
  { ok: true; installed: Record<string, HubLockEntry> } | { ok: false }
> {
  let raw: string;
  try {
    raw = await fs.readFile(HUB_LOCK_PATH, 'utf8');
  } catch (err) {
    // ENOENT is the only one that proves a lock does not exist — a device with
    // no store installs. Everything else is the file refusing to be read.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, installed: {} };
    return { ok: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // `typeof [] === 'object'`, so the array check is not pedantry: a lock that
    // parsed as an array would otherwise be read as a readable one with no
    // entries — the very "unreadable means everything went" answer this
    // function exists to refuse.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    const installed = (parsed as HubLock).installed;
    if (installed === undefined) return { ok: true, installed: {} };
    if (!installed || typeof installed !== 'object' || Array.isArray(installed)) return { ok: false };
    return { ok: true, installed };
  } catch {
    // Truncated or mid-write: the one shape that used to read as "empty".
    return { ok: false };
  }
}

/**
 * The lenient wrapper every existing caller uses: missing/unparsable → empty.
 * Correct wherever an unreadable lock and an empty one lead to the same safe
 * action (listing nothing, or reporting nothing installed) — and NOT correct
 * where the emptiness is taken as evidence that a removal happened; those
 * callers ask `readHubLockState` instead.
 */
export async function readHubLock(): Promise<Record<string, HubLockEntry>> {
  const state = await readHubLockState();
  return state.ok ? state.installed : {};
}

/**
 * The lock entry stored under exactly `key` in a lock ALREADY READ, or
 * undefined.
 *
 * Every lookup into `installed` goes through here because the key is caller
 * data: a plain `installed[key]` answers '__proto__', 'constructor' and
 * 'toString' out of Object.prototype even for a lock that lists none of them,
 * and an inherited member is not an installed skill.
 *
 * It takes the lock rather than reading one so a caller can ask about a
 * SNAPSHOT: the install route reads the lock before the CLI runs, to tell an
 * entry this request created from one that was already there, and a fresh
 * `readHubLock()` afterwards would answer about a file the CLI has rewritten.
 */
export function hubLockEntry(
  installed: Record<string, HubLockEntry>,
  key: string,
): HubLockEntry | undefined {
  if (!Object.prototype.hasOwnProperty.call(installed, key)) return undefined;
  const entry = new Map(Object.entries(installed)).get(key);
  return entry && typeof entry === 'object' ? entry : undefined;
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

/**
 * Every lock key whose entry records `identifier`, in lock order.
 *
 * Normally 0 or 1: a store id lands under one key. It can be more, because
 * `/setup-api/hermes/skills/install` passes a caller's `name` through to
 * `hermes skills install --name`, so one store id can be installed twice under
 * two keys. Only `resolveLockKey` reads this — it is naming a skill the install
 * route has just created, so the first is right there. The uninstall side is
 * deleting and goes through `matchRemovableSkill`, which refuses a tie.
 */
function lockKeysForIdentifier(
  installed: Record<string, HubLockEntry>,
  identifier: string,
): string[] {
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(installed)) {
    if (entry.identifier === identifier) keys.push(key);
  }
  return keys;
}

/** Resolve the lock key (the `uninstall` argument) for an identifier or name. */
export async function resolveLockKey(idOrName: string): Promise<string | null> {
  const lock = await readHubLock();
  if (Object.prototype.hasOwnProperty.call(lock, idOrName)) return idOrName;
  return lockKeysForIdentifier(lock, idOrName)[0] ?? null;
}

/**
 * The lock key an /uninstall argument names — key, store identifier or DISPLAY
 * name — or the keys it could not be told apart from.
 *
 * `hermes skills uninstall` resolves one string and one only: the lock key. The
 * three that reach this device for a single skill are not always the same
 * string, and the third one is the only one a customer ever sees. A ClawHub
 * install lands flat under its slug and records that slug as both the key and
 * the identifier (pinned by skills-install-clawhub.test.ts's fakeHermes) while its SKILL.md
 * names it whatever the author wrote: `martin-weather` in the lock, `weather`
 * on the card. The key and the identifier are the pass `resolveLockKey` makes
 * for the install route (its `lockName` resolution), on the same scan; the display
 * name is the one that route has no use for and this one cannot do without.
 *
 * Past the exact lock key the tiers are `matchRemovableSkill`'s, the same
 * function the agent's skill_uninstall applies to the same device state a
 * moment earlier — literally one rule, so the tool cannot refuse what this
 * resolves and cannot resolve what this refuses.
 *
 * A TIE IS ANSWERED, NEVER BROKEN, across every non-unique key and BETWEEN
 * them: two entries sharing an identifier, two rows showing one display name,
 * and one row's identifier equal to another row's display name. This ends in a
 * delete and nothing in the request says which was meant. An exact lock key is
 * not a tie — it is a JSON object key, unique by construction — so it settles
 * the question even when another card shows that same string.
 *
 * Only HUB rows are searched by display name, and a builtin sharing that name
 * does NOT block the hub row: a builtin cannot be removed under any string, so
 * the removable row is the only actionable reading, and it is the one the
 * Skills page and skill_uninstall have always acted on. What the caller passed
 * comes back in `requested` so a client can see that a display name was
 * resolved. A string nothing hub-installed answers to is returned unchanged, so
 * the builtin and not-installed answers downstream are what they were.
 */
export async function resolveUninstallKey(
  idOrName: string,
): Promise<{ key: string } | { ambiguous: string[] }> {
  const lock = await readHubLock();
  // The lock itself for tier 1, because it needs no disk walk and an unreadable
  // lock has to degrade to the pre-F-09 answer (the argument, straight through).
  if (Object.prototype.hasOwnProperty.call(lock, idOrName)) return { key: idOrName };
  const match = matchRemovableSkill(await enumerateInstalledSkills(), idOrName);
  if (match.kind === 'ambiguous') return { ambiguous: match.ids };
  return { key: match.kind === 'one' ? match.row.id : idOrName };
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

/**
 * Skill names Hermes has been told NOT to load, from `skills.disabled` (and the
 * per-platform `skills.platform_disabled` map) in ~/.hermes/config.yaml. The
 * agent honours these at load time — agent/skill_utils.py:437
 * `get_disabled_skill_names()`, consumed by skill_commands.py:483 — so a skill
 * on this list is installed but inert.
 *
 * Read through `hermes config get`, which is the same store the CLI writes and
 * is memoised on config.yaml's mtime, rather than parsing the YAML here: an
 * earlier attempt at ad-hoc YAML parsing in this repo was reverted for being
 * order-dependent (see hermes-config-cache.ts).
 *
 * The CLI has no `--json`, so the printed form of a list value is not
 * contractual. Parse tolerantly — JSON array, Python repr, or a separated list
 * — and drop anything that is not a valid skill name, so a surprise format can
 * only ever produce an EMPTY set (every skill reported enabled, which is the
 * status quo) and never phantom names.
 */
export function parseDisabledSkillList(raw: string): Set<string> {
  const out = new Set<string>();
  const text = (raw || '').trim();
  if (!text || /^config key not set/i.test(text) || text === 'null' || text === 'None') return out;
  let tokens: string[];
  try {
    const parsed = JSON.parse(text) as unknown;
    tokens = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    tokens = text.replace(/^[[(]|[\])]$/g, '').split(/[,\s]+/);
  }
  for (const token of tokens) {
    const name = token.trim().replace(/^["']|["']$/g, '');
    if (isValidSkillName(name)) out.add(name);
  }
  return out;
}

export async function readDisabledSkillNames(): Promise<Set<string>> {
  // Only the GLOBAL list. `skills.platform_disabled` is a `{platform: [names]}`
  // map, and a skill switched off for Telegram is still live for the chat this
  // store belongs to — reporting it as disabled here would be a different
  // untruth from the one being fixed. (It is also unparseable without knowing
  // which keys are platform names and which are skills, and a guess there would
  // mark a skill CALLED `telegram` disabled.)
  return parseDisabledSkillList(await hermesConfigGet('skills.disabled'));
}

/**
 * Every skill name that already exists on this device OUTSIDE the hub — the
 * bundled set plus anything the agent wrote locally.
 *
 * This is the guard the installer does not have. Hermes' own collision check
 * consults the hub lock (hermes_cli/skills_hub.py:673-681), which by
 * construction contains only store installs: on a stock device the lock is
 * `{"installed": {}}` while 82 bundled skills sit on disk, so the check is
 * structurally blind to all of them. Meanwhile a non-`official` install lands
 * FLAT at ~/.hermes/skills/<name>, which sorts before productivity/<name> in
 * the agent's `sorted(matches)` dedup walk (agent/skill_utils.py:1226 +
 * skill_commands.py:480-492) — so a one-file store stub silently displaces the
 * 17-file bundled `pdf` skill and nothing anywhere says so.
 */
export async function readShadowableSkillNames(): Promise<Set<string>> {
  const [bundled, disk, lock] = await Promise.all([
    readBundledManifestNames(),
    walkAllSkillDirs(),
    readHubLock(),
  ]);
  const out = new Set(bundled);
  for (const s of disk) {
    // A hub-installed skill is replaceable through the store, so it is not a
    // shadowing conflict — updating one is the normal path.
    if (Object.prototype.hasOwnProperty.call(lock, s.name)) continue;
    out.add(s.name);
    // The directory name and the frontmatter name can differ; the agent dedups
    // on the FRONTMATTER name, so that is the one a collision is measured on.
    if (s.frontmatter.name) out.add(s.frontmatter.name);
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

/**
 * Absolute directory of an `official` skill inside the agent checkout, or null
 * when the catalog's path escapes it. This is the device's OFFLINE copy of the
 * authoritative file list for that skill — what a completeness check compares
 * an `official` install against without needing the network.
 */
export function officialSkillDir(indexPath: string): string | null {
  if (typeof indexPath !== 'string' || !indexPath || indexPath.length > 300) return null;
  return resolveInside(AGENT_ROOT, indexPath);
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

/**
 * Which category bucket a hub-installed skill belongs in.
 *
 * `install_path.split('/')[0]` was the whole rule, and it is right only when
 * the skill landed inside a category directory. Hermes applies an automatic
 * category to `official` installs ONLY (hermes_cli/skills_hub.py:668-672);
 * every clawhub / github / skills.sh / browse-sh install lands FLAT, so the
 * install path IS the skill slug and each such install minted its own
 * one-item category. On a stock box with three genuine single-item categories,
 * a handful of installs made the Installed filter mostly noise
 * (`agent-monitor`, `algorithmic-art`, … each with a count of 1).
 *
 * So: use the install path only when it actually names a parent directory,
 * fall back to the category the registry recorded in the lock's metadata, then
 * to the disk walk's directory when that names anything but the skill itself,
 * and otherwise bucket the skill under `hub` with everything else that came
 * from the store.
 */
export function hubCategory(name: string, entry: HubLockEntry, diskCategory?: string): string {
  const parts = (entry.install_path || '').split('/').filter(Boolean);
  if (parts.length > 1) return parts[0];
  const hermesMeta = entry.metadata?.hermes;
  const declared =
    hermesMeta && typeof hermesMeta === 'object'
      ? (hermesMeta as Record<string, unknown>).category
      : undefined;
  if (typeof declared === 'string' && declared.trim() && declared.trim() !== name) {
    return declared.trim().slice(0, 64);
  }
  // The disk walk's category is the TOP-LEVEL directory, which for a flat
  // install is the skill's own slug — the value that minted the junk
  // categories. It only counts when it names something other than the skill.
  if (diskCategory && diskCategory !== name) return diskCategory;
  return 'hub';
}

/**
 * Rewrite one lock entry's `files[]` after the install route has completed a
 * download the Hermes fetcher truncated.
 *
 * The lock is Hermes' file, and this is the one field ClawBox corrects in it:
 * the finding was not only that two of four files were missing, but that
 * lock.json recorded `files: ["SKILL.md", "templates/viewer.html"]` and every
 * surface downstream — the store's file count, `skill_info` — repeated that as
 * if it were the whole skill. Leaving the entry alone would fix the disk and
 * keep the lie.
 *
 * Read-modify-write of the single entry, and a no-op if the entry is gone (an
 * uninstall raced us) or the file cannot be parsed.
 */
export async function updateLockFiles(name: string, files: string[]): Promise<boolean> {
  let doc: HubLock;
  try {
    doc = JSON.parse(await fs.readFile(HUB_LOCK_PATH, 'utf8')) as HubLock;
  } catch {
    return false;
  }
  const installed = doc?.installed;
  if (!installed || typeof installed !== 'object') return false;
  // `name` reaches here from the install request body, so the entry is looked
  // up through an own-key map rather than by `installed[name]`. On a lock that
  // has no such entry, `installed['__proto__']` is not undefined — it is
  // Object.prototype, which is truthy, and the assignment below would then hang
  // a `files` property off every object in the process. Object.entries() only
  // ever yields own enumerable keys, so no inherited member can be selected.
  const entry = hubLockEntry(installed, name);
  if (!entry) return false;
  entry.files = files.slice(0, 500).sort();
  try {
    await fs.writeFile(HUB_LOCK_PATH, JSON.stringify(doc, null, 1));
    return true;
  } catch {
    return false;
  }
}

/** Absolute install directory of a hub lock entry, or null when unresolvable. */
export function lockInstallDir(entry: HubLockEntry | undefined): string | null {
  if (!entry?.install_path) return null;
  return resolveInside(SKILLS_DIR, entry.install_path);
}

let installedCache: { key: string; value: InstalledHermesSkill[] } | null = null;
const INSTALLED_TTL_MS = 10_000;
let installedCacheAt = 0;

// ── Removing a skill: the post-condition both routes need ───────────────────
//
// Removing a Hermes skill has TWO halves. `hermes skills uninstall` drops the
// LOCK ENTRY — what every store surface lists — and is supposed to delete the
// DIRECTORY, which is what the agent actually loads. It exits 0 whether it did
// either, so neither half may be inferred from its exit code, and a directory
// left behind is loaded by the agent with no lock entry to show for it.
//
// PR #517 established that for the install route's rollback and left the
// uninstall route checking only the lock. One implementation, used by both, is
// what stops the two answering differently about the same device state.

/**
 * What the skill directory is doing after a removal.
 *
 * Four states, not two, because "not known to be there" is not "gone" — and
 * because there are two different ways not to know, which a caller writing a
 * sentence for the customer cannot tell apart from one label:
 *
 * - `unchecked` — nothing ever looked. A lock entry that names no
 *   `install_path` gives the removal nothing to aim at, so nothing about the
 *   directory was checked and nothing about it may be claimed.
 * - `unknown` — something looked and the device would not answer: the removal
 *   believed it worked and the confirming `stat` failed with anything other
 *   than ENOENT (see `pathState`). The entry DOES name a location here, and the
 *   files are most likely still at it.
 *
 * They were one value, and the install route's refusal named the first as the
 * cause of both — telling a customer whose skill was still on the device that
 * the entry named no location. Neither surface has to guess now.
 */
export type SkillRemovalDir = 'present' | 'absent' | 'unchecked' | 'unknown';

/** What a removal ACHIEVED, as opposed to what the CLI printed about it. */
export interface SkillRemovalVerdict {
  /** No lock entry survived and no directory is known to have. */
  clean: boolean;
  /** The hub lock still lists the skill — every store surface calls it installed. */
  lockEntry: boolean;
  /** The skill directory is still on disk — the agent would load it. */
  dir: SkillRemovalDir;
}

/**
 * Is this path there? Three answers, because a failed `stat` has two meanings.
 *
 * ENOENT is the only one that proves absence. EACCES, ENOTDIR, EIO and a
 * timed-out network mount all mean the question could not be answered — and on
 * this device family that is not hypothetical: the root-owned subtree that
 * defeats the CLI's own `fs.rm` is exactly the kind of tree a stat can fail on.
 * Reading any of them as "not there" is how a caller ends up deleting an
 * installation it could not see.
 */
export type PathState = 'present' | 'absent' | 'unknown';

export async function pathState(p: string): Promise<PathState> {
  try {
    await fs.stat(p);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/**
 * Take the second swing at the directory, then report what is left of the skill.
 *
 * Call this AFTER `hermes skills uninstall` has run and only once the lock half
 * is believed to have worked: it deletes the directory the entry names, and
 * deleting the files under a lock entry that survived would manufacture exactly
 * the half-removed state this exists to detect.
 *
 * The lock question is asked about the KEY, never the identifier. The key came
 * out of the lock, so the CLI can only have removed that one key; matching on
 * the identifier as well scans every other entry and can therefore only produce
 * FALSE failures — a second copy of the same store id under a different name
 * would report a completed removal as incomplete.
 */
export async function verifySkillRemoval(
  lockKey: string,
  entry: HubLockEntry | undefined,
): Promise<SkillRemovalVerdict> {
  const installPath = entry?.install_path;
  // `unchecked` until something actually looks. With no `install_path` there is
  // nothing to look at, and the honest answer is not `absent`: the CLI may well
  // have left a directory behind at a location this route was never told.
  let dir: SkillRemovalDir = 'unchecked';
  if (installPath) {
    // Two things can leave the directory behind, so both are checked: a path
    // `removeSkillDir` will not resolve (it answers false and removes nothing),
    // and a removal it believes it made — `fs.rm` on a tree it cannot fully
    // traverse, the root-owned subdirectory case this device family produces.
    const removed = await removeSkillDir(SKILLS_DIR, installPath);
    const abs = lockInstallDir(entry);
    if (!removed) {
      dir = 'present';
    } else if (abs !== null) {
      // A stat that could not answer is `unknown`, NOT `unchecked`: the check
      // ran, the entry named the location it ran on, and only the answer is
      // missing. Nothing may call that "no location was named".
      dir = await pathState(abs);
    }
  }
  invalidateInstalledCache();
  // Read the lock AFTER the CLI, never before: it is the only thing that says
  // whether the store will still list this skill.
  const lockEntry = Object.prototype.hasOwnProperty.call(await readHubLock(), lockKey);
  // Neither unanswered state is a failure on its own. The store lists what the
  // lock lists, so a vanished lock entry means the customer sees nothing and
  // has nothing to act on; refusing here would report a failure over a removal
  // that did its job.
  return { clean: !lockEntry && dir !== 'present', lockEntry, dir };
}

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
  // config.yaml is in the key because `enabled` is read from `skills.disabled`
  // there: without it, switching a skill off left the tab claiming it was live
  // for the length of the TTL.
  return [
    await stat(HUB_LOCK_PATH),
    await stat(SKILLS_DIR),
    await stat(path.join(HERMES_HOME, 'config.yaml')),
  ].join('|');
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

  const [disk, lock, bundled, disabled] = await Promise.all([
    walkAllSkillDirs(),
    readHubLock(),
    readBundledManifestNames(),
    readDisabledSkillNames(),
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
      enabled: !disabled.has(s.name) && !disabled.has(fm.name || s.name),
    });
  }

  for (const [name, entry] of Object.entries(lock)) {
    const existing = byName.get(name);
    const report = scanReportFromLock(entry);
    byName.set(name, {
      id: name,
      name: entry.name || existing?.name || name,
      category: hubCategory(name, entry, existing?.category),
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
      enabled: !disabled.has(name) && !disabled.has(entry.name || name),
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
