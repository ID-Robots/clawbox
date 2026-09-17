import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-setup-progress-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

type RoutePost = (request: Request) => Promise<Response>;

let progressPost: RoutePost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/setup/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  ({ POST: progressPost } = await import("@/app/setup-api/setup/progress/route"));
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("POST /setup-api/setup/progress", () => {
  it("stores the current setup progress step", async () => {
    const res = await progressPost(jsonRequest({ step: 3 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.step).toBe(3);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_progress_step).toBe(3);
  });

  it("never moves setup progress backward", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ setup_progress_step: 5 }), "utf-8");

    const res = await progressPost(jsonRequest({ step: 3 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.step).toBe(5);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_progress_step).toBe(5);
  });

  it("never rewinds progress persisted by a build with more steps than this one", async () => {
    // The stored value is read without this wizard's upper bound: rejecting it
    // would make the next POST overwrite a later step with an earlier one and
    // walk the owner back through screens they have already answered.
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ setup_progress_step: 7 }), "utf-8");

    const res = await progressPost(jsonRequest({ step: 3 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.step).toBe(7);

    const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(config.setup_progress_step).toBe(7);
  });

  it("rejects invalid step values", async () => {
    const res = await progressPost(jsonRequest({ step: 99 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid setup step");
  });
});
