/**
 * Code Projects — manage code projects that build into ClawBox desktop webapps.
 *
 * Projects live in data/code-projects/<projectId>/ with a project.json metadata
 * file and arbitrary source files. The build step inlines local CSS/JS into
 * index.html and deploys to data/webapps/<projectId>/.
 */

import fs from "fs/promises";
import path from "path";
import { isProxyablePort } from "./clawbox-manifest";
import { DATA_DIR } from "./config-store";
import { registerWebappInPreferences } from "./webapp-registry";
import { ensureWebappIcon, htmlHint, safeAppId } from "./webapp-icon";
import { WEBAPP_KV_CLIENT_SNIPPET } from "./webapp-sandbox";

// ── Paths ──

const PROJECTS_DIR = path.join(DATA_DIR, "code-projects");
export const WEBAPPS_DIR = path.join(DATA_DIR, "webapps");

// ── Constraints ──

/** Shared app/project ID validation — alphanumeric, hyphens, underscores, 1-64 chars. */
export const APP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** The same rule spelled as an alphabet and a length, for safeProjectId. */
const PROJECT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
const MAX_PROJECT_ID_CHARS = 64;
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

/**
 * Resolve a file path inside a project directory, preventing traversal.
 *
 * The project half comes from `projectDir()` — the id rebuilt from the
 * alphabet — rather than a second `path.join(PROJECTS_DIR, projectId)` of its
 * own: a local constant of the same name shadowed that function here, so the
 * one root in this module that still joined the caller's string was the one
 * every `code_file_*` write and delete resolves against.
 *
 * ONE TERM AT A TIME, for the reason `src/app/setup-api/files/route.ts` states
 * over its own copy of this shape: `!resolved.startsWith(dir + path.sep) &&
 * resolved !== dir` leaves the code below reachable through the second term
 * without the prefix test having decided anything, so the containment check
 * governs nothing that follows — which is why every fs call downstream of this
 * helper stayed on the `js/path-injection` list (alert #529 and its siblings).
 * The project root answers with `projectDir`'s own string, which is the value
 * `resolved` holds in that branch; the accepted set does not move.
 */
function safePath(projectId: string, filePath: string): string {
  const dir = projectDir(projectId);
  const resolved = path.resolve(dir, filePath);
  if (resolved === dir) return dir;
  if (!resolved.startsWith(dir + path.sep)) {
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
  if (absPath === projectDir(projectId)) {
    throw new ValidationError("Refusing to target the project root");
  }
}

/**
 * The project id an on-disk path may be joined from, or null.
 *
 * validateProjectId's rule, applied the way webapp-icon's safeAppId applies
 * it: rather than testing the id and then joining the ORIGINAL string, the
 * value that reaches `path.join` is assembled one character at a time out of
 * the alphabet — whatever the caller sent, the path is made of these
 * characters and no more than this many of them. A `.test()` guard leaves the
 * caller's string in play, and a static analyser rightly keeps flagging every
 * path built from it. Its own copy because this module owns the id rule
 * (APP_ID_RE) and must not lean on the icon module for its directories.
 */
function safeProjectId(projectId: unknown): string | null {
  if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > MAX_PROJECT_ID_CHARS) {
    return null;
  }
  let safe = "";
  for (const ch of projectId) {
    const at = PROJECT_ID_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    safe += PROJECT_ID_ALPHABET[at];
  }
  return safe;
}

/**
 * The directory every project path is joined under — the scaffold initProject
 * writes, including the workflow it now ships, starts here — built from the
 * rebuilt id (safeProjectId), not the one that passed the test.
 */
function projectDir(projectId: string): string {
  const id = safeProjectId(projectId);
  if (!id) throw new ValidationError("Invalid project ID");
  return path.join(PROJECTS_DIR, id);
}

/**
 * The directory a DEPLOYED webapp lives in — `projectDir`'s sibling, and built
 * the same way, from the rebuilt id rather than the caller's string. Both roots
 * take an id from the same doors (`webapp_create`, `webapp_update`,
 * `code_project_build`, the webapps route), so leaving one of them joining the
 * raw string would have left the whole rule resting on whichever caller tested
 * it last. Exported because the webapps route serves files out of this folder
 * and must get its spelling from here rather than joining `WEBAPPS_DIR` again.
 */
export function webappPath(appId: string): string {
  const id = safeProjectId(appId);
  if (!id) throw new ValidationError("Invalid app ID");
  return path.join(WEBAPPS_DIR, id);
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

  // A check for the pull-request flow to wait on.
  //
  // The auto-PR switch (src/lib/coding-pr.ts) refuses to merge a pull request
  // that has NO checks — "every check passed" is trivially true of zero checks,
  // and merging on that would merge everything on sight. So a project scaffolded
  // here ships one real check: without it the flow would open pull requests that
  // can never satisfy their own guardrail, and the harness self-test could never
  // exercise the PR -> merge path it exists to prove.
  //
  // Deliberately trivial and dependency-free: it asserts the entry point exists
  // and is not empty, which is exactly the property a scaffold can promise.
  await fs.mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".github", "workflows", "check.yml"),
    `name: check
on:
  pull_request:
  push:
    branches-ignore:
      - "clawbox/**"

jobs:
  entry-point:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: index.html exists and is not empty
        run: |
          test -s index.html
          echo "index.html is $(wc -c < index.html) bytes"
`,
    "utf-8",
  );

  const template = opts?.template || "app";

  // Both scaffolds carry the KV bridge (src/lib/webapp-sandbox.ts): the built
  // app runs in a sandboxed frame with no ClawBox session, so this is the one
  // way it can persist anything, and the field guide tells the agent to call
  // window.clawboxKv as if it were already there.
  if (template === "blank") {
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(projectName)}</title>
  ${WEBAPP_KV_CLIENT_SNIPPET}
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
  ${WEBAPP_KV_CLIENT_SNIPPET}
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

// Plain-text only. A `regex` option used to compile the caller's pattern and
// run `re.test` synchronously per line, and no length cap bounds that: the
// cost of "(a+)+$" is exponential in the LINE, so a 30-character line held
// the box's one event loop — the desktop, every /setup-api route, the
// gateway proxy and the terminal's WebSocket — for minutes, and a line the
// caller had just written with `file-write` for hours. Nothing on the device
// sent it (no UI, no MCP tool; the CLI posts a plain pattern) and the agent
// already has a killable `grep` under a deadline, so the branch went rather
// than gained a worker. The route answers `regex_unsupported` for a body
// that still asks, so an old script gets a refusal and not a quiet change of
// meaning.
export async function searchFiles(
  projectId: string,
  pattern: string,
  opts?: { caseSensitive?: boolean; maxResults?: number }
): Promise<SearchMatch[]> {
  const dir = projectDir(projectId);
  const files = await getAllTextFiles(dir);
  const results: SearchMatch[] = [];
  const max = opts?.maxResults || 100;

  const needle = opts?.caseSensitive ? pattern : pattern.toLowerCase();
  const matcher = (line: string) =>
    (opts?.caseSensitive ? line : line.toLowerCase()).includes(needle);

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
    .stat(path.join(webappPath(projectId), "meta.json"))
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
  const dir = webappPath(appId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), html, "utf-8");
}

// ── Legacy host:port stubs ───────────────────────────────────────────────────
//
// Before `/apps/<id>/` existed (src/lib/app-proxy.ts), an app with a server of
// its own was put on the desktop as a one-file stub that sent the frame to
// `location.hostname:<port>`. Those stubs are still on disk on every box that
// shipped, and when their server is not running the window is whatever the
// browser makes of ERR_CONNECTION_REFUSED — an empty white rectangle, with
// nothing anywhere to say the app is simply not started. The webapps route
// recognises such a stub before it serves it; these two are what it needs.

/** The largest document still plausibly a redirect stub rather than an app. */
export const LEGACY_STUB_MAX_BYTES = 4096;
/** How a stub sends the frame somewhere else. */
const LEGACY_REDIRECT_RE = /location\s*\.\s*(?:replace|assign|href)|http-equiv\s*=\s*["']?refresh/i;

/**
 * The port a legacy host:port redirect stub points at, or null when this
 * document is not one.
 *
 * Deliberately narrow — a document is only a stub when it is TINY, names
 * `location.hostname`, redirects, and carries a port a local server could
 * actually have. A one-file app that happens to read its own hostname must
 * never be mistaken for one, because being mistaken means it is not served.
 */
export function legacyRedirectPort(html: string): number | null {
  if (html.length > LEGACY_STUB_MAX_BYTES) return null;
  if (!/location\s*\.\s*hostname/.test(html)) return null;
  if (!LEGACY_REDIRECT_RE.test(html)) return null;
  for (const match of html.matchAll(/:(\d{4,5})(?!\d)/g)) {
    const port = Number(match[1]);
    if (isProxyablePort(port)) return port;
  }
  return null;
}

/**
 * The page shown in place of a legacy stub whose server is not there.
 *
 * `detail` is the box's own sentence about the port — the same one
 * `/apps/<id>/` answers a 502 with — so the two surfaces cannot say different
 * things about the same silence. Framed with an opaque origin, so it is plain
 * HTML with no script and no link back into the desktop.
 */
export function serverAppDownHtml(name: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>` +
    "body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}" +
    "main{max-width:34rem;text-align:center}h1{font-size:1.05rem;font-weight:600;margin:0 0 .6rem}p{margin:0;font-size:.9rem;line-height:1.6;color:#b9b9c6}" +
    `</style></head><body><main><h1>${escapeHtml(name)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
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
    path.join(webappPath(appId), "meta.json"),
    JSON.stringify({ name, color: meta.color || "#f97316", icon: meta.icon || "" }),
    "utf-8",
  );
  // The icon is drawn inside `registerWebappInPreferences`, for every app that
  // reaches the desktop rather than only the ones built from HTML here — hence
  // the description: it is the icon prompt's only clue about what the app does,
  // and `htmlHint` is the best one available on this path. An app that supplied
  // an icon of its own is left alone there.
  await registerWebappInPreferences(appId, name, {
    color: meta.color,
    iconUrl: meta.icon,
    webappUrl: `/setup-api/webapps?app=${appId}`,
    description: meta.description || htmlHint(html),
  });
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
