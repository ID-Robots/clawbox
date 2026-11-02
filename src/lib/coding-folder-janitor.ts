/**
 * The folder janitor: removes the git worktrees and the project copies that
 * runs and agents leave behind, once nothing can still need them.
 *
 * WHY. Every coding run works in a worktree of its project, agents make more
 * of their own (`<project>/.claude/worktrees/…`, siblings beside the project
 * in the project folder, some in /tmp), and a few copy the whole project.
 * Nothing removed them: a busy box carried hundreds, each one disk, and every
 * sibling a row of its own in the project table.
 *
 * WHAT IS LOOKED AT (`planJanitorPass`): every linked worktree of every
 * repository directly inside the owner's project folder, wherever git says it
 * is, plus every top-level folder that is itself a worktree or a COPY of a
 * project (coding-folder-kind.ts says which). A folder that is neither is the
 * owner's project and is never a candidate, whatever its state.
 *
 * WHEN ONE GOES — all of these, checked cheapest first, the first that fails
 * is the reason it is kept:
 *
 * 1. no running, paused, queued or draft run, no run that left a process
 *    running, and no unsettled team works in it, around it or under it — read
 *    from the run and team stores, not guessed from the folder — and no run
 *    is starting there right now (coding-project-removal-lock.ts);
 * 2. no lab or board lease names it, when a lease file is there (`leaseFiles`);
 * 3. it has been idle longer than the retention (default 14 days): the newest
 *    mtime of its git HEAD, index and HEAD log. Measured BEFORE any git runs
 *    here, and git runs with `--no-optional-locks`, so looking never makes a
 *    folder look used;
 * 4. `git status --porcelain --untracked-files=all` is empty (the root
 *    `node_modules` LINK a run worktree gets is the project's, not work);
 * 5. its HEAD is merged into its base (the run's recorded base, the main
 *    checkout's branch, `origin/HEAD`, or main/master/beta/develop — local or
 *    on `origin`), or is pushed: no commit of it missing from every remote.
 *    A copy must be pushed, every branch of it, with no stash: merging inside
 *    a folder that is about to go saves nothing.
 *
 * HOW IT GOES. A worktree: `git worktree remove` WITHOUT `--force` (git's own
 * refusal of a dirty tree is the last guard), then `git worktree prune`. The
 * branch is kept. A copy: one `rename` into the box's trash, in its own shelf
 * (`<project folder>/.deleted-projects/run-copies/`), so the janitor never
 * takes a slot of — or pushes out — a project the owner deleted. Every action
 * is one JSON line in `data/coding-folder-janitor.jsonl`: path, branch,
 * reason, bytes freed.
 *
 * WHEN IT RUNS. Once a day and a little after a run settles (`start`,
 * `noteRunFinished`), only while the owner's switch is on, at most
 * `maxRemovals` removals a pass, and never two passes at once: a lock file
 * holds other processes off and the process store holds this one's copies
 * off. The Coding Agent settings' "Clean now" runs a pass by hand and the
 * dry run (`planJanitorPass`) shows what would go and why the rest is kept.
 *
 * SERVER ONLY.
 */

import fs from "fs";
import os from "os";
import path from "./runtime-path";
import { CONFIG_ROOT, DATA_DIR, get as configGet, set as configSet } from "./config-store";
import { getDefaultDirectory, listRuns, markRunWorktreesRemoved, onRunSettled, projectDirectoryOf, type CodingRun } from "./coding-agent";
import { isHeld } from "./coding-agent-status";
import { listBoards } from "./coding-team-board";
import { isSettledTeamStatus } from "./coding-team-status";
import { gitIn, isGeneratedArtifact, withDirLock } from "./coding-team-worktree";
import { beginProjectRemoval, isProjectBeingRemoved, runStartingIn } from "./coding-project-removal-lock";
import { directorySize, projectTrashDir, TRASH_RETENTION_MS, trashEntryTime } from "./coding-project-delete";
import { classifyFolders, readGitPointer, readHeadBranch, readRunMarker } from "./coding-folder-kind";
import { worktreeProject } from "./coding-worktree-paths";
import { processStore } from "./process-store";
import type { ChildResult } from "./child-run";

// ─── Settings ────────────────────────────────────────────────────────────────

export const JANITOR_ENABLED_CONFIG_KEY = "coding_agent_janitor_enabled";
export const JANITOR_RETENTION_CONFIG_KEY = "coding_agent_janitor_retention_days";
export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

/** Removals in one scheduled pass, and in one after a run. "Clean now" uses the first. */
export const MAX_REMOVALS_PER_PASS = 25;
export const MAX_REMOVALS_AFTER_RUN = 5;

/** How many top-level folders one scan reads. A bound, said in the plan when it bites. */
export const MAX_SCAN_FOLDERS = 2_000;

const DAY_MS = 24 * 60 * 60_000;

export interface JanitorSettings {
  enabled: boolean;
  retentionDays: number;
}

/** An error the route turns into a 400 (`invalid`) or a 409 (`busy`). */
export class JanitorError extends Error {
  constructor(public kind: "invalid" | "busy", message: string) {
    super(message);
  }
}

/** On unless the owner turned it off: absent means the default. */
export function retentionDaysFrom(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= MIN_RETENTION_DAYS && raw <= MAX_RETENTION_DAYS ? raw : DEFAULT_RETENTION_DAYS;
}

export async function readJanitorSettings(): Promise<JanitorSettings> {
  const [enabled, days] = await Promise.all([configGet(JANITOR_ENABLED_CONFIG_KEY), configGet(JANITOR_RETENTION_CONFIG_KEY)]);
  return { enabled: enabled !== false, retentionDays: retentionDaysFrom(days) };
}

/** Validate the whole patch, then write it. Refuses rather than clamps. */
export async function saveJanitorSettings(patch: unknown): Promise<JanitorSettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new JanitorError("invalid", "Send the settings as an object.");
  const { enabled, retentionDays } = patch as { enabled?: unknown; retentionDays?: unknown };
  if (enabled !== undefined && typeof enabled !== "boolean") throw new JanitorError("invalid", "The clean-up switch must be true or false.");
  if (retentionDays !== undefined
    && !(typeof retentionDays === "number" && Number.isInteger(retentionDays) && retentionDays >= MIN_RETENTION_DAYS && retentionDays <= MAX_RETENTION_DAYS)) {
    throw new JanitorError("invalid", `Keep run folders for a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}.`);
  }
  if (typeof enabled === "boolean") await configSet(JANITOR_ENABLED_CONFIG_KEY, enabled);
  if (typeof retentionDays === "number") await configSet(JANITOR_RETENTION_CONFIG_KEY, retentionDays);
  const settings = await readJanitorSettings();
  if (settings.enabled) rearm();
  return settings;
}

// ─── The plan ────────────────────────────────────────────────────────────────

/**
 * Why a candidate stays. In the order the checks run; the first that holds is
 * the one reported.
 */
export type JanitorKeepReason =
  | "protected" // ClawBox's own checkout, the project folder, or a main checkout
  | "locked" // `git worktree lock`ed by somebody
  | "live_run" // a running, paused, queued or draft run, or one that left a process
  | "live_team" // a team that has not settled
  | "busy" // a run is starting there, or a removal of it is under way
  | "lease" // a lab or board lease names it
  | "recent" // used within the retention period
  | "dirty" // changed, staged or untracked files
  | "stash" // a copy with stashed work
  | "unpushed" // commits its upstream does not have
  | "unmerged" // neither merged into its base nor pushed anywhere
  | "unknown" // git could not say, which is never permission to remove
  | "limit"; // would go, but this pass has done its share

export type JanitorAction = "remove" | "trash" | "prune" | "keep";

/** One candidate and what the janitor makes of it. */
export interface JanitorEntry {
  path: string;
  /** The project it belongs to (the main checkout), when known. */
  project: string | null;
  kind: "worktree" | "copy";
  branch: string | null;
  action: JanitorAction;
  /** A keep reason, or why it may go: `merged`, `pushed`, `missing`. */
  reason: JanitorKeepReason | "merged" | "pushed" | "missing";
  /** One English sentence for the log and the dry-run list. */
  detail: string;
  /** Whole days since its git state last changed, or null when unknown. */
  idleDays: number | null;
}

export interface JanitorPlan {
  at: number;
  settings: JanitorSettings;
  projectFolder: string;
  entries: JanitorEntry[];
  /** Top-level folders left alone as the owner's own projects. */
  userProjects: number;
  /** Top-level folders past `MAX_SCAN_FOLDERS`, not looked at in this pass. */
  notScanned: number;
}

/** A candidate before it is judged. */
interface Candidate {
  path: string;
  kind: "worktree" | "copy";
  /** Where `git worktree remove|prune` run: the main checkout, or the common dir of a bare one. */
  repoDir: string;
  project: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

/** Everything a pass reads once: the live folders, the leases, the protected paths. */
interface PassContext {
  now: number;
  retentionMs: number;
  projectFolder: string;
  live: { path: string; why: "live_run" | "live_team"; label: string }[];
  /** Run worktree path → the base the run forked from. */
  runBases: Map<string, string>;
  leases: string[];
  /** False when a lease file could not be read in full: then every candidate is kept. */
  leasesComplete: boolean;
  /** False when the run or team records could not be read: then every candidate is kept. */
  stateReadable: boolean;
  protectedPaths: string[];
}

const ok = (r: ChildResult) => r.code === 0 && !r.timedOut && !r.startFailed;
const out = (r: ChildResult) => r.stdout.trim();

/**
 * The dry run: every candidate and what a pass would do with it. Changes
 * nothing on disk — git runs with `--no-optional-locks`, so even the index is
 * left as it was.
 */
export async function planJanitorPass(options: { now?: number; maxRemovals?: number } = {}): Promise<JanitorPlan> {
  return (await planWithCandidates(options)).plan;
}

/** The plan, and the candidate behind each entry — what the act re-judges under its claim. */
async function planWithCandidates(options: { now?: number; maxRemovals?: number }): Promise<{ plan: JanitorPlan; candidates: Map<string, Candidate> }> {
  const now = options.now ?? Date.now();
  const maxRemovals = Math.max(0, options.maxRemovals ?? MAX_REMOVALS_PER_PASS);
  const settings = await readJanitorSettings();
  const projectFolder = path.resolve(await getDefaultDirectory());
  const scan = await scanCandidates(projectFolder);
  const ctx = await passContext(projectFolder, settings, now);
  const entries = (await mapLimit(scan.candidates, 4, (c) => judge(c, ctx))).sort(byAction);
  const candidates = new Map(scan.candidates.map((c) => [c.path, c]));
  // The pass's share, said in the plan: past it a removal waits for the next pass.
  let taken = 0;
  const capped = entries.map((e) => {
    if (e.action !== "remove" && e.action !== "trash") return e;
    taken += 1;
    return taken <= maxRemovals ? e : { ...e, action: "keep" as const, reason: "limit" as const, detail: `${e.detail} Waits for the next pass: one pass removes at most ${maxRemovals}.` };
  });
  return { plan: { at: now, settings, projectFolder, entries: capped.sort(byAction), userProjects: scan.userProjects, notScanned: scan.notScanned }, candidates };
}

const ACTION_ORDER: Record<JanitorAction, number> = { remove: 0, trash: 1, prune: 2, keep: 3 };
function byAction(a: JanitorEntry, b: JanitorEntry): number {
  return ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.path.localeCompare(b.path);
}

async function scanCandidates(projectFolder: string): Promise<{ candidates: Candidate[]; userProjects: number; notScanned: number }> {
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(projectFolder, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    names = [];
  }
  const notScanned = Math.max(0, names.length - MAX_SCAN_FOLDERS);
  names = names.slice(0, MAX_SCAN_FOLDERS);
  const kinds = classifyFolders(projectFolder, names, knownProjectDirs());
  const byPath = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const key = path.resolve(c.path);
    if (!byPath.has(key)) byPath.set(key, { ...c, path: key });
  };
  let userProjects = 0;
  const repos: string[] = [];
  for (const kind of kinds.values()) {
    if (kind.kind === "project") {
      userProjects += 1;
      if (readGitPointer(kind.dir).kind === "repo") repos.push(kind.dir);
    }
  }
  // Every linked worktree of every repository in the folder, wherever it is.
  for (const trees of await mapLimit(repos, 4, listWorktrees)) {
    for (const tree of trees) add(tree);
  }
  // Top-level folders that are worktrees of a repository OUTSIDE the folder,
  // and copies. A worktree of a repository inside it was listed above.
  for (const kind of kinds.values()) {
    if (kind.kind === "worktree") {
      const pointer = readGitPointer(kind.dir);
      if (pointer.kind !== "worktree") continue;
      const repoDir = pointer.mainRoot ?? pointer.commonDir;
      if (byPath.has(path.resolve(kind.dir))) continue;
      const locked = fs.existsSync(path.join(pointer.gitDir, "locked"));
      add({ path: kind.dir, kind: "worktree", repoDir, project: pointer.mainRoot, branch: kind.branch, locked, prunable: false });
    } else if (kind.kind === "copy") {
      add({ path: kind.dir, kind: "copy", repoDir: kind.dir, project: kind.parent, branch: kind.branch, locked: false, prunable: false });
    }
  }
  return { candidates: [...byPath.values()], userProjects, notScanned };
}

/** `git worktree list --porcelain` of one repository, without its main checkout. */
async function listWorktrees(repo: string): Promise<Candidate[]> {
  const r = await gitIn(repo, ["worktree", "list", "--porcelain"]);
  if (!ok(r)) return [];
  const found: Candidate[] = [];
  let first = true;
  let cur: Candidate | null = null;
  const flush = () => {
    if (cur && !first) found.push(cur);
    if (cur) first = false;
    cur = null;
  };
  for (const line of r.stdout.split("\n")) {
    const text = line.trimEnd();
    if (!text) {
      flush();
      continue;
    }
    if (text.startsWith("worktree ")) {
      flush();
      cur = { path: text.slice("worktree ".length), kind: "worktree", repoDir: repo, project: repo, branch: null, locked: false, prunable: false };
    } else if (cur && text.startsWith("branch ")) {
      cur.branch = text.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (cur && (text === "locked" || text.startsWith("locked "))) {
      cur.locked = true;
    } else if (cur && (text === "prunable" || text.startsWith("prunable "))) {
      cur.prunable = true;
    } else if (cur && text === "bare") {
      // A bare main: not a checkout anyone works in, and never a candidate.
    }
  }
  flush();
  return found;
}

/**
 * Folders the box KNOWS are originals: a project it made a run worktree or a
 * team in. A run that merely worked IN a folder does not make it one — runs
 * are pointed at copies too, and that must not hide a copy from the janitor.
 */
function knownProjectDirs(): Set<string> {
  const known = new Set<string>();
  for (const run of safeRuns()) {
    if (run.worktree?.project) known.add(path.resolve(run.worktree.project));
    const tree = typeof run.directory === "string" ? worktreeProject(projectDirectoryOf(run)) : null;
    if (tree) known.add(path.resolve(tree));
  }
  for (const board of safeBoards()) if (board.directory) known.add(path.resolve(board.directory));
  return known;
}

function safeRuns(): CodingRun[] {
  try {
    return listRuns(Number.MAX_SAFE_INTEGER);
  } catch {
    return [];
  }
}

function safeBoards(): ReturnType<typeof listBoards> {
  try {
    return listBoards();
  } catch {
    return [];
  }
}

/**
 * Can the run and team records be read? A store that is not there is an empty
 * one; a file that is there and will not parse is NOT — the run store answers
 * an empty list for it, and "nothing is running" read off a corrupt file is
 * exactly the answer that must never reach a removal.
 */
export function stateReadable(): boolean {
  try {
    if (!Array.isArray(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "coding-agent-runs.json"), "utf8")))) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const teams = path.join(DATA_DIR, "coding-team");
  let names: string[] = [];
  try {
    names = fs.readdirSync(teams);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      JSON.parse(fs.readFileSync(path.join(teams, name), "utf8"));
    } catch {
      return false;
    }
  }
  return true;
}

async function passContext(projectFolder: string, settings: JanitorSettings, now: number): Promise<PassContext> {
  const live: PassContext["live"] = [];
  const runBases = new Map<string, string>();
  for (const run of safeRuns()) {
    if (run.worktree?.path && run.worktree.base) runBases.set(path.resolve(run.worktree.path), run.worktree.base);
    const held = isHeld(run.status);
    if (!held && !run.leftover) continue;
    const label = `${run.leftover && !held ? "a process left by run" : `${run.status} run`} ${run.id}`;
    if (typeof run.directory === "string" && run.directory) live.push({ path: path.resolve(run.directory), why: "live_run", label });
    if (run.worktree?.path && !run.worktree.removed) live.push({ path: path.resolve(run.worktree.path), why: "live_run", label });
  }
  for (const board of safeBoards()) {
    if (isSettledTeamStatus(board.status)) continue;
    const label = `${board.status} team ${board.id}`;
    if (board.directory) live.push({ path: path.resolve(board.directory), why: "live_team", label });
    for (const task of board.tasks ?? []) {
      if (task.worktree) live.push({ path: path.resolve(task.worktree), why: "live_team", label });
    }
  }
  return {
    now,
    retentionMs: settings.retentionDays * DAY_MS,
    projectFolder,
    live,
    runBases,
    ...readLeases(),
    stateReadable: stateReadable(),
    protectedPaths: [path.resolve(CONFIG_ROOT), projectFolder],
  };
}

// ─── Leases ──────────────────────────────────────────────────────────────────

/**
 * Where lab and board leases may be written down on this machine: the files
 * and folders in `CLAWBOX_LEASE_FILES` (colon separated), else
 * `data/board-leases.json` and the lab lease helper's state folder. A lease
 * file that is not there is no lease; one that is there is read as text.
 */
export function leaseFiles(): string[] {
  const configured = (process.env.CLAWBOX_LEASE_FILES ?? "").split(":").map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured.map((p) => path.resolve(p));
  return [path.join(DATA_DIR, "board-leases.json"), path.join(os.homedir(), ".local", "state", "nano-lease")];
}

const MAX_LEASE_FILES = 200;
const MAX_LEASE_BYTES = 1024 * 1024;

/**
 * Every lease file's text, and whether ALL of them were read in full. A lease
 * file that is there but cannot be read — a permission, a size past the
 * bound, one file too many — is not "no lease": the pass then keeps every
 * candidate (`leasesComplete: false`), because it cannot say which one the
 * unread lease named.
 */
function readLeases(): { leases: string[]; leasesComplete: boolean } {
  const texts: string[] = [];
  let complete = true;
  const readOne = (file: string) => {
    if (texts.length >= MAX_LEASE_FILES) {
      complete = false;
      return;
    }
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return;
      if (st.size > MAX_LEASE_BYTES) {
        complete = false;
        return;
      }
      texts.push(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
    }
  };
  for (const entry of leaseFiles()) {
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(entry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      continue;
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(entry).sort();
      } catch {
        complete = false;
        continue;
      }
      for (const name of names) readOne(path.join(entry, name));
    } else {
      readOne(entry);
    }
  }
  return { leases: texts, leasesComplete: complete };
}

/**
 * The words that would name this candidate in a lease: its path, its folder
 * name (when long enough to mean something), its branch, the run it was made
 * for, and any task id in its name or branch.
 */
function leaseNeedles(c: Candidate): string[] {
  const needles = new Set<string>([c.path]);
  const base = path.basename(c.path);
  if (base.length >= 6) needles.add(base);
  if (c.branch && c.branch.length >= 6) needles.add(c.branch);
  const marker = readRunMarker(c.path);
  if (marker) needles.add(marker.id);
  for (const m of `${base} ${c.branch ?? ""}`.matchAll(/\b(run-[a-z0-9]{6,}|task-\d+)\b/gi)) needles.add(m[1]);
  return [...needles];
}

function leaseNaming(c: Candidate, leases: readonly string[]): boolean {
  if (!leases.length) return false;
  const needles = leaseNeedles(c);
  return leases.some((text) => {
    const lower = text.toLowerCase();
    return needles.some((n) => (/^(run|task)-/i.test(n) ? lower.includes(n.toLowerCase()) : text.includes(n)));
  });
}

// ─── Judging one candidate ───────────────────────────────────────────────────

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The newest mtime of the git state that changes whenever anyone uses the folder. */
export function lastGitActivity(dir: string): number | null {
  const pointer = readGitPointer(dir);
  const gitDir = pointer.kind === "repo" || pointer.kind === "worktree" ? pointer.gitDir : null;
  if (!gitDir) return null;
  let newest: number | null = null;
  for (const rel of ["HEAD", "index", path.join("logs", "HEAD")]) {
    try {
      const m = fs.statSync(path.join(gitDir, rel)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {
      // Not every one exists: a fresh worktree has no reflog yet.
    }
  }
  return newest;
}

function keep(c: Candidate, reason: JanitorKeepReason, detail: string, idleDays: number | null = null): JanitorEntry {
  return { path: c.path, project: c.project, kind: c.kind, branch: c.branch, action: "keep", reason, detail, idleDays };
}

function go(c: Candidate, action: Exclude<JanitorAction, "keep">, reason: "merged" | "pushed" | "missing", detail: string, idleDays: number | null): JanitorEntry {
  return { path: c.path, project: c.project, kind: c.kind, branch: c.branch, action, reason, detail, idleDays };
}

function liveIn(c: Candidate, ctx: PassContext): PassContext["live"][number] | null {
  const real = realOr(c.path);
  for (const l of ctx.live) {
    const lp = realOr(l.path);
    if (inside(lp, real) || inside(real, lp)) return l;
  }
  return null;
}

async function judge(c: Candidate, ctx: PassContext): Promise<JanitorEntry> {
  const real = realOr(c.path);
  if (ctx.protectedPaths.some((p) => inside(realOr(p), real)) || (c.project && realOr(c.project) === real)) {
    return keep(c, "protected", "ClawBox's own checkout, the project folder or a main checkout is never removed.");
  }
  if (!ctx.stateReadable) return keep(c, "unknown", "The run or team records could not be read, so nothing is removed.");
  if (c.locked) return keep(c, "locked", "Locked with git worktree lock.");
  const live = liveIn(c, ctx);
  if (live) return keep(c, live.why, `In use by the ${live.label}.`);
  if (isProjectBeingRemoved(real) || runStartingIn(real)) return keep(c, "busy", "A run is starting there, or it is being removed.");
  if (!ctx.leasesComplete) return keep(c, "lease", "A lease file could not be read in full, so nothing is removed.");
  if (leaseNaming(c, ctx.leases)) return keep(c, "lease", "A lab or board lease names it.");
  if (!fs.existsSync(c.path)) {
    // Only git's own word that the folder is gone lets the record go.
    if (c.kind !== "worktree" || !c.prunable) return keep(c, "unknown", "The folder is not there.");
    return go(c, "prune", "missing", "The folder is gone; git still lists it, and git worktree prune clears that.", null);
  }
  // Prunable with the folder still there (its `.git` file lost, say): pruning
  // would cut it loose from the repository with its files left behind.
  if (c.prunable) return keep(c, "unknown", "git calls it prunable, but its folder is still there.");

  const last = lastGitActivity(c.path);
  const idleDays = last === null ? null : Math.max(0, Math.floor((ctx.now - last) / DAY_MS));
  if (last === null) return keep(c, "unknown", "Its git state could not be read.");
  if (ctx.now - last < ctx.retentionMs) {
    return keep(c, "recent", `Used ${idleDays === 0 ? "today" : `${idleDays} day(s) ago`}; kept for ${Math.round(ctx.retentionMs / DAY_MS)} days.`, idleDays);
  }

  const clean = await cleanState(c.path);
  if (clean === null) return keep(c, "unknown", "git status could not be read.", idleDays);
  if (clean !== true) return keep(c, "dirty", clean, idleDays);

  if (c.kind === "copy") {
    const stash = await gitIn(c.path, ["--no-optional-locks", "stash", "list"]);
    if (!ok(stash)) return keep(c, "unknown", "git stash list could not be read.", idleDays);
    if (out(stash)) return keep(c, "stash", "It has stashed work.", idleDays);
    const unpushed = await countUnpushed(c.path, ["--branches", "HEAD"]);
    if (unpushed === null) return keep(c, "unknown", "git could not say what is pushed.", idleDays);
    if (unpushed > 0) return keep(c, (await hasUpstream(c.path)) ? "unpushed" : "unmerged", `${unpushed} commit(s) are on no remote.`, idleDays);
    return go(c, "trash", "pushed", `Clean, pushed and idle for ${idleDays} day(s): moves to the trash.`, idleDays);
  }

  const merged = await mergedInto(c, ctx);
  if (merged === null) return keep(c, "unknown", "git could not say whether it is merged.", idleDays);
  if (merged) return go(c, "remove", "merged", `Clean, merged into ${merged} and idle for ${idleDays} day(s).`, idleDays);
  const unpushed = await countUnpushed(c.path, ["HEAD"]);
  if (unpushed === null) return keep(c, "unknown", "git could not say what is pushed.", idleDays);
  if (unpushed === 0) return go(c, "remove", "pushed", `Clean, pushed and idle for ${idleDays} day(s).`, idleDays);
  if (await hasUpstream(c.path)) return keep(c, "unpushed", `${unpushed} commit(s) are not pushed.`, idleDays);
  return keep(c, "unmerged", `${unpushed} commit(s) are neither merged nor pushed.`, idleDays);
}

/**
 * Build output a removal may take with the tree: what `isGeneratedArtifact`
 * says git should never have been handed, the usual build and cache folders,
 * logs, and the box's own `.clawbox/`. Anything else ignored — a `.env`, a
 * local database, a `secrets.json` — is somebody's, and keeps the tree.
 */
const BUILD_OUTPUT = /(^|\/)(\.next|dist|build|out|coverage|\.cache|\.turbo|target|\.parcel-cache|\.vite|\.svelte-kit|\.nuxt|\.output|playwright-report|test-results|\.clawbox)(\/|$)|\.log$|(^|\/)\.eslintcache$/;

export function isBuildOutput(relPath: string): boolean {
  const p = relPath.replace(/\/+$/, "");
  return isGeneratedArtifact(p) || BUILD_OUTPUT.test(p);
}

/**
 * True when `git status` is empty, untracked files included, and nothing
 * ignored is anything but build output — `git worktree remove` takes ignored
 * files with it without asking. Otherwise the sentence that says why; null
 * when git could not say. A root `node_modules` LINK is the project's, not work.
 */
async function cleanState(dir: string): Promise<true | string | null> {
  const args = ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"];
  if (isLink(path.join(dir, "node_modules"))) args.push("--", ".", ":(exclude)node_modules");
  const r = await gitIn(dir, args);
  if (!ok(r)) return null;
  if (out(r) !== "") return "It has changed or untracked files.";
  const ignored = await gitIn(dir, ["--no-optional-locks", "status", "--porcelain", "--ignored=matching", "--untracked-files=normal"]);
  if (!ok(ignored)) return null;
  const kept = ignored.stdout.split("\n").filter((l) => l.startsWith("!! ")).map((l) => l.slice(3).replace(/^"|"$/g, "")).filter((p) => !isBuildOutput(p));
  if (kept.length) return `It has ignored files that are not build output: ${kept.slice(0, 3).join(", ")}${kept.length > 3 ? ", …" : ""}.`;
  return true;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Commits reachable from `revs` that no remote-tracking branch has. Null: git could not say. */
async function countUnpushed(dir: string, revs: string[]): Promise<number | null> {
  const r = await gitIn(dir, ["--no-optional-locks", "rev-list", "--count", ...revs, "--not", "--remotes"]);
  if (!ok(r)) return null;
  const n = Number(out(r));
  return Number.isFinite(n) ? n : null;
}

async function hasUpstream(dir: string): Promise<boolean> {
  const r = await gitIn(dir, ["--no-optional-locks", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  return ok(r) && out(r) !== "";
}

const COMMON_BASES = ["main", "master", "beta", "develop", "development"];

/**
 * The base HEAD is merged into, by name, or false; null when git could not
 * answer. The candidate's own branch is never its base.
 */
async function mergedInto(c: Candidate, ctx: PassContext): Promise<string | false | null> {
  const bases: string[] = [];
  const recorded = ctx.runBases.get(path.resolve(c.path));
  if (recorded) bases.push(recorded);
  const pointer = readGitPointer(c.path);
  if (pointer.kind === "worktree") {
    const mainBranch = readHeadBranch(pointer.commonDir);
    if (mainBranch) bases.push(mainBranch);
  }
  const originHead = await gitIn(c.path, ["--no-optional-locks", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (ok(originHead) && out(originHead).startsWith("origin/")) bases.push(out(originHead).slice("origin/".length));
  bases.push(...COMMON_BASES);
  const names = [...new Set(bases)].filter((b) => b && b !== c.branch);
  const refs = names.flatMap((b) => [`refs/heads/${b}`, `refs/remotes/origin/${b}`]);
  const r = await gitIn(c.path, ["--no-optional-locks", "for-each-ref", "--contains", "HEAD", "--format=%(refname)", ...refs]);
  if (!ok(r)) return null;
  const containing = new Set(out(r).split("\n").filter(Boolean));
  for (const ref of refs) {
    if (containing.has(ref)) return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
  }
  return false;
}

// ─── Acting ──────────────────────────────────────────────────────────────────

export type JanitorTrigger = "daily" | "run-finished" | "manual";

/** One line of `data/coding-folder-janitor.jsonl`. */
export interface JanitorLogLine {
  at: string;
  trigger: JanitorTrigger;
  action: "removed" | "trashed" | "pruned" | "failed" | "expired";
  kind: "worktree" | "copy";
  path: string;
  project: string | null;
  branch: string | null;
  reason: string;
  freedBytes: number;
  /** For a copy moved to the trash: its size. Nothing is freed until the trash lets it go (`expired`). */
  sizeBytes?: number;
  trashPath?: string;
  detail?: string;
}

export interface JanitorPassResult {
  at: number;
  trigger: JanitorTrigger;
  /** Set when the pass did not run: the switch is off, another pass holds the lock, or an update is under way. */
  skipped: "disabled" | "busy" | "update" | null;
  removed: number;
  trashed: number;
  pruned: number;
  failed: number;
  kept: number;
  freedBytes: number;
  actions: JanitorLogLine[];
}

export function janitorLogPath(): string {
  return path.join(DATA_DIR, "coding-folder-janitor.jsonl");
}

function statePath(): string {
  return path.join(DATA_DIR, "coding-folder-janitor.json");
}

function lockPath(): string {
  return path.join(DATA_DIR, "coding-folder-janitor.lock");
}

/** The log is a record, not an archive: past this it is rolled to `.1` once. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function appendLog(line: JanitorLogLine): void {
  const file = janitorLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o644 });
  } catch (err) {
    console.error("[coding-folder-janitor] could not write the log:", err instanceof Error ? err.message : err);
  }
}

/** The newest `limit` log lines, newest first. */
export function readJanitorLog(limit = 50): JanitorLogLine[] {
  let text = "";
  try {
    text = fs.readFileSync(janitorLogPath(), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).slice(-Math.max(0, limit));
  const parsed: JanitorLogLine[] = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l) as JanitorLogLine);
    } catch {
      // A torn line from a crash mid-append.
    }
  }
  return parsed.reverse();
}

export interface JanitorState {
  lastPass: Omit<JanitorPassResult, "actions"> | null;
}

export function readJanitorState(): JanitorState {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) as JanitorState;
    return { lastPass: raw && typeof raw.lastPass === "object" ? raw.lastPass : null };
  } catch {
    return { lastPass: null };
  }
}

function writeState(state: JanitorState): void {
  try {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error("[coding-folder-janitor] could not save its state:", err instanceof Error ? err.message : err);
  }
}

/** A pass that holds the lock longer than this is taken to have died. */
const STALE_LOCK_MS = 2 * 60 * 60_000;

/**
 * Take the cross-process lock, or null when another live pass holds it.
 *
 * The lock names its holder with a token, and only that token's holder
 * deletes it. A dead holder's lock is taken over by RENAMING it aside — one
 * process can win a rename — and checked again once it is aside: a lock a
 * live pass took in between is put back, never deleted.
 */
function takeLock(now: number): (() => void) | null {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid} ${now} ${Math.random().toString(36).slice(2, 10)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${token}\n`, { flag: "wx", mode: 0o644 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(file, "utf8").trim() === token) fs.rmSync(file, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (!lockIsStale(file, now)) return null;
      const aside = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.stale`;
      try {
        fs.renameSync(file, aside);
      } catch {
        return null;
      }
      if (!lockIsStale(aside, now)) {
        try {
          fs.linkSync(aside, file);
        } catch {
          // A newer lock is in place already: it stands.
        }
        fs.rmSync(aside, { force: true });
        return null;
      }
      fs.rmSync(aside, { force: true });
    }
  }
  return null;
}

function lockIsStale(file: string, now: number): boolean {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return true;
  }
  const [pidText, atText] = text.trim().split(/\s+/);
  const pid = Number(pidText);
  const at = Number(atText);
  if (!Number.isFinite(at) || now - at > STALE_LOCK_MS) return true;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const passState = processStore("coding-folder-janitor:pass", () => ({ running: false }));

/** Is a pass running in this process right now? */
export function janitorPassRunning(): boolean {
  return passState.running;
}

/**
 * One pass: plan, then act on what may go, at most `maxRemovals` removals.
 * Never two at once (see the header); a pass that cannot have the lock is
 * answered `skipped: "busy"`, or thrown as `busy` when `throwIfBusy`.
 */
export async function runJanitorPass(options: {
  trigger: JanitorTrigger;
  maxRemovals?: number;
  now?: number;
  /** The manual button runs even with the switch off: it is the owner asking. */
  ignoreSwitch?: boolean;
  throwIfBusy?: boolean;
}): Promise<JanitorPassResult> {
  const now = options.now ?? Date.now();
  const maxRemovals = Math.max(0, options.maxRemovals ?? MAX_REMOVALS_PER_PASS);
  const result: JanitorPassResult = { at: now, trigger: options.trigger, skipped: null, removed: 0, trashed: 0, pruned: 0, failed: 0, kept: 0, freedBytes: 0, actions: [] };
  // Claimed before the first await, so a second call in this process sees it.
  if (passState.running) {
    if (options.throwIfBusy) throw new JanitorError("busy", "A clean-up is already running.");
    return { ...result, skipped: "busy" };
  }
  passState.running = true;
  let release: (() => void) | null = null;
  try {
    const settings = await readJanitorSettings();
    if (!settings.enabled && !options.ignoreSwitch) return { ...result, skipped: "disabled" };
    if (await updateRunning()) return { ...result, skipped: "update" };
    release = takeLock(now);
    if (!release) {
      if (options.throwIfBusy) throw new JanitorError("busy", "A clean-up is already running.");
      return { ...result, skipped: "busy" };
    }
    const { plan, candidates } = await planWithCandidates({ now, maxRemovals });
    const log = (line: Omit<JanitorLogLine, "at" | "trigger">) => {
      const full: JanitorLogLine = { at: new Date().toISOString(), trigger: options.trigger, ...line };
      appendLog(full);
      result.actions.push(full);
    };
    const pruneRepos = new Set<string>();
    for (const entry of plan.entries) {
      if (entry.action === "keep") {
        result.kept += 1;
        continue;
      }
      if (entry.action === "prune") {
        const repo = entry.project ?? null;
        if (repo && !pruneRepos.has(repo)) {
          pruneRepos.add(repo);
          await withDirLock(repo, () => gitIn(repo, ["worktree", "prune"]));
        }
        log({ action: "pruned", kind: entry.kind, path: entry.path, project: entry.project, branch: entry.branch, reason: entry.reason, freedBytes: 0 });
        result.pruned += 1;
        continue;
      }
      const candidate = candidates.get(entry.path);
      let acted: Acted | null;
      try {
        // Judged again, fresh, right before the act: the plan may be minutes
        // old, and a run, a lease or a commit may have arrived since.
        const fresh = candidate ? await judge(candidate, await passContext(plan.projectFolder, settings, now)) : null;
        if (!candidate || !fresh || fresh.action !== entry.action) {
          acted = null;
        } else {
          acted = entry.action === "trash" ? await trashCopy(entry, plan.projectFolder, now) : await removeWorktree(entry);
        }
      } catch (err) {
        acted = { action: "failed", kind: entry.kind, path: entry.path, project: entry.project, branch: entry.branch, reason: entry.reason, freedBytes: 0, detail: err instanceof Error ? err.message : String(err) };
      }
      if (!acted) {
        result.kept += 1;
        continue;
      }
      log(acted);
      if (acted.action === "removed") result.removed += 1;
      else if (acted.action === "trashed") result.trashed += 1;
      else if (acted.action === "failed" && acted.detail?.startsWith("Kept:")) result.kept += 1;
      else result.failed += 1;
      result.freedBytes += acted.freedBytes;
    }
    for (const expired of await expireTrash(plan.projectFolder, now).catch(() => [] as Acted[])) {
      log(expired);
      result.freedBytes += expired.freedBytes;
    }
    // A run whose tree went must not go on claiming one: a resume rebuilds it.
    const gone = result.actions.filter((a) => a.kind === "worktree" && (a.action === "removed" || a.action === "pruned")).map((a) => a.path);
    try {
      markRunWorktreesRemoved(gone);
    } catch (err) {
      console.error("[coding-folder-janitor] could not update the run records:", err instanceof Error ? err.message : err);
    }
    writeState({ lastPass: summaryOf(result) });
    return result;
  } finally {
    release?.();
    passState.running = false;
  }
}

/** A pass without its action list: what the state file and the route keep. */
function summaryOf(r: JanitorPassResult): Omit<JanitorPassResult, "actions"> {
  return { at: r.at, trigger: r.trigger, skipped: r.skipped, removed: r.removed, trashed: r.trashed, pruned: r.pruned, failed: r.failed, kept: r.kept, freedBytes: r.freedBytes };
}

/** The run and team stores, read again at the act: a run may have started since the plan. Synchronous, for `claimFree`. */
function stillFree(p: string): JanitorKeepReason | null {
  const real = realOr(p);
  if (runStartingIn(real)) return "busy";
  for (const run of safeRuns()) {
    if (!isHeld(run.status) && !run.leftover) continue;
    for (const d of [run.directory, run.worktree && !run.worktree.removed ? run.worktree.path : null]) {
      if (typeof d !== "string" || !d) continue;
      const lp = realOr(d);
      if (inside(lp, real) || inside(real, lp)) return "live_run";
    }
  }
  for (const board of safeBoards()) {
    if (isSettledTeamStatus(board.status)) continue;
    for (const d of [board.directory, ...(board.tasks ?? []).map((t) => t.worktree)]) {
      if (typeof d !== "string" || !d) continue;
      const lp = realOr(d);
      if (inside(lp, real) || inside(real, lp)) return "live_team";
    }
  }
  return null;
}

type Acted = Omit<JanitorLogLine, "at" | "trigger">;

/**
 * Claim the folder for removal, the way the owner's Delete does
 * (coding-project-removal-lock.ts): never over somebody else's claim, and the
 * claim WRITTEN before the run store and the run starts are READ, with no
 * await between, so a run that starts later is refused and one that started
 * earlier is seen. Answers why it is busy, or the claim's release.
 */
function claimFree(p: string): { release: () => void } | { busy: JanitorKeepReason } {
  const real = realOr(p);
  if (isProjectBeingRemoved(real)) return { busy: "busy" };
  const release = beginProjectRemoval(real);
  const busy = stillFree(p);
  if (busy) {
    release();
    return { busy };
  }
  return { release };
}

async function removeWorktree(entry: JanitorEntry): Promise<Acted> {
  const base: Acted = { action: "failed", kind: "worktree", path: entry.path, project: entry.project, branch: entry.branch, reason: entry.reason, freedBytes: 0 };
  const repo = entry.project ?? readMainRoot(entry.path);
  if (!repo) return { ...base, detail: "Its repository could not be found." };
  const claim = claimFree(entry.path);
  if ("busy" in claim) return { ...base, detail: `Kept: ${claim.busy}.` };
  const releaseClaim = claim.release;
  try {
    if ((await cleanState(entry.path)) !== true) return { ...base, detail: "Kept: it changed since it was checked." };
    const size = await directorySize(entry.path);
    return await withDirLock(repo, async () => {
      // The run worktree's `node_modules` is a LINK to the project's; git
      // counts a link as an untracked file and would (rightly) refuse to
      // remove the tree without --force. The link alone goes, and comes back
      // if git refuses for any other reason.
      const link = path.join(entry.path, "node_modules");
      let linkTarget: string | null = null;
      if (isLink(link)) {
        try {
          linkTarget = fs.readlinkSync(link);
          fs.unlinkSync(link);
        } catch {
          linkTarget = null;
        }
      }
      const removed = await gitIn(repo, ["worktree", "remove", entry.path]);
      if (!ok(removed)) {
        if (linkTarget !== null) {
          try {
            fs.symlinkSync(linkTarget, link);
          } catch {
            // Best effort: the link is the project's own folder, which is still there.
          }
        }
        return { ...base, detail: (removed.stderr || removed.stdout || "git worktree remove failed").trim().slice(0, 300) };
      }
      await gitIn(repo, ["worktree", "prune"]);
      if (fs.existsSync(entry.path)) return { ...base, detail: "git answered, but the folder is still there." };
      return { ...base, action: "removed", freedBytes: size.bytes };
    });
  } finally {
    releaseClaim();
  }
}

function readMainRoot(dir: string): string | null {
  const pointer = readGitPointer(dir);
  return pointer.kind === "worktree" ? pointer.mainRoot ?? pointer.commonDir : null;
}

/** The janitor's own shelf in the box's trash: the owner's deleted projects never share its slots. */
export function janitorTrashDir(projectFolder: string): string {
  return path.join(projectTrashDir(projectFolder), "run-copies");
}

function stampFor(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function trashCopy(entry: JanitorEntry, projectFolder: string, now: number): Promise<Acted> {
  const base: Acted = { action: "failed", kind: "copy", path: entry.path, project: entry.project, branch: entry.branch, reason: entry.reason, freedBytes: 0 };
  // Only ever a folder directly inside the project folder: that is the only
  // place a copy is looked for, and the trash is on the same filesystem.
  if (path.dirname(path.resolve(entry.path)) !== path.resolve(projectFolder)) return { ...base, detail: "Not directly inside the project folder." };
  const claim = claimFree(entry.path);
  if ("busy" in claim) return { ...base, detail: `Kept: ${claim.busy}.` };
  const releaseClaim = claim.release;
  try {
    if ((await cleanState(entry.path)) !== true) return { ...base, detail: "Kept: it changed since it was checked." };
    const size = await directorySize(entry.path);
    const shelf = janitorTrashDir(projectFolder);
    await fs.promises.mkdir(shelf, { recursive: true });
    const stamp = stampFor(now);
    let name = `${path.basename(entry.path)}--${stamp}`;
    for (let n = 2; fs.existsSync(path.join(shelf, name)) && n < 100; n += 1) name = `${path.basename(entry.path)}-${n}--${stamp}`;
    const trashPath = path.join(shelf, name);
    try {
      await fs.promises.rename(entry.path, trashPath);
    } catch (err) {
      return { ...base, detail: `Could not move it to the trash: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ...base, action: "trashed", sizeBytes: size.bytes, trashPath };
  } finally {
    releaseClaim();
  }
}

/** Copies past the trash's retention go for good, as the owner's deleted projects do. */
async function expireTrash(projectFolder: string, now: number): Promise<Acted[]> {
  const shelf = janitorTrashDir(projectFolder);
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(shelf);
  } catch {
    return [];
  }
  const gone: Acted[] = [];
  for (const name of names) {
    const at = trashEntryTime(name);
    if (at === null || now - at < TRASH_RETENTION_MS) continue;
    const full = path.join(shelf, name);
    const size = await directorySize(full);
    const removed = await fs.promises.rm(full, { recursive: true, force: true }).then(() => true, () => false);
    if (removed) gone.push({ action: "expired", kind: "copy", path: full, project: null, branch: null, reason: "trash_retention", freedBytes: size.bytes });
  }
  return gone;
}

async function updateRunning(): Promise<boolean> {
  try {
    const { updateInFlight } = await import("./updater");
    return await updateInFlight();
  } catch {
    return false;
  }
}

// ─── Schedule ────────────────────────────────────────────────────────────────

/** The first pass after a boot waits this long: the boot rush is not the time. */
const BOOT_DELAY_MS = 10 * 60_000;
/** A settled run is followed this much later, so a run's own settle has finished. */
const AFTER_RUN_DELAY_MS = 2 * 60_000;
/** Runs settling back to back share one pass: never closer together than this. */
const AFTER_RUN_MIN_GAP_MS = 30 * 60_000;

const sched = processStore("coding-folder-janitor:schedule", () => ({
  started: false,
  daily: null as NodeJS.Timeout | null,
  afterRun: null as NodeJS.Timeout | null,
  unsubscribe: null as (() => void) | null,
}));

function lastPassAt(): number {
  return readJanitorState().lastPass?.at ?? 0;
}

function arm(delayMs: number): void {
  if (sched.daily) clearTimeout(sched.daily);
  sched.daily = setTimeout(() => {
    sched.daily = null;
    void runJanitorPass({ trigger: "daily" })
      .then((r) => {
        if (r.removed || r.trashed || r.pruned || r.failed) {
          console.log(`[coding-folder-janitor] daily pass: ${r.removed} removed, ${r.trashed} trashed, ${r.pruned} pruned, ${r.failed} failed, ${r.freedBytes} bytes`);
        }
      })
      .catch((err: unknown) => console.error("[coding-folder-janitor] daily pass failed:", err instanceof Error ? err.message : err))
      .finally(() => arm(DAY_MS));
  }, Math.max(0, Math.min(delayMs, 0x7fffffff)));
  sched.daily.unref?.();
}

/** Re-arm after the switch is turned back on, from the last pass's date. */
function rearm(): void {
  if (!sched.started) return;
  arm(Math.max(BOOT_DELAY_MS, lastPassAt() + DAY_MS - Date.now()));
}

/**
 * Arm the daily pass and the after-run pass. Idempotent; called once from the
 * boot hook (src/instrumentation.ts). A timer rebuilt at every boot cannot be
 * duplicated or orphaned by an update; the last pass's date is on disk, so a
 * restart neither skips a day nor runs twice in one.
 */
export function start(): void {
  if (sched.started) return;
  sched.started = true;
  arm(Math.max(BOOT_DELAY_MS, lastPassAt() + DAY_MS - Date.now()));
  sched.unsubscribe = onRunSettled(noteRunFinished);
}

export function stop(): void {
  if (sched.daily) clearTimeout(sched.daily);
  if (sched.afterRun) clearTimeout(sched.afterRun);
  sched.unsubscribe?.();
  sched.daily = null;
  sched.afterRun = null;
  sched.unsubscribe = null;
  sched.started = false;
}

/** When the next daily pass is due, or null when none is armed. */
export function nextPassAt(): number | null {
  if (!sched.started || !sched.daily) return null;
  return Math.max(Date.now(), lastPassAt() + DAY_MS);
}

/**
 * A run settled: one small pass a little later. Nothing at all unless the
 * schedule was started (a test, a script) — a run settling must never turn
 * into a scan of somebody's folder by accident.
 */
export function noteRunFinished(): void {
  if (!sched.started || sched.afterRun) return;
  // Deferred, never dropped: a run that settles soon after a pass is
  // followed once the gap since that pass is up.
  const wait = Math.max(AFTER_RUN_DELAY_MS, lastPassAt() + AFTER_RUN_MIN_GAP_MS - Date.now());
  sched.afterRun = setTimeout(() => {
    sched.afterRun = null;
    void runJanitorPass({ trigger: "run-finished", maxRemovals: MAX_REMOVALS_AFTER_RUN })
      .catch((err: unknown) => console.error("[coding-folder-janitor] after-run pass failed:", err instanceof Error ? err.message : err));
  }, Math.min(wait, 0x7fffffff));
  sched.afterRun.unref?.();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
