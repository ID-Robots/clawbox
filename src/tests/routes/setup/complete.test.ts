import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-setup-complete-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

type RoutePost = (request?: Request) => Promise<Response>;

let completePost: RoutePost;

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  ({ POST: completePost } = await import("@/app/setup-api/setup/complete/route"));
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("POST /setup-api/setup/complete", () => {
  it("marks setup as complete", async () => {
    const res = await completePost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBe(true);
  });

  it("sets setup_completed_at timestamp", async () => {
    const before = new Date().toISOString();
    await completePost();
    const after = new Date().toISOString();

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_completed_at).toBeDefined();

    const timestamp = new Date(config.setup_completed_at);
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it("preserves existing config values", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({
      existing_key: "preserved",
      wifi_configured: true,
    }), "utf-8");

    await completePost();

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.existing_key).toBe("preserved");
    expect(config.wifi_configured).toBe(true);
    expect(config.setup_complete).toBe(true);
  });

  it("can be called multiple times", async () => {
    const res1 = await completePost();
    expect(res1.status).toBe(200);

    const res2 = await completePost();
    expect(res2.status).toBe(200);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_complete).toBe(true);
  });

  it("returns success even without session secret", async () => {
    const res = await completePost();
    expect(res.status).toBe(200);
    // The cookie may or may not be set depending on whether getOrCreateSecret works
    // but the response should always be success
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
