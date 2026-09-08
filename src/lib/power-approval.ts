import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TelegramCallbackQuery } from "@/lib/email-approval-telegram";

export type PowerAction = "restart" | "shutdown";
export interface PowerApproval {
  id: string;
  action: PowerAction;
  reason: string;
  expiresAt: number;
  messages: { chatId: string; messageId: number }[];
}
const key: unique symbol = Symbol.for("clawbox.power-approval");
const runtime = globalThis as typeof globalThis & { [key]?: { pending: PowerApproval | null } };
const state = runtime[key] ??= { pending: null };
const execFileAsync = promisify(execFile);
const POWER_ACTIONS = { restart: "reboot", shutdown: "poweroff" } as const;

export function isPowerAction(action: unknown): action is PowerAction {
  return action === "restart" || action === "shutdown";
}

/** Pending requests deliberately expire across a server restart; they never execute unattended. */
export function pendingPowerApproval(): PowerApproval | null {
  if (state.pending && state.pending.expiresAt <= Date.now()) state.pending = null;
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
    if (existing.action !== action) throw new Error("Another power request is already awaiting confirmation");
    return existing;
  }
  const prompt: PowerApproval = {
    id: crypto.randomBytes(16).toString("hex"), action, reason: reason.slice(0, 200),
    expiresAt: Date.now() + 120_000, messages: [],
  };
  state.pending = prompt;
  // Use the existing dedicated approvals bot, never a second consumer of the
  // harness's main Telegram bot. No configured bot simply means desktop-only.
  try {
    const { approvalBotToken, chatApprovalEnabled, ownerChatIds, startApprovalPoller } = await import("@/lib/email-approval");
    const { sendApprovalMessage } = await import("@/lib/email-approval-telegram");
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
        } catch { /* One unavailable chat must not disable already-delivered buttons. */ }
      }
      if (prompt.messages.length) startApprovalPoller();
    }
  } catch { /* The owner can still confirm on the desktop. */ }
  return prompt;
}

/** Claim before dispatch: duplicate taps and competing desktop/chat decisions cannot run twice. */
export async function resolvePowerApproval(id: string, action: PowerAction, approve: boolean): Promise<boolean> {
  const prompt = pendingPowerApproval();
  if (!prompt || prompt.id !== id || prompt.action !== action) return false;
  state.pending = null;
  if (approve) await dispatchPowerAction(prompt.action);
  return true;
}

/** Only Telegram's direct, owner-allowlisted callback can resolve the chat question. */
export async function applyPowerApprovalCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!/^(pa|pd):[a-f0-9]{32}$/.test(data)) return false;
  const { ownerChatIds, approvalBotToken } = await import("@/lib/email-approval");
  const { answerCallback, clearApprovalKeyboard, replyInChat } = await import("@/lib/email-approval-telegram");
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
  for (const m of prompt.messages) await clearApprovalKeyboard(token, m.chatId, m.messageId).catch(() => undefined);
  try { await resolvePowerApproval(prompt.id, prompt.action, data.startsWith("pa:")); }
  catch {
    for (const m of prompt.messages) await replyInChat(token, m.chatId,
      "The power command failed. Please try again from the desktop.", m.messageId).catch(() => undefined);
  }
  return true;
}
