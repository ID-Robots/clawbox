import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real bash and a real git several times per case: vitest's 5 s test
// and 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

/**
 * scripts/force-update.sh, run whole, against a scratch checkout.
 *
 * What it used to do on a failed build (a board, 2026-09-23): `git HEAD` had
 * already moved to the new commit, `next build` had already emptied `.next`,
 * and the script either exited with the build's status — leaving HEAD ahead of
 * the build the service was still serving from memory, and nothing on disk for
 * the next restart to load — or, once, reported success after
 * "> Build error occurred".
 *
 * Each case here plays the device: a checkout on the commit it serves, an
 * origin one commit ahead, and a `.next` holding the serving build. Only the
 * things that would reach outside the scratch directory are stubbed — `bun`
 * (the build itself, scripted per case), `sudo` (which just drops `-u clawbox`),
 * `systemctl` (which records what it was asked) and `sleep`. git is real, so
 * "HEAD went back" is git's own answer.
 */

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "force-update.sh");

const CAN_RUN =
  process.platform === "linux"
  && spawnSync("bash", ["-c", "command -v git"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

type BuildOutcome =
  | "succeeds"
  | "fails"
  | "fails-with-entry"
  | "fails-long"
  | "says-error-exits-0"
  | "leaves-no-entry"
  | "names-another-commit"
  | "trace-race-then-succeeds"
  | "slow-success";

// Holds a step until the test writes $STUB_LOG/release — and never for more than
// 30 s, so a test that fails before it releases cannot hang the run.
const STUB_HOLD = `hold() {
  touch "$STUB_LOG/$1"
  local i=0
  while [ ! -e "$STUB_LOG/release" ] && [ "$i" -lt 300 ]; do command -p sleep 0.1; i=$((i + 1)); done
}`;

const STUB_BUN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/bun.log"
${STUB_HOLD}
if [ "$1" = "install" ]; then
  # Only the first install, the new commit's: the checkout has moved by then.
  if [ -n "\${STUB_HOLD_INSTALL:-}" ] && [ ! -e "$STUB_LOG/install-started" ]; then hold install-started; fi
  exit 0
fi
[ "$1 $2" = "run build" ] || exit 64
attempt=$(( $(cat "$STUB_LOG/builds" 2>/dev/null || echo 0) + 1 ))
echo "$attempt" > "$STUB_LOG/builds"
# What next build does first: it empties the output directory.
rm -rf .next/standalone .next/BUILD_ID .next/build-info.json
mkdir -p .next
# Stamped the way the real build is (scripts/write-build-info.mjs), with the
# commit it was built from, so the identity check after it has something true
# to read.
produce() {
  mkdir -p .next/standalone
  echo "new build" > .next/standalone/server.js
  echo "new-build-id" > .next/BUILD_ID
  printf '{"commit":"%s","buildId":"new-build-id"}\\n' "$(git rev-parse HEAD)" > .next/build-info.json
}
echo "   Creating an optimized production build ..."
case "$STUB_BUILD" in
  succeeds) produce; exit 0 ;;
  fails)
    echo "Error [TurbopackInternalError]: [project]/src/lib/edition-source.ts [app-rsc] (ecmascript)" >&2
    echo "- Symlink [project]/data/coding-agent-artifacts/run-aaaaaaaa/venv/bin/python is invalid, it points out of the filesystem root" >&2
    echo "> Build error occurred" >&2
    exit 1 ;;
  fails-with-entry)
    produce
    echo "> Build error occurred" >&2
    exit 1 ;;
  fails-long)
    for i in $(seq 1 100); do echo "build line $i"; done
    exit 1 ;;
  says-error-exits-0)
    echo "> Build error occurred" >&2
    echo "Error: ENOENT: no such file or directory, copyfile 'data/coding-agent-streams/run-aaaaaaaa.err'" >&2
    exit 0 ;;
  leaves-no-entry) echo "new-build-id" > .next/BUILD_ID; exit 0 ;;
  names-another-commit)
    produce
    printf '{"commit":"%s","buildId":"new-build-id"}\\n' 0000000000000000000000000000000000000000 > .next/build-info.json
    exit 0 ;;
  trace-race-then-succeeds)
    if [ "$attempt" -eq 1 ]; then
      echo "> Build error occurred" >&2
      echo "Error: ENOENT: no such file or directory, copyfile '/x/data/coding-agent-streams/run-aaaaaaaa.err' -> '/x/.next/standalone/data/coding-agent-streams/run-aaaaaaaa.err'" >&2
      exit 1
    fi
    produce; exit 0 ;;
  slow-success)
    # Held open until the test has sent its signal, however late it gets to.
    hold build-started
    produce; exit 0 ;;
esac
exit 70
`;

// Holds the deletion of the parked build, once there is one to delete, so a
// signal can land while it runs. The real rm does the work.
const STUB_RM = `#!/usr/bin/env bash
${STUB_HOLD}
if [ -n "\${STUB_HOLD_DROP:-}" ] && [ "\${!#}" = "$CLAWBOX_ROOT/.next-old" ] && [ -d "\${!#}" ]; then
  hold drop-started
fi
command -p rm "$@"
`;

const STUB_SUDO = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/sudo.log"
if [ "$1" = "-u" ]; then shift 2; exec "$@"; fi
[ "$1" = "chown" ] && exit 0
exec "$@"
`;

const STUB_SYSTEMCTL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG/systemctl.log"
case "$1" in
  is-active) exit "\${STUB_ACTIVE:-0}" ;;
esac
exit 0
`;

let tmp: string;
let box: string;
let seed: string;
let bin: string;
let stubLog: string;
let prevHead: string;
let newHead: string;

const GIT_ENV = testEnv({
  PATH: process.env.PATH ?? "",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "init.defaultBranch=beta", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...GIT_ENV, HOME: tmp },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, body: string): void {
  fs.writeFileSync(path.join(dir, "README.md"), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", body);
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function scriptEnv(build: BuildOutcome, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: tmp,
    TMPDIR: tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAWBOX_ROOT: box,
    CLAWBOX_BRANCH: "beta",
    CLAWBOX_BUN: path.join(bin, "bun"),
    STUB_LOG: stubLog,
    STUB_BUILD: build,
    ...extra,
  });
}

function runForceUpdate(build: BuildOutcome, extra: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf-8", timeout: 50_000, env: scriptEnv(build, extra) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function logOf(name: string): string {
  try {
    return fs.readFileSync(path.join(stubLog, name), "utf-8");
  } catch {
    return "";
  }
}

const read = (rel: string) => fs.readFileSync(path.join(box, rel), "utf-8");

/** Wait for a stub to say it has reached a step it is holding. */
async function waitForMarker(name: string): Promise<void> {
  await vi.waitFor(() => {
    if (!fs.existsSync(path.join(stubLog, name))) throw new Error(`the stub has not reached ${name} yet`);
  }, { timeout: 30_000, interval: 50 });
}

/** The build passed the checkout's own identity check, not a skipped one. */
function expectIdentityChecked(output: string): void {
  expect(output).not.toContain("identity was not checked");
  expect(JSON.parse(read(".next/build-info.json")).commit).toBe(newHead);
}

function expectPreviousBuildServed(): void {
  expect(read(".next/standalone/server.js")).toBe("old build\n");
  expect(read(".next/BUILD_ID")).toBe("old-build-id\n");
  expect(fs.existsSync(path.join(box, ".next", ".rebuild-pid")), "the park's owner stamp rode into the served build").toBe(false);
  expect(fs.existsSync(path.join(box, ".next-old")), "the parked build was left behind").toBe(false);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-force-update-")));
  seed = path.join(tmp, "origin");
  box = path.join(tmp, "box");
  bin = path.join(tmp, "bin");
  stubLog = path.join(tmp, "log");
  fs.mkdirSync(seed);
  fs.mkdirSync(bin);
  fs.mkdirSync(stubLog);

  git(seed, "init", "-q");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".next/\n.next-old/\nnode_modules/\ndata/\n");
  // The real identity check, where the run looks for it: under the checkout's
  // own scripts/. A build that works has to pass it, as it does on a box.
  fs.mkdirSync(path.join(seed, "scripts"));
  fs.copyFileSync(path.join(REPO, "scripts", "verify-build-identity.sh"), path.join(seed, "scripts", "verify-build-identity.sh"));
  commit(seed, "served");
  git(tmp, "clone", "-q", seed, box);
  prevHead = git(box, "rev-parse", "HEAD");
  commit(seed, "update");
  newHead = git(seed, "rev-parse", "HEAD");

  fs.mkdirSync(path.join(box, ".next", "standalone"), { recursive: true });
  fs.writeFileSync(path.join(box, ".next", "standalone", "server.js"), "old build\n");
  fs.writeFileSync(path.join(box, ".next", "BUILD_ID"), "old-build-id\n");

  writeExecutable(path.join(bin, "bun"), STUB_BUN);
  writeExecutable(path.join(bin, "sudo"), STUB_SUDO);
  writeExecutable(path.join(bin, "systemctl"), STUB_SYSTEMCTL);
  writeExecutable(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("scripts/force-update.sh never serves a build that failed", () => {
  it("rolls HEAD back, keeps the previous build, restarts nothing and exits non-zero", () => {
    const r = runForceUpdate("fails");

    expect(r.status, r.output).toBe(1);
    expect(git(box, "rev-parse", "HEAD"), "HEAD stayed on the commit whose build failed").toBe(prevHead);
    expect(git(box, "symbolic-ref", "--short", "HEAD")).toBe("beta");
    expectPreviousBuildServed();
    expect(logOf("systemctl.log")).not.toMatch(/restart/);
    expect(r.output).toContain("Checkout rolled back to beta");
    expect(r.stderr).toContain("FAILED (exit 1)");
  });

  it("puts the tail of the build's output in the failure, and only the tail", () => {
    const r = runForceUpdate("fails-long");

    expect(r.status).toBe(1);
    const tail = r.stderr.slice(r.stderr.indexOf("Last 30 lines of the build output:"));
    expect(tail).toContain("build line 71\n");
    expect(tail).toContain("build line 100\n");
    expect(tail).not.toContain("build line 70\n");
  });

  it("re-installs node_modules for the commit it rolled back to", () => {
    runForceUpdate("fails");

    // Once for the new commit, once more after the checkout went back.
    expect(logOf("bun.log").split("\n").filter((l) => l === "install")).toHaveLength(2);
  });

  it("does not report success over \"Build error occurred\", whatever the exit status said", () => {
    const r = runForceUpdate("says-error-exits-0");

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/printed "Build error occurred"/);
    expect(git(box, "rev-parse", "HEAD")).toBe(prevHead);
    expectPreviousBuildServed();
    expect(logOf("systemctl.log")).not.toMatch(/restart/);
  });

  it("refuses a build that exited 0 but left nothing the dashboard can load", () => {
    const r = runForceUpdate("leaves-no-entry");

    expect(r.status).not.toBe(0);
    expect(git(box, "rev-parse", "HEAD")).toBe(prevHead);
    expectPreviousBuildServed();
  });

  it("refuses a build that does not name the commit it was built from", () => {
    const r = runForceUpdate("names-another-commit");

    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/does not name the checked-out commit/);
    expect(git(box, "rev-parse", "HEAD")).toBe(prevHead);
    expectPreviousBuildServed();
  });

  it("goes back to the branch it was on, not just the commit", () => {
    // A box on main being moved to beta: the rollback has to leave it on main.
    git(box, "checkout", "-q", "-b", "main");
    git(box, "branch", "-q", "-D", "beta");

    const r = runForceUpdate("fails");

    expect(r.status).toBe(1);
    expect(git(box, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(box, "rev-parse", "HEAD")).toBe(prevHead);
  });

  it("brings the service back on the previous build if it went down while that build was parked", () => {
    const r = runForceUpdate("fails", { STUB_ACTIVE: "3" });

    expect(r.status).toBe(1);
    expectPreviousBuildServed();
    expect(logOf("systemctl.log")).toMatch(/^restart clawbox-setup$/m);
  });

  it("does not start the service onto what a failed build left when there was no previous build to keep", () => {
    // Nothing to park — no .next on disk — so after the failure .next is the
    // FAILED build's, entry and all. A service that is down must stay down
    // rather than come up on it.
    fs.rmSync(path.join(box, ".next"), { recursive: true });

    const r = runForceUpdate("fails-with-entry", { STUB_ACTIVE: "3" });

    expect(r.status).toBe(1);
    expect(git(box, "rev-parse", "HEAD")).toBe(prevHead);
    expect(logOf("systemctl.log")).not.toMatch(/restart/);
    expect(r.stderr).toContain("was NOT started");
    expect(r.stderr).toContain("there was no previous build on disk to keep");
  });

  it("puts back a build an interrupted update left parked before it parks anything", () => {
    // The box's only build is at .next-old; .next holds no entry.
    fs.renameSync(path.join(box, ".next"), path.join(box, ".next-old"));
    fs.mkdirSync(path.join(box, ".next"));

    const r = runForceUpdate("fails");

    expect(r.status).toBe(1);
    expectPreviousBuildServed();
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGPIPE", 141],
  ] as const)("rolls back when the run is interrupted mid-build by %s, even if the build then finishes", async (signal, code) => {
    // An SSH session dropping is SIGHUP; Ctrl-C and `systemctl stop` are two
    // more, and a reader that goes away is SIGPIPE on the next line written.
    // bash runs the trap once the build in the foreground ends — which the
    // stub holds off until the signal has been sent.
    const child = spawn("bash", [SCRIPT], { env: scriptEnv("slow-success"), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));

    await waitForMarker("build-started");
    child.kill(signal);
    fs.writeFileSync(path.join(stubLog, "release"), "");

    expect(await exited, stderr).toBe(code);
    expect(stderr).toContain(`Interrupted (${signal})`);
    expect(git(box, "rev-parse", "HEAD")).toBe(prevHead);
    expectPreviousBuildServed();
    expect(logOf("systemctl.log")).not.toMatch(/restart/);
  });

  it("rolls back on an exit nobody planned for, once the checkout has moved", async () => {
    // Under `set -e` a failed `echo` ends the script too: into a pipe whose
    // reader has gone while SIGPIPE is ignored (as a supervisor or `nohup`
    // may leave it), or into a terminal that has gone away. Here the reader
    // goes while the new commit's `bun install` runs; the next line written to
    // stdout is the trace-race retry's "building once more".
    const child = spawn("bash", ["-c", 'trap "" PIPE; exec bash "$0"', SCRIPT], {
      env: scriptEnv("trace-race-then-succeeds", { STUB_HOLD_INSTALL: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));

    await waitForMarker("install-started");
    child.stdout.destroy();
    fs.writeFileSync(path.join(stubLog, "release"), "");

    expect(await exited, stderr).toBe(1);
    expect(stderr).toContain("Exited unexpectedly (status 1)");
    expect(git(box, "rev-parse", "HEAD"), stderr).toBe(prevHead);
    expect(git(box, "symbolic-ref", "--short", "HEAD")).toBe("beta");
    expectPreviousBuildServed();
    expect(logOf("systemctl.log")).not.toMatch(/restart/);
  });
});

d("scripts/force-update.sh on a build that works", () => {
  it("moves to the new commit, serves the new build and drops the parked one", () => {
    const r = runForceUpdate("succeeds");

    expect(r.status, r.output).toBe(0);
    expect(git(box, "rev-parse", "HEAD")).toBe(newHead);
    expect(read(".next/standalone/server.js")).toBe("new build\n");
    expectIdentityChecked(r.output);
    expect(fs.existsSync(path.join(box, ".next-old"))).toBe(false);
    expect(logOf("systemctl.log")).toMatch(/^restart clawbox-setup$/m);
    expect(r.output).toContain("recovered the UI only");
  });

  it("still retries the mid-build trace race once, and judges the retry on its own output", () => {
    const r = runForceUpdate("trace-race-then-succeeds");

    expect(r.status, r.output).toBe(0);
    expect(logOf("builds").trim()).toBe("2");
    expect(git(box, "rev-parse", "HEAD")).toBe(newHead);
    expect(read(".next/standalone/server.js")).toBe("new build\n");
    expectIdentityChecked(r.output);
  });

  it("keeps the new build when it is interrupted while the parked one is being deleted", async () => {
    // The build passed all three checks, so the update is done; deleting the
    // parked tree takes seconds on a box. An interrupt then used to run the
    // rollback over it — the new build deleted, the half-deleted previous one
    // put back, the checkout moved back.
    writeExecutable(path.join(bin, "rm"), STUB_RM);
    const child = spawn("bash", [SCRIPT], { env: scriptEnv("succeeds", { STUB_HOLD_DROP: "1" }), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.on("exit", (c, s) => resolve(s ?? c)));

    await waitForMarker("drop-started");
    child.kill("SIGTERM");
    fs.writeFileSync(path.join(stubLog, "release"), "");

    // Nothing traps the signal any more: it ends the script where it stands.
    expect(await exited, stderr).toBe("SIGTERM");
    expect(stderr).not.toContain("rolling back");
    expect(git(box, "rev-parse", "HEAD")).toBe(newHead);
    expect(read(".next/standalone/server.js")).toBe("new build\n");
    // The rm the signal did not reach finishes on its own.
    await vi.waitFor(() => expect(fs.existsSync(path.join(box, ".next-old"))).toBe(false), { timeout: 30_000, interval: 50 });
  });
});
