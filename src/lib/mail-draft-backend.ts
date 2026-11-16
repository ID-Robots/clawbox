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
// day, through a prompt injection. It is returned as plain strings with the
// characters that could make it read differently from what is sent removed
// (controls, bidi overrides), and never interpreted.

import { createHash, randomBytes } from "crypto";
import type { DraftApprovalConfig } from "@/lib/mail-draft-approval-config";
import { sanitizeEmailHtml, type EmailNode } from "@/lib/email-html";
import { DRAFT_ID_RE } from "@/lib/chat-email-draft-refs";

/** How long one call to the backend may take. */
export const BACKEND_TIMEOUT_MS = 10_000;
/** The most a backend answer may be. A draft is text; a megabyte is plenty. */
export const BACKEND_MAX_BYTES = 1024 * 1024;

const MAX_RECIPIENTS = 500;
const MAX_SUBJECT_CHARS = 1_000;
const MAX_ADDRESS_CHARS = 400;
const MAX_ATTACHMENTS = 100;
/** What the card is given of the body. The hash always covers all of it. */
export const MAX_PREVIEW_CHARS = 20_000;

/**
 * A draft id as ClawBox accepts it from the assistant and passes to the
 * backend — one pattern, shared with the chat's directive reader.
 */
export { DRAFT_ID_RE };

export function isDraftId(value: unknown): value is string {
  return typeof value === "string" && DRAFT_ID_RE.test(value);
}

export interface DraftAttachment {
  name: string;
  size: number | null;
}

/** One draft, normalised. `body` is exactly what the backend returned. */
export interface MailDraft {
  id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyType: "text" | "html";
  body: string;
  attachments: DraftAttachment[];
}

/** What a card shows. Plain text only. */
export interface DraftView {
  id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyTruncated: boolean;
  attachments: DraftAttachment[];
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
 * Characters that change how a line READS without being visible: C0/C1
 * controls (bar tab and newline, handled per field), DEL, the bidi embeddings,
 * overrides and isolates, the line/paragraph separators and the BOM.
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** One line of text (an address, a subject): no line breaks of any kind. */
export function cleanLine(value: string, max: number): string {
  const line = value.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(INVISIBLE_RE, "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A body: line breaks kept, every other invisible character removed. */
export function cleanBody(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(INVISIBLE_RE, "");
}

const BLOCK_TAGS = new Set([
  "p", "div", "hr", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol",
]);

/** The words of an HTML body, through the same sanitiser the mail viewer uses. */
export function htmlToText(html: string): string {
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
        walk(node.children);
        if (block) out.push("\n");
      }
    }
  };
  walk(sanitizeEmailHtml(html));
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── reading a backend's answer ─────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** One recipient: `"a@b"`, `"Name <a@b>"`, `{address, name}` or Graph's `{emailAddress: {...}}`. */
function recipient(value: unknown): string | null {
  if (typeof value === "string") {
    const line = cleanLine(value, MAX_ADDRESS_CHARS);
    return line || null;
  }
  const outer = record(value);
  if (!outer) return null;
  const inner = record(outer.emailAddress) ?? outer;
  const address = typeof inner.address === "string" ? cleanLine(inner.address, MAX_ADDRESS_CHARS) : "";
  const name = typeof inner.name === "string" ? cleanLine(inner.name, MAX_ADDRESS_CHARS) : "";
  if (!address) return null;
  return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
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
    const list = raw
      .split(/[,;]/)
      .map((part) => cleanLine(part, MAX_ADDRESS_CHARS))
      .filter(Boolean);
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
    list.push({ name: cleanLine(item.name, 200) || "attachment", size });
  }
  return list;
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
  if (!to || !cc || !bcc) return null;

  const subject = typeof draft.subject === "string" ? draft.subject : draft.subject == null ? "" : null;
  if (subject === null) return null;

  let body = "";
  let bodyType: "text" | "html" = "text";
  const graphBody = record(draft.body);
  if (graphBody) {
    if (typeof graphBody.content !== "string") return null;
    body = graphBody.content;
    bodyType = String(graphBody.contentType).toLowerCase() === "html" ? "html" : "text";
  } else if (typeof draft.body === "string") {
    body = draft.body;
    bodyType = String(draft.bodyType ?? "text").toLowerCase() === "html" ? "html" : "text";
  } else if (draft.body != null) {
    return null;
  }

  const files = attachments(draft.attachments);
  if (!files) return null;

  return { id: requestedId, to, cc, bcc, subject, bodyType, body, attachments: files };
}

/**
 * The fingerprint a card's approval is bound to: everything that decides what
 * is sent and to whom. Computed over the backend's own values, so any change
 * made after the card was shown — a recipient added, a word in the body, an
 * attachment — makes a different hash and the Send is refused.
 */
export function draftContentHash(draft: MailDraft): string {
  const canonical = JSON.stringify([
    "clawbox-mail-draft/v1",
    draft.id,
    draft.to,
    draft.cc,
    draft.bcc,
    draft.subject,
    draft.bodyType,
    draft.body,
    draft.attachments.map((a) => [a.name, a.size]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The draft as a card shows it: plain text, capped, with nothing invisible left in it. */
export function draftView(draft: MailDraft): DraftView {
  const text = cleanBody(draft.bodyType === "html" ? htmlToText(draft.body) : draft.body).trim();
  const bodyTruncated = text.length > MAX_PREVIEW_CHARS;
  return {
    id: draft.id,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: cleanLine(draft.subject, MAX_SUBJECT_CHARS),
    body: bodyTruncated ? text.slice(0, MAX_PREVIEW_CHARS) : text,
    bodyTruncated,
    attachments: draft.attachments,
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

async function call(config: DraftApprovalConfig, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Raw> {
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
  const raw = await call(config, `${draftPath(draftId)}/send`, {
    method: "POST",
    body: { user, draftId, contentHash },
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
 * a 404 is the healthy answer.
 */
export async function probeBackend(config: DraftApprovalConfig, user: string): Promise<ProbeResult> {
  const probeId = `clawbox-probe-${randomBytes(6).toString("hex")}`;
  const raw = await call(config, `${draftPath(probeId)}?user=${encodeURIComponent(user)}`, { method: "GET" });
  if (!raw.ok) return raw.reason === "too_large" ? "bad_response" : "unreachable";
  if (raw.status === 404 || raw.status === 410 || raw.status === 200) return "ok";
  if (raw.status === 401 || raw.status === 403) return "auth";
  return "bad_response";
}
