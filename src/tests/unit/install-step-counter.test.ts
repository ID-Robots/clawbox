import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * An installer's progress counter has to agree with the number of steps the
 * edition in front of it actually runs.
 *
 * `install.sh`'s `TOTAL_STEPS` was a constant sized for the openclaw edition,
 * but the `log "Provisioning Hermes ..."` step is guarded by
 * `has_hermes_harness`, so the hermes and dual editions run one step more than
 * the constant admits and the last line of their install read `[27/26]`
 * (TASK-695).
 *
 * These tests derive each installer's step count from the shipped file itself —
 * the unconditional `log "` calls plus the edition-gated ones — and then
 * EXECUTE the real counter block (the `TOTAL_STEPS` declaration through the end
 * of `log()`) under `set -euo pipefail` for each edition. A rewrite that keeps
 * the comment and drops the edition awareness fails them; so does bumping the
 * constant to 27, which would leave openclaw counting to `[26/27]`.
 *
 * `install-x64.sh` has no edition gating and is correct as it stands; it is
 * covered here so the same drift — a step added without touching the constant —
 * cannot appear there unnoticed.
 */

const REPO = process.cwd();

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-step-counter-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Installer {
  /** The file name, which is also the test's name for it. */
  file: string;
  /** Editions to run the counter for, and the gate that decides the total. */
  editions: string[];
  /** The one-line predicate definition an edition-aware total calls, if any. */
  gate: string | null;
}

function analyse({ file, gate }: Installer) {
  const source = readFileSync(path.join(REPO, file), "utf-8");

  /** Everything from the progress counter's declaration to the end of the file. */
  const at = source.indexOf("\nTOTAL_STEPS=");
  if (at < 0) throw new Error(`TOTAL_STEPS declaration not found in ${file}`);
  const tail = source.slice(at + 1);

  /**
   * The counter as shipped: the `TOTAL_STEPS` declaration, any edition
   * adjustment, `step=0` and the whole `log()` function.
   */
  const logAt = tail.indexOf("log() {");
  if (logAt < 0) throw new Error(`log() not found after TOTAL_STEPS in ${file}`);
  const blockEnd = tail.indexOf("\n}", logAt);
  if (blockEnd < 0) throw new Error(`log() has no closing brace in ${file}`);
  const counterBlock = tail.slice(0, blockEnd + 2);

  const gateDefinition = (() => {
    if (gate === null) return "";
    const m = source.match(new RegExp(`^${gate}\\(\\).*$`, "m"));
    if (!m) throw new Error(`${gate}() definition not found in ${file}`);
    return m[0];
  })();

  const lines = tail.split("\n");
  const isLogCall = (line: string) => /^[ \t]*log "/.test(line);
  const logCalls = lines.map((line, index) => ({ line, index })).filter(({ line }) => isLogCall(line));

  /**
   * The `if <cond>; then` a nested call sits under. Walks back to the nearest
   * unclosed `if` so the test can state WHICH condition gates a step rather
   * than trusting indentation to mean "hermes".
   */
  function enclosingGuard(index: number): string | null {
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "fi") depth++;
      else if (/^if .*; then$/.test(line)) {
        if (depth === 0) return line;
        depth--;
      }
    }
    return null;
  }

  const unconditional = logCalls.filter(({ line }) => /^log "/.test(line)).length;
  const gated = logCalls.filter(({ line }) => !/^log "/.test(line));
  const gatedByEdition = gate === null ? 0 : gated.filter(({ index }) => enclosingGuard(index) === `if ${gate}; then`).length;

  return {
    source,
    counterBlock,
    gateDefinition,
    unconditional,
    gated: gated.length,
    gatedByEdition,
    /** Every `log "` in the WHOLE file, not just the counted tail. */
    logCallsInFile: source.split("\n").filter(isLogCall).length,
  };
}

/**
 * Run one installer's counter block for one edition, calling `log` exactly as
 * many times as that edition's install does, and return every `[step/total]`
 * line it printed.
 */
function runCounter(
  installer: Installer,
  edition: string,
  calls: number,
): { status: number | null; steps: string[] } {
  const { counterBlock, gateDefinition } = analyse(installer);
  const program = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `CLAWBOX_EDITION="${edition}"`,
    gateDefinition,
    counterBlock,
    `for _i in $(seq 1 ${calls}); do log "step $_i"; done`,
    "",
  ].join("\n");
  const file = path.join(root, `counter-${installer.file}-${edition}-${calls}.sh`);
  writeFileSync(file, program, { mode: 0o755 });
  const run = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
  const steps = (run.stdout ?? "").split("\n").filter((l) => /^\[\d+\/\d+\]/.test(l));
  return { status: run.status, steps };
}

const INSTALLERS: Installer[] = [
  { file: "install.sh", editions: ["openclaw", "hermes", "dual"], gate: "has_hermes_harness" },
  // No edition handling at all: one total for the one SKU it serves.
  { file: "install-x64.sh", editions: ["openclaw"], gate: null },
];

describe.each(INSTALLERS)("$file progress counter", (installer) => {
  it("the extraction found a real sequence to count", () => {
    // Guards every assertion below: a slice that found no steps, or lost the
    // gated one, would make the counter checks pass for the wrong reason.
    const { unconditional, gated, gatedByEdition } = analyse(installer);
    expect(unconditional).toBeGreaterThan(10);
    expect(gated).toBe(installer.gate === null ? 0 : 1);
    // Every gated progress step is accounted for by the edition gate — a new
    // conditional step under some other predicate must teach this test about
    // itself rather than silently under-count.
    expect(gatedByEdition).toBe(gated);
  });

  it("every log call is in the counted tail — log() is defined just above it", () => {
    // The tail slice starts at the TOTAL_STEPS line, so a `log "…"` added
    // inside a step_* function further up would increment `step` at runtime
    // and stay invisible here. It would also be a `log: command not found`
    // under `install.sh --step <name>`, which dispatches before log() exists.
    const { unconditional, gated, logCallsInFile } = analyse(installer);
    expect(logCallsInFile).toBe(unconditional + gated);
  });

  it.runIf(hasBash)("the base edition ends on its last step, not short of the total", () => {
    const { unconditional } = analyse(installer);
    const { status, steps } = runCounter(installer, "openclaw", unconditional);
    expect(status).toBe(0);
    expect(steps.at(-1)).toBe(`[${unconditional}/${unconditional}] step ${unconditional}`);
  });

  for (const edition of installer.editions.filter((e) => e !== "openclaw")) {
    it.runIf(hasBash)(`${edition} counts its gated step in the total`, () => {
      const { unconditional, gatedByEdition } = analyse(installer);
      const total = unconditional + gatedByEdition;
      const { status, steps } = runCounter(installer, edition, total);
      expect(status).toBe(0);
      // Before TASK-695: "[27/26] step 27" — the counter overran its own total.
      expect(steps.at(-1)).toBe(`[${total}/${total}] step ${total}`);
    });
  }
});
