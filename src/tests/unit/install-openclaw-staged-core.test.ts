import { describe, expect, it, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountOnlyHome, type AccountOnlyHome, CAN_LOCK_HOME, recursiveChownRecorder, shellFunctionIfPresent, unlockTree,
} from "../helpers/account-only-home";

// A real bash per case: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * 2026-09-16 — three field boxes stopped dead seconds after `npm install -g
 * openclaw@2026.9.3` had exited 0 inside the update's "Updating OpenClaw" step.
 * They came back with a core that was complete in SHAPE and useless: 5,346 of
 * the 35,025 files npm had just written were zero-length — openclaw.mjs and
 * package.json among them — because ext4 had not yet written what npm had
 * extracted, and the gateway then failed 203/EXEC on every boot. And for the
 * 33 s of the install itself the box had NO core at all, because a global npm
 * install retires the old tree first and removes it last.
 *
 * So `step_openclaw_install` now installs into a STAGING prefix, gates the
 * launcher there, and `promote_staged_openclaw_core` flushes the stage to disk
 * before two renames put it in front of the gateway. This drives the shipped
 * functions under bash against a real prefix, with the flush observed rather
 * than performed.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, "m").exec(INSTALL_SH);
  return m ? m[0] : `${name}=""`;
}

type Prefix = { dir: string; prefix: string; calls: () => string[] };

/**
 * Every launcher's first line here: who ran it, which one, with what. Logged
 * only where the step's own run names a $LAUNCHER_RUNS, so a case that runs the
 * live core afterwards to see what it is adds nothing to the record.
 */
const SAID_WHO = '[ -n "${AS_SERVICE_USER:-}" ] && who=service || who=root; echo "$who $0 $*" >> "${LAUNCHER_RUNS:-/dev/null}"';

/** A live prefix holding an OLD core, laid out the way npm lays a global install out. */
function makePrefix(opts: { oldCore?: boolean }): Prefix {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-staged-core-"));
  const prefix = path.join(dir, "npm-global");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "calls"), "");
  if (opts.oldCore !== false) {
    const old = path.join(prefix, "lib", "node_modules", "openclaw");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "openclaw.mjs"), `#!/usr/bin/env bash\n${SAID_WHO}\necho 'OpenClaw 2026.7.1 (old)'\n`);
    chmodSync(path.join(old, "openclaw.mjs"), 0o755);
    writeFileSync(path.join(old, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1" }));
    symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(prefix, "bin", "openclaw"));
  }
  return { dir, prefix, calls: () => readFileSync(path.join(dir, "calls"), "utf-8").split("\n").filter(Boolean) };
}

/** What npm leaves in a staging prefix: the new tree and a relative launcher link. */
function stageCore(prefix: string, version: string, opts: { emptyLauncher?: boolean } = {}): string {
  const stage = path.join(prefix, ".openclaw-stage");
  const pkg = path.join(stage, "lib", "node_modules", "openclaw");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "openclaw.mjs"), opts.emptyLauncher ? "" : `#!/usr/bin/env bash\necho 'OpenClaw ${version} (new)'\n`);
  chmodSync(path.join(pkg, "openclaw.mjs"), 0o755);
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version, engines: { node: ">=24" } }));
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(stage, "bin", "openclaw"));
  return stage;
}

function bash(p: Prefix, program: string) {
  const calls = JSON.stringify(path.join(p.dir, "calls"));
  return spawnSync("bash", ["-c", [
    "set -uo pipefail",
    `NPM_PREFIX=${JSON.stringify(p.prefix)}`,
    `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
    "chown() { :; }",
    `flush_core_to_disk() { printf 'flush %s\\n' "$1" >> ${calls}; }`,
    shellFunction("promote_staged_openclaw_core"),
    program,
  ].join("\n")], { encoding: "utf-8", timeout: 20_000 });
}

describe("promote_staged_openclaw_core", () => {
  it("flushes the stage BEFORE the swap, renames it into place, and drops the old tree after", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.4");
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status, r.stderr).toBe(0);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.9.4");
      // The launcher is npm's relative link, and it resolves from the live bin.
      const launcher = path.join(p.prefix, "bin", "openclaw");
      expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
      expect(readlinkSync(launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
      expect(spawnSync("bash", [launcher], { encoding: "utf-8" }).stdout).toContain("OpenClaw 2026.9.4 (new)");
      // Nothing of the old core or the stage is left behind.
      expect(existsSync(path.join(p.prefix, "lib", "node_modules", ".openclaw-previous"))).toBe(false);
      expect(existsSync(stage)).toBe(false);
      // The flush is the point: the stage before anything moved, the prefix after.
      expect(p.calls()).toEqual([`flush ${stage}`, `flush ${p.prefix}`]);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("sets a live core that is a symlink aside like any other", () => {
    // An `npm link`ed or hand-linked core: the link itself is what is moved
    // aside and dropped, never followed into whatever it points at.
    const p = makePrefix({ oldCore: false });
    try {
      const elsewhere = path.join(p.dir, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(path.join(elsewhere, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1" }));
      symlinkSync(elsewhere, path.join(p.prefix, "lib", "node_modules", "openclaw"));
      const stage = stageCore(p.prefix, "2026.9.4");
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status, r.stderr).toBe(0);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(lstatSync(live).isSymbolicLink()).toBe(false);
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.9.4");
      // The link's target is somebody else's folder: untouched.
      expect(existsSync(path.join(elsewhere, "package.json"))).toBe(true);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("refuses to finish when nothing launches the new tree, and says so", () => {
    // A live launcher link that still resolves into the new tree is accepted
    // (npm's relative link is the same for every version); with neither that
    // nor a staged launcher, the tree is in place and nothing starts it.
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.4");
      rmSync(path.join(stage, "bin", "openclaw"));
      rmSync(path.join(p.prefix, "bin", "openclaw"));
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no openclaw launcher/);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("accepts a live launcher link that still resolves into the promoted tree", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.4");
      rmSync(path.join(stage, "bin", "openclaw"));
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status, r.stderr).toBe(0);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.9.4");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("works on a box with no core yet", () => {
    const p = makePrefix({ oldCore: false });
    try {
      const stage = stageCore(p.prefix, "2026.9.4");
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status, r.stderr).toBe(0);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.9.4");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("puts the old core back when the staged tree cannot be moved in", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.4");
      // A stage whose package tree has vanished under it: the second rename fails.
      const r = bash(p, `rm -rf ${JSON.stringify(path.join(stage, "lib", "node_modules", "openclaw"))}; promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/putting the previous one back/);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.7.1");
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("refuses to go on when the stage cannot be flushed, leaving the live core untouched", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.4");
      const r = bash(p, `flush_core_to_disk() { return 1; }; promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status).not.toBe(0);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.7.1");
      expect(existsSync(stage)).toBe(true);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

describe("recover_parked_openclaw_core", () => {
  const recover = (p: Prefix) => spawnSync("bash", ["-c", [
    "set -uo pipefail",
    `NPM_PREFIX=${JSON.stringify(p.prefix)}`,
    shellFunction("recover_parked_openclaw_core"),
    "recover_parked_openclaw_core",
  ].join("\n")], { encoding: "utf-8", timeout: 20_000 });

  it("puts a core back that a promotion parked and never replaced", () => {
    // The window between the two renames: live gone, old tree parked.
    const p = makePrefix({});
    try {
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      const previous = path.join(p.prefix, "lib", "node_modules", ".openclaw-previous");
      spawnSync("mv", [live, previous]);
      const r = recover(p);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/putting it back/);
      expect(existsSync(previous)).toBe(false);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("drops what a finished promotion did not get to remove, and touches a present core not at all", () => {
    const p = makePrefix({});
    try {
      const previous = path.join(p.prefix, "lib", "node_modules", ".openclaw-previous");
      mkdirSync(previous, { recursive: true });
      const stage = stageCore(p.prefix, "2026.9.9");
      const r = recover(p);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(previous)).toBe(false);
      expect(existsSync(stage)).toBe(false);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("does nothing on a box with neither", () => {
    const p = makePrefix({ oldCore: false });
    try {
      const r = recover(p);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

describe("step_openclaw_install stages the core", () => {
  /** The step, driven with a stub npm that lays npm's layout down at the prefix it is handed. */
  function runStep(p: Prefix, opts: {
    npm: "ok" | "empty-launcher" | "wrong-version" | "stderr-first" | "nothing";
    pin?: string;
    /** Record where each recursive chown would land, one path per line in this file. */
    chownLog?: string;
    /** The npm prefix only `as_clawbox` can write to (src/tests/helpers/account-only-home.ts). */
    account?: AccountOnlyHome;
    /** The migration pre-flight refuses, so the step leaves through its gateway-restoring failure path. */
    preflightFails?: boolean;
    /** Run under errexit, as a dispatched root step does; `prelude` is sourced last before the step. */
    errexit?: boolean;
    prelude?: string;
  }) {
    const calls = JSON.stringify(path.join(p.dir, "calls"));
    const bin = path.join(p.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const npm = path.join(bin, "npm");
    writeFileSync(npm, `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> ${calls}
prefix=""; prev=""; want=""
for a in "$@"; do
  case "$prev" in --prefix) prefix="$a" ;; esac
  case "$a" in openclaw@*) want="\${a#openclaw@}" ;; esac
  prev="$a"
done
case ${JSON.stringify(opts.npm)} in
  nothing) exit 0 ;;
  wrong-version) want="2026.1.1" ;;
esac
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/openclaw"
said_who='${SAID_WHO}'
first=""
[ ${JSON.stringify(opts.npm)} = stderr-first ] && first='echo "a line on stderr before the banner" >&2'
if [ ${JSON.stringify(opts.npm)} = empty-launcher ]; then
  : > "$prefix/lib/node_modules/openclaw/openclaw.mjs"
else
  printf '#!/usr/bin/env bash\\n%s\\n%s\\necho "OpenClaw %s (new)"\\n' "$said_who" "$first" "$want" > "$prefix/lib/node_modules/openclaw/openclaw.mjs"
fi
chmod 755 "$prefix/lib/node_modules/openclaw/openclaw.mjs"
printf '{"name":"openclaw","version":"%s"}' "$want" > "$prefix/lib/node_modules/openclaw/package.json"
ln -s ../lib/node_modules/openclaw/openclaw.mjs "$prefix/bin/openclaw"
exit 0
`);
    chmodSync(npm, 0o755);
    // A pin file the step reads its target from.
    const src = path.join(p.dir, "src");
    mkdirSync(path.join(src, "config"), { recursive: true });
    writeFileSync(path.join(src, "config", "openclaw-target.txt"), `${opts.pin ?? "2026.9.4"}\n`);
    const program = [
      opts.errexit ? "set -euo pipefail" : "set -uo pipefail",
      `NPM_PREFIX=${JSON.stringify(p.prefix)}`,
      `OPENCLAW_BIN=${JSON.stringify(path.join(p.prefix, "bin", "openclaw"))}`,
      `SRC_DIR=${JSON.stringify(src)}`,
      `CLAWBOX_HOME=${JSON.stringify(p.dir)}`,
      `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
      assignment("OPENCLAW_VERSION"),
      assignment("OPENCLAW_NODE_ENGINE"),
      assignment("OPENCLAW_SERVICE_REPAIR_POLICY"),
      "is_hermes_edition() { return 1; }",
      "ensure_clawbox_bashrc_path() { :; }",
      "ensure_openclaw_node_engine() { :; }",
      "node_engine_remedy() { :; }",
      opts.chownLog ? recursiveChownRecorder(opts.chownLog) : "chown() { :; }",
      shellFunctionIfPresent(INSTALL_SH, "hand_over_home_path"),
      `flush_core_to_disk() { printf 'flush %s\\n' "$1" >> ${calls}; }`,
      `stop_openclaw_gateways_for_migration() { printf 'stop-gateways\\n' >> ${calls}; }`,
      // Everything after the install is the migration and the plugin refresh,
      // which this suite is not about: the step is cut off after the install.
      "openclaw_version_is_v2() { return 1; }",
      'as_clawbox() { while [ "${1:-}" = "-H" ]; do shift; done; AS_SERVICE_USER=1 "$@"; }',
      // Marks the run as the service account only when -u names it: a switch to
      // root must still read as root.
      'runuser() { local who=""; [ "${1:-}" = "-u" ] && [ "${2:-}" = "$CLAWBOX_USER" ] && who=1; '
        + 'shift 2; [ "${1:-}" = "--" ] && shift; AS_SERVICE_USER=$who "$@"; }',
      // The locked prefix's own `as_clawbox`, with the -H the step passes.
      ...(opts.account
        ? [
          opts.account.shell,
          'eval "$(declare -f as_clawbox | sed \'1s/^as_clawbox /__ao_as_clawbox /\')"',
          'as_clawbox() { while [ "${1:-}" = "-H" ]; do shift; done; __ao_as_clawbox "$@"; }',
        ]
        : []),
      `systemctl() { printf 'systemctl %s\\n' "$*" >> ${calls}; }`,
      "has_openclaw_harness() { return 0; }",
      shellFunction("recover_parked_openclaw_core"),
      shellFunction("promote_staged_openclaw_core"),
      // Stubbed, never lifted: the step calls it with no arguments, which means
      // the REAL /usr and /usr/local. Its own suite hands it a tmp prefix
      // (install-shadowing-system-openclaw.test.ts).
      "remove_shadowing_system_openclaw() { :; }",
      // The migration disk pre-flight and verdict record have suites of their own
      // (install-openclaw-migration-preflight.test.ts); here they pass.
      `openclaw_migration_disk_preflight() { return ${opts.preflightFails ? 1 : 0}; }`,
      "openclaw_record_migration_verdict() { :; }",
      // The fast path and its marker have a suite of their own
      // (install-openclaw-fast-path.test.ts); every case here is a full path.
      'openclaw_refresh_fast_path_check() { OPENCLAW_REFRESH_WHY="fixture: full path"; return 1; }',
      "openclaw_refresh_marker_clear() { :; }",
      "openclaw_refresh_marker_write() { :; }",
      shellFunction("step_openclaw_install").replace(/\n  # Force-reinstall every externally-installed plugin[\s\S]*$/, "\n}"),
      opts.prelude ?? "",
      ...(opts.account ? ["__ao_lock"] : []),
      "step_openclaw_install",
    ].join("\n");
    return spawnSync("bash", ["-c", program], {
      encoding: "utf-8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, LAUNCHER_RUNS: path.join(p.dir, "launcher-runs") },
    });
  }

  /** The step's launcher runs, in order: `<root|service> <launcher> <args>`. */
  const launcherRuns = (p: Prefix) => {
    const file = path.join(p.dir, "launcher-runs");
    return existsSync(file) ? readFileSync(file, "utf-8").split("\n").filter(Boolean) : [];
  };
  const live = (p: Prefix) => `${p.prefix}/bin/openclaw --version`;
  const staged = (p: Prefix) => `${p.prefix}/.openclaw-stage/bin/openclaw --version`;

  // The npm prefix is an entry in the clawbox user's home: a recursive chown of
  // a path through it changes whatever tree a link there points at.
  const chownTargets = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []);

  it("hands the stage over from inside the npm prefix", () => {
    const p = makePrefix({});
    try {
      // A stage an earlier root run left, which the parked-core recovery could
      // not take away first.
      mkdirSync(path.join(p.prefix, ".openclaw-stage", "lib"), { recursive: true });
      const log = path.join(p.dir, "chown-targets");
      const r = runStep(p, { npm: "ok", chownLog: log, prelude: "recover_parked_openclaw_core() { :; }" });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(chownTargets(log)).toContain(path.join(realpathSync(p.prefix), ".openclaw-stage"));
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("changes nothing behind a link at the npm prefix", () => {
    const p = makePrefix({});
    try {
      const elsewhere = path.join(p.dir, "elsewhere");
      renameSync(p.prefix, elsewhere);
      symlinkSync(elsewhere, p.prefix);
      const log = path.join(p.dir, "chown-targets");
      const r = runStep(p, { npm: "ok", chownLog: log });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(chownTargets(log).filter((t) => t.startsWith(realpathSync(elsewhere)))).toEqual([]);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("installs into the stage, never the live prefix, and promotes only a launcher that answers", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "ok" });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const npmCall = p.calls().find((c) => c.startsWith("npm "));
      // The prefix npm was handed IS the stage, and only the stage.
      expect(npmCall?.split(" --prefix ")[1]).toBe(path.join(p.prefix, ".openclaw-stage"));
      expect(r.stdout).toContain("OpenClaw installed: OpenClaw 2026.9.4 (new)");
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.9.4");
      expect(existsSync(path.join(p.prefix, ".openclaw-stage"))).toBe(false);
      expect(p.calls().filter((c) => c.startsWith("flush ")).length).toBe(2);
      // Both launchers sit in the service account's npm prefix, so both are
      // asked as that account: the live core's version, then the staged gate.
      expect(launcherRuns(p)).toEqual([`service ${live(p)}`, `service ${staged(p)}`]);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("keeps the live core when the staged launcher answers nothing — the zero-length file the field boxes were left with", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "empty-launcher" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/answers nothing to --version/);
      // An empty launcher logs nothing of its own; the live core's run does.
      expect(launcherRuns(p)).toEqual([`service ${live(p)}`]);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
      expect(p.calls().some((c) => c.startsWith("flush "))).toBe(false);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("still refuses a launcher that answers nothing when the pin is a dist-tag", () => {
    // A tag resolves to whatever npm chose, so the version is not compared —
    // but "answers nothing" is the zero-length launcher, and that never goes
    // live whatever the target was.
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "empty-launcher", pin: "beta" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/answers nothing to --version/);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("promotes whatever version a dist-tag pin resolved to", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "wrong-version", pin: "beta" });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.1.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("keeps the live core when npm delivered a different version than the pin", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "wrong-version" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not 2026\.9\.4 — leaving the core on the box as it is/);
      expect(launcherRuns(p)).toEqual([`service ${live(p)}`, `service ${staged(p)}`]);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("compares the first line of everything the staged launcher said, stderr included", () => {
    // The gate captures stdout AND stderr: a line ahead of the banner is not
    // the pinned core answering, and that core does not go live.
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "stderr-first" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(
        "Error: the staged openclaw answers 'a line on stderr before the banner\nOpenClaw 2026.9.4 (new)' to --version, not 2026.9.4 — leaving the core on the box as it is",
      );
      expect(launcherRuns(p)).toEqual([`service ${live(p)}`, `service ${staged(p)}`]);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  // The stage sits in the npm prefix, an entry in the clawbox user's home:
  // the account makes it and removes it, after it is handed back.
  (CAN_LOCK_HOME ? it : it.skip)("makes and removes the stage as the account, on a prefix root cannot write", () => {
    const p = makePrefix({});
    try {
      const aux = path.join(p.dir, "aux");
      mkdirSync(aux);
      const account = accountOnlyHome(p.prefix, aux);
      const r = runStep(p, { npm: "wrong-version", account });
      unlockTree(p.prefix);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not 2026\.9\.4 — leaving the core on the box as it is/);
      expect(r.stderr).not.toMatch(/Permission denied/);
      expect(existsSync(path.join(p.prefix, ".openclaw-stage"))).toBe(false);
      expect(account.rootInHome().filter((l) => l.includes(".openclaw-stage"))).toEqual([]);
      const stage = path.join(p.prefix, ".openclaw-stage");
      expect(account.asClawbox().slice(0, 2)).toEqual([`rm -rf -- ${stage}`, `mkdir -p -- ${stage}`]);
      expect(account.asClawbox().at(-1)).toBe(`rm -rf -- ${stage}`);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      unlockTree(p.dir);
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  (CAN_LOCK_HOME ? it : it.skip)("still starts the gateway on the pre-flight's way out when the stage cannot be removed, under errexit", () => {
    const p = makePrefix({});
    try {
      // Only the removal of a stage npm filled fails: the step's own first
      // emptying of the stage is bare, as it always was. The prefix is one
      // only the account can write to, so a root removal standing in for the
      // account's would be logged.
      const aux = path.join(p.dir, "aux");
      mkdirSync(aux);
      const account = accountOnlyHome(p.prefix, aux);
      const failRm = 'eval "$(declare -f as_clawbox | sed \'1s/^as_clawbox /__ok_as_clawbox /\')"\n'
        + 'as_clawbox() { [ "$1" = rm ] && [ -e "${@: -1}/bin" ] && return 1; __ok_as_clawbox "$@"; }';
      const r = runStep(p, { npm: "ok", preflightFails: true, errexit: true, prelude: failRm, account });
      unlockTree(p.prefix);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cannot take over the databases on this box/);
      expect(p.calls()).toContain("systemctl start clawbox-gateway.service");
      expect(account.rootInHome().filter((l) => l.includes(".openclaw-stage"))).toEqual([]);
      expect(existsSync(path.join(p.prefix, ".openclaw-stage", "bin"))).toBe(true);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      unlockTree(p.dir);
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("keeps the live core when npm left no launcher at all", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "nothing" });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/npm left no openclaw launcher/);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});
