// ── What a failed chat turn is allowed to say ───────────────────────────────
//
// When a run ends in `state: "error"`, the gateway hands the client an
// `errorMessage` written for an operator reading a log, and both chat surfaces
// used to render it verbatim. On a real box that produced this, in the
// customer's transcript (TASK-440, reproduced on .177 on beta ff04cee):
//
//     Error: session file changed while embedded prompt lock was released:
//       /home/clawbox/.openclaw/agents/main/sessions/3b45304b-…-…jsonl
//     Error: ⚠️ Agent failed before reply: … Logs: openclaw logs --follow
//
// An absolute device path, an internal session UUID, and an instruction to run
// a CLI the customer has no reason to open. TASK-416 closed this class of leak
// for the happy path; the error path was never covered.
//
// The rule here is the same one the attachment and voice paths already follow:
// a message from a failing layer is shown only if it survives
// `sanitizeErrorMessage`, and otherwise the customer gets our own sentence.
// What is different about a chat turn is that the customer can *do* something
// about it — send it again — so the fallback says that rather than apologising.
import { sanitizeErrorMessage } from "@/lib/safe-error-text";

/**
 * The failure OpenClaw reports when the session file changes under a running
 * prompt: another tab, the Telegram channel, a New chat reset landing on a
 * turn that is already running — or, as TASK-512 proved on .177, no second
 * client at all: a session can wedge so that EVERY turn dies this way, for
 * hours, with exactly one tab and one gateway in existence.
 *
 * Matched on the gateway's own wording rather than an invented marker, in the
 * same spirit as `isInternalRoutingMessage`. The wedged case is why the
 * sentence below must not assert a second window as fact, and why it has to
 * name New chat: retrying cures the one-off collision, but New chat is the
 * only recovery that also cures the wedge — and it cured it instantly in
 * every observation. A customer told only to "send it again" keeps hitting
 * the same wall with no way out on screen.
 */
function isSessionTakeover(raw: string): boolean {
  return /session file changed while embedded prompt lock was released/i.test(raw)
    || /session takeover/i.test(raw);
}

/**
 * The provider is rate-limiting this box's requests.
 *
 * An Anthropic 429 reached the owner as "The agent run failed before producing
 * a reply." — a generic dead-end that reads like the box broke. It did not: the
 * gateway had already worded the real cause ("API rate limit reached. Please
 * try again later.") and its failover decision carried `reason=rate_limit`. Any
 * of those signals — the gateway's own wording, the reason token, or a bare 429
 * — means the same thing, so they map to the same sentence.
 *
 * Matched on the wire wording rather than an invented marker, in the same
 * spirit as `isSessionTakeover`. Deliberately narrow: a *size* limit
 * ("Request exceeds the size limit") is a different failure with a different
 * remedy and must keep its own passthrough, so "limit" alone is never enough.
 */
function isRateLimit(raw: string): boolean {
  return /\brate[ _-]?limit(ed|ing|s)?\b/i.test(raw)
    || /\btoo many requests\b/i.test(raw)
    || /(^|[^0-9])429([^0-9]|$)/.test(raw);
}

/** Something went wrong and we will not say what, because we cannot say it safely. */
const GENERIC = "That message did not go through. Send it again — the details stayed in this box's log.";

/**
 * A rate limit is transient and external: the box is fine, the provider is just
 * throttling it. So the sentence names the cause, says the box is not broken,
 * and gives the two real remedies — wait, or switch to another provider in
 * Settings. No "check the log": there is nothing there to act on.
 */
const RATE_LIMIT = "That message did not go through — the AI provider is rate-limiting this box right now. Nothing is broken. Wait a minute and send it again, or switch to a different provider in Settings.";

/** The conversation changed under the turn; retry may work, New chat always does. */
const TAKEOVER = "That message did not go through. That can happen when this chat is open in another tab or on Telegram — or when the session gets stuck. Send it again, and if it keeps failing, start a New chat — that clears it.";

/**
 * Customer-facing text for a chat turn that ended in `state: "error"`.
 *
 * Always returns something. A silent failure — a turn that just stops with no
 * bubble — is worse than a vague one, because the customer cannot tell whether
 * the box is thinking or dead.
 */
export function describeChatFailure(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return GENERIC;
  if (isSessionTakeover(text)) return TAKEOVER;
  // Before the sanitizer: the raw rate-limit wording would itself pass the leak
  // rules ("API rate limit reached…" carries no path or handle), so without
  // this the customer would get that bare operator line instead of the calm,
  // actionable one — and a 429 buried in an otherwise unsafe string would be
  // dropped to the generic fallback, losing the one fact that explains it.
  if (isRateLimit(text)) return RATE_LIMIT;
  const safe = sanitizeErrorMessage(text);
  // A message that passes the leak rules is worth showing: "Request exceeds the
  // size limit" tells the customer what to change, and replacing it with the
  // generic line would throw that away.
  return safe ? `Error: ${safe}` : GENERIC;
}

/** A picture could not be drawn, and we will not say why, because we cannot say it safely. */
const IMAGE_GENERIC = "That picture could not be made. Try again — the details stayed in this box's log.";

/**
 * Customer-facing text for a failed image generation.
 *
 * Separate from `describeChatFailure` only for its fallback sentence. The
 * shared one tells the customer to "send it again", which is the wrong remedy
 * and the wrong noun for a request that was never a message — and getting the
 * noun wrong here is how a support ticket starts with someone re-typing a
 * prompt into a chat that already has it.
 *
 * The rule above it is the same one, and it matters MORE here rather than less:
 * everything this path can report was written by us for a customer, but the
 * layers underneath it are a proxy and a filesystem, and both quote what they
 * were handed. So the sanitizer still decides.
 */
export function describeImageFailure(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return IMAGE_GENERIC;
  const safe = sanitizeErrorMessage(text);
  return safe ?? IMAGE_GENERIC;
}
