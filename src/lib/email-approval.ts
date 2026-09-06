// Approving a queued email from the chat the owner is already in.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS ALLOWED TO BE, AND WHAT IT MUST NEVER BECOME
//
// src/lib/owner-session.ts explains why the approval queue answers to a browser
// session cookie and refuses the MCP bearer: the agent holds that bearer, and
// "a prompt-injected agent would queue a draft and approve it in the next tool
// call, and the owner would see nothing but a sent message."
//
// This file adds a SECOND owner-authenticated path. It does not widen the
// first. In particular there is no tool, no MCP verb and no route the agent can
// call that ends in a send — the agent cannot approve by asking, and it cannot
// approve by reporting that the owner said "I approve". The only thing that
// sends a draft from here is a callback_query that Telegram delivered to a bot
// ClawBox owns exclusively, from a user id that is already on the owner
// allowlist for this device.
//
// If a future change adds a way for the agent to reach applyApprovalCallback()
// — a tool, an unauthenticated route, a "simulate tap" debug verb — the gate is
// gone. See email-approval-telegram.ts for why the bot has to be a separate
// one, which is the part that makes the inbound stream unreachable from the
// agent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS FROZEN AT THE MOMENT THE QUESTION IS ASKED
//
// One prompt names ONE draft id and the fingerprint that draft had when the
// question was posted — the mechanism the desktop batch card uses (#498), not a
// parallel one. A draft the agent queues while the owner is reading has a
// different id, is in no prompt, and cannot ride along on a tap. A draft whose
// content changed no longer matches the fingerprint and is refused rather than
// sent. There is deliberately no "approve everything waiting" button;
// email-pending.ts:129 explains why that shortcut must not exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FULL TEXT, OR NO BUTTON AT ALL
//
// The reading is the safety mechanism: it is what lets a person catch an
// injected instruction before it is mailed to a stranger. So the question
// carries the whole draft — every recipient, the subject and the entire body.
// When that does not fit in one Telegram message the feature STANDS DOWN for
// that draft and says so; it never offers a one-tap send for text the owner was
// only shown part of.

import { getEmailCredentials, toSmtpConfig } from "@/lib/email-config";
import { claimPendingIfUnchanged, draftFingerprint, type PendingEmail } from "@/lib/email-pending";
// A tap is a THIRD approval surface, not a special one: it writes the same
// receipt and resolves the same duplicates as the desktop panel and the chat
// card, so all three agree about what is still waiting.
import { getOutcome, outcomeKindFor, recordOutcome, resolveSent } from "@/lib/email-outcomes";
import {
  advanceOffset,
  claimPrompt,
  countPrompts,
  createPrompt,
  listPrompts,
  readOffset,
  recordPromptMessage,
  removePromptsForDraft,
  type ApprovalPrompt,
} from "@/lib/email-approval-prompts";
import {
  answerCallback,
  CHAT_ID_RE,
  clearApprovalKeyboard,
  fetchApprovalUpdates,
  replyInChat,
  safeBotToken,
  sendApprovalMessage,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramUpdate,
} from "@/lib/email-approval-telegram";
import { get as configGet, getKnown as configGetKnown } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { readHermesApprovedUsers } from "@/lib/hermes-telegram";
import { readTelegramAllowFrom } from "@/lib/openclaw-config";
import { sendMail, SmtpError } from "@/lib/smtp-client";

/** Config keys. Both are owner-only to write; see the chat-approval route. */
export const CHAT_APPROVAL_ENABLED_KEY = "email_chat_approval";
export const CHAT_APPROVAL_TOKEN_KEY = "email_approval_bot_token";

/**
 * OFF unless the owner turned it on. The device that has never been configured
 * behaves exactly as it does today: the draft waits in Settings → Email.
 */
export const CHAT_APPROVAL_DEFAULT = false;

/**
 * How many chats one question is POSTED to. A delivery cap, deliberately not an
 * authorization cap: mirrors coding-agent-notify, where a notice to the
 * household is not a mailing list.
 *
 * It is applied at the fan-out and NOWHERE ELSE. Using it to trim the list that
 * decides who may press the button would make authorization depend on the order
 * the harness happens to list paired users in, and would answer a sixth owner
 * with "this ClawBox does not take approvals from this account" — which reads
 * like a pairing failure rather than the cap it is.
 */
const MAX_PROMPT_CHATS = 5;

/**
 * Telegram's hard limit is 4096 characters for a message. The margin is for the
 * header lines this file adds around the draft; a draft that only fits because
 * the header was short is a draft one edit away from being silently truncated.
 *
 * Exported because email-approval-reply.ts asks the same question of a message
 * built from the same `buildPromptText`, and two numbers would mean one surface
 * standing down where the other did not.
 */
export const MAX_PROMPT_CHARS = 3_800;

const APPROVE_PREFIX = "ea:";
const REJECT_PREFIX = "er:";

/** Telegram's own ceiling for callback_data. Nothing longer can be one of ours. */
const MAX_CALLBACK_DATA = 64;

/** What a tap did, for the log and for the tests. Never surfaced to the agent. */
export type CallbackOutcome =
  | "sent"
  | "rejected"
  | "not_owner"
  | "unknown_button"
  | "expired"
  | "gone"
  | "changed"
  | "unconfigured"
  | "send_failed";

export type PromptOutcome =
  | { kind: "sent"; chats: number }
  | { kind: "off" }
  | { kind: "unconfigured" }
  | { kind: "no_owner_chat" }
  | { kind: "too_long" }
  | { kind: "failed"; error: string };

// ── Is this device using chat approval at all? ───────────────────────────────

/**
 * The approvals bot's own token, and whether ClawBox's store could be read.
 *
 * Tri-state for the same reason the harness readers are: `data/config.json` is
 * a file that can be mid-write, root-owned or on a full disk, and the plain
 * read answers `{}` to all of that. A caller checking whether two bots collide
 * has to tell "there is no approvals bot" from "we could not look" — see
 * /setup-api/telegram/configure, which refuses rather than skipping its guard.
 */
export async function readApprovalBotToken(): Promise<{ token: string | null; known: boolean }> {
  const { value, known } = await configGetKnown(CHAT_APPROVAL_TOKEN_KEY);
  return { token: safeBotToken(value), known };
}

export async function approvalBotToken(): Promise<string | null> {
  return (await readApprovalBotToken()).token;
}

/**
 * Enabled means BOTH switched on AND holding a usable token. A toggle with no
 * bot behind it would queue drafts nobody is ever asked about, which is worse
 * than the feature being off — the owner would be waiting for a message that
 * cannot arrive.
 */
export async function chatApprovalEnabled(): Promise<boolean> {
  const flag = await configGet(CHAT_APPROVAL_ENABLED_KEY);
  const on = typeof flag === "boolean" ? flag : CHAT_APPROVAL_DEFAULT;
  if (!on) return false;
  return (await approvalBotToken()) !== null;
}

/**
 * Who may press the button. THE WHOLE allowlist, never a truncation of it.
 *
 * Read from the HARNESS's own allowlist, not from a list this feature keeps:
 * the people allowed to talk to this ClawBox over Telegram are already written
 * down, by the pairing flow the owner has already been through, and a second
 * list would be a second thing to get out of step. A Telegram user id is global
 * — the same number identifies the owner to every bot — so the ids the main bot
 * has approved are exactly the ids that may approve mail here.
 */
export async function ownerChatIds(): Promise<string[]> {
  const harness = await getActiveHarness();
  const raw =
    harness === "hermes"
      ? (await readHermesApprovedUsers()).map((u) => u.id)
      : await readTelegramAllowFrom();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of raw) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!CHAT_ID_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

// ── Asking ───────────────────────────────────────────────────────────────────

/**
 * The question, in full.
 *
 * Exported so a test can pin what it contains — and, more to the point, what it
 * must not omit. Every recipient and the entire body are here because a person
 * approving a message they have only seen the first line of is not consenting
 * to it.
 */
export function buildPromptText(draft: PendingEmail): string {
  const to = draft.to.join(", ");
  return [
    "ClawBox wants to send an email on your behalf.",
    "",
    `To: ${to}`,
    `Subject: ${draft.subject}`,
    "",
    draft.body,
    "",
    "Approve only if you recognise this message.",
  ].join("\n");
}

/**
 * Ask the owner, in chat, about one freshly-queued draft.
 *
 * Never throws. A question that could not be delivered must not turn a
 * successfully-queued draft into a failed send — the draft is on disk either
 * way and Settings → Email still works. The RESULT is returned rather than
 * swallowed so the send route can tell the agent the truth about whether the
 * owner was actually asked.
 */
export async function sendApprovalPrompt(draft: PendingEmail): Promise<PromptOutcome> {
  try {
    const token = await approvalBotToken();
    if (!token || !(await chatApprovalEnabled())) return { kind: "off" };

    const text = buildPromptText(draft);
    if (text.length > MAX_PROMPT_CHARS) {
      // Deliberately not truncated. See the header: no one-tap send for text
      // the owner was shown only part of.
      return { kind: "too_long" };
    }

    // The cap lives here, at the fan-out, and only here.
    const chats = (await ownerChatIds()).slice(0, MAX_PROMPT_CHATS);
    if (chats.length === 0) return { kind: "no_owner_chat" };

    const created = createPrompt({ draftId: draft.id, fingerprint: draftFingerprint(draft) });
    if (!created) return { kind: "failed", error: "Too many approval requests are already waiting." };
    // Already asked. Asking again would leave two live buttons for one email.
    if (!created.created) return { kind: "sent", chats: created.prompt.messages.length };
    const prompt = created.prompt;

    let delivered = 0;
    let lastError = "";
    for (const chatId of chats) {
      try {
        const messageId = await sendApprovalMessage(token, chatId, text, [
          { text: "Approve & send", callback_data: `${APPROVE_PREFIX}${prompt.handle}` },
          { text: "Delete draft", callback_data: `${REJECT_PREFIX}${prompt.handle}` },
        ]);
        recordPromptMessage(prompt.handle, { chatId, messageId });
        delivered += 1;
      } catch (err) {
        // Telegram's own words, which is what tells an owner they have not
        // pressed Start on the approvals bot yet. Never the token.
        lastError = err instanceof TelegramApiError ? err.message : "Could not reach Telegram";
      }
    }

    if (delivered === 0) {
      // Nobody was asked, so nothing is outstanding. Leaving the prompt behind
      // would keep the poller awake for a button that exists nowhere.
      removePromptsForDraft(draft.id);
      return { kind: "failed", error: lastError || "Could not reach Telegram" };
    }

    startApprovalPoller();
    return { kind: "sent", chats: delivered };
  } catch (err) {
    console.error("[email/approval] could not ask in chat:", err instanceof Error ? err.message : err);
    return { kind: "failed", error: "Could not ask in chat" };
  }
}

/**
 * A draft was decided somewhere else — the desktop panel, the chat card, a
 * reject. Take its buttons out of the chat so the owner is not left holding a
 * control whose only possible answer is "that is no longer waiting".
 *
 * Best effort and never throws: this is tidying, and a failure here must not
 * fail an approval that has already happened.
 */
export async function retireChatPrompt(draftId: string): Promise<void> {
  try {
    const prompts = removePromptsForDraft(draftId);
    if (prompts.length === 0) return;
    const token = await approvalBotToken();
    if (!token) return;
    for (const prompt of prompts) {
      for (const message of prompt.messages) {
        await clearApprovalKeyboard(token, message.chatId, message.messageId).catch(() => undefined);
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Take every outstanding question out of the chat.
 *
 * For the moment the mail account is disconnected: the drafts go, so the
 * buttons have to go with them, and they can only be found while the store
 * still holds the chat and message ids. Clearing the records first would leave
 * live controls in the owner's Telegram whose only possible answer is an error.
 */
export async function retireAllChatPrompts(): Promise<void> {
  try {
    const outstanding = listPrompts();
    for (const prompt of outstanding) await retireChatPrompt(prompt.draftId);
  } catch {
    // best-effort
  }
}

// ── Answering ────────────────────────────────────────────────────────────────

/**
 * What to tell the owner about a draft his tap no longer applies to.
 *
 * "It was already sent or deleted" was the honest answer while nothing
 * remembered which — and it is the ambiguity the receipts store exists to end:
 * the difference between "it went out" and "you threw it away" is the whole
 * question the person tapping is asking. The store is one lookup away, so it is
 * asked, and the vague sentence is kept only for a draft it has no word about
 * (a receipt older than a day, or a build older than the store).
 */
function staleTapAnswer(draftId: string): string {
  const receipt = getOutcome(draftId);
  switch (receipt?.kind) {
    case "sent":
      return "That message has already been sent.";
    case "rejected":
      return "That draft was deleted. Nothing was sent.";
    case "duplicate":
      return "An identical message was sent, so that copy was resolved and not sent again.";
    case "failed":
      return `That message was not sent: ${receipt.error || "the mail server refused it"}.`;
    case "unconfirmed":
      return "That message was handed to the mail server and the answer never came back — check your Sent folder before sending it again.";
    default:
      return "That draft is no longer waiting — it was already sent or deleted.";
  }
}

/**
 * One tap.
 *
 * THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY, so it is spelled out:
 *
 *   1. The button has to be one of ours. An unknown payload is answered and
 *      dropped without touching any state.
 *   2. The presser has to be the owner. This is checked BEFORE the prompt is
 *      claimed, so a stranger who somehow learns a handle cannot burn the
 *      owner's question by pressing it — they get a refusal and the button
 *      stays live for the person it was meant for.
 *   3. The prompt is claimed — read-and-removed in one synchronous step, so a
 *      double tap finds nothing the second time.
 *   4. What is left — the freeze check, the send and the receipt — is
 *      `settlePrompt`, shared with the reply path so the two surfaces cannot
 *      write different records for the same decision.
 */
export async function applyApprovalCallback(query: TelegramCallbackQuery): Promise<CallbackOutcome> {
  const token = await approvalBotToken();
  const data = typeof query.data === "string" ? query.data : "";
  const approve = data.startsWith(APPROVE_PREFIX);
  const reject = data.startsWith(REJECT_PREFIX);

  const say = async (text: string): Promise<void> => {
    if (!token) return;
    await answerCallback(token, query.id, text).catch(() => undefined);
  };

  // The length bound is Telegram's own: callback_data may not exceed 64 bytes,
  // so anything longer did not come from a button we posted and is not worth
  // carrying into a file lookup.
  if ((!approve && !reject) || data.length > MAX_CALLBACK_DATA) {
    await say("That button is not one this ClawBox is waiting on.");
    return "unknown_button";
  }
  const handle = data.slice((approve ? APPROVE_PREFIX : REJECT_PREFIX).length);

  // (2) — before (3), on purpose.
  const owners = await ownerChatIds();
  const presser = String(query.from.id);
  if (!owners.includes(presser)) {
    // Logged without the handle: this is the one line that survives a refused
    // tap, and it should say that a stranger pressed, not which draft.
    console.error("[email/approval] refused a tap from a user who is not on the owner allowlist");
    await say("This ClawBox does not take approvals from this account.");
    return "not_owner";
  }

  const prompt = claimPrompt(handle);
  if (!prompt) {
    await say("That approval request has already been answered or has expired.");
    return "expired";
  }

  const settled = await settlePrompt(prompt, !reject);
  await say(settled.answer);
  await settle(token, prompt, settled.note);
  return settled.outcome;
}

/**
 * What one settled question leaves behind: a verdict for the log and two
 * sentences for the owner.
 *
 * TWO sentences and not one because the button path says them in two places —
 * a `answerCallbackQuery` toast, which is short and disappears, and a reply
 * posted under the question, which stays. The reply path posts `note` only.
 */
export interface PromptSettlement {
  outcome: CallbackOutcome;
  /** The short answer. */
  answer: string;
  /** The lasting one, under the question. */
  note: string;
}

/**
 * DECIDE ONE CLAIMED PROMPT — the step every approval surface shares.
 *
 * It starts AFTER the two checks that differ per surface: the prompt has been
 * claimed (read-and-removed, so one question answers once) and the person
 * asking has been recognised. What is left is the same on all of them, and it
 * has to be, because they write the records the chat card and Settings → Email
 * both render: the freeze check, the send, and the receipt.
 *
 * THE ORDER IS THE CONTRACT, and it is the one applyApprovalCallback documents:
 * the draft is claimed with the fingerprint recorded when the question was
 * posted (so a draft queued during the reading pause cannot ride along, and one
 * whose text changed is refused rather than sent), then — and only then — the
 * SMTP client is handed anything, and the "sent" receipt is written after that
 * call has come back. Nothing here may report a send before it happened; the
 * one case this device genuinely cannot know either way is `unconfirmed`, and
 * both the receipt and the sentence say so in the same words.
 */
export async function settlePrompt(prompt: ApprovalPrompt, approve: boolean): Promise<PromptSettlement> {
  if (!approve) {
    // The same rule the approve path uses, and for the same reason: a draft
    // whose text changed is not the draft the owner read, and throwing away
    // words they never agreed to lose is not ours to do. There is no edit path
    // today; the point is that the day one arrives, both buttons already mean
    // "this exact message".
    const dropped = claimPendingIfUnchanged(prompt.draftId, prompt.fingerprint);
    if (!dropped.ok) {
      const text =
        dropped.reason === "gone"
          ? staleTapAnswer(prompt.draftId)
          : "That draft changed after this message was posted, so it was NOT deleted. Handle it in Settings → Email.";
      return { outcome: dropped.reason === "gone" ? "gone" : "changed", answer: text, note: text };
    }
    recordOutcome(dropped.draft, "rejected");
    return {
      outcome: "rejected",
      answer: "Draft deleted. Nothing was sent.",
      note: "Deleted. This message was not sent.",
    };
  }

  const settings = await getEmailCredentials();
  if (!settings) {
    return {
      outcome: "unconfigured",
      answer: "This ClawBox has no email account connected.",
      note: "Not sent: this ClawBox has no email account connected.",
    };
  }

  // The authoritative claim. A mismatch leaves the draft IN the queue — it has
  // not been consented to, and deleting text the owner never agreed to lose is
  // not ours to do.
  const claim = claimPendingIfUnchanged(prompt.draftId, prompt.fingerprint);
  if (!claim.ok) {
    const text =
      claim.reason === "gone"
        ? staleTapAnswer(prompt.draftId)
        : "That draft changed after this message was posted, so it was NOT sent. Approve it in Settings → Email.";
    return { outcome: claim.reason === "gone" ? "gone" : "changed", answer: text, note: text };
  }

  const draft = claim.draft;
  try {
    await sendMail(toSmtpConfig(settings), {
      from: settings.address,
      fromName: settings.fromName || "ClawBox",
      to: draft.to,
      subject: draft.subject,
      text: draft.body,
    });
    // Past the wire. Any exact copy still queued has now been delivered, so it
    // is resolved rather than left with a live button in Settings or in chat —
    // which is what the owner met: one request, two identical drafts, one of
    // them still asking to be sent after the other had gone.
    const twins = resolveSent(draft);
    for (const twin of twins) await retireChatPrompt(twin.id);
    return {
      outcome: "sent",
      answer: "Sent.",
      note: `Sent to ${draft.to.length} recipient(s).`,
    };
  } catch (err) {
    const kind = err instanceof SmtpError ? err.kind : "network";
    // Never the recipient, never the subject, never a line of the body — the
    // same rule the pending route's log follows.
    console.error(`[email/approval] approved send failed: kind=${kind} host=${settings.smtpHost}`);
    const reason = err instanceof SmtpError ? err.message : "Could not send the message.";
    // Nothing is covered by a send that did not happen, so no twin is touched.
    // What the receipt may CLAIM depends on which failure it was: a refusal the
    // mail server spoke is "not sent", a dropped connection is something this
    // process cannot know either way — and "not sent" there is how an owner is
    // talked into sending the same message twice.
    const ending = outcomeKindFor(err);
    recordOutcome(draft, ending, { error: reason });
    // AND THE SAME JUDGEMENT IN THE WORDS HE READS. The receipt has said
    // `unconfirmed` since this feature shipped; the sentence in the owner's own
    // chat still said "Not sent", two lines under the comment above explaining
    // why it must not.
    const verdict =
      ending === "unconfirmed"
        ? "Handed to the mail server, and the answer never came back — check your Sent folder before sending it again."
        : `Not sent: ${reason}`;
    // The draft was claimed before the send and is out of the queue — the same
    // trade the desktop path makes, for the same reason (never send twice). It
    // is not lost: the message above this reply still holds the whole draft,
    // which is exactly why the question is never overwritten with its verdict.
    return { outcome: "send_failed", answer: verdict, note: `${verdict} The draft above is no longer queued.` };
  }
}

/** Retire the buttons and post the verdict under the question. Best effort. */
async function settle(token: string | null, prompt: ApprovalPrompt, verdict: string): Promise<void> {
  if (!token) return;
  for (const message of prompt.messages) {
    await clearApprovalKeyboard(token, message.chatId, message.messageId).catch(() => undefined);
    await replyInChat(token, message.chatId, verdict, message.messageId).catch(() => undefined);
  }
}

// ── The poller ───────────────────────────────────────────────────────────────
//
// It runs ONLY while a question is outstanding. A box with the feature switched
// on and nothing queued makes no requests to Telegram at all — there is nothing
// for anyone to answer, so there is nothing to listen for.

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * The shortest a poll cycle may take.
 *
 * getUpdates is a LONG poll: it is supposed to hold the connection open for
 * POLL_TIMEOUT_S and hand back nothing. When it does not — a proxy that closes
 * idle connections early, a Telegram edge that answers at once, a stub in a
 * test — a loop with no floor becomes a tight one, and a tight loop against
 * Telegram is how a bot gets rate-limited off the network. One second costs a
 * tap nothing: the long poll is what makes it fast, and this only applies when
 * the long poll did not happen.
 */
const MIN_CYCLE_MS = 1_000;

let running = false;
let stopRequested = false;
/** Aborts the long poll that is in flight right now, if there is one. */
let pollAbort: AbortController | null = null;

export function approvalPollerRunning(): boolean {
  return running;
}

/**
 * Start listening, if a question is outstanding and nothing is listening yet.
 *
 * Idempotent: called after every prompt is posted and once at boot, and a
 * second caller must not open a second long poll against the same bot — two
 * pollers on one token is the exact conflict that made a shared bot impossible
 * in the first place.
 */
export function startApprovalPoller(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  // pollLoop clears the flag on every exit path of its own; this is the
  // backstop for a throw that escapes it entirely.
  void pollLoop().finally(() => {
    running = false;
  });
}

/**
 * For shutdown and for the tests.
 *
 * Aborting matters as much as the flag. Without it the loop stays parked in a
 * long poll for up to POLL_TIMEOUT_S after being told to stop — which at
 * shutdown is an open TLS request on an embedded board, and in a test is a
 * cycle that can still write to a CLAWBOX_ROOT the teardown has deleted.
 */
export function stopApprovalPoller(): void {
  stopRequested = true;
  pollAbort?.abort();
  pollAbort = null;
}

/** A sleep that never keeps the process alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open for a poll that nobody is waiting on.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

/** The long-poll cycle. Runs while a question is outstanding, and not otherwise. */
async function pollLoop(): Promise<void> {
  let backoff = RETRY_MIN_MS;
  while (!stopRequested) {
    let token: string | null = null;
    try {
      token = await approvalBotToken();
      // Release the slot in the SAME turn as the decision to stop. Leaving it
      // to the .finally() below puts a microtask between "this loop is going to
      // exit" and "running is false", and a startApprovalPoller() landing in
      // that window declines to start — leaving a question outstanding with
      // nothing listening for its answer.
      if (!token || !(await chatApprovalEnabled()) || countPrompts() === 0) {
        running = false;
        return;
      }
    } catch {
      running = false;
      return;
    }

    const startedAt = Date.now();
    pollAbort = new AbortController();
    try {
      const updates = await fetchApprovalUpdates(token, readOffset(), pollAbort.signal);
      backoff = RETRY_MIN_MS;
      for (const update of updates) {
        // Advance FIRST. A tap that throws while being handled must not be
        // replayed on the next poll: the draft may already be on the wire, and
        // "send it again to be sure" is the one outcome this feature may never
        // produce.
        advanceOffset(update.update_id + 1);
        await handleUpdate(update);
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_CYCLE_MS) await delay(MIN_CYCLE_MS - elapsed);
    } catch (err) {
      // A stop request aborts the request in flight, and the failure it causes
      // is not news. Leave without waiting out a backoff nobody is waiting for.
      if (stopRequested) break;
      console.error("[email/approval] poll failed:", err instanceof Error ? err.message : err);
      await delay(backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    } finally {
      pollAbort = null;
    }
  }
  running = false;
}

/** One update off the wire. A throw here must not take the loop down with it. */
async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (!update.callback_query) return;
  try {
    await applyApprovalCallback(update.callback_query);
  } catch (err) {
    console.error("[email/approval] could not handle a tap:", err instanceof Error ? err.message : err);
  }
}
