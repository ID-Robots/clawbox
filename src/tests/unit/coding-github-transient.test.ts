/**
 * GH-01c. #518 classified a dead uplink as a retryable fault — "a network that
 * is merely down gets 503, retry; 409 is for a request that cannot be
 * satisfied as it stands" — and wired `gh_unreachable` from githubStatus()
 * through backupToGitHub() to the route.
 *
 * It applied that only to the PROBE. The two calls that actually reach
 * github.com are `gh repo create --push` and `git push --set-upstream`, both on
 * the 180 s PUSH_TIMEOUT_MS, and both still answered `reason: "failed"` when
 * their child was killed — even though the very detail they attach reads
 * "Check this ClawBox's network connection and try again." reason "failed" is
 * not "gh_unreachable", so the route's ternary returned 409: a non-retryable
 * client error whose own text tells the owner to retry.
 *
 * The four killed LOCAL git probes have the same problem one step earlier: a
 * `git rev-parse` that our timer killed is a transient fault too, and 409 says
 * the request is wrong when nothing about it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A call that hangs on a dead uplink until our timer kills it. */
function hangingChild(): FakeChild {
  const child = baseChild();
  setImmediate(() => child.emit("spawn"));
  child.kill = (signal) => {
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

function exitingChild(code: number, text = ""): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("spawn");
    if (text) child.stderr.emit("data", Buffer.from(text));
    child.emit("close", code, null);
  });
  return child;
}

/** A spawn that failed and did not say why — an `error` with no errno. */
function errnoLessFailure(): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", new Error("spawn failed"));
    child.emit("close", null, null);
  });
  return child;
}

function gitChild(code: number, text = "", errText = ""): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("spawn");
    if (text) child.stdout.emit("data", Buffer.from(text));
    if (errText) child.stderr.emit("data", Buffer.from(errText));
    child.emit("close", code, null);
  });
  return child;
}

/** Clear the LONGEST budget in the module — pushes get 180 s, not 60. */
async function withTimeoutFired<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = work();
    await vi.advanceTimersByTimeAsync(400_000);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

const CONNECTED = "Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n";
const DIR = "/home/clawbox/Projects/site";
const TOPLEVEL = path.resolve(DIR);

function script(answer: (bin: string, args: string[]) => FakeChild): void {
  spawnMock.mockImplementation((bin: string, args: string[]) => answer(bin, args));
}

/** Everything up to and including the remote lookup answers normally. */
function upToRemote(bin: string, args: string[], remote: FakeChild | null): FakeChild | null {
  if (bin === "gh" && args[0] === "auth") return exitingChild(0, CONNECTED);
  if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
  if (args.includes("--verify")) return gitChild(0, "abc123");
  if (args.includes("--abbrev-ref")) return gitChild(0, "main");
  if (args.includes("get-url")) return remote;
  return null;
}

beforeEach(async () => {
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-github");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a network fault on the calls that reach github.com is reported as one", () => {
  it("answers gh_unreachable when `gh repo create` is killed", async () => {
    // No remote yet, so the create branch runs — and hangs on the uplink.
    script((bin, args) => {
      const early = upToRemote(bin, args, gitChild(1));
      if (early) return early;
      if (bin === "gh" && args[0] === "repo") return hangingChild();
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() => lib.backupToGitHub(DIR));

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    // The detail already says "check the network and try again". The reason
    // has to agree, or the route answers 409 to its own retry advice.
    expect(outcome.reason).toBe("gh_unreachable");
    expect(outcome.detail ?? "").toMatch(/network|timed out/i);
  });

  it("answers gh_unreachable when `git push` is killed", async () => {
    script((bin, args) => {
      const early = upToRemote(bin, args, gitChild(0, "git@github.com:me/site.git"));
      if (early) return early;
      if (args.includes("push")) return hangingChild();
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() => lib.backupToGitHub(DIR));

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("gh_unreachable");
    expect(outcome.detail ?? "").toMatch(/push/i);
  });

  it("still answers `failed` when GitHub itself refused the create", async () => {
    // The discriminator: a real refusal from a reachable GitHub is NOT
    // transient, and must keep answering 409 with what gh said.
    script((bin, args) => {
      const early = upToRemote(bin, args, gitChild(1));
      if (early) return early;
      if (bin === "gh" && args[0] === "repo") return exitingChild(1, "GraphQL: Name already exists on this account");
      return gitChild(0);
    });

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.transient).toBeFalsy();
    expect(outcome.detail ?? "").toMatch(/already exists/i);
  });

  it("still answers `failed` when the remote rejected the push", async () => {
    script((bin, args) => {
      const early = upToRemote(bin, args, gitChild(0, "git@github.com:me/site.git"));
      if (early) return early;
      if (args.includes("push")) return gitChild(1, "", "! [rejected] main -> main (fetch first)");
      return gitChild(0);
    });

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.transient).toBeFalsy();
    expect(outcome.detail ?? "").toMatch(/rejected/i);
  });
});

/**
 * The four local probes. Each already refuses to invent a finding (#518); what
 * they did not do is say the refusal was transient, so the owner got a 409 —
 * "your request is wrong" — for a git call our own timer killed.
 */
describe("a killed local git probe is reported as transient", () => {
  const cases: { name: string; hang: (args: string[]) => boolean; remote: number }[] = [
    { name: "the repo-root probe", hang: (a) => a.includes("--show-toplevel"), remote: 0 },
    { name: "the commit probe", hang: (a) => a.includes("--verify"), remote: 0 },
    { name: "the branch probe", hang: (a) => a.includes("--abbrev-ref"), remote: 0 },
    { name: "the remote probe", hang: (a) => a.includes("get-url"), remote: 0 },
  ];

  for (const c of cases) {
    it(`marks ${c.name} transient so the route can answer 503`, async () => {
      script((bin, args) => {
        if (bin === "gh" && args[0] === "auth") return exitingChild(0, CONNECTED);
        if (c.hang(args)) return hangingChild();
        if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
        if (args.includes("--verify")) return gitChild(0, "abc123");
        if (args.includes("--abbrev-ref")) return gitChild(0, "main");
        if (args.includes("get-url")) return gitChild(c.remote, "git@github.com:me/site.git");
        return gitChild(0);
      });

      const outcome = await withTimeoutFired(() => lib.backupToGitHub(DIR));

      expect(outcome.pushed).toBe(false);
      if (outcome.pushed) return;
      expect(outcome.transient).toBe(true);
      expect((outcome.detail ?? "").trim()).not.toBe("");
    });
  }

  it("does not call gh MISSING when the spawn failed with no errno", async () => {
    // Raised in review on this PR: `startError === null` was folded in with
    // ENOENT, so a spawn error that named no reason answered "not installed"
    // — the wrong remedy, drawn from no evidence at all.
    spawnMock.mockImplementation(() => errnoLessFailure());

    const status = await lib.githubStatus();

    expect(status.reason).not.toBe("not_installed");
    expect(status.connected).toBe(false);

    const out = await lib.disconnectGitHub();
    expect(out.ok).toBe(false);
    expect(out.kind).not.toBe("no_gh");
    expect(out.detail ?? "").not.toMatch(/is not installed/i);
    expect(out.detail ?? "").toMatch(/would not start/i);
    expect(out.detail ?? "").not.toMatch(/\(null\)|\(undefined\)/);
  });

  it("still calls gh MISSING for a real ENOENT", async () => {
    // The discriminator: tightening the rule must not lose the true case.
    spawnMock.mockImplementation(() => {
      const child = baseChild();
      setImmediate(() => {
        child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
        child.emit("close", null, null);
      });
      return child;
    });

    const status = await lib.githubStatus();

    expect(status.installed).toBe(false);
    expect(status.reason).toBe("not_installed");
  });

  it("does not mark a genuine `not a repo` transient", async () => {
    script((bin, args) => {
      if (bin === "gh" && args[0] === "auth") return exitingChild(0, CONNECTED);
      if (args.includes("--show-toplevel")) return gitChild(128, "");
      return gitChild(0);
    });

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("not_a_repo");
    expect(outcome.transient).toBeFalsy();
  });
});
