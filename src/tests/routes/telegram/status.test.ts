import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-telegram-status-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
// OpenClaw's own store — where `openclaw config set channels.telegram.botToken`
// and setTelegramToken() write, and what the gateway long-polls from.
const OPENCLAW_HOME = path.join(TEST_ROOT, "openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

type RouteGet = () => Promise<Response>;

let telegramStatusGet: RouteGet;
const savedRoot = process.env.CLAWBOX_ROOT;
const savedOpenclawHome = process.env.OPENCLAW_HOME;

// This suite checks which on-disk credential counts as configured. Live
// delivery/receiving behavior has dedicated suites; neither Telegram nor an
// installed OpenClaw CLI should be reached by these fixture-only checks.
vi.mock("@/lib/openclaw-channels", () => ({
  readCachedChannelStatus: async () => null,
}));

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  vi.resetModules();
  ({ GET: telegramStatusGet } = await import("@/app/setup-api/telegram/status/route"));
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, result: { username: "fixture_bot", first_name: "Fixture" } }),
  }));
  await fs.rm(CONFIG_PATH, { force: true });
  await fs.rm(OPENCLAW_CONFIG_PATH, { force: true });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = savedRoot;
  if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedOpenclawHome;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("GET /setup-api/telegram/status", () => {
  it("returns configured:false when no token is set", async () => {
    const res = await telegramStatusGet();
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.configured).toBe(false);
  });

  it("returns configured:true when token is set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ telegram_bot_token: "123456:ABC" }), "utf-8");

    const res = await telegramStatusGet();
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.configured).toBe(true);
  });

  it("returns configured:false for empty token", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ telegram_bot_token: "" }), "utf-8");

    const res = await telegramStatusGet();
    const body = await res.json();

    expect(body.configured).toBe(false);
  });

  it("returns configured:false for null token", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ telegram_bot_token: null }), "utf-8");

    const res = await telegramStatusGet();
    const body = await res.json();

    expect(body.configured).toBe(false);
  });

  // The credential belongs to the HARNESS on this edition too: setTelegramToken()
  // writes channels.telegram.botToken into openclaw.json and the gateway polls
  // from there. ClawBox's telegram_bot_token is a mirror this route's own
  // configure sibling happens to write, and a box paired with `openclaw config
  // set` — or restored with ~/.openclaw intact and a fresh data/config.json —
  // has none. Reporting "not configured" there invites the owner to set up the
  // bot he is already chatting with.
  it("reports the bot OpenClaw itself holds when ClawBox has no copy", async () => {
    await fs.writeFile(
      OPENCLAW_CONFIG_PATH,
      JSON.stringify({ channels: { telegram: { enabled: true, botToken: "654321:NativeOpenClawBot" } } }),
      "utf-8",
    );

    const res = await telegramStatusGet();
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.configured).toBe(true);
  });
});
