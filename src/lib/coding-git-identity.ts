/**
 * WHO the box commits as, resolved per project instead of hard-coded.
 *
 * WHY THIS FILE EXISTS
 *
 * Every commit the coding agent makes on the owner's behalf — the settle's
 * "Coding agent: <brief>", the empty first commit a worktree forks from, the
 * merge that brings a run's branch home, the team's "files present in the
 * checkout before a merge" — used to be authored as a placeholder that belongs
 * to nobody:
 *
 *     ClawBox Coding Agent <coding-agent@clawbox.local>
 *
 * On a project wired to the Vercel GitHub integration that address fails the
 * deployment check with "Git author must have access to the project on Vercel
 * to create deployments". The agent's own bookkeeping commits then block the
 * very pull requests it opened — nothing wrong with the code, and no way to
 * make the check pass from the desk.
 *
 * THE ORDER, and why it is this one:
 *
 *   1. the PROJECT's own git identity (`git -C <dir> config user.name/.email`,
 *      which layers the repository's config over the owner's global one exactly
 *      as git itself would). A repository the owner already commits to by hand
 *      carries the identity they want its history in, and the box has no
 *      business overriding it.
 *   2. the box owner's configured identity in data/config.json
 *      (`coding_agent_git_name` / `coding_agent_git_email`, both editable from
 *      the Coding Agent settings page) — the answer for a fresh checkout that
 *      has no git config of its own, which is the common case on a device that
 *      clones projects for the owner.
 *   3. the placeholder, unchanged, as the LAST resort. A box nobody has told
 *      anything still commits rather than failing with git's "Committer
 *      identity unknown".
 *
 * A SOURCE SUPPLIES BOTH HALVES OR IT SUPPLIES NEITHER. Taking the name from
 * one source and the e-mail from another produces an identity nobody
 * configured — "ClawBox Coding Agent <owner@example.com>" — and the e-mail is
 * the half a deployment check reads, so a half-match is exactly the state that
 * looks configured and is not. Git's own per-key layering still applies WITHIN
 * step 1, because `git config` does it before we ever see the answer.
 */

import { runChild } from "./child-run";
import { get as configGet } from "./config-store";

/** The pair git needs for a commit: `Name <email>`. */
export interface CodingGitIdentity {
  name: string;
  email: string;
}

/** Which of the three sources answered — carried so a caller (and a test) can
 *  say WHY a commit is authored the way it is, rather than inferring it from
 *  the value. */
export type CodingGitIdentitySource = "git" | "config" | "placeholder";

export interface ResolvedCodingGitIdentity extends CodingGitIdentity {
  source: CodingGitIdentitySource;
}

/** config.json keys of the owner's own commit identity. Both optional; absent
 *  means "fall through to the placeholder". */
export const CODING_AGENT_GIT_NAME_CONFIG_KEY = "coding_agent_git_name";
export const CODING_AGENT_GIT_EMAIL_CONFIG_KEY = "coding_agent_git_email";

/**
 * The identity of a box nobody has told anything, and of a project with no git
 * config of its own. Kept — a commit that cannot be authored is a run whose
 * work is not recorded — but it is now the floor rather than the rule.
 */
export const CODING_GIT_PLACEHOLDER: CodingGitIdentity = Object.freeze({
  name: "ClawBox Coding Agent",
  email: "coding-agent@clawbox.local",
});

/** Reading two config keys should never take this long. */
const GIT_CONFIG_TIMEOUT_MS = 10_000;

/** Longer than any real name or address; a guard on what the owner may paste. */
export const MAX_GIT_IDENTITY_CHARS = 200;

/** Below this is a control character; DEL sits at 127. */
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;

/**
 * Control characters, and the two brackets git's own ident parser uses.
 *
 * `Name <email>` is a FORMAT, not a pair of free strings: a `<` inside the name
 * or a newline inside either half produces a commit header git will either
 * reject or read as something other than what was typed. Refused at the door —
 * on the way in from the settings page, and again on the way out of git config,
 * so a value that predates this check cannot reach argv either.
 *
 * Written as a scan rather than a regex character class so the source file
 * carries no control character of its own.
 */
function hasUnsafeIdentChar(value: string): boolean {
  for (const ch of value) {
    if (ch === "<" || ch === ">") return true;
    const code = ch.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE || code === DEL) return true;
  }
  return false;
}

/**
 * `local-part@domain`, and nothing stricter.
 *
 * Deliberately not an RFC 5322 parser: the only property that matters here is
 * that git gets something shaped like an address and GitHub can match it to an
 * account. A dot in the domain is NOT required — `owner@localdomain` is a
 * legitimate thing to commit as on a box that never pushes.
 */
const EMAIL_SHAPE = /^[^\s<>@]+@[^\s<>@]+$/;

/** The owner's name, trimmed, or null when it is absent, blank or unusable. */
export function normalizeCodingGitName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_GIT_IDENTITY_CHARS) return null;
  return hasUnsafeIdentChar(value) ? null : value;
}

/** The owner's address, trimmed, or null when it is absent, blank or not
 *  shaped like an e-mail. */
export function normalizeCodingGitEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_GIT_IDENTITY_CHARS) return null;
  if (hasUnsafeIdentChar(value)) return null;
  return EMAIL_SHAPE.test(value) ? value : null;
}

/**
 * The `-c user.name=… -c user.email=…` prefix every commit-making call passes.
 *
 * `-c` rather than the environment or a written config: it applies to exactly
 * this one git process, it cannot leave anything behind in the owner's
 * repository, and it is what the call sites already did — only with a constant
 * where the resolved identity now goes.
 */
export function identityArgs(identity: CodingGitIdentity): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

/**
 * One `git -C <dir> config --get <key>`, with the coding agent's own
 * environment.
 *
 * HOME is set so the owner's GLOBAL config is in scope: a box with
 * `~/.gitconfig` and no per-repo identity is the ordinary case, and it is the
 * first thing an owner sets up on a machine they code on.
 *
 * GIT_CONFIG_NOSYSTEM, so `/etc/gitconfig` is NOT: the identity this answers is
 * the owner's, per project, and a machine-wide default nobody on this box chose
 * is not that. It is also the environment `commitRunWork` already commits in
 * (coding-git.ts), so the resolver cannot read an identity from a file the
 * committing process would ignore.
 */
async function gitConfigValue(dir: string, key: string): Promise<string | null> {
  const r = await runChild("git", ["-C", dir, "config", "--get", key], {
    timeoutMs: GIT_CONFIG_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/clawbox",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      NO_COLOR: "1",
      LANG: "C",
    },
  });
  // Exit 1 is "not set", which is an ANSWER. Every other failure — a folder
  // that is not there, a killed git, a git that would not start — is not, and
  // both read the same here: this source did not supply an identity, so the
  // next one is asked. Nothing is guessed from a fault.
  return r.code === 0 ? r.stdout : null;
}

/** The project's own identity, when git resolves BOTH halves of it. */
async function gitConfiguredIdentity(dir: string): Promise<CodingGitIdentity | null> {
  const [name, email] = await Promise.all([
    gitConfigValue(dir, "user.name"),
    gitConfigValue(dir, "user.email"),
  ]);
  const cleanName = normalizeCodingGitName(name);
  const cleanEmail = normalizeCodingGitEmail(email);
  return cleanName && cleanEmail ? { name: cleanName, email: cleanEmail } : null;
}

/** What the owner typed on the Coding Agent settings page, when they filled in
 *  both fields. Null otherwise — including for a value stored before the
 *  validation above existed. */
export async function configuredCodingGitIdentity(): Promise<CodingGitIdentity | null> {
  const [name, email] = await Promise.all([
    configGet(CODING_AGENT_GIT_NAME_CONFIG_KEY),
    configGet(CODING_AGENT_GIT_EMAIL_CONFIG_KEY),
  ]);
  const cleanName = normalizeCodingGitName(name);
  const cleanEmail = normalizeCodingGitEmail(email);
  return cleanName && cleanEmail ? { name: cleanName, email: cleanEmail } : null;
}

/**
 * Who a commit made in `projectDir` should be authored as.
 *
 * Never throws and never leaves a caller without an identity: the placeholder
 * is always there underneath, so a commit that used to be made is still made.
 */
export async function resolveCodingGitIdentity(projectDir: string): Promise<ResolvedCodingGitIdentity> {
  if (typeof projectDir === "string" && projectDir.trim() !== "") {
    const fromGit = await gitConfiguredIdentity(projectDir);
    if (fromGit) return { ...fromGit, source: "git" };
  }
  const fromConfig = await configuredCodingGitIdentity();
  if (fromConfig) return { ...fromConfig, source: "config" };
  return { ...CODING_GIT_PLACEHOLDER, source: "placeholder" };
}

/** The resolved identity as the argv prefix, in one call — what the commit
 *  sites actually want. */
export async function codingGitIdentityArgs(projectDir: string): Promise<string[]> {
  return identityArgs(await resolveCodingGitIdentity(projectDir));
}
