import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  chatGeneratedImageDir,
  GENERATED_IMAGE_RETENTION,
  pruneMediaDir,
  resolveInMediaRoot,
} from "@/lib/harness/media-root";
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

/**
 * The most pictures one turn may bring in.
 *
 * The turn record already stops at four rows; the model's own MENTIONS do not
 * stop at anything, and every one of them is a copy made AFTER the sweep that
 * was supposed to make room. Without a bound here a reply listing fifty cache
 * paths would push the tree that far past `GENERATED_IMAGE_RETENTION.maxBytes`
 * in one turn, and the next sweep would then throw away pictures older
 * customers can still see in their transcript. Four matches the record's own
 * cap, and a bubble showing more than four thumbnails is not a bubble anyone
 * asked for.
 */
const MAX_ADOPTED_PER_TURN = 4;

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

  // Swept before anything is copied in, by the same rule and into the same
  // directory the composer path sweeps — a box whose agent has a backend never
  // takes the composer path again, so a sweep that lived only there would let
  // this tree grow without a bound for the rest of the device's life. Best
  // effort: a failed sweep must never cost the customer their picture.
  await chatGeneratedImageDir()
    .then((dir) => pruneMediaDir(dir, GENERATED_IMAGE_RETENTION))
    .catch(() => {});

  const adopted: string[] = [];
  // One card per FILE: the same picture can arrive both from its tool row and
  // from the model's own mention of the path, and adopting it twice would put
  // two identical cards in one bubble.
  const seen = new Set<string>();
  for (const source of sources) {
    if (adopted.length >= MAX_ADOPTED_PER_TURN) break;
    if (seen.has(source)) continue;
    seen.add(source);
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

// ── Image mentions the model itself wrote into the reply ────────────────────
//
// The image backend answers the model with the SAVED FILE'S ABSOLUTE PATH, and
// models repeat it — observed on the hardware box (2026-08-25) both as a
// "MEDIA:/home/clawbox/.hermes/cache/images/….png" directive and as an
// "[Image: …]" aside. `settleTurn` appends its own MEDIA: directive for the
// ADOPTED copy of that same file, so a mention left in the caption was lifted
// by `splitAssistantMedia` as a SECOND image whose cache path `chat/media`
// refuses by design: every generated picture rendered as a broken card beside
// the real one. One generation must render exactly one card.
//
// A mention is therefore not just dropped — it is handed back as a SOURCE, so
// a picture whose tool row never reached `generatedImages` is still adopted
// off the model's own words.
//
// Only paths INSIDE THE IMAGE CACHE are reclaimed, and the bound is not a
// preference: `adoptOne` refuses everything else, so a mention taken out of
// the caption and then refused by adoption is information destroyed for
// nothing — the reply loses a picture the chat could have served. A path the
// chat media root already holds (a file the customer attached, echoed back by
// the model) is exactly that case, and it stays where it is for
// `splitAssistantMedia` to lift, the way it did before any of this landed.
// A remote URL in a MEDIA: line is likewise left alone, because nothing here
// can prove it broken, and audio directives are not image business at all.

const MEDIA_DIRECTIVE_RE = /^media:\s*(.+)$/i;
const IMAGE_MENTION_RE = /\[image:\s*([^\]\n]+)\]/gi;
const FENCE_RE = /^(?:```|~~~)/;

/** Strips one layer of the quoting a model tends to wrap a path in. */
function unquoted(value: string): string {
  for (const quote of ["`", '"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/** The local absolute image path a mention names, or null to leave it alone. */
function reclaimable(raw: string, cacheDir: string): string | null {
  const value = unquoted(raw.trim());
  if (!path.isAbsolute(value)) return null;
  if (!IMAGE_EXT.has(path.extname(value).toLowerCase())) return null;
  // Lexical only: this decides what to take OUT of a caption, and the
  // filesystem checks that decide what may be COPIED live in `adoptOne`,
  // which re-resolves symlinks against the same root.
  const rel = path.relative(cacheDir, path.resolve(value));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return value;
}

/**
 * Splits the model's own image-path mentions out of a reply.
 *
 * Returns the caption with those mentions removed, and the paths they named —
 * in order, de-duplicated — for `adoptHermesGeneratedImages` to judge. Only
 * paths lexically inside the Hermes image cache are taken, which is the set
 * adoption can accept at all; the adoption path then re-checks that same
 * containment through `realpath`, so nothing here has to decide what is safe
 * to READ, only what is worth taking out of a sentence. Fenced code blocks are
 * left untouched: a reply that explains the syntax is still allowed to show
 * it.
 */
export function reclaimImageMentions(raw: string): { text: string; sources: string[] } {
  if (!raw || (!/media:/i.test(raw) && !/\[image:/i.test(raw))) return { text: raw, sources: [] };
  const cacheDir = hermesImageCacheDir();
  const sources: string[] = [];
  const keep = (source: string) => {
    if (!sources.includes(source)) sources.push(source);
  };
  const kept: string[] = [];
  let inFence = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    const directive = MEDIA_DIRECTIVE_RE.exec(trimmed);
    if (directive) {
      const source = reclaimable(directive[1], cacheDir);
      if (source) {
        keep(source);
        continue; // the whole line was machinery; nothing of it stays
      }
      kept.push(line);
      continue;
    }
    // "[Image: /abs/path.png]" asides go; the sentence around them stays.
    const scrubbed = line.replace(IMAGE_MENTION_RE, (whole, payload: string) => {
      const source = reclaimable(payload, cacheDir);
      if (!source) return whole;
      keep(source);
      return "";
    });
    kept.push(scrubbed === line ? line : scrubbed.replace(/ {2,}/g, " ").replace(/[ \t]+$/, ""));
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, sources };
}
