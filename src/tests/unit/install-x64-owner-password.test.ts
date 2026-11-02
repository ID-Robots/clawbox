import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs bash and python3: vitest's 5 s default is not enough on a loaded CI
// runner (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A PC's first-boot wizard, when its account already has a password.
 *
 * The app's gates read two sources. The routes behind the wizard ask
 * deviceHasOwner(), which reads /etc/shadow; middleware, the wizard and /login
 * read `password_configured` in data/config.json. On a PC installed by
 * install-x64.sh the install user is a real desktop account with the password
 * its owner chose — an owner by /etc/shadow from the first second — but nothing
 * wrote the flag. So the wizard ran open, its Security and network steps were
 * refused for want of a session ("Authentication required"), and /login sent
 * the owner straight back to that wizard: setup could not be finished. Seen on
 * a DGX Spark.
 *
 * Recorded at install, the flag gives the flow the app already has for a box
 * whose owner password exists: /setup asks for the password, the owner signs in
 * with the computer's own, and the wizard goes past the steps a PC does not
 * need (src/components/SetupWizard.tsx).
 */
const SOURCE = readFileSync(path.resolve(process.cwd(), "install-x64.sh"), "utf8");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function sliceFunction(name: string): string {
  const start = SOURCE.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in install-x64.sh`);
  const end = SOURCE.indexOf("\n}\n", start + 1);
  return SOURCE.slice(start + 1, end + 3);
}

let dir: string;
let bin: string;
let config: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-x64-owner-"));
  bin = path.join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(dir, "data"));
  config = path.join(dir, "data", "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * record_owner_password with `passwd -S` answering `status` for the user and
 * unix_chkpwd exiting `defaultCheck` for the factory default (0: it IS the
 * default, 7: PAM_AUTH_ERR, it is not; anything else: the check could not run).
 */
function record(status: string, defaultCheck = 7) {
  const passwd = path.join(bin, "passwd");
  writeFileSync(passwd, `#!/usr/bin/env bash\necho "owner ${status} 2026-11-02 0 99999 7 -1"\n`);
  chmodSync(passwd, 0o755);
  const chk = path.join(bin, "unix_chkpwd");
  writeFileSync(chk, `#!/usr/bin/env bash\ncat > "${dir}/chkpwd-stdin"\nexit ${defaultCheck}\n`);
  chmodSync(chk, 0o755);
  const r = spawnSync("bash", ["-c", [
    'as_user() { "$@"; }',
    `PROJECT_DIR="${dir}"`,
    'CLAWBOX_USER="owner"',
    sliceFunction("record_owner_password"),
    "record_owner_password",
  ].join("\n")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!hasPython3)("install-x64.sh records a PC account's existing password", () => {
  it("marks the owner credential present, keeping everything else in config.json", () => {
    writeFileSync(config, JSON.stringify({ hostname: "atom", setup_progress_step: 1 }));
    const r = record("P");
    expect(r.status).toBe(0);
    const data = JSON.parse(readFileSync(config, "utf8"));
    expect(data).toEqual({ hostname: "atom", setup_progress_step: 1, password_configured: true });
    // config.json holds secrets: written 0600, as src/lib/config-store.ts writes it.
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("creates config.json with the flag on a fresh install", () => {
    record("P");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ password_configured: true });
  });

  it("leaves an account with no usable password to the wizard, which sets the first one", () => {
    for (const status of ["NP", "L"]) {
      record(status);
      expect(existsSync(config)).toBe(false);
    }
  });

  it("leaves an account still on the published factory default to the wizard, as deviceHasOwner does", () => {
    // src/lib/system-password.ts: the shipped default is "nobody's yet", so the
    // wizard may claim it and must make the owner choose a real password.
    record("P", 0);
    expect(existsSync(config)).toBe(false);
    expect(readFileSync(path.join(dir, "chkpwd-stdin"), "utf8")).toBe("clawbox\0");
  });

  it("records the owner when the default check cannot run, failing closed as the app does", () => {
    record("P", 9);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ password_configured: true });
  });

  it("never rewrites a config.json it cannot read", () => {
    writeFileSync(config, "{ not json");
    const r = record("P");
    expect(r.status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("{ not json");
    expect(r.out).toMatch(/config\.json/);
  });

  it("runs in the install, after .env is seeded and before the UI starts", () => {
    expect(sliceFunction("step_directories_permissions")).toContain("record_owner_password");
  });
});
