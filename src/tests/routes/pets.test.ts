// Pets on every edition (since 2026-09-07), through one route and two stores:
// on Hermes the `hermes` CLI and its config.yaml, on OpenClaw — where no such
// binary exists — ClawBox's own `data/pets` and the config store. The one
// fact the edition still decides is what the desktop wears with NO pet: the
// crab wherever ClawBox's own harness runs, the egg on a Hermes-only box.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CURATED_PETS } from "@/lib/pet-curated";

let tmpHome: string;
let petsDir: string;
let edition = "hermes";

vi.mock("@/lib/edition-source", () => ({
  readEdition: () => edition,
  hasHermesHarness: () => edition === "hermes" || edition === "dual",
}));

const cliCalls: string[][] = [];
let cliExit = 0;
let directUrl: string | null = null;
vi.mock("@/lib/petdex-manifest", () => ({
  PETDEX_ASSET_HOSTS: new Set<string>(["assets.petdex.dev"]),
  petdexSheetUrl: async () => directUrl,
}));

vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: (args: string[]) => {
    cliCalls.push(args);
    if (args[1] === "install" && cliExit === 0) {
      const dir = path.join(petsDir, args[2]);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify({ id: args[2], displayName: "Boba" }));
      fs.writeFileSync(path.join(dir, "spritesheet.webp"), "x");
    }
    return Promise.resolve({ code: cliExit, stdout: "", stderr: "" });
  },
}));

let petConfig = { enabled: false, slug: "" };
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: () =>
    Promise.resolve({
      "display.pet.enabled": petConfig.enabled ? "true" : "false",
      "display.pet.slug": petConfig.slug,
    }),
}));

async function getRoute() {
  vi.resetModules();
  return (await import("@/app/setup-api/pets/route")).GET;
}
async function selectRoute() {
  vi.resetModules();
  return (await import("@/app/setup-api/pets/select/route")).POST;
}

function post(body: unknown) {
  return new Request("http://localhost/setup-api/pets/select", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pets-route-"));
  process.env.HERMES_HOME = tmpHome;
  // The OpenClaw arm's store and config live under CLAWBOX_ROOT/data.
  process.env.CLAWBOX_ROOT = tmpHome;
  petsDir = path.join(tmpHome, "pets");
  directUrl = null;
  edition = "hermes";
  petConfig = { enabled: false, slug: "" };
  cliCalls.length = 0;
  cliExit = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /setup-api/pets — edition gating", () => {
  it("offers the curated shortlist on OpenClaw too, with the crab as what 'no pet' wears", async () => {
    edition = "openclaw";
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets?gallery=1"));
    const body = await res.json();
    expect(body.supported).toBe(true);
    expect(body.placeholder).toBe("crab");
    expect(body.active).toBeNull();
    expect(body.pets.length).toBe(CURATED_PETS.length);
    // No Hermes CLI was asked for anything on the way.
    expect(cliCalls).toEqual([]);
  });

  it("names the egg as what 'no pet' wears on a Hermes-only box, and the crab on dual", async () => {
    let res = await (await getRoute())(new Request("http://localhost/setup-api/pets"));
    expect((await res.json()).placeholder).toBe("egg");
    edition = "dual";
    res = await (await getRoute())(new Request("http://localhost/setup-api/pets"));
    expect((await res.json()).placeholder).toBe("crab");
  });

  it("offers the curated shortlist on Hermes", async () => {
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets?gallery=1"));
    const body = await res.json();
    expect(body.supported).toBe(true);
    expect(body.pets.length).toBe(CURATED_PETS.length);
    expect(body.pets.every((p: { curated: boolean }) => p.curated)).toBe(true);
    // Attribution travels with every tile — Petdex asks that pets keep credit.
    expect(body.pets.every((p: { submittedBy: string }) => p.submittedBy.length > 0)).toBe(true);
  });

  it("offers pets on the premium dual edition too", async () => {
    edition = "dual";
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets?gallery=1"));
    expect((await res.json()).supported).toBe(true);
  });

  it("has no active pet on a fresh Hermes box", async () => {
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets"));
    const body = await res.json();
    expect(body.supported).toBe(true);
    expect(body.active).toBeNull();
  });

  it("includes a pet installed outside ClawBox (CLI, or locally generated)", async () => {
    const dir = path.join(petsDir, "homemade");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify({ id: "homemade", displayName: "Homemade", createdBy: "generator" }));
    fs.writeFileSync(path.join(dir, "spritesheet.webp"), "x");
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets?gallery=1"));
    const body = await res.json();
    const found = body.pets.find((p: { slug: string }) => p.slug === "homemade");
    expect(found).toMatchObject({ installed: true, curated: false });
  });

  it("lists the whole shortlist with no internet at all", async () => {
    // The installed flag comes off the filesystem, not the Petdex manifest, so
    // the picker is fully usable offline — upstream's pet.gallery fail-open,
    // without needing the fallback.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets?gallery=1"));
    expect((await res.json()).pets.length).toBe(CURATED_PETS.length);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/pets/select", () => {
  it("on OpenClaw downloads the curated sheet into data/pets and keeps the pick in the config store", async () => {
    edition = "openclaw";
    directUrl = "https://assets.petdex.dev/curated/boba/sprite-v2.webp";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(Buffer.from("RIFF-not-really-a-webp"), { status: 200, headers: { "content-length": "22" } }),
    );
    const res = await (await selectRoute())(post({ slug: "boba" }));
    expect(res.status).toBe(200);
    expect((await res.json()).active).toMatchObject({ slug: "boba" });
    expect(fetchSpy).toHaveBeenCalledWith(directUrl, expect.objectContaining({ redirect: "manual" }));
    // ClawBox's own store, not Hermes' — and no CLI call on the way.
    expect(fs.existsSync(path.join(tmpHome, "data", "pets", "boba", "spritesheet.webp"))).toBe(true);
    expect(fs.existsSync(path.join(petsDir, "boba"))).toBe(false);
    expect(cliCalls).toEqual([]);
    const store = JSON.parse(fs.readFileSync(path.join(tmpHome, "data", "config.json"), "utf-8"));
    expect(store.mascot_pet).toEqual({ enabled: true, slug: "boba" });
    // The GET now reports it, and a null slug turns it off in the same store.
    expect((await (await (await getRoute())(new Request("http://localhost/setup-api/pets"))).json()).active).toMatchObject({ slug: "boba" });
    const off = await (await selectRoute())(post({ slug: null }));
    expect(off.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(tmpHome, "data", "config.json"), "utf-8")).mascot_pet).toEqual({ enabled: false, slug: "boba" });
  });

  it("on OpenClaw answers 502 when the sheet cannot be fetched, and stores nothing", async () => {
    edition = "openclaw";
    directUrl = "https://assets.petdex.dev/curated/boba/sprite-v2.webp";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const res = await (await selectRoute())(post({ slug: "boba" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "install-failed" });
    expect(fs.existsSync(path.join(tmpHome, "data", "config.json"))).toBe(false);
  });

  it("installs and activates, then reports the new active pet", async () => {
    const POST = await selectRoute();
    // The pet exists on disk after the mocked install, and the config now
    // reports it — the same round-trip the real CLI performs.
    const res = await POST(post({ slug: "boba" }));
    petConfig = { enabled: true, slug: "boba" };
    expect(res.status).toBe(200);
    expect(cliCalls).toEqual([
      ["pets", "install", "boba"],
      ["pets", "select", "boba"],
    ]);
  });

  it("persists the choice where every Hermes surface reads it", async () => {
    // The persistence claim is precisely "we wrote through the CLI, which
    // writes display.pet.* in config.yaml" — ClawBox keeps no copy of its own.
    const POST = await selectRoute();
    await POST(post({ slug: "boba" }));
    petConfig = { enabled: true, slug: "boba" };
    const res = await (await getRoute())(new Request("http://localhost/setup-api/pets"));
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.activeSlug).toBe("boba");
    expect(body.active).toMatchObject({ slug: "boba", frameW: 192, frameH: 208 });
  });

  it("turns the pet off through `hermes pets off`", async () => {
    const res = await (await selectRoute())(post({ slug: null }));
    expect(res.status).toBe(200);
    expect(cliCalls).toEqual([["pets", "off"]]);
  });

  it("rejects a slug that could escape the pets directory", async () => {
    const res = await (await selectRoute())(post({ slug: "../../etc/passwd" }));
    expect(res.status).toBe(400);
    expect(cliCalls).toEqual([]);
  });

  it("rejects a slug the CLI would read as a flag", async () => {
    const res = await (await selectRoute())(post({ slug: "--force" }));
    expect(res.status).toBe(400);
    expect(cliCalls).toEqual([]);
  });

  it("returns a fixed message when the install fails, never the CLI's own output", async () => {
    // The CLI's stderr can carry filesystem paths and upstream internals; it is
    // logged on the server and must not reach the browser.
    cliExit = 1;
    const res = await (await selectRoute())(post({ slug: "boba" }));
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error).toBe("Could not download that pet");
    expect(JSON.stringify(body)).not.toContain(".hermes");
  });

  it("rejects a body that is not JSON", async () => {
    const POST = await selectRoute();
    const res = await POST(
      new Request("http://localhost/setup-api/pets/select", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
    expect(cliCalls).toEqual([]);
  });
});
