import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { FILES_ROOT } from "@/lib/runtime-paths";

export const dynamic = "force-dynamic";

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', css: 'text/css',
  js: 'text/javascript', json: 'application/json', md: 'text/markdown',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};

const BASE_DIR = FILES_ROOT;

function safePath(segments: string[]): string | null {
  const rel = segments.join("/");
  const resolved = path.resolve(BASE_DIR, rel);
  if (!resolved.startsWith(path.resolve(BASE_DIR) + path.sep) && resolved !== path.resolve(BASE_DIR)) return null;
  return resolved;
}

type Params = { params: Promise<{ path: string[] }> };

// GET /setup-api/files/[...path] — download file
export async function GET(_req: NextRequest, { params }: Params) {
  const { path: segments } = await params;
  const abs = safePath(segments);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  if (!fs.existsSync(abs)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return NextResponse.json({ error: "Is a directory" }, { status: 400 });

  const buffer = fs.readFileSync(abs);
  const filename = path.basename(abs);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isInline = (contentType.startsWith('image/') && contentType !== 'image/svg+xml') || contentType === 'application/pdf';
  return new NextResponse(buffer, {
    headers: {
      "Content-Disposition": `${isInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`,
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
    },
  });
}

// PUT /setup-api/files/[...path] — rename/move
// Body: { newName: string }  (renames within same directory)
export async function PUT(req: NextRequest, { params }: Params) {
  const { path: segments } = await params;
  const abs = safePath(segments);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  if (!fs.existsSync(abs)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (!body.newName) return NextResponse.json({ error: "newName required" }, { status: 400 });

  const parentDir = path.dirname(abs);
  const newAbs = path.resolve(parentDir, body.newName);
  const base = path.resolve(BASE_DIR);
  if (newAbs !== base && !newAbs.startsWith(base + path.sep)) {
    return NextResponse.json({ error: "Invalid destination" }, { status: 400 });
  }
  if (fs.existsSync(newAbs)) return NextResponse.json({ error: "Already exists" }, { status: 409 });

  fs.renameSync(abs, newAbs);
  return NextResponse.json({ ok: true });
}

// DELETE /setup-api/files/[...path] — delete file or directory
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { path: segments } = await params;
  const abs = safePath(segments);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  if (!fs.existsSync(abs)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
  return NextResponse.json({ ok: true });
}
