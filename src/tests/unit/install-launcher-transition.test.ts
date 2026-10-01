import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";
import { UI_ROOT_STEPS, WEB_ROOT_STEPS, SELF_UPDATING_ROOT_STEPS } from "@/lib/root-steps";

/**
 * A box must never be stranded between two root-step contracts (TASK-1316).
 *
 * A customer's box ran a web build from before TASK-539 — every root step
 * started with a plain `systemctl start clawbox-root-update@<step>.service`,
 * authorised only by the polkit `manage-units` grant — over a tree from after
 * it. step_rebuild_reboot had removed that grant BEFORE its rebuild, the
 * rebuild failed and restored the old build, and from then on every update
 * died at step 1 with "Interactive authentication required". No update could
 * fix it: the update is what that server could no longer start.
 *
 * Pinned here, against the shipped shell:
 *   1. step_polkit_rules keeps the grant while the build a server would run
 *      still needs it, and removes it once it does not;
 *   2. step_rebuild_reboot removes it only after a verified rebuild;
 *   3. config/clawbox-build-heal.sh — root, at boot, no web-server privilege —
 *      finds a stranded box, heals it through the root dispatcher, and stops
 *      after a bounded number of recorded attempts;
 *   4. step_heal_build rebuilds, brings the root side up to the new build,
 *      restarts the web server onto it, and only then lets the grant go.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const HEAL_SH_PATH = path.join(REPO, "config", "clawbox-build-heal.sh");
const HEAL_SH = fs.readFileSync(HEAL_SH_PATH, "utf-8");
const HEAL_UNIT = fs.readFileSync(path.join(REPO, "config", "clawbox-build-heal.service"), "utf-8");
const DISPATCHER = fs.readFileSync(path.join(REPO, "config", "clawbox-root-step.sh"), "utf-8");
const LAUNCHER = fs.readFileSync(path.join(REPO, "config", "clawbox-run-root-step.sh"), "utf-8");
const NEW_PKLA = fs.readFileSync(path.join(REPO, "config", "49-clawbox-updates.pkla"), "utf-8");

/** What a box provisioned before TASK-539 carries (6b2adde's config/49-clawbox-updates.pkla). */
const OLD_PKLA = `[Allow clawbox to manage systemd units]
Identity=unix-user:clawbox
Action=org.freedesktop.systemd1.manage-units
ResultAny=yes
ResultInactive=yes
ResultActive=yes

${NEW_PKLA}`;

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

/** A whitespace-separated shell list assigned as NAME="..." in a script. */
function shellList(source: string, name: string): string[] {
  const m = new RegExp(`${name}="([^"]*)"`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1].split(/\s+/).filter(Boolean);
}

let tmp: string;
let project: string;
let home: string;
let shims: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-launcher-transition-")));
  project = path.join(tmp, "clawbox");
  home = path.join(tmp, "home");
  shims = path.join(tmp, "shims");
  fs.mkdirSync(home);
  fs.mkdirSync(shims);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A checkout, optionally with a web build on disk.
 *
 * `tree`: "launcher" ships config/clawbox-run-root-step.sh, as every tree from
 * TASK-539 on does; "legacy" does not. `build`: "launcher" compiles the
 * launcher path into its server code, "legacy" does not, "none" has no build.
 * `builtFrom`: "head" stamps the build with the checkout's HEAD, "other" with
 * an older commit, as a build left behind by an interrupted update is.
 */
function makeProject(opts: {
  tree: "launcher" | "legacy";
  build: "launcher" | "legacy" | "none";
  builtFrom?: "head" | "other";
  parked?: boolean;
}): { head: string } {
  fs.mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  write(path.join(project, ".gitignore"), ".next/\n.next-old/\n");
  write(path.join(project, "install.sh"), "echo tree\n");
  if (opts.tree === "launcher") write(path.join(project, "config", "clawbox-run-root-step.sh"), "#!/bin/sh\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const first = git(project, "rev-parse", "HEAD");
  write(path.join(project, "README"), "second\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "second");
  const head = git(project, "rev-parse", "HEAD");
  if (opts.build !== "none") {
    const standalone = path.join(project, opts.parked ? ".next-old" : ".next", "standalone");
    write(path.join(standalone, "server.js"), "require('./.next/server/app.js');\n");
    write(
      path.join(standalone, ".next", "server", "chunks", "ssr", "updater.js"),
      opts.build === "launcher"
        ? 'const a=["-n","/usr/local/libexec/clawbox/clawbox-run-root-step.sh"];'
        : 'execFile("/usr/bin/systemctl",["start",`clawbox-root-update@${s}.service`]);',
    );
    const commit = opts.builtFrom === "other" ? first : head;
    write(
      path.join(standalone, ".next", "build-info.json"),
      `${JSON.stringify({ commit, shortCommit: commit.slice(0, 7), branch: "main" }, null, 2)}\n`,
    );
  }
  return { head };
}

// ── 1. step_polkit_rules ────────────────────────────────────────────────────

d("step_polkit_rules keeps the old grant exactly as long as the web build needs it", () => {
  function runPolkit(installed: string | null): { status: number; out: string; pkla: string } {
    const src = path.join(tmp, "src");
    write(path.join(src, "config", "49-clawbox-updates.pkla"), NEW_PKLA);
    write(path.join(src, "config", "clawbox-build-heal.sh"), HEAL_SH, 0o755);
    const polkit = path.join(tmp, "polkit-1");
    const pkla = path.join(polkit, "localauthority", "50-local.d", "49-clawbox-updates.pkla");
    if (installed !== null) write(pkla, installed);
    else fs.rmSync(pkla, { force: true });
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `SRC_DIR=${JSON.stringify(src)}`,
      'install_root_file() { cp "$1" "$2"; }',
      fn("web_build_uses_root_step_launcher"),
      fn("step_polkit_rules").split("/etc/polkit-1").join(polkit),
      "step_polkit_rules",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: testEnv({ PATH: process.env.PATH ?? "", HOME: home }) });
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, pkla: fs.readFileSync(pkla, "utf-8") };
  }

  it("KEEPS the grant while the web build on disk predates the launcher", () => {
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    const r = runPolkit(OLD_PKLA);
    expect(r.status, r.out).toBe(0);
    expect(r.pkla).toBe(OLD_PKLA);
    expect(r.out).toContain("Keeping the old polkit manage-units grant for now");
  });

  it("keeps it for a parked pre-launcher build too — the one production-server.js reclaims at boot", () => {
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other", parked: true });
    const r = runPolkit(OLD_PKLA);
    expect(r.status, r.out).toBe(0);
    expect(r.pkla).toBe(OLD_PKLA);
  });

  it("removes it once the build on disk uses the launcher", () => {
    makeProject({ tree: "launcher", build: "launcher" });
    const r = runPolkit(OLD_PKLA);
    expect(r.status, r.out).toBe(0);
    expect(r.pkla).toBe(NEW_PKLA);
    expect(r.pkla).not.toContain("manage-units");
  });

  it("removes it when there is no build at all — nothing depends on it", () => {
    makeProject({ tree: "launcher", build: "none" });
    const r = runPolkit(OLD_PKLA);
    expect(r.status, r.out).toBe(0);
    expect(r.pkla).not.toContain("manage-units");
  });

  it("never ADDS the grant: a box without it gets the narrow file whatever the build", () => {
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    expect(runPolkit(NEW_PKLA).pkla).toBe(NEW_PKLA);
    fs.rmSync(project, { recursive: true, force: true });
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    expect(runPolkit(null).pkla).toBe(NEW_PKLA);
  });

  it("the shipped .pkla itself grants no manage-units", () => {
    expect(NEW_PKLA).not.toContain("manage-units");
  });
});

// ── 2. step_rebuild_reboot ──────────────────────────────────────────────────

d("step_rebuild_reboot removes the grant only after a verified rebuild", () => {
  function runRebuildReboot(rebuildRc: number, testMode: boolean): { status: number; events: string[] } {
    const events = path.join(tmp, "events");
    const log = (name: string) => `${name}() { echo ${name} >> ${JSON.stringify(events)}; }`;
    const script = [
      "set -euo pipefail",
      ...["step_directories_permissions", "step_systemd_services", "step_ollama_install", "step_openclaw_patch",
        "step_openclaw_config", "step_clawkeep_install", "step_polkit_rules", "reboot"].map(log),
      `do_rebuild() { echo "do_rebuild $*" >> ${JSON.stringify(events)}; return ${rebuildRc}; }`,
      `systemctl() { echo "systemctl $*" >> ${JSON.stringify(events)}; }`,
      `is_test_mode() { return ${testMode ? 0 : 1}; }`,
      fn("step_rebuild_reboot"),
      "step_rebuild_reboot",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf-8").split("\n").filter(Boolean) : [];
    return { status: r.status ?? -1, events: lines };
  }

  it("rebuilds, THEN narrows polkit, then reboots", () => {
    const r = runRebuildReboot(0, false);
    expect(r.status).toBe(0);
    const at = (e: string) => r.events.findIndex((l) => l.startsWith(e));
    expect(at("do_rebuild --reboot-follows")).toBeGreaterThan(-1);
    expect(at("step_polkit_rules")).toBeGreaterThan(at("do_rebuild"));
    expect(at("reboot")).toBeGreaterThan(at("step_polkit_rules"));
  });

  it("leaves the old build's grant alone when the rebuild fails", () => {
    const r = runRebuildReboot(137, false);
    expect(r.status).toBe(137);
    expect(r.events).not.toContain("step_polkit_rules");
    expect(r.events).not.toContain("reboot");
  });

  it("does the same on the test-mode arm, before the restart", () => {
    const r = runRebuildReboot(0, true);
    expect(r.status).toBe(0);
    const at = (e: string) => r.events.findIndex((l) => l.startsWith(e));
    expect(at("step_polkit_rules")).toBeGreaterThan(at("do_rebuild"));
    expect(at("systemctl restart clawbox-setup.service")).toBeGreaterThan(at("step_polkit_rules"));
  });

  it("post_update asks again, after the units and grants are in place", () => {
    const body = fn("step_post_update");
    expect(body).toContain("optional_step polkit_rules step_polkit_rules");
    expect(body.indexOf("optional_step polkit_rules")).toBeGreaterThan(body.indexOf("optional_step systemd_services"));
  });

  it("the legacy handover still rebuilds before it narrows", () => {
    const body = fn("handover_legacy_updater");
    expect(body.indexOf("do_rebuild")).toBeLessThan(body.indexOf("step_polkit_rules"));
  });
});

// ── 3. config/clawbox-build-heal.sh ─────────────────────────────────────────

d("clawbox-build-heal.sh heals a stranded box at boot, within bounds", () => {
  let libexec: string;
  let sudoers: string;
  let state: string;
  let dispatchLog: string;
  let script: string;

  /** The shipped script with its literals pointed at the fixture. */
  function stage(dispatchRc = 0): void {
    libexec = path.join(tmp, "libexec");
    sudoers = path.join(tmp, "sudoers.d", "clawbox");
    state = path.join(tmp, "var-lib-clawbox");
    dispatchLog = path.join(tmp, "dispatched");
    write(
      path.join(libexec, "clawbox-root-step.sh"),
      `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(dispatchLog)}\nexit ${dispatchRc}\n`,
      0o755,
    );
    script = path.join(tmp, "clawbox-build-heal.sh");
    write(
      script,
      HEAL_SH
        .replace('PROJECT_DIR="/home/clawbox/clawbox"', `PROJECT_DIR=${JSON.stringify(project)}`)
        .replace('LIBEXEC_DIR="/usr/local/libexec/clawbox"', `LIBEXEC_DIR=${JSON.stringify(libexec)}`)
        .replace('SUDOERS_DROPIN="/etc/sudoers.d/clawbox"', `SUDOERS_DROPIN=${JSON.stringify(sudoers)}`)
        .replace('STATE_DIR="/var/lib/clawbox"', `STATE_DIR=${JSON.stringify(state)}`),
      0o755,
    );
    // The boot arm runs as root; the runner is not. `id -u` answers 0 and
    // `runuser` runs its command as the caller, which owns the fixture.
    const realId = spawnSync("bash", ["-c", "command -v id"], { encoding: "utf-8" }).stdout.trim();
    write(path.join(shims, "id"), `#!/usr/bin/env bash\nif [ "$#" = 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi\nexec ${realId} "$@"\n`, 0o755);
    write(path.join(shims, "runuser"), '#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', 0o755);
    // install -o root is EPERM for the runner; the directory is what matters.
    write(path.join(shims, "install"), '#!/usr/bin/env bash\nfor a; do d="$a"; done\nmkdir -p "$d"\n', 0o755);
  }

  /** The launcher and its grant, as step_systemd_services installs them. */
  function rootContract(launcher = true, grant = true): void {
    if (launcher) write(path.join(libexec, "clawbox-run-root-step.sh"), "#!/bin/sh\n", 0o755);
    write(sudoers, grant
      ? `clawbox ALL=(root) NOPASSWD: ${path.join(libexec, "clawbox-run-root-step.sh")}\n`
      : "clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n");
  }

  function heal(...args: string[]): { status: number; out: string; dispatched: string[] } {
    const r = spawnSync("bash", [script, ...args], {
      encoding: "utf-8",
      env: testEnv({ PATH: `${shims}:${process.env.PATH ?? ""}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
    });
    const dispatched = fs.existsSync(dispatchLog)
      ? fs.readFileSync(dispatchLog, "utf-8").split("\n").filter(Boolean)
      : [];
    return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, dispatched };
  }

  function stateOf(): Record<string, string> {
    const file = path.join(state, "build-heal.state");
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(
      fs.readFileSync(file, "utf-8").split("\n").filter((l) => /^[a-z_]+=/.test(l)).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
  }

  it("does nothing on a healthy box — no dispatch, no record", () => {
    stage();
    makeProject({ tree: "launcher", build: "launcher" });
    rootContract();
    const r = heal();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("nothing to do");
    expect(r.dispatched).toEqual([]);
    expect(fs.existsSync(path.join(state, "build-heal.state"))).toBe(false);
  });

  it("heals the customer's state: a pre-launcher build over a launcher tree", () => {
    stage();
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    rootContract();
    const r = heal();
    expect(r.status, r.out).toBe(0);
    expect(r.dispatched).toEqual(["heal_build"]);
    expect(r.out).toContain("stale-build");
    const s = stateOf();
    expect(s.kind).toBe("stale-build");
    expect(s.attempts).toBe("1");
    expect(s.last_result).toBe("healed");
    expect(s.tree).toBe(git(project, "rev-parse", "HEAD"));
  });

  it("is bounded: two failed attempts per commit, then it stops and says how to repair by hand", () => {
    stage(1);
    const { head } = makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    rootContract();
    expect(heal().status).toBe(1);
    expect(stateOf().attempts).toBe("1");
    expect(stateOf().last_result).toContain("failed (exit 1)");
    expect(heal().status).toBe(1);
    expect(stateOf().attempts).toBe("2");

    const third = heal();
    expect(third.status).toBe(0);
    expect(third.dispatched).toHaveLength(2);
    expect(third.out).toContain("NOT retrying");
    expect(third.out).toContain("--step heal_build");
    expect(stateOf().attempts).toBe("2");

    // A new commit on disk (a fix pulled in) starts the count again.
    write(path.join(project, "fix"), "fixed\n");
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "fix");
    expect(git(project, "rev-parse", "HEAD")).not.toBe(head);
    const fourth = heal();
    expect(fourth.dispatched).toHaveLength(3);
    expect(stateOf().attempts).toBe("1");
  });

  it("records a dispatcher refusal as one, with the command that repairs it", () => {
    stage(65);
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    rootContract();
    const r = heal();
    expect(r.status).toBe(65);
    expect(stateOf().last_result).toMatch(/^refused by the root-step dispatcher \(exit 65\).*--step heal_build/);
  });

  it("leaves a box alone whose build and tree BOTH predate the launcher", () => {
    stage();
    makeProject({ tree: "legacy", build: "legacy", builtFrom: "other" });
    const r = heal();
    expect(r.status, r.out).toBe(0);
    expect(r.dispatched).toEqual([]);
  });

  it("leaves a box with no build to the installer", () => {
    stage();
    makeProject({ tree: "launcher", build: "none" });
    rootContract();
    const r = heal();
    expect(r.status, r.out).toBe(0);
    expect(r.dispatched).toEqual([]);
  });

  it("heals the reverse strand too: a launcher build whose launcher or grant is missing", () => {
    stage();
    makeProject({ tree: "launcher", build: "launcher" });
    rootContract(false, true);
    expect(heal().dispatched).toEqual(["heal_build"]);
    expect(stateOf().kind).toBe("root-contract-missing");

    fs.rmSync(dispatchLog, { force: true });
    fs.rmSync(state, { recursive: true, force: true });
    rootContract(true, false);
    const r = heal();
    expect(r.dispatched).toEqual(["heal_build"]);
    expect(r.out).toContain("does not grant");
  });

  it("answers the two questions install.sh asks it", () => {
    stage();
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    rootContract();
    expect(heal("--build-uses-launcher", project).status).toBe(1);
    const check = heal("--check", project);
    expect(check.status).toBe(0);
    expect(check.out).toMatch(/^stale-build: /);
    expect(check.dispatched).toEqual([]);

    fs.rmSync(project, { recursive: true, force: true });
    makeProject({ tree: "launcher", build: "none" });
    expect(heal("--build-uses-launcher", project).status).toBe(0);
  });

  it("will not run its boot arm unprivileged", () => {
    stage();
    fs.rmSync(path.join(shims, "id"));
    makeProject({ tree: "launcher", build: "legacy", builtFrom: "other" });
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) return;
    const r = heal();
    expect(r.status).toBe(64);
    expect(r.dispatched).toEqual([]);
  });
});

// ── 4. step_heal_build ──────────────────────────────────────────────────────

d("step_heal_build: rebuild, root side, restart — and only then the grant", () => {
  function runStep(verdicts: string[], rebuildRc = 0): { status: number; events: string[]; out: string } {
    const events = path.join(tmp, "events");
    const counter = path.join(tmp, "checks");
    const src = path.join(tmp, "src");
    // The probe answers from a queue, one verdict per `--check`: what the heal
    // sees before it runs and after.
    const queue = verdicts.map((v, i) => `  ${i}) echo ${JSON.stringify(v.replace(/^healthy:?\s*/, "healthy: "))}; exit ${v.startsWith("healthy") ? 1 : 0} ;;`).join("\n");
    write(path.join(src, "config", "clawbox-build-heal.sh"), [
      "#!/usr/bin/env bash",
      `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0); echo $((n + 1)) > ${JSON.stringify(counter)}`,
      'case "$n" in',
      queue,
      '  *) echo "healthy: done"; exit 1 ;;',
      "esac",
    ].join("\n"), 0o755);
    const log = (name: string) => `${name}() { echo ${name} >> ${JSON.stringify(events)}; }`;
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `SRC_DIR=${JSON.stringify(src)}`,
      log("step_systemd_services"),
      log("step_polkit_rules"),
      `do_rebuild() { echo do_rebuild >> ${JSON.stringify(events)}; return ${rebuildRc}; }`,
      `systemctl() { echo "systemctl $*" >> ${JSON.stringify(events)}; }`,
      fn("step_heal_build"),
      "step_heal_build",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf-8").split("\n").filter(Boolean) : [];
    return { status: r.status ?? -1, events: lines, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("heals a stale build in the order that never strands the web server", () => {
    const r = runStep(["stale-build: old", "healthy"]);
    expect(r.status, r.out).toBe(0);
    expect(r.events).toEqual([
      "do_rebuild",
      "step_systemd_services",
      "systemctl reset-failed clawbox-setup.service",
      "systemctl restart clawbox-setup.service",
      "step_polkit_rules",
    ]);
  });

  it("stops at a failed rebuild with nothing else touched", () => {
    const r = runStep(["stale-build: old"], 1);
    expect(r.status).toBe(1);
    expect(r.events).toEqual(["do_rebuild"]);
  });

  it("repairs a missing root contract without rebuilding or restarting anything", () => {
    const r = runStep(["root-contract-missing: no launcher", "healthy"]);
    expect(r.status, r.out).toBe(0);
    expect(r.events).toEqual(["step_systemd_services", "step_polkit_rules"]);
  });

  it("does nothing on a healthy box", () => {
    const r = runStep(["healthy"]);
    expect(r.status, r.out).toBe(0);
    expect(r.events).toEqual([]);
    expect(r.out).toContain("Nothing to heal");
  });

  it("fails loudly when the box still needs healing afterwards", () => {
    const r = runStep(["stale-build: old", "stale-build: still old"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("still needs healing");
  });
});

// ── 5. The privilege boundary around the heal ───────────────────────────────

describe("the heal adds no privilege and no new way in", () => {
  it("is a dispatchable, PINNED step that the web server cannot start", () => {
    const dispatch = /DISPATCH_STEPS=\(([\s\S]*?)\n\)/.exec(INSTALL_SH)?.[1] ?? "";
    expect(dispatch.split(/\s+/)).toContain("heal_build");
    expect(shellList(DISPATCHER, "ALLOWED_STEPS")).toContain("heal_build");
    expect(shellList(DISPATCHER, "SELF_UPDATING_STEPS")).not.toContain("heal_build");
    expect(shellList(LAUNCHER, "WEB_ROOT_STEPS")).not.toContain("heal_build");
    expect([...WEB_ROOT_STEPS]).not.toContain("heal_build");
    expect([...UI_ROOT_STEPS]).not.toContain("heal_build");
    expect([...SELF_UPDATING_ROOT_STEPS]).not.toContain("heal_build");
    expect(fs.readFileSync(path.join(REPO, "config", "clawbox-sudoers"), "utf-8")).not.toContain("clawbox-build-heal");
  });

  it("runs from a root-owned path at boot, installed by install_root_libexec", () => {
    expect(HEAL_UNIT).toMatch(/^ExecStart=\/usr\/local\/libexec\/clawbox\/clawbox-build-heal\.sh$/m);
    expect(HEAL_UNIT).toMatch(/^WantedBy=multi-user\.target$/m);
    expect(HEAL_UNIT).not.toMatch(/^User=/m);
    // Not ordered against the web server: the heal restarts it itself.
    expect(HEAL_UNIT).not.toMatch(/^(After|Before|Requires|Wants)=.*clawbox-setup/m);
    expect(fn("install_root_libexec")).toContain("clawbox-build-heal.sh");
    const installed = /EXPECTED_INSTALLED_SERVICES=\(([\s\S]*?)\n\)/.exec(INSTALL_SH)?.[1] ?? "";
    expect(installed).toContain("clawbox-build-heal.service");
  });

  it("dispatches through the root dispatcher and never re-adds the grant", () => {
    expect(HEAL_SH).toContain('"$DISPATCHER" heal_build');
    // Code, not the comments that explain the grant it exists to outlive.
    const code = HEAL_SH.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/manage-units|polkit|\.pkla/);
    // Reads the sudoers drop-in; writes nothing under /etc.
    expect(code).not.toMatch(/>\s*"?\$SUDOERS_DROPIN/);
    // It reads git as the tree's owner, never as root.
    expect(HEAL_SH).toMatch(/runuser -u "\$owner" -- git/);
  });
});
