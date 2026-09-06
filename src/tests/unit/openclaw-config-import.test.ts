import { describe, expect, it, vi } from "vitest";
import path from "path";

// Regression guard for a whole-file outage, not for a behaviour.
//
// `openclaw-config.ts` is imported by `updater.ts` and by most setup-api
// routes. Many of those modules' test files replace "@/lib/config-store" with a
// factory mock that lists only the store functions they exercise. If
// openclaw-config resolves a path from config-store's `DATA_DIR` at module
// scope, that mock makes `DATA_DIR` undefined, `path.join` throws during
// IMPORT, and every test in the importing file dies before it runs — which is
// exactly what happened when the Discord env file landed (33 tests in
// updater.test.ts, none of them about Discord).
//
// The mock below is deliberately byte-identical in shape to updater.test.ts's.

vi.mock("@/lib/config-store", () => {
  // `getKnown` is the tri-state reader ("we could not read the file" is not
  // "the key is unset"), and it answers from the SAME mock every fixture in
  // this file already drives — so a case that wants an unreadable store says
  // so by overriding `getKnown` alone.
  const get = vi.fn();
  return {
    get,
    getKnown: vi.fn(async (key: string) => ({ value: await get(key), known: true })),
    set: vi.fn(),
    setMany: vi.fn(),
  };
});

const TEST_ROOT = "/tmp/clawbox-openclaw-config-import-test";
process.env.CLAWBOX_ROOT = TEST_ROOT;

describe("openclaw-config module import", () => {
  it("imports when config-store is mocked without DATA_DIR", async () => {
    const openclawConfig = await import("@/lib/openclaw-config");
    expect(typeof openclawConfig.setDiscordToken).toBe("function");
  });

  it("still resolves the Discord EnvironmentFile under the ClawBox data dir", async () => {
    const { DISCORD_ENV_PATH } = await import("@/lib/openclaw-config");
    expect(DISCORD_ENV_PATH).toBe(path.join(TEST_ROOT, "data", "discord.env"));
  });

  it("lets updater.ts import too, since it re-exports from openclaw-config", async () => {
    const updater = await import("@/lib/updater");
    expect(typeof updater.getVersionInfo).toBe("function");
  });
});
