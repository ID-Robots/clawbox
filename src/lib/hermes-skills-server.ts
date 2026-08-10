// Server-only (fs) enumeration of installed Hermes skills. Kept apart from the
// pure `hermes-skills.ts` validators so the client component can import the
// types without pulling `fs` into the browser bundle.
//
// Two on-disk sources (per the probed contract):
//   (a) ~/.hermes/skills/.hub/lock.json  — AUTHORITATIVE for hub-installed
//       skills (what the store installs). JSON, keyed by skill name, carries
//       identifier + trust_level + scan_verdict + install_path.
//   (b) ~/.hermes/skills/<category>/**/SKILL.md — builtin/bundled skills, with
//       YAML frontmatter (name/description/metadata.hermes.category). Nesting
//       can exceed 2 levels, so we walk for SKILL.md up to a small max depth.
// Internal dot-dirs (.hub) and the .bundled_manifest file are skipped.

import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import type { InstalledHermesSkill } from "@/lib/hermes-skills";
import { getActiveHarness } from "@/lib/harness";

/**
 * Defense-in-depth gate for the skills-store routes: the store is a Hermes
 * feature, so refuse when the active harness isn't Hermes. Returns a 404
 * response to return early, or null to proceed. (On a dual box Hermes is
 * installed, so without this the CLI would run even with the store UI hidden.)
 */
export async function hermesSkillsGuard(): Promise<NextResponse | null> {
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export const HERMES_HOME =
  process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
export const SKILLS_DIR = path.join(HERMES_HOME, "skills");
const HUB_LOCK_PATH = path.join(SKILLS_DIR, ".hub", "lock.json");

interface HubLockEntry {
  source?: string;
  identifier?: string;
  trust_level?: string;
  scan_verdict?: string;
  install_path?: string;
  name?: string;
}
interface HubLock {
  version?: number;
  installed?: Record<string, HubLockEntry>;
}

/** Read the authoritative hub lock file. Missing/unparsable → empty. */
export async function readHubLock(): Promise<Record<string, HubLockEntry>> {
  try {
    const raw = await fs.readFile(HUB_LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw) as HubLock;
    return parsed && typeof parsed.installed === "object" && parsed.installed
      ? parsed.installed
      : {};
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

// readdir(withFileTypes) that yields [] instead of throwing on a missing dir.
// Returns Dirent[] by inference so callers keep .isFile()/.isDirectory()/.name.
async function readDirSafe(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Minimal YAML-frontmatter extraction — no YAML dependency. Pulls `name`,
// `description`, and `metadata.hermes.category` (indented under two parents).
function parseFrontmatter(md: string): { name?: string; description?: string; category?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1];
  const flat = (key: string): string | undefined => {
    const mm = block.match(new RegExp(`^${key}\\s*:\\s*["']?([^"'\\r\\n]+?)["']?\\s*$`, "m"));
    return mm ? mm[1].trim() : undefined;
  };
  // `category:` appears indented under metadata > hermes; a loose indented match
  // is good enough for a best-effort label.
  const catMatch = block.match(/^\s+category\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
  return {
    name: flat("name"),
    description: flat("description"),
    category: catMatch ? catMatch[1].trim() : undefined,
  };
}

async function walkForSkillMd(
  dir: string,
  topCategory: string,
  depth: number,
  out: InstalledHermesSkill[],
): Promise<void> {
  if (depth > 4) return;
  const entries = await readDirSafe(dir);
  const hasSkill = entries.some((e) => e.isFile() && e.name === "SKILL.md");
  if (hasSkill) {
    const skillName = path.basename(dir);
    let fm: { name?: string; description?: string; category?: string } = {};
    try {
      fm = parseFrontmatter(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"));
    } catch {
      /* best-effort */
    }
    out.push({
      id: skillName,
      name: fm.name || skillName,
      category: fm.category || topCategory,
      description: fm.description,
      source: "builtin",
      enabled: true,
    });
    return; // a skill dir is a leaf — don't descend into its references/
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue; // skip .hub and other dot-dirs
    await walkForSkillMd(path.join(dir, e.name), topCategory, depth + 1, out);
  }
}

// Resolve `<install_path>/SKILL.md` inside SKILLS_DIR, refusing anything that
// escapes the skills tree (defense-in-depth even though install_path is our own
// lock data).
function safeSkillMdPath(installPath: string): string | null {
  const rel = installPath.replace(/^[/\\]+/, "");
  const abs = path.resolve(SKILLS_DIR, rel, "SKILL.md");
  const root = path.resolve(SKILLS_DIR) + path.sep;
  return abs.startsWith(root) ? abs : null;
}

// Walk for a leaf skill dir whose basename === `name`, returning its SKILL.md.
async function findBuiltinSkillFile(
  dir: string,
  topCategory: string,
  name: string,
  depth: number,
): Promise<{ file: string; category: string } | null> {
  if (depth > 4) return null;
  const entries = await readDirSafe(dir);
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    return path.basename(dir) === name
      ? { file: path.join(dir, "SKILL.md"), category: topCategory }
      : null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const hit = await findBuiltinSkillFile(path.join(dir, e.name), topCategory, name, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Read the FULL, untruncated SKILL.md for an already-installed skill straight
 * off disk (the inspect CLI preview is truncated). Matches `idOrName` against
 * the hub lock (by name key or identifier) first, then the builtin disk walk.
 * Returns the raw markdown plus the authoritative source/trust overlay, or null
 * when the skill isn't installed locally (caller falls back to inspect).
 */
export async function readInstalledSkillMarkdown(idOrName: string): Promise<{
  markdown: string;
  source?: string;
  trust?: string;
  scanVerdict?: string;
  category?: string;
} | null> {
  const hub = await readHubLock();

  let entry: HubLockEntry | undefined;
  let key: string | undefined;
  if (Object.prototype.hasOwnProperty.call(hub, idOrName)) {
    key = idOrName;
    entry = hub[idOrName];
  } else {
    for (const [k, e] of Object.entries(hub)) {
      if (e.identifier === idOrName) {
        key = k;
        entry = e;
        break;
      }
    }
  }

  if (entry?.install_path) {
    const file = safeSkillMdPath(entry.install_path);
    if (file) {
      try {
        const markdown = await fs.readFile(file, "utf8");
        return {
          markdown,
          source: entry.source,
          trust: entry.trust_level,
          scanVerdict: entry.scan_verdict,
          category: entry.install_path.split("/")[0],
        };
      } catch {
        /* fall through to the builtin walk */
      }
    }
  }

  const target = key || idOrName;
  const topDirs = await readDirSafe(SKILLS_DIR);
  for (const d of topDirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const hit = await findBuiltinSkillFile(path.join(SKILLS_DIR, d.name), d.name, target, 1);
    if (hit) {
      try {
        const markdown = await fs.readFile(hit.file, "utf8");
        return { markdown, source: "builtin", category: hit.category };
      } catch {
        /* ignore and keep looking */
      }
    }
  }

  return null;
}

/**
 * Enumerate every installed skill. Builtin skills come from the disk walk; the
 * hub lock overlays identifier/trust/scan-verdict and authoritative source for
 * anything the user installed through the store. Missing SKILLS_DIR → [].
 */
export async function enumerateInstalledSkills(): Promise<InstalledHermesSkill[]> {
  const byId = new Map<string, InstalledHermesSkill>();

  // (b) disk walk for builtin/bundled skills. A missing skills dir → [].
  const topDirs = await readDirSafe(SKILLS_DIR);
  for (const d of topDirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const found: InstalledHermesSkill[] = [];
    await walkForSkillMd(path.join(SKILLS_DIR, d.name), d.name, 1, found);
    for (const s of found) byId.set(s.id, s);
  }

  // (a) authoritative hub lock overlay.
  const hub = await readHubLock();
  for (const [key, entry] of Object.entries(hub)) {
    const category = entry.install_path ? entry.install_path.split("/")[0] : "hub";
    const existing = byId.get(key);
    byId.set(key, {
      id: key,
      name: entry.name || existing?.name || key,
      category: existing?.category || category,
      description: existing?.description,
      source: entry.source || "hub",
      identifier: entry.identifier,
      trust: entry.trust_level,
      scanVerdict: entry.scan_verdict,
      enabled: true,
    });
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}
