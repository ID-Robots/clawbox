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
 * - a source outside the owner's home directory (the one fence that stands
 *   on its own, checked on the typed path and on the real one);
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
  const clean = trimEdges(base.replace(/[^A-Za-z0-9._-]/g, "-")).slice(0, 64);
  return clean || "project";
}

/** The root with one trailing separator, for a "begins with the root" check that a root of "/" does not trip. */
function withSep(root: string): string {
  return root.endsWith(path.sep) ? root : root + path.sep;
}

/** Strip leading and trailing dots and dashes — one pass, no backtracking. */
function trimEdges(name: string): string {
  let start = 0;
  let end = name.length;
  while (start < end && (name[start] === "-" || name[start] === ".")) start++;
  while (end > start && (name[end - 1] === "-" || name[end - 1] === ".")) end--;
  return name.slice(start, end);
}

/** One line for the log: a user-typed value can carry a newline that would forge a second entry. */
function forLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
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

/** How many owners are searched for manifests per listing: the code search allows ten calls a minute. */
export const MANIFEST_SEARCH_OWNERS_MAX = 5;

/**
 * Which repositories carry a clawbox.json at their root, one code search
 * PER OWNER (GitHub's code search takes one `user:` qualifier), the first
 * MANIFEST_SEARCH_OWNERS_MAX owners of the listing. `searched` says whose
 * repositories were asked about: a row of an owner beyond the cap, or of
 * a search GitHub refused (it is rate-limited apart from everything else,
 * and refuses an account without a verified email), shows no chip rather
 * than a wrong one.
 */
export async function findClawboxRepos(owners: string[]): Promise<{ found: Set<string>; searched: Set<string> }> {
  const found = new Set<string>();
  const searched = new Set<string>();
  for (const owner of [...new Set(owners)].slice(0, MANIFEST_SEARCH_OWNERS_MAX)) {
    const r = await run("gh", ["api", "-X", "GET", "search/code", "-f", `q=filename:${CLAWBOX_MANIFEST_FILE} user:${owner}`, "-f", "per_page=100"]);
    if (r.code !== 0) continue;
    try {
      const parsed = JSON.parse(r.stdout) as { items?: { name?: unknown; path?: unknown; repository?: { full_name?: unknown } }[] };
      for (const item of parsed.items ?? []) {
        // The file at the ROOT and nothing else: a clawbox.json three folders
        // deep is somebody's fixture, not the repository's manifest.
        if (item.path !== CLAWBOX_MANIFEST_FILE) continue;
        const full = item.repository?.full_name;
        if (typeof full === "string") found.add(full);
      }
      searched.add(owner);
    } catch {
      // GitHub answered with something other than a search result: unknown.
    }
  }
  return { found, searched };
}

/**
 * How long a listing is answered from the last one. Measured on the box:
 * 4.5-5.3 s per call, of which the connection probe is a fraction — the rest
 * is up to three pages of `gh api user/repos` and five code searches, each a
 * fresh `gh` boot, and the Import panel pays for all of it on every mount.
 * Served stale-while-revalidate past the window: the cached rows go back at
 * once and a refresh runs behind them, so only the first open after a
 * web-server boot waits.
 */
export const REPOS_STALE_AFTER_MS = 5 * 60_000;

/**
 * The last successful listing, keyed by the account it belongs to. Failures
 * are never cached — a rate-limited or half-answered listing must not be
 * served for five minutes — and the account is re-probed on every call rather
 * than cached with it, so signing out of GitHub still answers `not_connected`
 * on the very next request instead of handing back the rows of an account
 * that is no longer connected.
 */
let reposCache: { login: string; repos: GitHubRepo[]; truncated: boolean; at: number } | null = null;
/**
 * The listing being fetched right now, KEYED BY THE ACCOUNT it is for.
 *
 * One slot for every account meant a caller that had just resolved a different
 * login joined whichever refresh happened to be running and was handed the
 * other account's rows: sign out of A and into B while A's five-second listing
 * is still going, and B's Import panel showed A's private repositories. Keyed,
 * B starts its own; each entry is dropped as its own fetch settles.
 */
const reposRefresh = new Map<string, Promise<GitHubReposOutcome>>();
/**
 * The account the last resolved probe saw. `gh` answers as whoever is signed
 * in AT THE MOMENT of each call, not as the login the refresh was started for,
 * so a switch mid-listing produces rows that belong to neither cleanly — this
 * is what `fetchGitHubRepos` checks before it files or returns them.
 */
let activeLogin: string | null = null;
/**
 * Bumped every time the signed-in account CHANGES, sign-out included.
 *
 * Comparing the login alone is not enough: `gh` reads the credential out of
 * HOME at each boot, so an A → B → A switch during A's eight boots collects
 * some of B's rows and then passes a `activeLogin === "A"` check at the end.
 * A listing that saw the counter move is a listing that may be half one
 * account's, whoever is signed in when it finishes.
 */
let accountEpoch = 0;

/** Record who is signed in now, and note it if that is somebody else. */
function setActiveLogin(login: string | null): void {
  if (activeLogin === login) return;
  activeLogin = login;
  accountEpoch += 1;
}

/** For the tests: forget the cached listing. */
export function _resetGitHubReposCacheForTests(): void {
  reposCache = null;
  reposRefresh.clear();
  activeLogin = null;
  accountEpoch = 0;
}

/** The repositories the connected account can see, newest push first. */
export async function listGitHubRepos(): Promise<GitHubReposOutcome> {
  const status = await githubStatus();
  if (status.reason === "unreachable") return { ok: false, reason: "gh_unreachable", detail: "Could not reach GitHub from this ClawBox. Check the network connection and try again." };
  if (!status.installed) return { ok: false, reason: "no_gh", detail: "The GitHub CLI (gh) is not installed on this ClawBox." };
  if (!status.connected || !status.login) {
    // Signing out IS an account change: an in-flight listing for the account
    // that has just gone must not be filed or served.
    setActiveLogin(null);
    return { ok: false, reason: "not_connected", detail: "Connect a GitHub account in the Coding Agent's settings first." };
  }

  const login = status.login;
  setActiveLogin(login);
  const cached = reposCache?.login === login ? reposCache : null;
  if (cached) {
    // Nobody is waiting on the refresh, so its failure must not surface as an
    // unhandled rejection on a request that already answered.
    if (Date.now() - cached.at >= REPOS_STALE_AFTER_MS) void startRepoRefresh(login).catch(() => undefined);
    return { ok: true, login, repos: cached.repos, truncated: cached.truncated };
  }
  return startRepoRefresh(login);
}

/**
 * One listing PER ACCOUNT at a time: a second caller arriving on a cold cache
 * joins the first rather than starting another eight `gh` boots — but only
 * when it is asking about the same account (see `reposRefresh`).
 */
function startRepoRefresh(login: string): Promise<GitHubReposOutcome> {
  const running = reposRefresh.get(login);
  if (running) return running;
  const started: Promise<GitHubReposOutcome> = fetchGitHubRepos(login).finally(() => {
    // Only our own entry: a later refresh for this account has already
    // replaced it if this one was somehow still registered.
    if (reposRefresh.get(login) === started) reposRefresh.delete(login);
  });
  reposRefresh.set(login, started);
  return started;
}

async function fetchGitHubRepos(login: string): Promise<GitHubReposOutcome> {
  // The account as it stands at the FIRST boot. Every `gh` below answers as
  // whoever is signed in at the moment it runs.
  const startedAtEpoch = accountEpoch;
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
  const repos: GitHubRepo[] = rows.map((r) => ({ ...r, clawboxApp: apps.searched.has(r.owner) ? apps.found.has(r.fullName) : null }));
  // The account may have changed under this listing — five seconds of `gh`
  // boots is long enough for the owner to sign out and back in, and every one
  // of those boots answered as whoever was signed in at the time. So the rows
  // are neither cached under `login` nor handed back: a listing that may be
  // half one account's and half another's belongs to nobody.
  //
  // The EPOCH, not just the login: an A → B → A switch ends with `activeLogin`
  // back on A and rows that are partly B's, which the name comparison alone
  // waves through.
  if (activeLogin !== login || accountEpoch !== startedAtEpoch) {
    return { ok: false, reason: "failed", detail: "The GitHub account changed while this ClawBox was listing its repositories. Try again." };
  }
  reposCache = { login, repos, truncated, at: Date.now() };
  return { ok: true, login, repos, truncated };
}

// ── The import itself ────────────────────────────────────────────────────────

export type ImportReason =
  | "no_project_folder"
  | "invalid"
  | "exists"
  | "not_found"
  | "not_a_folder"
  | "refused"
  | "too_big"
  | "no_space"
  | "no_gh"
  | "not_connected"
  | "gh_unreachable"
  | "failed";

/** The most a project import may weigh, and the most files it may hold. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const IMPORT_MAX_FILES = 100_000;
/** Free space the disk must keep AFTER the import: a full disk takes the box's own data with it. */
export const IMPORT_FREE_RESERVE_BYTES = 512 * 1024 * 1024;

/** Bytes free on the disk `dir` sits on, or null when the disk will not say. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * What a folder weighs, without following links and without node_modules
 * — stopping as soon as a cap is passed, so a huge tree costs a bounded
 * walk. `over` says which cap it passed.
 */
export async function measureFolder(root: string): Promise<{ bytes: number; files: number; over: "bytes" | "files" | null }> {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IMPORT_SKIPPED_FOLDERS.includes(e.name)) continue;
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      files += 1;
      if (files > IMPORT_MAX_FILES) return { bytes, files, over: "files" };
      const st = await fs.promises.lstat(path.join(dir, e.name)).catch(() => null);
      bytes += st?.size ?? 0;
      if (bytes > IMPORT_MAX_BYTES) return { bytes, files, over: "bytes" };
    }
  }
  return { bytes, files, over: null };
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * Imports run ONE AT A TIME: the free-space check reads a snapshot, and two
 * copies passing the same snapshot together could take the reserve with
 * them. A promise chain is the whole lock — a request waits for the one
 * before it, whether that one succeeded or not.
 */
let importChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = importChain.then(work, work);
  importChain = run.catch(() => undefined);
  return run;
}

/** Room for `bytes` more on the project folder's disk, keeping the reserve, or the refusal. */
async function roomFor(projectsRoot: string, bytes: number): Promise<{ ok: false; reason: ImportReason; detail: string } | null> {
  const free = await freeBytes(projectsRoot);
  if (free === null) return null;
  if (free - bytes < IMPORT_FREE_RESERVE_BYTES) {
    return { ok: false, reason: "no_space", detail: `Not enough space: the import needs about ${humanSize(bytes)} and the disk has ${humanSize(Math.max(0, free - IMPORT_FREE_RESERVE_BYTES))} to spare.` };
  }
  return null;
}

export type ImportOutcome =
  | { ok: true; directory: string; folder: string; initialized: boolean; skipped: string[] }
  | { ok: false; reason: ImportReason; detail: string };

/**
 * A free name in the project folder, CLAIMED: the folder is made here, with
 * a `mkdir` that fails when it exists, so two imports of one name cannot
 * both pass a check and then clean each other's work away — the loser is
 * refused at the claim. The winner copies or clones INTO the empty folder
 * it owns, and removes only that on failure.
 */
async function claimTarget(projectsRoot: string, folder: string): Promise<{ ok: true; directory: string } | { ok: false; reason: ImportReason; detail: string }> {
  const root = path.resolve(projectsRoot);
  const directory = path.resolve(root, folder);
  // Directly inside the project folder and nothing else — the name was made
  // by importFolderName, and this is the check that stands on its own: the
  // resolved path must begin with the root plus a separator (a root of "/",
  // which the setting's validator refuses but an older stored value could
  // carry, already ends with one) and have the root as its parent.
  if (!directory.startsWith(withSep(root)) || path.dirname(directory) !== root) {
    return { ok: false, reason: "invalid", detail: "The project's name is not one the project folder can hold." };
  }
  await fs.promises.mkdir(root, { recursive: true }).catch(() => undefined);
  try {
    await fs.promises.mkdir(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, reason: "exists", detail: `There is already a "${folder}" in your project folder. Rename or remove it first.` };
    }
    return { ok: false, reason: "failed", detail: `Could not make the project folder: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
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
export function importFolder(input: { source: string; projectsRoot: string | null }): Promise<ImportOutcome> {
  return oneAtATime(() => importFolderNow(input));
}

async function importFolderNow(input: { source: string; projectsRoot: string | null }): Promise<ImportOutcome> {
  if (!input.projectsRoot) return { ok: false, reason: "no_project_folder", detail: "Set a project folder in the Coding Agent's settings first." };
  const typed = expandHome(input.source ?? "");
  if (!typed || !path.isAbsolute(typed)) return { ok: false, reason: "invalid", detail: "Give the folder as an absolute path, e.g. /home/clawbox/old-site or ~/old-site." };
  const source = path.resolve(typed);
  const projectsRoot = path.resolve(input.projectsRoot);
  // A folder under the owner's HOME, and nothing else: that is where their
  // own work lives (the Files app browses the same tree), and it is the one
  // fence that stands on its own — said as "begins with home plus a
  // separator" on the resolved path, before any read of it.
  const home = path.resolve(os.homedir());
  // A home of "/" would make the fence the whole disk.
  if (home === path.sep) return { ok: false, reason: "refused", detail: "This box's home directory is the filesystem root; nothing can be imported from it." };
  if (!source.startsWith(withSep(home))) {
    return { ok: false, reason: "refused", detail: `Only a folder under ${home} can be imported.` };
  }

  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat) return { ok: false, reason: "not_found", detail: `There is no folder at ${source}.` };
  if (!stat.isDirectory()) return { ok: false, reason: "not_a_folder", detail: `${source} is a file, not a folder.` };
  const real = await fs.promises.realpath(source).catch(() => source);
  // The same fence on the REAL path: a link under home to a folder outside it.
  if (!real.startsWith(withSep(home))) {
    return { ok: false, reason: "refused", detail: `Only a folder under ${home} can be imported.` };
  }
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

  const measured = await measureFolder(real);
  if (measured.over === "bytes") return { ok: false, reason: "too_big", detail: `That folder is over ${humanSize(IMPORT_MAX_BYTES)} (node_modules aside); a project import is capped there.` };
  if (measured.over === "files") return { ok: false, reason: "too_big", detail: `That folder holds more than ${IMPORT_MAX_FILES.toLocaleString("en-US")} files (node_modules aside); a project import is capped there.` };
  const room = await roomFor(projectsRoot, measured.bytes);
  if (room) return room;

  const folder = importFolderName(source);
  const target = await claimTarget(projectsRoot, folder);
  if (!target.ok) return target;

  const skipped: string[] = [];
  try {
    await fs.promises.cp(real, target.directory, {
      recursive: true,
      // Into the empty folder the claim made: nothing is there to overwrite,
      // and `force: false` keeps it that way should anything appear.
      errorOnExist: false,
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
  if (repo.detail) console.error(`[coding-agent] a folder import's repository could not be made: ${forLog(repo.detail)}`);
  return { ok: true, directory: target.directory, folder, initialized: repo.initialized, skipped };
}

const FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Clone one of the connected account's repositories into the project folder. */
export function importGitHubRepo(input: { fullName: string; projectsRoot: string | null }): Promise<ImportOutcome> {
  return oneAtATime(() => importGitHubRepoNow(input));
}

async function importGitHubRepoNow(input: { fullName: string; projectsRoot: string | null }): Promise<ImportOutcome> {
  if (!input.projectsRoot) return { ok: false, reason: "no_project_folder", detail: "Set a project folder in the Coding Agent's settings first." };
  const fullName = (input.fullName ?? "").trim();
  if (!FULL_NAME_RE.test(fullName) || fullName.includes("..")) return { ok: false, reason: "invalid", detail: "Name the repository as owner/name." };
  const projectsRoot = path.resolve(input.projectsRoot);

  const status = await githubStatus();
  if (status.reason === "unreachable") return { ok: false, reason: "gh_unreachable", detail: "Could not reach GitHub from this ClawBox. Check the network connection and try again." };
  if (!status.installed) return { ok: false, reason: "no_gh", detail: "The GitHub CLI (gh) is not installed on this ClawBox." };
  if (!status.connected) return { ok: false, reason: "not_connected", detail: "Connect a GitHub account in the Coding Agent's settings first." };

  const folder = importFolderName(fullName.split("/")[1]);
  // A taken name is refused before GitHub is asked anything; the claim
  // below is still the one that counts. The same fence as the claim's.
  const root = path.resolve(projectsRoot);
  const wanted = path.resolve(root, folder);
  if (!wanted.startsWith(withSep(root)) || path.dirname(wanted) !== root) {
    return { ok: false, reason: "invalid", detail: "The project's name is not one the project folder can hold." };
  }
  if (await fs.promises.lstat(wanted).catch(() => null)) {
    return { ok: false, reason: "exists", detail: `There is already a "${folder}" in your project folder. Rename or remove it first.` };
  }

  // What it weighs, from GitHub (kilobytes, packed): a checkout is larger,
  // so twice that is asked of the disk.
  const sized = await run("gh", ["api", `repos/${fullName}`, "--jq", ".size"]);
  const packedKb = sized.code === 0 ? Number(sized.stdout.trim()) : NaN;
  if (Number.isFinite(packedKb)) {
    const needed = packedKb * 1024 * 2;
    if (needed > IMPORT_MAX_BYTES) return { ok: false, reason: "too_big", detail: `That repository is about ${humanSize(packedKb * 1024)} packed; a project import is capped at ${humanSize(IMPORT_MAX_BYTES)}.` };
    const room = await roomFor(projectsRoot, needed);
    if (room) return room;
  }

  const target = await claimTarget(projectsRoot, folder);
  if (!target.ok) return target;

  // `gh repo clone` rather than a bare git clone: it knows the account's
  // protocol and lends the credential on every gh version, it takes the
  // owner/name form the listing gave, and git clones into an empty folder.
  const r = await run("gh", ["repo", "clone", fullName, target.directory, "--", "--quiet"], { cwd: projectsRoot, timeoutMs: CLONE_TIMEOUT_MS });
  if (r.code !== 0) {
    await fs.promises.rm(target.directory, { recursive: true, force: true }).catch(() => undefined);
    if (r.startFailed) return { ok: false, reason: startedMissing(r) ? "no_gh" : "failed", detail: failureDetail(r, "Cloning the repository") };
    if (wasKilled(r)) return { ok: false, reason: "gh_unreachable", detail: failureDetail(r, "Cloning the repository", "Check this ClawBox's network connection and try again.") };
    return { ok: false, reason: "failed", detail: failureDetail(r, "Cloning the repository") };
  }
  return { ok: true, directory: target.directory, folder, initialized: false, skipped: [] };
}
