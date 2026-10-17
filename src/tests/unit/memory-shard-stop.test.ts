import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settledMemoryRun } from "@/tests/helpers/memory-run-state";

/**
 * Stopping a running index pass (`stopMemoryIndex`, behind DELETE on the index
 * route and `memory_shard_reindex_stop`). Driven through the real start path
 * on the OpenClaw arm, with a fake CLI that indexes forever until it is
 * signalled — so what is asserted is the real supervision: the pass ends, its
 * own `finish` settles the record and frees the lock, and the record says it
 * was stopped rather than that something went wrong.
 */

// Starts a real process: vitest's 5 s default is not enough on a loaded CI
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { shard } = vi.hoisted(() => ({ shard: { enabled: true } }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => shard.enabled,
}));

let tmpDir = "";

beforeEach(async () => {
  shard.enabled = true;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-shard-stop-"));
  process.env.CLAWKEEP_DATA_DIR = tmpDir;
  process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
  // No pty wrapper: the fake CLI is signalled directly.
  process.env.CLAWKEEP_MEMORY_PTY_HOST = path.join(tmpDir, "no-such-script");
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  delete process.env.CLAWKEEP_MEMORY_PTY_HOST;
  delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("stopping an index pass", () => {
  it("says there is nothing to stop when no pass runs", async () => {
    const { stopMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await stopMemoryIndex()).stopped).toBe(false);
  });

  it("ends the running pass, settles it as stopped and frees the lock for the next one", async () => {
    const script = path.join(tmpDir, "fake-index");
    const started = path.join(tmpDir, "started");
    await fs.writeFile(script, [
      "#!/bin/sh",
      "trap 'exit 143' TERM",
      `touch '${started}'`,
      "while :; do sleep 0.1; done",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    vi.resetModules();
    const { startMemoryIndex, stopMemoryIndex } = await import("@/lib/clawkeep-memory");

    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    for (let i = 0; i < 200; i += 1) {
      if (await fs.stat(started).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const stop = await stopMemoryIndex();
    expect(stop.stopped).toBe(true);
    expect(stop.run.status).toBe("running");

    const run = await settledMemoryRun(tmpDir);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("interrupted");
    expect(run.error).toMatch(/stopped before it finished/);
    expect(run.error).toMatch(/incremental pass carries on/);

    // The lock went with it: a stop that left it behind would refuse the next pass.
    expect(await fs.stat(path.join(tmpDir, "memory-index.lock")).then(() => true, () => false)).toBe(false);
    expect((await stopMemoryIndex()).stopped).toBe(false);
  });
});
