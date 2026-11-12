import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Runs real bash for every case: vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `do_rebuild` is the build inside `install.sh --step rebuild_reboot` — the
 * only thing that turns freshly pulled code into a dashboard. It had three
 * defects, all measured on the OpenClaw dev box on 2026-09-04 (TASK-709).
 *
 *  1. It deleted `.next` BEFORE building. So any failure past that line left
 *     the box with new code and NO build: `clawbox-setup` stopped by this same
 *     function and never started again, port 80 dead — while `clawbox-gateway`
 *     kept answering on 18789, so the box looked half-alive and the owner saw
 *     "Failed to get gateway config" over a cached page.
 *
 *  2. It read `bun run build`'s exit status as the verdict and nothing else.
 *     `bun run build` is `next build` PLUS the `postbuild` lifecycle script,
 *     and postbuild is what makes a build servable — BUILD_ID is written
 *     before any of it. So a "successful" build can still leave
 *     production-server.js crash-looping on
 *     `require("./.next/standalone/server.js")`. (postbuild itself exited 0
 *     over copies that had not happened until TASK-725; it fails now, and
 *     scripts/postbuild.sh has that suite. The check here is the one that also
 *     answers whether the build came from the checked-out commit.)
 *
 * The memory half of the same incident — the build being OOM-killed with
 * ollama, Kokoro and llama.cpp resident — was fixed on beta by
 * `free_memory_for_build`, which `do_rebuild` calls after the clawbox-setup
 * stop and which has its own suite (install-free-memory-before-build.test.ts).
 * Nothing here duplicates it; the stub below simply lets it run.
 *
 * These run the SHIPPED function bodies out of install.sh against stubs, so an
 * edit to install.sh is what the assertions see.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/**
 * One shell function, verbatim, closing brace included; "" when there is none.
 *
 * Anchored at a LINE START. `indexOf(name + "() {")` also matches inside a
 * longer identifier, so a future `pre_do_rebuild() {` above `do_rebuild` would
 * hand back the tail of that definition — and the "extracted whole" guard,
 * which checks the body STARTS with `name() {`, is satisfied by the suffix. The
 * harness would then run the wrong body and the suite would pass for the wrong
 * reason.
 */
function findShellFunction(name: string): string {
  const opener = new RegExp(`^${name}\\(\\) \\{$`, "m").exec(INSTALL_SH);
  if (!opener) return "";
  const start = opener.index;
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(name + " has no closing brace");
  return INSTALL_SH.slice(start, end + 2);
}

function shellFunction(name: string): string {
  const body = findShellFunction(name);
  if (!body) throw new Error(name + " not found in install.sh");
  return body;
}

/**
 * The helpers, all of them required.
 *
 * They were optional while they did not exist yet; they ship now, and a
 * tolerant lookup would be a hole: a renamed or deleted helper makes
 * `do_rebuild` fail with command-not-found, and every case asserting
 * `status).not.toBe(0)` would still pass — for the wrong reason.
 */
function shellFunctions(...names: string[]): string {
  return names.map((n) => shellFunction(n)).join("\n\n");
}

type BuildOutcome =
  /** BUILD_ID and a loadable standalone entry: a real build. */
  | "succeeds"
  /** SIGKILL from the global OOM killer: nothing written. */
  | "oom-killed"
  /** Exit 0, nothing written at all. */
  | "exits-zero-without-output"
  /** Exit 0 with BUILD_ID but no standalone entry: the half-run postbuild. */
  | "no-standalone-entry"
  /** Next's unwrapped standalone copy hits a file that vanished; the retry works. */
  | "trace-race-then-succeeds"
  /** A ROUTE copy hit a vanished file: Next warns and exits 0 short of it; the retry works. */
  | "copy-warning-then-succeeds"
  /** The same warning on every attempt, over a build that exits 0 each time. */
  | "copy-warning-always"
  /** The same ENOENT every time — a file that is gone for good, not a race. */
  | "trace-race-always";

interface Scenario {
  build?: BuildOutcome;
  /** What `scripts/verify-build-identity.sh` answers, or that it is absent. */
  identity?: "ok" | "drift" | "script-missing";
  /** Is there a servable build in `.next` before the rebuild? */
  previousBuild?: "servable" | "none";
  /**
   * Is there a build parked in `.next-old` by an earlier interrupted run?
   *
   * "nested-entry" is the layout `postbuild` supports when Next nests the
   * standalone tree: `standalone/server.js` is a SYMLINK to an absolute path
   * inside `.next`, which dangles for as long as the tree is parked.
   */
  parkedBuild?: "servable" | "nested-entry" | "none";
  /** Units `systemctl is-active --quiet` answers yes for at the start. */
  activeUnits?: string[];
  /**
   * Does the dashboard actually answer on :80 after the start?
   *
   * False models the REAL crash-loop, which is why the unit still goes active
   * here: clawbox-setup is `Type=simple` with `Restart=always`, so systemd
   * marks it active the instant node is forked — before production-server.js
   * has required the build. `systemctl is-active` therefore says yes about a
   * box whose port 80 is dead, and only an HTTP probe can tell them apart.
   */
  startWorks?: boolean;
  /**
   * Room on the filesystem for a second copy of the build.
   *
   * "tight" takes `set_previous_build_aside`'s no-fallback branch, where the
   * old build is deleted rather than parked — the case in which a failed
   * rebuild has nothing to roll back to.
   */
  diskHeadroom?: "ample" | "tight";
  bunInstall?: "succeeds" | "fails";
  /**
   * Does the kernel log actually show an OOM kill?
   *
   * A SIGKILL is not evidence of one — a stop timeout, `systemctl kill` and an
   * operator all arrive as signal 9 — so `oom_killer_in_kernel_log` is what
   * decides whether the failure sentence may name memory, and it is stubbed
   * here rather than left to read the machine running the suite.
   */
  oomEvidence?: boolean;
  /** Can `run_next_build` open its build log at all? */
  buildLog?: "writable" | "unwritable";
  nodePty?: "succeeds" | "fails";
  /**
   * The build takes node-pty down with it: its compiled module is gone by the
   * time do_rebuild restores the previous build, the state a rolled-back box
   * was left in with a dead web terminal (TASK-2244).
   */
  ptyBrokenByBuild?: boolean;
  /** How the rebuild that follows a rollback goes, when one runs. */
  ptyRebuildAfterRollback?: "works" | "fails";
  /** Which shipped function to run. */
  entry?: "do_rebuild" | "step_build";
  /** Call `do_rebuild --reboot-follows`, as step_rebuild_reboot's real arm does. */
  rebootFollows?: boolean;
  /**
   * `CLAWBOX_RESTORE_PROBE_WAIT_S` — how long restore_previous_build watches for
   * the dashboard before reporting it DOWN. Cut to seconds a test can afford to
   * let expire; the shipped default is 180.
   */
  probeWindow?: string;
  /** The serving build carries a framework cache (`.next/cache/entry`). */
  previousCache?: boolean;
  /**
   * projectDir as a real git checkout, and the shipped
   * build_type_check_proven_by_ci in place of the stub every other case gets.
   * Absent: projectDir is no checkout at all and the stub answers "not one".
   */
  checkout?: Checkout;
  /** is_test_mode answers yes, as it does under e2e-install's CLAWBOX_TEST_MODE=1. */
  testMode?: boolean;
}

/** The checkout run_next_build asks about before it builds. */
interface Checkout {
  /** The branch the checkout is on; origin carries it at the same commit. */
  branch: string;
  /** HEAD detached at that commit (applied before `ahead`). */
  detached?: boolean;
  /** One local commit origin does not have — on the branch, or on a detached HEAD. */
  ahead?: boolean;
  /** origin/<branch> has one commit the checkout has not got. */
  behind?: boolean;
  /** A tracked file edited and not committed. */
  edited?: boolean;
  /** A new file nothing ignores. */
  untracked?: boolean;
  /**
   * A change `git status` would not show on its own: a new page that
   * `.git/info/exclude` or the owner's global ignore file (at its default
   * place, `$XDG_CONFIG_HOME/git/ignore`) hides, or an edit to a tracked file
   * whose index entry tells git not to look (`--skip-worktree`,
   * `--assume-unchanged`).
   */
  hidden?: "info-exclude" | "global-ignore" | "skip-worktree" | "assume-unchanged";
  /**
   * A tracked `scripts/x.sh` without its executable bit and a tracked symlink
   * `src/link.ts`, then the rebuild step's own `chmod +x` over scripts/*.sh (as
   * every in-app update runs it before it builds), then this change or none.
   */
  modeFlip?: "only" | "edit" | "new" | "deleted" | "symlink-to-file" | "file-to-symlink";
  /** `.update-branch`, the pin the updater writes. */
  pin?: string;
  /** git fails: every call, or only `status`; or `ls-files -v` answers nothing with exit 0. */
  gitFails?: "all" | "status" | "tracked-list-empty";
}

interface Run {
  /** Wall time the whole shipped body took, which the poll's window bounds. */
  elapsedMs: number;
  status: number | null;
  stdout: string;
  stderr: string;
  systemctl: string[];
  buildId: string | null;
  hasEntry: boolean;
  parked: boolean;
  /**
   * What the parked tree said about its owner WHILE `bun run build` ran —
   * "live <pid>", "stale <pid>" or "none". The reclaim in production-server.js
   * has nothing else to go on: from the park until the standalone entry is
   * written there is no `.next/standalone/server.js`, which is the only thing
   * it looks at, and clawbox-setup can be up inside that window — routinely so
   * before TASK-728 removed `clawbox-gateway.service`'s `Wants=`, and still
   * through a hand-run `--step rebuild`, a box where gateway_setup is skipped,
   * or an operator restarting the web server.
   */
  buildSawOwner: string;
  /** Did a stamp survive into the tree the box is left serving? */
  ownerLeftBehind: boolean;
  /** How many times `bun run build` was actually invoked. */
  attempts: number;
  /** Does node-pty load on the box this leaves? */
  ptyLoadable: boolean;
  /** How many times ensure_node_pty ran. */
  ptyRebuilds: number;
  /** Every build command handed to as_clawbox_login, verbatim, in order. */
  buildCommands: string[];
  /** Each run of the checkout's identity script: `<root|service> <args>`. */
  identityRuns: string[];
}

let sandbox: string;
let systemctlLog: string;
let projectDir: string;
let ownerProbe: string;
let buildAttempts: string;
let unwritableTmp: string;
let ptyOk: string;
let ptyCalls: string;
let buildCommands: string;
let identityRuns: string;

/**
 * git with no config of the machine running the suite: no global or system
 * file (a `status.showUntrackedFiles` or a signing key there would change the
 * answers), no global ignore file but the sandbox's own, and no walking up out
 * of the sandbox into a repository above it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, "xdg"),
  };
}

function fixtureGit(...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", projectDir, ...args], {
    encoding: "utf-8",
    env: gitEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * The `chmod +x` over scripts/*.sh that step_directories_permissions runs as
 * the service account, verbatim. step_rebuild_reboot, the step every in-app
 * update dispatches, runs it first and builds after it.
 */
function rebuildChmodLine(): string {
  const line = shellFunction("step_directories_permissions").split("\n").map((l) => l.trim())
    .find((l) => l.startsWith('(cd / && as_clawbox find "$PROJECT_DIR/scripts"') && l.includes("chmod +x"));
  if (!line) throw new Error("step_directories_permissions no longer makes scripts/*.sh executable");
  return line;
}

/**
 * projectDir as the box keeps it after a sync: on `branch`, at origin's tip,
 * nothing changed — then whatever the case moves away from that.
 */
function setUpCheckout(c: Checkout): void {
  fixtureGit("init", "-q");
  fixtureGit("symbolic-ref", "HEAD", `refs/heads/${c.branch}`);
  // The entries of the repository's own .gitignore that cover what this
  // harness writes into projectDir.
  writeFileSync(path.join(projectDir, ".gitignore"), ".next/\n.next-old/\n.update-branch\n", "utf-8");
  mkdirSync(path.join(projectDir, "src"), { recursive: true });
  writeFileSync(path.join(projectDir, "src", "app.ts"), "export const app = 1;\n", "utf-8");
  if (c.modeFlip) {
    mkdirSync(path.join(projectDir, "scripts"), { recursive: true });
    writeFileSync(path.join(projectDir, "scripts", "x.sh"), "echo x\n", { encoding: "utf-8", mode: 0o644 });
    symlinkSync("app.ts", path.join(projectDir, "src", "link.ts"));
  }
  fixtureGit("add", "-A");
  fixtureGit("commit", "-q", "-m", "base");
  fixtureGit("update-ref", `refs/remotes/origin/${c.branch}`, "HEAD");
  if (c.modeFlip) {
    if (fixtureGit("ls-files", "-s", "scripts/x.sh").split(" ")[0] !== "100644") throw new Error("scripts/x.sh is not tracked as 100644");
    const chmod = rebuildChmodLine();
    // The suite's own user owns the fixture, so the account is that user here.
    const r = spawnSync("bash", ["-c", `as_clawbox() { "$@"; }\n${chmod}`], {
      encoding: "utf-8",
      env: { ...gitEnv(), PROJECT_DIR: projectDir },
    });
    if (r.status !== 0) throw new Error(`${chmod} failed: ${r.stderr}`);
    const src = (name: string) => path.join(projectDir, "src", name);
    if (c.modeFlip === "edit") writeFileSync(path.join(projectDir, "scripts", "x.sh"), "echo y\n", "utf-8");
    if (c.modeFlip === "new") writeFileSync(src("fresh.ts"), "export const fresh = 1;\n", "utf-8");
    if (c.modeFlip === "deleted") rmSync(src("app.ts"));
    if (c.modeFlip === "symlink-to-file") {
      rmSync(src("link.ts"));
      writeFileSync(src("link.ts"), "export const link = 1;\n", "utf-8");
    }
    if (c.modeFlip === "file-to-symlink") {
      rmSync(src("app.ts"));
      symlinkSync("link-target.ts", src("app.ts"));
    }
  }
  if (c.behind) {
    const next = fixtureGit("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "landed on origin");
    fixtureGit("update-ref", `refs/remotes/origin/${c.branch}`, next);
  }
  if (c.detached) fixtureGit("checkout", "-q", "--detach");
  if (c.ahead) {
    writeFileSync(path.join(projectDir, "src", "local.ts"), "export const local = 1;\n", "utf-8");
    fixtureGit("add", "src/local.ts");
    fixtureGit("commit", "-q", "-m", "local");
  }
  if (c.edited) writeFileSync(path.join(projectDir, "src", "app.ts"), "export const app = 2;\n", "utf-8");
  if (c.untracked) writeFileSync(path.join(projectDir, "src", "new.ts"), "export const fresh = 1;\n", "utf-8");
  if (c.hidden === "info-exclude" || c.hidden === "global-ignore") {
    const page = c.hidden === "info-exclude" ? "x" : "y";
    mkdirSync(path.join(projectDir, "src", "app", page), { recursive: true });
    writeFileSync(path.join(projectDir, "src", "app", page, "page.tsx"), "export default function P() { return null; }\n", "utf-8");
    const ignoreFile = c.hidden === "info-exclude"
      ? path.join(projectDir, ".git", "info", "exclude")
      : path.join(sandbox, "xdg", "git", "ignore");
    mkdirSync(path.dirname(ignoreFile), { recursive: true });
    writeFileSync(ignoreFile, `src/app/${page}/\n`, { encoding: "utf-8", flag: "a" });
  }
  if (c.hidden === "skip-worktree" || c.hidden === "assume-unchanged") {
    writeFileSync(path.join(projectDir, "src", "app.ts"), "export const app = 3;\n", "utf-8");
    fixtureGit("update-index", `--${c.hidden}`, "src/app.ts");
  }
  if (c.pin !== undefined) writeFileSync(path.join(projectDir, ".update-branch"), c.pin + "\n", "utf-8");
}

/**
 * The shipped probe and its path-list helper, replacing the "not a checkout"
 * stub. findShellFunction, not shellFunction: on a tree without the probe the
 * slice is empty and run_next_build simply builds as before, so a case fails on
 * what it asserts about the build rather than on a missing function; "is
 * extracted whole" below holds both to existing. The root-side branch
 * resolution is defined too, so a probe that called it would run it and the
 * owner-only case below would see it.
 */
function checkoutLines(c: Checkout): string[] {
  return [
    // Only the checkout picks the branch, never the environment of the runner.
    'CLAWBOX_BRANCH=""',
    ...(c.gitFails === "all" ? ['git() { echo "fatal: not a git repository" >&2; return 128; }'] : []),
    ...(c.gitFails === "status"
      ? ['git() { case " $* " in *" status "*) echo "fatal: index file corrupt" >&2; return 128 ;; esac; command git "$@"; }']
      : []),
    ...(c.gitFails === "tracked-list-empty"
      ? ['git() { case " $* " in *" ls-files -v "*) return 0 ;; esac; command git "$@"; }']
      : []),
    shellFunctions("is_safe_git_ref", "recover_detached_branch", "resolve_update_branch"),
    "",
    findShellFunction("first_paths"),
    "",
    findShellFunction("build_type_check_proven_by_ci"),
    "",
  ];
}

function writeBuild(dir: string, buildId: string, withEntry = true): void {
  mkdirSync(path.join(dir, "standalone"), { recursive: true });
  writeFileSync(path.join(dir, "BUILD_ID"), buildId + "\n", "utf-8");
  if (withEntry) writeFileSync(path.join(dir, "standalone", "server.js"), "// server\n", "utf-8");
}

function run(scenario: Scenario = {}): Run {
  const {
    build = "succeeds",
    identity = "ok",
    previousBuild = "servable",
    parkedBuild = "none",
    activeUnits = ["ollama.service"],
    startWorks = true,
    diskHeadroom = "ample",
    bunInstall = "succeeds",
    oomEvidence = false,
    nodePty = "succeeds",
    buildLog = "writable",
    entry = "do_rebuild",
    rebootFollows = false,
    probeWindow = "2",
    previousCache = false,
    ptyBrokenByBuild = false,
    ptyRebuildAfterRollback = "works",
    checkout,
    testMode = false,
  } = scenario;
  // `step_build` calls run_next_build directly and ignores its arguments, so
  // pairing it with the flag would silently omit the behaviour and read as
  // coverage of it.
  if (rebootFollows && entry !== "do_rebuild") {
    throw new Error("rebootFollows only means anything for do_rebuild");
  }

  // Per RUN, not per test: a case that calls this twice must not read the
  // first build's attempts as the second's.
  rmSync(buildAttempts, { force: true });
  rmSync(ptyCalls, { force: true });
  rmSync(buildCommands, { force: true });
  // The box starts with a node-pty that loads, as one with a working terminal.
  writeFileSync(ptyOk, "", "utf-8");
  mkdirSync(projectDir, { recursive: true });
  if (previousBuild === "servable") writeBuild(path.join(projectDir, ".next"), "old-build-id");
  if (previousCache) {
    mkdirSync(path.join(projectDir, ".next", "cache"), { recursive: true });
    writeFileSync(path.join(projectDir, ".next", "cache", "entry"), "warm\n", "utf-8");
  }
  if (parkedBuild === "servable") {
    writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");
    // With the stamp the earlier, killed run left on it. Without this the
    // `rm -f "$build_dir/.rebuild-pid"` promote_parked_build performs has
    // nothing to strip, and the case asserting it does would pass with that
    // line deleted.
    writeFileSync(path.join(projectDir, ".next-old", ".rebuild-pid"), "999999 stale-boot\n", "utf-8");
  }
  if (parkedBuild === "nested-entry") {
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id", false);
    mkdirSync(path.join(kept, "standalone", "nested"), { recursive: true });
    writeFileSync(path.join(kept, "standalone", "nested", "server.js"), "// server\n", "utf-8");
    // Exactly what postbuild writes: an ABSOLUTE path through `.next`, which
    // does not exist while the tree is parked under `.next-old`.
    symlinkSync(
      path.join(projectDir, ".next", "standalone", "nested", "server.js"),
      path.join(kept, "standalone", "server.js"),
    );
  }

  rmSync(identityRuns, { force: true });
  if (identity !== "script-missing") {
    mkdirSync(path.join(projectDir, "scripts"), { recursive: true });
    // The script is a file in the service account's checkout: it says who ran it.
    const saidWho = `[ -n "\${AS_SERVICE_USER:-}" ] && who=service || who=root; echo "$who $*" >> ${JSON.stringify(identityRuns)}\n`;
    writeFileSync(
      path.join(projectDir, "scripts", "verify-build-identity.sh"),
      "#!/usr/bin/env bash\n" + saidWho
        + (identity === "ok" ? "exit 0\n" : "echo 'BUILD IDENTITY: FAIL' >&2\nexit 1\n"),
      "utf-8",
    );
  }
  if (checkout) setUpCheckout(checkout);

  // Stands in for `bun run build`. The four outcomes are the four the box can
  // produce, including the two that exit 0 without leaving a servable build.
  const fakeBuild = path.join(sandbox, "fake-build.sh");
  const bodies: Record<BuildOutcome, string> = {
    succeeds: 'mkdir -p "$1/.next/standalone" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && printf "// server\\n" > "$1/.next/standalone/server.js" && exit 0',
    "oom-killed": 'echo "Killed" >&2; exit 137',
    "exits-zero-without-output": "exit 0",
    "no-standalone-entry": 'mkdir -p "$1/.next" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && exit 0',
    // The message node throws out of `fs.promises.copyFile`, which Next's
    // standalone copy does NOT catch for the middleware and instrumentation
    // traces. Verbatim, because the retry is gated on recognising it.
    "trace-race-then-succeeds": [
      'if [ "$ATTEMPT" = "1" ]; then',
      `  echo "Error: ENOENT: no such file or directory, copyfile '$1/data/webapps/demo/index.html' -> '$1/.next/standalone/data/webapps/demo/index.html'" >&2`,
      "  exit 1",
      "fi",
      'mkdir -p "$1/.next/standalone" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && printf "// server\\n" > "$1/.next/standalone/server.js" && exit 0',
    ].join("\n"),
    // The shape Next prints from inside the `.catch` it wraps the ROUTE copies
    // in: a warning, the same node message, and exit 0 over a tree short of it.
    "copy-warning-then-succeeds": [
      'mkdir -p "$1/.next/standalone" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && printf "// server\\n" > "$1/.next/standalone/server.js"',
      'if [ "$ATTEMPT" = "1" ]; then',
      `  echo " ⚠ Failed to copy traced files for $1/.next/server/app/api/route.js Error: ENOENT: no such file or directory, copyfile '$1/node_modules/a/index.js' -> '$1/.next/standalone/node_modules/a/index.js'" >&2`,
      "fi",
      "exit 0",
    ].join("\n"),
    "copy-warning-always": [
      'mkdir -p "$1/.next/standalone" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && printf "// server\\n" > "$1/.next/standalone/server.js"',
      `echo " ⚠ Failed to copy traced files for $1/.next/server/app/api/route.js Error: ENOENT: no such file or directory, copyfile '$1/node_modules/a/index.js' -> '$1/.next/standalone/node_modules/a/index.js'" >&2`,
      "exit 0",
    ].join("\n"),
    "trace-race-always": [
      `echo "Error: ENOENT: no such file or directory, copyfile '$1/data/webapps/demo/index.html' -> '$1/.next/standalone/data/webapps/demo/index.html'" >&2`,
      "exit 1",
    ].join("\n"),
  };
  // Sampled from inside the build, because that is the only moment the
  // question matters: the reclaim fires on a box whose `bun run build` is
  // still running.
  const probeOwner = [
    'OWNER_FILE="$1/.next-old/.rebuild-pid"',
    'if [ -f "$OWNER_FILE" ]; then',
    // The same three questions production-server.js asks, in the same order.
    '  read -r OWNER_PID OWNER_BOOT OWNER_START REST < "$OWNER_FILE"',
    '  THIS_BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)',
    '  LIVE_START=$(sed -e "s/^.*) //" "/proc/$OWNER_PID/stat" 2>/dev/null | awk "{print \\$20}")',
    '  if [ -z "$REST" ] && [ -n "$OWNER_BOOT" ] && [ "$OWNER_BOOT" = "$THIS_BOOT" ] \\',
    '     && [ -n "$OWNER_START" ] && [ "$OWNER_START" = "$LIVE_START" ]; then',
    '    printf "live %s\\n" "$OWNER_PID" > ' + JSON.stringify(ownerProbe),
    "  else",
    '    printf "stale %s\\n" "$OWNER_PID" > ' + JSON.stringify(ownerProbe),
    "  fi",
    "else",
    '  printf "none\\n" > ' + JSON.stringify(ownerProbe),
    "fi",
  ].join("\n");
  // Counts its own invocations, because "was the build run twice?" is the
  // whole question for the retry cases — and the guard that a build which
  // failed for any other reason is still run exactly once.
  const countAttempt = [
    "ATTEMPTS_FILE=" + JSON.stringify(buildAttempts),
    'ATTEMPT=$(( $(cat "$ATTEMPTS_FILE" 2>/dev/null || echo 0) + 1 ))',
    'printf "%s\\n" "$ATTEMPT" > "$ATTEMPTS_FILE"',
  ].join("\n");
  writeFileSync(
    fakeBuild,
    "#!/usr/bin/env bash\n" + countAttempt + "\n" + probeOwner + "\n"
      + (ptyBrokenByBuild ? "rm -f " + JSON.stringify(ptyOk) + "\n" : "")
      + bodies[build] + "\n",
    "utf-8",
  );
  spawnSync("chmod", ["+x", fakeBuild]);

  const lines = [
    "set -euo pipefail",
    "",
    "PROJECT_DIR=" + JSON.stringify(projectDir),
    // A /tmp the box cannot write — a Jetson tmpfs under exactly the memory
    // pressure free_memory_for_build exists for, or a full eMMC.
    "TMPDIR=" + JSON.stringify(buildLog === "unwritable" ? unwritableTmp : sandbox),
    "CLAWBOX_USER=clawbox",
    "CLAWBOX_HOME=" + JSON.stringify(sandbox),
    "BUN=/nonexistent/bun",
    "FAKE_BUILD=" + JSON.stringify(fakeBuild),
    "SYSTEMCTL_LOG=" + JSON.stringify(systemctlLog),
    'ACTIVE_UNITS="' + activeUnits.join(" ") + '"',
    'START_WORKS=' + (startWorks ? "1" : "0"),
    "DASHBOARD_UP=0",
    'DISK_HEADROOM=' + JSON.stringify(diskHeadroom),
    "",
    `is_test_mode() { return ${testMode ? 0 : 1}; }`,
    // run_next_build asks whether CI already type-checked this tree. projectDir
    // is no checkout unless the case sets `checkout`, so the answer is no; those
    // cases replace this with the shipped function, further down.
    'build_type_check_proven_by_ci() { echo "not a checkout"; return 1; }',
    "BUILD_COMMANDS=" + JSON.stringify(buildCommands),
    // wait_note's bucket state, a top-level assignment in install.sh: under
    // `set -u` an unset one ends the slice on the first heartbeat check.
    'WAIT_NOTE_EVERY_S=30',
    'WAIT_NOTE_LAST=""',
    "# The readiness poll waits a real second per attempt. The LOOP is the",
    "# subject, not the wall clock, so the wait is a no-op here and all twenty",
    "# attempts run instantly.",
    "sleep() { :; }",
    "# The cache carry moves the parked build's .next/cache as clawbox; here that",
    "# is whoever runs the test. Both account switches mark what they run as the",
    "# service account's.",
    'as_clawbox() { AS_SERVICE_USER=1 "$@"; }',
    // Marks the run as the service account only when -u names it: a switch to
    // root must still read as root.
    'runuser() { local who=""; [ "${1:-}" = "-u" ] && [ "${2:-}" = "$CLAWBOX_USER" ] && who=1; '
      + 'shift 2; [ "${1:-}" = "--" ] && shift; AS_SERVICE_USER=$who "$@"; }',
    // node-pty's state is a file: present while the module loads. The first
    // run is do_rebuild's own, before the build; a second can only be the
    // rebuild after a rollback. Logged beside systemctl so the order shows.
    "PTY_OK=" + JSON.stringify(ptyOk),
    "PTY_CALLS=" + JSON.stringify(ptyCalls),
    "ensure_node_pty() {",
    '  local n=$(( $(cat "$PTY_CALLS" 2>/dev/null || echo 0) + 1 ))',
    '  printf "%s\\n" "$n" > "$PTY_CALLS"',
    '  printf "ensure_node_pty\\n" >> "$SYSTEMCTL_LOG"',
    '  if [ "$n" -eq 1 ]; then',
    nodePty === "succeeds"
      ? "    : > \"$PTY_OK\"; echo '  node-pty is already loadable'"
      : [
        '    rm -f "$PTY_OK"',
        "    NODE_PTY_FAILURE='../../node-addon-api/napi.h:13:10: fatal error: node_api.h: No such file or directory'",
        '    echo "Error: node-pty is still not loadable after rebuild: $NODE_PTY_FAILURE." >&2; return 1',
      ].join("\n"),
    "  else",
    ptyRebuildAfterRollback === "works"
      ? "    : > \"$PTY_OK\"; echo '  node-pty rebuilt and verified'"
      : [
        "    NODE_PTY_FAILURE='../src/unix/pty.cc:42:1: error: forkpty was not declared in this scope'",
        "    echo '    | gyp ERR! not ok'",
        '    echo "Error: node-pty is still not loadable after rebuild: $NODE_PTY_FAILURE." >&2; return 1',
      ].join("\n"),
    "  fi",
    "}",
    "",
    "# The build runs as the clawbox user through this one seam. `bun install`",
    "# has an outcome of its own because it sits inside the window where the",
    "# dashboard is down.",
    "as_clawbox_login() {",
    '  case "$*" in',
    // Recorded verbatim: `su -` clears the environment, so whatever the build
    // is told has to be inside this string.
    '    *"run build"*) printf "%s\\n" "$*" >> "$BUILD_COMMANDS"; "$FAKE_BUILD" "$PROJECT_DIR" ;;',
    "    *\"require('node-pty')\"*) [ -f \"$PTY_OK\" ] ;;",
    bunInstall === "succeeds" ? "    *) return 0 ;;" : '    *"install"*) return 1 ;;\n    *) return 0 ;;',
    "  esac",
    "}",
    "",
    "systemctl() {",
    '  printf "%s\\n" "systemctl $*" >> "$SYSTEMCTL_LOG"',
    "  # `Type=simple`: systemd marks the unit active as soon as ExecStart is",
    "  # forked, whether or not the process can load the build. So `start`",
    "  # ALWAYS makes is-active true here, and only the HTTP stub below knows",
    "  # whether the dashboard came up.",
    '  if [ "$1" = "start" ] || [ "$1" = "restart" ]; then',
    '    ACTIVE_UNITS="$ACTIVE_UNITS $2"',
    '    [ "$START_WORKS" = "1" ] && DASHBOARD_UP=1',
    "    return 0",
    "  fi",
    '  if [ "$1" = "stop" ]; then',
    '    local kept="" u',
    '    for u in $ACTIVE_UNITS; do [ "$u" = "$2" ] || kept="$kept $u"; done',
    '    ACTIVE_UNITS="$kept"',
    "    return 0",
    "  fi",
    '  if [ "$1" = "is-active" ]; then',
    "    for u in $ACTIVE_UNITS; do",
    '      for a in "$@"; do [ "$a" = "$u" ] && return 0; done',
    "    done",
    "    return 3",
    "  fi",
    "  return 0",
    "}",
    "",
    "# The dashboard's own answer, which is what restore_previous_build asks",
    "# for. `command -v curl` finds a shell function, so the missing-curl arm",
    "# stays unreached here and has its own case.",
    "curl() {",
    '  if [ "$DASHBOARD_UP" = "1" ]; then printf "200"; return 0; fi',
    '  printf "000"',
    "  return 7",
    "}",
    "",
    "# Free space on the build's filesystem. `tight` reports less than twice the",
    "# tree's size, which is set_previous_build_aside's no-fallback threshold.",
    "df() {",
    '  if [ "$DISK_HEADROOM" = "tight" ]; then',
    '    printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 99 1 99%% /\\n"',
    "  else",
    '    printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 1 99999999 1%% /\\n"',
    "  fi",
    "}",
    "",
    "# beta's own memory reclaim, and the two verbs that account for what it",
    "# took — do_rebuild ends in one or the other on every exit. Their",
    "# behaviour has its own suite; here they only have to be present,",
    "# harmless and OBSERVABLE, so the arm that hands the engines to a reboot",
    "# can be told from the arm that starts them. Both are stubbed",
    "# unconditionally: an unstubbed one would be a 127 inside the updater's",
    "# own rebuild step with every suite still green.",
    "ensure_build_swap() { return 0; }",
    // Says which arm it was handed: on the reboot path it pauses the gateway
    // itself; everywhere else the room is judged just before the build.
    'free_memory_for_build() { echo "FREED:${1:-routine}"; }',
    // TASK-1197's pair, stubbed for the same reason as the rest: present,
    // harmless and observable. The judgement echoes whether the build's own
    // bun install had already run, which is the ordering it exists for.
    'pause_gateway_if_build_needs_room() { echo "GATEWAY-ROOM-JUDGED"; }',
    'report_gateway_build_pause() { echo "GATEWAY-PAUSE-REPORTED"; }',
    // Stubbed unconditionally, like the pair above: unstubbed it would read
    // the kernel log of whatever machine runs the suite, so a box that really
    // had OOM-killed something in the last fifteen minutes would flip the
    // assertion. `return 1` is "no OOM kill in the log".
    `oom_killer_in_kernel_log() { return ${oomEvidence ? 0 : 1}; }`,
    // Also says whether the parked build was still on disk when the engines
    // came back: on success they are handed back BEFORE its `rm -rf`.
    'resume_paused_engines() { echo "RESUMED"; if [ -d "$PROJECT_DIR/.next-old" ]; then echo "RESUMED-BEFORE-CLEANUP"; fi; }',
    'forget_paused_engines() { echo "FORGOT"; }',
    "",
    shellFunctions(
      // The non-time exit restore_previous_build's poll asks before its own
      // window: has clawbox-setup stopped trying? Sliced out of install.sh like
      // everything else, so a rename fails loudly here instead of silently
      // turning the poll into a 127 inside the rollback path.
      "unit_is_coming_up",
      // The heartbeat that makes a long wait readable rather than a hang.
      "wait_note",
      "build_entry_present",
      "verify_build_present",
      // The drain promote_parked_build calls before it decides anything
      // (TASK-729). Unsourced it is a 127 inside do_rebuild's first statement.
      "drain_build_transients",
      "promote_parked_build",
      "set_previous_build_aside",
      // The parked build's .next/cache into the new one, between the park
      // and the build.
      "carry_build_cache",
      "restore_previous_build",
      "run_next_build",
      // The rebuild a rollback ends with (TASK-2244), against the stub above.
      "ensure_node_pty_after_rollback",
    ),
    "",
    ...(checkout ? checkoutLines(checkout) : []),
    shellFunction(entry),
    "",
    rebootFollows ? `${entry} --reboot-follows` : entry,
    "",
  ];

  const scriptPath = path.join(sandbox, "run.sh");
  writeFileSync(scriptPath, lines.join("\n"), "utf-8");
  // restore_previous_build's poll measures WALL time now, not iterations — which
  // is the point of it (a no-op `sleep` stub used to make its 20 turns instant
  // while a real box spent the probe's own `--max-time 5` on each one). So the
  // window has to be cut to something a test can afford to let expire, exactly
  // as the hermes harness cuts its restart budget.
  const startedAt = Date.now();
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    cwd: REPO,
    env: { ...gitEnv(), CLAWBOX_RESTORE_PROBE_WAIT_S: probeWindow },
  });
  const elapsedMs = Date.now() - startedAt;
  const log = existsSync(systemctlLog)
    ? readFileSync(systemctlLog, "utf-8").split("\n").filter(Boolean)
    : [];
  const buildIdPath = path.join(projectDir, ".next", "BUILD_ID");
  return {
    elapsedMs,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    systemctl: log,
    buildId: existsSync(buildIdPath) ? readFileSync(buildIdPath, "utf-8").trim() : null,
    hasEntry: existsSync(path.join(projectDir, ".next", "standalone", "server.js")),
    parked: existsSync(path.join(projectDir, ".next-old")),
    buildSawOwner: existsSync(ownerProbe) ? readFileSync(ownerProbe, "utf-8").trim() : "not-run",
    ownerLeftBehind: existsSync(path.join(projectDir, ".next", ".rebuild-pid")),
    attempts: existsSync(buildAttempts)
      ? Number(readFileSync(buildAttempts, "utf-8").trim())
      : 0,
    ptyLoadable: existsSync(ptyOk),
    ptyRebuilds: existsSync(ptyCalls) ? Number(readFileSync(ptyCalls, "utf-8").trim()) : 0,
    buildCommands: existsSync(buildCommands)
      ? readFileSync(buildCommands, "utf-8").split("\n").filter(Boolean)
      : [],
    identityRuns: existsSync(identityRuns) ? readFileSync(identityRuns, "utf-8").split("\n").filter(Boolean) : [],
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "clawbox-rebuild-"));
  systemctlLog = path.join(sandbox, "systemctl.log");
  projectDir = path.join(sandbox, "clawbox");
  ownerProbe = path.join(sandbox, "parked-owner.txt");
  buildAttempts = path.join(sandbox, "build-attempts.txt");
  // A regular FILE, not a 0500 directory: mode bits do not stop UID 0, so a
  // suite running as root would create the log inside it and skip the very
  // fallback these cases exist for. A file makes `mktemp -d` under it fail
  // with ENOTDIR whoever runs the tests.
  unwritableTmp = path.join(sandbox, "no-write");
  ptyOk = path.join(sandbox, "node-pty-loads");
  ptyCalls = path.join(sandbox, "ensure-node-pty-calls.txt");
  buildCommands = path.join(sandbox, "build-commands.txt");
  identityRuns = path.join(sandbox, "identity-runs.txt");
  writeFileSync(unwritableTmp, "", "utf-8");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the shipped function bodies these tests run", () => {
  // findShellFunction slices to the first line starting with `}`. That is true
  // of every function it reads today, and silently wrong the day one grows a
  // heredoc or an indented closing brace at column 0 — the tests would then
  // assert against a fragment and pass for the wrong reason.
  it.each([
    "do_rebuild", "step_build", "verify_build_present", "restore_previous_build", "run_next_build",
    "build_type_check_proven_by_ci", "first_paths",
  ])(
    "%s is extracted whole",
    (name) => {
      const body = shellFunction(name);
      expect(body.startsWith(name + "() {")).toBe(true);
      expect(body.endsWith("\n}")).toBe(true);
      // A fragment would not carry the function's last statement; every one of
      // these ends in a return, an echo or a cleanup, never mid-`if`.
      expect(body).not.toMatch(/\n\s*(if|while|case)[^\n]*\n\}$/);
    },
  );
});

describe("do_rebuild verifies the build it produced", () => {
  it("succeeds when the build writes a loadable standalone entry", () => {
    const r = run({ build: "succeeds" });
    expect(r.status).toBe(0);
    expect(r.buildId).toBe("new-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("carries the serving build's .next/cache into the new build instead of deleting it with the park", () => {
    const r = run({ build: "succeeds", previousCache: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.buildId).toBe("new-build-id");
    expect(r.stdout).toContain("Keeping the build cache (.next/cache) for this build");
    expect(readFileSync(path.join(projectDir, ".next", "cache", "entry"), "utf-8")).toBe("warm\n");
    expect(existsSync(path.join(projectDir, ".next-old")), "the parked build was left behind").toBe(false);
  });

  it("fails when the build exits 0 without producing anything", () => {
    const r = run({ build: "exits-zero-without-output" });
    expect(r.status).not.toBe(0);
  });

  it("fails when the build is OOM-killed", () => {
    expect(run({ build: "oom-killed" }).status).not.toBe(0);
  });

  // The false success the first version of this fix would still have had:
  // BUILD_ID is written by `next build`, and `postbuild` — which copies the
  // standalone entry, the static assets and the identity stamp — runs after it
  // and can exit 0 having copied nothing. production-server.js does
  // `require("./.next/standalone/server.js")`, so BUILD_ID alone green-lights a
  // box that cannot boot.
  it("fails when the build leaves no server entry for the dashboard to load", () => {
    const r = run({ build: "no-standalone-entry" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/standalone\/server\.js/);
  });

  it("fails when the build on disk is not the checked-out commit", () => {
    // Asked through scripts/verify-build-identity.sh, the copy CI runs too —
    // not a second implementation of the comparison.
    const r = run({ build: "succeeds", identity: "drift" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
  });

  it("rebuilds once when a file the build was tracing vanished under it", () => {
    // TASK-670. Next copies the middleware and instrumentation file traces
    // with NO error handling — the page and app-page copies are `.catch`
    // wrapped, those two are not (node_modules/next/dist/build/utils.js on
    // 16.3.3) — and both traces carry the project root as an asset directory,
    // data/webapps and data/code-projects included (measured on the OpenClaw
    // box). So a web app the agent creates or removes while the build runs
    // kills `next build` with ENOENT during the standalone copy, and the whole
    // update dies on a file nobody needed. The next trace cannot list a file
    // that is gone, so one rebuild is the whole repair.
    const r = run({ build: "trace-race-then-succeeds" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.buildId).toBe("new-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("gives up after ONE retry when the same file is still missing", () => {
    // A file that is gone for good is not a race, and a second five-minute
    // build is all this may ever spend finding that out.
    const r = run({ build: "trace-race-always" });
    expect(r.status).not.toBe(0);
    expect(r.attempts).toBe(2);
    // The box keeps serving what it was serving.
    expect(r.buildId).toBe("old-build-id");
  });

  it("retries a copy Next only warned about, and accepts the build that copied everything (TASK-1102)", () => {
    // For a ROUTE, Next catches the failed copy, warns and exits 0. The tree
    // it leaves is short of that file, so it is the same race and gets the
    // same one rebuild.
    const r = run({ build: "copy-warning-then-succeeds" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.buildId).toBe("new-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("fails a build that exited 0 but still could not copy a traced file after the retry", () => {
    // Exit 0 is not the verdict: rc must be non-zero on any build or copy
    // failure, and the box keeps serving what it was serving.
    const r = run({ build: "copy-warning-always" });
    expect(r.status).not.toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.stderr).toContain("could not copy every traced file");
    expect(r.buildId).toBe("old-build-id");
  });

  it("gives the full-install build the same retry", () => {
    // `install.sh --step build` is dispatchable on a live box, so it races the
    // same writers do_rebuild does.
    const r = run({ build: "trace-race-then-succeeds", entry: "step_build" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.hasEntry).toBe(true);
  });

  it("runs the build exactly once when it works", () => {
    // The other half of the retry cases: a loop that always ran twice would
    // satisfy every one of them and double every healthy update.
    expect(run({ build: "succeeds" }).attempts).toBe(1);
  });

  it("still succeeds when it cannot open a build log at all", () => {
    // The log is a debugging convenience for the retry gate, not a
    // precondition of building. A /tmp the box cannot write must cost the
    // RETRY, never the build — `tee`'s status is not the build's, and
    // verify_build_present is what catches a build that produced nothing.
    const r = run({ build: "succeeds", buildLog: "unwritable" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.buildId).toBe("new-build-id");
    expect(r.hasEntry).toBe(true);
    expect(r.stdout).toContain("could not open a build log");
  });

  it("still runs the build at all when it cannot open a build log", () => {
    // `step_build` calls the helper BARE, with errexit live: a failure while
    // opening the log there would abort the script before the build ran.
    const r = run({ build: "succeeds", buildLog: "unwritable", entry: "step_build" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.hasEntry).toBe(true);
  });

  it("does not retry a build that failed for any other reason", () => {
    // A retry over a real failure buys the owner a second wait and the same
    // answer, and hides which attempt the error came from.
    expect(run({ build: "oom-killed" }).attempts).toBe(1);
    expect(run({ build: "no-standalone-entry" }).attempts).toBe(1);
  });

  it("warns rather than failing when the identity script is not on disk", () => {
    const r = run({ build: "succeeds", identity: "script-missing" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/verify-build-identity\.sh is missing/);
  });

  it("runs the checkout's identity script as the service account, never as root, with the same outcome", () => {
    // The script is a file in the account's checkout, so root does not run it.
    const asked = `service --project-dir ${projectDir} --quiet`;
    const ok = run({ build: "succeeds", identity: "ok" });
    expect(ok.status).toBe(0);
    expect(ok.buildId).toBe("new-build-id");
    expect(ok.identityRuns).toEqual([asked]);

    const drift = run({ build: "succeeds", identity: "drift" });
    expect(drift.status).not.toBe(0);
    expect(drift.buildId).toBe("old-build-id");
    expect(drift.stderr).toContain("BUILD IDENTITY: FAIL\nError: the build on disk does not match the checked-out commit\n");
    expect(drift.identityRuns).toEqual([asked]);
  });
});

/**
 * The evidence half of the failure sentence, run for real.
 *
 * Everywhere else in this file `oom_killer_in_kernel_log` is STUBBED, so the
 * shipped body had no coverage at all — and it shipped broken: `grep -q` exits
 * on its first match and SIGPIPEs the producer, which under install.sh's
 * `pipefail` makes the pipeline non-zero and reads as "no OOM kill". The match
 * being EARLY in a long log is what triggers it, which is the normal shape of a
 * kernel log on a box that went on running afterwards.
 */
/**
 * Next's own type check is 77 s of a 113 s `bun run build` on an 8 GB board,
 * with a ~1 GB heap of its own. A box may leave it to CI only for a tree CI has
 * already checked: ON branch beta or main, HEAD exactly origin's fetched tip,
 * nothing changed or added. Every other build — another branch, a detached
 * HEAD even at the tip, a commit ahead or behind, an edit or a new file, one
 * hidden from `git status`, a git that cannot answer, test mode — keeps the
 * check, says so in its own command (`=0`, which neither a `.env` line nor a
 * login dotfile can override), and the log says why.
 */
describe("run_next_build leaves the type check to CI only at origin's beta or main tip", () => {
  const SKIP = "CLAWBOX_BUILD_SKIP_TYPECHECK=1 ";
  const KEEP = "CLAWBOX_BUILD_SKIP_TYPECHECK=0 ";
  const skipped = (branch: string) => new RegExp(
    `^  Building without the on-box type check: [0-9a-f]{12} is origin/${branch}'s tip on branch ${branch}; `
      + `CI type-checks every pull request before it lands on ${branch}$`,
    "m",
  );
  const withCheck = (r: Run) => r.stdout.split("\n").filter((l) => l.startsWith("  Building with the type check ("));

  it.each<[string, Checkout]>([
    ["on beta at origin/beta's tip", { branch: "beta" }],
    ["on main at origin/main's tip", { branch: "main" }],
    ["on beta at the tip with beta pinned, as an updated box is", { branch: "beta", pin: "beta" }],
    // A script's executable bit changes nothing Next compiles or checks.
    ["on beta at the tip after the rebuild step made a tracked 100644 script executable, as every in-app update does",
      { branch: "beta", pin: "beta", modeFlip: "only" }],
  ])("builds without it %s with a clean tree", (_what, checkout) => {
    const r = run({ checkout });
    expect(r.status).toBe(0);
    expect(r.buildCommands).toEqual([`cd ${projectDir} && ${SKIP}/nonexistent/bun run build`]);
    expect(r.stdout).toMatch(skipped(checkout.branch));
    expect(withCheck(r)).toEqual([]);
  });

  it.each<[string, Checkout, RegExp[]]>([
    ["HEAD is behind origin/beta", { branch: "beta", behind: true },
      [/^HEAD [0-9a-f]{12} is not origin\/beta's tip [0-9a-f]{12}$/]],
    ["HEAD carries a commit origin has not got", { branch: "beta", ahead: true },
      [/^HEAD [0-9a-f]{12} is not origin\/beta's tip [0-9a-f]{12}$/]],
    ["a tracked file is edited", { branch: "beta", edited: true }, [/^the tree has changes: src\/app\.ts$/]],
    ["a file nothing ignores was added", { branch: "beta", untracked: true }, [/^the tree has changes: src\/new\.ts$/]],
    // What the device proof reads on a box following a pull request's branch.
    ["the box follows another branch", { branch: "feature/x" }, [/^the box follows feature\/x, not beta or main$/]],
    ["HEAD is detached at origin/beta's tip with beta pinned", { branch: "beta", detached: true, pin: "beta" },
      [/^HEAD is not on a branch$/]],
    // Unpinned and detached, the probe does not recover which branch the tree
    // came from: that takes root git and the tree's build stamp, and a detached
    // HEAD keeps the check whatever the answer.
    ["HEAD is detached at origin/beta's tip with no pin", { branch: "beta", detached: true }, [
      /^no update branch could be resolved$/,
      /^HEAD is not on a branch$/,
      /^there is no origin branch to compare HEAD with$/,
    ]],
    ["no update branch can be resolved", { branch: "beta", detached: true, ahead: true }, [
      /^no update branch could be resolved$/,
      /^HEAD is not on a branch$/,
      /^there is no origin branch to compare HEAD with$/,
    ]],
    ["the pin names beta but HEAD is on another branch", { branch: "feature/x", pin: "beta" }, [
      /^HEAD is on feature\/x, not beta$/,
      /^origin\/beta is not in this checkout$/,
    ]],
    // Changes `git status` alone would not show. Next would compile a hidden
    // page as a route, with no type check.
    ["a new page only .git/info/exclude hides", { branch: "beta", hidden: "info-exclude" },
      [/^new files hidden from git status: src\/app\/x\/page\.tsx$/]],
    // `status` names a directory that is new as a whole, here all of src/app/.
    ["a new page only the owner's global ignore file hides", { branch: "beta", hidden: "global-ignore" },
      [/^the tree has changes: src\/app\/$/]],
    ["an edit git is told to skip (skip-worktree)", { branch: "beta", hidden: "skip-worktree" },
      [/^git does not check these tracked files for changes: src\/app\.ts$/]],
    ["an edit git is told to skip (assume-unchanged)", { branch: "beta", hidden: "assume-unchanged" },
      [/^git does not check these tracked files for changes: src\/app\.ts$/]],
    // The executable bits the rebuild step sets are not counted; any other
    // change beside them still is, and is the only one named.
    ["the rebuild step's chmod is followed by an edit of that script", { branch: "beta", modeFlip: "edit" },
      [/^the tree has changes: scripts\/x\.sh$/]],
    ["the rebuild step's chmod is followed by a new file", { branch: "beta", modeFlip: "new" },
      [/^the tree has changes: src\/fresh\.ts$/]],
    ["the rebuild step's chmod is followed by a deleted file", { branch: "beta", modeFlip: "deleted" },
      [/^the tree has changes: src\/app\.ts$/]],
    ["the rebuild step's chmod is followed by a tracked symlink turned into a file", { branch: "beta", modeFlip: "symlink-to-file" },
      [/^the tree has changes: src\/link\.ts$/]],
    ["the rebuild step's chmod is followed by a tracked file turned into a symlink", { branch: "beta", modeFlip: "file-to-symlink" },
      [/^the tree has changes: src\/app\.ts$/]],
    // A real checkout always tracks files: an empty list is a doubt, not "all plain".
    ["git lists no tracked files", { branch: "beta", gitFails: "tracked-list-empty" }, [/^git listed no tracked files$/]],
    // An empty answer from a status that failed must not read as a clean tree.
    ["git status fails", { branch: "beta", gitFails: "status" }, [/^git status could not answer$/]],
    // Nor two empty answers as equal commits.
    ["git cannot answer at all", { branch: "beta", gitFails: "all" }, [
      /^no update branch could be resolved$/,
      /^HEAD is not on a branch$/,
      /^git could not read HEAD$/,
      /^git status could not answer$/,
      /^git could not list the tracked files$/,
    ]],
  ])("keeps it when %s, and names every condition that failed", (_what, checkout, reasons) => {
    const r = run({ checkout });
    expect(r.status).toBe(0);
    expect(r.buildCommands).toEqual([`cd ${projectDir} && ${KEEP}/nonexistent/bun run build`]);
    expect(r.stdout).not.toContain("without the on-box type check");
    const lines = withCheck(r);
    expect(lines).toHaveLength(1);
    const named = lines[0].replace(/^  Building with the type check \(/, "").replace(/\)$/, "").split("; ");
    expect(named).toHaveLength(reasons.length);
    reasons.forEach((reason, i) => expect(named[i]).toMatch(reason));
  });

  it("keeps it in test mode, as e2e-install runs install.sh", () => {
    const r = run({ checkout: { branch: "beta" }, testMode: true });
    expect(r.status).toBe(0);
    expect(r.buildCommands).toEqual([`cd ${projectDir} && ${KEEP}/nonexistent/bun run build`]);
    expect(withCheck(r)).toEqual(["  Building with the type check (a test-mode run)"]);
  });

  it("builds the retry after a trace race without it too, asking once", () => {
    const r = run({ checkout: { branch: "beta" }, build: "trace-race-then-succeeds" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.buildCommands).toEqual(Array(2).fill(`cd ${projectDir} && ${SKIP}/nonexistent/bun run build`));
    expect(r.stdout.match(/Building without the on-box type check/g)).toHaveLength(1);
  });

  it("builds the retry after a trace race with it when the first attempt had it", () => {
    const r = run({ checkout: { branch: "feature/x" }, build: "trace-race-then-succeeds" });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.buildCommands).toEqual(Array(2).fill(`cd ${projectDir} && ${KEEP}/nonexistent/bun run build`));
    expect(withCheck(r)).toHaveLength(1);
  });

  it("puts it in the build command that runs without a build log too", () => {
    const r = run({ checkout: { branch: "beta" }, buildLog: "unwritable" });
    expect(r.status).toBe(0);
    expect(r.buildCommands).toEqual([`cd ${projectDir} && ${SKIP}/nonexistent/bun run build`]);
  });

  it("gives the full-install build the same decision", () => {
    const r = run({ checkout: { branch: "beta" }, entry: "step_build" });
    expect(r.status).toBe(0);
    expect(r.buildCommands).toEqual([`cd ${projectDir} && ${SKIP}/nonexistent/bun run build`]);
    expect(r.stdout).toMatch(skipped("beta"));
  });

  it("leaves the caller's update target as it found it, even called bare", () => {
    // run_next_build reads the answer through `$(…)`, which would hide a leak;
    // the probe must not lean on that. resolve_update_branch sets all three,
    // so a probe that called it would change them.
    mkdirSync(projectDir, { recursive: true });
    setUpCheckout({ branch: "beta" });
    const script = [
      "set -euo pipefail",
      "PROJECT_DIR=" + JSON.stringify(projectDir),
      "is_test_mode() { return 1; }",
      'as_clawbox() { "$@"; }',
      ...checkoutLines({ branch: "beta" }),
      "UPDATE_TARGET_LOCAL=kept-local",
      "UPDATE_TARGET_UPSTREAM=kept-upstream",
      "UPDATE_TARGET_UNRESOLVED=kept",
      "build_type_check_proven_by_ci",
      'echo "AFTER:$UPDATE_TARGET_LOCAL|$UPDATE_TARGET_UPSTREAM|$UPDATE_TARGET_UNRESOLVED"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: gitEnv() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/is origin\/beta's tip on branch beta/);
    expect(r.stdout).toContain("AFTER:kept-local|kept-upstream|kept");
  });

  // Why the probe must not count an executable bit: the step every in-app
  // update dispatches sets them on scripts/*.sh, then builds.
  it("is asked after the rebuild step has made every scripts/*.sh executable", () => {
    const code = shellFunction("step_rebuild_reboot").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const perms = code.indexOf("step_directories_permissions");
    expect(perms).toBeGreaterThan(-1);
    expect(code.indexOf("do_rebuild", perms)).toBeGreaterThan(perms);
    expect(rebuildChmodLine()).toBe('(cd / && as_clawbox find "$PROJECT_DIR/scripts" -name "*.sh" -exec chmod +x {} +)');
  });

  // A here-string over a pipe buffer goes through a temp file, and with /tmp
  // full the redirection fails before a loop over it runs once. The decision on
  // index tags must not rest on such a loop: here every `read` fails, as it
  // does then.
  it("keeps it for an edit git is told to skip even when its line-by-line scan cannot run", () => {
    mkdirSync(projectDir, { recursive: true });
    setUpCheckout({ branch: "beta", hidden: "skip-worktree" });
    const script = [
      "set -euo pipefail",
      "PROJECT_DIR=" + JSON.stringify(projectDir),
      "is_test_mode() { return 1; }",
      'as_clawbox() { "$@"; }',
      ...checkoutLines({ branch: "beta" }),
      "read() { return 1; }",
      'if why="$(build_type_check_proven_by_ci)"; then echo "SKIP: $why"; else echo "KEEP: $why"; fi',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: gitEnv() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^KEEP: git does not check these tracked files for changes/m);
  });

  // The dispatched rebuild steps run as root and ran no git in the service
  // account's tree before this probe; the probe must not start doing so, nor
  // read the tree's files as root.
  it.each<[string, Checkout, RegExp]>([
    ["a pinned box", { branch: "beta", pin: "beta" }, /is origin\/beta's tip on branch beta/],
    ["an unpinned box", { branch: "beta" }, /is origin\/beta's tip on branch beta/],
    ["a detached HEAD", { branch: "beta", detached: true }, /HEAD is not on a branch/],
  ])("runs every git it adds, and every read of the tree, as the tree's owner on %s", (_what, checkout, answer) => {
    mkdirSync(projectDir, { recursive: true });
    setUpCheckout(checkout);
    // The build stamp root-side branch recovery reads for a detached HEAD.
    mkdirSync(path.join(projectDir, ".next"), { recursive: true });
    writeFileSync(path.join(projectDir, ".next", "build-info.json"), '{"branch": "beta"}\n', "utf-8");
    const calls = path.join(sandbox, "calls.txt");
    const script = [
      "set -euo pipefail",
      "PROJECT_DIR=" + JSON.stringify(projectDir),
      "CALLS=" + JSON.stringify(calls),
      "is_test_mode() { return 1; }",
      // The owner's wrapper marks what runs inside it; each recorder below
      // writes down who ran it, then runs the real command.
      'as_clawbox() { local RUN_AS=owner; "$@"; }',
      ...["git", "head", "sed", "cat", "grep"].map(
        (cmd) => `${cmd}() { printf '%s ${cmd} %s\\n' "\${RUN_AS:-root}" "$*" >> "$CALLS"; command ${cmd} "$@"; }`,
      ),
      ...checkoutLines(checkout),
      "build_type_check_proven_by_ci || true",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: gitEnv() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(answer);
    const ran = existsSync(calls) ? readFileSync(calls, "utf-8").split("\n").filter(Boolean) : [];
    expect(ran.filter((l) => l.startsWith("owner git ")).length).toBeGreaterThan(0);
    expect(ran.filter((l) => !l.startsWith("owner "))).toEqual([]);
    expect(ran.filter((l) => l.includes("build-info"))).toEqual([]);
  });

  it("never rewrites .git/index, and runs every git it adds as the tree's owner", () => {
    const body = shellFunction("build_type_check_proven_by_ci");
    expect(body).toContain('as_clawbox git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR"');
    expect(body).toMatch(/--no-optional-locks status --porcelain/);
    // No git at a command position: every call goes through the owner's array,
    // and no helper that runs git as root is called.
    const code = body.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).toContain('"${tree_git[@]}"');
    expect(code).not.toMatch(/(?:^|[;&|(!]|\$\(|\bthen|\bdo)\s*git\s/m);
    expect(code).not.toMatch(/\b(?:resolve_update_branch|recover_detached_branch|is_safe_git_ref)\b/);
    // Nor a root read of the tree the recorders cannot see: no input
    // redirection from it, no file test on it, and the pin only through the
    // owner's wrapper.
    expect(code).not.toMatch(/<\s*"?\$PROJECT_DIR/);
    expect(code).not.toMatch(/\[\s+-[a-zA-Z]\s+"?\$PROJECT_DIR/);
    const pinReads = code.split("\n").filter((l) => l.includes(".update-branch"));
    expect(pinReads.length).toBeGreaterThan(0);
    for (const l of pinReads) expect(l).toMatch(/\bas_clawbox head -n 1 -- "\$PROJECT_DIR\/\.update-branch"/);
  });
});

describe("oom_killer_in_kernel_log does not lose an early match", () => {
  /** Run the shipped body with the kernel log stubbed to `text`. */
  function ask(text: string): number | null {
    const script = [
      // install.sh's own options — pipefail is the whole point of these cases.
      "set -euo pipefail",
      `journalctl() { cat ${JSON.stringify(path.join(sandbox, "kernel.log"))}; }`,
      "dmesg() { return 1; }",
      shellFunction("oom_killer_in_kernel_log"),
      "oom_killer_in_kernel_log",
    ].join("\n");
    writeFileSync(path.join(sandbox, "kernel.log"), text, "utf-8");
    return spawnSync("bash", ["-c", script], { encoding: "utf-8" }).status;
  }

  const MANY_LINES = Array.from({ length: 50_000 }, (_, i) => `kernel: line ${i}`).join("\n");

  it("finds an OOM record that sits EARLY in a long kernel log", () => {
    // The regression: a match at the top, with plenty of log after it.
    expect(ask(`oom-kill: constraint=CONSTRAINT_NONE,nodemask=(null)\n${MANY_LINES}\n`)).toBe(0);
  });

  it("finds the kernel's other wording too, and at the END of the log", () => {
    expect(ask(`${MANY_LINES}\nOut of memory: Killed process 4242 (next-build)\n`)).toBe(0);
  });

  it("answers no for a log that records no OOM kill", () => {
    // The honest negative is what stops the sentence inventing a cause.
    expect(ask(`${MANY_LINES}\n`)).toBe(1);
  });

  it("answers no when the kernel log cannot be read at all", () => {
    const script = [
      "set -euo pipefail",
      "journalctl() { return 1; }",
      "dmesg() { return 1; }",
      shellFunction("oom_killer_in_kernel_log"),
      "oom_killer_in_kernel_log",
    ].join("\n");
    expect(spawnSync("bash", ["-c", script], { encoding: "utf-8" }).status).not.toBe(0);
  });
});

describe("do_rebuild keeps the box serving when the build fails", () => {
  const restarted = (r: Run) =>
    r.systemctl.filter((l) => /^systemctl (start|restart) clawbox-setup\.service$/.test(l));

  it("leaves the previous build in place after an OOM kill", () => {
    const r = run({ build: "oom-killed" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("starts clawbox-setup again after a failed build", () => {
    const r = run({ build: "oom-killed" });
    expect(restarted(r).length).toBeGreaterThan(0);
    expect(r.stderr).toMatch(/Restored the previous build; the dashboard answers on :80 again/);
  });

  it("names memory when the kernel log confirms the OOM kill (TASK-1022)", () => {
    // "Error: rebuild failed (exit 137)" was the whole of what an owner was
    // told, and a number is not something they can act on. With the kernel's
    // own evidence the sentence may name WHAT died and WHY.
    const r = run({ build: "oom-killed", oomEvidence: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error: rebuild failed \(exit 137\)/);
    expect(r.stderr).toMatch(/bun run build was killed by the kernel's OOM killer/);
    expect(r.stderr).toMatch(/ran out of memory/);
  });

  it("does NOT claim memory for a 137 the kernel log does not attribute", () => {
    // A stop timeout, `systemctl kill`, a watchdog and an operator all arrive
    // as signal 9 / exit 137. Asserting an OOM over any of those would send
    // the owner after a problem they do not have — the kill is still named,
    // the cause is not invented.
    const r = run({ build: "oom-killed", oomEvidence: false });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error: rebuild failed \(exit 137\)/);
    expect(r.stderr).toMatch(/bun run build was killed by signal 9/);
    expect(r.stderr).not.toMatch(/ran out of memory/);
  });

  it("names bun install when that is what failed, not 'the rebuild'", () => {
    // The four things that can fail in this window used to collapse into one
    // sentence, so the banner never said which of them it was.
    const r = run({ bunInstall: "fails" });
    expect(r.stderr).toMatch(/Error: rebuild failed \(exit 1\) — bun install did not succeed\./);
  });

  // The window the first version of this fix left open: `bun install` and
  // `ensure_node_pty` run AFTER clawbox-setup is stopped and BEFORE the restore
  // branch, and `ensure_node_pty` used to `exit 1` outright — jumping over the
  // recovery and leaving the box in exactly the state the card describes, this
  // time with a perfectly good build untouched on disk.
  it("starts clawbox-setup again when bun install fails", () => {
    const r = run({ bunInstall: "fails" });
    expect(r.status).not.toBe(0);
    expect(restarted(r).length).toBeGreaterThan(0);
    expect(r.buildId).toBe("old-build-id");
  });

  it("starts clawbox-setup again when node-pty cannot be rebuilt", () => {
    const r = run({ nodePty: "fails" });
    expect(r.status).not.toBe(0);
    expect(restarted(r).length).toBeGreaterThan(0);
    expect(r.buildId).toBe("old-build-id");
  });

  it("says the dashboard is down when the restored build crash-loops", () => {
    // The state a Type=simple unit with Restart=always really produces: the
    // stub `systemctl start` makes the unit ACTIVE — as systemd does the
    // instant node is forked — while nothing answers on :80. An
    // implementation that polls `systemctl is-active` reports "serving again"
    // here, on a box that will be dead all night. Only the HTTP probe can tell
    // the two apart, which is why this case is the one that pins it.
    const r = run({ build: "oom-killed", startWorks: false, probeWindow: "2" });

    expect(r.status).not.toBe(0);
    expect(r.systemctl.some((l) => /^systemctl restart clawbox-setup/.test(l))).toBe(true);
    expect(r.stderr).toMatch(/it is DOWN/);
    expect(r.stderr).not.toMatch(/answers on :80/);
    // …and it watched for SECONDS, not for turns round the loop. The harness
    // stubs `sleep` to a no-op, so an iteration counter gives up in
    // milliseconds — while on a real box each turn costs the probe's own
    // `--max-time 5`, which is how a window that said three minutes ran for
    // eighteen. The floor is a second rather than the window itself because
    // `$SECONDS` counts in whole seconds from an arbitrary origin: a 2 s window
    // can elapse after as little as ~1 s of wall time, depending on where the
    // start landed inside a second. A second is already three orders of
    // magnitude away from what the counter did.
    expect(r.elapsedMs, "the poll did not measure wall time").toBeGreaterThanOrEqual(900);
  });

  it("hands the paused engines to the reboot, and starts them itself when there is none", () => {
    // The in-app updater's arm is `do_rebuild --reboot-follows`, and there the
    // engines are systemd's to bring back — starting four model servers seconds
    // before shutdown restores nothing that survives and lengthens the very
    // shutdown the updater is waiting through. Every other caller starts them.
    const withReboot = run({ build: "succeeds", rebootFollows: true });
    expect(withReboot.status).toBe(0);
    expect(withReboot.stdout + withReboot.stderr).toMatch(/FORGOT/);
    expect(withReboot.stdout + withReboot.stderr).not.toMatch(/RESUMED/);

    const withoutReboot = run({ build: "succeeds" });
    expect(withoutReboot.status).toBe(0);
    expect(withoutReboot.stdout + withoutReboot.stderr).toMatch(/RESUMED/);
  });

  it("judges the gateway's room just before the build on a routine rebuild, and only there (TASK-1197)", () => {
    // Not at the top: bun install, the node-pty check and the set-aside all
    // run with the assistant up, so a pause — when one is needed at all —
    // covers the build and nothing that merely precedes it.
    const r = run({ build: "succeeds" });
    expect(r.status).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("FREED:routine");
    const install = out.indexOf("Running bun install...");
    const judged = out.indexOf("GATEWAY-ROOM-JUDGED");
    const build = out.indexOf("Running bun build...");
    expect(install).toBeGreaterThan(-1);
    expect(judged).toBeGreaterThan(install);
    expect(build).toBeGreaterThan(judged);
    // …and says how long it was away, once the resume has brought it back.
    expect(out.indexOf("GATEWAY-PAUSE-REPORTED")).toBeGreaterThan(out.indexOf("RESUMED"));
  });

  it("leaves the update's reboot path exactly as it was: paused up front, handed to the reboot", () => {
    const r = run({ build: "succeeds", rebootFollows: true });
    expect(r.status).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("FREED:--reboot-follows");
    expect(out).not.toContain("GATEWAY-ROOM-JUDGED");
    expect(out).toContain("FORGOT");
  });

  it("gives the engines back before it deletes the parked build, not after", () => {
    const r = run({ build: "succeeds" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("RESUMED-BEFORE-CLEANUP");
    // And the parked tree is still removed.
    expect(r.parked).toBe(false);
  });

  it("reports the pause on the failure arm too, after the restore and the resume", () => {
    const r = run({ build: "oom-killed" });
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out.indexOf("GATEWAY-PAUSE-REPORTED")).toBeGreaterThan(out.indexOf("RESUMED"));
  });

  it("starts them back on the failure arm even when a reboot was announced", () => {
    // errexit ends step_rebuild_reboot before its `reboot` when do_rebuild
    // fails, so that arm is the one caller whose engines nothing else will
    // bring back.
    const r = run({ build: "oom-killed", rebootFollows: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/RESUMED/);
    expect(r.stdout + r.stderr).not.toMatch(/FORGOT/);
  });

  it("restarts clawbox-setup rather than starting it, so a latched unit is replaced", () => {
    // `start` on an already-active unit is a no-op, and the unit CAN be active
    // here: once anything brings it back, its own `Restart=always` latches it
    // onto whatever tree exists from the moment `next build` writes the
    // standalone entry. A `start` would then leave the box serving the build
    // that just failed verification while this function reported a rollback.
    //
    // What brought it back routinely was clawbox-gateway.service's
    // `Wants=clawbox-setup.service`, removed in TASK-728 — which removes the
    // routine trigger and not the case: a hand-run `--step rebuild`, a box where
    // gateway_setup is skipped, and an operator (or the sudoers grant)
    // restarting clawbox-setup all still land inside the window.
    const r = run({ build: "succeeds", identity: "drift" });

    expect(r.status).not.toBe(0);
    expect(r.systemctl.some((l) => l === "systemctl restart clawbox-setup.service")).toBe(true);
    expect(r.systemctl.some((l) => l === "systemctl start clawbox-setup.service")).toBe(false);
  });

  it("says the dashboard answers when the restore really comes up", () => {
    const r = run({ build: "oom-killed" });

    expect(r.stderr).toMatch(/answers on :80 again/);
    expect(r.stderr).not.toMatch(/it is DOWN/);
  });

  it("does not call it a restore when nothing was ever moved aside", () => {
    // `bun install` fails BEFORE the park, so the serving build was never
    // touched. The outcome is right either way; the sentence is not, and this
    // whole change is about not asserting things that did not happen.
    const r = run({ bunInstall: "fails" });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/The serving build was never moved aside/);
    expect(r.stderr).not.toMatch(/Restored the previous build/);
  });

  it("names the build that failed verification when the disk could not hold two", () => {
    // The no-fallback branch: `set_previous_build_aside` deleted the old build
    // rather than parking it, the new one then failed identity, and what is on
    // disk is that rejected build. Starting it beats a dead box — calling it a
    // rollback does not.
    const r = run({ build: "succeeds", identity: "drift", diskHeadroom: "tight" });

    expect(r.status).not.toBe(0);
    expect(r.parked).toBe(false);
    expect(r.buildId).toBe("new-build-id");
    expect(r.stderr).toMatch(/FAILED verification/);
    expect(r.stderr).not.toMatch(/Restored the previous build/);
  });

  it("replaces the previous build only once the new one exists", () => {
    const r = run({ build: "succeeds" });
    expect(r.status).toBe(0);
    expect(r.buildId).toBe("new-build-id");
    expect(r.parked).toBe(false);
  });

  it("still fails, without a previous build to fall back on", () => {
    const r = run({ build: "oom-killed", previousBuild: "none" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBeNull();
    expect(r.stderr).toMatch(/No build to fall back on/);
  });

  // A rebuild that is killed outright — the OOM killer picking this shell, a
  // power cut, an operator's Ctrl-C — leaves the only good build parked under a
  // gitignored directory that nothing else in the tree reads.
  it("reclaims a build parked by an interrupted rebuild", () => {
    const r = run({ build: "oom-killed", previousBuild: "none", parkedBuild: "servable" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("parked-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("reclaims a parked build whose entry is the nested layout's symlink", () => {
    // `-f` resolves the link, and the link dangles while the tree is parked —
    // so a `-f` guard answers "nothing parked here" about the box's only
    // build and the rename below deletes it.
    const r = run({ previousBuild: "none", parkedBuild: "nested-entry", build: "oom-killed" });

    expect(r.stderr).toMatch(/parked by an interrupted rebuild/);
    expect(r.buildId).toBe("parked-build-id");
    expect(r.parked).toBe(false);
  });

  it("does not touch a parked build when the current one is servable", () => {
    // A FAILING build, so the preserved identity is observable: with
    // `succeeds` the build overwrites BUILD_ID either way, and removing the
    // guard in promote_parked_build would leave every assertion holding.
    // Failing, the box must end on its OWN previous build, not the parked one.
    const r = run({ build: "oom-killed", previousBuild: "servable", parkedBuild: "servable" });

    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
  });
});

// TASK-2244. A box rolled back from the 4.3 update served its previous build
// with a dead web terminal: the rollback restores .next, never node_modules, so
// a node-pty that did not load stayed that way. And the update screen said only
// "node-pty is still not loadable … check the node-gyp output above" — output
// it never showed.
describe("do_rebuild after a rollback: node-pty and the failure sentence (TASK-2244)", () => {
  /** The newest line that starts with Error/fatal — what the update screen shows. */
  const failureLine = (r: Run) =>
    (r.stdout + "\n" + r.stderr)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(?:error|fatal)\b/i.test(l))
      .pop();

  it("names the compiler's own error when the node-pty rebuild is what failed", () => {
    const r = run({ nodePty: "fails" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "Error: rebuild failed (exit 1) — the node-pty rebuild did not succeed: "
        + "../../node-addon-api/napi.h:13:10: fatal error: node_api.h: No such file or directory",
    );
  });

  it("keeps the plain sentence for a failure that carries no reason of its own", () => {
    const r = run({ bunInstall: "fails" });
    expect(r.stderr).toMatch(/Error: rebuild failed \(exit 1\) — bun install did not succeed\.$/m);
  });

  it("rebuilds node-pty on the restored box when it no longer loads there", () => {
    const r = run({ build: "oom-killed", ptyBrokenByBuild: true });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
    expect(r.ptyLoadable).toBe(true);
    expect(r.ptyRebuilds).toBe(2);
    expect(r.stdout).toContain("node-pty rebuilt and verified on the restored box");
  });

  it("rebuilds it only once the dashboard is back, not before", () => {
    const r = run({ build: "oom-killed", ptyBrokenByBuild: true });
    const restart = r.systemctl.findIndex((l) => /^systemctl restart clawbox-setup\.service$/.test(l));
    const rebuilds = r.systemctl.flatMap((l, i) => (l === "ensure_node_pty" ? [i] : []));
    expect(restart).toBeGreaterThan(-1);
    expect(rebuilds).toHaveLength(2);
    expect(rebuilds[1]).toBeGreaterThan(restart);
  });

  it("leaves a node-pty that still loads alone", () => {
    const r = run({ build: "oom-killed" });
    expect(r.status).not.toBe(0);
    expect(r.ptyLoadable).toBe(true);
    expect(r.ptyRebuilds).toBe(1);
    expect(r.stdout).not.toContain("on the restored box");
  });

  it("does not repeat a node-pty rebuild that has just failed", () => {
    const r = run({ nodePty: "fails" });
    expect(r.ptyRebuilds).toBe(1);
  });

  it("does not let the rollback's rebuild replace the sentence that says why the update failed", () => {
    // The update screen shows the newest Error/fatal line of this step's
    // journal. The rebuild after the rollback is quiet: its own output, and its
    // own `Error:` line, go to a file.
    const r = run({ build: "oom-killed", ptyBrokenByBuild: true, ptyRebuildAfterRollback: "fails" });
    expect(r.status).not.toBe(0);
    expect(r.ptyLoadable).toBe(false);
    expect(failureLine(r)).toMatch(/^Error: rebuild failed \(exit 137\) — bun run build was killed by signal 9/);
    // failureLine reads stdout before stderr; an error line on stdout could
    // be newer than it shows, so there must be none at all.
    expect(r.stdout.split("\n").some((l) => /^(?:error|fatal)\b/i.test(l.trim()))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain("gyp ERR! not ok");
    expect(r.stderr).toMatch(
      /Warning: node-pty still does not load after the rollback, so the web terminal stays unavailable: \.\.\/src\/unix\/pty\.cc:42:1: error: forkpty/,
    );
  });

  it("adds at most two lines to the journal when it rebuilds after a rollback", () => {
    // readRootStepFailure reads the last 40 lines; the failure sentence must
    // stay inside them.
    const healthy = run({ build: "oom-killed" });
    const healed = run({ build: "oom-killed", ptyBrokenByBuild: true });
    const lines = (x: Run) => (x.stdout + x.stderr).split("\n").filter(Boolean).length;
    expect(lines(healed) - lines(healthy)).toBeLessThanOrEqual(2);
  });
});

describe("step_build asks the same two questions", () => {
  it("fails when the install path produces no server entry", () => {
    const r = run({ entry: "step_build", build: "no-standalone-entry", previousBuild: "none" });
    expect(r.status).not.toBe(0);
  });

  it("reclaims a parked build before rebuilding", () => {
    const r = run({ entry: "step_build", build: "oom-killed", previousBuild: "none", parkedBuild: "servable" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("parked-build-id");
  });

  it("runs the checkout's identity script as the service account", () => {
    const r = run({ entry: "step_build", build: "succeeds", previousBuild: "none" });
    expect(r.status).toBe(0);
    expect(r.identityRuns).toEqual([`service --project-dir ${projectDir} --quiet`]);
  });
});

// Linux only, and deliberately not made portable: what these cases pin is that
// the stamp names a process the reader can still PROVE is alive, and the proof
// is `/proc/sys/kernel/random/boot_id` plus field 22 of `/proc/<pid>/stat` —
// the two facts production-server.js reads. On a platform with no procfs the
// probe can only answer "stale", so the suite would fail over the machine it
// ran on rather than over install.sh. The device and CI are both Linux.
describe.skipIf(process.platform !== "linux")("do_rebuild says who owns the build it parks", () => {
  /**
   * The park is not a quiet moment. `set_previous_build_aside` renames `.next`
   * to `.next-old` and only then runs `bun run build`, so for the whole length
   * of the build there is no `.next/standalone/server.js` and there is a parked
   * one — the exact condition production-server.js's boot-time reclaim fires
   * on. And clawbox-setup used to come back up inside that window as a matter
   * of routine: `config/clawbox-gateway.service` carried
   * `Wants=clawbox-setup.service`, so every gateway (re)start started the
   * service `do_rebuild` had just stopped (e2e-install run 33971129750: four
   * seconds after the stop, while `bun install` was still running). TASK-728
   * removed that line — including for the update that carries it, since
   * step_systemd_services runs above do_rebuild in step_rebuild_reboot. The
   * stamp stays for the ways in that are left: a hand-run `--step rebuild`, a
   * skipped gateway_setup, and an operator restarting the web server.
   *
   * Nothing in the tree said "a rebuild is in flight", so the reclaim could not
   * tell that state from the one it exists for — a rebuild whose shell was
   * KILLED. The parked tree carries the rebuilding shell's PID instead, and
   * liveness is what separates the two.
   */
  it("stamps the parked build with the rebuilding shell while the build runs", () => {
    const r = run({ build: "succeeds" });

    expect(r.status).toBe(0);
    expect(r.buildSawOwner).toMatch(/^live \d+$/);
  });

  it("leaves no owner behind on the build it restores after a failure", () => {
    // The restore renames the parked tree back over `.next`. A stamp riding
    // along would sit inside the build the box serves, naming a process that
    // is about to exit.
    const r = run({ build: "oom-killed" });

    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
    expect(r.ownerLeftBehind).toBe(false);
  });

  it("leaves no owner behind on the build it promotes", () => {
    // Same rename, the other direction: promote_parked_build claims a tree an
    // earlier killed run left behind, and that tree carries that run's stamp.
    //
    // `bunInstall: "fails"` so the run ENDS on the promoted tree — it aborts
    // before the park, so nothing writes a fresh stamp and nothing deletes
    // `.next-old` afterwards. With a successful build both of those would make
    // the assertion true no matter what promote did.
    const r = run({ previousBuild: "none", parkedBuild: "servable", bunInstall: "fails" });

    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("parked-build-id");
    expect(r.ownerLeftBehind).toBe(false);
  });

  it("writes the stamp production-server.js reads", () => {
    // Two files, one filename, and no compiler between them. A rename on either
    // side puts the race back silently: the reclaim would find no stamp, call
    // every running rebuild a dead one, and fire mid-build again.
    const stamp = /\.rebuild-pid/;
    expect(shellFunction("set_previous_build_aside")).toMatch(stamp);
    expect(readFileSync(path.join(REPO, "production-server.js"), "utf-8")).toMatch(stamp);
  });

  it("stamps nothing when the disk could not hold two builds", () => {
    // The no-fallback branch deletes the serving build rather than parking it.
    // There is no parked tree to own, and no reclaim can fire — a stamp here
    // would be a claim about a directory that does not exist.
    const r = run({ build: "succeeds", diskHeadroom: "tight" });

    expect(r.status).toBe(0);
    expect(r.buildSawOwner).toBe("none");
  });
});
