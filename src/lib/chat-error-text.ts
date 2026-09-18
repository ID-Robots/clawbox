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
import { redactCredentialShapes } from "@/lib/incident-sanitize";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import {
  formatFreesUpAt,
  parseClawaiAllowanceRefusal,
  type ClawaiAllowanceKind,
} from "@/lib/clawai-allowance";

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

/**
 * The AI provider refused this box's credential.
 *
 * The customer-visible shape of a revoked, expired or rotated ClawBox AI token
 * (TASK-419): Settings shows a healthy paid badge, and the chat answers
 * "Error: HTTP 403: Invalid token" — true, unactionable, and pointing at a CLI
 * the customer has no reason to open. The remedy is a screen they already have.
 *
 * Matched on the wire wording, like the two predicates above, and deliberately
 * NARROW in two directions. A bare "token" is an ordinary word in this
 * codebase's errors ("context window exceeded: 403000 tokens" must not match),
 * so the number has to stand alone as a status. And the auth wording has to sit
 * NEXT TO that status, because a bare "forbidden" anywhere in the line matches
 * things that have nothing to do with the provider's credential — a web tool
 * fetching a page that answers "403 Forbidden", or a Cloudflare interstitial,
 * both of which reach this function through the Hermes adapter. Those used to
 * fall to the generic "send it again"; turning them into "your sign-in is dead,
 * reconnect the provider" would be a confident lie.
 */
function isCredentialRejected(raw: string): boolean {
  return /\b(?:401|403)\b(?!\s*[\d,])[^.\n]{0,24}?\b(?:invalid[ _-]?token|missing[ _-]?token|invalid[ _-]?api[ _-]?key|auth(?:entication|orization)?[ _-]?(?:error|failed)|unauthor(?:ized|ised))\b/i
    .test(raw);
}

/**
 * What the gateway knew about the run when it declared the turn dead — see
 * `chat-run-failure.ts` for where each field comes from on the wire. Every
 * field is optional: a turn can fail before the provider was ever asked.
 */
export interface ChatRunFailureContext {
  /** The gateway's failover reason token: `format`, `model_not_found`, `rate_limit`, … */
  reason?: string;
  /** Provider id as the gateway names it: `anthropic`, `openai`, `clawai`, … */
  provider?: string;
  /** Model id, bare or `provider/`-prefixed. */
  model?: string;
  /** The provider's refusal as the gateway logged it: `HTTP 400: {"type":"error",…}`. */
  detail?: string;
  /** Set when the turn ended WELL on a fallback: the provider that answered. */
  servedProvider?: string;
  /** Set when the turn ended WELL on a fallback: the model that answered. */
  servedModel?: string;
}

/** The provider's name as the customer knows it, from the id the gateway uses. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  clawai: "ClawBox AI",
  clawbox: "ClawBox AI",
  "clawbox-ai": "ClawBox AI",
  ollama: "the local model runner",
  "github-copilot": "GitHub Copilot",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
};

function providerLabel(provider: string | undefined): string {
  const id = provider?.trim().toLowerCase();
  if (!id) return "the AI provider";
  return PROVIDER_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The provider segment of a `provider/model` reference, when it has one. */
function providerFromRef(model: string | undefined): string | undefined {
  const id = model?.trim();
  const slash = id ? id.indexOf("/") : -1;
  return id && slash > 0 ? id.slice(0, slash) : undefined;
}

/** `anthropic/claude-x` and `claude-x` both read as the bare id. */
function modelLabel(model: string | undefined): string {
  const id = model?.trim();
  if (!id) return "the current model";
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) || id : id;
}

/** How much of the provider's own sentence is worth a bubble. */
const PROVIDER_MESSAGE_MAX = 240;

/** A trailing `, url: …` / `, cf-ray: …` / `, request id: …` field of the transport's framing. */
const TRANSPORT_FIELD_RE = /^\s*(?:url|cf-ray|request id)\s*:/i;

/**
 * Drop the transport's trailing fields, last to first. A split and a loop
 * rather than one anchored regex: the regex form (`(?:,\s*key:[^,]*)+$`) is
 * ambiguous between its `\s*` and `[^,]*` and backtracks exponentially on a
 * hostile line of repeated `,url:` — a provider's error body is untrusted input.
 */
function withoutTrailingTransportFields(text: string): string {
  const parts = text.split(",");
  while (parts.length > 1 && TRANSPORT_FIELD_RE.test(parts[parts.length - 1])) parts.pop();
  return parts.join(",");
}

/**
 * The provider's own words out of the gateway's detail line.
 *
 * The line is `HTTP <status>: <body>` where the body is whatever the provider
 * answered — for Anthropic and OpenAI a JSON error envelope, for a proxy
 * sometimes an HTML page or a bare sentence. The envelope's message is the
 * part written for a person ("Claude Code 2.1.75 does not support this
 * model; version 2.1.251 or newer is required"); the rest is `type`, a
 * `request_id` and braces. A body that is not an envelope is used as it is.
 * Whatever comes out still has to pass the leak rules, like every other
 * message from a failing layer.
 */
function providerMessageFromDetail(detail: string | undefined): string | undefined {
  const line = detail?.trim();
  if (!line) return undefined;
  const framed = line
    .replace(/^HTTP\s+\d{3}\s*:\s*/i, "")
    // The transport's own framing of a non-JSON refusal ("unexpected status
    // 401 Unauthorized: <sentence>., url: …, cf-ray: …, request id: …"):
    // the sentence is the provider's, the rest is plumbing.
    .replace(/^unexpected status\s+\d{3}\s+[A-Za-z ]+:\s*/i, "");
  const body = withoutTrailingTransportFields(framed).trim();
  if (!body) return undefined;
  let text = body;
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      text = envelopeMessage(parsed) ?? "";
    } catch {
      // A truncated envelope: braces and half a key are not a sentence.
      return undefined;
    }
  }
  // A provider echoing the key it refused, masked or not, is still a key
  // fragment in a chat bubble; the sentence stands without it. The inventory is
  // `incident-sanitize.ts`'s — the one this repo already owns, covering the
  // GitHub prefixes, JWTs, Slack tokens and the `token=`/`secret=` pairs as
  // well as `claw_`/`sk-`/`Bearer ` — rather than a second, narrower regex
  // here, so a shape added there reaches this path too. The empty replacement
  // is deliberate: this text becomes a sentence a customer reads.
  //
  // Belt and braces, not the wall. `sanitizeErrorMessage` below rejects the
  // WHOLE message on an unstripped `claw_`/`sk-`/`Bearer `, so anything this
  // misses falls to the generic line rather than into a bubble.
  // "You can find your API key at https://…" is the provider talking to its own
  // developers; the customer's remedy is in our sentence. Cut BEFORE the
  // credential scrub, not after: the shared inventory's token alphabet includes
  // `.`, so it swallows the full stop that ends the sentence the key sits in and
  // this rule would then have no boundary left to cut at.
  const withoutDeveloperUrl = text.replace(/\.\s+[^.]*https?:\/\/[^\s]*.*$/i, ".");
  const plain = redactCredentialShapes(withoutDeveloperUrl, "")
    .replace(/:\s*(?=[.,]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  if (!plain) return undefined;
  const safe = sanitizeErrorMessage(plain);
  if (!safe) return undefined;
  return safe.length > PROVIDER_MESSAGE_MAX ? `${safe.slice(0, PROVIDER_MESSAGE_MAX - 1).trimEnd()}…` : safe;
}

/** The human sentence inside a provider's error envelope, whichever shape it takes. */
function envelopeMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "msg"]) {
    const found = envelopeMessage(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The customer's sentence when the gateway told us WHY the provider failed.
 *
 * Every reason token below is one the gateway's own failover classifier
 * emits (`failoverReason` on its lifecycle and chat error frames). Rate limits
 * and refused credentials are handled before this by the predicates above,
 * which read the same evidence. Returns nothing when the context says
 * nothing a customer can act on — the caller's fallback rules still apply.
 */
function describeProviderFailure(context: ChatRunFailureContext): string | undefined {
  const reason = context.reason?.trim().toLowerCase();
  const provider = providerLabel(context.provider ?? providerFromRef(context.model));
  const model = modelLabel(context.model);
  const message = providerMessageFromDetail(context.detail);
  const quoted = message ? `: “${message}”` : "";
  switch (reason) {
    case "model_not_found":
      return `That message did not go through — ${provider} does not offer the model this chat is set to (${model}). Pick another model in the header and send it again.`;
    case "context_overflow":
      return `That message did not go through — this conversation has grown too long for ${model}. Start a New chat and send it there.`;
    case "billing":
      return `That message did not go through — ${provider} reports a billing problem with this account${quoted}. Check the account with ${provider}, or switch to a different provider in Settings.`;
    case "overloaded":
    case "server_error":
    case "timeout":
    case "empty_response":
      return `That message did not go through — ${provider} is having trouble right now${quoted}. Nothing is broken on this box. Wait a minute and send it again.`;
    case "format":
      return `That message did not go through — ${provider} rejected the request for ${model}${quoted}. Pick another model in the header, or send it again.`;
    default:
      // An unnamed or unclassified reason is still worth the provider's own
      // words when we have them; without them there is nothing to add.
      return message
        ? `That message did not go through — ${provider} answered${quoted}. Pick another model in the header, or send it again.`
        : undefined;
  }
}

/**
 * The gateway's own shrug — what it says when it has no copy for the reason a
 * run died ("The agent run failed before producing a reply.", "agent run
 * failed" on newer cores, "LLM request failed."). It carries nothing, so it
 * must not be relayed as "Error: …" as if it were the reason; ours at least
 * says what to do. Matched on the core's wording, like the predicates above.
 */
function isGatewayShrug(raw: string): boolean {
  return /^(?:⚠️\s*)?(?:the )?agent run failed(?: before producing a reply)?\.?$/i.test(raw)
    || /^LLM request failed(?: with an unknown error)?\.?$/i.test(raw);
}

/**
 * The note under a reply that a FALLBACK model wrote.
 *
 * The header says which model the owner picked; when that model fails and
 * the gateway's configured fallback answers, the reply looks like the
 * pick's — a box (2026-09-17) answered "I'm deepseek-v4-flash" under a header
 * that said GPT-6 Astra, and nothing on screen said why. The reason is on
 * the gateway's `fallback` frame; this turns it into one honest line: which
 * model wrote the reply, why the picked one did not, and the one thing to do.
 * Returns nothing when the context says no fallback happened.
 */
export function describeFallbackReply(context: ChatRunFailureContext): string | undefined {
  if (!context.servedModel) return undefined;
  const served = modelLabel(context.servedModel);
  const picked = modelLabel(context.model);
  const provider = providerLabel(context.provider ?? providerFromRef(context.model));
  const reason = context.reason?.trim().toLowerCase();
  const message = providerMessageFromDetail(context.detail);
  const quoted = message ? ` (“${message}”)` : "";
  const because = (() => {
    switch (reason) {
      case "auth":
      case "auth_permanent":
        return `${provider} did not accept this box's sign-in for ${picked}${quoted}. Reconnect it in Settings, under Providers, to get ${picked} back.`;
      case "rate_limit":
        return `${provider} is rate-limiting this box for ${picked}. It comes back on its own.`;
      case "model_not_found":
        return `${provider} does not offer ${picked}. Pick another model in the header.`;
      case "billing":
        return `${provider} reports a billing problem with the account behind ${picked}${quoted}. Check the account with ${provider}.`;
      case "context_overflow":
        return `this conversation has grown too long for ${picked}. Start a New chat to get it back.`;
      case "overloaded":
      case "server_error":
      case "timeout":
      case "empty_response":
        return `${provider} could not answer for ${picked} right now${quoted}. It usually comes back on its own.`;
      default:
        return `${provider} rejected the request for ${picked}${quoted}. Pick another model in the header if it keeps happening.`;
    }
  })();
  return `This reply came from ${served}, not ${picked}: ${because}`;
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

/**
 * The credential is the problem, and re-linking is the fix — so the sentence
 * names the screen that does it rather than the status code that revealed it.
 * No status number: "403" tells the customer nothing they can act on, and the
 * one thing they can act on is two taps away.
 */
const CREDENTIAL_REJECTED = "That message did not go through — the AI provider is not accepting this box's sign-in any more. Reconnect it in Settings, under Providers, and send it again.";

/** The conversation changed under the turn; retry may work, New chat always does. */
const TAKEOVER = "That message did not go through. That can happen when this chat is open in another tab or on Telegram — or when the session gets stuck. Send it again, and if it keeps failing, start a New chat — that clears it.";

/**
 * A ClawBox AI allowance is spent. Each window gets its own sentence because
 * each has its own remedy: the weekly pool and the memory-indexing meter come
 * back as the week rolls on, while the burst ceiling comes back within hours
 * and the weekly pool still has room — a customer told "the weekly allowance is
 * used up" after a burst refusal would stop for a week over a five-hour wait.
 *
 * The English here is the floor for a caller with no translator; the chat
 * surfaces pass theirs, and the catalogue carries the same keys in every locale.
 */
const ALLOWANCE_KEY: Record<ClawaiAllowanceKind, string> = {
  weekly: "chat.allowanceWeekly",
  burst: "chat.allowanceBurst",
  embeddings: "chat.allowanceEmbeddings",
};

const ALLOWANCE_EN: Record<string, string> = {
  "chat.allowanceWeekly": "That message did not go through — this week's ClawBox AI chat allowance is used up.",
  "chat.allowanceBurst": "That message did not go through — the ClawBox AI 5-hour burst limit is reached. Your weekly allowance still has room.",
  "chat.allowanceEmbeddings": "That did not go through — this week's ClawBox AI memory indexing allowance is used up.",
  "chat.allowanceFreesUpAt": "It frees up at {time}.",
  "chat.allowanceFreesUpLater": "It frees up as older usage leaves the rolling window.",
  "chat.allowanceSeeUsage": "Your usage is in Settings, under Providers.",
};

/** What a chat surface hands in so the sentence comes out in the owner's language and clock. */
export interface ChatFailureWords {
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
  /** The zone "frees up at" is read in; the browser's own when absent. */
  timeZone?: string | null;
}

function allowanceSentence(raw: string, words: ChatFailureWords | undefined): string | null {
  const refusal = parseClawaiAllowanceRefusal(raw);
  if (!refusal) return null;
  // A translator that does not know a key answers the key itself (and, with no
  // provider above it, ignores the params) — the English floor covers both.
  const say = (key: string, params?: Record<string, string | number>): string => {
    const hit = words?.t(key, params);
    let out = hit && hit !== key ? hit : ALLOWANCE_EN[key];
    for (const [name, value] of Object.entries(params ?? {})) out = out.replaceAll(`{${name}}`, String(value));
    return out;
  };
  const time = formatFreesUpAt(refusal.resetAt, { locale: words?.locale ?? "en", timeZone: words?.timeZone ?? null });
  return [
    say(ALLOWANCE_KEY[refusal.kind]),
    time ? say("chat.allowanceFreesUpAt", { time }) : say("chat.allowanceFreesUpLater"),
    say("chat.allowanceSeeUsage"),
  ].join(" ");
}

/**
 * Customer-facing text for a chat turn that ended in `state: "error"`.
 *
 * Always returns something. A silent failure — a turn that just stops with no
 * bubble — is worse than a vague one, because the customer cannot tell whether
 * the box is thinking or dead.
 */
export function describeChatFailure(raw: unknown, context?: ChatRunFailureContext, words?: ChatFailureWords): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  // The predicates read the provider's detail too: a 429 or a 401 lives in
  // the detail line when the gateway's own sentence is the generic one.
  const evidence = [text, context?.detail ?? "", context?.reason ?? ""].join("\n").trim();
  if (!evidence) return GENERIC;
  if (isSessionTakeover(text)) return TAKEOVER;
  // Ahead of the rate limit: a spent allowance also arrives as a 429, and the
  // generic "wait a minute" is exactly the wrong advice for a window that frees
  // up days from now. The refusal names which allowance and when, so say that.
  // Read off the same evidence as the rate limit: the refusal's code sits in
  // the provider's detail line when the gateway's own sentence is the generic one.
  const allowance = allowanceSentence(evidence, words);
  if (allowance) return allowance;
  // Before the sanitizer: the raw rate-limit wording would itself pass the leak
  // rules ("API rate limit reached…" carries no path or handle), so without
  // this the customer would get that bare operator line instead of the calm,
  // actionable one — and a 429 buried in an otherwise unsafe string would be
  // dropped to the generic fallback, losing the one fact that explains it.
  if (isRateLimit(evidence)) return RATE_LIMIT;
  // Before the sanitizer for the same reason as the rate limit: "HTTP 403:
  // Invalid token" carries no path or handle, so it would otherwise pass the
  // leak rules and be relayed verbatim — which is exactly the bubble TASK-419
  // is about.
  if (isCredentialRejected(evidence) || context?.reason === "auth" || context?.reason === "auth_permanent") {
    return CREDENTIAL_REJECTED;
  }
  // The gateway's reason and the provider's words beat the gateway's sentence:
  // for a reason it has no copy for, that sentence is the generic one, and
  // for one it has, ours says the same thing in the customer's terms.
  if (context) {
    const described = describeProviderFailure(context);
    if (described) return described;
  }
  if (!text || isGatewayShrug(text)) return GENERIC;
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
