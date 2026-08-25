import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-453 round 2 — `app_uninstall` left the deployed webapp on disk.
 *
 * Observed live: after `app_uninstall qa-t453a-revalidate` the desktop icon and
 * the preference were gone, but `data/webapps/qa-t453a-revalidate/` was still
 * there and `/setup-api/webapps?app=qa-t453a-revalidate` still answered 200
 * with the agent's page. The owner is told the app is removed while it stays
 * served to anyone holding the URL.
 *
 * Real temp directory rather than a mocked fs: the point of the test is that
 * the FILES are gone, and a mocked `rm` can only prove a call was made.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-uninstall-"));
const PREVIOUS_ROOT = process.env.CLAWBOX_ROOT;
process.env.CLAWBOX_ROOT = ROOT;

const SKILLS_ROOT = path.join(ROOT, "openclaw-workspace");

vi.mock("@/lib/openclaw-config", () => ({
  getSkillsDir: vi.fn(() => SKILLS_ROOT),
}));

vi.mock("@/lib/preference-store", () => ({
  setPreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, getAll: vi.fn().mockResolvedValue({}) };
});

const WEBAPPS = path.join(ROOT, "data", "webapps");

function deployWebapp(appId: string): string {
  const dir = path.join(WEBAPPS, appId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>T453 MARKER</h1>");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: appId }));
  return dir;
}

async function uninstall(appId: unknown): Promise<Response> {
  const mod = await import("@/app/setup-api/apps/uninstall/route");
  return mod.POST(
    new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId }),
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  fs.rmSync(WEBAPPS, { recursive: true, force: true });
});

afterAll(() => {
  // Restore rather than leak the temp root into anything that runs after.
  if (PREVIOUS_ROOT === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = PREVIOUS_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("/setup-api/apps/uninstall — the deployed webapp goes with the app", () => {
  it("deletes data/webapps/<appId>/ so the URL stops serving", async () => {
    const dir = deployWebapp("qa-t453a-revalidate");
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);

    const res = await uninstall("qa-t453a-revalidate");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, appId: "qa-t453a-revalidate" });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("leaves every other deployed webapp alone", async () => {
    deployWebapp("keep-me");
    const doomed = deployWebapp("remove-me");

    await uninstall("remove-me");

    expect(fs.existsSync(doomed)).toBe(false);
    expect(fs.readFileSync(path.join(WEBAPPS, "keep-me", "index.html"), "utf8")).toContain("T453 MARKER");
  });

  it("succeeds for an app that never deployed a webapp", async () => {
    const res = await uninstall("never-built");
    expect(res.status).toBe(200);
  });

  it("cannot be walked out of the webapps directory", async () => {
    const sibling = path.join(ROOT, "data", "config.json");
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, "{}");

    const res = await uninstall("../config.json");

    expect(res.status).toBe(400);
    expect(fs.existsSync(sibling)).toBe(true);
  });
});
