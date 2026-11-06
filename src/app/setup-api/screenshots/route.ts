import { NextResponse } from "next/server";
import { boundedBody } from "@/lib/bounded-body";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { MAX_SCREENSHOT_BYTES, SCREENSHOTS_DIR, screenshotRelPath } from "@/lib/screenshot/files";
import { ScreenshotError, deleteScreenshot, listScreenshots, saveScreenshot } from "@/lib/screenshot/store";

export const dynamic = "force-dynamic";

// /setup-api/screenshots — the Screenshot app's folder (TASK-1475).
//
//   GET                 the newest screenshots in <Files root>/Screenshots
//   POST   ?name=<file> save one image; the body is the PNG or JPEG itself
//   DELETE ?name=<file> remove one
//
// The pictures themselves are read back through the Files route
// (/setup-api/files/Screenshots/<name>), the same way the Files app shows
// them. This route only ever touches that one folder: the name is a single
// validated segment (src/lib/screenshot/files.ts), the body is capped at
// MAX_SCREENSHOT_BYTES and must really be the image its extension claims.
// Owner-only like the Files routes it sits beside; writes are same-origin.

const NO_STORE = { "cache-control": "no-store" };

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

function refusal(err: unknown) {
  if (err instanceof ScreenshotError) return refuse(err.message, err.code, err.status);
  console.error("[screenshots] failed:", err instanceof Error ? err.message : err);
  return refuse("The screenshot could not be saved.", "write_failed", 500);
}

export async function GET(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;
  try {
    return NextResponse.json(
      { dir: SCREENSHOTS_DIR, maxBytes: MAX_SCREENSHOT_BYTES, files: listScreenshots() },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[screenshots] list failed:", err instanceof Error ? err.message : err);
    return refuse("The screenshots could not be listed.", "read_failed", 500);
  }
}

async function readImage(request: Request): Promise<Uint8Array | NextResponse> {
  if (!request.body) return refuse("The image is empty.", "empty", 400);
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_SCREENSHOT_BYTES) {
    return refuse("The image is too large to save.", "too_large", 413);
  }
  const bounded = boundedBody(request.body, { limit: MAX_SCREENSHOT_BYTES });
  const chunks: Uint8Array[] = [];
  try {
    const reader = bounded.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    if (bounded.overflowed()) return refuse("The image is too large to save.", "too_large", 413);
    return refuse("The image did not arrive whole.", "incomplete", 400);
  }
  const total = bounded.bytes();
  // A body cut short on its way here must not be saved as if it were the picture.
  if (Number.isFinite(declared) && declared !== total) {
    return refuse("The image did not arrive whole.", "incomplete", 400);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function POST(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;
  if (!isSameOriginRequest(request)) return refuse("Cross-origin request refused.", "cross_origin", 403);

  const name = new URL(request.url).searchParams.get("name");
  const bytes = await readImage(request);
  if (bytes instanceof NextResponse) return bytes;
  try {
    const saved = saveScreenshot(name, bytes);
    return NextResponse.json(
      { ok: true, ...saved, path: screenshotRelPath(saved.name) },
      { status: 201, headers: NO_STORE },
    );
  } catch (err) {
    return refusal(err);
  }
}

export async function DELETE(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;
  if (!isSameOriginRequest(request)) return refuse("Cross-origin request refused.", "cross_origin", 403);

  const name = new URL(request.url).searchParams.get("name");
  try {
    deleteScreenshot(name);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof ScreenshotError) return refuse(err.message, err.code, err.status);
    console.error("[screenshots] delete failed:", err instanceof Error ? err.message : err);
    return refuse("The screenshot could not be deleted.", "delete_failed", 500);
  }
}
