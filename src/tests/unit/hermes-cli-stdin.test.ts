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
