import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTORY_DEFAULT_PASSWORD } from "@/lib/system-password";

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
 * unix_chkpwd exiting `defaultCheck` for the factory default:
 *   0  it IS the published default — nobody's account yet, leave it to the wizard
 *   7  PAM_AUTH_ERR, it is not the default — the password is the owner's own
 *   *  the check could not run, so the answer is unknown and nothing is recorded
 *
 * Run under `set -euo pipefail`, the mode install-x64.sh itself runs in: the
 * exit code has to be read off the pipeline without the shell leaving the
 * function first, and nothing in here may fail the step that calls it.
 */
function record(status: string, defaultCheck = 7, projectDir?: string) {
  stubPasswd(status);
  stubChkpwd(defaultCheck);
  return run(projectDir ?? dir);
}

/**
 * `passwd -S` for the account. Stubbed in $PATH ahead of the real one, which
 * as a non-root test user refuses to report another account's status at all —
 * and record_owner_password returns on anything but "P", so a case that forgets
 * this stub passes without reaching the check it is about.
 */
function stubPasswd(status: string) {
  const passwd = path.join(bin, "passwd");
  writeFileSync(passwd, `#!/usr/bin/env bash\necho "owner ${status} 2026-11-02 0 99999 7 -1"\n`);
  chmodSync(passwd, 0o755);
}

/** unix_chkpwd, keeping what it was handed on stdin for the assertions below. */
function stubChkpwd(exitCode: number) {
  const chk = path.join(bin, "unix_chkpwd");
  writeFileSync(chk, `#!/usr/bin/env bash\ncat > "${dir}/chkpwd-stdin"\nexit ${exitCode}\n`);
  chmodSync(chk, 0o755);
}

/** The function under the shell mode and $PATH the installer gives it. */
function run(projectDir: string, after: string[] = []) {
  const r = spawnSync("bash", ["-c", [
    "set -euo pipefail",
    'as_user() { "$@"; }',
    `PROJECT_DIR="${projectDir}"`,
    'CLAWBOX_USER="owner"',
    sliceFunction("record_owner_password"),
    "record_owner_password",
    ...after,
  ].join("\n")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The half-written `.config.json.*` temps the writer must never leave in data/. */
function tempLeftovers(): string[] {
  const data = path.join(dir, "data");
  if (!existsSync(data)) return [];
  return readdirSync(data).filter((name) => name.startsWith(".config.json."));
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
    // The 0600 temp the rename went through is gone, not left for the next run.
    expect(tempLeftovers()).toEqual([]);
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

  it("checks the default against the app's own constant", () => {
    expect(SOURCE).toContain(`printf '${FACTORY_DEFAULT_PASSWORD}\\0' | as_user unix_chkpwd`);
  });

  it("reads the flag before checking any password, so a re-run logs no failed check", () => {
    // The app reads the flag first for the same reason (system-password.ts):
    // auth.log must not carry a failed check nobody made.
    writeFileSync(config, JSON.stringify({ password_configured: true }, null, 2));
    record("P");
    expect(existsSync(path.join(dir, "chkpwd-stdin"))).toBe(false);
  });

  it("records the owner on PAM_AUTH_ERR, the one exit that means the password is not the default", () => {
    // 7 is the only "it is not the factory default" answer unix_chkpwd gives
    // (src/lib/system-password.ts PAM_AUTH_ERR). Pinned on its own so the case
    // below cannot be widened back over it.
    record("P", 7);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ password_configured: true });
  });

  it("records nothing when the default check could not run, and says so", () => {
    // Any exit that is neither 0 nor 7 — helper missing (127), PAM_USER_UNKNOWN,
    // PAM_SYSTEM_ERR, a signal — means the check never ran, so whether this
    // account still carries the published default is UNKNOWN.
    // src/lib/system-password.ts answers null there and no caller reads null as
    // "the owner's". Recording the flag on that guess is the one outcome that
    // cannot be undone from the UI: middleware and /login would treat an
    // as-flashed box as owned, and setup would ask for a password that is
    // public knowledge instead of making the owner choose one.
    const r = record("P", 9);
    expect(r.status).toBe(0);
    expect(existsSync(config)).toBe(false);
    expect(r.out).toMatch(/WARN.*unix_chkpwd exit 9/);
  });

  it("records nothing when unix_chkpwd is not installed at all", () => {
    // No unix_chkpwd anywhere in $PATH (the real one lives in /usr/sbin, which
    // is not on it here): bash answers 127 for the right-hand side of the
    // pipeline, which must read as "could not run", never as "not the default".
    stubPasswd("P");
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(existsSync(config)).toBe(false);
    expect(r.out).toMatch(/WARN.*unix_chkpwd exit 127/);
  });

  it("never rewrites a config.json it cannot read", () => {
    writeFileSync(config, "{ not json");
    const r = record("P");
    expect(r.status).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("{ not json");
    expect(r.out).toMatch(/config\.json/);
    expect(tempLeftovers()).toEqual([]);
  });

  it("cannot fail the install step when the write fails, and leaves no temp behind", () => {
    // step_directories_permissions runs under `set -e` (install-x64.sh, line 1):
    // a writer that exited non-zero aborted the install over a flag the wizard
    // can ask for itself. Here data/ does not exist, so mkstemp cannot create
    // the temp file config-store.ts-style writes go through.
    const tree = path.join(dir, "absent-tree");
    stubPasswd("P");
    stubChkpwd(7);
    const r = run(tree, ['echo "step continued"']);
    expect(r.status).toBe(0);
    expect(r.out).toContain("step continued");
    expect(r.out).toMatch(/WARN.*could not be written/);
    expect(existsSync(path.join(tree, "data"))).toBe(false);
  });

  // As root every directory is writable, so there is no unwritable-data/ case.
  it.skipIf(process.getuid?.() === 0)("warns instead of raising when data/ is read-only", () => {
    writeFileSync(config, JSON.stringify({ hostname: "atom" }));
    const data = path.join(dir, "data");
    chmodSync(data, 0o500);
    try {
      const r = record("P");
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/WARN/);
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ hostname: "atom" });
      expect(tempLeftovers()).toEqual([]);
    } finally {
      chmodSync(data, 0o700);
    }
  });

  it("runs in the install, after .env is seeded and before the UI starts", () => {
    expect(sliceFunction("step_directories_permissions")).toContain("record_owner_password");
  });
});
