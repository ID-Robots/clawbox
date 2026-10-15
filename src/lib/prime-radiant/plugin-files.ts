/**
 * What OpenClaw's `memory-wiki` plugin writes into a vault it reads, told
 * apart from what Prime Radiant and the owner wrote.
 *
 * Wired with its defaults, the plugin compiles the vault on its first
 * `wiki_status` / `wiki_search`: a "## Related" block between
 * `<!-- openclaw:wiki:related:start -->` and `…:end -->` appended to every
 * page, a "## Generated" block in `index.md`, `<folder>/index.md` for
 * sources, entities, concepts and syntheses (no frontmatter), dashboards
 * under `reports/`; and every time it starts, `WIKI.md`, `inbox.md`,
 * `.openclaw-wiki/` and the empty `_views/` and `_attachments/` folders.
 * `plugin-wiring.ts` now switches the compile writers off; what is here keeps
 * the vault right whatever the plugin does:
 *
 *  - {@link isPluginOwnedPath}: those files are never pages — not listed,
 *    linted, compared or committed (the vault's `.gitignore` names them,
 *    {@link PLUGIN_GITIGNORE_LINES});
 *  - {@link stripManagedBlocks}: a page's body is read without the plugin's
 *    managed blocks, so they count toward no length, link or summary, and a
 *    page Prime Radiant re-writes drops them;
 *  - the pristine checks say which plugin files the one-time repair
 *    (`plugin-repair.ts`) may delete: only one exactly as the plugin made
 *    it. A note the owner added to `inbox.md`, or under a generated block,
 *    stays.
 *
 * Pure: no fs, and no import from the rest of Prime Radiant (`paths.ts` and
 * `frontmatter.ts` both read it).
 */

/** The folders whose `index.md` the plugin's compile writes (its page groups). */
export const PLUGIN_INDEX_DIRS: readonly string[] = ["sources", "entities", "concepts", "syntheses"];
/** Top-level files the plugin creates when it starts. */
export const PLUGIN_TOP_FILES: readonly string[] = ["WIKI.md", "inbox.md"];
/** Top-level folders that are the plugin's alone. */
export const PLUGIN_TOP_DIRS: readonly string[] = [".openclaw-wiki", "reports", "_views", "_attachments"];

/**
 * The lines the vault's `.gitignore` carries so a plugin file never reaches a
 * commit, even when the plugin re-creates it after the repair took it out.
 */
export const PLUGIN_GITIGNORE_LINES: readonly string[] = [
  ".openclaw-wiki/",
  "/WIKI.md",
  "/inbox.md",
  "/reports/",
  "/_views/",
  "/_attachments/",
  ...PLUGIN_INDEX_DIRS.map((d) => `/${d}/index.md`),
];

/** Whether a vault-relative POSIX path is one of the plugin's files or folders. */
export function isPluginOwnedPath(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.length === 1) return PLUGIN_TOP_FILES.includes(segments[0]) || PLUGIN_TOP_DIRS.includes(segments[0]);
  if (PLUGIN_TOP_DIRS.includes(segments[0])) return true;
  return segments.length === 2 && segments[1] === "index.md" && PLUGIN_INDEX_DIRS.includes(segments[0]);
}

/** Every marker the plugin writes starts with this. */
export const MANAGED_MARKER_PREFIX = "<!-- openclaw:wiki:";

/**
 * One managed block as `replaceManagedMarkdownBlock` writes it: an optional
 * heading line, then `<!-- openclaw:wiki:<name>:start -->` … `:end -->` with
 * the same name, from the start of a line. A human block (`openclaw:human:…`)
 * and the raw-source marker (no start/end) never match. The blank lines the
 * plugin put before it are not in the pattern — a `(?:\r?\n)*` in front made
 * every run of line breaks a quadratic backtrack (ReDoS); stripManagedBlocks
 * takes them off in code. Each run here can be matched one way only.
 */
const MANAGED_BLOCK_RE =
  /(?:^|(?<=\n))(?:#{1,6}[ \t]+(?:Related|Generated)[ \t]*[\r\n]+[ \t]*)?<!-- openclaw:wiki:([A-Za-z0-9][\w:.-]{0,80}):start -->[\s\S]*?<!-- openclaw:wiki:\1:end -->[ \t]*/g;

/** `text` without the line breaks (LF or CRLF) it ends with — one pass from the end, no regex. */
function withoutTrailingLineBreaks(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") {
    end -= 1;
    if (end > 0 && text[end - 1] === "\r") end -= 1;
  }
  return text.slice(0, end);
}

export interface StrippedText {
  text: string;
  /** Managed blocks taken out. */
  blocks: number;
}

/**
 * `text` without the plugin's managed blocks. A page the plugin appended a
 * block to comes back byte for byte as it was before (the plugin trims the
 * end and adds a blank line; the trailing newline is kept). Text without a
 * block is returned as is.
 */
export function stripManagedBlocks(text: string): StrippedText {
  if (!text.includes(MANAGED_MARKER_PREFIX)) return { text, blocks: 0 };
  let blocks = 0;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MANAGED_BLOCK_RE)) {
    // The blank lines the plugin put before the block go with it.
    out += withoutTrailingLineBreaks(text.slice(last, m.index));
    last = m.index + m[0].length;
    blocks += 1;
  }
  if (blocks === 0) return { text, blocks };
  out += text.slice(last);
  return { text: text.endsWith("\n") && !out.endsWith("\n") ? `${out}\n` : out, blocks };
}

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** What is left once the managed blocks are out: nothing, or a title line alone. */
function onlyATitle(text: string): boolean {
  return /^(?:#[ \t]+[^\n]*)?$/.test(text.trim());
}

/** `<folder>/index.md` exactly as the plugin's compile writes it: a title and generated blocks. */
export function isPristinePluginIndex(text: string): boolean {
  const { text: rest, blocks } = stripManagedBlocks(text);
  return blocks > 0 && !FRONTMATTER_RE.test(text) && onlyATitle(rest);
}

/** A `reports/<name>.md` dashboard as the plugin writes it: its own frontmatter, a title, generated blocks. */
export function isPristinePluginReport(text: string): boolean {
  const m = FRONTMATTER_RE.exec(text);
  if (!m || !/^pageType:[ \t]*["']?report["']?[ \t]*$/m.test(m[1]) || !/^id:[ \t]*["']?report\./m.test(m[1])) return false;
  const { text: rest, blocks } = stripManagedBlocks(text.slice(m[0].length));
  return blocks > 0 && onlyATitle(rest);
}

/** `WIKI.md` as the plugin creates it, its notes block still empty. */
export function isPristineWikiOverview(text: string): boolean {
  return (
    /^# Memory Wiki\r?\n/.test(text) &&
    text.includes("This vault is maintained by the OpenClaw memory-wiki plugin.") &&
    /## Notes\r?\n<!-- openclaw:human:start -->\s*<!-- openclaw:human:end -->\s*$/.test(text)
  );
}

/** `inbox.md` as the plugin creates it, nothing dropped in yet. */
export function isPristineInbox(text: string): boolean {
  return text.trim() === "# Inbox\n\nDrop raw ideas, questions, and source links here.";
}

/** `.gitignore` with every {@link PLUGIN_GITIGNORE_LINES} entry it lacks appended, or null when it has them all. */
export function withPluginGitignore(current: string | null): string | null {
  const have = new Set((current ?? "").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")));
  const missing = PLUGIN_GITIGNORE_LINES.filter((l) => !have.has(l.replace(/^\//, "")));
  if (missing.length === 0) return null;
  let text = current ?? "";
  if (text !== "" && !text.endsWith("\n")) text += "\n";
  if (text !== "") text += "\n";
  return `${text}# OpenClaw's memory-wiki plugin re-creates these when it starts; they are not knowledge.\n${missing.join("\n")}\n`;
}
