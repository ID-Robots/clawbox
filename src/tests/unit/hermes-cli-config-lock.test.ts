import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The third writer of ~/.hermes/config.yaml.
 *
 * The two shell writers (setup-hermes-dashboard-auth.sh, register-mcp.sh) take
 * an flock over `<config>.lock`. `hermes config set`, run from the Settings
 * routes, is a read-modify-write of the SAME file through the Hermes CLI's own
 * load->save_config — so a save landing on the provisioning window can drop the
 * dashboard auth block exactly the way the install-time race did.
 *
 * It cannot be asked to take our lock, so it is run UNDER the lock instead,
 * via flock(1). These pin that, and pin that read-only calls stay unlocked (a
 * `config get` cannot lose an update, and serialising it behind a provisioning
 * run would stall the UI for nothing).
 */

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/usr/bin/hermes-test" }));

import { HERMES_CONFIG_LOCK_BUSY, runHermesCli } from "@/lib/hermes-cli";

const FLOCK_BIN = "/usr/bin/flock";
// The wrap is skipped when flock is absent; only assert it where it applies.
const HAS_FLOCK = fs.existsSync(FLOCK_BIN);

interface FakeChild extends EventEmitter {
  stdin: EventEmitter & { end: (chunk?: unknown) => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => void;
}

/** A child that closes with the given exit code on the next tick. */
function childExiting(code: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = Object.assign(new EventEmitter(), { end: () => {} }) as FakeChild["stdin"];
  setImmediate(() => child.emit("close", code));
  return child;
}

describe("hermes config writes are serialised with the provisioning scripts", () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it.runIf(HAS_FLOCK)("runs `config set` under the shared lock", async () => {
    spawnMock.mockImplementation(() => childExiting(0));
    await runHermesCli(["config", "set", "model.default", "gpt-x"]);

    const [bin, argv] = spawnMock.mock.calls[0];
    expect(bin).toBe(FLOCK_BIN);
    // The lock file the shell writers derive: <config>.lock beside config.yaml.
    const lockArg = (argv as string[]).find((a) => a.endsWith("config.yaml.lock"));
    expect(lockArg, `no lock path in ${JSON.stringify(argv)}`).toBeDefined();
    expect(lockArg).toMatch(/\.hermes[/\\]config\.yaml\.lock$/);
    // The real command still runs, with its arguments intact.
    expect(argv).toContain("/usr/bin/hermes-test");
    expect((argv as string[]).slice(-4)).toEqual([
      "config",
      "set",
      "model.default",
      "gpt-x",
    ]);
    // Bounded wait: a UI action must fail rather than hang.
    expect(argv).toContain("-w");
  });

  it.runIf(HAS_FLOCK)("runs `config unset` under the lock too", async () => {
    spawnMock.mockImplementation(() => childExiting(0));
    await runHermesCli(["config", "unset", "providers.local.key"]);
    expect(spawnMock.mock.calls[0][0]).toBe(FLOCK_BIN);
  });

  it("does NOT lock read-only calls", async () => {
    spawnMock.mockImplementation(() => childExiting(0));
    await runHermesCli(["config", "get", "model.default"]);
    expect(spawnMock.mock.calls[0][0]).toBe("/usr/bin/hermes-test");
  });

  it("does not lock non-config subcommands", async () => {
    spawnMock.mockImplementation(() => childExiting(0));
    await runHermesCli(["models", "list"]);
    expect(spawnMock.mock.calls[0][0]).toBe("/usr/bin/hermes-test");
  });

  it.runIf(HAS_FLOCK)("reports a lock conflict as busy, not as a failed command", async () => {
    // flock exits with our chosen code WITHOUT running hermes, so there is no
    // child output to explain the failure. "The device was busy" and "the
    // command failed" send the caller to different places, so they must not
    // arrive as the same empty-stderr non-zero result.
    spawnMock.mockImplementation(() => childExiting(HERMES_CONFIG_LOCK_BUSY));
    const res = await runHermesCli(["config", "set", "model.default", "gpt-x"]);
    expect(res.code).toBe(HERMES_CONFIG_LOCK_BUSY);
    expect(res.stderr).toMatch(/busy/i);
    expect(res.stderr).toMatch(/Nothing was changed/i);
  });
});
