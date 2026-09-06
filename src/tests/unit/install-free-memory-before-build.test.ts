import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `do_rebuild` is where this appliance rebuilds itself — from the in-app
 * update (updater.ts → the `rebuild_reboot` root step → `step_rebuild_reboot`),
 * from `install.sh --step rebuild`, and from a full install.
 *
 * It used to run `bun run build` against whatever memory the box happened to
 * have left. On an 8 GB Jetson that is not a tuning question: ollama keeps a
 * model resident for ten idle minutes after the last chat turn, Kokoro holds
 * its voice on the GPU for five, and a llama.cpp server stays up until
 * something stops it — so an owner who pressed Update a minute after talking
 * to their box was building underneath several gigabytes of resident model.
 * The build is OOM-killed, and the update ends on a half-written .next.
 *
 * `free_memory_for_build` is the fix. What is pinned here:
 *  - it runs AFTER the web server is stopped (that is what makes the free
 *    hold — the gateway reaches ollama and llama.cpp through the web server's
 *    proxy, so nothing can pull a model back in behind it) and BEFORE the
 *    build;
 *  - it STOPS engines and never disables them, so they come back on demand;
 *  - it never fails the update;
 *  - and it never signals a pid it has not identified, because it runs as root
 *    and pidfiles outlive the processes they name.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = readFileSync(INSTALL_SH_PATH, "utf-8");

const NL = String.fromCharCode(10);

function extractShellFunction(name: string): string {
  const fn = findShellFunction(name);
  if (fn === null) throw new Error(`${name} not found in install.sh`);
  return fn;
}

/**
 * The same cut, for a function a tree may not have yet.
 *
 * Used only where a MISSING function must fail the assertion it is part of
 * rather than the whole file: the pause/resume pair is what these tests are
 * about, and "install.sh has no pause_engine_unit" is the RED, not a harness
 * error.
 */
function findShellFunction(name: string): string | null {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) return null;
  const end = INSTALL_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

/** Comments quote the failure being prevented; assertions must not read them. */
function shellCode(fn: string): string {
  return fn
    .split(NL)
    .filter((line) => !line.trim().startsWith("#"))
    .join(NL)
    .replace(new RegExp("\\\\" + NL + "\\s*", "g"), " ");
}

const DO_REBUILD = shellCode(extractShellFunction("do_rebuild"));
const FREE_MEMORY = shellCode(extractShellFunction("free_memory_for_build"));
/**
 * Everything that STOPS an engine for the build. The `systemctl` calls moved
 * out of `free_memory_for_build` into the pause helpers when the stops gained
 * their matching starts (TASK-724), so the rules below are asserted over the
 * code that does the stopping wherever it lives.
 */
const PAUSE_CODE = [
  FREE_MEMORY,
  shellCode(findShellFunction("pause_engine_unit") ?? ""),
  shellCode(findShellFunction("pause_engine_user_unit") ?? ""),
].join(NL);

/**
 * The install.sh fragments the stubbed runs below need, cut out of the shipped
 * file rather than restated here.
 *
 * The pause/resume trio is extracted BY THE SAME sed as everything else and is
 * not required to exist: on a tree that has not got it, sed simply writes
 * nothing and the assertions about it fail on what they are about — the
 * missing start — instead of on a harness error.
 */
function sourceInstallShellFns(tmp: string): string[] {
  const fns = [
    "available_mb",
    "llamacpp_pid_if_running",
    "pause_engine_unit",
    "pause_engine_user_unit",
    "resume_paused_engines",
    "free_memory_for_build",
  ];
  return [
    `: > "${tmp}/fns.sh"`,
    // The top-level state the pair keeps between the stop and the start. Cut
    // from install.sh too, so a test cannot pass by declaring it itself.
    `grep -E '^PAUSED_ENGINE_[A-Z_]+=' "$1" >> "${tmp}/fns.sh" || true`,
    ...fns.map((f) => `sed -n '/^${f}() {/,/^}/p' "$1" >> "${tmp}/fns.sh"`),
    `. "${tmp}/fns.sh"`,
  ];
}

describe("do_rebuild frees memory in the one place it can hold", () => {
  it("frees memory before the build", () => {
    // `run_next_build` IS the build here — it is the only caller of
    // `$BUN run build` in do_rebuild's path, and it exists because Next's
    // standalone copy can die on a file that changed mid-build (TASK-670).
    // Both halves are asserted, so neither the call nor the command can move
    // ahead of the free without this failing.
    const freeIdx = DO_REBUILD.indexOf("free_memory_for_build");
    const buildIdx = DO_REBUILD.indexOf("run_next_build");
    expect(freeIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(freeIdx).toBeLessThan(buildIdx);
    expect(shellCode(extractShellFunction("run_next_build"))).toContain("$BUN run build");
  });

  it("frees memory AFTER the web server is stopped, not before", () => {
    // Order is the whole mechanism, not tidiness. The OpenClaw gateway reaches
    // ollama and llama.cpp through the web server's own proxy
    // (src/lib/local-ai-runtime.ts), so a free performed while that proxy is
    // still listening can be undone by the next chat turn — and the build runs
    // for minutes.
    const stopIdx = DO_REBUILD.indexOf("systemctl stop clawbox-setup.service");
    const freeIdx = DO_REBUILD.indexOf("free_memory_for_build");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(freeIdx);
  });

  it("is reached by the in-app update, not only by a hand-run install", () => {
    // step_rebuild_reboot is what the updater's `rebuild_reboot` root step
    // runs; step_rebuild is the non-rebooting sibling. Both must go through
    // do_rebuild, or the fix misses the flow it was asked for.
    for (const step of ["step_rebuild_reboot", "step_rebuild"]) {
      expect(shellCode(extractShellFunction(step))).toMatch(/^\s*do_rebuild\b/m);
    }
  });
});

describe("free_memory_for_build stops engines without un-configuring them", () => {
  it("stops, never disables", () => {
    // The same rule the idle standby in src/lib/local-ai-runtime.ts follows:
    // these engines are meant to come back on demand. An update that quietly
    // un-enabled one would be a box that stopped talking after its next
    // reboot — a worse bug than the OOM this prevents.
    expect(FREE_MEMORY).toContain("pause_engine_unit ollama.service");
    expect(PAUSE_CODE).toContain('systemctl stop "$unit"');
    expect(PAUSE_CODE).not.toContain("disable");
    expect(PAUSE_CODE).not.toMatch(/systemctl[^\n]*\benable\b/);
  });

  it("names every engine that can hold memory across the build", () => {
    for (const unit of ["ollama.service", "kokoro-server.service", "whisper-server.service"]) {
      expect(FREE_MEMORY).toContain(unit);
    }
    // llama.cpp has no unit — ClawBox supervises it itself and records the pid.
    expect(FREE_MEMORY).toContain("llamacpp_pid_if_running");
  });

  it("cannot fail the update", () => {
    // errexit is live (install.sh runs under `set -euo pipefail`) and this is
    // called as a bare statement, so every command that can legitimately fail
    // on a healthy box has to carry its own fallback.
    const stops = PAUSE_CODE.split(NL).filter((l) => l.includes("systemctl") && l.includes("stop"));
    expect(stops.length).toBeGreaterThan(0);
    for (const line of stops) {
      expect(line, `a stop must not be able to abort the update: ${line}`).toMatch(/\|\|/);
    }
    expect(FREE_MEMORY).toMatch(/drop_caches[^\n]*\|\|/);
  });
});

/**
 * The assertions above read install.sh as text. The two properties that matter
 * most — that a stale pidfile cannot get an innocent process killed by root,
 * and that the whole thing exits 0 on a box where every step fails — cannot be
 * read out of a regex. So drive the real functions with stubbed `systemctl`
 * and `sudo` on PATH, and look at what actually happened.
 */
describe("free_memory_for_build — behaviour, driven against stubs", () => {
  let tmp: string;
  /** Every fake engine started, so a failing assertion cannot leak one. */
  let strays: number[] = [];

  beforeEach(() => {
    strays = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "free-mem-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "data", "llamacpp"), { recursive: true });

    // Records every call, and answers `cat` — the existence test — from
    // EXISTING_UNITS, so the harness can give the box a Kokoro and no Whisper.
    fs.writeFileSync(
      path.join(tmp, "bin", "systemctl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
        'case " $* " in',
        '  *" cat "*)',
        '    for u in $EXISTING_UNITS; do',
        '      case " $* " in *" $u "*) exit 0 ;; esac',
        "    done",
        "    exit 1 ;;",
        // systemd answers 3 for a unit that exists and is not running, so the
        // stub has to as well: `is-active` failing for any other reason is a
        // different question from "it is stopped".
        '  *" is-active "*)',
        '    for u in ${ACTIVE_UNITS-$EXISTING_UNITS}; do',
        '      case " $* " in *" $u "*) exit 0 ;; esac',
        "    done",
        "    exit 3 ;;",
        "esac",
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );

    // `sudo -u <user> VAR=val cmd …` → run `cmd …` as ourselves. A real
    // executable rather than a shell function so it behaves the same however
    // the function invokes it.
    fs.writeFileSync(
      path.join(tmp, "bin", "sudo"),
      [
        "#!/bin/sh",
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        "    -u) shift 2 ;;",
        "    -n) shift ;;",
        "    *=*) shift ;;",
        "    *) break ;;",
        "  esac",
        "done",
        'exec "$@"',
        "",
      ].join(NL),
      { mode: 0o755 },
    );

    // The real `sync` flushes every dirty page on the machine running the
    // suite — seconds per call on the appliance's own storage, and nothing
    // this test is about. Stub it, and assert below that it is still called.
    fs.writeFileSync(
      path.join(tmp, "bin", "sync"),
      `#!/bin/sh${NL}printf "sync\\n" >> "$SYSTEMCTL_LOG"${NL}`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const pid of strays) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already gone — that is what most of these tests assert */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const pidFile = () => path.join(tmp, "data", "llamacpp", "server.pid");

  /**
   * Start a process whose argv[0] IS `name`, so /proc/<pid>/cmdline says what
   * the harness needs it to say. `llama-server` is the engine; anything else
   * stands in for the process that inherited a recycled pid.
   *
   * A copy of `sleep` spawned directly, not a shell script: a script that
   * `exec`s sleep replaces its own argv, so cmdline would read "sleep" and the
   * identity check under test would never see the name it is looking for.
   * Detached and unref'd so it outlives the call rather than dying with it.
   */
  const SLEEP_BIN = ["/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));

  function startFakeProcess(name: string): number {
    if (!SLEEP_BIN) throw new Error("no sleep binary to copy");
    const bin = path.join(tmp, "bin", name);
    fs.copyFileSync(SLEEP_BIN, bin);
    fs.chmodSync(bin, 0o755);
    const child = spawn(bin, ["120"], { detached: true, stdio: "ignore" });
    child.unref();
    strays.push(child.pid!);
    return child.pid!;
  }

  /**
   * Alive, and not merely unreaped.
   *
   * The fake engines are children of this test process, and `execFileSync`
   * blocks the event loop for the whole harness run — so a killed one stays a
   * zombie until the harness returns. A zombie still answers `kill -0`, to
   * Node and to the shell alike, which is why this reads the state letter out
   * of /proc instead, and why the production loop above is written to fall
   * through rather than wait for the process to stop answering.
   */
  const alive = (pid: number) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The comm field is parenthesised and may itself contain ')', so the
      // state letter is the token after the LAST one.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch {
      return false;
    }
  };

  function run({ existingUnits = "ollama.service kokoro-server.service" } = {}) {
    const log = path.join(tmp, "systemctl.log");
    fs.writeFileSync(log, "");
    const script = [
      // install.sh's own options. A laxer harness would certify paths the
      // shipped script does not have.
      "set -euo pipefail",
      `PROJECT_DIR="${tmp}"`,
      'CLAWBOX_USER="$(id -un)"',
      `export PATH="${tmp}/bin:$PATH"`,
      ...sourceInstallShellFns(tmp),
      "free_memory_for_build 2>&1",
    ].join(NL);
    let code = 0;
    let out: string;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SYSTEMCTL_LOG: log, EXISTING_UNITS: existingUnits },
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { code, out, calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean) };
  }

  it("succeeds and reports what the build has to work with", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Memory available for the build: \d+ MB \(was \d+ MB\)/);
  });

  it("stops ollama and never disables it", () => {
    const r = run();
    expect(r.calls).toContain("stop ollama.service");
    expect(r.calls.join(NL)).not.toMatch(/\bdisable\b/);
  });

  it("skips a unit the box does not have", () => {
    // Whisper is absent from EXISTING_UNITS: the existence test must keep the
    // stop from being attempted at all, so the log stays free of a failure
    // that is not one.
    const r = run();
    expect(r.calls.some((c) => c.includes("stop whisper-server.service"))).toBe(false);
  });

  it("stops the voice engines the box does have", () => {
    const r = run();
    // The user units need the clawbox user's session bus. On a runner with no
    // login session there is no /run/user/<uid> and nothing to stop — assert
    // the branch the environment actually offers rather than skipping.
    const hasSession = fs.existsSync(`/run/user/${process.getuid?.() ?? -1}`);
    expect(r.calls.some((c) => c.includes("stop kokoro-server.service"))).toBe(hasSession);
  });

  it("stops the llama.cpp server its pidfile names", () => {
    const pid = startFakeProcess("llama-server");
    fs.writeFileSync(pidFile(), `${pid}${NL}`);

    const r = run();

    expect(r.code).toBe(0);
    expect(alive(pid)).toBe(false);
    // It went on the first signal, so the journal must not say otherwise —
    // the harness's own child is unreaped at this point, which is exactly the
    // state that made the old message lie.
    expect(r.out).not.toMatch(/did not exit on SIGTERM/);
    // The pidfile goes with it: leaving it behind would make the next reader
    // believe a server is up.
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it("never signals a process that merely inherited the pid", () => {
    // This runs as root on the device. A pidfile outlives a crash and pids are
    // recycled, so an unverified kill here is a root SIGKILL aimed at whatever
    // holds the number now — which on this box could be the gateway.
    const innocent = startFakeProcess("not-llama");
    fs.writeFileSync(pidFile(), `${innocent}${NL}`);

    const r = run();

    expect(r.code).toBe(0);
    expect(alive(innocent)).toBe(true);
  });

  it("escalates to SIGKILL only while the pid is still the engine", () => {
    // A server that ignores SIGTERM: the escalation path, which no other test
    // reaches. Its argv is the interpreter plus a script whose NAME carries
    // the identity, so /proc still answers the question the code asks.
    const script = path.join(tmp, "bin", "llama-server-stubborn");
    fs.writeFileSync(script, `trap '' TERM${NL}while :; do sleep 1; done${NL}`);
    const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
    child.unref();
    strays.push(child.pid!);
    fs.writeFileSync(pidFile(), `${child.pid}${NL}`);

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/did not exit on SIGTERM/);
    expect(alive(child.pid!)).toBe(false);
  });

  it("cannot be aborted by a failing sync", () => {
    // `sync` runs as a bare command under errexit, and free_memory_for_build is
    // itself called bare from do_rebuild — so an I/O error here would abort the
    // whole update before the build, which is the opposite of this function's
    // one promise. Reported by CodeRabbit on #643.
    fs.writeFileSync(path.join(tmp, "bin", "sync"), `#!/bin/sh${NL}exit 1${NL}`, { mode: 0o755 });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Memory available for the build/);
  });

  it("survives a pidfile that is not a pid", () => {
    fs.writeFileSync(pidFile(), `not-a-number${NL}`);
    expect(run().code).toBe(0);
  });

  it("drops the page cache only after the engines have let go of it", () => {
    // Before the stops it would reclaim a cache the engines are still holding
    // pages in, which frees materially less.
    const r = run();
    expect(r.calls).toContain("sync");
    expect(r.calls.indexOf("stop ollama.service")).toBeLessThan(r.calls.indexOf("sync"));
  });

  it("survives a box where every stop fails", () => {
    // The engines are not what the owner pressed Update for. A box that cannot
    // stop one of them should still attempt the build it was asked for — and
    // errexit is live, so this is a real risk, not a hypothetical one. The
    // units are present (`cat` succeeds) and every stop refuses.
    fs.writeFileSync(
      path.join(tmp, "bin", "systemctl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
        'case " $* " in *" cat "*) exit 0 ;; esac',
        "exit 1",
        "",
      ].join(NL),
      { mode: 0o755 },
    );

    const r = run();

    expect(r.code).toBe(0);
    expect(r.calls).toContain("stop ollama.service");
    expect(r.out).toMatch(/Warning: could not stop ollama\.service/);
    expect(r.out).toMatch(/Memory available for the build/);
  });
});

/**
 * TASK-724 — the stop half of this pair shipped without the start half.
 *
 * Measured on the OpenClaw box 2026-09-05 and again on every deploy of the
 * 2026-09-06 run: the in-app update stopped `ollama.service` so `next build`
 * would fit, the build succeeded, the updater reported `phase=completed` — and
 * the box was left with local AI dead until somebody noticed and started it by
 * hand. The update's own report said the box was fine while a service the
 * update had stopped was still down. False success.
 *
 * Two rules, and the second is what keeps the first from being over-reach:
 * every engine this run stopped comes back, and ONLY the ones that were running
 * when it stopped them — an engine the owner had switched off, or that the
 * runtime's own ten-minute idle standby had put away, must stay off.
 */
describe("free_memory_for_build gives back what it took", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resume-engines-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "data", "llamacpp"), { recursive: true });
    // Answers `cat` from EXISTING_UNITS and `is-active` from ACTIVE_UNITS, and
    // flips a unit to inactive once it has been stopped — so a start that is
    // asked for is visible in the log AND in the unit's state, and the "did it
    // come back" check is a real question rather than a constant.
    fs.writeFileSync(
      path.join(tmp, "bin", "systemctl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
        'unit=""',
        'for a in "$@"; do case "$a" in *.service) unit="$a" ;; esac; done',
        'state="$SYSTEMCTL_STATE/$unit"',
        'case " $* " in',
        '  *" cat "*)',
        '    for u in $EXISTING_UNITS; do',
        '      [ "$u" = "$unit" ] && exit 0',
        "    done",
        "    exit 1 ;;",
        '  *" stop "*)',
        '    printf inactive > "$state"',
        "    exit 0 ;;",
        '  *" start "*)',
        '    [ -n "$START_FAILS" ] && exit 1',
        '    printf active > "$state"',
        "    exit 0 ;;",
        '  *" is-active "*)',
        '    if [ -f "$state" ]; then',
        '      [ "$(cat "$state")" = active ] && exit 0',
        "      exit 3",
        "    fi",
        '    for u in $ACTIVE_UNITS; do',
        '      [ "$u" = "$unit" ] && exit 0',
        "    done",
        "    exit 3 ;;",
        "esac",
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "bin", "sudo"),
      ["#!/bin/sh", 'while [ $# -gt 0 ]; do', '  case "$1" in', "    -u) shift 2 ;;", "    -n) shift ;;",
        "    *=*) shift ;;", "    *) break ;;", "  esac", "done", 'exec "$@"', ""].join(NL),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(tmp, "bin", "sync"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Free memory, then resume — the pair `do_rebuild` performs around a build. */
  function pauseThenResume({
    existingUnits = "ollama.service clawbox-embed.service",
    activeUnits = "ollama.service clawbox-embed.service",
    startFails = "",
  } = {}) {
    const log = path.join(tmp, "systemctl.log");
    const state = path.join(tmp, "state");
    fs.writeFileSync(log, "");
    fs.mkdirSync(state, { recursive: true });
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR="${tmp}"`,
      'CLAWBOX_USER="$(id -un)"',
      `export PATH="${tmp}/bin:$PATH"`,
      ...sourceInstallShellFns(tmp),
      "free_memory_for_build 2>&1",
      "echo '--- build happens here ---'",
      "resume_paused_engines 2>&1",
    ].join(NL);
    let code = 0;
    let out: string;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SYSTEMCTL_LOG: log,
          SYSTEMCTL_STATE: state,
          EXISTING_UNITS: existingUnits,
          ACTIVE_UNITS: activeUnits,
          START_FAILS: startFails,
        },
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { code, out, calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean) };
  }

  it("starts ollama again after the build, having stopped it for the build", () => {
    const r = pauseThenResume();
    expect(r.code).toBe(0);
    const stop = r.calls.indexOf("stop ollama.service");
    const start = r.calls.indexOf("start ollama.service");
    expect(stop, "the build still gets the memory").toBeGreaterThan(-1);
    expect(start, "and the engine still gets to come back").toBeGreaterThan(stop);
  });

  it("gives back every engine it paused, not just the one on the card", () => {
    const r = pauseThenResume();
    expect(r.calls).toContain("start clawbox-embed.service");
  });

  it("leaves an engine that was already stopped alone", () => {
    // The runtime stops ollama after ten idle minutes of its own accord, so
    // "inactive" is a normal steady state and not something to undo. An update
    // that started engines the box had put away would be holding memory nobody
    // asked it to hold.
    const r = pauseThenResume({ activeUnits: "clawbox-embed.service" });
    expect(r.calls).toContain("stop ollama.service");
    expect(r.calls).not.toContain("start ollama.service");
    expect(r.calls).toContain("start clawbox-embed.service");
  });

  it("says so, by name, when an engine does not come back", () => {
    // `systemctl start` answering 0 is not the outcome — it answers 0 for a
    // unit whose ExecStart forked and died. The state after the start is.
    const r = pauseThenResume({ startFails: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[WARN\][^\n]*ollama\.service did not come back/);
  });

  it("reports the engines that did come back, so a log reader can tell", () => {
    const r = pauseThenResume();
    expect(r.out).toMatch(/\[ok\][^\n]*ollama\.service is back/);
  });

  it("cannot start an engine twice, so the second pause accounts only for itself", () => {
    // post_update stops ollama a second time and resumes it at its own end. If
    // resume did not clear its record, a later call would start whatever the
    // first one had — including a unit the box has since stopped on purpose.
    const log = path.join(tmp, "systemctl.log");
    const state = path.join(tmp, "state");
    fs.writeFileSync(log, "");
    fs.mkdirSync(state, { recursive: true });
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR="${tmp}"`,
      'CLAWBOX_USER="$(id -un)"',
      `export PATH="${tmp}/bin:$PATH"`,
      ...sourceInstallShellFns(tmp),
      "free_memory_for_build >/dev/null 2>&1",
      "resume_paused_engines >/dev/null 2>&1",
      `printf '' > "$SYSTEMCTL_LOG"`,
      "resume_paused_engines 2>&1",
    ].join(NL);
    execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SYSTEMCTL_LOG: log,
        SYSTEMCTL_STATE: state,
        EXISTING_UNITS: "ollama.service",
        ACTIVE_UNITS: "ollama.service",
        START_FAILS: "",
      },
    });
    expect(fs.readFileSync(log, "utf8").split(NL).filter(Boolean)).toEqual([]);
  });
});

describe("both stops an update performs have a start", () => {
  const POST_UPDATE = shellCode(extractShellFunction("step_post_update"));

  it("do_rebuild resumes on the success path and on the failure path", () => {
    // Above the `rc` branch rather than inside both of its arms: an exit added
    // to either arm later cannot then skip it, which is how the stop came to
    // have no start in the first place.
    const resumeIdx = DO_REBUILD.indexOf("resume_paused_engines");
    const branchIdx = DO_REBUILD.search(/if \[ "\$rc" -ne 0 \]/);
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(resumeIdx).toBeLessThan(branchIdx);
    // And after the build, or it would hand the memory back before it is used.
    expect(DO_REBUILD.indexOf("run_next_build")).toBeLessThan(resumeIdx);
  });

  it("step_post_update's own ollama stop is paired too", () => {
    // The second of the two stops an update performs, and the one whose missing
    // start left the box dead: nothing runs after post_update that would have
    // woken it.
    expect(POST_UPDATE).toContain("pause_engine_unit ollama.service");
    const pauseIdx = POST_UPDATE.indexOf("pause_engine_unit ollama.service");
    const resumeIdx = POST_UPDATE.indexOf("resume_paused_engines");
    expect(resumeIdx).toBeGreaterThan(pauseIdx);
    // A bare stop beside the paired one would be a third, unaccounted-for stop.
    expect(POST_UPDATE).not.toMatch(/systemctl stop ollama\.service/);
  });

  it("does not try to restart the llama.cpp server it killed", () => {
    // It has no unit: the web server spawns it, holds the child handle and
    // records the pid, and wakes it on the next request that needs it. A root
    // shell starting a second one behind the app's back would be a process the
    // app has no handle on, fighting it over the same pidfile.
    const RESUME = findShellFunction("resume_paused_engines");
    expect(RESUME, "resume_paused_engines must exist for the pair to close").not.toBeNull();
    expect(shellCode(RESUME ?? "")).not.toMatch(/llama/i);
  });
});
