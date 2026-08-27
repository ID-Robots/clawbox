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

/**
 * The same defect class as GAP 2b, and it had two other live members.
 *
 * `$PROJECT_DIR/data` is written by the web server, i.e. by the clawbox user,
 * and install.sh runs as root from a NOPASSWD grant. `source`ing anything in
 * there is therefore arbitrary ROOT code execution for anything that can already
 * run code as clawbox — and both of these were reachable:
 *
 *   * `data/hostname.env` was `.`-sourced by read_configured_hostname, which the
 *     granted `clawbox-root-update@set_hostname.service` runs;
 *   * `data/network.env` was sourced at the TOP of install.sh, i.e. on every
 *     root run of the script, `--step chpasswd` included;
 *   * `data/hotspot.env` was sourced by scripts/start-ap.sh, which
 *     clawbox-ap.service runs with no `User=` and the granted
 *     `clawbox-root-update@restart_ap.service` restarts.
 *
 * The rule is now: root parses these files, never evaluates them.
 */
d("root never evaluates a clawbox-writable data file", () => {
  const PAYLOAD = "x=$(id -u > PWNFILE)";

  function runHostname(fileBody: string) {
    const script = [
      "set -uo pipefail",
      `PROJECT_DIR="${project}"`,
      shellFunction("read_untrusted_env_value"),
      shellFunction("validate_hostname"),
      shellFunction("read_configured_hostname"),
      "read_configured_hostname",
    ].join("\n");
    fs.mkdirSync(path.join(project, "data"), { recursive: true });
    fs.writeFileSync(path.join(project, "data", "hostname.env"), fileBody);
    return spawnSync("bash", ["-c", script], { encoding: "utf-8", cwd: tmp });
  }

  it("reads a plain HOSTNAME assignment", () => {
    expect(runHostname("HOSTNAME=kitchen\n").stdout.trim()).toBe("kitchen");
  });

  it("does not execute a command substitution planted in hostname.env", () => {
    const r = runHostname(`${PAYLOAD.replace("PWNFILE", path.join(tmp, "pwned"))}\nHOSTNAME=kitchen\n`);
    expect(fs.existsSync(path.join(tmp, "pwned")), "root executed data/hostname.env").toBe(false);
    expect(r.stdout.trim()).toBe("kitchen");
  });

  it("falls back to the default rather than taking a value it cannot vouch for", () => {
    // The old code would have run this; the parser rejects the shape instead.
    expect(runHostname("HOSTNAME=$(id -un)\n").stdout.trim()).toBe("clawbox");
    expect(runHostname("HOSTNAME=`id -un`\n").stdout.trim()).toBe("clawbox");
    expect(runHostname("HOSTNAME='kitchen; id'\n").stdout.trim()).toBe("clawbox");
  });

  it("ignores a symlinked env file", () => {
    fs.mkdirSync(path.join(project, "data"), { recursive: true });
    const target = path.join(tmp, "elsewhere.env");
    fs.writeFileSync(target, "HOSTNAME=elsewhere\n");
    const link = path.join(project, "data", "hostname.env");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
    const script = [
      "set -uo pipefail",
      `PROJECT_DIR="${project}"`,
      shellFunction("read_untrusted_env_value"),
      shellFunction("validate_hostname"),
      shellFunction("read_configured_hostname"),
      "read_configured_hostname",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(r.stdout.trim()).toBe("clawbox");
  });

  it("install.sh sources nothing that lives under the clawbox-writable data/", () => {
    // The root-owned /etc/clawbox/*.env files are still sourced, and that is
    // fine — root owns them. What must never come back is `source` on anything
    // resolving into $PROJECT_DIR.
    const CLAWBOX_WRITABLE = ["$PROJECT_DIR", "$IFACE_ENV", "$hostname_env", "/home/clawbox/"];
    for (const line of INSTALL_SH.split("\n")) {
      const m = /^\s*(?:\.|source)\s+(\S.*)$/.exec(line);
      if (!m) continue;
      for (const needle of CLAWBOX_WRITABLE) {
        expect(m[1], `install.sh sources a clawbox-writable path: ${line.trim()}`).not.toContain(needle);
      }
    }
  });

  it("no root-capable script sources anything under the clawbox-writable data/", () => {
    // The whole class, asserted once. Every one of these runs as root somewhere:
    // start-ap.sh and ap-watchdog.sh from units with no `User=`, both reachable
    // through the granted clawbox-root-update@restart_ap.service.
    //
    // launch-browser.sh is deliberately NOT here: its state file is under
    // $HOME/.cache, so the root path reads /root's copy, not clawbox's, and the
    // clawbox path is the clawbox user reading its own file.
    for (const name of ["start-ap.sh", "ap-watchdog.sh", "stop-ap.sh"]) {
      const file = path.join(REPO, "scripts", name);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
        if (/^\s*#/.test(line)) continue;
        const m = /(?:^|[;&|(]|\s)(?:\.|source)\s+(\S+)/.exec(line);
        if (!m) continue;
        expect(m[1], `${name} sources a clawbox-writable path: ${line.trim()}`)
          .not.toMatch(/data\/|HOTSPOT_ENV|CONFIG_FILE|\$ROOT/);
      }
    }
  });

  it("ap-watchdog.sh reads the disable flag without executing the file", () => {
    // It runs as ROOT on a timer (clawbox-ap-watchdog.service has no User=), so
    // `. "$HOTSPOT_ENV"` was arbitrary root code execution on a schedule: plant
    // the payload as clawbox, wait for the next tick.
    const script = fs.readFileSync(path.join(REPO, "scripts", "ap-watchdog.sh"), "utf-8");
    const body = script.split("read_env_value() {")[1].split("\n}")[0];
    const envFile = path.join(tmp, "hotspot.env");
    const pwned = path.join(tmp, "pwned-watchdog").replace(/\\/g, "/");
    fs.writeFileSync(envFile, `x=$(id -u > ${pwned})\nHOTSPOT_DISABLED=1\n`);
    const r = spawnSync("bash", ["-c", [
      "set -uo pipefail",
      `read_env_value() {${body}\n}`,
      `read_env_value "${envFile.replace(/\\/g, "/")}" HOTSPOT_DISABLED`,
    ].join("\n")], { encoding: "utf-8" });
    expect(fs.existsSync(pwned), "root executed data/hotspot.env").toBe(false);
    expect(r.stdout).toBe("1");
  });

  it("start-ap.sh parses hotspot.env instead of sourcing it", () => {
    // It runs as root: clawbox-ap.service and clawbox-ap-watchdog.service carry
    // no `User=`, and clawbox-root-update@restart_ap.service is granted.
    const startAp = fs.readFileSync(path.join(REPO, "scripts", "start-ap.sh"), "utf-8");
    expect(startAp).not.toMatch(/source\s+"\$HOTSPOT_ENV"/);
    expect(startAp).toContain("read_env_value");

    const script = [
      "set -uo pipefail",
      fs.readFileSync(path.join(REPO, "scripts", "start-ap.sh"), "utf-8")
        .split("read_env_value() {")[1]
        .split("\n}")[0]
        .replace(/^/, "read_env_value() {") + "\n}",
      `read_env_value "${path.join(tmp, "hotspot.env").replace(/\\/g, "/")}" HOTSPOT_PASSWORD`,
    ].join("\n");
    fs.writeFileSync(
      path.join(tmp, "hotspot.env"),
      `x=$(id -u > ${path.join(tmp, "pwned-ap").replace(/\\/g, "/")})\nHOTSPOT_PASSWORD="p a$s w'ord"\n`,
    );
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    expect(fs.existsSync(path.join(tmp, "pwned-ap")), "root executed data/hotspot.env").toBe(false);
    // A WiFi PSK may contain almost anything, so the value is passed through
    // whole — it is only ever an argv element for nmcli, never evaluated.
    expect(r.stdout).toBe("p a$s w'ord");
  });
});
