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
/** The stamp set_previous_build_aside leaves in the tree it parks. */
const OWNER_STAMP = ".rebuild-pid";

/**
 * The stamp's second field. A PID is only evidence within the boot that issued
 * it — a power cut mid-build leaves the stamp on disk, and after the reboot the
 * number can belong to anything — so writer and reader both pin it to the boot.
 */
function bootId(): string {
  const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  if (!id) throw new Error("/proc/sys/kernel/random/boot_id is empty — these cases need a Linux host");
  return id;
}

/** What install.sh's set_previous_build_aside writes into the tree it parks. */
const ownerStamp = (pid: number): string => `${pid} ${bootId()}\n`;
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

/**
 * A PID that is certainly not running.
 *
 * The stamp `set_previous_build_aside` leaves in the parked tree must not become
 * a latch: an OOM kill leaves it behind together with the build, and that is
 * the exact case the reclaim exists for. Testing "the owner is gone" needs a
 * number that really is gone, and `pid_max` is one by definition — proc(5)
 * says the value in that file "is one greater than the maximum PID", so the
 * kernel never allocates it. Reading it beats spawning a child and waiting for
 * it to die: no real process, no second timeout ceiling
 * (test-timeout-hygiene.test.ts), and no window in which the kernel could hand
 * the number to something else.
 */
function deadPid(): number {
  const pid = Number.parseInt(readFileSync("/proc/sys/kernel/pid_max", "utf-8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("could not read /proc/sys/kernel/pid_max");
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) throw new Error(`pid ${pid} is running after all — it cannot stand in for a dead one`);
  return pid;
}

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

  it("refuses to reclaim the parked build while the rebuild that parked it is still running", () => {
    // The window is not narrow: `do_rebuild` renames `.next` to `.next-old`
    // and only THEN runs `bun run build`, so for the whole length of the build
    // — minutes on a Jetson — there is no `.next/standalone/server.js` and
    // there is a parked one. That is exactly the condition this block reclaims
    // on, and clawbox-setup is pulled back up inside that window routinely:
    // `clawbox-gateway.service` carries `Wants=clawbox-setup.service`, so every
    // gateway (re)start starts the service `do_rebuild` had just stopped (seen
    // in e2e-install run 33971129750, four seconds after the stop). Reclaiming
    // there `rm -rf`s the half-written build out from under `next build` and
    // renames the previous one on top of it.
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id");
    writeFileSync(path.join(kept, OWNER_STAMP), ownerStamp(process.pid), "utf-8");
    // What `next build` has written so far: a `.next` with no standalone entry.
    mkdirSync(path.join(projectDir, ".next", "server"), { recursive: true });
    writeFileSync(path.join(projectDir, ".next", "BUILD_ID"), "half-written\n", "utf-8");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    // The in-progress build is untouched…
    expect(existsSync(path.join(projectDir, ".next", "server"))).toBe(true);
    expect(buildId(projectDir)).toBe("half-written");
    // …and so is the fallback the rebuild is counting on.
    expect(existsSync(path.join(kept, "standalone", "server.js"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/rebuild is in progress/);
  });

  it("still reclaims once the rebuild that parked the build is gone", () => {
    // An OOM kill leaves the stamp behind together with the build. A stamp
    // that outlived its process must not disable the reclaim — that would turn
    // the repair #632 added into the crash loop it was written to end.
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id");
    writeFileSync(path.join(kept, OWNER_STAMP), ownerStamp(deadPid()), "utf-8");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    expect(existsSync(path.join(projectDir, ".next-old"))).toBe(false);
    // …and the stamp does not ride into the tree the box now serves.
    expect(existsSync(path.join(projectDir, ".next", OWNER_STAMP))).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/killed mid-rebuild/);
  });

  it("reclaims when the stamp is from an earlier boot", () => {
    // The power-cut case, after the reboot. The PID in the stamp may well be
    // live by then — it belongs to whatever systemd started this time — and
    // believing it would leave the box crash-looping with its only build on
    // disk, which is the exact state this block exists to end.
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id");
    writeFileSync(
      path.join(kept, OWNER_STAMP),
      `${process.pid} 00000000-0000-4000-8000-000000000000\n`,
      "utf-8",
    );

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    expect(existsSync(path.join(projectDir, ".next-old"))).toBe(false);
  });

  it("refuses for a live owner this process may not signal", () => {
    // The branch that actually runs on a device: do_rebuild is root and this
    // server is `clawbox`, so `process.kill(pid, 0)` answers EPERM rather than
    // succeeding, and EPERM means alive. pid 1 stands in for it — owned by
    // root, always running. (A suite run AS root takes the success branch
    // instead and asserts the same outcome, which is why there is no skip.)
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id");
    writeFileSync(path.join(kept, OWNER_STAMP), ownerStamp(1), "utf-8");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(existsSync(path.join(kept, "standalone", "server.js"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/rebuild is in progress/);
  });

  it("reclaims, and says so, when the stamp cannot be read as an owner", () => {
    // A stamp that is there but proves nothing — truncated, garbled, written by
    // a shell that could not read the boot id. Reclaiming is right, but a guard
    // that is silently inoperative must not look like one that never fired.
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id");
    writeFileSync(path.join(kept, OWNER_STAMP), `not-a-pid ${bootId()}\n`, "utf-8");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    expect(r.warnings.join(" ")).toMatch(/names no live rebuild/);
  });

  it.each([
    ["a pid with trailing junk", (b: string) => `123junk ${b}`],
    ["a third field", (b: string) => `1 ${b} trailing`],
    ["only a pid", () => "1"],
  ])("reclaims when the stamp has %s", (_name, make) => {
    // Only a stamp this file can vouch for may refuse the reclaim. One writer
    // produces `<pid> <boot id>` and nothing else, so anything of another shape
    // is corruption — and believing it would strand the box on a crash loop
    // with its only build on disk, which is the expensive direction.
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id");
    writeFileSync(path.join(kept, OWNER_STAMP), `${make(bootId())}\n`, "utf-8");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    expect(r.warnings.join(" ")).toMatch(/names no live rebuild/);
  });

  it("reclaims a parked build that carries no stamp at all", () => {
    // Every build parked before this stamp existed, and every one parked by a
    // shell that could not write it, has none. Absent must mean "nobody is
    // building", or an upgrade would strand exactly the boxes already stuck.
    writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");

    const r = runReclaim(projectDir);

    expect(r.threw).toBeNull();
    expect(buildId(projectDir)).toBe("parked-build-id");
    // …and nothing is said about a stamp that was never there.
    expect(r.warnings.join(" ")).not.toMatch(/names no live rebuild/);
  });
});
