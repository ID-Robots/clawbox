import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermes' Mixture of Agents is a VIRTUAL provider: the dashboard reports it as
 * authenticated with one placeholder model regardless of whether it has been
 * set up, because there is no credential to check. It answers nothing until
 * `hermes moa configure` writes its slots into config.yaml, so that block is
 * the only honest "is this usable" signal — and offering it in the chat picker
 * before then offers a provider that cannot reply.
 */
describe("isMoaConfigured", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-moa-"));
    vi.resetModules();
    process.env.HERMES_HOME = home;
  });

  afterEach(async () => {
    delete process.env.HERMES_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  /** Re-import per case: the config path is resolved at module load. */
  async function check(config: string | null): Promise<boolean> {
    if (config !== null) await fs.writeFile(path.join(home, "config.yaml"), config);
    const mod = await import("@/lib/hermes-model-options");
    return mod.isMoaConfigured();
  }

  it("is false when there is no config at all (fresh device)", async () => {
    expect(await check(null)).toBe(false);
  });

  it("is false when config.yaml has no moa block — the shipped default", async () => {
    expect(await check("providers:\n  anthropic:\n    api_key: sk-x\n")).toBe(false);
  });

  it("is false for a bare `moa:` key with nothing under it", async () => {
    expect(await check("moa:\nproviders:\n  anthropic:\n    api_key: sk-x\n")).toBe(false);
  });

  it("is false when the block holds only comments", async () => {
    expect(await check("moa:\n  # aggregator: ...\n  # references: ...\n")).toBe(false);
  });

  it("is true once the block carries real settings", async () => {
    expect(await check("moa:\n  aggregator: anthropic/claude-opus-5\n  references:\n    - openai/gpt-5\n")).toBe(true);
  });

  it("is true when the block sits between other top-level keys", async () => {
    expect(await check([
      "providers:",
      "  anthropic:",
      "    api_key: sk-x",
      "moa:",
      "  aggregator: anthropic/claude-opus-5",
      "logging:",
      "  level: info",
      "",
    ].join("\n"))).toBe(true);
  });

  it("does not mistake an indented `moa:` under another key for the real block", async () => {
    expect(await check("providers:\n  moa:\n    api_key: sk-x\n")).toBe(false);
  });
});
