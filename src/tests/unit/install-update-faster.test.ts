import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";

/**
 * TASK-2517: a faster, steadier in-app update, with nothing the owner sees
 * changing except the time it takes.
 *
 *   1. `build_is_current_for_checkout` — step_rebuild_reboot leaves the rebuild
 *      out when the build on disk is already this checkout's (an update with
 *      nothing new, the wizard's update on a box flashed at the target).
 *   2. `hand_paused_gateway_to_update` — on the update's restart arm a gateway
 *      paused for `next build` is not started again by the rebuild, because the
 *      update's second half stops it first thing and then starts it; a
 *      transient timer starts it if nothing has since.
 *   3. `git_with_retry` ends a transfer that has stalled, so the retries it
 *      already had can run instead of a hung fetch eating the step's budget.
 *
 * These run the shipped functions, sliced out of install.sh, against a real
 * git checkout and the real scripts/verify-build-identity.sh, with the
 * privilege drops and systemd stubbed.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const VERIFY_SH = fs.readFileSync(path.join(REPO, "scripts", "verify-build-identity.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function fn(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return INSTALL_SH.slice(start + 1, end + 2);
}

/** The GATEWAY_HANDBACK_* settings, verbatim, as the functions see them. */
function handbackSettings(): string {
  const start = INSTALL_SH.indexOf('\nGATEWAY_HANDBACK_UNIT="');
  const end = INSTALL_SH.indexOf("\ndisarm_gateway_handback() {", start);
  if (start < 0 || end < 0) throw new Error("GATEWAY_HANDBACK_* settings not found in install.sh");
  return INSTALL_SH.slice(start + 1, end);
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "update-faster-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function bash(script: string, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, ...env }),
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// ── 1. Is the build on disk already this checkout's? ───────────────────────

d("build_is_current_for_checkout: a rebuild only when one could change something", () => {
  let project: string;
  let head: string;

  interface Stamp { commit?: string; dirty?: unknown; untracked?: unknown; node?: string; buildId?: string }

  function writeStamp(dir: string, over: Stamp = {}): void {
    const stamp = { commit: head, dirty: false, untracked: 0, node: process.version, buildId: "build-1", ...over };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify(stamp, null, 2));
    fs.writeFileSync(path.join(dir, "BUILD_ID"), "build-1");
  }

  /** A whole build of HEAD: the standalone entry, BUILD_ID and both stamps. */
  function writeBuild(over: Stamp = {}): void {
    const next = path.join(project, ".next");
    fs.mkdirSync(path.join(next, "standalone", ".next"), { recursive: true });
    fs.writeFileSync(path.join(next, "standalone", "server.js"), "// entry\n");
    writeStamp(path.join(next, "standalone", ".next"), over);
    writeStamp(next, over);
  }

  beforeEach(() => {
    project = path.join(tmp, "clawbox");
    fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(project, "scripts", "verify-build-identity.sh"), VERIFY_SH);
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    fs.writeFileSync(path.join(project, ".gitignore"), ".next/\n.next-old/\n.env\n");
    git(project, "init", "-q");
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "init");
    head = git(project, "rev-parse", "HEAD");
    writeBuild();
  });

  function ask(env: Record<string, string> = {}, extra: string[] = []): { status: number | null; reason: string; err: string } {
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      "CLAWBOX_USER=clawbox",
      `CLAWBOX_HOME=${JSON.stringify(tmp)}`,
      // The privilege drops, without the privilege: the commands run as the
      // test's own user, exactly as given.
      'as_clawbox() { "$@"; }',
      'as_clawbox_login() { bash -c "$*"; }',
      'runuser() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift; "$@"; }',
      ...extra,
      fn("first_paths"),
      fn("build_entry_present"),
      fn("build_stamp_refusal"),
      fn("build_is_current_for_checkout"),
      "build_is_current_for_checkout",
    ].join("\n");
    const r = bash(script, env);
    return { status: r.status, reason: r.out.trim(), err: r.err };
  }

  it("says yes for a whole build of HEAD from a clean tree on this Node, and says why", () => {
    const r = ask();
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.reason).toContain(head.slice(0, 12));
    expect(r.reason).toContain(process.version);
  });

  it("rebuilds when the build is of another commit", () => {
    writeBuild({ commit: "0".repeat(40) });
    const r = ask();
    expect(r.status).toBe(1);
    expect(r.reason).toContain(`the build on disk is not a build of ${head.slice(0, 12)}`);
  });

  it("rebuilds when the stamp's build id is not the build beside it", () => {
    fs.writeFileSync(path.join(project, ".next", "standalone", ".next", "BUILD_ID"), "build-2");
    expect(ask().status).toBe(1);
  });

  it.each([
    ["changes", { dirty: true }, "was built from a tree with changes"],
    ["untracked files", { untracked: 3 }, "was built with 3 untracked file(s)"],
    ["another Node", { node: "v1.0.0" }, "was built on Node v1.0.0"],
    ["no recorded Node", { node: undefined }, "was built on Node (unrecorded)"],
  ])("rebuilds a build made from a tree with %s", (_what, over, said) => {
    writeBuild(over as Stamp);
    const r = ask();
    expect(r.status).toBe(1);
    expect(r.reason).toContain(said);
  });

  it("rebuilds when the build's own Node cannot be asked", () => {
    const r = ask({}, ['as_clawbox_login() { return 1; }']);
    expect(r.status).toBe(1);
    expect(r.reason).toContain("this build would run on (no answer)");
  });

  it("rebuilds when node cannot read the stamps at all", () => {
    const r = ask({}, ['as_clawbox() { if [ "$1" = node ]; then return 127; fi; "$@"; }']);
    expect(r.status).toBe(1);
    expect(r.reason).toContain(".next/build-info.json could not be read");
  });

  it("rebuilds when a stamp is not JSON", () => {
    fs.writeFileSync(path.join(project, ".next", "build-info.json"), "{");
    const r = ask();
    expect(r.status).toBe(1);
  });

  it("rebuilds over a tracked edit and over a new file, and names them", () => {
    fs.writeFileSync(path.join(project, "package.json"), '{"edited":true}\n');
    fs.writeFileSync(path.join(project, "new-page.tsx"), "x\n");
    const r = ask();
    expect(r.status).toBe(1);
    expect(r.reason).toContain("the tree has changes");
    expect(r.reason).toContain("package.json");
    expect(r.reason).toContain("new-page.tsx");
  });

  it("does not count an executable bit the rebuild step set as a change", () => {
    fs.writeFileSync(path.join(project, "scripts", "x.sh"), "echo\n");
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "script");
    head = git(project, "rev-parse", "HEAD");
    writeBuild();
    fs.chmodSync(path.join(project, "scripts", "x.sh"), 0o755);
    expect(ask().status).toBe(0);
  });

  it("rebuilds when there is no complete build to keep", () => {
    fs.rmSync(path.join(project, ".next", "standalone", "server.js"));
    const r = ask();
    expect(r.status).toBe(1);
    expect(r.reason).toContain("there is no complete build in .next");
  });

  it.each([".next-old", ".next-claim.4242", ".next-discard.4242"])(
    "rebuilds while %s says a rebuild did not finish",
    (name) => {
      fs.mkdirSync(path.join(project, name));
      const r = ask();
      expect(r.status).toBe(1);
      expect(r.reason).toContain(`a rebuild did not finish (${name} is there)`);
    },
  );

  it("rebuilds when an env file Next loads changed after the build", () => {
    const env = path.join(project, ".env");
    fs.writeFileSync(env, "PORTAL_EMBED_ORIGINS=https://example.invalid\n");
    const built = fs.statSync(path.join(project, ".next", "BUILD_ID")).mtimeMs / 1000;
    fs.utimesSync(env, built + 60, built + 60);
    const r = ask();
    expect(r.status).toBe(1);
    expect(r.reason).toContain(".env changed after the build");
    // …and does not, when the env file is older than the build.
    fs.utimesSync(env, built - 60, built - 60);
    expect(ask().status).toBe(0);
  });

  it("rebuilds when the identity script is not in the tree", () => {
    fs.rmSync(path.join(project, "scripts", "verify-build-identity.sh"));
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "drop");
    head = git(project, "rev-parse", "HEAD");
    writeBuild();
    const r = ask();
    expect(r.status).toBe(1);
    expect(r.reason).toContain("verify-build-identity.sh is missing");
  });

  it("always rebuilds with CLAWBOX_FORCE_REBUILD=1", () => {
    const r = ask({ CLAWBOX_FORCE_REBUILD: "1" });
    expect(r.status).toBe(1);
    expect(r.reason).toContain("CLAWBOX_FORCE_REBUILD=1");
  });

  it("names every failed condition at once", () => {
    writeBuild({ dirty: true, node: "v1.0.0" });
    fs.writeFileSync(path.join(project, "package.json"), '{"edited":true}\n');
    const r = ask({ CLAWBOX_FORCE_REBUILD: "1" });
    expect(r.status).toBe(1);
    for (const said of ["CLAWBOX_FORCE_REBUILD=1", "changes (dirty=true)", "Node v1.0.0", "the tree has changes"]) {
      expect(r.reason).toContain(said);
    }
  });
});

// ── 2. The gateway the build paused, handed to the update's second half ────

d("hand_paused_gateway_to_update: one start of the gateway, by gateway_verify", () => {
  function hand(opts: { paused: string[]; stamp?: string; runFails?: boolean }): {
    status: number | null; out: string; paused: string; pausedAt: string; runs: string;
  } {
    const runs = path.join(tmp, "systemd-run.args");
    const script = [
      "set -euo pipefail",
      handbackSettings(),
      `systemctl() { if [ "$1" = show ]; then printf '%s\\n' ${JSON.stringify(opts.stamp ?? "")}; fi; return 0; }`,
      `systemd-run() { printf '%s\\n' "$@" > ${JSON.stringify(runs)}; return ${opts.runFails ? 1 : 0}; }`,
      `PAUSED_ENGINE_UNITS=(${opts.paused.join(" ")})`,
      "GATEWAY_PAUSED_FOR_BUILD_AT=1700000000",
      fn("disarm_gateway_handback"),
      fn("arm_gateway_handback"),
      fn("hand_paused_gateway_to_update"),
      "hand_paused_gateway_to_update",
      'echo "PAUSED=${PAUSED_ENGINE_UNITS[*]-}"',
      'echo "AT=$GATEWAY_PAUSED_FOR_BUILD_AT"',
    ].join("\n");
    const r = bash(script);
    const line = (k: string) => (r.out.split("\n").find((l) => l.startsWith(`${k}=`)) ?? "").slice(k.length + 1);
    return {
      status: r.status,
      out: r.out,
      paused: line("PAUSED"),
      pausedAt: line("AT"),
      runs: fs.existsSync(runs) ? fs.readFileSync(runs, "utf-8") : "",
    };
  }

  it("leaves the gateway stopped, keeps every other engine to resume, and arms the fallback", () => {
    const r = hand({ paused: ["ollama.service", "clawbox-gateway.service", "clawbox-embed.service"], stamp: "123456789" });
    expect(r.status).toBe(0);
    expect(r.paused).toBe("ollama.service clawbox-embed.service");
    // The pause is not reported as over: the gateway is still down.
    expect(r.pausedAt).toBe("");
    expect(r.out).toContain("Leaving clawbox-gateway.service stopped for the update's second half");
    expect(r.out).toContain("15 min");
    const args = r.runs.split("\n");
    expect(args).toContain("--unit=clawbox-gateway-handback");
    expect(args).toContain("--on-active=900s");
    expect(args).toContain("--collect");
    // The stamp the pause left travels to the timer as its $1.
    expect(args[args.length - 2]).toBe("123456789");
    expect(args).toContain("/bin/sh");
  });

  it.each([
    ["the timer cannot be armed", { stamp: "123456789", runFails: true }],
    ["the stop's stamp cannot be read", { stamp: "" }],
    ["the stop's stamp is zero", { stamp: "0" }],
  ])("starts the gateway again as before when %s", (_why, o) => {
    const r = hand({ paused: ["ollama.service", "clawbox-gateway.service"], ...o });
    expect(r.status).toBe(0);
    expect(r.paused).toBe("ollama.service clawbox-gateway.service");
    expect(r.pausedAt).toBe("1700000000");
    expect(r.out).toContain("starting clawbox-gateway.service again here as before");
  });

  it("does nothing when the build did not pause the gateway", () => {
    const r = hand({ paused: ["ollama.service"], stamp: "123456789" });
    expect(r.paused).toBe("ollama.service");
    expect(r.runs).toBe("");
    expect(r.out).toBe("PAUSED=ollama.service\nAT=1700000000\n");
  });

  it("does nothing with nothing paused", () => {
    const r = hand({ paused: [], stamp: "123456789" });
    expect(r.status).toBe(0);
    expect(r.runs).toBe("");
  });
});

d("the gateway's fallback start: only a gateway nobody has touched since the pause", () => {
  /** Runs GATEWAY_HANDBACK_SCRIPT the way the timer does, with a fake systemctl first on PATH. */
  function fire(box: { state: string; stamp: string; rootSteps?: string }, armed = "123456789"): { calls: string; out: string } {
    const bin = path.join(tmp, "bin");
    const calls = path.join(tmp, "systemctl.calls");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "systemctl"), [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'case "$*" in',
      `  *"-p ActiveState"*) echo ${JSON.stringify(box.state)} ;;`,
      `  *"-p InactiveEnterTimestampMonotonic"*) echo ${JSON.stringify(box.stamp)} ;;`,
      `  list-units*) printf '%s' ${JSON.stringify(box.rootSteps ?? "")} ;;`,
      "esac",
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    const script = [
      handbackSettings(),
      `PATH=${JSON.stringify(bin)}:$PATH /bin/sh -c "$GATEWAY_HANDBACK_SCRIPT" sh ${JSON.stringify(armed)}`,
    ].join("\n");
    const r = bash(script);
    return { calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8") : "", out: r.out };
  }

  const started = (calls: string) => calls.includes("start --no-block clawbox-gateway.service");

  it("starts a gateway still stopped by the pause, with no update step running", () => {
    const r = fire({ state: "inactive", stamp: "123456789" });
    expect(started(r.calls)).toBe(true);
    expect(r.out).toContain("nothing has started it since");
  });

  it("starts a gateway that failed to stop cleanly in the pause and was left so", () => {
    expect(started(fire({ state: "failed", stamp: "123456789" }).calls)).toBe(true);
  });

  it.each(["active", "activating", "deactivating"])("leaves a gateway that is %s alone", (state) => {
    expect(started(fire({ state, stamp: "123456789" }).calls)).toBe(false);
  });

  it("leaves a gateway something started and stopped since (gateway_verify, a swap, an operator)", () => {
    expect(started(fire({ state: "inactive", stamp: "999999999" }).calls)).toBe(false);
  });

  it("does nothing while a root update step runs", () => {
    const r = fire({ state: "inactive", stamp: "123456789", rootSteps: "clawbox-root-update@post_update.service loaded active running X\n" });
    expect(started(r.calls)).toBe(false);
  });

  it("does nothing without the stamp it was armed with", () => {
    expect(started(fire({ state: "inactive", stamp: "" }, "").calls)).toBe(false);
  });

  it("is one line with no ${…} and no %: systemd writes a transient unit's command into a unit file, and expands both", () => {
    const settings = handbackSettings();
    const line = settings.split("\n").find((l) => l.startsWith("GATEWAY_HANDBACK_SCRIPT='")) ?? "";
    // The whole value closes on its own line: a newline inside it split the
    // transient unit's ExecStart= on the first board run.
    expect(line).toMatch(/^GATEWAY_HANDBACK_SCRIPT='.*'$/);
    expect(line).not.toMatch(/\$\{/);
    expect(line).not.toContain("%");
  });
});

// ── 3. A stalled fetch is a failure to retry ────────────────────────────────

d("git_with_retry: a stalled transfer ends and is retried", () => {
  function run(env: Record<string, string> = {}, failures = 0, message = "fatal: unable to access 'https://example.invalid/': Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds"): {
    status: number | null; argv: string[]; attempts: number;
  } {
    const argvFile = path.join(tmp, "git.argv");
    const count = path.join(tmp, "git.count");
    const script = [
      "set -euo pipefail",
      `git() { printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}; n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(count)}; if [ "$n" -le ${failures} ]; then echo ${JSON.stringify(message)} >&2; return 128; fi; return 0; }`,
      "GIT_RUNNER=()",
      fn("git_retryable_failure"),
      fn("git_with_retry"),
      "git_with_retry -C /x fetch origin --quiet",
    ].join("\n");
    const r = bash(script, { CLAWBOX_GIT_RETRY_DELAY: "0", ...env });
    return {
      status: r.status,
      argv: fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf-8").trim().split("\n") : [],
      attempts: Number(fs.existsSync(count) ? fs.readFileSync(count, "utf-8").trim() : 0),
    };
  }

  it("bounds silence, not length: under 1000 B/s for 60 s ends the transfer", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.argv.slice(0, 4)).toEqual(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"]);
    // The caller's own arguments follow untouched.
    expect(r.argv.slice(4)).toEqual(["-C", "/x", "fetch", "origin", "--quiet"]);
  });

  it("takes the window from CLAWBOX_GIT_LOW_SPEED_TIME, and falls back on a value that is not a number", () => {
    expect(run({ CLAWBOX_GIT_LOW_SPEED_TIME: "30" }).argv).toContain("http.lowSpeedTime=30");
    expect(run({ CLAWBOX_GIT_LOW_SPEED_TIME: "soon" }).argv).toContain("http.lowSpeedTime=60");
  });

  it("retries the transfer the bound ended", () => {
    const r = run({}, 2);
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(3);
  });

  it("retries a stall git reports as a failed RPC as well", () => {
    const r = run({}, 1, "error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds");
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
  });
});

// ── 4. The note that tells the update's second half the build was kept ─────

d("record_rebuild_kept_build: the serving build's id, on the boot's own count", () => {
  let project: string;
  let note: string;

  beforeEach(() => {
    project = path.join(tmp, "clawbox");
    note = path.join(tmp, "run", "clawbox", "rebuild-kept-build");
  });

  function serve(buildId: string, nested = false): void {
    const tree = nested ? path.join(project, ".next", "standalone", "apps", "box") : path.join(project, ".next", "standalone");
    fs.mkdirSync(path.join(tree, ".next"), { recursive: true });
    fs.writeFileSync(path.join(tree, "server.js"), "// entry\n");
    fs.writeFileSync(path.join(tree, ".next", "BUILD_ID"), buildId);
    if (nested) fs.symlinkSync(path.join(tree, "server.js"), path.join(project, ".next", "standalone", "server.js"));
  }

  function record(): { status: number | null } {
    const start = INSTALL_SH.indexOf('\nREBUILD_KEPT_NOTE="');
    const end = INSTALL_SH.indexOf("\n", start + 1);
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      'as_clawbox() { "$@"; }',
      INSTALL_SH.slice(start + 1, end),
      fn("forget_rebuild_kept_build"),
      fn("record_rebuild_kept_build"),
      "record_rebuild_kept_build",
    ].join("\n");
    const r = bash(script, { CLAWBOX_REBUILD_KEPT_BUILD: note });
    return { status: r.status };
  }

  it("writes the serving build's BUILD_ID and the seconds since boot, readable by the web server", () => {
    serve("Fdx9fmcX3pnT8MkGe4OK3");
    expect(record().status).toBe(0);
    const [id, up] = fs.readFileSync(note, "utf-8").trim().split(" ");
    expect(id).toBe("Fdx9fmcX3pnT8MkGe4OK3");
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf-8").split(" ")[0]);
    expect(Number(up)).toBeGreaterThan(0);
    expect(Number(up)).toBeLessThanOrEqual(uptime + 1);
    expect(fs.statSync(note).mode & 0o777).toBe(0o644);
    // Nothing of the temp file it renamed into place is left beside it.
    expect(fs.readdirSync(path.dirname(note))).toEqual(["rebuild-kept-build"]);
  });

  it("follows the nested layout's entry link to the build that serves", () => {
    serve("nested-build", true);
    expect(record().status).toBe(0);
    expect(fs.readFileSync(note, "utf-8")).toMatch(/^nested-build \d/);
  });

  it.each([
    ["there is no standalone entry", () => fs.mkdirSync(project, { recursive: true })],
    ["the BUILD_ID is not one", () => serve("../../etc")],
  ])("writes nothing, and removes an older note, when %s", (_why, arrange) => {
    arrange();
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "older 1.0\n");
    expect(record().status).toBe(1);
    expect(fs.existsSync(note)).toBe(false);
  });
});

// ── 5. The cache is moved, not copied: it does not count twice ─────────────

d("set_previous_build_aside: room for two builds is judged without the cache", () => {
  function park(availKb: number, cacheKb: number): { status: number | null; parked: boolean; kept: boolean; out: string } {
    const project = path.join(tmp, "clawbox");
    const build = path.join(project, ".next");
    fs.mkdirSync(path.join(build, "standalone"), { recursive: true });
    fs.writeFileSync(path.join(build, "standalone", "server.js"), Buffer.alloc(100 * 1024, 1));
    if (cacheKb > 0) {
      fs.mkdirSync(path.join(build, "cache", "turbopack"), { recursive: true });
      fs.writeFileSync(path.join(build, "cache", "turbopack", "db"), Buffer.alloc(cacheKb * 1024, 1));
    }
    const script = [
      "set -euo pipefail",
      `df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 1 1 %s 1%% /\\n' ${availKb}; }`,
      fn("set_previous_build_aside"),
      `set_previous_build_aside ${JSON.stringify(build)} ${JSON.stringify(path.join(project, ".next-old"))}`,
    ].join("\n");
    const r = bash(script);
    return {
      status: r.status,
      parked: fs.existsSync(path.join(project, ".next-old", "standalone", "server.js")),
      kept: fs.existsSync(path.join(project, ".next-old", "cache", "turbopack", "db")),
      out: r.out + r.err,
    };
  }

  it("parks a build whose disk holds two builds once its cache is left out of the sum", () => {
    // ~100 KB of build and ~2 MB of cache, 1 MB free: twice the build fits,
    // twice build + cache would not.
    const r = park(1024, 2048);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("clearing the old one instead of keeping it");
    expect(r.parked).toBe(true);
    // The cache goes with the parked tree, for carry_build_cache to move on.
    expect(r.kept).toBe(true);
  });

  it("still clears the old build when even the build alone does not fit twice", () => {
    const r = park(150, 2048);
    expect(r.status).toBe(0);
    expect(r.out).toContain("clearing the old one instead of keeping it");
    expect(r.parked).toBe(false);
  });
});
