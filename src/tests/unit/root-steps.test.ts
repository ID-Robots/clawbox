import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { SELF_UPDATING_ROOT_STEPS, UI_ROOT_STEPS, isUiRootStep, maySelfUpdate } from "@/lib/root-steps";

/**
 * The root-privilege boundary is: clawbox-setup (User=clawbox) →
 * `sudo systemctl start clawbox-root-update@<step>.service` → install.sh as
 * root. Three things have to hold for that to be a boundary at all, and each is
 * enforced in a different file — so they are pinned together here. TASK-445.
 */

const REPO = path.resolve(__dirname, "../../..");
const DISPATCHER = path.join(REPO, "config", "clawbox-root-step.sh");
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

    // The instances the web server really starts, spelled out.
    const primary = read(SUDOERS[0]);
    for (const step of ["chpasswd", "set_hostname", "restart_ap", "llamacpp_install"]) {
      expect(primary).toContain(`clawbox-root-update@${step}.service`);
    }
    // The update family runs through the updater's own root chain, not through
    // a sudo grant the web server can reach.
    for (const step of SELF_UPDATING_ROOT_STEPS) {
      expect(primary, `${step} must not be startable through sudo`)
        .not.toContain(`clawbox-root-update@${step}.service`);
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

  it("gates install.sh's self-update on an explicit opt-in", () => {
    const sh = read(INSTALL_SH);
    expect(sh).toContain("CLAWBOX_ALLOW_SELF_UPDATE");
    expect(sh).toContain("_clawbox_may_self_update");
  });
});
