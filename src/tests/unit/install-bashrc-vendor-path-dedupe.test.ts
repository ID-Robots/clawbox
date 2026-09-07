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
function runBashrcHygiene(
  home: string = sandbox,
  /** Shell injected before the function runs — used to stage a concurrent writer. */
  prelude = "",
): { status: number | null; stdout: string; stderr: string } {
  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    'CLAWBOX_USER="$(id -un)"',
    "",
    shellConstants(),
    "",
    prelude,
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
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

  it("says so, and changes nothing, when the vendor's block shape has moved", () => {
    // The premise of the whole function is that the writer is a third party
    // ClawBox does not own and cannot pin, so its shape WILL change — one extra
    // line between the marker and the export is enough for every block to fall
    // through the transform. Reporting the collapse off `mv`'s exit code would
    // then rewrite the file byte-identical and log a success on every update,
    // for ever, with the bound silently gone: the false-success class, on the
    // one path whose stated design assumption is "the vendor will change".
    const moved = ["", VENDOR_MARKER, "# a line the vendor did not use to write", VENDOR_EXPORT];
    const before = [
      "# ~/.bashrc",
      'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"',
      ...moved,
      ...moved,
      ...moved,
      "",
    ].join("\n");
    fs.writeFileSync(bashrc, before, "utf-8");

    const run = runBashrcHygiene();

    expect(run.status, run.stderr).toBe(0);
    expect(read(), "a file the transform could not improve is not replaced").toBe(before);
    expect(run.stdout).toContain("the vendor's block shape has changed");
    expect(run.stdout, "and no collapse may be claimed").not.toContain("Collapsed");
  });

  it("says what it did, with the number it actually removed", () => {
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");

    const run = runBashrcHygiene();

    expect(run.stdout).toContain("Collapsed 23 duplicate cua-driver-rs PATH blocks");
  });

  it("leaves a symlinked .bashrc alone rather than replacing the link", () => {
    // Read THROUGH the link as root and then replaced by the `mv` with a
    // regular file — a dotfiles checkout would quietly lose its link.
    const real = path.join(sandbox, "dotfiles-bashrc");
    fs.writeFileSync(real, bashrcFixture(23), "utf-8");
    fs.symlinkSync(real, bashrc);

    expect(runBashrcHygiene().status).toBe(0);

    expect(fs.lstatSync(bashrc).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf-8")).toBe(bashrcFixture(23));
  });

  /** A shell function that shadows `name` and appends a vendor block after it runs. */
  function appendingWrapper(name: string): string {
    return [
      `${name}() {`,
      `  command ${name} "$@"`,
      `  printf '\\n%s\\n%s\\n' ${JSON.stringify(VENDOR_MARKER)} ${JSON.stringify(VENDOR_EXPORT)} >> ${JSON.stringify(bashrc)}`,
      "}",
    ].join("\n");
  }

  it("leaves the file alone when something wrote to it mid-collapse", () => {
    // The `mv` is an atomic rename, so no reader sees half a file — but a
    // rename replaces the INODE, and an append that lands between the read and
    // the swap would go with the old one. The vendor's installer runs on the
    // box's own schedule, so it can be alive during an update.
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");

    // A writer that appends the moment the transform has read the file.
    const run = runBashrcHygiene(sandbox, appendingWrapper("awk"));

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("changed while it was being collapsed");
    expect(run.stdout).not.toContain("Collapsed");
    // The concurrent append survives — it was not swapped away with the inode.
    expect(countOf(read(), VENDOR_MARKER)).toBe(24);
  });

  it("looks once more after the mode is set, not before it", () => {
    // The check has to be the LAST thing between the look and the rename:
    // `chown` and `chmod` run on the temp file in between, and an append
    // landing in that gap would still be swapped away with the old inode.
    // There is no atomic compare-and-rename, so the window cannot be closed —
    // only narrowed to one `stat` and one `rename`.
    fs.writeFileSync(bashrc, bashrcFixture(23), "utf-8");

    const run = runBashrcHygiene(sandbox, appendingWrapper("chmod"));

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("changed while it was being collapsed");
    expect(run.stdout).not.toContain("Collapsed");
    expect(countOf(read(), VENDOR_MARKER)).toBe(24);
  });

  // root ignores the directory mode, so the case cannot be staged there.
  const asUser = process.getuid?.() === 0 ? it.skip : it;
  asUser("warns rather than ending the update when the file cannot be replaced", () => {
    // `--step post_update` runs the step body with errexit ON and the
    // dispatcher calls the step plainly, so an unguarded failure here would end
    // the update at this line with none of the steps below it running.
    const locked = path.join(sandbox, "locked");
    fs.mkdirSync(locked);
    const lockedBashrc = path.join(locked, ".bashrc");
    fs.writeFileSync(lockedBashrc, bashrcFixture(23), "utf-8");
    const before = fs.readFileSync(lockedBashrc, "utf-8");
    fs.chmodSync(locked, 0o555); // no new file in the directory: mktemp fails

    try {
      const run = runBashrcHygiene(locked);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("Warning");
      expect(fs.readFileSync(lockedBashrc, "utf-8")).toBe(before);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
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

    // The link that makes the claim true for an already-flashed device, and
    // the one nothing else pins: step_openclaw_install returns on the Hermes
    // SKU before its own call, and the bottom-of-file call runs on the full
    // install only. Drop step_coding_harness from this list — it is edited
    // constantly — and the collapse silently becomes fresh-install-only, which
    // is the regression the comment above that call says already happened once.
    expect(extractShellFunction("step_post_update")).toContain("step_coding_harness");
  });
});
