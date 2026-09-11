import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FLASH = "deepseek/deepseek-v4-flash";
const PRO = "deepseek/deepseek-v4-pro";
let root: string;
let configPath: string;
let repair: () => Promise<boolean>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-flash-policy-"));
  configPath = path.join(root, "openclaw.json");
  vi.stubEnv("CLAWBOX_OPENCLAW_HOME", root);
  vi.resetModules();
  repair = (await import("@/lib/openclaw-config")).repairClawboxAiFlashModelPolicy;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await fs.rm(root, { recursive: true, force: true });
});

function configWithAllow(allow?: string[]) {
  return {
    gateway: { port: 18789 },
    agents: {
      defaults: {
        model: { primary: PRO },
        modelPolicy: { allow, deny: ["openai/private-model"] },
      },
      list: [{ id: "other", model: { primary: "anthropic/claude-opus-5" } }],
    },
  };
}

// A separate native-style writer holds the canonical sidecar before this
// process asks to repair. Its stdin supplies the edit committed on release.
async function competingWriter() {
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const configPath = process.argv[1];
    const lockPath = configPath + ".lock";
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()}));
    process.stdout.write("locked\\n");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      fs.writeFileSync(configPath, JSON.stringify(JSON.parse(input)));
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    });
  `, configPath], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`competing writer exited ${code}`)));
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("competing writer exited before locking")));
  });
  return { child, exited };
}

describe("Flash model-policy repair under the native cross-process lock", () => {
  it.each([PRO, "clawai/deepseek-v4-pro"])("appends Flash for %s without changing any other config", async (allowedPro) => {
    const config = configWithAllow([allowedPro, "anthropic/*"]);
    await fs.writeFile(configPath, JSON.stringify(config));

    expect(await repair()).toBe(true);

    const expected = structuredClone(config);
    expected.agents.defaults.modelPolicy.allow!.push(FLASH);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(expected);
    expect(existsSync(`${configPath}.lock`)).toBe(false);
    const written = await fs.readFile(configPath, "utf8");
    expect(await repair()).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toBe(written);
  });

  it.each([
    ["absent list", undefined],
    ["empty list", []],
    ["wildcard only", ["deepseek/*"]],
    ["foreign Pro id", ["openrouter/deepseek/deepseek-v4-pro"]],
    ["already allowed Flash", [PRO, FLASH]],
  ])("leaves an %s unchanged", async (_label, allow) => {
    const raw = JSON.stringify(configWithAllow(allow));
    await fs.writeFile(configPath, raw);

    expect(await repair()).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it.each([
    ["adds another allowed model", [PRO, "openrouter/new-model"], true],
    ["removes the explicit Pro permission", ["anthropic/*"], false],
    ["already adds Flash", [PRO, FLASH], false],
  ] as const)("re-reads after another process %s while holding the lock", async (_label, allow, shouldRepair) => {
    const initial = configWithAllow([PRO]);
    await fs.writeFile(configPath, JSON.stringify(initial));
    const writer = await competingWriter();
    const pending = repair();
    const latest = configWithAllow([...allow]);
    latest.gateway.port = 18790;
    let didRepair: boolean;
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(initial);
    } finally {
      writer.child.stdin.end(JSON.stringify(latest));
      await writer.exited;
      didRepair = await pending;
    }

    expect(didRepair).toBe(shouldRepair);
    if (shouldRepair) latest.agents.defaults.modelPolicy.allow!.push(FLASH);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(latest);
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("preserves the original file and releases the lock when the atomic write fails", async () => {
    const raw = JSON.stringify(configWithAllow([PRO]));
    await fs.writeFile(configPath, raw);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("atomic write failed"));

    await expect(repair()).rejects.toThrow("atomic write failed");

    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("does not replace unreadable configuration with a repaired fragment", async () => {
    await fs.writeFile(configPath, "{broken");

    await expect(repair()).rejects.toThrow("not valid JSON");

    expect(await fs.readFile(configPath, "utf8")).toBe("{broken");
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });
});
