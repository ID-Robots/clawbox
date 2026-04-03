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

function projectDir(projectId: string): string {
  if (!validateProjectId(projectId)) throw new ValidationError("Invalid project ID");
  return path.join(PROJECTS_DIR, projectId);
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

  const dir = projectDir(projectId);
  const exists = await fs.stat(dir).catch(() => null);
  if (exists) throw new ValidationError(`Project '${projectId}' already exists`);

  await fs.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    projectId,
    name,
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
  <title>${escapeHtml(name)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <h1>${escapeHtml(name)}</h1>
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
  <title>${escapeHtml(name)}</title>
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

    await fs.writeFile(
      path.join(dir, "app.js"),
      `// ${escapeHtml(name)} — ClawBox Web App
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  app.innerHTML = \`
    <h1>${escapeHtml(name)}</h1>
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
  if (filePath === "project.json") throw new ValidationError("Cannot overwrite project.json");
  const absPath = safePath(projectId, filePath);

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
  if (filePath === "project.json") throw new ValidationError("Cannot edit project.json");
  const absPath = safePath(projectId, filePath);
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
  if (filePath === "project.json") throw new ValidationError("Cannot delete project.json");
  const absPath = safePath(projectId, filePath);
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
    const flags = opts.caseSensitive ? "g" : "gi";
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch {
      throw new ValidationError(`Invalid regex pattern: ${pattern}`);
    }
    matcher = (line) => re.test(line);
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
        return `<script>\n${js}\n</script>`;
      } catch {
        return match;
      }
    }
  );

  // Deploy to webapps directory
  const webappDir = path.join(WEBAPPS_DIR, projectId);
  await fs.mkdir(webappDir, { recursive: true });
  await fs.writeFile(path.join(webappDir, "index.html"), html, "utf-8");
  await fs.writeFile(
    path.join(webappDir, "meta.json"),
    JSON.stringify({ name, color, icon: "" }),
    "utf-8"
  );

  const url = `/setup-api/webapps?app=${projectId}`;
  return { html, url, filesInlined };
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
