/**
 * One browser per box (src/lib/shared-browser.ts): what the gateway is told,
 * which profile survives on a box that had two, and what keeps the one
 * browser running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { DesktopBrowserConfig } from "@/lib/desktop-browser-config";
import {
  KEEPER_INTERVAL_MS,
  SHARED_PROFILE,
  agentProfileMigration,
  applySharedBrowserBlock,
  chromiumMajor,
  ensureSharedBrowserProfile,
  findAgentProfiles,
  keepSharedBrowser,
  startSharedBrowserKeeper,
  type KeeperDeps,
  type ProfileMigrationRecord,
} from "@/lib/shared-browser";

function desktop(over: Partial<DesktopBrowserConfig> = {}): DesktopBrowserConfig {
  return {
    profileDir: "/home/clawbox/.config/clawbox-browser",
    cdpPort: 18800,
    executable: null,
    ownProfile: true,
    agentIsolated: false,
    warnings: [],
    ...over,
  };
}

describe("applySharedBrowserBlock", () => {
  it("points the gateway at the desktop browser and never lets it launch one", () => {
    const config: Record<string, unknown> = { tools: { profile: "full" } };
    expect(applySharedBrowserBlock(config, desktop())).toBe(true);
    expect(config.browser).toEqual({
      defaultProfile: SHARED_PROFILE,
      profiles: { [SHARED_PROFILE]: { cdpUrl: "http://127.0.0.1:18800", attachOnly: true } },
    });
    expect(config.tools).toEqual({ profile: "full" });
  });

  it("is a no-op the second time", () => {
    const config: Record<string, unknown> = {};
    applySharedBrowserBlock(config, desktop());
    const before = JSON.stringify(config);
    expect(applySharedBrowserBlock(config, desktop())).toBe(false);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("follows the owner's configured port", () => {
    const config: Record<string, unknown> = {};
    applySharedBrowserBlock(config, desktop());
    expect(applySharedBrowserBlock(config, desktop({ cdpPort: 9222 }))).toBe(true);
    expect((config.browser as { profiles: Record<string, unknown> }).profiles[SHARED_PROFILE])
      .toEqual({ cdpUrl: "http://127.0.0.1:9222", attachOnly: true });
  });

  it("keeps every other browser setting and profile the owner has", () => {
    const config: Record<string, unknown> = {
      browser: {
        enabled: true,
        ssrfPolicy: { allowPrivateNetwork: false },
        defaultProfile: "openclaw",
        profiles: { work: { cdpUrl: "http://10.0.0.5:9222" } },
      },
    };
    expect(applySharedBrowserBlock(config, desktop())).toBe(true);
    expect(config.browser).toEqual({
      enabled: true,
      ssrfPolicy: { allowPrivateNetwork: false },
      defaultProfile: SHARED_PROFILE,
      profiles: {
        work: { cdpUrl: "http://10.0.0.5:9222" },
        [SHARED_PROFILE]: { cdpUrl: "http://127.0.0.1:18800", attachOnly: true },
      },
    });
  });

  it("leaves a default profile the owner chose themselves", () => {
    const config: Record<string, unknown> = {
      browser: { defaultProfile: "work", profiles: { work: { cdpUrl: "http://10.0.0.5:9222" } } },
    };
    expect(applySharedBrowserBlock(config, desktop())).toBe(true);
    const browser = config.browser as { defaultProfile: string; profiles: Record<string, unknown> };
    expect(browser.defaultProfile).toBe("work");
    expect(browser.profiles[SHARED_PROFILE]).toEqual({ cdpUrl: "http://127.0.0.1:18800", attachOnly: true });
    expect(applySharedBrowserBlock(config, desktop())).toBe(false);
  });

  it("replaces a stale cdpPort on its own profile rather than leaving two endpoints", () => {
    const config: Record<string, unknown> = {
      browser: { defaultProfile: SHARED_PROFILE, profiles: { [SHARED_PROFILE]: { cdpPort: 18800, color: "#ff0000" } } },
    };
    expect(applySharedBrowserBlock(config, desktop())).toBe(true);
    expect((config.browser as { profiles: Record<string, unknown> }).profiles[SHARED_PROFILE])
      .toEqual({ color: "#ff0000", cdpUrl: "http://127.0.0.1:18800", attachOnly: true });
  });

  describe("the escape hatch", () => {
    it("takes out what it wrote, and only that", () => {
      const config: Record<string, unknown> = { browser: { enabled: true, profiles: { work: { cdpUrl: "http://10.0.0.5:9222" } } } };
      applySharedBrowserBlock(config, desktop());
      expect(applySharedBrowserBlock(config, desktop({ agentIsolated: true }))).toBe(true);
      expect(config.browser).toEqual({ enabled: true, profiles: { work: { cdpUrl: "http://10.0.0.5:9222" } } });
    });

    it("removes the whole block when nothing else was in it", () => {
      const config: Record<string, unknown> = { tools: {} };
      applySharedBrowserBlock(config, desktop());
      expect(applySharedBrowserBlock(config, desktop({ agentIsolated: true }))).toBe(true);
      expect(config).toEqual({ tools: {} });
    });

    it("does nothing on a box that was never shared", () => {
      const config: Record<string, unknown> = { browser: { defaultProfile: "work" } };
      expect(applySharedBrowserBlock(config, desktop({ agentIsolated: true }))).toBe(false);
      expect(applySharedBrowserBlock({}, desktop({ agentIsolated: true }))).toBe(false);
    });
  });
});

describe("ensureSharedBrowserProfile", () => {
  const deps = (config: Record<string, unknown>, over: Partial<Parameters<typeof ensureSharedBrowserProfile>[0]> = {}) => {
    const writeConfig = vi.fn(async () => {});
    return {
      writeConfig,
      deps: {
        readConfig: async () => config,
        writeConfig,
        readDesktop: async () => desktop(),
        gatewayAbsent: () => false,
        ...over,
      },
    };
  };

  it("writes the block once and reports the change", async () => {
    const config = { tools: { profile: "full" } };
    const first = deps(config);
    expect(await ensureSharedBrowserProfile(first.deps)).toBe(true);
    expect(first.writeConfig).toHaveBeenCalledTimes(1);
    const second = deps(config);
    expect(await ensureSharedBrowserProfile(second.deps)).toBe(false);
    expect(second.writeConfig).not.toHaveBeenCalled();
  });

  it("does not create a gateway config on a box that has none yet", async () => {
    const { deps: d, writeConfig } = deps({});
    expect(await ensureSharedBrowserProfile(d)).toBe(false);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("does nothing on an edition without the gateway", async () => {
    const { deps: d, writeConfig } = deps({ tools: {} }, { gatewayAbsent: () => true });
    expect(await ensureSharedBrowserProfile(d)).toBe(false);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe("chromiumMajor", () => {
  it("reads the leading number of a version, wherever it sits in the line", () => {
    expect(chromiumMajor("153.0.8010.12")).toBe(153);
    expect(chromiumMajor("Chromium 146.0.7680.80 snap\n")).toBe(146);
    expect(chromiumMajor("Google Chrome for Testing 153.0.8010.12")).toBe(153);
    expect(chromiumMajor("")).toBeNull();
    expect(chromiumMajor("not a version")).toBeNull();
  });
});

describe("the profile migration", () => {
  let home: string;
  let openclawHome: string;
  let profileDir: string;
  let records: ProfileMigrationRecord[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "one-browser-"));
    openclawHome = path.join(home, ".openclaw");
    profileDir = path.join(home, ".config", "clawbox-browser");
    records = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function agentProfile(name = "openclaw", version = "146.0.7680.80"): string {
    const dir = path.join(openclawHome, "browser", name, "user-data");
    fs.mkdirSync(path.join(dir, "Default", "Cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Local State"), "{}");
    fs.writeFileSync(path.join(dir, "Last Version"), version);
    fs.writeFileSync(path.join(dir, "Default", "Cookies"), "agent-cookies");
    fs.writeFileSync(path.join(dir, "Default", "Cache", "blob"), "x".repeat(64));
    fs.symlinkSync("somehost-4242", path.join(dir, "SingletonLock"));
    return dir;
  }
  function ownerProfile(): void {
    fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "Local State"), "{}");
    fs.writeFileSync(path.join(profileDir, "Default", "Cookies"), "owner-cookies");
  }
  function migration(over: Partial<Parameters<typeof agentProfileMigration>[0]> = {}, config: Partial<DesktopBrowserConfig> = {}) {
    return agentProfileMigration({
      readDesktop: async () => desktop({ profileDir, ...config }),
      openclawHome,
      releaseProfile: async () => true,
      desktopBrowserVersion: async () => "Chromium 153.0.8010.12",
      record: async (value) => { records.push(value); },
      ...over,
    });
  }

  it("has nothing to do on a box whose assistant never had a profile", async () => {
    expect(await migration().run()).toBe(false);
    expect(records).toEqual([{ outcome: "none", agentProfiles: [] }]);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it("makes the assistant's profile the desktop profile when the owner never had one", async () => {
    const source = agentProfile();
    expect(await migration().run()).toBe(true);
    expect(records).toEqual([{ outcome: "adopted", agentProfiles: [source] }]);
    // The sign-ins came along …
    expect(fs.readFileSync(path.join(profileDir, "Default", "Cookies"), "utf-8")).toBe("agent-cookies");
    // … the disk cache and the old browser's lock did not …
    expect(fs.existsSync(path.join(profileDir, "Default", "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, "SingletonLock"))).toBe(false);
    // … and the original is exactly where it was, for the escape hatch.
    expect(fs.readFileSync(path.join(source, "Default", "Cookies"), "utf-8")).toBe("agent-cookies");
    expect(fs.existsSync(`${profileDir}.adopting`)).toBe(false);
  });

  it("keeps the owner's profile when both exist, and leaves the assistant's on disk", async () => {
    const source = agentProfile();
    ownerProfile();
    expect(await migration().run()).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "kept-separate", agentProfiles: [source] });
    expect(fs.readFileSync(path.join(profileDir, "Default", "Cookies"), "utf-8")).toBe("owner-cookies");
    expect(fs.readFileSync(path.join(source, "Default", "Cookies"), "utf-8")).toBe("agent-cookies");
  });

  it("does not adopt a profile written by a newer Chromium than the desktop one", async () => {
    const source = agentProfile("openclaw", "160.0.1.2");
    expect(await migration().run()).toBe(true);
    expect(records[0]).toMatchObject({ outcome: "kept-separate", agentProfiles: [source] });
    expect(records[0].reason).toContain("160");
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it("does not adopt when the versions cannot be compared", async () => {
    agentProfile();
    expect(await migration({ desktopBrowserVersion: async () => null }).run()).toBe(true);
    expect(records[0].outcome).toBe("kept-separate");
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it("never copies into a profile the owner configured themselves", async () => {
    agentProfile();
    expect(await migration({}, { ownProfile: false }).run()).toBe(true);
    expect(records[0].outcome).toBe("kept-separate");
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it("asks again at the next boot while the assistant's browser will not let go of its profile", async () => {
    agentProfile();
    await expect(migration({ releaseProfile: async () => false }).run()).rejects.toThrow(/still running/);
    expect(records).toEqual([]);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it("replaces an empty directory left by a browser that never started", async () => {
    agentProfile();
    fs.mkdirSync(profileDir, { recursive: true });
    expect(await migration().run()).toBe(true);
    expect(records[0].outcome).toBe("adopted");
    expect(fs.readFileSync(path.join(profileDir, "Default", "Cookies"), "utf-8")).toBe("agent-cookies");
  });

  it("adopts the profile the assistant used last when it had several", async () => {
    const older = agentProfile("openclaw");
    const newer = agentProfile("work");
    fs.writeFileSync(path.join(newer, "Default", "Cookies"), "newer-cookies");
    const past = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(older, "Local State"), past, past);
    expect(await findAgentProfiles(openclawHome)).toEqual([newer, older]);
    await migration().run();
    expect(fs.readFileSync(path.join(profileDir, "Default", "Cookies"), "utf-8")).toBe("newer-cookies");
  });

  it("stands down where the owner chose the isolated assistant browser", async () => {
    agentProfile();
    expect(await migration({}, { agentIsolated: true }).run()).toBe(false);
    expect(records).toEqual([]);
    expect(fs.existsSync(profileDir)).toBe(false);
  });
});

describe("the keeper", () => {
  function keeperDeps(over: Partial<KeeperDeps> = {}) {
    const deps: { [K in keyof KeeperDeps]: ReturnType<typeof vi.fn> } = {
      readDesktop: vi.fn(async () => desktop()),
      findBrowserPids: vi.fn(async () => [] as number[]),
      findPortHolders: vi.fn(async () => ({ assistant: [] as number[], other: [] as number[] })),
      closeAssistantBrowser: vi.fn(async () => 0),
      startBrowser: vi.fn(async () => {}),
    };
    Object.assign(deps, over);
    return deps as unknown as KeeperDeps & typeof deps;
  }

  it("starts the browser when it is not running", async () => {
    const deps = keeperDeps();
    expect(await keepSharedBrowser(deps)).toBe("started");
    expect(deps.startBrowser).toHaveBeenCalledTimes(1);
    expect(deps.closeAssistantBrowser).not.toHaveBeenCalled();
  });

  it("leaves a running browser alone", async () => {
    const deps = keeperDeps({ findBrowserPids: vi.fn(async () => [4242]) });
    expect(await keepSharedBrowser(deps)).toBe("running");
    expect(deps.startBrowser).not.toHaveBeenCalled();
    expect(deps.findPortHolders).not.toHaveBeenCalled();
  });

  it("clears the assistant's hidden browser off the port first — the second browser this removes", async () => {
    const order: string[] = [];
    const deps = keeperDeps({
      findPortHolders: vi.fn(async () => ({ assistant: [6060], other: [] })),
      closeAssistantBrowser: vi.fn(async () => { order.push("close"); return 1; }),
      startBrowser: vi.fn(async () => { order.push("start"); }),
    });
    expect(await keepSharedBrowser(deps)).toBe("started");
    expect(order).toEqual(["close", "start"]);
  });

  it("never closes a person's browser to make room", async () => {
    const deps = keeperDeps({ findPortHolders: vi.fn(async () => ({ assistant: [], other: [5150] })) });
    expect(await keepSharedBrowser(deps)).toBe("port-taken");
    expect(deps.closeAssistantBrowser).not.toHaveBeenCalled();
    expect(deps.startBrowser).not.toHaveBeenCalled();
  });

  it("keeps nothing where the owner chose the isolated assistant browser", async () => {
    const deps = keeperDeps({ readDesktop: vi.fn(async () => desktop({ agentIsolated: true })) });
    expect(await keepSharedBrowser(deps)).toBe("isolated");
    expect(deps.findBrowserPids).not.toHaveBeenCalled();
    expect(deps.startBrowser).not.toHaveBeenCalled();
  });

  it("reports a start that failed instead of throwing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = keeperDeps({ startBrowser: vi.fn(async () => { throw new Error("no display"); }) });
    expect(await keepSharedBrowser(deps)).toBe("failed");
    quiet.mockRestore();
  });

  describe("on its timer", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("brings back a browser the owner closed, at the next look", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      let running = true;
      const deps = keeperDeps({
        findBrowserPids: vi.fn(async () => (running ? [4242] : [])),
        startBrowser: vi.fn(async () => { running = true; }),
      });
      const stop = startSharedBrowserKeeper(deps, { firstDelayMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(deps.startBrowser).not.toHaveBeenCalled();
      running = false;
      await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
      expect(deps.startBrowser).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
      expect(deps.startBrowser).toHaveBeenCalledTimes(1);
      stop();
      vi.restoreAllMocks();
    });

    it("backs off from a browser that will not start", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = keeperDeps({ startBrowser: vi.fn(async () => { throw new Error("no Chromium"); }) });
      const stop = startSharedBrowserKeeper(deps, { firstDelayMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(deps.startBrowser).toHaveBeenCalledTimes(1);
      // Doubled: nothing at the normal interval, one at twice it.
      await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
      expect(deps.startBrowser).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
      expect(deps.startBrowser).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS * 20);
      expect(deps.startBrowser).toHaveBeenCalledTimes(2);
      vi.restoreAllMocks();
    });
  });
});
