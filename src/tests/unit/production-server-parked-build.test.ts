import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The half `install.sh` cannot reach: a build parked by an update that was
 * killed OUTRIGHT.
 *
 * `do_rebuild` renames the serving build to `.next-old` before it builds and
 * renames it back when the build fails — but only if that shell survives. An
 * OOM kill that picks the shell (TASK-709: three in one night, `next-build` at
 * 2.1 GB against ollama's 2.3 GB), a power cut or a Ctrl-C leaves no `.next` at
 * all and a perfectly good build under a gitignored directory. `install.sh`'s
 * own `promote_parked_build` is no help there: it runs inside an update, and an
 * update needs the dashboard to be up. So the box crash-looped on the missing
 * entry with its build on disk, and every recovery was by hand.
 *
 * production-server.js is the one process that runs in that state, so the
 * reclaim lives immediately before its `require`. These cases run the SHIPPED
 * block — extracted from the file by text — against a temp tree.
 */

const REPO = process.cwd();
const SRC = readFileSync(path.join(REPO, "production-server.js"), "utf-8");
const START = "// A build parked by an update that was killed OUTRIGHT";
const END = 'require("./.next/standalone/server.js");';

/** The shipped reclaim block, verbatim, or a failure that names why. */
function reclaimBlock(): string {
  const from = SRC.indexOf(START);
  const to = SRC.indexOf(END);
  if (from < 0) throw new Error("the parked-build reclaim block is gone from production-server.js");
  if (to < from) throw new Error("the reclaim block no longer sits before the standalone require");
  const block = SRC.slice(from, to).trim();
  // A block that no longer mentions the parked directory would run happily and
  // assert nothing — the shape this whole file exists to catch elsewhere.
  if (!block.includes(".next-old")) throw new Error("the reclaim block no longer names .next-old");
  return block;
}

interface Reclaim {
  warnings: string[];
  threw: unknown;
}

function runReclaim(dir: string, fsOverride: object = {}): Reclaim {
  const warnings: string[] = [];
  const fakeConsole = { warn: (...args: unknown[]) => warnings.push(args.join(" ")) };
  const fs = { ...realFs, ...fsOverride };
  let threw: unknown = null;
  try {
    new Function("fs", "path", "__dirname", "console", reclaimBlock())(fs, path, dir, fakeConsole);
  } catch (err) {
    threw = err;
  }
  return { warnings, threw };
}

function writeBuild(dir: string, buildId: string): void {
  mkdirSync(path.join(dir, "standalone"), { recursive: true });
  writeFileSync(path.join(dir, "BUILD_ID"), buildId + "\n", "utf-8");
  writeFileSync(path.join(dir, "standalone", "server.js"), "// server\n", "utf-8");
}

const buildId = (dir: string): string | null => {
  const p = path.join(dir, ".next", "BUILD_ID");
  return existsSync(p) ? readFileSync(p, "utf-8").trim() : null;
};

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "clawbox-parked-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("production-server.js reclaims a parked build at boot", () => {
  it("puts the parked build back when there is no build at all", () => {
    writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    expect(existsSync(path.join(projectDir, ".next-old"))).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/killed mid-rebuild/);
  });

  it("puts back a parked build whose entry is the nested layout's symlink", () => {
    // `postbuild` links `.next/standalone/server.js` at an ABSOLUTE path inside
    // `.next` when Next nests the standalone tree — and that link dangles for
    // as long as the tree is parked. `existsSync` follows it and would call the
    // box's only build absent.
    const kept = path.join(projectDir, ".next-old");
    mkdirSync(path.join(kept, "standalone", "nested"), { recursive: true });
    writeFileSync(path.join(kept, "BUILD_ID"), "parked-build-id\n", "utf-8");
    writeFileSync(path.join(kept, "standalone", "nested", "server.js"), "// server\n", "utf-8");
    symlinkSync(
      path.join(projectDir, ".next", "standalone", "nested", "server.js"),
      path.join(kept, "standalone", "server.js"),
    );

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    // …and the link resolves again once the tree is back where it points.
    expect(existsSync(path.join(projectDir, ".next", "standalone", "server.js"))).toBe(true);
  });

  it("does not touch a box that already has a build", () => {
    // The narrowness IS the safety: this runs in the boot path of every box on
    // every restart, and a build that is present must be left exactly alone —
    // including a stale `.next-old` a previous run left behind.
    writeBuild(path.join(projectDir, ".next"), "current-build-id");
    writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("current-build-id");
    expect(existsSync(path.join(projectDir, ".next-old"))).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("says nothing and throws nothing when there is neither build", () => {
    // A box that genuinely has no build must still reach the `require` below,
    // so that ITS error is the one an operator reads.
    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(existsSync(path.join(projectDir, ".next"))).toBe(false);
  });

  it("never lets its own failure stop the server from starting", () => {
    // A read-only rootfs, a directory another process is holding, an ENOSPC on
    // the rename: whatever it is, this block must swallow it. It runs in the
    // boot path of every box on every restart, and the `require` below is what
    // has to produce the real error — not a throw from the repair attempt.
    writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");

    const r = runReclaim(projectDir, {
      renameSync: () => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      },
    });

    expect(r.threw).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/Could not reclaim a parked build/);
  });
});
