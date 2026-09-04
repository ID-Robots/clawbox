// Writes the UI language preference into the running agent's persona files.
//
// This is the one preference whose value ends up interpolated into SOUL.md and
// USER.md — the agent's system prompt — so the language code that reaches here
// has to come from the closed set of locales the device ships. The POST route
// validates it, but the domain check is repeated here so the property holds
// for this function on its own rather than depending on who calls it: a future
// second caller must not be able to reopen the path by forgetting the check.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import type { Harness } from "@/lib/harness";
import { isPreferenceLanguage } from "@/lib/preference-schema";

export interface PersonaFiles {
  userFile: string;
  soulFile: string;
}

/** The file OpenClaw seeds to arm its first-conversation ritual. */
const BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

// Where OpenClaw actually keeps the workspace, rather than where it usually
// does. `agents.defaults.workspace` in openclaw.json wins when it is set — the
// same resolution getSkillsDir() performs in openclaw-config.ts and the one
// gateway-pre-start.sh repeats in python — because the guard below and the
// write it guards have to be talking about one directory. A guard that read
// the default path while the write landed in a moved workspace would answer
// "allowed" about a directory OpenClaw never opens, which is the whole failure
// this guard exists to prevent.
//
// Resolved here instead of by importing getSkillsDir so that saving a
// preference does not drag the OpenClaw CLI surface (session store, plugin
// probes, child_process) in behind it, and deliberately without that
// function's `~/clawd` last resort: this is where the persona is written, not
// where skills are hunted for, and inventing a directory to write a persona
// into would create exactly the "already configured" evidence we are avoiding.
export function openclawWorkspaceDir(): string {
  const home = process.env.HOME || "/home/clawbox";
  const openclawHome = path.join(home, ".openclaw");
  try {
    const cfg = JSON.parse(fsSync.readFileSync(path.join(openclawHome, "openclaw.json"), "utf-8"));
    const configured = cfg?.agents?.defaults?.workspace;
    if (typeof configured === "string" && configured.trim()) {
      const raw = configured.trim();
      const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
      // A bare name is relative to the OpenClaw home, which is how the gateway
      // itself reads it; anything absolute is taken as written.
      return path.isAbsolute(expanded) ? expanded : path.join(openclawHome, expanded);
    }
  } catch {
    // No config yet (a fresh box, or a factory reset that removed it) or one we
    // cannot parse: the default workspace is the honest answer either way.
  }
  return path.join(openclawHome, "workspace");
}

async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/**
 * May ClawBox write the persona files of `harness` right now?
 *
 * OpenClaw decides on the FIRST agent turn whether to run its
 * first-conversation ritual, and it decides by looking at the workspace:
 * a USER.md (or SOUL.md) that differs from its own template means "someone has
 * already configured this agent", so it stamps the workspace complete and
 * never writes BOOTSTRAP.md. ClawBox used to lose that race by a few minutes —
 * the setup wizard's language pick created USER.md before the owner had ever
 * said hello — and the ritual was suppressed on every box that shipped, with
 * no way back short of a factory reset.
 *
 * So the persona is off limits until the workspace is one OpenClaw has already
 * finished with. Both conditions matter and neither implies the other:
 *
 *   - USER.md must already EXIST. Creating it is the suppressing act; the
 *     absence of the file is precisely the fresh workspace the ritual needs.
 *   - BOOTSTRAP.md must NOT exist. Its presence means the ritual is armed and
 *     unfinished, and an edit to USER.md/SOUL.md now makes the next turn delete
 *     it — the same suppression, arriving late.
 *
 * Hermes has no such ritual and its persona files are its own, so nothing is
 * deferred there.
 */
export async function personaWritesAllowed(harness: Harness): Promise<boolean> {
  if (harness === "hermes") return true;
  const workspace = openclawWorkspaceDir();
  if (!(await fileExists(path.join(workspace, "USER.md")))) return false;
  return !(await fileExists(path.join(workspace, BOOTSTRAP_FILENAME)));
}

// Where the RUNNING agent reads its persona from. Writing the language
// preference into the other harness's files is a silent no-op: OpenClaw scans
// ~/.openclaw/workspace, Hermes reads SOUL.md from its own home and USER.md
// from the memories/ directory beside it (agent/prompt_builder.py resolves
// both against HERMES_HOME). On a ClawBox those Hermes paths are symlinks to
// the shared ~/.clawbox/agent-identity bridge, so a write here follows through
// to the canonical files and both harnesses stay in step.
export function personaFilesFor(harness: Harness): PersonaFiles {
  if (harness === "hermes") {
    const home = process.env.HOME || "/home/clawbox";
    const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
    return {
      userFile: path.join(hermesHome, "memories", "USER.md"),
      soulFile: path.join(hermesHome, "SOUL.md"),
    };
  }
  // Resolved rather than hardcoded, and resolved by the same function
  // personaWritesAllowed() consults: a box whose workspace has been moved must
  // not have its guard inspect one directory and its write land in another.
  const wsDir = openclawWorkspaceDir();
  return { userFile: path.join(wsDir, "USER.md"), soulFile: path.join(wsDir, "SOUL.md") };
}

export const LANG_NAMES: Record<string, string> = {
  en: "English", bg: "Български", de: "Deutsch", es: "Español",
  fr: "Français", it: "Italiano", ja: "日本語", nl: "Nederlands",
  sv: "Svenska", zh: "中文",
};

/**
 * Rewrite the persona files for `lang`. Byte-for-byte the same content the
 * OpenClaw path has always written — only the target paths vary by harness.
 *
 * Returns false and writes nothing for a language code outside the shipped set.
 */
export async function writeLanguagePersona(lang: string, files: PersonaFiles): Promise<boolean> {
  if (!isPreferenceLanguage(lang) || !(lang in LANG_NAMES)) return false;

  const langName = LANG_NAMES[lang];
  const { userFile, soulFile } = files;
  await fs.mkdir(path.dirname(userFile), { recursive: true }).catch(() => {});
  await fs.mkdir(path.dirname(soulFile), { recursive: true }).catch(() => {});

  // Update USER.md with language preference
  try {
    let userMd = await fs.readFile(userFile, "utf-8").catch(() => "# USER.md - About Your Human\n");
    // Remove existing language line if present
    userMd = userMd.replace(/\n- \*\*Language:\*\*.*\n/g, "\n");
    // Add language preference after the header or at the end
    const langLine = `- **Language:** ${langName} (${lang})` + (lang !== "en"
      ? ` — Always respond in ${langName}`
      : "");
    if (userMd.includes("- **Name:**")) {
      userMd = userMd.replace(/(- \*\*Name:\*\*.*\n)/, `$1${langLine}\n`);
    } else {
      userMd = userMd.trimEnd() + `\n${langLine}\n`;
    }
    await fs.writeFile(userFile, userMd, "utf-8");
  } catch (err) {
    console.error(`[preferences] Failed to update ${userFile}:`, err instanceof Error ? err.message : err);
  }

  // Also write SOUL.md language instruction for strong enforcement
  if (lang !== "en") {
    try {
      let soulMd = await fs.readFile(soulFile, "utf-8").catch(() => "# SOUL.md - Who You Are\n");
      // Remove existing language section
      soulMd = soulMd.replace(/\n## Language\n[\s\S]*?(?=\n## |\n$|$)/, "");
      // Append language section
      soulMd = soulMd.trimEnd() + `\n\n## Language\n\nYou MUST respond in ${langName}. The user's preferred language is ${langName} (${lang}). All messages, explanations, and summaries must be in ${langName}. Only use English for code, technical terms, and tool names.\n`;
      await fs.writeFile(soulFile, soulMd, "utf-8");
    } catch (err) {
      console.error(`[preferences] Failed to update ${soulFile}:`, err instanceof Error ? err.message : err);
    }
  } else {
    // English — remove language section from SOUL.md if present
    try {
      let soulMd = await fs.readFile(soulFile, "utf-8").catch(() => "");
      if (soulMd.includes("## Language")) {
        soulMd = soulMd.replace(/\n## Language\n[\s\S]*?(?=\n## |\n$|$)/, "");
        await fs.writeFile(soulFile, soulMd.trimEnd() + "\n", "utf-8");
      }
    } catch (err) {
      console.error(`[preferences] Failed to update ${soulFile}:`, err instanceof Error ? err.message : err);
    }
  }
  return true;
}
