import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";
import { shellFunctionIfPresent } from "@/tests/helpers/account-only-home";
import { rollBackCheckoutAfterFailedUpdate, UPDATE_ROLLBACK_KEY } from "@/lib/update-checkout-rollback";

/**
 * A failed rebuild puts the checkout back on the served build's commit, from
 * the shell of the NEW code (TASK-1427).
 *
 * The in-app rollback lives in the dashboard, so an update driven by an older
 * dashboard never runs it. step_rebuild_reboot is the new code's own step, so
 * the rollback there works whichever build is serving. These run the shipped
 * functions, sliced out of install.sh, against a throwaway git fixture; only
 * do_rebuild and the root-side steps around it are stubbed.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

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

let tmp: string;
let proj: string;
let npmPrefix: string;
let oldSha: string;
let newSha: string;

/** The OpenClaw pin each fixture commit carries, as config/openclaw-target.txt. */
const OLD_PIN = "2026.10.9";
const NEW_PIN = "2026.11.5";

/** The line install.sh defines `has_openclaw_harness` on, lifted as it is. */
const HAS_OPENCLAW_HARNESS = (() => {
  const m = /^has_openclaw_harness\(\) \{.*\}$/m.exec(INSTALL_SH);
  if (!m) throw new Error("has_openclaw_harness not found in install.sh");
  return m[0];
})();

/** The OpenClaw core installed in the fixture's npm prefix, as npm leaves its package.json. */
function core(version: string): void {
  const dir = path.join(npmPrefix, "lib", "node_modules", "openclaw");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "openclaw", version }));
}

function git(...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: proj,
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function stamp(commit: string | null): void {
  const dir = path.join(proj, ".next", "standalone", ".next");
  fs.mkdirSync(dir, { recursive: true });
  const info: Record<string, unknown> = { shortCommit: commit?.slice(0, 7) ?? null, branch: "beta" };
  if (commit !== null) info.commit = commit;
  fs.writeFileSync(path.join(dir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
}

/** step_rebuild_reboot with the root-side steps stubbed and do_rebuild exiting `rebuildRc`. */
function runStep(
  rebuildRc: number,
  rebuildBody?: string,
  { edition = "openclaw" }: { edition?: string } = {},
): { status: number | null; out: string } {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(proj)}`,
    `NPM_PREFIX=${JSON.stringify(npmPrefix)}`,
    `CLAWBOX_EDITION=${JSON.stringify(edition)}`,
    HAS_OPENCLAW_HARNESS,
    "as_clawbox() { \"$@\"; }",
    "is_test_mode() { return 0; }",
    "for s in step_directories_permissions step_systemd_services step_ollama_install step_openclaw_patch step_openclaw_config step_clawkeep_install step_polkit_rules; do eval \"$s() { :; }\"; done",
    "systemctl() { echo \"systemctl $*\"; }",
    rebuildBody ?? `do_rebuild() { echo do_rebuild; return ${rebuildRc}; }`,
    // The dispatcher's own EXIT trap, which the guard must chain to.
    "outer() { echo \"outer saw $?\"; }",
    "trap outer EXIT",
    "_REBUILD_PREV_EXIT_TRAP=\"\"",
    fn("_rebuild_trap_cmd"),
    fn("arm_rebuild_checkout_guard"),
    fn("disarm_rebuild_checkout_guard"),
    fn("rebuild_checkout_guard"),
    fn("served_build_commit"),
    shellFunctionIfPresent(INSTALL_SH, "openclaw_core_ahead_of_commit"),
    fn("restore_checkout_to_served_build"),
    // The rebuild skip (TASK-2517) has its own suite: here the build is never current.
    "forget_rebuild_kept_build() { :; }",
    "disarm_gateway_handback() { :; }",
    "record_rebuild_kept_build() { :; }",
    "build_is_current_for_checkout() { echo 'not current'; return 1; }",
    fn("step_rebuild_reboot"),
    "step_rebuild_reboot",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-1427-")));
  proj = path.join(tmp, "clawbox");
  npmPrefix = path.join(tmp, "npm-global");
  if (!CAN_RUN) return;
  fs.mkdirSync(path.join(proj, "config"), { recursive: true });
  git("init", "-q", "-b", "beta");
  fs.writeFileSync(path.join(proj, ".gitignore"), ".next/\ndata/\n");
  fs.writeFileSync(path.join(proj, "app.txt"), "4.1\n");
  fs.writeFileSync(path.join(proj, "install.sh"), "# 4.1\n");
  fs.writeFileSync(path.join(proj, "config", "openclaw-target.txt"), `${OLD_PIN}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "old");
  oldSha = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(proj, "app.txt"), "4.2\n");
  fs.writeFileSync(path.join(proj, "install.sh"), "# 4.2\n");
  fs.writeFileSync(path.join(proj, "config", "openclaw-target.txt"), `${NEW_PIN}\n`);
  git("commit", "-q", "-am", "new");
  newSha = git("rev-parse", "HEAD");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("step_rebuild_reboot: checkout follows the served build on failure", () => {
  it("moves the checkout back to the restored build's commit and keeps the failure", () => {
    stamp(oldSha);
    const r = runStep(3);
    expect(r.status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("beta");
    expect(fs.readFileSync(path.join(proj, "app.txt"), "utf-8")).toBe("4.1\n");
    expect(r.out).not.toContain("systemctl restart");
    expect(r.out).toContain("outer saw 3");
  });

  it("keeps errexit live inside do_rebuild", () => {
    stamp(oldSha);
    const r = runStep(0, "do_rebuild() { false; echo AFTER-FALSE; }");
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("AFTER-FALSE");
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("works from a detached HEAD", () => {
    git("checkout", "-q", "--detach", newSha);
    stamp(oldSha);
    expect(runStep(1).status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("leaves the checkout alone when the build succeeds", () => {
    stamp(oldSha);
    const r = runStep(0);
    expect(r.status).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(r.out).toContain("systemctl restart clawbox-setup.service");
    expect(r.out).toContain("outer saw 0");
  });

  it("leaves the checkout alone when the served build has no commit stamp", () => {
    stamp(null);
    expect(runStep(1).status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
  });

  it("leaves the checkout alone when the stamped commit is not in the repository", () => {
    stamp("f".repeat(40));
    const r = runStep(1);
    expect(r.status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(r.out).toContain("is not in this checkout");
  });

  it("does nothing when HEAD already is the served build", () => {
    stamp(newSha);
    const r = runStep(1);
    expect(r.status).toBe(1);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(r.out).not.toContain("Moving the checkout back");
  });
});

/**
 * An update that moves the OpenClaw core forward migrates its databases on the
 * way (doctor --fix, in step_openclaw_install), and the previous core is gone
 * by then. A failure after that point must not put the checkout back on a
 * commit that pins an older core: that commit's gateway pre-start, plugin pins
 * and dashboard would run against a core they were never released with. The
 * box stays on the new checkout with the old build — drift the dashboard
 * reports and the next update repairs.
 */
d("step_rebuild_reboot: never puts the checkout behind the installed OpenClaw core", () => {
  it("keeps the checkout on the new commit when the installed core is newer than the restored build's pin", () => {
    core(NEW_PIN);
    stamp(oldSha);
    const r = runStep(3);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(fs.readFileSync(path.join(proj, "app.txt"), "utf-8")).toBe("4.2\n");
    expect(r.status).toBe(3);
    expect(r.out).toContain(`Checkout left on ${newSha.slice(0, 7)}`);
    expect(r.out).not.toContain("Moving the checkout back");
    expect(r.out).toContain("outer saw 3");
  });

  it("leaves the tree root recorded, so the pinned root steps are not refused afterwards", () => {
    // The update's bootstrap records install.sh, scripts/ and config/ right
    // after it moves the tree (config/clawbox-root-manifest.sh); the root
    // dispatcher refuses every pinned step while the tree differs from that
    // record. Here the shipped helper, retargeted onto the fixture.
    const libexec = path.join(tmp, "libexec");
    const etc = path.join(tmp, "etc");
    fs.mkdirSync(libexec, { recursive: true });
    const helper = path.join(libexec, "clawbox-root-manifest.sh");
    let text = fs.readFileSync(path.join(REPO, "config", "clawbox-root-manifest.sh"), "utf-8");
    for (const [re, val] of [
      [/^PROJECT_DIR=.*$/m, `PROJECT_DIR="${proj}"`],
      [/^MANIFEST_DIR=.*$/m, `MANIFEST_DIR="${etc}"`],
      [/^MANIFEST_FILE=.*$/m, `MANIFEST_FILE="${path.join(etc, "root-exec.manifest")}"`],
      [/^MIRROR_DIR=.*$/m, `MIRROR_DIR="${path.join(tmp, "mirror")}"`],
    ] as const) {
      if (!re.test(text)) throw new Error(`constant ${re} not found in clawbox-root-manifest.sh`);
      text = text.replace(re, val);
    }
    // `install -o root -g root` needs root; the copy itself is what matters.
    fs.writeFileSync(helper, text.replace(/install (-d )?-o root -g root /g, "install $1"), { mode: 0o755 });
    const manifest = (verb: string) => spawnSync("bash", [helper, verb], { encoding: "utf-8" });
    expect(manifest("--write").status).toBe(0);

    core(NEW_PIN);
    stamp(oldSha);
    expect(runStep(3).status).toBe(3);
    expect(manifest("--verify").status).toBe(0);
  });

  it("still moves the checkout back when the core is at the restored build's pin", () => {
    core(OLD_PIN);
    stamp(oldSha);
    expect(runStep(3).status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("orders versions as versions: 2026.10.10 is newer than 2026.10.9", () => {
    core("2026.10.10");
    stamp(oldSha);
    expect(runStep(3).status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(newSha);
  });

  it("still moves the checkout back when the installed core is OLDER than the restored build's pin", () => {
    // 2026.9.30 sorts after 2026.10.9 as a string, before it as a version.
    core("2026.9.30");
    stamp(oldSha);
    expect(runStep(3).status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("still moves the checkout back when the core's version is not a plain release number", () => {
    // A dist-tag pin installs whatever npm chose; nothing proves it newer.
    core(`${NEW_PIN}-beta.1`);
    stamp(oldSha);
    expect(runStep(3).status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("still moves the checkout back on the Hermes edition, which runs no OpenClaw core", () => {
    core(NEW_PIN);
    stamp(oldSha);
    expect(runStep(3, undefined, { edition: "hermes" }).status).toBe(3);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });
});

/**
 * Before the rebuild, a failed update's checkout is moved back by the in-app
 * updater (src/lib/update-checkout-rollback.ts), from the target it recorded in
 * data/config.json before step 1 — on the first update from an older release,
 * by THAT release's copy, which nothing in this tree can change. So once the
 * core is past the served build's pin, install.sh drops the target, and the
 * rollback finds none.
 */
d("keep_checkout_with_installed_core: the in-app updater's rollback target", () => {
  const configPath = () => path.join(proj, "data", "config.json");
  const target = () => JSON.stringify({ commit: oldSha, branch: "beta", recordedAt: "2026-11-01T00:00:00.000Z" });

  /** data/config.json as the dashboard leaves it at step 1: 0600, its own two-space JSON. */
  function writeConfig(value: Record<string, unknown> | string): void {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  function runKeep(asClawbox = "as_clawbox() { \"$@\"; }"): { status: number | null; out: string; err: string } {
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(proj)}`,
      `NPM_PREFIX=${JSON.stringify(npmPrefix)}`,
      "CLAWBOX_EDITION=openclaw",
      HAS_OPENCLAW_HARNESS,
      asClawbox,
      fn("served_build_commit"),
      shellFunctionIfPresent(INSTALL_SH, "openclaw_core_ahead_of_commit"),
      shellFunctionIfPresent(INSTALL_SH, "keep_checkout_with_installed_core"),
      "keep_checkout_with_installed_core",
      "echo REACHED_END",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  /** The dashboard's own rollback, over the same git checkout and the same data/config.json. */
  function dashboardRollback() {
    const read = () => JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    return rollBackCheckoutAfterFailedUpdate({
      readState: async () => ({
        buildCommit: oldSha,
        head: git("rev-parse", "HEAD"),
        branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      }),
      git: async (args) => {
        git(...args);
      },
      get: async (key) => read()[key],
      set: async (key, value) => {
        const next = read();
        if (value === undefined) delete next[key];
        else next[key] = value;
        fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
      },
    });
  }

  it("drops the target once the core is newer than the served build's pin, so the dashboard leaves the checkout", async () => {
    const others = { setup_complete: true, telegram_bot_token: "123:abc", update_in_progress: true, note: "café ✓" };
    writeConfig({ ...others, [UPDATE_ROLLBACK_KEY]: target() });
    core(NEW_PIN);
    stamp(oldSha);
    const r = runKeep();

    const outcome = await dashboardRollback();
    expect(git("rev-parse", "HEAD")).toBe(newSha);
    expect(outcome).toEqual({ rolledBack: false, reason: "no-target" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("REACHED_END");
    expect(r.out).toContain("Dropped the updater's checkout rollback target");
    expect(r.out).toContain("from here a failed update leaves the checkout where it is");
    // Every other key kept, in the bytes the store itself writes, at its mode.
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(JSON.stringify(others, null, 2));
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(configPath()))).toEqual(["config.json"]);
  });

  it("never replaces a write the dashboard made between its read and its rename", () => {
    // The store rewrites data/config.json without a lock. Here a write lands
    // right after the new copy is written and before it would be renamed in.
    const preload = path.join(tmp, "store-writes-meanwhile.cjs");
    fs.writeFileSync(preload, [
      "const fs = require(\"fs\");",
      "const write = fs.writeFileSync;",
      "fs.writeFileSync = function (file, ...rest) {",
      "  const done = write.call(fs, file, ...rest);",
      "  if (String(file).endsWith(\".rollback\")) {",
      "    const store = JSON.parse(fs.readFileSync(process.env.CLAWBOX_CFG, \"utf8\"));",
      "    store.telegram_bot_token = \"456:changed\";",
      "    write.call(fs, process.env.CLAWBOX_CFG, JSON.stringify(store, null, 2));",
      "  }",
      "  return done;",
      "};",
    ].join("\n"));
    writeConfig({ telegram_bot_token: "123:abc", [UPDATE_ROLLBACK_KEY]: target() });
    core(NEW_PIN);
    stamp(oldSha);
    const r = runKeep(`as_clawbox() { NODE_OPTIONS="--require ${preload}" "$@"; }`);
    const after = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    expect(after.telegram_bot_token).toBe("456:changed");
    expect(after[UPDATE_ROLLBACK_KEY]).toBe(target());
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/could not rewrite .* \(it changed meanwhile\)/);
    expect(r.err).toMatch(/Warning: could not check or drop the updater's checkout rollback target/);
    expect(fs.readdirSync(path.dirname(configPath()))).toEqual(["config.json"]);
  });

  it("keeps the target while the core is at the served build's pin, and the dashboard moves the checkout back as before", async () => {
    const before = JSON.stringify({ setup_complete: true, [UPDATE_ROLLBACK_KEY]: target() }, null, 2);
    writeConfig(before);
    core(OLD_PIN);
    stamp(oldSha);
    const r = runKeep();
    expect(r.status, r.err).toBe(0);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);

    expect((await dashboardRollback()).rolledBack).toBe(true);
    expect(git("rev-parse", "HEAD")).toBe(oldSha);
  });

  it("never fails the step over a config it cannot read: the file stays as it is", () => {
    writeConfig("{ not json");
    core(NEW_PIN);
    stamp(oldSha);
    const r = runKeep();
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{ not json");
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("REACHED_END");
    expect(r.err).toMatch(/Warning: .*rollback target/);
  });
});
