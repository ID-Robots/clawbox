import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PEP 668 (externally-managed-environment) blocks `pip install --user`
// outright on Ubuntu 24.04+ / JetPack 7, which is where the ClawKeep and
// Hugging Face CLI installs in install.sh used to fail. These pin the fix:
// pipx is preferred (it builds into its own isolated venv, immune to the
// distro's PEP 668 policy), pip --user only runs as a fallback for hosts
// where pipx could not be provisioned (still correct on JetPack 6.2 /
// Ubuntu 22.04, which predates PEP 668 enforcement), and neither path ever
// reaches for `--break-system-packages`.

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

describe("installer never uses --break-system-packages", () => {
  it("nowhere in install.sh", () => {
    expect(INSTALL_SH).not.toContain("--break-system-packages");
  });
});

describe("ensure_pipx bootstrap helper", () => {
  it("is defined before step_apt_update, and installs the pipx apt package", () => {
    const helperAt = INSTALL_SH.indexOf("ensure_pipx() {");
    const stepApAt = INSTALL_SH.indexOf("step_apt_update() {");
    expect(helperAt).toBeGreaterThan(-1);
    expect(stepApAt).toBeGreaterThan(-1);
    expect(helperAt).toBeLessThan(stepApAt);

    const fn = extractShellFunction("ensure_pipx");
    // Idempotent: a pipx already on PATH short-circuits before any apt call.
    expect(fn).toMatch(/command -v pipx.*&&\s*return 0/);
    expect(fn).toContain("apt-get install -y -qq pipx");
  });

  it("refreshes apt metadata before installing pipx, in that order, using noninteractive APT", () => {
    // A root-owned standalone step dispatch can hit
    // this function on a boot where step_apt_update never ran, so the local
    // apt cache may be empty/stale — installing pipx without an update
    // first can 404 on a fresh image.
    const fn = extractShellFunction("ensure_pipx");
    const updateAt = fn.indexOf("apt-get update -qq");
    const installAt = fn.indexOf("apt-get install -y -qq pipx");
    expect(updateAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(updateAt).toBeLessThan(installAt);
    expect(fn).toMatch(/DEBIAN_FRONTEND=noninteractive apt-get update -qq/);
    expect(fn).toMatch(/DEBIAN_FRONTEND=noninteractive apt-get install -y -qq pipx/);
  });

  it("does not silently discard the apt-get install result — failures surface a warning, not a swallowed exit code", () => {
    const fn = extractShellFunction("ensure_pipx");
    // The old body piped stderr to /dev/null and unconditionally forced
    // success (`|| true`) on the install line itself, hiding *why* pipx
    // ended up unavailable. The function's real signal is still the final
    // `command -v pipx` probe, but a failed install must now be audible.
    expect(fn).not.toMatch(/apt-get install -y -qq pipx\s*2>\/dev\/null\s*\|\|\s*true/);
    expect(fn).toMatch(/apt-get install -y -qq pipx; then\s*\n\s*echo\s+"\s*Warning: apt-get install pipx failed"/);
  });

  it("tolerates an update failure (offline JetPack 6.2) rather than aborting before the install attempt", () => {
    const fn = extractShellFunction("ensure_pipx");
    expect(fn).toMatch(/if ! DEBIAN_FRONTEND=noninteractive apt-get update -qq; then[\s\S]*fi/);
    // The update failing must not `return` early — install (and the final
    // command -v probe that determines the real fallback decision) still run.
    const updateBlockEnd = fn.indexOf("fi", fn.indexOf("apt-get update -qq"));
    const updateBlock = fn.slice(fn.indexOf("apt-get update -qq"), updateBlockEnd);
    expect(updateBlock).not.toContain("return");
  });

  it("pipx is provisioned up front by step_apt_update, for the fast path on a fresh install", () => {
    const fn = extractShellFunction("step_apt_update");
    expect(fn).toMatch(/apt-get install -y -qq[^\n]*\bpipx\b/);
  });

  it("both standalone-dispatchable pip installers call ensure_pipx rather than assuming apt_update already ran", () => {
    // step_clawkeep_install and step_llamacpp_install's Hugging Face CLI
    // install can each run outside the full-install sequence (e.g. via
    // the root-owned step service), so neither may assume
    // step_apt_update has provisioned pipx on this boot already.
    expect(extractShellFunction("step_clawkeep_install")).toContain("ensure_pipx");
    expect(extractShellFunction("step_llamacpp_install")).toContain("ensure_pipx");
  });
});

describe("ClawKeep install prefers pipx, Ubuntu 22.04 and 24.04-safe", () => {
  const fn = extractShellFunction("step_clawkeep_install");

  it("installs via pipx --force when pipx is available", () => {
    expect(fn).toContain("pipx install --force '$PROJECT_DIR/clawkeep'");
  });

  it("falls back to the pip --user path only when pipx could not be provisioned", () => {
    expect(fn).toMatch(/if ! ensure_pipx; then[\s\S]*step_clawkeep_install_pip_user_fallback/);
  });

  it("clears stale pre-pipx shims first, so pipx's own symlinks aren't skipped", () => {
    // pipx refuses to overwrite files it did not create. Without this, a
    // device already carrying a pip --user-installed clawkeep/clawkeepd
    // would keep running the stale binary after every future `git pull`.
    const rmAt = fn.indexOf("rm -f $CLAWBOX_HOME/.local/bin/clawkeep $CLAWBOX_HOME/.local/bin/clawkeepd");
    const pipxInstallAt = fn.indexOf("pipx install --force");
    expect(rmAt).toBeGreaterThan(-1);
    expect(pipxInstallAt).toBeGreaterThan(-1);
    expect(rmAt).toBeLessThan(pipxInstallAt);
  });

  it("verifies clawkeepd landed on disk before declaring success", () => {
    expect(fn).toContain('local CLAWKEEPD_BIN="$CLAWBOX_HOME/.local/bin/clawkeepd"');
    expect(fn).toMatch(/if \[ ! -x "\$CLAWKEEPD_BIN" \]; then/);
  });

  it("the pip --user fallback exists, still forces a reinstall, and never adds --break-system-packages", () => {
    const fallback = extractShellFunction("step_clawkeep_install_pip_user_fallback");
    expect(fallback).toContain("pip install --user --force-reinstall --no-deps --use-pep517");
    expect(fallback).not.toContain("--break-system-packages");
  });
});

describe("Hugging Face CLI install prefers pipx, Ubuntu 22.04 and 24.04-safe", () => {
  const fn = extractShellFunction("step_llamacpp_install");

  it("installs via pipx --force when pipx is available", () => {
    expect(fn).toContain("pipx install --force 'huggingface_hub[cli]'");
  });

  it("clears stale pre-pipx shims (hf, huggingface-cli) before the pipx install", () => {
    const rmAt = fn.indexOf("rm -f $CLAWBOX_HOME/.local/bin/hf $CLAWBOX_HOME/.local/bin/huggingface-cli");
    const pipxInstallAt = fn.indexOf("pipx install --force 'huggingface_hub[cli]'");
    expect(rmAt).toBeGreaterThan(-1);
    expect(pipxInstallAt).toBeGreaterThan(-1);
    expect(rmAt).toBeLessThan(pipxInstallAt);
  });

  it("the pipx migration is dispatched on ensure_pipx succeeding, not gated behind an `hf` presence check", () => {
    // Regression guard for the original bug: `if ! command -v hf` wrapped
    // the whole migration, so a device with a working pre-existing pip
    // --user `hf` never got migrated to pipx. The pipx branch must now be
    // reachable purely from `ensure_pipx` succeeding.
    expect(fn).toMatch(/if ensure_pipx; then\s*\n\s*echo\s+"\s*Installing Hugging Face CLI via pipx"/);
    // And no gate of the form `if ! ... command -v hf ... ; then` wraps the
    // pipx branch anywhere ahead of it in this function.
    const pipxBranchAt = fn.indexOf("if ensure_pipx; then");
    const staleGateAt = fn.indexOf('if ! as_clawbox_login "command -v hf"');
    expect(pipxBranchAt).toBeGreaterThan(-1);
    // The only remaining `command -v hf` check is the "already installed,
    // pipx unavailable" probe, which must come AFTER (inside the ensure_pipx
    // failure branch), never wrapping the pipx branch itself.
    if (staleGateAt !== -1) {
      expect(staleGateAt).toBeGreaterThan(pipxBranchAt);
    }
  });

  it("falls back to plain pip --user, or leaves an already-working install alone, only when ensure_pipx fails", () => {
    expect(fn).toMatch(
      /if ensure_pipx; then[\s\S]*pipx install --force 'huggingface_hub\[cli\]'[\s\S]*elif as_clawbox_login "command -v hf" &>\/dev\/null; then[\s\S]*already installed[\s\S]*else[\s\S]*pip install --user --upgrade 'huggingface_hub\[cli\]'/,
    );
  });

  it("the pip --user fallback only runs when hf is truly absent (both ensure_pipx and hf presence gate it)", () => {
    const elifAt = fn.indexOf('elif as_clawbox_login "command -v hf" &>/dev/null; then');
    const pipInstallAt = fn.indexOf("pip install --user --upgrade 'huggingface_hub[cli]'");
    expect(elifAt).toBeGreaterThan(-1);
    expect(pipInstallAt).toBeGreaterThan(elifAt);
  });
});

describe("no unsafe system-wide pip mutation was introduced", () => {
  it("every actual pip invocation in install.sh stays scoped to --user", () => {
    // Matches real invocations only (`python3 -m pip install` / `pip3
    // install`) — deliberately narrower than a bare "pip install" substring
    // search, which would also match the prose in comments and echoed
    // troubleshooting text elsewhere in this same file.
    const invocation = /(?:python3\s+-m\s+pip|pip3)\s+install\b/;
    const offenders = INSTALL_SH.split("\n")
      .map((l) => l.trim())
      .filter((l) => invocation.test(l) && !/--user\b/.test(l));
    // jetson-stats (`pip3 install jetson-stats`) legitimately installs into
    // system site-packages — it's an NVIDIA-recommended root-level tool, not
    // one of the two PEP 668-hardened CLI installs this change targets.
    const allowed = offenders.filter((l) => !l.includes("jetson-stats"));
    expect(allowed).toEqual([]);
  });
});
