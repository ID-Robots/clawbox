import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import Busboy from "busboy";
import { randomUUID } from "crypto";
import { OPENCLAW_HOME } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// -- Chat attachment staging ------------------------------------------------
//
// Where a file the user attaches in device chat is written so the agent can
// actually open it.
//
// The chat composer uploads the file and then names its absolute path in the
// message (`[Attached file: /abs/path]`), so the path has to be one OpenClaw
// will read. It maintains a fixed allowlist of media roots --
// `buildMediaLocalRoots` in `dist/local-roots-CAoJyC6u.js` on 2026.7.1: the
// openclaw tmp dir, `<configDir>/media`, and
// `<stateDir>/{media,canvas,workspace,sandboxes}`, plus the agent workspace.
// `$HOME/uploads`, which is where `/setup-api/files?dir=uploads` puts it, is on
// none of them, so the `image` tool answers "Local media path is not under an
// allowed directory" and the assistant tells the user it cannot see the
// picture. Reproduced on a real box on 2026-08-21 with the exact path the
// composer produces; see TASK-417.
//
// `<stateDir>/media` is the allowlisted root that is also where OpenClaw keeps
// inbound media of its own, so a subdirectory of it is the natural home. The
// Files API cannot be used for this: file-guard.ts refuses the whole of
// ~/.openclaw there -- correctly, since that tree also holds openclaw.json, the
// identity keys and every transcript -- and relaxing that guard to land one
// attachment would expose the credentials with it. Same reasoning, and the same
// OPENCLAW_HOME rooting, as the sibling media reader in ../media/route.ts.
//
// Session-gated by middleware, which lists /setup-api/chat among the surfaces
// that stay closed even during the pre-setup AP window.
const ATTACHMENT_DIR = path.join(OPENCLAW_HOME, "media", "chat-attachments");

// OpenClaw refuses an inline chat image over 6 MB
// (`attachment-normalize-CpH9LzfB.js`), but this path is not the inline one --
// it stages a file the agent opens by path, and the composer also accepts PDFs
// and text. 25 MB matches the ceiling the sibling media reader uses.
const MAX_BYTES = 25 * 1024 * 1024;

// `limits.fileSize` bounds each file, not the request. Without a total-bytes
// guard a caller can stream unbounded data at the disk under one part, or pile
// on parts and fields that never hit the file limit at all. This route is
// session-gated, so this is a resource guard rather than a perimeter, but the
// disk it fills is the customer's.
const MAX_REQUEST_BYTES = MAX_BYTES + 1024 * 1024;
const MAX_FIELDS = 8;
const MAX_FIELD_BYTES = 4096;
const MAX_PARTS = 12;

/** Raised for input the client got wrong (400) as opposed to a failure of ours (500). */
class BadUpload extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BadUpload";
  }
}

/**
 * A filesystem-safe leaf name for an uploaded file.
 *
 * The name arrives from a browser file picker or a clipboard paste, so it is
 * attacker-influenced in the same way any upload name is. `path.basename`
 * drops any directory part, the character class removes separators and control
 * bytes that survive it on some platforms, and leading dots are stripped so an
 * upload cannot land as a dotfile. Returns null when nothing usable is left --
 * the caller rejects rather than inventing a name, so the client never gets
 * back a path it did not send a file for.
 *
 * Containment is still re-checked against the resolved directory after the
 * join; this is the first of two gates, not the only one.
 */
function safeLeafName(raw: string): string | null {
  const base = path.basename(String(raw ?? "").trim());
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

/**
 * `<dir>/<name>`, or null when the join escapes `dir`.
 *
 * Belt and braces over `safeLeafName`. An exact-match check is not enough on
 * its own: without the separator a sibling like `.../chat-attachments-evil`
 * would pass a bare `startsWith`.
 */
function resolveDest(dirReal: string, name: string): string | null {
  const dest = path.resolve(dirReal, name);
  if (dest !== dirReal && !dest.startsWith(dirReal + path.sep)) return null;
  return dest;
}

// POST /setup-api/chat/attachments
// Body: multipart/form-data with one `file` part.
// Returns { ok, name, path } -- the same shape the composer already reads back
// from the Files API, so only the URL changes on the client.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  if (!req.body) return NextResponse.json({ error: "No body" }, { status: 400 });

  // Preparing the staging directory is our side of the contract, not the
  // caller's: a read-only filesystem or a bad permission here is a 500, and it
  // has to be caught, or the rejection escapes the route with no JSON body at
  // all.
  let dirReal: string;
  try {
    await fsp.mkdir(ATTACHMENT_DIR, { recursive: true });
    // Resolve AFTER mkdir: realpath on a directory that does not exist yet
    // throws, and ~/.openclaw is a symlink on shared-identity installs.
    dirReal = await fsp.realpath(ATTACHMENT_DIR);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not prepare the attachment directory: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  let written: string | null = null;
  // Hoisted so the cleanup below can wait for the write to stop before
  // unlinking. Rejecting on a limit does not halt the pipeline synchronously,
  // and an unlink that races it just gets the bytes written back underneath it.
  const pendingWrites: Promise<unknown>[] = [];
  try {
    const result = await new Promise<{ name: string; path: string }>((resolve, reject) => {
      const busboy = Busboy({
        headers: { "content-type": contentType },
        limits: {
          files: 1,
          fileSize: MAX_BYTES,
          fields: MAX_FIELDS,
          fieldSize: MAX_FIELD_BYTES,
          parts: MAX_PARTS,
        },
      });
      let settled = false;
      let fileName = "";
      let destPath = "";
      let sawFile = false;
      const writes: Promise<void>[] = [];

      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      // busboy stops emitting past a limit rather than failing, so a request
      // that trips one would otherwise look like a well-formed short upload.
      busboy.on("filesLimit", () => rejectOnce(new BadUpload("Only one file per request")));
      busboy.on("partsLimit", () => rejectOnce(new BadUpload("Too many multipart parts")));
      busboy.on("fieldsLimit", () => rejectOnce(new BadUpload("Too many form fields")));

      busboy.on("file", (_field, fileStream, info) => {
        sawFile = true;
        const leaf = safeLeafName(info.filename);
        if (!leaf) {
          fileStream.resume();
          rejectOnce(new BadUpload("Invalid filename"));
          return;
        }
        // Storage name is ours, display name is theirs. Deriving the path from
        // the client filename alone means two uploads called screenshot.png
        // land on the same file, and the second silently rewrites the bytes an
        // earlier chat message already points at — `createWriteStream` opens
        // "w", which truncates. The uuid prefix also makes the exclusive open
        // below a genuine collision check rather than a formality.
        const storageName = `${randomUUID()}-${leaf}`;
        const dest = resolveDest(dirReal, storageName);
        if (!dest) {
          fileStream.resume();
          rejectOnce(new BadUpload("Invalid destination"));
          return;
        }
        fileName = leaf;
        destPath = dest;
        written = dest;
        // busboy raises `limit` and then ends the stream, so the pipeline would
        // otherwise resolve on a truncated file and hand back a path to it.
        fileStream.on("limit", () => rejectOnce(new BadUpload("File exceeds the size limit", 413)));
        // "wx": never clobber. A path we just generated should not exist, and
        // if it does, something is wrong enough that overwriting is the worst
        // available answer.
        const write = pipeline(fileStream, fs.createWriteStream(dest, { flags: "wx" })).then(() => {});
        writes.push(write);
        pendingWrites.push(write);
        write.catch(rejectOnce);
      });

      busboy.on("finish", () => {
        if (!sawFile) {
          rejectOnce(new BadUpload("No file part"));
          return;
        }
        void Promise.all(writes)
          .then(() => {
            if (settled) return;
            settled = true;
            resolve({ name: fileName, path: destPath });
          })
          .catch(rejectOnce);
      });
      busboy.on("error", rejectOnce);

      const nodeStream = Readable.fromWeb(req.body as unknown as import("stream/web").ReadableStream);
      // Total-request guard. Per-file and per-field limits leave the sum
      // unbounded, so count what actually arrives and cut the stream off.
      let receivedBytes = 0;
      nodeStream.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_REQUEST_BYTES) {
          nodeStream.unpipe(busboy);
          nodeStream.destroy();
          rejectOnce(new BadUpload("Request exceeds the size limit", 413));
        }
      });
      nodeStream.on("error", rejectOnce);
      nodeStream.pipe(busboy);
    });
    return NextResponse.json({ ok: true, name: result.name, path: result.path });
  } catch (err) {
    // A rejected upload must not leave a partial file behind: the composer
    // would be told nothing, but a later request reusing the name would
    // silently inherit whatever bytes did land.
    if (written) {
      await Promise.allSettled(pendingWrites);
      try { await fsp.unlink(written); } catch { /* best effort */ }
    }
    // 400/413 only for input the caller can fix. Anything else is ours —
    // a full disk, a permission problem — and reporting it as a client error
    // sends the user off debugging a request that was fine.
    const status = err instanceof BadUpload ? err.status : 500;
    return NextResponse.json(
      { error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` },
      { status },
    );
  }
}
