// ── One message, in the shape a reader wants it ──────────────────────────────
//
// `extractText` in imap-client.ts answers the AGENT's question: "what does this
// message say?" It flattens HTML to text and throws the structure away, which
// is right for something that is about to be summarised into prose.
//
// This module answers the OWNER's question: "show me the actual email." It
// walks the same MIME tree and keeps what the other one discards — the HTML
// part as markup, the pictures the message carried inside itself, the names of
// the files attached to it, and the addresses in the header block.
//
// The two live side by side rather than one replacing the other. The agent's
// path is unchanged by this feature: `email_read` still returns flattened,
// capped text, because a full HTML body in a tool result is tokens spent to
// tell a model what it already knew.
//
// NOTHING HERE TRUSTS THE MESSAGE. Every part is decoded defensively, every
// accumulation is capped, and the HTML that comes out of this module is still
// raw — it is `sanitizeEmailHtml` in email-html.ts, not this file, that decides
// what may be rendered. Keeping the two apart means the sanitiser has exactly
// one input and one job.

import { decodeEncodedWords, decodePart, parseHeaders } from "@/lib/imap-client";
import {
  blockRemoteImages,
  emailTextToNodes,
  sanitizeEmailHtml,
  type EmailNode,
  type ImageResolver,
} from "@/lib/email-html";

/** One name-and-address pair out of a header like `From` or `To`. */
export interface EmailAddress {
  /** The display name, when the header carried one. May be empty. */
  name: string;
  /** The bare address. May be empty when the header could not be parsed. */
  address: string;
}

/** A file the message carried. Named only — see the note on `readFullMessage`. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Decoded size in bytes, or -1 when the part was cut off by the fetch cap. */
  size: number;
}

/** The full view's payload. Everything the client needs, already made safe. */
export interface FullMessage {
  uid: number;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  date: string;
  unread: boolean;
  /** Which part the body came from, so the UI can say so honestly. */
  format: "html" | "text";
  /** Already sanitised. There is no raw markup in this payload. */
  body: EmailNode[];
  attachments: EmailAttachment[];
  /** Remote images left unloaded. Drives the "images are blocked" notice. */
  blockedImages: number;
  /** True when the fetch or a cap cut the message short. */
  truncated: boolean;
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Deepest multipart nesting walked. Real mail never approaches this. */
const MAX_PART_DEPTH = 12;
/** Most parts examined in one message. */
const MAX_PARTS = 400;
/** Largest inline image inlined as a data: URI, before base64 expansion. */
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
/** Total budget for inline images, so one message cannot balloon the payload. */
const MAX_INLINE_TOTAL_BYTES = 4 * 1024 * 1024;
/** Most attachments listed. */
const MAX_ATTACHMENTS = 100;

/**
 * Split an address-list header into pairs.
 *
 * Commas inside a quoted display name do not separate addresses — `"Doe, Jane"
 * <jane@example.com>` is ONE recipient — so the split walks the string and
 * tracks quoting and angle brackets rather than calling `.split(",")`.
 */
export function parseAddressList(raw: string): EmailAddress[] {
  if (!raw.trim()) return [];
  const chunks: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && ch === "<") angled = true;
    if (!quoted && ch === ">") angled = false;
    if (ch === "," && !quoted && !angled) {
      chunks.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  chunks.push(current);
  // A header with hundreds of recipients is a mailing list, not something the
  // header block should try to show; the UI shows the first few and a count.
  return chunks
    .map((chunk) => parseAddress(chunk))
    .filter((a) => a.name !== "" || a.address !== "")
    .slice(0, 200);
}

/** One `Display Name <addr@host>`, or a bare address. */
export function parseAddress(raw: string): EmailAddress {
  const value = decodeEncodedWords(raw.trim());
  // `[\s\S]` rather than `.` with the `s` flag: a folded display name can carry
  // a newline, and this file compiles against a target without `dotAll`.
  const angled = /^([\s\S]*?)<([^>]*)>\s*$/.exec(value);
  if (angled) {
    return { name: unquote(angled[1].trim()), address: angled[2].trim() };
  }
  // A bare address, or something that is not an address at all. Either way the
  // text is shown as written rather than guessed at.
  return value.includes("@") ? { name: "", address: value } : { name: unquote(value), address: "" };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  }
  return value;
}

/** A parameter out of a `Content-Type` or `Content-Disposition` header. */
function param(header: string, name: string): string {
  // RFC 2231 continuations (`name*0=`, `name*=utf-8''…`) turn up in real mail;
  // the simple forms cover the rest.
  const extended = new RegExp(`${name}\\*\\s*=\\s*(?:[\\w-]*'[\\w-]*')?([^;]+)`, "i").exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return extended[1].trim().replace(/^"|"$/g, "");
    }
  }
  const simple = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header);
  if (!simple) return "";
  return decodeEncodedWords((simple[1] ?? simple[2] ?? "").trim());
}

interface MimePart {
  headers: Record<string, string>;
  /** The part's body, already decoded from its transfer encoding. */
  body: string;
  /** The raw, still-encoded body — needed to measure and to re-encode. */
  raw: string;
  contentType: string;
  disposition: string;
  filename: string;
  contentId: string;
}

interface Walked {
  html: string | null;
  text: string | null;
  /** `cid:` value → the part, for inlining pictures the message carried. */
  inline: Map<string, MimePart>;
  attachments: EmailAttachment[];
}

/**
 * Walk the MIME tree, collecting the parts a reader cares about.
 *
 * PREFERENCE, and why it is the opposite of `extractText`'s: for the full view
 * HTML wins over plain text when a message carries both. A `multipart/
 * alternative` sender writes the plain part as a lossy fallback — links become
 * bare URLs, tables become columns of words — so showing it in a view whose
 * whole purpose is "the real thing" would be showing the worse copy on purpose.
 * The agent's summary path still prefers text, for the opposite reason.
 */
function walkParts(rawBody: string, headers: Record<string, string>, found: Walked, depth = 0, budget = { parts: 0 }): void {
  if (depth > MAX_PART_DEPTH || budget.parts > MAX_PARTS) return;
  budget.parts += 1;

  const contentType = (headers["content-type"] ?? "text/plain").trim();
  const encoding = headers["content-transfer-encoding"] ?? "7bit";
  const disposition = (headers["content-disposition"] ?? "").trim();
  const filename = param(disposition, "filename") || param(contentType, "name");
  const contentId = (headers["content-id"] ?? "").trim().replace(/^<|>$/g, "");

  if (/^multipart\//i.test(contentType)) {
    const boundary = param(contentType, "boundary");
    if (!boundary) return;
    for (const piece of rawBody.split(`--${boundary}`)) {
      const trimmed = piece.replace(/^\r?\n/, "");
      if (!trimmed || trimmed.startsWith("--")) continue;
      const split = trimmed.search(/\r?\n\r?\n/);
      if (split < 0) continue;
      walkParts(
        trimmed.slice(split).replace(/^\r?\n\r?\n/, ""),
        parseHeaders(trimmed.slice(0, split)),
        found,
        depth + 1,
        budget,
      );
    }
    return;
  }

  const part: MimePart = {
    headers,
    body: "",
    raw: rawBody,
    contentType,
    disposition,
    filename,
    contentId,
  };

  const isAttachment = /^attachment/i.test(disposition) || (filename !== "" && !/^inline/i.test(disposition));

  // A picture the message carried, referenced from the HTML by `cid:`. These
  // are free to show: the bytes already arrived, so painting them costs no
  // request and tells the sender nothing.
  if (contentId && /^image\//i.test(contentType)) {
    found.inline.set(contentId, part);
  }

  if (isAttachment || (!/^text\/(?:plain|html)/i.test(contentType) && !contentId)) {
    if (found.attachments.length < MAX_ATTACHMENTS && (filename || !/^text\//i.test(contentType))) {
      found.attachments.push({
        filename: filename || "(unnamed)",
        contentType: contentType.split(";")[0].trim().toLowerCase(),
        size: decodedSize(rawBody, encoding),
      });
    }
    return;
  }

  if (/^text\/html/i.test(contentType) && found.html === null) {
    found.html = decodePart(rawBody, contentType, encoding);
    return;
  }
  if (/^text\/plain/i.test(contentType) && found.text === null) {
    found.text = decodePart(rawBody, contentType, encoding);
  }
}

/** Decoded byte count, without building the buffer for the common cases. */
function decodedSize(raw: string, encoding: string): number {
  const enc = encoding.trim().toLowerCase();
  if (enc === "base64") {
    const clean = raw.replace(/\s+/g, "");
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
  return Buffer.byteLength(raw, "utf8");
}

/** A part's bytes as a `data:` URI, or null when it is too big to inline. */
function inlineDataUri(part: MimePart, spent: { bytes: number }): string | null {
  const encoding = (part.headers["content-transfer-encoding"] ?? "7bit").trim().toLowerCase();
  const size = decodedSize(part.raw, encoding);
  if (size <= 0 || size > MAX_INLINE_IMAGE_BYTES) return null;
  if (spent.bytes + size > MAX_INLINE_TOTAL_BYTES) return null;

  const mime = part.contentType.split(";")[0].trim().toLowerCase();
  // Only the types a browser will actually paint, and only ones our own
  // sanitiser will accept back — `image/svg+xml` is a scriptable document and
  // is deliberately not among them.
  if (!/^image\/(?:png|jpeg|jpg|gif|webp|bmp|avif)$/.test(mime)) return null;

  let base64: string;
  if (encoding === "base64") {
    base64 = part.raw.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]*$/.test(base64)) return null;
  } else {
    base64 = Buffer.from(part.raw, "binary").toString("base64");
  }
  spent.bytes += size;
  return `data:${mime === "image/jpg" ? "image/jpeg" : mime};base64,${base64}`;
}

/**
 * Build the full view of one already-fetched raw message.
 *
 * `resolveRemote` is how the owner's consent reaches the parser. By default it
 * is absent and every network-backed image becomes a blocked placeholder; the
 * route passes a resolver only when the request explicitly asked for images.
 */
export function buildFullMessage(
  raw: string,
  meta: { uid: number; unread: boolean; internalDate: string; truncated: boolean },
  resolveRemote?: (url: string) => string | undefined,
): FullMessage {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const rawBody = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");

  const found: Walked = { html: null, text: null, inline: new Map(), attachments: [] };
  walkParts(rawBody, headers, found);

  const spent = { bytes: 0 };
  let blockedImages = 0;

  /**
   * The one place an `<img src>` is decided.
   *
   * Order matters: a `cid:` reference is resolved from the message's own parts
   * BEFORE anything else is considered, so the common case (a logo in a
   * signature) never counts as blocked and never needs consent.
   */
  const resolveImage: ImageResolver = (src) => {
    const value = src.trim();
    const cid = /^cid:(.+)$/i.exec(value);
    if (cid) {
      const part = found.inline.get(decodeURIComponent(cid[1]).replace(/^<|>$/g, ""));
      const uri = part ? inlineDataUri(part, spent) : null;
      // A cid that names no part is a broken reference, not a blocked image:
      // there is nothing on the network to go and get.
      return uri ? { src: uri } : {};
    }
    if (/^https?:/i.test(value)) {
      const loaded = resolveRemote?.(value);
      if (loaded) return { src: loaded };
      blockedImages += 1;
      // Falls through to the default policy, which keeps the HOST and discards
      // the URL — so a payload built without consent contains nothing the
      // client could turn into a request.
      return blockRemoteImages(value);
    }
    return blockRemoteImages(value);
  };

  const format: "html" | "text" = found.html !== null ? "html" : "text";
  const body = found.html !== null
    ? sanitizeEmailHtml(found.html, resolveImage)
    : emailTextToNodes(found.text ?? "");

  return {
    uid: meta.uid,
    from: parseAddress(headers.from ?? ""),
    to: parseAddressList(headers.to ?? ""),
    cc: parseAddressList(headers.cc ?? ""),
    subject: headers.subject ?? "",
    date: headers.date ?? meta.internalDate,
    unread: meta.unread,
    format,
    body,
    attachments: found.attachments,
    blockedImages,
    truncated: meta.truncated,
  };
}

/**
 * Every remote image URL a message references, in document order.
 *
 * Used only by the consent path: the route resolves these itself and hands the
 * results back through `resolveRemote`, so the URL a fetch is aimed at always
 * comes from the message rather than from the caller. That is what keeps the
 * image route from being an open proxy — see email-image-fetch.ts.
 */
export function remoteImageUrls(raw: string): string[] {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const rawBody = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const found: Walked = { html: null, text: null, inline: new Map(), attachments: [] };
  walkParts(rawBody, headers, found);
  if (found.html === null) return [];

  const urls: string[] = [];
  const seen = new Set<string>();
  sanitizeEmailHtml(found.html, (src) => {
    const value = src.trim();
    if (/^https?:/i.test(value) && !seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
    return {};
  });
  return urls;
}
