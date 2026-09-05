/**
 * Bringing an EXISTING project into the owner's project folder: a clone of
 * one of their GitHub repositories, or a copy of a folder already on the
 * box. Both land as `<project folder>/<name>`, which is exactly what the
 * Coding Agent lists (listProjects: a folder with a `.git` of its own), so
 * an import is a project the moment it finishes.
 *
 * WHY A COPY, NOT A LINK, FOR A FOLDER
 *
 * The owner asked for "import from folder that copies the folder": the
 * project folder is where runs work, commit and branch, and a symlink out
 * of it would put a run's commits into a tree the owner keeps elsewhere.
 * `readFolderNames` never follows a link for the same reason. The source is
 * left exactly as it was.
 *
 * WHAT IS REFUSED
 *
 * - a source under a credential store or the ClawBox checkout
 *   (`isProtectedFilePath`, and the checkout's `data/` most of all — a copy
 *   of data/ into a folder runs can read would hand every secret to a run);
 * - a source that is the project folder, inside it (it is a project already,
 *   or a run's folder), or an ancestor of it (the copy would recurse into
 *   itself);
 * - a name already taken in the project folder: nothing is merged or
 *   overwritten, ever.
 *
 * `node_modules` is not copied — it is rebuilt by an install, weighs more
 * than the rest of most projects put together, and the copy would take
 * minutes on this disk. The response says so.
 *
 * GITHUB
 *
 * The listing and the clone go through `gh`, the CLI the owner connected in
 * Settings (coding-github.ts): `gh api user/repos` for what they can see,
 * `gh api search/code` for which of those carry a clawbox.json, and a
 * `git clone` whose credential gh lends (GIT_CREDENTIAL_HELPER). The token
 * is never in this process.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { type ChildResult, failureDetail, runChild, startedMissing, wasKilled } from "@/lib/child-run";
import { CONFIG_ROOT } from "@/lib/config-store";
import { isInside, isProtectedFilePath } from "@/lib/file-guard";
import { CLAWBOX_MANIFEST_FILE } from "@/lib/clawbox-manifest";
import { githubStatus } from "@/lib/coding-github";

/** A folder name the project folder will take, from a repository or folder name. */
export function importFolderName(raw: string): string {
  const base = path.basename(raw.trim()).replace(/\.git$/i, "");
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64);
  return clean || "project";
}

/** Folders left behind on a copy — rebuilt by an install, not part of the project. */
export const IMPORT_SKIPPED_FOLDERS: readonly string[] = ["node_modules"];

const GH_TIMEOUT_MS = 60_000;
/** A clone of a big repository over the owner's uplink. */
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** Per page of the listing; the most GitHub gives. */
const REPOS_PER_PAGE = 100;
/** Pages read: the owner picks from a list, and three hundred rows is a list nobody scrolls. */
const REPOS_MAX_PAGES = 3;

const COMMIT_NAME = "ClawBox";
const COMMIT_EMAIL = "clawbox@localhost";

function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ChildResult> {
  return runChild(bin, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? os.homedir(),
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      LANG: "C",
    },
  });
}

// ── GitHub: the owner's repositories ─────────────────────────────────────────

export interface GitHubRepo {
  /** "owner/name" — what the clone takes. */
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  /** ISO time of the last push, for the sort and the row. */
  pushedAt: string | null;
  defaultBranch: string | null;
  /** True when the repository carries a clawbox.json (as GitHub's code search sees it), false when it does not, null when the search could not say. */
  clawboxApp: boolean | null;
  /** The folder the import would create. */
  folder: string;
}

export type GitHubReposOutcome =
  | { ok: true; login: string; repos: GitHubRepo[]; truncated: boolean }
  | { ok: false; reason: "no_gh" | "not_connected" | "gh_unreachable" | "failed"; detail: string };

/** One page of `gh api user/repos`, as an array of records, or null when it is not that. */
function parseRepoPage(stdout: string): Record<string, unknown>[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : null;
  } catch {
    return null;
  }
}

/** A repository row out of GitHub's JSON, or null for a row without the fields the import needs. */
export function repoFromApi(raw: Record<string, unknown>): Omit<GitHubRepo, "clawboxApp"> | null {
  const fullName = typeof raw.full_name === "string" ? raw.full_name : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  const owner = raw.owner && typeof raw.owner === "object" && typeof (raw.owner as { login?: unknown }).login === "string"
    ? (raw.owner as { login: string }).login
    : null;
  if (!fullName || !name || !owner || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return null;
  return {
    fullName,
    name,
    owner,
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim().slice(0, 300) : null,
    private: raw.private === true,
    pushedAt: typeof raw.pushed_at === "string" ? raw.pushed_at : null,
    defaultBranch: typeof raw.default_branch === "string" ? raw.default_branch : null,
    folder: importFolderName(name),
  };
}

/**
 * Which of the owner's repositories carry a clawbox.json, by one code
 * search over every owner in the listing. `null` when GitHub would not say
 * (the code search is rate-limited apart from everything else, and refuses
 * an account that has not verified an email): the rows then show no chip
 * rather than a wrong one.
 */
export async function findClawboxRepos(owners: string[]): Promise<Set<string> | null> {
  if (owners.length === 0) return new Set();
  const qualifiers = [...new Set(owners)].slice(0, 10).map((o) => `user:${o}`).join(" ");
  const q = `filename:${CLAWBOX_MANIFEST_FILE} ${qualifiers}`;
  const r = await run("gh", ["api", "-X", "GET", "search/code", "-f", `q=${q}`, "-f", "per_page=100"]);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { items?: { name?: unknown; path?: unknown; repository?: { full_name?: unknown } }[] };
    const found = new Set<string>();
    for (const item of parsed.items ?? []) {
      // The file at the ROOT and nothing else: a clawbox.json three folders
      // deep is somebody's fixture, not the repository's manifest.
      if (item.path !== CLAWBOX_MANIFEST_FILE) continue;
      const full = item.repository?.full_name;
      if (typeof full === "string") found.add(full);
    }
    return found;
  } catch {
    return null;
  }
}

/** The repositories the connected account can see, newest push first. */
export async function listGitHubRepos(): Promise<GitHubReposOutcome> {
  const status = await githubStatus();
  if (status.reason === "unreachable") return { ok: false, reason: "gh_unreachable", detail: "Could not reach GitHub from this ClawBox. Check the network connection and try again." };
  if (!status.installed) return { ok: false, reason: "no_gh", detail: "The GitHub CLI (gh) is not installed on this ClawBox." };
  if (!status.connected || !status.login) return { ok: false, reason: "not_connected", detail: "Connect a GitHub account in the Coding Agent's settings first." };

  const rows: Omit<GitHubRepo, "clawboxApp">[] = [];
  let truncated = false;
  for (let page = 1; page <= REPOS_MAX_PAGES; page++) {
    const r = await run("gh", ["api", `user/repos?per_page=${REPOS_PER_PAGE}&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`]);
    if (r.startFailed) {
      return { ok: false, reason: startedMissing(r) ? "no_gh" : "failed", detail: failureDetail(r, "Listing the GitHub repositories") };
    }
    if (wasKilled(r)) return { ok: false, reason: "gh_unreachable", detail: failureDetail(r, "Listing the GitHub repositories", "Check this ClawBox's network connection and try again.") };
    if (r.code !== 0) return { ok: false, reason: "failed", detail: failureDetail(r, "Listing the GitHub repositories") };
    const parsed = parseRepoPage(r.stdout);
    if (!parsed) return { ok: false, reason: "failed", detail: "GitHub answered with something other than a list of repositories." };
    for (const raw of parsed) {
      const repo = repoFromApi(raw);
      if (repo) rows.push(repo);
    }
    if (parsed.length < REPOS_PER_PAGE) break;
    if (page === REPOS_MAX_PAGES) truncated = true;
  }
  const apps = await findClawboxRepos(rows.map((r) => r.owner));
  const repos: GitHubRepo[] = rows.map((r) => ({ ...r, clawboxApp: apps === null ? null : apps.has(r.fullName) }));
  return { ok: true, login: status.login, repos, truncated };
}

// ── The import itself ────────────────────────────────────────────────────────

export type ImportReason =
  | "no_project_folder"
  | "invalid"
  | "exists"
  | "not_found"
  | "not_a_folder"
  | "refused"
  | "no_gh"
  | "not_connected"
  | "gh_unreachable"
  | "failed";

export type ImportOutcome =
  | { ok: true; directory: string; folder: string; initialized: boolean; skipped: string[] }
  | { ok: false; reason: ImportReason; detail: string };

/** A free name in the project folder, or the refusal. */
async function claimTarget(projectsRoot: string, folder: string): Promise<{ ok: true; directory: string } | { ok: false; reason: ImportReason; detail: string }> {
  const directory = path.join(projectsRoot, folder);
  const existing = await fs.promises.lstat(directory).catch(() => null);
  if (existing) return { ok: false, reason: "exists", detail: `There is already a "${folder}" in your project folder. Rename or remove it first.` };
  return { ok: true, directory };
}

/**
 * Give an imported folder a repository of its own when it has none, with one
 * commit that says where it came from — a project is listed by its history,
 * and a run's first commit should not be "everything".
 */
async function ensureRepository(directory: string, from: string): Promise<{ initialized: boolean; detail: string | null }> {
  const dotGit = await fs.promises.stat(path.join(directory, ".git")).catch(() => null);
  if (dotGit?.isDirectory()) return { initialized: false, detail: null };
  const init = await run("git", ["init", "--quiet"], { cwd: directory });
  if (init.code !== 0) return { initialized: false, detail: failureDetail(init, "Creating a git repository for the folder") };
  await run("git", ["config", "user.name", COMMIT_NAME], { cwd: directory });
  await run("git", ["config", "user.email", COMMIT_EMAIL], { cwd: directory });
  await run("git", ["add", "-A"], { cwd: directory });
  const commit = await run("git", ["commit", "--quiet", "--allow-empty", "-m", `Imported from ${from}`], { cwd: directory });
  if (commit.code !== 0) return { initialized: true, detail: failureDetail(commit, "Recording the first commit") };
  return { initialized: true, detail: null };
}

/** Expand a leading `~` the way a shell would; the owner types paths as they type them in the Terminal. */
export function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * Copy a folder on the box into the project folder. `source` is what the
 * owner typed (absolute, or `~/…`).
 */
export async function importFolder(input: { source: string; projectsRoot: string | null }): Promise<ImportOutcome> {
  if (!input.projectsRoot) return { ok: false, reason: "no_project_folder", detail: "Set a project folder in the Coding Agent's settings first." };
  const typed = expandHome(input.source ?? "");
  if (!typed || !path.isAbsolute(typed)) return { ok: false, reason: "invalid", detail: "Give the folder as an absolute path, e.g. /home/clawbox/old-site or ~/old-site." };
  const source = path.resolve(typed);
  const projectsRoot = path.resolve(input.projectsRoot);

  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat) return { ok: false, reason: "not_found", detail: `There is no folder at ${source}.` };
  if (!stat.isDirectory()) return { ok: false, reason: "not_a_folder", detail: `${source} is a file, not a folder.` };
  const real = await fs.promises.realpath(source).catch(() => source);
  const realRoot = await fs.promises.realpath(projectsRoot).catch(() => projectsRoot);

  // The fences, in the order a reader would ask: is it secret, is it ClawBox's
  // own, is it the project folder or in it, is the project folder in it.
  if (isProtectedFilePath(source) || isProtectedFilePath(real)) {
    return { ok: false, reason: "refused", detail: "That folder holds this ClawBox's own configuration or credentials and cannot become a project." };
  }
  const checkout = path.resolve(CONFIG_ROOT);
  if (isInside(real, checkout) || isInside(source, checkout)) {
    return { ok: false, reason: "refused", detail: "That folder is part of the ClawBox software itself. Point the import at your own folder." };
  }
  if (isInside(real, realRoot) || isInside(source, projectsRoot)) {
    return { ok: false, reason: "refused", detail: "That folder is already inside your project folder." };
  }
  if (isInside(realRoot, real) || isInside(projectsRoot, source)) {
    return { ok: false, reason: "refused", detail: "That folder contains your project folder; the copy would never end." };
  }

  const folder = importFolderName(source);
  const target = await claimTarget(projectsRoot, folder);
  if (!target.ok) return target;

  const skipped: string[] = [];
  try {
    await fs.promises.cp(real, target.directory, {
      recursive: true,
      errorOnExist: true,
      force: false,
      // A link inside the source is copied as a link, never followed: a link
      // to /etc or to the checkout would otherwise become a copy of it.
      dereference: false,
      filter: (src) => {
        const base = path.basename(src);
        if (IMPORT_SKIPPED_FOLDERS.includes(base) && src !== real) {
          if (!skipped.includes(base)) skipped.push(base);
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    await fs.promises.rm(target.directory, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: "failed", detail: `Copying the folder failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400) };
  }
  const repo = await ensureRepository(target.directory, source);
  if (repo.detail) console.error(`[coding-agent] import of ${source}: ${repo.detail}`);
  return { ok: true, directory: target.directory, folder, initialized: repo.initialized, skipped };
}

const FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Clone one of the connected account's repositories into the project folder. */
export async function importGitHubRepo(input: { fullName: string; projectsRoot: string | null }): Promise<ImportOutcome> {
  if (!input.projectsRoot) return { ok: false, reason: "no_project_folder", detail: "Set a project folder in the Coding Agent's settings first." };
  const fullName = (input.fullName ?? "").trim();
  if (!FULL_NAME_RE.test(fullName) || fullName.includes("..")) return { ok: false, reason: "invalid", detail: "Name the repository as owner/name." };
  const projectsRoot = path.resolve(input.projectsRoot);

  const status = await githubStatus();
  if (status.reason === "unreachable") return { ok: false, reason: "gh_unreachable", detail: "Could not reach GitHub from this ClawBox. Check the network connection and try again." };
  if (!status.installed) return { ok: false, reason: "no_gh", detail: "The GitHub CLI (gh) is not installed on this ClawBox." };
  if (!status.connected) return { ok: false, reason: "not_connected", detail: "Connect a GitHub account in the Coding Agent's settings first." };

  const folder = importFolderName(fullName.split("/")[1]);
  const target = await claimTarget(projectsRoot, folder);
  if (!target.ok) return target;
  await fs.promises.mkdir(projectsRoot, { recursive: true }).catch(() => undefined);

  // `gh repo clone` rather than a bare git clone: it knows the account's
  // protocol and lends the credential on every gh version, and it takes the
  // owner/name form the listing gave.
  const r = await run("gh", ["repo", "clone", fullName, target.directory, "--", "--quiet"], { cwd: projectsRoot, timeoutMs: CLONE_TIMEOUT_MS });
  if (r.code !== 0) {
    await fs.promises.rm(target.directory, { recursive: true, force: true }).catch(() => undefined);
    if (r.startFailed) return { ok: false, reason: startedMissing(r) ? "no_gh" : "failed", detail: failureDetail(r, "Cloning the repository") };
    if (wasKilled(r)) return { ok: false, reason: "gh_unreachable", detail: failureDetail(r, "Cloning the repository", "Check this ClawBox's network connection and try again.") };
    return { ok: false, reason: "failed", detail: failureDetail(r, "Cloning the repository") };
  }
  return { ok: true, directory: target.directory, folder, initialized: false, skipped: [] };
}
