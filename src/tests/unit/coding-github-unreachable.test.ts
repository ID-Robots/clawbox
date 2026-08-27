/**
 * GH-01. A `gh` probe that TIMED OUT was reported as "gh is not installed".
 *
 * `run()` kills a slow child with SIGKILL, and a signalled child closes with
 * `code === null` — the very same null the `error` handler resolves with when
 * the binary could not be started at all. The two were indistinguishable, so
 * `githubStatus()` answered `installed: false` for both.
 *
 * That matters because `gh auth status` is a NETWORK call: it validates the
 * stored token against api.github.com. On a box whose uplink is down, or
 * behind a captive portal, the call hangs, the timer kills it, and the device
 * told the owner to install software that was already there — gh 2.4.0 is on
 * the box this was found on. A transient environment fault reported as a
 * permanent missing-dependency fact, with the wrong remedy attached.
 *
 * The discriminator these tests pin: the `error` event is the ONLY evidence
 * that gh could not start. A `close` carrying a signal means the process ran,
 * which means the binary exists.
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

/**
 * A child that runs forever until something kills it: `gh auth status` waiting
 * on api.github.com behind a dead uplink. When killed it closes the way the
 * kernel closes a signalled process — a null exit code, and the signal.
 */
function hangingChild(): FakeChild {
  const child = baseChild();
  child.kill = (signal) => {
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

/**
 * A binary that is not there. Node emits `error` for the failed spawn and then
 * `close` with a null code and NO signal — nothing ever ran. Critically it
 * never emits `spawn`, which is the only thing that distinguishes it from the
 * child below.
 */
function missingBinary(): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
    child.emit("close", null, null);
  });
  return child;
}

/**
 * A child that started fine but whose kill() cannot deliver the signal — Node
 * reports that by emitting `error` on an ALREADY SPAWNED process. It looks
 * identical to a failed spawn unless `spawn` is tracked, which is how the
 * missing-gh lie could sneak back in through the timeout path itself.
 */
function unkillableChild(): FakeChild {
  const child = baseChild();
  setImmediate(() => child.emit("spawn"));
  child.kill = () => {
    setImmediate(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
    return false;
  };
  return child;
}

/** A child that runs and exits, writing `text` to stderr the way gh does. */
function exitingChild(code: number, text = ""): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    if (text) child.stderr.emit("data", Buffer.from(text));
    child.emit("close", code, null);
  });
  return child;
}

/** The same, on stdout — where git answers `rev-parse` and `remote get-url`. */
function gitChild(code: number, text = ""): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    if (text) child.stdout.emit("data", Buffer.from(text));
    child.emit("close", code, null);
  });
  return child;
}

/**
 * Drive the module's own timeout budgets, then settle the promise. The advance
 * must clear the LONGEST of them — pushes get 180s, not the 60s a probe gets —
 * or a hanging push is never killed and the test times out instead of asserting.
 */
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

beforeEach(async () => {
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-github");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a probe that timed out is not a missing gh", () => {
  it("reports gh as INSTALLED but unreachable when the probe is killed", async () => {
    spawnMock.mockImplementation(() => hangingChild());

    const status = await withTimeoutFired(() => lib.githubStatus());

    // The process ran, so the binary is there. Saying otherwise sends the
    // owner to install something they already have.
    expect(status.installed).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.login).toBeNull();
    expect(status.reason).toBe("unreachable");
  });

  it("does not report a missing gh when the KILL fails on a running process", async () => {
    // The regression that would undo this whole fix from the inside: `error`
    // fires on a child that spawned fine, our timer's kill could not land, and
    // reading that as "could not start" says gh is not installed again.
    spawnMock.mockImplementation(() => unkillableChild());

    const status = await withTimeoutFired(() => lib.githubStatus());

    expect(status.installed).toBe(true);
    expect(status.reason).toBe("unreachable");
    expect(status.reason).not.toBe("not_installed");
  });

  it("still reports gh as MISSING when the binary genuinely cannot start", async () => {
    spawnMock.mockImplementation(() => missingBinary());

    const status = await lib.githubStatus();

    expect(status.installed).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.reason).toBe("not_installed");
  });

  it("answers normally when gh answers, with no failure reason attached", async () => {
    spawnMock.mockImplementation(() =>
      exitingChild(0, "github.com\n  Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n"),
    );

    const status = await lib.githubStatus();

    expect(status.installed).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.login).toBe("yalexx");
    expect(status.reason).toBeUndefined();
  });

  it("reports a logged-out gh as installed and simply not connected", async () => {
    spawnMock.mockImplementation(() =>
      exitingChild(1, "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n"),
    );

    const status = await lib.githubStatus();

    expect(status.installed).toBe(true);
    expect(status.connected).toBe(false);
    // Not an error state: nobody has logged in yet, which is not a failure.
    expect(status.reason).toBeUndefined();
  });

  it("re-probes on every call — an unreachable answer is never cached", async () => {
    // The recurring shape in this codebase: a probe taken once and reused
    // forever. A cached "unreachable" would outlive the outage that caused it
    // and keep denying a backup after the network came back.
    spawnMock.mockImplementation(() => hangingChild());
    const down = await withTimeoutFired(() => lib.githubStatus());
    expect(down.reason).toBe("unreachable");

    spawnMock.mockImplementation(() =>
      exitingChild(0, "Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n"),
    );
    const up = await lib.githubStatus();

    expect(up.connected).toBe(true);
    expect(up.reason).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe("disconnecting over a dead network", () => {
  it("does not claim gh is missing when the logout timed out", async () => {
    spawnMock.mockImplementation(() => hangingChild());

    const out = await withTimeoutFired(() => lib.disconnectGitHub());

    expect(out.ok).toBe(false);
    expect(out.detail ?? "").not.toMatch(/not installed/i);
    // and it says what actually went wrong, so the owner can retry.
    expect(out.detail ?? "").toMatch(/network|reach|timed out/i);
  });

  it("does not claim the account is still connected either", async () => {
    // gh may well have dropped the local credential before it hung on the
    // network. Asserting "nothing was changed" would be a guess.
    spawnMock.mockImplementation(() => hangingChild());

    const out = await withTimeoutFired(() => lib.disconnectGitHub());

    expect(out.detail ?? "").not.toMatch(/nothing was changed|still connected/i);
  });

  it("still says gh is missing when the binary genuinely cannot start", async () => {
    spawnMock.mockImplementation(() => missingBinary());

    const out = await lib.disconnectGitHub();

    expect(out.ok).toBe(false);
    expect(out.detail ?? "").toMatch(/not installed/i);
  });

  it("reports a logout that exited 0 as the success it was", async () => {
    // The other half of the same bug class: an error path firing over
    // something that actually worked.
    spawnMock.mockImplementation(() => exitingChild(0));

    const out = await lib.disconnectGitHub();

    expect(out.ok).toBe(true);
    expect(out.detail).toBeUndefined();
  });
});

describe("backing up when GitHub cannot be reached", () => {
  it("does not tell the owner to install gh", async () => {
    spawnMock.mockImplementation(() => hangingChild());

    const outcome = await withTimeoutFired(() => lib.backupToGitHub("/home/clawbox/Projects/site"));

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).not.toBe("no_gh");
    expect(outcome.reason).toBe("gh_unreachable");
    expect(outcome.detail ?? "").toMatch(/network|reach/i);
    expect(outcome.detail ?? "").not.toMatch(/install/i);
  });

  it("still answers no_gh when gh really is absent", async () => {
    spawnMock.mockImplementation(() => missingBinary());

    const outcome = await lib.backupToGitHub("/home/clawbox/Projects/site");

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("no_gh");
  });
});

/**
 * The same null code reaches four more branches once the probe is past. Each
 * one reads a non-zero code as a FACT about the folder, and a killed call
 * carries no fact at all — these pin that none of them guesses.
 */
describe("a killed git probe is never read as an answer", () => {
  const connected = "Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n";
  // backupToGitHub compares `git rev-parse --show-toplevel` against
  // path.resolve(directory), so the stub must answer in the host's own form.
  const DIR = "/home/clawbox/Projects/site";
  const TOPLEVEL = path.resolve(DIR);

  /** Answer each spawned command in order, by the argv it was given. */
  function script(answer: (bin: string, args: string[]) => FakeChild): void {
    spawnMock.mockImplementation((bin: string, args: string[]) => answer(bin, args));
  }

  it("does not create a SECOND repository when the remote probe is killed", async () => {
    // `git remote get-url origin` exiting non-zero means "no remote yet", and
    // the branch below it creates a repo on GitHub. A killed probe returns the
    // same null code. Guessing here is irreversible.
    const seen: string[][] = [];
    script((bin, args) => {
      seen.push([bin, ...args]);
      if (bin === "gh" && args[0] === "auth") return exitingChild(0, connected);
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("--verify")) return gitChild(0, "abc123");
      if (args.includes("--abbrev-ref")) return gitChild(0, "main");
      if (args.includes("get-url")) return hangingChild();
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() =>
      lib.backupToGitHub(DIR),
    );

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.detail ?? "").toMatch(/remote/i);
    // The point of the test: nothing was created on GitHub.
    expect(seen.some((c) => c[0] === "gh" && c[1] === "repo" && c[2] === "create")).toBe(false);
  });

  it("does not call a repository 'not a git repository' when the probe is killed", async () => {
    script((bin, args) => {
      if (bin === "gh") return exitingChild(0, connected);
      if (args.includes("--show-toplevel")) return hangingChild();
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() =>
      lib.backupToGitHub(DIR),
    );

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).not.toBe("not_a_repo");
    expect(outcome.detail ?? "").not.toMatch(/not its own git repository/i);
  });

  it("does not call a repository EMPTY when the commit probe is killed", async () => {
    // `rev-parse --verify HEAD` exiting non-zero means "no commits yet". A
    // killed probe returns the same null, and telling an owner with a full
    // history that the folder is empty is a lie drawn from a dead network.
    script((bin, args) => {
      if (bin === "gh") return exitingChild(0, connected);
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("--verify")) return hangingChild();
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() => lib.backupToGitHub(DIR));

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).not.toBe("nothing_to_push");
    expect(outcome.detail ?? "").not.toMatch(/no commits yet/i);
  });

  it("does not push to 'main' when the branch probe is killed", async () => {
    // The branch name feeds `push --set-upstream origin <branch>`. Falling back
    // to "main" on a killed probe would push a `develop` checkout to main AND
    // bind it there — a durable wrong answer from a transient fault.
    const seen: string[][] = [];
    script((bin, args) => {
      seen.push([bin, ...args]);
      if (bin === "gh") return exitingChild(0, connected);
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("--verify")) return gitChild(0, "abc123");
      if (args.includes("--abbrev-ref")) return hangingChild();
      if (args.includes("get-url")) return gitChild(0, "git@github.com:me/site.git");
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() => lib.backupToGitHub(DIR));

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect(outcome.detail ?? "").toMatch(/branch/i);
    // The point: nothing was pushed anywhere, least of all to main.
    expect(seen.some((c) => c.includes("push"))).toBe(false);
  });

  it("never reports a killed push with a blank message", async () => {
    // A SIGKILLed child writes no stderr, so `(stderr || stdout)` was "".
    // The owner saw a failure with nothing in it.
    script((bin, args) => {
      if (bin === "gh") return exitingChild(0, connected);
      if (args.includes("--show-toplevel")) return gitChild(0, TOPLEVEL);
      if (args.includes("--verify")) return gitChild(0, "abc123");
      if (args.includes("--abbrev-ref")) return gitChild(0, "main");
      if (args.includes("get-url")) return gitChild(0, "git@github.com:me/site.git");
      if (args.includes("push")) return hangingChild();
      return gitChild(0);
    });

    const outcome = await withTimeoutFired(() =>
      lib.backupToGitHub(DIR),
    );

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("failed");
    expect((outcome.detail ?? "").trim()).not.toBe("");
    expect(outcome.detail ?? "").toMatch(/push/i);
  });
});
