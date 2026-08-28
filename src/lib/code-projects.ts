/**
 * Code Projects — manage code projects that build into ClawBox desktop webapps.
 *
 * Projects live in data/code-projects/<projectId>/ with a project.json metadata
 * file and arbitrary source files. The build step inlines local CSS/JS into
 * index.html and deploys to data/webapps/<projectId>/.
 */

import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./config-store";
import { registerWebappInPreferences } from "./webapp-registry";
import { ensureWebappIcon, htmlHint, safeAppId } from "./webapp-icon";

// ── Paths ──

const PROJECTS_DIR = path.join(DATA_DIR, "code-projects");
export const WEBAPPS_DIR = path.join(DATA_DIR, "webapps");

// ── Constraints ──

/** Shared app/project ID validation — alphanumeric, hyphens, underscores, 1-64 chars. */
export const APP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_FILE_SIZE = 512 * 1024; // 512 KB per file
const MAX_PROJECT_FILES = 200;

const TEXT_EXTS = new Set([
  ".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx",
  ".json", ".xml", ".svg", ".md", ".txt", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".env", ".sh", ".py", ".rb",
  ".go", ".rs", ".c", ".h", ".cpp", ".java", ".vue", ".svelte",
]);

// ── Error Types ──

export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "NotFoundError"; }
}
export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}

// ── Types ──

export interface ProjectMeta {
  projectId: string;
  name: string;
  color: string;
  description: string;
  created: string;
  updated: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileEntry[];
}

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

export interface BuildResult {
  html: string;
  url: string;
  filesInlined: number;
}

// ── Validation ──

export function validateProjectId(id: string): boolean {
  return APP_ID_RE.test(id);
}

/** Longest project name the desktop label and the starter templates carry. */
export const MAX_PROJECT_NAME_LENGTH = 60;

/**
 * The name a project may be created with, trimmed — or a ValidationError.
 *
 * Checked in the library rather than at each route because initProject writes
 * the directory and project.json before the name reaches the templates: a name
 * the templates cannot render has to be refused while nothing has been created
 * yet, so a rejected request leaves no project behind for the next attempt to
 * collide with. deployWebapp applies it for the same reason — it is the
 * chokepoint the webapps route and buildProject share. The MCP door declares
 * the same limit (`zText(60)` in mcp/tools/desktop.ts); this is where it is
 * enforced.
 */
function assertProjectName(name: unknown): string {
  if (typeof name !== "string") throw new ValidationError("Project name must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError("Project name required");
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ValidationError(`Project name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/** Resolve a file path inside a project directory, preventing traversal. */
function safePath(projectId: string, filePath: string): string {
  if (!validateProjectId(projectId)) throw new ValidationError("Invalid project ID");
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    throw new ValidationError("Path traversal denied");
  }
  return resolved;
}

/**
 * Guard a mutating (write/edit/delete) target. The raw-string `=== "project.json"`
 * checks were bypassable with equivalent spellings ("./project.json"), and a
 * path resolving to the project root itself ("." / "./") would let a single
 * file-delete recursively wipe the whole project. Check the RESOLVED path.
 */
function assertMutableTarget(projectId: string, absPath: string): void {
  if (path.basename(absPath) === "project.json") {
    throw new ValidationError("Cannot modify project.json");
  }
  if (absPath === path.join(PROJECTS_DIR, projectId)) {
    throw new ValidationError("Refusing to target the project root");
  }
}

function projectDir(projectId: string): string {
  if (!validateProjectId(projectId)) throw new ValidationError("Invalid project ID");
  return path.join(PROJECTS_DIR, projectId);
}

/**
 * The ABSOLUTE on-device directory a project's source files live in.
 *
 * Exported because the agent edits those files with its harness's own file
 * tools, and those resolve a relative path against the HARNESS's working
 * directory, not the web tier's. On a Hermes device the two differ
 * (/home/clawbox vs /home/clawbox/clawbox), so handing out
 * "data/code-projects/<id>/" made every read miss and every write land in a
 * parallel tree that nothing ever builds. Only an absolute path is portable
 * between the two processes.
 */
export function projectPath(projectId: string): string {
  return projectDir(projectId);
}

function metaPath(projectId: string): string {
  return path.join(projectDir(projectId), "project.json");
}

// ── Project CRUD ──

export async function initProject(
  projectId: string,
  name: string,
  opts?: { color?: string; description?: string; template?: "blank" | "app" }
): Promise<ProjectMeta> {
  if (!validateProjectId(projectId)) throw new ValidationError("Invalid project ID");
  // Before anything is created on disk — see assertProjectName.
  const projectName = assertProjectName(name);

  const dir = projectDir(projectId);
  const exists = await fs.stat(dir).catch(() => null);
  if (exists) throw new ValidationError(`Project '${projectId}' already exists`);

  await fs.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    projectId,
    name: projectName,
    color: opts?.color || "#f97316",
    description: opts?.description || "",
    created: now,
    updated: now,
  };
  await fs.writeFile(metaPath(projectId), JSON.stringify(meta, null, 2), "utf-8");

  const template = opts?.template || "app";

  if (template === "blank") {
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <h1>${escapeHtml(projectName)}</h1>
</body>
</html>`,
      "utf-8"
    );
  } else {
    // "app" template — multi-file with separated CSS/JS
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(dir, "style.css"),
      `* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
  min-height: 100vh;
}

#app {
  padding: 20px;
}

h1 {
  color: #f97316;
  margin-bottom: 16px;
}
`,
      "utf-8"
    );

    // The name is written into app.js — once as a line comment and once inside
    // a JS template literal assigned to innerHTML. escapeHtml alone leaves the
    // template-literal metacharacters (` $ \) and newlines untouched, so a name
    // like "`;fetch('/setup-api/...')`" would break out of the literal and run
    // as code when the built app loads on the ClawBox origin (stored XSS).
    const commentName = projectName.replace(/[\r\n]+/g, " ");
    const innerName = jsTemplateEscape(escapeHtml(projectName));
    await fs.writeFile(
      path.join(dir, "app.js"),
      `// ${commentName} — ClawBox Web App
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  app.innerHTML = \`
    <h1>${innerName}</h1>
    <p>Edit the project files to build your app.</p>
  \`;
});
`,
      "utf-8"
    );
  }

  return meta;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });

  const projects = (
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (entry) => {
          try {
            const raw = await fs.readFile(
              path.join(PROJECTS_DIR, entry.name, "project.json"),
              "utf-8"
            );
            return JSON.parse(raw) as ProjectMeta;
          } catch {
            return null;
          }
        })
    )
  ).filter((p): p is ProjectMeta => p !== null);

  return projects.sort(
    (a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime()
  );
}

export async function getProject(projectId: string): Promise<ProjectMeta> {
  const raw = await fs.readFile(metaPath(projectId), "utf-8");
  return JSON.parse(raw);
}

export async function deleteProject(projectId: string): Promise<void> {
  if (!validateProjectId(projectId)) throw new ValidationError("Invalid project ID");
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

async function touchProject(projectId: string): Promise<void> {
  try {
    const meta = await getProject(projectId);
    meta.updated = new Date().toISOString();
    await fs.writeFile(metaPath(projectId), JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    // ignore if project.json doesn't exist
  }
}

// ── File Operations ──

export async function listFiles(projectId: string, dir?: string): Promise<FileEntry[]> {
  const base = dir ? safePath(projectId, dir) : projectDir(projectId);
  const entries = await fs.readdir(base, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    if (entry.name === "project.json") continue;

    const relPath = dir ? path.join(dir, entry.name) : entry.name;

    if (entry.isDirectory()) {
      const children = await listFiles(projectId, relPath);
      result.push({ name: entry.name, path: relPath, type: "directory", children });
    } else {
      const stat = await fs.stat(path.join(base, entry.name));
      result.push({ name: entry.name, path: relPath, type: "file", size: stat.size });
    }
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFile(projectId: string, filePath: string): Promise<string> {
  const absPath = safePath(projectId, filePath);
  return fs.readFile(absPath, "utf-8");
}

export async function writeFile(
  projectId: string,
  filePath: string,
  content: string
): Promise<void> {
  const absPath = safePath(projectId, filePath);
  assertMutableTarget(projectId, absPath);

  const size = Buffer.byteLength(content, "utf-8");
  if (size > MAX_FILE_SIZE) {
    throw new ValidationError(`File too large (${size} bytes, max ${MAX_FILE_SIZE})`);
  }

  // Only count files when creating new ones, not on overwrites
  const fileExists = await fs.stat(absPath).catch(() => null);
  if (!fileExists) {
    const allFiles = await countFiles(projectDir(projectId));
    if (allFiles >= MAX_PROJECT_FILES) {
      throw new ValidationError(`Project file limit reached (max ${MAX_PROJECT_FILES})`);
    }
  }

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf-8");
  await touchProject(projectId);
}

export async function editFile(
  projectId: string,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): Promise<{ applied: number }> {
  const absPath = safePath(projectId, filePath);
  assertMutableTarget(projectId, absPath);
  let content = await fs.readFile(absPath, "utf-8");

  if (!content.includes(oldString)) {
    throw new ValidationError(
      `old_string not found in ${filePath}. Make sure the string matches exactly (including whitespace and indentation).`
    );
  }

  let applied: number;
  if (replaceAll) {
    const parts = content.split(oldString);
    applied = parts.length - 1;
    content = parts.join(newString);
  } else {
    // Ensure uniqueness for single replacement
    const first = content.indexOf(oldString);
    const second = content.indexOf(oldString, first + oldString.length);
    if (second !== -1) {
      throw new ValidationError(
        `old_string appears multiple times in ${filePath}. Provide more context to make it unique, or set replaceAll=true.`
      );
    }
    content = content.replace(oldString, newString);
    applied = 1;
  }

  const size = Buffer.byteLength(content, "utf-8");
  if (size > MAX_FILE_SIZE) {
    throw new ValidationError(`Resulting file too large (${size} bytes, max ${MAX_FILE_SIZE})`);
  }

  await fs.writeFile(absPath, content, "utf-8");
  await touchProject(projectId);
  return { applied };
}

export async function deleteFile(projectId: string, filePath: string): Promise<void> {
  const absPath = safePath(projectId, filePath);
  assertMutableTarget(projectId, absPath);
  await fs.rm(absPath, { recursive: true });
  await touchProject(projectId);
}

// ── Search ──

export async function searchFiles(
  projectId: string,
  pattern: string,
  opts?: { regex?: boolean; caseSensitive?: boolean; maxResults?: number }
): Promise<SearchMatch[]> {
  const dir = projectDir(projectId);
  const files = await getAllTextFiles(dir);
  const results: SearchMatch[] = [];
  const max = opts?.maxResults || 100;

  let matcher: (line: string) => boolean;
  if (opts?.regex) {
    // Cap the pattern length to limit worst-case backtracking a caller can set
    // up (JS has no native regex timeout; a pattern like "(a+)+$" over a long
    // line backtracks exponentially and would block the single-threaded event
    // loop). Combined with the per-line slice below this bounds the work.
    if (pattern.length > 200) {
      throw new ValidationError("Regex pattern too long (max 200 chars)");
    }
    // No global flag: only test() is used, and the 'g' flag makes test()
    // stateful (persisting lastIndex), which silently skips alternating matches.
    const flags = opts.caseSensitive ? "" : "i";
    // Flagged by CodeQL js/regex-injection: the pattern is a search FILTER, not
    // a guard. It decides no path, permission or sanitisation outcome — only
    // which lines of this device's own project files come back to the caller
    // that asked. /setup-api/code sits behind the session / MCP-bearer gate.
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      throw new ValidationError(`Invalid regex pattern: ${pattern}`);
    }
    // Bound each test to a slice so a pathological pattern against a very long
    // line (files can be up to 512 KB) can't hang the process.
    matcher = (line) => re.test(line.length > 2000 ? line.slice(0, 2000) : line);
  } else {
    const needle = opts?.caseSensitive ? pattern : pattern.toLowerCase();
    matcher = (line) =>
      (opts?.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  outer: for (const file of files) {
    const relPath = path.relative(dir, file);
    if (relPath === "project.json") continue;

    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) {
        results.push({ file: relPath, line: i + 1, content: lines[i] });
        if (results.length >= max) break outer;
      }
    }
  }

  return results;
}

// ── Build & Deploy ──

export async function buildProject(
  projectId: string,
  opts?: { name?: string; color?: string }
): Promise<BuildResult> {
  const dir = projectDir(projectId);
  const meta = await getProject(projectId);
  const name = opts?.name || meta.name;
  const color = opts?.color || meta.color;

  // Read index.html — required entry point
  const indexPath = path.join(dir, "index.html");
  let html: string;
  try {
    html = await fs.readFile(indexPath, "utf-8");
  } catch {
    throw new NotFoundError(
      "Project must have an index.html file as the entry point."
    );
  }

  // Inline local CSS — lookaheads match both attribute orderings in one pass
  let filesInlined = 0;
  html = await replaceAsync(
    html,
    /<link\s+(?=[^>]*rel=["']stylesheet["'])(?=[^>]*href=["']([^"']+)["'])[^>]*\/?>/gi,
    async (match, href) => {
      if (isExternalUrl(href)) return match;
      try {
        const cssPath = safePath(projectId, href);
        const css = await fs.readFile(cssPath, "utf-8");
        filesInlined++;
        return `<style>\n${css}\n</style>`;
      } catch {
        return match;
      }
    }
  );

  // Inline local JS: <script src="local.js"></script>
  html = await replaceAsync(
    html,
    /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
    async (match, src) => {
      if (isExternalUrl(src)) return match;
      try {
        const jsPath = safePath(projectId, src);
        const js = await fs.readFile(jsPath, "utf-8");
        filesInlined++;
        // Neutralize any literal "</script>" in the source so it can't close
        // the inlined block early and dump the remainder into the DOM.
        return `<script>\n${escapeScriptClose(js)}\n</script>`;
      } catch {
        return match;
      }
    }
  );

  // First build registers the app on the desktop via the shared chokepoint
  // (same on-disk layout + meta.json shape as the webapps POST route). A
  // rebuild only refreshes index.html — re-running deployWebapp would clobber
  // the saved icon and re-surface an app the user intentionally hid.
  const alreadyDeployed = await fs
    .stat(path.join(WEBAPPS_DIR, projectId, "meta.json"))
    .then(() => true)
    .catch(() => false);
  if (alreadyDeployed) {
    await writeWebappIndex(projectId, html);
    // A rebuild of an app that still has no icon — its first build may have
    // happened before the box was linked to ClawBox AI — gets the same
    // after-the-reply generation a create does. `ensureWebappIcon` answers
    // 'kept' from one stat when the icon has since appeared, so this costs a
    // meta.json read and nothing more on every other rebuild.
    if (await deployedWithoutIcon(projectId)) {
      void ensureWebappIcon(projectId, {
        name,
        color,
        description: meta.description || htmlHint(html),
      }).catch(() => {});
    }
  } else {
    await deployWebapp(projectId, html, { name, color, description: meta.description });
  }

  const url = `/setup-api/webapps?app=${projectId}`;
  return { html, url, filesInlined };
}

/**
 * Refresh only the deployed index.html for an existing webapp. The shared
 * "update" chokepoint (webapps POST update branch + buildProject rebuilds) —
 * it deliberately leaves meta.json and the desktop registration untouched so a
 * rebuild can't wipe the saved icon or re-surface an app the user hid.
 */
export async function writeWebappIndex(appId: string, html: string): Promise<void> {
  const dir = path.join(WEBAPPS_DIR, appId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), html, "utf-8");
}

/**
 * Deploy a single-page webapp to data/webapps/<appId>/ (index.html + meta.json)
 * and durably register it on the desktop. The one chokepoint shared by the
 * webapps POST route and buildProject — so the on-disk layout, the meta.json
 * shape, and the preference registration can't drift between the two create
 * paths (and can't be half-applied by one caller forgetting a step).
 *
 * Create-time only: it (re)writes meta.json and re-registers in preferences.
 * For rebuilds of an existing app use writeWebappIndex so existing metadata
 * and hidden/uninstalled state are preserved.
 */
export async function deployWebapp(
  appId: string,
  html: string,
  meta: { name: string; color?: string; icon?: string; description?: string },
): Promise<void> {
  // Same rule and same reason as initProject: the name reaches meta.json and
  // the desktop label, so bound it before any of that is written.
  const name = assertProjectName(meta.name);
  await writeWebappIndex(appId, html);
  await fs.writeFile(
    path.join(WEBAPPS_DIR, appId, "meta.json"),
    JSON.stringify({ name, color: meta.color || "#f97316", icon: meta.icon || "" }),
    "utf-8",
  );
  await registerWebappInPreferences(appId, name, {
    color: meta.color,
    iconUrl: meta.icon,
    webappUrl: `/setup-api/webapps?app=${appId}`,
  });
  // An app that arrived without an icon gets one drawn by ClawBox AI, AFTER
  // this returns: generation takes 5–15 s and the tool reply behind this call
  // must not wait for a picture. Fire-and-forget by design — the app is
  // created and registered either way, and `ensureWebappIcon` never rejects;
  // the `.catch` is belt and braces against an unhandled rejection ever taking
  // the server down over a missing icon. A create that supplied its own icon
  // is left alone.
  if (!meta.icon) {
    void ensureWebappIcon(appId, {
      name,
      color: meta.color,
      description: meta.description || htmlHint(html),
    }).catch(() => {});
  }
}

/** Is this deployed app's meta.json still without an icon of its own? */
async function deployedWithoutIcon(appId: string): Promise<boolean> {
  // The id passed the door already; the path is still joined from the rebuilt
  // copy, so this read stands on its own the way ensureWebappIcon's do.
  const id = safeAppId(appId);
  if (!id) return false;
  try {
    const raw = await fs.readFile(path.join(WEBAPPS_DIR, id, "meta.json"), "utf-8");
    const parsed = JSON.parse(raw) as { icon?: unknown };
    return !parsed.icon;
  } catch {
    // Unreadable metadata is not a reason to spend a generation on it.
    return false;
  }
}

// ── Helpers ──

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a value for safe embedding inside a JS template literal (`...`). */
function jsTemplateEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

/** Neutralize a literal `</script` so inlined JS can't break out of a <script>. */
function escapeScriptClose(s: string): string {
  return s.replace(/<\/(script)/gi, "<\\/$1");
}

function isExternalUrl(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || href.startsWith("data:");
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

async function getAllTextFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await getAllTextFiles(full)));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXTS.has(ext) || entry.name.startsWith(".")) {
        results.push(full);
      }
    }
  }
  return results;
}

/** Async version of String.replace for callback-based replacements. */
async function replaceAsync(
  str: string,
  regex: RegExp,
  asyncFn: (match: string, ...groups: string[]) => Promise<string>
): Promise<string> {
  const promises: Promise<string>[] = [];
  str.replace(regex, (match, ...args) => {
    promises.push(asyncFn(match, ...args));
    return match;
  });
  const results = await Promise.all(promises);
  let i = 0;
  return str.replace(regex, () => results[i++]);
}
