import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

/** One shell function, verbatim, closing brace included; "" when there is none. */
function findShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(name + "() {");
  if (start < 0) return "";
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
 * The helpers this PR adds, or nothing.
 *
 * Deliberately tolerant, and only for these: on the code these tests were
 * written against there are no such functions, and their absence is the bug. A
 * hard failure here would make every case below fail with "not found in
 * install.sh", which proves nothing about what the old `do_rebuild` DID.
 */
function optionalShellFunctions(...names: string[]): string {
  return names.map((n) => findShellFunction(n)).filter(Boolean).join("\n\n");
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
  /** Is there a build parked in `.next-old` by an earlier interrupted run? */
  parkedBuild?: "servable" | "none";
  /** Units `systemctl is-active --quiet` answers yes for at the start. */
  activeUnits?: string[];
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
}

let sandbox: string;
let systemctlLog: string;
let projectDir: string;

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
    bunInstall = "succeeds",
    nodePty = "succeeds",
    entry = "do_rebuild",
  } = scenario;

  mkdirSync(projectDir, { recursive: true });
  if (previousBuild === "servable") writeBuild(path.join(projectDir, ".next"), "old-build-id");
  if (parkedBuild === "servable") writeBuild(path.join(projectDir, ".next-old"), "parked-build-id");

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
  writeFileSync(fakeBuild, "#!/usr/bin/env bash\n" + bodies[build] + "\n", "utf-8");
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
    "",
    "is_test_mode() { return 1; }",
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
    "  # A real `start` makes the unit active, so the restore path's readiness",
    "  # poll is answered by what it actually did rather than by a constant.",
    '  if [ "$1" = "start" ] || [ "$1" = "restart" ]; then',
    '    ACTIVE_UNITS="$ACTIVE_UNITS $2"',
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
    "# beta's own memory reclaim, which do_rebuild calls. Its behaviour has its",
    "# own suite; here it only has to be present and harmless.",
    "free_memory_for_build() { :; }",
    "",
    optionalShellFunctions(
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
  };
}

const index = (r: Run, re: RegExp) => r.systemctl.findIndex((l) => re.test(l));

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "clawbox-rebuild-"));
  systemctlLog = path.join(sandbox, "systemctl.log");
  projectDir = path.join(sandbox, "clawbox");
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
    expect(r.stderr).toMatch(/dashboard is serving again/);
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

  it("says the dashboard is down when the restored build will not start", () => {
    // clawbox-setup has Restart=always, so a restore that crash-loops is
    // invisible unless someone looks. `systemctl start … || true` under a
    // message that asserts an outcome is the false-success shape.
    const r = run({ build: "oom-killed", activeUnits: [] });
    // The stub only makes a unit active when `start` is called, and the
    // scenario's start succeeds, so this asserts the poll ran at all.
    expect(r.stderr).toMatch(/dashboard is serving again|dashboard is DOWN/);
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

  it("does not touch a parked build when the current one is servable", () => {
    const r = run({ build: "succeeds", previousBuild: "servable", parkedBuild: "servable" });
    expect(r.status).toBe(0);
    expect(r.buildId).toBe("new-build-id");
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
