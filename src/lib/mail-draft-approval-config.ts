// Where ClawBox sends an e-mail draft the person approved — and whether it does.
//
// THE SPLIT THIS FEATURE RESTS ON. The assistant may hold a mail tool that can
// only CREATE DRAFTS (an owner-granted Microsoft 365 / mail MCP server). It
// never holds the right to send. Sending is done by a separate HTTP service on
// this box — the "mail send backend" — which holds the mailbox's send
// credential, and ClawBox's web server calls it only when a signed-in person
// presses Send on the draft's card (src/lib/mail-draft-approval.ts).
//
// What is configured here: the backend's base URL and the one header ClawBox
// authenticates to it with. Both live in data/config.json beside the mailbox
// password and the bot tokens (0600, src/lib/config-store.ts), are written only
// by the owner's browser (src/app/setup-api/email/draft-approval/route.ts) and
// are never handed to the harness. The header VALUE is never sent back to any
// caller once saved; the panel only learns that one is set.
//
// DEFAULT OFF. No endpoint, no cards: the draft tool keeps working and the
// draft simply waits in the mailbox's Drafts folder.
//
// ON THE BOX ONLY. The endpoint must be a loopback address. The service it
// names holds a send credential, so it belongs on this device, and a box that
// could be pointed at any host would also be a box that posts the owner's
// approvals (and the auth header) wherever the configuration says.

import { getKnownMany, setMany as configSetMany } from "@/lib/config-store";

export const DRAFT_APPROVAL_ENABLED_KEY = "mail_draft_approval_enabled";
export const DRAFT_APPROVAL_ENDPOINT_KEY = "mail_draft_approval_endpoint";
export const DRAFT_APPROVAL_AUTH_HEADER_KEY = "mail_draft_approval_auth_header";
export const DRAFT_APPROVAL_AUTH_VALUE_KEY = "mail_draft_approval_auth_value";

const KEYS = [
  DRAFT_APPROVAL_ENABLED_KEY,
  DRAFT_APPROVAL_ENDPOINT_KEY,
  DRAFT_APPROVAL_AUTH_HEADER_KEY,
  DRAFT_APPROVAL_AUTH_VALUE_KEY,
] as const;

/** The header ClawBox authenticates with when the owner names none. */
export const DEFAULT_AUTH_HEADER = "Authorization";

export const MAX_ENDPOINT_LEN = 300;
export const MAX_AUTH_VALUE_LEN = 4096;

/** Everything the server needs to talk to the backend. Server-side only. */
export interface DraftApprovalConfig {
  enabled: boolean;
  /** Normalised base URL without a trailing slash, or null when none is saved. */
  endpoint: string | null;
  authHeader: string;
  /** The secret header value, or null when none is saved. NEVER returned to a client. */
  authValue: string | null;
}

/** What the owner's panel may see. No secret in it. */
export interface PublicDraftApprovalConfig {
  enabled: boolean;
  endpoint: string | null;
  authHeader: string;
  hasAuth: boolean;
  /** Switched on AND pointing somewhere: cards will be shown. */
  active: boolean;
}

/** RFC 7230 token characters: what a header NAME may be made of. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/**
 * A header VALUE: visible ASCII and spaces only. No CR or LF — a value with a
 * line break in it is a header injection — and nothing outside ASCII, which
 * `fetch` would refuse at send time rather than at save time.
 */
const HEADER_VALUE_RE = /^[\x20-\x7e]+$/;

/** Headers `fetch` manages itself or that would change what the request is. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection", "cookie", "origin", "referer",
]);

export function isValidAuthHeaderName(name: unknown): name is string {
  return typeof name === "string" && HEADER_NAME_RE.test(name) && !RESERVED_HEADERS.has(name.toLowerCase());
}

export function isValidAuthHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length <= MAX_AUTH_VALUE_LEN
    && value.trim().length > 0
    && HEADER_VALUE_RE.test(value)
  );
}

/** True for the hosts that can only mean "this device". */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  // 127.0.0.0/8, written out in full: `new URL` already turned shorthand such
  // as `127.1` or a decimal `2130706433` into dotted quads.
  const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return quad !== null && quad.slice(1).every((part) => Number(part) <= 255);
}

export type EndpointVerdict =
  | { ok: true; endpoint: string }
  | { ok: false; reason: "invalid" | "not_loopback" | "credentials" | "query" };

/**
 * The backend's base URL, or why it cannot be one.
 *
 * http or https; a loopback host; no user:password in the URL (the header is
 * where the credential goes, and a URL is what ends up in logs); no query or
 * fragment, because ClawBox appends its own paths and parameters.
 */
export function parseBackendEndpoint(raw: unknown): EndpointVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const value = raw.trim();
  if (!value || value.length > MAX_ENDPOINT_LEN) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "invalid" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.search || url.hash || value.includes("?") || value.includes("#")) return { ok: false, reason: "query" };
  if (!isLoopbackHost(url.hostname)) return { ok: false, reason: "not_loopback" };
  const pathname = url.pathname.replace(/\/+$/, "");
  return { ok: true, endpoint: `${url.protocol}//${url.host}${pathname}` };
}

function configFrom(values: Record<string, unknown>): DraftApprovalConfig {
  const endpoint = parseBackendEndpoint(values[DRAFT_APPROVAL_ENDPOINT_KEY]);
  const header = values[DRAFT_APPROVAL_AUTH_HEADER_KEY];
  const value = values[DRAFT_APPROVAL_AUTH_VALUE_KEY];
  return {
    enabled: values[DRAFT_APPROVAL_ENABLED_KEY] === true,
    // A stored value that no longer passes is treated as absent, never used:
    // the check is what keeps the send credential's backend on this device.
    endpoint: endpoint.ok ? endpoint.endpoint : null,
    authHeader: isValidAuthHeaderName(header) ? header : DEFAULT_AUTH_HEADER,
    authValue: isValidAuthHeaderValue(value) ? value : null,
  };
}

/**
 * The configuration, tri-state: `known: false` when the store could not be
 * read. A caller deciding whether to SEND treats unknown as off.
 */
export async function readDraftApprovalConfig(): Promise<{ config: DraftApprovalConfig; known: boolean }> {
  const { values, known } = await getKnownMany(KEYS);
  return { config: configFrom(values), known };
}

/** Switched on and pointing somewhere. */
export function draftApprovalActive(config: DraftApprovalConfig): boolean {
  return config.enabled && config.endpoint !== null;
}

export function publicDraftApprovalConfig(config: DraftApprovalConfig): PublicDraftApprovalConfig {
  return {
    enabled: config.enabled,
    endpoint: config.endpoint,
    authHeader: config.authHeader,
    hasAuth: config.authValue !== null,
    active: draftApprovalActive(config),
  };
}

export interface DraftApprovalUpdate {
  enabled?: boolean;
  endpoint?: string | null;
  authHeader?: string;
  /** A new secret value; `null` removes the saved one; absent keeps it. */
  authValue?: string | null;
}

export type ParsedUpdate =
  | { ok: true; update: DraftApprovalUpdate }
  | { ok: false; field: "enabled" | "endpoint" | "authHeader" | "authValue"; reason: string };

/** Reads the owner's POST body into an update, checking every field it names. */
export function parseDraftApprovalUpdate(body: Record<string, unknown>): ParsedUpdate {
  const update: DraftApprovalUpdate = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, field: "enabled", reason: "invalid" };
    update.enabled = body.enabled;
  }
  if (body.endpoint !== undefined) {
    if (body.endpoint === null || body.endpoint === "") {
      update.endpoint = null;
    } else {
      const verdict = parseBackendEndpoint(body.endpoint);
      if (!verdict.ok) return { ok: false, field: "endpoint", reason: verdict.reason };
      update.endpoint = verdict.endpoint;
    }
  }
  if (body.authHeader !== undefined) {
    if (body.authHeader === null || body.authHeader === "") {
      update.authHeader = DEFAULT_AUTH_HEADER;
    } else if (!isValidAuthHeaderName(body.authHeader)) {
      return { ok: false, field: "authHeader", reason: "invalid" };
    } else {
      update.authHeader = body.authHeader;
    }
  }
  if (body.authValue !== undefined) {
    if (body.authValue === null) {
      update.authValue = null;
    } else if (!isValidAuthHeaderValue(body.authValue)) {
      return { ok: false, field: "authValue", reason: "invalid" };
    } else {
      update.authValue = body.authValue;
    }
  }
  return { ok: true, update };
}

/** Writes an update in one store write, so a half-saved configuration never exists. */
export async function saveDraftApprovalConfig(update: DraftApprovalUpdate): Promise<void> {
  const entries: Record<string, unknown> = {};
  if (update.enabled !== undefined) entries[DRAFT_APPROVAL_ENABLED_KEY] = update.enabled;
  if (update.endpoint !== undefined) entries[DRAFT_APPROVAL_ENDPOINT_KEY] = update.endpoint ?? undefined;
  if (update.authHeader !== undefined) entries[DRAFT_APPROVAL_AUTH_HEADER_KEY] = update.authHeader;
  if (update.authValue !== undefined) entries[DRAFT_APPROVAL_AUTH_VALUE_KEY] = update.authValue ?? undefined;
  if (Object.keys(entries).length > 0) await configSetMany(entries);
}

/** Forgets the backend entirely and switches the cards off. */
export async function clearDraftApprovalConfig(): Promise<void> {
  await configSetMany({
    [DRAFT_APPROVAL_ENABLED_KEY]: false,
    [DRAFT_APPROVAL_ENDPOINT_KEY]: undefined,
    [DRAFT_APPROVAL_AUTH_HEADER_KEY]: undefined,
    [DRAFT_APPROVAL_AUTH_VALUE_KEY]: undefined,
  });
}
