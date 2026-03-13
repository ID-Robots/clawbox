import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  set: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  setTelegramToken: vi.fn(),
  restartGateway: vi.fn(),
}));

import { set } from "@/lib/config-store";
import { setTelegramToken, restartGateway } from "@/lib/openclaw-config";

const mockSet = vi.mocked(set);
const mockSetTelegramToken = vi.mocked(setTelegramToken);
const mockRestartGateway = vi.mocked(restartGateway);

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

    mockSet.mockResolvedValue();
    mockSetTelegramToken.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();

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

  it("returns 500 when restartGateway fails", async () => {
    mockRestartGateway.mockRejectedValue(new Error("Restart failed"));

    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Restart failed");
  });

  it("returns generic error for non-Error throws", async () => {
    mockSet.mockRejectedValue("unknown error");

    const res = await telegramConfigurePost(jsonRequest({ botToken: "123:abc" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to save");
  });
});
