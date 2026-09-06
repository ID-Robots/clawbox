// One plain message to one chat, on the bot the box already talks on.
//
// Two features speak to the owner through this file — the coding-agent finish
// notice and the email approval question — and what is pinned here is the part
// that is identical for both and different per edition, plus the two promises
// its header makes: it never throws, and a caller's budget only ever shortens
// the wait, never lengthens it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-telegram", () => ({ notifyHermesTelegramUser: vi.fn(async () => true) }));
vi.mock("@/lib/telegram-bot-identity", () => ({ readActiveTelegramBot: vi.fn() }));

const TOKEN = "123456:AAbbCCddEEffGG-hh_ii";

let send: typeof import("@/lib/telegram-owner-send");
let harness: typeof import("@/lib/harness");
let hermes: typeof import("@/lib/hermes-telegram");
let identity: typeof import("@/lib/telegram-bot-identity");

beforeEach(async () => {
  vi.resetModules();
  send = await import("@/lib/telegram-owner-send");
  harness = await import("@/lib/harness");
  hermes = await import("@/lib/hermes-telegram");
  identity = await import("@/lib/telegram-bot-identity");
  vi.mocked(identity.readActiveTelegramBot).mockResolvedValue({ token: TOKEN, known: true });
  vi.mocked(hermes.notifyHermesTelegramUser).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `fetch` the OpenClaw leg makes, recorded. */
function stubTelegram(ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: ok ? 200 : 502 });
    }),
  );
  return calls;
}

describe("which bot the box talks on", () => {
  it("uses the harness's own CLI on Hermes and the Bot API on OpenClaw", async () => {
    const calls = stubTelegram();
    vi.mocked(harness.getActiveHarness).mockResolvedValue("hermes");
    expect(await send.sendOwnerTelegramText("6001", "hello")).toBe(true);
    expect(vi.mocked(hermes.notifyHermesTelegramUser)).toHaveBeenCalledWith("6001", "hello", undefined);
    expect(calls).toHaveLength(0);

    vi.mocked(harness.getActiveHarness).mockResolvedValue("openclaw");
    expect(await send.sendOwnerTelegramText("6001", "hello")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendMessage");
  });

  it("answers for the harness NAMED, not the active one", async () => {
    // The dual SKU runs both inbound hooks, so a verdict has to go back on the
    // bot the owner actually typed to.
    stubTelegram();
    vi.mocked(harness.getActiveHarness).mockResolvedValue("openclaw");
    await send.sendOwnerTelegramText("6001", "hello", { harness: "hermes" });
    expect(vi.mocked(hermes.notifyHermesTelegramUser)).toHaveBeenCalled();
  });
});

describe("a caller's budget", () => {
  it("shortens the wait on BOTH legs, and never lengthens it", async () => {
    stubTelegram();
    // The OpenClaw leg's budget is only visible in the signal it builds, so the
    // factory is what is watched — asserting `instanceof AbortSignal` would
    // pass for the unbudgeted call too, which is the whole thing under test.
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });

    await send.sendOwnerTelegramText("6001", "hello", { timeoutMs: 500 });
    await send.sendOwnerTelegramText("6001", "hello");
    // A budget LARGER than this file's own ceiling buys nothing.
    await send.sendOwnerTelegramText("6001", "hello", { timeoutMs: 9_999_999 });
    expect(timeouts).toEqual([500, send.TELEGRAM_TIMEOUT_MS, send.TELEGRAM_TIMEOUT_MS]);

    // The Hermes leg passes the number on and clamps it in its own file.
    vi.mocked(harness.getActiveHarness).mockResolvedValue("hermes");
    await send.sendOwnerTelegramText("6001", "hello", { timeoutMs: 500 });
    expect(vi.mocked(hermes.notifyHermesTelegramUser)).toHaveBeenCalledWith("6001", "hello", 500);
  });

  it("is optional: no budget means this file's own ceiling", async () => {
    stubTelegram();
    vi.mocked(harness.getActiveHarness).mockResolvedValue("hermes");
    await send.sendOwnerTelegramText("6001", "hello");
    expect(vi.mocked(hermes.notifyHermesTelegramUser)).toHaveBeenCalledWith("6001", "hello", undefined);
  });
});

describe("never throws", () => {
  it("answers false when the bot store cannot be READ at all", async () => {
    // `hermesSecretsPresent` raises on an unreadable harness store (EACCES
    // after a root-run `hermes config set`, a non-regular file). An unhandled
    // throw here would turn a notice beside work that SUCCEEDED into a failed
    // request — this file's header promises it cannot.
    stubTelegram();
    vi.mocked(identity.readActiveTelegramBot).mockRejectedValue(new Error("EACCES"));
    expect(await send.sendOwnerTelegramText("6001", "hello")).toBe(false);
  });

  it("answers false for a chat id that cannot address anybody", async () => {
    const calls = stubTelegram();
    expect(await send.sendOwnerTelegramText("not-a-chat", "hello")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("answers false for a token that is not the shape Telegram issues", async () => {
    // The token is interpolated into the request PATH, so its charset is what
    // stops a config value from reshaping the request.
    const calls = stubTelegram();
    vi.mocked(identity.readActiveTelegramBot).mockResolvedValue({ token: "not/a/token", known: true });
    expect(await send.sendOwnerTelegramText("6001", "hello")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rebuilds both values at the sink rather than trusting a caller", async () => {
    const calls = stubTelegram();
    expect(await send.sendTelegramBotMessage(` ${TOKEN} `, " -100200 ", "hello")).toBe(true);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(calls[0].init.body)).chat_id).toBe("-100200");
  });
});
