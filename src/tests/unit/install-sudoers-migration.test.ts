import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-445 round 2 — the residue the revalidation measured on the QA box.
 *
 * PR #436 narrowed config/clawbox-sudoers to an explicit allow-list, but the
 * device still carried `/etc/sudoers.d/90-clawbox-nopasswd` containing
 *
 *     clawbox ALL=(ALL) NOPASSWD: ALL
 *
 * from provisioning. sudo takes the UNION of every drop-in, so while that file
 * exists the whole allow-list is decorative: anything running as clawbox (the
 * web server, the in-UI terminal, the agent's shell) is still one step from
 * root. Shipping a narrow file is therefore only half a fix — the installer has
 * to REMOVE the wide one on devices that already have it.
 *
 * The second half is the order of operations. The old code copied the drop-in
 * and only then ran visudo, deleting it and exiting when validation failed —
 * i.e. a typo in the repo left an appliance with no console and no working
 * privilege escalation at all. install_sudoers_dropin validates a staged copy
 * first and keeps whatever is installed when the candidate is bad.
 *
 * These tests source the real functions out of install.sh (never a copy) and
 * run them against a temp /etc/sudoers.d with fake root-capable tools.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && fs.existsSync("/usr/sbin/visudo");
const d = CAN_RUN ? describe : describe.skip;

/** The sudoers helper block, verbatim: constants through the last function. */
function sudoersBlock(): string {
  const start = INSTALL_SH.indexOf("# ── sudoers ─");
  const end = INSTALL_SH.indexOf("step_systemd_services() {");
  if (start < 0 || end < 0) throw new Error("sudoers block markers not found in install.sh");
  return INSTALL_SH.slice(start, end);
}

let tmp: string;

/**
 * Run `body` with the real install.sh helpers in scope.
 *
 * The fakes are the minimum needed to exercise root-only code as a normal user:
 *   install  — drops -o/-g so ownership flags don't fail
 *   chown    — no-op
 *   visudo   — `-cf <file>` goes to the real visudo (that check is the point of
 *              the test); a bare `-c` reads the machine's /etc/sudoers, which a
 *              test cannot, so its result is scripted via VISUDO_C_STATUS.
 */
function runShell(body: string, env: Record<string, string> = {}) {
  const script = `
set -uo pipefail
export PATH="${tmp}/bin:$PATH"
${sudoersBlock()}
SUDOERS_DIR="${tmp}/sudoers.d"
SUDOERS_QUARANTINE_DIR="${tmp}/quarantine"
SUDOERS_STAGING_DIR="${tmp}/staging"
REPO="${REPO}"
${body}
`;
  return spawnSync("bash", ["-c", script], { encoding: "utf-8", env: { ...process.env, ...env } });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-sudoers-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.mkdirSync(path.join(tmp, "sudoers.d"));
  fs.mkdirSync(path.join(tmp, "staging"));
  fs.writeFileSync(
    path.join(tmp, "bin/install"),
    "#!/usr/bin/env bash\nargs=(); while [ $# -gt 0 ]; do case \"$1\" in -o|-g) shift 2;; *) args+=(\"$1\"); shift;; esac; done\nexec /usr/bin/install \"${args[@]}\"\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(tmp, "bin/chown"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(tmp, "bin/visudo"),
    "#!/usr/bin/env bash\n"
    + 'if [ "${1:-}" = "-cf" ]; then exec /usr/sbin/visudo "$@"; fi\n'
    + 'if [ "${1:-}" = "-c" ]; then exit "${VISUDO_C_STATUS:-0}"; fi\n'
    + 'exec /usr/sbin/visudo "$@"\n',
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("sudoers_grants_blanket_nopasswd", () => {
  const detect = (contents: string) =>
    runShell(`printf '%s' "$BLANKET_FIXTURE" > "${tmp}/probe"\nsudoers_grants_blanket_nopasswd "${tmp}/probe"`, {
      BLANKET_FIXTURE: contents,
    }).status;

  it("detects the exact file found on the QA box", () => {
    expect(detect("clawbox ALL=(ALL) NOPASSWD: ALL\n")).toBe(0);
  });

  it("detects the spacing and runas variants of the same rule", () => {
    expect(detect("clawbox ALL=(ALL) NOPASSWD:ALL\n")).toBe(0);
    expect(detect("clawbox\tALL=(ALL:ALL)\tNOPASSWD: ALL\n")).toBe(0);
    expect(detect("%clawbox ALL=(ALL) NOPASSWD: ALL\n")).toBe(0);
    expect(detect("clawbox ALL=(ALL) \\\n  NOPASSWD: ALL\n")).toBe(0);
  });

  it("does not fire on a narrow grant, or on the drop-in we ship", () => {
    expect(detect("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n")).toBe(1);
    expect(detect(fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8"))).toBe(1);
    expect(detect(fs.readFileSync(path.join(REPO, "config/sudoers-clawbox-ollama"), "utf-8"))).toBe(1);
  });

  it("does not fire on a commented-out rule or a PASSWD:-tagged ALL", () => {
    expect(detect("# clawbox ALL=(ALL) NOPASSWD: ALL\n")).toBe(1);
    expect(detect("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, PASSWD: ALL\n")).toBe(1);
  });

  // Removing someone else's blanket rule could lock the only administrator out
  // of a device that is nowhere near a keyboard. The detector is scoped to the
  // clawbox service user on purpose.
  it("leaves rules that are not about the clawbox user alone", () => {
    expect(detect("%sudo ALL=(ALL:ALL) NOPASSWD: ALL\n")).toBe(1);
    expect(detect("%admin ALL=(ALL) NOPASSWD: ALL\n")).toBe(1);
    expect(detect("ubuntu ALL=(ALL) NOPASSWD: ALL\n")).toBe(1);
  });
});

d("install_sudoers_dropin", () => {
  it("installs the shipped drop-in root-owned at 0440", () => {
    const r = runShell(`install_sudoers_dropin "$REPO/config/clawbox-sudoers" clawbox`);
    expect(r.status).toBe(0);
    const dest = path.join(tmp, "sudoers.d/clawbox");
    expect(fs.readFileSync(dest, "utf-8")).toBe(
      fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8"),
    );
    expect((fs.statSync(dest).mode & 0o777).toString(8)).toBe("440");
  });

  // The regression this replaces: cp-then-validate deleted the drop-in and
  // exited, leaving the box with no way to restart a service, change the
  // password, reboot, or finish an update.
  it("keeps the installed file when the candidate fails visudo", () => {
    fs.writeFileSync(path.join(tmp, "good"), "clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n");
    fs.writeFileSync(path.join(tmp, "bad"), "this is not sudoers syntax at all !!!\n");
    expect(runShell(`install_sudoers_dropin "${tmp}/good" clawbox`).status).toBe(0);
    const r = runShell(
      `install_sudoers_dropin "${tmp}/good" clawbox >/dev/null\n`
      + `install_sudoers_dropin "${tmp}/bad" clawbox`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/failed visudo validation; keeping the existing/);
    expect(fs.readFileSync(path.join(tmp, "sudoers.d/clawbox"), "utf-8")).toContain("systemctl reboot");
  });

  it("treats a missing source as a failure instead of a silent no-op", () => {
    const r = runShell(`install_sudoers_dropin "${tmp}/nope" clawbox`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is missing; leaving/);
  });

  // A fragment can parse on its own and still collide with another drop-in.
  it("rolls the previous file back when the whole set stops validating", () => {
    const r = runShell(
      `install_sudoers_dropin "$REPO/config/clawbox-sudoers" clawbox >/dev/null\n`
      + `VISUDO_C_STATUS=1 install_sudoers_dropin "$REPO/config/sudoers-clawbox-ollama" clawbox`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/rolled .* back/);
    expect(fs.readFileSync(path.join(tmp, "sudoers.d/clawbox"), "utf-8")).toBe(
      fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8"),
    );
  });

  it("removes a first-time install that breaks the set", () => {
    const r = runShell(`VISUDO_C_STATUS=1 install_sudoers_dropin "$REPO/config/clawbox-sudoers" fresh`);
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(tmp, "sudoers.d/fresh"))).toBe(false);
  });

  // The candidate must never be staged inside /etc/sudoers.d: sudo parses every
  // file in there, so an unvalidated one is live the moment it lands.
  it("stages outside /etc/sudoers.d and leaves nothing behind", () => {
    expect(sudoersBlock()).not.toMatch(/mktemp "\$SUDOERS_DIR/);
    runShell(`install_sudoers_dropin "$REPO/config/clawbox-sudoers" clawbox`);
    expect(fs.readdirSync(path.join(tmp, "staging"))).toEqual([]);
    expect(fs.readdirSync(path.join(tmp, "sudoers.d"))).toEqual(["clawbox"]);
  });
});

d("quarantine_overbroad_sudoers", () => {
  const seed = () => {
    fs.writeFileSync(path.join(tmp, "sudoers.d/90-clawbox-nopasswd"), "clawbox ALL=(ALL) NOPASSWD: ALL\n");
    fs.writeFileSync(
      path.join(tmp, "sudoers.d/clawbox"),
      fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8"),
    );
    fs.writeFileSync(path.join(tmp, "sudoers.d/clawbox-ollama"), "clawbox ALL=(ALL) NOPASSWD: ALL\n");
    fs.writeFileSync(path.join(tmp, "sudoers.d/99-operator"), "%sudo ALL=(ALL:ALL) ALL\n");
  };

  it("removes the blanket drop-in and keeps a root-only copy", () => {
    seed();
    const r = runShell("quarantine_overbroad_sudoers");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Removed over-broad sudoers drop-in 90-clawbox-nopasswd/);
    expect(fs.existsSync(path.join(tmp, "sudoers.d/90-clawbox-nopasswd"))).toBe(false);

    const kept = fs.readdirSync(path.join(tmp, "quarantine"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^90-clawbox-nopasswd\.\d{8}T\d{6}Z$/);
    const copy = path.join(tmp, "quarantine", kept[0]);
    expect(fs.readFileSync(copy, "utf-8")).toBe("clawbox ALL=(ALL) NOPASSWD: ALL\n");
    expect((fs.statSync(copy).mode & 0o777).toString(8)).toBe("400");
    // 0400 root-owned: clawbox must not be able to read the rule back out and
    // re-plant it, and must not be able to delete the audit trail.
    expect((fs.statSync(path.join(tmp, "quarantine")).mode & 0o777).toString(8)).toBe("700");
  });

  it("never inspects the drop-ins the installer owns", () => {
    seed();
    runShell("quarantine_overbroad_sudoers");
    expect(fs.existsSync(path.join(tmp, "sudoers.d/clawbox"))).toBe(true);
    // clawbox-ollama is seeded with a blanket rule on purpose: it is on the
    // managed list, so it must be skipped without being read.
    expect(fs.existsSync(path.join(tmp, "sudoers.d/clawbox-ollama"))).toBe(true);
  });

  it("leaves an operator's own rule alone", () => {
    seed();
    runShell("quarantine_overbroad_sudoers");
    expect(fs.readFileSync(path.join(tmp, "sudoers.d/99-operator"), "utf-8")).toContain("%sudo");
  });

  it("is idempotent", () => {
    seed();
    expect(runShell("quarantine_overbroad_sudoers").status).toBe(0);
    const second = runShell("quarantine_overbroad_sudoers");
    expect(second.status).toBe(0);
    expect(second.stdout).not.toMatch(/Removed over-broad/);
  });

  // A quarantined file may have defined an alias another drop-in uses. Better a
  // device that still has the wide grant than a device where sudo refuses
  // everything and the only fix is physical access.
  it("restores everything when the removal breaks visudo -c", () => {
    seed();
    const r = runShell("VISUDO_C_STATUS=1 quarantine_overbroad_sudoers");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/restored them/);
    expect(fs.readFileSync(path.join(tmp, "sudoers.d/90-clawbox-nopasswd"), "utf-8"))
      .toBe("clawbox ALL=(ALL) NOPASSWD: ALL\n");
    expect(fs.readdirSync(path.join(tmp, "quarantine"))).toEqual([]);
  });
});

describe("install.sh wiring", () => {
  const fn = (name: string) => {
    const start = INSTALL_SH.indexOf(`${name}() {`);
    expect(start, `${name} not found in install.sh`).toBeGreaterThan(-1);
    const end = INSTALL_SH.indexOf("\n}", start);
    return INSTALL_SH.slice(start, end);
  };

  it("installs the allow-list before quarantining the blanket grant", () => {
    const body = fn("step_systemd_services");
    const install = body.indexOf('install_sudoers_dropin "$PROJECT_DIR/config/clawbox-sudoers" clawbox');
    const quarantine = body.indexOf("quarantine_overbroad_sudoers");
    expect(install).toBeGreaterThan(-1);
    expect(quarantine).toBeGreaterThan(install);
  });

  // If the drop-in did not land, removing the wide one would leave the device
  // with neither.
  it("skips the quarantine when the allow-list failed to install", () => {
    expect(fn("step_systemd_services")).toMatch(
      /if install_sudoers_dropin "\$PROJECT_DIR\/config\/clawbox-sudoers" clawbox; then[\s\S]*?quarantine_overbroad_sudoers[\s\S]*?else[\s\S]*?Warning: sudoers rules NOT updated/,
    );
  });

  it("no longer exits the installer when a drop-in fails to validate", () => {
    for (const step of ["step_systemd_services", "step_performance_mode"]) {
      const body = fn(step);
      expect(body, step).not.toMatch(/visudo -cf \/etc\/sudoers\.d/);
      expect(body, step).not.toMatch(/rm -f \/etc\/sudoers\.d/);
    }
  });

  // The migration has to reach devices that are already in the field, and the
  // only root path an owner can trigger from the UI is the in-app updater ->
  // post_update.
  it("reaches existing devices through the updater", () => {
    expect(fn("step_post_update")).toMatch(/step_systemd_services/);
  });

  // Both managed drop-ins must be installed from step_systemd_services, the one
  // step a fresh install and step_post_update both run unconditionally. The
  // ollama grant used to live in step_performance_mode, which returns early
  // under CLAWBOX_TEST_MODE — so on every box that took that return the device
  // ended up with the narrowed allow-list and no ollama grant at all, and
  // "save a local Ollama model" hit a password prompt nobody can answer.
  it("installs the ollama drop-in through the same validating helper", () => {
    expect(fn("step_systemd_services")).toMatch(
      /install_sudoers_dropin "\$PROJECT_DIR\/config\/sudoers-clawbox-ollama" clawbox-ollama/,
    );
  });

  it("installs every managed drop-in from the step that always runs", () => {
    const body = fn("step_systemd_services");
    for (const name of ["clawbox-sudoers", "sudoers-clawbox-ollama"]) {
      expect(body, `${name} must be installed from step_systemd_services`).toContain(
        `install_sudoers_dropin "$PROJECT_DIR/config/${name}"`,
      );
    }
    // Nowhere else may call it — a drop-in installed from a conditional step is
    // a grant that silently does not exist on some devices. Every call site
    // must fall inside step_systemd_services' byte range.
    const start = INSTALL_SH.indexOf("step_systemd_services() {");
    const end = start + body.length;
    for (const m of INSTALL_SH.matchAll(/^[ \t]*install_sudoers_dropin .*/gm)) {
      expect(
        m.index! >= start && m.index! < end,
        `install_sudoers_dropin called outside step_systemd_services: ${m[0].trim()}`,
      ).toBe(true);
    }
  });

  // The quarantine hands the device's blanket root back. It must not be gated
  // on a feature grant: a box that failed to install the ollama tuning grant
  // still has to lose its passwordless-root drop-in.
  it("gates the quarantine on the primary allow-list, not the ollama grant", () => {
    const body = fn("step_systemd_services");
    const quarantineAt = body.indexOf("quarantine_overbroad_sudoers");
    const ollamaAt = body.indexOf("sudoers-clawbox-ollama");
    expect(quarantineAt).toBeGreaterThan(-1);
    expect(ollamaAt).toBeGreaterThan(-1);
    expect(quarantineAt).toBeLessThan(ollamaAt);
  });
});

describe("the root-owned helper scripts the grants point at", () => {
  const libexec = (() => {
    const start = INSTALL_SH.indexOf("install_root_libexec() {");
    return INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start));
  })();

  // The revalidation found the deployed bundle calling
  // `sudo /usr/local/libexec/clawbox/optimize-ollama.sh` on a box where
  // /usr/local/libexec did not exist, so every "save a local Ollama model" quietly
  // skipped the q8_0 KV-cache / flash-attention tuning.
  it("ships every script a sudoers grant names", () => {
    const sudoers = [
      fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8"),
      fs.readFileSync(path.join(REPO, "config/sudoers-clawbox-ollama"), "utf-8"),
    ].join("\n");
    const granted = [...sudoers.matchAll(/^clawbox ALL=\(root\) NOPASSWD: (\/usr\/local\/libexec\/clawbox\/[\w.-]+)/gm)]
      .map((m) => path.basename(m[1]));
    expect(granted).toContain("optimize-ollama.sh");
    for (const script of new Set(granted)) {
      expect(libexec, `install_root_libexec must install ${script}`).toContain(script);
      expect(fs.existsSync(path.join(REPO, "scripts", script)), `scripts/${script} must exist`).toBe(true);
    }
  });

  it("installs them root-owned at 0755 under a root-owned directory", () => {
    expect(libexec).toMatch(/install -d -o root -g root -m 0755 "\$ROOT_LIBEXEC_DIR"/);
    expect(libexec).toMatch(/install -o root -g root -m 0755 "\$PROJECT_DIR\/scripts\/\$src"/);
  });

  // Running the repo copy here would let a broken install_root_libexec pass
  // unnoticed — the whole point is that the copy under sudo is the one that runs.
  it("runs the root-owned copy of optimize-ollama.sh, not the clawbox-writable one", () => {
    for (const step of ["step_performance_mode", "step_ollama_install"]) {
      const start = INSTALL_SH.indexOf(`${step}() {`);
      expect(start, `${step} not found in install.sh`).toBeGreaterThan(-1);
      const body = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start));
      expect(body, `${step} must run the root-owned copy`).toContain(
        '"$ROOT_LIBEXEC_DIR/optimize-ollama.sh"',
      );
    }
    // install.sh runs as root throughout, so the repo copy — which lives under
    // clawbox-writable /home/clawbox/clawbox/scripts — must not be executed
    // from anywhere in it.
    expect(INSTALL_SH).not.toMatch(/^[ \t]*(bash |sh )?"?\$PROJECT_DIR\/scripts\/optimize-ollama\.sh"?/m);
  });

  it("never grants a path inside the clawbox-writable project tree", () => {
    const sudoers = [
      fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8"),
      fs.readFileSync(path.join(REPO, "config/sudoers-clawbox-ollama"), "utf-8"),
    ].join("\n");
    for (const line of sudoers.split("\n")) {
      if (!line.startsWith("clawbox ALL=")) continue;
      expect(line).not.toMatch(/\/home\/clawbox/);
      expect(line, "a bare ALL is the blanket grant this task removed").not.toMatch(/NOPASSWD:\s*ALL\s*$/);
    }
  });
});
