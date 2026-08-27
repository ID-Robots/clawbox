// ── Untrusted mail HTML → a safe node tree ───────────────────────────────────
//
// This module turns the HTML part of an email into a small tree of nodes the
// chat renders as REACT ELEMENTS. That indirection is the whole security
// design, and it is worth stating plainly:
//
//   No HTML string produced from a message ever reaches the browser.
//
// `dangerouslySetInnerHTML` appears nowhere in this repository and this feature
// does not introduce it. The client walks `EmailNode[]` and calls
// `createElement` with tag names taken from OUR allow-list — never from the
// message — so there is no parser on the far side that could be tricked into
// re-interpreting text as markup. A sanitiser that emits a string has to be
// right about every escaping corner; one that emits a tree only has to be right
// about which nodes it builds.
//
// WHY NOT DOMPurify: it wants a DOM, which means running the sanitiser in the
// browser on markup a stranger sent, and it adds a dependency to an appliance
// that ships its own bundle. The tree above needs neither. The existing
// `stripHtml` in imap-client.ts already established this file's scanning
// discipline; this is the same scanner, keeping structure instead of dropping
// it.
//
// SINGLE FORWARD PASS, for the reason spelled out over `stripHtml`: any
// "delete the dangerous sequence" pass can put the sequence back together
// (`<scr<script>ipt>`). The scanner below reads the input once, left to right,
// and never re-reads what it has emitted, so no leftover can be reassembled
// into a tag. Entities are decoded on emitted TEXT only.
//
// WHAT IS DELIBERATELY DROPPED, and why each one matters:
//   • <script>, <iframe>, <object>, <embed>, <form>, <button>, <svg>, <math>,
//     <template>, <noscript> — every one of these either executes, navigates,
//     submits, or (svg/math) opens a second parsing mode with its own script
//     vectors.
//   • EVERY attribute except the handful named below. This is an allow-list,
//     so a novel `on…` handler, `srcset`, `formaction`, `xlink:href` and
//     anything else invented later is dropped by DEFAULT rather than by a
//     blocklist that has to be kept current.
//   • `style=` and `class=` on every element, and the whole <style> element.
//     That is what makes "CSS cannot escape the container" true by
//     construction rather than by careful containment: there is no
//     message-authored CSS anywhere in the output, so there is nothing to
//     escape with. `position:fixed`, a full-viewport overlay, a font that
//     redraws the dashboard's own chrome — none of them can be expressed.
//
// REMOTE IMAGES ARE NOT RESOLVED HERE. An <img> pointing at the network becomes
// a node carrying only its HOST and alt text, never a usable `src`, so the
// default render cannot emit a request. Loading them is a separate, explicit
// act by the owner (see email-mime.ts and the messages route): a remote image
// in mail is a read receipt, and fetching one tells the sender their message
// was opened, when, and roughly from where.

/** Text taken from the message. Rendered as a React text child, never markup. */
export interface EmailTextNode {
  type: "text";
  text: string;
}

/**
 * One structural element.
 *
 * `tag` is OUR string, looked up in ALLOWED_TAGS — never the name the message
 * wrote. That is what stops a crafted tag name from reaching `createElement`.
 */
export interface EmailElementNode {
  type: "element";
  tag: AllowedTag;
  /** `<a>` only, and only when the protocol passed `isSafeHref`. */
  href?: string;
  children: EmailNode[];
}

/**
 * A picture.
 *
 * At most one of `src` and `remoteHost` is set:
 *   • `src`        — safe to render with no network call at all. Either a
 *                    `data:` URI the message carried itself, or one the owner
 *                    asked the device to fetch on their behalf.
 *   • `remoteHost` — the image lives on the network and has NOT been fetched.
 *                    Only the host is kept, for the "images blocked" notice.
 *                    There is deliberately no full URL here: a node the client
 *                    cannot turn into a request cannot leak a read receipt by
 *                    accident, however it is later rendered.
 */
export interface EmailImageNode {
  type: "image";
  alt: string;
  src?: string;
  remoteHost?: string;
}

export type EmailNode = EmailTextNode | EmailElementNode | EmailImageNode;

/**
 * The elements that survive, mapped to themselves.
 *
 * Everything structural a mail actually uses to mean something — paragraphs,
 * emphasis, lists, quotes, headings, tables, preformatted text. Presentational
 * relics (`<font>`, `<center>`, `<big>`) are dropped as ELEMENTS but their
 * children are kept, so the words survive without the message dictating type.
 */
const ALLOWED_TAGS = [
  "p", "div", "span", "br", "hr",
  "strong", "em", "b", "i", "u", "s", "sub", "sup", "code", "pre",
  "ul", "ol", "li", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "a",
] as const;

export type AllowedTag = (typeof ALLOWED_TAGS)[number];

const ALLOWED = new Map<string, AllowedTag>(ALLOWED_TAGS.map((t) => [t, t]));

/** Elements with no closing tag; they never open a scope on the stack. */
const VOID_TAGS = new Set<string>(["br", "hr"]);

/**
 * Elements whose CONTENT is machinery, not words — skipped whole.
 *
 * Keyed by our own copy of the name, so the closing tag the scanner then hunts
 * for is this file's string rather than one taken from the message.
 */
const DROP_WITH_CONTENT = new Map<string, string>([
  ["script", "script"],
  ["style", "style"],
  ["head", "head"],
  ["title", "title"],
  ["iframe", "iframe"],
  ["object", "object"],
  ["embed", "embed"],
  ["noscript", "noscript"],
  ["template", "template"],
  ["svg", "svg"],
  ["math", "math"],
  ["form", "form"],
  ["select", "select"],
  ["textarea", "textarea"],
  ["button", "button"],
]);

/** Entities that turn up in mail, and our copy of what each means. */
const NAMED_ENTITIES = new Map<string, string>([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#39", "'"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["hellip", "…"],
  ["rsquo", "’"],
  ["lsquo", "‘"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["middot", "·"],
  ["bull", "•"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["euro", "€"],
  ["pound", "£"],
  ["deg", "°"],
]);

// ── Bounds ───────────────────────────────────────────────────────────────────
//
// A message is written by a stranger, so every recursive or accumulating step
// needs a ceiling. These are not tuning knobs; they are the difference between
// a badly-formed mail rendering poorly and one wedging the dashboard.

/** Deepest nesting kept. Beyond this, children are flattened into the parent. */
const MAX_DEPTH = 24;
/** Most nodes built from one message. Marketing mail nests tables absurdly. */
const MAX_NODES = 12_000;
/** Longest single run of text kept as one node. */
const MAX_TEXT_RUN = 40_000;

/** Protocols a link may use. Everything else — `javascript:` above all — goes. */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  // A scheme-relative or relative href has no protocol to check and nothing
  // sensible to resolve against inside a mail body, so it is not a link.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return /^(?:https?|mailto):/i.test(value);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    const named = NAMED_ENTITIES.get(body.toLowerCase());
    if (named !== undefined) return named;
    if (body[0] !== "#") return whole;
    const code = body[1] === "x" || body[1] === "X"
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    // Controls, surrogates and out-of-range code points are not text a reader
    // asked for; leaving the entity as written says more than dropping it.
    if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

interface ScannedTag {
  /** Lower-cased element name; "" for a doctype or a bare "<!". */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Raw attribute text between the name and the ">". Parsed only if needed. */
  attrs: string;
  /** Index just past the ">" that ends the tag. */
  end: number;
}

/**
 * Read one tag starting at `start` (which must be a "<"), or null when it never
 * closes.
 *
 * Attribute values are stepped over IN QUOTES, so `<a title="a>b">` ends at the
 * real ">" rather than the one inside the title. A regex that stops at the
 * first ">" leaves `b">` behind as visible text — and, worse, can end a tag
 * early enough that the rest of its attributes are read as markup.
 */
function scanTag(html: string, start: number): ScannedTag | null {
  let i = start + 1;
  const closing = html[i] === "/";
  if (closing) i += 1;
  const name = (/^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(i, i + 64))?.[0] ?? "").toLowerCase();
  i += name.length;
  const attrsFrom = i;
  let quote = "";
  for (; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      const attrs = html.slice(attrsFrom, i);
      return { name, closing, selfClosing: attrs.trimEnd().endsWith("/"), attrs, end: i + 1 };
    }
  }
  return null;
}

/**
 * Pull one attribute's value out of a tag's raw attribute text.
 *
 * Deliberately narrow: it is called only for the three attributes this module
 * keeps (`href` on a link, `src` and `alt` on an image). Everything else is
 * never looked at, which is what makes the attribute policy an allow-list
 * rather than a list of things to strip.
 */
function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** How an <img> src should be resolved. Decided by the caller, not the message. */
export type ImageResolver = (src: string) => { src?: string; remoteHost?: string };

/** A `data:` URI holding one of the image types a browser will actually paint. */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=\s]*$/i;

/**
 * The default policy: nothing is fetched, and nothing that COULD be fetched is
 * handed onward.
 *
 * `data:` images are the one thing rendered as-is, and only for image types:
 * the bytes are already in the message, so showing them costs no request and
 * tells the sender nothing. `cid:` references are resolved by email-mime.ts
 * before this runs — anything still saying `cid:` here names a part that was
 * not in the message, so there is nothing to show and the image is dropped.
 */
export const blockRemoteImages: ImageResolver = (src) => {
  const value = src.trim();
  if (DATA_IMAGE_RE.test(value)) return { src: value.replace(/\s+/g, "") };
  if (/^https?:/i.test(value)) {
    try {
      return { remoteHost: new URL(value).host };
    } catch {
      return { remoteHost: "" };
    }
  }
  return {};
};

/**
 * Parse the HTML part of a message into nodes the chat can render.
 *
 * `resolveImage` decides what happens to every `<img>`; it is a parameter
 * rather than a flag so the "images blocked" and "owner asked for images" paths
 * are the same code walking the same tree, differing only in what an image node
 * ends up carrying.
 */
export function sanitizeEmailHtml(
  html: string,
  resolveImage: ImageResolver = blockRemoteImages,
): EmailNode[] {
  const root: EmailElementNode = { type: "element", tag: "div", children: [] };
  // The open-element stack. `root` is never popped, so a message with more
  // closing tags than opening ones cannot unwind past the top.
  const stack: EmailElementNode[] = [root];
  let nodes = 0;
  let i = 0;

  const top = (): EmailElementNode => stack[stack.length - 1];

  const pushNode = (node: EmailNode): void => {
    if (nodes >= MAX_NODES) return;
    nodes += 1;
    top().children.push(node);
  };

  const pushText = (raw: string): void => {
    if (!raw) return;
    const text = decodeEntities(raw.length > MAX_TEXT_RUN ? raw.slice(0, MAX_TEXT_RUN) : raw);
    // Whitespace between block tags is layout, not content, and a tree full of
    // whitespace-only nodes renders as a column of blank lines.
    if (!text.trim()) {
      const siblings = top().children;
      const last = siblings[siblings.length - 1];
      // One space is kept between two runs of text, because `a</b> <b>b`
      // means "a b" and dropping it would say "ab".
      if (last && last.type === "text" && !/\s$/.test(last.text)) {
        pushNode({ type: "text", text: " " });
      }
      return;
    }
    pushNode({ type: "text", text });
  };

  while (i < html.length && nodes < MAX_NODES) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    // "a < b" in a body is arithmetic, not a tag: only a name, a closer, a
    // comment or a declaration starts markup.
    if (!/[A-Za-z!/?]/.test(html[lt + 1] ?? "")) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    const tag = scanTag(html, lt);
    // A "<" with no ">" after it is an unterminated tag: everything left is
    // inside it, so there is no more content to take.
    if (!tag) break;
    i = tag.end;

    // A doctype, a processing instruction, or `</>`.
    if (!tag.name) continue;

    const dropped = DROP_WITH_CONTENT.get(tag.name);
    if (dropped) {
      if (!tag.closing) i = skipContent(html, dropped, i);
      continue;
    }

    if (tag.name === "img") {
      if (tag.closing) continue;
      const resolved = resolveImage(attrValue(tag.attrs, "src") ?? "");
      if (resolved.src !== undefined || resolved.remoteHost !== undefined) {
        pushNode({
          type: "image",
          alt: (attrValue(tag.attrs, "alt") ?? "").slice(0, 300),
          ...resolved,
        });
      }
      continue;
    }

    const allowed = ALLOWED.get(tag.name);
    if (!allowed) {
      // An element we do not model — `<font>`, `<center>`, `<main>`. Its
      // children still carry the words, so only the element is dropped. It
      // opens no scope, which is why nothing has to be popped for it either.
      continue;
    }

    if (tag.closing) {
      // Pop to the matching open element if there is one. Searching rather
      // than popping blindly keeps `<b><i></b></i>` from unwinding the tree:
      // a closer with no opener is simply ignored.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === allowed) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    if (VOID_TAGS.has(allowed)) {
      pushNode({ type: "element", tag: allowed, children: [] });
      continue;
    }

    const element: EmailElementNode = { type: "element", tag: allowed, children: [] };
    if (allowed === "a") {
      const href = attrValue(tag.attrs, "href") ?? "";
      if (isSafeHref(href)) element.href = href.trim();
    }
    pushNode(element);
    // Past the depth cap the element is still emitted, but its children land in
    // the parent instead of nesting further. The words survive; the tree stops
    // growing. Recursion depth on the render side is what this protects.
    if (!tag.selfClosing && stack.length < MAX_DEPTH) stack.push(element);
  }

  return root.children;
}

/**
 * Index just past `</name ...>`, or the end of the input when it never closes.
 *
 * The scan walks the ORIGINAL string and lower-cases only the few characters
 * that could be the tag name. Searching a lower-cased COPY would be wrong
 * twice: `toLowerCase()` is not length-preserving (U+0130 becomes two code
 * units), so an index into the copy is not an index into the input, and a copy
 * per dropped element makes a message with many <style> blocks quadratic work.
 */
function skipContent(html: string, name: string, from: number): number {
  for (let i = from; i + name.length + 2 <= html.length; i++) {
    if (html[i] !== "<" || html[i + 1] !== "/") continue;
    if (html.slice(i + 2, i + 2 + name.length).toLowerCase() !== name) continue;
    const end = html.indexOf(">", i + 2 + name.length);
    return end < 0 ? html.length : end + 1;
  }
  return html.length;
}

// ── Plain text ───────────────────────────────────────────────────────────────

/** A bare URL in plain text. Trailing sentence punctuation is left outside. */
const URL_RE = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])/gi;

/**
 * A text/plain body as the same node tree.
 *
 * Paragraphs and line breaks are preserved as structure rather than left to
 * `white-space: pre-wrap`, so a plain message and an HTML one render through
 * ONE renderer with one set of typography — which is what stops the full view
 * from looking like two different features depending on what the sender used.
 *
 * URLs become links. They go through `isSafeHref` like every other link, even
 * though the pattern already only matches http(s): the check is where link
 * policy lives, and routing every link through it means there is no second
 * place to keep in step.
 */
export function emailTextToNodes(text: string): EmailNode[] {
  const nodes: EmailNode[] = [];
  // Blank-line-separated runs are paragraphs; single breaks inside one are
  // <br>, which is what a person meant when they pressed Enter once.
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const children: EmailNode[] = [];
    block.split("\n").forEach((line, index) => {
      if (index > 0) children.push({ type: "element", tag: "br", children: [] });
      children.push(...linkify(line));
    });
    nodes.push({ type: "element", tag: "p", children });
    if (nodes.length >= MAX_NODES) break;
  }
  return nodes;
}

function linkify(line: string): EmailNode[] {
  const out: EmailNode[] = [];
  let last = 0;
  for (const match of line.matchAll(URL_RE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: "text", text: line.slice(last, at) });
    const href = match[0];
    out.push(
      isSafeHref(href)
        ? { type: "element", tag: "a", href, children: [{ type: "text", text: href }] }
        : { type: "text", text: href },
    );
    last = at + href.length;
  }
  if (last < line.length) out.push({ type: "text", text: line.slice(last) });
  return out;
}
