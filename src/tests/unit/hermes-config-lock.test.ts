import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ~/.hermes/config.yaml has MORE THAN ONE writer. At install time the auth
 * script (setup-hermes-dashboard-auth.sh) and the MCP registrar
 * (register-mcp.sh, fire-and-forgotten by production-server.js on the
 * clawbox-setup restart) both read-modify-write it seconds apart. Whichever one
 * snapshotted the file first and wrote last silently erased the other's block —
 * a lost update. That is what erased the dashboard block between the auth
 * script's write and its verify, making it look like the credentials were wrong.
 *
 * The fix is a single flock both scripts take, derived from the SAME config
 * path so they always collide on one lock file. These pin the contract and the
 * runtime behaviour.
 */
const REPO = process.cwd();
const AUTH = path.join(REPO, "scripts", "setup-hermes-dashboard-auth.sh");
const REGISTER = path.join(REPO, "scripts", "register-mcp.sh");
const AUTH_SRC = fs.readFileSync(AUTH, "utf-8");
const REGISTER_SRC = fs.readFileSync(REGISTER, "utf-8");

const RUNNABLE =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf-8" }).status === 0;
const FLOCK =
  RUNNABLE && spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf-8" }).status === 0;

describe("both writers share ONE lock file", () => {
  it("derive the lock from the same config path, so they collide", () => {
    // Same right-hand side in both scripts => same absolute lock file for the
    // same config. If one ever changes this expression, they stop excluding
    // each other and the lost update comes back.
    expect(AUTH_SRC).toContain('CONFIG_LOCK="${HERMES_CONFIG}.lock"');
    expect(REGISTER_SRC).toContain('CONFIG_LOCK="${HERMES_CONFIG}.lock"');
  });

  it("both take the lock before they touch config.yaml", () => {
    // The auth script acquires before its mint; the registrar acquires before
    // its PyYAML reconcile AND holds it across the `hermes tools disable` CLI
    // call (which does its own wide load->save_config on the same file).
    expect(AUTH_SRC).toMatch(/acquire_config_lock[\s\S]*mint_credentials/);

    // Locate the registrar's CALL SITE with an anchored regex: a bare
    // `acquire_config_lock` line at column 0. That cannot match the DEFINITION
    // (`acquire_config_lock() {`) and does not depend on what happens to follow
    // it, unlike the old "acquire_config_lock\n\nexport" formatting marker.
    const call = REGISTER_SRC.search(/^acquire_config_lock[ \t]*$/m);
    // The registrar's two writes of config.yaml: the PyYAML reconcile, and the
    // Hermes CLI call that does its own load->save_config. The lock has to come
    // before BOTH — "before the CLI call" alone was satisfied by taking it one
    // line above, leaving the reconcile unprotected.
    const reconcile = REGISTER_SRC.search(/^export CLAWBOX_MCP_HERMES_CONFIG=/m);
    // Anchored at column 0 and on the binary, and on NOTHING that wraps the
    // call. The wrapper has now moved twice — `if "$HERMES_BIN" …`, then
    // `if timeout -k 5 … "$HERMES_BIN" …`, then a brace group whose status is
    // captured — and each time a marker that pinned the wrapper stopped
    // matching. Both times the -1 guard below is what caught it, which is the
    // argument for keeping the marker as loose as the ordering claim needs.
    const cliCall = REGISTER_SRC.search(/^.*"\$HERMES_BIN" tools disable browser/m);
    // Every marker must have been FOUND before their order means anything: a
    // `search` miss returns -1, and -1 < anything, so an ordering assertion over
    // a moved marker passes while checking nothing.
    expect(call, "register-mcp.sh: no top-level acquire_config_lock call").toBeGreaterThan(-1);
    expect(reconcile, "register-mcp.sh: no PyYAML reconcile block").toBeGreaterThan(-1);
    expect(cliCall, "register-mcp.sh: no `hermes tools disable browser` call").toBeGreaterThan(-1);
    expect(call).toBeLessThan(reconcile);
    expect(call).toBeLessThan(cliCall);

    expect(AUTH_SRC).toContain("flock -w 120 9");
    expect(REGISTER_SRC).toContain("flock -w 120 9");
  });

  it("bounds EVERY hermes invocation with a SIGKILL grace, so no survivor keeps fd 9", () => {
    // This is a LOCK invariant, which is why it lives here. Both `hermes` calls
    // run inside the fd-9 critical section, and a child inherits that fd: a
    // `hermes` that ignores SIGTERM outlives `timeout` and goes on holding
    // ~/.hermes/config.yaml.lock after this script has exited, leaving
    // setup-hermes-dashboard-auth.sh to burn its 120 s wait and then write
    // UNLOCKED — the lost update this whole file exists to prevent, with the
    // lock in place and doing nothing. Plain `timeout` sends SIGTERM only, so
    // the `-k` grace is what actually ends such a child.
    //
    // The sweep is over the WHOLE file rather than the critical section, which
    // is the stronger rule and the one worth keeping: a `hermes` call added
    // outside the lock inherits fd 9 just the same, because the `exec 9>` that
    // opens it is inherited by every later child.
    //
    // An INVOCATION is the binary followed by a word — a subcommand or a flag.
    // Every spelling of the expansion counts, because "EVERY hermes call" is
    // what this claims: `"$HERMES_BIN"`, `${HERMES_BIN}`, and the bare
    // `$HERMES_BIN` a future edit might reach for. The two things that are NOT
    // invocations are excluded by name rather than by an accident of quoting,
    // so a change to either fails here instead of quietly widening the sweep:
    // the `[ ! -x "$HERMES_BIN" ]` executable guard and the `HERMES_BIN=`
    // assignment.
    const calls = REGISTER_SRC.split("\n").filter(
      (line) =>
        /\$\{?HERMES_BIN\}?"?\s+[a-z-]/.test(line)
        && !/^\s*#/.test(line)
        && !/\[\s*!?\s*-[a-z]\s+"?\$\{?HERMES_BIN/.test(line)
        && !/^\s*HERMES_BIN=/.test(line),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line, `unbounded hermes call: ${line.trim()}`).toMatch(/timeout -k \d+ /);
    }
  });

  it("keeps the exec that opens the lock fd free of a stderr redirect", () => {
    // Redirections on `exec` are permanent: `exec 9>file 2>/dev/null` would
    // silence the whole script and hide every error message. Guard against that
    // exact regression in both scripts.
    expect(AUTH_SRC).not.toMatch(/exec 9>"\$CONFIG_LOCK"\s+2>/);
    expect(REGISTER_SRC).not.toMatch(/exec 9>"\$CONFIG_LOCK"\s+2>/);
    expect(AUTH_SRC).toContain('exec 9>"$CONFIG_LOCK"');
    expect(REGISTER_SRC).toContain('exec 9>"$CONFIG_LOCK"');
  });
});

describe.runIf(RUNNABLE)("the lock is really taken at runtime", () => {
  it("opens the lock file beside the config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lock-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    const proc = spawnSync("bash", [AUTH], {
      encoding: "utf-8",
      env: { ...process.env, CLAWBOX_ROOT: root, HERMES_CONFIG: configPath },
    });
    expect(proc.status, proc.stderr).toBe(0);
    // The lock file exists next to the config (it is opened even on the happy
    // path). On a box without flock the script logs and skips — tolerate that.
    if (FLOCK) expect(fs.existsSync(`${configPath}.lock`)).toBe(true);
  });

  it.runIf(FLOCK)("waits for a held lock instead of racing through it", () => {
    // Timed in THIS process, not in the shell: `date +%s.%N` is a GNU coreutils
    // extension, and on BSD/macOS date `%N` is emitted literally, so the old
    // driver parsed "1770000000.N" and failed for a reason that had nothing to
    // do with the lock. The suite gates only on platform !== "win32", so it runs
    // there. And only the auth script's OWN duration is measured — timing the
    // whole driver, including `wait` on the holder, would report ≈ the hold
    // time whether or not the script honoured the lock.
    const HOLD_S = 1.5;

    // Calibrate: what one UNCONTENDED run of this script costs on this machine.
    // The assertion below is "honouring the lock adds most of the hold ON TOP of
    // that", so it cannot be satisfied by a slow interpreter. Twice, keeping the
    // faster: the first run in a fresh process pays cold-start costs (bash,
    // python, page cache) that the contended run no longer pays, and a cold
    // baseline would eat the margin and fail for the wrong reason.
    const timeUncontendedRun = () => {
      const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lockbase-"));
      const baseConfig = path.join(baseRoot, "hermes", "config.yaml");
      fs.mkdirSync(path.dirname(baseConfig), { recursive: true });
      fs.writeFileSync(baseConfig, "mcp_servers:\n  clawbox:\n    enabled: true\n");
      const baseStart = Date.now();
      const baseProc = spawnSync("bash", [AUTH], {
        encoding: "utf-8",
        timeout: 20000,
        env: { ...process.env, CLAWBOX_ROOT: baseRoot, HERMES_CONFIG: baseConfig },
      });
      const ms = Date.now() - baseStart;
      expect(baseProc.status, baseProc.stderr).toBe(0);
      return ms;
    };
    const uncontendedMs = Math.min(timeUncontendedRun(), timeUncontendedRun());

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lockwait-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Pre-seed a foreign writer's content; it must survive the auth script's
    // write (the auth script preserves unrelated top-level keys).
    fs.writeFileSync(configPath, "mcp_servers:\n  clawbox:\n    enabled: true\n");
    const lockFile = `${configPath}.lock`;

    // Background holder: takes the shared lock and keeps it for HOLD_S.
    const holder = spawn("bash", ["-c", `exec 9>"${lockFile}"; flock 9; sleep ${HOLD_S}`], {
      stdio: "ignore",
    });
    holder.on("error", () => {});
    try {
      // Do not GUESS that the holder has the lock — prove it, by probing with a
      // non-blocking flock until the probe is refused. A sleep-and-hope here is
      // how this test would start measuring nothing on a loaded machine.
      const deadline = Date.now() + 5000;
      let held = false;
      while (Date.now() < deadline) {
        const probe = spawnSync("bash", ["-c", `exec 9>"${lockFile}"; flock -n 9`], {
          encoding: "utf-8",
        });
        if (probe.status !== 0) {
          held = true;
          break;
        }
      }
      expect(held, "the background holder never took the lock").toBe(true);

      const start = Date.now();
      const proc = spawnSync("bash", [AUTH], {
        encoding: "utf-8",
        timeout: 20000,
        env: { ...process.env, CLAWBOX_ROOT: root, HERMES_CONFIG: configPath },
      });
      const contendedMs = Date.now() - start;
      expect(proc.status, proc.stderr).toBe(0);
      // Held 1.5s and the script started while it was held, so honouring the
      // lock costs ≳1.4s more than the uncontended run. Ignoring it would cost
      // about the same as the uncontended run. 500ms separates those cleanly.
      expect(contendedMs - uncontendedMs).toBeGreaterThan(500);
    } finally {
      holder.kill();
    }

    // And the foreign writer's key survived alongside the new dashboard block.
    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toMatch(/^dashboard:/m);
    expect(config).toMatch(/^mcp_servers:/m);
  });
});
