import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { saveEnv } from "@/tests/helpers/env";

// The DeepSeek provider plugin is installed PINNED to the running core. The
// day OpenClaw 2026.8.2 shipped, ClawHub's latest @openclaw/deepseek-provider
// declared `pluginApi >=2026.8.2`; the pinned 2026.8.1 runtime refused it and
// every fresh install parked at a gateway that would not report ready. These
// pin the ordering: the core's own build first, the unpinned spec only as the
// fallback, and no throw either way (the route's write path reports a missing
// plugin on its own).

const spawnOpenclawCli = vi.fn<(args: string[], opts?: unknown) => Promise<string>>();

vi.mock("@/lib/openclaw-config", () => ({
  spawnOpenclawCli: (args: string[], opts?: unknown) => spawnOpenclawCli(args, opts),
}));

import {
  DEEPSEEK_PROVIDER_PLUGIN_SPEC,
  deepseekPluginSpecs,
  installDeepseekProviderPlugin,
  installedOpenclawRelease,
} from "@/lib/openclaw-deepseek-plugin";

const installCalls = () =>
  spawnOpenclawCli.mock.calls.filter(([args]) => args[0] === "plugins").map(([args]) => args[2]);

let root: string;
let restoreEnv: () => void;

beforeEach(() => {
  spawnOpenclawCli.mockReset();
  // The installer reads and writes `data/plugin-install-unavailable.json`:
  // this suite's own box, not the run-wide root.
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = mkdtempSync(path.join(tmpdir(), "deepseek-plugin-"));
  process.env.CLAWBOX_ROOT = root;
});

afterEach(() => {
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

const recordPath = () => path.join(root, "data", "plugin-install-unavailable.json");
const records = () => (existsSync(recordPath()) ? JSON.parse(readFileSync(recordPath(), "utf-8")) : {});

describe("deepseekPluginSpecs", () => {
  it("tries the core's own build before the unpinned spec", () => {
    expect(deepseekPluginSpecs("2026.8.1")).toEqual([
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`,
      DEEPSEEK_PROVIDER_PLUGIN_SPEC,
    ]);
  });

  it("falls back to the unpinned spec alone when the core cannot be asked", () => {
    expect(deepseekPluginSpecs(null)).toEqual([DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });
});

describe("installedOpenclawRelease", () => {
  it("reads the release out of the binary's banner", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    await expect(installedOpenclawRelease()).resolves.toBe("2026.8.1");
    expect(spawnOpenclawCli).toHaveBeenCalledWith(["--version"], expect.objectContaining({ captureStdout: true }));
  });

  it("is null when the binary cannot be asked", async () => {
    spawnOpenclawCli.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(installedOpenclawRelease()).resolves.toBeNull();
  });
});

describe("installDeepseekProviderPlugin", () => {
  it("installs the pinned build and stops there", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result).toEqual({ installed: `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`, failures: [], unavailable: false });
    expect(installCalls()).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`]);
    expect(spawnOpenclawCli.mock.calls[1][0]).toEqual([
      "plugins",
      "install",
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`,
      "--accept-capabilities",
    ]);
  });

  it("falls back to the unpinned spec when no build carries the core's version", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.1 (abcdef0)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("Version 2026.9.1 not found"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
    expect(result.failures).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.1: Version 2026.9.1 not found`]);
    expect(installCalls()).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.1`, DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });

  it("never throws: both failures are reported, installed is null", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("offline"));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("still offline"));
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBeNull();
    expect(result.failures).toHaveLength(2);
  });

  it("goes straight to the unpinned spec when the core cannot be asked", async () => {
    spawnOpenclawCli.mockRejectedValueOnce(new Error("ENOENT"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
    expect(installCalls()).toEqual([DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });
});

// TASK-1206. OpenClaw 2026.9.4, and ClawHub has no 2026.9.4 build of the
// plugin: the pinned spec is "Version not found", the unpinned one resolves
// ClawHub's 2026.9.5, which the runtime refuses. The configure route a person
// is waiting on, and the updater, must not spend a minute asking that again.
describe("installDeepseekProviderPlugin — a core with no build of it (TASK-1206)", () => {
  const PINNED = `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.4`;
  const VERSION_NOT_FOUND = "Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.";
  const API_REFUSAL = 'Plugin "@openclaw/deepseek-provider" requires plugin API >=2026.9.5, but this OpenClaw runtime exposes 2026.9.4.';

  function registrySaysNo() {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (a6fd92f)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error(`Downloading…\n${VERSION_NOT_FOUND}`));
    spawnOpenclawCli.mockRejectedValueOnce(new Error(API_REFUSAL));
  }

  it("records the registry's no for this core, and says so", async () => {
    registrySaysNo();
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBeNull();
    expect(result.unavailable).toBe(true);
    expect(records().deepseek).toMatchObject({
      core: "2026.9.4",
      specs: [PINNED, DEEPSEEK_PROVIDER_PLUGIN_SPEC],
      cause: VERSION_NOT_FOUND,
    });
  });

  it("does not ask the registry again while that answer stands", async () => {
    registrySaysNo();
    await installDeepseekProviderPlugin();
    spawnOpenclawCli.mockReset();
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (a6fd92f)\n");

    const again = await installDeepseekProviderPlugin();
    expect(installCalls()).toEqual([]);
    expect(again).toMatchObject({ installed: null, unavailable: true });
    expect(again.failures[0]).toContain("Version not found on ClawHub");
  });

  it("asks again when the owner's Retry says to, and forgets the answer once it installs", async () => {
    registrySaysNo();
    await installDeepseekProviderPlugin();
    spawnOpenclawCli.mockReset();
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (a6fd92f)\n");
    spawnOpenclawCli.mockResolvedValueOnce("");

    const retry = await installDeepseekProviderPlugin({ force: true, recheckUnavailable: true });
    expect(retry).toEqual({ installed: PINNED, failures: [], unavailable: false });
    expect(records()).toEqual({});
  });

  it("asks again on another core", async () => {
    registrySaysNo();
    await installDeepseekProviderPlugin();
    spawnOpenclawCli.mockReset();
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.5 (0000000)\n");
    spawnOpenclawCli.mockResolvedValueOnce("");
    expect((await installDeepseekProviderPlugin()).installed).toBe(`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.5`);
  });

  it("records nothing when a refusal says nothing about the package", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (a6fd92f)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error(VERSION_NOT_FOUND));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN clawhub.ai"));
    const result = await installDeepseekProviderPlugin();
    expect(result.unavailable).toBe(false);
    expect(records()).toEqual({});
  });

  it("believes a record the boot script wrote", async () => {
    // The pre-start writes this file on the boot path; the configure route and
    // the updater read the same one.
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(recordPath(), JSON.stringify({
      deepseek: { core: "2026.9.4", atMs: Date.now(), specs: [PINNED], cause: `openclaw plugins install exited 1: ${VERSION_NOT_FOUND}` },
    }));
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (a6fd92f)\n");
    const result = await installDeepseekProviderPlugin();
    expect(installCalls()).toEqual([]);
    expect(result.unavailable).toBe(true);
  });
});
