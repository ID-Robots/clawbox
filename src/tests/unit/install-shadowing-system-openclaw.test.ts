import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A real bash per case: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * 2026-09-18 — Settings → AI Providers → ClawBox AI answered "Credential
 * migration failed. The subscription sign-in was rolled back" to every sign-in
 * on a box that carried TWO OpenClaw cores: the managed 2026.9.3 under
 * `~/.npm-global`, which the gateway ran, and a root-owned 2026.7.1-2 under
 * `/usr` (a `sudo npm install -g openclaw` from July — the distro npm's default
 * prefix is /usr), which the web server ran, because it looked for the CLI
 * beside its own `/usr/bin/node` first. The new core had migrated openclaw.json
 * and the state database; the old CLI refused both.
 *
 * `findOpenclawBin` asks the managed prefix first now (see
 * openclaw-bin-resolution.test.ts). This is the other half: every install and
 * every update takes the second core off the box. It is root deleting under
 * /usr, so what it must NOT touch is pinned as hard as what it removes. The
 * shipped function is driven under bash against tmp prefixes handed to it as
 * arguments — the seam it has instead of an environment variable.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

type Box = { dir: string; managed: string; usr: string; usrLocal: string };

/** npm's global layout at `prefix`: the tree, and the relative launcher link into it. */
function npmGlobalInstall(prefix: string, version: string, name = "openclaw") {
  const tree = path.join(prefix, "lib", "node_modules", "openclaw");
  mkdirSync(tree, { recursive: true });
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  writeFileSync(path.join(tree, "openclaw.mjs"), `#!/usr/bin/env bash\necho 'OpenClaw ${version}'\n`);
  chmodSync(path.join(tree, "openclaw.mjs"), 0o755);
  writeFileSync(path.join(tree, "package.json"), JSON.stringify({ name, version }, null, 2));
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(prefix, "bin", "openclaw"));
}

function makeBox(opts: { managed?: boolean } = {}): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-shadow-core-"));
  const box = { dir, managed: path.join(dir, "home", ".npm-global"), usr: path.join(dir, "usr"), usrLocal: path.join(dir, "usr-local") };
  for (const p of [box.usr, box.usrLocal]) mkdirSync(path.join(p, "bin"), { recursive: true });
  if (opts.managed !== false) npmGlobalInstall(box.managed, "2026.9.3");
  return box;
}

function run(box: Box, opts: { dpkgOwns?: string; args?: string[] } = {}) {
  const args = (opts.args ?? [box.usr, box.usrLocal]).map((a) => JSON.stringify(a)).join(" ");
  return spawnSync("bash", ["-c", [
    // errexit ON: the step that calls this is dispatched with it, so a bare
    // failing test inside the function would end the update.
    "set -euo pipefail",
    `NPM_PREFIX=${JSON.stringify(box.managed)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(box.managed, "bin", "openclaw"))}`,
    // dpkg answers for exactly one path, or for none.
    `dpkg() { [ "$1" = "-S" ] && [ -n ${JSON.stringify(opts.dpkgOwns ?? "")} ] && [ "$2" = ${JSON.stringify(opts.dpkgOwns ?? "")} ]; }`,
    shellFunction("remove_shadowing_system_openclaw"),
    `remove_shadowing_system_openclaw ${args}`,
    "echo FINISHED",
  ].join("\n")], { encoding: "utf-8", timeout: 20_000 });
}

const treeOf = (prefix: string) => path.join(prefix, "lib", "node_modules", "openclaw");
const launcherOf = (prefix: string) => path.join(prefix, "bin", "openclaw");
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

describe("remove_shadowing_system_openclaw", () => {
  it("removes a second npm-global core and its launcher, and leaves the managed core whole", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      // Something else npm linked beside it: not ours, not touched.
      writeFileSync(path.join(box.usr, "bin", "node"), "#!/bin/sh\n");
      symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", path.join(box.usr, "bin", "npm"));
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("FINISHED");
      expect(r.stdout).toMatch(/Removing a second OpenClaw core \(2026\.7\.1-2\)/);
      expect(existsSync(treeOf(box.usr))).toBe(false);
      expect(isLink(launcherOf(box.usr))).toBe(false);
      expect(existsSync(path.join(box.usr, "bin", "node"))).toBe(true);
      expect(isLink(path.join(box.usr, "bin", "npm"))).toBe(true);
      // The managed core still answers.
      expect(spawnSync("bash", [launcherOf(box.managed)], { encoding: "utf-8" }).stdout).toContain("OpenClaw 2026.9.3");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("covers /usr/local as well as /usr in one pass", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      npmGlobalInstall(box.usrLocal, "2026.6.8");
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(treeOf(box.usr))).toBe(false);
      expect(existsSync(treeOf(box.usrLocal))).toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("says nothing and removes nothing on a box with one core", () => {
    const box = makeBox();
    try {
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("FINISHED");
      expect(r.stderr.trim()).toBe("");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("leaves a system-wide core alone while the managed one is not in place", () => {
    // A box whose own install has just failed keeps whatever core it has.
    const box = makeBox({ managed: false });
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/managed OpenClaw core is not in place/);
      expect(existsSync(treeOf(box.usr))).toBe(true);
      expect(isLink(launcherOf(box.usr))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  // Either half is enough: a package can ship the tree and create its launcher
  // in postinst, where dpkg does not own it — or the other way round.
  it.each([
    ["the launcher", (box: Box) => launcherOf(box.usr)],
    ["the tree", (box: Box) => path.join(treeOf(box.usr), "package.json")],
  ])("never removes an install a package owns — %s", (_what, owned) => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      const r = run(box, { dpkgOwns: owned(box) });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/a package owns the OpenClaw install/);
      expect(existsSync(treeOf(box.usr))).toBe(true);
      expect(isLink(launcherOf(box.usr))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("never removes a directory that is not an npm install of openclaw", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "1.0.0", "somebody-elses-package");
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/does not look like an npm install of openclaw/);
      expect(existsSync(treeOf(box.usr))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("never follows a linked tree into somebody's checkout", () => {
    // `npm link` from a source checkout: the entry under node_modules is a
    // symlink, and the folder it points at is a person's work.
    const box = makeBox();
    try {
      const checkout = path.join(box.dir, "src-openclaw");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "openclaw", version: "0.0.0-dev" }));
      mkdirSync(path.join(box.usr, "lib", "node_modules"), { recursive: true });
      symlinkSync(checkout, treeOf(box.usr));
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(path.join(checkout, "package.json"))).toBe(true);
      expect(isLink(treeOf(box.usr))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("leaves a hand-written launcher alone, and says so", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      rmSync(launcherOf(box.usr));
      writeFileSync(launcherOf(box.usr), "#!/bin/sh\nexec /opt/somewhere/openclaw \"$@\"\n");
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(treeOf(box.usr))).toBe(false);
      expect(existsSync(launcherOf(box.usr))).toBe(true);
      expect(r.stderr).toMatch(/is not a link into that install/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("never removes the tree the managed launcher itself resolves into", () => {
    // A box someone wired by hand: ~/.npm-global/bin/openclaw -> the /usr core.
    const box = makeBox({ managed: false });
    try {
      npmGlobalInstall(box.usr, "2026.9.3");
      mkdirSync(path.join(box.managed, "bin"), { recursive: true });
      symlinkSync(path.join(treeOf(box.usr), "openclaw.mjs"), launcherOf(box.managed));
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/managed launcher resolves into/);
      expect(existsSync(treeOf(box.usr))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("never treats the managed prefix as a second core, even when it is named", () => {
    // The managed launcher is a plain FILE here (a wrapper), so the
    // resolves-into guard cannot be what saves the tree: only the prefix guard
    // can, and it is the silent one.
    const box = makeBox({ managed: false });
    try {
      npmGlobalInstall(box.managed, "2026.9.3");
      rmSync(launcherOf(box.managed));
      writeFileSync(launcherOf(box.managed), "#!/usr/bin/env bash\necho 'OpenClaw 2026.9.3'\n");
      chmodSync(launcherOf(box.managed), 0o755);
      const r = run(box, { args: [box.managed] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("FINISHED");
      expect(existsSync(path.join(treeOf(box.managed), "package.json"))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("compares like with like behind a linked prefix: the launchers go, and a managed launcher wired into that core keeps it", () => {
    // /usr/local moved to another disk: the prefix as typed is not canonical,
    // and `readlink -f` answers canonical paths.
    const box = makeBox();
    try {
      const real = path.join(box.dir, "nvme", "local");
      mkdirSync(path.join(real, "bin"), { recursive: true });
      const linked = path.join(box.dir, "linked-local");
      symlinkSync(real, linked);
      npmGlobalInstall(linked, "2026.7.1-2");
      const r = run(box, { args: [linked] });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(treeOf(real))).toBe(false);
      expect(isLink(launcherOf(real))).toBe(false);
      expect(r.stderr).not.toMatch(/is not a link into that install/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
    const wired = makeBox({ managed: false });
    try {
      const real = path.join(wired.dir, "nvme", "local");
      mkdirSync(path.join(real, "bin"), { recursive: true });
      const linked = path.join(wired.dir, "linked-local");
      symlinkSync(real, linked);
      npmGlobalInstall(linked, "2026.9.3");
      mkdirSync(path.join(wired.managed, "bin"), { recursive: true });
      symlinkSync(path.join(treeOf(linked), "openclaw.mjs"), launcherOf(wired.managed));
      const r = run(wired, { args: [linked] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/managed launcher resolves into/);
      expect(existsSync(path.join(treeOf(real), "package.json"))).toBe(true);
    } finally {
      rmSync(wired.dir, { recursive: true, force: true });
    }
  });

  it("clears a dangling launcher a hand removal left behind", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      rmSync(treeOf(box.usr), { recursive: true, force: true });
      expect(isLink(launcherOf(box.usr))).toBe(true);
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/dangling OpenClaw launcher/);
      expect(isLink(launcherOf(box.usr))).toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("leaves a dangling launcher that points anywhere else — even one whose text says lib/node_modules/openclaw", () => {
    // A vendor's core on an /opt volume that is not mounted right now. The
    // words in the link are the same as npm's; the install is somebody else's,
    // so the target has to fall under THIS prefix's tree, not merely read like one.
    const box = makeBox();
    try {
      symlinkSync("/opt/vendor-not-mounted/lib/node_modules/openclaw/bin/openclaw", launcherOf(box.usr));
      symlinkSync("/opt/not-mounted/openclaw/bin/openclaw", launcherOf(box.usrLocal));
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("FINISHED");
      expect(isLink(launcherOf(box.usr))).toBe(true);
      expect(isLink(launcherOf(box.usrLocal))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("never removes a dangling launcher a package owns", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      rmSync(treeOf(box.usr), { recursive: true, force: true });
      const r = run(box, { dpkgOwns: launcherOf(box.usr) });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/a package owns .*bin\/openclaw/);
      expect(isLink(launcherOf(box.usr))).toBe(true);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("clears a dangling launcher behind a linked prefix", () => {
    // The same like-with-like rule as the live tree: /usr/local on another disk.
    const box = makeBox();
    try {
      const real = path.join(box.dir, "nvme", "local");
      mkdirSync(path.join(real, "bin"), { recursive: true });
      const linked = path.join(box.dir, "linked-local");
      symlinkSync(real, linked);
      npmGlobalInstall(linked, "2026.7.1-2");
      rmSync(treeOf(real), { recursive: true, force: true });
      const r = run(box, { args: [linked] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/dangling OpenClaw launcher/);
      expect(isLink(launcherOf(real))).toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("finishes a removal that was cut short, instead of disowning what is left", () => {
    // The box stopped inside the delete. `rm -rf` unlinks package.json long
    // before the bulk of the tree, so a half-deleted tree under its own name
    // would fail the identity check for ever; parked, the next run sweeps it.
    const box = makeBox();
    try {
      const parked = path.join(box.usr, "lib", "node_modules", ".openclaw-shadow-removed");
      mkdirSync(path.join(parked, "dist"), { recursive: true });
      writeFileSync(path.join(parked, "dist", "leftover.js"), "// 187 MB of this\n");
      const r = run(box);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Finishing an earlier removal/);
      expect(existsSync(parked)).toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("parks the tree with one rename before deleting it", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      const parked = path.join(box.usr, "lib", "node_modules", ".openclaw-shadow-removed");
      // The delete is what gets cut short: with `rm -rf` failing, the tree must
      // already be under the parked name, whole, for the next run to finish.
      const r = spawnSync("bash", ["-c", [
        "set -euo pipefail",
        `NPM_PREFIX=${JSON.stringify(box.managed)}`,
        `OPENCLAW_BIN=${JSON.stringify(launcherOf(box.managed))}`,
        "dpkg() { return 1; }",
        'rm() { case "$1" in -rf) return 1 ;; *) command rm "$@" ;; esac; }',
        shellFunction("remove_shadowing_system_openclaw"),
        `remove_shadowing_system_openclaw ${JSON.stringify(box.usr)}`,
      ].join("\n")], { encoding: "utf-8", timeout: 20_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(treeOf(box.usr))).toBe(false);
      expect(existsSync(path.join(parked, "package.json"))).toBe(true);
      expect(isLink(launcherOf(box.usr))).toBe(false);
      expect(r.stderr).toMatch(/WARN: could not remove the second OpenClaw core/);
      // …and the next run does.
      const again = run(box);
      expect(again.status, again.stderr).toBe(0);
      expect(existsSync(parked)).toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("warns and carries on when the core cannot be removed", () => {
    const box = makeBox();
    try {
      npmGlobalInstall(box.usr, "2026.7.1-2");
      // root's `rm` does not fail on a read-only directory, so the failure is
      // staged rather than provoked: the point is what the function does next.
      const r = spawnSync("bash", ["-c", [
        "set -euo pipefail",
        `NPM_PREFIX=${JSON.stringify(box.managed)}`,
        `OPENCLAW_BIN=${JSON.stringify(launcherOf(box.managed))}`,
        "dpkg() { return 1; }",
        "rm() { return 1; }",
        shellFunction("remove_shadowing_system_openclaw"),
        `remove_shadowing_system_openclaw ${JSON.stringify(box.usr)}`,
        "echo FINISHED",
      ].join("\n")], { encoding: "utf-8", timeout: 20_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("FINISHED");
      expect(r.stderr).toMatch(/WARN: could not remove the second OpenClaw core/);
      // The launcher it failed to delete IS a link into that install: saying it
      // was "left alone" because it is not would be the opposite of the truth.
      expect(r.stderr).not.toMatch(/is not a link into that install/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });
});

describe("step_openclaw_install calls the repair where the managed core is proven", () => {
  const start = INSTALL_SH.indexOf("\nstep_openclaw_install() {");
  const body = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start + 1));

  it("after the promotion and before doctor — never ahead of the install", () => {
    const call = body.indexOf("\n  remove_shadowing_system_openclaw\n");
    expect(call, "the step does not call remove_shadowing_system_openclaw").toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(body.indexOf("promote_staged_openclaw_core \"$_oc_stage\""));
    expect(call).toBeLessThan(body.indexOf("doctor --fix --non-interactive"));
  });

  it("with no arguments: the prefixes are the function's own, not a caller's", () => {
    expect(body).not.toMatch(/remove_shadowing_system_openclaw[ \t]+\S/);
    expect(shellFunction("remove_shadowing_system_openclaw")).toContain('[ "$#" -gt 0 ] || set -- /usr /usr/local');
  });
});
