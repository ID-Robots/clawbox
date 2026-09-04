import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "../../helpers/env";

/**
 * TASK-551 — `app_uninstall` computed its delete target from an OpenClaw path
 * on a device with no OpenClaw.
 *
 * `getSkillsDir()` answers unconditionally: openclaw.json's workspace, else
 * ~/.openclaw/workspace, else ~/clawd. On the Hermes SKU neither of the first
 * two exists, so it returns ~/clawd — a directory nothing on that device
 * created and nothing uses — and the route resolved <appId> under its `skills`
 * child and `rm -rf`'d it, then answered `{ok:true}`.
 *
 * Harmless only by accident today: mcp/tools/desktop.ts pre-filters the
 * installed list and page.tsx hides the store, so only webapps reach here on
 * Hermes. The route itself has no edition question — unlike its apps/install
 * sibling, which calls openclawAppsGuard(). Anything that widens what reaches
 * it turns a no-op into a wrong-directory delete that reports success.
 *
 * It must NOT simply be guarded off on Hermes: openclaw-apps-server.ts records
 * why this one route is deliberately reachable there — the MCP `app_uninstall`
 * tool posts to it, so the agent can still remove a webapp whose store the UI
 * has hidden, and refusing would strand those apps in the prefs with nothing
 * able to delete them. So the SKILL half is what has to know the edition; the
 * webapp, icon, preference and KV cleanup stays.
 */

vi.mock("@/lib/openclaw-skill-info", () => ({ refreshSkillsCache: vi.fn() }));
vi.mock("@/lib/kv-store", () => ({ kvDelete: vi.fn() }));
vi.mock("@/lib/preference-store", () => ({ setPreferences: vi.fn().mockResolvedValue(undefined) }));

const clearSkillEntry = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  clearSkillEntry,
}));

let home: string;
let dataDir: string;
let restoreEnv: () => void;

vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() {
    return dataDir;
  },
  getAll: vi.fn().mockResolvedValue({}),
  setMany: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/code-projects", () => ({
  get WEBAPPS_DIR() {
    return path.join(dataDir, "webapps");
  },
}));

const APP = "notes";

async function uninstall(appId: string) {
  const { POST } = await import("@/app/setup-api/apps/uninstall/route");
  const res = await POST(
    new Request("http://localhost/setup-api/apps/uninstall", {
      method: "POST",
      body: JSON.stringify({ appId }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The legacy OpenClaw workspace `getSkillsDir()` falls back to. */
const clawdSkill = () => path.join(home, "clawd", "skills", APP);
const webappDir = () => path.join(dataDir, "webapps", APP);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  clearSkillEntry.mockResolvedValue(false);
  restoreEnv = saveEnv("HOME", "CLAWBOX_EDITION");
  home = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-uninst-"));
  dataDir = path.join(home, "clawbox", "data");
  process.env.HOME = home;
  // A file nothing on a Hermes box put there, standing in for whatever the
  // agent or an older install left in the legacy workspace.
  await fs.mkdir(clawdSkill(), { recursive: true });
  await fs.writeFile(path.join(clawdSkill(), "SKILL.md"), "# not ours\n");
  await fs.mkdir(webappDir(), { recursive: true });
  await fs.writeFile(path.join(webappDir(), "index.html"), "<p>hi</p>");
});

afterEach(async () => {
  restoreEnv();
  await fs.rm(home, { recursive: true, force: true });
});

describe("POST /setup-api/apps/uninstall on a device with no OpenClaw", () => {
  beforeEach(() => {
    process.env.CLAWBOX_EDITION = "hermes";
  });

  it("does not delete a directory under the OpenClaw workspace it does not have", async () => {
    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // THE defect: the directory under the workspace this edition does not have
    // is still there.
    await expect(fs.stat(clawdSkill())).resolves.toBeTruthy();
    // ...and the answer says the skill half did not happen, rather than
    // reporting the same `{ok:true}` a real removal reports.
    expect(body.skillRemoved).toBeNull();
  });

  it("still removes the webapp — the reason this route is reachable there at all", async () => {
    await uninstall(APP);

    await expect(fs.stat(webappDir())).rejects.toThrow();
  });

  it("does not touch the OpenClaw config it has none of", async () => {
    await uninstall(APP);

    expect(clearSkillEntry).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/apps/uninstall on an OpenClaw device", () => {
  beforeEach(() => {
    process.env.CLAWBOX_EDITION = "openclaw";
  });

  it("deletes under the workspace the config names, not the legacy fallback", async () => {
    // The branch a real device takes. `getSkillsDir()` prefers
    // `agents.defaults.workspace`, then ~/.openclaw/workspace, then ~/clawd —
    // and only the last of those was covered, so a helper that resolved the
    // wrong one of the three, or stopped appending `skills`, was pinned by
    // nothing.
    const workspace = path.join(home, "work");
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace } } }),
    );
    const configured = path.join(workspace, "skills", APP);
    await fs.mkdir(configured, { recursive: true });
    await fs.writeFile(path.join(configured, "SKILL.md"), "# ours\n");

    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    expect(body.skillRemoved).toBe(true);
    await expect(fs.stat(configured)).rejects.toThrow();
    // ...and the legacy path it did NOT resolve is untouched.
    await expect(fs.stat(clawdSkill())).resolves.toBeTruthy();
  });

  it("refuses to guess a delete target from a config it could not read", async () => {
    // `getSkillsDir()` swallows a parse error and falls through to a
    // well-known path. Good enough for the `stat` its other caller makes, and
    // not a delete target: openclaw.json is rewritten in place by `openclaw
    // config set`, so a half-written read is a real race, and on a box whose
    // workspace is not the well-known one it would redirect the removal.
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), '{"agents":{"defa');

    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    await expect(fs.stat(clawdSkill())).resolves.toBeTruthy();
    expect(body.skillRemoved).toBeNull();
    expect(clearSkillEntry).not.toHaveBeenCalled();
  });

  it("removes the skill directory, exactly as before", async () => {
    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    await expect(fs.stat(clawdSkill())).rejects.toThrow();
    await expect(fs.stat(webappDir())).rejects.toThrow();
    expect(clearSkillEntry).toHaveBeenCalledWith(APP);
  });
});
