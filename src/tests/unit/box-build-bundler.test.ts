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
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// The link script is a real bash process: vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded runner (test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = process.cwd();

describe("the box's build", () => {
  it("bundles with webpack, not Turbopack", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe("next build --webpack");
    expect(pkg.scripts.postbuild).toBe("bash scripts/postbuild.sh");
    // The dev server may keep Turbopack: it never runs on the box.
    const postbuild = fs.readFileSync(path.join(ROOT, "scripts", "postbuild.sh"), "utf-8");
    // The webpack standalone build's traced copy of `next` misses
    // lib/metadata/get-metadata-route (the server dies on it at start —
    // both e2e suites did, 2026-09-05); postbuild points the standalone
    // tree at the real package through a script that fails the build when
    // it cannot (set -e in postbuild.sh propagates it)…
    expect(postbuild).toContain("set -euo pipefail");
    expect(postbuild).toContain('bash scripts/link-standalone-next.sh "$LINK_TREE"');
    // …and the playwright copy runs only into a node_modules directory of
    // the standalone tree's own: through a symlinked one its rm removed the
    // real package too (2026-09-05).
    expect(postbuild).toContain('if [ ! -L "$SDIR/node_modules" ]; then');
  });

  it("is run by the updater with two webpack workers, so its peak stays where it was measured", () => {
    const install = fs.readFileSync(path.join(ROOT, "install.sh"), "utf-8");
    expect(install).toContain("NEXT_WEBPACK_PARALLELISM=2 $BUN run build");
  });
});

describe("link-standalone-next.sh", () => {
  const script = path.join(ROOT, "scripts", "link-standalone-next.sh");
  /** A project with a real `next` package and a standalone tree whose node_modules is a directory, or a symlink to the project's. */
  function fixture(standaloneNodeModules: "directory" | "symlink") {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "link-next-"));
    const project = path.join(base, "project");
    fs.mkdirSync(path.join(project, "node_modules", "next", "dist"), { recursive: true });
    fs.writeFileSync(path.join(project, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "16.3.3" }));
    fs.writeFileSync(path.join(project, "node_modules", "next", "dist", "real.js"), "real");
    const standalone = path.join(project, ".next", "standalone");
    fs.mkdirSync(standalone, { recursive: true });
    if (standaloneNodeModules === "directory") {
      fs.mkdirSync(path.join(standalone, "node_modules", "next"), { recursive: true });
      fs.writeFileSync(path.join(standalone, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", traced: true }));
    } else {
      fs.symlinkSync(path.join(project, "node_modules"), path.join(standalone, "node_modules"));
    }
    return { base, project, standalone };
  }
  const run = (standalone: string, project: string) => spawnSync("bash", [script, standalone, project], { encoding: "utf-8" });

  it("replaces the traced copy in a standalone tree of its own with a link to the real package", () => {
    const { base, project, standalone } = fixture("directory");
    try {
      const r = run(standalone, project);
      expect(r.status, r.stderr).toBe(0);
      const link = path.join(standalone, "node_modules", "next");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(project, "node_modules", "next"));
      expect(fs.existsSync(path.join(link, "dist", "real.js"))).toBe(true);
      // The real package is exactly as it was.
      expect(JSON.parse(fs.readFileSync(path.join(project, "node_modules", "next", "package.json"), "utf-8")).version).toBe("16.3.3");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("touches nothing when the standalone node_modules is a symlink — the real package would be what it removed", () => {
    const { base, project, standalone } = fixture("symlink");
    try {
      const r = run(standalone, project);
      expect(r.status, r.stderr).toBe(0);
      expect(fs.lstatSync(path.join(standalone, "node_modules")).isSymbolicLink()).toBe(true);
      const real = path.join(project, "node_modules", "next");
      expect(fs.lstatSync(real).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(real, "dist", "real.js"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails when the project has no real next package to link — the traced copy is never waved through", () => {
    const { base, project, standalone } = fixture("directory");
    try {
      fs.rmSync(path.join(project, "node_modules", "next"), { recursive: true, force: true });
      const r = run(standalone, project);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no ");
      // The traced copy is left where it was, for the failure to be read.
      expect(fs.existsSync(path.join(standalone, "node_modules", "next", "package.json"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails when the standalone tree has no node_modules directory to link into", () => {
    const { base, project, standalone } = fixture("directory");
    try {
      fs.rmSync(path.join(standalone, "node_modules"), { recursive: true, force: true });
      const r = run(standalone, project);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not a directory");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
