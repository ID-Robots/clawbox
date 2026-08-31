import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const originalClawboxHome = process.env.CLAWBOX_OPENCLAW_HOME;
const originalOpenclawHome = process.env.OPENCLAW_HOME;

afterEach(async () => {
  vi.resetModules();
  if (originalClawboxHome === undefined) delete process.env.CLAWBOX_OPENCLAW_HOME;
  else process.env.CLAWBOX_OPENCLAW_HOME = originalClawboxHome;
  if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = originalOpenclawHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("serialized unvalidated primary-model fallback", () => {
  it("creates a missing OpenClaw home before acquiring the sidecar lock", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-fresh-"));
    roots.push(parent);
    const root = path.join(parent, "nested", ".openclaw");
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    await setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");

    const configPath = path.join(root, "openclaw.json");
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.agents.defaults.model.primary).toBe("deepseek/deepseek-v4-pro");
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("waits for OpenClaw's sidecar lock and preserves a concurrent config update", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-lock-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const configPath = path.join(root, "openclaw.json");
    const lockPath = `${configPath}.lock`;
    await fs.writeFile(configPath, JSON.stringify({ gateway: { port: 18789 } }));
    // Simulate an OpenClaw CLI/gateway mutation holding its canonical sidecar.
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    const pending = setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");

    try {
      // Give the fallback enough time to observe EEXIST. It must not read and
      // stage the old complete file while the other mutation still owns it.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(JSON.parse(await fs.readFile(configPath, "utf8")))
        .toEqual({ gateway: { port: 18789 } });

      await fs.writeFile(configPath, JSON.stringify({
        gateway: { port: 18789 },
        models: { providers: { anthropic: { api: "anthropic-messages" } } },
      }));
      await fs.unlink(lockPath);
      await pending;
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.gateway).toEqual({ port: 18789 });
    expect(written.models.providers.anthropic).toEqual({ api: "anthropic-messages" });
    expect(written.agents.defaults.model.primary).toBe("deepseek/deepseek-v4-pro");
    expect(existsSync(lockPath)).toBe(false);
  });
});
