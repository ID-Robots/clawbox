// The ClawBox crab is a PET now.
//
// `vibrant-clawd` ships in this repository (public/pets/, src/lib/pet-builtin.ts)
// and is what an OpenClaw or dual box wears with nothing picked — the place the
// still `clawbox-crab.png` used to be drawn. Three properties are load-bearing
// and none of them is visible from the pack alone:
//
//   - the pack is FOUND with an empty pets directory, on a box that has never
//     had a network, and never through a download;
//   - the brand body is resolved where the CRAB placeholder applies (openclaw,
//     dual) and never on a Hermes-only box, which keeps its egg;
//   - it is marked `brand`, so the mascot keeps the crab's name and voice while
//     wearing the sheet. A crab may say "claws".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpHome: string;
let edition = "openclaw";

vi.mock("@/lib/edition-source", () => ({
  readEdition: () => edition,
  hasHermesHarness: () => edition === "hermes" || edition === "dual",
}));

vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: () => Promise.resolve({ "display.pet.enabled": "false", "display.pet.slug": "" }),
}));

async function loadModule() {
  vi.resetModules();
  return import("@/lib/hermes-pets");
}

/** What the OpenClaw arm reads its pick out of. */
function writePick(pick: unknown) {
  fs.mkdirSync(path.join(tmpHome, "data"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "data", "config.json"), JSON.stringify({ mascot_pet: pick }));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-default-mascot-"));
  // A box with an EMPTY pets directory: nothing downloaded, nothing installed.
  process.env.HERMES_HOME = tmpHome;
  process.env.CLAWBOX_ROOT = tmpHome;
  edition = "openclaw";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the bundled pack", () => {
  it("ships pet.json and a nine-state sheet under public/pets", async () => {
    const dir = path.join(process.cwd(), "public", "pets", "vibrant-clawd");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "pet.json"), "utf-8"));
    expect(meta.id).toBe("vibrant-clawd");
    expect(meta.displayName).toBe("ClawBox crab");
    expect(meta.version).toBe("2.1.0");
    expect(meta.spritesheetPath).toBe("spritesheet.webp");
    // The credit file is part of the deliverable: this is first-party artwork
    // and the repository's licensing note points at it.
    expect(fs.existsSync(path.join(dir, "CREDIT.txt"))).toBe(true);
    expect(fs.statSync(path.join(dir, "spritesheet.webp")).size).toBeGreaterThan(100_000);
  });

  it("is loadable with an empty pets directory, off the repo's own copy", async () => {
    const { loadPet, builtinPetDir, builtinInstalledPets, installedPets } = await loadModule();
    expect(installedPets()).toEqual([]); // nothing in the harness's own store

    const pet = loadPet("vibrant-clawd");
    expect(pet?.displayName).toBe("ClawBox crab");
    expect(pet?.builtin).toBe(true);
    expect(pet?.sheetPath).toBe(path.join(builtinPetDir("vibrant-clawd")!, "spritesheet.webp"));
    expect(builtinInstalledPets().map((p) => p.slug)).toEqual(["vibrant-clawd"]);
  });

  it("is found on a Hermes box too — the gallery offers it on both editions", async () => {
    edition = "hermes";
    const { builtinInstalledPets } = await loadModule();
    expect(builtinInstalledPets().map((p) => p.slug)).toEqual(["vibrant-clawd"]);
  });

  it("is never downloaded: a bundled slug is refused by the direct install", async () => {
    // `selectPet` on the OpenClaw arm reaches `installPetDirect` only when the
    // pack is missing, and a slug Petdex never heard of must not be fetched.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { selectPet } = await loadModule();
    expect(await selectPet("vibrant-clawd")).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("the brand body", () => {
  it("names vibrant-clawd wherever the crab placeholder applies", async () => {
    const { brandPetSlug, mascotPlaceholder } = await loadModule();
    for (const e of ["openclaw", "dual"]) {
      edition = e;
      expect(mascotPlaceholder()).toBe("crab");
      expect(brandPetSlug()).toBe("vibrant-clawd");
    }
    edition = "hermes";
    expect(mascotPlaceholder()).toBe("egg");
    expect(brandPetSlug()).toBeNull();
  });

  it("is the active descriptor on OpenClaw with nothing picked", async () => {
    const { activePetDescriptor } = await loadModule();
    const active = await activePetDescriptor(() => "ID-Robots");
    expect(active?.slug).toBe("vibrant-clawd");
    expect(active?.displayName).toBe("ClawBox crab");
    expect(active?.brand).toBe(true);
    expect(active?.submittedBy).toBe("ID-Robots");
    // Measured off the real sheet: 8x9 cells of 192x208, with the ragged rows
    // the atlas actually has (waving draws four frames, jumping five).
    expect([active?.cols, active?.rows]).toEqual([8, 9]);
    expect(active?.rowMetrics?.map((r) => r.frames)).toEqual([6, 6, 6, 4, 5, 6, 6, 6, 6]);
  }, 30_000);

  it("stays the body when the owner switches the pet OFF — 'off' means the crab", async () => {
    writePick({ enabled: false, slug: "boba" });
    const { activePetDescriptor } = await loadModule();
    expect((await activePetDescriptor(() => ""))?.slug).toBe("vibrant-clawd");
  }, 30_000);

  it("is not worn on a Hermes-only box, which keeps its egg", async () => {
    edition = "hermes";
    const { activePetDescriptor } = await loadModule();
    expect(await activePetDescriptor(() => "")).toBeNull();
  });

  it("does not silence the crab's own voice", async () => {
    // `isPetActive` is what the phrase route asks before it strips crab-literal
    // lines. The crab is not someone else's pet.
    const { isPetActive } = await loadModule();
    expect(await isPetActive()).toBe(false);
    writePick({ enabled: true, slug: "vibrant-clawd" });
    expect(await (await loadModule()).isPetActive()).toBe(false);
  });

  it("steps aside for a pet the owner actually picked", async () => {
    const dir = path.join(tmpHome, "data", "pets", "boba");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify({ id: "boba", displayName: "Boba" }));
    fs.writeFileSync(path.join(dir, "spritesheet.webp"), "not-really-a-webp");
    writePick({ enabled: true, slug: "boba" });
    const { activePetDescriptor, isPetActive } = await loadModule();
    const active = await activePetDescriptor(() => "railly");
    expect(active?.slug).toBe("boba");
    expect(active?.brand).toBe(false);
    expect(await isPetActive()).toBe(true);
  });
});
