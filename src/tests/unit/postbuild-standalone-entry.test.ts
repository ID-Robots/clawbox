import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-725 — the postbuild step must stamp the build `next build` just wrote,
 * and must fail when it cannot.
 *
 * During an in-app update the project root holds two builds: the new one under
 * `.next`, and the previous one parked at `.next-old` by
 * `set_previous_build_aside` so an OOM-killed rebuild cannot leave the box with
 * no build at all. Next's file tracing copies the parked one INTO the new
 * standalone tree — `src/instrumentation-node.ts` resolves
 * `path.join(CONFIG_ROOT, 'scripts', 'terminal-server.mjs')` and CONFIG_ROOT
 * comes from the environment, so @vercel/nft cannot resolve it and emits the
 * whole project directory as an asset directory. Reproduced on Next 16.3.3:
 * with a build parked beside it, `.next/server/instrumentation.js.nft.json`
 * lists 6186 files, 4202 of them `../../.next-old/**`.
 *
 * So `.next/standalone` contains a SECOND `server.js`, three levels down at
 * `.next/standalone/.next-old/standalone/server.js`, and the old lookup —
 * `find … -maxdepth 3 -name node_modules -prune -o -name server.js -print -quit`
 * — took whichever readdir handed back first. In e2e-install runs 33971129750,
 * 33974951149 and 33977666658 (2026-09-05) that was the parked one:
 *
 *     cp: cannot create directory '.next/standalone/.next-old/standalone/.next/static': No such file or directory
 *     cp: cannot create regular file '.next/standalone/.next-old/standalone/.next/build-info.json': No such file or directory
 *     cp: cannot create directory '.next/standalone/.next-old/standalone/node_modules/playwright': No such file or directory
 *     cp: cannot create directory '.next/standalone/.next-old/standalone/node_modules/playwright-core': No such file or directory
 *     BUILD IDENTITY: FAIL — .next/standalone/.next holds a deployed build but no build-info.json — the postbuild step did not copy the stamp
 *
 * Four failed copies, exit 0, and the step's last clause then replaced the real
 * `.next/standalone/server.js` with a symlink to the PARKED entry — the update
 * would have come back on the build it was replacing. Only
 * `verify-build-identity.sh` noticed, two lines later, and the rebuild was
 * rolled back.
 *
 * These run the REAL postbuild step out of package.json against a temp tree, so
 * they cannot drift from what ships.
 */

// Starts a real process (bash / node): vitest's 5 s test and 10 s hook defaults
// are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const POSTBUILD: string = JSON.parse(
  fs.readFileSync(path.join(REPO, "package.json"), "utf-8"),
).scripts.postbuild;

// The real `find`, resolved before the stub below can shadow it: the stub
// answers the entry lookup only and hands every other call to this one.
//
// It has to be an ABSOLUTE path, and that is a hard condition rather than a
// tidiness rule: `command -v` prints a BARE NAME for a shell function or alias,
// and the stub is first on PATH, so `exec find "$@"` on a bare name re-enters
// the stub forever. That loop sits inside `spawnSync`, which blocks the worker
// synchronously — `testTimeout` cannot interrupt it, so the symptom would be a
// hung CI job rather than a failing test. A `sh` that reads `$ENV`/`BASH_ENV`
// is the way in; skipping the suite is the safe answer.
const REAL_FIND = (
  spawnSync("sh", ["-c", "command -v find"], { encoding: "utf-8" }).stdout ?? ""
).trim();

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("sh", ["-c", "true"], { stdio: "ignore" }).status === 0
  && REAL_FIND.startsWith("/");
const d = CAN_RUN ? describe : describe.skip;

let tmp: string;
let standalone: string;
let stubBin: string;

const PARKED_ENTRY = path.join(".next", "standalone", ".next-old", "standalone", "server.js");

/** The project tree `next build` leaves behind, before postbuild runs. */
function buildFixture() {
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  // Whatever package.json's postbuild actually invokes has to be in the
  // fixture: write-build-info.mjs on every head, and the step's own script
  // where it is one. Copied, not linked, so the fixture is self-contained.
  for (const script of ["write-build-info.mjs", "postbuild.sh"]) {
    const src = path.join(REPO, "scripts", script);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(tmp, "scripts", script);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "0.0.0-test" }));

  fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "public", "marker.txt"), "public asset\n");
  fs.mkdirSync(path.join(tmp, ".next", "static"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".next", "static", "chunk.js"), "// chunk\n");
  fs.writeFileSync(path.join(tmp, ".next", "BUILD_ID"), "new-build-id\n");

  standalone = path.join(tmp, ".next", "standalone");
  fs.mkdirSync(path.join(standalone, ".next"), { recursive: true });
  fs.writeFileSync(path.join(standalone, ".next", "BUILD_ID"), "new-build-id\n");
  fs.writeFileSync(path.join(standalone, "server.js"), "// standalone server\n");

  // `find -maxdepth 3 -name server.js` reaches package-root server.js files
  // under node_modules (next/ and react-dom/ both have one), which is what the
  // `-name node_modules -prune` in the lookup has always been for.
  for (const pkg of ["next", "react-dom"]) {
    fs.mkdirSync(path.join(standalone, "node_modules", pkg), { recursive: true });
    fs.writeFileSync(path.join(standalone, "node_modules", pkg, "server.js"), "// decoy\n");
  }
}

/**
 * The parked previous build, as the trace copies it in.
 *
 * Deliberately without a `.next` beside the nested entry: that is the shape the
 * three CI runs had, and it is why all four copies failed there with
 * "No such file or directory" instead of silently landing in the wrong tree.
 */
function sweepParkedBuildIn() {
  const parked = path.join(tmp, PARKED_ENTRY);
  fs.mkdirSync(path.dirname(parked), { recursive: true });
  fs.writeFileSync(parked, "// the PREVIOUS build's entry\n");
}

/**
 * A `find` that hands back the parked copy first.
 *
 * readdir order is a property of the filesystem, not of the fixture, so
 * staging two candidates and hoping proves nothing on someone else's disk.
 * This stub pins the one order that matters — the one three CI runs actually
 * got — and the step is asked what it does with it. A lookup that consults
 * `find` at all is handed the parked entry; a lookup that takes the entry
 * `next build` wrote never runs it.
 *
 * It answers the ENTRY lookup only — the one call that names `server.js`. The
 * step's other `find` sweeps the whole tree for copied `.env`/`.git` files
 * (TASK-692) and gets the real one: entry SELECTION does not need `find`, that
 * sweep does, and a stub that answered both would fail the build over a
 * leftover this fixture never planted.
 *
 * That narrows the negative control, deliberately and with a limit worth
 * knowing: a lookup reintroduced in a DIFFERENT shape — matching `server*.js`,
 * or a `-path`/`-regex` form that never passes the bare word — would fall
 * through to the real `find`, which prunes `.next-old*` here and hands back the
 * right entry, so both cases would pass while the regression was live. The
 * shape this pins is the one the defect had (TASK-725: `find … -name
 * node_modules -prune -o -name server.js -print -quit`), which carries it.
 */
function stubFindReturning(rel: string) {
  fs.mkdirSync(stubBin, { recursive: true });
  const stub = path.join(stubBin, "find");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = server.js ]; then
    printf '%s\\n' ${JSON.stringify(rel)}
    exit 0
  fi
done
exec ${JSON.stringify(REAL_FIND)} "$@"
`,
  );
  fs.chmodSync(stub, 0o755);
}

function runPostbuild(env: Record<string, string> = {}) {
  return spawnSync("sh", ["-c", POSTBUILD], {
    cwd: tmp,
    encoding: "utf-8",
    // write-build-info.mjs resolves its project dir from CLAWBOX_ROOT first,
    // and the suite sets that globally to a shared temp path — point it at the
    // fixture so the stamp lands where the postbuild step looks for it.
    env: { ...process.env, CLAWBOX_ROOT: tmp, PATH: `${stubBin}:${process.env.PATH ?? ""}`, ...env },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-postbuild-entry-"));
  stubBin = path.join(tmp, "stub-bin");
  fs.mkdirSync(stubBin, { recursive: true });
  buildFixture();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("postbuild entry selection", () => {
  it("stamps the entry next build wrote, not the parked build the lookup offers first", () => {
    sweepParkedBuildIn();
    stubFindReturning(PARKED_ENTRY);

    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);

    // The stamp and the assets, in the tree the service actually loads. This is
    // the exact post-condition scripts/verify-build-identity.sh checks, and the
    // one the three CI runs failed.
    expect(fs.existsSync(path.join(standalone, ".next", "build-info.json"))).toBe(true);
    expect(fs.existsSync(path.join(standalone, ".next", "static", "chunk.js"))).toBe(true);
    expect(fs.existsSync(path.join(standalone, "public", "marker.txt"))).toBe(true);

    // And the entry is still the file, not a symlink into the parked copy.
    expect(fs.lstatSync(path.join(standalone, "server.js")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(standalone, "server.js"), "utf-8"))
      .toContain("standalone server");
  });

  it("takes the entry from the path Next recorded for it", () => {
    // `relativeAppDir` in .next/required-server-files.json is
    // path.relative(outputFileTracingRoot, dir) — the same segment
    // copyTracedFiles joins under .next/standalone. Nesting the tree and
    // stating it in the manifest is the whole of Next's contract here, so the
    // parked decoy and a `find` that offers it first must change nothing.
    fs.rmSync(path.join(standalone, "server.js"));
    const nested = path.join(standalone, "app");
    fs.mkdirSync(path.join(nested, ".next"), { recursive: true });
    fs.writeFileSync(path.join(nested, "server.js"), "// nested standalone server\n");
    fs.writeFileSync(
      path.join(tmp, ".next", "required-server-files.json"),
      JSON.stringify({ version: 1, relativeAppDir: "app" }),
    );
    sweepParkedBuildIn();
    stubFindReturning(PARKED_ENTRY);

    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(nested, ".next", "build-info.json"))).toBe(true);
    expect(fs.realpathSync(path.join(standalone, "server.js")))
      .toBe(fs.realpathSync(path.join(nested, "server.js")));
  });

  it("stamps the build it is building, whatever CLAWBOX_ROOT says", () => {
    // write-build-info.mjs resolves its project dir from CLAWBOX_ROOT and this
    // step copies `.next/build-info.json` out of the build directory. A shell
    // that exports CLAWBOX_ROOT at some other path — a dev box, a test runner —
    // used to send the stamp somewhere else and leave the copy to print a
    // warning; under `set -e` that would be a build that cannot complete, and
    // playwright.config.ts's webServer starts with `bun run build`.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-elsewhere-"));
    try {
      const res = runPostbuild({ CLAWBOX_ROOT: elsewhere });
      expect(res.status, res.stderr).toBe(0);
      expect(fs.existsSync(path.join(standalone, ".next", "build-info.json"))).toBe(true);
      expect(fs.existsSync(path.join(elsewhere, ".next"))).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("removes a parked build that the file trace swept into the standalone output", () => {
    sweepParkedBuildIn();

    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    // A second complete build inside the one that ships: hundreds of MB on an
    // eMMC, and a second server.js for anything that goes looking.
    expect(fs.existsSync(path.join(standalone, ".next-old"))).toBe(false);
    // The real parked tree is `$PROJECT_DIR/.next-old` and is none of this
    // step's business — only the copy inside the standalone output is.
    expect(fs.existsSync(path.join(standalone, ".next", "build-info.json"))).toBe(true);
  });

  it("fails the build when a copy into the standalone tree fails", () => {
    // The failure the three runs had, reduced to one copy: a source that is not
    // there. Four of these failed in run 33971129750 and the step still exited
    // 0, so the only thing that noticed was verify-build-identity.sh.
    fs.rmSync(path.join(tmp, "public"), { recursive: true });

    const res = runPostbuild();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("public");
  });

  it("fails the build when there is no standalone entry to assemble around", () => {
    // `next build` exiting 0 with no standalone entry is a real outcome (an
    // OOM-killed write, a half-run trace copy). The step used to exit 0 having
    // copied nothing, which is what let install.sh's do_rebuild call such a
    // build successful until verify_build_present was added.
    fs.rmSync(path.join(standalone, "server.js"));

    const res = runPostbuild();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("server.js");
  });

  it("takes the nested entry, never one inside a parked tree, in the nested layout", () => {
    // Next nests the standalone tree under <standalone>/<path from the tracing
    // root to the app> when outputFileTracingRoot is a parent directory. The
    // search is what supports that shape; with a parked build swept in beside
    // it, the pruned search has exactly one candidate whatever readdir does.
    fs.rmSync(path.join(standalone, "server.js"));
    const nested = path.join(standalone, "app");
    fs.mkdirSync(path.join(nested, ".next"), { recursive: true });
    fs.writeFileSync(path.join(nested, "server.js"), "// nested standalone server\n");
    sweepParkedBuildIn();

    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(nested, ".next", "build-info.json"))).toBe(true);
    expect(fs.lstatSync(path.join(standalone, "server.js")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(standalone, "server.js")))
      .toBe(fs.realpathSync(path.join(nested, "server.js")));
  });
});
