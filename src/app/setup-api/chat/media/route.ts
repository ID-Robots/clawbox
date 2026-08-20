import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { OPENCLAW_HOME } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// ── Generated-media reader ──────────────────────────────────────────────────
//
// The agent's image tool writes into the harness' own media tree
// (~/.openclaw/media/tool-image-generation/…). The desktop chat cannot read the
// filesystem, and the gateway's `/__openclaw__/assistant-media` endpoint
// refuses this tree ("Outside allowed folders"), so the picture needs a route
// of ClawBox's own to be displayable at all.
//
// This deliberately does NOT reuse the Files API. file-guard.ts refuses the
// whole of ~/.openclaw there, and rightly so: the same directory holds
// openclaw.json, the identity keys and every session transcript. Relaxing that
// guard so the chat could show a picture would expose the credentials with it.
// This route names the one safe subtree instead and leaves the guard intact.
//
// Session-gated by middleware, which also lists /setup-api/chat among the
// surfaces that stay closed during the pre-setup AP window.
//
// Rooted on OPENCLAW_HOME rather than a second `$HOME + "/.openclaw"` of our
// own: that env var is a live contract the config and ws-config routes already
// honour, and an install that relocates the tree would otherwise leave this
// route resolving a directory holding nothing, 404-ing every picture.
const MEDIA_ROOT = path.join(OPENCLAW_HOME, "media");

// Extension → Content-Type. Doubles as the allowlist: anything not named here
// is refused rather than served under a guessed type. `.svg` is absent on
// purpose — it is a scriptable document and these paths come from model output.
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

// A generated 1024×1024 PNG runs ~1.5 MB; this leaves room for larger renders
// without letting the route buffer something unbounded into memory.
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * The root with symlinks resolved. `~/.openclaw` may itself be a link (a
 * shared-identity install moves it), and comparing a resolved file path against
 * an unresolved root would then reject every legitimate read. Null when the
 * tree does not exist yet — no image has been generated on this box — which
 * simply means nothing can match.
 */
async function resolvedRoot(): Promise<string | null> {
  try {
    return await fsp.realpath(MEDIA_ROOT);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("path");
  if (!requested) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }
  if (!path.isAbsolute(requested)) {
    return NextResponse.json({ error: "Path must be absolute" }, { status: 400 });
  }

  const contentType = CONTENT_TYPES[path.extname(requested).toLowerCase()];
  if (!contentType) {
    return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
  }

  // Resolve symlinks BEFORE the containment test: a link planted inside the
  // media tree and pointing at ~/.openclaw/openclaw.json would otherwise pass a
  // plain prefix check (CWE-59). A path that does not exist fails here too, and
  // is reported as a miss rather than distinguishing the two cases.
  let real: string;
  try {
    real = await fsp.realpath(path.resolve(requested));
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Exact match or a genuine descendant. The separator matters: without it a
  // sibling such as `~/.openclaw/media-backup` would slip through the prefix.
  const root = await resolvedRoot();
  if (!root || (real !== root && !real.startsWith(root + path.sep))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Everything below reads `safe`, never `real` or `requested`. `safe` is
  // rebuilt from the trusted root plus a relative segment that has just been
  // proven not to escape it, so no value derived from the query string reaches
  // the filesystem calls. The containment test above already made this correct;
  // reconstructing makes it *provable* — CodeQL's js/path-injection cannot
  // follow the check through the async resolvedRoot() indirection and flagged
  // the route high severity. A guard a scanner cannot see is one the next
  // person will quietly refactor away.
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const safe = path.join(root, rel);

  try {
    const stat = await fsp.stat(safe);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (stat.size > MAX_BYTES) {
      return NextResponse.json({ error: "Media too large" }, { status: 413 });
    }
    // Streamed, not buffered — the sibling files route does the same, for the
    // same reason: a 25 MB ceiling read into RAM (and then copied again into a
    // Uint8Array) is not something to hand a Jetson per request.
    const body = Readable.toWeb(fs.createReadStream(safe)) as unknown as ReadableStream;
    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        // Per-device, per-conversation content: keep it out of shared caches,
        // stop the browser sniffing it into something executable, and give it
        // no ambient authority if it is ever opened as a document.
        //
        // `immutable` because the harness names every file with a UUID and
        // never rewrites one — without it, reopening a chat re-reads and
        // re-transfers every picture in the visible history once an hour.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
