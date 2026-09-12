/**
 * The run environment's own half of the secret store: what `buildRunEnv` will
 * and will not put in a child's environment.
 *
 * `buildRunEnv` is the boundary the contract test already guards — it is the
 * WHOLE environment a delegated run gets, deliberately not `process.env`. This
 * file pins the one thing the secret store adds to it, and the two guards that
 * make the addition safe:
 *
 *  - a secret NEVER overwrites what the device wrote. Everything above it in
 *    that function decides which account pays for the run, which model answers,
 *    where its evidence goes and what its PATH is; an entry that could
 *    overwrite one of those would be a way to move a run onto another account
 *    by saving a "secret".
 *  - a name outside the store's alphabet, or one the device reserves, is
 *    dropped even if it somehow reached the file. `setSecret` refuses both at
 *    save time, so this is defence in depth and covers a store written by an
 *    older build.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

import { buildRunEnv } from "@/lib/coding-agent";

const TOKEN = "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC";

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("buildRunEnv and the owner's secrets", () => {
  it("adds nothing when the caller resolved nothing", () => {
    // Which is every run on a box that has not switched injection on.
    const bare = buildRunEnv({ effort: "high" });
    const empty = buildRunEnv({ effort: "high", secrets: {} });
    expect(empty).toEqual(bare);
  });

  it("puts a resolved secret in the child's environment under its own name", () => {
    const env = buildRunEnv({ effort: "high", secrets: { VERCEL_TOKEN: TOKEN } });
    expect(env.VERCEL_TOKEN).toBe(TOKEN);
  });

  it("never overwrites what the device itself wrote", () => {
    const device = buildRunEnv({ effort: "high", artifactsDir: "/tmp/evidence", provider: "clawbox-ai" });
    const withSecrets = buildRunEnv({
      effort: "high",
      artifactsDir: "/tmp/evidence",
      provider: "clawbox-ai",
      // Every one of these is something the device decides. Reaching this
      // function at all would take a store written by hand, which is the
      // point: the guard is here so this loop is safe to read on its own.
      secrets: {
        PATH: "/attacker/bin",
        HOME: "/attacker",
        CLAUDE_DS_PROVIDER: "anthropic",
        CLAWBOX_RUN_ARTIFACTS_DIR: "/attacker/evidence",
      },
    });
    expect(withSecrets.PATH).toBe(device.PATH);
    expect(withSecrets.HOME).toBe(device.HOME);
    expect(withSecrets.CLAUDE_DS_PROVIDER).toBe("clawbox-ai");
    expect(withSecrets.CLAWBOX_RUN_ARTIFACTS_DIR).toBe("/tmp/evidence");
  });

  it("drops a reserved name the device does not happen to be writing on this run", () => {
    // `LD_PRELOAD` is in no run's environment, so `name in env` would let it
    // through: the reserved-name check is what refuses it.
    const env = buildRunEnv({
      effort: "high",
      secrets: {
        LD_PRELOAD: "/tmp/evil.so",
        BASH_FUNC_DEPLOY: "() { rm -rf /; }",
        // Sourced by a non-interactive bash before its own body runs, which is
        // a way into `scripts/claude-ds` itself.
        BASH_ENV: "/tmp/evil.sh",
        NODE_OPTIONS: "--require /tmp/evil.js",
      },
    });
    expect(env).not.toHaveProperty("LD_PRELOAD");
    expect(env).not.toHaveProperty("BASH_FUNC_DEPLOY");
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("drops a name outside the store's alphabet", () => {
    const env = buildRunEnv({ effort: "high", secrets: { "lower_case": "x", "HAS-DASH": "y", "": "z" } });
    expect(Object.keys(env)).not.toContain("lower_case");
    expect(Object.keys(env)).not.toContain("HAS-DASH");
    expect(Object.keys(env)).not.toContain("");
  });

  it("keeps every environment value a string, whatever the store held", () => {
    // spawn() throws on a non-string value, which would fail the run rather
    // than the save. Nothing in the store can produce one — the value is
    // validated as text — and this is the assertion that says so.
    const env = buildRunEnv({ effort: "high", secrets: { A_TOKEN: TOKEN } });
    for (const value of Object.values(env)) expect(typeof value).toBe("string");
  });
});
