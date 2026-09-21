// The picker's thumbnails are only as good as the sheet URL behind them, and
// that URL is NOT derivable from the slug: Petdex serves seven of the thirteen
// curated pets as `sprite-v2.webp` and six as `spritesheet.webp`. Composing
// either name 404s the other half of the gallery, which is what shipped before
// this module existed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmpHome: string;

function manifestBody(entries: { slug: string; spritesheetUrl: string }[]) {
  return JSON.stringify({ generatedAt: "now", total: entries.length, pets: entries });
}

async function loadModule() {
  vi.resetModules();
  return import("@/lib/petdex-manifest");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-petdex-"));
  vi.stubEnv("HERMES_HOME", tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("petdexSheetUrl", () => {
  it("returns the manifest's own spritesheetUrl, not a composed one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(manifestBody([
      { slug: "boba", spritesheetUrl: "https://assets.petdex.dev/curated/boba/sprite-v2.webp" },
      { slug: "boxcat", spritesheetUrl: "https://assets.petdex.dev/curated/boxcat/spritesheet.webp" },
    ]), { status: 200 })));
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");
    expect(await petdexSheetUrl("boxcat")).toBe("https://assets.petdex.dev/curated/boxcat/spritesheet.webp");
  });

  it("fetches the manifest ONCE however many slugs are asked for", async () => {
    const fetchMock = vi.fn(async () => new Response(manifestBody([
      { slug: "boba", spritesheetUrl: "https://assets.petdex.dev/curated/boba/sprite-v2.webp" },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { petdexSheetUrl } = await loadModule();
    await Promise.all(["boba", "boxcat", "scoop", "nukey"].map(petdexSheetUrl));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("writes the resolved map to disk so a restart does not re-fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(manifestBody([
      { slug: "scoop", spritesheetUrl: "https://assets.petdex.dev/curated/scoop/spritesheet.webp" },
    ]), { status: 200 })));
    const first = await loadModule();
    await first.petdexSheetUrl("scoop");

    // Fresh module, and a fetch that would fail if it were reached.
    const failing = vi.fn(async () => { throw new Error("network is down"); });
    vi.stubGlobal("fetch", failing);
    const second = await loadModule();
    expect(await second.petdexSheetUrl("scoop")).toBe("https://assets.petdex.dev/curated/scoop/spritesheet.webp");
    expect(failing).not.toHaveBeenCalled();
  });

  it("falls back to the curated address when the manifest cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { petdexSheetUrl } = await loadModule();
    // The two filename shapes, so a fallback that guessed one would fail here.
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");
    expect(await petdexSheetUrl("boxcat")).toBe("https://assets.petdex.dev/curated/boxcat/spritesheet.webp");
  });

  it("ignores a manifest entry pointing off the Petdex hosts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(manifestBody([
      { slug: "boba", spritesheetUrl: "https://evil.example.com/curated/boba/sprite-v2.webp" },
      { slug: "scoop", spritesheetUrl: "https://assets.petdex.dev/curated/scoop/spritesheet.webp" },
    ]), { status: 200 })));
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");
  });

  it("answers null for a slug ClawBox does not offer, without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { petdexSheetUrl } = await loadModule();
    // `skipper` is one of the three broken curated slugs that were dropped.
    expect(await petdexSheetUrl("skipper")).toBeNull();
    expect(await petdexSheetUrl("homelander")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a stale disk cache rather than nothing when the network is down", async () => {
    const cacheFile = path.join(tmpHome, "cache", "clawbox-pets", "sheet-urls.json");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      // Two days old — past the TTL, so the fetch is attempted and fails.
      fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
      urls: { boba: "https://assets.petdex.dev/curated/boba/sprite-v99.webp" },
    }));
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v99.webp");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("the curated list itself", () => {
  it("names no pet whose Petdex asset belongs to another pet", async () => {
    const { CURATED_PETS } = await import("@/lib/pet-curated");
    const slugs = CURATED_PETS.map((p) => p.slug);
    // These three resolve to cash-cuy's sheet and Sabo's pet.json upstream:
    // installing one downloads the wrong art under the wrong name.
    for (const broken of ["daemon-dumpling", "skipper", "captain-quack"]) {
      expect(slugs, broken).not.toContain(broken);
    }
  });

  it("gives every curated pet a fallback address under its OWN slug", async () => {
    const { CURATED_PETS, curatedFallbackSheetUrl } = await import("@/lib/pet-curated");
    for (const pet of CURATED_PETS) {
      expect(curatedFallbackSheetUrl(pet.slug)).toBe(
        `https://assets.petdex.dev/curated/${pet.slug}/${pet.sheetFile}`,
      );
    }
  });
});

// ── What actually lands on disk ──
//
// The cache file is written from a body this box did not author, so nothing
// from that body is carried through verbatim: the manifest is parsed, reduced
// to the two fields the picker consumes for the thirteen slugs it can offer,
// and re-serialised from the curated table’s own strings.

describe("the manifest never reaches the disk cache verbatim", () => {
  function cachePath() {
    return path.join(tmpHome, "cache", "clawbox-pets", "sheet-urls.json");
  }

  it("drops every field and slug the picker does not consume", async () => {
    const body = JSON.stringify({
      generatedAt: "now",
      total: 3,
      // A whole extra top-level branch, which must not survive.
      operatorNote: "x".repeat(5000),
      pets: [
        {
          slug: "boba",
          spritesheetUrl: "https://assets.petdex.dev/curated/boba/sprite-v2.webp",
          // Everything below is real manifest cargo we have no use for.
          petJsonUrl: "https://assets.petdex.dev/curated/boba/petjson.json",
          zipUrl: "https://assets.petdex.dev/curated/boba/boba.zip",
          displayName: "Boba",
          submittedBy: "railly",
          spriteVersionNumber: 2,
          notes: "y".repeat(5000),
        },
        // Not curated: 4.5k of these exist upstream and none may be cached.
        { slug: "homelander", spritesheetUrl: "https://assets.petdex.dev/pets/homelander/spritesheet.webp" },
        { slug: "scoop", spritesheetUrl: "https://assets.petdex.dev/curated/scoop/spritesheet.webp" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");

    const raw = fs.readFileSync(cachePath(), "utf-8");
    expect(raw).not.toContain("zipUrl");
    expect(raw).not.toContain("petjson");
    expect(raw).not.toContain("operatorNote");
    expect(raw).not.toContain("homelander");
    const written = JSON.parse(raw);
    expect(Object.keys(written).sort()).toEqual(["fetchedAt", "urls"]);
    expect(typeof written.fetchedAt).toBe("number");
    expect(written.urls).toEqual({
      boba: "https://assets.petdex.dev/curated/boba/sprite-v2.webp",
      scoop: "https://assets.petdex.dev/curated/scoop/spritesheet.webp",
    });
  });

  it("rebuilds the URL instead of copying it, so nothing rides along in a query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(manifestBody([
      {
        slug: "boba",
        spritesheetUrl:
          "https://assets.petdex.dev/curated/boba/sprite-v2.webp?trackme=1&next=//evil.example.com#frag",
      },
    ]), { status: 200 })));
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");
    const raw = fs.readFileSync(cachePath(), "utf-8");
    expect(raw).not.toContain("trackme");
    expect(raw).not.toContain("evil.example.com");
  });

  it("refuses a sheet URL that is not shaped like a curated sheet", async () => {
    const cases = [
      // Another pet's directory — the bug that made three slugs unofferable.
      "https://assets.petdex.dev/curated/cash-cuy/spritesheet.webp",
      // Outside the curated namespace entirely.
      "https://assets.petdex.dev/pets/boba/spritesheet.webp",
      // Traversal, which `pathname` keeps encoded so the file gate catches it.
      "https://assets.petdex.dev/curated/boba/..%2f..%2fetc%2fpasswd",
      // Not an image at all.
      "https://assets.petdex.dev/curated/boba/install.sh",
      // Credentials smuggled into the authority.
      "https://user:pw@assets.petdex.dev/curated/boba/sprite-v2.webp",
      // A file name past the length cap.
      `https://assets.petdex.dev/curated/boba/${"n".repeat(300)}.webp`,
      "http://assets.petdex.dev/curated/boba/sprite-v2.webp",
    ];
    for (const spritesheetUrl of cases) {
      fs.rmSync(path.join(tmpHome, "cache"), { recursive: true, force: true });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        manifestBody([{ slug: "boba", spritesheetUrl }]), { status: 200 },
      )));
      const { petdexSheetUrl } = await loadModule();
      // The offline fallback, not the manifest's answer.
      expect(await petdexSheetUrl("boba"), spritesheetUrl)
        .toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");
      expect(fs.existsSync(cachePath()), spritesheetUrl).toBe(false);
    }
  });

  it("rejects a manifest that declares more bytes than the cap", async () => {
    const fetchMock = vi.fn(async () => new Response(
      manifestBody([{ slug: "scoop", spritesheetUrl: "https://assets.petdex.dev/curated/scoop/spritesheet.webp" }]),
      { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("scoop")).toBe("https://assets.petdex.dev/curated/scoop/spritesheet.webp");
    expect(fetchMock).toHaveBeenCalled();
    // Fallback answer, and nothing cached from a body we refused to read.
    expect(fs.existsSync(cachePath())).toBe(false);
  });

  it("rejects an oversized body even when the declared length lies", async () => {
    const padded = JSON.stringify({
      pets: [{ slug: "scoop", spritesheetUrl: "https://assets.petdex.dev/curated/scoop/spritesheet.webp" }],
      filler: "z".repeat(17 * 1024 * 1024),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(padded, {
      status: 200, headers: { "content-length": "42" },
    })));
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("scoop")).toBe("https://assets.petdex.dev/curated/scoop/spritesheet.webp");
    expect(fs.existsSync(cachePath())).toBe(false);
  });

  it("re-validates the disk cache on read, so a hand-edited file cannot redirect a thumbnail", async () => {
    const cacheFile = cachePath();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      fetchedAt: Date.now(),
      urls: {
        boba: "https://evil.example.com/curated/boba/sprite-v2.webp",
        scoop: "https://assets.petdex.dev/curated/scoop/spritesheet.webp",
      },
    }));
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const { petdexSheetUrl } = await loadModule();
    expect(await petdexSheetUrl("boba")).toBe("https://assets.petdex.dev/curated/boba/sprite-v2.webp");
    expect(await petdexSheetUrl("scoop")).toBe("https://assets.petdex.dev/curated/scoop/spritesheet.webp");
  });
});
