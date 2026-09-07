import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-758 — a third-party installer grows the box's `~/.bashrc` without bound.
 *
 * Measured on 2026-09-07, read-only, on both dev boxes:
 *
 *   Hermes    25 `.local/bin` exports, 23 `# Added by cua-driver-rs installer`
 *             blocks, 7 049 B, `.bashrc` lines 122-193
 *   OpenClaw   3 `.local/bin` exports,  1 such block,                4 431 B
 *
 * NOTHING IN THIS REPOSITORY WRITES THAT BLOCK. `grep -rn cua` over install.sh,
 * install-x64.sh, scripts/, src/, config/ and mcp/ finds nothing: the writer is
 * the vendor's own `cua-driver` binary, and it is Hermes' agent that keeps
 * calling it — `tools/computer_use/cua_backend.py` runs `cua_driver_update_check`
 * on its own — which is why the Hermes box has 23 of them and the OpenClaw box,
 * whose `~/.local/bin/cua-driver` was installed once and never updated, has one.
 * So "make the writer idempotent" is not available to us; each append costs
 * every login shell another ~119 B and nothing bounds it.
 *
 * What IS available is the other end: collapse the copies to ONE and fence it,
 * on every update, so the next append is collapsed too. It has to run on every
 * update rather than once, precisely because the writer is not ours and will
 * append again.
 *
 * The block the vendor appends, verbatim from the box (the dash is an em dash):
 *
 *     <blank>
 *     # Added by cua-driver-rs installer — see https://github.com/trycua/cua
 *     export PATH="/home/clawbox/.local/bin:$PATH"
 *
 * Its export line is BYTE-IDENTICAL to the one inside the vendor Codex fence
 * (#765) three lines from the end of the same file, which is why a dedupe keyed
 * on the export line would eat the Codex block. The marker comment is the key.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

/** install.sh's own `CUA_BASHRC_*` assignments, so the sandbox uses the shipped strings. */
function shellConstants(): string {
  const lines = INSTALL_SH.split("\n").filter((l) => /^CUA_BASHRC_[A-Z_]+='/.test(l));
  if (lines.length !== 3) {
    throw new Error(`expected 3 CUA_BASHRC_* assignments in install.sh, found ${lines.length}`);
  }
  return lines.join("\n");
}

/** The vendor's block, exactly as it lands on the box. */
const VENDOR_MARKER = "# Added by cua-driver-rs installer — see https://github.com/trycua/cua";
const VENDOR_EXPORT = 'export PATH="/home/clawbox/.local/bin:$PATH"';
const vendorBlock = ["", VENDOR_MARKER, VENDOR_EXPORT];

/** The Codex installer's fenced block (#765) — same export line, must survive. */
const CODEX_BLOCK = [
  "# >>> Codex installer >>>",
  VENDOR_EXPORT,
  "# <<< Codex installer <<<",
];

/**
 * The Hermes box's `~/.bashrc`, in shape: the stock tail, the bun block, the
 * FIRST vendor block ahead of ClawBox's own stanza (that is the real order),
 * then `copies - 1` more, then install-voice.sh's CUDA exports and the Codex
 * fence at the end.
 */
function bashrcFixture(copies: number): string {
  const lines = [
    "# ~/.bashrc: executed by bash(1) for non-login shells.",
    "case $- in",
    "    *i*) ;;",
    "      *) return;;",
    "esac",
    "",
    "# bun",
    'export BUN_INSTALL="$HOME/.bun"',
    'export PATH="$BUN_INSTALL/bin:$PATH"',
  ];
  if (copies > 0) lines.push(...vendorBlock);
  lines.push(
    "",
    "# npm global binaries (openclaw, codex, gemini) and user-local binaries (claude, hf, clawkeep)",
    'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"',
  );
  for (let i = 1; i < copies; i++) lines.push(...vendorBlock);
  lines.push(
    "export LD_LIBRARY_PATH=/home/clawbox/.local/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}",
    "export CUDA_HOME=/usr/local/cuda",
    "",
    ...CODEX_BLOCK,
    "",
  );
  return lines.join("\n");
}

let sandbox: string;
let bashrc: string;

/**
 * Run install.sh's `.bashrc` hygiene over the fixture, exactly as an update
 * does — through `ensure_clawbox_bashrc_path`, which `step_coding_harness`
 * calls and `step_post_update` reaches on BOTH editions.
 */
function runBashrcHygiene(): { status: number | null; stderr: string } {
  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(sandbox)}`,
    'CLAWBOX_USER="$(id -un)"',
    "",
    shellConstants(),
    "",
    extractShellFunction("dedupe_vendor_bashrc_path_blocks"),
    "",
    extractShellFunction("ensure_clawbox_bashrc_path"),
    "",
    "ensure_clawbox_bashrc_path",
    "",
  ].join("\n");
  const runner = path.join(sandbox, "run.sh");
  fs.writeFileSync(runner, script, "utf-8");
  const result = spawnSync("bash", [runner], { encoding: "utf-8", cwd: REPO });
  return { status: result.status, stderr: result.stderr ?? "" };
}

const read = () => fs.readFileSync(bashrc, "utf-8");
const countOf = (text: string, needle: string) => text.split(needle).length - 1;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-bashrc-dedupe-"));
  bashrc = path.join(sandbox, ".bashrc");
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

d("~/.bashrc keeps ONE vendor PATH block, however often the vendor appends", () => {
  it("collapses the box's 23 copies to one fenced block", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    expect(countOf(read(), VENDOR_MARKER)).toBe(23);

    const run = runBashrcHygiene();
    expect(run.status, run.stderr).toBe(0);

    const after = read();
    expect(
      countOf(after, VENDOR_MARKER),
      "the vendor's block must survive exactly once — it says who put the path there",
    ).toBe(1);
    // 3 remain: ClawBox's own stanza, the surviving vendor block, and Codex's.
    expect(countOf(after, ".local/bin")).toBe(3);
    expect(after.length).toBeLessThan(bashrcFixture(23).length);
  });

  it("fences the survivor, so the next append is collapsed too", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    expect(runBashrcHygiene().status).toBe(0);

    const after = read().split("\n");
    const at = after.findIndex((l) => l === VENDOR_MARKER);
    expect(at).toBeGreaterThan(0);
    expect(after[at - 1]).toMatch(/^# >>> ClawBox: cua-driver-rs PATH .*>>>$/);
    expect(after[at + 1]).toBe(VENDOR_EXPORT);
    expect(after[at + 2]).toMatch(/^# <<< ClawBox: cua-driver-rs PATH .*<<<$/);
  });

  it("leaves everything that is not the vendor's block exactly as it was", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    expect(runBashrcHygiene().status).toBe(0);

    const before = bashrcFixture(23).split("\n");
    const after = read().split("\n");
    const isOurs = (l: string) => /^# [<>]{3} ClawBox: cua-driver-rs PATH /.test(l);
    // Every line of real content, in order — nothing else moved, changed or went.
    const strip = (lines: string[]) =>
      lines.filter((l) => l !== "" && l !== VENDOR_MARKER && l !== VENDOR_EXPORT && !isOurs(l));
    expect(strip(after).join("\n")).toBe(strip(before).join("\n"));
    // The blank line the vendor writes above each block goes WITH the block it
    // belongs to, and with nothing else: 22 removed blocks, 22 fewer blanks.
    const blanks = (lines: string[]) => lines.filter((l) => l === "").length;
    expect(blanks(before) - blanks(after)).toBe(22);
    // Named explicitly, because its export line is byte-identical to the
    // vendor's and a dedupe keyed on that line would have eaten it.
    expect(read()).toContain(CODEX_BLOCK.join("\n"));
  });

  it("keeps the survivor where the FIRST copy was, so PATH order does not move", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    expect(runBashrcHygiene().status).toBe(0);

    const after = read().split("\n");
    const vendorAt = after.findIndex((l) => l === VENDOR_MARKER);
    const clawboxAt = after.findIndex((l) => l.includes('$HOME/.npm-global/bin:$HOME/.local/bin'));
    expect(vendorAt).toBeGreaterThan(0);
    expect(clawboxAt).toBeGreaterThan(vendorAt);
  });

  it("is idempotent — a second run changes nothing", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    expect(runBashrcHygiene().status).toBe(0);
    const once = read();

    expect(runBashrcHygiene().status).toBe(0);
    expect(read()).toBe(once);
  });

  it("collapses again after the vendor has appended over the fence", () => {
    // The whole reason this runs on every update: the writer is not ours.
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    expect(runBashrcHygiene().status).toBe(0);
    const collapsed = read();

    fs.writeFileSync(bashrc, `${collapsed}${vendorBlock.join("\n")}\n`, "utf-8");
    expect(runBashrcHygiene().status).toBe(0);

    expect(countOf(read(), VENDOR_MARKER)).toBe(1);
    expect(countOf(read(), "# >>> ClawBox: cua-driver-rs PATH")).toBe(1);
  });

  it("does not rewrite a file with a single copy — the OpenClaw box", () => {
    fs.writeFileSync(bashrc, bashrcFixture(1), "utf-8");
    const before = read();

    expect(runBashrcHygiene().status).toBe(0);

    expect(read(), "one copy is not a duplicate; touching it would be churn").toBe(before);
  });

  it("does not rewrite a file with no vendor block at all", () => {
    fs.writeFileSync(bashrc, bashrcFixture(0), "utf-8");
    const before = read();

    expect(runBashrcHygiene().status).toBe(0);

    expect(read()).toBe(before);
  });

  it("keeps the file's mode across the rewrite", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");
    fs.chmodSync(bashrc, 0o640);

    expect(runBashrcHygiene().status).toBe(0);

    expect(fs.statSync(bashrc).mode & 0o777).toBe(0o640);
  });

  it("still writes the ClawBox PATH stanza into a .bashrc that has none", () => {
    // The function's own job must survive the addition.
    fs.writeFileSync(bashrc, "# empty\n", "utf-8");

    expect(runBashrcHygiene().status).toBe(0);

    expect(read()).toContain('export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"');
  });
});

d("the collapse reaches an already-shipped box", () => {
  it("runs from ensure_clawbox_bashrc_path, which step_coding_harness calls", () => {
    // step_post_update -> step_coding_harness -> ensure_clawbox_bashrc_path is
    // the only .bashrc path an in-app update takes on BOTH editions:
    // step_openclaw_install returns before its own call on the Hermes SKU —
    // which is the box with 23 copies.
    const fn = extractShellFunction("ensure_clawbox_bashrc_path");
    expect(fn).toContain("dedupe_vendor_bashrc_path_blocks");

    const harness = extractShellFunction("step_coding_harness");
    expect(harness).toContain("ensure_clawbox_bashrc_path");
  });
});
