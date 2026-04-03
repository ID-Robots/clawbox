#!/usr/bin/env bun
/**
 * ClawBox MCP Server v3.0.0
 *
 * Full coding-agent tool suite (clean-room reimplementation of Claude Code tools)
 * plus ClawBox-specific device, desktop, and webapp tools.
 *
 * Transport: stdio
 * Backend: HTTP to local ClawBox web server + direct shell/fs execution
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";
import { readFile as fsReadFile, writeFile as fsWriteFile, readdir, stat, mkdir, unlink } from "fs/promises";
import { resolve, relative, dirname, extname, join, basename } from "path";

// ══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════

const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
const HOME = process.env.HOME || "/home/clawbox";
const DEFAULT_CWD = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const COMMAND_TIMEOUT = 30_000;
const MAX_COMMAND_TIMEOUT = 600_000;
const AUTO_BG_TIMEOUT = 15_000;
const UI_PICKUP_DELAY_MS = 2500;
const DEFAULT_READ_LIMIT = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const GLOB_RESULT_LIMIT = 200;
const GREP_RESULT_LIMIT = 250;
const WEB_CACHE_TTL = 15 * 60_000; // 15 minutes

// ══════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ══════════════════════════════════════════════════════════════════════

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

async function apiPost(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ══════════════════════════════════════════════════════════════════════
// SHELL HELPERS
// ══════════════════════════════════════════════════════════════════════

function runShell(
  command: string,
  timeoutMs = COMMAND_TIMEOUT,
  cwd = HOME,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      timeout: timeoutMs, cwd,
      env: { ...process.env, HOME },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.on("error", (err: Error) => resolve({ stdout, stderr: err.message, exitCode: 1 }));
  });
}

/** Escape a string for safe inclusion in a bash command. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ══════════════════════════════════════════════════════════════════════
// DANGEROUS COMMAND DETECTION (bash security)
// ══════════════════════════════════════════════════════════════════════

const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)/, "Recursive forced delete — may destroy data irreversibly"],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/, "Recursive forced delete — may destroy data irreversibly"],
  [/\bgit\s+push\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)/, "Force push — may overwrite remote history"],
  [/\bgit\s+reset\s+--hard/, "Hard reset — discards all local changes"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "Git clean force — removes untracked files permanently"],
  [/\bgit\s+checkout\s+--\s+\./, "Checkout . — discards all unstaged changes"],
  [/\bgit\s+branch\s+-D\b/, "Force delete branch — may lose unmerged work"],
  [/\bdd\s+.*of=\/dev\//, "Direct device write — may corrupt disk"],
  [/\bmkfs\./, "Filesystem format — destroys all data on device"],
  [/\b(chmod|chown)\s+(-R\s+)?.*\/\s*$/, "Recursive permission change on root"],
  [/>\s*\/dev\/[sh]d[a-z]/, "Redirect to raw device — destroys filesystem"],
  [/\bkill\s+-9\s+-1/, "Kill all processes — system crash"],
  [/\bsystemctl\s+(stop|disable)\s+(NetworkManager|sshd|systemd)/, "Stopping critical system service"],
  [/:(){ :\|:& };:/, "Fork bomb"],
];

const GIT_SAFETY_PATTERNS: [RegExp, string][] = [
  [/\bgit\s+push\s+.*--no-verify/, "Skipping push hooks (--no-verify)"],
  [/\bgit\s+commit\s+.*--no-verify/, "Skipping commit hooks (--no-verify)"],
  [/\bgit\s+.*--no-gpg-sign/, "Skipping GPG signing"],
  [/\bgit\s+rebase\s+-i/, "Interactive rebase requires terminal — not supported"],
  [/\bgit\s+add\s+(-A|--all|\.)(\s|$)/, "git add -A/--all/. — may stage secrets or large files. Prefer adding specific files."],
];

const READ_ONLY_PATTERNS = /^\s*(ls|cat|head|tail|less|more|find|grep|rg|wc|file|stat|du|df|top|ps|who|id|uname|hostname|date|echo|printf|which|type|env|printenv|set)\b/;

function detectDangerousCommand(cmd: string): string[] {
  const warnings: string[] = [];
  for (const [pattern, msg] of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) warnings.push(`⚠ DANGEROUS: ${msg}`);
  }
  for (const [pattern, msg] of GIT_SAFETY_PATTERNS) {
    if (pattern.test(cmd)) warnings.push(`⚠ GIT SAFETY: ${msg}`);
  }
  return warnings;
}

// ══════════════════════════════════════════════════════════════════════
// BACKGROUND TASK STORE
// ══════════════════════════════════════════════════════════════════════

interface BgTask {
  id: string;
  command: string;
  description: string;
  status: "running" | "completed" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  completedAt: number | null;
  process: ChildProcess | null;
}

const bgTasks = new Map<string, BgTask>();
const BG_TASK_MAX_AGE = 3600_000; // evict completed tasks after 1 hour
const BG_TASK_MAX_KEPT = 50;
let bgTaskSeq = 0;

function evictStaleBgTasks() {
  const now = Date.now();
  for (const [id, task] of bgTasks) {
    if (task.status !== "running" && task.completedAt && now - task.completedAt > BG_TASK_MAX_AGE) {
      bgTasks.delete(id);
    }
  }
  // If still over limit, drop oldest completed
  if (bgTasks.size > BG_TASK_MAX_KEPT) {
    const completed = [...bgTasks.entries()]
      .filter(([, t]) => t.status !== "running")
      .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));
    while (bgTasks.size > BG_TASK_MAX_KEPT && completed.length) {
      bgTasks.delete(completed.shift()![0]);
    }
  }
}

function spawnBackground(command: string, timeoutMs: number, desc = ""): BgTask {
  evictStaleBgTasks();
  const id = `bg-${++bgTaskSeq}`;
  const task: BgTask = {
    id, command, description: desc, status: "running",
    stdout: "", stderr: "", exitCode: null,
    startedAt: Date.now(), completedAt: null, process: null,
  };
  bgTasks.set(id, task);

  const child = spawn("bash", ["-c", command], {
    timeout: timeoutMs, cwd: HOME,
    env: { ...process.env, HOME },
  });
  task.process = child;
  child.stdout.on("data", (d: Buffer) => { task.stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { task.stderr += d.toString(); });
  child.on("close", (code: number | null) => {
    task.exitCode = code ?? 1;
    task.status = code === 0 ? "completed" : "failed";
    task.completedAt = Date.now();
    task.process = null;
  });
  child.on("error", (err: Error) => {
    task.stderr += err.message;
    task.exitCode = 1;
    task.status = "failed";
    task.completedAt = Date.now();
    task.process = null;
  });
  return task;
}

// ══════════════════════════════════════════════════════════════════════
// USER TASK STORE (full-featured)
// ══════════════════════════════════════════════════════════════════════

interface UserTask {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string;
  activeForm: string;
  metadata: Record<string, unknown>;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
  updatedAt: string;
}

const userTasks = new Map<string, UserTask>();
let userTaskSeq = 0;

// ══════════════════════════════════════════════════════════════════════
// FILE STATE TRACKING (staleness detection)
// ══════════════════════════════════════════════════════════════════════

interface FileState {
  mtime: number;
  size: number;
  readAt: number;
}

const fileReadState = new Map<string, FileState>();
const FILE_STATE_MAX = 500;

async function recordFileRead(absPath: string): Promise<void> {
  try {
    const st = await stat(absPath);
    fileReadState.set(absPath, { mtime: st.mtimeMs, size: st.size, readAt: Date.now() });
    // Evict oldest entries when over limit
    if (fileReadState.size > FILE_STATE_MAX) {
      const oldest = [...fileReadState.entries()].sort((a, b) => a[1].readAt - b[1].readAt);
      while (fileReadState.size > FILE_STATE_MAX && oldest.length) {
        fileReadState.delete(oldest.shift()![0]);
      }
    }
  } catch {}
}

async function checkStaleness(absPath: string): Promise<string | null> {
  const prev = fileReadState.get(absPath);
  if (!prev) return null; // never read — no staleness possible
  try {
    const st = await stat(absPath);
    if (st.mtimeMs !== prev.mtime) {
      return `File has been modified since you last read it (${new Date(prev.mtime).toLocaleTimeString()} → ${new Date(st.mtimeMs).toLocaleTimeString()}). Read it again before editing.`;
    }
  } catch {}
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// WEB FETCH CACHE
// ══════════════════════════════════════════════════════════════════════

interface CacheEntry { body: string; contentType: string; status: number; fetchedAt: number; }
const webCache = new Map<string, CacheEntry>();
const WEB_CACHE_MAX = 50;

function evictStaleWebCache() {
  const now = Date.now();
  for (const [url, entry] of webCache) {
    if (now - entry.fetchedAt > WEB_CACHE_TTL) webCache.delete(url);
  }
  if (webCache.size > WEB_CACHE_MAX) {
    const oldest = [...webCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    while (webCache.size > WEB_CACHE_MAX && oldest.length) {
      webCache.delete(oldest.shift()![0]);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// FILE HELPERS
// ══════════════════════════════════════════════════════════════════════

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
const BINARY_EXTS = new Set([".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".bin", ".exe", ".so", ".dylib", ".o", ".a", ".wasm", ".pyc", ".class", ".pdf"]);
const BLOCKED_PATHS = new Set(["/dev/zero", "/dev/null", "/dev/random", "/dev/urandom", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/console", "/proc/self/mem"]);

function isImageFile(p: string): boolean { return IMAGE_EXTS.has(extname(p).toLowerCase()); }
function isBinaryFile(p: string): boolean { return BINARY_EXTS.has(extname(p).toLowerCase()); }
function isPdfFile(p: string): boolean { return extname(p).toLowerCase() === ".pdf"; }
function isNotebookFile(p: string): boolean { return extname(p).toLowerCase() === ".ipynb"; }

function resolvePath(filePath: string): string {
  if (filePath.startsWith("~")) return join(HOME, filePath.slice(1).replace(/^\//, ""));
  if (filePath.startsWith("/")) return filePath;
  return resolve(DEFAULT_CWD, filePath);
}

function detectEncoding(buf: Buffer): { encoding: BufferEncoding; hasBom: boolean } {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { encoding: "utf16le", hasBom: true };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { encoding: "utf-8", hasBom: true };
  return { encoding: "utf-8", hasBom: false };
}

function detectLineEnding(content: string): string {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function simpleDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const hunks: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++; continue;
    }
    // Found a difference — output context
    const startI = Math.max(0, i - 2);
    const startJ = Math.max(0, j - 2);
    hunks.push(`@@ -${startI + 1} +${startJ + 1} @@`);
    // Output some context before
    for (let c = Math.max(0, i - 2); c < i; c++) hunks.push(` ${oldLines[c]}`);
    // Output changed lines
    while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
      hunks.push(`-${oldLines[i++]}`);
    }
    while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
      hunks.push(`+${newLines[j++]}`);
    }
    // Output some context after
    for (let c = 0; c < 2 && i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]; c++) {
      hunks.push(` ${oldLines[i++]}`);
      j++;
    }
    if (hunks.length > 100) { hunks.push("[diff truncated]"); break; }
  }
  return hunks.length > 2 ? hunks.join("\n") : "[no textual diff]";
}

// ══════════════════════════════════════════════════════════════════════
// HTML-TO-TEXT
// ══════════════════════════════════════════════════════════════════════

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<img\s[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  text = text.replace(/<img\s[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(parseInt(n)))
    .replace(/&[a-zA-Z]+;/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ══════════════════════════════════════════════════════════════════════
// MCP SERVER
// ══════════════════════════════════════════════════════════════════════

const server = new McpServer({ name: "clawbox", version: "3.0.0" });

// ══════════════════════════════════════════════════════════════════════
// TOOL: bash
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "bash",
  `Execute a shell command on the ClawBox device and return stdout/stderr.

Use for: system tasks, package management, git, process management, piped commands.

IMPORTANT — prefer dedicated tools over bash when available:
- Read files → read_file (not cat/head/tail)
- Write files → write_file (not echo/cat heredoc)
- Edit files → edit_file (not sed/awk)
- Search contents → grep (not grep/rg command)
- Find files → glob (not find/ls)

Commands run from /home/clawbox with a default 30s timeout (max 10min).
Use run_in_background for builds, installs, and servers.

GIT SAFETY:
- Never force-push to main/master
- Prefer new commits over amending
- Never skip hooks (--no-verify) unless explicitly asked
- Stage specific files, not "git add -A" (may include secrets)
- Before destructive ops (reset --hard, checkout --), consider safer alternatives`,
  {
    command: z.string().describe("Shell command to execute"),
    timeout: z.number().optional().describe("Timeout in ms (default 30000, max 600000)"),
    description: z.string().optional().describe("Brief description of what this command does"),
    run_in_background: z.boolean().optional().describe("Run in background, return task ID immediately"),
    cwd: z.string().optional().describe("Working directory (default: /home/clawbox)"),
  },
  async ({ command, timeout, description, run_in_background, cwd }) => {
    const timeoutMs = Math.min(timeout ?? COMMAND_TIMEOUT, MAX_COMMAND_TIMEOUT);
    const workDir = cwd || HOME;

    // Dangerous command detection
    const warnings = detectDangerousCommand(command);
    const warningText = warnings.length ? warnings.join("\n") + "\n\n" : "";

    if (run_in_background) {
      const task = spawnBackground(command, timeoutMs, description || "");
      return {
        content: [{
          type: "text",
          text: `${warningText}Background task started: ${task.id}${description ? ` (${description})` : ""}\nUse task_status with id "${task.id}" to check progress.`,
        }],
      };
    }

    const result = await runShell(command, timeoutMs, workDir);
    const parts: string[] = [];
    if (warningText) parts.push(warningText.trim());
    if (description) parts.push(`[${description}]`);
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    parts.push(`[exit code: ${result.exitCode}]`);
    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: task_status
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "task_status",
  "Check the status and output of a background bash task.",
  { id: z.string().describe("Background task ID (e.g., 'bg-1')") },
  async ({ id }) => {
    const task = bgTasks.get(id);
    if (!task) return { content: [{ type: "text", text: `No background task "${id}".` }], isError: true };
    const elapsed = ((task.completedAt || Date.now()) - task.startedAt) / 1000;
    const parts = [`Task: ${task.id} — ${task.status} (${elapsed.toFixed(1)}s)`, `Command: ${task.command}`];
    if (task.description) parts.push(`Description: ${task.description}`);
    if (task.stdout) parts.push(`[stdout]\n${task.stdout}`);
    if (task.stderr) parts.push(`[stderr]\n${task.stderr}`);
    if (task.exitCode !== null) parts.push(`[exit code: ${task.exitCode}]`);
    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: read_file
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "read_file",
  `Read a file from the filesystem. Returns content with line numbers (cat -n format).

Usage:
- Absolute paths or paths relative to project root (/home/clawbox/clawbox)
- By default reads up to 2000 lines from the start
- Use offset and limit for large files
- Can read images (returns base64) and PDF files (via pdftotext)
- Can read Jupyter notebooks (.ipynb) — returns cells with outputs
- Reads text files only — binary files are rejected
- Always read a file before editing it with edit_file
- Use list_directory for directories (not this tool)`,
  {
    file_path: z.string().describe("Path to file (absolute or relative to /home/clawbox/clawbox)"),
    offset: z.number().optional().describe("Start line (0-indexed, default: 0)"),
    limit: z.number().optional().describe("Max lines to read (default: 2000)"),
  },
  async ({ file_path, offset, limit }) => {
    const absPath = resolvePath(file_path);

    // Blocked device paths
    if (BLOCKED_PATHS.has(absPath) || absPath.startsWith("/dev/") || absPath.startsWith("/proc/self/")) {
      return { content: [{ type: "text", text: `Cannot read device path: ${file_path}` }], isError: true };
    }

    const st = await stat(absPath).catch(() => null);
    if (!st) return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
    if (st.isDirectory()) return { content: [{ type: "text", text: `"${file_path}" is a directory. Use list_directory instead.` }], isError: true };

    // Images → base64
    if (isImageFile(absPath)) {
      const buf = await fsReadFile(absPath);
      const ext = extname(absPath).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml"
        : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
      await recordFileRead(absPath);
      return {
        content: [
          { type: "text", text: `Image: ${file_path} (${buf.length} bytes)` },
          { type: "image", data: buf.toString("base64"), mimeType: mime },
        ],
      };
    }

    // PDF → text via pdftotext
    if (isPdfFile(absPath)) {
      const result = await runShell(`pdftotext ${shellEscape(absPath)} - 2>/dev/null || echo "[pdftotext not available — install poppler-utils]"`, 10_000);
      const text = result.stdout.trim() || "[Could not extract text from PDF]";
      await recordFileRead(absPath);
      const lines = text.split("\n");
      const startLine = offset ?? 0;
      const maxLines = limit ?? DEFAULT_READ_LIMIT;
      const selected = lines.slice(startLine, startLine + maxLines);
      const numbered = selected.map((line: string, i: number) => `${startLine + i + 1}\t${line}`).join("\n");
      return { content: [{ type: "text", text: `[PDF: ${file_path}, ${lines.length} lines extracted]\n${numbered}` }] };
    }

    // Jupyter notebook
    if (isNotebookFile(absPath)) {
      try {
        const raw = await fsReadFile(absPath, "utf-8");
        const nb = JSON.parse(raw);
        const cells: string[] = [];
        for (let ci = 0; ci < (nb.cells || []).length; ci++) {
          const cell = nb.cells[ci];
          const src = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
          const header = `--- Cell ${ci} [${cell.cell_type}] ---`;
          cells.push(header);
          cells.push(src);
          if (cell.outputs?.length) {
            for (const out of cell.outputs) {
              if (out.text) cells.push(`[output] ${Array.isArray(out.text) ? out.text.join("") : out.text}`);
              if (out.data?.["text/plain"]) {
                const t = out.data["text/plain"];
                cells.push(`[output] ${Array.isArray(t) ? t.join("") : t}`);
              }
            }
          }
        }
        await recordFileRead(absPath);
        return { content: [{ type: "text", text: `[Notebook: ${file_path}, ${nb.cells?.length || 0} cells]\n${cells.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Failed to parse notebook: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    // Binary check
    if (isBinaryFile(absPath)) {
      return { content: [{ type: "text", text: `Binary file: ${file_path} (${st.size} bytes). Cannot display binary content.` }] };
    }

    if (st.size > MAX_FILE_SIZE) {
      return { content: [{ type: "text", text: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB). Use offset/limit or bash to read portions.` }], isError: true };
    }

    // Text files — detect encoding
    const buf = await fsReadFile(absPath);
    const { encoding } = detectEncoding(buf);
    const raw = buf.toString(encoding);
    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const startLine = offset ?? 0;
    const maxLines = limit ?? DEFAULT_READ_LIMIT;
    const selectedLines = allLines.slice(startLine, startLine + maxLines);

    const numbered = selectedLines.map((line: string, i: number) => `${startLine + i + 1}\t${line}`).join("\n");
    const truncated = (startLine + maxLines) < totalLines;
    const header = truncated
      ? `[${file_path}: lines ${startLine + 1}-${startLine + selectedLines.length} of ${totalLines}]`
      : `[${file_path}: ${totalLines} lines]`;

    await recordFileRead(absPath);
    return { content: [{ type: "text", text: `${header}\n${numbered}` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: write_file
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "write_file",
  `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.

IMPORTANT:
- Prefer edit_file for modifying existing files (surgical changes, not full rewrites)
- Always read_file first before overwriting to understand current content
- Do not create documentation/README files unless explicitly requested
- File must have been read before overwrite — staleness is checked`,
  {
    file_path: z.string().describe("Path to file (absolute or relative to /home/clawbox/clawbox)"),
    content: z.string().describe("Complete file content to write"),
  },
  async ({ file_path, content }) => {
    const absPath = resolvePath(file_path);

    // Staleness check for existing files
    const existed = await stat(absPath).then(() => true).catch(() => false);
    if (existed) {
      const stale = await checkStaleness(absPath);
      if (stale) return { content: [{ type: "text", text: stale }], isError: true };
    }

    // Read original for diff
    let original: string | null = null;
    if (existed) {
      try { original = await fsReadFile(absPath, "utf-8"); } catch {}
    }

    // Preserve line endings of original file
    if (original) {
      const origEnding = detectLineEnding(original);
      if (origEnding === "\r\n" && !content.includes("\r\n")) {
        content = content.replace(/\n/g, "\r\n");
      }
    }

    await mkdir(dirname(absPath), { recursive: true });
    await fsWriteFile(absPath, content, "utf-8");
    await recordFileRead(absPath);

    const lines = content.split("\n").length;
    const parts = [`${existed ? "Updated" : "Created"}: ${file_path} (${lines} lines, ${content.length} chars)`];

    // Include diff for updates
    if (original !== null) {
      const diff = simpleDiff(original, content, basename(file_path));
      if (diff !== "[no textual diff]") parts.push("\n" + diff);
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: edit_file
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "edit_file",
  `Edit a file by replacing an exact string match. Preferred way to modify existing files — changes only the targeted section.

RULES:
- old_string must match EXACTLY (whitespace, indentation, everything)
- old_string must appear exactly once (unless replace_all is true)
- If not unique, add more surrounding context to make it unique
- Always read_file before editing to see current content
- old_string and new_string must differ
- Staleness is checked — if file changed since your last read, edit is rejected
- Use write_file instead when rewriting most or all of the file`,
  {
    file_path: z.string().describe("Path to file (absolute or relative to /home/clawbox/clawbox)"),
    old_string: z.string().describe("Exact string to find and replace"),
    new_string: z.string().describe("Replacement string"),
    replace_all: z.boolean().optional().describe("Replace all occurrences (default: false)"),
  },
  async ({ file_path, old_string, new_string, replace_all }) => {
    if (old_string === new_string) {
      return { content: [{ type: "text", text: "old_string and new_string are identical." }], isError: true };
    }

    const absPath = resolvePath(file_path);

    // Staleness check
    const stale = await checkStaleness(absPath);
    if (stale) return { content: [{ type: "text", text: stale }], isError: true };

    // Read file with encoding detection
    let buf: Buffer;
    try { buf = await fsReadFile(absPath); }
    catch { return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true }; }

    const { encoding } = detectEncoding(buf);
    const lineEnding = detectLineEnding(buf.toString(encoding));
    let content = buf.toString(encoding);
    const original = content;

    if (!content.includes(old_string)) {
      const trimmed = old_string.trim();
      if (trimmed !== old_string && content.includes(trimmed)) {
        return { content: [{ type: "text", text: `old_string not found exactly. A trimmed version was found — check whitespace/indentation.` }], isError: true };
      }
      return { content: [{ type: "text", text: `old_string not found in ${file_path}. Use read_file to check current content.` }], isError: true };
    }

    let replacements: number;
    if (replace_all) {
      const parts = content.split(old_string);
      replacements = parts.length - 1;
      content = parts.join(new_string);
    } else {
      const first = content.indexOf(old_string);
      const second = content.indexOf(old_string, first + old_string.length);
      if (second !== -1) {
        let count = 0, idx = -1;
        while ((idx = content.indexOf(old_string, idx + 1)) !== -1) count++;
        return { content: [{ type: "text", text: `old_string appears ${count} times in ${file_path}. Add more context for uniqueness, or set replace_all=true.` }], isError: true };
      }
      content = content.replace(old_string, new_string);
      replacements = 1;
    }

    await fsWriteFile(absPath, content, encoding);
    await recordFileRead(absPath);

    // Generate diff
    const diff = simpleDiff(original, content, basename(file_path));
    const parts = [`Edited ${file_path}: ${replacements} replacement${replacements !== 1 ? "s" : ""} applied.`];
    if (diff !== "[no textual diff]") parts.push("\n" + diff);

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: list_directory
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "list_directory",
  "List files and directories at a given path. Returns names, types, and sizes.",
  { path: z.string().optional().describe("Directory path (default: /home/clawbox/clawbox)") },
  async ({ path: dirPath }) => {
    const absPath = resolvePath(dirPath || DEFAULT_CWD);
    const st = await stat(absPath).catch(() => null);
    if (!st || !st.isDirectory()) {
      return { content: [{ type: "text", text: `Not a directory: ${dirPath || DEFAULT_CWD}` }], isError: true };
    }
    const entries = await readdir(absPath, { withFileTypes: true });
    const lines = entries
      .sort((a: any, b: any) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e: any) => `${e.isDirectory() ? "📁 " : "   "}${e.name}${e.isDirectory() ? "/" : ""}`);
    return { content: [{ type: "text", text: `${absPath}/\n${lines.join("\n")}` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: glob
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "glob",
  `Fast file pattern matching. Find files by name using glob syntax.

Examples: "**/*.ts", "src/**/*.tsx", "*.json", "components/**/index.*"

Results are sorted by modification time (newest first).
Use this for finding files by name. For searching file *contents*, use grep.`,
  {
    pattern: z.string().describe('Glob pattern (e.g., "**/*.ts")'),
    path: z.string().optional().describe("Directory to search (default: /home/clawbox/clawbox)"),
  },
  async ({ pattern, path: searchPath }) => {
    const dir = resolvePath(searchPath || DEFAULT_CWD);

    const hasSlash = pattern.includes("/");
    const findArg = hasSlash ? `-path ${shellEscape(`*/${pattern}`)}` : `-name ${shellEscape(pattern)}`;
    const cmd = `find ${shellEscape(dir)} -type f ${findArg} 2>/dev/null | head -${GLOB_RESULT_LIMIT * 2}`;
    const result = await runShell(cmd, 10_000, dir);

    if (!result.stdout.trim()) {
      const ext = extname(pattern);
      let suggestion = "";
      if (ext && !hasSlash) {
        const altResult = await runShell(`find ${shellEscape(dir)} -type f -name ${shellEscape("*" + ext)} 2>/dev/null | head -5`, 5_000, dir);
        if (altResult.stdout.trim()) {
          const examples = altResult.stdout.trim().split("\n").slice(0, 3).map((f: string) => relative(dir, f));
          suggestion = `\n\nSimilar files with ${ext} extension:\n  ${examples.join("\n  ")}`;
        }
      }
      return { content: [{ type: "text", text: `No files match "${pattern}" in ${dir}${suggestion}` }] };
    }

    // Sort by mtime (newest first) and limit — use printf to safely pass filenames
    const sortCmd = `printf '%s\\0' ${result.stdout.trim().split("\n").map(shellEscape).join(" ")} | xargs -0 ls -t 2>/dev/null | head -${GLOB_RESULT_LIMIT}`;
    const sorted = await runShell(sortCmd, 5_000, dir);
    const raw = sorted.exitCode === 0 && sorted.stdout.trim() ? sorted.stdout : result.stdout;

    const files = raw.trim().split("\n").filter(Boolean)
      .slice(0, GLOB_RESULT_LIMIT)
      .map((f: string) => relative(dir, f)).filter(Boolean);
    const truncated = files.length >= GLOB_RESULT_LIMIT;
    return {
      content: [{
        type: "text",
        text: `${files.length}${truncated ? "+" : ""} file${files.length !== 1 ? "s" : ""} matched:\n${files.join("\n")}${truncated ? "\n[results truncated]" : ""}`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: grep
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "grep",
  `Search file contents for a text pattern. Uses ripgrep (rg) or grep.

IMPORTANT: Always use this tool — never run grep/rg as a bash command.

Output modes:
- "content" (default) — matching lines with file:line: prefix
- "files_with_matches" — only file paths containing matches
- "count" — match count per file

Supports regex, context lines, case-insensitive, multiline, file type filtering.`,
  {
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("File or directory (default: project root)"),
    include: z.string().optional().describe('Glob filter (e.g., "*.ts", "*.{js,jsx}")'),
    type: z.string().optional().describe("File type filter (js, py, ts, rust, go, java, etc.) — more efficient than include"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("Output format (default: content)"),
    before_context: z.number().optional().describe("Lines before each match (-B)"),
    after_context: z.number().optional().describe("Lines after each match (-A)"),
    context: z.number().optional().describe("Lines before AND after each match (-C)"),
    case_sensitive: z.boolean().optional().describe("Case-sensitive (default: true)"),
    max_results: z.number().optional().describe(`Max output lines (default: ${GREP_RESULT_LIMIT})`),
    offset: z.number().optional().describe("Skip first N results before applying limit"),
    multiline: z.boolean().optional().describe("Enable multiline (dot matches newlines)"),
  },
  async ({ pattern, path: searchPath, include, type: fileType, output_mode, before_context, after_context, context, case_sensitive, max_results, offset, multiline }) => {
    const dir = resolvePath(searchPath || DEFAULT_CWD);
    const limit = max_results ?? GREP_RESULT_LIMIT;
    const skip = offset ?? 0;
    const mode = output_mode || "content";

    const hasRg = (await runShell("which rg 2>/dev/null", 3000)).exitCode === 0;
    let cmd: string;

    if (hasRg) {
      const args = ["rg", "--no-heading", "--with-filename"];
      if (mode === "files_with_matches") args.push("-l");
      else if (mode === "count") args.push("-c");
      else args.push("-n");
      if (case_sensitive === false) args.push("-i");
      if (context && mode === "content") args.push(`-C${context}`);
      if (before_context && mode === "content") args.push(`-B${before_context}`);
      if (after_context && mode === "content") args.push(`-A${after_context}`);
      if (include) args.push("--glob", include);
      if (fileType) args.push("--type", fileType);
      if (multiline) args.push("-U", "--multiline-dotall");
      args.push("--", pattern, dir);
      cmd = args.map(shellEscape).join(" ");
    } else {
      const args = ["grep", "-rn"];
      if (mode === "files_with_matches") args.push("-l");
      else if (mode === "count") args.push("-c");
      if (case_sensitive === false) args.push("-i");
      if (context && mode === "content") args.push(`-C${context}`);
      if (before_context && mode === "content") args.push(`-B${before_context}`);
      if (after_context && mode === "content") args.push(`-A${after_context}`);
      if (include) args.push(`--include=${include}`);
      if (multiline) args.push("-Pz");
      args.push("-e", pattern, dir);
      cmd = args.map(shellEscape).join(" ");
    }

    cmd += ` 2>/dev/null`;
    if (skip > 0) cmd += ` | tail -n +${skip + 1}`;
    cmd += ` | head -${limit}`;

    const result = await runShell(cmd, 15_000, dir);

    if (!result.stdout.trim()) {
      return { content: [{ type: "text", text: `No matches for "${pattern}" in ${dir}` }] };
    }

    // Relativize paths
    let output = result.stdout;
    if (dir !== "/") {
      const prefix = dir + "/";
      output = output.split("\n").map((line: string) => line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n");
    }

    const lines = output.trim().split("\n");
    const truncated = lines.length >= limit;
    const meta: string[] = [];
    if (skip > 0) meta.push(`offset: ${skip}`);
    if (truncated) meta.push("truncated");

    return {
      content: [{
        type: "text",
        text: `${lines.length}${truncated ? "+" : ""} result${lines.length !== 1 ? "s" : ""}${meta.length ? ` (${meta.join(", ")})` : ""}:\n${output.trim()}`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: web_fetch
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "web_fetch",
  `Fetch a URL and return the page content as readable text/markdown.

Use for: documentation, API responses, GitHub files/issues, web content.
HTML is auto-converted to readable text. JSON is auto-formatted.
Results are cached for 15 minutes.
If the URL redirects to a different host, a warning is shown.`,
  {
    url: z.string().describe("URL to fetch (http/https)"),
    max_length: z.number().optional().describe("Max response chars (default: 50000)"),
    headers: z.string().optional().describe('HTTP headers as JSON string (e.g., \'{"Authorization":"Bearer ..."}\''),
  },
  async ({ url, max_length, headers }) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { content: [{ type: "text", text: "URL must start with http:// or https://" }], isError: true };
    }

    const maxLen = max_length ?? 50_000;
    evictStaleWebCache();

    const cached = webCache.get(url);
    if (cached && (Date.now() - cached.fetchedAt) < WEB_CACHE_TTL) {
      let body = cached.contentType.includes("json")
        ? cached.body : cached.contentType.includes("html") ? htmlToText(cached.body) : cached.body;
      if (body.length > maxLen) body = body.slice(0, maxLen) + `\n[truncated — ${body.length} chars total]`;
      return { content: [{ type: "text", text: `[${cached.status} cached] ${url}\n\n${body}` }] };
    }

    try {
      const extraHeaders = headers ? JSON.parse(headers) : {};
      const originalHost = new URL(url).hostname;

      const res = await fetch(url, {
        headers: { "User-Agent": "ClawBox/3.0 (MCP Agent)", "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*", ...extraHeaders },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        return { content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}: ${url}` }], isError: true };
      }

      // Detect redirect to different host
      const finalHost = new URL(res.url).hostname;
      const redirectWarning = finalHost !== originalHost ? `\n⚠ Redirected to different host: ${finalHost}\n` : "";

      const contentType = res.headers.get("content-type") || "";
      const rawBody = await res.text();

      // Cache the raw result
      webCache.set(url, { body: rawBody, contentType, status: res.status, fetchedAt: Date.now() });

      let body: string;
      if (contentType.includes("json")) {
        try { body = JSON.stringify(JSON.parse(rawBody), null, 2); } catch { body = rawBody; }
      } else if (contentType.includes("html")) {
        body = htmlToText(rawBody);
      } else {
        body = rawBody;
      }

      if (body.length > maxLen) body = body.slice(0, maxLen) + `\n[truncated — ${body.length} chars total]`;

      return { content: [{ type: "text", text: `[${res.status}] ${url}${redirectWarning}\n\n${body}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: web_search
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "web_search",
  `Search the web and return results with titles, URLs, and snippets.
After searching, use web_fetch to read specific pages in full.`,
  {
    query: z.string().describe("Search query (min 2 chars)"),
    max_results: z.number().optional().describe("Number of results (default: 10)"),
    allowed_domains: z.string().optional().describe("Comma-separated allowed domains (e.g., 'github.com,docs.python.org')"),
    blocked_domains: z.string().optional().describe("Comma-separated blocked domains"),
  },
  async ({ query, max_results, allowed_domains, blocked_domains }) => {
    const limit = max_results ?? 10;
    try {
      const params = new URLSearchParams({ q: query });
      const res = await fetch(`https://lite.duckduckgo.com/lite/?${params}`, {
        headers: { "User-Agent": "ClawBox/3.0 (MCP Agent)", "Accept": "text/html" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { content: [{ type: "text", text: `Search failed: HTTP ${res.status}` }], isError: true };

      const html = await res.text();
      const results: { title: string; url: string; snippet: string }[] = [];
      const linkRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

      const links: { url: string; title: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) !== null) {
        links.push({ url: m[1].replace(/&amp;/g, "&"), title: m[2].replace(/<[^>]+>/g, "").trim() });
      }
      const snippets: string[] = [];
      while ((m = snippetRe.exec(html)) !== null) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim());
      }

      // Domain filtering
      const allowed = allowed_domains ? allowed_domains.split(",").map((d: string) => d.trim().toLowerCase()) : null;
      const blocked = blocked_domains ? blocked_domains.split(",").map((d: string) => d.trim().toLowerCase()) : null;

      for (let i = 0; i < links.length && results.length < limit; i++) {
        const { url, title } = links[i];
        try {
          const host = new URL(url).hostname.toLowerCase();
          if (allowed && !allowed.some((d: string) => host.includes(d))) continue;
          if (blocked && blocked.some((d: string) => host.includes(d))) continue;
        } catch { continue; }
        results.push({ title, url, snippet: snippets[i] || "" });
      }

      // Fallback
      if (results.length === 0) {
        const anyLinkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((m = anyLinkRe.exec(html)) !== null && results.length < limit) {
          const href = m[1]; const text = m[2].replace(/<[^>]+>/g, "").trim();
          if (!text || href.includes("duckduckgo.com") || text.length < 5) continue;
          try {
            const host = new URL(href).hostname.toLowerCase();
            if (allowed && !allowed.some((d: string) => host.includes(d))) continue;
            if (blocked && blocked.some((d: string) => host.includes(d))) continue;
          } catch { continue; }
          results.push({ title: text, url: href, snippet: "" });
        }
      }

      if (!results.length) return { content: [{ type: "text", text: `No results for "${query}".` }] };

      const formatted = results.map((r: { title: string; url: string; snippet: string }, i: number) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`
      ).join("\n\n");
      return { content: [{ type: "text", text: `Search: "${query}"\n\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: notebook_edit
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "notebook_edit",
  `Edit Jupyter notebook (.ipynb) cells. Supports replacing cell content, inserting new cells, and deleting cells.

Modes:
- "replace" (default): Replace a cell's source code
- "insert": Insert a new cell after the specified cell
- "delete": Delete a cell

Use read_file first to see the notebook cells and their indices.`,
  {
    notebook_path: z.string().describe("Path to .ipynb file"),
    cell_index: z.number().describe("0-based index of the cell to edit/insert after/delete"),
    new_source: z.string().optional().describe("New cell source (required for replace/insert)"),
    cell_type: z.enum(["code", "markdown"]).optional().describe("Cell type for insert (default: code)"),
    edit_mode: z.enum(["replace", "insert", "delete"]).optional().describe("Edit mode (default: replace)"),
  },
  async ({ notebook_path, cell_index, new_source, cell_type, edit_mode }) => {
    const mode = edit_mode || "replace";
    const absPath = resolvePath(notebook_path);

    if (!isNotebookFile(absPath)) {
      return { content: [{ type: "text", text: "File must be a .ipynb notebook." }], isError: true };
    }

    let raw: string;
    try { raw = await fsReadFile(absPath, "utf-8"); }
    catch { return { content: [{ type: "text", text: `File not found: ${notebook_path}` }], isError: true }; }

    const nb = JSON.parse(raw);
    if (!nb.cells || !Array.isArray(nb.cells)) {
      return { content: [{ type: "text", text: "Invalid notebook: no cells array." }], isError: true };
    }

    if (cell_index < 0 || cell_index >= nb.cells.length) {
      return { content: [{ type: "text", text: `Cell index ${cell_index} out of range (0-${nb.cells.length - 1}).` }], isError: true };
    }

    if (mode === "replace") {
      if (new_source === undefined) return { content: [{ type: "text", text: "new_source required for replace mode." }], isError: true };
      nb.cells[cell_index].source = new_source.split("\n").map((l: string, i: number, a: string[]) => i < a.length - 1 ? l + "\n" : l);
      nb.cells[cell_index].outputs = [];
      nb.cells[cell_index].execution_count = null;
    } else if (mode === "insert") {
      if (new_source === undefined) return { content: [{ type: "text", text: "new_source required for insert mode." }], isError: true };
      const newCell = {
        cell_type: cell_type || "code",
        source: new_source.split("\n").map((l: string, i: number, a: string[]) => i < a.length - 1 ? l + "\n" : l),
        metadata: {},
        ...(cell_type !== "markdown" ? { outputs: [], execution_count: null } : {}),
      };
      nb.cells.splice(cell_index + 1, 0, newCell);
    } else if (mode === "delete") {
      nb.cells.splice(cell_index, 1);
    }

    await fsWriteFile(absPath, JSON.stringify(nb, null, 1), "utf-8");
    await recordFileRead(absPath);

    const action = mode === "replace" ? `Replaced cell ${cell_index}` : mode === "insert" ? `Inserted cell after ${cell_index}` : `Deleted cell ${cell_index}`;
    return { content: [{ type: "text", text: `${action} in ${notebook_path} (${nb.cells.length} cells total).` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TOOL: agent (sub-agent delegation)
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "agent",
  `Spawn a background sub-agent that executes a sequence of shell commands autonomously.

Use this to delegate multi-step work that can run independently:
- Build processes (install deps → build → test)
- Data processing pipelines
- System maintenance tasks
- Parallel workstreams

Each command runs sequentially. If any command fails, the remaining commands are skipped.
Returns a task ID — check progress with task_status.`,
  {
    description: z.string().describe("Brief description of what this agent will do"),
    commands: z.string().describe("Shell commands to execute, separated by newlines. Each runs sequentially."),
    cwd: z.string().optional().describe("Working directory for all commands (default: /home/clawbox)"),
  },
  async ({ description, commands, cwd }) => {
    const workDir = cwd || HOME;
    // Chain commands with && so failure stops execution, wrap in a subshell
    const chainedCmd = commands.split("\n").filter((c: string) => c.trim()).map((c: string) => c.trim()).join(" && ");
    const wrappedCmd = `cd ${JSON.stringify(workDir)} && ${chainedCmd}`;
    const task = spawnBackground(wrappedCmd, MAX_COMMAND_TIMEOUT, description);
    return {
      content: [{
        type: "text",
        text: `Agent started: ${task.id}\nDescription: ${description}\nCommands: ${commands.split("\n").filter((c: string) => c.trim()).length} steps\nUse task_status("${task.id}") to check progress.`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════
// TASK MANAGEMENT (full-featured)
// ══════════════════════════════════════════════════════════════════════

server.tool(
  "task_create",
  `Create a task to track progress on multi-step work.

Use for complex tasks requiring 3+ steps. Break work into discrete tasks, mark each completed as you go.
Tasks can have dependencies (blockedBy) — a blocked task cannot start until its dependencies complete.`,
  {
    subject: z.string().describe("Brief actionable title (e.g., 'Create login component')"),
    description: z.string().optional().describe("Details about what needs to be done"),
    active_form: z.string().optional().describe("Present continuous form for spinner (e.g., 'Creating login component')"),
    owner: z.string().optional().describe("Owner/assignee name"),
    blocked_by: z.string().optional().describe("Comma-separated task IDs this task depends on (e.g., 'task-1,task-2')"),
    metadata: z.string().optional().describe("JSON string of arbitrary metadata"),
  },
  async ({ subject, description, active_form, owner, blocked_by, metadata }) => {
    const id = `task-${++userTaskSeq}`;
    const now = new Date().toISOString();
    const blockedByList = blocked_by ? blocked_by.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
    const meta = metadata ? JSON.parse(metadata) : {};
    const task: UserTask = {
      id, subject, description: description || "",
      status: "pending", owner: owner || "", activeForm: active_form || "",
      metadata: meta, blockedBy: blockedByList, blocks: [],
      createdAt: now, updatedAt: now,
    };
    // Set up reverse blocks
    for (const depId of blockedByList) {
      const dep = userTasks.get(depId);
      if (dep && !dep.blocks.includes(id)) dep.blocks.push(id);
    }
    userTasks.set(id, task);
    return { content: [{ type: "text", text: `Created ${id}: ${subject}${blockedByList.length ? ` (blocked by: ${blockedByList.join(", ")})` : ""}` }] };
  }
);

server.tool(
  "task_update",
  `Update a task's status, details, or dependencies.

Status workflow: pending → in_progress → completed (or deleted).
When completing a task, any tasks it blocks become unblocked.`,
  {
    task_id: z.string().describe("Task ID (e.g., 'task-1')"),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional().describe("New status"),
    subject: z.string().optional().describe("Updated title"),
    description: z.string().optional().describe("Updated description"),
    active_form: z.string().optional().describe("Updated spinner text"),
    owner: z.string().optional().describe("Updated owner"),
    add_blocked_by: z.string().optional().describe("Comma-separated task IDs to add as dependencies"),
    metadata: z.string().optional().describe("JSON string of metadata to merge (set key to null to delete)"),
  },
  async ({ task_id, status, subject, description, active_form, owner, add_blocked_by, metadata }) => {
    const task = userTasks.get(task_id);
    if (!task) return { content: [{ type: "text", text: `Task not found: ${task_id}` }], isError: true };

    if (status === "deleted") {
      // Remove from other tasks' blockedBy lists
      for (const t of userTasks.values()) {
        t.blockedBy = t.blockedBy.filter((id: string) => id !== task_id);
      }
      userTasks.delete(task_id);
      return { content: [{ type: "text", text: `Deleted ${task_id}.` }] };
    }

    const oldStatus = task.status;
    if (status) task.status = status;
    if (subject) task.subject = subject;
    if (description !== undefined) task.description = description;
    if (active_form) task.activeForm = active_form;
    if (owner !== undefined) task.owner = owner;
    if (add_blocked_by) {
      const newDeps = add_blocked_by.split(",").map((s: string) => s.trim()).filter(Boolean);
      for (const depId of newDeps) {
        if (!task.blockedBy.includes(depId)) task.blockedBy.push(depId);
        const dep = userTasks.get(depId);
        if (dep && !dep.blocks.includes(task_id)) dep.blocks.push(task_id);
      }
    }
    if (metadata) {
      const m = JSON.parse(metadata);
      for (const [k, v] of Object.entries(m)) {
        if (v === null) delete task.metadata[k];
        else task.metadata[k] = v;
      }
    }
    task.updatedAt = new Date().toISOString();

    // When completing, remove from dependents' blockedBy
    if (status === "completed" && oldStatus !== "completed") {
      for (const blockedId of task.blocks) {
        const blocked = userTasks.get(blockedId);
        if (blocked) blocked.blockedBy = blocked.blockedBy.filter((id: string) => id !== task_id);
      }
    }

    return { content: [{ type: "text", text: `Updated ${task_id}: ${task.status} — ${task.subject}` }] };
  }
);

server.tool(
  "task_get",
  "Get full details of a specific task including description, dependencies, and metadata.",
  { task_id: z.string().describe("Task ID") },
  async ({ task_id }) => {
    // Check user tasks
    const task = userTasks.get(task_id);
    if (task) {
      const lines = [
        `${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
        task.description ? `Description: ${task.description}` : "",
        task.owner ? `Owner: ${task.owner}` : "",
        task.activeForm ? `Active form: ${task.activeForm}` : "",
        task.blockedBy.length ? `Blocked by: ${task.blockedBy.join(", ")}` : "",
        task.blocks.length ? `Blocks: ${task.blocks.join(", ")}` : "",
        Object.keys(task.metadata).length ? `Metadata: ${JSON.stringify(task.metadata)}` : "",
        `Created: ${task.createdAt}`,
        `Updated: ${task.updatedAt}`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    // Check background tasks
    const bg = bgTasks.get(task_id);
    if (bg) {
      const elapsed = ((bg.completedAt || Date.now()) - bg.startedAt) / 1000;
      const lines = [
        `${bg.id}: ${bg.description || bg.command.slice(0, 80)}`,
        `Status: ${bg.status} (${elapsed.toFixed(1)}s)`,
        `Command: ${bg.command}`,
        bg.stdout ? `Stdout: ${bg.stdout.length} chars` : "",
        bg.exitCode !== null ? `Exit code: ${bg.exitCode}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    return { content: [{ type: "text", text: `Task not found: ${task_id}` }], isError: true };
  }
);

server.tool(
  "task_list",
  `List all tasks. Shows user tasks and background tasks with status.

Prefer working on tasks in ID order (lowest first). Blocked tasks cannot start until dependencies resolve.`,
  async () => {
    const items: string[] = [];

    for (const t of userTasks.values()) {
      if (t.status === "deleted") continue;
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
      const blocked = t.blockedBy.length ? ` [blocked by: ${t.blockedBy.join(",")}]` : "";
      const own = t.owner ? ` @${t.owner}` : "";
      items.push(`${icon} [${t.id}] ${t.subject} (${t.status})${own}${blocked}`);
    }

    for (const t of bgTasks.values()) {
      const icon = t.status === "completed" ? "✓" : t.status === "running" ? "⟳" : "✗";
      const desc = t.description || t.command.slice(0, 60);
      items.push(`${icon} [${t.id}] ${desc}${desc.length < t.command.length && !t.description ? "..." : ""} (${t.status})`);
    }

    if (!items.length) return { content: [{ type: "text", text: "No tasks." }] };
    return { content: [{ type: "text", text: `Tasks:\n${items.join("\n")}` }] };
  }
);

server.tool(
  "task_stop",
  "Stop a running background task by killing its process.",
  { task_id: z.string().describe("Background task ID (e.g., 'bg-1')") },
  async ({ task_id }) => {
    const task = bgTasks.get(task_id);
    if (!task) return { content: [{ type: "text", text: `Task not found: ${task_id}` }], isError: true };
    if (task.status !== "running") return { content: [{ type: "text", text: `Task ${task_id} is not running (${task.status}).` }] };
    if (task.process) {
      task.process.kill("SIGTERM");
      task.status = "failed";
      task.completedAt = Date.now();
      task.stderr += "\n[killed by task_stop]";
    }
    return { content: [{ type: "text", text: `Stopped ${task_id}.` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// CLAWBOX SYSTEM TOOLS
// ══════════════════════════════════════════════════════════════════════

server.tool("system_stats", "Get comprehensive system statistics: CPU, memory, disk, network, temperature, GPU, top processes", async () => {
  const stats = await api("/setup-api/system/stats");
  return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
});

server.tool("system_info", "Get basic system info: hostname, CPU, memory, temperature, disk", async () => {
  const info = await api("/setup-api/system/info");
  return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
});

server.tool("system_power", "Restart or shut down the ClawBox device",
  { action: z.enum(["restart", "shutdown"]).describe("Power action") },
  async ({ action }) => {
    await apiPost("/setup-api/system/power", { action });
    return { content: [{ type: "text", text: `Power action '${action}' initiated.` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// BROWSER AUTOMATION
// ══════════════════════════════════════════════════════════════════════

type ContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function browserResult(text: string, result: { screenshot?: string }): { content: ContentPart[] } {
  const parts: ContentPart[] = [{ type: "text", text }];
  if (result.screenshot) parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
  return { content: parts };
}

server.tool("browser_launch", "Launch headless Chromium and optionally navigate. Returns screenshot.",
  { url: z.string().optional().describe("URL to navigate to") },
  async ({ url }) => {
    const result = await apiPost("/setup-api/browser", { action: "launch", ...(url ? { url } : {}) });
    return browserResult(`Browser launched.${url ? ` Navigated to: ${url}` : ""}`, result);
  }
);

server.tool("browser_navigate", "Navigate browser to URL. Returns screenshot.",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    const result = await apiPost("/setup-api/browser", { action: "navigate", url });
    return browserResult(`Navigated to: ${url}`, result);
  }
);

server.tool("browser_click", "Click at coordinates in browser.",
  { x: z.number().describe("X"), y: z.number().describe("Y"), button: z.enum(["left", "right", "middle"]).optional().describe("Button (default: left)") },
  async ({ x, y, button }) => {
    const result = await apiPost("/setup-api/browser", { action: "click", x, y, ...(button ? { button } : {}) });
    return browserResult(`Clicked (${x}, ${y})`, result);
  }
);

server.tool("browser_type", "Type text into focused browser element.",
  { text: z.string().describe("Text to type") },
  async ({ text }) => {
    const result = await apiPost("/setup-api/browser", { action: "type", text });
    return browserResult(`Typed: "${text}"`, result);
  }
);

server.tool("browser_keypress", "Press a key in browser (Enter, Tab, Escape, etc.).",
  { key: z.string().describe("Key name") },
  async ({ key }) => {
    const result = await apiPost("/setup-api/browser", { action: "keydown", key });
    return browserResult(`Pressed: ${key}`, result);
  }
);

server.tool("browser_scroll", "Scroll the browser page.",
  { x: z.number().describe("X"), y: z.number().describe("Y"), deltaX: z.number().optional().describe("Horizontal"), deltaY: z.number().describe("Vertical (positive=down)") },
  async ({ x, y, deltaX, deltaY }) => {
    const result = await apiPost("/setup-api/browser", { action: "scroll", x, y, ...(deltaX !== undefined ? { deltaX } : {}), deltaY });
    return browserResult(`Scrolled (${x},${y}) by ${deltaY}px`, result);
  }
);

server.tool("browser_screenshot", "Take a screenshot of current browser page.", async () => {
  const result = await apiPost("/setup-api/browser", { action: "screenshot" });
  return browserResult("Screenshot captured.", result);
});

server.tool("browser_close", "Close the browser session.", async () => {
  await apiPost("/setup-api/browser", { action: "close" });
  return { content: [{ type: "text", text: "Browser closed." }] };
});

// ══════════════════════════════════════════════════════════════════════
// APP STORE
// ══════════════════════════════════════════════════════════════════════

server.tool("app_search", "Search the ClawBox app store",
  { query: z.string().optional().describe("Search query"), category: z.string().optional().describe("Category"), limit: z.number().optional().describe("Max results") },
  async ({ query, category, limit }) => {
    const p = new URLSearchParams();
    if (query) p.set("q", query); if (category) p.set("category", category); if (limit) p.set("limit", String(limit));
    return { content: [{ type: "text", text: JSON.stringify(await api(`/setup-api/apps/store?${p}`), null, 2) }] };
  }
);

server.tool("app_install", "Install an app from the ClawBox store",
  { appId: z.string().describe("App ID") },
  async ({ appId }) => { await apiPost("/setup-api/apps/install", { appId }); return { content: [{ type: "text", text: `App '${appId}' installed.` }] }; }
);

server.tool("app_uninstall", "Uninstall an app from ClawBox",
  { appId: z.string().describe("App ID") },
  async ({ appId }) => { await apiPost("/setup-api/apps/uninstall", { appId }); return { content: [{ type: "text", text: `App '${appId}' uninstalled.` }] }; }
);

// ══════════════════════════════════════════════════════════════════════
// NETWORK
// ══════════════════════════════════════════════════════════════════════

server.tool("wifi_scan", "Scan for WiFi networks", async () => {
  return { content: [{ type: "text", text: JSON.stringify((await api("/setup-api/wifi/scan")).networks, null, 2) }] };
});
server.tool("wifi_status", "Get WiFi connection status", async () => {
  return { content: [{ type: "text", text: JSON.stringify(await api("/setup-api/wifi/status"), null, 2) }] };
});
server.tool("vnc_status", "Check VNC server status", async () => {
  return { content: [{ type: "text", text: JSON.stringify(await api("/setup-api/vnc"), null, 2) }] };
});

// ══════════════════════════════════════════════════════════════════════
// PREFERENCES
// ══════════════════════════════════════════════════════════════════════

server.tool("preferences_get", "Get ClawBox user preferences",
  { keys: z.string().optional().describe("Comma-separated keys (omit for all)") },
  async ({ keys }) => {
    return { content: [{ type: "text", text: JSON.stringify(await api(`/setup-api/preferences${keys ? `?keys=${encodeURIComponent(keys)}` : ""}`), null, 2) }] };
  }
);

server.tool("preferences_set", "Set ClawBox user preferences",
  { preferences: z.string().describe("JSON string of key-value pairs") },
  async ({ preferences }) => {
    const parsed = JSON.parse(preferences);
    await apiPost("/setup-api/preferences", parsed);
    return { content: [{ type: "text", text: `Preferences updated: ${Object.keys(parsed).join(", ")}` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// DESKTOP UI
// ══════════════════════════════════════════════════════════════════════

const AVAILABLE_APPS = [
  { id: "settings", name: "Settings", description: "Device settings" },
  { id: "openclaw", name: "OpenClaw", description: "AI chat" },
  { id: "terminal", name: "Terminal", description: "Shell" },
  { id: "files", name: "Files", description: "File manager" },
  { id: "store", name: "Store", description: "App store" },
  { id: "browser", name: "Browser", description: "Web browser" },
  { id: "vnc", name: "Remote Desktop", description: "VNC viewer" },
  { id: "vscode", name: "VS Code", description: "Code editor" },
];

server.tool("ui_open_app", "Open an app on the ClawBox desktop",
  { appId: z.string().describe("App ID") },
  async ({ appId }) => {
    await apiPost("/setup-api/kv", { key: "ui:pending-action", value: JSON.stringify({ type: "open_app", appId, ts: Date.now() }) });
    return { content: [{ type: "text", text: `Opening ${AVAILABLE_APPS.find(a => a.id === appId)?.name ?? appId}.` }] };
  }
);

server.tool("ui_list_apps", "List apps available on the ClawBox desktop", async () => {
  let installed: { id: string; name: string }[] = [];
  try {
    const r = await runShell("ls /home/clawbox/.openclaw/skills/ 2>/dev/null");
    if (r.exitCode === 0) installed = r.stdout.trim().split("\n").filter(Boolean).map((n: string) => ({ id: `installed-${n}`, name: n }));
  } catch {}
  const all = [...AVAILABLE_APPS.map(a => `${a.id} — ${a.name}: ${a.description}`), ...installed.map(a => `${a.id} — ${a.name} (installed)`)];
  return { content: [{ type: "text", text: `Apps:\n${all.join("\n")}` }] };
});

server.tool("ui_notify", "Show a notification on the ClawBox desktop",
  { message: z.string().describe("Message") },
  async ({ message }) => {
    await apiPost("/setup-api/kv", { key: "ui:pending-action", value: JSON.stringify({ type: "notify", message, ts: Date.now() }) });
    return { content: [{ type: "text", text: `Notification: "${message}"` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// WEBAPP CREATION
// ══════════════════════════════════════════════════════════════════════

server.tool("webapp_create",
  `Create a single-file web app on the ClawBox desktop. For multi-file apps, use code_project_* instead.
Write complete standalone HTML with inline CSS/JS. Dark theme: bg #1a1a2e, text #e0e0e0, accent #f97316. No CDN links.`,
  {
    appId: z.string().describe("Unique app ID (lowercase, hyphens)"),
    name: z.string().describe("Display name"),
    html: z.string().describe("Complete HTML with inline CSS/JS"),
    color: z.string().optional().describe("Icon color hex (default: #f97316)"),
    openAfterCreate: z.boolean().optional().describe("Open immediately (default: true)"),
  },
  async ({ appId, name, html, color, openAfterCreate }) => {
    const saveResult = await apiPost("/setup-api/webapps", { appId, html, name, color: color || "#f97316" });
    const url = (saveResult as { url?: string }).url || `/setup-api/webapps?app=${appId}`;
    await apiPost("/setup-api/kv", { key: "ui:pending-action", value: JSON.stringify({ type: "register_webapp", appId, name, color: color || "#f97316", url, ts: Date.now() }) });
    if (openAfterCreate !== false) {
      await new Promise(r => setTimeout(r, UI_PICKUP_DELAY_MS));
      await apiPost("/setup-api/kv", { key: "ui:pending-action", value: JSON.stringify({ type: "open_app", appId: `installed-${appId}`, ts: Date.now() }) });
    }
    return { content: [{ type: "text", text: `Created "${name}" (${appId}).${openAfterCreate !== false ? " Opening..." : ""}` }] };
  }
);

server.tool("webapp_update", "Update an existing webapp's HTML.",
  { appId: z.string().describe("App ID"), html: z.string().describe("Updated HTML") },
  async ({ appId, html }) => {
    await apiPost("/setup-api/webapps", { appId, html });
    return { content: [{ type: "text", text: `Webapp "${appId}" updated.` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// CODE PROJECTS
// ══════════════════════════════════════════════════════════════════════

async function codeApi(action: string, body: Record<string, unknown> = {}) {
  return apiPost("/setup-api/code", { action, ...body });
}

server.tool("code_project_init",
  `Create a new code project for building a ClawBox webapp.
1. Init → scaffolds index.html + style.css + app.js
2. Use read_file/write_file/edit_file on files in data/code-projects/<id>/
3. Use code_project_build to bundle and deploy

Templates: "app" (default, multi-file) or "blank" (single index.html)`,
  {
    projectId: z.string().describe("Unique ID (lowercase, hyphens)"),
    name: z.string().describe("Display name"),
    template: z.enum(["app", "blank"]).optional().describe("Template (default: app)"),
    color: z.string().optional().describe("Icon color (default: #f97316)"),
    description: z.string().optional().describe("Description"),
  },
  async ({ projectId, name, template, color, description }) => {
    await codeApi("init", { projectId, name, template, color, description });
    const files = await codeApi("file-list", { projectId }) as { files: { name: string; type: string }[] };
    const list = files.files.map((f: { name: string; type: string }) => `  ${f.type === "directory" ? "📁" : "📄"} ${f.name}`).join("\n");
    return { content: [{ type: "text", text: `Project "${name}" (${projectId}) created.\n\nFiles:\n${list}\n\nPath: data/code-projects/${projectId}/` }] };
  }
);

server.tool("code_project_list", "List all code projects.", async () => {
  const data = await codeApi("list-projects") as { projects: { projectId: string; name: string; updated: string }[] };
  if (!data.projects.length) return { content: [{ type: "text", text: "No projects." }] };
  return { content: [{ type: "text", text: `Projects:\n${data.projects.map((p: any) => `${p.projectId} — ${p.name} (${new Date(p.updated).toLocaleDateString()})`).join("\n")}` }] };
});

server.tool("code_project_build",
  `Build and deploy a code project. Inlines CSS/JS into index.html, deploys to desktop, opens the app.`,
  {
    projectId: z.string().describe("Project ID"),
    name: z.string().optional().describe("Override name"),
    color: z.string().optional().describe("Override color"),
    openAfterBuild: z.boolean().optional().describe("Open after build (default: true)"),
  },
  async ({ projectId, name, color, openAfterBuild }) => {
    let meta = { name: name || projectId, color: color || "#f97316" };
    try {
      const proj = await codeApi("get-project", { projectId }) as { project: { name: string; color: string } };
      if (!name) meta.name = proj.project.name;
      if (!color) meta.color = proj.project.color;
    } catch {}
    const data = await codeApi("build", { projectId, name: meta.name, color: meta.color }) as { url: string; filesInlined: number };
    await apiPost("/setup-api/kv", { key: "ui:pending-action", value: JSON.stringify({ type: "register_webapp", appId: projectId, name: meta.name, color: meta.color, url: data.url, ts: Date.now() }) });
    if (openAfterBuild !== false) {
      await new Promise(r => setTimeout(r, UI_PICKUP_DELAY_MS));
      await apiPost("/setup-api/kv", { key: "ui:pending-action", value: JSON.stringify({ type: "open_app", appId: `installed-${projectId}`, ts: Date.now() }) });
    }
    return { content: [{ type: "text", text: `Built "${meta.name}" — ${data.filesInlined} file${data.filesInlined !== 1 ? "s" : ""} inlined.${openAfterBuild !== false ? " Opening..." : ""}` }] };
  }
);

server.tool("code_project_delete", "Delete a code project source files.",
  { projectId: z.string().describe("Project ID") },
  async ({ projectId }) => {
    await codeApi("delete-project", { projectId });
    return { content: [{ type: "text", text: `Project "${projectId}" deleted.` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[clawbox-mcp] Server v3.0.0 started on stdio");
}

main().catch((err) => {
  console.error("[clawbox-mcp] Fatal error:", err);
  process.exit(1);
});
