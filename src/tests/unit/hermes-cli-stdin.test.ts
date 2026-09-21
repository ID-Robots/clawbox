import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runHermesCli` writes the caller's input to the child's stdin. A child that
 * exits before it has drained that input makes the write fail on the pipe, and
 * a stream error with no listener does not reach the promise — it surfaces at
 * the process level, which on this device is the whole web server.
 *
 * These pin the two halves of the handling: the error never escapes, and it
 * does not turn a command the child actually completed into a failure.
 */

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/usr/bin/hermes-test" }));

import { runHermesCli } from "@/lib/hermes-cli";

interface FakeChild extends EventEmitter {
  stdin: EventEmitter & { end: (chunk?: unknown) => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => void;
}

/** A child whose stdin fails the moment the caller writes to it. */
function makeChild(onStdinEnd: (child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const stdin = new EventEmitter() as FakeChild["stdin"];
  // `emit("error")` on an emitter with no listener throws synchronously — the
  // in-process shape of the crash this guards against.
  stdin.end = () => onStdinEnd(child);
  child.stdin = stdin;
  return child;
}

const brokenPipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

describe("runHermesCli stdin handling", () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("does not let a stdin failure escape the promise", async () => {
    spawnMock.mockImplementation(() => makeChild((child) => child.stdin.emit("error", brokenPipe())));

    // Before the listener existed, this line threw out of runHermesCli rather
    // than settling the promise it returns.
    await expect(runHermesCli(["skill", "uninstall", "x"], { input: "y\n" })).rejects.toThrow("EPIPE");
  });

  it("still reports the child's own result when the child finished its work", async () => {
    // A child that never reads the confirmation but exits 0 did the job; the
    // failed write says nothing about the outcome and must not mask it.
    spawnMock.mockImplementation(() =>
      makeChild((child) => {
        child.stdin.emit("error", brokenPipe());
        child.stdout.emit("data", Buffer.from("removed"));
        child.emit("close", 0);
      }),
    );

    await expect(runHermesCli(["skill", "uninstall", "x"], { input: "y\n" })).resolves.toEqual({
      code: 0,
      stdout: "removed",
      stderr: "",
    });
  });

  it("leaves the no-input path untouched", async () => {
    spawnMock.mockImplementation(() => {
      const child = makeChild(() => {
        throw new Error("stdin must not be written when no input was given");
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(runHermesCli(["config", "get", "model.default"])).resolves.toMatchObject({ code: 0 });
    // stdio: stdin is only piped when there is something to write.
    expect(spawnMock.mock.calls[0][2].stdio[0]).toBe("ignore");
  });
});

/**
 * TASK-453 — every caller that READS Hermes' output is parsing it, and Hermes
 * prints through `rich`, which falls back to 80 columns when stdout is a pipe
 * and hard-wraps what it renders. Live on a Hermes box, `hermes skills install
 * clawhub/oo-terraform` split its refusal mid-sentence and its scan-report rows
 * mid-excerpt at that width; at a wide COLUMNS the same run printed both whole.
 *
 * Three call sites used to pass their own COLUMNS, at two different widths, and
 * the fourth (install) did not — so its output was the wrapped one.
 */
describe("runHermesCli console width", () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  /** Spawn a child that just exits 0, and hand back the options spawn was given. */
  function spawnOptions(): Record<string, unknown> {
    return spawnMock.mock.calls[0][2] as Record<string, unknown>;
  }

  function exitZero(): void {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
  }

  it("asks for a console wide enough that nothing this repo parses wraps", async () => {
    exitZero();

    await runHermesCli(["skills", "install", "clawhub/x", "--yes"]);

    const env = spawnOptions().env as Record<string, string>;
    expect(Number(env.COLUMNS)).toBeGreaterThanOrEqual(200);
  });

  it("still lets a caller choose its own width", async () => {
    exitZero();

    await runHermesCli(["skills", "browse"], { env: { COLUMNS: "120" } });

    expect((spawnOptions().env as Record<string, string>).COLUMNS).toBe("120");
  });
});
