import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A fixup that failed inside `step_post_update` has to reach the OWNER.
 *
 * Every one of the nineteen fixups in that step is non-fatal by design —
 * refusing to finish an update because a VNC unit refresh failed would be the
 * worse outcome — and each said so with `|| echo "  Warning: … (non-fatal)"`,
 * which reaches the journal and nothing else. The step still exits 0, so the
 * updater marks "Applying system fixups" completed and the update reports as
 * having worked in full when part of it did not: the false-success shape,
 * spelled nineteen times in one function.
 *
 * What is pinned here: the step still cannot fail (that part was right), the
 * failures are COLLECTED, and they are re-stated on one
 * `CLAWBOX-WARN[post-update-fixups]:` line — the updater reads that marker back
 * out of THIS invocation's journal and puts it on the update's own status.
 */

// Starts a real bash: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const NL = String.fromCharCode(10);
const INSTALL_SH = readFileSync(path.join(process.cwd(), "install.sh"), "utf-8");

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end + 2);
}

let hasBash = true;
try {
  execFileSync("/bin/bash", ["-c", "true"], { stdio: "ignore" });
} catch {
  hasBash = false;
}

/**
 * Run the real `step_post_update` with every step it calls stubbed, and the
 * NAMED ones made to fail. Only the wrapper, the reporter and the step's own
 * body come from install.sh, so this cannot pass against a wrapper that has
 * stopped behaving like the shipped one.
 */
function runPostUpdate(failing: string[]): { out: string; rc: string } {
  const body = extractShellFunction("step_post_update");
  const called = new Set(body.match(/\bstep_[a-z_0-9]+/g) ?? []);
  called.delete("step_post_update");

  const program = [
    // The same options install.sh runs under, so an errexit regression in
    // `optional_step` or in the reporter's position as the step's last
    // statement is caught here rather than on a box.
    "set -euo pipefail",
    ...[...called].map((fn) => (failing.includes(fn) ? `${fn}() { return 1; }` : `${fn}() { :; }`)),
    // The helpers post_update calls that are not step_-prefixed, so the sweep
    // above does not find them.
    ...["pause_engine_unit", "resume_paused_engines"].map((fn) => `${fn}() { :; }`),
    failing.includes("ensure_local_embeddings")
      ? "ensure_local_embeddings() { return 1; }"
      : "ensure_local_embeddings() { :; }",
    'POST_UPDATE_FAILED_STEPS=""',
    extractShellFunction("optional_step"),
    extractShellFunction("report_optional_step_failures"),
    body,
    "step_post_update",
    'echo "POST_RC=$?"',
  ].join(NL);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-post-update-warn-"));
  try {
    const script = path.join(dir, "run.sh");
    fs.writeFileSync(script, program);
    const out = execFileSync("/bin/bash", [script], { encoding: "utf-8", timeout: 20_000 });
    return { out, rc: /POST_RC=(\d+)/.exec(out)?.[1] ?? "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasBash)("step_post_update reports the fixups it skipped", () => {
  it("names every failed fixup on the line the updater reads", () => {
    const { out, rc } = runPostUpdate(["step_edition_lock", "step_firewall"]);

    // Still non-fatal: that half was never the defect.
    expect(rc, `post_update must not fail over a non-fatal fixup:${NL}${out}`).toBe("0");
    const marker = out.split(NL).find((line) => line.includes("CLAWBOX-WARN["));
    expect(marker, `no CLAWBOX-WARN line in:${NL}${out}`).toBeDefined();
    expect(marker).toContain("edition_lock");
    expect(marker).toContain("firewall");
    // ONE line for the run, not one per fixup: the updater turns each into a
    // warning, and nineteen of them would be a wall rather than a report.
    expect(out.split(NL).filter((l) => l.includes("CLAWBOX-WARN[post-update-fixups]"))).toHaveLength(1);
  });

  it("says nothing at all when every fixup worked", () => {
    const { out, rc } = runPostUpdate([]);
    expect(rc).toBe("0");
    expect(out).not.toContain("CLAWBOX-WARN[post-update-fixups]");
  });

  it("reports a non-step helper that failed too", () => {
    // `ensure_local_embeddings` is not `step_`-prefixed and was tolerated by
    // the same idiom; a memory index that silently stopped being provisioned
    // is exactly what an owner needs told.
    const { out } = runPostUpdate(["ensure_local_embeddings"]);
    expect(out).toContain("CLAWBOX-WARN[post-update-fixups]");
    expect(out).toContain("local_embeddings_check");
  });

  it("reports a Hermes repair that did not leave a runnable agent", () => {
    // The REAL function, not a stub: `step_hermes_install` used to end in an
    // unconditional `return 0` with a comment saying post_update would report
    // any non-zero return as a failed step — so the one population this call
    // was added for (a factory reset that left no agent) got "completed" over a
    // repair that had not worked. It returns its outcome now, and the wrapper
    // records it without failing the update.
    const fn = extractShellFunction("step_hermes_install");
    expect(fn).not.toMatch(/step_post_update reports any non-zero return/);
    // The last thing it does is answer whether the agent runs.
    expect(fn).toMatch(/\[ -x "\$shim" \] && \[ -x "\$venv_python" \]/);
    expect(fn).toMatch(/return 1/);
  });

  it("reports the smokes' own findings instead of always answering 0", () => {
    // `step_update_smoke`'s findings — an unreachable gateway, a weak auth
    // token, a Telegram bot that will not answer — were `[WARN]` echoes behind
    // an unconditional `return 0`, so the update said "completed" over every
    // one of them.
    const fn = extractShellFunction("step_update_smoke");
    expect(fn).toContain("SMOKE_FINDINGS=1");
    expect(fn).toMatch(/return "\$SMOKE_FINDINGS"/);
  });

  it("carries the engine-resume warning on the marker the updater reads", () => {
    // install.sh asked for this surface in so many words ("there is no quieter
    // surface for it today. Whoever adds one should start here") for exactly
    // this line: an engine the update stopped and did not bring back.
    const fn = extractShellFunction("resume_paused_engines");
    expect(fn).toContain("CLAWBOX-WARN[engine-not-resumed]");
  });

  it("still prints the per-step warning line, so the journal reads as before", () => {
    const { out } = runPostUpdate(["step_vnc_refresh"]);
    expect(out).toContain("Warning: vnc_refresh step failed (non-fatal)");
  });
});
