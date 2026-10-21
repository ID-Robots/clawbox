/**
 * POST /setup-api/apps/uninstall for a ClawBox app the Store installed: its
 * project folder goes too — only a folder carrying the Store's receipt for
 * that id, never the owner's own folder of the same name — and a folder that
 * will not go stops the uninstall before the desktop entry is dropped.
 *
 * Real temp filesystem: the claim is about what is left on disk.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-uninstall-store-"));
const PREVIOUS_ROOT = process.env.CLAWBOX_ROOT;
process.env.CLAWBOX_ROOT = ROOT;
const PROJECTS = path.join(ROOT, "projects");
const SKILLS_ROOT = path.join(ROOT, "openclaw-workspace", "skills");

vi.mock("@/lib/openclaw-config", () => ({
  openclawSkillRoot: vi.fn(() => SKILLS_ROOT),
  clearSkillEntry: vi.fn(async () => false),
  OpenclawConfigUnreadableError: class OpenclawConfigUnreadableError extends Error {
    readonly code = "config_unreadable";
  },
}));
vi.mock("@/lib/openclaw-skill-info", () => ({ refreshSkillsCache: vi.fn() }));
vi.mock("@/lib/kv-store", () => ({ kvDelete: vi.fn() }));
const setPreferences = vi.hoisted(() => vi.fn());
vi.mock("@/lib/preference-store", () => ({ setPreferences }));
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return {
    ...actual,
    getAll: vi.fn(async () => ({
      "pref:installed_apps": ["hello-app"],
      "pref:installed_meta": { "hello-app": { name: "Hello App", color: "#f97316", iconUrl: "", webappUrl: "/setup-api/webapps?app=hello-app" } },
    })),
  };
});
vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory: vi.fn(async () => PROJECTS) }));
const removeFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@/lib/store-install-receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store-install-receipt")>();
  return {
    ...actual,
    removeStoreInstalledFolder: vi.fn(async (appId: string) => {
      if (removeFailure.error) throw removeFailure.error;
      return actual.removeStoreInstalledFolder(appId);
    }),
  };
});

function post(appId: string): Request {
  return new Request("http://localhost/setup-api/apps/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId }) });
}

function storeFolder(id: string, receipt: boolean): string {
  const dir = path.join(PROJECTS, id);
  fs.mkdirSync(path.join(dir, ".clawbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "clawbox.json"), JSON.stringify({ name: "Hello App" }));
  if (receipt) {
    fs.writeFileSync(path.join(dir, ".clawbox", "store-app.json"), JSON.stringify({ source: "clawbox", slug: id, version: "1.0.0", sha256: "a".repeat(64), installedAt: "2026-10-01T00:00:00.000Z" }));
  }
  return dir;
}

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  removeFailure.error = null;
  setPreferences.mockReset();
  setPreferences.mockResolvedValue(undefined);
  vi.resetModules();
  POST = (await import("@/app/setup-api/apps/uninstall/route")).POST;
});

afterAll(() => {
  if (PREVIOUS_ROOT === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = PREVIOUS_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("uninstalling a ClawBox app from the Store", () => {
  it("removes the project folder the Store installed, and says so", async () => {
    const dir = storeFolder("hello-app", true);
    const res = await POST(post("hello-app"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, appId: "hello-app", projectRemoved: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("never touches the owner's folder of the same name", async () => {
    const dir = storeFolder("hello-app", false);
    const res = await POST(post("hello-app"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("projectRemoved");
    expect(fs.existsSync(path.join(dir, "clawbox.json"))).toBe(true);
  });

  it("stops before the desktop entry when the folder will not go", async () => {
    storeFolder("hello-app", true);
    removeFailure.error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const res = await POST(post("hello-app"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "project_remove_failed", retryable: true, appId: "hello-app" });
    expect(setPreferences).not.toHaveBeenCalled();
  });
});
