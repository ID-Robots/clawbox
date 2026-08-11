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

async function loadReader() {
  vi.resetModules();
  const mod = await import("@/lib/edition-source");
  return mod.readEdition;
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
