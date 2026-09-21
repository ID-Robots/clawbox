/**
 * GH-01b, at the library rather than the route.
 *
 * `backupToGitHub` gives every refusal a sentence except two: `no_gh` and
 * `not_connected` return `{ pushed: false, reason }` and nothing else. Those
 * two are the branches #518 rewrote when it split `no_gh` away from
 * `gh_unreachable`, and they are the two the owner meets first — tapping Backup
 * before connecting GitHub is the ordinary way to arrive here, not an edge.
 *
 * The route's fallback is fixed separately (git-refusal-message.test.ts); this
 * pins the library, because `detail` is what any other caller reads and the
 * route should never be the only thing standing between an enum and a person.
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

function baseChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
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

/** gh is genuinely absent: ENOENT on spawn. */
function missing(): FakeChild {
  const child = baseChild();
  setImmediate(() => {
    child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
    child.emit("close", null, null);
  });
  return child;
}

const DIR = "/home/clawbox/Projects/site";

/** A refusal a person can act on: real words, and not the enum token. */
function expectSentence(detail: string | undefined, reason: string): void {
  expect((detail ?? "").trim()).not.toBe("");
  expect(detail).not.toBe(reason);
  expect(detail ?? "").not.toMatch(/^[a-z]+(_[a-z]+)+$/);
  expect(detail ?? "").toMatch(/\s/);
}

beforeEach(async () => {
  spawnMock.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-github");
});

describe("every backup refusal carries words, not just a token", () => {
  it("says the GitHub CLI is missing rather than answering `no_gh`", async () => {
    spawnMock.mockImplementation(() => missing());

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("no_gh");
    expectSentence(outcome.detail, "no_gh");
  });

  it("says nobody has signed in rather than answering `not_connected`", async () => {
    // gh runs and exits 0, but prints no "Logged in to ... as ..." line.
    spawnMock.mockImplementation(() => exitingChild(1, "", "You are not logged into any GitHub hosts.\n"));

    const outcome = await lib.backupToGitHub(DIR);

    expect(outcome.pushed).toBe(false);
    if (outcome.pushed) return;
    expect(outcome.reason).toBe("not_connected");
    expectSentence(outcome.detail, "not_connected");
  });
});
