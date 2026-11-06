// File naming and validation for saved screenshots. Pure and dependency-free:
// the browser uses it to propose a name, the route to decide whether to trust
// one. Where the file lands on disk is store.ts's business.

/** The folder under the Files app's root that screenshots are saved into. */
export const SCREENSHOTS_DIR = "Screenshots";

/**
 * The largest image the save route accepts.
 *
 * Under 10 MiB on purpose: Next buffers a request body for the middleware and
 * keeps only its first 10 MiB (`proxyClientMaxBodySize`'s default) WITHOUT
 * failing the request, so a larger upload would arrive cut short. A ceiling
 * below that, checked in the browser before anything is sent, turns a
 * truncated PNG into a sentence the owner can act on.
 */
export const MAX_SCREENSHOT_BYTES = 9 * 1024 * 1024;

/** How many of the newest screenshots the app lists. */
export const MAX_RECENT_SCREENSHOTS = 60;

export type ScreenshotFormat = "png" | "jpg";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,99}\.(png|jpe?g)$/i;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `Screenshot_2026-10-10_14-51-07.png` — sortable, and safe on every filesystem. */
export function screenshotFileName(date: Date, format: ScreenshotFormat): string {
  const stamp =
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `Screenshot_${stamp}.${format}`;
}

/**
 * Whether `name` may be a file in the screenshots folder: ONE path segment of
 * plain characters ending in an image extension. Everything that could walk
 * out of the folder — a separator, a `..`, a leading dot, a NUL — is refused
 * here by not being on the list, before any path is built from it.
 */
export function isValidScreenshotName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (!NAME_PATTERN.test(name)) return false;
  if (name.includes("..")) return false;
  // "name .png" and "name..png" are how a look-alike of another file is made.
  const stem = name.slice(0, name.lastIndexOf("."));
  return !/[ .]$/.test(stem);
}

export function screenshotFormatOf(name: string): ScreenshotFormat | null {
  const ext = /\.([A-Za-z]+)$/.exec(name)?.[1].toLowerCase();
  if (ext === "png") return "png";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  return null;
}

/** What the bytes really are, from their signature — the extension is only a claim. */
export function sniffImageFormat(bytes: Uint8Array): ScreenshotFormat | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/**
 * `name`, or `name-2`, `name-3` … — the first that `taken` does not hold, so a
 * second capture in the same second never overwrites the first. Compared
 * without case: the folder may sit on a filesystem that ignores it.
 */
export function uniqueScreenshotName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const entry of taken) used.add(entry.toLowerCase());
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** The path the Files app knows the screenshot by, relative to its root. */
export function screenshotRelPath(name: string): string {
  return `${SCREENSHOTS_DIR}/${name}`;
}

/** `/setup-api/files/Screenshots/<name>` — the Files route that serves the image back. */
export function screenshotUrl(name: string, version?: number | string): string {
  const base = `/setup-api/files/${SCREENSHOTS_DIR}/${encodeURIComponent(name)}`;
  return version === undefined ? base : `${base}?v=${encodeURIComponent(String(version))}`;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
