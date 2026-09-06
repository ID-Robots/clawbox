import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `/setup-api/harness/active` is where the browser learns which product this
 * box is, and since the wallpaper list became edition-scoped (owner ruling
 * 2026-09-06) it is also where the browser learns whether that answer is worth
 * believing.
 *
 * `active` is resolved from the root-owned edition lock and, on the one SKU the
 * lock deliberately leaves open, from `data/config.json`. Both of those reads
 * fall back to "openclaw" when nothing could answer — the safe way to be wrong
 * for "which SKU is this", since openclaw is the non-premium one, and the wrong
 * way round for anything that BRANDS the box: a Hermes device whose lock is
 * unreadable, or a licensed `dual` running Hermes whose config store a `sudo`
 * script left root-owned, would be dressed as a ClawBox. `activeKnown` is what
 * lets a caller tell a fact from a fallback, so the route reports the doubt
 * instead of hiding it behind a default.
 */

interface Answer {
  active: string;
  edition: string;
  activeKnown: boolean;
}

let lockPath: string;
let previousEditionFile: string | undefined;
let previousEdition: string | undefined;

/** The route, freshly imported — `edition-source` captures its path at load. */
async function get(): Promise<Answer> {
  vi.resetModules();
  const mod = await import("@/app/setup-api/harness/active/route");
  return (await mod.GET()).json();
}

/** The premium SKU actually unlocked: the licence is not env-overridable. */
function licenseDual(): void {
  vi.doMock("@/lib/edition-license", () => ({ verifyDualLicense: () => true }));
}

beforeEach(() => {
  previousEditionFile = process.env.CLAWBOX_EDITION_FILE;
  previousEdition = process.env.CLAWBOX_EDITION;
  // A fresh path per case: edition-source caches by mtime, and two writes
  // inside the same millisecond would otherwise be one cached answer.
  lockPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-edition-")),
    "edition.env",
  );
  process.env.CLAWBOX_EDITION_FILE = lockPath;
  delete process.env.CLAWBOX_EDITION;
});

afterEach(() => {
  vi.doUnmock("@/lib/edition-license");
  vi.doUnmock("@/lib/config-store");
  if (previousEditionFile === undefined) delete process.env.CLAWBOX_EDITION_FILE;
  else process.env.CLAWBOX_EDITION_FILE = previousEditionFile;
  if (previousEdition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = previousEdition;
  fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
});

describe("GET /setup-api/harness/active — is `active` a fact or a default?", () => {
  it("resolves a single-harness edition from the root-owned lock", async () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
    expect(await get()).toEqual({ active: "hermes", edition: "hermes", activeKnown: true });
  });

  it("takes the environment's word when there is no lock file", async () => {
    // Dev machines, CI and pre-3.x installs never had one, and the documented
    // env fallback is still an answer somebody gave.
    process.env.CLAWBOX_EDITION = "openclaw";
    expect(await get()).toMatchObject({ edition: "openclaw", activeKnown: true });
  });

  it("says the harness is NOT resolved when the lock carries no edition", async () => {
    // A truncated write, a permission change, a partial reflash. `edition` and
    // `active` still answer "openclaw" — every other caller of this route
    // depends on that default — and `activeKnown` is what says it was a guess.
    fs.writeFileSync(lockPath, "# ClawBox edition lock\n# (truncated)\n");
    expect(await get()).toEqual({ active: "openclaw", edition: "openclaw", activeKnown: false });
  });

  it("says the harness is NOT resolved when nothing on the device names an edition", async () => {
    expect(await get()).toMatchObject({ activeKnown: false });
  });

  it("says the harness is not resolved for a lock naming something unrecognised", async () => {
    // "openclaw" here is edition-source's default, not the file's word.
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=enterprise\n");
    expect(await get()).toMatchObject({ edition: "openclaw", activeKnown: false });
  });
});

describe("GET /setup-api/harness/active — the dual SKU, whose harness is a runtime choice", () => {
  beforeEach(() => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=dual\n");
  });

  it("pins an UNLICENSED dual to the default harness, and that is a fact", async () => {
    // No licence, so the switcher never unlocks and the stored value is ignored
    // outright — the box really is on the default, not guessed onto it.
    expect(await get()).toEqual({ active: "openclaw", edition: "dual", activeKnown: true });
  });

  it("resolves a licensed dual from the config store", async () => {
    licenseDual();
    vi.doMock("@/lib/config-store", async (orig) => ({
      ...(await orig<typeof import("@/lib/config-store")>()),
      getKnown: async () => ({ value: "hermes", known: true }),
    }));
    expect(await get()).toEqual({ active: "hermes", edition: "dual", activeKnown: true });
  });

  it("treats a licensed dual nobody has switched as a fact, not a doubt", async () => {
    // An ABSENT key is a real answer: that box runs the default harness. Calling
    // it unknown would strip the branding from every healthy dual box.
    licenseDual();
    vi.doMock("@/lib/config-store", async (orig) => ({
      ...(await orig<typeof import("@/lib/config-store")>()),
      getKnown: async () => ({ value: undefined, known: true }),
    }));
    expect(await get()).toEqual({ active: "openclaw", edition: "dual", activeKnown: true });
  });

  it("says the harness is NOT resolved when the config store cannot be read", async () => {
    // The gap this pair of tests exists for. `data/config.json` left root-owned
    // by a `sudo` script: the forgiving reader answers "openclaw" for a box
    // that is running Hermes, and taking that as a fact paints the ClawBox art
    // on it — and, on a box that had never chosen, writes `wp_id: "clawbox"`
    // box-wide. The edition is perfectly readable here; only the harness is not.
    licenseDual();
    vi.doMock("@/lib/config-store", async (orig) => ({
      ...(await orig<typeof import("@/lib/config-store")>()),
      getKnown: async () => ({ value: undefined, known: false }),
    }));
    expect(await get()).toEqual({ active: "openclaw", edition: "dual", activeKnown: false });
  });
});
