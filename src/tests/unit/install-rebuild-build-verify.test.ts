import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Runs real bash for every case: vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `do_rebuild` is the build inside `install.sh --step rebuild_reboot` — the
 * only thing that turns freshly pulled code into a dashboard. It had three
 * defects, all measured on the OpenClaw dev box on 2026-09-04 (TASK-709).
 *
 *  1. It deleted `.next` BEFORE building. So any failure past that line left
 *     the box with new code and NO build: `clawbox-setup` stopped by this same
 *     function and never started again, port 80 dead — while `clawbox-gateway`
 *     kept answering on 18789, so the box looked half-alive and the owner saw
 *     "Failed to get gateway config" over a cached page.
 *
 *  2. It read `bun run build`'s exit status as the verdict and nothing else.
 *     `bun run build` is `next build` PLUS the `postbuild` lifecycle script,
 *     and postbuild is what makes a build servable — BUILD_ID is written
 *     before any of it, and postbuild's own `if [ -n "$SRVJS" ]` guard exits 0
 *     having copied nothing. So a "successful" build can still leave
 *     production-server.js crash-looping on
 *     `require("./.next/standalone/server.js")`.
 *
 * The memory half of the same incident — the build being OOM-killed with
 * ollama, Kokoro and llama.cpp resident — was fixed on beta by
 * `free_memory_for_build`, which `do_rebuild` calls after the clawbox-setup
 * stop and which has its own suite (install-free-memory-before-build.test.ts).
 * Nothing here duplicates it; the stub below simply lets it run.
 *
 * These run the SHIPPED function bodies out of install.sh against stubs, so an
 * edit to install.sh is what the assertions see.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/**
 * One shell function, verbatim, closing brace included; "" when there is none.
 *
 * Anchored at a LINE START. `indexOf(name + "() {")` also matches inside a
 * longer identifier, so a future `pre_do_rebuild() {` above `do_rebuild` would
 * hand back the tail of that definition — and the "extracted whole" guard,
 * which checks the body STARTS with `name() {`, is satisfied by the suffix. The
 * harness would then run the wrong body and the suite would pass for the wrong
 * reason.
 */
function findShellFunction(name: string): string {
  const opener = new RegExp(`^${name}\\(\\) \\{$`, "m").exec(INSTALL_SH);
  if (!opener) return "";
  const start = opener.index;
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(name + " has no closing brace");
  return INSTALL_SH.slice(start, end + 2);
}

function shellFunction(name: string): string {
  const body = findShellFunction(name);
  if (!body) throw new Error(name + " not found in install.sh");
  return body;
}

/**
 * The helpers, all of them required.
 *
 * They were optional while they did not exist yet; they ship now, and a
 * tolerant lookup would be a hole: a renamed or deleted helper makes
 * `do_rebuild` fail with command-not-found, and every case asserting
 * `status).not.toBe(0)` would still pass — for the wrong reason.
 */
function shellFunctions(...names: string[]): string {
  return names.map((n) => shellFunction(n)).join("\n\n");
}

type BuildOutcome =
  /** BUILD_ID and a loadable standalone entry: a real build. */
  | "succeeds"
  /** SIGKILL from the global OOM killer: nothing written. */
  | "oom-killed"
  /** Exit 0, nothing written at all. */
  | "exits-zero-without-output"
  /** Exit 0 with BUILD_ID but no standalone entry: the half-run postbuild. */
  | "no-standalone-entry";

interface Scenario {
  build?: BuildOutcome;
  /** What `scripts/verify-build-identity.sh` answers, or that it is absent. */
  identity?: "ok" | "drift" | "script-missing";
  /** Is there a servable build in `.next` before the rebuild? */
  previousBuild?: "servable" | "none";
  /**
   * Is there a build parked in `.next-old` by an earlier interrupted run?
   *
   * "nested-entry" is the layout `postbuild` supports when Next nests the
   * standalone tree: `standalone/server.js` is a SYMLINK to an absolute path
   * inside `.next`, which dangles for as long as the tree is parked.
   */
  parkedBuild?: "servable" | "nested-entry" | "none";
  /** Units `systemctl is-active --quiet` answers yes for at the start. */
  activeUnits?: string[];
  /**
   * Does the dashboard actually answer on :80 after the start?
   *
   * False models the REAL crash-loop, which is why the unit still goes active
   * here: clawbox-setup is `Type=simple` with `Restart=always`, so systemd
   * marks it active the instant node is forked — before production-server.js
   * has required the build. `systemctl is-active` therefore says yes about a
   * box whose port 80 is dead, and only an HTTP probe can tell them apart.
   */
  startWorks?: boolean;
  /**
   * Room on the filesystem for a second copy of the build.
   *
   * "tight" takes `set_previous_build_aside`'s no-fallback branch, where the
   * old build is deleted rather than parked — the case in which a failed
   * rebuild has nothing to roll back to.
   */
  diskHeadroom?: "ample" | "tight";
  bunInstall?: "succeeds" | "fails";
  nodePty?: "succeeds" | "fails";
  /** Which shipped function to run. */
  entry?: "do_rebuild" | "step_build";
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  systemctl: string[];
  buildId: string | null;
  hasEntry: boolean;
  parked: boolean;
  /**
   * What the parked tree said about its owner WHILE `bun run build` ran —
   * "live <pid>", "stale <pid>" or "none". The reclaim in production-server.js
   * has nothing else to go on: from the park until the standalone entry is
   * written there is no `.next/standalone/server.js`, which is the only thing
   * it looks at, and clawbox-setup is pulled back up inside that window by
   * `clawbox-gateway.service`'s `Wants=`.
   */
  buildSawOwner: string;
  /** Did a stamp survive into the tree the box is left serving? */
  ownerLeftBehind: boolean;
}

let sandbox: string;
let systemctlLog: string;
let projectDir: string;
let ownerProbe: string;

function writeBuild(dir: string, buildId: string, withEntry = true): void {
  mkdirSync(path.join(dir, "standalone"), { recursive: true });
  writeFileSync(path.join(dir, "BUILD_ID"), buildId + "\n", "utf-8");
  if (withEntry) writeFileSync(path.join(dir, "standalone", "server.js"), "// server\n", "utf-8");
}

function run(scenario: Scenario = {}): Run {
  const {
    build = "succeeds",
    identity = "ok",
    previousBuild = "servable",
    parkedBuild = "none",
    activeUnits = ["ollama.service"],
    startWorks = true,
    diskHeadroom = "ample",
    bunInstall = "succeeds",
    nodePty = "succeeds",
    entry = "do_rebuild",
  } = scenario;

  mkdirSync(projectDir, { recursive: true });
  if (previousBuild === "servable") writeBuild(path.join(projectDir, ".next"), "old-build-id");
  if (parkedBuild === "servable") {
    writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");
    // With the stamp the earlier, killed run left on it. Without this the
    // `rm -f "$build_dir/.rebuild-pid"` promote_parked_build performs has
    // nothing to strip, and the case asserting it does would pass with that
    // line deleted.
    writeFileSync(path.join(projectDir, ".next-old", ".rebuild-pid"), "999999 stale-boot\n", "utf-8");
  }
  if (parkedBuild === "nested-entry") {
    const kept = path.join(projectDir, ".next-old");
    writeBuild(kept, "parked-build-id", false);
    mkdirSync(path.join(kept, "standalone", "nested"), { recursive: true });
    writeFileSync(path.join(kept, "standalone", "nested", "server.js"), "// server\n", "utf-8");
    // Exactly what postbuild writes: an ABSOLUTE path through `.next`, which
    // does not exist while the tree is parked under `.next-old`.
    symlinkSync(
      path.join(projectDir, ".next", "standalone", "nested", "server.js"),
      path.join(kept, "standalone", "server.js"),
    );
  }

  if (identity !== "script-missing") {
    mkdirSync(path.join(projectDir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "scripts", "verify-build-identity.sh"),
      identity === "ok" ? "#!/usr/bin/env bash\nexit 0\n" : "#!/usr/bin/env bash\necho 'BUILD IDENTITY: FAIL' >&2\nexit 1\n",
      "utf-8",
    );
  }

  // Stands in for `bun run build`. The four outcomes are the four the box can
  // produce, including the two that exit 0 without leaving a servable build.
  const fakeBuild = path.join(sandbox, "fake-build.sh");
  const bodies: Record<BuildOutcome, string> = {
    succeeds: 'mkdir -p "$1/.next/standalone" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && printf "// server\\n" > "$1/.next/standalone/server.js" && exit 0',
    "oom-killed": 'echo "Killed" >&2; exit 137',
    "exits-zero-without-output": "exit 0",
    "no-standalone-entry": 'mkdir -p "$1/.next" && printf "new-build-id\\n" > "$1/.next/BUILD_ID" && exit 0',
  };
  // Sampled from inside the build, because that is the only moment the
  // question matters: the reclaim fires on a box whose `bun run build` is
  // still running.
  const probeOwner = [
    'OWNER_FILE="$1/.next-old/.rebuild-pid"',
    'if [ -f "$OWNER_FILE" ]; then',
    '  read -r OWNER_PID OWNER_BOOT < "$OWNER_FILE"',
    '  THIS_BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)',
    '  if [ -n "$OWNER_BOOT" ] && [ "$OWNER_BOOT" = "$THIS_BOOT" ] && kill -0 "$OWNER_PID" 2>/dev/null; then',
    '    printf "live %s\\n" "$OWNER_PID" > ' + JSON.stringify(ownerProbe),
    "  else",
    '    printf "stale %s\\n" "$OWNER_PID" > ' + JSON.stringify(ownerProbe),
    "  fi",
    "else",
    '  printf "none\\n" > ' + JSON.stringify(ownerProbe),
    "fi",
  ].join("\n");
  writeFileSync(fakeBuild, "#!/usr/bin/env bash\n" + probeOwner + "\n" + bodies[build] + "\n", "utf-8");
  spawnSync("chmod", ["+x", fakeBuild]);

  const lines = [
    "set -euo pipefail",
    "",
    "PROJECT_DIR=" + JSON.stringify(projectDir),
    "CLAWBOX_USER=clawbox",
    "BUN=/nonexistent/bun",
    "FAKE_BUILD=" + JSON.stringify(fakeBuild),
    "SYSTEMCTL_LOG=" + JSON.stringify(systemctlLog),
    'ACTIVE_UNITS="' + activeUnits.join(" ") + '"',
    'START_WORKS=' + (startWorks ? "1" : "0"),
    "DASHBOARD_UP=0",
    'DISK_HEADROOM=' + JSON.stringify(diskHeadroom),
    "",
    "is_test_mode() { return 1; }",
    "# The readiness poll waits a real second per attempt. The LOOP is the",
    "# subject, not the wall clock, so the wait is a no-op here and all twenty",
    "# attempts run instantly.",
    "sleep() { :; }",
    "ensure_node_pty() {",
    nodePty === "succeeds"
      ? "  echo '  node-pty is already loadable'"
      : "  echo 'Error: node-pty is still not loadable' >&2; return 1",
    "}",
    "",
    "# The build runs as the clawbox user through this one seam. `bun install`",
    "# has an outcome of its own because it sits inside the window where the",
    "# dashboard is down.",
    "as_clawbox_login() {",
    '  case "$*" in',
    '    *"run build"*) "$FAKE_BUILD" "$PROJECT_DIR" ;;',
    bunInstall === "succeeds" ? "    *) return 0 ;;" : '    *"install"*) return 1 ;;\n    *) return 0 ;;',
    "  esac",
    "}",
    "",
    "systemctl() {",
    '  printf "%s\\n" "systemctl $*" >> "$SYSTEMCTL_LOG"',
    "  # `Type=simple`: systemd marks the unit active as soon as ExecStart is",
    "  # forked, whether or not the process can load the build. So `start`",
    "  # ALWAYS makes is-active true here, and only the HTTP stub below knows",
    "  # whether the dashboard came up.",
    '  if [ "$1" = "start" ] || [ "$1" = "restart" ]; then',
    '    ACTIVE_UNITS="$ACTIVE_UNITS $2"',
    '    [ "$START_WORKS" = "1" ] && DASHBOARD_UP=1',
    "    return 0",
    "  fi",
    '  if [ "$1" = "stop" ]; then',
    '    local kept="" u',
    '    for u in $ACTIVE_UNITS; do [ "$u" = "$2" ] || kept="$kept $u"; done',
    '    ACTIVE_UNITS="$kept"',
    "    return 0",
    "  fi",
    '  if [ "$1" = "is-active" ]; then',
    "    for u in $ACTIVE_UNITS; do",
    '      for a in "$@"; do [ "$a" = "$u" ] && return 0; done',
    "    done",
    "    return 3",
    "  fi",
    "  return 0",
    "}",
    "",
    "# The dashboard's own answer, which is what restore_previous_build asks",
    "# for. `command -v curl` finds a shell function, so the missing-curl arm",
    "# stays unreached here and has its own case.",
    "curl() {",
    '  if [ "$DASHBOARD_UP" = "1" ]; then printf "200"; return 0; fi',
    '  printf "000"',
    "  return 7",
    "}",
    "",
    "# Free space on the build's filesystem. `tight` reports less than twice the",
    "# tree's size, which is set_previous_build_aside's no-fallback threshold.",
    "df() {",
    '  if [ "$DISK_HEADROOM" = "tight" ]; then',
    '    printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 99 1 99%% /\\n"',
    "  else",
    '    printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 1 99999999 1%% /\\n"',
    "  fi",
    "}",
    "",
    "# beta's own memory reclaim, which do_rebuild calls. Its behaviour has its",
    "# own suite; here it only has to be present and harmless.",
    "free_memory_for_build() { :; }",
    "",
    shellFunctions(
      "build_entry_present",
      "verify_build_present",
      "promote_parked_build",
      "set_previous_build_aside",
      "restore_previous_build",
    ),
    "",
    shellFunction(entry),
    "",
    entry,
    "",
  ];

  const scriptPath = path.join(sandbox, "run.sh");
  writeFileSync(scriptPath, lines.join("\n"), "utf-8");
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", cwd: REPO });
  const log = existsSync(systemctlLog)
    ? readFileSync(systemctlLog, "utf-8").split("\n").filter(Boolean)
    : [];
  const buildIdPath = path.join(projectDir, ".next", "BUILD_ID");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    systemctl: log,
    buildId: existsSync(buildIdPath) ? readFileSync(buildIdPath, "utf-8").trim() : null,
    hasEntry: existsSync(path.join(projectDir, ".next", "standalone", "server.js")),
    parked: existsSync(path.join(projectDir, ".next-old")),
    buildSawOwner: existsSync(ownerProbe) ? readFileSync(ownerProbe, "utf-8").trim() : "not-run",
    ownerLeftBehind: existsSync(path.join(projectDir, ".next", ".rebuild-pid")),
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "clawbox-rebuild-"));
  systemctlLog = path.join(sandbox, "systemctl.log");
  projectDir = path.join(sandbox, "clawbox");
  ownerProbe = path.join(sandbox, "parked-owner.txt");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the shipped function bodies these tests run", () => {
  // findShellFunction slices to the first line starting with `}`. That is true
  // of every function it reads today, and silently wrong the day one grows a
  // heredoc or an indented closing brace at column 0 — the tests would then
  // assert against a fragment and pass for the wrong reason.
  it.each(["do_rebuild", "step_build", "verify_build_present", "restore_previous_build"])(
    "%s is extracted whole",
    (name) => {
      const body = shellFunction(name);
      expect(body.startsWith(name + "() {")).toBe(true);
      expect(body.endsWith("\n}")).toBe(true);
      // A fragment would not carry the function's last statement; every one of
      // these ends in a return, an echo or a cleanup, never mid-`if`.
      expect(body).not.toMatch(/\n\s*(if|while|case)[^\n]*\n\}$/);
    },
  );
});

describe("do_rebuild verifies the build it produced", () => {
  it("succeeds when the build writes a loadable standalone entry", () => {
    const r = run({ build: "succeeds" });
    expect(r.status).toBe(0);
    expect(r.buildId).toBe("new-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("fails when the build exits 0 without producing anything", () => {
    const r = run({ build: "exits-zero-without-output" });
    expect(r.status).not.toBe(0);
  });

  it("fails when the build is OOM-killed", () => {
    expect(run({ build: "oom-killed" }).status).not.toBe(0);
  });

  // The false success the first version of this fix would still have had:
  // BUILD_ID is written by `next build`, and `postbuild` — which copies the
  // standalone entry, the static assets and the identity stamp — runs after it
  // and can exit 0 having copied nothing. production-server.js does
  // `require("./.next/standalone/server.js")`, so BUILD_ID alone green-lights a
  // box that cannot boot.
  it("fails when the build leaves no server entry for the dashboard to load", () => {
    const r = run({ build: "no-standalone-entry" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/standalone\/server\.js/);
  });

  it("fails when the build on disk is not the checked-out commit", () => {
    // Asked through scripts/verify-build-identity.sh, the copy CI runs too —
    // not a second implementation of the comparison.
    const r = run({ build: "succeeds", identity: "drift" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
  });

  it("warns rather than failing when the identity script is not on disk", () => {
    const r = run({ build: "succeeds", identity: "script-missing" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/verify-build-identity\.sh is missing/);
  });
});

describe("do_rebuild keeps the box serving when the build fails", () => {
  const restarted = (r: Run) =>
    r.systemctl.filter((l) => /^systemctl (start|restart) clawbox-setup\.service$/.test(l));

  it("leaves the previous build in place after an OOM kill", () => {
    const r = run({ build: "oom-killed" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("starts clawbox-setup again after a failed build", () => {
    const r = run({ build: "oom-killed" });
    expect(restarted(r).length).toBeGreaterThan(0);
    expect(r.stderr).toMatch(/Restored the previous build; the dashboard answers on :80 again/);
  });

  // The window the first version of this fix left open: `bun install` and
  // `ensure_node_pty` run AFTER clawbox-setup is stopped and BEFORE the restore
  // branch, and `ensure_node_pty` used to `exit 1` outright — jumping over the
  // recovery and leaving the box in exactly the state the card describes, this
  // time with a perfectly good build untouched on disk.
  it("starts clawbox-setup again when bun install fails", () => {
    const r = run({ bunInstall: "fails" });
    expect(r.status).not.toBe(0);
    expect(restarted(r).length).toBeGreaterThan(0);
    expect(r.buildId).toBe("old-build-id");
  });

  it("starts clawbox-setup again when node-pty cannot be rebuilt", () => {
    const r = run({ nodePty: "fails" });
    expect(r.status).not.toBe(0);
    expect(restarted(r).length).toBeGreaterThan(0);
    expect(r.buildId).toBe("old-build-id");
  });

  it("says the dashboard is down when the restored build crash-loops", () => {
    // The state a Type=simple unit with Restart=always really produces: the
    // stub `systemctl start` makes the unit ACTIVE — as systemd does the
    // instant node is forked — while nothing answers on :80. An
    // implementation that polls `systemctl is-active` reports "serving again"
    // here, on a box that will be dead all night. Only the HTTP probe can tell
    // the two apart, which is why this case is the one that pins it.
    const r = run({ build: "oom-killed", startWorks: false });

    expect(r.status).not.toBe(0);
    expect(r.systemctl.some((l) => /^systemctl restart clawbox-setup/.test(l))).toBe(true);
    expect(r.stderr).toMatch(/it is DOWN/);
    expect(r.stderr).not.toMatch(/answers on :80/);
  });

  it("restarts clawbox-setup rather than starting it, so a latched unit is replaced", () => {
    // `start` on an already-active unit is a no-op, and the unit CAN be active
    // here: clawbox-gateway.service's `Wants=clawbox-setup.service` pulls it
    // back up mid-rebuild, and its own `Restart=always` latches it onto
    // whatever tree exists once `next build` writes the standalone entry. A
    // `start` would then leave the box serving the build that just failed
    // verification while this function reported a rollback.
    const r = run({ build: "succeeds", identity: "drift" });

    expect(r.status).not.toBe(0);
    expect(r.systemctl.some((l) => l === "systemctl restart clawbox-setup.service")).toBe(true);
    expect(r.systemctl.some((l) => l === "systemctl start clawbox-setup.service")).toBe(false);
  });

  it("says the dashboard answers when the restore really comes up", () => {
    const r = run({ build: "oom-killed" });

    expect(r.stderr).toMatch(/answers on :80 again/);
    expect(r.stderr).not.toMatch(/it is DOWN/);
  });

  it("does not call it a restore when nothing was ever moved aside", () => {
    // `bun install` fails BEFORE the park, so the serving build was never
    // touched. The outcome is right either way; the sentence is not, and this
    // whole change is about not asserting things that did not happen.
    const r = run({ bunInstall: "fails" });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/The serving build was never moved aside/);
    expect(r.stderr).not.toMatch(/Restored the previous build/);
  });

  it("names the build that failed verification when the disk could not hold two", () => {
    // The no-fallback branch: `set_previous_build_aside` deleted the old build
    // rather than parking it, the new one then failed identity, and what is on
    // disk is that rejected build. Starting it beats a dead box — calling it a
    // rollback does not.
    const r = run({ build: "succeeds", identity: "drift", diskHeadroom: "tight" });

    expect(r.status).not.toBe(0);
    expect(r.parked).toBe(false);
    expect(r.buildId).toBe("new-build-id");
    expect(r.stderr).toMatch(/FAILED verification/);
    expect(r.stderr).not.toMatch(/Restored the previous build/);
  });

  it("replaces the previous build only once the new one exists", () => {
    const r = run({ build: "succeeds" });
    expect(r.status).toBe(0);
    expect(r.buildId).toBe("new-build-id");
    expect(r.parked).toBe(false);
  });

  it("still fails, without a previous build to fall back on", () => {
    const r = run({ build: "oom-killed", previousBuild: "none" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBeNull();
    expect(r.stderr).toMatch(/No build to fall back on/);
  });

  // A rebuild that is killed outright — the OOM killer picking this shell, a
  // power cut, an operator's Ctrl-C — leaves the only good build parked under a
  // gitignored directory that nothing else in the tree reads.
  it("reclaims a build parked by an interrupted rebuild", () => {
    const r = run({ build: "oom-killed", previousBuild: "none", parkedBuild: "servable" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("parked-build-id");
    expect(r.hasEntry).toBe(true);
  });

  it("reclaims a parked build whose entry is the nested layout's symlink", () => {
    // `-f` resolves the link, and the link dangles while the tree is parked —
    // so a `-f` guard answers "nothing parked here" about the box's only
    // build and the rename below deletes it.
    const r = run({ previousBuild: "none", parkedBuild: "nested-entry", build: "oom-killed" });

    expect(r.stderr).toMatch(/parked by an interrupted rebuild/);
    expect(r.buildId).toBe("parked-build-id");
    expect(r.parked).toBe(false);
  });

  it("does not touch a parked build when the current one is servable", () => {
    // A FAILING build, so the preserved identity is observable: with
    // `succeeds` the build overwrites BUILD_ID either way, and removing the
    // guard in promote_parked_build would leave every assertion holding.
    // Failing, the box must end on its OWN previous build, not the parked one.
    const r = run({ build: "oom-killed", previousBuild: "servable", parkedBuild: "servable" });

    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
  });
});

describe("step_build asks the same two questions", () => {
  it("fails when the install path produces no server entry", () => {
    const r = run({ entry: "step_build", build: "no-standalone-entry", previousBuild: "none" });
    expect(r.status).not.toBe(0);
  });

  it("reclaims a parked build before rebuilding", () => {
    const r = run({ entry: "step_build", build: "oom-killed", previousBuild: "none", parkedBuild: "servable" });
    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("parked-build-id");
  });
});

describe("do_rebuild says who owns the build it parks", () => {
  /**
   * The park is not a quiet moment. `set_previous_build_aside` renames `.next`
   * to `.next-old` and only then runs `bun run build`, so for the whole length
   * of the build there is no `.next/standalone/server.js` and there is a parked
   * one — the exact condition production-server.js's boot-time reclaim fires
   * on. And clawbox-setup comes back up inside that window as a matter of
   * routine: `config/clawbox-gateway.service` carries
   * `Wants=clawbox-setup.service`, so every gateway (re)start starts the
   * service `do_rebuild` had just stopped (e2e-install run 33971129750: four
   * seconds after the stop, while `bun install` was still running).
   *
   * Nothing in the tree said "a rebuild is in flight", so the reclaim could not
   * tell that state from the one it exists for — a rebuild whose shell was
   * KILLED. The parked tree carries the rebuilding shell's PID instead, and
   * liveness is what separates the two.
   */
  it("stamps the parked build with the rebuilding shell while the build runs", () => {
    const r = run({ build: "succeeds" });

    expect(r.status).toBe(0);
    expect(r.buildSawOwner).toMatch(/^live \d+$/);
  });

  it("leaves no owner behind on the build it restores after a failure", () => {
    // The restore renames the parked tree back over `.next`. A stamp riding
    // along would sit inside the build the box serves, naming a process that
    // is about to exit.
    const r = run({ build: "oom-killed" });

    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("old-build-id");
    expect(r.ownerLeftBehind).toBe(false);
  });

  it("leaves no owner behind on the build it promotes", () => {
    // Same rename, the other direction: promote_parked_build claims a tree an
    // earlier killed run left behind, and that tree carries that run's stamp.
    //
    // `bunInstall: "fails"` so the run ENDS on the promoted tree — it aborts
    // before the park, so nothing writes a fresh stamp and nothing deletes
    // `.next-old` afterwards. With a successful build both of those would make
    // the assertion true no matter what promote did.
    const r = run({ previousBuild: "none", parkedBuild: "servable", bunInstall: "fails" });

    expect(r.status).not.toBe(0);
    expect(r.buildId).toBe("parked-build-id");
    expect(r.ownerLeftBehind).toBe(false);
  });

  it("writes the stamp production-server.js reads", () => {
    // Two files, one filename, and no compiler between them. A rename on either
    // side puts the race back silently: the reclaim would find no stamp, call
    // every running rebuild a dead one, and fire mid-build again.
    const stamp = /\.rebuild-pid/;
    expect(shellFunction("set_previous_build_aside")).toMatch(stamp);
    expect(readFileSync(path.join(REPO, "production-server.js"), "utf-8")).toMatch(stamp);
  });

  it("stamps nothing when the disk could not hold two builds", () => {
    // The no-fallback branch deletes the serving build rather than parking it.
    // There is no parked tree to own, and no reclaim can fire — a stamp here
    // would be a claim about a directory that does not exist.
    const r = run({ build: "succeeds", diskHeadroom: "tight" });

    expect(r.status).toBe(0);
    expect(r.buildSawOwner).toBe("none");
  });
});
