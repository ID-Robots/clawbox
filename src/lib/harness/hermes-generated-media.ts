import fsp from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import {
  chatGeneratedImageDir,
  chatMediaRoot,
  GENERATED_IMAGE_RETENTION,
  pruneMediaDir,
  resolveInMediaRoot,
} from "@/lib/harness/media-root";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";
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
 *   3. contained in one of the adoption roots AFTER symlink resolution, and
 *      cleared by that root's secret guard. This is what stops
 *      `…/cache/images/link → ~/.hermes/.env` — the file with every provider
 *      key in it — from being copied into a tree the browser can read
 *      (CWE-59), and what keeps `~/.ssh/anything.png` out of it too;
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
 * A tree a picture may be adopted OUT of.
 *
 * `guarded` says whether the Files API's secret rule applies inside it. It is
 * not a convenience flag — it is the difference between the two kinds of root
 * here, and getting it wrong breaks one path or the other:
 *
 *  - The image cache is a CARVE-OUT. It lives under `~/.hermes`, and
 *    `isProtectedFilePath` refuses the whole of `~/.hermes` because that is
 *    where `config.yaml`, `.env` and `auth.json` are. Running the guard over
 *    the cache would refuse every picture the ClawBox AI backend has ever
 *    drawn — the working path. Containment plus `realpath` is what makes this
 *    subtree safe, and that is exactly what is checked below.
 *  - Every other root is GUARDED, because it is a tree the customer's own files
 *    are in and the guard is the only thing keeping `~/.ssh/x.png`, a `.netrc`,
 *    or anything under `DATA_DIR` out of a browser-readable copy.
 */
interface AdoptionRoot {
  /** Symlink-resolved, so containment can be decided against a real path. */
  real: string;
  /** Apply `isProtectedFilePath` to what is found inside this root. */
  guarded: boolean;
}

/**
 * Where a picture may come from, in the order the roots are tried.
 *
 * WHY MORE THAN THE CACHE. A box with no ClawBox AI link has no image tool at
 * all, and an agent asked for a picture anyway improvises with the shell:
 * observed on the owner's box (2026-08-26) hand-writing an SVG into its own
 * working directory and rasterising it with cairosvg. That file is real, valid
 * and 1024x1024 — and being outside the cache it was never adopted, so the
 * reply carried a card whose `src` 404s and whose download button saves the 21
 * bytes of `{"error":"Not found"}` under a `.png` name.
 *
 * WHY THIS IS NOT A NEW READ CAPABILITY. The agent's working directory IS the
 * Files API's browse root on this appliance, and that route already serves any
 * file in it to this same authenticated session, behind this same guard. What
 * changes is which of those files the chat will copy for itself, not which
 * files the session may read. Everything outside these roots — `/etc`, another
 * user's home, an absolute path the model simply invented — is refused, and a
 * refused picture costs a card, never the reply.
 */
async function adoptionRoots(): Promise<AdoptionRoot[]> {
  const roots: AdoptionRoot[] = [];
  const add = async (dir: string, guarded: boolean) => {
    if (!dir) return;
    try {
      const real = await fsp.realpath(dir);
      // A root nested inside an earlier one (the tests' fake HOME lives under
      // the tmp dir) must not be listed twice; first match wins below, so the
      // outer root would never be consulted for it anyway.
      if (!roots.some((root) => root.real === real)) roots.push({ real, guarded });
    } catch {
      // A root that does not exist on this box holds nothing to adopt.
    }
  };
  // The cache FIRST, and the order is load-bearing: it sits inside the browse
  // root, so a later, guarded root would otherwise claim it and the guard would
  // refuse it for being under `~/.hermes`.
  await add(hermesImageCacheDir(), false);
  // The chat's OWN tree, as a source as well as a destination. It is normally
  // never reached: `reclaimImageMentions` leaves a path this tree already holds
  // in the caption, precisely so an attachment the model echoed back is not
  // copied for no reason. This is the belt to that exemption's braces — if the
  // media root cannot be resolved at reclaim time, or a symlink hides it from
  // the lexical test, the mention IS reclaimed, and without this root the
  // DATA_DIR guard would then refuse it and the customer would lose a picture
  // that works today. Unguarded for the same reason as the cache: `chat/media`
  // already serves this exact tree to this exact session.
  await add(await chatMediaRoot().catch(() => ""), false);
  await add(filesBrowseRoot(), true);
  // Where a shell-improvising agent writes when it does not write beside itself.
  await add(os.tmpdir(), true);
  return roots;
}

/**
 * `abs` rebuilt from `root` when it is lexically inside it, else null.
 *
 * The path is REBUILT rather than returned as given, so what reaches the
 * filesystem is the trusted root plus a cleared relative segment instead of a
 * string carried down from the agent's database.
 */
function containedIn(root: string, abs: string): string | null {
  const rel = path.relative(root, path.resolve(abs));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.join(root, rel);
}

/**
 * The real file `abs` names, if any root will vouch for it.
 *
 * Two passes, and both are needed. Lexical containment picks the root that
 * rebuilds the path; `realpath` then re-decides which root the file is ACTUALLY
 * in, because a symlink can carry a name inside one root to a file inside
 * another — or outside all of them, which is
 * `…/cache/images/link -> ~/.hermes/.env`, the CWE-59 case this has refused
 * since #482. The guard that judges the file is the guard of the root the REAL
 * path lands in.
 */
async function resolveInAdoptionRoot(
  abs: string,
  roots: readonly AdoptionRoot[],
): Promise<string | null> {
  let candidate: string | null = null;
  for (const root of roots) {
    candidate = containedIn(root.real, abs);
    if (candidate) break;
  }
  if (!candidate) return null;
  const real = await fsp.realpath(candidate);
  for (const root of roots) {
    if (!containedIn(root.real, real)) continue;
    if (root.guarded && isProtectedFilePath(real)) return null;
    return real;
  }
  return null;
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
  const roots = await adoptionRoots();
  // No root resolves on this box, so there is nowhere a picture could be.
  if (!roots.length) return [];

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
  // Keyed on the RESOLVED path rather than the raw string: the tool row and the
  // model's own sentence name the same file, and they do not always spell it
  // the same way ("/home/clawbox/./a.png" is the second card nobody asked for).
  const seen = new Set<string>();
  for (const source of sources) {
    if (adopted.length >= MAX_ADOPTED_PER_TURN) break;
    const key = typeof source === "string" ? path.resolve(source) : String(source);
    if (seen.has(key)) continue;
    seen.add(key);
    const copied = await adoptOne(source, roots);
    if (copied) adopted.push(copied);
  }
  return adopted;
}

async function adoptOne(
  source: string,
  roots: readonly AdoptionRoot[],
): Promise<string | null> {
  try {
    if (typeof source !== "string" || !path.isAbsolute(source)) return null;
    if (!IMAGE_EXT.has(path.extname(source).toLowerCase())) return null;

    // Containment, symlinks and the secret guard, all decided together — see
    // `resolveInAdoptionRoot`. Nothing below this line has ever seen the string
    // the record carried; it has only the real path a root vouched for.
    const real = await resolveInAdoptionRoot(source, roots);
    if (!real) return null;

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
// WHAT IS RECLAIMED, AND WHY IT IS NOT JUST THE CACHE ANY MORE.
//
// #482 bounded this to the image cache on the reasoning that `adoptOne` refused
// everything else, so taking a mention out of a caption it could not replace
// destroyed information for nothing. That reasoning had a hole, and the owner's
// box (2026-08-26) fell straight through it: a mention this leaves in the
// caption is not left alone downstream — `splitAssistantMedia` lifts EVERY
// surviving `MEDIA:` line into a card, with no containment check anywhere, and
// `chat/media` then refuses the path it was handed. The result was the one
// outcome that is worse than no picture: a card with a dead thumbnail and a
// download button that saves 21 bytes of `{"error":"Not found"}` under a `.png`
// name.
//
// So the rule is inverted. Every LOCAL image path the model names is taken out
// of the caption and offered to adoption, and only what adoption actually
// copied comes back as a directive. A picture that can be served renders; one
// that cannot leaves the sentence and no card. The path itself is machinery in
// either case — an absolute device path in a chat bubble was never something
// to preserve.
//
// Three things are still left exactly where the model put them:
//   - a path the CHAT MEDIA ROOT already holds (the customer's own attachment,
//     echoed back), because `chat/media` serves that tree and
//     `splitAssistantMedia` lifting it is the behaviour that has always worked;
//   - a remote URL, because nothing here can prove it broken;
//   - anything that is not an image — audio directives are not image business.

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

/** A source the browser can already fetch on its own — left where it is. */
const REMOTE_RE = /^(?:https?:|data:)/i;

/**
 * `file:///abs/path` is a LOCAL path wearing a scheme, and treating it as
 * remote would be the whole bug again in miniature: `mediaUrl` strips the
 * scheme and asks `chat/media` for the path underneath, so a mention left in
 * the caption becomes a card that 404s exactly like a bare one. Stripped here
 * so adoption gets a real path to judge.
 */
const FILE_URL_RE = /^file:\/\/(?=\/)/i;

/** The local image path a mention names, or null to leave it alone. */
function reclaimable(raw: string, mediaRoot: string | null): string | null {
  const value = unquoted(raw.trim()).replace(FILE_URL_RE, "");
  if (!value || REMOTE_RE.test(value)) return null;
  if (!IMAGE_EXT.has(path.extname(value).toLowerCase())) return null;
  // Already servable: `chat/media` is rooted here, so this one really is better
  // off staying in the caption for `splitAssistantMedia` to lift.
  if (mediaRoot && path.isAbsolute(value) && containedIn(mediaRoot, value)) return null;
  // Everything else, ABSOLUTE OR NOT. A relative mention ("MEDIA:crab.png") is
  // reclaimed too and then refused by `adoptOne`, which is the point: left in,
  // it becomes a card resolving to `?path=crab.png` and a 404. Lexical only —
  // the filesystem checks that decide what may be COPIED live in `adoptOne`.
  return value;
}

/**
 * Splits the model's own image-path mentions out of a reply.
 *
 * Returns the caption with those mentions removed, and the paths they named —
 * in order, de-duplicated — for `adoptHermesGeneratedImages` to judge. Nothing
 * here decides what is safe to READ; it decides only what must not be allowed
 * to reach `splitAssistantMedia` as an unservable card. Fenced code blocks are
 * left untouched: a reply that explains the syntax is still allowed to show it.
 *
 * `mediaRoot` is the chat media root when the caller has resolved it — the one
 * tree whose paths are already servable and so stay in the caption. Passing
 * null simply means nothing gets that exemption.
 */
export function reclaimImageMentions(
  raw: string,
  mediaRoot: string | null = null,
): { text: string; sources: string[] } {
  if (!raw || (!/media:/i.test(raw) && !/\[image:/i.test(raw))) return { text: raw, sources: [] };
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
      const source = reclaimable(directive[1], mediaRoot);
      if (source) {
        keep(source);
        continue; // the whole line was machinery; nothing of it stays
      }
      kept.push(line);
      continue;
    }
    // "[Image: /abs/path.png]" asides go; the sentence around them stays.
    const scrubbed = line.replace(IMAGE_MENTION_RE, (whole, payload: string) => {
      const source = reclaimable(payload, mediaRoot);
      if (!source) return whole;
      keep(source);
      return "";
    });
    kept.push(scrubbed === line ? line : scrubbed.replace(/ {2,}/g, " ").replace(/[ \t]+$/, ""));
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, sources };
}
