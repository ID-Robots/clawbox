/**
 * GH-01a and GH-01d — the half of #518's lesson that landed in `coding-git.ts`
 * and not in its twin.
 *
 * `wasKilled()` is defined as `!r.startFailed && r.code === null`. It
 * DELIBERATELY excludes a failed spawn, because a killed child and a child that
 * never started are different facts with different remedies. The shared module
 * exports `inconclusive()` — "started-and-killed OR never started", i.e. no
 * finding either way — precisely so a guard that only wants to know "did this
 * call tell me anything about the world?" asks one question.
 *
 * `backupToGitHub` guards all four of its local git probes with `wasKilled`
 * alone. So when `git` cannot be started at all — EAGAIN or ENOMEM on fork
 * under load, EMFILE, a git chmod'ed 644 — every guard is skipped and the next
 * line reads the null code as a FINDING about the folder:
 *
 *   - `top.code !== 0`       -> "This folder is not its own git repository."
 *   - `head.code !== 0`      -> "The folder has no commits yet."
 *   - `hasRemote.code !== 0` -> `gh repo create --private --source --push`
 *
 * That last one is the irreversible outcome #518's own comment pins against:
 * "reading it as 'no remote' would create a second repository for a folder that
 * already has one — an irreversible guess made from a transient fault." The
 * guard was written for the killed case and never for the spawn-failure case.
 *
 * GH-01d is the same conflation on the way out: `gh repo create`, `git push`
 * and `gh auth logout` build their detail from raw `(stderr || stdout)`, so a
 * failed spawn renders runChild's five-word placeholder and an exit that wrote
 * to neither stream renders the empty string — the blank #518 removed from the
 * killed push, still live one branch over.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import path from "path";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

type Lib = typeof import("@/lib/coding-github");
let lib: Lib;

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal: NodeJS.Signals) => boolean;
}

function baseChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

/**
 * A spawn that never happened: `error` WITHOUT a preceding `spawn`, carrying a
 * real errno. EAGAIN is what fork() returns on a Jetson that is out of process
 * slots — the loaded-box condition, not an exotic one.
 */
function startFailure(errno = "EAGAIN"): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", Object.assign(new Error(`spawn ${errno}`), { code: errno }));
    child.emit("close", null, null);
  });
  return child;
}

function exitingChild(code: number, out = "", err = ""): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("spawn");
    if (out) child.stdout.emit("data", Buffer.from(out));
    if (err) child.stderr.emit("data", Buffer.from(err));
    child.emit("close", code, null);
  });
  return child;
}

const CONNECTED = "Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n";
const DIR = "/home/clawbox/Projects/site";
const TOPLEVEL = path.resolve(DIR);

/** Everything healthy, except the one call the test names. */
function script(broken: (bin: string, args: string[]) => FakeChild | null, remoteCode = 0): void {
  spawnMock.mockImplementation((bin: string, args: string[]) => {
    const hit = broken(bin, args);
    if (hit) return hit;
    if (bin === "gh" && args[0] === "auth") return exitingChild(0, "", CONNECTED);
    if (args.includes("--show-toplevel")) return exitingChild(0, TOPLEVEL);
    if (args.includes("--verify")) return exitingChild(0, "abc123");
    if (args.includes("--abbrev-ref")) return exitingChild(0, "main");
    if (args.includes("get-url")) return exitingChild(remoteCode, "git@github.com:me/site.git");
    return exitingChild(0);
  });
}

/** What the module actually spawned, in order — the only proof that a repository
 *  was or was not created. */
function spawned(): [string, string[]][] {
  return spawnMock.mock.calls as [string, string[]][];
}

function ghRepoCreateSpawned(): boolean {
  return spawned().some(([bin, args]) => bin === "gh" && args[0] === "repo" && args[1] === "create");
}

beforeEach(async () => {
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-github");
});

describe("a git that could not be started is not a finding about the folder", () => {
  it("never creates a second GitHub repository because the remote probe failed to spawn", async () => {
    // THE consequential one. `git remote get-url origin` never ran, so nothing
    // is known about whether this folder already has an origin — and the branch
    // below it makes a repository on github.com that cannot be un-made.
    script((bin, args) => (bin === "git" && args.includes("get-url") ? startFailure() : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(ghRepoCreateSpawned()).toBe(false);
    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.transient).toBe(true);
    expect(outcome.detail ?? "").toMatch(/EAGAIN/);
  });

  it("does not report 'not its own git repository' when the toplevel probe failed to spawn", async () => {
    script((bin, args) => (bin === "git" && args.includes("--show-toplevel") ? startFailure() : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).not.toBe("not_a_repo");
    expect(outcome.transient).toBe(true);
    expect(outcome.detail ?? "").not.toMatch(/not its own git repository/i);
  });

  it("does not report 'no commits yet' when the HEAD probe failed to spawn", async () => {
    script((bin, args) => (bin === "git" && args.includes("--verify") ? startFailure() : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).not.toBe("nothing_to_push");
    expect(outcome.transient).toBe(true);
  });

  it("does not push a guessed branch when the branch probe failed to spawn", async () => {
    // The "main" fallback is fine when git answered and had no name to give.
    // When git never ran it binds a `develop` checkout to origin/main over a
    // transient fault, so the call must refuse instead.
    script((bin, args) => (bin === "git" && args.includes("--abbrev-ref") ? startFailure() : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.transient).toBe(true);
    const pushed = spawned().some(([, args]) => args.includes("push"));
    expect(pushed).toBe(false);
  });

  it("names the errno rather than saying the call was stopped before it finished", async () => {
    // A failed spawn was never "stopped before it finished" — it never began,
    // and killedDetail's wording describes a child that ran.
    script((bin, args) => (bin === "git" && args.includes("--show-toplevel") ? startFailure("ENOMEM") : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.detail ?? "").toMatch(/ENOMEM/);
    expect(outcome.detail ?? "").not.toMatch(/stopped before it finished|timed out/i);
  });
});

describe("a call that left the box and could not start is reported as a fault, not a refusal", () => {
  it("does not hand back runChild's placeholder when `gh repo create` failed to spawn", async () => {
    script((bin, args) => (bin === "gh" && args[0] === "repo" ? startFailure() : null), 1);

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.detail ?? "").not.toBe("could not start");
    expect(outcome.detail ?? "").toMatch(/EAGAIN/);
    // Nothing about the request was wrong, so the route must not answer 409.
    expect(outcome.transient).toBe(true);
    // Raised by review on this PR. A create that never started never reached
    // the uplink, so "check your network connection" is the wrong remedy —
    // the same wrong-remedy defect this PR removes, one line over.
    expect(outcome.detail ?? "").not.toMatch(/network/i);
  });

  it("does not hand back runChild's placeholder when `git push` failed to spawn", async () => {
    script((bin, args) => (bin === "git" && args.includes("push") ? startFailure() : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.detail ?? "").not.toBe("could not start");
    expect(outcome.detail ?? "").toMatch(/EAGAIN/);
    expect(outcome.transient).toBe(true);
    expect(outcome.detail ?? "").not.toMatch(/network/i);
  });

  it("never renders a blank message for a create that wrote to neither stream", async () => {
    script((bin, args) => (bin === "gh" && args[0] === "repo" ? exitingChild(1) : null), 1);

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect((outcome.detail ?? "").trim()).not.toBe("");
  });

  it("never renders a blank message for a push that wrote to neither stream", async () => {
    script((bin, args) => (bin === "git" && args.includes("push") ? exitingChild(1) : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect((outcome.detail ?? "").trim()).not.toBe("");
  });

  it("never renders a blank message for a logout that wrote to neither stream", async () => {
    spawnMock.mockImplementation(() => exitingChild(1));

    const out = await lib.disconnectGitHub();

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect((out.detail ?? "").trim()).not.toBe("");
  });
});

describe("the findings that are real are still reported as findings", () => {
  it("still answers not_a_repo when git looked and said no", async () => {
    script((bin, args) => (bin === "git" && args.includes("--show-toplevel") ? exitingChild(128) : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("not_a_repo");
    expect(outcome.transient).toBeFalsy();
  });

  it("still answers nothing_to_push for a folder with no commits", async () => {
    script((bin, args) => (bin === "git" && args.includes("--verify") ? exitingChild(128) : null));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("nothing_to_push");
    expect(outcome.transient).toBeFalsy();
  });

  it("still creates the repository when git really says there is no remote", async () => {
    script((bin, args) => (bin === "gh" && args[0] === "repo" ? exitingChild(0) : null), 1);

    const outcome = await lib.backupToGitHub(DIR);

    expect(ghRepoCreateSpawned()).toBe(true);
    expect(outcome.pushed).toBe(true);
  });

  it("still keeps GitHub's own refusal, and its 409", async () => {
    script(
      (bin, args) => (bin === "gh" && args[0] === "repo" ? exitingChild(1, "", "GraphQL: Name already exists") : null),
      1,
    );

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.transient).toBeFalsy();
    expect(outcome.detail ?? "").toMatch(/already exists/i);
  });
});
