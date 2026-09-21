import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const originalClawboxHome = process.env.CLAWBOX_OPENCLAW_HOME;
const originalOpenclawHome = process.env.OPENCLAW_HOME;

afterEach(async () => {
  vi.restoreAllMocks();
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
    // A live PID remains authoritative even when createdAt is older than the
    // stale window; OpenClaw never steals a lock from a proven-live owner.
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" }));

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

  it("reclaims a fresh lock whose PID is definitely dead", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-dead-lock-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const configPath = path.join(root, "openclaw.json");
    const lockPath = `${configPath}.lock`;
    await fs.writeFile(configPath, "{}");
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: new Date().toISOString(),
    }));

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    await setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.agents.defaults.model.primary).toBe("deepseek/deepseek-v4-pro");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it("reclaims an expired ownerless lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-expired-lock-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const configPath = path.join(root, "openclaw.json");
    const lockPath = `${configPath}.lock`;
    await fs.writeFile(configPath, "{}");
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    await setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it("reclaims an old zero-byte lock left before its owner payload was written", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-empty-lock-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const configPath = path.join(root, "openclaw.json");
    const lockPath = `${configPath}.lock`;
    await fs.writeFile(configPath, "{}");
    await fs.writeFile(lockPath, "");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, old, old);

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    await setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");

    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers an abandoned reclaim guard but does not remove a recent one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-reclaim-guard-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const configPath = path.join(root, "openclaw.json");
    const guardPath = `${configPath}.lock.reclaim`;
    await fs.writeFile(configPath, "{}");
    await fs.mkdir(guardPath);
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(guardPath, old, old);

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    await setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");
    expect(existsSync(guardPath)).toBe(false);

    await fs.mkdir(guardPath);
    const pending = setPrimaryModelWithoutCatalogValidation("openai/gpt-5");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(existsSync(guardPath)).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).agents.defaults.model.primary)
      .toBe("deepseek/deepseek-v4-pro");
    await fs.rmdir(guardPath);
    await pending;
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).agents.defaults.model.primary)
      .toBe("openai/gpt-5");
  });

  it("quarantines and retains a replacement guard instead of deleting it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-guard-replacement-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    const configPath = path.join(root, "openclaw.json");
    const guardPath = `${configPath}.lock.reclaim`;
    await fs.writeFile(configPath, "{}");
    await fs.mkdir(guardPath);
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(guardPath, old, old);

    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      // Replace the stale directory after inspectReclaimGuard pins it but
      // before its atomic rename. The moved inode is now a live successor and
      // must survive under the unique quarantine path.
      await fs.rmdir(from);
      await fs.mkdir(from);
      await fs.writeFile(path.join(String(from), "live-owner"), "still active");
      await rename(from, to);
    });

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    const pending = setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro");

    let quarantinePath = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const entry = (await fs.readdir(root)).find((name) => name.startsWith("openclaw.json.lock.reclaim.quarantine-"));
      if (entry && existsSync(guardPath)) {
        quarantinePath = path.join(root, entry);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(renameSpy).toHaveBeenCalled();
    expect(quarantinePath).not.toBe("");
    expect(await fs.readFile(path.join(quarantinePath, "live-owner"), "utf8")).toBe("still active");

    // Release the canonical presence marker so the pending config mutation can
    // proceed. The quarantined replacement remains untouched for its owner.
    await fs.rmdir(guardPath);
    await pending;
    expect(await fs.readFile(path.join(quarantinePath, "live-owner"), "utf8")).toBe("still active");
  });

  it("removes its own lock when fstat fails after exclusive creation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-primary-stat-fail-"));
    roots.push(root);
    process.env.CLAWBOX_OPENCLAW_HOME = root;
    delete process.env.OPENCLAW_HOME;
    vi.resetModules();

    // FileHandle is not exported as a runtime constructor. Probe one handle to
    // reach the shared prototype, then fail only the lock's first fstat call;
    // releaseOwnedLock's path snapshot must still identify our unique token.
    const probePath = path.join(root, "probe");
    const probe = await fs.open(probePath, "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { stat: () => Promise<unknown> };
    await probe.close();
    await fs.unlink(probePath);
    vi.spyOn(fileHandlePrototype, "stat").mockRejectedValueOnce(new Error("simulated fstat failure"));

    const { setPrimaryModelWithoutCatalogValidation } = await import("@/lib/openclaw-config");
    await expect(setPrimaryModelWithoutCatalogValidation("deepseek/deepseek-v4-pro"))
      .rejects.toThrow("simulated fstat failure");

    const lockPath = path.join(root, "openclaw.json.lock");
    expect(existsSync(lockPath)).toBe(false);
  });
});
