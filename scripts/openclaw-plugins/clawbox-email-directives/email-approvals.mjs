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
 * The shape a reply must have, EXACTLY: a word, a code, nothing else.
 *
 * Applied here as well as on the ClawBox side so that an ordinary message costs
 * a regex and no HTTP at all — this hook runs on every inbound message on every
 * channel. The two copies have to agree, and
 * `src/tests/routes/email/email-approval-reply-parity.test.ts` is what keeps
 * them agreeing: the authority is `parseApprovalReply` in
 * src/lib/email-approval-reply.ts.
 */
const APPROVAL_SHAPE = /^\s*[A-Za-z]{1,10}\s+[A-Za-z0-9]{4,8}\s*$/;

/** Long enough for one loopback POST plus an SMTP conversation behind it. */
const TIMEOUT_MS = 60_000;

const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
const MIN_TOKEN_LEN = 16;

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
 * `{ handled: true, text }` when ClawBox settled a draft, `undefined` otherwise.
 *
 * `undefined` and not `{ handled: false }`: the dispatcher reads a falsy result
 * as "this handler had no opinion", which is exactly what every path but a
 * settled approval means.
 */
export async function onBeforeDispatch(event, ctx) {
  const text = contentOf(event);
  if (!APPROVAL_SHAPE.test(text)) return undefined;
  const senderId = senderOf(event, ctx);
  if (!senderId) return undefined;
  const token = apiToken();
  if (!token) return undefined;

  try {
    const res = await fetch(`${API_BASE}/setup-api/email/chat-reply`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // `deliverVerdict` off: this hook can answer in the conversation itself
      // through `text`, which lands in the thread the owner typed in. The
      // Hermes twin cannot — its claim carries no reply — so it asks ClawBox to
      // post the verdict instead. The divergence is the harnesses', not a
      // decision taken twice; see
      // scripts/hermes-plugins/clawbox_email_directives/approvals.py.
      body: JSON.stringify({ senderId, text, deliverVerdict: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const answer = await res.json();
    if (!answer || answer.handled !== true) return undefined;
    return typeof answer.reply === "string" && answer.reply
      ? { handled: true, text: answer.reply }
      : { handled: true };
  } catch {
    return undefined;
  }
}
