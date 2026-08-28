import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { kvSet } from "@/lib/kv-store";
import { hasClawaiToken } from "@/lib/harness/credentials";
import { generateClawaiImage } from "@/lib/harness/clawai-images";

/**
 * A desktop icon for a web app that was created without one. SERVER ONLY.
 *
 * `webapp_create` and `code_project_build` put an app on the desktop with a
 * colour tile and a generic "extension" glyph, because the agent has no way to
 * draw. The box does: the same ClawBox AI credential the chat spends on
 * pictures serves an image model, and one 1024×1024 picture is exactly an icon.
 * So when an app lands with `meta.icon` empty, the box asks for one itself and
 * drops it where the icon route already looks —
 * `data/icons/<appId>.png`, the file `/setup-api/apps/icon/[appId]` serves
 * before it ever proxies the store.
 *
 * THE RULES, all of which exist because this runs behind a tool reply that has
 * already been sent:
 *
 *   - NEVER OVERWRITES. An icon that exists is either the store's cached one
 *     or an earlier generation, and both are worth more than a fresh roll of
 *     the dice. The final step is a `link`, which fails rather than clobbers.
 *   - NEVER THROWS, and never makes the caller wait. Generation takes 5–15 s
 *     against production; the route and the MCP tool answer first and this
 *     runs after (`void ensureWebappIcon(...)`). Every failure is one warn line
 *     and 'skipped' — a missing icon is cosmetic, a failed create is not.
 *   - SILENT WITHOUT A CREDENTIAL. An unlinked box is the normal case, not an
 *     error, so it costs one config read and no log line.
 *   - PNG OR NOTHING. The icon route answers `image/png` unconditionally, so
 *     bytes in any other format would be served under a lying Content-Type.
 *     The magic bytes decide, not the proxy's `output_format`.
 *   - THE PROMPT IS NEVER LOGGED. It carries the app's name and description,
 *     which the agent wrote from the customer's own words.
 *   - ONE PICTURE PER APP, ONE AT A TIME. Every picture is paid for out of the
 *     plan's daily allowance and buffers tens of megabytes on a Jetson while
 *     it downloads, and `code_project_build` fires this on EVERY rebuild of an
 *     app that has no icon yet. So a second call for an app whose picture is
 *     already being drawn joins that call instead of paying again, all
 *     generations go through one slot so a loop that creates N apps opens one
 *     upstream request rather than N, and an app whose generation failed is
 *     not retried for a while — a rebuild ten seconds later would only fail
 *     the same way. A refused credential or a spent allowance is box-wide, so
 *     that pause covers every app, not just the one that hit it.
 *   - ONLY FOR AN APP THAT STILL EXISTS. `app_uninstall` can run inside the
 *     generation window, and it removes the app's directory, its icon and its
 *     desktop entry. An icon written after that is an orphan nothing cleans
 *     up, and the desktop nudge below would put the uninstalled app BACK on
 *     the desktop (the handler is add-if-missing). So the app's `meta.json` is
 *     checked right before the write and again right before the nudge.
 *
 * The picture is generated INTO the chat media tree (that is the only place
 * `generateClawaiImage` writes) and moved out of it here: an icon is not a
 * chat picture, must not appear in a transcript, and must not be swept by the
 * 30-day retention that tree runs under.
 */

/** Where the icon route reads from. Same constant, same directory. */
export const ICONS_DIR = path.join(DATA_DIR, "icons");

/**
 * Where deployed apps live. Spelled out rather than imported from
 * code-projects.ts, which imports THIS module — the same constant, the same
 * directory, and no import cycle. `deployWebapp` writes the app's meta.json;
 * the uninstall route removes the whole directory.
 */
const WEBAPPS_DIR = path.join(DATA_DIR, "webapps");

/**
 * The icon route's own whitelist (`/setup-api/apps/icon/[appId]`, the same
 * rule as `APP_ID_RE` in code-projects.ts), repeated rather than imported so
 * this module cannot pull a Next.js route handler into a library: one to
 * sixty-four of these characters and nothing else. An id the route would
 * refuse is an icon nothing could ever fetch, so it is not worth generating.
 */
const APP_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
const MAX_APP_ID_CHARS = 64;

/**
 * The app id this module builds paths from, or null for anything else.
 *
 * Every path here — the icon, its temp file, the app's meta.json — is
 * `<dir>/<appId>…`, and the id arrives from a tool argument or a request
 * body. Rather than testing the id and then joining the ORIGINAL string, the
 * value that reaches `path.join` is assembled here, one character at a time,
 * out of the alphabet: whatever the caller sent, what is used downstream is
 * made of these characters and no more than this many of them. The rule is
 * exactly a regex test; it is written this way so the data flow itself shows
 * the cut — a `.test()` guard leaves the caller's string in play, and a
 * static analyser rightly keeps flagging every path built from it.
 */
export function safeAppId(appId: unknown): string | null {
  if (typeof appId !== "string" || appId.length < 1 || appId.length > MAX_APP_ID_CHARS) return null;
  let safe = "";
  for (const ch of appId) {
    const at = APP_ID_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    safe += APP_ID_ALPHABET[at];
  }
  return safe;
}

/** The 8-byte PNG signature; the icon route serves `image/png` and nothing else. */
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/** The desktop's own default tile colour (see webapp-registry.ts). */
const DEFAULT_COLOR = "#f97316";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * How much of the name and description reach the prompt. Both are agent-written
 * text; the name is already bounded at 60 by `assertProjectName`, and a
 * description longer than a sentence or two does not make a better glyph.
 */
const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 200;

/** Icons are public assets served to every browser; 0644 is the right mode. */
const ICON_FILE_MODE = 0o644;

/** The slot the desktop polls; see `notifyOwner` in email-notify.ts for the precedent. */
const UI_ACTION_KEY = "ui:pending-action";

/**
 * How long a failure is remembered. Long enough that an agent iterating on an
 * app (build, look, build again) does not pay for the same failure on every
 * pass; short enough that a transient proxy fault is retried within the
 * session. The box-wide pause is for the two answers that cannot change in
 * minutes — a refused credential and a spent daily allowance — and is longer
 * for that reason.
 */
const APP_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const BOX_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * The statuses `ClawaiImageError` carries for "the box, not the picture":
 * 503 is the credential (upstream 401/403), 429 is the allowance. Matched on
 * the status rather than `instanceof` because the number is the contract the
 * image module documents, and a mocked module has no class to match against.
 */
const BOX_WIDE_STATUSES = new Set([429, 503]);

export type WebappIconOutcome = "generated" | "kept" | "skipped";

export interface WebappIconHints {
  /** The name under the desktop icon. */
  name: string;
  /** The tile colour as `#rrggbb`; anything else falls back to the default. */
  color?: string;
  /** What the app does, when known: a project description or an HTML title. */
  description?: string;
}

/** Generations in progress, by app id: a repeat caller joins, never re-posts. */
const inFlight = new Map<string, Promise<WebappIconOutcome>>();

/** The one generation slot: the tail of a chain every generation waits on. */
let generationSlot: Promise<void> = Promise.resolve();

/** App ids whose last generation failed, and until when they are left alone. */
const appCooldownUntil = new Map<string, number>();

/** Until when NO app is tried, after the proxy refused the box itself. */
let boxCooldownUntil = 0;

/** Where the icon for this app lives, whether or not it exists yet. */
export function webappIconPath(appId: string): string {
  return path.join(ICONS_DIR, `${appId}.png`);
}

/** Collapse whitespace and cut, so the prompt stays one paragraph. */
function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The prompt for a DESKTOP APP ICON, as opposed to a picture.
 *
 * Exported so the test can pin what it must and must not ask for. Every
 * clause here is a constraint the desktop imposes, not taste: the tile behind
 * the icon is already the app's colour, so the background must match it; the
 * name is rendered as a label underneath, so any text in the picture is a
 * duplicate that will not match the label's font; and the tile is a rounded
 * square, so anything but a centred glyph gets clipped.
 */
export function buildIconPrompt(hints: WebappIconHints): string {
  const name = oneLine(hints.name, MAX_NAME_CHARS) || "an app";
  const description = oneLine(hints.description ?? "", MAX_DESCRIPTION_CHARS);
  const color = hints.color && HEX_COLOR_RE.test(hints.color) ? hints.color : DEFAULT_COLOR;
  const about = description ? ` The app: ${description}.` : "";
  return (
    `A desktop app icon for an app called "${name}".${about} ` +
    "Flat, minimal design: one single centred glyph that represents the app, " +
    `on a solid ${color} background filling the whole image, ` +
    "soft rounded-square framing, high contrast, clean vector look. " +
    "No text, no letters, no words, no numbers, no watermark, no border, no drop shadow, " +
    "no photo. 1024x1024."
  );
}

/**
 * How much of a page is searched for its title. A hint, not a parse: any real
 * page names itself in its first few kilobytes, and the work here must not
 * grow with the size of the create — `webapp_create` accepts megabytes.
 */
const MAX_HINT_SCAN_CHARS = 64 * 1024;

/** The elements a page names itself in, in order of preference. */
const HINT_ELEMENTS: { open: RegExp; close: RegExp }[] = [
  { open: /<title(?=[\s/>])/i, close: /<\/title\s*>/gi },
  { open: /<h1(?=[\s/>])/i, close: /<\/h1\s*>/gi },
];

/** The entities worth decoding for a prompt; the rest are left as written. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

/**
 * A one-line description pulled from a page, for a create that carried none.
 *
 * `webapp_create` sends HTML and a name and nothing else, so the closest thing
 * to "what is this app" is what the page calls itself: its `<title>`, else its
 * first `<h1>`. Tags inside are dropped, the common entities are decoded, and
 * the result is one bounded line — it feeds a prompt, not a renderer.
 */
export function htmlHint(html: string): string {
  if (typeof html !== "string" || !html) return "";
  const page = html.slice(0, MAX_HINT_SCAN_CHARS);
  for (const element of HINT_ELEMENTS) {
    const inner = elementText(page, element);
    if (inner === null) continue;
    const line = oneLine(decodeEntities(stripTags(inner)), MAX_DESCRIPTION_CHARS);
    if (line) return line;
  }
  return "";
}

/**
 * The text between the first `<tag …>` and the `</tag>` after it, or null.
 *
 * Three positions looked up in turn rather than `<tag[^>]*>([\s\S]*?)</tag>`:
 * that pattern rescans to the end of the page from every `<tag` it fails to
 * close, which is quadratic on exactly the input an agent can send.
 */
function elementText(page: string, element: { open: RegExp; close: RegExp }): string | null {
  const start = element.open.exec(page);
  if (!start) return null;
  const from = page.indexOf(">", start.index + start[0].length);
  if (from < 0) return null;
  // A global pattern searches from `lastIndex`; it is set on every call, so
  // the shared object carries nothing over from the previous page.
  element.close.lastIndex = from + 1;
  const end = element.close.exec(page);
  if (!end) return null;
  return page.slice(from + 1, end.index);
}

/**
 * Drop the tags inside the text: everything from a `<` to the next `>`, and
 * a `<` that nothing closes is left as written. The same reading as
 * `/<[^>]*>/g`, in one forward pass — that pattern rescans to the end of the
 * text from every `<` once one of them has no `>`, which is quadratic.
 */
function stripTags(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<", at);
    if (open < 0) return out + text.slice(at);
    const close = text.indexOf(">", open + 1);
    if (close < 0) return out + text.slice(at);
    out += `${text.slice(at, open)} `;
    at = close + 1;
  }
}

/**
 * One pass with a table, so what a decode produces is never decoded again:
 * `&amp;lt;` is the four characters `&lt;`, not `<`.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name: string) => ENTITIES[name]);
}

/**
 * Make sure `data/icons/<appId>.png` exists, generating it when the box can.
 *
 * Resolves to what happened and NEVER rejects — see the module comment for why
 * each outcome is what it is. Callers are expected to `void` it.
 *
 * Deliberately not `async`: the in-flight map must be consulted and filled
 * before the first `await`, or two calls in the same tick would both miss it
 * and both post a generation — the very thing the map exists to stop.
 */
export function ensureWebappIcon(appId: string, hints: WebappIconHints): Promise<WebappIconOutcome> {
  // From here on only the rebuilt id exists: every path below is joined from
  // `id`, never from the argument.
  const id = safeAppId(appId);
  if (!id) return Promise.resolve("skipped");
  const pending = inFlight.get(id);
  if (pending) return pending;
  const job = ensureOnce(id, hints)
    .catch((err: unknown): WebappIconOutcome => {
      // `ensureOnce` catches its own; this is belt and braces so the map can
      // never hold a rejected promise that a later caller would be handed.
      warn(id, err instanceof Error ? err.message : String(err));
      return "skipped";
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

async function ensureOnce(appId: string, hints: WebappIconHints): Promise<WebappIconOutcome> {
  const target = webappIconPath(appId);
  if (await exists(target)) return "kept";
  if (coolingDown(appId)) return "skipped";
  if (!(await hasClawaiToken())) return "skipped";

  return withGenerationSlot(async () => {
    // The wait for the slot can be long (a queue of creates, each 5–15 s);
    // what was true before it may not be now. Both checks are one stat.
    if (await exists(target)) return "kept";
    if (!(await appExists(appId))) return "skipped";

    let generatedPath: string | null = null;
    let placed = false;
    try {
      const result = await generateClawaiImage(buildIconPrompt(hints));
      generatedPath = result.path;
      const bytes = await fsp.readFile(generatedPath);
      if (!isPng(bytes)) {
        warn(appId, "the picture was not a PNG");
        rememberFailure(appId);
        return "skipped";
      }
      // The app may have been uninstalled while the picture was drawn.
      if (!(await appExists(appId))) return "skipped";
      const outcome = await placeIcon(target, await shrinkIcon(bytes));
      if (outcome === "exists") return "kept";
      placed = true;
    } catch (err) {
      warn(appId, err instanceof Error ? err.message : String(err));
      rememberFailure(appId, err);
      return "skipped";
    } finally {
      // Whatever happened, the media-tree copy is not a chat picture and must
      // not linger where the transcript reader could serve it.
      if (generatedPath) await fsp.unlink(generatedPath).catch(() => {});
    }

    // Checked once more before the nudge, because the nudge is what would
    // resurrect an uninstalled app. An uninstall that landed between the
    // check above and the `link` has already removed the icon it knew about,
    // so the one just placed is taken back too rather than left as an orphan.
    if (placed && !(await appExists(appId))) {
      await fsp.unlink(target).catch(() => {});
      return "skipped";
    }
    nudgeDesktop(appId, hints);
    return "generated";
  });
}

/**
 * Run `fn` when no other generation is running.
 *
 * A promise chain rather than a counter: each caller waits on the previous
 * caller's completion and hands its own to the next, so order is arrival order
 * and a throw inside `fn` releases the slot like a return does.
 */
async function withGenerationSlot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = generationSlot;
  let release!: () => void;
  generationSlot = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Is this app, or the whole box, inside a failure pause? */
function coolingDown(appId: string): boolean {
  const now = Date.now();
  if (now < boxCooldownUntil) return true;
  const until = appCooldownUntil.get(appId);
  if (until === undefined) return false;
  if (now < until) return true;
  appCooldownUntil.delete(appId);
  return false;
}

/**
 * Note a failure so the next rebuild does not repeat it.
 *
 * Expired entries are dropped on the way in, so the map is bounded by the
 * number of apps that failed in the last few minutes rather than ever.
 */
function rememberFailure(appId: string, err?: unknown): void {
  const now = Date.now();
  for (const [id, until] of appCooldownUntil) {
    if (until <= now) appCooldownUntil.delete(id);
  }
  appCooldownUntil.set(appId, now + APP_FAILURE_COOLDOWN_MS);
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  if (typeof status === "number" && BOX_WIDE_STATUSES.has(status)) {
    boxCooldownUntil = now + BOX_FAILURE_COOLDOWN_MS;
  }
}

/** The desktop draws an icon at 48 CSS px at most; 256 is crisp on a 4× display. */
const ICON_PX = 256;

/**
 * Bring the picture down to icon size.
 *
 * The proxy answers 1024×1024 (~1.1 MB of PNG per icon); a desktop with a
 * dozen generated apps would ship a dozen megabytes of icons on every load
 * over the tunnel. `sharp` is already a dependency (Next's image optimiser),
 * loaded lazily so a box where its native binding will not load keeps the
 * full-size picture rather than no icon at all.
 */
async function shrinkIcon(bytes: Buffer): Promise<Buffer> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(bytes).resize(ICON_PX, ICON_PX, { fit: "cover" }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return bytes;
  }
}

/**
 * Put the bytes at `target` without ever replacing what is there.
 *
 * A temp file in the same directory takes the whole write, then a hard LINK
 * gives it its final name: `link` is atomic like `rename` but fails with
 * EEXIST where `rename` would silently overwrite, which is the guarantee the
 * module comment makes. The temp name is removed either way.
 */
async function placeIcon(target: string, bytes: Buffer): Promise<"placed" | "exists"> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tmp, bytes, { mode: ICON_FILE_MODE });
    // `writeFile`'s mode is masked by the umask; the icon has to be readable
    // by the web server whatever the umask was.
    await fsp.chmod(tmp, ICON_FILE_MODE).catch(() => {});
    try {
      await fsp.link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw err;
    }
    return "placed";
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * Tell an open desktop the icon is there.
 *
 * The desktop remembers a source that 404'd for as long as its props stay the
 * same, and the app was registered BEFORE this icon existed, so it has to be
 * told. The message is the same `register_webapp` action the MCP tool pushes
 * when it creates the app — the handler in page.tsx is idempotent on the app
 * list and rewrites `iconUrl`, and a changed `iconUrl` is what makes
 * `InstalledAppIcon` try again. The `?v=` makes the new URL differ from the
 * old empty one, from any earlier generation's, and from whatever the browser
 * has cached under the bare URL for an app that once used this id.
 *
 * Best effort and one-way, like `notifyOwner`: the icon is on disk and the
 * next desktop load finds it whether or not this lands. The slot is
 * single-consumer, so a push can replace an action nobody has read yet — the
 * same property every other writer of this key already has.
 */
function nudgeDesktop(appId: string, hints: WebappIconHints): void {
  try {
    const color = hints.color && HEX_COLOR_RE.test(hints.color) ? hints.color : DEFAULT_COLOR;
    kvSet(
      UI_ACTION_KEY,
      JSON.stringify({
        type: "register_webapp",
        appId,
        name: oneLine(hints.name, MAX_NAME_CHARS) || appId,
        color,
        url: `/setup-api/webapps?app=${appId}`,
        iconUrl: `/setup-api/apps/icon/${appId}?v=${Date.now()}`,
        ts: Date.now(),
      }),
    );
  } catch {
    // A nudge that fails to land is a reload away from being moot.
  }
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/** Is the app still deployed? Its meta.json goes when the app is uninstalled. */
function appExists(appId: string): Promise<boolean> {
  return exists(path.join(WEBAPPS_DIR, appId, "meta.json"));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** One line, the app id and the reason — never the prompt. */
function warn(appId: string, reason: string): void {
  console.warn(`[webapp-icon] could not generate an icon for "${appId}" (continuing): ${reason}`);
}
