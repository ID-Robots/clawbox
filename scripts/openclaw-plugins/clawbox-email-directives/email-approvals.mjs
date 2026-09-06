// The owner's "send AB2CD", taken off the wire before the model sees it.
//
// THE SEAM IS THE CORE'S OWN. `before_dispatch` — "Handle an inbound message
// before the normal model dispatch" — is the typed inbound CLAIM hook of the
// pinned 2026.8.1 core (docs/plugins/hooks.md, the hook catalog's channel
// section). Returning `{ handled: true, text }` sends that text back on the
// originating route and ends the turn with no model call at all; returning
// nothing lets the message through untouched.
//
// It needs no conversation-access grant: the core's `conversationHookNameSet`
// covers the prompt/agent hooks only, and this is not one of them. So it rides
// on the plugin ClawBox already installs and enables at every gateway start.
//
// WHY A CLAIM RATHER THAN AN OBSERVATION. `message_received` would see the same
// message, but the owner's reply is an instruction to the BOX, not a remark to
// the assistant: leaving it in the stream would have the agent answer "I can't
// send that for you" beside the box quietly sending it. Claiming also keeps the
// code out of the model's context entirely, which is the property that lets
// ClawBox tell the agent, truthfully, that it does not know the code.
//
// WHAT IT DOES NOT DECIDE. Not who the owner is, not which draft, not whether
// anything is sent. It matches a shape, hands the message and the sender id to
// ClawBox, and relays the answer. Every gate is on the ClawBox side
// (src/app/setup-api/email/chat-reply/route.ts), because a plugin cannot read
// the queue, the fingerprints or the harness's allowlist — and because one
// place to be wrong is the point.
//
// FAIL OPEN, ALWAYS. Anything unexpected — ClawBox down mid-rebuild, no token,
// a timeout — leaves the message to the agent exactly as it would have arrived
// without this plugin. An approval that does not go through is an owner
// repeating himself; a message swallowed by a failed hook is a box that has
// stopped listening.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The words ClawBox acts on, and the shape a reply must have to be one.
 *
 * THE VERBS ARE IN THE SHAPE, and this list has to stay identical to the one in
 * `src/lib/email-approval-reply.ts`. Leaving them out looked tidier — "which
 * words mean approve is the device's decision" — and it was wrong: a bare
 * `[A-Za-z]{1,10}` matches "hello", so "hello there" and "good night" were
 * posted to /email/chat-reply on their way past, and ten of them inside ten
 * minutes spent the route's attempt budget on nothing.
 *
 * This plugin still decides NOTHING. Approve-versus-delete is settled once, on
 * the device; the list here only decides whether to ask. Ordered longest-first
 * so `no` wins over `n`, and case-insensitive because a phone keyboard
 * capitalises the first word of a message.
 *
 * `src/tests/unit/email-approval-reply-parity.test.ts` is what keeps the three
 * copies agreeing. The pattern carries no `\s` and no `$`-before-newline
 * subtlety — the text is trimmed first and the separator is literal spaces and
 * tabs — because those are the two places the three languages disagree.
 */
export const APPROVAL_WORDS = [
  "approve", "okay", "send", "yes", "ok", "y",
  "discard", "cancel", "delete", "reject", "deny", "no", "n",
];

export const APPROVAL_SHAPE = new RegExp(`^(?:${APPROVAL_WORDS.join("|")})[ \\t]+[A-Za-z0-9]{5}$`, "i");

/**
 * The trim the shape assumes — and the one character the two languages
 * disagree about.
 *
 * `String.prototype.trim` treats U+FEFF as whitespace and Python's
 * `str.strip()` does not, so a stray byte order mark on the end of a pasted
 * code made the same message an approval here and ordinary conversation on
 * Hermes. Both copies now take it off explicitly.
 */
export function looksLikeApproval(text) {
  if (typeof text !== "string") return false;
  // A single-character global replace plus the engine's own trim: an
  // anchored-at-the-end run of a character class is the polynomial-ReDoS shape,
  // and this runs on every inbound message on every channel.
  return APPROVAL_SHAPE.test(text.replace(/\ufeff/g, "").trim());
}

/**
 * Long enough for one loopback POST plus the SMTP conversation behind it, and
 * THE SAME NUMBER the Hermes twin uses — two ceilings over identical
 * server-side work is two different answers to one question.
 *
 * The floor is the mail client's own worst case: src/lib/smtp-client.ts allows
 * a 15 s connect and 20 s per command, so a sluggish server can take well over
 * a minute before ClawBox has an answer to give.
 */
const TIMEOUT_MS = 120_000;

const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
const MIN_TOKEN_LEN = 16;

/**
 * What a bearer may be made of.
 *
 * The token is read off disk and interpolated into an `Authorization` header,
 * so its charset is load-bearing twice over: a stray CR or LF would be header
 * injection, and CodeQL rightly flags file data reaching an outbound request
 * (`js/file-access-to-http`) unless the value is rebuilt from characters a
 * pattern allows. `src/lib/mcp-token.ts` mints hex, so this is wide enough for
 * anything token-shaped and narrow enough to be a sanitizer.
 */
const TOKEN_RE = /^([A-Za-z0-9._~+/=-]{16,512})$/;

let cachedToken = null;

/**
 * The per-install bearer /setup-api/* accepts beside a session cookie.
 *
 * Read the way mcp/lib/api.ts reads it — env first, then the file — and cached
 * only on success, so a token written after the gateway started is still picked
 * up. This is not what authorises the approval (the sender id is); it is what
 * gets the request past middleware at all.
 */
function apiToken() {
  if (cachedToken) return cachedToken;
  const fromEnv = (process.env.CLAWBOX_MCP_TOKEN || "").trim();
  if (fromEnv.length >= MIN_TOKEN_LEN) {
    cachedToken = fromEnv;
    return cachedToken;
  }
  try {
    const raw = readFileSync(join(CLAWBOX_ROOT, "data", ".mcp-token"), "utf-8").trim();
    if (raw.length >= MIN_TOKEN_LEN) {
      cachedToken = raw;
      return cachedToken;
    }
  } catch {
    // No token on this box: nothing here can work, and the message goes on to
    // the agent, which is the state every box was in before this existed.
  }
  return null;
}

/**
 * The sender, from the fields the core promises for an inbound context.
 *
 * `ctx.senderId` is the first-class field the docs tell hooks to prefer; the
 * event's own copy is the fallback for a channel that filled only that one. A
 * blank is left blank rather than defaulted — ClawBox refuses an empty sender,
 * and inventing one here would be the one way to turn "we do not know who this
 * is" into an approval.
 */
function senderOf(event, ctx) {
  for (const candidate of [ctx?.senderId, event?.senderId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return "";
}

function contentOf(event) {
  for (const candidate of [event?.content, event?.body]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

/**
 * `{ handled: true }` when ClawBox settled a draft, `undefined` otherwise.
 *
 * `undefined` and not `{ handled: false }`: the dispatcher reads a falsy result
 * as "this handler had no opinion", which is exactly what every path but a
 * settled approval means.
 */
/**
 * One POST to ClawBox.
 *
 * Answers `{ status, claim }` rather than just the claim, because the caller
 * has to tell an authorization failure — worth one retry with a re-read token —
 * from every other unhappy answer, which is not.
 */
async function ask(token, body) {
  // Rebuilt from the match, never tested and passed through — see TOKEN_RE.
  const matched = TOKEN_RE.exec(token.trim());
  if (!matched) return { status: 0, claim: undefined };
  const res = await fetch(`${API_BASE}/setup-api/email/chat-reply`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${matched[1]}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { status: res.status, claim: undefined };
  const answer = await res.json();
  if (!answer || answer.handled !== true) return { status: res.status, claim: undefined };
  // A CLAIM WITH NO TEXT, even though this hook could carry one. ClawBox posts
  // the verdict itself, so answering here as well would give the owner two
  // messages for one approval — and it has to be ClawBox either way, because a
  // hook that TIMED OUT has to claim the message silently (the mail may already
  // be going) and cannot say anything at all. One path is the only way both
  // editions and both timings say the same thing once. `answer.reply` is read
  // by nothing here on purpose.
  return { status: res.status, claim: { handled: true } };
}

/**
 * WHERE THE MESSAGE CAME FROM, asked of both signals the core fills in.
 *
 * The allowlist ClawBox checks the sender against is a TELEGRAM one, so the
 * channel travels with the request and the device refuses anything else. A
 * delivery this hook cannot place at all is not offered — an unknown surface is
 * not an argument for treating its ids as Telegram's.
 */
function channelOf(event, ctx) {
  for (const candidate of [ctx?.channelId, event?.channel]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().toLowerCase();
  }
  return "";
}

export async function onBeforeDispatch(event, ctx) {
  const text = contentOf(event);
  if (!looksLikeApproval(text)) return undefined;
  const senderId = senderOf(event, ctx);
  if (!senderId) return undefined;
  const channel = channelOf(event, ctx);
  if (!channel) return undefined;
  const token = apiToken();
  if (!token) return undefined;

  const body = { senderId, text, channel, harness: "openclaw" };

  try {
    let answer = await ask(token, body);
    if (answer.status === 401 || answer.status === 403) {
      // The token this process cached may be older than the file on disk. Read
      // it once more before giving up: a stale cache is a real state and a
      // silent one — every approval would answer 403 for as long as this
      // process happened to stay up.
      cachedToken = null;
      const fresh = apiToken();
      if (fresh && fresh !== token) answer = await ask(fresh, body);
    }
    return answer.claim;
  } catch (err) {
    // A TIMEOUT IS NOT A REFUSAL, and it is the one failure that must not fail
    // open. ClawBox answers only once the whole send has finished, so a timeout
    // means the mail may already be on the wire — and letting the message
    // through would hand the model a "send <code>" it can only answer by
    // queueing the same mail again. Claim it silently; ClawBox posts the
    // verdict itself when it is done.
    //
    // Everything else — connection refused, DNS, a body that is not JSON —
    // means nothing happened, so the message goes on to the agent exactly as it
    // would have without this plugin.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { handled: true };
    return undefined;
  }
}
