import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  SELF_UPDATING_ROOT_STEPS,
  UI_ROOT_STEPS,
  WEB_ROOT_STEPS,
  isUiRootStep,
  maySelfUpdate,
} from "@/lib/root-steps";

// The libexec test below runs the real install_root_libexec under bash; a
// spawning test carries both ceilings (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The root-privilege boundary is: clawbox-setup (User=clawbox) →
 * `sudo systemctl start clawbox-root-update@<step>.service` → install.sh as
 * root. Three things have to hold for that to be a boundary at all, and each is
 * enforced in a different file — so they are pinned together here. TASK-445.
 */

const REPO = path.resolve(__dirname, "../../..");
const DISPATCHER = path.join(REPO, "config", "clawbox-root-step.sh");
const LAUNCHER = path.join(REPO, "config", "clawbox-run-root-step.sh");
const UNIT = path.join(REPO, "config", "clawbox-root-update@.service");
const INSTALL_SH = path.join(REPO, "install.sh");
const SUDOERS = [
  path.join(REPO, "config", "clawbox-sudoers"),
  path.join(REPO, "config", "sudoers-clawbox-ollama"),
];

const read = (p: string) => fs.readFileSync(p, "utf-8");

/** The Cmnd_Spec of every `clawbox … NOPASSWD:` rule in a drop-in. */
const grantsIn = (file: string): string[] =>
  read(file)
    .split("\n")
    .filter((l) => l.trim().startsWith("clawbox ") && l.includes("NOPASSWD:"))
    .map((l) => l.split("NOPASSWD:")[1].trim());

/**
 * Does systemd run this unit as root? A system unit runs as root unless User=
 * names somebody else — and `User=root`, `User=0` and an empty value all name
 * root, so "has a User= line" is not the test: it exempted a `User=root` unit
 * from every root-unit check below. The LAST assignment wins, as in systemd.
 * DynamicUser=yes allocates a transient user and is never root.
 */
function runsAsRoot(unit: string): boolean {
  if (/^DynamicUser=yes$/m.test(unit)) return false;
  const users = [...unit.matchAll(/^User=(.*)$/gm)].map((m) => m[1].trim());
  const user = users.at(-1) ?? "";
  return user === "" || user === "root" || user === "0";
}

/** The body of a `name() {` shell function in install.sh, braces included. */
function shellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

/** Pull a whitespace-separated shell list assigned as NAME="..." . */
function shellList(source: string, name: string): string[] {
  const m = new RegExp(`^${name}="([^"]*)"`, "m").exec(source);
  if (!m) throw new Error(`${name} not found in the dispatcher`);
  return m[1].split(/\s+/).filter(Boolean);
}

describe("root-step allow-lists", () => {
  it("keeps the TypeScript UI list inside the dispatcher's allow-list", () => {
    const allowed = new Set(shellList(read(DISPATCHER), "ALLOWED_STEPS"));
    for (const step of UI_ROOT_STEPS) {
      expect(allowed.has(step), `${step} is offered by the UI but the root dispatcher rejects it`).toBe(true);
    }
  });

  it("keeps the self-update list identical on both sides", () => {
    const shell = shellList(read(DISPATCHER), "SELF_UPDATING_STEPS");
    expect([...shell].sort()).toEqual([...SELF_UPDATING_ROOT_STEPS].sort());
  });

  it("only lets the dispatcher run steps install.sh can actually dispatch", () => {
    // A step the dispatcher permits but install.sh has no function for is a
    // root unit that fails; the reverse (install.sh knows it, the dispatcher
    // refuses) is safe and expected for anything not reachable from the web.
    const m = /^DISPATCH_STEPS=\(([^)]*)\)/m.exec(read(INSTALL_SH));
    expect(m).not.toBeNull();
    const dispatchable = new Set(
      m![1].split(/\s+/).map((t) => t.trim()).filter((t) => t && !t.startsWith("#")),
    );
    // Pre-existing, and deliberately not fixed here: `clawkeep_install` has a
    // `step_clawkeep_install` function but was never added to DISPATCH_STEPS,
    // so `install.sh --step clawkeep_install` already exits "Unknown step".
    // The UI's install button has therefore never worked. Keeping it in both
    // allow-lists preserves exactly today's behaviour (the request reaches
    // install.sh and install.sh refuses it); adding it to DISPATCH_STEPS would
    // ENABLE a root step, which is a product change, not a security fix.
    const KNOWN_UNDISPATCHABLE = new Set(["clawkeep_install"]);

    // install.sh's array carries inline comments; drop anything that isn't a
    // bare identifier.
    for (const step of shellList(read(DISPATCHER), "ALLOWED_STEPS")) {
      if (KNOWN_UNDISPATCHABLE.has(step)) continue;
      expect(dispatchable.has(step), `${step} is permitted as root but install.sh cannot dispatch it`).toBe(true);
    }
  });

  it("never lets a credential or hostname change self-update", () => {
    // install.sh's bootstrap does `git fetch` + `git reset --hard` + re-exec.
    // A password change must not reach the network or mutate the source tree.
    for (const step of ["chpasswd", "set_hostname", "restart_ap", "edition_lock", "validate_services"]) {
      expect(maySelfUpdate(step), `${step} must not run install.sh's self-update`).toBe(false);
    }
  });

  it("still lets the update family self-update", () => {
    expect(maySelfUpdate("git_pull")).toBe(true);
    expect(maySelfUpdate("bootstrap_updater")).toBe(true);
  });

  it("keeps destructive steps off the UI list", () => {
    for (const step of ["chpasswd", "git_pull", "rebuild_reboot", "recover", "network_setup", "restart"]) {
      expect(isUiRootStep(step), `${step} must not be startable from a UI button`).toBe(false);
    }
  });
});

describe("root-executed paths are outside clawbox's write access", () => {
  it("runs the root-update unit from a root-owned entrypoint", () => {
    const unit = read(UNIT);
    const execStart = /^ExecStart=(.+)$/m.exec(unit)?.[1] ?? "";
    expect(execStart).toContain("/usr/local/libexec/clawbox/");
    // The project tree is clawbox-owned and clawbox-writable, and install.sh
    // `chown -R clawbox`s it on every root run.
    expect(execStart).not.toContain("/home/clawbox");
  });

  it("grants NOPASSWD root only on paths clawbox cannot write", () => {
    for (const file of SUDOERS) {
      for (const grant of grantsIn(file)) {
        expect(
          grant.includes("/home/clawbox"),
          `sudoers grants root on a clawbox-writable path: ${grant}`,
        ).toBe(false);
      }
    }
  });

  it("does not hand over the whole systemd unit namespace", () => {
    // A `clawbox-*` PREFIX was not a scope. sudoers matches arguments as one
    // concatenated string, so `*` spans whitespace and `systemctl start` takes a
    // LIST of units: `start clawbox-root-update@chpasswd.service ssh.service`
    // matched. Every grant is therefore an exact command now.
    for (const file of SUDOERS) {
      const grants = grantsIn(file);
      expect(grants.length).toBeGreaterThan(0);
      for (const grant of grants) {
        expect(grant, `sudoers grant still uses a wildcard: ${grant}`).not.toMatch(/[*?]/);
      }
    }

    // And no rule names a systemd UNIT for the root-step template at all: the
    // web server reaches those through the root-owned launcher, which builds the
    // unit name itself from a step it has checked. TASK-539.
    const primary = grantsIn(SUDOERS[0]);
    for (const grant of primary) {
      expect(grant, `a root-step unit is still named in a grant: ${grant}`)
        .not.toContain("clawbox-root-update@");
    }
    expect(primary).toContain("/usr/local/libexec/clawbox/clawbox-run-root-step.sh");
  });

  it("keeps the launcher's list identical to the TypeScript one", () => {
    // The launcher is the outer bound on what the WEB SERVER may start as root,
    // and it is the only thing config/clawbox-sudoers grants for that purpose.
    // If the two lists drift, either a product feature stops working or a step
    // becomes startable that nobody reviewed.
    const shell = shellList(read(LAUNCHER), "WEB_ROOT_STEPS");
    expect([...shell].sort()).toEqual([...WEB_ROOT_STEPS].sort());
  });

  it("keeps the web-startable list inside the dispatcher's own allow-list", () => {
    const allowed = new Set(shellList(read(DISPATCHER), "ALLOWED_STEPS"));
    for (const step of WEB_ROOT_STEPS) {
      expect(allowed.has(step), `${step} is web-startable but the dispatcher refuses it`).toBe(true);
    }
    // ...and strictly narrower: the dispatcher also covers operator-only steps.
    expect(WEB_ROOT_STEPS.length).toBeLessThan(allowed.size);
  });

  it("offers every UI step through the launcher", () => {
    for (const step of UI_ROOT_STEPS) {
      expect(WEB_ROOT_STEPS.includes(step), `${step} is a UI button with no way to start`).toBe(true);
    }
  });

  it("verifies what root is about to run before it runs it", () => {
    // GAP 2: the dispatcher is root-owned, but the file it exec'd was not.
    // install.sh records everything root runs on clawbox's behalf and the
    // dispatcher refuses a tree that no longer matches that record.
    const dispatcher = read(DISPATCHER);
    expect(dispatcher).toContain("clawbox-root-manifest.sh");
    expect(dispatcher).toMatch(/--verify/);
    const verifyAt = dispatcher.indexOf("--verify");
    const execAt = dispatcher.indexOf("exec /bin/bash");
    expect(execAt, "the dispatcher must still exec install.sh").toBeGreaterThan(-1);
    expect(verifyAt, "the verification must happen BEFORE the exec").toBeLessThan(execAt);
  });

  it("installs the root-owned copies before the sudoers rules that point at them", () => {
    const sh = read(INSTALL_SH);
    expect(sh).toContain("install_root_libexec");
    // The ollama grant's target must be the installed copy, not the repo one.
    expect(read(SUDOERS[1])).toContain("/usr/local/libexec/clawbox/optimize-ollama.sh");
    // Asserted as an ORDER inside step_systemd_services rather than as one
    // literal line, so the check survives the surrounding text changing (it did
    // not, before TASK-445 round 2 rewrote the sudoers install).
    const step = sh.slice(sh.indexOf("step_systemd_services() {"));
    const body = step.slice(0, step.indexOf("\n}"));
    const libexecAt = body.indexOf("install_root_libexec");
    const grantAt = body.indexOf("install_sudoers_dropin");
    expect(libexecAt, "install_root_libexec must be called by step_systemd_services").toBeGreaterThan(-1);
    expect(grantAt, "the sudoers drop-in must be installed by step_systemd_services").toBeGreaterThan(-1);
    expect(libexecAt, "install_root_libexec must run before the sudoers drop-in that points at it")
      .toBeLessThan(grantAt);
  });

  it("never lets a root unit exec or source the clawbox-writable tree", () => {
    // Security scan #21 / the #8 residual. The rule above covered ONE unit and
    // the sudoers grants; clawbox-ap.service, clawbox-ap-watchdog.service (root,
    // ExecStart on scripts/ the tree, fired every 20 s by its timer) and their
    // EnvironmentFile= on data/network.env were never looked at, which is how a
    // zero-privilege clawbox → root path survived TASK-445. Generic now: every
    // config/*.service and *.timer systemd runs as root (no User=, or one that
    // names root — see runsAsRoot), and nothing it executes or loads may live
    // under /home/clawbox: not as the program, not as an argument, not as a
    // quoted EnvironmentFile. A prefix test let `ExecStart=/usr/bin/bash
    // /home/clawbox/clawbox/x.sh` through.
    const configDir = path.join(REPO, "config");
    const units = fs.readdirSync(configDir).filter((f) => /\.(service|timer)$/.test(f));
    expect(units.length).toBeGreaterThan(0);
    // No exemptions. clawbox-heartbeat.service used to be the one: it loaded
    // its own credential from data/ into root's curl under ProtectHome=yes,
    // which is the same class (systemd filters neither ownership nor variable
    // names, so an LD_PRELOAD line in that file would have reached root's
    // curl on the timer's next tick); it runs as `User=clawbox` now, which
    // this loop verifies by skipping it.
    const DIRECTIVES = /^(ExecStart|ExecStartPre|ExecStartPost|ExecStop|ExecStopPost|ExecReload|EnvironmentFile)=(.+)$/gm;
    let rootUnits = 0;
    for (const unit of units) {
      const text = read(path.join(configDir, unit));
      if (!runsAsRoot(text)) continue;
      rootUnits += 1;
      for (const m of text.matchAll(DIRECTIVES)) {
        const [, , raw] = m;
        // systemd's own prefixes: `-` (optional), `+`/`!`/`!!` (privilege), `@`
        // (argv[0]), `:` (no env expansion).
        const value = raw.trim().replace(/^[-+!@:]+/, "");
        expect(value, `${unit} runs root over a clawbox-writable path: ${m[0]}`).not.toContain("/home/clawbox");
        expect(value, `${unit}: ${m[0]}`).not.toContain("$PROJECT_DIR");
      }
    }
    expect(rootUnits, "the two AP units and the root-step template at least").toBeGreaterThanOrEqual(3);
  });

  it("installs, root-owned, every libexec script a root unit names", () => {
    // A unit pointing at /usr/local/libexec/clawbox/x.sh that install.sh never
    // puts there is a hotspot that cannot start — the failure the ordering pin
    // in install-post-update-units.test.ts is about, in its permanent form.
    const configDir = path.join(REPO, "config");
    const sh = read(INSTALL_SH);
    const libexecFn = sh.slice(sh.indexOf("install_root_libexec() {"));
    const body = libexecFn.slice(0, libexecFn.indexOf("\n}"));
    for (const unit of fs.readdirSync(configDir).filter((f) => /\.service$/.test(f))) {
      const text = read(path.join(configDir, unit));
      if (!runsAsRoot(text)) continue;
      for (const m of text.matchAll(/^Exec(?:Start|Stop|StartPre)=(?:[-+!@:]+)?(\/usr\/local\/libexec\/clawbox\/(\S+))/gm)) {
        expect(body, `${unit} names ${m[1]} but install_root_libexec does not install it`).toContain(m[2]);
      }
    }
  });

  it("keeps the AP units' environment on the root-owned twin of data/network.env", () => {
    // Moving the scripts alone would not have been enough: ap-watchdog.sh takes
    // CLAWBOX_START_AP from its environment (for the tests' witness), so an
    // EnvironmentFile clawbox can write would have been the same hole by
    // another name. /etc/clawbox/network.env is root 0644, written by
    // step_network_setup beside the data/ copy, and already what
    // clawbox-root-update@.service loads.
    for (const unit of ["clawbox-ap.service", "clawbox-ap-watchdog.service"]) {
      const text = read(path.join(REPO, "config", unit));
      const envFiles = [...text.matchAll(/^EnvironmentFile=(.+)$/gm)].map((m) => m[1]);
      expect(envFiles, unit).toEqual(["-/etc/clawbox/network.env"]);
    }
    expect(read(INSTALL_SH)).toContain("> /etc/clawbox/network.env");
  });

  it("points the other root readers of start-ap.sh at the root-owned copy", () => {
    // The NetworkManager dispatcher hook (root, from dispatcher.d) and the
    // watchdog both used to derive START_AP from $CLAWBOX_ROOT/scripts.
    for (const name of ["nm-dispatcher-failover.sh", "ap-watchdog.sh"]) {
      const src = read(path.join(REPO, "scripts", name));
      const m = /^START_AP="([^"]*)"$/m.exec(src);
      expect(m, `${name}: START_AP assignment`).not.toBeNull();
      expect(m![1], name).toBe("${CLAWBOX_START_AP:-/usr/local/libexec/clawbox/start-ap.sh}");
    }
    // scripts/recover.sh and step_recover fall back to the tree copy ONLY when
    // the libexec one is absent (recovery must work mid-migration); the libexec
    // copy is the one tried first.
    const recover = read(path.join(REPO, "scripts", "recover.sh"));
    expect(recover.indexOf("/usr/local/libexec/clawbox/start-ap.sh"))
      .toBeLessThan(recover.indexOf("/home/clawbox/clawbox/scripts/start-ap.sh"));
    const sh = read(INSTALL_SH);
    const stepRecover = sh.slice(sh.indexOf("step_recover() {"));
    const recoverBody = stepRecover.slice(0, stepRecover.indexOf("\n}"));
    expect(recoverBody).toContain('"$ROOT_LIBEXEC_DIR/start-ap.sh"');
    expect(recoverBody.indexOf("$ROOT_LIBEXEC_DIR/start-ap.sh"))
      .toBeLessThan(recoverBody.indexOf("$PROJECT_DIR/scripts/start-ap.sh"));
  });

  it("writes the first-boot VNC unit against the root-owned copy, not the tree", () => {
    // install.sh writes clawbox-firstboot-vnc.service from a heredoc (root, no
    // User=). It used to name $PROJECT_DIR/scripts/… and `chown root:root` that
    // file, which the tree-wide chown undid after every git reset.
    const sh = read(INSTALL_SH);
    const start = sh.indexOf("<<FIRSTBOOTVNC");
    expect(start).toBeGreaterThan(-1);
    const heredoc = sh.slice(start, sh.indexOf("\nFIRSTBOOTVNC", start));
    expect(heredoc).not.toMatch(/^User=/m);
    for (const m of heredoc.matchAll(/^Exec(?:Start|StartPre|Stop)=(.+)$/gm)) {
      expect(m[1], `firstboot-vnc: ${m[0]}`).not.toContain("$PROJECT_DIR");
      expect(m[1], `firstboot-vnc: ${m[0]}`).not.toContain("/home/clawbox");
    }
    expect(heredoc).toContain("ExecStart=$ROOT_LIBEXEC_DIR/ensure-vnc-on-first-boot.sh");
    expect(sh).not.toContain('chown root:root "$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh"');
  });

  it("gates install.sh's self-update on an explicit opt-in", () => {
    const sh = read(INSTALL_SH);
    expect(sh).toContain("CLAWBOX_ALLOW_SELF_UPDATE");
    expect(sh).toContain("_clawbox_may_self_update");
  });
});

describe("runsAsRoot (the test's own reading of a unit)", () => {
  it("treats User=root, User=0 and an empty User= as root, and a named user or DynamicUser as not", () => {
    expect(runsAsRoot("[Service]\nExecStart=/bin/true\n")).toBe(true);
    expect(runsAsRoot("[Service]\nUser=root\n")).toBe(true);
    expect(runsAsRoot("[Service]\nUser=0\n")).toBe(true);
    expect(runsAsRoot("[Service]\nUser=\n")).toBe(true);
    expect(runsAsRoot("[Service]\nUser=clawbox\n")).toBe(false);
    // The last assignment wins, as in systemd.
    expect(runsAsRoot("[Service]\nUser=clawbox\nUser=root\n")).toBe(true);
    expect(runsAsRoot("[Service]\nDynamicUser=yes\n")).toBe(false);
  });
});

describe("install_root_libexec: a copy that did not land is never a success", () => {
  // The recorded case is the UPDATE path. step_post_update runs its fixups as
  // `step_x || echo "(non-fatal)"`, and bash runs a function called in an
  // OR-list with errexit OFF, so a failed install_root_file inside
  // install_root_libexec was followed by successful commands, the function
  // returned 0, and the units and grants installed after it named a copy that
  // was not there (a first update onto a fresh libexec) or was stale. Every
  // run here is in that OR-list shape on purpose.
  const sh = read(INSTALL_SH);

  /** Run install_root_libexec against a fake tree; failOn names the copy whose install fails. */
  function run(failOn: string): { stdout: string; landed: (name: string) => boolean } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-libexec-"));
    const project = path.join(tmp, "project");
    const libexec = path.join(tmp, "libexec");
    fs.mkdirSync(path.join(project, "config"), { recursive: true });
    fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
    // No clawbox-resource-limits.env: its destination is the real /etc/clawbox,
    // and the test must never write there.
    for (const f of ["clawbox-root-manifest.sh", "clawbox-run-root-step.sh", "clawbox-root-step.sh"]) {
      fs.writeFileSync(path.join(project, "config", f), "#!/bin/bash\n");
    }
    for (const f of ["start-ap.sh", "stop-ap.sh", "ap-watchdog.sh", "ensure-vnc-on-first-boot.sh"]) {
      fs.writeFileSync(path.join(project, "scripts", f), "#!/bin/bash\n");
    }
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `ROOT_LIBEXEC_DIR=${JSON.stringify(libexec)}`,
      `FAIL_ON=${JSON.stringify(failOn)}`,
      // `install -d -o root` cannot run unprivileged; the directories are the
      // point of those calls, and only one under the tmp tree is ever created —
      // a runner that executes vitest as root must not gain an /etc/clawbox
      // from a unit test.
      'install() { if [ "$1" = -d ]; then case "${@: -1}" in "$ROOT_LIBEXEC_DIR"*) mkdir -p -- "${@: -1}";; esac; fi; }',
      // install_root_file's contract, not its code: 1 for the named copy, else the file lands.
      'install_root_file() { if [ -n "$FAIL_ON" ] && [ "$(basename -- "$2")" = "$FAIL_ON" ]; then return 1; fi; : > "$2"; }',
      "write_root_exec_manifest() { return 0; }",
      'record_provision_failure() { echo "recorded:$1"; }',
      shellFn(sh, "install_root_libexec"),
      // The OR-list shape of every step_post_update fixup.
      'install_root_libexec || echo "rc=$?"',
      'echo "after"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    // Snapshot what landed, then remove the tree: nothing of this run outlives it.
    const landedNames = fs.existsSync(libexec) ? fs.readdirSync(libexec) : [];
    fs.rmSync(tmp, { recursive: true, force: true });
    return { stdout: r.stdout + r.stderr, landed: (name) => landedNames.includes(name) };
  }

  it("returns non-zero and records root_libexec when one copy fails, in the OR-list shape", () => {
    const { stdout, landed } = run("start-ap.sh");
    expect(stdout).toContain("rc=1");
    expect(stdout).toContain("recorded:root_libexec");
    expect(stdout).toContain("could not install");
    // COLLECTED, not returned at the first failure: the copies are independent
    // (install_root_file is atomic), and the dispatcher after the manifest
    // block still lands, or a stale manifest would refuse every root step.
    expect(landed("stop-ap.sh"), "the copies after the failed one still land").toBe(true);
    expect(landed("clawbox-root-step.sh"), "the dispatcher still lands").toBe(true);
    expect(landed("start-ap.sh")).toBe(false);
  });

  it("returns zero and records nothing when every copy lands", () => {
    const { stdout, landed } = run("");
    expect(stdout).not.toContain("rc=");
    expect(stdout).not.toContain("recorded:");
    expect(stdout).toContain("after");
    expect(landed("clawbox-root-step.sh")).toBe(true);
  });

  it("names step_systemd_services as the repair for root_libexec", () => {
    expect(shellFn(sh, "provision_repair_step")).toMatch(/root_libexec\)\s+printf 'systemd_services'/);
  });

  it("no caller hides the result in a `[ -x … ] || install_root_libexec` list", () => {
    // Over the CODE only: the comments beside the two callers name the shape
    // they replaced, and a pin that failed on its own explanation would make
    // the explanation the thing to delete.
    const code = sh.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    expect(code).not.toMatch(/\]\s*\|\|\s*install_root_libexec\b/);
    // The units and the sudoers grant installed by step_systemd_services name
    // the copies: over copies that are not current they point at nothing.
    expect(shellFn(sh, "step_systemd_services")).toMatch(/install_root_libexec \|\| \{/);
    // The firstboot unit is gated on the FILE — a function's 0 is not a file.
    const vncInstall = shellFn(sh, "step_vnc_install");
    expect(vncInstall).toContain("install_root_libexec || return 1");
    const fileGate = vncInstall.indexOf('if [ ! -x "$ROOT_LIBEXEC_DIR/ensure-vnc-on-first-boot.sh" ]; then\n    echo');
    expect(fileGate).toBeGreaterThan(-1);
    expect(fileGate).toBeLessThan(vncInstall.indexOf("<<FIRSTBOOTVNC"));
    // The refresh keeps the unrelated clawbox-vnc.service work and returns the
    // collected status at its END, so step_post_update's warning is honest and
    // the update is not cut short over it.
    const vncRefresh = shellFn(sh, "step_vnc_refresh");
    expect(vncRefresh).toContain("install_root_libexec || firstboot_rc=1");
    expect(vncRefresh.trimEnd().endsWith('return "$firstboot_rc"\n}')).toBe(true);
  });
});
