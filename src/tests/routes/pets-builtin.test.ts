// The gallery and the sprite route, for the pet ClawBox SHIPS.
//
// Everything here is asserted with an EMPTY pets directory, because that is the
// state of every box in the field: the bundled pack has to be listed as
// installed, served by the ordinary sprite route, and offered on both editions,
// with no Petdex manifest, no CDN and no network of any kind.

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

interface GalleryPet {
  slug: string;
  displayName: string;
  submittedBy: string;
  curated: boolean;
  builtin: boolean;
  installed: boolean;
}

async function gallery() {
  vi.resetModules();
  const { GET } = await import("@/app/setup-api/pets/route");
  const res = await GET(new Request("http://localhost/setup-api/pets?gallery=1"));
  return (await res.json()) as {
    placeholder: string;
    defaultSlug: string;
    activeSlug: string;
    pets: GalleryPet[];
  };
}

async function sprite(slug: string) {
  vi.resetModules();
  const { GET } = await import("@/app/setup-api/pets/sprite/route");
  return GET(new Request(`http://localhost/setup-api/pets/sprite?slug=${slug}`));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pets-builtin-"));
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

describe("GET /setup-api/pets?gallery=1", () => {
  it("lists the bundled crab as installed and built in, on an empty box", async () => {
    const body = await gallery();
    const clawd = body.pets.find((p) => p.slug === "vibrant-clawd");
    expect(clawd).toBeDefined();
    expect(clawd?.installed).toBe(true);
    expect(clawd?.builtin).toBe(true);
    expect(clawd?.displayName).toBe("ClawBox crab");
    expect(clawd?.submittedBy).toBe("ID-Robots");
    // It leads the list: it is the default and the one tile that needs no
    // internet, so it is not buried under thirteen downloads.
    expect(body.pets[0].slug).toBe("vibrant-clawd");
    // Nothing else changed: the curated shortlist is still offered, uninstalled.
    expect(body.pets.filter((p) => p.builtin)).toHaveLength(1);
    expect(body.pets.find((p) => p.slug === "boba")?.installed).toBe(false);
  }, 30_000);

  it("makes it the default pet", async () => {
    expect((await gallery()).defaultSlug).toBe("vibrant-clawd");
  }, 30_000);

  it("offers it on a Hermes box too, where the placeholder is still the egg", async () => {
    edition = "hermes";
    const body = await gallery();
    expect(body.placeholder).toBe("egg");
    expect(body.pets.find((p) => p.slug === "vibrant-clawd")?.installed).toBe(true);
    // The egg stays: the brand crab is not worn on someone else's harness
    // unless the owner picks it from this gallery.
    expect(body.activeSlug).toBe("");
  });

  it("reports it as the active body on an OpenClaw box with nothing picked", async () => {
    const body = await gallery();
    expect(body.placeholder).toBe("crab");
    expect(body.activeSlug).toBe("vibrant-clawd");
  }, 30_000);

  it("calls the pack ClawBox SHIPS by the name ClawBox ships it under", async () => {
    // A box whose owner picked the crab before the rename keeps a materialised
    // copy naming it "Vibrant Clawd", and `materialiseBuiltinPet` skips a
    // destination that exists — so the gallery, which prefers the installed
    // copy's name, went on showing the old one. For a slug ClawBox ships, the
    // name is ClawBox's own answer; only the BODY still comes from the owner's
    // copy, which is the precedence `loadPet` applies and is left alone.
    const dir = path.join(tmpHome, "data", "pets", "vibrant-clawd");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify({
      id: "vibrant-clawd",
      displayName: "Vibrant Clawd",
      spritesheetPath: "spritesheet.webp",
      frameWidth: 64,
      frameHeight: 64,
    }));
    fs.copyFileSync(
      path.join(process.cwd(), "public", "pets", "vibrant-clawd", "spritesheet.webp"),
      path.join(dir, "spritesheet.webp"),
    );

    const crab = (await gallery()).pets.find((p) => p.slug === "vibrant-clawd");
    expect(crab?.installed).toBe(true);
    expect(crab?.displayName).toBe("ClawBox crab");
  }, 30_000);
});

describe("GET /setup-api/pets/sprite", () => {
  it("serves the bundled sheet from the repo, byte for byte", async () => {
    const res = await sprite("vibrant-clawd");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = fs.readFileSync(
      path.join(process.cwd(), "public", "pets", "vibrant-clawd", "spritesheet.webp"),
    );
    expect(served.equals(onDisk)).toBe(true);
  });

  it("still 404s a pet that is neither installed nor bundled", async () => {
    expect((await sprite("boba")).status).toBe(404);
  });

  it("falls back to the bundled pack when the owner's copy of it is unusable", async () => {
    // An empty directory at the owner's path — a materialisation that died
    // half way, a stray mkdir — used to shadow the shipped pack outright: the
    // crab read as not installed, the sprite route 404'd, and the Hermes
    // arm's copy step skips an existing destination, so nothing repaired it.
    fs.mkdirSync(path.join(tmpHome, "data", "pets", "vibrant-clawd"), { recursive: true });

    const crab = (await gallery()).pets.find((p) => p.slug === "vibrant-clawd");
    expect(crab?.installed).toBe(true);
    expect(crab?.builtin).toBe(true);
    expect((await sprite("vibrant-clawd")).status).toBe(200);
  });
});
