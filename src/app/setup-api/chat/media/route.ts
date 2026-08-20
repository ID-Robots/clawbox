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

  const root = await resolvedRoot();
  if (!root) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // TWO containment tests, and the order of the first one is the point.
  //
  // This one is purely lexical and runs BEFORE any filesystem call touches the
  // query string. It reduces the request to a path RELATIVE to the media root,
  // rejects anything that climbs out, and then rebuilds the absolute path by
  // joining that cleared segment onto MEDIA_ROOT — a module constant, never
  // user input. Nothing derived from the query string is handed to the
  // filesystem; realpath below receives a value built from the constant.
  //
  // Written this way deliberately. Comparing `path.resolve(requested)` against
  // the root with startsWith is equally correct and reads more naturally, but
  // the root is only known after an async call, so a scanner cannot tie the
  // guard to the sink and js/path-injection stayed open at high severity. This
  // form is both correct and legible to the tool.
  const rel = path.relative(MEDIA_ROOT, path.resolve(requested));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const candidate = path.join(MEDIA_ROOT, rel);

  // The second test still resolves symlinks, because the lexical check above
  // cannot see them: a link planted inside the media tree pointing at
  // ~/.openclaw/openclaw.json is textually contained and still an escape
  // (CWE-59). A path that does not exist fails here too, reported as a miss
  // rather than distinguishing the two cases.
  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Exact match or a genuine descendant. The separator matters: without it a
  // sibling such as `~/.openclaw/media-backup` would slip through the prefix.
  if (real !== root && !real.startsWith(root + path.sep)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Reads go through `safe`, rebuilt from the resolved root plus the segment the
  // symlink check just cleared — so the value handed to stat and
  // createReadStream is constructed from trusted parts rather than carried down
  // from the request.
  const realRel = path.relative(root, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const safe = path.join(root, realRel);

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
