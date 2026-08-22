// A pet slug travels from the browser into a filesystem path AND into the
// `hermes` CLI's argv. Upstream has `_safe_slug` for exactly that reason; this
// is the ClawBox-side port, plus the store reads the mascot depends on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpHome: string;
let petsDir: string;

async function loadModule() {
  vi.resetModules();
  return import("@/lib/hermes-pets");
}

function makePet(slug: string, opts: { sheet?: string; meta?: unknown } = {}) {
  const dir = path.join(petsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.meta !== null) {
    fs.writeFileSync(
      path.join(dir, "pet.json"),
      JSON.stringify(opts.meta ?? { id: slug, displayName: slug.toUpperCase(), spritesheetPath: "spritesheet.webp" }),
    );
  }
  if (opts.sheet !== undefined) {
    if (opts.sheet) fs.writeFileSync(path.join(dir, opts.sheet), "not-really-a-webp");
  } else {
    fs.writeFileSync(path.join(dir, "spritesheet.webp"), "not-really-a-webp");
  }
  return dir;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pets-"));
  process.env.HERMES_HOME = tmpHome;
  petsDir = path.join(tmpHome, "pets");
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("safePetSlug", () => {
  it("accepts the slugs Petdex actually uses", async () => {
    const { safePetSlug } = await loadModule();
    for (const slug of ["boba", "cache-capy", "daemon-dumpling", "pet2"]) {
      expect(safePetSlug(slug)).toBe(slug);
    }
    expect(safePetSlug("  boba  ")).toBe("boba");
  });

  it("rejects anything that could escape the pets directory", async () => {
    const { safePetSlug } = await loadModule();
    for (const bad of ["../evil", "..", ".", "a/b", "a\\b", "/etc/passwd", "boba/../../x", ""]) {
      expect(safePetSlug(bad), `${JSON.stringify(bad)} must be rejected`).toBeNull();
    }
  });

  it("rejects a value the CLI would read as a flag", async () => {
    const { safePetSlug } = await loadModule();
    // runHermesCli passes args to spawn with no shell, so this is not command
    // injection — but `--force` as a "slug" would still be parsed as a FLAG.
    for (const bad of ["-rf", "--force", "-"]) {
      expect(safePetSlug(bad)).toBeNull();
    }
  });

  it("rejects non-strings and over-long values", async () => {
    const { safePetSlug } = await loadModule();
    expect(safePetSlug(null)).toBeNull();
    expect(safePetSlug(42)).toBeNull();
    expect(safePetSlug({ toString: () => "boba" })).toBeNull();
    expect(safePetSlug("a".repeat(65))).toBeNull();
  });
});

describe("the pet store", () => {
  it("returns nothing at all on a device that has never installed a pet", async () => {
    const { installedPets, resolveActivePet } = await loadModule();
    expect(installedPets()).toEqual([]);
    expect(resolveActivePet("boba")).toBeNull();
  });

  it("reads an installed pet's metadata and revision", async () => {
    makePet("boba");
    const { loadPet } = await loadModule();
    const pet = loadPet("boba");
    expect(pet?.slug).toBe("boba");
    expect(pet?.displayName).toBe("BOBA");
    expect(pet?.revision).toMatch(/^\d+:\d+$/);
  });

  it("ignores a directory with no spritesheet — an aborted install is not a pet", async () => {
    makePet("half-installed", { sheet: "" });
    const { installedPets, loadPet } = await loadModule();
    expect(loadPet("half-installed")).toBeNull();
    expect(installedPets()).toEqual([]);
  });

  it("still loads a pet whose pet.json is missing or corrupt", async () => {
    const dir = path.join(petsDir, "nometa");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spritesheet.png"), "x");
    fs.writeFileSync(path.join(dir, "pet.json"), "{ not json");
    const { loadPet } = await loadModule();
    const pet = loadPet("nometa");
    expect(pet?.slug).toBe("nometa");
    expect(pet?.displayName).toBe("nometa");
    expect(pet?.sheetPath.endsWith("spritesheet.png")).toBe(true);
  });

  it("refuses a pet.json that points its spritesheet out of the directory", async () => {
    makePet("escapee", { meta: { id: "escapee", spritesheetPath: "../../../etc/passwd" }, sheet: "" });
    const { loadPet } = await loadModule();
    // No in-directory sheet either, so the pet is simply not usable.
    expect(loadPet("escapee")).toBeNull();
  });

  it("resolves the configured slug, then the first installed alphabetically", async () => {
    makePet("boba");
    makePet("apple-pet");
    const { resolveActivePet } = await loadModule();
    expect(resolveActivePet("boba")?.slug).toBe("boba");
    // Mirrors upstream resolve_active_pet: an unknown/uninstalled configured
    // slug does not blank the pet, it falls through to what IS installed.
    expect(resolveActivePet("nope")?.slug).toBe("apple-pet");
    expect(resolveActivePet("")?.slug).toBe("apple-pet");
  });
});

describe("geometry", () => {
  it("falls back to the canonical 192x208 / 8x9 grid when the sheet cannot be read", async () => {
    makePet("boba"); // the "sheet" is a text file — sharp will reject it
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadPet, readPetGeometry } = await loadModule();
    const pet = loadPet("boba")!;
    const geometry = await readPetGeometry(pet);
    expect(geometry).toMatchObject({
      frameW: 192,
      frameH: 208,
      cols: 8,
      rows: 9,
      framesPerState: 6,
      loopMs: 1100,
    });
  });
});

describe("readPetConfig", () => {
  it("is off when Hermes cannot answer at all", async () => {
    vi.doMock("@/lib/hermes-config-cache", () => ({
      hermesConfigGetMany: () => Promise.reject(new Error("hermes missing")),
    }));
    const { readPetConfig } = await loadModule();
    expect(await readPetConfig()).toEqual({ enabled: false, slug: "" });
    vi.doUnmock("@/lib/hermes-config-cache");
  });

  it("reads display.pet.* and drops a slug that could escape the store", async () => {
    vi.doMock("@/lib/hermes-config-cache", () => ({
      hermesConfigGetMany: () =>
        Promise.resolve({ "display.pet.enabled": "true", "display.pet.slug": "../../etc" }),
    }));
    const { readPetConfig } = await loadModule();
    expect(await readPetConfig()).toEqual({ enabled: true, slug: "" });
    vi.doUnmock("@/lib/hermes-config-cache");
  });
});

describe("selectPet", () => {
  it("installs first, then selects, and gives the download a long timeout", async () => {
    const calls: { args: string[]; opts?: { timeoutMs?: number } }[] = [];
    vi.doMock("@/lib/hermes-cli", () => ({
      runHermesCli: (args: string[], opts?: { timeoutMs?: number }) => {
        calls.push({ args, opts });
        // The install "succeeds": drop a sheet so loadPet() agrees.
        if (args[1] === "install") makePet("boba");
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }));
    const { selectPet } = await loadModule();
    expect(await selectPet("boba")).toEqual({ ok: true });
    expect(calls[0].args).toEqual(["pets", "install", "boba"]);
    // 30 s (the CLI default) would abort a 2.2 MB download on a slow link and
    // leave a partial pet directory behind.
    expect(calls[0].opts?.timeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(calls[1].args).toEqual(["pets", "select", "boba"]);
    vi.doUnmock("@/lib/hermes-cli");
  });

  it("skips the download for a pet already on disk", async () => {
    makePet("boba");
    const calls: string[][] = [];
    vi.doMock("@/lib/hermes-cli", () => ({
      runHermesCli: (args: string[]) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }));
    const { selectPet } = await loadModule();
    expect(await selectPet("boba")).toEqual({ ok: true });
    expect(calls).toEqual([["pets", "select", "boba"]]);
    vi.doUnmock("@/lib/hermes-cli");
  });

  it("reports a failure when the install left no spritesheet behind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@/lib/hermes-cli", () => ({
      // Exit code 0 but nothing on disk — a timed-out download looks like this.
      runHermesCli: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    }));
    const { selectPet } = await loadModule();
    expect(await selectPet("boba")).toEqual({ ok: false, reason: "install-failed" });
    vi.doUnmock("@/lib/hermes-cli");
  });

  it("never reaches the CLI with an unsafe slug", async () => {
    const runHermesCli = vi.fn();
    vi.doMock("@/lib/hermes-cli", () => ({ runHermesCli }));
    const { selectPet } = await loadModule();
    expect(await selectPet("../../etc/passwd")).toEqual({ ok: false, reason: "not-installed" });
    expect(runHermesCli).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/hermes-cli");
  });
});
