import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

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
process.env.CLAWBOX_ROOT = MISSING_ROOT;

const { DEFAULT_CWD, hasBinary, spawnArgv } = await import("../../../mcp/lib/guard");

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

  it("does NOT silently relocate a working directory the caller asked for", async () => {
    // The fix is about the DEFAULT only. A caller that names a directory means
    // that directory: running somewhere else instead would be the false-success
    // mirror of the bug being fixed here.
    const r = await spawnArgv("/usr/bin/env", ["pwd"], { cwd: MISSING_ROOT, timeoutMs: 3_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
