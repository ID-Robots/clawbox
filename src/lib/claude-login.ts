/**
 * The `claude` sign-in the owner made on this box themselves — asked about,
 * never read for its credential, never written.
 *
 * Its own module because two others need it and each needs the other: the
 * connection state in src/lib/coding-anthropic.ts and the account pool in
 * src/lib/anthropic-accounts.ts, where the sign-in is one account among the
 * others (the `login` kind). coding-anthropic.ts re-exports what it always
 * exported, so no caller moved.
 *
 * Asked of the files rather than by running `claude`: the CLI has no
 * non-interactive "who am I" that answers in under a second, and this is read
 * on every status poll. Two places count, because which one holds the answer
 * depends on the CLI's version — the credential file it writes on Linux, and
 * the account block in its top-level config.
 */

import fs from "fs";
import os from "os";
import path from "path";

/** Where `claude` writes an OAuth credential on Linux. */
function credentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

/** Claude Code's top-level config, which records the signed-in account. */
function claudeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

function readableNonEmptyFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

interface ConfigAccount {
  present: boolean;
  email: string | null;
}

/**
 * The last verdict about `~/.claude.json`, keyed on what would change it.
 *
 * The Coding Agent app polls the status route every five seconds while a run
 * or a pull request is in flight, and each poll reached the branch below: a
 * SYNCHRONOUS whole-file read plus a `JSON.parse`, on the web server's event
 * loop. That file is Claude Code's own and grows a `projects` entry for every
 * folder the owner has ever opened, so on a box in daily use it is not small.
 *
 * Keyed on size and mtime rather than a timer alone: the answer changes only
 * when the file does, and a sign-in the owner has just made must show up at
 * the next poll rather than after a TTL. The TTL is the other half — it
 * bounds a clock that went backwards and an mtime granularity coarser than
 * the poll — so the worst case is one stale answer, and the stale answer is
 * never used to REFUSE anything: a run's own gate re-reads (assertCanSpawn),
 * and the wrapper reads the file itself immediately before exec.
 */
let configLoginCache: { key: string; at: number; answer: ConfigAccount } | null = null;

/** How long a cached verdict may stand even if nothing about the file changed. */
const LOGIN_CACHE_TTL_MS = 5_000;

const NO_ACCOUNT: ConfigAccount = { present: false, email: null };

/** The whole-file read, cached. Answers "no account" for anything it cannot read. */
function configAccount(): ConfigAccount {
  let key: string;
  try {
    const stat = fs.statSync(claudeConfigPath());
    key = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    // No config at all is a stable, cheap answer — and not one worth caching,
    // since a stat is all it cost.
    return NO_ACCOUNT;
  }
  const now = Date.now();
  if (configLoginCache && configLoginCache.key === key && now - configLoginCache.at < LOGIN_CACHE_TTL_MS) {
    return configLoginCache.answer;
  }
  let answer = NO_ACCOUNT;
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeConfigPath(), "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const account = (parsed as { oauthAccount?: unknown }).oauthAccount;
      if (typeof account === "object" && account !== null) {
        const email = (account as { emailAddress?: unknown }).emailAddress;
        answer = { present: true, email: typeof email === "string" && email.includes("@") ? email.slice(0, 254) : null };
      }
    }
  } catch {
    answer = NO_ACCOUNT;
  }
  configLoginCache = { key, at: now, answer };
  return answer;
}

/** Test seam: forget what was read, so a case can rewrite the file under it. */
export function _resetAnthropicLoginCache(): void {
  configLoginCache = null;
}

/**
 * Has the owner signed `claude` in on this box?
 *
 * The credential file is checked FIRST and is a `stat`, so the common case —
 * a box where the owner has signed in — never opens the larger config at all.
 */
export function hasAnthropicLogin(): boolean {
  if (readableNonEmptyFile(credentialsPath())) return true;
  return configAccount().present;
}

/**
 * The email the sign-in belongs to, when Claude Code recorded one — a LABEL
 * for the owner's account list, never used to decide anything.
 */
export function anthropicLoginEmail(): string | null {
  return configAccount().email;
}
