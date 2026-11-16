// "Send this e-mail draft?" — the person's approval, and the only way a draft
// the assistant prepared ever leaves the box.
//
// THE THREAT. The assistant writes drafts with an owner-granted mail tool that
// cannot send. Text it reads (a web page, an inbound mail, a file) may be an
// attacker's, so the assistant must not be able to turn a draft into a sent
// mail by itself — not with a tool, not with its MCP bearer, not by replaying
// something it saw. Only a signed-in PERSON pressing Send may.
//
// HOW. A card in the chat asks this module for an approval (`mintCard`). The
// draft is read from the mail send backend — never from the assistant's words
// — and the card gets a ONE-TIME TOKEN bound to:
//
//   - the signed-in user the card was made for (owner or member of staff),
//   - the draft id,
//   - a hash of the draft's content as the backend holds it,
//   - an expiry.
//
// The token is HMAC-signed with a key derived from the session-signing secret,
// so it cannot be made up, and its card is recorded in a ledger on disk
// (data/mail-draft-approvals.json, 0600) so it can be used once. Pressing Send
// (`decideCard`) checks, in order: the signature, that the person pressing is
// the person it was made for, that it has not been used, that it has not
// expired — then re-reads the draft from the backend and refuses if a single
// byte that decides what is sent has changed. Only then is the backend asked
// to send it.
//
// WHO MAY CALL. Both entry points are reached through
// /setup-api/email/draft-approval/{card,decide}, which accept a person's
// session cookie and nothing else: the MCP bearer middleware admits on every
// other /setup-api route is refused there (src/lib/owner-session.ts), and so
// is a cross-site page riding the cookie (src/lib/same-origin.ts). No MCP tool
// reaches them; the assistant's only tool here (`email_draft_card`) reads
// whether cards are on and returns the line the chat turns into a card.
//
// WHAT THIS DOES NOT COVER, said plainly: an agent that can run shell commands
// as the box's user can read data/config.json and the session secret like any
// other process of that user — the same boundary every other approval on this
// box has. Keep the send backend under its own OS user, and the agent's shell
// behind the operator approvals, and that boundary holds.

import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { getSessionSigningSecret } from "@/lib/auth";
import type { SessionIdentity } from "@/lib/session-identity";
import {
  draftApprovalActive,
  readDraftApprovalConfig,
  type DraftApprovalConfig,
} from "@/lib/mail-draft-approval-config";
import {
  draftView,
  fetchDraft,
  isDraftId,
  sendDraft,
  type DraftView,
} from "@/lib/mail-draft-backend";

const LEDGER_PATH = path.join(DATA_DIR, "mail-draft-approvals.json");

/** How long a card's approval lasts. */
export const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;
const MIN_TTL_S = 10;
const MAX_TTL_S = 24 * 3600;

/**
 * The approval lifetime: 30 minutes, or `CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S`
 * (10 s – 24 h) for a box whose owner wants it shorter or longer. Read per
 * call, so a test can set it.
 */
export function tokenTtlMs(): number {
  const raw = Number(process.env.CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TOKEN_TTL_MS;
  return Math.round(Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, raw)) * 1000);
}

const TOKEN_PREFIX = "cbd1";
const KEY_LABEL = "clawbox/mail-draft-approval/v1";
const HASH_RE = /^[0-9a-f]{64}$/;
const CARD_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_TOKEN_LEN = 4096;

/** How many cards the ledger keeps, newest first. */
const MAX_CARDS = 2000;
const OPEN_KEEP_MS = 24 * 3600_000;
const SETTLED_KEEP_MS = 30 * 24 * 3600_000;
/** A Send that never came back (the server died mid-call) is settled as uncertain after this. */
const SENDING_STALE_MS = 2 * 60_000;

/**
 * `uncertain`: a Send reached the backend and its answer was lost — the mail
 * may have gone. A plain reload never offers that draft's Send again; only the
 * person's explicit "Review again", after being told to check the Sent folder.
 */
export type CardState = "open" | "sending" | "sent" | "kept" | "revised" | "changed" | "failed" | "uncertain";
export type DecisionAction = "send" | "keep" | "revise";

interface CardEntry {
  /** Card id: 16 random bytes, base64url. */
  c: string;
  /** The username the card was made for. */
  u: string;
  /** The draft id. */
  d: string;
  /** The draft's content hash when the card was made. */
  h: string;
  iat: number;
  exp: number;
  state: CardState;
  /** When the state last changed. */
  at: number;
}

interface TokenClaims {
  v: 1;
  c: string;
  u: string;
  d: string;
  h: string;
  e: number;
}

/** What a route answers. */
export interface ApprovalAnswer {
  status: number;
  body: Record<string, unknown>;
}

function refusal(status: number, kind: string, error: string, extra: Record<string, unknown> = {}): ApprovalAnswer {
  return { status, body: { error, kind, ...extra } };
}

const DISABLED = () =>
  refusal(409, "disabled", "Sending approved e-mail drafts is switched off on this ClawBox (Settings → Email).");
const UNAVAILABLE = () =>
  refusal(503, "unavailable", "ClawBox could not check this approval right now. Nothing was sent.");
const FORGED = () => refusal(403, "forged", "This approval is not one ClawBox issued. Nothing was sent.");

// ── the signing key and the token ──────────────────────────────────────────

async function approvalKey(): Promise<Buffer | null> {
  let secret: string | null | undefined;
  try {
    secret = await getSessionSigningSecret();
  } catch {
    return null;
  }
  if (!secret) return null;
  // A key of its own, derived rather than reused: a token is never a valid
  // session cookie, and a cookie is never a valid token.
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

function signature(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(`${TOKEN_PREFIX}.${payload}`).digest();
}

function issueToken(key: Buffer, entry: CardEntry): string {
  const claims: TokenClaims = { v: 1, c: entry.c, u: entry.u, d: entry.d, h: entry.h, e: entry.exp };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${TOKEN_PREFIX}.${payload}.${signature(key, payload).toString("base64url")}`;
}

/** The token's claims when ClawBox signed it, else null. Never throws. */
function readToken(key: Buffer, token: unknown): TokenClaims | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LEN) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = signature(key, payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const c = claims as Partial<TokenClaims> | null;
  if (
    !c
    || c.v !== 1
    || typeof c.c !== "string" || !CARD_ID_RE.test(c.c)
    || typeof c.u !== "string" || !c.u
    || !isDraftId(c.d)
    || typeof c.h !== "string" || !HASH_RE.test(c.h)
    || typeof c.e !== "number" || !Number.isFinite(c.e)
  ) {
    return null;
  }
  return c as TokenClaims;
}

// ── the ledger ─────────────────────────────────────────────────────────────

function isEntry(value: unknown): value is CardEntry {
  const v = value as Partial<CardEntry> | null;
  return (
    typeof v === "object" && v !== null
    && typeof v.c === "string" && typeof v.u === "string" && typeof v.d === "string" && typeof v.h === "string"
    && typeof v.iat === "number" && typeof v.exp === "number" && typeof v.at === "number"
    && ["open", "sending", "sent", "kept", "revised", "changed", "failed", "uncertain"].includes(v.state as string)
  );
}

/**
 * Every card on record. A missing file is an empty ledger; an unreadable or
 * corrupt one THROWS, so a decision is refused rather than taken against a
 * ledger that may have forgotten a token was used.
 */
function readLedger(): CardEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(LEDGER_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(text) as { v?: unknown; cards?: unknown };
  if (parsed?.v !== 1 || !Array.isArray(parsed.cards)) throw new Error("mail-draft-approvals.json is not a ledger");
  return parsed.cards.filter(isEntry);
}

function writeLedger(cards: CardEntry[], now: number): void {
  const kept = cards
    .map((card) => (card.state === "sending" && now - card.at > SENDING_STALE_MS ? { ...card, state: "uncertain" as const, at: now } : card))
    .filter((card) => (card.state === "open" ? card.exp > now - OPEN_KEEP_MS : card.at > now - SETTLED_KEEP_MS))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CARDS);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // config-store's discipline: a fresh temp at 0600, chmod for a stale one,
  // then an atomic rename — a crash leaves the old ledger or the new one.
  const tmp = untraced(`${LEDGER_PATH}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, cards: kept }), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmp, LEDGER_PATH);
}

/**
 * Moves one card from `from` to `to`, or does nothing and says what it found.
 * Synchronous read-modify-write: within this server process no other request
 * runs between the read and the rename, so two presses of one card cannot both
 * see it open.
 */
function transition(cardId: string, from: CardState, to: CardState, now: number): { ok: true } | { ok: false; state: CardState | null } {
  const cards = readLedger();
  const card = cards.find((entry) => entry.c === cardId);
  if (!card) return { ok: false, state: null };
  if (card.state !== from) return { ok: false, state: card.state };
  card.state = to;
  card.at = now;
  writeLedger(cards, now);
  return { ok: true };
}

/** Records a state with no precondition. Used only after a claim succeeded. */
function settle(cardId: string, to: CardState, now: number): void {
  const cards = readLedger();
  const card = cards.find((entry) => entry.c === cardId);
  if (!card) return;
  card.state = to;
  card.at = now;
  writeLedger(cards, now);
}

// ── making a card ──────────────────────────────────────────────────────────

async function activeConfig(): Promise<{ config: DraftApprovalConfig } | { answer: ApprovalAnswer }> {
  const { config, known } = await readDraftApprovalConfig();
  if (!known) return { answer: UNAVAILABLE() };
  if (!draftApprovalActive(config)) return { answer: DISABLED() };
  return { config };
}

function backendRefusal(reason: "unreachable" | "auth" | "bad_response"): ApprovalAnswer {
  if (reason === "auth") {
    return refusal(502, "backend_auth", "The mail service refused ClawBox's credentials. Check Settings → Email → Send approved drafts.");
  }
  if (reason === "bad_response") {
    return refusal(502, "backend_bad", "The mail service gave an answer ClawBox could not read.");
  }
  return refusal(502, "backend_unreachable", "ClawBox could not reach the mail service.");
}

const GONE = () =>
  refusal(404, "gone", "This draft is no longer in the mailbox: it was sent or deleted.");

/**
 * What the ledger alone says about a draft, when that settles it: sent; a
 * Send in flight; a Send whose answer was lost (unless the person asked to
 * review it again, having been told to check the Sent folder).
 */
function settledAnswerIn(cards: CardEntry[], user: string, draftId: string, reopen: boolean): ApprovalAnswer | null {
  const mine = cards.filter((card) => card.u === user && card.d === draftId);
  const sent = mine.find((card) => card.state === "sent");
  if (sent) return { status: 200, body: { state: "sent", decidedAt: sent.at } };
  const now = Date.now();
  // A claim older than a Send can take is one whose server went away mid-call.
  const lost = (card: CardEntry) => card.state === "uncertain" || (card.state === "sending" && now - card.at > SENDING_STALE_MS);
  const sending = mine.find((card) => card.state === "sending" && !lost(card));
  if (sending) return { status: 200, body: { state: "sending", decidedAt: sending.at } };
  if (!reopen) {
    const latest = [...mine].sort((a, b) => b.at - a.at)[0];
    if (latest && lost(latest)) return { status: 200, body: { state: "uncertain", decidedAt: latest.at } };
  }
  return null;
}

function settledAnswer(user: string, draftId: string, reopen: boolean): ApprovalAnswer | null {
  let cards: CardEntry[];
  try {
    cards = readLedger();
  } catch {
    return UNAVAILABLE();
  }
  return settledAnswerIn(cards, user, draftId, reopen);
}

/**
 * The card for one draft, made for the signed-in person asking.
 *
 * `reopen` asks again about a draft the person already kept or sent back for
 * changes — the card's "Review again". A draft already SENT is never offered
 * again: the card says so.
 */
export async function mintCard(
  identity: SessionIdentity,
  draftId: unknown,
  opts: { reopen?: boolean; now?: number } = {},
): Promise<ApprovalAnswer> {
  const now = opts.now ?? Date.now();
  if (!isDraftId(draftId)) return refusal(400, "invalid_draft", "That is not a draft id.");
  const active = await activeConfig();
  if ("answer" in active) return active.answer;
  const key = await approvalKey();
  if (!key) return UNAVAILABLE();

  // Answered from the ledger before the backend is asked: a draft already sent
  // is not fetched again, and one whose Send is in flight or lost is not offered.
  const early = settledAnswer(identity.username, draftId, opts.reopen === true);
  if (early) return early;

  const fetched = await fetchDraft(active.config, identity.username, draftId);
  if (!fetched.ok) return fetched.reason === "not_found" ? GONE() : backendRefusal(fetched.reason);
  const hash = fetched.draft.hash;
  const view: DraftView = draftView(fetched.draft);

  // EVERYTHING FROM HERE IS SYNCHRONOUS, and reads the ledger afresh. The
  // await above let other requests run — another card minted, a Send claimed
  // — and writing back a list read before it would undo them: a card just
  // sent would be written back open.
  let cards: CardEntry[];
  try {
    cards = readLedger();
  } catch {
    return UNAVAILABLE();
  }
  const again = settledAnswerIn(cards, identity.username, draftId, opts.reopen === true);
  if (again) return again;
  const mine = cards.filter((card) => card.u === identity.username && card.d === draftId);

  // Already answered, and nothing has changed since: show the answer, not the
  // question again. A draft the assistant has revised has a new hash and is
  // asked about afresh.
  if (!opts.reopen) {
    const settled = mine
      .filter((card) => card.h === hash && (card.state === "kept" || card.state === "revised"))
      .sort((a, b) => b.at - a.at)[0];
    if (settled) return { status: 200, body: { state: settled.state, decidedAt: settled.at, draft: view } };
  }

  // The same open card when one is still good for a while, so reopening a
  // chat does not grow the ledger by one card per draft per visit. Same
  // claims, same key: the very same token.
  const ttl = tokenTtlMs();
  const reuseMargin = Math.min(2 * 60_000, ttl / 2);
  let card = mine.find((entry) => entry.state === "open" && entry.h === hash && entry.exp - now > reuseMargin);
  if (!card) {
    card = {
      c: randomBytes(16).toString("base64url"),
      u: identity.username,
      d: draftId,
      h: hash,
      iat: now,
      exp: now + ttl,
      state: "open",
      at: now,
    };
    try {
      writeLedger([...cards, card], now);
    } catch {
      return UNAVAILABLE();
    }
  }
  return {
    status: 200,
    body: { state: "open", token: issueToken(key, card), expiresAt: card.exp, draft: view },
  };
}

// ── answering a card ───────────────────────────────────────────────────────

export function isDecisionAction(value: unknown): value is DecisionAction {
  return value === "send" || value === "keep" || value === "revise";
}

/**
 * The person's answer to a card: send the draft, keep it as a draft, or send
 * it back for changes. Every refusal names its kind; nothing is sent unless
 * every check below passed.
 */
export async function decideCard(
  identity: SessionIdentity,
  token: unknown,
  action: unknown,
  opts: { now?: number } = {},
): Promise<ApprovalAnswer> {
  if (!isDecisionAction(action)) return refusal(400, "invalid", "action must be send, keep or revise");
  if (typeof token !== "string" || !token) {
    return refusal(403, "no_approval", "Sending a draft needs the approval from its card. Nothing was sent.");
  }
  const active = await activeConfig();
  if ("answer" in active) return active.answer;
  const key = await approvalKey();
  if (!key) return UNAVAILABLE();

  // 1. Signed by this box.
  const claims = readToken(key, token);
  if (!claims) return FORGED();

  // 2. For the person pressing. Checked before the ledger is read, so another
  //    user learns nothing about the card's state.
  if (claims.u !== identity.username) {
    return refusal(403, "other_user", "This card belongs to another ClawBox user. Nothing was sent.");
  }

  // 3. Issued and still unused. A signed token the ledger has no matching card
  //    for is refused the same way: it cannot be used.
  const now = opts.now ?? Date.now();
  let card: CardEntry | undefined;
  try {
    card = readLedger().find((entry) => entry.c === claims.c);
  } catch {
    return UNAVAILABLE();
  }
  if (!card || card.u !== claims.u || card.d !== claims.d || card.h !== claims.h || card.exp !== claims.e) {
    return refusal(409, "reused", "This approval can no longer be used. Nothing was sent.", { state: null });
  }
  if (card.state !== "open") {
    return refusal(409, "reused", "This approval was already used.", { state: card.state });
  }

  // 4. Not expired.
  if (now >= claims.e) {
    return refusal(410, "expired", "This approval expired. Reload the draft to approve it again. Nothing was sent.");
  }

  if (action === "keep" || action === "revise") {
    const to = action === "keep" ? "kept" : "revised";
    let moved: ReturnType<typeof transition>;
    try {
      moved = transition(card.c, "open", to, now);
    } catch {
      return UNAVAILABLE();
    }
    if (!moved.ok) return refusal(409, "reused", "This approval was already used.", { state: moved.state });
    return { status: 200, body: { state: to } };
  }

  // SEND. Claimed first, so a second press — or a second tab — finds it taken.
  try {
    const claimed = transition(card.c, "open", "sending", now);
    if (!claimed.ok) return refusal(409, "reused", "This approval was already used.", { state: claimed.state });
  } catch {
    return UNAVAILABLE();
  }

  const reopen = () => {
    try {
      settle(card.c, "open", Date.now());
    } catch {
      // The card stays "sending" and is settled as failed later: refused, never sent twice.
    }
  };
  const close = (state: CardState) => {
    try {
      settle(card.c, state, Date.now());
    } catch {
      // Same: a card that could not be settled can no longer be used.
    }
  };

  // 5. The draft as it is NOW, from the backend, against the hash the person approved.
  const fetched = await fetchDraft(active.config, identity.username, claims.d);
  if (!fetched.ok) {
    if (fetched.reason === "not_found") {
      close("failed");
      return GONE();
    }
    // Nothing was sent; the same card may be pressed again.
    reopen();
    return backendRefusal(fetched.reason);
  }
  const hash = fetched.draft.hash;
  if (hash !== claims.h) {
    close("changed");
    return refusal(409, "changed", "The draft changed after this card was shown, so it was not sent. Review the current version.");
  }

  // 6. Send — with the hash, so a backend that checks can refuse a draft
  //    edited between the read above and its own send.
  const sent = await sendDraft(active.config, identity.username, claims.d, hash);
  if (sent.ok) {
    close("sent");
    return { status: 200, body: { state: "sent" } };
  }
  switch (sent.reason) {
    case "changed":
      close("changed");
      return refusal(409, "changed", "The draft changed after this card was shown, so it was not sent. Review the current version.");
    case "not_found":
      close("failed");
      return GONE();
    case "auth":
      reopen();
      return backendRefusal("auth");
    case "refused":
      close("failed");
      return refusal(502, "send_refused", "The mail service refused to send this draft. It is still in the Drafts folder.");
    default:
      close("uncertain");
      return refusal(
        502,
        "send_uncertain",
        "ClawBox lost the mail service's answer, so this draft may or may not have been sent. Check the Sent folder before trying again.",
      );
  }
}

/** For tests: where the ledger lives. */
export const MAIL_DRAFT_LEDGER_PATH = LEDGER_PATH;
