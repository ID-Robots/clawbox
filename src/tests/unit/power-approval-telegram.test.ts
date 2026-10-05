import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const exec = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const clear = vi.hoisted(() => vi.fn(async () => {}));
const poll = vi.hoisted(() => vi.fn());
// The owner-notice ring the desktops read: kept off disk here, and watched.
const push = vi.hoisted(() => vi.fn<(action: Record<string, unknown>, id?: string) => Promise<unknown>>(async () => ({})));
vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: push }));
vi.mock("node:child_process", () => ({ execFile: exec }));
vi.mock("@/lib/email-approval", () => ({
  approvalBotToken: async () => "123:FAKE", chatApprovalEnabled: async () => true,
  ownerChatIds: async () => ["100", "200"], startApprovalPoller: poll,
}));
vi.mock("@/lib/email-approval-telegram", () => ({
  sendApprovalMessage: send, answerCallback: async () => {}, clearApprovalKeyboard: clear, replyInChat: async () => {},
}));
import { requestPowerApproval, pendingPowerApproval, resolvePowerApproval, applyPowerApprovalCallback } from "@/lib/power-approval";

describe("power requests through the dedicated approvals bot", () => {
  beforeEach(async () => {
    const old = pendingPowerApproval();
    if (old) await resolvePowerApproval(old.id, old.action, false);
    const state = (globalThis as typeof globalThis & { [key: symbol]: { deniedAt?: number } })[Symbol.for("clawbox.power-approval")];
    delete state.deniedAt;
    exec.mockImplementation((...args: unknown[]) => (args.at(-1) as (...a: unknown[]) => void)(null, "", ""));
    push.mockImplementation(async () => ({}));
    send.mockImplementation(async (_token, chat) => {
      if (chat === "200") throw new Error("second owner has not started bot");
      return 7;
    });
  });
  afterEach(() => vi.useRealTimers());
  it("keeps listening if a second recipient fails, and refuses a forged or non-owner tap", async () => {
    const p = await requestPowerApproval("restart", "test");
    expect(poll).toHaveBeenCalledOnce();
    const query = { id: "q", from: { id: 999 }, data: `pa:${p.id}`, message: { message_id: 7, chat: { id: 100 } } };
    await applyPowerApprovalCallback(query);
    expect(exec).not.toHaveBeenCalled();
    await applyPowerApprovalCallback({ ...query, from: { id: 100 }, message: { message_id: 8, chat: { id: 100 } } });
    expect(exec).not.toHaveBeenCalled();
    await applyPowerApprovalCallback({ ...query, from: { id: 100 } });
    await applyPowerApprovalCallback({ ...query, from: { id: 100 } });
    expect(exec).toHaveBeenCalledOnce();
  });
  it("an answer in Telegram takes the question off every open desktop", async () => {
    const p = await requestPowerApproval("restart", "test");
    // The desktops hear of it before the chat delivery is even begun.
    expect(push).toHaveBeenCalledWith({ type: "power_approval" }, `power-approval:${p.id}:asked`);
    expect(push.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    await applyPowerApprovalCallback({ id: "q", from: { id: 100 }, data: `pd:${p.id}`, message: { message_id: 7, chat: { id: 100 } } });
    expect(push).toHaveBeenLastCalledWith({ type: "power_approval" }, `power-approval:${p.id}:settled`);
    expect(push.mock.calls.filter(([, id]) => id === `power-approval:${p.id}:settled`)).toHaveLength(1);
  });
  it("an owner denial never dispatches power", async () => {
    const p = await requestPowerApproval("shutdown", "test");
    await applyPowerApprovalCallback({ id: "q", from: { id: 100 }, data: `pd:${p.id}`, message: { message_id: 7, chat: { id: 100 } } });
    expect(exec).not.toHaveBeenCalled();
    expect(pendingPowerApproval()).toBeNull();
  });
  it("desktop resolution retires keyboards even when cleanup never finishes", async () => {
    const p = await requestPowerApproval("restart", "test");
    clear.mockImplementationOnce(() => new Promise<void>(() => {}));
    await resolvePowerApproval(p.id, p.action, true);
    expect(exec).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledWith("123:FAKE", "100", 7));
  });
  it("expired requests retire keyboards without dispatch", async () => {
    const p = await requestPowerApproval("restart", "test");
    vi.useFakeTimers(); vi.setSystemTime(p.expiresAt + 1);
    expect(pendingPowerApproval()).toBeNull();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledWith("123:FAKE", "100", 7));
    expect(exec).not.toHaveBeenCalled();
    // …and the desktops take it down too.
    expect(push).toHaveBeenLastCalledWith({ type: "power_approval" }, `power-approval:${p.id}:settled`);
  });

});
