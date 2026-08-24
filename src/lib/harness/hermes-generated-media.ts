import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { chatGeneratedImageDir, resolveInMediaRoot } from "@/lib/harness/media-root";
import { hermesHome } from "@/lib/hermes-env";

/**
 * Bringing a picture the AGENT drew into the tree the chat can serve from.
 *
 * SERVER ONLY.
 *
 * THE PROBLEM. Hermes' image backends save into `$HERMES_HOME/cache/images/`
 * and hand the model the path. `/setup-api/chat/media` reads from the chat
 * media root and nothing else, so the file exists, the reply names it, and the
 * browser cannot open it — the customer gets a sentence with an absolute device
 * path in it where a picture should be.
 *
 * WHY COPY AND NOT WIDEN THE READER. Adding a second allowed root to
 * `chat/media` would be one line and is the wrong line: that route's whole
 * defence is that it serves exactly one subtree, and every extra root is a new
 * thing to prove is safe to read from forever. The cache directory also holds
 * pictures from every channel this box has — WhatsApp, Discord, cron — and the
 * desktop chat has no business being able to enumerate those. Copying moves
 * exactly the files THIS turn produced and leaves the reader's contract alone.
 *
 * WHAT IS CHECKED BEFORE ANYTHING IS OPENED. The path arrives from the agent's
 * database, i.e. from a tool result the model's arguments influenced, so it is
 * treated as untrusted input all the way through:
 *
 *   1. absolute, or it is not a path this can resolve at all;
 *   2. an image extension `chat/media` will serve — a name is not evidence, but
 *      a name it would refuse is proof the copy is pointless;
 *   3. contained in the Hermes image cache AFTER symlink resolution, which is
 *      what stops `…/cache/images/link → ~/.hermes/.env` — the file with every
 *      provider key in it — from being copied into a tree the browser can read
 *      (CWE-59);
 *   4. a regular file, under a size cap.
 *
 * The copy's NAME is ours (a uuid), never the source's, and the destination is
 * re-checked with the same `resolveInMediaRoot` the CLI path uses.
 */

/** Extensions `chat/media` serves as pictures. `.svg` is deliberately absent. */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);

/**
 * The biggest picture worth adopting. A 1024×1024 PNG off the ClawBox AI proxy
 * measured 944 KB on the live box; this leaves room for a landscape render at
 * high quality and still refuses anything that could only be a mistake.
 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Dir 0700 and file 0600, matching the attachment staging tree next door. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Where every Hermes image backend writes — `save_b64_image` in the plugin ABC. */
export function hermesImageCacheDir(): string {
  return path.join(hermesHome(), "cache", "images");
}

/**
 * Copy the pictures this turn drew into the chat media root.
 *
 * Returns the absolute paths of the COPIES, in the order the originals were
 * given, skipping any that failed a check — a picture that cannot be adopted
 * costs a thumbnail, never the reply it came with, so nothing here throws.
 */
export async function adoptHermesGeneratedImages(
  sources: readonly string[],
): Promise<string[]> {
  if (!sources.length) return [];
  let cacheRoot: string;
  try {
    cacheRoot = await fsp.realpath(hermesImageCacheDir());
  } catch {
    // No cache directory means nothing was ever drawn on this box, so nothing
    // can be inside it.
    return [];
  }

  const adopted: string[] = [];
  for (const source of sources) {
    const copied = await adoptOne(source, cacheRoot);
    if (copied) adopted.push(copied);
  }
  return adopted;
}

async function adoptOne(source: string, cacheRoot: string): Promise<string | null> {
  try {
    if (typeof source !== "string" || !path.isAbsolute(source)) return null;
    if (!IMAGE_EXT.has(path.extname(source).toLowerCase())) return null;

    // Lexical containment first, on the string, before any filesystem call sees
    // it — then the absolute path is REBUILT from the trusted root plus the
    // cleared segment, so what reaches `realpath` is not carried down from the
    // record. Same shape as `chat/media` and for the same reason: it keeps the
    // guard tied to the sink where a `startsWith` comparison does not.
    const rel = path.relative(cacheRoot, path.resolve(source));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const candidate = path.join(cacheRoot, rel);

    // Then symlinks, which the lexical check cannot see.
    const real = await fsp.realpath(candidate);
    if (real !== cacheRoot && !real.startsWith(cacheRoot + path.sep)) return null;

    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null;

    const dir = await chatGeneratedImageDir();
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
    // `mkdir`'s mode is ignored when the directory already exists, so an older
    // build (or a umask) may have left it at 0755. Best effort, as elsewhere.
    await fsp.chmod(dir, DIR_MODE).catch(() => {});

    // A uuid, and the extension of the file we just verified — never the
    // source's name, which the model had a hand in.
    const target = path.join(dir, `agent-${randomUUID()}${path.extname(real).toLowerCase()}`);
    await fsp.copyFile(real, target);
    await fsp.chmod(target, FILE_MODE).catch(() => {});

    // The destination gets the same containment check every other ref in this
    // chat gets, so "inside the media root" is a checked fact rather than a
    // claim about a path we built.
    return await resolveInMediaRoot(target);
  } catch {
    // A vanished file, a permission error, a full disk. All of them mean this
    // one picture is not adopted, and none of them may cost the reply.
    return null;
  }
}
