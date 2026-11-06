// Which turns get a ClawBox user's own language, and the instruction itself,
// read from the device store ClawBox keeps (src/lib/user-language.ts).
//
// Everything here decides "no instruction" whenever it cannot prove one: with
// none, the turn follows the persona's language — the box default, the owner's
// — exactly as every turn did before users had languages of their own.

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The device-store key holding `{ [username]: locale }` (user-language.ts `USER_LANGUAGES_KEY`). */
export const USER_LANGUAGES_KEY = "ui_language_by_user";

/**
 * The locales the desktop ships and the names that reach the prompt — the
 * same table as LANG_NAMES in src/lib/language-persona.ts, which
 * src/tests/unit/openclaw-user-language-plugin.test.ts holds this one to.
 */
export const LANG_NAMES = Object.freeze({
  en: "English", bg: "Български", de: "Deutsch", es: "Español",
  fr: "Français", it: "Italiano", ja: "日本語", nl: "Nederlands",
  sv: "Svenska", zh: "中文",
});

/** The store is a few dozen keys; anything far larger is not one ClawBox wrote. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Where ClawBox keeps its device store: `<ClawBox root>/data/config.json`
 * (src/lib/config-store.ts). The gateway does not run with `CLAWBOX_ROOT`
 * set, so the root falls back exactly as scripts/gateway-pre-start.sh resolves
 * it: `$CLAWBOX_HOME_DIR/clawbox`, the home directory when that is unset.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 */
export function deviceStoreFile(env = process.env, home = os.homedir()) {
  const root = env.CLAWBOX_ROOT || path.join(env.CLAWBOX_HOME_DIR || home, "clawbox");
  return path.join(root, "data", "config.json");
}

/**
 * The ClawBox user whose own chat `key` is, or null: `agent:<id>:clawbox-user-<name>`
 * and `agent:<id>:clawbox-utab-<12 hex>-<name>` — the OpenClaw half of
 * `chatKeyUser` in src/lib/chat-scope.ts, held to it by the test named above.
 * The owner's keys, a cron run's and a subagent's are none of these.
 */
const NAME = "[a-z_][a-z0-9_-]{0,31}";
const AGENT = "[a-z0-9][a-z0-9_-]{0,63}";
const USER_MAIN_RE = new RegExp(`^agent:${AGENT}:clawbox-user-(${NAME})$`);
const USER_TAB_RE = new RegExp(`^agent:${AGENT}:clawbox-utab-[0-9a-f]{12}-(${NAME})$`);

export function chatKeyUser(key) {
  if (typeof key !== "string") return null;
  const k = key.trim().toLowerCase();
  const m = USER_MAIN_RE.exec(k) ?? USER_TAB_RE.exec(k);
  return m ? m[1] : null;
}

/** The username rule (src/lib/username-rules.ts USERNAME_RE). */
const USERNAME_RE = new RegExp(`^${NAME}$`);

/** The stored map, read defensively — user-language.ts `parseUserLanguages`. */
export function parseUserLanguages(raw) {
  const out = new Map();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [username, lang] of Object.entries(raw)) {
    if (USERNAME_RE.test(username) && typeof lang === "string" && Object.hasOwn(LANG_NAMES, lang)) {
      out.set(username, lang);
    }
  }
  return out;
}

/**
 * The instruction for one turn in a user's own chat. It has to win over the
 * persona, which names the OWNER's language ("You MUST respond in …" in
 * SOUL.md, "Always respond in …" in USER.md), so it says whose those are.
 */
export function languageInstruction(lang) {
  const name = LANG_NAMES[lang];
  return [
    "## Language of this conversation",
    "",
    `The person in this conversation is a ClawBox user, not the box owner, and their language is ${name} (${lang}).`,
    `Respond in ${name} in this conversation, whatever language SOUL.md or USER.md names: those describe the owner.`,
    "Only use English for code, technical terms, and tool names.",
  ].join("\n");
}

/**
 * The users' languages, read again only when the store changed (its inode,
 * size and time): ClawBox replaces config.json atomically on every write, so
 * the next prompt build sees a new pick with no restart. An empty map when
 * there is no store or it cannot be parsed.
 *
 * Opened once and both checked and read through that handle; non-blocking, so
 * a FIFO in its place cannot hold the turn open.
 */
export function createLanguagesReader(file) {
  let cached = null;
  return async function readLanguages() {
    let fh;
    try {
      fh = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    } catch {
      cached = null;
      return new Map();
    }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return new Map();
      const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (cached?.key === key) return cached.languages;
      let languages = new Map();
      try {
        languages = parseUserLanguages(JSON.parse(await fh.readFile("utf8"))?.[USER_LANGUAGES_KEY]);
      } catch {
        languages = new Map();
      }
      cached = { key, languages };
      return languages;
    } catch {
      cached = null;
      return new Map();
    } finally {
      await fh.close().catch(() => {});
    }
  };
}

/**
 * The `before_prompt_build` answer for one turn: the user's language as system
 * context in their own chat, nothing anywhere else — the owner's chats, cron
 * and automation runs, and a user who never picked a language of their own all
 * keep the persona's.
 *
 * `appendSystemContext`, not `prependContext`: system context is rebuilt with
 * the system prompt on every turn and never lands in the transcript, so a
 * changed pick reaches the next turn and the history carries no copies.
 */
export async function promptContext(ctx, readLanguages) {
  const user = chatKeyUser(ctx?.sessionKey);
  if (!user) return undefined;
  const lang = (await readLanguages()).get(user);
  return lang ? { appendSystemContext: languageInstruction(lang) } : undefined;
}
