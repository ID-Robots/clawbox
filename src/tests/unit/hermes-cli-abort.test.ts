/**
 * `runHermesCli` and a signal that is ALREADY aborted.
 *
 * THE BUG THIS PINS. Cancellation was wired with
 * `signal.addEventListener("abort", …)`, and an already-aborted signal never
 * dispatches `abort` again — so a caller that gave up before the call was even
 * made still spawned the child, and the command ran to completion. The route
 * handlers hand `request.signal` down, and it is aborted the moment the browser
 * disconnects; the worst instance is `ensureHermesGateway`, whose first probe
 * would come back as "no gateway here" and send it into
 * `sudo hermes gateway install --system` — a privileged install nobody asked
 * for any more, carrying a signal that can no longer stop it.
 *
 * The check belongs at the one place that spawns, so every caller that passes a
 * signal is covered by it rather than each one remembering.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock, execFile: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/usr/bin/hermes-test" }));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => void;
}

/** A child that never exits on its own, so only an abort can settle the call. */
function makeHangingChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** A child that does its job and exits 0 — the command running to completion. */
function makeExitingChild(stdout = ""): FakeChild {
  const child = makeHangingChild();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", 0);
  });
  return child;
}

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

beforeEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runHermesCli with an already-aborted signal", () => {
  it("rejects without spawning anything", async () => {
    spawnMock.mockImplementation(() => makeExitingChild());
    const { runHermesCli } = await import("@/lib/hermes-cli");

    await expect(
      runHermesCli(["gateway", "status"], { signal: abortedSignal() }),
    ).rejects.toThrow("hermes call cancelled");

    // The whole point: the process is never started, so there is nothing to
    // kill and nothing running past the caller's interest in it.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a PRIVILEGED call the same way", async () => {
    spawnMock.mockImplementation(() => makeExitingChild());
    const { runHermesCli } = await import("@/lib/hermes-cli");

    await expect(
      runHermesCli(["gateway", "install", "--system"], { signal: abortedSignal(), sudo: true }),
    ).rejects.toThrow("hermes call cancelled");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still kills a child when the abort lands mid-call", async () => {
    // The half that already worked, kept honest: the pre-spawn check must not
    // replace the listener that covers an abort arriving after the spawn.
    const child = makeHangingChild();
    spawnMock.mockImplementation(() => child);
    const { runHermesCli } = await import("@/lib/hermes-cli");

    const controller = new AbortController();
    const call = runHermesCli(["gateway", "status"], { signal: controller.signal });
    controller.abort();

    await expect(call).rejects.toThrow("hermes call cancelled");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("ensureHermesGateway with an already-aborted signal", () => {
  it("never reaches the privileged install", async () => {
    // The customer-visible half. A configure route does several awaits before
    // it gets here, so the browser can be long gone by the time it does.
    // An empty `gateway status` reads as "no gateway here", which is exactly
    // the branch that then runs the install.
    spawnMock.mockImplementation(() => makeExitingChild());
    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");

    await expect(ensureHermesGateway(abortedSignal())).rejects.toThrow("hermes call cancelled");

    // Not one `hermes` invocation: not the status probe, and above all not
    // `sudo hermes gateway install --system`.
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
