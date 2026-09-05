import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-551 round 7 — the id that reaches a filesystem path.
 *
 * `POST /setup-api/apps/uninstall` builds three delete targets out of the
 * request body's `appId`: `<skillsRoot>/<id>`, `<data>/webapps/<id>` and
 * `<data>/icons/<id>.png`. All three joined the CALLER'S STRING, with a regex
 * in the route as the only thing keeping them inside their directories — the
 * alphabet #627 widened and shared with `webapp_update` and `code_project_*`.
 *
 * The rest of the tree stopped doing that: `code-projects.ts` (safeProjectId),
 * `openclaw-skill-info.ts` (safeSkillName) and `webapp-icon.ts` (safeAppId)
 * each REBUILD the id from a constant alphabet before joining, and each says
 * why in a comment — a `.test()` guard leaves the caller's string in play. This
 * route was one of the three left, and CodeQL reports the icon removal as
 * `js/path-injection` (high).
 *
 * Real temp filesystem, not a mocked `fs`: the claim is that the NEIGHBOUR
 * survives, and a mocked `rm` can only prove which string was passed to it.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-uninstall-guard-"));
const PREVIOUS_ROOT = process.env.CLAWBOX_ROOT;
process.env.CLAWBOX_ROOT = ROOT;

const SKILLS_ROOT = path.join(ROOT, "openclaw-workspace", "skills");

// An OpenClaw device, so the skill half runs too — the Hermes answer (null) is
// pinned against the real implementation in uninstall-edition.test.ts.
vi.mock("@/lib/openclaw-config", () => ({
  openclawSkillRoot: vi.fn(() => SKILLS_ROOT),
  clearSkillEntry: vi.fn(async () => false),
  OpenclawConfigUnreadableError: class OpenclawConfigUnreadableError extends Error {
    readonly code = "config_unreadable";
  },
}));

// The rescan behind an uninstall would spawn the real openclaw CLI here.
vi.mock("@/lib/openclaw-skill-info", () => ({ refreshSkillsCache: vi.fn() }));
vi.mock("@/lib/kv-store", () => ({ kvDelete: vi.fn() }));
vi.mock("@/lib/preference-store", () => ({ setPreferences: vi.fn(async () => undefined) }));

// The real DATA_DIR (it follows CLAWBOX_ROOT above, which is what puts the
// webapps and icons under the temp root); only the preference read is stubbed.
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, getAll: vi.fn(async () => ({})) };
});

const WEBAPPS = path.join(ROOT, "data", "webapps");
const ICONS = path.join(ROOT, "data", "icons");

/** An app with all three halves on disk: a skill, a deployed webapp, an icon. */
function seed(appId: string): void {
  fs.mkdirSync(path.join(SKILLS_ROOT, appId), { recursive: true });
  fs.writeFileSync(path.join(SKILLS_ROOT, appId, "SKILL.md"), `# ${appId}\n`);
  fs.mkdirSync(path.join(WEBAPPS, appId), { recursive: true });
  fs.writeFileSync(path.join(WEBAPPS, appId, "index.html"), `<h1>${appId}</h1>`);
  fs.mkdirSync(ICONS, { recursive: true });
  fs.writeFileSync(path.join(ICONS, `${appId}.png`), "PNG");
}

function onDisk(appId: string) {
  return {
    skill: fs.existsSync(path.join(SKILLS_ROOT, appId)),
    webapp: fs.existsSync(path.join(WEBAPPS, appId)),
    icon: fs.existsSync(path.join(ICONS, `${appId}.png`)),
  };
}

const ALL_THERE = { skill: true, webapp: true, icon: true };

async function uninstall(appId: unknown) {
  const mod = await import("@/app/setup-api/apps/uninstall/route");
  const res = await mod.POST(
    new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.resetModules();
  fs.rmSync(path.join(ROOT, "data"), { recursive: true, force: true });
  fs.rmSync(SKILLS_ROOT, { recursive: true, force: true });
  seed("notes");
  seed("other");
});

afterAll(() => {
  if (PREVIOUS_ROOT === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = PREVIOUS_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("POST /setup-api/apps/uninstall — an id that is not one path segment", () => {
  for (const appId of ["../../etc", "notes/../other", "notes/nested", "..", ".", ""]) {
    it(`refuses ${JSON.stringify(appId)} without touching the disk`, async () => {
      const { status, body } = await uninstall(appId);

      expect(status).toBe(400);
      // The route's refusal contract, the one the Store and the MCP door read:
      // an id that cannot be spelled is not a fault to wait out and retry.
      expect(body).toMatchObject({ ok: false, code: "invalid_app_id", retryable: false });
      expect(onDisk("notes")).toEqual(ALL_THERE);
      expect(onDisk("other")).toEqual(ALL_THERE);
    });
  }

  it("removes exactly the app named, and leaves its neighbour alone", async () => {
    const { status, body } = await uninstall("notes");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(onDisk("notes")).toEqual({ skill: false, webapp: false, icon: false });
    expect(onDisk("other")).toEqual(ALL_THERE);
  });
});
