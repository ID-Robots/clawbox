/**
 * A folder whose repository already exists on the owner's account — the
 * harness test remakes its folder, a restore does too — used to fail its
 * backup with GitHub's "Name already exists on this account". The
 * repository IS the folder's: the backup attaches it and pushes, and only a
 * push GitHub rejects is reported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

type Lib = typeof import("@/lib/coding-github");
let lib: Lib;

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal: NodeJS.Signals) => boolean;
}

function exitingChild(code: number, out = "", err = ""): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    child.emit("spawn");
    if (out) child.stdout.emit("data", Buffer.from(out));
    if (err) child.stderr.emit("data", Buffer.from(err));
    child.emit("close", code, null);
  });
  return child;
}

const DIR = "/home/clawbox/Projects/harness-test";
const LOGGED_IN = "github.com\n  ✓ Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n";

/** Script the box: every git/gh call answered by what it asked. */
function script(overrides: Partial<Record<string, () => FakeChild>> = {}) {
  const calls: string[] = [];
  spawnMock.mockImplementation((cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    for (const [needle, make] of Object.entries(overrides)) {
      if (line.includes(needle) && make) return make();
    }
    if (line.includes("auth status")) return exitingChild(0, "", LOGGED_IN);
    if (line.includes("rev-parse --show-toplevel")) return exitingChild(0, DIR);
    if (line.includes("rev-parse --verify HEAD")) return exitingChild(0, "e1ff637");
    if (line.includes("rev-parse --abbrev-ref HEAD")) return exitingChild(0, "master");
    if (line.includes("remote get-url origin")) return exitingChild(1, "", "fatal: No such remote 'origin'");
    if (line.includes("repo create")) return exitingChild(1, "", "GraphQL: Name already exists on this account (createRepository)");
    if (line.includes("repo view yalexx/harness-test")) return exitingChild(0, JSON.stringify({ url: "https://github.com/yalexx/harness-test" }));
    if (line.includes("remote add origin")) return exitingChild(0);
    if (line.includes("push --set-upstream origin master")) return exitingChild(0);
    return exitingChild(0);
  });
  return calls;
}

beforeEach(async () => {
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-github");
});

describe("backing up a folder whose repository already exists on the account", () => {
  it("attaches the repository as origin and pushes the branch, reporting it as not newly created", async () => {
    const calls = script();
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome).toEqual({ pushed: true, repo: "https://github.com/yalexx/harness-test.git", created: false, branch: "master" });
    expect(calls).toContainEqual(expect.stringContaining("repo view yalexx/harness-test --json url"));
    expect(calls).toContainEqual(expect.stringContaining("remote add origin https://github.com/yalexx/harness-test.git"));
    expect(calls).toContainEqual(expect.stringContaining("push --set-upstream origin master"));
    // Never a force push, whatever the histories.
    expect(calls.some((c) => c.includes("push") && c.includes("--force"))).toBe(false);
  });

  it("reports a push GitHub rejected in words, without forcing it", async () => {
    script({ "push --set-upstream": () => exitingChild(1, "", "! [rejected] master -> master (fetch first)") });
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.detail).toMatch(/history|rejected/i);
    expect(outcome.detail).toMatch(/\s/);
  });

  it("falls back to GitHub's own refusal when the existing repository cannot be read", async () => {
    script({ "repo view": () => exitingChild(1, "", "GraphQL: Could not resolve to a Repository") });
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.detail).toContain("already exists");
  });

  it("reports a killed or unstarted probe of the existing repository as a fault worth retrying, never as GitHub's refusal", async () => {
    const killed = (): FakeChild => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => { child.emit("spawn"); child.emit("close", null, "SIGKILL"); });
      return child;
    };
    script({ "repo view": killed });
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason === "gh_unreachable" || outcome.transient === true).toBe(true);
    expect(outcome.detail).not.toContain("already exists");
  });

  it("pushes the base branch beside a run branch on a new repository and makes it the default, so a pull request has something to compare", async () => {
    // No remote before the create, the new one after it.
    let remoteAsks = 0;
    const calls = script({
      "repo create": () => exitingChild(0, "https://github.com/yalexx/harness-test"),
      "rev-parse --abbrev-ref HEAD": () => exitingChild(0, "clawbox/run-abc"),
      "rev-parse --verify --quiet refs/heads/main": () => exitingChild(1),
      "rev-parse --verify --quiet refs/heads/master": () => exitingChild(0, "e1ff637"),
      "remote get-url origin": () => (remoteAsks++ === 0 ? exitingChild(1, "", "fatal: No such remote 'origin'") : exitingChild(0, "https://github.com/yalexx/harness-test.git")),
    });
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome).toMatchObject({ pushed: true, created: true, branch: "clawbox/run-abc", base: "master" });
    expect(calls).toContainEqual(expect.stringContaining("push --set-upstream origin master"));
    expect(calls).toContainEqual(expect.stringContaining("api -X PATCH repos/yalexx/harness-test -f default_branch=master"));
  });

  it("leaves the default alone when the checkout is on the base branch itself", async () => {
    let remoteAsks = 0;
    const calls = script({
      "repo create": () => exitingChild(0, "https://github.com/yalexx/harness-test"),
      "rev-parse --abbrev-ref HEAD": () => exitingChild(0, "master"),
      "rev-parse --verify --quiet refs/heads/main": () => exitingChild(1),
      "remote get-url origin": () => (remoteAsks++ === 0 ? exitingChild(1, "", "fatal: No such remote 'origin'") : exitingChild(0, "https://github.com/yalexx/harness-test.git")),
    });
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome).toMatchObject({ pushed: true, created: true, branch: "master" });
    expect("base" in outcome).toBe(false);
    expect(calls.some((c) => c.includes("default_branch="))).toBe(false);
  });

  it("does not attach anything when the create failed for another reason", async () => {
    const calls = script({ "repo create": () => exitingChild(1, "", "GraphQL: Resource not accessible by integration") });
    const outcome = await lib.backupToGitHub(DIR);
    expect(outcome.pushed).toBe(false);
    expect(calls.some((c) => c.includes("remote add"))).toBe(false);
  });
});
