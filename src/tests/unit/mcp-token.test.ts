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

    it("picks up a token rotated on disk under a running web server", async () => {
      // gateway-pre-start.sh replaces the token file whenever this uid cannot
      // read it or other local users can, and only the MCP SUBPROCESS gets the
      // new value (the reconcile rewrites openclaw.json). The verifier lives
      // here, caches in module state and prefers CLAWBOX_MCP_TOKEN, which
      // production-server.js pins at Next boot — and nothing orders
      // clawbox-setup.service against clawbox-gateway.service. So a gateway
      // restart mid-uptime (a model/config change, or Restart=always after a
      // crash) left every /setup-api/* call from the agent's device tools
      // 401'ing until clawbox-setup happened to restart. TASK-657.
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      const before = getMcpToken();
      expect(verifyMcpBearer(`Bearer ${before}`)).toBe(true);

      const rotated = "b".repeat(64);
      fs.writeFileSync(path.join(tmpDir, "data", ".mcp-token"), `${rotated}\n`, { mode: 0o600 });

      expect(verifyMcpBearer(`Bearer ${rotated}`)).toBe(true);
      // And the superseded one stops working, rather than both being valid for
      // the life of the process.
      expect(verifyMcpBearer(`Bearer ${before}`)).toBe(false);
    });

    it("does not re-read the file for every rejected bearer", async () => {
      // The re-read above is on the failure path, which is the path an
      // unauthenticated caller controls. Bounded by the file's mtime so a
      // bad-bearer flood cannot turn into one disk read per request.
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      getMcpToken();
      const tokenPath = path.join(tmpDir, "data", ".mcp-token");
      let reads = 0;
      const realRead = fs.readFileSync;
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((f: never, ...rest: never[]) => {
        if (f === tokenPath) reads += 1;
        return (realRead as never as (...a: never[]) => never)(f, ...rest);
      }) as never);
      try {
        for (let i = 0; i < 50; i += 1) {
          expect(verifyMcpBearer(`Bearer ${"c".repeat(64)}`)).toBe(false);
        }
      } finally {
        spy.mockRestore();
      }
      expect(reads).toBeLessThanOrEqual(1);
    });

    it("a bad-bearer flood cannot stop the rotated token from being picked up", async () => {
      // The bound on the re-read has to be a property of the FILE, not a slot
      // on a wall clock. A slot is a shared resource an unauthenticated caller
      // can consume: at more than one bad bearer per interval the flood takes
      // every window, the legitimate rotated bearer keeps landing inside a
      // spent one, and the 401s this re-read exists to end carry on for as long
      // as the flood does — the defect back through its own remedy.
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      const before = getMcpToken();
      expect(verifyMcpBearer(`Bearer ${before}`)).toBe(true);

      const rotated = "d".repeat(64);
      fs.writeFileSync(path.join(tmpDir, "data", ".mcp-token"), `${rotated}\n`, { mode: 0o600 });

      // The flood arrives first and keeps arriving, all within one second.
      for (let i = 0; i < 50; i += 1) {
        expect(verifyMcpBearer(`Bearer ${"e".repeat(64)}`)).toBe(false);
      }
      // The real caller still gets in, on its first attempt, with no wait.
      expect(verifyMcpBearer(`Bearer ${rotated}`)).toBe(true);
      expect(verifyMcpBearer(`Bearer ${before}`)).toBe(false);
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
