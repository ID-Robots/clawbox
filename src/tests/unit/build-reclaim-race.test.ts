import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-729 — two reclaimers of the same two directories, and no lock between
 * them.
 *
 * `install.sh`'s `promote_parked_build` and the boot-time block in
 * `production-server.js` both put a build parked by a killed rebuild back, and
 * both used to run the same non-atomic pair: `rm -rf .next`, then
 * `mv .next-old .next`. They fire on the same fact — no `.next/standalone/
 * server.js`, but a `.next-old/standalone/server.js` — and nothing stops them
 * running together: `do_rebuild` stops clawbox-setup and calls
 * `promote_parked_build` while a gateway (re)start can pull the web server
 * straight back up.
 *
 * Whichever arrived second destroyed what the first had just restored: its
 * `rm -rf .next` deleted the build, and its own rename then failed into a
 * best-effort catch. The box was left with NEITHER tree — and if the build that
 * follows is OOM-killed, `restore_previous_build` finds nothing to fall back
 * on and the dashboard stays down. That is the exact outcome the park exists to
 * prevent (#632).
 *
 * The fix is not a second advisory check but an ATOMIC CLAIM: rename the parked
 * tree to a private name FIRST — a rename has exactly one winner — and destroy
 * only private names afterwards. The loser's rename fails and it returns having
 * touched nothing.
 *
 * Both implementations are driven here, in one file, because the invariant is
 * shared and two files would let them drift.
 */

// Starts a real bash process for the shell half; vitest's 5 s default is not
// enough on a loaded runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = fs.readFileSync(INSTALL_SH_PATH, "utf-8");
const SERVER_JS = fs.readFileSync(path.join(REPO, "production-server.js"), "utf-8");
const NL = String.fromCharCode(10);

function writeBuild(dir: string, buildId: string): void {
  fs.mkdirSync(path.join(dir, "standalone"), { recursive: true });
  fs.writeFileSync(path.join(dir, "BUILD_ID"), `${buildId}${NL}`, "utf-8");
  fs.writeFileSync(path.join(dir, "standalone", "server.js"), "// server\n", "utf-8");
}

const buildIdAt = (dir: string): string | null => {
  const p = path.join(dir, "BUILD_ID");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : null;
};

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-race-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("install.sh's reclaim cannot destroy a build the other reclaimer restored", () => {
  /**
   * Run the shipped `promote_parked_build` with the OTHER reclaimer wedged into
   * it, deterministically.
   *
   * `rm` and `mv` are shell functions here, and the first of them to be called
   * runs the other reclaimer's whole sequence before handing on to the real
   * command. That is the interleave, made repeatable: whatever the function
   * reaches for first, it reaches for it one instant after the other reclaimer
   * has finished.
   */
  function runInterleaved() {
    const script = [
      // install.sh's own options: a laxer harness would certify a script the
      // shipped one is not.
      "set -euo pipefail",
      `PROJECT_DIR="${projectDir}"`,
      "wedged=0",
      // The other reclaimer, as production-server.js ran it before this fix:
      // destroy .next, then rename the parked tree over it.
      "other_reclaimer() {",
      '  command rm -rf "$PROJECT_DIR/.next"',
      '  command mv "$PROJECT_DIR/.next-old" "$PROJECT_DIR/.next" 2>/dev/null || true',
      '  printf other >> "$PROJECT_DIR/wedged.log"',
      "}",
      "wedge() { if [ \"$wedged\" = 0 ]; then wedged=1; other_reclaimer; fi; }",
      'rm() { wedge; command rm "$@"; }',
      'mv() { wedge; command mv "$@"; }',
      `sed -n '/^build_entry_present() {/,/^}/p' "$1" > "${projectDir}/fns.sh"`,
      `sed -n '/^drain_build_transients() {/,/^}/p' "$1" >> "${projectDir}/fns.sh"`,
      `sed -n '/^promote_parked_build() {/,/^}/p' "$1" >> "${projectDir}/fns.sh"`,
      `. "${projectDir}/fns.sh"`,
      'promote_parked_build "$PROJECT_DIR/.next" "$PROJECT_DIR/.next-old" 2>&1',
    ].join(NL);
    let code = 0;
    let out: string;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { code, out };
  }

  it("leaves the box with a build when the other reclaimer wins the race", () => {
    // The state both reclaimers fire on: a rebuild was killed, so `.next` has
    // no entry and `.next-old` holds the box's only build.
    writeBuild(path.join(projectDir, ".next-old"), "the-only-build");
    fs.mkdirSync(path.join(projectDir, ".next"), { recursive: true });

    const r = runInterleaved();

    expect(fs.readFileSync(path.join(projectDir, "wedged.log"), "utf-8"), "the interleave must have fired")
      .toBe("other");
    expect(
      buildIdAt(path.join(projectDir, ".next")),
      "the box was left with NEITHER tree — the outcome the park exists to prevent",
    ).toBe("the-only-build");
    expect(fs.existsSync(path.join(projectDir, ".next", "standalone", "server.js"))).toBe(true);
    expect(r.code).toBe(0);
  });

  it("destroys nothing at all when it loses the claim", () => {
    // The loser's whole contract: it may return empty-handed, it may not take
    // the winner's build with it.
    writeBuild(path.join(projectDir, ".next-old"), "the-only-build");
    fs.mkdirSync(path.join(projectDir, ".next"), { recursive: true });

    runInterleaved();

    // Exactly one live build on disk, and no stray claim or discard left over.
    const strays = fs
      .readdirSync(projectDir)
      .filter((e) => e.startsWith(".next-claim") || e.startsWith(".next-discard"));
    expect(strays).toEqual([]);
  });

  /** The shipped reclaim, with nothing wedged into it. */
  function runReclaimAlone() {
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR="${projectDir}"`,
      `sed -n '/^build_entry_present() {/,/^}/p' "$1" > "${projectDir}/fns.sh"`,
      `sed -n '/^drain_build_transients() {/,/^}/p' "$1" >> "${projectDir}/fns.sh"`,
      `sed -n '/^promote_parked_build() {/,/^}/p' "$1" >> "${projectDir}/fns.sh"`,
      `. "${projectDir}/fns.sh"`,
      'promote_parked_build "$PROJECT_DIR/.next" "$PROJECT_DIR/.next-old" 2>&1',
    ].join(NL);
    return execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("finishes a claim a kill interrupted, instead of leaving the build hidden", () => {
    // The cost of claiming under a private name: a SIGKILL between the claim
    // and the placement leaves the box's only build under a name nothing else
    // looks at. The next reclaim has to fold it back.
    writeBuild(path.join(projectDir, ".next-claim.999999"), "the-interrupted-build");

    const script = [
      "set -euo pipefail",
      `PROJECT_DIR="${projectDir}"`,
      `sed -n '/^build_entry_present() {/,/^}/p' "$1" > "${projectDir}/fns.sh"`,
      `sed -n '/^drain_build_transients() {/,/^}/p' "$1" >> "${projectDir}/fns.sh"`,
      `sed -n '/^promote_parked_build() {/,/^}/p' "$1" >> "${projectDir}/fns.sh"`,
      `. "${projectDir}/fns.sh"`,
      'promote_parked_build "$PROJECT_DIR/.next" "$PROJECT_DIR/.next-old" 2>&1',
    ].join(NL);
    execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(buildIdAt(path.join(projectDir, ".next"))).toBe("the-interrupted-build");
    expect(fs.existsSync(path.join(projectDir, ".next-claim.999999"))).toBe(false);
  });

  it("adopts a build stranded under a discard name by a kill", () => {
    // The cost of moving `.next` aside instead of deleting it: a process killed
    // between the move-aside and the placement can leave the box's ONLY build
    // under `.next-discard.<pid>`, which nothing used to read. Same brick,
    // new name.
    writeBuild(path.join(projectDir, ".next-discard.999998"), "the-stranded-build");

    runReclaimAlone();

    expect(buildIdAt(path.join(projectDir, ".next"))).toBe("the-stranded-build");
    expect(fs.existsSync(path.join(projectDir, ".next-discard.999998"))).toBe(false);
  });

  it("throws away a discard that holds no build, rather than hoarding it", () => {
    // A discard is entry-less by construction — it is the `.next` both
    // reclaimers only ever touch when it HAS no entry — so an orphaned one is
    // junk. Left on disk it is traced into every later standalone build and
    // eats the `avail < need*2` headroom that decides whether the next park
    // keeps a fallback at all.
    fs.mkdirSync(path.join(projectDir, ".next-discard.999997", "standalone"), { recursive: true });
    writeBuild(path.join(projectDir, ".next-old"), "the-only-build");

    runReclaimAlone();

    expect(fs.existsSync(path.join(projectDir, ".next-discard.999997"))).toBe(false);
    expect(buildIdAt(path.join(projectDir, ".next"))).toBe("the-only-build");
  });

  it("is not latched by a stray claim beside an existing parked build", () => {
    // With a SHARED claim destination this state was stable and fatal: the
    // fold-back failed ENOTEMPTY, the claim failed ENOTEMPTY, and both
    // reclaimers were disabled for ever — precisely in the window where they
    // are needed. Private destinations make it unrepresentable.
    writeBuild(path.join(projectDir, ".next-claim.999996"), "a-stray-older-build");
    writeBuild(path.join(projectDir, ".next-old"), "the-only-current-build");

    runReclaimAlone();

    expect(
      buildIdAt(path.join(projectDir, ".next")),
      "the reclaim must still place the current build",
    ).toBe("the-only-current-build");
  });

  it("claims before it destroys, in the text as well as in the behaviour", () => {
    // The property in one line, so a refactor that keeps the tests green by
    // accident cannot lose it: nothing destructive may precede the claim.
    const start = INSTALL_SH.indexOf("promote_parked_build() {");
    const body = INSTALL_SH.slice(start, INSTALL_SH.indexOf(`${NL}}`, start));
    const claim = body.indexOf('mv -T "$kept_dir" "$claim_dir"');
    const destroy = body.search(/\brm -rf "\$build_dir"|\bmv -T "\$build_dir"/);
    expect(claim, "the parked tree must be claimed with a rename").toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(claim);
  });
});

describe("production-server.js's reclaim cannot destroy a build install.sh restored", () => {
  const START = "// A build parked by an update that was killed OUTRIGHT";
  const END = 'require("./.next/standalone/server.js");';

  function reclaimBlock(): string {
    const from = SERVER_JS.indexOf(START);
    const to = SERVER_JS.indexOf(END);
    if (from < 0) throw new Error("the parked-build reclaim block is gone from production-server.js");
    return SERVER_JS.slice(from, to).trim();
  }

  /**
   * The same wedge, on the Node side: the first `renameSync` or `rmSync` the
   * block performs runs install.sh's old sequence first.
   */
  function runInterleaved(dir: string) {
    const warnings: string[] = [];
    let wedged = false;
    const wedge = () => {
      if (wedged) return;
      wedged = true;
      fs.rmSync(path.join(dir, ".next"), { recursive: true, force: true });
      try {
        fs.renameSync(path.join(dir, ".next-old"), path.join(dir, ".next"));
      } catch { /* the other reclaimer's own best-effort catch */ }
    };
    const patched = {
      ...fs,
      renameSync: (from: string, to: string) => { wedge(); return fs.renameSync(from, to); },
      rmSync: (target: string, opts?: object) => { wedge(); return fs.rmSync(target, opts as never); },
    };
    try {
      new Function("fs", "path", "__dirname", "console", reclaimBlock())(
        patched,
        path,
        dir,
        { warn: (...args: unknown[]) => warnings.push(args.join(" ")) },
      );
    } catch (err) {
      return { warnings, threw: err, wedged };
    }
    return { warnings, threw: null as unknown, wedged };
  }

  it("leaves the box with a build when the other reclaimer wins the race", () => {
    writeBuild(path.join(projectDir, ".next-old"), "the-only-build");
    fs.mkdirSync(path.join(projectDir, ".next"), { recursive: true });

    const r = runInterleaved(projectDir);

    expect(r.wedged, "the interleave must have fired").toBe(true);
    expect(
      buildIdAt(path.join(projectDir, ".next")),
      "the box was left with NEITHER tree — the outcome the park exists to prevent",
    ).toBe("the-only-build");
    expect(r.threw).toBeNull();
  });

  it("folds an interrupted claim back and places it", () => {
    writeBuild(path.join(projectDir, ".next-claim.999999"), "the-interrupted-build");

    const warnings: string[] = [];
    new Function("fs", "path", "__dirname", "console", reclaimBlock())(
      fs,
      path,
      projectDir,
      { warn: (...args: unknown[]) => warnings.push(args.join(" ")) },
    );

    expect(buildIdAt(path.join(projectDir, ".next"))).toBe("the-interrupted-build");
    expect(fs.existsSync(path.join(projectDir, ".next-claim.999999"))).toBe(false);
  });

  it("claims before it destroys, in the text as well as in the behaviour", () => {
    const block = reclaimBlock();
    const claim = block.indexOf("renameQuiet(parkedDir, claimDir)");
    const destroy = block.search(/rmSync\(nextDir|renameQuiet\(nextDir, discardDir\)/);
    expect(claim, "the parked tree must be claimed with a rename").toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(claim);
    // And `.next` itself is never destroyed outright any more — it is moved to
    // a private name, so a mistaken judgement about it can be undone.
    expect(block).not.toMatch(/rmSync\(\s*path\.join\(__dirname, "\.next"\)/);
  });
});

describe("the transient names survive the update's own git clean", () => {
  it("both are gitignored, like .next-old", () => {
    // An update runs `git clean -fd` over this tree. A claim swept away
    // mid-flight is a box with no build — the same reason `.next-old/` has an
    // entry.
    const ignore = fs.readFileSync(path.join(REPO, ".gitignore"), "utf-8");
    expect(ignore).toMatch(/^\.next-claim\.\*\/$/m);
    expect(ignore).toMatch(/^\.next-discard\.\*\/$/m);
  });

  it("postbuild sweeps them out of the standalone output like .next-old", () => {
    // Next's instrumentation trace copies the whole project root into the
    // standalone output, which is why `.next-old*` is swept there. A transient
    // that happened to exist during a build would be copied the same way.
    const postbuild = fs.readFileSync(path.join(REPO, "scripts", "postbuild.sh"), "utf-8");
    expect(postbuild).toMatch(/\.next-claim\.\*/);
    expect(postbuild).toMatch(/\.next-discard\.\*/);
  });
});
