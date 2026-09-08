import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TelegramCallbackQuery } from "@/lib/email-approval-telegram";

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
const runtime = globalThis as typeof globalThis & { [key]?: { pending: PowerApproval | null; deniedAt?: number } };
const state = runtime[key] ??= { pending: null };
const DENIAL_COOLDOWN_MS = 60_000;
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
    retirePowerKeyboards(expired);
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
  if (!approve) state.deniedAt = Date.now();
  retirePowerKeyboards(prompt);
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
