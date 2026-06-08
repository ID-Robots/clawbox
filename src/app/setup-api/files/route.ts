import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import Busboy from "busboy";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getAvailableDiskBytes(dir: string): number {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return 0;
  }
}

export const dynamic = "force-dynamic";

const BASE_DIR = process.env.FILES_ROOT ?? (process.env.HOME || "/home/clawbox");

function safePath(rel: string): string | null {
  const base = path.resolve(BASE_DIR);
  const resolved = path.resolve(base, rel);
  // Require either an exact base match or a path inside base (with separator),
  // otherwise sibling dirs like "/home/clawboxmalicious" would slip through.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Recursive name search rooted at `rootAbs`. Breadth-first so shallow matches
// surface first; bounded by MAX_SCANNED/MAX_MATCHES so a search over a large
// home directory can't hang the request or exhaust memory. Symlinked
// directories are reported (if their name matches) but never traversed —
// `dirent.isDirectory()` is false for symlinks, which avoids cycle loops.
function searchTree(rootAbs: string, query: string, includeHidden: boolean) {
  const baseResolved = path.resolve(BASE_DIR);
  const MAX_MATCHES = 300;
  const MAX_SCANNED = 20000;
  const matches: Array<{
    name: string;
    type: "file" | "directory";
    size: number | null;
    modified: string;
    path: string;
  }> = [];
  const queue: string[] = [rootAbs];
  let head = 0;
  let scanned = 0;
  let truncated = false;

  while (head < queue.length) {
    const dir = queue[head++];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions) — skip it
    }
    for (const dirent of entries) {
      if (scanned >= MAX_SCANNED) { truncated = true; break; }
      scanned++;
      const name = dirent.name;
      if (!includeHidden && name.startsWith(".")) continue;
      const isDir = dirent.isDirectory();
      const full = path.join(dir, name);
      if (name.toLowerCase().includes(query)) {
        let size: number | null = null;
        let modified = "";
        try {
          const s = fs.statSync(full);
          size = isDir ? null : s.size;
          modified = s.mtime.toISOString();
        } catch { /* stat may fail on a broken symlink — still list the name */ }
        matches.push({
          name,
          type: isDir ? "directory" : "file",
          size,
          modified,
          path: path.relative(baseResolved, full).split(path.sep).join("/"),
        });
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
      }
      if (isDir) queue.push(full);
    }
    if (truncated) break;
  }

  return { files: matches, search: query, truncated };
}

function ensureBaseDir() {
  try { if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true }); } catch { /* read-only fs */ }
  // Ensure standard home subdirectories exist (skip when FILES_ROOT is explicitly set, e.g. tests)
  if (!process.env.FILES_ROOT) {
    for (const sub of ["Documents", "Downloads", "Desktop"]) {
      const p = path.join(BASE_DIR, sub);
      try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch { /* read-only fs */ }
    }
  }
}

// GET /setup-api/files?dir=relative/path
export async function GET(req: NextRequest) {
  ensureBaseDir();
  const dir = req.nextUrl.searchParams.get("dir") ?? "";
  const abs = safePath(dir);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  if (!fs.existsSync(abs)) {
    // Auto-create if it's the base dir
    if (abs === path.resolve(BASE_DIR)) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
  }

  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

  // Recursive search mode: walk the tree from `abs` and return matches with
  // each one's path relative to the files root. Hidden files are excluded
  // unless ?hidden=1, which also keeps the walk fast (heavy dot-dirs like
  // .cache/.npm are skipped by default).
  const searchRaw = req.nextUrl.searchParams.get("search");
  if (searchRaw && searchRaw.trim()) {
    const includeHidden = req.nextUrl.searchParams.get("hidden") === "1";
    return NextResponse.json(searchTree(abs, searchRaw.trim().toLowerCase(), includeHidden));
  }

  // Return everything including dotfiles. The client (FilesApp) hides
  // them by default and toggles visibility via the visibility/visibility_off
  // button — filtering server-side would defeat that toggle.
  const entries = fs.readdirSync(abs);
  const files = entries
    .map((name) => {
      try {
        const fullPath = path.join(abs, name);
        const s = fs.statSync(fullPath);
        return {
          name,
          type: s.isDirectory() ? "directory" : "file",
          size: s.isDirectory() ? null : s.size,
          modified: s.mtime.toISOString(),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const availableSpace = getAvailableDiskBytes(abs);
  return NextResponse.json({ files, availableSpace });
}

// POST /setup-api/files?dir=relative/path
// Body: multipart (file upload) OR JSON { action: "mkdir", name: "..." }
export async function POST(req: NextRequest) {
  ensureBaseDir();
  const dir = req.nextUrl.searchParams.get("dir") ?? "";
  const abs = safePath(dir);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    if (!req.body) return NextResponse.json({ error: "No body" }, { status: 400 });
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });

    try {
      const result = await new Promise<{ name: string; path: string }>((resolve, reject) => {
        const busboy = Busboy({ headers: { "content-type": contentType } });
        let fileName = "";
        let absPath = "";
        const fileWrites: Promise<void>[] = [];
        let settled = false;

        const rejectOnce = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolve({ name: fileName, path: absPath });
        };

        busboy.on("file", (_field, fileStream, info) => {
          fileName = info.filename;
          const destPath = safePath(path.join(dir, fileName));
          if (!destPath) {
            fileStream.resume();
            rejectOnce(new Error("Invalid destination"));
            return;
          }
          absPath = destPath;
          const ws = fs.createWriteStream(destPath);
          const writePromise = pipeline(fileStream, ws).then(() => {});
          fileWrites.push(writePromise);
          writePromise.catch(rejectOnce);
        });
        busboy.on("finish", () => {
          void Promise.all(fileWrites).then(resolveOnce).catch(rejectOnce);
        });
        busboy.on("error", rejectOnce);

        const nodeStream = Readable.fromWeb(req.body as unknown as import("stream/web").ReadableStream);
        nodeStream.pipe(busboy);
      });
      return NextResponse.json({ ok: true, name: result.name, path: result.path });
    } catch (err) {
      return NextResponse.json({ error: `Upload failed: ${err instanceof Error ? err.message : err}` }, { status: 500 });
    }
  }

  // JSON action
  const body = await req.json().catch(() => ({}));
  if (body.action === "mkdir") {
    if (!body.name) return NextResponse.json({ error: "Name required" }, { status: 400 });
    const newDir = safePath(path.join(dir, body.name));
    if (!newDir) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    if (fs.existsSync(newDir)) return NextResponse.json({ error: "Already exists" }, { status: 409 });
    fs.mkdirSync(newDir, { recursive: true });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "resolve") {
    if (!body.filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    const resolved = safePath(body.filePath);
    if (!resolved) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    return NextResponse.json({ absPath: resolved });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// PUT /setup-api/files?dir=relative/path&name=filename
// Body: raw binary file (application/octet-stream)
// Streams directly to disk — handles large files without buffering
export async function PUT(req: NextRequest) {
  ensureBaseDir();
  const dir = req.nextUrl.searchParams.get("dir") ?? "";
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });

  const abs = safePath(dir);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  const destPath = safePath(path.join(dir, name));
  if (!destPath) return NextResponse.json({ error: "Invalid destination" }, { status: 400 });

  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });

  if (!req.body) return NextResponse.json({ error: "No body" }, { status: 400 });

  // Check disk space before writing
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  const available = getAvailableDiskBytes(abs);
  if (contentLength > 0 && contentLength > available) {
    const avail = formatBytes(available);
    const need = formatBytes(contentLength);
    return NextResponse.json({ error: `Not enough disk space. Need ${need}, only ${avail} available.` }, { status: 507 });
  }

  try {
    const nodeReadable = Readable.fromWeb(req.body as unknown as import("stream/web").ReadableStream);
    await pipeline(nodeReadable, fs.createWriteStream(destPath));
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch { /* cleanup best-effort */ }
    return NextResponse.json({ error: `Upload failed: ${err instanceof Error ? err.message : err}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, name });
}
