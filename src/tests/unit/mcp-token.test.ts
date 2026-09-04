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

    it("does not let one transient read error consume the rotation's re-read", async () => {
      // The file's identity is the budget for the re-read, so it must be spent
      // on a read that RETURNED. Stamped on the ATTEMPT, a single transient
      // failure — an EMFILE or ENOMEM on a loaded server, a momentary EACCES
      // inside the rotation window — recorded that identity forever: every later
      // check saw `fileId === lastReadFileId` and returned early, so the rotated
      // was never adopted until the file changed AGAIN. One unlucky syscall
      // re-opened the 401s this re-read exists to end, permanently.
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      getMcpToken();
      const tokenPath = path.join(tmpDir, "data", ".mcp-token");

      const rotated = "f".repeat(64);
      fs.writeFileSync(tokenPath, `${rotated}\n`, { mode: 0o600 });

      // Exactly one read fails, on the first check after the rotation.
      const realRead = fs.readFileSync;
      let thrown = false;
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((f: never, ...rest: never[]) => {
        if (f === tokenPath && !thrown) {
          thrown = true;
          const err = new Error("EMFILE: too many open files") as Error & { code: string };
          err.code = "EMFILE";
          throw err;
        }
        return (realRead as never as (...a: never[]) => never)(f, ...rest);
      }) as never);
      try {
        expect(verifyMcpBearer(`Bearer ${rotated}`)).toBe(false);
        expect(thrown, "the fixture never exercised the failing read").toBe(true);
      } finally {
        spy.mockRestore();
      }

      // The rotation is still picked up on the next call, with no further write
      // to the file — the transient did not spend its budget.
      expect(verifyMcpBearer(`Bearer ${rotated}`)).toBe(true);
    });

    it("adopts a second rotation that reports the same mtime as the first", async () => {
      // The re-read is bounded by the file's identity so a bad-bearer flood
      // costs one `statSync` rather than one read per request. `mtimeMs` alone
      // is not that identity. `scripts/gateway-pre-start.sh` rotates by
      // REPLACING the file (`mv` over it), and `mtimeMs` resolution belongs to
      // the filesystem — so two replacements landing inside one timestamp tick
      // report the same value, the second is never read, and the bearer the MCP
      // subprocess is now sending is rejected until something rotates the file a
      // THIRD time. That is the permanent 401 this whole re-read exists to end,
      // reached through a different door.
      const { getMcpToken, verifyMcpBearer } = await loadModule(tmpDir);
      const tokenPath = path.join(tmpDir, "data", ".mcp-token");
      const before = getMcpToken();
      expect(verifyMcpBearer(`Bearer ${before}`)).toBe(true);

      // One fixed timestamp on every rotation: what a coarse-granularity
      // filesystem reports for replacements inside a single tick.
      const pinned = new Date(1_700_000_000_000);
      const rotate = (value: string) => {
        // Staged and renamed, the way the shipped script does it, so each
        // rotation is a new inode rather than a rewrite in place.
        const staged = path.join(tmpDir, "data", ".mcp-token.new");
        fs.writeFileSync(staged, `${value}\n`, { mode: 0o600 });
        fs.renameSync(staged, tokenPath);
        fs.utimesSync(tokenPath, pinned, pinned);
      };

      const first = "b".repeat(64);
      rotate(first);
      expect(verifyMcpBearer(`Bearer ${first}`)).toBe(true);

      const second = "c".repeat(64);
      rotate(second);
      expect(
        fs.statSync(tokenPath).mtimeMs,
        "both rotations must report one mtime or this test proves nothing",
      ).toBe(pinned.getTime());

      expect(verifyMcpBearer(`Bearer ${second}`)).toBe(true);
      expect(verifyMcpBearer(`Bearer ${first}`)).toBe(false);
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
