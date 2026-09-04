import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Pad `body` so it ends `slack` bytes below a 1024-byte boundary.
 *
 * The cap `runCapped` sets can only land on a block boundary, so without this
 * the room left for the append is whatever the template's length happens to
 * leave — measured at 1242 bytes for today's guide, which is most of the way to
 * the 1761-byte section. The case would still fail loudly the day the section
 * is trimmed, but with a message about the wrong thing.
 */
function padToJustUnderABlock(body: string, slack = 64): string {
  const filler = "Owner note: the printer is on the shelf.\n";
  let out = body;
  while ((Buffer.byteLength(out) + slack) % 1024 !== 0) {
    const gap = (1024 - ((Buffer.byteLength(out) + slack) % 1024) + 1024) % 1024;
    out += gap >= filler.length ? filler : "x".repeat(gap);
  }
  return out;
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

/**
 * The same run under a file-size limit, so an append stops PART WAY through.
 *
 * A full Jetson eMMC is the realistic shape and ENOSPC cannot be produced in a
 * unit test; `ulimit -f` produces the same partial write with the same
 * non-zero return. `trap "" XFSZ` is what makes it a return value rather than a
 * signal — without it the kernel kills the shell and nothing in the block ever
 * gets to see the failure it is supposed to handle.
 *
 * `bytes` is rounded up to the 1024-byte blocks bash's `ulimit -f` counts in
 * (bash scales -f by 1024, not by the POSIX 512 — getting that wrong makes the
 * cap twice as generous as intended and the append simply succeeds). Because
 * the cap can only move in whole blocks, callers pad their fixture so the
 * headroom is a fixed small number rather than "up to 1023 bytes, depending on
 * how long the shipped template happens to be" — see `padToJustUnderABlock`.
 */
function runCapped(bytes: number, template = TEMPLATE): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(path.join(dir, "root-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config/clawbox-workspace-guide.md"), readFileSync(template, "utf-8"));
  const blocks = Math.max(1, Math.ceil(bytes / 1024));
  const script = [
    "set -euo pipefail",
    'trap "" XFSZ',
    `ulimit -f ${blocks}`,
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `CLAWBOX_WORKSPACE=${JSON.stringify(workspace)}`,
    seedingBlock(),
  ].join("\n");
  const res = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
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

  it("leaves no write in the seeding block unguarded, whatever the uid", () => {
    // The case above needs a `skipIf`: root bypasses directory mode bits, and no
    // permission trick is uid-independent here — GNU `install` unlinks and
    // recreates its destination, so a read-only or dangling destination does not
    // fail either. This one is structural, so it still holds in a root container,
    // where both `skipIf` cases skip and nothing else covers the appends.
    //
    // A write that OPENS a statement runs with `set -e` armed, and its failure is
    // the whole unit's failure. The sanctioned form puts the write in a
    // condition instead — `if install …; then`, or `if clawbox_append_or_rollback
    // …; then` — where `set -e` is suspended and an else branch can warn.
    // `… || true` is deliberately NOT sanctioned here: it keeps the boot alive
    // but lets the success line print over a write that failed, which is the
    // false-success class this block exists to avoid. (`rm -f … || true` on a
    // recovery path is the one exception, and it is matched below as a write so
    // it stays visible; it undoes rather than produces.)
    const lines = seedingBlock()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    // Every line that writes: a copy verb, an append redirection, or a call to
    // the one helper that owns the appends (its own definition line is not a
    // write, so the call form — a quoted destination — is what is matched).
    const writes = lines.filter((line) =>
      /^(if |elif )?(install|cp|mv|tee|truncate|rm)\b/.test(line)
      // The rollback is two commands on two lines — `if ! truncate …` and the
      // continued `&& ! dd of=…` — and without this the six-line minimum would
      // still be met with BOTH of them deleted.
      || /^(if\s+)?!\s*truncate\b/.test(line)
      || /^&&\s*!\s*dd\b/.test(line)
      || />>/.test(line)
      // The helper's CALL, not its definition line. Matched on the name alone
      // so an unquoted first argument cannot slip past the filter — which is
      // exactly the shape this test exists to catch.
      || (/^(if |elif )?clawbox_append_or_rollback\b/.test(line) && !/\(\)\s*\{/.test(line)));
    // Guarded means the write sits in a condition — the line opens with
    // `if`/`elif`, or it closes a brace group the condition consumes
    // (`…; } >> file; then`). Anything else runs with `set -e` armed.
    const unguarded = writes.filter((line) =>
      !/^(if|elif)\b/.test(line)
      && !/;\s*then$/.test(line)
      // A rollback that cannot roll back must not take the boot down either —
      // but the exception is `rm`'s alone. `printf … >> "$f" || true` would
      // otherwise pass this audit while printing a success line over a failed
      // write, which is the class the audit exists to catch.
      && !/^rm\b.*\|\|\s*true$/.test(line));

    // Sanity: the filter has to be finding this block's write sites — the seed,
    // the three appends, the helper's own redirection and its two rollback
    // verbs — or an empty `unguarded` would prove nothing.
    expect(writes.length).toBeGreaterThanOrEqual(6);
    // Both rollback verbs, by name: a six-line count can be met without them.
    expect(writes.join("\n")).toMatch(/truncate -s/);
    expect(writes.join("\n")).toMatch(/dd of=/);
    expect(unguarded).toEqual([]);
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
    // ...and nothing about a rollback. A write that failed at OPEN wrote
    // nothing, so warning that the file "may be cut mid-section" sends an
    // operator triaging a real disk fault to inspect a guide that is fine —
    // every boot, in the journal they are actually reading.
    expect(stderr).not.toContain("could not roll");
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

  // Every append in this block writes its HEADING first, and the heading is
  // also the `grep -qF` idempotence marker. A write that stops part way — a
  // full eMMC on a Jetson is the realistic shape — therefore leaves the marker
  // sitting on a fragment: every later gateway start finds the heading,
  // appends nothing, and the guide stays cut mid-sentence forever. The one
  // warning went to the journal at boot and is never seen again. What is lost
  // is exactly TASK-612's deliverable, the "never queue an operator_approval"
  // paragraph, which is the last thing the section says.
  // The seed is the same defect one branch up, and worse: the fragment it leaves
  // already contains the top-up marker, so the `grep -qF` guard finds the
  // heading on every later boot, appends nothing, and the box keeps a guide cut
  // mid-sentence for good. First boot and post-factory-reset is exactly where a
  // full eMMC bites.
  it("leaves no fragment when the first seed stops part way", () => {
    const res = runCapped(4096);

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("could not seed CLAWBOX.md");
    expect(existsSync(guide)).toBe(false);
  });

  it("seeds the whole template on the next boot after a part-way seed", () => {
    runCapped(4096);
    const { stdout } = run();

    expect(stdout).toContain("Seeded CLAWBOX.md");
    expect(readFileSync(guide, "utf-8")).toBe(readFileSync(TEMPLATE, "utf-8"));
  });

  it("leaves nothing behind when the append stops part way", () => {
    const older = padToJustUnderABlock(readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0]);
    writeFileSync(guide, older);

    // Exactly 64 bytes of room for a section that is well over a kilobyte.
    const res = runCapped(Buffer.byteLength(older) + 64);

    // Boot safety first: pre-start must still exit 0 (config/clawbox-gateway.service
    // runs it as ExecStartPre with no leading `-`).
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("could not append");
    expect(res.stdout).not.toContain("Appended the system-actions section");
    // ...and the file is back to what it was, marker and fragment both gone.
    expect(readFileSync(guide, "utf-8")).toBe(older);
  });

  it("appends the whole section on the next boot after a part-way write", () => {
    const older = padToJustUnderABlock(readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0]);
    writeFileSync(guide, older);

    runCapped(Buffer.byteLength(older) + 64);
    const second = run();

    expect(second.stdout).toContain("Appended the system-actions section");
    const after = readFileSync(guide, "utf-8");
    expect(after.startsWith(older)).toBe(true);
    // The paragraph that used to be the casualty.
    expect(after).toContain("operator_approval");
    // And exactly one copy of the heading, not a fragment plus a full one.
    expect(after.split(HEADING)).toHaveLength(2);
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

    // THIS text is the copy that reaches the model — AGENTS.md is what the
    // harness injects; CLAWBOX.md is read only if the agent opens it. So the
    // screens it names are pinned here as hard as they are in the guide's own
    // test, and for a stronger reason. Without these, the rule could be
    // regressed back to "Settings -> AI" and "Their own control is
    // Settings -> System" with the whole suite still green, and the box would
    // ship the exact defect this PR exists to remove.
    expect(after).toMatch(/Settings -> Providers/);
    expect(after).not.toMatch(/Settings -> AI\b/);
    expect(after).toMatch(/power menu in the desktop tray/);
    expect(after).toMatch(/not Settings -> System/);
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

  it("still lands the rule when the guide template is missing entirely", () => {
    // The rule needs no template — it is a printf in the script — and it is the
    // copy the harness injects. Gating it on the template (the block used to be
    // wrapped in `[ -f "$CLAWBOX_GUIDE_SRC" ]`) meant a half-finished update or a
    // renamed template withheld the deliverable with exit 0 and no output at all.
    writeFileSync(agents, "# AGENTS\n");
    const root = mkdtempSync(path.join(dir, "empty-root-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    const script = `set -euo pipefail\nCLAWBOX_ROOT=${JSON.stringify(root)}\nCLAWBOX_WORKSPACE=${JSON.stringify(workspace)}\n${seedingBlock()}`;
    const res = spawnSync("bash", ["-c", script], { encoding: "utf-8" });

    expect(res.status).toBe(0);
    // The missing template is reported rather than passed over in silence...
    expect(res.stderr).toContain("could not read");
    // ...and the rule still reaches the file the harness loads.
    expect(readFileSync(agents, "utf-8")).toContain(RULE);
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

  it("leaves no fragment in AGENTS.md when an append stops part way", () => {
    // The same shape as the guide top-up, in the file the harness actually
    // injects: a half-written rule keeps its heading, so the rule the model
    // reads is a sentence that stops mid-word and no later boot repairs it.
    // Padded past a 1024-byte boundary on purpose: the cap can only be set in
    // whole blocks, so a short file would let the whole rule fit inside the
    // first block and the write would simply succeed, testing nothing.
    const existing = "# AGENTS\n\nBe helpful.\n\n## ClawBox integration\n\nSee `CLAWBOX.md`.\n"
      + "Owner note: the printer is on the shelf.\n".repeat(45);
    writeFileSync(agents, existing);

    const res = runCapped(Buffer.byteLength(existing) + 128);

    expect(res.status).toBe(0);
    // Proof the append really did stop part way — without this the case
    // degenerates into "the write succeeded" the day the rule text shrinks.
    expect(res.stderr).toContain("could not append the system-actions rule");
    expect(readFileSync(agents, "utf-8")).toBe(existing);

    const second = run();
    expect(second.stdout).toContain("Appended the system-actions rule to AGENTS.md");
    const after = readFileSync(agents, "utf-8");
    expect(after).toContain(RULE);
    expect(after).toContain("operator_approval");
    expect(after.split(RULE)).toHaveLength(2);
  });

  it.skipIf(process.getuid?.() === 0)("does not stop the gateway when AGENTS.md cannot be written", () => {
    writeFileSync(agents, "# AGENTS\n");
    chmodSync(agents, 0o444);

    // `run` throws on a non-zero exit, so reaching the assertion is the proof.
    const { stderr } = run();

    expect(stderr).toContain("could not append the system-actions rule");
    expect(stderr).not.toContain("could not roll");
    expect(readFileSync(agents, "utf-8")).toBe("# AGENTS\n");
  });
});
