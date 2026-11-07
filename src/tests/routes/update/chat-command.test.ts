/**
 * /setup-api/update/chat-command (TASK-2260): what the harness hooks post for
 * /update and the Update button's tap.
 *
 * Pinned: the bearer is REQUIRED (a browser cookie is not enough), only
 * Telegram and the two known harnesses are weighed, ordinary conversation is
 * never claimed, a non-owner is claimed and refused, and the owner's tap
 * reaches `requestPowerApproval` — the question — and never `startUpdate`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendOwnerTelegramText = vi.fn(async (..._a: unknown[]) => true);
const sendOwnerTelegramButtons = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/telegram-owner-send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram-owner-send")>()),
  sendOwnerTelegramText: (...a: unknown[]) => sendOwnerTelegramText(...a),
  sendOwnerTelegramButtons: (...a: unknown[]) => sendOwnerTelegramButtons(...a),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/openclaw-config", () => ({ readTelegramAllowFrom: vi.fn(async () => ["6001"]) }));
vi.mock("@/lib/hermes-telegram", () => ({ readHermesApprovedUsers: vi.fn(async () => [{ id: "7001" }]) }));
const startUpdate = vi.fn(() => ({ started: true }));
vi.mock("@/lib/updater", () => ({
  getVersionInfo: vi.fn(async () => ({
    clawbox: { current: "v4.3.0", target: "v4.3.1", updateAvailable: true },
    remote: { reachable: true },
  })),
  invalidateVersionCache: vi.fn(),
  getUpdateState: vi.fn(() => ({ phase: "idle", steps: [] })),
  startUpdate: () => startUpdate(),
}));
vi.mock("@/lib/update-whats-new-server", () => ({
  readUpdateWhatsNew: vi.fn(async () => ({ version: "4.3.1", highlights: [] })),
  prefetchUpdateWhatsNew: vi.fn(async () => undefined),
}));

const MCP_TOKEN = "t".repeat(32);
const SESSION_SECRET = "a".repeat(64);

let root: string;
let POST: typeof import("@/app/setup-api/update/chat-command/route").POST;
let power: typeof import("@/lib/power-approval");
let cookie: string;

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${MCP_TOKEN}` }): Promise<Response> {
  return POST(new Request("http://127.0.0.1/setup-api/update/chat-command", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const fromOpenclaw = (extra: Record<string, unknown>) => ({ channel: "telegram", harness: "openclaw", ...extra });

/** The route answers first and works after; give the background work its turn. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-update-chat-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.resetModules();
  sendOwnerTelegramText.mockClear();
  sendOwnerTelegramButtons.mockClear();
  startUpdate.mockClear();
  const auth = await import("@/lib/auth");
  cookie = `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`;
  (await import("@/lib/update-notice")).resetForcedCheckForTests();
  power = await import("@/lib/power-approval");
  ({ POST } = await import("@/app/setup-api/update/chat-command/route"));
});

afterEach(async () => {
  // A question left pending would leak into the next case through globalThis.
  const pending = power.pendingPowerApproval();
  if (pending) await power.resolvePowerApproval(pending.id, pending.action, false);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CLAWBOX_MCP_TOKEN;
});

describe("who may call it", () => {
  it("refuses a caller without the bearer — a browser cookie is not enough", async () => {
    const res = await post(fromOpenclaw({ senderId: "6001", text: "/update" }), { cookie });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ handled: false });
  });

  it("refuses a wrong bearer", async () => {
    const res = await post(fromOpenclaw({ senderId: "6001", text: "/update" }), { authorization: "Bearer nope-nope-nope-nope" });
    expect(res.status).toBe(403);
  });

  it("refuses a body that is not JSON, too large, or missing the sender", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post(fromOpenclaw({ senderId: "6001", text: "x".repeat(5_000) }))).status).toBe(413);
    expect((await post(fromOpenclaw({ text: "/update" }))).status).toBe(400);
  });
});

describe("what it claims", () => {
  it("never claims ordinary conversation", async () => {
    const res = await post(fromOpenclaw({ senderId: "6001", text: "is there an update?" }));
    expect(await res.json()).toEqual({ handled: false });
  });

  it("weighs Telegram senders only, from the two harnesses it knows", async () => {
    expect(await (await post({ senderId: "6001", text: "/update", channel: "whatsapp", harness: "openclaw" })).json())
      .toEqual({ handled: false });
    expect(await (await post({ senderId: "6001", text: "/update", channel: "telegram", harness: "other" })).json())
      .toEqual({ handled: false });
  });

  it("claims a stranger's /update and refuses it: no check, no question", async () => {
    const res = await post(fromOpenclaw({ senderId: "999", chatId: "999", text: "/update" }));
    expect(await res.json()).toEqual({ handled: true });
    await settle();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith("999", "Only this ClawBox's owner can do that.", { harness: "openclaw" });
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(power.pendingPowerApproval()).toBeNull();
  });

  it("claims a stranger's tap and asks the owner nothing", async () => {
    const res = await post(fromOpenclaw({ senderId: "999", text: "callback_data: clawbox-update" }));
    expect(await res.json()).toEqual({ handled: true });
    await settle();
    expect(power.pendingPowerApproval()).toBeNull();
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("weighs a Hermes sender against the HERMES allowlist", async () => {
    // 6001 is OpenClaw's owner, not Hermes'.
    await post({ senderId: "6001", text: "/update", channel: "telegram", harness: "hermes" });
    await settle();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith("6001", "Only this ClawBox's owner can do that.", { harness: "hermes" });
    sendOwnerTelegramText.mockClear();
    await post({ senderId: "7001", chatId: "7001", text: "/update", channel: "telegram", harness: "hermes" });
    await settle();
    expect(sendOwnerTelegramButtons).toHaveBeenCalledWith("7001", expect.stringContaining("4.3.1"), expect.any(Array), { harness: "hermes" });
  });
});

describe("the owner", () => {
  it("/update gets the notice with its button", async () => {
    const res = await post(fromOpenclaw({ senderId: "6001", chatId: "6001", text: "/update" }));
    expect(await res.json()).toEqual({ handled: true });
    await settle();
    expect(sendOwnerTelegramButtons).toHaveBeenCalledWith(
      "6001",
      expect.stringContaining("ClawBox 4.3.1 is available"),
      [{ text: "Update", callback_data: "clawbox-update" }],
      { harness: "openclaw" },
    );
  });

  it("the tap raises the existing owner question — desktop prompt — and nothing runs until Confirm", async () => {
    const res = await post(fromOpenclaw({ senderId: "6001", chatId: "6001", text: "callback_data: clawbox-update" }));
    expect(await res.json()).toEqual({ handled: true });
    await settle();
    const pending = power.pendingPowerApproval();
    expect(pending).toMatchObject({ action: "update", reason: "Update button in Telegram" });
    expect(startUpdate).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith(
      "6001",
      "Update requested. Confirm it on the ClawBox desktop within 2 minutes.",
      { harness: "openclaw" },
    );
    // The owner's Confirm — the desktop's own path — is what starts it.
    expect(await power.resolvePowerApproval(pending!.id, "update", true)).toBe(true);
    expect(startUpdate).toHaveBeenCalledTimes(1);
  });

  it("an owner's /update in a group is claimed and redirected to the private chat", async () => {
    const res = await post(fromOpenclaw({ senderId: "6001", chatId: "-1001", isGroup: true, text: "/update@ClawBoxBot" }));
    expect(await res.json()).toEqual({ handled: true });
    await settle();
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("private chat");
  });
});
