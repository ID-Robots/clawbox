import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-telegram-status-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

type RouteGet = () => Promise<Response>;

let telegramStatusGet: RouteGet;

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  ({ GET: telegramStatusGet } = await import("@/app/setup-api/telegram/status/route"));
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("GET /setup-api/telegram/status", () => {
  it("returns configured:false when no token is set", async () => {
    const res = await telegramStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
  });

  it("returns configured:true when token is set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ telegram_bot_token: "123456:ABC" }), "utf-8");

    const res = await telegramStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
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
});
