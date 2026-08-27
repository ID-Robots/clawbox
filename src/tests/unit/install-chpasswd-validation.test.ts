import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-445 audit, GAP 2b — the root side of the password change validates what
 * it consumes.
 *
 * `step_chpasswd` reads `$PROJECT_DIR/data/.chpasswd-input` and pipes it into
 * `/usr/sbin/chpasswd` as root. `$PROJECT_DIR/data` is clawbox-writable — the
 * web server, the in-UI terminal and the agent's shell all run as clawbox — so
 * the record is attacker-choosable. Every guard on it lived on the
 * UNPRIVILEGED side (src/lib/chpasswd.ts), which is no guard at all: dropping
 *
 *     printf 'root:<new>\n' > /home/clawbox/clawbox/data/.chpasswd-input
 *
 * and starting the granted unit set ROOT's password.
 *
 * These tests run the real `step_chpasswd` out of install.sh with
 * /usr/sbin/chpasswd redirected to a recorder, and assert what actually reaches
 * it.
 */

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
let inputFile: string;
let seen: string;

/** Run the real step_chpasswd against the temp tree. */
function runStep() {
  const body = shellFunction("step_chpasswd")
    .replace("/usr/sbin/chpasswd", `${tmp}/fake-chpasswd`);
  const script = [
    "set -uo pipefail",
    `PROJECT_DIR="${project}"`,
    'CLAWBOX_USER="clawbox"',
    body,
    "step_chpasswd",
  ].join("\n");
  return spawnSync("bash", ["-c", script], { encoding: "utf-8" });
}

const fedToChpasswd = () => (fs.existsSync(seen) ? fs.readFileSync(seen, "utf-8") : "");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-chpasswd-"));
  project = path.join(tmp, "project");
  inputFile = path.join(project, "data", ".chpasswd-input");
  seen = path.join(tmp, "seen");
  fs.mkdirSync(path.join(project, "data"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "fake-chpasswd"), `#!/usr/bin/env bash\ncat > "${seen}"\n`, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("install.sh::step_chpasswd", () => {
  it("changes the clawbox user's password", () => {
    fs.writeFileSync(inputFile, "clawbox:hunter2\n", { mode: 0o600 });
    const r = runStep();
    expect(r.status).toBe(0);
    expect(fedToChpasswd()).toBe("clawbox:hunter2\n");
    expect(fs.existsSync(inputFile), "the plaintext record must be scrubbed").toBe(false);
  });

  it("keeps a password containing colons intact — chpasswd splits on the first one", () => {
    fs.writeFileSync(inputFile, "clawbox:a:b:c\n", { mode: 0o600 });
    expect(runStep().status).toBe(0);
    expect(fedToChpasswd()).toBe("clawbox:a:b:c\n");
  });

  it("REFUSES a record naming root", () => {
    // The escalation, in one line.
    fs.writeFileSync(inputFile, "root:pwned\n", { mode: 0o600 });
    const r = runStep();
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/only clawbox may be changed here/);
    expect(fedToChpasswd()).toBe("");
  });

  it("REFUSES a record naming any other account", () => {
    for (const user of ["nvidia", "ubuntu", "sshd", ""]) {
      fs.writeFileSync(inputFile, `${user}:pwned\n`, { mode: 0o600 });
      const r = runStep();
      expect(r.status, `${user} was accepted`).toBe(64);
      expect(fedToChpasswd()).toBe("");
    }
  });

  it("REFUSES a second record smuggled in after a valid one", () => {
    fs.writeFileSync(inputFile, "clawbox:fine\nroot:pwned\n", { mode: 0o600 });
    const r = runStep();
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/exactly one record/);
    expect(fedToChpasswd()).toBe("");
  });

  it("REFUSES a carriage return", () => {
    fs.writeFileSync(inputFile, "clawbox:pw\r\n", { mode: 0o600 });
    expect(runStep().status).toBe(64);
    expect(fedToChpasswd()).toBe("");
  });

  it("REFUSES a record with no password", () => {
    for (const record of ["clawbox\n", "clawbox:\n"]) {
      fs.writeFileSync(inputFile, record, { mode: 0o600 });
      const r = runStep();
      expect(r.status, `${JSON.stringify(record)} was accepted`).toBe(64);
      expect(r.stderr).toMatch(/no password/);
    }
  });

  it("REFUSES a symlinked input file", () => {
    fs.symlinkSync("/etc/shadow", inputFile);
    const r = runStep();
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/symlink/);
    expect(fedToChpasswd()).toBe("");
  });

  it("scrubs the rejected record instead of leaving it for the next run", () => {
    fs.writeFileSync(inputFile, "root:pwned\n", { mode: 0o600 });
    runStep();
    expect(fs.existsSync(inputFile)).toBe(false);
  });

  it("still says so when there is nothing to do", () => {
    const r = runStep();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/);
  });

  it("does no git or network work — the acceptance criterion, asserted on the source", () => {
    const body = shellFunction("step_chpasswd");
    expect(body).not.toMatch(/\bgit\b|curl|wget|fetch/);
  });
});
