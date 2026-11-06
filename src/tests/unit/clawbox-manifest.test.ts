/**
 * @vitest-environment node
 *
 * clawbox.json — the file that makes a folder a ClawBox app. Parsed
 * strictly: a manifest is what it says or it is nothing, never a guess.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { appProxyPath, isProxyablePort, manifestSlug, MANIFEST_MAX_BYTES, parseClawboxManifest, readClawboxManifest, readClawboxManifestSync, slugFromName } from "@/lib/clawbox-manifest";

describe("parseClawboxManifest", () => {
  it("reads every field, and drops the ones of the wrong shape", () => {
    expect(parseClawboxManifest(JSON.stringify({
      name: "  Tinder   Clone ", description: "Swipe on profiles", kind: "server", port: 4230, start: "bun run dev", stripBasePath: true,
    }))).toEqual({ name: "Tinder Clone", description: "Swipe on profiles", kind: "server", port: 4230, start: "bun run dev", stripBasePath: true });
    expect(parseClawboxManifest(JSON.stringify({ name: "x", kind: "spaceship", port: "4230", start: 7, stripBasePath: "yes" })))
      .toEqual({ name: "x", description: null, kind: null, port: null, start: null, stripBasePath: false });
  });

  it("reads a ClawBox Store slug only when it is one", () => {
    expect(parseClawboxManifest(JSON.stringify({ name: "A", slug: "tinder-clone" }))?.slug).toBe("tinder-clone");
    for (const slug of ["Tinder", "-x", "x-", "a/b", "a".repeat(65), 7]) {
      expect(parseClawboxManifest(JSON.stringify({ name: "A", slug })), String(slug)).not.toHaveProperty("slug");
    }
  });

  it("is nothing without a name, or when it is not an object", () => {
    expect(parseClawboxManifest("{}")).toBeNull();
    expect(parseClawboxManifest(JSON.stringify({ name: "   " }))).toBeNull();
    expect(parseClawboxManifest("[]")).toBeNull();
    expect(parseClawboxManifest("null")).toBeNull();
    expect(parseClawboxManifest("not json")).toBeNull();
  });

  it("bounds the texts", () => {
    const m = parseClawboxManifest(JSON.stringify({ name: "n".repeat(100), description: "d".repeat(500), start: "s".repeat(300) }));
    expect(m?.name).toHaveLength(60);
    expect(m?.description).toHaveLength(300);
    expect(m?.start).toHaveLength(200);
  });

  it("takes only a port a local server can listen on for the owner", () => {
    expect(isProxyablePort(3000)).toBe(true);
    expect(isProxyablePort(65535)).toBe(true);
    // Never the box's own web server, nor a privileged port, nor a fraction.
    expect(isProxyablePort(80)).toBe(false);
    expect(isProxyablePort(1023)).toBe(false);
    expect(isProxyablePort(65536)).toBe(false);
    expect(isProxyablePort(3000.5)).toBe(false);
    expect(isProxyablePort("3000")).toBe(false);
  });
});

describe("readClawboxManifest", () => {
  it("reads the file at the folder's root, and answers null for a folder without one or with a huge one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
    try {
      expect(await readClawboxManifest(dir)).toBeNull();
      expect(readClawboxManifestSync(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, "clawbox.json"), JSON.stringify({ name: "Site", port: 3000 }));
      expect(await readClawboxManifest(dir)).toMatchObject({ name: "Site", port: 3000 });
      expect(readClawboxManifestSync(dir)).toMatchObject({ name: "Site", port: 3000 });
      fs.writeFileSync(path.join(dir, "clawbox.json"), JSON.stringify({ name: "Site", pad: "x".repeat(MANIFEST_MAX_BYTES) }));
      expect(await readClawboxManifest(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the path the box serves a server app under", () => {
    expect(appProxyPath("tinder-clone")).toBe("/apps/tinder-clone/");
  });
});

describe("slugFromName / manifestSlug", () => {
  it("makes a Store slug of a name", () => {
    expect(slugFromName("Tinder Clone!")).toBe("tinder-clone");
    expect(slugFromName("  Café   Crème  ")).toBe("cafe-creme");
    expect(slugFromName("x".repeat(80))).toBe("x".repeat(64));
    expect(slugFromName("Тетрис")).toBeNull();
    expect(slugFromName("---")).toBeNull();
  });

  it("prefers the manifest's own slug, then the name, then the folder", () => {
    const base = { name: "Tinder Clone", description: null, kind: null, port: null, start: null, stripBasePath: false };
    expect(manifestSlug({ ...base, slug: "swiper" }, "folder")).toBe("swiper");
    expect(manifestSlug(base, "folder")).toBe("tinder-clone");
    expect(manifestSlug({ ...base, name: "Тетрис" }, "tetris-app")).toBe("tetris-app");
    expect(manifestSlug({ ...base, name: "Тетрис" })).toBeNull();
  });
});
