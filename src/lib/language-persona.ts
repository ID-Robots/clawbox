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
import path from "@/lib/runtime-path";
import * as config from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { isPreferenceLanguage, PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";

export interface PersonaFiles {
  userFile: string;
  soulFile: string;
}

/** The file OpenClaw seeds to arm its first-conversation ritual. */
const BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

/**
 * Where a retired BOOTSTRAP.md is kept: inside the workspace, so it travels with
 * it, but in a directory OpenClaw never injects. scripts/gateway-pre-start.sh
 * retires into the same place.
 */
export const RETIRED_RITUAL_DIRNAME = ".clawbox-retired";

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
  // The same resolution openclaw-config.ts performs, spelled out rather than
  // imported for the reason above — and gateway-pre-start.sh honours
  // OPENCLAW_HOME too. A box that moved its OpenClaw home would otherwise have
  // this guard reading one openclaw.json while the gateway ran from another,
  // which is the exact disagreement the comment above says must not happen.
  const openclawHome = process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(home, ".openclaw");
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
 * Is OpenClaw's first-conversation ritual armed and still unfinished?
 *
 * The same fact `personaWritesAllowed` reads, asked in the positive: BOOTSTRAP.md
 * is present exactly while the ritual is waiting to run, and OpenClaw deletes it
 * on the turn that finishes the introduction. It is therefore the one honest
 * answer to "is this a fresh box that has never been introduced to its owner?"
 * — better than an empty transcript, which is also what a cleared conversation,
 * a restored side tab and a reset session all look like.
 *
 * Read here rather than derived in the caller so the two guards cannot drift:
 * a change to how a fresh workspace is recognised belongs in one file.
 *
 * Hermes runs no such ritual (see above), so it is never armed there — a Hermes
 * box has no introduction for a greeting to start.
 *
 * Never armed on a box whose setup wizard is complete either (TASK-1528): a
 * set-up box answers its first chat message like any other, and
 * `retireOnboardingRitual` takes the file away. Asked of the setup flag as well
 * as the file so a retirement that has not landed yet — an updated box before
 * its first heartbeat, a write that failed — still never has the chat send the
 * opener that starts the ritual, in this tab or any new one.
 */
export async function onboardingRitualArmed(harness: Harness): Promise<boolean> {
  if (harness === "hermes") return false;
  if (await setupComplete()) return false;
  return fileExists(path.join(openclawWorkspaceDir(), BOOTSTRAP_FILENAME));
}

/** Has the owner finished the setup wizard? A store that cannot be read says no. */
async function setupComplete(): Promise<boolean> {
  try {
    return (await config.get("setup_complete")) === true;
  } catch {
    return false;
  }
}

/**
 * The owner's name as it may appear in USER.md, or null.
 *
 * The setup wizard does not ask for a name; `pref:ui_user_name` is written by
 * the agent's `preferences_set` (or was, by the retired Settings field). It is
 * free text that lands in the agent's system prompt, so only what a name needs
 * survives: letters, marks, digits, spaces and `.'-`. Anything longer than the
 * tool's own 64-character cap is not a name. The Python twin in
 * scripts/gateway-pre-start.sh applies the same rule, so every step is spelled
 * in Unicode categories rather than either language's `\s`: the two disagree
 * (JavaScript's includes U+FEFF, Python's includes U+001C-001F and U+0085), and
 * the two USER.md writers must not.
 */
export function personaOwnerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/[\p{Z}\t\n\v\f\r]/gu, " ")
    .replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!name || [...name].length > 64) return null;
  return name;
}

/**
 * The USER.md ClawBox starts on a set-up box whose workspace has none.
 *
 * Its first job is to exist and to differ from OpenClaw's own template: that is
 * what OpenClaw reads as "already configured", so it never seeds its stock
 * ritual into the workspace. The note is for the agent — OpenClaw's IDENTITY.md
 * template still says to fill it in "during your first conversation", and this
 * file is injected into every session. Byte-for-byte what
 * scripts/gateway-pre-start.sh writes; the test there compares the two.
 */
export function clawboxUserMd(name: string | null): string {
  const value = name ? ` ${name}` : "";
  return [
    "# USER.md - About Your Human",
    "",
    "_ClawBox started this file when the owner finished setting up the box. Fill it in as you learn about them._",
    "",
    `- **Name:**${value}`,
    `- **What to call them:**${value}`,
    "- **Timezone:**",
    "- **Notes:**",
    "",
    "## Context",
    "",
    "_The owner has already set this box up. Answer their first message like any other: no introductions, and no",
    "asking what to call you or them. When they mention their name or how they like to be addressed, record it here._",
    "",
  ].join("\n");
}

async function pathPresent(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false);
}

/**
 * End OpenClaw's first-conversation ritual for good on a box whose setup wizard
 * is complete (TASK-1528).
 *
 * The ritual asks what to call the assistant and what to call the owner, and
 * while BOOTSTRAP.md is on disk OpenClaw injects it into every new session — so
 * an owner who never played it through met it again in every new chat tab. The
 * product ruling is that a set-up box answers its first message normally.
 *
 * Two steps, in this order:
 *
 *   1. USER.md is put in place if the workspace has none (`clawboxUserMd`). A
 *      USER.md that differs from OpenClaw's template is what tells it the
 *      workspace is configured; without one, a workspace OpenClaw has not yet
 *      seen would have the stock ritual seeded in place of the one we retire.
 *      Never written over an existing file: that one is the agent's.
 *   2. BOOTSTRAP.md is MOVED, never deleted, into RETIRED_RITUAL_DIRNAME. Once
 *      it is gone OpenClaw stamps the workspace complete and does not seed it
 *      again. Skipped when step 1 could not leave a USER.md behind.
 *
 * Only while OpenClaw is the harness in play. On a dual box running Hermes,
 * a USER.md here would make clawbox-identity-sync.sh read the OpenClaw
 * workspace as introduced, and a canonical identity still marked provisional
 * would then be overwritten from it — the USER.md Hermes has been keeping,
 * replaced by this template. The switch to OpenClaw (`harness/select`), the
 * heartbeat after it and the gateway's ExecStartPre do the work instead.
 *
 * Returns true only when a BOOTSTRAP.md was retired. Never throws: the
 * heartbeat, the harness switch and the wizard's last step call it, and none of
 * them should fail over a text file.
 */
export async function retireOnboardingRitual(): Promise<boolean> {
  try {
    const store = await config.getAll();
    if (store.setup_complete !== true) return false;
    if ((await getActiveHarness()) !== "openclaw") return false;

    const workspace = openclawWorkspaceDir();
    await fs.mkdir(workspace, { recursive: true });

    const userFile = path.join(workspace, "USER.md");
    if (!(await pathPresent(userFile))) {
      await writeIfMissing(userFile, clawboxUserMd(personaOwnerName(store[`${PREFERENCE_KEY_PREFIX}ui_user_name`])));
    }

    const bootstrap = path.join(workspace, BOOTSTRAP_FILENAME);
    if (!(await pathPresent(bootstrap))) return false;
    if (!(await pathPresent(userFile))) return false;

    const retiredDir = path.join(workspace, RETIRED_RITUAL_DIRNAME);
    await fs.mkdir(retiredDir, { recursive: true });
    let target = path.join(retiredDir, BOOTSTRAP_FILENAME);
    if (await pathPresent(target)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      target = path.join(retiredDir, `BOOTSTRAP-${stamp}.md`);
    }
    await fs.rename(bootstrap, target);
    console.log(`[onboarding] Setup is complete; retired the first-conversation ritual to ${target}`);
    return true;
  } catch (err) {
    console.error(
      "[onboarding] Could not retire the first-conversation ritual:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Create `file` with `text` unless something is already there.
 *
 * Written to a temporary file and LINKED into place: the link fails with EEXIST
 * if another writer got there first, and a write cut short (a full eMMC) never
 * leaves a fragment under the real name. On a filesystem without hard links
 * the fallback is an EXCLUSIVE copy, which also fails rather than replace a
 * USER.md another writer created in the meantime — a rename would not.
 */
async function writeIfMissing(file: string, text: string): Promise<void> {
  const tmp = `${file}.clawbox-${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text, "utf-8");
    await fs.link(tmp, file).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return;
      await fs.copyFile(tmp, file, fsSync.constants.COPYFILE_EXCL).catch((copyErr: NodeJS.ErrnoException) => {
        if (copyErr.code !== "EEXIST") throw copyErr;
      });
    });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
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

/** The SOUL.md heading of the language section, alone on its line. */
const SOUL_LANGUAGE_HEADING = /^## Language[ \t]*\r?$/;
/** What ends a section: the next heading of level one or two. */
const SECTION_END = /^#{1,2}[ \t]/;
/** The USER.md line this module writes, and every one an older build wrote. */
const USER_LANGUAGE_LINE = "- **Language:**";
const USER_NAME_LINE = "- **Name:**";

/**
 * `soulMd` with EVERY `## Language` section taken out: from the heading line
 * up to, not including, the next level-one or level-two heading, or the end of
 * the file.
 *
 * Line by line rather than one regular expression, because the expression this
 * replaced removed only the first section and only one that a newline came
 * before: a SOUL.md that started with the section, or carried it twice (an
 * edit, a restore, a second writer), kept an instruction to answer in a
 * language the owner had switched away from. Unchanged text comes back
 * unchanged, so `!==` is the caller's "was there one".
 *
 * scripts/gateway-pre-start.sh has the Python twin
 * (`without_language_section`), held to this one by
 * src/tests/unit/gateway-prestart-onboarding.test.ts.
 */
export function withoutLanguageSection(soulMd: string): string {
  const kept: string[] = [];
  let inSection = false;
  for (const line of soulMd.split("\n")) {
    if (SOUL_LANGUAGE_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && SECTION_END.test(line)) inSection = false;
    if (!inSection) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * `userMd` with every `- **Language:**` line replaced by `langLine`, placed
 * after the `- **Name:**` line when there is one, else at the end.
 *
 * Every line, wherever it sits — the first line of the file and a last line
 * with no newline after it included — so the English line that replaces a
 * `— Always respond in …` one never leaves the old one behind.
 */
export function withLanguageLine(userMd: string, langLine: string): string {
  const lines = userMd.split("\n").filter((line) => !line.startsWith(USER_LANGUAGE_LINE));
  const nameAt = lines.findIndex((line) => line.startsWith(USER_NAME_LINE));
  if (nameAt < 0) return `${lines.join("\n").trimEnd()}\n${langLine}\n`;
  lines.splice(nameAt + 1, 0, langLine);
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Rewrite the persona files for `lang`. Byte-for-byte the same content the
 * OpenClaw path has always written — only the target paths vary by harness.
 *
 * These are the box's persona: every chat and every cron or automation run
 * reads them. The ONLY language that belongs here is the owner's, the box
 * default (`pref:ui_language`); another ClawBox user's pick is theirs alone
 * and reaches only their own chat (src/lib/user-language.ts). The callers are
 * the preferences route on the owner's pick, the deferred repayment below and
 * nothing else.
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
    const userMd = await fs.readFile(userFile, "utf-8").catch(() => "# USER.md - About Your Human\n");
    const langLine = `${USER_LANGUAGE_LINE} ${langName} (${lang})` + (lang !== "en"
      ? ` — Always respond in ${langName}`
      : "");
    await fs.writeFile(userFile, withLanguageLine(userMd, langLine), "utf-8");
  } catch (err) {
    console.error(`[preferences] Failed to update ${userFile}:`, err instanceof Error ? err.message : err);
  }

  // Also write SOUL.md language instruction for strong enforcement
  if (lang !== "en") {
    try {
      const soulMd = await fs.readFile(soulFile, "utf-8").catch(() => "# SOUL.md - Who You Are\n");
      // Every earlier section out, this one appended.
      const next = withoutLanguageSection(soulMd).trimEnd()
        + `\n\n## Language\n\nYou MUST respond in ${langName}. The user's preferred language is ${langName} (${lang}). All messages, explanations, and summaries must be in ${langName}. Only use English for code, technical terms, and tool names.\n`;
      await fs.writeFile(soulFile, next, "utf-8");
    } catch (err) {
      console.error(`[preferences] Failed to update ${soulFile}:`, err instanceof Error ? err.message : err);
    }
  } else {
    // English is the absence of the instruction, not another instruction:
    // every language section goes, and the file is written only if one was there.
    try {
      const soulMd = await fs.readFile(soulFile, "utf-8").catch(() => "");
      const stripped = withoutLanguageSection(soulMd);
      if (stripped !== soulMd) {
        await fs.writeFile(soulFile, stripped.trimEnd() + "\n", "utf-8");
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
