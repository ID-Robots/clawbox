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

// Hoisted, like clearSkillEntry below: the module registry is reset before each
// test, so a factory-local vi.fn() would not be the one the route just called.
const kvDelete = vi.hoisted(() => vi.fn());
const setPreferences = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/kv-store", () => ({ kvDelete }));
vi.mock("@/lib/preference-store", () => ({ setPreferences }));

const clearSkillEntry = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  clearSkillEntry,
}));

let home: string;
let dataDir: string;
let restoreEnv: () => void;
/** The config store's contents for one test — `installed_meta` is read from it. */
let stored: Record<string, unknown> = {};

// `vi.fn(impl)`, not a chained `.mockResolvedValue`: the vitest config's
// `mockReset: true` wipes a chained value before every test (this factory runs
// once) and `getAll` would then answer undefined.
vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() {
    return dataDir;
  },
  getAll: vi.fn(async () => stored),
  setMany: vi.fn(async () => undefined),
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
  stored = {};
  restoreEnv = saveEnv("HOME", "CLAWBOX_EDITION", "OPENCLAW_HOME");
  home = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-uninst-"));
  dataDir = path.join(home, "clawbox", "data");
  process.env.HOME = home;
  // vitest.config.ts floors OPENCLAW_HOME at a tmp path so no test reads a
  // real box's openclaw.json; a test that needs one points it at its own
  // fixture, which is what the module's CONFIG_PATH resolves.
  process.env.OPENCLAW_HOME = path.join(home, ".openclaw");
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

  it("refuses the whole uninstall, and drops nothing, when the config cannot be read", async () => {
    // `getSkillsDir()` swallows a parse error and falls through to a
    // well-known path. Good enough for the `stat` its other caller makes, and
    // not a delete target: openclaw.json is rewritten in place by `openclaw
    // config set`, so a half-written read is a real race, and on a box whose
    // workspace is not the well-known one it would redirect the removal.
    //
    // But "I could not read the config" is NOT "this device has no OpenClaw",
    // and answering the first with the second's `null` was a false success on
    // the edition that HAS the files: the skill and its `skills.entries.<id>`
    // stayed — still loaded by the gateway — while the tile, the preferences,
    // the KV and the icon went, and the route answered
    // `{ok:true, skillRemoved:null}` → "Removed from the desktop". The owner
    // then has no entry left to retry from. Nothing may be removed here.
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), '{"agents":{"defa');
    const icon = path.join(dataDir, "icons", `${APP}.png`);
    await fs.mkdir(path.dirname(icon), { recursive: true });
    await fs.writeFile(icon, "icon");

    const { status, body } = await uninstall(APP);

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("config_unreadable");
    expect(body.retryable).toBe(true);
    // Nothing was removed, and nothing the desktop needs to offer the retry
    // was dropped.
    await expect(fs.stat(clawdSkill())).resolves.toBeTruthy();
    await expect(fs.stat(webappDir())).resolves.toBeTruthy();
    await expect(fs.stat(icon)).resolves.toBeTruthy();
    expect(clearSkillEntry).not.toHaveBeenCalled();
    expect(setPreferences).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it("still removes a WEB APP while that config is unreadable — it has no skill half", async () => {
    // The refusal above must not spread to an app the OpenClaw config has
    // nothing to do with. On a licensed `dual` box running Hermes the idle
    // harness's openclaw.json can be invalid for good, and every uninstall on
    // the box — including the agent's own web apps, which beta removed — would
    // then need a terminal to recover.
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), '{"agents":{"defa');
    stored = { "pref:installed_meta": { [APP]: { name: "Notes", webappUrl: `/setup-api/webapps?app=${APP}` } } };

    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // No skill half to report on, so nothing is claimed about one.
    expect(body.skillRemoved).toBeNull();
    await expect(fs.stat(webappDir())).rejects.toThrow();
    // ...and the skills root was never resolved, so nothing under it was
    // touched and the OpenClaw config was left alone.
    await expect(fs.stat(clawdSkill())).resolves.toBeTruthy();
    expect(clearSkillEntry).not.toHaveBeenCalled();
  });

  it("follows OPENCLAW_HOME, not $HOME, to the config that names the workspace", async () => {
    // install.sh sets HOME and CLAWBOX_OPENCLAW_HOME side by side, so the two
    // agree on a shipped box by convention only. A helper that reads
    // $HOME/.openclaw while the module's own CONFIG_PATH honours the override
    // resolves the DELETE target from a file that is not this box's config —
    // TASK-551's shape, one level down.
    const overrideHome = path.join(home, "oc-home");
    process.env.OPENCLAW_HOME = overrideHome;
    const workspace = path.join(home, "work");
    await fs.mkdir(overrideHome, { recursive: true });
    await fs.writeFile(
      path.join(overrideHome, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace } } }),
    );
    // A DIFFERENT config in the place $HOME alone would look, naming a
    // workspace nothing may be deleted under.
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: path.join(home, "decoy") } } }),
    );
    const configured = path.join(workspace, "skills", APP);
    const decoy = path.join(home, "decoy", "skills", APP);
    await fs.mkdir(configured, { recursive: true });
    await fs.mkdir(decoy, { recursive: true });

    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    expect(body.skillRemoved).toBe(true);
    await expect(fs.stat(configured)).rejects.toThrow();
    await expect(fs.stat(decoy)).resolves.toBeTruthy();
  });

  it("falls back to the workspace under OPENCLAW_HOME, not the one under $HOME", async () => {
    // The other half of the same rule: when the config names no workspace, the
    // well-known one is OpenClaw's own `<home>/workspace`. Keyed on $HOME it
    // would find a directory belonging to no configuration this box reads —
    // and delete under it.
    const overrideHome = path.join(home, "oc-home");
    process.env.OPENCLAW_HOME = overrideHome;
    await fs.mkdir(overrideHome, { recursive: true });
    await fs.writeFile(path.join(overrideHome, "openclaw.json"), JSON.stringify({ agents: {} }));
    const real = path.join(overrideHome, "workspace", "skills", APP);
    const decoy = path.join(home, ".openclaw", "workspace", "skills", APP);
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(decoy, { recursive: true });

    const { body } = await uninstall(APP);

    expect(body.skillRemoved).toBe(true);
    await expect(fs.stat(real)).rejects.toThrow();
    await expect(fs.stat(decoy)).resolves.toBeTruthy();
  });

  // Root ignores the mode bits, so the unremovable child is removable there and
  // the case cannot be staged.
  it.skipIf(process.getuid?.() === 0)(
    "does not claim nothing happened when the folder was PART-removed",
    async () => {
      // `fs.rm` deletes as it walks and throws on the first entry it cannot
      // remove, so an EACCES deep in the folder leaves everything above it
      // already deleted. Reporting that as "nothing was removed" is the same
      // false report as reporting a non-removal as a removal, and the owner
      // acts on it — the tile stays, the retry fails the same way, and the
      // skill they were told is untouched is in pieces.
      const locked = path.join(home, "clawd", "skills", APP, "locked");
      await fs.mkdir(locked, { recursive: true });
      await fs.writeFile(path.join(locked, "inner.txt"), "pinned");
      await fs.chmod(locked, 0o500);
      try {
        const { status, body } = await uninstall(APP);

        expect(status).toBe(503);
        expect(body.code).toBe("skill_remove_failed");
        expect(body.retryable).toBe(true);
        // The folder really is part-gone: SKILL.md went before the throw.
        await expect(fs.stat(path.join(home, "clawd", "skills", APP, "SKILL.md"))).rejects.toThrow();
        await expect(fs.stat(locked)).resolves.toBeTruthy();
        // ...so the answer must not say the removal did not happen at all.
        expect(String(body.error)).not.toMatch(/nothing was (uninstalled|removed)/i);
        // And the rest of the uninstall did not run: the desktop entry is what
        // the owner retries and reports from.
        await expect(fs.stat(webappDir())).resolves.toBeTruthy();
        expect(clearSkillEntry).not.toHaveBeenCalled();
        expect(setPreferences).not.toHaveBeenCalled();
        expect(kvDelete).not.toHaveBeenCalled();
      } finally {
        await fs.chmod(locked, 0o700);
      }
    },
  );

  it("removes the skill directory, exactly as before", async () => {
    const { status, body } = await uninstall(APP);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    await expect(fs.stat(clawdSkill())).rejects.toThrow();
    await expect(fs.stat(webappDir())).rejects.toThrow();
    expect(clearSkillEntry).toHaveBeenCalledWith(APP);
  });
});
