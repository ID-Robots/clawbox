/**
 * The desktop icon and the favicon of a CODING-AGENT PROJECT. SERVER ONLY.
 *
 * `src/lib/webapp-icon.ts` draws an icon for a web app the agent created,
 * because a web app has a tile on the desktop and the tile was empty. A
 * project a delegated run works in had neither: a folder under ~/Projects has
 * no desktop presence at all, and the site it builds shipped with the
 * browser's default document glyph in the tab. Both are the same picture, so
 * this is the same pipeline — the generation, the box-wide slot, the failure
 * cooldowns and the never-overwrite placement all come from webapp-icon; what
 * is added here is where the picture ALSO lands:
 *
 *   data/icons/<id>.png   256 px — what /setup-api/apps/icon/<id> serves, so
 *                         the Coding Agent app's project row has an icon and a
 *                         later `registerWebappInPreferences` finds one
 *                         already there ('kept') rather than paying again;
 *   <project>/favicon.png  64 px — what the pages the run writes link to;
 *   <project>/favicon.ico  the same 64 px PNG inside a one-entry ICO, for the
 *                         browsers and crawlers that still ask for /favicon.ico.
 *
 * THE RULES it inherits and the two it adds:
 *
 *   - NEVER OVERWRITES, anywhere. The icon is placed with `link` (webapp-icon)
 *     and both favicons with 'wx', so a favicon the run or the owner wrote
 *     themselves always wins. This runs while the run is working, and losing
 *     that race must mean "theirs stays", not "ours does".
 *   - NEVER THROWS and never blocks its caller: the runner fires it with
 *     `void` at the start of a run. A project without an icon is cosmetic.
 *   - ONLY FOR A FOLDER THAT IS STILL THERE. A run can be stopped and its
 *     folder removed inside the 5–15 s generation window; an icon written
 *     after that is an orphan.
 *   - A PROJECT ALREADY DRAWN IS NOT REDRAWN, but its favicons are still
 *     written from the icon on disk — a box that had the icon before this
 *     existed, or a project whose favicon the owner deleted, must not have to
 *     spend a second picture to get one.
 */
import fsp from "fs/promises";
import path from "path";
import {
  ensureIconFile,
  isPng,
  safeAppId,
  shrinkIcon,
  webappIconPath,
  type WebappIconOutcome,
} from "@/lib/webapp-icon";

/** What the pages of a project link to, and what a browser asks for by name. */
export const FAVICON_PNG = "favicon.png";
export const FAVICON_ICO = "favicon.ico";

/**
 * 64 px, which is what a favicon is: the tab renders it at 16 CSS px and a
 * pinned tile at 32, so this is crisp on a 2× display and still a few
 * kilobytes rather than the icon's hundred.
 */
const FAVICON_PX = 64;

/** Public assets, like the icon beside them. */
const FAVICON_MODE = 0o644;

export interface ProjectIconTarget {
  /**
   * The id the icon is filed under — the project's folder name, which is also
   * the id a web app for that folder would use, so the desktop and this agree
   * without either of them being told.
   */
  id: string;
  /** The project folder itself: where the two favicons go. */
  directory: string;
  /** What to call it in the prompt. The folder's name will do. */
  name: string;
  /** What it is, in a line: the run's task, or the project's description. */
  description?: string;
}

export interface ProjectIconOutcome {
  icon: WebappIconOutcome;
  /** Whether either favicon was written by THIS call. */
  favicon: boolean;
}

/**
 * Draw this project's icon and favicons, if it has none. Resolves to what
 * happened and never rejects — callers are expected to `void` it.
 */
export async function ensureProjectIcon(target: ProjectIconTarget): Promise<ProjectIconOutcome> {
  const id = safeAppId(target.id);
  // An id the icon route would refuse is an icon nothing could ever fetch.
  if (!id || !target.directory) return { icon: "skipped", favicon: false };
  let favicon = false;
  try {
    const icon = await ensureIconFile(
      id,
      { name: target.name || id, description: target.description },
      {
        stillWanted: () => isDirectory(target.directory),
        // The 1024 px original, before it is thrown away: the favicon is a
        // different size, and this is the one moment the full picture exists.
        onBytes: async (bytes) => {
          favicon = await writeFavicons(target.directory, bytes);
        },
      },
    );
    // 'kept' means the icon was already on disk and nothing was generated —
    // the favicons still have to be derived, from that file rather than from a
    // second picture.
    if (icon === "kept" && !favicon) {
      const existing = await fsp.readFile(webappIconPath(id)).catch(() => null);
      if (existing && isPng(existing)) favicon = await writeFavicons(target.directory, existing);
    }
    return { icon, favicon };
  } catch (err) {
    warn(id, err instanceof Error ? err.message : String(err));
    return { icon: "skipped", favicon: false };
  }
}

/**
 * Write favicon.png and favicon.ico beside the project, never over what is
 * there. Answers whether either file is new.
 */
async function writeFavicons(directory: string, source: Buffer): Promise<boolean> {
  const small = await shrinkIcon(source, FAVICON_PX);
  // If sharp could not load its native binding it hands back the original;
  // a 1024 px favicon is still a favicon, and better than none.
  const png = await placeNew(path.join(directory, FAVICON_PNG), small);
  const ico = await placeNew(path.join(directory, FAVICON_ICO), icoFromPng(small, FAVICON_PX));
  return png || ico;
}

/**
 * A one-entry ICO whose single image is the PNG itself.
 *
 * Hand-assembled because sharp cannot write .ico, and because the format for
 * this case is twenty-two bytes of header in front of bytes we already have:
 * every browser since IE11 reads a PNG-payload ICO, and a BMP encoder for the
 * ones that do not would be a real dependency for a file nothing on this box
 * renders.
 *
 * ICONDIR:      reserved 0, type 1 (icon), one image.
 * ICONDIRENTRY: width and height as single bytes (0 would mean 256, which is
 *               why a 256 px favicon is not what this writes), no palette,
 *               one plane, 32 bits per pixel, then the payload's length and
 *               its offset — 6 + 16, the only place it can start.
 */
export function icoFromPng(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size >= 256 ? 0 : size, 6);
  header.writeUInt8(size >= 256 ? 0 : size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

/**
 * Write the file only if that name is free.
 *
 * 'wx' asks and writes in one syscall, so a favicon the run saved between a
 * "does it exist" check and the write is stepped over rather than replaced —
 * the same guarantee webapp-icon's `link` makes for the icon.
 */
async function placeNew(target: string, bytes: Buffer): Promise<boolean> {
  try {
    await fsp.writeFile(target, bytes, { flag: "wx", mode: FAVICON_MODE });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fsp.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** One line, the project and the reason — never the prompt, which is the task. */
function warn(id: string, reason: string): void {
  console.warn(`[project-icon] could not draw an icon for "${id}" (continuing): ${reason}`);
}
