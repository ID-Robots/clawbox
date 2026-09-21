import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Has the owner been through ClawKeep's first-run wizard?"
 *
 * The answer has to survive the wizard's own progress. ClawKeepApp used to ask
 * `setupComplete === false && !paired`, re-derived on every status poll — so
 * pairing, which is step 1 of 3, falsified the condition that kept the wizard on
 * screen. The owner landed on the dashboard before the passphrase and schedule
 * steps, at "AT RISK — Protection Lapsed", with the flag still false. Found on a
 * box upgraded to v4.0.0 on 2026-09-09.
 *
 * The `!paired` conjunct existed for one real case: a box paired before this
 * wizard shipped must not be dragged through onboarding by an update. Answered
 * HERE, that case costs the front door nothing — the app asks the single
 * question its sibling apps ask, and cannot be ejected by its own success.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-setup-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const TOKEN_PATH = path.join(DATA_DIR, "token");

/** The device-store value, as a test controls it. */
let storedFlag: unknown;

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async () => storedFlag),
  set: vi.fn(async () => {}),
  getKnown: vi.fn(async () => ({})),
  setMany: vi.fn(async () => {}),
}));

let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  await fs.mkdir(DATA_DIR, { recursive: true });
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  storedFlag = undefined;
  await fs.rm(TOKEN_PATH, { force: true });
});
afterEach(() => vi.clearAllMocks());

/** What pairing leaves behind: a `claw_`-prefixed device token. */
async function pair() {
  await fs.writeFile(TOKEN_PATH, "claw_abc123\n", "utf8");
}

describe("getClawKeepSetupComplete", () => {
  it("is false on a fresh box: no flag, nothing paired", async () => {
    expect(await clawkeep.getClawKeepSetupComplete()).toBe(false);
  });

  it("takes an EXPLICIT false even on a paired box", async () => {
    // The regression this repairs. Mid-wizard the box is paired and the flag is
    // still false, and that combination has to keep meaning "not finished" — it
    // is exactly the state the wizard is in between step 1 and step 3.
    await pair();
    storedFlag = false;
    expect(await clawkeep.getClawKeepSetupComplete()).toBe(false);
  });

  it("takes an explicit true", async () => {
    storedFlag = true;
    expect(await clawkeep.getClawKeepSetupComplete()).toBe(true);
  });

  it("counts a paired box as set up when no flag was ever written", async () => {
    // The legacy case the front door's `!paired` conjunct used to carry: a box
    // paired before the flag existed has been through setup by definition.
    await pair();
    expect(await clawkeep.getClawKeepSetupComplete()).toBe(true);
  });

  it("ignores a token that is not one", async () => {
    // readToken refuses anything without the `claw_` prefix, so a stray or
    // truncated file must not be read as "this box is already set up".
    await fs.writeFile(TOKEN_PATH, "not-a-token\n", "utf8");
    expect(await clawkeep.getClawKeepSetupComplete()).toBe(false);
  });
});
