import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findOpenclawBin } from "@/lib/openclaw-config";
import { installedOpenclawCoreGeneration } from "@/lib/openclaw-core-generation";

// Only the resolver, so the real module's own reading of the manifest is what
// is under test here.
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  findOpenclawBin: vi.fn(() => "/nonexistent/bin/openclaw"),
}));

/**
 * TASK-755. Which home the image-model slot is written to depends on this
 * answer, and `agents.defaults` is `.strict()` on BOTH generations — so a wrong
 * answer is `Unrecognized key` and gateway exit 78, not a key quietly ignored.
 * `unknown` is therefore an answer worth having rather than a failure.
 */
describe("which OpenClaw core generation is installed", () => {
  let root: string;
  let ambient: string | undefined;

  function installCore(version: unknown): void {
    const pkgDir = path.join(root, "lib", "node_modules", "openclaw");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(version === undefined ? { name: "openclaw" } : { name: "openclaw", version }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "clawbox-core-gen-"));
    mkdirSync(path.join(root, "bin"), { recursive: true });
    ambient = process.env.OPENCLAW_BIN;
    process.env.OPENCLAW_BIN = path.join(root, "bin", "openclaw");
  });

  afterEach(() => {
    if (ambient === undefined) delete process.env.OPENCLAW_BIN;
    else process.env.OPENCLAW_BIN = ambient;
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["2026.8.0", "v2"],
    ["2026.8.1", "v2"],
    ["2026.9.2", "v2"],
    ["2027.1.0", "v2"],
    ["2026.7.1", "v1"],
    ["2026.1.0", "v1"],
    ["2025.12.4", "v1"],
  ])("reads %s as %s", async (version, expected) => {
    installCore(version);

    await expect(installedOpenclawCoreGeneration()).resolves.toBe(expected);
  });

  it.each([
    ["a prerelease", "2026.8.1-dev.3", "v2"],
    ["a v1 prerelease", "2026.7.1-rc.1", "v1"],
  ])("puts %s in the same generation the boot script does", async (_label, version, expected) => {
    // The boot script reads the same field with `grep -oE
    // '^20[0-9]{2}\.[0-9]+\.[0-9]+'` — anchored at the START only. Measured:
    // it calls `2026.8.1-dev.3` v2. If this reader called it unknown, the boot
    // script would write `mediaModels.image` on that box and this route would
    // write nothing, which is the writer disagreement this card exists to close.
    installCore(version);

    await expect(installedOpenclawCoreGeneration()).resolves.toBe(expected);
  });

  it.each([
    ["a git install", "0.0.0-development"],
    ["a month that is not a month", "2026.13.0"],
    ["a zero month", "2026.0.0"],
    ["a version that does not begin with a date", "v2026.8.1"],
    ["not a string", 20268],
    ["absent", undefined],
  ])("answers unknown for %s rather than guessing a generation", async (_label, version) => {
    // A build whose version does not BEGIN with a date says nothing about which
    // config homes it accepts, and guessing v1 there would write a key a v2
    // gateway refuses outright.
    installCore(version);

    await expect(installedOpenclawCoreGeneration()).resolves.toBe("unknown");
  });

  it("trims a padded version rather than calling it unrecognisable", () => {
    // Deliberately more forgiving than the boot script's `grep -oE '^20…'`,
    // which reads the same field unanchored to whitespace: a padded version is
    // still unambiguous about the generation, and answering `unknown` there
    // would stop a perfectly identifiable box writing its image slot at all.
    installCore(" 2026.8.1 ");

    return expect(installedOpenclawCoreGeneration()).resolves.toBe("v2");
  });

  it("finds the core through findOpenclawBin when nothing overrides it", async () => {
    // THE BRANCH EVERY BOX TAKES. Nothing sets `OPENCLAW_BIN` in the web
    // server's unit, so this is the production path and it was the one with no
    // case: a typo in the join would answer `unknown` on every box and leave
    // the suite green. `findOpenclawBin` is the same resolver `memory-shard.ts`
    // uses to read this very file, which is what stops the two disagreeing.
    delete process.env.OPENCLAW_BIN;
    installCore("2026.8.1");
    vi.mocked(findOpenclawBin).mockReturnValue(path.join(root, "bin", "openclaw"));

    await expect(installedOpenclawCoreGeneration()).resolves.toBe("v2");
  });

  it("answers unknown, not a throw, when there is no core at all", async () => {
    // Every caller of this is on a path that must still write what it can: a
    // Hermes box, a half-finished update and a developer machine all land here.
    await expect(installedOpenclawCoreGeneration()).resolves.toBe("unknown");
  });

  it("answers unknown for a manifest that is not JSON", async () => {
    const pkgDir = path.join(root, "lib", "node_modules", "openclaw");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), "half a file, no closing brace");

    await expect(installedOpenclawCoreGeneration()).resolves.toBe("unknown");
  });

  it("reads the manifest beside the binary, not a fixed path", async () => {
    // `OPENCLAW_BIN` is an installer or operator override; a hard-coded path
    // would answer about a different core than the one that will parse what
    // this box writes.
    installCore("2026.7.1");
    const other = mkdtempSync(path.join(tmpdir(), "clawbox-core-gen-other-"));
    try {
      mkdirSync(path.join(other, "lib", "node_modules", "openclaw"), { recursive: true });
      writeFileSync(
        path.join(other, "lib", "node_modules", "openclaw", "package.json"),
        JSON.stringify({ version: "2026.8.1" }),
      );
      process.env.OPENCLAW_BIN = path.join(other, "bin", "openclaw");

      await expect(installedOpenclawCoreGeneration()).resolves.toBe("v2");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
