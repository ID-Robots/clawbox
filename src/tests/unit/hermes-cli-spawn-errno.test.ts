import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SAME ENOENT-only guard, in the shared CLI helper.
 *
 * `src/lib/hermes-cli.ts` sanitises ENOENT and rejects with the raw error for
 * every other errno — the identical shape the chat route carried. It matters
 * more here, not less: eleven routes call `runHermesCli` and return
 * `err instanceof Error ? err.message : …` to the browser, so one unsanitised
 * spawn failure leaks the install path through all of them at once. The grep
 * that finds them:
 *
 *   grep -rn "err instanceof Error ? err.message" src/app/setup-api/hermes
 *
 * Fixing the guard at the spawn — rather than at each of those eleven — is what
 * makes the class closed instead of the instance.
 */
vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/home/clawbox/.local/bin/hermes" }));

import { spawn } from "child_process";
import { runHermesCli } from "@/lib/hermes-cli";

const mockSpawn = vi.mocked(spawn);

function unstartable(code: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    const e = new Error(`spawn /home/clawbox/.local/bin/hermes ${code}`) as NodeJS.ErrnoException;
    e.code = code;
    child.emit("error", e);
  });
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runHermesCli — a child that cannot be started", () => {
  it.each([
    ["ENOENT", /not installed/i],
    ["EACCES", /permission/i],
    ["EPERM", /permission/i],
    ["EAGAIN", /resources/i],
    ["ENOMEM", /resources/i],
    ["EMFILE", /could not be started/i],
  ])("rejects %s without naming the binary", async (code, expected) => {
    mockSpawn.mockImplementation(() => unstartable(code) as never);

    const err = await runHermesCli(["config", "get", "model.default"]).then(
      () => new Error("expected a rejection"),
      (e: Error) => e,
    );

    expect(err.message).not.toContain("/home/");
    expect(err.message).not.toContain("spawn ");
    expect(err.message).toMatch(expected);
  });
});
