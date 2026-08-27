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

    // `(ALL : ALL) ALL` from the `sudo` GROUP is expected and is deliberately
    // NOT what this task removes. install.sh's step_ensure_user puts clawbox in
    // `sudo`, `video`, `audio`, `i2c`, `gpio` on every device, and the distro's
    // `%sudo ALL=(ALL:ALL) ALL` demands a password — so it is the owner's own
    // administrator account, not a path the web server can take. Stripping it
    // would lock the only administrator out of an appliance that has no
    // console, which is why quarantine_overbroad_sudoers only ever looks at
    // `clawbox`/`%clawbox` NOPASSWD rules.
    //
    // So assert the BEHAVIOUR rather than the rendering: the web server only
    // ever runs `sudo -n`, and under a blanket grant `sudo -n <anything>`
    // succeeds. Each probe below is a command no line in the allow-list names,
    // so a pass here means an unrestricted rule is reachable without a password.
    for (const probe of ["id -u", "cat /etc/shadow", "install -m 0755 /bin/true /usr/local/bin/pwn"]) {
      const out = await dockerExec(
        ["bash", "-lc", `sudo -n ${probe} >/dev/null 2>&1 && echo ESCALATED || echo DENIED`],
        { user: "clawbox" },
      );
      expect(out.trim(), `\`sudo -n ${probe}\` must not be permitted`).toBe("DENIED");
    }
  });

  test("the removed drop-in is kept, root-only, where it can be explained", async () => {
    const kept = await dockerExec([
      "bash", "-lc",
      "ls -1 /var/lib/clawbox/sudoers-quarantine/ 2>/dev/null || true",
    ]);
    // The Dockerfile seeds BOTH blanket names a device is seen with — the
    // factory-baked `90-clawbox-nopasswd` and the field name `clawbox-nopasswd`
    // — so both must have been moved aside. Neither is written by this repo:
    // they arrive in the flashed image, which is why the installer has to
    // remove them rather than merely stop writing them.
    expect(kept).toMatch(/(^|\n)clawbox-nopasswd\.\d{8}T\d{6}Z/);
    expect(kept).toMatch(/(^|\n)90-clawbox-nopasswd\.\d{8}T\d{6}Z/);

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
      ["password change", "/usr/bin/systemctl start clawbox-root-update@chpasswd.service"],
      ["hostname change", "/usr/bin/systemctl start clawbox-root-update@set_hostname.service"],
      ["hotspot restart", "/usr/bin/systemctl start clawbox-root-update@restart_ap.service"],
      ["llama.cpp installer hand-off", "/usr/bin/systemctl start --no-block clawbox-root-update@llamacpp_install.service"],
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

  test("no granted command is owned or writable by clawbox", async () => {
    // Stronger than the string check above, and the invariant the audit asked
    // for: resolve every granted path on the real filesystem and require root
    // ownership with no group/other write bit. A grant on a file clawbox can
    // rewrite is passwordless local root whatever the path happens to read as.
    const paths = [...new Set(
      (await sudoList())
        .split("\n")
        .flatMap((l) => l.match(/\/[\w./@-]+/g) ?? [])
        .filter((p) => p.startsWith("/usr/") || p.startsWith("/bin/") || p.startsWith("/home/")),
    )];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const stat = (await dockerExec(["bash", "-lc", `stat -c '%U %a' ${p} 2>/dev/null || echo SKIP`])).trim();
      if (stat === "SKIP") continue;
      const [owner, mode] = stat.split(" ");
      expect(owner, `${p} is granted but owned by ${owner}`).toBe("root");
      expect(Number(mode.slice(-1)) & 2, `${p} is world-writable`).toBe(0);
      expect(Number(mode.slice(-2, -1)) & 2, `${p} is group-writable`).toBe(0);
    }
  });

  test("a wildcard cannot swallow a second unit name (GAP 3)", async () => {
    // sudoers matches arguments as ONE concatenated string, so `clawbox-*` also
    // matched `<granted unit> ssh.service` — and `systemctl start` takes a LIST
    // of units. `sudo -n -l <cmd>` asks sudo what it MATCHES without running it.
    for (const cmd of [
      "/usr/bin/systemctl start clawbox-root-update@chpasswd.service ssh.service",
      "/usr/bin/systemctl start --no-block clawbox-root-update@llamacpp_install.service ssh.service",
      "/usr/bin/systemctl reset-failed clawbox-root-update@chpasswd.service ssh.service",
      "/usr/bin/systemctl start --no-block clawbox-setup.service ssh.service",
      // The update family is not reachable from the web server at all now.
      "/usr/bin/systemctl start clawbox-root-update@git_pull.service",
      "/usr/bin/systemctl start clawbox-root-update@build.service",
    ]) {
      const out = await dockerExec(
        ["bash", "-lc", `sudo -n -l ${cmd} >/dev/null 2>&1 && echo ALLOWED || echo DENIED`],
        { user: "clawbox" },
      );
      expect(out.trim(), `sudo must not match: ${cmd}`).toBe("DENIED");
    }

    // Control: what the product really issues still matches, so a pass above
    // cannot just be "sudo denies everything".
    for (const cmd of [
      "/usr/bin/systemctl start clawbox-root-update@chpasswd.service",
      "/usr/bin/systemctl start --no-block clawbox-root-update@llamacpp_install.service",
    ]) {
      const out = await dockerExec(
        ["bash", "-lc", `sudo -n -l ${cmd} >/dev/null 2>&1 && echo ALLOWED || echo DENIED`],
        { user: "clawbox" },
      );
      expect(out.trim(), `sudo must still match: ${cmd}`).toBe("ALLOWED");
    }
  });

  test("root records the code it is allowed to run (GAP 2)", async () => {
    const stat = (await dockerExec([
      "bash", "-lc",
      "stat -c '%a %U:%G' /etc/clawbox/root-exec.manifest 2>&1 || echo MISSING",
    ])).trim();
    expect(stat, "install.sh did not write the root-exec manifest").toBe("644 root:root");

    const helper = (await dockerExec([
      "bash", "-lc",
      "stat -c '%a %U:%G' /usr/local/libexec/clawbox/clawbox-root-manifest.sh 2>&1 || echo MISSING",
    ])).trim();
    expect(helper).toBe("755 root:root");

    // It has to cover install.sh itself AND the scripts a root step goes on to
    // run — install.sh is only the first file root executes out of that tree.
    const covered = await dockerExec([
      "bash", "-lc",
      "sed -n 's/^[0-9a-f]\\{64\\} [ *]//p' /etc/clawbox/root-exec.manifest | sort",
    ]);
    expect(covered).toContain("install.sh");
    expect(covered).toContain("scripts/start-ap.sh");
    expect(covered).toContain("config/clawbox-root-update@.service");

    // And it must describe the device as install.sh actually left it.
    const verify = await dockerExec([
      "bash", "-lc",
      "/usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify >/dev/null 2>&1; echo rc=$?",
    ]);
    expect(verify.trim()).toBe("rc=0");
  });
});

/**
 * The refusals, exercised. Unlike the block above these CHANGE state: each one
 * plants something, asserts the root side refuses it, and puts the container
 * back. Kept in their own describe so the read-only block stays read-only.
 */
test.describe("root escalation surface — the refusals, exercised", () => {
  test("the root dispatcher refuses a tree it did not record (GAP 2)", async () => {
    // ADD a file under a covered path rather than editing one: the tamper is
    // then perfectly reversible, and it exercises the membership half of the
    // check, which `sha256sum -c` on its own cannot see.
    const probe = "/home/clawbox/clawbox/scripts/zz-e2e-tamper.sh";
    try {
      await dockerExec(["bash", "-lc", `echo 'id -u' > ${probe}`], { user: "clawbox" });
      const refused = await dockerExec([
        "bash", "-lc",
        "/usr/local/libexec/clawbox/clawbox-root-step.sh set_hostname >/dev/null 2>&1; echo rc=$?",
      ]);
      expect(refused.trim(), "root ran a step against an unrecorded tree").toBe("rc=65");
    } finally {
      await dockerExec(["bash", "-lc", `rm -f ${probe}`], { user: "clawbox" });
    }

    // ...and it verifies again once the tree matches its record, so the refusal
    // above is the tamper rather than a permanently broken device.
    const ok = await dockerExec([
      "bash", "-lc",
      "/usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify >/dev/null 2>&1; echo rc=$?",
    ]);
    expect(ok.trim()).toBe("rc=0");
  });

  test("the password step refuses a record naming another account (GAP 2b)", async () => {
    // The escalation as it stood: data/ is clawbox-writable, so the record was
    // attacker-choosable, and the root side validated nothing about it.
    const before = (await dockerExec(["bash", "-lc", "getent shadow root | cut -d: -f2"])).trim();
    const input = "/home/clawbox/clawbox/data/.chpasswd-input";
    try {
      await dockerExec(["bash", "-lc", `echo 'root:clawbox-e2e-must-not-apply' > ${input}`], { user: "clawbox" });
      const out = await dockerExec([
        "bash", "-lc",
        "systemctl start clawbox-root-update@chpasswd.service >/dev/null 2>&1; echo rc=$?",
      ]);
      expect(out.trim(), "the chpasswd step accepted a root: record").not.toBe("rc=0");
    } finally {
      await dockerExec([
        "bash", "-lc",
        `rm -f ${input}; systemctl reset-failed clawbox-root-update@chpasswd.service >/dev/null 2>&1 || true`,
      ]);
    }
    const after = (await dockerExec(["bash", "-lc", "getent shadow root | cut -d: -f2"])).trim();
    expect(after, "root's password hash changed").toBe(before);
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
