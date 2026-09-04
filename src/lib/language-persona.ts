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
import * as config from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { isPreferenceLanguage, PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";

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

/**
 * The device-store key that records a language pick the guard above sent away.
 *
 * Deliberately not a `pref:` key: it is not the owner's preference, it is a
 * debt this box owes its own persona, and `preferences_get` must not serve it.
 */
export const DEFERRED_LANGUAGE_KEY = "ui_language_persona_pending";

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

/**
 * Pay back a language pick the ritual made us defer.
 *
 * The deferral has to be repaid by something that happens on a box nobody is
 * touching, because that is exactly the box the defect lives on: the owner
 * chooses Bulgarian in the setup wizard, the introduction runs minutes later,
 * and from then until an unrelated restart the desktop is in Bulgarian while
 * the agent's persona carries no language directive at all. The gateway's
 * ExecStartPre re-applies the same pick, but nothing restarts the gateway when
 * the introduction ends, so on its own it is a repayment with no due date.
 *
 * So this is called from the five-minute portal heartbeat — the one tick every
 * installed box already runs whether or not a desktop is open — and the
 * ExecStartPre stays as the path for a box that reboots first. The flag is what
 * keeps the tick cheap and keeps it quiet: without a deferral on record there
 * is nothing to do, and once the write lands the flag is cleared so a persona
 * the agent may since have edited is not rewritten every five minutes (OpenClaw
 * revalidates workspace files by mtime, so an identical rewrite is not free).
 *
 * Returns true only when the persona was actually written. Never throws: the
 * caller is a timer-driven route whose whole contract is to answer 200.
 */
export async function applyDeferredLanguagePersona(): Promise<boolean> {
  try {
    // One read of the store for both the flag and the pick — config.get()
    // re-reads and re-parses the whole file on every call.
    const store = await config.getAll();
    if (store[DEFERRED_LANGUAGE_KEY] !== true) return false;

    const harness = await getActiveHarness();
    // The same guard the route applies, asked again here rather than assumed:
    // the deferral was recorded while the ritual was armed or unstarted, and
    // this runs on a schedule, so most ticks find it still armed.
    if (!(await personaWritesAllowed(harness))) return false;

    const lang = store[`${PREFERENCE_KEY_PREFIX}ui_language`];
    const written =
      typeof lang === "string" && (await writeLanguagePersona(lang, personaFilesFor(harness)));
    // The debt is cleared either way. A stored value outside the shipped set
    // can never be paid back, and a box with no pick at all owes nothing, so
    // leaving the flag up would re-ask the same question every five minutes
    // for the life of the device.
    await config.set(DEFERRED_LANGUAGE_KEY, false);
    return written;
  } catch (err) {
    // Worth a line in the journal, never worth a failed tick: the next one is
    // five minutes away and the persona is not urgent.
    console.error(
      "[preferences] Could not apply the deferred language persona:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
