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
 * `edition` and `active` both resolve through `readEditionSource()`, which
 * collapses "nobody said" into its own "openclaw" default — the safe way to be
 * wrong for "which SKU is this", since openclaw is the non-premium one, and the
 * wrong way round for anything that BRANDS the box: a Hermes device whose lock
 * is unreadable would be dressed as a ClawBox. `editionKnown` is what lets a
 * caller tell the two apart, so the route reports the doubt instead of hiding
 * it behind a default.
 */

let lockPath: string;
let previousEditionFile: string | undefined;
let previousEdition: string | undefined;

async function get(): Promise<{ active: string; edition: string; editionKnown: boolean }> {
  vi.resetModules();
  const mod = await import("@/app/setup-api/harness/active/route");
  return (await mod.GET()).json();
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
  if (previousEditionFile === undefined) delete process.env.CLAWBOX_EDITION_FILE;
  else process.env.CLAWBOX_EDITION_FILE = previousEditionFile;
  if (previousEdition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = previousEdition;
  fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
});

describe("GET /setup-api/harness/active — is the edition a fact or a default?", () => {
  it("says the edition is known when the root-owned lock names one", async () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
    expect(await get()).toMatchObject({ active: "hermes", edition: "hermes", editionKnown: true });
  });

  it("says the edition is known when only the environment names one", async () => {
    // Dev machines, CI and pre-3.x installs never had the lock file, and the
    // documented env fallback is still an answer somebody gave.
    process.env.CLAWBOX_EDITION = "openclaw";
    expect(await get()).toMatchObject({ edition: "openclaw", editionKnown: true });
  });

  it("says the edition is NOT known when the lock carries none", async () => {
    // A truncated write, a permission change, a partial reflash. `edition` and
    // `active` still answer "openclaw" — every other caller of this route
    // depends on that default — and `editionKnown` is what says it was a guess.
    fs.writeFileSync(lockPath, "# ClawBox edition lock\n# (truncated)\n");
    expect(await get()).toEqual({ active: "openclaw", edition: "openclaw", editionKnown: false });
  });

  it("says the edition is NOT known when nothing on the device names one", async () => {
    expect(await get()).toMatchObject({ editionKnown: false });
  });

  it("says the edition is not known for a lock naming something unrecognised", async () => {
    // "openclaw" here is this module's default, not the file's word.
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=enterprise\n");
    expect(await get()).toMatchObject({ edition: "openclaw", editionKnown: false });
  });
});
