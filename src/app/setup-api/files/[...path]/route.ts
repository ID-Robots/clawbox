import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { filesBrowseRoot, isProtectedContainer, isProtectedFilePath } from "@/lib/file-guard";

export const dynamic = "force-dynamic";

// Translate a Node fs error into a clean HTTP response without echoing the raw
// error string (which leaks absolute paths / syscall names).
function fsErrorResponse(err: unknown, fallback: string): NextResponse {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }
  if (code === "ENOENT") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

// Same idea for mutations (rename/delete). ENOENT/EXDEV are client-side
// mistakes (gone underneath us / cross-device rename) → 400, not 404/500.
function mutationErrorResponse(err: unknown, fallback: string): NextResponse {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }
  if (code === "ENOENT" || code === "EXDEV") {
    return NextResponse.json({ error: fallback }, { status: 400 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', css: 'text/css',
  js: 'text/javascript', json: 'application/json', md: 'text/markdown',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};

const BASE_DIR = filesBrowseRoot();

// The rename and delete handlers' answer for a directory that HOLDS the box's
// own state — the data directory and its ancestors, the browse root, the
// parent of a credential store. `safePath` keeps such a directory openable so
// its public subtrees can be listed; moving or removing it is a different
// question (see `isProtectedContainer`). The folder is visible in the listing,
// so there is nothing to hide: the error says what it is and carries a code
// the Files app can key on, instead of the "Invalid path" a secret gets.
function protectedContainerResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "This folder holds the box's own state and cannot be moved or deleted here",
      code: "protected_container",
    },
    { status: 400 },
  );
}

function safePath(segments: string[]): string | null {
  const rel = segments.join("/");
  const resolved = path.resolve(BASE_DIR, rel);
  if (!resolved.startsWith(path.resolve(BASE_DIR) + path.sep) && resolved !== path.resolve(BASE_DIR)) return null;
  // Browse root is $HOME → secret stores live inside the sandbox; deny them.
  if (isProtectedFilePath(resolved)) return null;
  return resolved;
}

type Params = { params: Promise<{ path: string[] }> };

// GET /setup-api/files/[...path] — download file
export async function GET(_req: NextRequest, { params }: Params) {
  const { path: segments } = await params;
  const abs = safePath(segments);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    return fsErrorResponse(err, "Failed to read file");
  }
  if (stat.isDirectory()) return NextResponse.json({ error: "Is a directory" }, { status: 400 });

  // Stream the file instead of buffering the whole thing into RAM — a
  // multi-hundred-MB download must not OOM the Jetson.
  let nodeStream: fs.ReadStream;
  try {
    nodeStream = fs.createReadStream(abs);
  } catch (err) {
    return fsErrorResponse(err, "Failed to read file");
  }

  const filename = path.basename(abs);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isInline = (contentType.startsWith('image/') && contentType !== 'image/svg+xml') || contentType === 'application/pdf';
  // RFC 5987: quoted ASCII fallback + filename* for Unicode/spaces. The ASCII
  // fallback strips anything outside the printable-ASCII range (and quotes/
  // backslashes) so the quoted-string stays valid.
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = `${isInline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new NextResponse(body, {
    headers: {
      "Content-Disposition": disposition,
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
    },
  });
}

// PUT /setup-api/files/[...path] — rename/move
// Body: { newName: string }  (renames within same directory)
export async function PUT(req: NextRequest, { params }: Params) {
  const { path: segments } = await params;
  const abs = safePath(segments);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  // Before the existence check: `data` is renamable precisely because it is
  // there and `safePath` lets it through.
  if (isProtectedContainer(abs)) return protectedContainerResponse();
  if (!fs.existsSync(abs)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // `.catch` covers a body that is not JSON at all; this covers one that IS —
  // a request whose body is literally `null` parses to `null`, and reading
  // `.newName` off it threw a TypeError, so the Files app got a 500 where the
  // 400 below is the answer. Anything that is not a plain object carries no
  // `newName` either, so they all take the same road.
  const parsed: unknown = await req.json().catch(() => null);
  const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const newName: unknown = body.newName;
  if (typeof newName !== "string" || !newName) return NextResponse.json({ error: "newName required" }, { status: 400 });

  // A rename is a NAME, not a move. `../escape.txt` resolves to a path that is
  // still inside the browse root, so the containment check below waved it
  // through: the app answered "Renamed" and the file left the folder the owner
  // was looking at with nothing on screen to say where it went. The fence is
  // here because the route is the fence — the app is not its only caller.
  if (newName !== path.basename(newName) || newName === "." || newName === "..") {
    return NextResponse.json({ error: "Invalid destination" }, { status: 400 });
  }

  const parentDir = path.dirname(abs);
  const newAbs = path.resolve(parentDir, newName);
  const base = path.resolve(BASE_DIR);
  if (newAbs !== base && !newAbs.startsWith(base + path.sep)) {
    return NextResponse.json({ error: "Invalid destination" }, { status: 400 });
  }
  // Don't let a rename create/clobber a secret store name either.
  if (isProtectedFilePath(newAbs)) {
    return NextResponse.json({ error: "Invalid destination" }, { status: 400 });
  }
  // Nor take the data directory's own path: `data-copy` → `data` after a
  // restart has recreated it is a 409, but before it has, the rename would put
  // a folder of the owner's choosing where the box keeps its state.
  if (isProtectedContainer(newAbs)) return protectedContainerResponse();
  if (fs.existsSync(newAbs)) return NextResponse.json({ error: "Already exists" }, { status: 409 });

  try {
    fs.renameSync(abs, newAbs);
  } catch (err) {
    return mutationErrorResponse(err, "Failed to rename");
  }
  return NextResponse.json({ ok: true });
}

// DELETE /setup-api/files/[...path] — delete file or directory
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { path: segments } = await params;
  const abs = safePath(segments);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  // `rmSync(…, { recursive: true })` on the data directory removes the config,
  // the session secret and every token in one request; on the browse root it
  // removes the home. Neither is a file-manager gesture.
  if (isProtectedContainer(abs)) return protectedContainerResponse();
  if (!fs.existsSync(abs)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const stat = fs.statSync(abs);
  try {
    if (stat.isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      fs.unlinkSync(abs);
    }
  } catch (err) {
    return mutationErrorResponse(err, "Failed to delete");
  }
  return NextResponse.json({ ok: true });
}
