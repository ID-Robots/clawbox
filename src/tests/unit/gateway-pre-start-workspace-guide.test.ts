import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * So an existing file is TOPPED UP with EVERY section it is missing, and never
 * overwritten — one hand-added marker per section did not scale, and the box
 * that proved it had never received the Coding agent section at all (TASK-706).
 * These run the block out of the shipped `.sh` rather than a copy, so the test
 * fails if the real script drifts.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
function runCapped(
  bytes: number,
  template = TEMPLATE,
  opts: { hideTruncate?: boolean; hidePython?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(path.join(dir, "root-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config/clawbox-workspace-guide.md"), readFileSync(template, "utf-8"));
  const blocks = Math.max(1, Math.ceil(bytes / 1024));
  const script = [
    "set -euo pipefail",
    'trap "" XFSZ',
    // A rootfs without coreutils' `truncate`: the shell function shadows the
    // binary, so the helper falls through to its python3 fallback.
    ...(opts.hideTruncate ? ["truncate() { return 127; }"] : []),
    // …and both of them gone, which is the only way to reach the helper's
    // "could not roll it back" warning. Two divergences from a real ENOSPC are
    // worth knowing when reading these fixtures: the shipped script sets no
    // XFSZ trap (correct — ENOSPC raises no signal, only `ulimit -f` does), and
    // under the cap the rollback verbs themselves always succeed, which is why
    // the failed-rollback branch needs a shadow of its own rather than falling
    // out of any capped run.
    ...(opts.hidePython ? ["python3() { return 127; }"] : []),
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
      // continued `&& ! python3 -c '… os.truncate …'` — and without this the
      // write-count floor would still be met with BOTH of them deleted.
      || /^(if\s+)?!\s*truncate\b/.test(line)
      || /^&&\s*!\s*python3\b/.test(line)
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
      && !/^rm -f "\$[A-Za-z_][A-Za-z0-9_]*" 2>\/dev\/null \|\| true$/.test(line));

    // Sanity: the filter has to be finding this block's write sites, or an
    // empty `unguarded` would prove nothing. The floor is the REAL count, not a
    // token one. The eight write sites are, today:
    //   1 the helper's own `printf >>`
    //   2 `truncate -s`, 3 the `python3 os.truncate` fallback
    //   4 the `install` seed, 5 its failure-branch `rm -f`
    //   6-8 the three `clawbox_append_or_rollback` calls
    expect(writes.length).toBeGreaterThanOrEqual(8);
    // Both rollback verbs, by name: the write-count floor can be met
    // without them.
    expect(writes.join("\n")).toMatch(/truncate -s/);
    expect(writes.join("\n")).toMatch(/os\.truncate/);
    expect(unguarded).toEqual([]);
  });

  it("appends the system-actions section to a guide written before it existed", () => {
    // A real pre-TASK-612 guide, personalized: the sections the box was seeded
    // with, plus a note the owner added.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, `${older}\n\n## Owner's notes\n\nThe printer is on the shelf.\n`);

    const { stdout } = run();

    expect(stdout).toMatch(/Appended to CLAWBOX\.md:.*System actions and restarts/);
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

    expect(second.stdout).not.toMatch(/Appended to CLAWBOX\.md/);
    expect(readFileSync(guide, "utf-8")).toBe(afterFirst);
    expect(afterFirst.split(HEADING)).toHaveLength(2);
  });

  it("appends each section on its own, bounded by the next heading", () => {
    // The extraction is bounded by the NEXT `## ` heading, so every missing
    // section arrives as its own block behind its own separator — never one
    // heading carrying the body of the ones after it. With a multi-section
    // top-up that invariant is what keeps the file readable rather than one
    // run-on tail.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, older);

    run();

    const appended = readFileSync(guide, "utf-8").slice(older.length);
    for (const heading of ["## System actions and restarts", "## Coding agent (delegate a whole task)"]) {
      expect(appended).toContain(`\n---\n\n${heading}\n`);
    }
    // And the template's own closing rule is not carried with them: the append
    // supplies its own leading separator, so carrying that one too would end the
    // topped-up guide on a dangling horizontal rule.
    expect(appended.trimEnd().endsWith("---")).toBe(false);
  });

  it("follows a heading the template renames, instead of losing the section", () => {
    // The old top-up matched ONE marker string that had to stay in step with the
    // template's heading; a rename in the template silently stopped delivering
    // the section, with a warning nobody sees. The headings now come out of the
    // template itself, so a rename is simply a different heading to deliver —
    // and the old name, which no template carries any more, is not invented.
    const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
    writeFileSync(guide, older);
    const renamed = path.join(dir, "renamed-template.md");
    writeFileSync(renamed, readFileSync(TEMPLATE, "utf-8").replace(HEADING, "## Restarts, renamed"));

    const { stdout } = run(renamed);

    const after = readFileSync(guide, "utf-8");
    expect(stdout).toMatch(/Appended to CLAWBOX\.md:.*Restarts, renamed/);
    expect(after).toContain("## Restarts, renamed");
    expect(after).toContain("operator_approval");
    expect(after).not.toContain(HEADING);
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

    expect(stdout).not.toMatch(/Appended to CLAWBOX\.md/);
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
    expect(res.stdout).not.toMatch(/Appended to CLAWBOX\.md/);
    // ...and the file is back to what it was, marker and fragment both gone.
    expect(readFileSync(guide, "utf-8")).toBe(older);
  });

  it("rolls back without truncate on the PATH", () => {
    // The fallback, exercised rather than assumed: a rootfs without coreutils'
    // `truncate` must still remove the fragment, not empty the file.
    const older = padToJustUnderABlock(readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0]);
    writeFileSync(guide, older);

    const res = runCapped(Buffer.byteLength(older) + 64, TEMPLATE, { hideTruncate: true });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("could not append");
    expect(res.stderr).not.toContain("could not roll");
    expect(readFileSync(guide, "utf-8")).toBe(older);
  });

  it.skipIf(process.getuid?.() === 0)("measures a destination it cannot open, and says nothing about it", () => {
    // Two things at once, both in the false-failure class.
    //
    // The number decides whether a rollback happens at all, and `wc -c` needs
    // to OPEN the file: on a present-but-unopenable destination the helper had
    // no length and left the fragment. `stat` does not open, so it still
    // answers.
    //
    // And the redirection ORDER: bash applies them left to right, so
    // `wc -c < "$f" 2>/dev/null` opens BEFORE stderr is silenced and a
    // "Permission denied" line reached the gateway journal on a boot where
    // nothing had gone wrong — in the file an operator triaging a real disk
    // fault is reading.
    const target = path.join(dir, "unopenable.md");
    writeFileSync(target, "0123456789");
    chmodSync(target, 0o222);

    const script = [
      "set -euo pipefail",
      `CLAWBOX_ROOT=${JSON.stringify(dir)}`,
      // A workspace that does not exist, so the block defines its helpers and
      // runs none of its own writes.
      `CLAWBOX_WORKSPACE=${JSON.stringify(path.join(dir, "nowhere"))}`,
      seedingBlock(),
      `clawbox_file_size ${JSON.stringify(target)}`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", script], { encoding: "utf-8" });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe("10");
    expect(res.stderr).toBe("");
  });

  it("says the fragment is still there when NEITHER rollback verb can run", () => {
    // The one operator-facing line in the helper that no other case reaches:
    // both verbs shadowed, so the rollback itself fails. Without a fixture of
    // its own the message could be malformed, or the `if ! … && ! …` chain
    // inverted, and every other case would stay green.
    //
    // The three things that matter here are the three the helper promises: the
    // boot survives, the failure is NOT reported as a success, and the file is
    // named as suspect rather than claimed clean.
    const older = padToJustUnderABlock(readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0]);
    writeFileSync(guide, older);

    const res = runCapped(Buffer.byteLength(older) + 64, TEMPLATE, {
      hideTruncate: true,
      hidePython: true,
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("could not roll");
    expect(res.stderr).toContain(guide);
    expect(res.stdout).not.toContain("Appended the system-actions section");
    // …and it really is still cut: the warning is not itself a false failure.
    expect(readFileSync(guide, "utf-8").length).toBeGreaterThan(older.length);
  });

  it("appends the whole section on the next boot after a part-way write", () => {
    const older = padToJustUnderABlock(readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0]);
    writeFileSync(guide, older);

    runCapped(Buffer.byteLength(older) + 64);
    const second = run();

    expect(second.stdout).toMatch(/Appended to CLAWBOX\.md:.*System actions and restarts/);
    const after = readFileSync(guide, "utf-8");
    expect(after.startsWith(older)).toBe(true);
    // The paragraph that used to be the casualty.
    expect(after).toContain("operator_approval");
    // And exactly one copy of the heading, not a fragment plus a full one.
    expect(after.split(HEADING)).toHaveLength(2);
  });

  // TASK-706. Seed-if-missing plus one hand-added marker per section does not
  // scale, and the cost was measured: the OpenClaw dev box's CLAWBOX.md is
  // dated Aug 13 and carries five headings, so it has NEVER received the
  // "## Coding agent (delegate a whole task)" section — which is how the agent
  // learns that coding_agent_run / coding_agent_status / coding_agent_stop
  // exist and what to say when they are not offered. Every box set up before
  // that section landed is in the same state, silently. So the top-up appends
  // EVERY `## ` section the file is missing, not one named one.
  describe("tops a guide up to every section the template has", () => {
    // Fenced lines excluded, exactly as the script excludes them: the template
    // documents markdown, so a ``` block containing a `## ` line would make
    // these cases demand a section the script correctly refuses to enumerate.
    const headings = () => {
      const out: string[] = [];
      let fenced = false;
      for (const raw of readFileSync(TEMPLATE, "utf-8").split("\n")) {
        const line = raw.replace(/[ \t\r]+$/, "");
        if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue; }
        if (!fenced && /^## +[^ ]/.test(line)) out.push(line);
      }
      return out;
    };

    it("gives an old guide every heading the shipped template carries", () => {
      // A real pre-TASK-612 guide: the sections that box was seeded with, and
      // nothing added since.
      const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
      writeFileSync(guide, older);

      run();

      const after = readFileSync(guide, "utf-8")
        .split("\n")
        .map((l) => l.replace(/\r$/, ""));
      for (const heading of headings()) {
        expect(after).toContain(heading);
      }
    });

    it("names the Coding agent section specifically", () => {
      // The one the measurement was about, and the one a per-section marker
      // would still be missing today.
      const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
      writeFileSync(guide, older);

      const { stdout } = run();

      const after = readFileSync(guide, "utf-8");
      expect(after).toContain("## Coding agent");
      expect(after).toContain("coding_agent_run");
      expect(stdout).toMatch(/Coding agent/);
    });

    it("adds each missing section exactly once, however many times the gateway starts", () => {
      const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
      writeFileSync(guide, older);

      run();
      const afterFirst = readFileSync(guide, "utf-8");
      const second = run();

      expect(readFileSync(guide, "utf-8")).toBe(afterFirst);
      expect(second.stdout).not.toMatch(/Appended/);
      for (const heading of headings()) {
        expect(afterFirst.split(heading)).toHaveLength(2);
      }
    });

    it("keeps the owner's own sections and their text", () => {
      const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
      writeFileSync(guide, `${older}\n\n## Owner's notes\n\nThe printer is on the shelf.\n`);

      run();

      const after = readFileSync(guide, "utf-8");
      expect(after).toContain("The printer is on the shelf.");
      expect(after).toContain("## Owner's notes");
      expect(after.startsWith(older)).toBe(true);
    });

    it("does not accept a longer heading of the owner's as the template's section", () => {
      // The marker is a WHOLE line, not a prefix. The discriminating fixture
      // REPLACES the template's `## Skills` with a longer heading of the
      // owner's: a substring match would call the section present and the box
      // would never receive it. Adding the longer heading BESIDE the real one
      // proves nothing — `## Skills` is a whole line either way.
      const current = readFileSync(TEMPLATE, "utf-8");
      writeFileSync(guide, current.replace("\n## Skills\n", "\n## Skills and other things\n"));

      const { stdout } = run();

      expect(stdout).toMatch(/Appended to CLAWBOX\.md:.*Skills/);
      const after = readFileSync(guide, "utf-8");
      expect(after).toContain("## Skills and other things");
      expect(after.match(/^## Skills$/gm)).toHaveLength(1);
    });

    it("leaves a guide that already carries every section alone", () => {
      const current = readFileSync(TEMPLATE, "utf-8");
      writeFileSync(guide, `${current}\n\n## Skills and other things\n\nMine.\n`);

      const { stdout } = run();

      expect(stdout).not.toMatch(/Appended/);
      expect(readFileSync(guide, "utf-8").match(/^## Skills$/gm)).toHaveLength(1);
    });

    it("says nothing about a guide that is already complete", () => {
      const current = readFileSync(TEMPLATE, "utf-8");
      writeFileSync(guide, current);

      const { stdout } = run();

      expect(stdout).not.toMatch(/Appended/);
      // Nor re-seeded: a complete guide takes neither path.
      expect(stdout).not.toContain("Seeded CLAWBOX.md");
      expect(readFileSync(guide, "utf-8")).toBe(current);
    });

    // `skipIf`, like every other chmod case in this file: root ignores the mode
    // bits, so `[ -r ]` is true, the file reads fine and there is nothing to
    // assert. A root container would otherwise report this as a pass.
    it.skipIf(process.getuid?.() === 0)("warns and changes nothing when the guide cannot be read", () => {
      // `grep`/`awk` answer exit 2 on an unreadable file, which reads as
      // "the heading is not there" — so a 0200 CLAWBOX.md was re-appended to on
      // EVERY boot, growing without bound, while the file itself could never be
      // checked. A file this block cannot read is a file it must not top up.
      const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
      writeFileSync(guide, older);
      chmodSync(guide, 0o200);
      let res: { status: number | null; stdout: string; stderr: string };
      try {
        res = runRaw();
      } finally {
        chmodSync(guide, 0o644);
      }
      expect(res.status).toBe(0);
      // Anchored on the DESTINATION: `/could not read/` alone also matches the
      // warning about an unreadable TEMPLATE, which is a different fault.
      expect(res.stderr).toMatch(/could not read .*CLAWBOX\.md/);
      expect(res.stdout).not.toMatch(/Appended/);
      // The point of the guard: the file is untouched, not merely unreported.
      expect(readFileSync(guide, "utf-8")).toBe(older);
    });

    it("says so when the shipped template carries no sections at all", () => {
      // A truncated or zero-byte template from a half-finished deploy is
      // readable, so the guard above passes and the loop runs zero times.
      // Silence there is indistinguishable from "already complete" — the same
      // shape as the defect this card exists to fix.
      const older = readFileSync(TEMPLATE, "utf-8").split(`\n---\n\n${HEADING}`)[0];
      writeFileSync(guide, older);
      const empty = path.join(dir, "empty-template.md");
      writeFileSync(empty, "# ClawBox Integration Guide\n\nNo sections here.\n");

      const res = runRaw(empty);

      expect(res.status).toBe(0);
      expect(res.stderr).toMatch(/carries no '## ' headings/);
      expect(res.stdout).not.toMatch(/Appended/);
      expect(readFileSync(guide, "utf-8")).toBe(older);
    });

    it("does not enumerate a heading that lives inside a fenced block", () => {
      // The template is markdown that documents markdown and shell. A `## ` line
      // inside a ``` fence was harmless while one heading was named by hand;
      // enumerated, it would become a phantom section appended to every box.
      const fenced = path.join(dir, "fenced-template.md");
      writeFileSync(
        fenced,
        [
          "# Guide", "", "## Real section", "", "Body.", "",
          "```markdown", "## Not a heading", "```", "",
        ].join("\n"),
      );
      writeFileSync(guide, "# Guide\n\n## Real section\n\nBody.\n");

      const { stdout } = runRaw(fenced);

      expect(stdout).not.toMatch(/Appended/);
      expect(readFileSync(guide, "utf-8")).not.toContain("Not a heading");
    });

    it("delivers a section the guide only mentions inside a fenced block", () => {
      // The destination side of the same rule. A guide that quotes a heading
      // inside a ``` fence — an owner pasting an example, or the guide
      // documenting itself — does not CARRY that section, and reading the
      // fenced line as the marker would withhold it for good.
      const current = readFileSync(TEMPLATE, "utf-8");
      writeFileSync(
        guide,
        current.replace("\n## Skills\n", "\n```markdown\n## Skills\n```\n"),
      );

      const { stdout } = run();

      expect(stdout).toMatch(/Appended to CLAWBOX\.md:.*Skills/);
      // The real one arrives; the quoted one is left where it was.
      expect(readFileSync(guide, "utf-8").match(/^## Skills *$/gm)).toHaveLength(2);
    });

    it("does not add a second copy of a section whose heading has trailing whitespace", () => {
      // What a markdown hard line break, a prettier pass or a hand edit leaves.
      // The old substring match tolerated it; a whole-line match must normalise
      // what it now compares, or the box gains a permanent duplicate.
      const current = readFileSync(TEMPLATE, "utf-8");
      writeFileSync(guide, current.replace("\n## Skills\n", "\n## Skills \n"));

      const { stdout } = run();

      expect(stdout).not.toMatch(/Appended/);
      // End-anchored: `/^## Skills */gm` also matches the prefix of
      // `## Skills and other things`, which is the very heading this case is
      // about.
      expect(readFileSync(guide, "utf-8").match(/^## Skills *$/gm)).toHaveLength(1);
    });
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
    const existing = padToJustUnderABlock(
      "# AGENTS\n\nBe helpful.\n\n## ClawBox integration\n\nSee `CLAWBOX.md`.\n",
    );
    writeFileSync(agents, existing);

    const res = runCapped(Buffer.byteLength(existing) + 64);

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

  it.skipIf(process.getuid?.() === 0)("does not grow an AGENTS.md it cannot read", () => {
    // The same exit-2 conflation the CLAWBOX.md loop guards against, and worse
    // here: mode 0200 denies the READ while permitting the WRITE, so `grep`
    // answered "marker absent", both appends succeeded, and the file grew by
    // ~1 KB on every boot — each one reported on stdout as a success. AGENTS.md
    // is what the harness injects into every session, under a bootstrap
    // character budget.
    const existing = "# AGENTS\n\nBe helpful.\n";
    writeFileSync(agents, existing);
    chmodSync(agents, 0o200);
    let first: { status: number | null; stdout: string; stderr: string };
    let second: { status: number | null; stdout: string; stderr: string };
    try {
      first = runRaw();
      second = runRaw();
    } finally {
      chmodSync(agents, 0o644);
    }

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).not.toMatch(/Appended/);
    expect(second.stdout).not.toMatch(/Appended/);
    expect(first.stderr).toMatch(/could not read .*AGENTS\.md/);
    expect(readFileSync(agents, "utf-8")).toBe(existing);
  });

  it("does not re-append to a CRLF AGENTS.md on every boot", () => {
    // A whole-line match that is byte-exact misses `## ClawBox integration\r`,
    // so a CRLF file was appended to on EVERY boot and grew without bound —
    // the failure whole-line matching was introduced to prevent, not cause.
    const existing = "# AGENTS\r\n\r\n## ClawBox integration\r\n\r\nSee `CLAWBOX.md`.\r\n"
      + "## System actions on this ClawBox\r\n\r\nMine.\r\n";
    writeFileSync(agents, existing);

    const { stdout } = run();

    expect(stdout).not.toMatch(/Appended/);
    expect(readFileSync(agents, "utf-8")).toBe(existing);
  });

  it("does not take a longer heading of the owner's as its own marker", () => {
    // Whole-line, not substring: an AGENTS.md that says "## ClawBox integration
    // notes" is not carrying ClawBox's pointer, and a substring guard would
    // withhold it forever.
    const existing = "# AGENTS\n\n## ClawBox integration notes\n\nMine.\n";
    writeFileSync(agents, existing);

    const { stdout } = run();

    expect(stdout).toContain("Appended CLAWBOX.md reference to AGENTS.md");
    const after = readFileSync(agents, "utf-8");
    expect(after.startsWith(existing)).toBe(true);
    expect(after.match(/^## ClawBox integration$/gm)).toHaveLength(1);
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
