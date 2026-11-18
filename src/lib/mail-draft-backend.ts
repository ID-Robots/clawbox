// The mail send backend, as ClawBox's web server talks to it.
//
// A small HTTP service on this box holds the mailbox's SEND credential (for
// Microsoft 365, the Mail.Send permission). ClawBox asks it for two things:
//
//   GET  {endpoint}/drafts/{id}?user={username}       → the draft as it is now
//   POST {endpoint}/drafts/{id}/send                  → send that draft
//        body {"user": "...", "draftId": "...", "contentHash": "<sha256 hex>"}
//
// `user` is the ClawBox user the card belongs to (the owner or a member of
// staff), so one backend can serve one mailbox per person. Every request
// carries the auth header the owner configured. The full contract, with the
// answers each status code is read as, is docs/email-draft-approval.md.
//
// WHAT THIS MODULE GUARANTEES: the draft a card shows and the draft whose
// content hash a Send is checked against are both read from the BACKEND, never
// from anything the assistant said. The assistant only ever names a draft id.
//
// Everything a draft contains is text someone else may have written — on a bad
// day, through a prompt injection. It is returned as plain strings, and the
// characters that could make it read differently from what is sent (controls,
// bidi overrides, zero-width and tag characters) are SHOWN as `[U+202E]`-style
// marks rather than silently dropped: the card must read like the mail the
// recipient will get.

import { createHash, randomBytes } from "crypto";
import type { DraftApprovalConfig } from "@/lib/mail-draft-approval-config";
import { sanitizeEmailHtmlReporting, type EmailNode } from "@/lib/email-html";
import { DRAFT_ID_RE } from "@/lib/chat-email-draft-refs";

/** How long one call to the backend may take. */
export const BACKEND_TIMEOUT_MS = 10_000;
/** The most a backend answer may be. A draft is text; a megabyte is plenty. */
export const BACKEND_MAX_BYTES = 1024 * 1024;

const MAX_RECIPIENTS = 500;
const MAX_SUBJECT_CHARS = 1_000;
const MAX_ADDRESS_CHARS = 400;
const MAX_ATTACHMENT_NAME_CHARS = 200;
const MAX_ATTACHMENTS = 100;
/**
 * What the card is given of the body. Above the backend's own 1 MiB answer
 * limit in practice, so a whole body is always shown; a card whose preview
 * WAS cut offers no Send (the person would approve a tail they never saw).
 */
export const MAX_PREVIEW_CHARS = 1_000_000;

/**
 * A draft id as ClawBox accepts it from the assistant and passes to the
 * backend — one pattern, shared with the chat's directive reader.
 */
export { DRAFT_ID_RE };

export function isDraftId(value: unknown): value is string {
  // `.` and `..` would be read as path segments once in the backend's URL
  // (even percent-encoded), and reach paths other than this draft's.
  return typeof value === "string" && DRAFT_ID_RE.test(value) && !/^\.+$/.test(value);
}

export interface DraftAttachment {
  name: string;
  size: number | null;
}

/** One draft, normalised. `body` is exactly what the backend returned. */
export interface MailDraft {
  id: string;
  /** The sender, when the backend names one. */
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Where replies go, when the backend names it. */
  replyTo: string[];
  subject: string;
  bodyType: "text" | "html";
  body: string;
  attachments: DraftAttachment[];
  /** `draftContentHash` of the backend's whole answer. */
  hash: string;
}

/** What a card shows. Plain text only. */
export interface DraftView {
  id: string;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  body: string;
  bodyTruncated: boolean;
  /**
   * The subject or an attachment name was too long to show whole (it ends in
   * "…"). Like a cut body, such a card offers no Send. A recipient is never
   * cut: one too long to show is refused as unreadable.
   */
  headerTruncated: boolean;
  attachments: DraftAttachment[];
  /** Something in it would read differently from what is sent; shown as `[U+…]`. */
  hiddenCharacters: boolean;
}

export type BackendFailure = "unreachable" | "auth" | "bad_response";

export type FetchDraftResult =
  | { ok: true; draft: MailDraft }
  | { ok: false; reason: "not_found" | BackendFailure };

export type SendDraftResult =
  | { ok: true }
  // `uncertain`: the request may have reached the backend and the answer was
  // lost (a timeout, a dropped connection, a 5xx). Never reported as "not sent".
  | { ok: false; reason: "not_found" | "changed" | "auth" | "refused" | "uncertain" };

// ── text hygiene ───────────────────────────────────────────────────────────

/**
 * Characters that change how a line READS without being visible, or carry text
 * nobody sees:
 *
 *   - C0/C1 controls (bar tab and newline, handled per field) and DEL;
 *   - every Unicode format character (`Cf`): the bidi embeddings, overrides,
 *     isolates and marks (U+061C, U+200E/F, U+202A-U+202E, U+2066-U+2069), the
 *     zero-width space, non-joiner and joiner, the word joiner and invisible
 *     operators (U+2060-U+2064), the Mongolian vowel separator, the BOM, the
 *     interlinear annotations, and the TAG block (U+E0000-U+E007F), which
 *     spells ASCII no one can see;
 *   - every other default-ignorable code point: the soft hyphen, the combining
 *     grapheme joiner, the Hangul fillers, the variation selectors
 *     (U+FE00-U+FE0F, U+E0100-U+E01EF) and the reserved ignorables.
 *
 * The `u` flag makes an astral one (a tag, a supplementary variation selector)
 * one match, marked by its real code point, not two surrogate halves.
 */
const HIDDEN_CLASS = String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]`;

/**
 * The few places some of those characters are simply how an emoji is written,
 * matched FIRST so their joiners are left alone: the ZWJ in a family or
 * "woman technologist" emoji, the U+FE0F of a red heart or a keycap 1, and
 * the tags of the three standard subdivision flags (England, Scotland,
 * Wales). Marking those would warn about every friendly
 * sign-off. Deliberately narrow (UTS #51's emoji sequence, cut down): a
 * variation selector only after a pictograph or in a keycap (never after a
 * plain digit, where it would hide a bit in an invoice total), a joiner only
 * BETWEEN two emoji, and no tag run but those three flags. Everything else is
 * marked, and linear: no `\p{RGI_Emoji}`, whose thousands of alternatives cost
 * seconds on a 1 MiB body of emoji.
 */
const FLAG_TAGS = String.raw`\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}`;
const EMOJI_CORE = String.raw`(?:${FLAG_TAGS}|[#*0-9]\ufe0f?\u20e3|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\ufe0f)?|\p{Emoji_Modifier})`;
const HIDDEN_RE = new RegExp(String.raw`(${EMOJI_CORE}(?:\u200d${EMOJI_CORE})*)|${HIDDEN_CLASS}`, "gu");

function mark(ch: string): string {
  return `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`;
}

/** Each such character as a visible mark, so the card shows that it is there. */
function reveal(value: string): string {
  return value.replace(HIDDEN_RE, (match: string, emoji: string | undefined) => emoji ?? mark(match));
}

/** True when `value` holds a character `reveal` would mark. */
export function hasInvisible(value: string): boolean {
  for (const match of value.matchAll(HIDDEN_RE)) {
    if (match[1] === undefined) return true;
  }
  return false;
}

/** `cleanLine`, saying whether the line had to be cut to `max`. */
function lineOf(value: string, max: number): { line: string; cut: boolean } {
  const line = reveal(value.replace(/[\r\n\t\u2028\u2029]+/g, " ")).trim();
  return line.length > max ? { line: `${line.slice(0, max)}…`, cut: true } : { line, cut: false };
}

/** One line of text (an address, a subject): no line breaks of any kind, invisible characters shown. */
export function cleanLine(value: string, max: number): string {
  return lineOf(value, max).line;
}

/** A body: line breaks kept, every other invisible character shown. */
export function cleanBody(value: string): string {
  return reveal(value.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n"));
}

const BLOCK_TAGS = new Set([
  "p", "div", "hr", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol",
]);

/** The words of an HTML body, through the same sanitiser the mail viewer uses. */
export function htmlToText(html: string): string {
  return htmlToTextReporting(html).text;
}

/**
 * `htmlToText`, saying whether the sanitiser had to drop part of the message
 * (absurdly many nodes, or one run of text past its ceiling). A card that shows
 * a body in part offers no Send, so the cut has to be reported rather than
 * guessed at from the length of what came out: 100,000 characters of text in
 * one run come back as 40,000, far under the preview cap, and the person would
 * have approved a mail they saw the first third of.
 */
export function htmlToTextReporting(html: string): { text: string; truncated: boolean } {
  const out: string[] = [];
  const walk = (nodes: EmailNode[]): void => {
    for (const node of nodes) {
      if (node.type === "text") out.push(node.text);
      else if (node.type === "image") out.push(node.alt ? `[${node.alt}]` : "");
      else {
        if (node.tag === "br") {
          out.push("\n");
          continue;
        }
        if (node.tag === "li") {
          out.push("\n• ");
          walk(node.children);
          continue;
        }
        const block = BLOCK_TAGS.has(node.tag);
        if (block) out.push("\n");
        if (node.tag === "td" || node.tag === "th") out.push(" ");
        if (node.tag === "a" && node.href) {
          // The target, not only the words: "Open invoice" must not hide where it goes.
          const start = out.length;
          walk(node.children);
          const words = out.slice(start).join("").trim();
          const target = node.href.replace(/^mailto:/i, "");
          if (words !== target && words !== node.href) out.push(` <${node.href}>`);
          continue;
        }
        walk(node.children);
        if (block) out.push("\n");
      }
    }
  };
  const sanitized = sanitizeEmailHtmlReporting(html);
  walk(sanitized.nodes);
  return {
    text: out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    truncated: sanitized.truncated,
  };
}

// ── reading a backend's answer ─────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * One recipient: `"a@b"`, `"Name <a@b>"`, `{address, name}` or Graph's
 * `{emailAddress: {...}}`. Null when unreadable — and when too long to show
 * whole: a cut address would show the person part of where the mail goes.
 */
function recipient(value: unknown): string | null {
  if (typeof value === "string") {
    const { line, cut } = lineOf(value, MAX_ADDRESS_CHARS);
    return line && !cut ? line : null;
  }
  const outer = record(value);
  if (!outer) return null;
  const inner = record(outer.emailAddress) ?? outer;
  const address = typeof inner.address === "string" ? lineOf(inner.address, MAX_ADDRESS_CHARS) : { line: "", cut: false };
  const named = typeof inner.name === "string" ? lineOf(inner.name, MAX_ADDRESS_CHARS) : { line: "", cut: false };
  if (address.cut || named.cut) return null;
  const name = named.line;
  if (!address.line) return null;
  return name && name.toLowerCase() !== address.line.toLowerCase() ? `${name} <${address.line}>` : address.line;
}

/**
 * A recipient list, or null when the field is not a list at all. A list that
 * holds something unreadable is refused as a whole: a card that silently
 * dropped one recipient would show the person less than the mail goes to.
 */
function recipients(...candidates: unknown[]): string[] | null {
  const raw = candidates.find((c) => c !== undefined && c !== null);
  if (raw === undefined) return [];
  if (typeof raw === "string") {
    // A comma- or semicolon-separated line, the shape a simple backend sends.
    const parts = raw.split(/[,;]/).map((part) => lineOf(part, MAX_ADDRESS_CHARS));
    if (parts.some((part) => part.cut)) return null;
    const list = parts.map((part) => part.line).filter(Boolean);
    return list.length > MAX_RECIPIENTS ? null : list;
  }
  if (!Array.isArray(raw) || raw.length > MAX_RECIPIENTS) return null;
  const list: string[] = [];
  for (const entry of raw) {
    const one = recipient(entry);
    if (one === null) return null;
    list.push(one);
  }
  return list;
}

function attachments(value: unknown): DraftAttachment[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const list: DraftAttachment[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!item || typeof item.name !== "string") return null;
    const size = typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0 ? Math.floor(item.size) : null;
    list.push({ name: cleanLine(item.name, MAX_ATTACHMENT_NAME_CHARS) || "attachment", size });
  }
  return list;
}

/**
 * The body type a backend named. Absent is text; anything but a string is an
 * answer ClawBox cannot read (null). Never `String(value)`: a backend's JSON
 * such as `{"toString": 1}` makes that throw, and a throw here would leave a
 * card claimed for Send.
 */
function bodyTypeOf(value: unknown): "text" | "html" | null {
  if (value === undefined || value === null) return "text";
  if (typeof value !== "string") return null;
  return value.toLowerCase() === "html" ? "html" : "text";
}

/**
 * A backend's draft JSON, normalised — or null when it is not one.
 *
 * Two shapes are read: the simple one docs/email-draft-approval.md describes
 * (`to`, `cc`, `bcc`, `subject`, `body`, `bodyType`, `attachments`) and a
 * Microsoft Graph `message` passed straight through (`toRecipients`,
 * `ccRecipients`, `bccRecipients`, `body: {contentType, content}`).
 */
export function normalizeDraft(json: unknown, requestedId: string): MailDraft | null {
  const draft = record(json);
  if (!draft) return null;
  // A backend that answers for a different draft than the one asked about is
  // confused, and a card built from its answer would approve the wrong mail.
  if (draft.id !== undefined && draft.id !== requestedId) return null;

  const to = recipients(draft.to, draft.toRecipients);
  const cc = recipients(draft.cc, draft.ccRecipients);
  const bcc = recipients(draft.bcc, draft.bccRecipients);
  const replyTo = recipients(draft.replyTo);
  if (!to || !cc || !bcc || !replyTo) return null;
  let from: string | null = null;
  if (draft.from != null) {
    from = recipient(draft.from);
    if (from === null) return null;
  }

  const subject = typeof draft.subject === "string" ? draft.subject : draft.subject == null ? "" : null;
  if (subject === null) return null;

  let body = "";
  let bodyType: "text" | "html" = "text";
  const graphBody = record(draft.body);
  if (graphBody) {
    if (typeof graphBody.content !== "string") return null;
    body = graphBody.content;
    const type = bodyTypeOf(graphBody.contentType);
    if (type === null) return null;
    bodyType = type;
  } else if (typeof draft.body === "string") {
    body = draft.body;
    const type = bodyTypeOf(draft.bodyType);
    if (type === null) return null;
    bodyType = type;
  } else if (draft.body != null) {
    return null;
  }

  const files = attachments(draft.attachments);
  if (!files) return null;

  // The hash binds the whole answer or there is no card: an answer too deep to
  // canonicalise, or with a number past the double range, is refused here,
  // before one is made for it.
  let hash: string;
  try {
    hash = draftContentHash(json);
  } catch {
    return null;
  }

  return { id: requestedId, from, to, cc, bcc, replyTo, subject, bodyType, body, attachments: files, hash };
}

/**
 * How deep canonicalisation reads. A draft is a flat record with a few lists in
 * it, so this is far past any answer a mailbox gives; it is here to bound the
 * recursion on a stranger's JSON.
 */
export const MAX_CANONICAL_DEPTH = 64;

/** An answer nested deeper than `canonicalJson` reads. Refused, never hashed in part. */
export class TooDeepToHash extends Error {
  constructor() {
    super("the backend's answer nests deeper than ClawBox canonicalises");
    this.name = "TooDeepToHash";
  }
}

/** A number in the answer outside the double range, which has no canonical form. Refused, never hashed. */
export class UnhashableNumber extends Error {
  constructor() {
    super("the backend's answer has a number outside the range ClawBox canonicalises");
    this.name = "UnhashableNumber";
  }
}

/**
 * JSON with every object's keys in sorted order, so the same draft always
 * serialises to the same text however the backend ordered its fields.
 *
 * PAST THE DEPTH LIMIT IT THROWS, and `normalizeDraft` refuses the answer. It
 * used to write `null` in place of everything deeper, which gave two answers
 * that differ only down there the same hash — and the approval is bound to the
 * backend's WHOLE answer, so a difference the hash cannot see is a difference
 * the Send would not refuse. Key order stays as invariant as it ever was.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new TooDeepToHash();
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  // A number past the double range (`1e400`) parses to ±Infinity, which JSON
  // cannot write: `JSON.stringify` would make it `null`, a value no backend
  // following the documented rules (or RFC 8785) would produce. Refused, as an
  // answer too deep is, rather than hashed as something it is not.
  if (typeof value === "number" && !Number.isFinite(value)) throw new UnhashableNumber();
  return JSON.stringify(value) ?? "null";
}

/**
 * The fingerprint a card's approval is bound to: the backend's WHOLE answer
 * for the draft, canonicalised — not a list of fields ClawBox thought to pick.
 * A recipient added, a word in the body, a Reply-To, a header, an
 * attachment's bytes (when the backend includes them or their digest):
 * anything the backend reports that changes after the card was shown makes a
 * different hash, and the Send is refused. The backend may recompute it the
 * same way to check a send itself (docs/email-draft-approval.md).
 */
export function draftContentHash(raw: unknown): string {
  return createHash("sha256").update(`clawbox-mail-draft/v2\n${canonicalJson(raw)}`, "utf8").digest("hex");
}

/** The draft as a card shows it: plain text, capped, with nothing invisible left in it. */
export function draftView(draft: MailDraft): DraftView {
  const converted = draft.bodyType === "html" ? htmlToTextReporting(draft.body) : { text: draft.body, truncated: false };
  const words = converted.text;
  const text = cleanBody(words).trim();
  // Cut by the preview cap, or by a sanitiser ceiling on the way here. Either
  // way the card has only part of the body, and `tooLong` offers no Send.
  const bodyTruncated = converted.truncated || text.length > MAX_PREVIEW_CHARS;
  const subject = lineOf(draft.subject, MAX_SUBJECT_CHARS);
  const shown = [draft.from ?? "", ...draft.to, ...draft.cc, ...draft.bcc, ...draft.replyTo, draft.subject, words, ...draft.attachments.map((a) => a.name)];
  return {
    id: draft.id,
    from: draft.from,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    replyTo: draft.replyTo,
    subject: subject.line,
    body: text.length > MAX_PREVIEW_CHARS ? text.slice(0, MAX_PREVIEW_CHARS) : text,
    bodyTruncated,
    // A name `cleanLine` cut is one character over its cap (the "…").
    headerTruncated: subject.cut || draft.attachments.some((a) => a.name.length > MAX_ATTACHMENT_NAME_CHARS),
    attachments: draft.attachments,
    // Addresses were revealed when they were read; the marks are what to look for there.
    hiddenCharacters: shown.some((part) => hasInvisible(part) || /\[U\+[0-9A-F]{4,6}\]/.test(part)),
  };
}

// ── talking to the backend ─────────────────────────────────────────────────

type Raw =
  | { ok: true; status: number; json: unknown }
  | { ok: false; reason: "unreachable" | "timeout" | "too_large" };

async function readBounded(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BACKEND_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * One request to the backend. `statusOnly`: the caller decides by the status
 * alone (a Send), so the answer's body is never read — it is cancelled
 * unread. A Send the backend has ANSWERED 202 is confirmed by that status; a
 * body that breaks off after it must not turn the confirmed Send into a lost
 * one ("may have gone", and a Review again over mail already in Sent). Only
 * a request that never got a status back is a lost answer.
 *
 * A read's body is read only on a 200, the one status whose body means
 * anything (a draft). Every other status says what it says by itself (404
 * missing, 401/403 credentials refused): its body is cancelled unread, so an
 * oversized or broken one cannot turn a 404 into "could not read" or hide a
 * refused credential.
 */
async function call(
  config: DraftApprovalConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; statusOnly?: boolean },
): Promise<Raw> {
  if (!config.endpoint) return { ok: false, reason: "unreachable" };
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.authValue) headers[config.authHeader] = config.authValue;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${config.endpoint}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // A redirect would carry the auth header somewhere the owner never
      // configured; the backend is on this box and has no reason to send one.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
  if (init.statusOnly || response.status !== 200) {
    // Not awaited: a body that stalls or fails cannot hold up, or undo, the
    // status already in hand. Cancelling frees the connection.
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      // A body already locked or gone needs no cancelling.
    }
    return { ok: true, status: response.status, json: null };
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (text === null) return { ok: false, reason: "too_large" };
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { ok: true, status: response.status, json };
}

function draftPath(draftId: string): string {
  return `/drafts/${encodeURIComponent(draftId)}`;
}

/** The draft as the backend holds it right now. */
export async function fetchDraft(config: DraftApprovalConfig, user: string, draftId: string): Promise<FetchDraftResult> {
  const raw = await call(config, `${draftPath(draftId)}?user=${encodeURIComponent(user)}`, { method: "GET" });
  if (!raw.ok) return { ok: false, reason: raw.reason === "too_large" ? "bad_response" : "unreachable" };
  if (raw.status === 404 || raw.status === 410) return { ok: false, reason: "not_found" };
  if (raw.status === 401 || raw.status === 403) return { ok: false, reason: "auth" };
  if (raw.status !== 200) return { ok: false, reason: "bad_response" };
  const draft = normalizeDraft(raw.json, draftId);
  return draft ? { ok: true, draft } : { ok: false, reason: "bad_response" };
}

/**
 * Asks the backend to send one draft. Called ONLY by the decide route, after a
 * person's approval token has been checked and the draft re-read and matched.
 */
export async function sendDraft(
  config: DraftApprovalConfig,
  user: string,
  draftId: string,
  contentHash: string,
): Promise<SendDraftResult> {
  // Decided by the status alone (`statusOnly`): once one arrives the answer is
  // known, whatever becomes of the body after it.
  const raw = await call(config, `${draftPath(draftId)}/send`, {
    method: "POST",
    body: { user, draftId, contentHash },
    statusOnly: true,
  });
  if (!raw.ok) return { ok: false, reason: "uncertain" };
  if (raw.status >= 200 && raw.status < 300) return { ok: true };
  if (raw.status === 404 || raw.status === 410) return { ok: false, reason: "not_found" };
  if (raw.status === 409 || raw.status === 412) return { ok: false, reason: "changed" };
  if (raw.status === 401 || raw.status === 403) return { ok: false, reason: "auth" };
  // A 4xx is the backend saying no; a 5xx (or a redirect) may have happened
  // after the mail left, so it is not reported as "not sent".
  if (raw.status >= 400 && raw.status < 500) return { ok: false, reason: "refused" };
  return { ok: false, reason: "uncertain" };
}

export type ProbeResult = "ok" | BackendFailure;

/**
 * "Can ClawBox reach the backend, and does it accept the header?" — asked by
 * the owner's Test button. Reads a draft id nobody has, so it touches nothing:
 * a 404 is the healthy answer, and a 200 is one only when it reads as a draft.
 */
export async function probeBackend(config: DraftApprovalConfig, user: string): Promise<ProbeResult> {
  const probeId = `clawbox-probe-${randomBytes(6).toString("hex")}`;
  const raw = await call(config, `${draftPath(probeId)}?user=${encodeURIComponent(user)}`, { method: "GET" });
  if (!raw.ok) return raw.reason === "too_large" ? "bad_response" : "unreachable";
  if (raw.status === 404 || raw.status === 410) return "ok";
  // A 200 is healthy only when it is a draft ClawBox can read, as a card would
  // read it: a port serving some other page answers 200 too.
  if (raw.status === 200) return normalizeDraft(raw.json, probeId) ? "ok" : "bad_response";
  if (raw.status === 401 || raw.status === 403) return "auth";
  return "bad_response";
}
