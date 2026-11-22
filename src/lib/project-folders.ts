/**
 * MULTI-FOLDER PROJECTS (TASK-2757): a project that lists several folders, each
 * a git repository directly inside the owner's project folder — the way a VS
 * Code multi-root workspace lists its roots. "SkyHub" = skyhub_gateway_service
 * + skyhub_dashboard.
 *
 * Stored in data/config.json under ONE key, the way a project's MCP servers are
 * (project-mcp-servers.ts): `{ [project]: [{ folder, base? }] }`. A project with
 * no entry is a single-folder project, and every run in it behaves exactly as it
 * always did — the runner only takes the multi-folder path when this store
 * names the project.
 *
 * The project's own folder, `<project folder>/<project>`, is its HOME: a run on
 * it works in one directory there (`<home>/.clawbox/worktrees/<runId>`) that
 * holds a git worktree of EACH listed folder side by side, one subfolder per
 * repository (coding-agent.ts `attachRunFolders`). The home is either one of the
 * listed repositories (a project that had a folder added on its page) or a
 * plain folder `createFolderProject` made for the purpose.
 *
 * Pure of the runner: the caller passes the owner's project folder (`root`), so
 * coding-agent.ts can import this module without a cycle.
 */
import fs from "fs";
import path from "@/lib/runtime-path";
import { getKnown, set } from "@/lib/config-store";
import { SECRET_SCOPE_RE } from "@/lib/project-secrets-shape";

/** The config key. */
export const PROJECT_FOLDERS_KEY = "coding_agent_project_folders";

/** At most this many folders in one project: each is a worktree, a branch and a pull request per run. */
export const MAX_PROJECT_FOLDERS = 8;

/** One folder of a multi-folder project: its name in the owner's project folder, and the branch its runs fork from when not the one it is on. */
export interface ProjectFolder {
  folder: string;
  base?: string;
}

/** The same rule `requireBaseBranch` (coding-agent.ts) applies to a run's base_branch. */
const BASE_BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

export class ProjectFoldersError extends Error {
  constructor(
    public readonly code: "invalid_project" | "invalid_folder" | "not_a_repository" | "too_many" | "exists" | "not_found" | "store_unreadable",
    message: string,
  ) {
    super(message);
  }
}

/** A project or folder name: one path segment in the project-scope alphabet (the secret store's rule). */
export function isFolderName(name: unknown): name is string {
  return typeof name === "string" && SECRET_SCOPE_RE.test(name);
}

function readBase(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().replace(/^origin\//, "");
  return name && BASE_BRANCH_RE.test(name) && !name.endsWith(".lock") ? name : undefined;
}

/** The stored map, as far as it is one. With no prototype: a folder may be called `__proto__`. */
function storedMap(value: unknown): Record<string, ProjectFolder[]> {
  const out: Record<string, ProjectFolder[]> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [project, list] of Object.entries(value as Record<string, unknown>)) {
    if (!isFolderName(project) || !Array.isArray(list)) continue;
    const seen = new Set<string>();
    const kept: ProjectFolder[] = [];
    for (const row of list) {
      const folder = (row as { folder?: unknown } | null)?.folder;
      if (!isFolderName(folder) || seen.has(folder)) continue;
      seen.add(folder);
      const base = readBase((row as { base?: unknown }).base);
      kept.push(base ? { folder, base } : { folder });
    }
    if (kept.length > 0) out[project] = kept.slice(0, MAX_PROJECT_FOLDERS);
  }
  return out;
}

async function readMap(): Promise<Record<string, ProjectFolder[]>> {
  const { value, known } = await getKnown(PROJECT_FOLDERS_KEY);
  return known ? storedMap(value) : Object.create(null);
}

/** A project's folders, or null when it is a single-folder project (or the store cannot be read: a run then works as it always did). */
export async function readProjectFolders(project: string | null | undefined): Promise<ProjectFolder[] | null> {
  if (!isFolderName(project)) return null;
  const map = await readMap();
  return Object.hasOwn(map, project) ? map[project].map((f) => ({ ...f })) : null;
}

/** Every multi-folder project, by name. */
export async function listProjectFolders(): Promise<Record<string, ProjectFolder[]>> {
  return { ...(await readMap()) };
}

/** Every change after the previous one: a read-modify-write of one key, from two tabs or a tab and the assistant. */
let chain: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

async function mutate(change: (map: Record<string, ProjectFolder[]>) => void): Promise<Record<string, ProjectFolder[]>> {
  return serialised(async () => {
    const { value, known } = await getKnown(PROJECT_FOLDERS_KEY);
    if (!known) throw new ProjectFoldersError("store_unreadable", "This ClawBox could not read its settings file, so nothing was changed.");
    const map = storedMap(value);
    const before = JSON.stringify(map);
    change(map);
    if (JSON.stringify(map) !== before || (value !== undefined && Object.keys(map).length === 0)) {
      await set(PROJECT_FOLDERS_KEY, Object.keys(map).length > 0 ? map : undefined);
    }
    return map;
  });
}

/** True when `<root>/<name>` is a directory (not a link) with a `.git` directory of its own — what the projects listing counts as a repository. */
function isRepositoryFolder(root: string, name: string): boolean {
  const dir = path.join(path.resolve(root), name);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    return fs.lstatSync(path.join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function requireProjectName(project: unknown): string {
  if (!isFolderName(project)) throw new ProjectFoldersError("invalid_project", "A project is named by its folder's name: letters, digits, '-' and '_', at most 64.");
  return project;
}

function requireFolder(root: string, folder: unknown): string {
  if (!isFolderName(folder)) throw new ProjectFoldersError("invalid_folder", "A folder is named by its name in the project folder: letters, digits, '-' and '_', at most 64.");
  if (!isRepositoryFolder(root, folder)) {
    throw new ProjectFoldersError("not_a_repository", `${folder} is not a git repository directly inside the project folder (${root}).`);
  }
  return folder;
}

function requireBase(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const base = readBase(raw);
  if (!base) throw new ProjectFoldersError("invalid_folder", `"${String(raw).slice(0, 80)}" is not a branch name this box will fork from.`);
  return base;
}

/**
 * Create a multi-folder project: `<root>/<project>` becomes its home (made as a
 * plain folder when there is none) and `folders` its list. Refused when the
 * project already lists folders, or a folder is not a repository in `root`.
 */
export async function createFolderProject(root: string, project: unknown, folders: unknown): Promise<ProjectFolder[]> {
  const name = requireProjectName(project);
  if (!Array.isArray(folders) || folders.length === 0) throw new ProjectFoldersError("invalid_folder", "Name at least one folder.");
  const rows: ProjectFolder[] = [];
  for (const raw of folders) {
    const entry = typeof raw === "string" ? { folder: raw } : (raw as { folder?: unknown; base?: unknown } | null) ?? {};
    const folder = requireFolder(root, entry.folder);
    if (rows.some((r) => r.folder === folder)) continue;
    const base = requireBase(entry.base);
    rows.push(base ? { folder, base } : { folder });
  }
  if (rows.length > MAX_PROJECT_FOLDERS) throw new ProjectFoldersError("too_many", `A project may list at most ${MAX_PROJECT_FOLDERS} folders.`);
  const home = path.join(path.resolve(root), name);
  try {
    const st = fs.lstatSync(home);
    if (!st.isDirectory()) throw new ProjectFoldersError("invalid_project", `${home} exists and is not a folder.`);
  } catch (err) {
    if (err instanceof ProjectFoldersError) throw err;
    fs.mkdirSync(home, { recursive: true });
  }
  const map = await mutate((current) => {
    if (Object.hasOwn(current, name)) throw new ProjectFoldersError("exists", `${name} already lists folders; add or remove one instead.`);
    current[name] = rows;
  });
  return map[name].map((f) => ({ ...f }));
}

/**
 * Add one folder to a project. A project with no list yet starts one with its
 * OWN folder first when that is a repository — "Add folder" on a project's page
 * makes it a two-folder project, not a project that lost its own repository.
 */
export async function addProjectFolder(root: string, project: unknown, folder: unknown, base?: unknown): Promise<ProjectFolder[]> {
  const name = requireProjectName(project);
  const added = requireFolder(root, folder);
  const branch = requireBase(base);
  const map = await mutate((current) => {
    const list = Object.hasOwn(current, name) ? current[name] : (isRepositoryFolder(root, name) ? [{ folder: name }] : []);
    const at = list.findIndex((f) => f.folder === added);
    const row = branch ? { folder: added, base: branch } : { folder: added };
    if (at >= 0) list[at] = row;
    else list.push(row);
    if (list.length > MAX_PROJECT_FOLDERS) throw new ProjectFoldersError("too_many", `A project may list at most ${MAX_PROJECT_FOLDERS} folders.`);
    current[name] = list;
  });
  return map[name].map((f) => ({ ...f }));
}

/**
 * Take one folder off a project's list. When what is left is the project's own
 * folder alone, or nothing, the entry goes: the project is a single-folder
 * project again and its runs behave exactly as before.
 */
export async function removeProjectFolder(project: unknown, folder: unknown): Promise<ProjectFolder[]> {
  const name = requireProjectName(project);
  if (!isFolderName(folder)) throw new ProjectFoldersError("invalid_folder", "A folder is named by its name in the project folder.");
  const map = await mutate((current) => {
    if (!Object.hasOwn(current, name) || !current[name].some((f) => f.folder === folder)) {
      throw new ProjectFoldersError("not_found", `${name} does not list ${folder}.`);
    }
    const left = current[name].filter((f) => f.folder !== folder);
    if (left.length === 0 || (left.length === 1 && left[0].folder === name && !left[0].base)) delete current[name];
    else current[name] = left;
  });
  return Object.hasOwn(map, name) ? map[name].map((f) => ({ ...f })) : [];
}

/**
 * A deleted project's list goes with it, the way its MCP servers do — and so
 * does its folder from every OTHER project's list, which would otherwise name
 * a folder now in the trash and refuse every run's start. A list left with
 * nothing, or with its own folder alone, goes too (`removeProjectFolder`'s
 * rule). Never throws.
 */
export async function deleteProjectFolders(project: string): Promise<void> {
  if (!isFolderName(project)) return;
  await mutate((current) => {
    delete current[project];
    for (const name of Object.keys(current)) {
      const left = current[name].filter((f) => f.folder !== project);
      if (left.length === current[name].length) continue;
      if (left.length === 0 || (left.length === 1 && left[0].folder === name && !left[0].base)) delete current[name];
      else current[name] = left;
    }
  }).catch((err) => {
    console.error("[project-folders] a deleted project's folder list could not be removed:", err instanceof Error ? err.message : err);
  });
}
