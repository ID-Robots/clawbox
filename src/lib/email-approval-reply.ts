// Approving a queued email by REPLYING in the conversation the owner is
// already in — no second bot, no BotFather token, no button.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THE ANSWER GETS BACK IN, AND WHY THAT IS THE WHOLE DESIGN
//
// email-approval-telegram.ts states the constraint this file works within: the
// HARNESS is the single consumer of the main bot's `getUpdates` long poll, so
// ClawBox cannot read that stream. What it CAN do is ask the harness for the
// message, and both harnesses offer exactly that, natively:
//
//   OpenClaw  the typed plugin hook `before_dispatch` — "Handle an inbound
//             message before the normal model dispatch" — which hands a plugin
//             the content and `senderId` and takes `{ handled: true }` as a
//             claim, so a claimed message never reaches the model at all.
//             ClawBox's own plugin registers it beside the outbound hook it
//             already has (scripts/openclaw-plugins/clawbox-email-directives).
//   Hermes    `pre_gateway_dispatch`, fired for every user-originated inbound
//             with the whole MessageEvent, taking `{"action": "skip"}` as the
//             same claim (gateway/run.py in the pinned 0.20.5). Note that it
//             runs BEFORE the harness's own auth, deliberately — so this file
//             does its own, and must.
//
// Both are the harness's own seam, so nothing here polls Telegram and nothing
// here needs a credential Telegram issued. The second bot in email-approval.ts
// stays exactly as it was: the surface with a BUTTON, for an owner who wants
// one, and the fallback when a reply cannot be routed.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT AUTHORISES A SEND HERE, AND WHAT DELIBERATELY DOES NOT
//
// The gate is the SENDER ID the harness reports, checked against the harness's
// own owner allowlist — the identical rule the button path applies to
// `callback_query.from.id` (see ownerChatIds). It is not the code, and it is
// not the agent's word.
//
// THERE IS STILL NO APPROVE VERB ON THE TOOL SURFACE, and there must never be.
// src/lib/owner-session.ts explains why: the agent holds the MCP bearer, so a
// tool that could approve would be a gate answering to the party it exists to
// gate. Nothing in this file is reachable from a tool call — the only caller is
// /setup-api/email/chat-reply, which the harness's own hook posts to with a
// message it took off the wire. A claimed approval message never reaches the
// model on either edition, so the agent does not even see the code go past.
//
// THE CODE IS A NAME, NOT A PASSWORD. Its job is the owner's own instruction
// (queue-2026-09-03, B15): bind the reply to the card id, never "the latest" by
// guess. A bare "send" therefore decides nothing at all — this file answers
// `handled: false` and the message goes on to the agent, which can say which
// draft it means. Sizing and alphabet are in email-approval-prompts.ts.

import { getEmailCredentials } from "@/lib/email-config";
import { draftFingerprint, type PendingEmail } from "@/lib/email-pending";
import {
  buildPromptText,
  MAX_PROMPT_CHARS,
  ownerChatIds,
  retireChatPrompt,
  settlePrompt,
  type CallbackOutcome,
} from "@/lib/email-approval";
import {
  claimPrompt,
  createPrompt,
  findPromptByCode,
  recordPromptMessage,
  removePromptsForDraft,
} from "@/lib/email-approval-prompts";
import { sendOwnerTelegramText } from "@/lib/telegram-owner-send";

/**
 * How many chats one question is POSTED to.
 *
 * A delivery cap and deliberately not an authorization cap, for the reason
 * MAX_PROMPT_CHATS states in email-approval.ts: trimming the list that decides
 * who may ANSWER would make authorization depend on the order the harness
 * happens to list paired users in.
 */
const MAX_NOTICE_CHATS = 5;

/** What `offerReplyApproval` can say. */
export type ReplyOfferOutcome =
  | { kind: "offered"; code: string; chats: number }
  | { kind: "already_asked"; code: string | null }
  | { kind: "no_owner_chat" }
  | { kind: "too_long" }
  | { kind: "failed"; error: string };

/** What one inbound message did. `handled` is what the harness hook acts on. */
export interface ReplyApprovalResult {
  /**
   * True only when ClawBox has DEALT with this message and the harness should
   * stop. Everything else — ordinary conversation, an unknown code, a sender
   * who is not the owner — is false, so the message carries on to the agent and
   * to the harness's own auth exactly as it would have without this feature.
   */
  handled: boolean;
  /** What to say back, when the caller renders replies itself. */
  reply?: string;
  /** For the log and the tests. Never surfaced to the agent. */
  outcome?: CallbackOutcome | "not_command" | "not_owner" | "unknown_code";
}

const APPROVE_WORDS = new Set(["send", "approve", "ok", "okay", "yes", "y"]);
const REJECT_WORDS = new Set(["delete", "deny", "no", "n", "cancel", "reject", "discard"]);

/**
 * A reply that is EXACTLY a verb and a code, or nothing.
 *
 * Strict on purpose, and in two directions. Towards the owner: "send the
 * invoice AB2CD" is a sentence about mail, not an instruction to release one,
 * and a rule loose enough to accept it would fire on things a person said in
 * passing. Towards the plugins: each harness hook runs this shape locally
 * before it calls ClawBox at all, so every ordinary message costs nothing, and
 * the two copies have to agree with this one — email-directive-parity's sibling
 * test pins that.
 */
export function parseApprovalReply(text: string): { verb: "approve" | "reject"; code: string } | null {
  if (typeof text !== "string") return null;
  // TRIM FIRST, then match with no `\s` anywhere. `\s` matches a newline in
  // every one of the three languages this rule is written in, and Python's `$`
  // also matches BEFORE a trailing newline where JavaScript's does not — so a
  // pattern spelled with `\s` and `$` accepts a different set on each edition.
  // Trimming takes the stray whitespace off in a way all three agree on, and a
  // separator of literal spaces and tabs leaves nothing else to disagree about.
  // email-approval-reply-parity.test.ts is what keeps them honest.
  const match = /^([A-Za-z]{1,10})[ \t]+([A-Za-z0-9]{4,8})$/.exec(text.trim());
  if (!match) return null;
  const word = match[1].toLowerCase();
  const code = match[2].toUpperCase();
  if (APPROVE_WORDS.has(word)) return { verb: "approve", code };
  if (REJECT_WORDS.has(word)) return { verb: "reject", code };
  return null;
}

/** The question, with the two lines that say how to answer it. */
export function buildNoticeText(draft: PendingEmail, code: string): string {
  return [
    buildPromptText(draft),
    "",
    `Reply "send ${code}" to send it, or "delete ${code}" to throw it away.`,
  ].join("\n");
}

/**
 * Ask the owner about one freshly-queued draft, in his own conversation.
 *
 * Never throws, for the reason sendApprovalPrompt does not: a question that
 * could not be delivered must not turn a successfully-queued draft into a
 * failed send. The draft is on disk either way and Settings → Email still
 * works; the RESULT is returned so the send route can tell the agent the truth
 * about whether the owner was actually asked.
 */
export async function offerReplyApproval(draft: PendingEmail): Promise<ReplyOfferOutcome> {
  try {
    // ONE question per draft, whichever surface asked it. When the approvals
    // bot has already posted its buttons this finds that prompt and posts
    // nothing — two questions about one email would leave the owner holding two
    // live answers, and the second would only ever say "no longer waiting".
    const created = createPrompt({ draftId: draft.id, fingerprint: draftFingerprint(draft) });
    if (!created) return { kind: "failed", error: "Too many approval requests are already waiting." };
    if (!created.created) return { kind: "already_asked", code: created.prompt.code ?? null };

    const prompt = created.prompt;
    const code = prompt.code;
    if (!code) {
      removePromptsForDraft(draft.id);
      return { kind: "failed", error: "Could not name this draft." };
    }

    const text = buildNoticeText(draft, code);
    if (text.length > MAX_PROMPT_CHARS) {
      // Deliberately not truncated, and the same rule the button path applies:
      // the reading IS the safety mechanism, so there is no one-line send for
      // text the owner was shown only part of.
      removePromptsForDraft(draft.id);
      return { kind: "too_long" };
    }

    const chats = (await ownerChatIds()).slice(0, MAX_NOTICE_CHATS);
    if (chats.length === 0) {
      removePromptsForDraft(draft.id);
      return { kind: "no_owner_chat" };
    }

    let delivered = 0;
    for (const chatId of chats) {
      if (await sendOwnerTelegramText(chatId, text)) {
        // There is no message id to record — this is a plain send, not the
        // inline keyboard the button path edits later — but the CHAT is worth
        // keeping: it is where the verdict goes.
        recordPromptMessage(prompt.handle, { chatId, messageId: 1 });
        delivered += 1;
      }
    }

    if (delivered === 0) {
      // Nobody was asked, so nothing is outstanding. Leaving the prompt behind
      // would leave a code live that nobody has.
      removePromptsForDraft(draft.id);
      return { kind: "failed", error: "Could not reach Telegram" };
    }
    return { kind: "offered", code, chats: delivered };
  } catch (err) {
    console.error("[email/approval] could not ask in chat:", err instanceof Error ? err.message : err);
    return { kind: "failed", error: "Could not ask in chat" };
  }
}

/**
 * One inbound message from the harness.
 *
 * THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY, and it is the button path's
 * order (applyApprovalCallback) for the same reasons:
 *
 *   1. Is this even one of ours? Anything that is not exactly a verb and a code
 *      is left alone, untouched, and goes on to the agent.
 *   2. Is the sender the owner? Checked BEFORE the prompt is claimed, so a
 *      stranger who somehow learns a code cannot burn the owner's question by
 *      typing it — and answered `handled: false` rather than with a refusal,
 *      because the harness has its OWN auth still to run and an unpaired sender
 *      must still meet the pairing flow.
 *   3. Which draft? Looked up without consuming, then claimed by handle —
 *      read-and-removed in one synchronous step, so one code answers once.
 *   4. `settlePrompt` — the freeze check, the send, the receipt — shared with
 *      the button path so no two surfaces can write different records.
 */
export async function applyReplyApproval(input: {
  senderId: string;
  text: string;
  /** Post the verdict over Telegram instead of returning it to be rendered. */
  deliverVerdict?: boolean;
}): Promise<ReplyApprovalResult> {
  const parsed = parseApprovalReply(input.text);
  if (!parsed) return { handled: false, outcome: "not_command" };

  const senderId = String(input.senderId ?? "").trim();
  const owners = await ownerChatIds();
  if (!senderId || !owners.includes(senderId)) {
    // Logged without the code: this is the one line that survives a refused
    // reply, and it should say that a stranger typed, not which draft.
    console.error("[email/approval] a reply naming a draft came from a user who is not on the owner allowlist");
    return { handled: false, outcome: "not_owner" };
  }

  const found = findPromptByCode(parsed.code);
  if (!found) return { handled: false, outcome: "unknown_code" };
  const prompt = claimPrompt(found.handle);
  if (!prompt) return { handled: false, outcome: "unknown_code" };

  // An approval that has been claimed here must not leave the same draft
  // answerable by a button somewhere else.
  await retireChatPrompt(prompt.draftId);

  const settled = await settlePrompt(prompt, parsed.verb === "approve");
  if (input.deliverVerdict) {
    for (const message of prompt.messages) {
      await sendOwnerTelegramText(message.chatId, settled.note).catch(() => undefined);
    }
  }
  return { handled: true, reply: settled.note, outcome: settled.outcome };
}

/**
 * Is there anywhere for a reply-approval question to GO on this device?
 *
 * Asked by /email/send so the agent is told the truth about whether the owner
 * was asked at all, and by nothing else — it is not a gate, and a false here
 * only means the draft waits in Settings → Email as it always did.
 */
export async function replyApprovalPossible(): Promise<boolean> {
  if (!(await getEmailCredentials())) return false;
  return (await ownerChatIds()).length > 0;
}
