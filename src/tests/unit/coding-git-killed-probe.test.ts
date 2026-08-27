/**
 * GH-01a / GH-01b. src/lib/coding-git.ts was the unfixed twin of
 * src/lib/coding-github.ts.
 *
 * #518 removed one belief from the GitHub wrapper: that `code === null` means
 * the binary is missing. It does not. A child killed by our own SIGKILL closes
 * with exactly the same null a failed spawn produces, and a spawn `error` is
 * not proof of absence either — ENOENT means missing, EACCES means present and
 * not executable, and the remedies are opposites.
 *
 * coding-git.ts kept a byte-for-byte copy of the pre-#518 wrapper: no `spawn`
 * listener, no signal, no timedOut, no startError. Three consequences, all
 * pinned below.
 *
 *  1. `if (probe.code === null) return no_git` reports a git that RAN — or one
 *     sitting right there with the wrong mode bits — as "git is not
 *     installed", the one remedy that cannot help.
 *
 *  2. A SIGKILLed child writes no stderr, so `detail: add.stderr` was "".
 *     coding-agent.ts renders `outcome.detail ?? outcome.reason`, and "" is
 *     not nullish, so the run panel showed the owner literally
 *     "Not committed: " with no reason at all.
 *
 *  3. The consequential one. This file's own header calls the rule
 *     non-negotiable: a folder inside a repository that TRACKS it is someone
 *     else's working tree and a run has no business committing to it. That
 *     refusal is decided by two probes that both returned `false` for a null
 *     code — so one killed `rev-parse --is-inside-work-tree` turned the
 *     refusal into `git init` INSIDE another repository's tracked tree,
 *     shadowing that subtree's history and committing into it. An unknown
 *     repository shape is not an absent one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import path from "path";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

type Lib = typeof import("@/lib/coding-git");
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

/** A child that runs forever until our timer kills it. It SPAWNED, so git is
 *  installed; the kernel closes it with a null code and the signal. */
function hangingChild(): FakeChild {
  const child = baseChild();
  setImmediate(() => child.emit("spawn"));
  child.kill = (signal) => {
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

/** git is genuinely absent: `error` with ENOENT, never a `spawn`. */
function missingBinary(): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
    child.emit("close", null, null);
  });
  return child;
}

/** git is RIGHT THERE and would not execute. Same null code, opposite remedy. */
function unrunnableBinary(): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", Object.assign(new Error("spawn git EACCES"), { code: "EACCES" }));
    child.emit("close", null, null);
  });
  return child;
}

/**
 * A spawn that failed and did not say why — an `error` with no errno. The
 * absence of evidence, which the code used to fold in with ENOENT and answer
 * "not installed": the same guess this module exists to stop, one layer down.
 */
function errnoLessFailure(): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", new Error("spawn failed"));
    child.emit("close", null, null);
  });
  return child;
}

/** A child that ran and exited, writing `text` to stdout. */
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

/** Fire the module's 30 s GIT_TIMEOUT_MS, then settle. */
async function withTimeoutFired<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = work();
    await vi.advanceTimersByTimeAsync(120_000);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

const DIR = "/home/clawbox/Projects/site";
const TOPLEVEL = path.resolve(DIR);
const INPUT = { directory: DIR, runId: "run-aaaa1111", task: "add a toggle", summary: "did it" };

/** Answer each spawned git by the argv it was given, recording the calls. */
let seen: string[][];
function script(answer: (args: string[]) => FakeChild): void {
  seen = [];
  spawnMock.mockImplementation((bin: string, args: string[]) => {
    seen.push([bin, ...args]);
    return answer(args);
  });
}

/** True when `git init` was run — the irreversible step. */
function ranInit(): boolean {
  return seen.some((c) => c.includes("init"));
}

beforeEach(async () => {
  spawnMock.mockReset();
  seen = [];
  vi.resetModules();
  lib = await import("@/lib/coding-git");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GH-01a — a null exit code is not proof git is missing", () => {
  it("does not say 'git is not installed' for a git that is present but not executable", async () => {
    // EACCES: the file exists, which is why the errno is not ENOENT. Sending
    // the owner to install it offers the one remedy that cannot work.
    script(() => unrunnableBinary());

    const out = await lib.commitRunWork(INPUT);

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).not.toBe("no_git");
    expect(out.detail ?? "").toMatch(/permission/i);
    expect(out.detail ?? "").not.toMatch(/not installed/i);
  });

  it("still says git is missing when the binary genuinely cannot start", async () => {
    script(() => missingBinary());

    const out = await lib.commitRunWork(INPUT);

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("no_git");
    expect(out.detail ?? "").toMatch(/not installed/i);
  });

  it("does not say 'git is not installed' for a spawn failure with NO errno", async () => {
    // Raised in review on this PR. ENOENT is the only errno that means "there
    // is no such file"; an error carrying none means the spawn failed and did
    // not say why. Reading that as absence is the same unfounded guess as
    // reading a null exit code as absence — and it hands over the same wrong
    // remedy. The message must name both things worth checking, neither as a
    // finding.
    script(() => errnoLessFailure());

    const out = await lib.commitRunWork(INPUT);

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).not.toBe("no_git");
    expect(out.reason).toBe("git_failed");
    expect(out.detail ?? "").not.toMatch(/is not installed/i);
    expect(out.detail ?? "").toMatch(/would not start/i);
    // and never the raw errno slot rendered empty
    expect(out.detail ?? "").not.toMatch(/\(null\)|\(undefined\)/);
  });

  it("does not say 'git is not installed' when the version probe was KILLED", async () => {
    // It ran. Being killed says nothing about whether it is on the box.
    script(() => hangingChild());

    const out = await withTimeoutFired(() => lib.commitRunWork(INPUT));

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).not.toBe("no_git");
    expect(out.reason).toBe("git_failed");
    expect((out.detail ?? "").trim()).not.toBe("");
  });

  it("never reports a killed `git add` with a blank message", async () => {
    // A SIGKILLed child writes no stderr, so `detail: add.stderr` was "". The
    // owner's run panel then read "Not committed: " and stopped there.
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("add")) return hangingChild();
      return gitChild(0);
    });

    const out = await withTimeoutFired(() => lib.commitRunWork(INPUT));

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("git_failed");
    expect((out.detail ?? "").trim()).not.toBe("");
  });

  it("never reports a killed `git commit` with a blank message", async () => {
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("--cached")) return gitChild(0, "index.html");
      if (args.includes("commit")) return hangingChild();
      return gitChild(0);
    });

    const out = await withTimeoutFired(() => lib.commitRunWork(INPUT));

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("git_failed");
    expect((out.detail ?? "").trim()).not.toBe("");
  });

  it("still reports what git actually said when git actually spoke", async () => {
    // The other half: a real refusal must keep its real message.
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("add")) return gitChild(128, "", "fatal: pathspec did not match");
      return gitChild(0);
    });

    const out = await lib.commitRunWork(INPUT);

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("git_failed");
    expect(out.detail ?? "").toMatch(/pathspec/);
  });
});

describe("GH-01b — an inconclusive repository shape is never acted on", () => {
  it("does not `git init` inside another repository when the inside-work-tree probe is killed", async () => {
    // The consequential one. `rev-parse --is-inside-work-tree` returning
    // non-zero means "no repo here", and the branch below it CREATES one. A
    // killed probe returns the same null, so reading it as a finding runs
    // `git init` in a tree somebody else's repository tracks — shadowing that
    // subtree's history and committing into it.
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, "/home/clawbox/clawbox");
      if (args.includes("--is-inside-work-tree")) return hangingChild();
      return gitChild(0);
    });

    const out = await withTimeoutFired(() => lib.commitRunWork(INPUT));

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("git_failed");
    expect((out.detail ?? "").trim()).not.toBe("");
    // The point of the test: nothing was created.
    expect(ranInit()).toBe(false);
  });

  it("does not claim the folder belongs to another repository when check-ignore is killed", async () => {
    // The mirror lie. A killed `check-ignore` was read as "not ignored", which
    // with an enclosing repo produces the refusal message about a folder that
    // may well be ignored and perfectly free to init.
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, "/home/clawbox/clawbox");
      if (args.includes("--is-inside-work-tree")) return gitChild(0, "true");
      if (args.includes("check-ignore")) return hangingChild();
      return gitChild(0);
    });

    const out = await withTimeoutFired(() => lib.commitRunWork(INPUT));

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).not.toBe("foreign_repo");
    expect(out.detail ?? "").not.toMatch(/belongs to another git repository/i);
    expect(ranInit()).toBe(false);
  });

  it("does not `git init` when the repo-root probe itself is killed", async () => {
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return hangingChild();
      return gitChild(0);
    });

    const out = await withTimeoutFired(() => lib.commitRunWork(INPUT));

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("git_failed");
    expect((out.detail ?? "").trim()).not.toBe("");
    expect(ranInit()).toBe(false);
  });

  it("still REFUSES a folder an enclosing repository really does track", async () => {
    // The rule itself must survive the fix: real findings still decide.
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, "/home/clawbox/clawbox");
      if (args.includes("--is-inside-work-tree")) return gitChild(0, "true");
      if (args.includes("check-ignore")) return gitChild(1);
      return gitChild(0);
    });

    const out = await lib.commitRunWork(INPUT);

    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("foreign_repo");
    expect(ranInit()).toBe(false);
  });

  it("still gives a folder its own repository when the outer tree ignores it", async () => {
    script((args) => {
      if (args.includes("--version")) return gitChild(0, "git version 2.43.0");
      if (args.includes("--show-toplevel")) return gitChild(0, "/home/clawbox/clawbox");
      if (args.includes("--is-inside-work-tree")) return gitChild(0, "true");
      if (args.includes("check-ignore")) return gitChild(0);
      if (args.includes("--cached")) return gitChild(0, "index.html");
      if (args.includes("--short")) return gitChild(0, "abc1234");
      return gitChild(0);
    });

    const out = await lib.commitRunWork(INPUT);

    expect(out.committed).toBe(true);
    if (!out.committed) return;
    expect(out.initialized).toBe(true);
    expect(ranInit()).toBe(true);
  });
});
