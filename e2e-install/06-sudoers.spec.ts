/**
 * Root escalation surface, checked on a device that install.sh actually
 * provisioned. TASK-445.
 *
 * The QA-box revalidation of PR #436 found the narrowing landed in the repo and
 * nowhere else: /etc/sudoers.d still carried `90-clawbox-nopasswd` with
 * `clawbox ALL=(ALL) NOPASSWD: ALL` from provisioning, /usr/local/libexec did
 * not exist at all, and the deployed bundle was calling a helper there. Every
 * assertion below is a thing that was true in the repo and false on the box, so
 * they are made against the container's real filesystem rather than the source.
 *
 * The container is seeded with exactly that blanket drop-in (e2e-install/
 * Dockerfile writes it so volume permissions work before install.sh runs), which
 * makes it a genuine fixture for the migration: if quarantine_overbroad_sudoers
 * did not run, the first test fails.
 *
 * Read-only: every command here inspects state, none changes it. Runs at NN=06,
 * after the captive-portal probes and before the wizard mutates anything.
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";

/** `sudo -n -l` for the clawbox user, i.e. what the web server may run as root. */
async function sudoList(): Promise<string> {
  return dockerExec(["bash", "-lc", "sudo -n -l 2>&1 || true"], { user: "clawbox" });
}

test.describe("root escalation surface", () => {
  test("no drop-in grants clawbox unrestricted passwordless root", async () => {
    const rules = await dockerExec([
      "bash", "-lc",
      "grep -rhv '^[[:space:]]*#' /etc/sudoers.d/ 2>/dev/null | grep -v '^[[:space:]]*$' || true",
    ]);
    for (const line of rules.split("\n")) {
      if (!/^\s*(clawbox|%clawbox)\s/.test(line)) continue;
      expect(line, "a blanket NOPASSWD ALL grant survived the install").not.toMatch(/NOPASSWD:\s*ALL\s*$/);
    }

    const listed = await sudoList();
    expect(listed).not.toMatch(/NOPASSWD:\s*ALL\s*$/m);
    // `(ALL : ALL) ALL` is sudo's rendering of an unrestricted rule.
    expect(listed).not.toMatch(/\(ALL\s*:\s*ALL\)\s+ALL\s*$/m);
  });

  test("the removed drop-in is kept, root-only, where it can be explained", async () => {
    const kept = await dockerExec([
      "bash", "-lc",
      "ls -1 /var/lib/clawbox/sudoers-quarantine/ 2>/dev/null || true",
    ]);
    // The Dockerfile seeds /etc/sudoers.d/clawbox-nopasswd, so exactly that file
    // must have been moved aside.
    expect(kept).toMatch(/clawbox-nopasswd\.\d{8}T\d{6}Z/);

    const perms = await dockerExec([
      "bash", "-lc",
      "stat -c '%a %U:%G' /var/lib/clawbox/sudoers-quarantine",
    ]);
    expect(perms.trim()).toBe("700 root:root");
  });

  test("clawbox can still do exactly what the product needs", async () => {
    const listed = await sudoList();
    // A failure here is a device that has lost a feature to a password prompt
    // nobody can answer, so each entry names the path that would break.
    for (const [what, needle] of [
      ["factory reset / power menu", "/usr/bin/systemctl reboot"],
      ["power menu", "/usr/bin/systemctl poweroff"],
      ["password change + hostname + AP restart", "clawbox-root-update@*.service"],
      ["updater + installer hand-off", "/usr/bin/systemctl start --no-block clawbox-*"],
      ["updater + installer hand-off", "/usr/bin/systemctl reset-failed clawbox-*"],
      ["gateway restart after a config write", "/usr/bin/systemctl restart clawbox-gateway.service"],
      ["web server restart (force-update.sh)", "/usr/bin/systemctl restart clawbox-setup.service"],
      ["Settings → Local Models", "/usr/bin/systemctl disable --now ollama.service"],
      ["Settings → Desktop", "/usr/local/libexec/clawbox/clawbox-desktop-mode.sh --disable"],
      ["Settings → Performance mode", "/usr/local/libexec/clawbox/clawbox-power-mode.sh --performance"],
      ["saving a local Ollama model", "/usr/local/libexec/clawbox/optimize-ollama.sh"],
    ] as const) {
      expect(listed, `${what} lost its sudo grant`).toContain(needle);
    }
  });

  test("every granted libexec helper exists, root-owned and 0755", async () => {
    const granted = (await sudoList())
      .split("\n")
      .map((l) => l.match(/(\/usr\/local\/libexec\/clawbox\/[\w.-]+)/)?.[1])
      .filter((p): p is string => !!p);
    expect(granted.length).toBeGreaterThan(0);
    expect(granted).toContain("/usr/local/libexec/clawbox/optimize-ollama.sh");

    for (const script of new Set(granted)) {
      const stat = await dockerExec([
        "bash", "-lc",
        `stat -c '%a %U:%G' ${script} 2>&1 || echo MISSING`,
      ]);
      expect(stat.trim(), `${script} is granted but not installed correctly`).toBe("755 root:root");
    }

    // The directories above them must be root-owned too, or the grant is
    // decorative: clawbox could replace the file root is about to run.
    for (const dir of ["/usr/local/libexec", "/usr/local/libexec/clawbox"]) {
      const stat = await dockerExec(["bash", "-lc", `stat -c '%U:%G' ${dir}`]);
      expect(stat.trim(), `${dir} must be root-owned`).toBe("root:root");
    }
  });

  test("no grant points into the clawbox-writable project tree", async () => {
    const listed = await sudoList();
    expect(listed).not.toContain("/home/clawbox/clawbox");
  });

  test("the root-update unit runs the root-owned entrypoint", async () => {
    const unit = await dockerExec([
      "bash", "-lc",
      "systemctl cat clawbox-root-update@.service 2>&1 | grep -i '^ExecStart' || true",
    ]);
    expect(unit).toContain("/usr/local/libexec/clawbox/clawbox-root-step.sh");
    expect(unit).not.toContain("/home/clawbox/clawbox/install.sh");
  });

  test("the whole sudoers set still parses", async () => {
    const out = await dockerExec(["bash", "-lc", "visudo -c 2>&1; echo rc=$?"]);
    expect(out).toContain("rc=0");
  });
});
