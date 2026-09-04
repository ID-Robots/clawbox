import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  // A REAL class, not a stub: the route narrows on
  // `err instanceof GatewayNotReadyError` to tell a gateway that is still
  // binding apart from one that refused the restart, and `instanceof undefined`
  // throws a TypeError the first time a test makes the restart reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  setTelegramToken: vi.fn(),
  restartGateway: vi.fn(),
  clearTelegramPairingState: vi.fn(),
  // The Telegram bot the OpenClaw gateway actually polls lives in the harness's
  // own config, and the route now reads it through the STRICT reader so an
  // unreadable openclaw.json cannot pass for "no bot configured".
  readConfigStrict: vi.fn(async () => ({})),
}));

import { get, set } from "@/lib/config-store";
import { GatewayNotReadyError, setTelegramToken, restartGateway, clearTelegramPairingState, readConfigStrict } from "@/lib/openclaw-config";

const mockReadConfigStrict = vi.mocked(readConfigStrict);
const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockSetTelegramToken = vi.mocked(setTelegramToken);
const mockRestartGateway = vi.mocked(restartGateway);
const mockClearPairing = vi.mocked(clearTelegramPairingState);

describe("POST /setup-api/telegram/configure", () => {
  let telegramConfigurePost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGet.mockResolvedValue(undefined);
    mockSet.mockResolvedValue();
    mockSetTelegramToken.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();
    mockClearPairing.mockResolvedValue();
    mockReadConfigStrict.mockResolvedValue({});

    const mod = await import("@/app/setup-api/telegram/configure/route");
    telegramConfigurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("configures Telegram bot successfully", async () => {
    const token = "123456789:ABCDefGHIjklMNOpqrsTUVwxyz";
    const res = await telegramConfigurePost(jsonRequest({ botToken: token }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSet).toHaveBeenCalledWith("telegram_bot_token", token);
    expect(mockSetTelegramToken).toHaveBeenCalledWith(token);
    expect(mockRestartGateway).toHaveBeenCalled();
  });

  it("resets the allowlist + name map when the bot token changes", async () => {
    mockGet.mockResolvedValue("111:OLD_token_value");
    const res = await telegramConfigurePost(jsonRequest({ botToken: "222:new_token_value" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reset).toBe(true);
    expect(mockClearPairing).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith("telegram_approved_names", undefined);
  });

  it("keeps the allowlist when re-saving the same token", async () => {
    const token = "111:same_token_value";
    mockGet.mockResolvedValue(token);
    const res = await telegramConfigurePost(jsonRequest({ botToken: token }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reset).toBe(false);
    expect(mockClearPairing).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalledWith("telegram_approved_names", undefined);
  });

  it("clears the old approvals before the new token is persisted", async () => {
    mockGet.mockResolvedValue("111:OLD_token_value");
    await telegramConfigurePost(jsonRequest({ botToken: "222:new_token_value" }));

    const tokenSave = mockSet.mock.calls.findIndex(([key]) => key === "telegram_bot_token");
    expect(tokenSave).toBeGreaterThanOrEqual(0);
    const reset = mockClearPairing.mock.invocationCallOrder[0];
    expect(reset).toBeLessThan(mockSet.mock.invocationCallOrder[tokenSave]);
    expect(reset).toBeLessThan(mockSetTelegramToken.mock.invocationCallOrder[0]);
  });

  it("fails the save, old token still in place, when the old approvals cannot be cleared", async () => {
    // A new bot must not go live answering senders approved for the old one,
    // and the next attempt has to see the token change again so the reset is
    // retried — both need the reset to run before anything is persisted.
    mockGet.mockResolvedValue("111:OLD_token_value");
    mockClearPairing.mockRejectedValue(new Error("Could not clear the previous Telegram approvals"));
    const res = await telegramConfigurePost(jsonRequest({ botToken: "222:new_token_value" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBeUndefined();
    expect(body.error).toMatch(/approvals/);
    expect(body.error).toMatch(/not saved/);
    expect(mockSet).not.toHaveBeenCalledWith("telegram_bot_token", expect.anything());
    expect(mockSet).not.toHaveBeenCalledWith("telegram_approved_names", undefined);
    expect(mockSetTelegramToken).not.toHaveBeenCalled();
    expect(mockRestartGateway).not.toHaveBeenCalled();
  });

  // The mirror is not the store the gateway polls. `channels.telegram.botToken`
  // is, so on a box whose bot was rotated with `openclaw config set` re-saving
  // ClawBox's older copy IS a bot change — and the reset has to run, in front of
  // both writes, or senders approved for the previous bot carry over.
  it("compares against OpenClaw's own store, not the mirror, and resets first", async () => {
    mockGet.mockResolvedValue("111:MIRROR_token_val");
    mockReadConfigStrict.mockResolvedValue({
      channels: { telegram: { enabled: true, botToken: "333:NATIVE_token_val" } },
    });

    const res = await telegramConfigurePost(jsonRequest({ botToken: "111:MIRROR_token_val" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reset).toBe(true);
    expect(mockClearPairing).toHaveBeenCalledTimes(1);
    const tokenSave = mockSet.mock.calls.findIndex(([key]) => key === "telegram_bot_token");
    expect(mockClearPairing.mock.invocationCallOrder[0])
      .toBeLessThan(mockSet.mock.invocationCallOrder[tokenSave]);
    expect(mockClearPairing.mock.invocationCallOrder[0])
      .toBeLessThan(mockSetTelegramToken.mock.invocationCallOrder[0]);
  });

  it("keeps the approvals when the native store already holds this exact token", async () => {
    const token = "333:NATIVE_token_val";
    mockReadConfigStrict.mockResolvedValue({
      channels: { telegram: { enabled: true, botToken: token } },
    });

    const res = await telegramConfigurePost(jsonRequest({ botToken: token }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reset).toBe(false);
    expect(mockClearPairing).not.toHaveBeenCalled();
  });

  // FAIL CLOSED, and identically to the approvals guard next door. Treating an
  // unreadable openclaw.json as "the bot changed" performs an IRREVERSIBLE reset
  // — every household member unpaired — on a guess, which a config caught
  // half-written by a concurrent `openclaw config set` would have been enough to
  // trigger while the owner merely re-entered the same token.
  it("refuses the save, changing nothing, when the harness store cannot be read", async () => {
    mockGet.mockResolvedValue("111:OLD_token_value");
    mockReadConfigStrict.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

    const res = await telegramConfigurePost(jsonRequest({ botToken: "222:new_token_value" }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.kind).toBe("bot_unknown");
    expect(mockClearPairing).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalledWith("telegram_approved_names", undefined);
    expect(mockSet).not.toHaveBeenCalledWith("telegram_bot_token", expect.anything());
    expect(mockSetTelegramToken).not.toHaveBeenCalled();
    expect(mockRestartGateway).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await telegramConfigurePost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for missing bot token", async () => {
    const res = await telegramConfigurePost(jsonRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Bot token is required");
  });

  it("returns 400 for invalid token format - no colon", async () => {
    const res = await telegramConfigurePost(jsonRequest({ botToken: "invalidtoken" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid bot token format");
  });

  it("returns 400 for invalid token format - non-numeric prefix", async () => {
    const res = await telegramConfigurePost(jsonRequest({ botToken: "abc:defghijklmnop" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid bot token format");
  });

  it("returns 400 for invalid token format - special characters", async () => {
    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc!@#$%" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid bot token format");
  });

  it("accepts valid token formats", async () => {
    const validTokens = [
      "123456789:ABCDefGHIjklMNOpqrsTUVwxyz",
      "1:a",
      "999999999999:abc_DEF-123",
    ];

    for (const token of validTokens) {
      vi.clearAllMocks();
      const res = await telegramConfigurePost(jsonRequest({ botToken: token }));
      expect(res.status).toBe(200);
    }
  });

  it("returns 500 when setTelegramToken fails", async () => {
    mockSetTelegramToken.mockRejectedValue(new Error("Gateway unreachable"));

    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Gateway unreachable");
  });

  it("answers 502 with a soft warning when the gateway does not come back", async () => {
    // The token is already persisted before the restart, so a restart failure
    // must not fail the whole save — it's reported as a soft warning that
    // applies on the next gateway restart. But it is NOT a success either: the
    // bot does not answer until the gateway is serving, so the status code says
    // "the upstream did not come back", exactly as /telegram/streaming does for
    // the same condition (the route this one's own comment says it mirrors).
    mockRestartGateway.mockRejectedValue(new Error("Restart failed"));

    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.success).toBe(true);
    expect(body.restarted).toBe(false);
    expect(typeof body.warning).toBe("string");
    // The raw exec error must never be surfaced.
    expect(JSON.stringify(body)).not.toContain("Restart failed");
  });

  it("answers 200 with a soft warning when the gateway is still coming back", async () => {
    // TASK-608 widened this catch: before it, only a REFUSED `systemctl
    // restart` arrived here; now a restart that exited 0 and has not finished
    // binding :18789 does too, and on a cold box that is the ordinary case.
    // Both used to answer the same 502 and the same sentence — "will apply on
    // next gateway restart" — over a restart that has already been taken. The
    // same false failure this task removed from /local-ai/exclusive.
    mockRestartGateway.mockRejectedValue(new GatewayNotReadyError("gateway did not come back"));

    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.warning).toContain("has not finished restarting");
    // The sentence for a restart nobody took must not be reused here.
    expect(body.warning).not.toContain("next gateway restart");
  });

  it("returns generic error for non-Error throws", async () => {
    mockSet.mockRejectedValue("unknown error");

    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to save");
  });
});
