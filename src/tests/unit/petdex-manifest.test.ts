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
