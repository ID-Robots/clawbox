/**
 * The FACTORY git identity, taken off the box at boot.
 *
 * WHY THIS FILE EXISTS
 *
 * The Jetson golden flash image ships a personal git identity in the clawbox
 * user's own `~/.gitconfig`:
 *
 *     user.name  = yalexx
 *     user.email = yanko@idrobots.com
 *
 * It belongs to a member of staff who built the image, and every box flashed
 * from it carries it. `resolveCodingGitIdentity` (coding-git-identity.ts) asks
 * `git -C <dir> config --get user.name/.email` first, and git layers the
 * GLOBAL file under the repository's own — so on a freshly flashed box the very
 * first commit the coding agent made for its owner was authored
 * `yalexx <yanko@idrobots.com>`. Measured on a new box: nothing in the owner's
 * history is theirs, and a name they have never heard of is on it.
 *
 * WHY THE FIX IS HERE AND NOT IN THE RESOLVER. The resolver is right: a global
 * identity IS the answer for a project with no config of its own, and that is
 * the ordinary case on a machine somebody codes on. Teaching it to ignore one
 * particular address would leave the same wrong identity in place for `git
 * commit` from the Terminal, for the owner's own hand-made commits, and for
 * every tool on the box that is not this resolver. The value does not belong on
 * the device at all, so it is REMOVED, once, and everything downstream is
 * simply correct afterwards.
 *
 * WHAT IS AND IS NOT TOUCHED
 *
 *   - the GLOBAL config only (`git config --global`), which is the clawbox
 *     user's `~/.gitconfig` — exactly the file the image ships. A repository's
 *     own `.git/config` is never touched: that is the owner's project, its
 *     history's identity is their business, and a boot job rewriting files
 *     inside their repositories is not a fix anyone asked for.
 *   - each key on its own, and only when its value is EXACTLY the factory one.
 *     A box whose owner has set their own name or address keeps it. An image
 *     where only one half survived is still cleaned — "yalexx" over the owner's
 *     own address is no less wrong than the pair.
 *   - nothing at all when the key holds several values and any one of them is
 *     not the factory value: that is an identity somebody assembled, and this
 *     job removes a known string, not a config it does not understand.
 *
 * The flash image itself still has to be cleaned — that is a change in the
 * flash tooling, not here. This runs on every boot precisely because boxes
 * already in the field were flashed from the image as it is.
 */

import { failureDetail, runChild } from "./child-run";

/** The pair the golden image ships. Not a value to write — a value to
 *  RECOGNISE, in the spirit of `PROJECT_IMPORT_PLACEHOLDER` next door. */
export const FACTORY_GIT_IDENTITY = Object.freeze({
  name: "yalexx",
  email: "yanko@idrobots.com",
});

/** The two keys this job looks at, and nothing else in the file. */
export type FactoryIdentityKey = "user.name" | "user.email";

export const FACTORY_IDENTITY_KEYS: readonly FactoryIdentityKey[] = Object.freeze([
  "user.name",
  "user.email",
] as const);

/**
 * Whether a stored value is the factory one.
 *
 * Trimmed and case-folded, for the reason `isBoxWrittenIdentityEmail` gives:
 * git stores whatever was typed, the domain half of an address is
 * case-insensitive by definition, and a re-typed `Yalexx` is the same handle.
 * Case-folding cannot swallow a real identity here because the match is against
 * the WHOLE value — `yalexx2`, `yanko@idrobots.com.example` and any other
 * address at the same domain are all left exactly where they are.
 */
function equalsFactoryValue(key: FactoryIdentityKey, value: string): boolean {
  const factory = key === "user.name" ? FACTORY_GIT_IDENTITY.name : FACTORY_GIT_IDENTITY.email;
  return value.trim().toLowerCase() === factory.toLowerCase();
}

/** Reading and unsetting two keys should never take this long. */
const GIT_CONFIG_TIMEOUT_MS = 10_000;

/** git's own "you tried to unset an option which does not exist". Not a fault:
 *  something else removed it between the read and the write. */
const GIT_NOTHING_TO_UNSET = 5;

/**
 * The environment every git here runs in — the coding agent's own, so this job
 * reads and writes the same file the resolver reads.
 *
 * GIT_CONFIG_NOSYSTEM keeps `/etc/gitconfig` out of it: a machine-wide default
 * is not the clawbox user's global config, and `--global` must not be confused
 * by one. Built from nothing rather than spread over `process.env` for the same
 * reason the resolver builds its own: `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`
 * and friends all move what `--global` means, and a boot job that unsets a key
 * must be certain which file it is unsetting it from.
 */
function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
    LANG: "C",
  };
}

/** Every value the global config holds for a key — or the admission that git
 *  could not be asked, which is not the same as "the key is not set". */
type GlobalValuesProbe =
  | { known: true; values: string[] }
  | { known: false; detail: string };

/**
 * `git config --global --get-all <key>`.
 *
 * `--get-all` rather than `--get`: a key set twice makes `--get` exit 2 without
 * printing anything, and a box whose `.gitconfig` has the factory name in it
 * twice is exactly the box this has to clean. Every value is read, and the
 * decision below is made on all of them.
 */
async function globalValues(home: string, key: FactoryIdentityKey): Promise<GlobalValuesProbe> {
  const r = await runChild("git", ["config", "--global", "--get-all", key], {
    timeoutMs: GIT_CONFIG_TIMEOUT_MS,
    env: gitEnv(home),
  });
  if (r.code === 0) {
    return { known: true, values: r.stdout.split("\n").map((line) => line.trim()).filter(Boolean) };
  }
  // Exit 1, and only exit 1, is git's own "there is no such key" — including
  // the box with no `~/.gitconfig` at all, which is the answer on most of them
  // after the first boot. Everything else is git failing to look: a killed
  // child, a git that would not start, an unreadable file.
  if (r.code === 1 && !r.timedOut && !r.signal && !r.startFailed) return { known: true, values: [] };
  return { known: false, detail: failureDetail(r, `Reading ${key} from the global git config`) };
}

/** What happened to one key. */
export type FactoryIdentityOutcome =
  /** It held the factory value and is gone. */
  | "removed"
  /** It held something else — the owner's own identity — and was left alone. */
  | "kept"
  /** It was not set. The ordinary state of a box this has already cleaned. */
  | "absent"
  /** git could not be asked, or would not unset it. The value is still there. */
  | "failed";

export interface FactoryGitIdentityCleanup {
  /** Per key, so a caller can say exactly what it did rather than infer it. */
  outcomes: Record<FactoryIdentityKey, FactoryIdentityOutcome>;
  /** The keys removed by THIS run — empty on every boot after the first, which
   *  is what makes the job idempotent in the only sense that matters. */
  removed: FactoryIdentityKey[];
  /** One line per key git could not settle. Empty on success. */
  failures: string[];
}

/** The line written to the journal for a key that was removed. Shared with the
 *  tests so the wording cannot drift away from what is asserted. */
export function factoryIdentityRemovedLine(key: FactoryIdentityKey, value: string): string {
  return `[git-identity] Removed the factory ${key} (${value}) from the clawbox user's global git config`;
}

/**
 * Take the factory identity off this box's global git config.
 *
 * Never throws: a box must boot whatever git says. A failure is reported in the
 * result and logged, and the next boot tries again — the whole job is a read
 * and at most two unsets, so running it on every boot costs nothing on a box
 * that is already clean.
 *
 * `home` is the clawbox user's home; the web server runs as that user
 * (`config/clawbox-setup.service`: `User=clawbox`), so the default is simply
 * its own HOME, with the same `/home/clawbox` floor the resolver uses.
 */
export async function clearFactoryGitIdentity(
  options: { home?: string; log?: (message: string) => void } = {},
): Promise<FactoryGitIdentityCleanup> {
  const home = options.home ?? process.env.HOME ?? "/home/clawbox";
  const log = options.log ?? ((message: string) => console.log(message));
  const outcomes = {} as Record<FactoryIdentityKey, FactoryIdentityOutcome>;
  const removed: FactoryIdentityKey[] = [];
  const failures: string[] = [];

  // One key after the other, never together: both unsets rewrite the same
  // `~/.gitconfig` through git's own lock file, and two at once is one of them
  // losing to "could not lock config file" for no reason at all.
  for (const key of FACTORY_IDENTITY_KEYS) {
    const probe = await globalValues(home, key);
    if (!probe.known) {
      outcomes[key] = "failed";
      failures.push(probe.detail);
      log(`[git-identity] ${probe.detail}`);
      continue;
    }
    if (probe.values.length === 0) {
      outcomes[key] = "absent";
      continue;
    }
    // EVERY value, not the effective one. A key holding the factory value and
    // something else is a config somebody has had a hand in, and `--unset-all`
    // would take their value with the one this job is for.
    if (!probe.values.every((value) => equalsFactoryValue(key, value))) {
      outcomes[key] = "kept";
      continue;
    }
    const value = probe.values[probe.values.length - 1];
    // `--unset-all`, because `--unset` refuses a key with more than one value
    // ("has multiple values") and would leave the factory identity in place on
    // precisely the config that needs it removed most.
    const unset = await runChild("git", ["config", "--global", "--unset-all", key], {
      timeoutMs: GIT_CONFIG_TIMEOUT_MS,
      env: gitEnv(home),
    });
    if (unset.code !== 0 && unset.code !== GIT_NOTHING_TO_UNSET) {
      outcomes[key] = "failed";
      const detail = failureDetail(unset, `Removing the factory ${key} from the global git config`);
      failures.push(detail);
      log(`[git-identity] ${detail}`);
      continue;
    }
    // READ IT BACK, because a zero exit is not proof. `--global` READS both
    // `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config` and WRITES to only one
    // of them, so a value living in the other is answered by the probe above
    // and then not found by the unset — which exits 5, the code this treats as
    // "somebody else removed it". Reporting that as removed would leave the
    // factory identity on the box behind a journal line saying it was gone.
    const after = await globalValues(home, key);
    if (!after.known || after.values.some((value) => equalsFactoryValue(key, value))) {
      outcomes[key] = "failed";
      const detail = after.known
        ? `The factory ${key} is still in the global git config after git was asked to unset it.`
        : after.detail;
      failures.push(detail);
      log(`[git-identity] ${detail}`);
      continue;
    }
    outcomes[key] = "removed";
    removed.push(key);
    log(factoryIdentityRemovedLine(key, value));
  }

  return { outcomes, removed, failures };
}
