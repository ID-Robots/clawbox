// A minimal, dependency-free IMAP client — READ-ONLY, on purpose.
//
// Sibling of smtp-client.ts and built for the same reason: this device ships an
// offline-first standalone Next.js bundle onto a Jetson, and the whole feature
// needs exactly two things — "list the last few messages" and "show me that
// one". That is a bounded slice of RFC 3501 against node's own `net`/`tls`, so
// a new runtime dependency (and its update/CVE surface on an appliance that
// customers update rarely) buys nothing here.
//
// THE RULE THIS FILE EXISTS TO KEEP: reading the owner's mail must not CHANGE
// the owner's mail. Concretely:
//
//   - the mailbox is opened with EXAMINE, never SELECT. EXAMINE is read-only at
//     the protocol level: a server must refuse STORE/EXPUNGE in that state, so
//     the guarantee does not rest on this client being careful.
//   - every body fetch uses BODY.PEEK[...] rather than BODY[...]. BODY[] sets
//     \Seen as a side effect of reading — that is the one operation that would
//     silently mark the owner's unread mail as read, which is the exact
//     complaint "don't touch my mailbox" is about. There is no code path here
//     that emits a bare BODY[.
//   - no STORE, no APPEND, no EXPUNGE, no COPY, no flag writes of any kind.
//     None of those verbs appear in this file.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - no plaintext LOGIN on an unencrypted channel (see requireTls below);
//   - no IDLE, no polling, no long-lived connection. One call, one connection,
//     one LOGOUT. Nothing in this module can run without a caller;
//   - no full MIME tree. It finds the first text part and says so when it had
//     to give up (see extractText);
//   - no attachments, no search beyond UNSEEN, no writes, no retries.
//
// SECURITY NOTES:
//   - the password is never written to a log line and never appears in an Error
//     message: every server-supplied string that leaves this module goes
//     through Session.scrub(), the single chokepoint for that rule.
//   - responses are byte-capped twice over: MAX_RESPONSE_BYTES bounds any one
//     server response, and body fetches ask the SERVER to truncate with a
//     partial fetch (`<0.N>`) so a 40 MB message never crosses the wire at all.

import net from "net";
import tls from "tls";
import { isHostname, isPort } from "@/lib/smtp-client";

export interface ImapConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 993). Otherwise plain + STARTTLS. */
  secure: boolean;
  /**
   * When not `secure`, refuse to authenticate unless STARTTLS succeeded.
   * Default true and there is no UI to turn it off — an app password must never
   * cross the wire in the clear. Tests use it for a plaintext sink.
   */
  requireTls?: boolean;
  user: string;
  password: string;
}

/**
 * The things that actually go wrong, kept apart because the fix is different
 * for each and the reader is a non-engineer or a small model.
 */
export type ImapFailureKind =
  | "auth"     // credentials rejected
  | "network"  // never got a usable connection
  | "tls"      // connected, but the encrypted channel could not be established
  | "mailbox"  // connected and signed in, but the folder is not there
  | "protocol"; // anything else the server said

export class ImapError extends Error {
  constructor(
    readonly kind: ImapFailureKind,
    message: string,
    /** Server's own reply, scrubbed. Safe to show; never contains the password. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ImapError";
  }
}

export const DEFAULT_IMAP_MAILBOX = "INBOX";

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 20_000;
/** Any single response. A body fetch is capped far below this by the server. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Refuse a literal this big before allocating for it. */
const MAX_LITERAL_BYTES = 1024 * 1024;

/** How much of one message body we ever ask the server for. */
export const MAX_BODY_FETCH_BYTES = 128 * 1024;
/**
 * The higher ceiling the FULL VIEW may ask for.
 *
 * 128 KB is a generous budget for text a model is about to summarise, and a
 * mean one for showing a person their actual mail: an HTML newsletter with its
 * pictures base64'd inside it passes 128 KB routinely, and cutting there ends
 * the message mid-tag. This bound is what `MAX_LITERAL_BYTES` already allows a
 * single literal to be, so raising to it costs no new allocation ceiling.
 */
export const MAX_FULL_FETCH_BYTES = 1024 * 1024;
/** How much of the decoded text we hand back. */
export const MAX_BODY_TEXT_CHARS = 16_000;
/** Upper bound on `limit` for a listing, whatever the caller asks for. */
export const MAX_LIST_LIMIT = 50;

// ── Shapes the callers see ───────────────────────────────────────────────────

export interface MessageSummary {
  uid: number;
  from: string;
  subject: string;
  /** The message's own Date header when present, else the server's INTERNALDATE. */
  date: string;
  unread: boolean;
}

export interface MessageListing {
  mailbox: string;
  /** Messages in the mailbox, all of them, not just the ones returned. */
  total: number;
  /** How many of those are unread. -1 when the server refused the SEARCH. */
  unseen: number;
  /** Newest last — the order a person reads a thread in. */
  messages: MessageSummary[];
}

export interface MessageDetail extends MessageSummary {
  to: string;
  text: string;
  /** True when the body was cut short, by the fetch cap or the text cap. */
  truncated: boolean;
}

// ── Validation helpers ───────────────────────────────────────────────────────

export function isImapConfigUsable(cfg: ImapConfig): boolean {
  return isHostname(cfg.host) && !cfg.host.startsWith("-") && isPort(cfg.port) && cfg.user.length > 0;
}

/**
 * IMAP mailbox names are an astring: anything but CR, LF and NUL. The quoting
 * below handles `"` and `\`, so the only hard rule is "no line breaks" —
 * otherwise a mailbox name from a caller could inject a second command.
 */
export function isMailboxNameSafe(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !/[\r\n\0]/.test(name);
}

function quoted(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

/** Remove anything that looks like the configured secret from a string. */
function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("***");
    out = out.split(quoted(secret)).join("***");
    out = out.split(Buffer.from(secret, "utf8").toString("base64")).join("***");
  }
  return out;
}

// ── Header decoding ──────────────────────────────────────────────────────────

/**
 * Decode a charset node knows about, falling back to latin1 — which cannot
 * throw and gets Western European text approximately right — rather than
 * dropping the header entirely.
 */
function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = charset.toLowerCase();
  if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return bytes.toString("utf8");
  }
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252" || cs === "cp1252") {
    return bytes.toString("latin1");
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/**
 * RFC 2047 encoded-words: `=?UTF-8?B?...?=` / `=?ISO-8859-1?Q?...?=`. Real
 * subject lines from real providers are full of these, and an undecoded one is
 * unreadable rather than merely ugly.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([A-Za-z0-9._-]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          return decodeBytes(Buffer.from(payload, "base64"), charset);
        }
        // Q encoding: "_" is a space, "=XX" is a byte.
        const bytes: number[] = [];
        for (let i = 0; i < payload.length; i++) {
          const ch = payload[i];
          if (ch === "_") {
            bytes.push(0x20);
          } else if (ch === "=" && i + 2 < payload.length) {
            const hex = payload.slice(i + 1, i + 3);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return whole;
            bytes.push(parseInt(hex, 16));
            i += 2;
          } else {
            bytes.push(ch.charCodeAt(0) & 0xff);
          }
        }
        return decodeBytes(Buffer.from(bytes), charset);
      } catch {
        return whole;
      }
    },
  );
}

/** Unfold continuation lines, then split "Name: value" pairs. Keys lower-cased. */
export function parseHeaders(raw: string): Record<string, string> {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // First occurrence wins: a second From: is a spoofing attempt, not an update.
    if (!(key in headers)) headers[key] = decodeEncodedWords(value);
  }
  return headers;
}

function decodeQuotedPrintable(input: string): Buffer {
  const bytes: number[] = [];
  const text = input.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(contentType);
  return m ? m[1] : "utf-8";
}

export function decodePart(body: string, contentType: string, encoding: string): string {
  const enc = encoding.trim().toLowerCase();
  const charset = charsetOf(contentType);
  // base64 and quoted-printable arrive as ASCII that SPELLS bytes, so those
  // bytes have to be rebuilt and then read in the part's charset.
  if (enc === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (enc === "quoted-printable") return decodeBytes(decodeQuotedPrintable(body), charset);
  // 7bit, 8bit, binary: nothing spells anything — the part IS its text, already
  // decoded from the fetched bytes by readMessage. Pushing it back through
  // latin1 to "decode" it again is not a no-op: `Buffer.from(s, "binary")`
  // keeps only the low byte of each code unit, so a message sent as plain
  // 8bit UTF-8 — which a great deal of real mail is — loses every character
  // outside ASCII. "Здравей" came out as gibberish; "İ" came out as "0".
  return body;
}

/**
 * Tags whose CONTENT is machinery rather than words. Keyed by our own copy of
 * the name so the closing tag we then search for is this file's string, not a
 * name taken from the message.
 */
const DROP_CONTENT_TAGS = new Map<string, string>([
  ["script", "script"],
  ["style", "style"],
  ["head", "head"],
  ["title", "title"],
]);

/** Tags that end a visual line, so the text keeps the message's shape. */
const LINE_BREAK_TAGS = new Set([
  "br", "p", "div", "tr", "li", "ul", "ol", "table", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);

/** The named entities that turn up in mail, and our copy of what each means. */
const NAMED_ENTITIES = new Map<string, string>([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["#39", "'"],
]);

interface HtmlTag {
  /** Lower-cased element name; "" for a doctype or a bare "<!". */
  name: string;
  closing: boolean;
  /** Index just past the ">" that ends the tag. */
  end: number;
}

/**
 * Read one tag starting at `start` (which must be a "<"), or null when the tag
 * never closes.
 *
 * Attribute values are stepped over in quotes, so `<a title="a>b">` ends at the
 * real ">" instead of the one inside the title — a regex that stops at the
 * first ">" leaves `b">` behind as visible text.
 */
function readTag(html: string, start: number): HtmlTag | null {
  let i = start + 1;
  const closing = html[i] === "/";
  if (closing) i += 1;
  const name = (/^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(i, i + 64))?.[0] ?? "").toLowerCase();
  i += name.length;
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
    if (ch === ">") return { name, closing, end: i + 1 };
  }
  return null;
}

/**
 * Index just past `</name ...>`, or the end of the input when it never closes.
 *
 * The scan walks the ORIGINAL string and lower-cases only the few characters
 * that could be the tag name. Searching a lower-cased COPY instead would be
 * wrong twice over: `toLowerCase()` is not length-preserving (U+0130, Turkish
 * dotted capital I, becomes two code units), so an index into the copy is not
 * an index into the input, and a copy per dropped element makes a message with
 * many <style> blocks quadratic work on a body we did not write.
 */
function skipElementContent(html: string, name: string, from: number): number {
  for (let i = from; i + name.length + 2 <= html.length; i++) {
    if (html[i] !== "<" || html[i + 1] !== "/") continue;
    if (html.slice(i + 2, i + 2 + name.length).toLowerCase() !== name) continue;
    const end = html.indexOf(">", i + 2 + name.length);
    return end < 0 ? html.length : end + 1;
  }
  return html.length;
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

/**
 * HTML to plain text in ONE forward pass.
 *
 * WHY NOT A CHAIN OF `.replace()` CALLS: deleting `<script>…</script>` and then
 * deleting `<…>` rewrites the string, and the rewritten string can contain
 * markup the earlier pass has already walked past — `<scr<script>ipt>` loses
 * its inner tag and leaves a working `<script>` behind. CodeQL calls this an
 * incomplete multi-character sanitization, and it is right: any "remove the
 * dangerous sequence" pass can put the sequence back together.
 *
 * A scanner has no such failure mode. It reads the input once, left to right,
 * and never re-reads what it has emitted: every "<" that starts a tag is
 * consumed together with everything up to the ">" that ends it, so no leftover
 * can be assembled into a tag. Entities are decoded afterwards, on the emitted
 * TEXT only — decoding first, or stripping again after decoding, is what turns
 * `&lt;script&gt;` back into markup.
 *
 * The result is TEXT, not sanitized HTML, and every caller treats it as such:
 * it reaches JSON responses that React escapes, and the MCP reply, and nothing
 * inserts it into a page as markup.
 */
function stripHtml(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch !== "<") {
      out += ch;
      i += 1;
      continue;
    }
    // "a < b" in a message body is arithmetic, not a tag: only a name, a
    // closer, a comment or a declaration starts markup.
    if (!/[A-Za-z!/?]/.test(html[i + 1] ?? "")) {
      out += ch;
      i += 1;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    const tag = readTag(html, i);
    // A "<" with no ">" after it is an unterminated tag; everything left is
    // inside it, so there is no more text to take.
    if (!tag) break;
    i = tag.end;
    const dropped = DROP_CONTENT_TAGS.get(tag.name);
    if (dropped) {
      if (!tag.closing) i = skipElementContent(html, dropped, i);
      continue;
    }
    if (LINE_BREAK_TAGS.has(tag.name)) out += "\n";
  }
  return decodeEntities(out)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Best-effort plain text out of one message. Prefers text/plain, falls back to
 * a de-tagged text/html, and says plainly when it found neither rather than
 * returning something that looks like an empty message.
 *
 * DELIBERATELY SHALLOW: it walks the top level of a multipart body and, for a
 * multipart/alternative nested inside one, one level more. That covers the
 * shapes real mail actually arrives in; a deeper tree returns the notice below,
 * which is honest, instead of a partial body that reads as the whole message.
 */
export function extractText(rawBody: string, headers: Record<string, string>): string {
  const contentType = headers["content-type"] ?? "text/plain";
  const encoding = headers["content-transfer-encoding"] ?? "7bit";

  if (!/^multipart\//i.test(contentType.trim())) {
    const text = decodePart(rawBody, contentType, encoding);
    return /^text\/html/i.test(contentType.trim()) ? stripHtml(text) : text;
  }

  const boundaryMatch = /boundary\s*=\s*"([^"]+)"|boundary\s*=\s*([^;\s]+)/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return "[This message's parts could not be read.]";

  const parts = rawBody.split(`--${boundary}`);
  let htmlFallback: string | null = null;

  for (const part of parts) {
    const trimmed = part.replace(/^\r?\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;
    const split = trimmed.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const partHeaders = parseHeaders(trimmed.slice(0, split));
    const partBody = trimmed.slice(split).replace(/^\r?\n\r?\n/, "");
    const partType = partHeaders["content-type"] ?? "text/plain";

    if (/^multipart\//i.test(partType.trim())) {
      const nested = extractText(partBody, partHeaders);
      if (nested && !nested.startsWith("[")) return nested;
      continue;
    }
    const partEncoding = partHeaders["content-transfer-encoding"] ?? "7bit";
    if (/^text\/plain/i.test(partType.trim())) {
      return decodePart(partBody, partType, partEncoding);
    }
    if (/^text\/html/i.test(partType.trim()) && htmlFallback === null) {
      htmlFallback = stripHtml(decodePart(partBody, partType, partEncoding));
    }
  }

  if (htmlFallback !== null) return htmlFallback;
  return "[This message has no readable text part — it may be an attachment or an unsupported format.]";
}

// ── Protocol engine ──────────────────────────────────────────────────────────

/**
 * One complete server response.
 *
 * `text` has every literal replaced by a NUL-delimited placeholder, which is
 * what makes the FETCH parsing below regex-able: NUL cannot occur in IMAP
 * response text, so a placeholder can never collide with real content.
 */
interface ImapLine {
  text: string;
  literals: Buffer[];
}


export interface CommandResult {
  status: "OK" | "NO" | "BAD";
  /** The tagged line's own text, minus the tag. */
  text: string;
  untagged: ImapLine[];
}

class Session {
  private socket: net.Socket | tls.TLSSocket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: ImapLine[] = [];
  private pending: { resolve: (l: ImapLine) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private closed = false;
  private tagSeq = 0;
  capabilities = new Set<string>();

  constructor(socket: net.Socket | tls.TLSSocket, private readonly secrets: string[]) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    // No setEncoding: literals are byte-counted, and the socket handed to
    // tls.connect() during STARTTLS must still be in binary mode.
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", (err: Error) => this.fail(err));
    this.socket.on("close", () => {
      this.closed = true;
      if (this.pending) {
        this.fail(this.failure ?? new ImapError("network", "The mail server closed the connection unexpectedly."));
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_RESPONSE_BYTES) {
      this.fail(new ImapError("protocol", "The mail server sent an unexpectedly large response."));
      return;
    }
    for (;;) {
      const line = this.consume();
      if (!line) break;
      const waiter = this.pending;
      if (waiter) {
        this.pending = null;
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.queue.push(line);
      }
    }
  }

  /**
   * Pull one complete response off the buffer, resolving literals as it goes.
   *
   * A response is NOT simply "up to the next CRLF": `{123}` at the end of a line
   * means the next 123 bytes are payload and the response continues after them.
   * Getting this wrong is the framing bug that would make every FETCH whose body
   * happens to contain a CRLF parse as garbage, which is all of them.
   */
  private consume(): ImapLine | null {
    let pos = 0;
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const nl = this.buf.indexOf("\r\n", pos);
      if (nl < 0) return null;
      const segment = this.buf.toString("utf8", pos, nl);
      const m = /\{(\d+)\+?\}$/.exec(segment);
      if (!m) {
        this.buf = this.buf.subarray(nl + 2);
        return { text: text + segment, literals };
      }
      const size = Number(m[1]);
      if (!Number.isFinite(size) || size > MAX_LITERAL_BYTES) {
        this.fail(new ImapError("protocol", "The mail server offered more data than ClawBox will read at once."));
        return null;
      }
      const start = nl + 2;
      if (this.buf.length < start + size) return null;
      literals.push(this.buf.subarray(start, start + size));
      text += `${segment.slice(0, m.index)}\u0000LIT${literals.length - 1}\u0000`;
      pos = start + size;
    }
  }

  private fail(err: Error): void {
    this.failure = err;
    const waiter = this.pending;
    this.pending = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private read(): Promise<ImapLine> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new ImapError("network", "The mail server closed the connection."));
    return new Promise<ImapLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new ImapError("network", "The mail server stopped responding."));
      }, COMMAND_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
    });
  }

  /** The untagged greeting. `* OK`, or `* PREAUTH` on a pre-authenticated link. */
  async greeting(): Promise<ImapLine> {
    const line = await this.read();
    if (/^\* (OK|PREAUTH)/i.test(line.text)) {
      this.absorbCapabilities(line.text);
      return line;
    }
    throw new ImapError("protocol", "That server did not answer like an IMAP server.", this.scrub(line.text));
  }

  private absorbCapabilities(text: string): void {
    const m = /\[CAPABILITY ([^\]]*)\]/i.exec(text) ?? /^\* CAPABILITY (.*)$/i.exec(text);
    if (!m) return;
    for (const cap of m[1].trim().split(/\s+/)) {
      if (cap) this.capabilities.add(cap.toUpperCase());
    }
  }

  /**
   * Send one tagged command and collect everything until its tagged reply.
   *
   * `label` is what an error may quote; `line` may contain the password, so the
   * two are separate arguments and only `label` is ever put in a message.
   */
  async command(line: string, label?: string): Promise<CommandResult> {
    if (this.failure) throw this.failure;
    const tag = `A${(++this.tagSeq).toString().padStart(3, "0")}`;
    this.socket.write(`${tag} ${line}\r\n`);
    const untagged: ImapLine[] = [];
    for (;;) {
      const resp = await this.read();
      if (resp.text.startsWith(`${tag} `)) {
        const rest = resp.text.slice(tag.length + 1);
        const m = /^(OK|NO|BAD)\b\s*(.*)$/i.exec(rest);
        if (!m) {
          throw new ImapError("protocol", `The mail server gave an unreadable answer to ${label ?? "a command"}.`, this.scrub(rest));
        }
        this.absorbCapabilities(rest);
        return { status: m[1].toUpperCase() as "OK" | "NO" | "BAD", text: m[2], untagged };
      }
      if (/^\* BYE/i.test(resp.text)) {
        // BYE is the CORRECT answer to LOGOUT (RFC 3501 §7.1.5) and a hang-up
        // in reply to anything else. Treating it as an error either way made
        // every clean logout throw and be swallowed, which hid real hang-ups.
        if (label === "LOGOUT") {
          untagged.push(resp);
          continue;
        }
        throw new ImapError("network", "The mail server hung up.", this.scrub(resp.text));
      }
      // A "+ " continuation is only reachable from commands this client does
      // not send (literals, AUTHENTICATE). Treat it as protocol noise.
      if (!resp.text.startsWith("+ ")) {
        this.absorbCapabilities(resp.text);
        untagged.push(resp);
      }
    }
  }

  /** Replace the socket with a TLS one wrapping it (STARTTLS). */
  async upgrade(servername: string, rejectUnauthorized: boolean): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.buf = Buffer.alloc(0);
    this.queue = [];
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ImapError("tls", "The encrypted connection timed out.")), CONNECT_TIMEOUT_MS);
      // The annotation is load-bearing: `sock` is referenced inside its own
      // initializer, so without it TypeScript falls back to `any` and every
      // listener callback becomes an implicit-any parameter, which fails
      // `next build`'s type-check step under `strict`.
      const sock: tls.TLSSocket = tls.connect({ socket: plain, servername, rejectUnauthorized }, () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.socket = secure;
    this.failure = null;
    this.closed = false;
    // RFC 3501 §6.2.1: capabilities learned before STARTTLS are discarded.
    this.capabilities.clear();
    this.attach();
  }

  /**
   * The one way a server-supplied string is allowed out of this module. Every
   * caller that puts server text into an ImapError must go through here.
   */
  scrub(text: string): string {
    return scrubSecrets(text, this.secrets).replace(/\u0000LIT\d+\u0000/g, "[data]").slice(0, 300);
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }
}

/** The error every abort path raises, so callers can recognise one shape. */
function cancelled(): ImapError {
  return new ImapError("network", "The connection was cancelled.");
}

function classifyConnectError(err: NodeJS.ErrnoException, cfg: ImapConfig): ImapError {
  const where = `${cfg.host} on port ${cfg.port}`;
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new ImapError(
        "network",
        `Could not look up the incoming-mail server "${cfg.host}". Check the spelling in Settings → Email, and that the device is online.`,
      );
    case "ECONNREFUSED":
      return new ImapError("network", `${where} refused the connection. Check the incoming server address.`);
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new ImapError("network", `Could not reach ${where}. Check the device's internet connection.`);
    default:
      break;
  }
  if (/certificate|self.signed|ssl|tls|alert/i.test(err.message || "")) {
    return new ImapError("tls", `The encrypted connection to ${cfg.host} could not be established.`, err.message.slice(0, 200));
  }
  return new ImapError("network", `Could not connect to ${where}.`);
}

function connectSocket(cfg: ImapConfig, rejectUnauthorized: boolean, signal?: AbortSignal): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ImapError("network", `Could not reach ${cfg.host} on port ${cfg.port} — the connection timed out.`));
    }, CONNECT_TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(cancelled());
    };
    const onReady = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(classifyConnectError(err, cfg));
    };
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized }, onReady)
      : net.connect({ host: cfg.host, port: cfg.port }, onReady);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function openSession(cfg: ImapConfig, rejectUnauthorized: boolean, signal?: AbortSignal): Promise<Session> {
  const socket = await connectSocket(cfg, rejectUnauthorized, signal);
  const session = new Session(socket, [cfg.password]);
  await session.greeting();

  if (session.capabilities.size === 0) {
    const caps = await session.command("CAPABILITY", "CAPABILITY");
    if (caps.status !== "OK") {
      session.close();
      throw new ImapError("protocol", `${cfg.host} rejected the IMAP handshake.`, session.scrub(caps.text));
    }
  }

  if (!cfg.secure) {
    if (!session.capabilities.has("STARTTLS")) {
      if (cfg.requireTls !== false) {
        session.close();
        throw new ImapError(
          "tls",
          `${cfg.host}:${cfg.port} does not offer encryption (STARTTLS). ClawBox will not send a mail password over an unencrypted connection — the usual incoming port is 993.`,
        );
      }
    } else {
      const start = await session.command("STARTTLS", "STARTTLS");
      if (start.status !== "OK") {
        session.close();
        throw new ImapError("tls", `${cfg.host} refused to start an encrypted connection.`, session.scrub(start.text));
      }
      try {
        await session.upgrade(cfg.host, rejectUnauthorized);
      } catch (err) {
        session.close();
        throw err instanceof ImapError
          ? err
          : new ImapError(
              "tls",
              `The encrypted connection to ${cfg.host} could not be established. If this is a company mail server with its own certificate, the device may not trust it.`,
              err instanceof Error ? err.message.slice(0, 200) : undefined,
            );
      }
      const caps = await session.command("CAPABILITY", "CAPABILITY");
      if (caps.status !== "OK") {
        session.close();
        throw new ImapError("protocol", `${cfg.host} rejected the IMAP handshake after encryption.`, session.scrub(caps.text));
      }
    }
  }

  // LOGINDISABLED is the server saying "not on this channel". Sending LOGIN
  // anyway would put the app password on the wire to be refused.
  if (session.capabilities.has("LOGINDISABLED")) {
    session.close();
    throw new ImapError(
      "auth",
      `${cfg.host} will not accept a password on this connection. Check that the incoming port is 993.`,
    );
  }

  const login = await session.command(`LOGIN ${quoted(cfg.user)} ${quoted(cfg.password)}`, "LOGIN");
  if (login.status !== "OK") {
    session.close();
    throw new ImapError(
      "auth",
      "The mail server rejected that address and password for reading mail. For Gmail this must be the same 16-character App Password, and IMAP has to be enabled in Gmail's settings.",
      session.scrub(login.text),
    );
  }
  return session;
}

export interface ImapOptions {
  /**
   * Verify the server's certificate. Always true in the product; tests use a
   * plaintext sink with `requireTls: false` instead of turning this off.
   */
  rejectUnauthorized?: boolean;
  /** Hang up as soon as the caller stops caring — routes pass `request.signal`. */
  signal?: AbortSignal;
}

/**
 * Open a session, run `body`, and always close — closing EARLY if the caller
 * aborts, which is what makes the socket go away with the request rather than
 * on its own timeout.
 */
async function withSession<T>(cfg: ImapConfig, opts: ImapOptions, body: (session: Session) => Promise<T>): Promise<T> {
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const session = await openSession(cfg, opts.rejectUnauthorized !== false, signal);
  const onAbort = () => session.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await body(session);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await session.command("LOGOUT", "LOGOUT").catch(() => undefined);
    session.close();
  }
}

/**
 * EXAMINE, never SELECT. See the header: this is the protocol-level guarantee
 * that nothing in a read can modify the mailbox, and it does not depend on the
 * rest of this file being careful.
 */
async function examine(session: Session, mailbox: string): Promise<{ exists: number }> {
  const result = await session.command(`EXAMINE ${quoted(mailbox)}`, "EXAMINE");
  if (result.status !== "OK") {
    throw new ImapError(
      "mailbox",
      `The mailbox "${mailbox}" is not there, or the account cannot open it.`,
      session.scrub(result.text),
    );
  }
  let exists = 0;
  for (const line of result.untagged) {
    const m = /^\* (\d+) EXISTS/i.exec(line.text);
    if (m) exists = Number(m[1]);
  }
  return { exists };
}

// ── FETCH parsing ────────────────────────────────────────────────────────────

interface FetchItem {
  uid: number;
  flags: string[];
  internalDate: string;
  /** The literal that came back for the BODY[...] item, if any. */
  body: Buffer | null;
}

/**
 * Pull the fields we asked for out of one `* n FETCH (...)` response.
 *
 * Regex rather than a full IMAP tokenizer, and that is a real (bounded) choice:
 * every literal is already a NUL placeholder by the time this runs, so the only
 * remaining content is the item names this client itself asked for. It would be
 * wrong for arbitrary FETCH responses; it is exact for the two we send.
 */
export function parseFetchLine(line: ImapLine): FetchItem | null {
  if (!/^\* \d+ FETCH /i.test(line.text)) return null;
  const uidMatch = /\bUID (\d+)/i.exec(line.text);
  if (!uidMatch) return null;
  const flagsMatch = /\bFLAGS \(([^)]*)\)/i.exec(line.text);
  const dateMatch = /\bINTERNALDATE "([^"]*)"/i.exec(line.text);
  // BODY[...] — the response name, even though the request said BODY.PEEK[...].
  const bodyMatch = /\bBODY\[[^\]]*\](?:<\d+>)? (\u0000LIT(\d+)\u0000|"([^"]*)"|NIL)/i.exec(line.text);

  let body: Buffer | null = null;
  if (bodyMatch) {
    if (bodyMatch[2] !== undefined) {
      body = line.literals[Number(bodyMatch[2])] ?? null;
    } else if (bodyMatch[3] !== undefined) {
      body = Buffer.from(bodyMatch[3], "utf8");
    }
  }

  return {
    uid: Number(uidMatch[1]),
    flags: flagsMatch ? flagsMatch[1].split(/\s+/).filter(Boolean) : [],
    internalDate: dateMatch ? dateMatch[1] : "",
    body,
  };
}

function summaryFrom(item: FetchItem): MessageSummary {
  const headers = parseHeaders(item.body ? item.body.toString("utf8") : "");
  return {
    uid: item.uid,
    from: headers.from ?? "(unknown sender)",
    subject: headers.subject ?? "(no subject)",
    date: headers.date ?? item.internalDate,
    unread: !item.flags.some((f) => f.toLowerCase() === "\\seen"),
  };
}

// ── The two operations this whole file exists for ────────────────────────────

export interface ListOptions extends ImapOptions {
  /** How many of the newest messages to return. Clamped to MAX_LIST_LIMIT. */
  limit?: number;
  mailbox?: string;
}

/**
 * The newest `limit` messages: sender, subject, date, read/unread. No bodies.
 *
 * Nothing calls this on a timer. It runs when, and only when, a tool call runs.
 */
export async function listMessages(cfg: ImapConfig, opts: ListOptions = {}): Promise<MessageListing> {
  const mailbox = opts.mailbox?.trim() || DEFAULT_IMAP_MAILBOX;
  if (!isMailboxNameSafe(mailbox)) {
    throw new ImapError("mailbox", "That is not a usable mailbox name.");
  }
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(opts.limit ?? 10)));

  return withSession(cfg, opts, async (session) => {
    const { exists } = await examine(session, mailbox);
    if (exists === 0) return { mailbox, total: 0, unseen: 0, messages: [] };

    // How many are unread overall. A server that refuses this still gives a
    // usable listing, so it degrades to -1 rather than failing the call.
    let unseen = -1;
    const search = await session.command("SEARCH UNSEEN", "SEARCH").catch(() => null);
    if (search && search.status === "OK") {
      unseen = 0;
      for (const line of search.untagged) {
        const m = /^\* SEARCH\b(.*)$/i.exec(line.text);
        if (m) unseen = m[1].trim() ? m[1].trim().split(/\s+/).length : 0;
      }
    }

    const first = Math.max(1, exists - limit + 1);
    // BODY.PEEK — the whole point. BODY[HEADER.FIELDS ...] would set \Seen on
    // every message merely listed, which is the thing this feature promises not
    // to do.
    const fetch = await session.command(
      `FETCH ${first}:${exists} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`,
      "FETCH",
    );
    if (fetch.status !== "OK") {
      throw new ImapError("protocol", "The mail server would not list the messages.", session.scrub(fetch.text));
    }

    const messages = fetch.untagged
      .map(parseFetchLine)
      .filter((item): item is FetchItem => item !== null)
      .map(summaryFrom)
      .sort((a, b) => a.uid - b.uid);

    return { mailbox, total: exists, unseen, messages };
  });
}

export interface ReadOptions extends ImapOptions {
  mailbox?: string;
  /** How many bytes of the raw message to ask for. Clamped to MAX_BODY_FETCH_BYTES. */
  maxBytes?: number;
}

/**
 * One message by UID, as plain text.
 *
 * UID rather than sequence number on purpose: a sequence number means something
 * different the moment anything else touches the mailbox, so an agent that
 * listed and then read could open a different message than the one it named.
 */
/** One message as it arrived, before anything has been made of it. */
export interface RawMessage {
  uid: number;
  /** The whole RFC 5322 message — headers, blank line, body. */
  raw: string;
  unread: boolean;
  internalDate: string;
  /** True when the fetch cap cut the message short. */
  truncated: boolean;
}

/**
 * One message's raw bytes by UID.
 *
 * Extracted from `readMessage` so the FULL VIEW and the agent's text summary
 * fetch identically — same EXAMINE, same BODY.PEEK, same UID semantics — and
 * differ only in what they then make of the result. Two copies of this fetch
 * would be two places for the read-only guarantee to rot.
 */
export async function readRawMessage(cfg: ImapConfig, uid: number, opts: ReadOptions = {}): Promise<RawMessage> {
  if (!Number.isInteger(uid) || uid < 1 || uid > 4294967295) {
    throw new ImapError("protocol", "That is not a valid message id.");
  }
  const mailbox = opts.mailbox?.trim() || DEFAULT_IMAP_MAILBOX;
  if (!isMailboxNameSafe(mailbox)) {
    throw new ImapError("mailbox", "That is not a usable mailbox name.");
  }
  const maxBytes = Math.max(1024, Math.min(MAX_FULL_FETCH_BYTES, Math.floor(opts.maxBytes ?? MAX_BODY_FETCH_BYTES)));

  return withSession(cfg, opts, async (session) => {
    await examine(session, mailbox);
    // BODY.PEEK[]<0.N> — PEEK so reading does not mark it read, and the partial
    // range so the SERVER truncates a huge message instead of sending it all.
    const fetch = await session.command(
      `UID FETCH ${uid} (UID FLAGS INTERNALDATE BODY.PEEK[]<0.${maxBytes}>)`,
      "UID FETCH",
    );
    if (fetch.status !== "OK") {
      throw new ImapError("protocol", "The mail server would not return that message.", session.scrub(fetch.text));
    }
    const item = fetch.untagged.map(parseFetchLine).find((i): i is FetchItem => i !== null);
    if (!item || !item.body) {
      throw new ImapError("mailbox", `There is no message with id ${uid} in "${mailbox}".`);
    }
    return {
      uid: item.uid,
      raw: item.body.toString("utf8"),
      unread: !item.flags.some((f) => f.toLowerCase() === "\\seen"),
      internalDate: item.internalDate,
      truncated: item.body.length >= maxBytes,
    };
  });
}

export async function readMessage(cfg: ImapConfig, uid: number, opts: ReadOptions = {}): Promise<MessageDetail> {
  // The agent's view: flattened, capped text. Unchanged by the full-message
  // view, which parses the same bytes differently rather than replacing this.
  const item = await readRawMessage(cfg, uid, opts);
  const raw = item.raw;
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const rawBody = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");

  let text = extractText(rawBody, headers);
  const cutByText = text.length > MAX_BODY_TEXT_CHARS;
  if (cutByText) text = text.slice(0, MAX_BODY_TEXT_CHARS);

  return {
    uid: item.uid,
    from: headers.from ?? "(unknown sender)",
    to: headers.to ?? "",
    subject: headers.subject ?? "(no subject)",
    date: headers.date ?? item.internalDate,
    unread: item.unread,
    text: text.trim(),
    truncated: item.truncated || cutByText,
  };
}

/** Connect + sign in, then hang up. Used to prove a read mode is actually usable. */
export async function verifyImap(cfg: ImapConfig, opts: ImapOptions = {}): Promise<void> {
  await withSession(cfg, opts, async (session) => {
    await examine(session, DEFAULT_IMAP_MAILBOX);
  });
}

/** Exported for the LOGINDISABLED / literal-framing tests. */
export const _internals = { quoted, scrubSecrets };
