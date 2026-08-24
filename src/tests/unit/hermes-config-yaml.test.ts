import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * b10, live on a QA box on 2026-08-24: ONE "save local model" in the ClawBox UI
 * took ~/.hermes/config.yaml from 3175 bytes with 36 comment lines to 1505 with
 * none, and the following disable took it to 1325. The deleted lines are the
 * only in-product documentation for secret redaction, tirith pre-exec scanning
 * and provider failover, and nothing puts them back.
 *
 * The fixture is that exact file, byte for byte, with the dashboard password
 * hash and session secret swapped for same-length placeholders — so it is still
 * 3175 bytes and still 36 comment lines.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));

const FIXTURE = path.join(__dirname, "../fixtures/hermes-config-3175.yaml");

let home: string;
let configPath: string;
let original: string;

async function loadModule() {
  vi.resetModules();
  return await import("@/lib/hermes-config-yaml");
}

function commentLines(text: string): number {
  return text.split("\n").filter((l) => l.startsWith("#")).length;
}

beforeEach(async () => {
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
  process.env.HERMES_HOME = home;
  configPath = path.join(home, "config.yaml");
  original = await fs.readFile(FIXTURE, "utf-8");
  await fs.writeFile(configPath, original, { mode: 0o600 });
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("patchHermesConfig on the real 3175-byte Hermes config", () => {
  it("is a fixture of the shape the finding reported", () => {
    expect(Buffer.byteLength(original)).toBe(3175);
    expect(commentLines(original)).toBe(36);
  });

  it("registers the local provider without deleting a single comment", async () => {
    const { patchHermesConfig } = await loadModule();

    const result = await patchHermesConfig({
      set: {
        "providers.clawlocal.base_url": "http://127.0.0.1/setup-api/local-ai/ollama/v1",
        "providers.clawlocal.api_key": "local-token-xyz",
        "providers.clawlocal.api_mode": "openai",
        "model.provider": "clawlocal",
        "model.default": "qwen2.5:3b",
      },
    });

    const after = await fs.readFile(configPath, "utf-8");
    expect(result.mode).toBe("merge");
    expect(commentLines(after)).toBe(36);
    // It GREW. The whole symptom was a config that shrank on every save.
    expect(Buffer.byteLength(after)).toBeGreaterThan(3175);
    // Every line of the original is still there, in order.
    const before = original.split("\n");
    const remaining = after.split("\n");
    let cursor = 0;
    for (const line of before) {
      const found = remaining.indexOf(line, cursor);
      expect(found, `lost line: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
    // …including the two documentation blocks by name.
    expect(after).toContain("# ── Security ──");
    expect(after).toContain("# ── Fallback Model ──");
    expect(after).toContain("#   tirith_fail_open: true");
    // …and the data that is not ours: mcp_servers, toolsets, dashboard auth.
    expect(after).toContain("_config_version: 38");
    expect(after).toContain("      CLAWBOX_API_BASE: http://127.0.0.1:80");
    expect(after).toContain("    - yuanbao");

    expect(after).toContain("providers:\n  clawlocal:\n");
    expect(after).toContain("model:\n  provider: clawlocal\n  default: qwen2.5:3b");
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("keeps the previous revision as config.yaml.bak", async () => {
    const { patchHermesConfig } = await loadModule();
    const result = await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    expect(result.backupPath).toBe(`${configPath}.bak`);
    expect(await fs.readFile(`${configPath}.bak`, "utf-8")).toBe(original);
  });

  it("round-trips: enable then disable returns the file to what it was", async () => {
    const { patchHermesConfig } = await loadModule();
    await patchHermesConfig({
      set: {
        "providers.clawlocal.base_url": "http://127.0.0.1/setup-api/local-ai/ollama/v1",
        "providers.clawlocal.api_key": "local-token-xyz",
        "providers.clawlocal.api_mode": "openai",
        "model.provider": "clawlocal",
        "model.default": "qwen2.5:3b",
      },
    });
    await patchHermesConfig({
      unset: [
        "providers.clawlocal.base_url",
        "providers.clawlocal.api_key",
        "providers.clawlocal.api_mode",
        "model.provider",
        "model.default",
      ],
    });

    const after = await fs.readFile(configPath, "utf-8");
    expect(after).toBe(original);
    expect(Buffer.byteLength(after)).toBe(3175);
    expect(commentLines(after)).toBe(36);
  });

  it("preserves the file mode", async () => {
    const { patchHermesConfig } = await loadModule();
    await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("reads a key back without spawning the CLI", async () => {
    const { patchHermesConfig, readHermesConfigValue } = await loadModule();
    await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    expect(await readHermesConfigValue("model.provider")).toBe("clawlocal");
    expect(await readHermesConfigValue("model.default")).toBeNull();
    expect(await readHermesConfigValue("dashboard.basic_auth.username")).toBe("clawbox");
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("creates the file on a device that has none yet", async () => {
    await fs.rm(configPath);
    const { patchHermesConfig } = await loadModule();
    const result = await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    expect(result.mode).toBe("merge");
    expect(result.backupPath).toBeNull();
    expect(await fs.readFile(configPath, "utf-8")).toContain("provider: clawlocal");
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("falls back to the CLI — and leaves the file alone — on a shape it cannot edit", async () => {
    // Flow style on the very key we are asked to patch. Losing the comments is
    // bad; writing a config we half-understand is worse.
    const odd = "model: {provider: openrouter}\n";
    await fs.writeFile(configPath, odd, { mode: 0o600 });
    const { patchHermesConfig } = await loadModule();

    const result = await patchHermesConfig({ set: { "model.provider": "clawlocal" } });

    expect(result.mode).toBe("cli");
    expect(await fs.readFile(configPath, "utf-8")).toBe(odd);
    expect(cliMock.mock.calls[0][0]).toEqual(["config", "set", "model.provider", "clawlocal"]);
  });

  it("surfaces a CLI failure on the fallback path instead of reporting success", async () => {
    await fs.writeFile(configPath, "model: {provider: openrouter}\n", { mode: 0o600 });
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "hermes: nope" });
    const { patchHermesConfig, HermesConfigWriteError } = await loadModule();
    await expect(patchHermesConfig({ set: { "model.provider": "x" } })).rejects.toBeInstanceOf(
      HermesConfigWriteError,
    );
  });

  it("serialises concurrent writes rather than losing one", async () => {
    const { patchHermesConfig } = await loadModule();
    await Promise.all([
      patchHermesConfig({ set: { "providers.clawlocal.base_url": "http://a/v1" } }),
      patchHermesConfig({ set: { "providers.clawlocal.api_key": "k" } }),
      patchHermesConfig({ set: { "providers.clawlocal.api_mode": "openai" } }),
    ]);
    const after = await fs.readFile(configPath, "utf-8");
    expect(after).toContain("base_url: http://a/v1");
    expect(after).toContain("api_key: k");
    expect(after).toContain("api_mode: openai");
    expect(commentLines(after)).toBe(36);
  });
});
