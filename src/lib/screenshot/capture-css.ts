// The string work behind the DOM capture (dom-capture.ts): which @font-face
// blocks a snapshot needs, where the URLs in a CSS value are, and what has to
// be stripped before markup is valid XML. Pure, so it is unit tested without a
// browser; the fetching and the drawing stay in dom-capture.ts.

const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;
const FONT_FACE_PATTERN = /@font-face\s*\{[^}]*\}/gi;

/** Every `url(...)` target in a CSS value, in order, without its quotes. */
export function cssUrls(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    const url = match[1] ?? match[2] ?? match[3] ?? "";
    if (url) found.push(url);
  }
  return found;
}

/** `value` with each `url(...)` target passed through `replace`; null keeps the original. */
export function replaceCssUrls(value: string, replace: (url: string) => string | null): string {
  return value.replace(URL_PATTERN, (whole, dq?: string, sq?: string, bare?: string) => {
    const url = dq ?? sq ?? bare ?? "";
    if (!url) return whole;
    const next = replace(url);
    return next === null ? whole : `url("${next.replace(/"/g, "%22")}")`;
  });
}

export function normalizeFontFamily(family: string): string {
  return family.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

/** `U+0000-00FF, u+131` → `U+0-FF,U+131`, so two spellings of one range compare equal. */
export function normalizeUnicodeRange(range: string): string {
  return range
    .split(",")
    .map((part) =>
      part
        .trim()
        .toUpperCase()
        .replace(/^U\+/, "")
        .split("-")
        .map((hex) => hex.replace(/^0+(?=[0-9A-F?])/, ""))
        .join("-"),
    )
    .filter(Boolean)
    .map((part) => `U+${part}`)
    .join(",");
}

export interface FontFaceBlock {
  /** The whole `@font-face { … }` rule as written. */
  text: string;
  family: string;
  /** Normalized, or "" when the rule covers everything. */
  unicodeRange: string;
  /** The font file to embed: the woff2 source when there is one, else the first. */
  url: string | null;
}

function descriptor(block: string, name: string): string {
  const match = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, "i").exec(block);
  return match ? match[1].trim() : "";
}

export function parseFontFaces(css: string): FontFaceBlock[] {
  const blocks: FontFaceBlock[] = [];
  for (const match of css.matchAll(FONT_FACE_PATTERN)) {
    const text = match[0];
    const src = descriptor(text, "src");
    const urls = cssUrls(src);
    const range = descriptor(text, "unicode-range");
    blocks.push({
      text,
      family: normalizeFontFamily(descriptor(text, "font-family")),
      unicodeRange: range ? normalizeUnicodeRange(range) : "",
      url: urls.find((u) => /\.woff2(?:[?#]|$)/i.test(u)) ?? urls[0] ?? null,
    });
  }
  return blocks;
}

/**
 * The fonts the page has actually drawn with: family → the unicode ranges
 * loaded for it. `null` means "unknown", and every face is then kept.
 */
export type LoadedFonts = Map<string, Set<string>> | null;

/** Whether a snapshot needs this face — i.e. the live page loaded it. */
export function fontFaceIsUsed(block: FontFaceBlock, loaded: LoadedFonts): boolean {
  if (!block.url || !block.family) return false;
  if (loaded === null) return true;
  const ranges = loaded.get(block.family);
  if (!ranges) return false;
  if (!block.unicodeRange) return true;
  // The default range is how a browser reports a face declared without one.
  return ranges.has(block.unicodeRange) || ranges.has("U+0-10FFFF");
}

/**
 * `css` with its @font-face rules rewritten for a self-contained document:
 * a face the page never loaded is dropped (a snapshot must not carry megabytes
 * of unused glyphs), a used one has its `src` replaced by `sources[url]`, and
 * a used one whose file could not be embedded is dropped rather than left
 * pointing at a URL an image document is not allowed to fetch.
 */
export function rewriteFontFaces(
  css: string,
  loaded: LoadedFonts,
  sources: ReadonlyMap<string, string | null>,
): string {
  return css.replace(FONT_FACE_PATTERN, (text) => {
    const [block] = parseFontFaces(text);
    if (!block || !fontFaceIsUsed(block, loaded) || !block.url) return "";
    const data = sources.get(block.url);
    if (!data) return "";
    const body = text
      .slice(text.indexOf("{") + 1, text.lastIndexOf("}"))
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d && !/^src\s*:/i.test(d));
    body.push(`src:url("${data}")`);
    return `@font-face{${body.join(";")}}`;
  });
}

/**
 * Markup made safe to parse as XML: the control characters XML forbids (a
 * terminal's output is full of them) and unpaired surrogates, either of which
 * makes the whole image fail to decode, are removed.
 */
export function sanitizeXml(markup: string): string {
  return markup.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");
}

/** Whether an attribute name can be written into XML as it is. */
export function isXmlAttributeName(name: string): boolean {
  return /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(name);
}

/** `backgroundColor` → `background-color`; custom properties pass through. */
export function cssPropertyName(name: string): string {
  if (name.startsWith("--")) return name;
  if (name === "cssFloat") return "float";
  if (name === "cssOffset") return "offset";
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
