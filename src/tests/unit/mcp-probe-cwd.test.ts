import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * TASK-722 — a capability probe must not answer "the binary is missing"
 * because a *working directory* is missing.
 *
 * `mcp/lib/guard.ts` gives every spawn a default cwd of `DEFAULT_CWD`
 * (`CLAWBOX_ROOT` or `/home/clawbox/clawbox`). When that directory is not
 * there, `spawn` fails ENOENT before the program is ever reached, `spawnArgv`
 * settles at exit code 127, and `hasBinary()` returns false for a binary that
 * is installed. `mcp/lib/context.ts` takes those answers once at startup, so
 * the MCP server then drops `disk_usage`, `disk_cleanup`, `logs_tail` and
 * `screen_capture` from its tool list with nothing said — the false-failure
 * class, and the silence that sends an agent to the shell instead.
 *
 * On a box the tree is normally there; this bites while it briefly is not
 * (mid-update, a failed mount, a mis-set CLAWBOX_ROOT), which is exactly when
 * the tools are wanted. Off a box — every CI runner and every dev machine —
 * it is the permanent state, which is why `bun run check:mcp-tools` probed
 * nothing and said so to nobody.
 *
 * Set BEFORE the module under test loads: guard.ts reads CLAWBOX_ROOT once, at
 * import time, into DEFAULT_CWD.
 */
const MISSING_ROOT = path.join(os.tmpdir(), `clawbox-missing-root-${process.pid}`);
const PREVIOUS_ROOT = process.env.CLAWBOX_ROOT;
process.env.CLAWBOX_ROOT = MISSING_ROOT;

const { DEFAULT_CWD, hasBinary, spawnArgv } = await import("../../../mcp/lib/guard");

afterAll(() => {
  if (PREVIOUS_ROOT === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = PREVIOUS_ROOT;
});

describe("capability probes survive a missing ClawBox tree", () => {
  it("has a root that really is absent, so the rest of this file means what it says", () => {
    expect(DEFAULT_CWD).toBe(MISSING_ROOT);
    expect(fs.existsSync(MISSING_ROOT)).toBe(false);
  });

  it("finds a binary that exists while CLAWBOX_ROOT points at a directory that does not", async () => {
    // `sh` is on every POSIX host, including every CI runner and both editions
    // of the device. If this answers false, the probe answered about the
    // working directory rather than about the binary.
    await expect(hasBinary("sh")).resolves.toBe(true);
  });

  it("still answers false for a binary that genuinely is not installed", async () => {
    await expect(hasBinary("clawbox-no-such-binary-722")).resolves.toBe(false);
  });

  it("runs a program on the default cwd path, which is what probeJournal and the du/df tools use", async () => {
    // Same defaulting, one level down: `probeJournal()` and the disk tools
    // pass no cwd at all, so a missing tree turned every one of them into a
    // 127 that reads exactly like an absent binary.
    const r = await spawnArgv("/usr/bin/env", ["true"], { timeoutMs: 3_000 });
    expect(r.exitCode).toBe(0);
  });

  it("runs in the documented fallback, not in some other directory that happens to exist", async () => {
    // Pinned rather than implied: `/` is what the comment in guard.ts promises,
    // and it is what makes the fallback safe for callers that pass absolute
    // paths. A later swap to HOME or os.tmpdir() would still make the tests
    // above pass while quietly changing where `rm -rf --` runs.
    const r = await spawnArgv("/usr/bin/env", ["pwd"], { timeoutMs: 3_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("/");
  });

  it("does NOT silently relocate a working directory the caller asked for", async () => {
    // The fix is about the DEFAULT only. A caller that names a directory means
    // that directory: running somewhere else instead would be the false-success
    // mirror of the bug being fixed here.
    const r = await spawnArgv("/usr/bin/env", ["pwd"], { cwd: MISSING_ROOT, timeoutMs: 3_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("finds the binary when the root EXISTS but cannot be entered", async () => {
    // Root ignores the mode bits, so a root runner cannot make this directory
    // refuse and there is nothing here to prove.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    // The stat answers "yes, a directory" and the chdir then answers EACCES —
    // a root-owned tree part-way through an install is exactly that shape. So
    // predicting the refusal cannot be what selects the fallback; the refusal
    // itself has to be, which is also what covers a tree that vanishes between
    // the two syscalls (the mid-update window this whole fix is about).
    const sealed = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-sealed-root-"));
    fs.chmodSync(sealed, 0o000);
    const saved = process.env.CLAWBOX_ROOT;
    try {
      vi.resetModules();
      process.env.CLAWBOX_ROOT = sealed;
      const guard = await import("../../../mcp/lib/guard");
      expect(guard.DEFAULT_CWD).toBe(sealed);
      expect(fs.statSync(sealed).isDirectory()).toBe(true);
      await expect(guard.hasBinary("sh")).resolves.toBe(true);
    } finally {
      process.env.CLAWBOX_ROOT = saved;
      vi.resetModules();
      fs.chmodSync(sealed, 0o700);
      fs.rmSync(sealed, { recursive: true, force: true });
    }
  });
});
