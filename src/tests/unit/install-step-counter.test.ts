import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The installer's progress counter has to agree with the number of steps the
 * edition in front of it actually runs.
 *
 * `TOTAL_STEPS` was a constant sized for the openclaw edition, but the
 * `log "Provisioning Hermes ..."` step is guarded by `has_hermes_harness`, so
 * the hermes and dual editions run one step more than the constant admits and
 * the last line of their install reads `[27/26]` (TASK-695).
 *
 * These tests derive the step count from the shipped install.sh itself — the
 * unconditional `log "` calls plus the edition-gated ones — and then EXECUTE
 * the real counter block (the `TOTAL_STEPS` declaration through the end of
 * `log()`) under `set -euo pipefail` for each edition. A rewrite that keeps
 * the comment and drops the edition awareness fails them; so does bumping the
 * constant to 27, which would leave openclaw counting to `[26/27]`.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/** Everything from the progress counter's declaration to the end of the file. */
const FULL_INSTALL_TAIL = (() => {
  const at = INSTALL_SH.indexOf("\nTOTAL_STEPS=");
  if (at < 0) throw new Error("TOTAL_STEPS declaration not found in install.sh");
  return INSTALL_SH.slice(at + 1);
})();

/**
 * The counter as shipped: the `TOTAL_STEPS` declaration, any edition
 * adjustment, `step=0` and the whole `log()` function.
 */
const COUNTER_BLOCK = (() => {
  const logAt = FULL_INSTALL_TAIL.indexOf("log() {");
  if (logAt < 0) throw new Error("log() not found after TOTAL_STEPS");
  const end = FULL_INSTALL_TAIL.indexOf("\n}", logAt);
  if (end < 0) throw new Error("log() has no closing brace");
  return FULL_INSTALL_TAIL.slice(0, end + 2);
})();

/** The one-line `has_hermes_harness` definition, lifted verbatim. */
const HAS_HERMES_HARNESS = (() => {
  const m = INSTALL_SH.match(/^has_hermes_harness\(\).*$/m);
  if (!m) throw new Error("has_hermes_harness() definition not found in install.sh");
  return m[0];
})();

const TAIL_LINES = FULL_INSTALL_TAIL.split("\n");

/** Indices of every `log "..."` progress call in the full-install sequence. */
const LOG_CALLS = TAIL_LINES.map((line, index) => ({ line, index })).filter(({ line }) =>
  /^[ \t]*log "/.test(line),
);

/**
 * The `if <cond>; then` a nested call sits under. Walks back to the nearest
 * unclosed `if` so the test can state WHICH condition gates a step rather than
 * trusting indentation to mean "hermes".
 */
function enclosingGuard(index: number): string | null {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const line = TAIL_LINES[i].trim();
    if (line === "fi") depth++;
    else if (/^if .*; then$/.test(line)) {
      if (depth === 0) return line;
      depth--;
    }
  }
  return null;
}

const UNCONDITIONAL_STEPS = LOG_CALLS.filter(({ line }) => /^log "/.test(line)).length;
const GATED_STEPS = LOG_CALLS.filter(({ line }) => !/^log "/.test(line));
const HERMES_ONLY_STEPS = GATED_STEPS.filter(
  ({ index }) => enclosingGuard(index) === "if has_hermes_harness; then",
).length;

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-step-counter-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run the shipped counter block for one edition, calling `log` exactly as many
 * times as that edition's install does, and return every `[step/total]` line
 * it printed.
 */
function runCounter(edition: string, calls: number): { status: number | null; steps: string[] } {
  const program = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `CLAWBOX_EDITION="${edition}"`,
    HAS_HERMES_HARNESS,
    COUNTER_BLOCK,
    `for _i in $(seq 1 ${calls}); do log "step $_i"; done`,
    "",
  ].join("\n");
  const file = path.join(root, `counter-${edition}-${calls}.sh`);
  writeFileSync(file, program, { mode: 0o755 });
  const run = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
  const steps = (run.stdout ?? "").split("\n").filter((l) => /^\[\d+\/\d+\]/.test(l));
  return { status: run.status, steps };
}

describe("install.sh progress counter", () => {
  it("the extraction found a real sequence to count", () => {
    // Guards every assertion below: a slice that found no steps, or lost the
    // Hermes one, would make the counter checks pass for the wrong reason.
    expect(UNCONDITIONAL_STEPS).toBeGreaterThan(10);
    expect(HERMES_ONLY_STEPS).toBe(1);
    // Every gated progress step is the Hermes one — if another edition gains a
    // conditional step, this test must be taught about it rather than silently
    // under-counting.
    expect(GATED_STEPS.length).toBe(HERMES_ONLY_STEPS);
  });

  it.runIf(hasBash)("openclaw ends on its last step, not short of the total", () => {
    const { status, steps } = runCounter("openclaw", UNCONDITIONAL_STEPS);
    expect(status).toBe(0);
    expect(steps.at(-1)).toBe(`[${UNCONDITIONAL_STEPS}/${UNCONDITIONAL_STEPS}] step ${UNCONDITIONAL_STEPS}`);
  });

  for (const edition of ["hermes", "dual"]) {
    it.runIf(hasBash)(`${edition} counts its Hermes provisioning step in the total`, () => {
      const total = UNCONDITIONAL_STEPS + HERMES_ONLY_STEPS;
      const { status, steps } = runCounter(edition, total);
      expect(status).toBe(0);
      // Today: "[27/26] step 27" — the counter overruns its own total.
      expect(steps.at(-1)).toBe(`[${total}/${total}] step ${total}`);
    });
  }
});
