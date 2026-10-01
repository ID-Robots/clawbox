import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The DeepSeek provider plugin is installed PINNED to the running core. The
// day OpenClaw 2026.8.2 shipped, ClawHub's latest @openclaw/deepseek-provider
// declared `pluginApi >=2026.8.2`; the pinned 2026.8.1 runtime refused it and
// every fresh install parked at a gateway that would not report ready. These
// pin the ordering: the core's own build first — from ClawHub, then from npm
// (TASK-1302: ClawHub has no 2026.9.4, npm does) — the unpinned spec only as
// the last fallback, and no throw either way (the route's write path reports a
// missing plugin on its own).

const spawnOpenclawCli = vi.fn<(args: string[], opts?: unknown) => Promise<string>>();

vi.mock("@/lib/openclaw-config", () => ({
  spawnOpenclawCli: (args: string[], opts?: unknown) => spawnOpenclawCli(args, opts),
}));

import {
  DEEPSEEK_PROVIDER_NPM_SPEC,
  DEEPSEEK_PROVIDER_PLUGIN_SPEC,
  deepseekPluginOnDisk,
  deepseekPluginSpecs,
  installDeepseekProviderPlugin,
  installedOpenclawRelease,
} from "@/lib/openclaw-deepseek-plugin";

const installCalls = () =>
  spawnOpenclawCli.mock.calls.filter(([args]) => args[0] === "plugins").map(([args]) => args[2]);
const installArgv = () =>
  spawnOpenclawCli.mock.calls.filter(([args]) => args[0] === "plugins").map(([args]) => args.join(" "));

/** What `spawnOpenclawCli` rejects with when its deadline kills the child. */
function timedOut(): Error {
  const err = new Error("openclaw plugins install timed out after 180000ms");
  err.name = "OpenclawSpawnTimeoutError";
  return err;
}

beforeEach(() => {
  spawnOpenclawCli.mockReset();
});

describe("deepseekPluginSpecs", () => {
  it("tries the core's own build from ClawHub, then from npm, before the unpinned spec", () => {
    expect(deepseekPluginSpecs("2026.9.4")).toEqual([
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.4`,
      `${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.4`,
      DEEPSEEK_PROVIDER_PLUGIN_SPEC,
    ]);
    expect(DEEPSEEK_PROVIDER_NPM_SPEC).toBe("npm:@openclaw/deepseek-provider");
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
    expect(result).toEqual({ installed: `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`, failures: [] });
    expect(installCalls()).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`]);
    expect(spawnOpenclawCli.mock.calls[1][0]).toEqual([
      "plugins",
      "install",
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`,
      "--accept-capabilities",
    ]);
  });

  it("installs the core's build from npm when ClawHub has no such version (TASK-1302)", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (3a9d69d)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4."));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(`${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.4`);
    expect(result.failures).toEqual([
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.4: Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.`,
    ]);
    // `--force` on npm even for a first install: it is the CLI's consent to a
    // non-ClawHub source.
    expect(installArgv()).toEqual([
      `plugins install ${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.4 --accept-capabilities`,
      `plugins install ${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.4 --force --accept-capabilities`,
    ]);
  });

  it("falls back to the unpinned spec only when neither registry carries the core's version", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.1 (abcdef0)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("Version 2026.9.1 not found"));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("npm error code ETARGET"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
    expect(result.failures).toEqual([
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.1: Version 2026.9.1 not found`,
      `${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.1: npm error code ETARGET`,
    ]);
    expect(installCalls()).toEqual([
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.1`,
      `${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.1`,
      DEEPSEEK_PROVIDER_PLUGIN_SPEC,
    ]);
  });

  it("never throws: every failure is reported in order, installed is null", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("offline"));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("still offline"));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("offline to the end"));
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBeNull();
    expect(result.failures).toHaveLength(3);
    expect(result.failures[2]).toBe(`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}: offline to the end`);
  });

  it("skips the unpinned ClawHub spec once ClawHub ran into its deadline, but still asks npm", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (3a9d69d)\n");
    spawnOpenclawCli.mockRejectedValueOnce(timedOut());
    spawnOpenclawCli.mockRejectedValueOnce(new Error("npm error code ENOTFOUND"));
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBeNull();
    expect(installCalls()).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.4`, `${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.4`]);
    expect(result.failures[result.failures.length - 1]).toBe(`${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.4: npm error code ENOTFOUND`);
  });

  it("still asks ClawHub for the unpinned spec when npm is the one that timed out", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (3a9d69d)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("Version not found on ClawHub"));
    spawnOpenclawCli.mockRejectedValueOnce(timedOut());
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
  });

  it("forces every spec for a repair", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.4 (3a9d69d)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("Version not found on ClawHub"));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("npm error code E404"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    await installDeepseekProviderPlugin({ force: true });
    expect(installArgv()).toEqual([
      `plugins install ${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.4 --force --accept-capabilities`,
      `plugins install ${DEEPSEEK_PROVIDER_NPM_SPEC}@2026.9.4 --force --accept-capabilities`,
      `plugins install ${DEEPSEEK_PROVIDER_PLUGIN_SPEC} --force --accept-capabilities`,
    ]);
  });

  it("goes straight to the unpinned spec when the core cannot be asked", async () => {
    spawnOpenclawCli.mockRejectedValueOnce(new Error("ENOENT"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
    expect(installCalls()).toEqual([DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });
});

describe("deepseekPluginOnDisk", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "deepseek-on-disk-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Where the 2026.9.4 CLI put each registry's install, measured against a scratch state directory. */
  function payload(where: "clawhub" | "npm-project" | "npm-flat", version = "2026.9.4", project = "openclaw-deepseek-provider-2481ed984b") {
    const dir = where === "clawhub"
      ? path.join(home, "extensions", "deepseek")
      : where === "npm-flat"
        ? path.join(home, "npm", "node_modules", "@openclaw", "deepseek-provider")
        : path.join(home, "npm", "projects", project, "node_modules", "@openclaw", "deepseek-provider");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@openclaw/deepseek-provider", version }));
  }

  it("is false on a box with no payload, without asking the core", async () => {
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(false);
    expect(spawnOpenclawCli).not.toHaveBeenCalled();
  });

  it("is true for a ClawHub payload, whatever its version, without asking the core", async () => {
    payload("clawhub", "2026.9.3");
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(true);
    expect(spawnOpenclawCli).not.toHaveBeenCalled();
  });

  it("is true for an npm payload of the running core's release", async () => {
    payload("npm-project");
    spawnOpenclawCli.mockResolvedValue("OpenClaw 2026.9.4 (3a9d69d)\n");
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(true);
  });

  it("is true for a flat npm payload and for a republish of the release", async () => {
    payload("npm-flat", "2026.9.4-1");
    spawnOpenclawCli.mockResolvedValue("OpenClaw 2026.9.4 (3a9d69d)\n");
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(true);
  });

  it("is false for an npm payload an older core left behind", async () => {
    payload("npm-project", "2026.9.4");
    spawnOpenclawCli.mockResolvedValue("OpenClaw 2026.9.5 (abcdef0)\n");
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(false);
  });

  it("finds the current build among stale ones, asking the core once", async () => {
    payload("npm-project", "2026.9.3", "openclaw-deepseek-provider-2481ed984b");
    payload("npm-project", "2026.9.4", "openclaw-deepseek-provider-2481ed984b__openclaw-generation__g-04d569a9e83ca680");
    spawnOpenclawCli.mockResolvedValue("OpenClaw 2026.9.4 (3a9d69d)\n");
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(true);
    expect(spawnOpenclawCli).toHaveBeenCalledTimes(1);
  });

  it("takes any npm payload when the core cannot be asked", async () => {
    payload("npm-project", "2026.9.3");
    spawnOpenclawCli.mockRejectedValue(new Error("ENOENT"));
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(true);
  });

  it("is false, not a throw, for a payload whose package.json cannot be read", async () => {
    const dir = path.join(home, "npm", "projects", "p", "node_modules", "@openclaw", "deepseek-provider");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}");
    writeFileSync(path.join(dir, "package.json"), "not json");
    await expect(deepseekPluginOnDisk(home)).resolves.toBe(false);
  });
});
