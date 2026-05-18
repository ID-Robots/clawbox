import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The module reads CLAWBOX_ROOT once at import time to derive the
// token path, so every test that needs a different root has to load
// a fresh copy of the module. `vi.resetModules()` clears Vitest's
// registry so the next dynamic import re-runs the module's top-level
// code with the current env.
async function loadModule(tmpDir: string) {
  process.env.CLAWBOX_ROOT = tmpDir;
  delete process.env.CLAWBOX_MCP_TOKEN;
  vi.resetModules();
  const mod = await import("@/lib/mcp-token");
  mod._resetMcpTokenCacheForTests();
  return mod;
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mcp-token-"));
}

describe("mcp-token", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmp();
  });

  it("getMcpToken mints and persists a token on first read", async () => {
    const { getMcpToken } = await loadModule(tmpDir);
    const tokenPath = path.join(tmpDir, "data", ".mcp-token");
    expect(fs.existsSync(tokenPath)).toBe(false);

    const token = getMcpToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenPath, "utf-8").trim()).toBe(token);
  });

  it("getMcpToken returns the persisted token on subsequent reads", async () => {
    const { getMcpToken, _resetMcpTokenCacheForTests } = await loadModule(tmpDir);
    const first = getMcpToken();
    _resetMcpTokenCacheForTests();
    const second = getMcpToken();
    expect(second).toBe(first);
  });

  it("CLAWBOX_MCP_TOKEN env override wins over the file", async () => {
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "data", ".mcp-token"), "ondisk".repeat(8));

    process.env.CLAWBOX_ROOT = tmpDir;
    process.env.CLAWBOX_MCP_TOKEN = "env-override-token-must-be-long-enough";
    vi.resetModules();
    const mod = await import("@/lib/mcp-token");
    mod._resetMcpTokenCacheForTests();

    expect(mod.getMcpToken()).toBe("env-override-token-must-be-long-enough");
    delete process.env.CLAWBOX_MCP_TOKEN;
  });

  describe("verifyMcpBearer", () => {
    it("accepts a matching Bearer header", async () => {
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      const token = getMcpToken();
      expect(verifyMcpBearer(`Bearer ${token}`)).toBe(true);
    });

    it("accepts the case-insensitive `bearer` prefix", async () => {
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      const token = getMcpToken();
      expect(verifyMcpBearer(`bearer ${token}`)).toBe(true);
    });

    it("rejects null / empty / non-Bearer headers", async () => {
      const { verifyMcpBearer } = await loadModule(tmpDir);
      expect(verifyMcpBearer(null)).toBe(false);
      expect(verifyMcpBearer("")).toBe(false);
      expect(verifyMcpBearer("Basic some-creds")).toBe(false);
      expect(verifyMcpBearer("Bearer")).toBe(false);
      expect(verifyMcpBearer("Bearer ")).toBe(false);
    });

    it("rejects a Bearer token that doesn't match", async () => {
      const { verifyMcpBearer } = await loadModule(tmpDir);
      expect(verifyMcpBearer("Bearer wrong-token-value-here-do-not-match")).toBe(false);
    });

    it("rejects a token that's a prefix of the real one", async () => {
      // Guard against any accidental startsWith comparison — timingSafeEqual
      // requires equal lengths so this should be a fast reject.
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      const token = getMcpToken();
      expect(verifyMcpBearer(`Bearer ${token.slice(0, 16)}`)).toBe(false);
    });
  });
});
