/**
 * A page file <-> { frontmatter, body }.
 *
 * YAML is read and written with js-yaml's CORE schema: no `!!js/*` types, and
 * — the reason it is not the default schema — no implicit timestamps, so
 * `updatedAt: 2026-01-31T10:00:00Z` stays the string it was written as instead
 * of coming back as a Date and being re-serialised in another shape.
 *
 * Serialisation is deterministic (fixed key order, no line folding, no
 * anchors), so writing an unchanged page produces the same bytes and git sees
 * no change. Pure; no fs.
 */

import yaml from "js-yaml";
import { stripManagedBlocks } from "./plugin-files";
import {
  FRONTMATTER_KEY_ORDER,
  validateFrontmatter,
  type PageFrontmatter,
  type SchemaError,
} from "./schema";

/** Larger than any page the size caps allow; a bigger header is refused unparsed. */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

const FENCE_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SplitPage {
  /** The YAML text between the fences, or null when the file has none. */
  yamlText: string | null;
  body: string;
}

export function splitFrontmatter(text: string): SplitPage {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const m = FENCE_RE.exec(src);
  if (!m) return { yamlText: null, body: src };
  return { yamlText: m[1], body: src.slice(m[0].length) };
}

export type ParsedPage =
  | { ok: true; frontmatter: PageFrontmatter; body: string }
  | { ok: false; errors: SchemaError[]; body: string; raw: unknown };

/**
 * Parse and validate a page file's text. Never throws. The body comes back
 * without memory-wiki's managed blocks (a "## Related" list the plugin
 * appended): they are the plugin's, not the page's — no length, link or
 * summary rule counts them, and a page written back from its parse drops
 * them.
 */
export function parsePage(text: string): ParsedPage {
  const { yamlText, body: rawBody } = splitFrontmatter(text);
  const body = stripManagedBlocks(rawBody).text;
  if (yamlText === null) {
    return { ok: false, errors: [{ field: "", message: "no frontmatter block" }], body, raw: null };
  }
  if (Buffer.byteLength(yamlText, "utf8") > MAX_FRONTMATTER_BYTES) {
    return { ok: false, errors: [{ field: "", message: "frontmatter is too large" }], body, raw: null };
  }
  let raw: unknown;
  try {
    raw = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA, json: false });
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "unreadable";
    return { ok: false, errors: [{ field: "", message: `YAML: ${reason}` }], body, raw: null };
  }
  const result = validateFrontmatter(raw);
  if (!result.ok) return { ok: false, errors: result.errors, body, raw };
  return { ok: true, frontmatter: result.frontmatter, body };
}

function ordered(fm: PageFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEY_ORDER) out[key] = fm[key];
  for (const [key, value] of Object.entries(fm)) {
    if (!(key in out) && value !== undefined) out[key] = value;
  }
  return out;
}

/** The YAML block alone, fences excluded. */
export function serializeFrontmatter(fm: PageFrontmatter): string {
  return yaml.dump(ordered(fm), {
    schema: yaml.CORE_SCHEMA,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    skipInvalid: false,
  });
}

/** A whole page file. The body is written as given, with exactly one trailing newline. */
export function serializePage(fm: PageFrontmatter, body: string): string {
  const trimmed = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  return `---\n${serializeFrontmatter(fm)}---\n\n${trimmed}\n`;
}

/**
 * The page's summary: its first paragraph of prose, after any leading
 * headings. Null when the body has none.
 */
export function pageSummary(body: string): string | null {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || /^#{1,6}\s/.test(lines[i]))) i++;
  const para: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^#{1,6}\s/.test(line)) break;
    para.push(line.trim());
  }
  const text = para.join(" ").trim();
  return text === "" ? null : text;
}
