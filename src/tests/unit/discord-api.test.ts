import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DiscordAuthError,
  DiscordUnavailableError,
  fetchDiscordBotInfo,
  isSafeDiscordToken,
} from "@/lib/discord-api";

// A Discord bot token is opaque, so the live call IS the validation. These tests
// pin the two distinctions the rest of the integration depends on:
//   * 401 (a verdict on the token) must never be confused with
//   * offline / 429 / 5xx (no verdict at all) — treating the second as a bad
//     token would tell someone with a perfectly good bot to go get a new one.

// Deliberately NOT shaped like a real Discord token: a realistic fixture trips
// GitHub's push protection (it is a public repo), and the code treats the token
// as opaque anyway, so the shape carries no test value.
const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("isSafeDiscordToken", () => {
  it("accepts a token-shaped value", () => {
    expect(isSafeDiscordToken(TOKEN)).toBe(true);
  });

  it("rejects a leading dash, which the Hermes CLI would read as a flag", () => {
    expect(isSafeDiscordToken(`-${TOKEN}`)).toBe(false);
  });

  it("rejects whitespace and newlines, which would split a systemd env line", () => {
    expect(isSafeDiscordToken(`${TOKEN} extra`)).toBe(false);
    expect(isSafeDiscordToken(`${TOKEN}\nDISCORD_ALLOW_ALL_USERS=true`)).toBe(false);
    expect(isSafeDiscordToken(`${TOKEN}\r`)).toBe(false);
  });

  it("rejects quoting and shell metacharacters", () => {
    expect(isSafeDiscordToken(`"${TOKEN}"`)).toBe(false);
    expect(isSafeDiscordToken(`${TOKEN};id`)).toBe(false);
    expect(isSafeDiscordToken(`${TOKEN}$(id)`)).toBe(false);
  });

  it("rejects values too short to be a token", () => {
    expect(isSafeDiscordToken("abc")).toBe(false);
    expect(isSafeDiscordToken("")).toBe(false);
  });

  it("does not impose a segment shape — the live check is the real test", () => {
    // Discord has changed the token encoding more than once; a shape check here
    // would reject valid tokens on the next change.
    expect(isSafeDiscordToken("a".repeat(72))).toBe(true);
  });
});

describe("fetchDiscordBotInfo", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Discord for the bot identity with Bot auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "42", username: "clawbot", discriminator: "0" }));

    const info = await fetchDiscordBotInfo(TOKEN);

    expect(info).toEqual({
      id: "42",
      username: "clawbot",
      discriminator: undefined,
      displayName: "clawbot",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/users/@me");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
  });

  it("keeps a legacy discriminator in the display name", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "42", username: "clawbot", discriminator: "0451" }));
    await expect(fetchDiscordBotInfo(TOKEN)).resolves.toMatchObject({
      displayName: "clawbot#0451",
    });
  });

  it("throws DiscordAuthError on 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "401: Unauthorized", code: 0 }, 401));
    await expect(fetchDiscordBotInfo(TOKEN)).rejects.toBeInstanceOf(DiscordAuthError);
  });

  it("throws DiscordUnavailableError — not an auth error — when rate limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ retry_after: 3 }, 429));
    await expect(fetchDiscordBotInfo(TOKEN)).rejects.toBeInstanceOf(DiscordUnavailableError);
  });

  it("throws DiscordUnavailableError on a server error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    await expect(fetchDiscordBotInfo(TOKEN)).rejects.toBeInstanceOf(DiscordUnavailableError);
  });

  it("throws DiscordUnavailableError when the device is offline", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchDiscordBotInfo(TOKEN)).rejects.toBeInstanceOf(DiscordUnavailableError);
  });

  it("throws DiscordUnavailableError on an answer it cannot read", async () => {
    fetchMock.mockResolvedValue(new Response("<html>proxy</html>", { status: 200 }));
    await expect(fetchDiscordBotInfo(TOKEN)).rejects.toBeInstanceOf(DiscordUnavailableError);
  });

  it("never puts the token in an error message", async () => {
    for (const response of [
      jsonResponse({}, 401),
      jsonResponse({}, 500),
    ]) {
      fetchMock.mockResolvedValue(response);
      const err = await fetchDiscordBotInfo(TOKEN).catch((e: Error) => e);
      expect(String(err)).not.toContain(TOKEN);
      expect((err as Error).stack ?? "").not.toContain(TOKEN);
    }
  });

  // The route hands this call `request.signal` so a browser that goes away
  // stops the work. That must not cost us the 8 s ceiling: `signal ?? timeout`
  // used the caller's signal INSTEAD of the timeout, so a Discord connection
  // that opened and then hung would keep the POST (and the Settings spinner)
  // alive on undici's defaults.
  describe("abort handling", () => {
    /** Run the call with fetch parked until whichever signal it got aborts. */
    function callWithParkedFetch(callerSignal?: AbortSignal) {
      let seen: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        seen = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
      const promise = fetchDiscordBotInfo(TOKEN, callerSignal);
      return { promise, signal: () => seen as AbortSignal };
    }

    it("still times out when the caller supplies its own signal", async () => {
      // Stand in for the 8 s timer so the test does not have to wait for it.
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const caller = new AbortController();

      const { promise, signal } = callWithParkedFetch(caller.signal);
      const rejects = expect(promise).rejects.toBeInstanceOf(DiscordUnavailableError);
      expect(signal().aborted).toBe(false);

      timeout.abort();

      expect(signal().aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      await rejects;
    });

    it("still aborts when the caller disconnects", async () => {
      const caller = new AbortController();
      const { promise, signal } = callWithParkedFetch(caller.signal);
      const rejects = expect(promise).rejects.toBeInstanceOf(DiscordUnavailableError);

      caller.abort();

      expect(signal().aborted).toBe(true);
      await rejects;
    });
  });
});
