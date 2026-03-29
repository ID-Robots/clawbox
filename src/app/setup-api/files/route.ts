import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

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

  return NextResponse.json({ files, baseDir: BASE_DIR });
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
    // File upload
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const destPath = safePath(path.join(dir, file.name));
    if (!destPath) return NextResponse.json({ error: "Invalid destination" }, { status: 400 });

    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return NextResponse.json({ ok: true, name: file.name });
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

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
