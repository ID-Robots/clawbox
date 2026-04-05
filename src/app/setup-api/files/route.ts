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
  const resolved = path.resolve(BASE_DIR, rel);
  if (!resolved.startsWith(path.resolve(BASE_DIR))) return null;
  return resolved;
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

  const entries = fs.readdirSync(abs).filter((name) => !name.startsWith("."));
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
      const result = await new Promise<{ name: string }>((resolve, reject) => {
        const busboy = Busboy({ headers: { "content-type": contentType } });
        let fileName = "";

        busboy.on("file", (_field, fileStream, info) => {
          fileName = info.filename;
          const destPath = safePath(path.join(dir, fileName));
          if (!destPath) {
            fileStream.resume();
            reject(new Error("Invalid destination"));
            return;
          }
          const ws = fs.createWriteStream(destPath);
          fileStream.pipe(ws);
          ws.on("error", reject);
        });
        busboy.on("finish", () => resolve({ name: fileName }));
        busboy.on("error", reject);

        const nodeStream = Readable.fromWeb(req.body as unknown as import("stream/web").ReadableStream);
        nodeStream.pipe(busboy);
      });
      return NextResponse.json({ ok: true, name: result.name });
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
