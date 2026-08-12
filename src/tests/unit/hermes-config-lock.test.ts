import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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
    const regTail = REGISTER_SRC.slice(REGISTER_SRC.indexOf("acquire_config_lock\n\nexport"));
    expect(regTail).toContain("acquire_config_lock");
    expect(REGISTER_SRC.indexOf("acquire_config_lock\n\nexport")).toBeLessThan(
      REGISTER_SRC.indexOf("tools disable browser"),
    );
    expect(AUTH_SRC).toContain("flock -w 120 9");
    expect(REGISTER_SRC).toContain("flock -w 120 9");
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
    // Hold the shared lock for ~800ms in the background, then run the auth
    // script. If it honours the lock it blocks until release (elapsed ≳ hold);
    // if it ignored it, it would finish in well under 300ms. This is the mutual
    // exclusion that stops the lost update.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lockwait-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Pre-seed a foreign writer's content; it must survive the auth script's
    // write (the auth script preserves unrelated top-level keys).
    fs.writeFileSync(configPath, "mcp_servers:\n  clawbox:\n    enabled: true\n");
    const lockFile = `${configPath}.lock`;

    // One bash driver so the holder and the auth script actually overlap: launch
    // a background holder that takes the lock for ~0.8s, wait 0.15s so it wins
    // the lock first, then run the auth script and time how long it blocks.
    const script = `
      set -e
      LOCK="${lockFile}"
      ( exec 9>"$LOCK"; flock 9; sleep 0.8 ) &
      hold=$!
      sleep 0.15                       # ensure the holder has the lock first
      start=$(date +%s.%N)
      CLAWBOX_ROOT="${root}" HERMES_CONFIG="${configPath}" bash "${AUTH}" >/dev/null 2>&1
      end=$(date +%s.%N)
      wait $hold
      awk -v s="$start" -v e="$end" 'BEGIN{printf "%.3f", e - s}'
    `;
    const proc = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 20000 });
    const elapsed = parseFloat(proc.stdout.trim() || "0");
    // Held ~0.8s, started ~0.15s in, so the auth script should wait ≳0.5s.
    expect(elapsed).toBeGreaterThan(0.5);

    // And the foreign writer's key survived alongside the new dashboard block.
    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toMatch(/^dashboard:/m);
    expect(config).toMatch(/^mcp_servers:/m);
  });
});
