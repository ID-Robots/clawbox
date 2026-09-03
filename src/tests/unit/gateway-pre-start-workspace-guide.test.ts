import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * How the ClawBox guide reaches the OpenClaw workspace.
 *
 * The seeding block writes `config/clawbox-workspace-guide.md` to
 * `<workspace>/CLAWBOX.md` — but only when the file is absent, deliberately, so
 * an owner's or an agent's edits survive a gateway start. The consequence was
 * silent: a section added to the template after a box was set up never reached
 * that box, and every box in the field already has the file. TASK-612's rule
 * (system actions are the owner's; never queue an operator_approval) would have
 * shipped to new boxes only — including not to the box whose agent produced the
 * incident.
 *
 * So an existing file is TOPPED UP with the one missing section, and never
 * overwritten. These run the block out of the shipped `.sh` rather than a copy,
 * so the test fails if the real script drifts.
 */

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const TEMPLATE = path.resolve(process.cwd(), "config/clawbox-workspace-guide.md");
const HEADING = "## System actions and restarts";

/**
 * The seeding block, verbatim, between its two sentinels.
 *
 * Bounded rather than sliced to EOF: the block is last in the file today, and
 * the day anything is appended after it these tests would execute that too, in
 * a stub shell holding only CLAWBOX_ROOT and CLAWBOX_WORKSPACE, and fail under
 * `set -u` for a reason that has nothing to do with the guide.
 */
const BLOCK_END = "# --- end guide seeding ---";
function seedingBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf('CLAWBOX_GUIDE_SRC="$CLAWBOX_ROOT');
  const end = src.indexOf(BLOCK_END, start);
  if (start < 0 || end < 0) throw new Error("guide seeding block not found in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let workspace: string;
let guide: string;

/**
 * Run the shipped block against a temp workspace under the same shell options
 * pre-start itself sets (`set -euo pipefail`, line 19) — the point of several
 * of these tests is what those options do to a failure.
 *
 * `template` overrides the guide the block copies from, for the case where the
 * template no longer carries the section the marker names.
 */
function runRaw(template = TEMPLATE): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(path.join(dir, "root-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config/clawbox-workspace-guide.md"), readFileSync(template, "utf-8"));
  const script = `set -euo pipefail\nCLAWBOX_ROOT=${JSON.stringify(root)}\nCLAWBOX_WORKSPACE=${JSON.stringify(workspace)}\n${seedingBlock()}`;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The same run, asserting the exit code the systemd unit demands. */
function run(template = TEMPLATE): { stdout: string; stderr: string } {
  const res = runRaw(template);
  if (res.status !== 0) {
    throw new Error(`pre-start block exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-guide-"));
  workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  guide = path.join(workspace, "CLAWBOX.md");
});
afterEach(() => {
  // A test that made the workspace unwritable has to hand it back, or the
  // recursive remove below fails and every later test inherits the leftovers.
  try {
    chmodSync(workspace, 0o755);
  } catch {
    /* the test may have removed it */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("gateway-pre-start seeds and tops up CLAWBOX.md", () => {
  it("seeds the whole template when the workspace has no guide", () => {
    const { stdout } = run();

    expect(stdout).toContain("Seeded CLAWBOX.md");
    expect(readFileSync(guide, "utf-8")).toBe(readFileSync(TEMPLATE, "utf-8"));
  });

  // The seed is the FIRST-BOOT and post-factory-reset path, and its write was
  // the one left bare in the block. `config/clawbox-gateway.service:20` is
  // `ExecStartPre=...gateway-pre-start.sh` with no leading `-`, so a non-zero
  // exit here fails the unit; with Restart=always, RestartSec=5 and
  // StartLimitBurst=20 / StartLimitIntervalSec=3600 it burns twenty starts in
  // ~100 s and then sits failed for the rest of the hour. The gateway is down —
  // over an advisory text file.
  it.skipIf(process.getuid?.() === 0)("warns and lets the gateway start when the workspace cannot be seeded", () => {
    // A full rootfs (ENOSPC on a Jetson eMMC), a filesystem remounted read-only
    // after errors, or the documented "delete CLAWBOX.md to re-seed" path on
    // such a box all arrive here: no guide yet, and the write fails.
    chmodSync(workspace, 0o555);

    const res = runRaw();

    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("Seeded CLAWBOX.md");
    expect(res.stderr).toContain("could not seed CLAWBOX.md");
  });

  it("starts no statement in the seeding block with a bare copy, whatever the uid", () => {
    // The case above needs a `skipIf`: root bypasses directory mode bits, and no
    // permission trick is uid-independent here — GNU `install` unlinks and
    // recreates its destination, so a read-only or dangling destination does not
    // fail either. This one is structural, so it still holds in a root container:
    // a write that opens a statement runs with `set -e` armed, and its failure is
    // the whole unit's failure. Inside an `if`, `set -e` is suspended.
    const bareWrites = seedingBlock()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(install|cp|mv|tee)\b/.test(line));

    expect(bareWrites).toEqual([]);
  });

  it("appends the system-actions section to a guide written before it existed", () => {
    // A real pre-TASK-612 guide, personalized: the sections the box was seeded
    // with, plus a note the owner added.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, `${older}\n\n## Owner's notes\n\nThe printer is on the shelf.\n`);

    const { stdout } = run();

    expect(stdout).toContain("Appended the system-actions section");
    const after = readFileSync(guide, "utf-8");
    // The rule arrived...
    expect(after).toContain(HEADING);
    expect(after).toContain("operator_approval");
    expect(after).toMatch(/Settings\s*→\s*System/);
    // ...the personalization survived, and nothing else was rewritten.
    expect(after).toContain("The printer is on the shelf.");
    expect(after.startsWith(older)).toBe(true);
  });

  it("appends once, however many times the gateway starts", () => {
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, older);

    run();
    const afterFirst = readFileSync(guide, "utf-8");
    const second = run();

    expect(second.stdout).not.toContain("Appended the system-actions section");
    expect(readFileSync(guide, "utf-8")).toBe(afterFirst);
    expect(afterFirst.split(HEADING)).toHaveLength(2);
  });

  it("takes only that section, not the ones that follow it in the template", () => {
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, older);

    run();

    const appended = readFileSync(guide, "utf-8").slice(older.length);
    expect(appended).toContain(HEADING);
    // The template's next heading must not have been dragged along.
    expect(appended).not.toContain("## Coding agent");
    expect(appended).not.toContain("## Remember the user's name");
    // Nor the `---` rule that closes the section in the template: the append
    // supplies its own leading separator, so carrying that one too ends the
    // topped-up guide on a dangling horizontal rule.
    expect(appended.trimEnd().endsWith("---")).toBe(false);
  });

  it("warns instead of appending an empty section when the template loses the heading", () => {
    // The marker and the heading are two strings that have to stay in step. If
    // the heading is renamed and the marker is not, the extraction comes back
    // empty — appending the separator alone would report a success that added
    // nothing, and would do it again on every gateway start.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, older);
    const renamed = path.join(dir, "renamed-template.md");
    writeFileSync(renamed, readFileSync(TEMPLATE, "utf-8").replace(HEADING, "## Restarts, renamed"));

    const { stdout, stderr } = run(renamed);

    expect(stdout).not.toContain("Appended the system-actions section");
    expect(stderr).toContain("no longer carries");
    expect(readFileSync(guide, "utf-8")).toBe(older);
  });

  // `skipIf`, not an early return: a root container would otherwise report this
  // as a pass with no assertions, and it is the one test covering "the gateway
  // still starts". Root ignores the mode bits, so there is nothing to prove there.
  it.skipIf(process.getuid?.() === 0)("warns and lets the gateway start when the guide cannot be written", () => {
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, older);
    chmodSync(guide, 0o444);

    // `run` throws on a non-zero exit — reaching the assertions IS the proof
    // that pre-start survived.
    const { stdout, stderr } = run();

    expect(stdout).not.toContain("Appended the system-actions section");
    expect(stderr).toContain("could not append");
    expect(readFileSync(guide, "utf-8")).toBe(older);
  });

  it("keeps the appended section as its own heading when the guide has no trailing newline", () => {
    // A file ending `...text` joined to the separator turns that last line into
    // a setext H2 — the owner's last note silently becomes a heading.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, `${older.trimEnd()}\n\nThe printer is on the shelf.`);

    run();

    const after = readFileSync(guide, "utf-8");
    expect(after).toContain("The printer is on the shelf.\n\n---\n");
    expect(after).not.toContain("The printer is on the shelf.\n---\n");
  });

  it("appends the section at the end, after whatever the owner already had", () => {
    // The placement IS a decision: a top-up appends rather than splicing the
    // section into its template position, so on a personalized guide it lands
    // last. Asserted so a change of mind is a failing test, not a surprise.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, `${older}\n\n## Owner's notes\n\nThe printer is on the shelf.\n`);

    run();

    const after = readFileSync(guide, "utf-8");
    expect(after.indexOf(HEADING)).toBeGreaterThan(after.indexOf("## Owner's notes"));
  });

  it("leaves a guide that already carries the section untouched", () => {
    const current = readFileSync(TEMPLATE, "utf-8");
    writeFileSync(guide, current);

    const { stdout } = run();

    expect(stdout).not.toContain("Appended the system-actions section");
    expect(stdout).not.toContain("Seeded CLAWBOX.md");
    expect(readFileSync(guide, "utf-8")).toBe(current);
  });
});

/**
 * The rule has to reach the model, not just the disk.
 *
 * OpenClaw's workspace file map injects AGENTS.md at the start of every session
 * ("operating instructions ... good place for rules"); CLAWBOX.md is not in that
 * set and is read only if the agent opens it. So the prohibition itself is
 * written into AGENTS.md, under a marker of its own — NOT the "CLAWBOX.md"
 * pointer marker, which is already present on every box in the field and
 * therefore can never deliver anything again.
 */
describe("gateway-pre-start puts the rule where the harness loads it", () => {
  const RULE = "## System actions on this ClawBox";
  let agents: string;

  beforeEach(() => {
    agents = path.join(workspace, "AGENTS.md");
    writeFileSync(guide, readFileSync(TEMPLATE, "utf-8"));
  });

  it("appends the rule to an AGENTS.md that already carries the old pointer", () => {
    // The field-box shape, measured: the pointer sentence is there, so the
    // pointer's own guard is satisfied and only a separate marker can deliver.
    const existing = "# AGENTS\n\nBe helpful.\n\n## ClawBox integration\n\nSee `CLAWBOX.md` for device-specific conventions: where user-installed skills live.\n";
    writeFileSync(agents, existing);

    const { stdout } = run();

    expect(stdout).toContain("Appended the system-actions rule to AGENTS.md");
    const after = readFileSync(agents, "utf-8");
    expect(after.startsWith(existing)).toBe(true);
    expect(after).toContain(RULE);
    expect(after).toContain("operator_approval");
    expect(after).toContain("system_power");
    // The gateway restart and the device restart must not be conflated: one is
    // refused, the other is the agent's own tool.
    expect(after).toMatch(/gateway is not yours|not yours to do/i);
  });

  it("appends the rule once, however many times the gateway starts", () => {
    writeFileSync(agents, "# AGENTS\n");

    run();
    const afterFirst = readFileSync(agents, "utf-8");
    const second = run();

    expect(second.stdout).not.toContain("Appended the system-actions rule");
    expect(readFileSync(agents, "utf-8")).toBe(afterFirst);
    expect(afterFirst.split(RULE)).toHaveLength(2);
  });

  it("writes no AGENTS.md of its own when the workspace has none", () => {
    // Creating one would fight whatever the harness does on a fresh workspace.
    const { stdout } = run();

    expect(stdout).not.toContain("AGENTS.md");
    expect(() => readFileSync(agents, "utf-8")).toThrow();
  });

  it("names system actions in the pointer it appends to a fresh AGENTS.md", () => {
    writeFileSync(agents, "# AGENTS\n");

    run();

    const after = readFileSync(agents, "utf-8");
    // Both halves land: the pointer for the long form, the rule for the model.
    expect(after).toContain("CLAWBOX.md");
    expect(after).toMatch(/system actions are the owner/i);
    expect(after).toContain(RULE);
  });

  it("appends the pointer even when the rule already put the literal CLAWBOX.md in the file", () => {
    // The rule's own body ends "`CLAWBOX.md` has the long form", so a pointer
    // guarded on that bare literal is satisfied by the rule text. Both blocks
    // land today only because the pointer happens to be written first in the
    // script: any reorder, or moving the rule into a helper that runs earlier,
    // silently costs a fresh box its `## ClawBox integration` pointer forever —
    // both markers "satisfied", no warning, suite still green. The guard is on
    // the pointer's own heading instead, which nothing else writes.
    const ruleAlreadyThere = `# AGENTS\n\nBe helpful.\n\n${RULE}\n\nNever queue an \`operator_approval\` proposal. \`CLAWBOX.md\` has the long form.\n`;
    writeFileSync(agents, ruleAlreadyThere);

    const { stdout } = run();

    expect(stdout).toContain("Appended CLAWBOX.md reference to AGENTS.md");
    const after = readFileSync(agents, "utf-8");
    expect(after.startsWith(ruleAlreadyThere)).toBe(true);
    expect(after).toContain("## ClawBox integration");
    // ...and the rule itself is not appended a second time.
    expect(after.split(RULE)).toHaveLength(2);
  });

  it.skipIf(process.getuid?.() === 0)("does not stop the gateway when AGENTS.md cannot be written", () => {
    writeFileSync(agents, "# AGENTS\n");
    chmodSync(agents, 0o444);

    // `run` throws on a non-zero exit, so reaching the assertion is the proof.
    const { stderr } = run();

    expect(stderr).toContain("could not append the system-actions rule");
    expect(readFileSync(agents, "utf-8")).toBe("# AGENTS\n");
  });
});
