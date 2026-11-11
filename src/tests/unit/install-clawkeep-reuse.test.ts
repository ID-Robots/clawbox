import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testEnv } from "@/tests/helpers/env";

// A real bash per case: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * UPD-04 — every in-app update force-reinstalled the ClawKeep CLI twice:
 * 9 s in step_rebuild_reboot and 8 s more in step_post_update, the second
 * inside the quiesced gateway's down window, from the same source tree.
 *
 * rebuild_reboot keeps forcing (the package stays at version 0.1.0 across
 * releases, so only a forced install refreshes the code). Once that install is
 * verified it records the git tree id of clawkeep/ in a root-owned file on
 * /run, and post_update (`--reuse-this-update`) skips its own forced install
 * only when that record names the tree HEAD has NOW, the tree has no local
 * change, clawkeepd is there and `clawkeep --help` still answers. The reuse
 * spends the record. Anything else forces, exactly as before.
 *
 * This drives the shipped function under bash with pipx, git and the CLI
 * replaced by logging fakes.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OTHER_TREE = "0123456789abcdef0123456789abcdef01234567";
const REUSE_LINE =
  /ClawKeep CLI: the same code \(clawkeep tree 4b825dc642cb\) was installed and verified earlier in this update; not reinstalled/;

let dir: string;
let project: string;
let home: string;
let bin: string;
let record: string;

function exe(file: string, body: string): void {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
  chmodSync(file, 0o755);
}

function flag(name: string, content = ""): void {
  writeFileSync(path.join(dir, name), content);
}

function calls(): string[] {
  return readFileSync(path.join(dir, "calls"), "utf-8").split("\n").filter(Boolean);
}

const pipxRuns = () => calls().filter((c) => c.startsWith("pipx ")).length;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-clawkeep-reuse-"));
  project = path.join(dir, "project");
  home = path.join(dir, "home");
  bin = path.join(dir, "bin");
  record = path.join(dir, "run", "clawkeep-installed");
  mkdirSync(path.join(project, "clawkeep"), { recursive: true });
  mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(dir, "calls"), "");
  const log = JSON.stringify(path.join(dir, "calls"));
  const at = (name: string) => JSON.stringify(path.join(dir, name));
  const clawkeepd = JSON.stringify(path.join(home, ".local", "bin", "clawkeepd"));
  // An installed CLI, as a previous install left it.
  exe(path.join(home, ".local", "bin", "clawkeepd"), "exit 0\n");
  // pipx: logs, and lays down clawkeepd unless the case says the install broke.
  exe(path.join(bin, "pipx"), [
    `printf 'pipx %s\\n' "$*" >> ${log}`,
    `[ -f ${at("pipx-fails")} ] && exit 1`,
    `[ -f ${at("pipx-no-clawkeepd")} ] || { printf '#!/bin/sh\\nexit 0\\n' > ${clawkeepd}; chmod +x ${clawkeepd}; }`,
    "exit 0",
    "",
  ].join("\n"));
  exe(path.join(bin, "clawkeep"), [
    `printf 'clawkeep %s\\n' "$*" >> ${log}`,
    `[ -f ${at("clawkeep-broken")} ] && exit 1`,
    "echo 'usage: clawkeep [-h] {backup,restore,status}'",
    "",
  ].join("\n"));
  // git: the tree id of HEAD:clawkeep from the file `tree` (none: git cannot
  // answer), and `status --porcelain` from the file `dirty`.
  exe(path.join(bin, "git"), [
    `printf 'git %s\\n' "$*" >> ${log}`,
    'case " $* " in',
    `  *" rev-parse "*) [ -f ${at("tree")} ] || exit 128; cat ${at("tree")} ;;`,
    // A failing `status` prints nothing: empty output must not read as clean.
    `  *" status "*) [ -f ${at("status-fails")} ] && exit 128; cat ${at("dirty")} 2>/dev/null; exit 0 ;;`,
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n"));
  flag("tree", `${TREE}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runStep(args: string[], opts: { pipx?: boolean } = {}) {
  const log = JSON.stringify(path.join(dir, "calls"));
  const program = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(project)}`,
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    `ensure_pipx() { return ${opts.pipx === false ? 1 : 0}; }`,
    `step_clawkeep_install_pip_user_fallback() { printf 'pip-user-fallback\\n' >> ${log}; }`,
    // The tree's owner, never root: every git call must come through here.
    `as_clawbox() { printf 'as_clawbox %s\\n' "$1" >> ${log}; "$@"; }`,
    `as_clawbox_login() { bash -c "$*"; }`,
    shellFunction("step_clawkeep_install"),
    `step_clawkeep_install ${args.join(" ")}`,
  ].join("\n");
  return spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 20_000,
    env: testEnv({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      CLAWBOX_CLAWKEEP_INSTALLED_RECORD: record,
    }),
  });
}

function keepRecord(content: string): void {
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, content);
}

describe("step_clawkeep_install: one forced install per update", () => {
  it("a forced run installs and records the clawkeep tree it installed", () => {
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Installing ClawKeep CLI via pipx");
    expect(pipxRuns()).toBe(1);
    expect(readFileSync(record, "utf-8")).toBe(`${TREE}\n`);
    // git ran as the tree's owner, never as root.
    const gitCalls = calls().filter((c) => c.startsWith("git ")).length;
    expect(gitCalls).toBeGreaterThan(0);
    expect(calls().filter((c) => c === "as_clawbox git").length).toBe(gitCalls);
  });

  it("post_update reuses a verified install of the same tree: no pipx, one line, record spent", () => {
    keepRecord(`${TREE}\n`);
    const r = runStep(["--reuse-this-update"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(REUSE_LINE);
    expect(r.stdout).not.toContain("Installing ClawKeep CLI via pipx");
    expect(pipxRuns()).toBe(0);
    // The CLI still answered before the skip.
    expect(calls()).toContain("clawkeep --help");
    expect(existsSync(record)).toBe(false);
  });

  it("a second --reuse-this-update in the same boot forces again", () => {
    keepRecord(`${TREE}\n`);
    expect(runStep(["--reuse-this-update"]).stdout).toMatch(REUSE_LINE);
    expect(pipxRuns()).toBe(0);
    const again = runStep(["--reuse-this-update"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(REUSE_LINE);
    expect(pipxRuns()).toBe(1);
  });

  it("a run without the flag forces even over a matching record", () => {
    keepRecord(`${TREE}\n`);
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(REUSE_LINE);
    expect(pipxRuns()).toBe(1);
  });

  it.each([
    ["no record", () => {}],
    ["a record of another tree", () => keepRecord(`${OTHER_TREE}\n`)],
    ["a tree with local edits", () => { keepRecord(`${TREE}\n`); flag("dirty", " M clawkeep/clawkeep/cli.py\n"); }],
    ["a git that cannot answer", () => { keepRecord(`${TREE}\n`); rmSync(path.join(dir, "tree")); }],
    ["a git status that fails", () => { keepRecord(`${TREE}\n`); flag("status-fails"); }],
    ["a missing clawkeepd", () => { keepRecord(`${TREE}\n`); rmSync(path.join(home, ".local", "bin", "clawkeepd")); }],
    ["a CLI that no longer answers", () => { keepRecord(`${TREE}\n`); flag("clawkeep-broken"); }],
    ["a symlinked record", () => {
      mkdirSync(path.dirname(record), { recursive: true });
      writeFileSync(path.join(dir, "elsewhere"), `${TREE}\n`);
      symlinkSync(path.join(dir, "elsewhere"), record);
    }],
  ])("forces under --reuse-this-update with %s", (_label, arrange) => {
    arrange();
    const r = runStep(["--reuse-this-update"]);
    expect(r.stdout).not.toMatch(REUSE_LINE);
    expect(pipxRuns()).toBe(1);
  });

  it("never records a tree with local edits", () => {
    flag("dirty", "?? clawkeep/clawkeep/extra.py\n");
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(pipxRuns()).toBe(1);
    expect(existsSync(record)).toBe(false);
  });

  it("never records when git cannot name the tree", () => {
    rmSync(path.join(dir, "tree"));
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it("never records when git status fails, though it printed nothing", () => {
    flag("status-fails");
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(pipxRuns()).toBe(1);
    expect(existsSync(record)).toBe(false);
  });

  it("replaces a symlinked record with a file and leaves the link's target alone", () => {
    mkdirSync(path.dirname(record), { recursive: true });
    const target = path.join(dir, "elsewhere");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, record);
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(record).isSymbolicLink()).toBe(false);
    expect(readFileSync(record, "utf-8")).toBe(`${TREE}\n`);
    expect(readFileSync(target, "utf-8")).toBe("untouched\n");
  });

  it("a failed pipx install drops an older record and writes none", () => {
    keepRecord(`${TREE}\n`);
    flag("pipx-fails");
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(pipxRuns()).toBe(1);
    expect(existsSync(record)).toBe(false);
  });

  it("an install with no clawkeepd keeps its error and writes no record", () => {
    keepRecord(`${TREE}\n`);
    flag("pipx-no-clawkeepd");
    const r = runStep([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("clawkeepd is missing");
    expect(existsSync(record)).toBe(false);
  });

  it("the pip --user fallback drops an older record and writes none", () => {
    keepRecord(`${TREE}\n`);
    const r = runStep([], { pipx: false });
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toContain("pip-user-fallback");
    expect(pipxRuns()).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it("a missing ClawKeep source drops an older record", () => {
    keepRecord(`${TREE}\n`);
    rmSync(path.join(project, "clawkeep"), { recursive: true });
    const r = runStep([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("ClawKeep source missing; skipping");
    expect(existsSync(record)).toBe(false);
  });
});

describe("who may reuse: post_update only", () => {
  it("step_post_update passes --reuse-this-update", () => {
    expect(shellFunction("step_post_update")).toContain(
      "optional_step clawkeep_install step_clawkeep_install --reuse-this-update",
    );
  });

  it("step_rebuild_reboot keeps the one forced install of the update", () => {
    const fn = shellFunction("step_rebuild_reboot");
    expect(fn).toMatch(/\n\s*step_clawkeep_install \|\|/);
    expect(fn).not.toContain("--reuse-this-update");
  });

  it("no other caller in install.sh passes the flag", () => {
    expect(INSTALL_SH.match(/step_clawkeep_install --reuse-this-update/g)?.length).toBe(1);
    // The full install forces.
    expect(INSTALL_SH).toMatch(/\nstep_clawkeep_install\n/);
  });
});
