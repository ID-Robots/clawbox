import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TelegramCallbackQuery } from "@/lib/email-approval-telegram";
import { pushPendingAction } from "@/lib/pending-actions";

export class PowerApprovalConflict extends Error {}

export type PowerAction = "restart" | "shutdown";
export interface PowerApproval {
  id: string;
  action: PowerAction;
  reason: string;
  expiresAt: number;
  messages: { chatId: string; messageId: number }[];
}
const key: unique symbol = Symbol.for("clawbox.power-approval");
const runtime = globalThis as typeof globalThis & {
  [key]?: { pending: PowerApproval | null; deniedAt?: number; expiry?: ReturnType<typeof setTimeout> };
};
const state = runtime[key] ??= { pending: null };
const DENIAL_COOLDOWN_MS = 60_000;
/**
 * How long after its `expiresAt` the expiry timer looks. A timer is not a
 * promise about the WALL clock the expiry is judged by (`Date.now()`), and one
 * that fired a millisecond early would find the request still live and have to
 * come back; a quarter of a second late it never has to, unless the clock has
 * actually been stepped back.
 */
const EXPIRY_SLACK_MS = 250;
/**
 * The longest the expiry timer waits before it looks again. `expiresAt` is a
 * WALL-clock time and the timer runs on the monotonic one, so the gap between
 * them is whatever the box's clock has done since the request was made — and a
 * clock stepped back by more than ~24.8 days (a date set by hand far ahead and
 * then corrected by NTP — the box has no RTC to hold a sane one) makes that gap
 * larger than a timer can hold: Node then logs a `TimeoutOverflowWarning` and
 * fires after 1 ms, the request is still live by the wall-clock test, the timer
 * is armed again at once, and the web server spins on 1 ms timers and floods
 * the journal until the clock catches up. Capped, a request that is still live
 * is simply looked at once a minute. A normal request is looked at twice (one
 * minute in, then at its two-minute expiry), which costs nothing; a clock
 * stepped FORWARD is noticed within a minute rather than at the old deadline.
 */
const EXPIRY_LOOK_MAX_MS = 60_000;

/**
 * Tell every open desktop that the question changed — asked, answered (here,
 * on another desktop or from Telegram) or run out — through the owner-notice
 * ring the desktops already read every 2 s (src/lib/pending-actions.ts). The
 * prompt used to ask the approval route every 5 s, around the clock, on every
 * owner desktop, for a request that almost never exists; it now asks when the
 * ring says there is something to ask about (src/components/PowerApprovalPrompt.tsx).
 *
 * The notice carries no part of the request: the ring is a file the MCP bearer
 * can read and the agent can write, so the prompt's content still comes only
 * from the owner-gated route, and a forged notice can do no more than make a
 * desktop ask it. One id per request and phase, so a desktop that sees the same
 * notice on two polls acts on it once.
 *
 * Never awaited and never thrown: a decision must not wait on — or fail over —
 * a write that only saves the desktops a few seconds (their slow safety poll
 * catches up without it).
 */
function announce(prompt: PowerApproval, phase: "asked" | "settled"): void {
  try {
    void pushPendingAction({ type: "power_approval" }, `power-approval:${prompt.id}:${phase}`).catch(() => undefined);
  } catch { /* The safety poll still brings the desktops up to date. */ }
}

/**
 * Expire `prompt` when its time is up even if nobody asks. Expiry used to be
 * noticed only by the next reader, and the 5 s desktop poll was always the next
 * reader; with that poll gone, a request nobody answered would otherwise stay
 * on every desktop until the slow safety poll. Judged by the same wall-clock
 * test as always (`pendingPowerApproval`): if the box's clock has been stepped
 * back since the request was made, the request is still live by that test and
 * the timer simply looks again — never more than `EXPIRY_LOOK_MAX_MS` later,
 * which is what keeps a large step from overflowing the timer (see there).
 */
function armExpiry(prompt: PowerApproval): void {
  if (state.expiry) clearTimeout(state.expiry);
  const untilExpiry = Math.max(0, prompt.expiresAt - Date.now());
  const timer = setTimeout(() => {
    if (state.expiry === timer) state.expiry = undefined;
    if (state.pending !== prompt) return;
    // Expires it (and tells the desktops) when its time is up, by the same
    // wall-clock rule as every reader; still live means look again.
    if (pendingPowerApproval() === prompt) armExpiry(prompt);
  }, Math.min(untilExpiry, EXPIRY_LOOK_MAX_MS) + EXPIRY_SLACK_MS);
  // Never what keeps a process alive.
  timer.unref?.();
  state.expiry = timer;
}

function clearExpiry(): void {
  if (state.expiry) clearTimeout(state.expiry);
  state.expiry = undefined;
}

// Share lazy imports across cleanup and simultaneous chat decisions. These
// modules participate in the approval poller's cycle, so keep them lazy.
let approvalModule: Promise<typeof import("@/lib/email-approval")> | undefined;
let telegramModule: Promise<typeof import("@/lib/email-approval-telegram")> | undefined;
const approvals = () => approvalModule ??= import("@/lib/email-approval");
const telegram = () => telegramModule ??= import("@/lib/email-approval-telegram");
const execFileAsync = promisify(execFile);
const POWER_ACTIONS = { restart: "reboot", shutdown: "poweroff" } as const;

export function isPowerAction(action: unknown): action is PowerAction {
  return action === "restart" || action === "shutdown";
}

/** Pending requests deliberately expire across a server restart; they never execute unattended. */
export function pendingPowerApproval(): PowerApproval | null {
  if (state.pending && state.pending.expiresAt <= Date.now()) {
    const expired = state.pending;
    state.pending = null;
    clearExpiry();
    retirePowerKeyboards(expired);
    announce(expired, "settled");
  }
  return state.pending;
}

export function powerKeyboardPending(): boolean {
  return (pendingPowerApproval()?.messages.length ?? 0) > 0;
}

export async function dispatchPowerAction(action: PowerAction): Promise<void> {
  const systemctlAction = POWER_ACTIONS[action];
  await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", systemctlAction], { timeout: 10_000 });
}

/** One bounded question, not an agent-controlled stream of confirmation popups. */
export async function requestPowerApproval(action: PowerAction, reason: string): Promise<PowerApproval> {
  const existing = pendingPowerApproval();
  if (existing) {
    if (existing.action !== action) throw new PowerApprovalConflict("Another power request is already awaiting confirmation");
    return existing;
  }
  if (state.deniedAt !== undefined && Date.now() - state.deniedAt < DENIAL_COOLDOWN_MS) {
    throw new PowerApprovalConflict("The owner declined a power request. Wait before asking again.");
  }
  const prompt: PowerApproval = {
    id: crypto.randomBytes(16).toString("hex"), action, reason: reason.slice(0, 200),
    expiresAt: Date.now() + 120_000, messages: [],
  };
  state.pending = prompt;
  armExpiry(prompt);
  // Before the Telegram round trips below: the desktop is where the owner
  // most likely is, and it should not wait on a chat delivery to see this.
  announce(prompt, "asked");
  // Use the existing dedicated approvals bot, never a second consumer of the
  // harness's main Telegram bot. No configured bot simply means desktop-only.
  try {
    const { approvalBotToken, chatApprovalEnabled, ownerChatIds, startApprovalPoller } = await approvals();
    const { sendApprovalMessage } = await telegram();
    const token = await approvalBotToken();
    if (token && await chatApprovalEnabled()) {
      for (const chatId of (await ownerChatIds()).slice(0, 5)) {
        try {
        const messageId = await sendApprovalMessage(token, chatId,
          `${action === "restart" ? "Restart" : "Shut down"} this ClawBox?\n\nRequested reason: ${prompt.reason}\n\nExpires in 2 minutes.`, [
            { text: action === "restart" ? "Restart" : "Shut down", callback_data: `pa:${prompt.id}` },
            { text: "Cancel", callback_data: `pd:${prompt.id}` },
          ]);
        prompt.messages.push({ chatId, messageId });
        // Delivery may finish after a desktop decision or expiry.
        if (state.pending !== prompt || prompt.expiresAt <= Date.now()) retirePowerKeyboards(prompt);
        } catch { /* One unavailable chat must not disable already-delivered buttons. */ }
      }
      if (prompt.messages.length) startApprovalPoller();
    }
  } catch { /* The owner can still confirm on the desktop. */ }
  return prompt;
}

/** Cleanup must never delay power dispatch or turn a decision into an error. */
function retirePowerKeyboards(prompt: PowerApproval): void {
  void (async () => {
    const { approvalBotToken } = await approvals();
    const { clearApprovalKeyboard } = await telegram();
    const token = await approvalBotToken();
    if (token) await Promise.all(prompt.messages.map(m =>
      clearApprovalKeyboard(token, m.chatId, m.messageId).catch(() => undefined)));
  })().catch(() => undefined);
}

/** Claim before dispatch: duplicate taps and competing desktop/chat decisions cannot run twice. */
export async function resolvePowerApproval(id: string, action: PowerAction, approve: boolean): Promise<boolean> {
  const prompt = pendingPowerApproval();
  if (!prompt || prompt.id !== id || prompt.action !== action) return false;
  state.pending = null;
  clearExpiry();
  if (!approve) state.deniedAt = Date.now();
  retirePowerKeyboards(prompt);
  // Every other desktop takes the question down — this one did, or the owner
  // answered in Telegram — whichever way it went.
  announce(prompt, "settled");
  if (approve) await dispatchPowerAction(prompt.action);
  return true;
}

/** Only Telegram's direct, owner-allowlisted callback can resolve the chat question. */
export async function applyPowerApprovalCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!/^(pa|pd):[a-f0-9]{32}$/.test(data)) return false;
  const { ownerChatIds, approvalBotToken } = await approvals();
  const { answerCallback, replyInChat } = await telegram();
  const token = await approvalBotToken();
  if (!token) return true;
  const say = (text: string) => answerCallback(token, query.id, text).catch(() => undefined);
  if (!(await ownerChatIds()).includes(String(query.from.id))) {
    await say("Only this ClawBox's owner can confirm.");
    return true;
  }
  const prompt = pendingPowerApproval();
  if (!prompt || prompt.id !== data.slice(3) || !prompt.messages.some(m =>
    m.chatId === String(query.message?.chat.id) && m.messageId === query.message?.message_id)) {
    await say("That request has expired or was already answered.");
    return true;
  }
  // Acknowledge before teardown so Telegram does not leave a spinning button.
  await say(data.startsWith("pa:") ? "Confirmed." : "Cancelled.");
  try { await resolvePowerApproval(prompt.id, prompt.action, data.startsWith("pa:")); }
  catch {
    for (const m of prompt.messages) await replyInChat(token, m.chatId,
      "The power command failed. Please try again from the desktop.", m.messageId).catch(() => undefined);
  }
  return true;
}
