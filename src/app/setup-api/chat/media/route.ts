import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { chatMediaRoot } from "@/lib/harness/media-root";
import { getActiveHarness } from "@/lib/harness";
import { openclawWorkspaceDir } from "@/lib/language-persona";

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
// Rooted on the edition's resolved media root rather than a second
// `$HOME + "/.openclaw"` of our own: OPENCLAW_HOME is a live contract the config
// and ws-config routes already honour, and an install that relocates the tree
// would otherwise leave this route resolving a directory holding nothing,
// 404-ing every picture.
//
// Resolved per request, and per EDITION. A Hermes SKU has no `~/.openclaw/media`
// at all, so this reader was pointed at a directory nothing wrote into while the
// staging route next door wrote somewhere it could not read. Both ends now ask
// the same question. On an OpenClaw box the answer is byte-identical to the
// constant this replaced, so nothing about that path changes.

// Extension → Content-Type for what the chat renders INLINE. Anything not named
// here is served only as an `application/octet-stream` attachment download,
// never under a guessed type. `.svg` is absent on
// purpose — it is a scriptable document and these paths come from model output.
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  // Spoken replies. The on-device TTS provider writes `.wav`; the rest are here
  // so switching provider does not silently turn every answer back into a 415.
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".weba": "audio/webm",
  // Served as audio because the only .webm this tree ever holds is one: it is
  // what MediaRecorder emits and what a provider returning Opus-in-WebM would
  // write. `isAudioMedia` deliberately does NOT claim the extension, so a bare
  // MEDIA: line naming a .webm video is still not routed into an audio player.
  ".webm": "audio/webm",
};

const AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/webm",
]);

// A generated 1024×1024 PNG runs ~1.5 MB; this leaves room for larger renders
// without letting the route buffer something unbounded into memory.
const MAX_BYTES = 25 * 1024 * 1024;

// Anything that is not rendered inline — a PDF, a zip, a CSV the agent made —
// is only ever handed over as a download, streamed, so it can be larger.
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** Filename for Content-Disposition, safe for the header in both spellings. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

interface Root {
  logical: string;
  real: string;
  /** Refuse dot-segments below this root (`.git`, `.env`, `.openclaw`, …). */
  hideDotfiles: boolean;
}

/**
 * The trees this route may read from. The media tree always; on OpenClaw also
 * the agent workspace, because OpenClaw's own protocol lets a reply attach a
 * file by an absolute or workspace-relative path (docs: rich-output-protocol)
 * and a report the agent wrote into its workspace is exactly what the owner
 * wants to download. The workspace also holds dotfiles and, if configured as
 * `~`, the whole home — so every dot-segment below it is refused, which keeps
 * `~/.openclaw`, `.ssh`, `.env` and `.git` out of reach.
 */
async function allowedRoots(): Promise<{ roots: Root[]; workspace: string | null }> {
  const roots: Root[] = [];
  const mediaLogical = await chatMediaRoot();
  const mediaReal = await resolvedRoot(mediaLogical);
  if (mediaReal) roots.push({ logical: mediaLogical, real: mediaReal, hideDotfiles: false });
  let workspace: string | null = null;
  if ((await getActiveHarness()) !== "hermes") {
    workspace = openclawWorkspaceDir();
    const wsReal = await resolvedRoot(workspace);
    if (wsReal) roots.push({ logical: workspace, real: wsReal, hideDotfiles: true });
  }
  return { roots, workspace };
}

/** A path relative to `base` that stays inside it, or null. */
function inside(base: string, target: string): string | null {
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function hasDotSegment(rel: string): boolean {
  return rel.split(path.sep).some((segment) => segment.startsWith("."));
}

/**
 * Parse one `Range: bytes=…` header against a known size.
 *
 * Only the single-range forms a media element actually sends are honoured;
 * anything else returns null and is answered with the whole file, which is a
 * legal response to any range request. Returning the whole file is also why
 * this never produces a 416: refusing outright would break playback over a
 * header we chose not to implement.
 *
 * Why it exists at all: an `<audio>` element seeks by asking for a byte range.
 * Served without `Accept-Ranges`, Chrome plays the file but the scrubber will
 * not move, and Safari refuses to start it — so "playable with native
 * controls" is not a property of the element, it is a property of this
 * response.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  // A suffix range ("give me the last N bytes") is the one form with no start.
  if (!rawStart) {
    const wanted = Number(rawEnd);
    if (!Number.isFinite(wanted) || wanted <= 0) return null;
    // An empty file has no last N bytes. Without this the reply is
    // `Content-Range: bytes 0--1/0`, which is not a range at all.
    if (size === 0) return null;
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/**
 * The root with symlinks resolved. `~/.openclaw` may itself be a link (a
 * shared-identity install moves it), and comparing a resolved file path against
 * an unresolved root would then reject every legitimate read. Null when the
 * tree does not exist yet — no image has been generated on this box — which
 * simply means nothing can match.
 */
async function resolvedRoot(logical: string): Promise<string | null> {
  try {
    return await fsp.realpath(logical);
  } catch {
    return null;
  }
}

type Resolved =
  | { ok: true; safe: string; size: number; contentType: string; inline: boolean; name: string }
  | { ok: false; response: NextResponse };

function fail(status: number, error: string): Resolved {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

async function resolveRequest(req: NextRequest): Promise<Resolved> {
  const requested = req.nextUrl.searchParams.get("path");
  if (!requested) return fail(400, "Missing path");
  if (requested.includes("\0")) return fail(400, "Invalid path");

  const hintedMime = (req.nextUrl.searchParams.get("mime") ?? "")
    .split(";", 1)[0].trim().toLowerCase();
  const extension = path.extname(requested).toLowerCase();
  // A MIME hint exists only for structured attachments whose provider wrote
  // an extensionless file. It must never override a named type: otherwise
  // `secret.json?mime=audio/wav` would be served as something playable.
  const inlineType = CONTENT_TYPES[extension]
    ?? (!extension && AUDIO_MIME_TYPES.has(hintedMime) ? hintedMime : undefined);
  // Everything else is still served — but only as an opaque download, never
  // under a guessed type a browser could render (svg, html, …).
  const forceDownload = req.nextUrl.searchParams.get("download") === "1";
  const inline = Boolean(inlineType) && !forceDownload;
  const contentType = inlineType ?? "application/octet-stream";

  const { roots, workspace } = await allowedRoots();

  // TWO containment tests. The first is purely lexical and runs before any
  // filesystem call touches the query string: the request is reduced to a
  // path RELATIVE to an allowed root and rebuilt by joining that cleared
  // segment onto the trusted root. A relative request is resolved against the
  // workspace — never the server's cwd — and refused where there is none.
  //
  // A shared-identity install gives one legitimate file two spellings (the
  // logical `~/.openclaw/media/...` and its realpath), so either spelling of a
  // root is accepted, then rebuilt from the resolved one.
  let absolute: string;
  if (path.isAbsolute(requested)) absolute = path.resolve(requested);
  else if (workspace) absolute = path.resolve(workspace, requested);
  else return fail(400, "Path must be absolute");

  let root: Root | null = null;
  let rel: string | null = null;
  for (const candidateRoot of roots) {
    const found = inside(candidateRoot.logical, absolute) ?? inside(candidateRoot.real, absolute);
    if (found !== null) {
      root = candidateRoot;
      rel = found;
      break;
    }
  }
  if (!root || rel === null) return fail(404, "Not found");
  if (root.hideDotfiles && hasDotSegment(rel)) return fail(404, "Not found");
  const candidate = path.join(root.real, rel);

  // The second test resolves symlinks, which the lexical check cannot see: a
  // link planted inside the tree pointing at ~/.openclaw/openclaw.json is
  // textually contained and still an escape (CWE-59).
  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    return fail(404, "Not found");
  }
  const realRel = inside(root.real, real);
  if (realRel === null) return fail(404, "Not found");
  if (root.hideDotfiles && hasDotSegment(realRel)) return fail(404, "Not found");
  const safe = path.join(root.real, realRel);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(safe);
  } catch {
    return fail(404, "Not found");
  }
  if (!stat.isFile()) return fail(404, "Not found");
  if (stat.size > (inline ? MAX_BYTES : MAX_DOWNLOAD_BYTES)) return fail(413, "Media too large");
  return { ok: true, safe, size: stat.size, contentType, inline, name: path.basename(safe) };
}

function baseHeaders(resolved: Extract<Resolved, { ok: true }>): Record<string, string> {
  return {
    "Content-Type": resolved.contentType,
    // Advertised on every response: a media element reads this from the
    // first, full-file reply and only asks for ranges afterwards.
    "Accept-Ranges": "bytes",
    // Authentication is cookie-based, browser caches are not keyed by that
    // cookie: never let a file outlive logout in a cache.
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ...(resolved.inline ? {} : { "Content-Disposition": contentDisposition(resolved.name) }),
  };
}

/** Size and type without the body — what a download card shows before a click. */
export async function HEAD(req: NextRequest) {
  const resolved = await resolveRequest(req);
  if (!resolved.ok) return new NextResponse(null, { status: resolved.response.status });
  return new NextResponse(null, {
    headers: { ...baseHeaders(resolved), "Content-Length": String(resolved.size) },
  });
}

export async function GET(req: NextRequest) {
  const resolved = await resolveRequest(req);
  if (!resolved.ok) return resolved.response;
  const headers = baseHeaders(resolved);
  try {
    // Streamed, not buffered: a Jetson should not hold a file in RAM per request.
    const range = parseRange(req.headers.get("range"), resolved.size);
    if (range) {
      const partial = Readable.toWeb(
        fs.createReadStream(resolved.safe, { start: range.start, end: range.end }),
      ) as unknown as ReadableStream;
      return new NextResponse(partial, {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${resolved.size}`,
        },
      });
    }
    const body = Readable.toWeb(fs.createReadStream(resolved.safe)) as unknown as ReadableStream;
    return new NextResponse(body, {
      headers: { ...headers, "Content-Length": String(resolved.size) },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
