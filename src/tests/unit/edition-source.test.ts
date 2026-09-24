import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// readEdition() must prefer the ROOT-OWNED /etc/clawbox/edition.env over the
// environment: clawbox-setup.service loads a clawbox-writable .env, and systemd
// lets EnvironmentFile override Environment=, so an env-only edition check can
// be flipped by anyone with a shell on the box.

let tmpDir: string;
let editionFile: string;

async function loadModule() {
  vi.resetModules();
  return import("@/lib/edition-source");
}

async function loadReader() {
  return (await loadModule()).readEdition;
}

// A fixed mtime, so "the same mtime" is exact rather than whatever the
// filesystem's timestamp granularity makes of two writes in a row.
const BAKED_AT = 1_700_000_000;

function bake(contents: string, mtime = BAKED_AT) {
  fs.writeFileSync(editionFile, contents);
  fs.utimesSync(editionFile, mtime, mtime);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-edition-"));
  editionFile = path.join(tmpDir, "edition.env");
  process.env.CLAWBOX_EDITION_FILE = editionFile;
  delete process.env.CLAWBOX_EDITION;
});

afterEach(() => {
  delete process.env.CLAWBOX_EDITION_FILE;
  delete process.env.CLAWBOX_EDITION;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readEdition", () => {
  it.each([
    ["CLAWBOX_EDITION=hermes\n", "hermes"],
    ["CLAWBOX_EDITION=dual\n", "dual"],
    ["# baked by install.sh\nCLAWBOX_EDITION=openclaw\n", "openclaw"],
    ['CLAWBOX_EDITION="hermes"\n', "hermes"],
    ["export CLAWBOX_EDITION=HERMES\n", "hermes"],
  ])("reads %j from the root-owned file", async (contents, expected) => {
    fs.writeFileSync(editionFile, contents);
    expect((await loadReader())()).toBe(expected);
  });

  it("lets the root-owned file beat a conflicting environment variable", async () => {
    fs.writeFileSync(editionFile, "CLAWBOX_EDITION=hermes\n");
    process.env.CLAWBOX_EDITION = "dual"; // what a customer could inject via .env
    expect((await loadReader())()).toBe("hermes");
  });

  it("falls back to the environment when the file is absent (dev/CI)", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    expect((await loadReader())()).toBe("hermes");
  });

  it("falls back to openclaw for an unrecognised value", async () => {
    fs.writeFileSync(editionFile, "CLAWBOX_EDITION=premium-plus\n");
    expect((await loadReader())()).toBe("openclaw");
  });

  it("re-reads after the installer re-bakes the file", async () => {
    fs.writeFileSync(editionFile, "CLAWBOX_EDITION=openclaw\n");
    const readEdition = await loadReader();
    expect(readEdition()).toBe("openclaw");

    fs.writeFileSync(editionFile, "CLAWBOX_EDITION=hermes\n");
    // Force a distinct mtime — a same-millisecond rewrite would otherwise hit
    // the mtime cache on filesystems with coarse timestamps.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(editionFile, future, future);
    expect(readEdition()).toBe("hermes");
  });
});

describe("readEditionSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers from the cache while the mtime is unchanged, without reading the file again", async () => {
    bake("CLAWBOX_EDITION=hermes\n");
    const { readEditionSource } = await loadModule();
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });

    // Same mtime, different contents: only a re-read could see "dual".
    bake("CLAWBOX_EDITION=dual\n");
    const read = vi.spyOn(fs, "readFileSync");
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });
    expect(read).not.toHaveBeenCalled();
  });

  it("re-reads the file once its mtime changes", async () => {
    bake("CLAWBOX_EDITION=hermes\n");
    const { readEditionSource } = await loadModule();
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });

    bake("CLAWBOX_EDITION=dual\n", BAKED_AT + 60);
    const read = vi.spyOn(fs, "readFileSync");
    expect(readEditionSource()).toEqual({ edition: "dual", defaulted: false });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("falls back to the environment when the file is missing", async () => {
    process.env.CLAWBOX_EDITION = "dual";
    const { readEditionSource } = await loadModule();
    expect(readEditionSource()).toEqual({ edition: "dual", defaulted: false });
  });

  it("says the answer was a guess when neither the file nor the environment names an edition", async () => {
    const { readEditionSource } = await loadModule();
    expect(readEditionSource()).toEqual({ edition: "openclaw", defaulted: true });
  });

  it("treats a symlinked lock as missing instead of following it", async () => {
    const target = path.join(tmpDir, "elsewhere.env");
    fs.writeFileSync(target, "CLAWBOX_EDITION=dual\n");
    fs.symlinkSync(target, editionFile);
    const { readEditionSource } = await loadModule();

    expect(readEditionSource()).toEqual({ edition: "openclaw", defaulted: true });
    process.env.CLAWBOX_EDITION = "hermes";
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });
  });

  it("does not serve a cached edition once the lock is swapped for a symlink with the same mtime", async () => {
    bake("CLAWBOX_EDITION=hermes\n");
    const { readEditionSource } = await loadModule();
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });

    const target = path.join(tmpDir, "elsewhere.env");
    fs.renameSync(editionFile, target);
    fs.symlinkSync(target, editionFile);
    expect(readEditionSource()).toEqual({ edition: "openclaw", defaulted: true });
  });

  it("treats a lock path that is not a regular file as missing", async () => {
    fs.mkdirSync(editionFile);
    process.env.CLAWBOX_EDITION = "hermes";
    const { readEditionSource } = await loadModule();
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });
  });
});
