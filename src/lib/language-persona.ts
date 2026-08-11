// Writes the UI language preference into the running agent's persona files.
//
// This is the one preference whose value ends up interpolated into SOUL.md and
// USER.md — the agent's system prompt — so the language code that reaches here
// has to come from the closed set of locales the device ships. The POST route
// validates it, but the domain check is repeated here so the property holds
// for this function on its own rather than depending on who calls it: a future
// second caller must not be able to reopen the path by forgetting the check.

import fs from "fs/promises";
import path from "path";
import type { Harness } from "@/lib/harness";
import { isPreferenceLanguage } from "@/lib/preference-schema";

export interface PersonaFiles {
  userFile: string;
  soulFile: string;
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
  const wsDir = "/home/clawbox/.openclaw/workspace";
  return { userFile: `${wsDir}/USER.md`, soulFile: `${wsDir}/SOUL.md` };
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
