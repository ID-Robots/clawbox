/**
 * @vitest-environment node
 *
 * The shipped build is a webpack build. Next 16 bundles with Turbopack by
 * default, and on the 8 GB Jetson that build is OOM-killed (2026-09-05: the
 * kernel killed `next-build` at 4.6 GB resident with 5.7 GB free, and the
 * owner's in-app update ended on "rebuild failed (exit 137)"), while the
 * webpack build of the same commit fits in ~3.7 GB. Pinned here because the
 * flag is one word in package.json and the box has no other way to build.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

describe("the box's build", () => {
  it("bundles with webpack, not Turbopack", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe("next build --webpack");
    // The dev server may keep Turbopack: it never runs on the box.
    expect(pkg.scripts.postbuild).toContain("write-build-info.mjs");
  });

  it("is run by the updater with two webpack workers, so its peak stays where it was measured", () => {
    const install = fs.readFileSync(path.join(ROOT, "install.sh"), "utf-8");
    expect(install).toContain("NEXT_WEBPACK_PARALLELISM=2 $BUN run build");
  });
});
