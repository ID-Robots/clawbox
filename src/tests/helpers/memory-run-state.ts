import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Wait for the memory-index run-state file to settle out of "running".
 *
 * Both suites that drive `startMemoryIndex` need this — the OpenClaw arm's and
 * the local arm's — and both had grown their own copy, down to the same
 * "the run never settled" message. That is exactly how
 * `src/tests/helpers/core-model-manifests.ts` and
 * `src/tests/helpers/gateway-pre-start.ts` came to exist: two copies of one
 * piece of scaffolding drift, and then one suite is testing something the other
 * is not.
 *
 * `startMemoryIndex` resolves as soon as the pass is DISPATCHED, so a test that
 * asserted on the record straight after it would be reading the "running" row.
 * The file is the only thing both arms write, which is why it and not a promise
 * is what gets waited on.
 */
export interface SettledMemoryRun {
  status: string;
  error: string;
  errorCode: string;
  childPid: number;
  mode?: string;
}

/**
 * A run record for a box that has never indexed, to hand `parseMemoryStatus`
 * directly. Here rather than in each suite for the same reason the waiter is:
 * both arms' suites need one, and two copies of a ten-field literal drift.
 */
export const IDLE_MEMORY_RUN = {
  status: "idle" as const,
  mode: "" as const,
  trigger: "" as const,
  startedAtMs: 0,
  finishedAtMs: 0,
  durationMs: 0,
  error: "",
  errorCode: "" as const,
};

export async function settledMemoryRun(
  clawkeepDir: string,
  { tries = 300, everyMs = 20 }: { tries?: number; everyMs?: number } = {},
): Promise<SettledMemoryRun> {
  const file = path.join(clawkeepDir, "memory-index-state.json");
  for (let i = 0; i < tries; i += 1) {
    const now = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as Partial<SettledMemoryRun>;
    if (now.status && now.status !== "running") return now as SettledMemoryRun;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error("the run never settled");
}
