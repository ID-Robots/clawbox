import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  SlackAuthError,
  SlackUnavailableError,
  checkSlackAppToken,
  fetchSlackBotInfo,
  isSlackAppToken,
  isSlackBotToken,
} from "@/lib/slack-api";

// Slack answers an auth failure with HTTP 200 and `ok:false`, and an outage
// with a non-2xx. Mixing the two up is how a box that is merely offline tells
// its owner the token is wrong, so both directions are pinned here.

const BOT = ["xoxb", "000000000000", "000000000000", "clawboxtestnotreal"].join("-");
const APP = ["xapp", "1", "A000000000", "000000000000", "clawboxtestnotreal"].join("-");

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("token shapes", () => {
  it("tells the two tokens apart", () => {
    expect(isSlackBotToken(BOT)).toBe(true);
    expect(isSlackAppToken(APP)).toBe(true);
    expect(isSlackBotToken(APP)).toBe(false);
    expect(isSlackAppToken(BOT)).toBe(false);
    expect(isSlackBotToken(`${BOT}\n`)).toBe(false);
    expect(isSlackBotToken("xoxp-0000000000-user")).toBe(false);
  });
});

describe("fetchSlackBotInfo", () => {
  it("reads the workspace and bot from auth.test", async () => {
    answer({ ok: true, team: "Acme", team_id: "T1", user: "clawbox", user_id: "U1", bot_id: "B1" });
    expect(await fetchSlackBotInfo(BOT)).toEqual({
      teamId: "T1",
      teamName: "Acme",
      botName: "clawbox",
      botUserId: "U1",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/auth.test");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT}`);
  });

  it("rejects a token Slack calls dead", async () => {
    answer({ ok: false, error: "invalid_auth" });
    await expect(fetchSlackBotInfo(BOT)).rejects.toBeInstanceOf(SlackAuthError);
  });

  it("rejects a token that is not a bot's (no bot_id)", async () => {
    answer({ ok: true, team: "Acme", team_id: "T1", user: "ada", user_id: "U1" });
    await expect(fetchSlackBotInfo(BOT)).rejects.toMatchObject({ problem: "bot_token_rejected" });
  });

  it("calls a rate limit, an outage or a network error unavailable — never a bad token", async () => {
    answer({ ok: false, error: "ratelimited" });
    await expect(fetchSlackBotInfo(BOT)).rejects.toBeInstanceOf(SlackUnavailableError);
    answer({}, 503);
    await expect(fetchSlackBotInfo(BOT)).rejects.toBeInstanceOf(SlackUnavailableError);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(fetchSlackBotInfo(BOT)).rejects.toBeInstanceOf(SlackUnavailableError);
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(fetchSlackBotInfo(BOT)).rejects.toBeInstanceOf(SlackUnavailableError);
  });

  it("refuses a malformed token without calling Slack", async () => {
    await expect(fetchSlackBotInfo("nope")).rejects.toBeInstanceOf(SlackAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkSlackAppToken", () => {
  it("passes when Slack opens a Socket Mode connection", async () => {
    answer({ ok: true, url: "wss://example.invalid/link" });
    await expect(checkSlackAppToken(APP)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/apps.connections.open");
  });

  it("names a missing connections:write scope apart from a dead token", async () => {
    answer({ ok: false, error: "missing_scope" });
    await expect(checkSlackAppToken(APP)).rejects.toMatchObject({ problem: "app_token_scope" });
    answer({ ok: false, error: "not_allowed_token_type" });
    await expect(checkSlackAppToken(APP)).rejects.toMatchObject({ problem: "app_token_rejected" });
  });

  it("calls an outage unavailable", async () => {
    answer({ ok: false, error: "internal_error" });
    await expect(checkSlackAppToken(APP)).rejects.toBeInstanceOf(SlackUnavailableError);
  });
});
