import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Runs a real bash, a real node and a background churn loop per case.
// See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

/**
 * scripts/check-build-isolation.sh, the CI proof for TASK-1102: build over a
 * planted data/ and fail if the build reaches it.
 *
 * The real build is what CI runs it with (build-identity.yml). Here the build
 * is a stub that does what the real one would do in each case: writes a trace
 * that is clean or one that lists a planted file, prints Turbopack's
 * whole-project warning, fails outright, or leaves a data/ copy in the
 * standalone tree. That pins the other half: a checker that cannot fail proves
 * nothing, and one that left its fixture behind would be planting into
 * whatever tree it ran in.
 */

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "check-build-isolation.sh");

// What the stub build does, per $FAKE_MODE. It also writes down which planted
// hazards were really on disk while it ran.
const FAKE_BUILD = `#!/usr/bin/env bash
set -u
A=data/coding-agent-artifacts/run-fixture
{
  [ -L "$A/venv-attempt/venv/bin/python" ] && [ "$(readlink "$A/venv-attempt/venv/bin/python")" = python3 ] && echo venv-link
  [ "$(readlink "$A/venv-attempt/venv/bin/python3")" = /usr/bin/python3 ] && echo venv-escapes
  [ -L "$A/dangling" ] && [ ! -e "$A/dangling" ] && echo dangling
  ls data/fixture-names/*/x.tmp >/dev/null 2>&1 && echo name-tmp
  ls data/fixture-names/*/x.lock >/dev/null 2>&1 && echo name-lock
  [ -f .clawbox/worktrees/run-fixture/notes.txt ] && echo worktree
  [ -f .next-old/standalone/server.js ] && echo parked
} > "$FAKE_LOG/seen"
# Long enough for the churn loop to have come and gone a few times.
first="$(ls data/coding-agent-streams/run-churn-*.err 2>/dev/null | head -n 1)"
sleep 0.3
second="$(ls data/coding-agent-streams/run-churn-*.err 2>/dev/null | head -n 1)"
[ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ] && echo churn >> "$FAKE_LOG/seen"

mkdir -p .next/server/app/api .next/standalone
echo "module.exports = {}" > .next/standalone/server.js
trace() { printf '{"version":1,"files":[%s]}\\n' "$2" > ".next/server/$1"; }
trace app/api/route.js.nft.json '"../../../../node_modules/next/package.json"'
trace middleware.js.nft.json '"../../node_modules/next/package.json"'
case "$FAKE_MODE" in
  clean) ;;
  traces-data) trace instrumentation.js.nft.json '"../../data/coding-agent-streams/run-fixture.err"' ;;
  traces-worktree) trace middleware.js.nft.json '"../../.clawbox/worktrees/run-fixture/notes.txt"' ;;
  traces-git) trace instrumentation.js.nft.json '"../../.git/HEAD"' ;;
  traces-claim) trace instrumentation.js.nft.json '"../../.next-claim.123/standalone/server.js"' ;;
  whole-project) echo "Warning: Dynamic filesystem access causes tracing of the whole project" ;;
  fails) echo "> Build error occurred" >&2; exit 1 ;;
  standalone-data) mkdir -p .next/standalone/data/coding-agent-streams ;;
esac
exit 0
`;

let tmp: string;
let root: string;
let fakeLog: string;

function run(mode: string) {
  const r = spawnSync("bash", [path.join(root, "scripts", "check-build-isolation.sh"), "bash", path.join(tmp, "fake-build.sh")], {
    encoding: "utf-8",
    timeout: 50_000,
    env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: fakeLog, TMPDIR: tmp },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function seen(): string[] {
  try {
    return fs.readFileSync(path.join(fakeLog, "seen"), "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function expectNothingLeft(): void {
  for (const p of ["data", ".clawbox", ".next-old"]) {
    expect(fs.existsSync(path.join(root, p)), `${p} was left behind`).toBe(false);
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-build-isolation-")));
  root = path.join(tmp, "checkout");
  fakeLog = path.join(tmp, "log");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(fakeLog);
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "check-build-isolation.sh"));
  // The names the checker plants come from the source it finds.
  fs.writeFileSync(
    path.join(root, "src", "lib", "store.ts"),
    "export const tmpOf = (p: string) => `${p}.tmp`;\nexport const LOCK = \".lock\";\n",
  );
  fs.writeFileSync(path.join(tmp, "fake-build.sh"), FAKE_BUILD, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scripts/check-build-isolation.sh", () => {
  it("passes a build that stays out, with every hazard really planted while it ran", () => {
    const r = run("clean");

    expect(r.status, r.output).toBe(0);
    expect(r.stdout).toContain("check-build-isolation: OK");
    expect(seen().sort()).toEqual(
      ["churn", "dangling", "name-lock", "name-tmp", "parked", "venv-escapes", "venv-link", "worktree"].sort(),
    );
    expectNothingLeft();
  });

  it.each([
    ["traces-data", "data/coding-agent-streams/run-fixture.err"],
    ["traces-worktree", ".clawbox/worktrees/run-fixture/notes.txt"],
    ["traces-git", ".git/HEAD"],
    ["traces-claim", ".next-claim.123/standalone/server.js"],
  ])("fails a build whose trace reaches runtime state (%s)", (mode, reached) => {
    const r = run(mode);

    expect(r.status, r.output).not.toBe(0);
    expect(r.stderr).toContain(reached);
    expect(r.stderr).toContain("a build trace lists files under");
    expectNothingLeft();
  });

  it("fails a build Turbopack says traced the whole project, planted match or not", () => {
    const r = run("whole-project");

    expect(r.status, r.output).not.toBe(0);
    expect(r.stderr).toContain("traced a dynamic path across the whole project");
    expectNothingLeft();
  });

  it("fails a build that failed, and still cleans up", () => {
    const r = run("fails");

    expect(r.status, r.output).not.toBe(0);
    expect(r.stderr).toContain("the build exited 1");
    expectNothingLeft();
  });

  it("fails when .next/standalone holds a data/ tree", () => {
    const r = run("standalone-data");

    expect(r.status, r.output).not.toBe(0);
    expect(r.stderr).toContain(".next/standalone/data exists");
    expectNothingLeft();
  });

  it("refuses to run over a data/ that is already there, and leaves it alone", () => {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "config.json"), "{\"owner\":true}\n");

    const r = run("clean");

    expect(r.status, r.output).not.toBe(0);
    expect(r.stderr).toContain("already exists");
    expect(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8")).toBe("{\"owner\":true}\n");
    expect(seen(), "the build ran anyway").toEqual([]);
  });
});
