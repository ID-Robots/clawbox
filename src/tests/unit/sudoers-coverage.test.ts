import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-445 — the guard that keeps the sudoers allow-list an allow-list.
 *
 * config/clawbox-sudoers replaced `clawbox ALL=(ALL) NOPASSWD: ALL` with an
 * explicit list of commands. Nothing stops that list from drifting back: a new
 * `sudo` call with no matching grant fails on a device with no console (a
 * password prompt nobody can answer), and the cheapest-looking fix is to widen
 * the list. scripts/check-sudoers-coverage.sh makes both directions of drift a
 * build failure instead.
 */

const REPO = path.resolve(__dirname, "../../..");
const CHECKER = path.join(REPO, "scripts/check-sudoers-coverage.sh");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("perl", ["-e", "1"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function run(root: string, args: string[] = []) {
  return spawnSync("bash", [CHECKER, ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_REPO_ROOT: root },
  });
}

let fixture: string;

/**
 * A repo root that shares the real src/ and mcp/ trees (so the call sites under
 * test are the real ones) but has its own config/ and scripts/, which the tests
 * mutate.
 */
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-sudoers-cov-"));
  fs.mkdirSync(path.join(fixture, "config"));
  for (const f of ["clawbox-sudoers", "sudoers-clawbox-ollama"]) {
    fs.copyFileSync(path.join(REPO, "config", f), path.join(fixture, "config", f));
  }
  fs.symlinkSync(path.join(REPO, "src"), path.join(fixture, "src"));
  fs.symlinkSync(path.join(REPO, "mcp"), path.join(fixture, "mcp"));
  fs.mkdirSync(path.join(fixture, "scripts"));
  for (const e of fs.readdirSync(path.join(REPO, "scripts"))) {
    fs.symlinkSync(path.join(REPO, "scripts", e), path.join(fixture, "scripts", e));
  }
});

afterEach(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

const grants = () => path.join(fixture, "config/clawbox-sudoers");
const appendGrant = (line: string) => fs.appendFileSync(grants(), `${line}\n`);
const dropGrant = (needle: string) =>
  fs.writeFileSync(
    grants(),
    fs.readFileSync(grants(), "utf-8").split("\n").filter((l) => !l.includes(needle)).join("\n"),
  );

d("check-sudoers-coverage", () => {
  it("passes on the repo as it ships", () => {
    const r = run(REPO);
    expect(r.stderr + r.stdout).toMatch(/OK — \d+ grants, \d+ resolved sudo invocations, 0 gaps/);
    expect(r.status).toBe(0);
  });

  it("passes on the fixture, so the fixture itself is not the thing under test", () => {
    expect(run(fixture).status).toBe(0);
  });

  it("fails when a sudo call has no grant", () => {
    fs.writeFileSync(
      path.join(fixture, "scripts/zz-probe.sh"),
      "#!/usr/bin/env bash\nsudo /usr/bin/systemctl restart some-other.service\n",
    );
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNCOVERED sudo invocations/);
    expect(r.stderr).toMatch(/systemctl restart some-other\.service/);
  });

  it("fails when a granted command loses its grant", () => {
    dropGrant("systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNCOVERED sudo invocations/);
    expect(r.stderr).toMatch(/\/usr\/bin\/systemctl reboot/);
  });

  // The reverse direction. A grant nobody uses is privilege handed out for free,
  // and it is how the list creeps back towards ALL one line at a time.
  it("fails on a grant nothing invokes", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl restart cups.service");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNUSED grants/);
    expect(r.stderr).toMatch(/cups\.service/);
  });

  // The `.service` / bare-unit pairs in config/clawbox-sudoers exist because
  // sudoers matches arguments as exact strings; only one spelling is ever called.
  it("accepts the bare-unit twin of a grant that is used", () => {
    expect(fs.readFileSync(grants(), "utf-8")).toMatch(/systemctl restart clawbox-gateway$/m);
    expect(run(fixture).status).toBe(0);
  });

  // Fail-closed: a sudo call the checker cannot read is never quietly a pass.
  it("fails on a sudo call whose arguments it cannot resolve", () => {
    fs.writeFileSync(
      path.join(fixture, "scripts/zz-probe.sh"),
      '#!/usr/bin/env bash\nsudo /usr/bin/systemctl restart "$UNIT"\n',
    );
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNRESOLVED sudo call sites/);
  });

  it("does not mistake a sudo command inside a message for an invocation", () => {
    fs.writeFileSync(
      path.join(fixture, "scripts/zz-probe.sh"),
      '#!/usr/bin/env bash\necho "Fix it with: sudo systemctl restart cups"\n',
    );
    expect(run(fixture).status).toBe(0);
  });

  it("refuses a blanket grant outright", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: ALL");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/grants a bare ALL/);
  });

  it("refuses a grant that runs as anything other than root", () => {
    appendGrant("clawbox ALL=(clawbox) NOPASSWD: /usr/bin/systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only \(root\) is allowed/);
  });

  it("refuses a line it cannot parse rather than skipping it", () => {
    appendGrant("clawbox ALL=(root) /usr/bin/systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not a `clawbox ALL=\(root\) NOPASSWD: <cmd>` rule/);
  });

  // ── Shape invariants (TASK-445 audit, GAP 2 + GAP 3) ──────────────────────
  //
  // Coverage alone never made a grant safe. These two rules are what stop the
  // allow-list drifting back into the shapes the audit failed it for, and they
  // are asserted here so a regression fails CI rather than a device.

  it("refuses a wildcard in the command arguments", () => {
    // The real defect: sudoers matches arguments as one concatenated string, so
    // this rule also matched `... start --no-block clawbox-setup.service ssh.service`
    // and `systemctl start` takes a list of units.
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block clawbox-*");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uses a wildcard/);
  });

  it("refuses a wildcard in the command path", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/local/libexec/clawbox/*.sh");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uses a wildcard/);
  });

  it("refuses a `?` wildcard too, not just `*`", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl start clawbox-gatewa?.service");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uses a wildcard/);
  });

  it("refuses a grant pointing into the clawbox-writable project tree", () => {
    // GAP 2 in one line: install.sh is clawbox:clawbox 0755 inside a
    // clawbox-writable directory, so this grant is passwordless local root for
    // anything that can already run code as clawbox.
    appendGrant("clawbox ALL=(root) NOPASSWD: /home/clawbox/clawbox/install.sh --step build");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/outside every root-owned prefix/);
  });

  it("refuses a grant on any other clawbox-writable location", () => {
    for (const target of ["/tmp/helper.sh", "/home/clawbox/.local/bin/hermes", "/var/tmp/x"]) {
      fs.copyFileSync(path.join(REPO, "config", "clawbox-sudoers"), grants());
      appendGrant(`clawbox ALL=(root) NOPASSWD: ${target}`);
      const r = run(fixture);
      expect(r.status, `${target} was accepted`).toBe(1);
      expect(r.stderr).toMatch(/outside every root-owned prefix/);
    }
  });

  it("refuses a relative command, which sudo would resolve through secure_path", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/relative command/);
  });

  it("still accepts a root-owned libexec helper", () => {
    // The escape hatch the invariant leaves open, and the pattern every new
    // privileged helper is supposed to follow. Granting a path nothing calls is
    // an unused grant, not a shape error — so assert on the message, not the code.
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/local/libexec/clawbox/clawbox-new-helper.sh --go");
    const r = run(fixture);
    expect(r.stderr).not.toMatch(/outside every root-owned prefix|uses a wildcard/);
    expect(r.stderr).toMatch(/UNUSED grants/);
  });

  // A direct assertion that the SHIPPED files contain no wildcard lives in
  // root-steps.test.ts, which reads both drop-ins; the tests above prove the
  // checker is what fails CI when one comes back.

  it("lists what it matched", () => {
    const r = run(REPO, ["--list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/GRANTS \(\d+\):/);
    expect(r.stdout).toContain("/usr/local/libexec/clawbox/optimize-ollama.sh");
    expect(r.stdout).toContain("/usr/bin/systemctl start clawbox-root-update@chpasswd.service");
    expect(r.stdout).toMatch(/RESOLVED CALL SITES:/);
  });

  it("reports machine-readably", () => {
    const r = run(REPO, ["--json"]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.uncovered).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.unused).toEqual([]);
    expect(report.grants).toBeGreaterThan(30);
    expect(report.calls).toBeGreaterThan(30);
  });

  it("rejects an unknown flag instead of silently checking", () => {
    expect(run(REPO, ["--nope"]).status).toBe(2);
  });
});

describe("the call sites the allow-list has to cover", () => {
  const listed = () => {
    const r = run(REPO, ["--list"]);
    return r.stdout;
  };

  // Every path the task brief names, traced end to end. If one of these stops
  // being covered the device loses that feature to a password prompt.
  it.runIf(CAN_RUN)("covers the wizard, updater, power, wifi, desktop and factory-reset paths", () => {
    const out = listed();
    for (const expected of [
      // setup wizard: hostname + hotspot hand-off, and the chpasswd hand-off
      "sudo /usr/bin/systemctl start clawbox-root-update@set_hostname.service",
      "sudo /usr/bin/systemctl start clawbox-root-update@restart_ap.service",
      "sudo /usr/bin/systemctl start clawbox-root-update@chpasswd.service",
      // power menu
      "sudo /usr/bin/systemctl reboot",
      "sudo /usr/bin/systemctl poweroff",
      // factory reset: mask, stop, unmask, reset password, reboot
      "sudo /usr/bin/systemctl --runtime mask clawbox-gateway.service",
      "sudo /usr/bin/systemctl --runtime unmask clawbox-gateway.service",
      "sudo /usr/bin/systemctl stop clawbox-gateway.service",
      // desktop / power-profile toggles, through the root-owned copies
      "sudo /usr/local/libexec/clawbox/clawbox-desktop-mode.sh --enable",
      "sudo /usr/local/libexec/clawbox/clawbox-desktop-mode.sh --disable",
      "sudo /usr/local/libexec/clawbox/clawbox-power-mode.sh --balanced",
      "sudo /usr/local/libexec/clawbox/clawbox-power-mode.sh --performance",
      // local models
      "sudo /usr/bin/systemctl enable --now ollama.service",
      "sudo /usr/bin/systemctl disable --now ollama.service",
      "sudo /usr/local/libexec/clawbox/optimize-ollama.sh",
      // remote control
      "sudo /usr/bin/systemctl restart clawbox-tunnel.service",
      "sudo /usr/bin/systemctl enable clawbox-tunnel.service",
    ]) {
      expect(out, `${expected} is no longer a resolved call site`).toContain(expected);
    }
  });
});
