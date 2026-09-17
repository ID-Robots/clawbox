import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSessionCookie } from "@/tests/helpers/session";

/**
 * TASK-863 — the wizard's Update step and /setup-api/setup/status disagreed.
 *
 * On a freshly flashed box the step reports "System is up to date" and lets the
 * owner through without running anything, so nothing ever wrote the
 * `update_completed` config key — that key is the UPDATER's own record of a run
 * that finished, and /setup-api/update/status synthesises a `completed` phase
 * from it. The status route's field of the same name has meant something else
 * since it was born: it sits beside `wifi_configured` and `password_configured`
 * as the wizard's own progress, and the wizard reads it back to decide which
 * step to resume on. So every box that passed the step without needing an
 * update answered `update_completed: false` for ever.
 *
 * Both routes go through the same config store here, so this is the whole
 * chain: the wizard records that it moved past the Update step, and the status
 * route answers the question it was actually asked.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-update-step-completed-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");

const SESSION_SECRET = "update-step-completed-secret-0123456789";

let progressPost: (request: Request) => Promise<Response>;
let statusGet: (request: Request) => Promise<Response>;

function progressRequest(step: number): Request {
  return new Request("http://localhost/setup-api/setup/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step }),
  });
}

function statusRequest(): Request {
  return new Request("http://localhost/setup-api/setup/status", {
    headers: { Cookie: `clawbox_session=${signSessionCookie({ secret: SESSION_SECRET })}` },
  });
}

async function readStatus(): Promise<Record<string, unknown>> {
  return (await statusGet(statusRequest())).json();
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  process.env.SESSION_SECRET = SESSION_SECRET;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  await fs.writeFile(path.join(OPENCLAW_HOME, "openclaw.json"), JSON.stringify({}), "utf-8");
  vi.resetModules();
  ({ POST: progressPost } = await import("@/app/setup-api/setup/progress/route"));
  ({ GET: statusGet } = await import("@/app/setup-api/setup/status/route"));
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.OPENCLAW_HOME;
  delete process.env.SESSION_SECRET;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("the wizard's Update step and setup/status", () => {
  it("reports the step as done once the wizard has moved past it without updating", async () => {
    // Exactly what the wizard does when the step says "System is up to date":
    // it auto-advances to the Credentials step and persists that progress. No
    // update ran, so the updater wrote nothing.
    expect((await progressPost(progressRequest(3))).status).toBe(200);

    const body = await readStatus();

    expect(body.setup_progress_step).toBe(3);
    expect(body.update_completed).toBe(true);
  });

  it("still reports the step as open while the wizard is standing on it", async () => {
    expect((await progressPost(progressRequest(2))).status).toBe(200);

    const body = await readStatus();

    expect(body.setup_progress_step).toBe(2);
    expect(body.update_completed).toBe(false);
  });

  it("reports the step as done on a box that finished the whole wizard", async () => {
    // The rig boxes: setup finished, nothing to update, and the flag stuck at
    // false for every consumer that read it afterwards.
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ setup_complete: true, setup_progress_step: 6 }), "utf-8");

    const body = await readStatus();

    expect(body.setup_complete).toBe(true);
    expect(body.update_completed).toBe(true);
  });

  it("keeps reporting a real completed update run", async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ update_completed: true }), "utf-8");

    const body = await readStatus();

    expect(body.update_completed).toBe(true);
  });

  it("answers the same field to an anonymous caller", async () => {
    // The field is part of the public payload the /login page and the wizard
    // bootstrap read before a session exists — it must not need one to be true.
    expect((await progressPost(progressRequest(4))).status).toBe(200);

    const body = await (await statusGet(new Request("http://localhost/setup-api/setup/status"))).json();

    expect(body.update_completed).toBe(true);
    expect(body).not.toHaveProperty("telegram_configured");
  });
});
