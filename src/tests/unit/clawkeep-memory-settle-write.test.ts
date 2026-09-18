import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { settledMemoryRun } from "@/tests/helpers/memory-run-state";

/**
 * The write that records how a pass ENDED is the one the box cannot afford to
 * drop: left undone, the record says "running" beside a pid that has been
 * reaped, and the next read calls a pass that succeeded "interrupted". So a
 * failed write is tried again before the run's lock is let go.
 */

// Starts a real process: vitest's default budgets are not enough on a loaded
// CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { failures } = vi.hoisted(() => ({ failures: { settled: 0 } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFile = (async (...args: Parameters<typeof actual.promises.writeFile>) => {
    const [file, data] = args;
    if (
      failures.settled > 0
      && String(file).includes("memory-index-state.json")
      && typeof data === "string"
      && /"status": "(succeeded|failed)"/.test(data)
    ) {
      failures.settled -= 1;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return actual.promises.writeFile(...args);
  }) as typeof actual.promises.writeFile;
  return { ...actual, default: actual, promises: { ...actual.promises, writeFile } };
});
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => true,
}));

let tmpDir = "";

beforeEach(async () => {
  const { promises: fs } = await vi.importActual<typeof import("node:fs")>("node:fs");
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawkeep-settle-"));
  process.env.CLAWKEEP_DATA_DIR = tmpDir;
  process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "true";
  process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
  vi.resetModules();
});

afterEach(async () => {
  const { promises: fs } = await vi.importActual<typeof import("node:fs")>("node:fs");
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
  delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  failures.settled = 0;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("recording how a pass ended", () => {
  it("tries the settled record again when the first write fails, rather than leaving it 'running'", async () => {
    failures.settled = 2;
    const { startMemoryIndex, readMemoryRunState } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    const run = await settledMemoryRun(tmpDir);
    expect(run.status).toBe("succeeded");
    expect(failures.settled).toBe(0);
    expect((await readMemoryRunState()).status).toBe("succeeded");
  });
});
