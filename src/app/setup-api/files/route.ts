import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import Busboy from "busboy";
import { boundedBody } from "@/lib/bounded-body";
import { DISK_FREE_RESERVE_BYTES } from "@/lib/disk-reserve";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Once per process, not per request: a filesystem statfs cannot read is a
// property of the box, and a line per upload would only bury the one that
// says so.
let warnedUnmeasurable = false;

/**
 * Bytes free on the disk `dir` sits on — the DESTINATION's disk, never the
 * checkout's, or an NVMe/SD split box gets the wrong number — or null when
 * statfs will not say. Null is deliberately not 0: "no room" and "could not
 * look" have different answers below, and the old 0 refused every declared
 * upload on a box whose statfs failed, with a message that said the disk was
 * full.
 */
function measureAvailableDiskBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    if (!warnedUnmeasurable) {
      warnedUnmeasurable = true;
      console.warn("[files] could not measure free space; uploads proceed without the disk reserve");
    }
    return null;
  }
}

/** The listing's `availableSpace`, which has always said 0 when nothing could be measured. */
function getAvailableDiskBytes(dir: string): number {
  return measureAvailableDiskBytes(dir) ?? 0;
}

/** Bytes an upload into `dir` may add before the disk drops under the box's reserve; null when the disk will not say. */
function uploadRoom(dir: string): number | null {
  const available = measureAvailableDiskBytes(dir);
  return available === null ? null : Math.max(0, available - DISK_FREE_RESERVE_BYTES);
}

// How often a running upload asks the disk again. A budget measured once at
// request start is not a bound: two uploads at once (the owner's window and
// the agent's bearer, or a script that never waits) are each granted the
// whole room and together cross the reserve. 64 MiB is one statfs per few
// hundred milliseconds of a LAN upload — cheap — and far under the reserve,
// so nothing can slip a reserve's worth past between two measurements.
const REMEASURE_EVERY_BYTES = 64 * 1024 * 1024;

/**
 * The ceiling `boundedBody` asks on every chunk: the bytes already through
 * plus the room the disk reports NOW, re-read every `REMEASURE_EVERY_BYTES`.
 * The bytes through are near enough on disk — what the write stream still
 * holds is tens of kilobytes against a half-gigabyte reserve. A disk statfs
 * cannot read gets no ceiling at all (Infinity), the way a project import
 * proceeds when `freeBytes` answers null: refusing every upload on such a
 * box would make the Files app unusable to fix a problem it did not cause.
 */
function uploadBudget(dir: string): (bytesPassed: number) => number {
  let ceiling = Infinity;
  let measuredAt = -Infinity;
  return (bytesPassed) => {
    if (bytesPassed - measuredAt >= REMEASURE_EVERY_BYTES) {
      measuredAt = bytesPassed;
      const room = uploadRoom(dir);
      ceiling = room === null ? Infinity : bytesPassed + room;
    }
    return ceiling;
  };
}

// What a multipart body carries beyond the file itself: boundaries, part
// headers, the two fields the limits allow. The body meter grants it on top of
// the disk's room so a file that fits exactly is not refused for its framing.
const MULTIPART_HEADROOM_BYTES = 1024 * 1024;

// An upload the route turned away, with the status the caller reads and a
// code a screen can act on. Anything else that escapes the promise below is
// ours — a permission problem, a genuine write error — and stays a 500.
class UploadRefused extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "UploadRefused";
  }
}

const DISK_FULL = `Not enough disk space: the upload would leave the disk under its ${formatBytes(DISK_FREE_RESERVE_BYTES)} reserve.`;

function refusal(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof UploadRefused) return { status: err.status, body: { error: err.message, code: err.code } };
  return { status: 500, body: { error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`, code: "upload_failed" } };
}

export const dynamic = "force-dynamic";

const BASE_DIR = filesBrowseRoot();

/**
 * The absolute path one request may name, or null.
 *
 * SAME RULE, ONE TERM AT A TIME. The two cases used to share a condition —
 * `resolved !== base && !resolved.startsWith(base + path.sep)` — and that is
 * what kept `js/path-injection` open on every fs call downstream of this
 * helper (alerts #523-#528, and the dismissed #247/#248 before them). A
 * containment check only vouches for the path when reaching the code after it
 * REQUIRED the check to pass: with the two terms `&&`-ed, the fall-through is
 * reachable through `resolved === base` without the prefix test having decided
 * anything, so the check governs nothing an analyser — or a reader — can rely
 * on. Split, each line is the only way past itself.
 *
 * The base case answers with the ROOT'S OWN string. It is the same value
 * `resolved` holds there (they are equal, which is why that branch is taken),
 * but it is the constant this module built rather than the request's spelling
 * of it, so nothing of the request survives into the `""` answer.
 *
 * The accepted set is unchanged, deliberately and exactly: an absolute path
 * that already lies under the root is still accepted (the Coding Agent's "Open
 * in Files" sends one), a name beginning `..` — `~/..hidden` — is still a
 * legitimate entry rather than a traversal, and everything that resolved
 * outside the root is still refused. `isInside()` would have been the shorter
 * spelling and is NOT equivalent: its `rel.startsWith("..")` refuses
 * `~/..hidden`, and the Files app has always listed it.
 */
function safePath(rel: string): string | null {
  const base = path.resolve(BASE_DIR);
  const resolved = path.resolve(base, rel);
  // The browse root itself.
  if (resolved === base) return isProtectedFilePath(base) ? null : base;
  // Anything else must be INSIDE it (with the separator, otherwise sibling
  // dirs like "/home/clawboxmalicious" would slip through).
  if (!resolved.startsWith(base + path.sep)) return null;
  // The browse root is $HOME, so secret stores (.ssh, .openclaw, the data/
  // tokens) sit inside the sandbox — deny them at the single resolve chokepoint
  // that every read/write/rename/download path funnels through.
  if (isProtectedFilePath(resolved)) return null;
  return resolved;
}

// Folders the search walks past. A home directory's weight is almost entirely
// node_modules: searching from Home spent the whole 20,000-entry budget inside
// one of them, so the answer was a page of dependency paths and NOTHING from
// the tree the owner keeps files in — while the banner said "first 61 shown",
// as if the rest were merely not displayed. The folder itself is still
// reported when its own name matches; only the descent into it is skipped.
const SEARCH_SKIPPED_DIRS = new Set(["node_modules", ".git", ".cache", ".npm", "__pycache__", ".venv"]);

// Recursive name search rooted at `rootAbs`. Breadth-first so shallow matches
// surface first; bounded by MAX_SCANNED/MAX_MATCHES so a search over a large
// home directory can't hang the request or exhaust memory. Symlinked
// directories are reported (if their name matches) but never traversed —
// `dirent.isDirectory()` is false for symlinks, which avoids cycle loops.
async function searchTree(rootAbs: string, query: string, includeHidden: boolean) {
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
  // WHY the walk ended, not just that it did: "the match list is full" and
  // "the tree was too big to finish" are different answers and the banner
  // above the results words them differently.
  let stoppedBy: "matches" | "scanned" | null = null;

  while (head < queue.length) {
    const dir = queue[head++];
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions) — skip it
    }
    for (const dirent of entries) {
      if (scanned >= MAX_SCANNED) { stoppedBy = "scanned"; break; }
      scanned++;
      const name = dirent.name;
      if (!includeHidden && name.startsWith(".")) continue;
      const isDir = dirent.isDirectory();
      const full = path.join(dir, name);
      // Never surface or descend into secret stores, even with ?hidden=1.
      if (isProtectedFilePath(full)) continue;
      if (name.toLowerCase().includes(query)) {
        let size: number | null = null;
        let modified = "";
        try {
          const s = await fsp.stat(full);
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
        if (matches.length >= MAX_MATCHES) { stoppedBy = "matches"; break; }
      }
      if (isDir && !SEARCH_SKIPPED_DIRS.has(name)) queue.push(full);
    }
    if (stoppedBy) break;
  }

  return { files: matches, search: query, truncated: stoppedBy !== null, stoppedBy };
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

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }
    return NextResponse.json({ error: "Failed to read directory" }, { status: 500 });
  }
  if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

  // Recursive search mode: walk the tree from `abs` and return matches with
  // each one's path relative to the files root. Hidden files are excluded
  // unless ?hidden=1, which also keeps the walk fast (heavy dot-dirs like
  // .cache/.npm are skipped by default).
  const searchRaw = req.nextUrl.searchParams.get("search");
  if (searchRaw && searchRaw.trim()) {
    const includeHidden = req.nextUrl.searchParams.get("hidden") === "1";
    return NextResponse.json(await searchTree(abs, searchRaw.trim().toLowerCase(), includeHidden));
  }

  // Return everything including dotfiles. The client (FilesApp) hides
  // them by default and toggles visibility via the visibility/visibility_off
  // button — filtering server-side would defeat that toggle.
  let entries: string[];
  try {
    entries = fs.readdirSync(abs);
  } catch (err) {
    // A 700 / root-owned directory yields EACCES from scandir — return a clean
    // 403 instead of a 500 that leaks the absolute path in the syscall string.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }
    return NextResponse.json({ error: "Failed to read directory" }, { status: 500 });
  }
  const files = entries
    .map((name) => {
      try {
        const fullPath = path.join(abs, name);
        // Keep secret stores out of the listing entirely (not just un-openable).
        if (isProtectedFilePath(fullPath)) return null;
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

    // Two bounds, because the finding was two holes. Busboy's `limits` count
    // the parts, files and fields (a thousand-part body used to open a
    // thousand write streams and report the last), and the body meter holds
    // the bytes to the disk's room, re-measured as it goes. The file limit is
    // the room measured ONCE plus busboy's one sentinel byte, so a file that
    // fits exactly is accepted whole and only a larger one trips `limit`; the
    // meter around the source carries the framing's headroom and is what
    // notices a disk that filled from elsewhere while this upload ran.
    const room = uploadRoom(abs);
    const bounded = boundedBody(req.body, {
      limit: (() => {
        const budget = uploadBudget(abs);
        return (passed: number) => {
          const ceiling = budget(passed);
          return ceiling === Infinity ? Infinity : ceiling + MULTIPART_HEADROOM_BYTES;
        };
      })(),
      message: DISK_FULL,
    });

    // Every path a write was opened on, so a failure — at any part, from any
    // cause — unlinks all of them and not only the last. Hoisted with the
    // writes so the cleanup can wait for each stream to stop before unlinking:
    // an unlink that races a write just gets the bytes written back under it.
    const written: string[] = [];
    const pendingWrites: Promise<unknown>[] = [];
    try {
      const result = await new Promise<{ name: string; path: string }>((resolve, reject) => {
        const busboy = Busboy({
          headers: { "content-type": contentType },
          limits: {
            files: 1,
            parts: 4,
            fields: 2,
            fieldSize: 1024,
            fileSize: room === null ? Infinity : room + 1,
          },
        });
        let fileName = "";
        let absPath = "";
        const fileWrites: Promise<void>[] = [];
        let settled = false;
        let activeFileStream: Readable | null = null;
        let activeWrite: fs.WriteStream | null = null;
        // Assigned once the body is adapted, below; nothing can emit before
        // `pipe`, so it is never still null by the time an abort can fire.
        let nodeStream: Readable | null = null;

        /**
         * The single way this upload fails. Rejecting alone stops nothing —
         * busboy's `fileSize` limit TRUNCATES: it raises `limit` on the part,
         * ends the stream, and the pipeline then resolves on a cut file that
         * this route would have answered `ok: true` for. And a source that
         * dies mid-part leaves busboy and the write alive, the write never
         * settles, and the route answers nothing at all (the attachments
         * route's documented hang). So every limit, parser, part, write and
         * source error comes through here and tears down all three stages
         * before rejecting. Idempotent, because the teardown makes the other
         * handlers fire in turn.
         */
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          const cause = error instanceof Error ? error : new Error(String(error));
          // The claim is synchronous, the teardown one tick later: busboy
          // emits `limit` from inside its own write loop and touches the part
          // it just emitted on right after (busboy 1.6.0, multipart.js:480),
          // so destroying it from within the handler throws inside the parser
          // — an unhandled rejection, with the caller still answered. Nothing
          // can resolve in the gap, because `settled` is already taken.
          process.nextTick(() => {
            nodeStream?.unpipe(busboy);
            nodeStream?.destroy();
            activeFileStream?.destroy(cause);
            activeWrite?.destroy(cause);
            busboy.destroy();
            reject(error);
          });
        };

        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolve({ name: fileName, path: absPath });
        };

        const tooMany = (what: string) => () => fail(new UploadRefused(`Too many multipart parts: ${what}`, 413, "too_many_parts"));
        busboy.on("filesLimit", tooMany("one file per request"));
        busboy.on("partsLimit", tooMany("at most four parts"));
        busboy.on("fieldsLimit", tooMany("at most two fields"));

        busboy.on("file", (_field, fileStream, info) => {
          activeFileStream = fileStream as unknown as Readable;
          fileStream.on("error", fail);
          fileName = info.filename;
          const destPath = safePath(path.join(dir, fileName));
          if (!destPath) {
            fileStream.resume();
            fail(new UploadRefused("Invalid destination", 400, "invalid_destination"));
            return;
          }
          absPath = destPath;
          // The truncation trap: without this, an oversize part is cut at
          // the limit, the pipeline resolves, and the caller is told the
          // upload worked.
          fileStream.on("limit", () => fail(new UploadRefused(DISK_FULL, 507, "disk_full")));
          const ws = fs.createWriteStream(destPath);
          activeWrite = ws;
          written.push(destPath);
          const writePromise = pipeline(fileStream, ws).then(() => {});
          fileWrites.push(writePromise);
          pendingWrites.push(writePromise);
          writePromise.catch(fail);
        });
        // No file part is not an error here and never was: the answer is
        // `ok: true` with an empty name, and callers read it that way.
        busboy.on("finish", () => {
          void Promise.all(fileWrites).then(resolveOnce).catch(fail);
        });
        busboy.on("error", fail);

        const source = Readable.fromWeb(bounded.stream as unknown as import("stream/web").ReadableStream);
        nodeStream = source;
        source.on("error", (err) => {
          fail(bounded.overflowed() ? new UploadRefused(DISK_FULL, 507, "disk_full") : err);
        });
        source.pipe(busboy);
      });
      return NextResponse.json({ ok: true, name: result.name, path: result.path });
    } catch (err) {
      // A refused upload must not leave a partial file behind: the caller is
      // told nothing landed, and a later upload of the same name would
      // silently inherit whatever bytes did.
      await Promise.allSettled(pendingWrites);
      // Containment re-established HERE, not trusted from the write: every
      // entry is a safePath() answer, but the check that admitted it governed
      // the write inside the promise, and a guard does not carry across that
      // closure into this catch block — CodeQL's path-injection query says so
      // (js/path-injection, alert 519), and it is right that an unlink should
      // vouch for its own argument. The same resolve-then-prefix shape
      // safePath uses; it never refuses a path that was written.
      const base = path.resolve(BASE_DIR);
      for (const p of written) {
        const target = path.resolve(p);
        if (!target.startsWith(base + path.sep)) continue;
        try { await fsp.unlink(target); } catch { /* best effort */ }
      }
      const { status, body } = refusal(err);
      return NextResponse.json(body, { status });
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
    // `relPath` is what the Files app navigates by — the Coding Agent's
    // "Open in Files" asks for a project folder's, absolute as it knows it.
    return NextResponse.json({ absPath: resolved, relPath: path.relative(path.resolve(BASE_DIR), resolved) });
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

  // Content-Length is worth believing when it is offered — an honest client
  // is turned away before a byte is read — but it is a courtesy, not a bound:
  // a chunked body declares nothing, and a dishonest one declares whatever
  // gets it past this line. The metered write below is what actually holds,
  // and it measures against the box's reserve, not the raw free space.
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  const room = uploadRoom(abs);
  if (contentLength > 0 && room !== null && contentLength > room) {
    const avail = formatBytes(room);
    const need = formatBytes(contentLength);
    return NextResponse.json(
      { error: `Not enough disk space. Need ${need}, only ${avail} available.`, code: "disk_full" },
      { status: 507 },
    );
  }

  const bounded = boundedBody(req.body, { limit: uploadBudget(abs), message: DISK_FULL });
  try {
    const nodeReadable = Readable.fromWeb(bounded.stream as unknown as import("stream/web").ReadableStream);
    await pipeline(nodeReadable, fs.createWriteStream(destPath));
  } catch (err) {
    // Whatever landed comes off the disk either way; only the STATUS differs,
    // and it is decided by the meter's flag, never by the error's text — the
    // pipeline surfaces the cut-off as a plain rejection indistinguishable
    // from a genuine write error.
    try { fs.unlinkSync(destPath); } catch { /* cleanup best-effort */ }
    const { status, body } = refusal(bounded.overflowed() ? new UploadRefused(DISK_FULL, 507, "disk_full") : err);
    return NextResponse.json(body, { status });
  }
  return NextResponse.json({ ok: true, name });
}
