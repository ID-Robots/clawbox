import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every box ends up on the llama.cpp build install.sh pins (TASK-2166).
 *
 * The install step used to rebuild llama-server only when it was missing or
 * CPU-only, so a box that already had one kept it through every move of the
 * pin, and an in-app update never asked at all. A field box was still on a May
 * build that rejects `--embd-normalize`, and its memory embedder could not
 * start. These drive the shell functions themselves — the decision, the
 * build tree, the swap and its rollback — against fake binaries.
 *
 * The fakes stand in for the real layout: a 15 KB llama-server whose RUNPATH
 * names the build tree it came from. Each fake "loads its library" by sourcing
 * `<tree>/bin/libllama.sh` from a path baked in at creation (LD_LIBRARY_PATH
 * first, as the dynamic loader does with a RUNPATH), so moving or deleting the
 * tree breaks the binary exactly the way it breaks the real one.
 */

// Starts real bash processes: vitest's 5 s default is not enough on a loaded
// CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const INSTALL_SH = path.join(process.cwd(), "install.sh");
const SRC = fs.readFileSync(INSTALL_SH, "utf8");
// The llama.cpp install.sh pins ("is the pin install.sh builds" keeps them in step).
const PIN = "5f490d7bfe78844e6390c869454c149fd7e003a8";
const PIN_SHORT = PIN.slice(0, 9);
// The pin before it, on every box until its next update.
const PREV_PIN = "db7d8b24b5197ca39435cf47b3c1ba039b53605b";
// What a build of the previous pin prints: the older --version form.
const PREV_FORM = "version: 10214 (db7d8b24b)";
const OLD = "f08f20a";
// llama.cpp's newer --version line (upstream common/build-info.cpp.in from
// 680a9ae on; 29c720e and 5f490d7 both print it): the semver, build number and
// hash length all vary by build.
const NEW_FORM = "version: 0.9.0-dev (build 12233, commit 5f490d7bf)";
// What a --depth 1 build of that commit printed on an Orin Nano.
const CAPTURED_FORM = "version: 0.9.0-dev (build 1, commit 5f490d7)";

const FUNCTIONS = [
  "llamacpp_binary_commit",
  "llamacpp_commit_matches",
  "llamacpp_server_libraries",
  "llamacpp_rebuild_reason",
  "llamacpp_build_jobs",
  "build_llamacpp_from_source",
  "activate_llamacpp_server",
  "prune_llamacpp_build_trees",
  "install_prebuilt_llamacpp",
  "llamacpp_runtime_locked",
  "step_llamacpp_runtime",
];

function shellFunction(name: string): string {
  const start = SRC.indexOf(`\n${name}() {\n`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = SRC.indexOf("\n}\n", start + 1);
  return SRC.slice(start + 1, end + 2);
}

let tmp: string;
let liveBin: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-runtime-"));
  fs.mkdirSync(path.join(tmp, "usr-local-bin"));
  liveBin = path.join(tmp, "usr-local-bin", "llama-server");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * A build tree: `<tree>/bin/llama-server` plus the "library" it loads, which
 * says which commit it is. `version` overrides the whole --version line, which
 * goes to stderr as the real binary's does, so the probe's `2>&1` is tested.
 */
function makeTree(tree: string, commit: string, version?: string): string {
  const bin = path.join(tree, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const line = version ?? `version: 4242 (${commit})`;
  fs.writeFileSync(path.join(bin, "libllama.sh"), `LINE='${line}'\n`);
  fs.writeFileSync(path.join(bin, "libggml-cuda.so.0"), "x");
  fs.writeFileSync(
    path.join(bin, "llama-server"),
    `#!/bin/bash
. "\${LD_LIBRARY_PATH:-${bin}}/libllama.sh" 2>/dev/null || { echo "llama-server: error while loading shared libraries: libllama.so: cannot open shared object file" >&2; exit 127; }
if [ -n "\${FAIL_WHEN_INSTALLED:-}" ] && [ "$0" = "\${FAIL_WHEN_INSTALLED}" ]; then echo "Illegal instruction" >&2; exit 132; fi
[ "\${1:-}" = "--version" ] && { echo "$LINE"; echo "built with GNU 11.4.0 for Linux aarch64"; } >&2
exit 0
`,
    { mode: 0o755 },
  );
  return path.join(bin, "llama-server");
}

/** The old binary as the box has it: a copy in /usr/local/bin, loading from its tree. */
function installLive(tree: string, commit: string, version?: string): void {
  fs.copyFileSync(makeTree(tree, commit, version), liveBin);
  fs.chmodSync(liveBin, 0o755);
}

function liveVersion(): string {
  const r = spawnSync(liveBin, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stderr.split("\n")[0] : "does not start";
}

/**
 * Run `body` with the install.sh functions under test defined and the box
 * around them stubbed. `ldd` prints LDD_OUT; every systemctl call is recorded.
 */
function run(body: string, env: Record<string, string> = {}): { code: number; out: string } {
  const script = `
set -u
CLAWBOX_USER="$(id -un)"
PROJECT_DIR="${tmp}/clawbox"
LLAMACPP_SERVER_BIN="${liveBin}"
LLAMACPP_REPO_URL="https://github.com/ggml-org/llama.cpp.git"
LLAMACPP_BUILD_LOCK="${tmp}/build.lock"
CLAWBOX_HOME="${tmp}"
is_test_mode() { return 1; }
as_clawbox() { "$@"; }
available_mb() { printf '%s' "\${FAKE_AVAIL_MB:-8000}"; }
nproc() { echo "\${FAKE_CORES:-6}"; }
ldd() { printf '%s\\n' "\${LDD_OUT:-}"; }
systemctl() { echo "systemctl $*" >> "${tmp}/calls"; }
${FUNCTIONS.map(shellFunction).join("\n")}
${body}
`;
  try {
    const out = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function calls(): string {
  return fs.existsSync(path.join(tmp, "calls")) ? fs.readFileSync(path.join(tmp, "calls"), "utf8") : "";
}

const CUDA_LDD = "libcudart.so.12 => /usr/local/cuda/lib64/libcudart.so.12\nlibcublas.so.12 => /usr/local/cuda/lib64/libcublas.so.12";

describe("which llama.cpp a llama-server was built from", () => {
  it("is the short hash its own --version names", () => {
    const bin = makeTree(path.join(tmp, "t"), "db7d8b24b");
    expect(run(`llamacpp_binary_commit "${bin}"`).out.trim()).toBe("db7d8b24b");
  });

  it("is nothing for a build that answers 'unknown' or does not start", () => {
    const unknown = makeTree(path.join(tmp, "u"), "", "version: 0 (unknown)");
    expect(run(`llamacpp_binary_commit "${unknown}"`).out.trim()).toBe("");
    const broken = makeTree(path.join(tmp, "b"), "db7d8b24b");
    fs.rmSync(path.join(tmp, "b", "bin", "libllama.sh"));
    expect(run(`llamacpp_binary_commit "${broken}"`).out.trim()).toBe("");
  });

  it("reads the newer form too: version: <semver> (build <N>, commit <hash>)", () => {
    const full = makeTree(path.join(tmp, "n"), "", NEW_FORM);
    expect(run(`llamacpp_binary_commit "${full}"`).out.trim()).toBe("5f490d7bf");
    const captured = makeTree(path.join(tmp, "c"), "", CAPTURED_FORM);
    expect(run(`llamacpp_binary_commit "${captured}"`).out.trim()).toBe("5f490d7");
  });

  it("is nothing for a newer-form build that cannot name its commit, or a binary that says nothing", () => {
    for (const [i, line] of [
      "version: 0.9.0-dev (build 1, commit unknown)",
      "version: 0.9.0-dev (build 1, commit 5f490dz)",
      "version: 0.9.0-dev (build 1, commit 5f490d)",
      `version: 0.9.0-dev (build 1, commit ${PIN}0)`,
      "",
    ].entries()) {
      const bin = makeTree(path.join(tmp, `x${i}`), "", line);
      expect(run(`llamacpp_binary_commit "${bin}"`).out.trim()).toBe("");
    }
  });

  it("can load a staged build's own libraries instead of the tree its RUNPATH names", () => {
    const staged = makeTree(path.join(tmp, "staged"), "db7d8b24b");
    fs.rmSync(path.join(tmp, "staged", "bin", "libllama.sh"));
    makeTree(path.join(tmp, "other"), "db7d8b24b");
    expect(run(`llamacpp_binary_commit "${staged}" "${path.join(tmp, "other", "bin")}"`).out.trim()).toBe("db7d8b24b");
  });

  it("matches the pin by prefix, and never on fewer than seven characters", () => {
    const r = run(`
      llamacpp_commit_matches ${PIN_SHORT} ${PIN} && echo A
      llamacpp_commit_matches ${PIN.slice(0, 7)} ${PIN} && echo B
      llamacpp_commit_matches ${OLD} ${PIN} || echo C
      llamacpp_commit_matches ${PIN.slice(0, 6)} ${PIN} || echo D
      llamacpp_commit_matches "" ${PIN} || echo E
      llamacpp_commit_matches ${PIN_SHORT} "" || echo F`);
    expect(r.out.split("\n").filter(Boolean)).toEqual(["A", "B", "C", "D", "E", "F"]);
  });
});

describe("when llama-server has to be rebuilt", () => {
  it("rebuilds the customer's box: an older build that still runs, with CUDA", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    const r = run(`llamacpp_rebuild_reason "${liveBin}" ON ${PIN}`, { LDD_OUT: CUDA_LDD });
    expect(r.out).toContain(`llama.cpp ${OLD}`);
    expect(r.out).toContain(PIN_SHORT);
  });

  it("rebuilds every box on the previous pin, which names itself in the older form", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), "", PREV_FORM);
    expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PIN}`, { LDD_OUT: CUDA_LDD }).out.trim())
      .toBe(`the installed llama-server is llama.cpp db7d8b24b, and this release pins ${PIN_SHORT}`);
  });

  it("leaves an older-form CUDA build of its pin alone", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), "", PREV_FORM);
    expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PREV_PIN}`, { LDD_OUT: CUDA_LDD }).out.trim()).toBe("");
  });

  it("leaves a newer-form CUDA build of the pin alone, whatever its build number or hash length", () => {
    for (const line of [NEW_FORM, CAPTURED_FORM]) {
      installLive(path.join(tmp, "llama.cpp", "build"), "", line);
      expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PIN}`, { LDD_OUT: CUDA_LDD }).out.trim()).toBe("");
    }
    // Off the pin it is named by its commit, not taken for a binary that does not start.
    expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PREV_PIN}`, { LDD_OUT: CUDA_LDD }).out.trim())
      .toBe("the installed llama-server is llama.cpp 5f490d7, and this release pins db7d8b24b");
  });

  it("rebuilds when it is missing, does not start, or lost CUDA — as before", () => {
    expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PIN}`).out).toMatch(/missing/);

    installLive(path.join(tmp, "llama.cpp", "build"), "", NEW_FORM);
    expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PIN}`, { LDD_OUT: "libc.so.6 => /lib/libc.so.6" }).out)
      .toMatch(/without CUDA/);
    // A CPU box asks for no CUDA.
    expect(run(`llamacpp_rebuild_reason "${liveBin}" OFF ${PIN}`, { LDD_OUT: "libc.so.6 => /lib/libc.so.6" }).out.trim())
      .toBe("");

    fs.rmSync(path.join(tmp, "llama.cpp", "build"), { recursive: true });
    expect(run(`llamacpp_rebuild_reason "${liveBin}" ON ${PIN}`, { LDD_OUT: CUDA_LDD }).out).toMatch(/does not start/);
  });
});

describe("how many compile jobs the build gets", () => {
  it("one per GiB available, capped by the cores, never below one", () => {
    expect(run("llamacpp_build_jobs", { FAKE_AVAIL_MB: "4271" }).out.trim()).toBe("4");
    expect(run("llamacpp_build_jobs", { FAKE_AVAIL_MB: "9000" }).out.trim()).toBe("6");
    expect(run("llamacpp_build_jobs", { FAKE_AVAIL_MB: "600" }).out.trim()).toBe("1");
  });

  it("keeps the cores when memory cannot be read, and takes an explicit override", () => {
    expect(run("llamacpp_build_jobs", { FAKE_AVAIL_MB: "0" }).out.trim()).toBe("6");
    expect(run("llamacpp_build_jobs", { FAKE_AVAIL_MB: "4271", LLAMACPP_BUILD_JOBS: "2" }).out.trim()).toBe("2");
  });
});

describe("the source build goes into a tree of its own", () => {
  /** Stub git/cmake: record each command, and "build" when cmake --build runs. */
  function stubbedBuild(head: string, cuda = "ON") {
    return run(`
      as_clawbox_login() {
        echo "LOGIN $*" >> "${tmp}/calls"
        case "$*" in
          *"cmake --build "*) tree=$(sed -E 's/.*cmake --build ([^ ]+).*/\\1/' <<<"$*"); mkdir -p "$tree/bin"; printf '#!/bin/sh\\n' > "$tree/bin/llama-server"; chmod +x "$tree/bin/llama-server" ;;
        esac
      }
      as_clawbox() { if [ "$1" = git ]; then echo "${head}"; else "$@"; fi; }
      mkdir -p "${tmp}/llama.cpp/.git" "${tmp}/llama.cpp/build/bin"
      echo live > "${tmp}/llama.cpp/build/bin/libllama.so"
      build_llamacpp_from_source "${tmp}/llama.cpp" ${PIN} ${cuda} && echo "BUILT=$LLAMACPP_BUILT_SERVER TREE=$LLAMACPP_ACTIVE_TREE"
    `);
  }

  it("fetches the pinned commit by URL, checks it out, and builds beside the live tree", () => {
    const r = stubbedBuild(PIN);
    expect(r.code).toBe(0);
    const tree = path.join(tmp, "llama.cpp", `build-${PIN.slice(0, 12)}-cuda`);
    expect(r.out).toContain(`BUILT=${tree}/bin/llama-server TREE=${tree}`);
    const log = calls();
    expect(log).toContain(`git fetch --quiet https://github.com/ggml-org/llama.cpp.git ${PIN}`);
    expect(log).toContain(`checkout --quiet --force --detach ${PIN}`);
    expect(log).toContain(`-B ${tree} -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=87`);
    // The installed binary's libraries are never rebuilt under it.
    expect(log).not.toMatch(/-B build\b|--build build\b|\/build\/CMakeCache/);
    expect(fs.readFileSync(path.join(tmp, "llama.cpp", "build", "bin", "libllama.so"), "utf8")).toBe("live\n");
  });

  it("names the tree after the backend too: a CPU build of the pin gaining CUDA is a new tree", () => {
    const r = stubbedBuild(PIN, "OFF");
    expect(r.code).toBe(0);
    const tree = path.join(tmp, "llama.cpp", `build-${PIN.slice(0, 12)}-cpu`);
    expect(r.out).toContain(`TREE=${tree}`);
    expect(calls()).toContain(`-B ${tree} -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF\n`);
  });

  it("refuses to build anything but the pin — no 'whatever is checked out'", () => {
    const r = stubbedBuild(`${OLD}0e330da9530ded3e800dff9fbb05a3288`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`not ${PIN}.`);
    expect(calls()).not.toMatch(/cmake/);
  });
});

describe("the swap", () => {
  it("puts the new build in place atomically and leaves nothing beside it", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    const fresh = makeTree(path.join(tmp, "llama.cpp", "build-new"), "db7d8b24b");
    const r = run(`activate_llamacpp_server "${fresh}" ${PREV_PIN}`);
    expect(r.code).toBe(0);
    expect(liveVersion()).toBe("version: 4242 (db7d8b24b)");
    expect(fs.readdirSync(path.dirname(liveBin))).toEqual(["llama-server"]);
  });

  it("moves a box off the previous pin to a build of this one, which prints the newer form", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), "", PREV_FORM);
    const fresh = makeTree(path.join(tmp, "llama.cpp", "build-new"), "", NEW_FORM);
    const r = run(`activate_llamacpp_server "${fresh}" ${PIN}`);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`llama-server is now llama.cpp ${PIN_SHORT} (pinned ${PIN_SHORT}).`);
    expect(liveVersion()).toBe(NEW_FORM);
    expect(fs.readdirSync(path.dirname(liveBin))).toEqual(["llama-server"]);
  });

  it("keeps the installed one when the new build is not the pin", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    const wrong = makeTree(path.join(tmp, "llama.cpp", "build-new"), "a1b2c3d4e");
    const r = run(`activate_llamacpp_server "${wrong}" ${PIN}`);
    expect(r.code).not.toBe(0);
    expect(liveVersion()).toBe(`version: 4242 (${OLD})`);
  });

  it("puts the previous binary back when the INSTALLED copy does not start", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    const fresh = makeTree(path.join(tmp, "llama.cpp", "build-new"), "", NEW_FORM);
    const r = run(`activate_llamacpp_server "${fresh}" ${PIN}`, { FAIL_WHEN_INSTALLED: liveBin });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/putting the previous one back/);
    expect(liveVersion()).toBe(`version: 4242 (${OLD})`);
    expect(fs.readdirSync(path.dirname(liveBin))).toEqual(["llama-server"]);
  });

  it("prunes the trees nothing loads any more — only once ldd shows the kept one in use", () => {
    const llama = path.join(tmp, "llama.cpp");
    const keep = path.join(llama, "build-db7d8b24b519");
    for (const t of ["build", "build-f08f20a0e330", "build.clawbox-prev", "build-db7d8b24b519"]) makeTree(path.join(llama, t), "x");
    fs.mkdirSync(path.join(llama, "common"));

    let r = run(`prune_llamacpp_build_trees "${llama}" "${keep}"`, { LDD_OUT: `libllama.so => ${path.join(llama, "build")}/bin/libllama.so` });
    expect(r.out).toMatch(/Kept the previous/);
    expect(fs.readdirSync(llama).sort()).toEqual(["build", "build-db7d8b24b519", "build-f08f20a0e330", "build.clawbox-prev", "common"]);

    r = run(`prune_llamacpp_build_trees "${llama}" "${keep}"`, { LDD_OUT: `libllama.so => ${keep}/bin/libllama.so` });
    expect(r.code).toBe(0);
    expect(fs.readdirSync(llama).sort()).toEqual(["build-db7d8b24b519", "common"]);
  });
});

describe("a prebuilt archive is staged beside the live tree, never over it", () => {
  /** A prebuilt as a build host makes it: build/bin, RUNPATH = <llama>/build/bin. */
  function archive(commit: string, version = `version: 9 (${commit})`): string {
    const llama = path.join(tmp, "llama.cpp");
    const stage = path.join(tmp, "host");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "libllama.sh"), `LINE='${version}'\n`);
    fs.writeFileSync(path.join(stage, "libggml-cuda.so.0"), "x");
    fs.writeFileSync(
      path.join(stage, "llama-server"),
      `#!/bin/bash
. "\${LD_LIBRARY_PATH:-${llama}/build/bin}/libllama.sh" 2>/dev/null || exit 127
[ "\${1:-}" = "--version" ] && echo "$LINE" >&2
exit 0
`,
      { mode: 0o755 },
    );
    const out = path.join(tmp, `${commit}.tar.gz`);
    execFileSync("tar", ["--force-local", "-czf", out, "-C", stage, "."]);
    return out;
  }

  const AARCH64 = 'file() { echo "ELF 64-bit LSB pie executable, ARM aarch64"; }';

  it("swaps in a pinned prebuilt, keeping the old tree only until the new binary starts", () => {
    const llama = path.join(tmp, "llama.cpp");
    installLive(path.join(llama, "build"), OLD);
    const r = run(`${AARCH64}
      install_prebuilt_llamacpp "${archive("db7d8b24b")}" ON "${llama}" ${PREV_PIN} && echo "TREE=$LLAMACPP_ACTIVE_TREE"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`TREE=${llama}/build`);
    expect(liveVersion()).toBe("version: 9 (db7d8b24b)");
    expect(fs.readdirSync(llama)).toEqual(["build"]);
  });

  it("installs one on a fresh box, with no checkout and no llama-server yet", () => {
    const llama = path.join(tmp, "llama.cpp");
    const r = run(`${AARCH64}
      install_prebuilt_llamacpp "${archive("db7d8b24b")}" ON "${llama}" ${PREV_PIN}`);
    expect(r.code).toBe(0);
    expect(liveVersion()).toBe("version: 9 (db7d8b24b)");
    expect(fs.readdirSync(llama)).toEqual(["build"]);
  });

  it("takes a pinned prebuilt that prints the newer form", () => {
    const llama = path.join(tmp, "llama.cpp");
    installLive(path.join(llama, "build"), OLD);
    const r = run(`${AARCH64}
      install_prebuilt_llamacpp "${archive("5f490d7bf", NEW_FORM)}" ON "${llama}" ${PIN}`);
    expect(r.code).toBe(0);
    expect(liveVersion()).toBe(NEW_FORM);
    expect(fs.readdirSync(llama)).toEqual(["build"]);
  });

  it("rejects a prebuilt of another commit and leaves the box exactly as it was", () => {
    const llama = path.join(tmp, "llama.cpp");
    installLive(path.join(llama, "build"), OLD);
    const r = run(`${AARCH64}
      install_prebuilt_llamacpp "${archive("a1b2c3d4e")}" ON "${llama}" ${PIN}`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`not the pinned ${PIN_SHORT}`);
    expect(liveVersion()).toBe(`version: 4242 (${OLD})`);
    expect(fs.readdirSync(llama)).toEqual(["build"]);
  });
});

describe("the step's verdict", () => {
  /** llamacpp_runtime_locked with the install itself stubbed to $INSTALL_RESULT. */
  function step(env: Record<string, string>) {
    return run(`
      llamacpp_install_pinned() { echo "INSTALL $*" >> "${tmp}/calls"; LLAMACPP_ACTIVE_TREE="$1/build-x"; return "\${INSTALL_RESULT:-0}"; }
      prune_llamacpp_build_trees() { echo "PRUNE $*" >> "${tmp}/calls"; }
      llamacpp_runtime_locked "${tmp}/llama.cpp" ${PIN} ON`, env);
  }

  it("does nothing but probe a box already on the pin", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), "", NEW_FORM);
    const r = step({ LDD_OUT: CUDA_LDD });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`already installed (llama.cpp ${PIN_SHORT}, CUDA=ON)`);
    expect(calls()).toBe("");
  });

  it("rebuilds an off-pin box, clears a failed embedder and prunes the old tree", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    const r = step({ LDD_OUT: CUDA_LDD });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Rebuilding llama-server: the installed llama-server is llama\.cpp f08f20a/);
    expect(calls()).toContain(`INSTALL ${tmp}/llama.cpp ${PIN} ON`);
    expect(calls()).toContain("systemctl reset-failed clawbox-embed.service");
    expect(calls()).toContain(`PRUNE ${tmp}/llama.cpp ${tmp}/llama.cpp/build-x`);
  });

  it("keeps a working old binary when the rebuild fails, and says so where the updater reads it", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    const r = step({ LDD_OUT: CUDA_LDD, INSTALL_RESULT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[llamacpp-not-rebuilt\]: /m);
    expect(liveVersion()).toBe(`version: 4242 (${OLD})`);
    expect(calls()).not.toMatch(/PRUNE|reset-failed/);
  });

  it("keeps a working newer-form binary when the rebuild fails: a warning, not a failure", () => {
    const offPin = `version: 0.9.0-dev (build 12000, commit ${OLD})`;
    installLive(path.join(tmp, "llama.cpp", "build"), "", offPin);
    const r = step({ LDD_OUT: CUDA_LDD, INSTALL_RESULT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[llamacpp-not-rebuilt\]: /m);
    expect(r.out).not.toMatch(/No llama-server that starts/);
    expect(liveVersion()).toBe(offPin);
  });

  it("fails only when the box is left with no llama-server that starts", () => {
    const r = step({ INSTALL_RESULT: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/CLAWBOX-WARN/);
  });
});

describe("the step around it", () => {
  it("refuses a pin that is not a full hash, failing only a box left with nothing that starts", () => {
    let r = run("LLAMACPP_COMMIT=db7d8b2 step_llamacpp_runtime");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/must be a full 40-character commit hash/);
    installLive(path.join(tmp, "llama.cpp", "build"), OLD);
    r = run("LLAMACPP_COMMIT=db7d8b2 step_llamacpp_runtime");
    expect(r.code).toBe(0);
    // A binary that is there but does not start is not "working".
    fs.rmSync(path.join(tmp, "llama.cpp", "build"), { recursive: true });
    expect(run("LLAMACPP_COMMIT=db7d8b2 step_llamacpp_runtime").code).not.toBe(0);
    // A working binary that prints the newer form is a working binary too.
    installLive(path.join(tmp, "llama.cpp", "build"), "", NEW_FORM);
    expect(run("LLAMACPP_COMMIT=db7d8b2 step_llamacpp_runtime").code).toBe(0);
  });

  it("waits for a build already running, says so, and then has nothing to do", () => {
    installLive(path.join(tmp, "llama.cpp", "build"), "", NEW_FORM);
    const r = run(`
      ( flock 9; sleep 1 ) 9>>"$LLAMACPP_BUILD_LOCK" &
      sleep 0.3
      step_llamacpp_runtime; echo "rc=$?"`, { LDD_OUT: CUDA_LDD, PATH: `/nonexistent-cuda:${process.env.PATH}` });
    expect(r.out).toMatch(/Waiting for the llama\.cpp build already running to finish/);
    expect(r.out).toMatch(new RegExp(`llama-server already installed \\(llama\\.cpp ${PIN_SHORT}, CUDA=(ON|OFF)\\)`));
    expect(r.out).toContain("rc=0");
  });

  it("is the pin install.sh builds unless LLAMACPP_COMMIT says otherwise", () => {
    const m = /local LLAMACPP_COMMIT="\$\{LLAMACPP_COMMIT:-([0-9a-f]+)\}"/.exec(shellFunction("step_llamacpp_runtime"));
    expect(m?.[1]).toBe(PIN);
  });
});

describe("install.sh wiring", () => {
  it("runs the same check from the install step and as a step of its own", () => {
    expect(SRC).toMatch(/^DISPATCH_STEPS=\(\n[^)]*\bllamacpp_runtime\b/m);
    expect(shellFunction("step_llamacpp_install")).toMatch(/step_llamacpp_runtime \|\| return 1/);
    // The old gate — rebuild only when missing or CPU-only — is gone.
    expect(SRC).not.toMatch(/needs_rebuild/);
  });

  it("is reachable from the web server's root launcher and the root dispatcher", () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), "config/clawbox-run-root-step.sh"), "utf8");
    const dispatcher = fs.readFileSync(path.join(process.cwd(), "config/clawbox-root-step.sh"), "utf8");
    expect(launcher).toMatch(/\bllamacpp_runtime\b/);
    expect(dispatcher).toMatch(/\bllamacpp_runtime\b/);
  });

  it("probes binaries as the clawbox user, never as root", () => {
    expect(shellFunction("llamacpp_server_libraries")).toMatch(/as_clawbox ldd "\$1"/);
    expect(SRC).not.toMatch(/^\s*[^#\n]*[^_]ldd "\$(bin|LLAMACPP_SERVER_BIN)"/m);
    const fn = shellFunction("llamacpp_binary_commit");
    expect(fn).toMatch(/as_clawbox env LD_LIBRARY_PATH=/);
    expect(fn).toMatch(/as_clawbox "\$bin" --version/);
    expect(shellFunction("install_prebuilt_llamacpp")).not.toMatch(/^\s*if ! "\$llama_dir\/build\/bin\/llama-server" --version/m);
  });
});
