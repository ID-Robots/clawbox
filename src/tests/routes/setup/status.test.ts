import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-setup-status-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

type RouteGet = (request?: Request) => Promise<Response>;

let statusGet: RouteGet;

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  await fs.writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify({}), "utf-8");
  vi.resetModules();
  ({ GET: statusGet } = await import("@/app/setup-api/setup/status/route"));
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
  await fs.writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify({}), "utf-8");
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.OPENCLAW_HOME;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("GET /setup-api/setup/status", () => {
  it("returns all flags as false when config is empty", async () => {
    const res = await statusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.setup_complete).toBe(false);
    expect(body.password_configured).toBe(false);
    expect(body.update_completed).toBe(false);
    expect(body.wifi_configured).toBe(false);
    expect(body.setup_progress_step).toBeNull();
    expect(body.local_ai_configured).toBe(false);
    expect(body.local_ai_provider).toBeNull();
    expect(body.local_ai_model).toBeNull();
    expect(body.ai_model_configured).toBe(false);
    expect(body.ai_model_provider).toBeNull();
    expect(body.telegram_configured).toBe(false);
  });

  it("returns setup_complete as true when set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ setup_complete: true }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.setup_complete).toBe(true);
  });

  it("returns password_configured as true when set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ password_configured: true }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.password_configured).toBe(true);
  });

  it("returns update_completed as true when set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ update_completed: true }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.update_completed).toBe(true);
  });

  it("returns wifi_configured as true when set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ wifi_configured: true }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.wifi_configured).toBe(true);
  });

  it("returns setup_progress_step when present", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ setup_progress_step: 5 }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.setup_progress_step).toBe(5);
  });

  it("returns ai_model_configured with provider when set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({
      ai_model_configured: true,
      ai_model_provider: "anthropic",
    }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.ai_model_configured).toBe(true);
    expect(body.ai_model_provider).toBe("anthropic");
  });

  it("returns local_ai_configured with provider and model when set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.local_ai_configured).toBe(true);
    expect(body.local_ai_provider).toBe("llamacpp");
    expect(body.local_ai_model).toBe("llamacpp/gemma4-e2b-it-q4_0");
  });

  it("infers local AI configuration from openclaw.json when config-store flags are missing", async () => {
    await fs.writeFile(
      OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-v4-pro",
              fallbacks: ["deepseek/deepseek-v4-pro"],
            },
          },
        },
        models: {
          providers: {
            llamacpp: {
              models: [{ id: "gemma4-e2b-it-q4_0" }],
            },
          },
        },
      }),
      "utf-8",
    );

    const res = await statusGet();
    const body = await res.json();

    expect(body.local_ai_configured).toBe(true);
    expect(body.local_ai_provider).toBe("llamacpp");
    expect(body.local_ai_model).toBe("llamacpp/gemma4-e2b-it-q4_0");
  });

  it("honors an explicit disabled local AI flag instead of inferring from openclaw.json", async () => {
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({
        local_ai_configured: false,
      }),
      "utf-8",
    );
    await fs.writeFile(
      OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        models: {
          providers: {
            llamacpp: {
              models: [{ id: "gemma4-e2b-it-q4_0" }],
            },
          },
        },
      }),
      "utf-8",
    );

    const res = await statusGet();
    const body = await res.json();

    expect(body.local_ai_configured).toBe(false);
    expect(body.local_ai_provider).toBeNull();
    expect(body.local_ai_model).toBeNull();
  });

  it("returns telegram_configured as true when bot token is set", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({
      telegram_bot_token: "123456:ABC",
    }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.telegram_configured).toBe(true);
  });

  it("returns all configuration states correctly", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({
      setup_complete: true,
      password_configured: true,
      update_completed: true,
      wifi_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      ai_model_configured: true,
      ai_model_provider: "openai",
      telegram_bot_token: "token123",
    }), "utf-8");

    const res = await statusGet();
    const body = await res.json();

    expect(body.setup_complete).toBe(true);
    expect(body.password_configured).toBe(true);
    expect(body.update_completed).toBe(true);
    expect(body.wifi_configured).toBe(true);
    expect(body.setup_progress_step).toBeNull();
    expect(body.local_ai_configured).toBe(true);
    expect(body.local_ai_provider).toBe("llamacpp");
    expect(body.local_ai_model).toBe("llamacpp/gemma4-e2b-it-q4_0");
    expect(body.ai_model_configured).toBe(true);
    expect(body.ai_model_provider).toBe("openai");
    expect(body.telegram_configured).toBe(true);
  });
});
