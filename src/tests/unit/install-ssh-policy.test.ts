import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { LEGACY_IMAGE_PASSWORD } from "@/lib/system-password";

/**
 * SSH off by default — the root side (install.sh::step_ssh_policy and
 * step_ssh_policy_apply). These run the real functions out of install.sh with
 * passwd, runuser, systemctl and usermod replaced by recorders on PATH, and the
 * policy file moved onto a temp tree.
 */

// Starts real bash processes: vitest's 5 s default is too tight on CI.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end + 2);
}

let tmp: string;
let project: string;
let bin: string;
let policyFile: string;
let log: string;

/**
 * passwdStatus: what `passwd -S` reports (P / L / NP / "" for a failure).
 * chkpwdExit: unix_chkpwd's exit for the legacy password (0 = it IS the
 * legacy password, 7 = it is not, anything else = the check did not run).
 */
function run(fn: string, opts: { passwdStatus: string; chkpwdExit: number }) {
  fs.writeFileSync(path.join(bin, "passwd"),
    opts.passwdStatus
      ? `#!/usr/bin/env bash\necho "clawbox ${opts.passwdStatus} 01/01/2026 0 99999 7 -1"\n`
      : "#!/usr/bin/env bash\nexit 1\n",
    { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "runuser"),
    `#!/usr/bin/env bash\necho "runuser $*" >> "${log}"\ncat > "${tmp}/chkpwd-stdin"\nexit ${opts.chkpwdExit}\n`,
    { mode: 0o755 });
  for (const tool of ["systemctl", "usermod"]) {
    fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\n`, { mode: 0o755 });
  }
  const fns = [
    "ssh_owner_password_state", "write_ssh_policy", "read_ssh_policy", "ssh_service_off",
    "step_ssh_policy", "step_ssh_policy_apply",
  ].map(shellFunction).join("\n");
  const script = [
    "set -uo pipefail",
    `PATH="${bin}:$PATH"`,
    `PROJECT_DIR="${project}"`,
    'CLAWBOX_USER="clawbox"',
    `SSH_POLICY_FILE="${policyFile}"`,
    `SSH_LEGACY_IMAGE_PASSWORD="${LEGACY_IMAGE_PASSWORD}"`,
    fns,
    fn,
  ].join("\n");
  return spawnSync("bash", ["-c", script], { encoding: "utf-8" });
}

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "");
const policy = () => (fs.existsSync(policyFile) ? fs.readFileSync(policyFile, "utf-8").trim() : null);
const request = (word: string) =>
  fs.writeFileSync(path.join(project, "data", ".ssh-policy-request"), word, { mode: 0o600 });

const OWNER = { passwdStatus: "P", chkpwdExit: 7 };
const LEGACY = { passwdStatus: "P", chkpwdExit: 0 };
const NO_PASSWORD = { passwdStatus: "L", chkpwdExit: 7 };
const UNKNOWN = { passwdStatus: "P", chkpwdExit: 9 };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-ssh-policy-"));
  project = path.join(tmp, "project");
  bin = path.join(tmp, "bin");
  policyFile = path.join(tmp, "etc", "ssh-policy");
  log = path.join(tmp, "calls");
  fs.mkdirSync(path.join(project, "data"), { recursive: true });
  fs.mkdirSync(bin);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the legacy image password", () => {
  it("is the same constant on both sides of the boundary", () => {
    expect(INSTALL_SH).toContain(`SSH_LEGACY_IMAGE_PASSWORD="${LEGACY_IMAGE_PASSWORD}"`);
  });

  it("is checked with unix_chkpwd as the clawbox user, NUL-terminated", () => {
    request("enable");
    run("step_ssh_policy", OWNER);
    expect(calls()).toContain("runuser -u clawbox -- /usr/sbin/unix_chkpwd clawbox nonull");
    expect(fs.readFileSync(path.join(tmp, "chkpwd-stdin"), "utf-8")).toBe(`${LEGACY_IMAGE_PASSWORD}\0`);
  });

  it("appears in no other product file", () => {
    const literal = `"${LEGACY_IMAGE_PASSWORD}"`;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "tests") walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf-8");
        if (text.includes(`PASSWORD = ${literal}`) || /chpasswdRecord\([^)]*"clawbox"\)/.test(text)) {
          offenders.push(path.relative(REPO, full));
        }
      }
    };
    walk(path.join(REPO, "src"));
    expect(offenders).toEqual(["src/lib/system-password.ts"]);
  });
});

d("install.sh::step_ssh_policy", () => {
  it("enables SSH for an owner", () => {
    request("enable");
    const r = run("step_ssh_policy", OWNER);
    expect(r.status).toBe(0);
    expect(policy()).toBe("enabled");
    expect(calls()).toContain("systemctl enable --now ssh");
    expect(fs.existsSync(path.join(project, "data", ".ssh-policy-request"))).toBe(false);
  });

  for (const [name, state] of [["the legacy image password", LEGACY], ["no password", NO_PASSWORD], ["an unreadable state", UNKNOWN]] as const) {
    it(`refuses to enable SSH with ${name}`, () => {
      request("enable");
      const r = run("step_ssh_policy", state);
      expect(r.status).toBe(65);
      expect(policy()).toBeNull();
      expect(calls()).not.toContain("systemctl enable");
    });
  }

  it("disables SSH", () => {
    request("disable");
    const r = run("step_ssh_policy", OWNER);
    expect(r.status).toBe(0);
    expect(policy()).toBe("disabled");
    expect(calls()).toContain("systemctl disable --now ssh");
    // A socket-activated sshd would keep port 22 listening otherwise.
    expect(calls()).toContain("systemctl disable --now ssh.socket");
  });

  it("factory_reset removes the password hash entirely and switches SSH off", () => {
    request("factory_reset");
    const r = run("step_ssh_policy", OWNER);
    expect(r.status).toBe(0);
    expect(calls()).toContain("usermod -p ! clawbox");
    expect(calls()).not.toMatch(/chpasswd/);
    expect(policy()).toBe("disabled");
    expect(calls()).toContain("systemctl disable --now ssh");
  });

  it("rejects anything else", () => {
    for (const word of ["", "enabled", "enable\nfactory_reset", "ENABLE", "on"]) {
      request(word);
      const r = run("step_ssh_policy", OWNER);
      expect(r.status, JSON.stringify(word)).toBe(64);
    }
    expect(calls()).not.toMatch(/systemctl|usermod/);
  });

  it("refuses a symlinked request", () => {
    const target = path.join(tmp, "elsewhere");
    fs.writeFileSync(target, "factory_reset");
    fs.symlinkSync(target, path.join(project, "data", ".ssh-policy-request"));
    const r = run("step_ssh_policy", OWNER);
    expect(r.status).toBe(64);
    expect(calls()).not.toContain("usermod");
  });
});

d("install.sh::step_ssh_policy_apply (every update)", () => {
  it("keeps SSH exactly as it was on an owned box from before the policy", () => {
    const r = run("step_ssh_policy_apply", OWNER);
    expect(r.status).toBe(0);
    expect(policy()).toBe("enabled");
    expect(calls()).not.toContain("systemctl");
  });

  it("never takes SSH away when the owner check cannot run, and records nothing", () => {
    run("step_ssh_policy_apply", UNKNOWN);
    // No guess becomes permanent: the next update decides again.
    expect(policy()).toBeNull();
    expect(calls()).not.toContain("systemctl");
  });

  it("switches SSH off on an unowned box (legacy password or none)", () => {
    for (const state of [LEGACY, NO_PASSWORD]) {
      fs.rmSync(policyFile, { force: true });
      fs.rmSync(log, { force: true });
      run("step_ssh_policy_apply", state);
      expect(policy()).toBe("disabled");
      expect(calls()).toContain("systemctl disable --now ssh");
    }
  });

  it("holds SSH off when the policy says disabled, even for an owner", () => {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, "disabled\n");
    run("step_ssh_policy_apply", OWNER);
    expect(calls()).toContain("systemctl disable --now ssh");
  });

  it("holds SSH off when nobody owns the box, even with the policy enabled", () => {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, "enabled\n");
    run("step_ssh_policy_apply", LEGACY);
    expect(calls()).toContain("systemctl disable --now ssh");
    expect(policy()).toBe("enabled");
  });

  it("runs on every update", () => {
    const post = shellFunction("step_post_update");
    expect(post).toContain("optional_step ssh_policy_apply step_ssh_policy_apply");
  });
});
