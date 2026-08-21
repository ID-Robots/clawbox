import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `step_hermes_install` decides whether a device already has a working Hermes
 * agent. It used to decide it from the wrong file:
 *
 *   if [ -x "$CLAWBOX_HOME/.local/bin/hermes" ]; then
 *     echo "  Hermes already installed ($(… --version 2>/dev/null | head -1))"
 *     return 0
 *
 * `~/.local/bin/hermes` is a 4-line shim that execs
 * `~/.hermes/hermes-agent/venv/bin/python`. A factory reset removed ~/.hermes
 * and left the shim, so the guard matched, the `--version` probe returned
 * EMPTY into an echo whose value nobody looked at, and the step returned
 * success without reinstalling. Observed verbatim on the bench box:
 *
 *   Hermes already installed ()
 *
 * That is what made the brick unrecoverable: a full `install.sh` re-run hit the
 * same guard and did nothing, so the only remaining repair was a reflash.
 *
 * Two further properties are pinned here because both were load-bearing on
 * hardware:
 *  - the probe must run as the clawbox user (a root-run `hermes --version`
 *    writes root-owned __pycache__ into a clawbox-owned tree, and the
 *    factory-reset route — which runs as clawbox — then aborts on EACCES);
 *  - the reinstall must clear the stale ~/.hermes/hermes-agent husk first, or
 *    the upstream installer refuses with "Directory exists but is not a git
 *    repository" and the box stays broken.
 */
const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = readFileSync(INSTALL_SH_PATH, "utf-8");
const UPDATER_TS = readFileSync(path.join(REPO, "src/lib/updater.ts"), "utf-8");

const NL = String.fromCharCode(10);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

/**
 * The comments inside step_hermes_install quote the OLD buggy code verbatim —
 * that is the point of them — so an assertion run over the raw text would
 * match the very thing it is meant to forbid. Strip comment lines, and join
 * shell line-continuations so a statement split across lines is matched as
 * the single statement it is.
 */
function shellCode(fn: string): string {
  return fn
    .split(NL)
    .filter((line) => !line.trim().startsWith("#"))
    .join(NL)
    .replace(new RegExp("\\\\" + NL + "\\s*", "g"), " ");
}

const HERMES_INSTALL = extractShellFunction("step_hermes_install");
const HERMES_CODE = shellCode(HERMES_INSTALL);

describe("step_hermes_install treats a shim without an agent as NOT installed", () => {
  it("does not decide from the shim alone", () => {
    // The exact shape of the defect: a bare `[ -x .local/bin/hermes ]` test
    // whose success arm returns 0.
    expect(HERMES_CODE).not.toMatch(
      /if\s+\[\s+-x\s+"\$CLAWBOX_HOME\/\.local\/bin\/hermes"\s+\]\s*;\s*then/,
    );
  });

  it("requires the venv interpreter the shim execs", () => {
    // The shim's line 4 execs this path; its absence is the whole failure mode.
    expect(HERMES_CODE).toContain("$CLAWBOX_HOME/.hermes/hermes-agent");
    expect(HERMES_CODE).toMatch(/venv_python="\$agent_dir\/venv\/bin\/python"/);
    expect(HERMES_CODE).toMatch(/\[\s+-x\s+"\$venv_python"\s+\]/);
  });

  it("requires the --version probe to return something", () => {
    // `-n "$installed"` is the whole point: an EMPTY probe result must fall
    // through to the reinstall, not print "already installed ()".
    expect(HERMES_CODE).toMatch(/if\s+\[\s+-n\s+"\$installed"\s+\]/);
  });

  it("only says 'already installed' when it has a version to show", () => {
    const alreadyLine = HERMES_CODE.split(NL).find((l) => l.includes("Hermes already installed"));
    expect(alreadyLine).toBeDefined();
    // Interpolates the captured variable, never a bare inline command
    // substitution whose emptiness goes unchecked.
    expect(alreadyLine).toContain("$installed");
    expect(alreadyLine).not.toContain("--version");
  });

  // "moves the husk aside" and "reachability before the husk moves" used to be
  // asserted here as regexes over the shell text. They are now driven for real
  // against a fake HOME at the bottom of this file, which is stronger evidence
  // and does not have to be rewritten every time the branch is reshaped.

  it("prechecks and installs from the same URL", () => {
    // A precheck against a host the install does not then use would be worse
    // than no precheck — it would report reachable and still fail. Expressed
    // as: every curl call goes through the one variable, none carries a
    // literal URL of its own.
    const curlLines = HERMES_CODE.split(NL).filter((l) => l.includes("curl "));
    expect(curlLines.length).toBeGreaterThan(0);
    for (const line of curlLines) {
      expect(line, `curl must use $installer_url: ${line}`).toContain("$installer_url");
      expect(line, `curl must not carry its own URL: ${line}`).not.toContain("https://");
      // …and the URL reaches the install as an ARGUMENT, never spliced into a
      // `bash -c` string. Harmless while it is a local literal; free to keep
      // safe if it is ever made configurable.
      expect(line, `URL must not be interpolated into a shell string: ${line}`).not.toContain(
        "'$installer_url'",
      );
    }
  });

  it("hands the husk to the clawbox user so a later factory reset can delete it", () => {
    // Not reachable behaviourally — it needs root and a root-owned file. The
    // failure it prevents was reproduced on hardware: the husk is a verbatim
    // `mv` of a tree an older root-run probe wrote __pycache__ into, the reset
    // route runs as clawbox and does NOT spare a `.broken` name, so the unlink
    // fails with EACCES, the reset aborts at its failure gate — before the
    // password/WiFi/hostname reset and the reboot — and returns 500 every time.
    const mvIdx = HERMES_CODE.indexOf('mv "$agent_dir" "$agent_dir.broken"');
    expect(mvIdx).toBeGreaterThan(-1);
    expect(HERMES_CODE.slice(mvIdx)).toMatch(
      /chown -R "\$CLAWBOX_USER:\$CLAWBOX_USER" "\$agent_dir\.broken"/,
    );
    // …and it must not be able to abort the step: errexit is live at this
    // function's bare call sites, and the agent is moved aside at this exact
    // moment, so a chown failure would leave the device with nothing.
    expect(HERMES_CODE.slice(mvIdx)).toMatch(/chown -R[\s\S]{0,120}\|\| echo/);
  });

  it("never deletes the shim", () => {
    // Deleting it on the failure path left the operator with no `hermes`
    // command at all, and moving the husk back by hand did not bring it back.
    // On the success path the installer rewrites it anyway.
    expect(HERMES_CODE).not.toMatch(/rm -f "\$shim"/);
  });

  it("verifies the install afterwards instead of assuming it worked", () => {
    // The upstream installer is fetched over the network and its failure is
    // non-fatal, so the step has to check.
    // Anchored on the install invocation itself, not on the URL — the URL now
    // also appears in the `installer_url` declaration at the top of the
    // function, which would make this assertion pass vacuously.
    const installIdx = HERMES_CODE.indexOf("curl -fsSL");
    expect(installIdx).toBeGreaterThan(-1);
    const afterInstall = HERMES_CODE.slice(installIdx);
    expect(afterInstall).toContain("--version");
    expect(afterInstall).toMatch(/Warning: Hermes still does not run/);
  });
});

describe("step_hermes_install never runs hermes as root", () => {
  it("every hermes invocation goes through runuser as the clawbox user", () => {
    const invocations = HERMES_CODE.split(NL).filter(
      (line) => line.includes("--version") && line.includes("$shim"),
    );
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line, `hermes must not be executed as root: ${line}`).toContain(
        'runuser -u "$CLAWBOX_USER"',
      );
    }
  });

  it("passes HOME explicitly — hermes resolves ~/.hermes from $HOME", () => {
    // install.sh runs as root (HOME=/root); relying on runuser to reset HOME
    // would point the probe at /root/.hermes.
    const runuserLines = HERMES_CODE.split(NL).filter((l) => l.includes("runuser -u"));
    expect(runuserLines.length).toBeGreaterThan(0);
    for (const line of runuserLines) {
      // The upstream installer is the one exception: it is piped into `bash`,
      // which resolves the home directory for itself.
      if (line.includes("| bash")) continue;
      // Everything else — the two probes and the reachability precheck — runs
      // with the same environment, so none of them can quietly read /root's
      // dotfiles instead of the owner's.
      expect(line, `runuser call must pass HOME: ${line}`).toContain('HOME="$CLAWBOX_HOME"');
    }
  });
});

describe("an in-app update can heal a device a factory reset broke", () => {
  const POST_UPDATE = shellCode(extractShellFunction("step_post_update"));

  it("post_update reinstalls the Hermes agent", () => {
    // Without this the ONLY repair path was SSH. The in-app updater runs
    // post_update and rebuild_reboot; neither reached step_hermes_install, so
    // clicking UPDATE on a bricked box did nothing for it.
    expect(POST_UPDATE).toMatch(/^\s*step_hermes_install\b/m);
  });

  it("post_update re-caches the offline model", () => {
    expect(POST_UPDATE).toMatch(/^\s*step_llamacpp_model\b/m);
  });

  it("both are non-fatal, in the surrounding style", () => {
    for (const step of ["step_hermes_install", "step_llamacpp_model"]) {
      const line = POST_UPDATE.split(NL).find((l) => l.trim().startsWith(step));
      expect(line, `${step} must be called in post_update`).toBeDefined();
      expect(line, `${step} must not be able to fail the update`).toContain("|| echo");
    }
  });

  it("repairs the agent BEFORE the updater's hermes_edition step runs", () => {
    // setup-hermes-edition.sh hard-fails when ~/.local/bin/hermes is not
    // executable, and UPDATE_STEPS puts hermes_edition immediately after
    // post_update — so the repair has to be inside post_update, not after it.
    const postUpdateIdx = UPDATER_TS.indexOf('id: "post_update"');
    const hermesEditionIdx = UPDATER_TS.indexOf('id: "hermes_edition"');
    expect(postUpdateIdx).toBeGreaterThan(-1);
    expect(hermesEditionIdx).toBeGreaterThan(postUpdateIdx);
  });

  it("post_update's budget covers the repair rather than leaning on the advisory path", () => {
    // advisoryOnOverrun does not pause the update — it marks the step complete
    // and moves on to hermes_edition, which would then fail because the agent
    // is still mid-install. Measured on hardware: ~90s for the agent, plus a
    // 3.2 GB model download.
    const start = UPDATER_TS.indexOf('id: "post_update"');
    const block = UPDATER_TS.slice(start, start + 400);
    const match = block.match(/timeoutMs:\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const budgetMs = Number(match![1].replace(/_/g, ""));
    expect(budgetMs).toBeGreaterThanOrEqual(900_000);
  });
});

describe("llamacpp_model is a cheap, dispatchable step", () => {
  const LLAMACPP_MODEL = shellCode(extractShellFunction("step_llamacpp_model"));

  it("is dispatchable by the updater", () => {
    const open = INSTALL_SH.indexOf("DISPATCH_STEPS=(");
    const dispatch = INSTALL_SH.slice(open, INSTALL_SH.indexOf(")", open));
    expect(dispatch).toContain("llamacpp_model");
  });

  it("does not drag in the ~19-minute native llama.cpp build", () => {
    expect(LLAMACPP_MODEL).not.toContain("cmake");
    expect(LLAMACPP_MODEL).not.toContain("llama-server");
    expect(LLAMACPP_MODEL).toContain("ensure_llamacpp_model_cached");
  });

  it("is not gated on the Hermes harness — every edition loses the model", () => {
    // The factory-reset route wipes data/ on all editions, so an openclaw box
    // needs exactly the same repair.
    expect(LLAMACPP_MODEL).not.toContain("has_hermes_harness");
  });
});

/**
 * Everything above reads install.sh as TEXT. That pins the shape of the code
 * but not its behaviour: a regex cannot tell whether the branches actually go
 * where the text suggests, and it is exactly the branch ordering — probe, then
 * reachability, then move aside, then install — that decides whether a healthy
 * box survives this step. So drive the real function, with a fake HOME and
 * stubbed `runuser`/`curl`, and look at what it did to the filesystem.
 *
 * Same approach as install-llamacpp-prebuilt.test.ts: lift the one function
 * out with sed, because sourcing install.sh would install a machine.
 */
describe("step_hermes_install — behaviour, driven against a fake HOME", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-guard-"));
    // Stands in for the venv interpreter: all it has to do here is exist, be
    // executable, and answer --version.
    fs.writeFileSync(path.join(tmp, "fake-py"), "#!/bin/sh\necho 'Hermes 9.9.9'\n", { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const agentDir = () => path.join(tmp, ".hermes", "hermes-agent");
  const shimPath = () => path.join(tmp, ".local", "bin", "hermes");
  const exists = (p: string) => fs.existsSync(p);

  /**
   * The shim survives a factory reset — it lives outside ~/.hermes.
   * `answers: false` gives a shim that is present and executable but exits
   * non-zero, which is what a false-negative probe looks like from here.
   */
  function giveShim({ answers = true } = {}) {
    fs.mkdirSync(path.dirname(shimPath()), { recursive: true });
    // The real shim is 4 lines that exec the venv interpreter, so it answers
    // only while the agent behind it exists — the property the step now
    // depends on twice, since it no longer deletes the shim before installing.
    const venvPython = path.join(agentDir(), "venv", "bin", "python");
    fs.writeFileSync(
      shimPath(),
      answers ? `#!/bin/sh${NL}exec "${venvPython}" "$@"${NL}` : `#!/bin/sh${NL}exit 1${NL}`,
    );
    fs.chmodSync(shimPath(), 0o755);
  }

  /** An agent checkout, with or without the venv the shim execs. */
  function giveAgent({ venv }: { venv: boolean }) {
    fs.mkdirSync(agentDir(), { recursive: true });
    // Marks THIS checkout, so we can tell "moved aside" from "recreated".
    fs.writeFileSync(path.join(agentDir(), "SENTINEL"), "original");
    if (venv) {
      const binDir = path.join(agentDir(), "venv", "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.copyFileSync(path.join(tmp, "fake-py"), path.join(binDir, "python"));
      fs.chmodSync(path.join(binDir, "python"), 0o755);
    }
  }

  /**
   * `reachable` decides what the reachability precheck sees; `installOk`
   * whether the stubbed installer actually lays down a working agent. The stub
   * records that it ran, so "did the network install happen at all" is
   * directly observable.
   */
  function run({ reachable = true, installOk = true, fetchOk = true } = {}) {
    // The reachability precheck is the `-o /dev/null` call; anything else is
    // the real installer being fetched to be piped into bash.
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "bin", "curl"),
      [
        "#!/bin/sh",
        'case " $* " in *" -o /dev/null "*) exit "$PRECHECK_RC" ;; esac',
        'echo ran >> "$MARKER"',
        // A fetch that fails after the precheck said the host was up: the CDN
        // answering is not the same as the install succeeding.
        'if [ "$FETCH_OK" = "0" ]; then exit 22; fi',
        'if [ "$INSTALL_OK" = "1" ]; then',
        '  mkdir -p "$AGENT_DIR/venv/bin" "$(dirname "$SHIM")"',
        '  cp "$FAKE_PY" "$AGENT_DIR/venv/bin/python"',
        '  cp "$FAKE_PY" "$SHIM"',
        "fi",
        'echo ":"',
        "",
      ].join(NL),
      { mode: 0o755 },
    );
    const script = [
      // install.sh's OWN options, not a laxer subset. Under `set -e` a probe
      // assignment that inherits a non-zero status aborts the whole script, so
      // a harness running with plain `set -u` certifies paths the shipped
      // script does not actually have.
      "set -euo pipefail",
      'CLAWBOX_HOME="$1"',
      'CLAWBOX_USER="$(id -un)"',
      'export MARKER="$1/installer-ran"',
      'export AGENT_DIR="$1/.hermes/hermes-agent"',
      'export SHIM="$1/.local/bin/hermes"',
      'export FAKE_PY="$1/fake-py"',
      'export PRECHECK_RC="$2"',
      'export INSTALL_OK="$3"',
      'export FETCH_OK="$5"',
      "has_hermes_harness() { return 0; }",
      // Run the command as this user instead of switching: `runuser -u X -- cmd`.
      'runuser() { shift 2; if [ "$1" = "--" ]; then shift; fi; "$@"; }',
      // curl is stubbed as a real executable on PATH, not as a shell function:
      // the reachability precheck runs it through `env`, which does a PATH
      // lookup and never sees a function. A function stub therefore let the
      // precheck reach the real network — the test passed for the wrong reason.
      'export PATH="$1/bin:$PATH"',
      "sed -n '/^step_hermes_install() {/,/^}/p' \"$4\" > \"$1/fn.sh\"",
      '. "$1/fn.sh"',
      // Merged, because the warnings that matter here are all on stderr.
      "step_hermes_install 2>&1",
    ].join(NL);
    try {
      const out = execFileSync(
        "bash",
        [
          "-c",
          script,
          "bash",
          tmp,
          reachable ? "0" : "1",
          installOk ? "1" : "0",
          INSTALL_SH_PATH,
          fetchOk ? "1" : "0",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { code: 0, out, installerRan: exists(path.join(tmp, "installer-ran")) };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return {
        code: err.status ?? 1,
        out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
        installerRan: exists(path.join(tmp, "installer-ran")),
      };
    }
  }

  it("a healthy install is a no-op — nothing touched, nothing fetched", () => {
    giveShim();
    giveAgent({ venv: true });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already installed \(Hermes 9\.9\.9\)/);
    // Why the reachability precheck sits AFTER the probe: a healthy box makes
    // no network call at all, on every single update.
    expect(r.installerRan).toBe(false);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
  });

  it("a shim with no venv is reinstalled — the factory-reset husk case", () => {
    // What the bench box actually looked like: the shim survived in
    // ~/.local/bin and ~/.hermes/hermes-agent was a shell with no venv.
    giveShim();
    giveAgent({ venv: false });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/already installed/);
    expect(r.installerRan).toBe(true);
    expect(r.out).toMatch(/Moved the unusable agent to .*hermes-agent\.broken/);
    // A working agent is in its place…
    expect(exists(path.join(agentDir(), "venv", "bin", "python"))).toBe(true);
    expect(r.out).toMatch(/Hermes installed \(Hermes 9\.9\.9\)/);
    // …so the husk has done its job and is gone. It is ~1.9 GB on a
    // disk-constrained device, and while it exists a factory reset has to be
    // able to delete it — the reset keeps only the exact name "hermes-agent".
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("a probe that exits non-zero reinstalls instead of killing install.sh", () => {
    // The false-negative case the whole step is built around, and the one that
    // errexit turns into a silent death: `installed=$(… | head -1)` inherits
    // the probe's status, so without `|| installed=""` bash exits right there —
    // no output, nothing repaired. It takes down `install.sh --step
    // hermes_install` (the documented repair command) and, in a full install,
    // every step that follows this one.
    giveShim({ answers: false });
    giveAgent({ venv: true });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.installerRan).toBe(true);
    expect(r.out).toMatch(/Hermes installed \(Hermes 9\.9\.9\)/);
  });

  it("a shim with no agent directory reinstalls without inventing a husk", () => {
    giveShim();

    const r = run();

    expect(r.code).toBe(0);
    expect(r.installerRan).toBe(true);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
    expect(exists(path.join(agentDir(), "venv", "bin", "python"))).toBe(true);
  });

  it("an unreachable installer leaves the existing agent exactly where it is", () => {
    // The regression this guards: post_update runs this step on every update on
    // every hermes box, so a probe that comes back empty on a device with no
    // internet must not be able to destroy a recoverable install.
    giveShim();
    giveAgent({ venv: false });

    const r = run({ reachable: false });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cannot reach the Hermes installer/);
    expect(r.installerRan).toBe(false);
    // Untouched: not moved aside, not deleted, shim still present.
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
    expect(exists(`${agentDir()}.broken`)).toBe(false);
    expect(exists(shimPath())).toBe(true);
  });

  it("a failed install puts the previous agent back", () => {
    // Non-fatal by design — but it must not be one-way. The husk is insurance
    // against a WRONG diagnosis, so the step has to be able to undo itself.
    giveShim();
    giveAgent({ venv: false });

    const r = run({ installOk: false });

    // step_post_update's `|| echo` depends on this not being a hard failure.
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Warning: Hermes still does not run/);
    expect(r.out).toMatch(/Restored the previous agent/);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
    // Nothing parked under another name for an operator to find and move back.
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("a healthy agent survives a lying probe plus a failed install", () => {
    // The worst realistic case, and the reason the restore exists: a box whose
    // agent works, a probe that comes back non-zero anyway (a fork failure on
    // an 8 GB device mid-update), a reachable CDN, and an upstream install that
    // then fails — clone or venv build, neither of which the precheck sees.
    // step_post_update drives this on EVERY update on EVERY hermes/dual box,
    // so this path has to leave the device exactly as it found it.
    giveShim({ answers: false });
    giveAgent({ venv: true });

    const r = run({ installOk: false });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
    expect(exists(path.join(agentDir(), "venv", "bin", "python"))).toBe(true);
    // The shim has to survive too: without it there is no `hermes` command,
    // and the next run would find no shim, skip the probe and move the healthy
    // agent aside all over again.
    expect(exists(shimPath())).toBe(true);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("repeated failed repairs neither accumulate husks nor lose the original", () => {
    // step_post_update runs this on every update, so a persistently broken box
    // reaches this branch again and again. Round 2 must still find the owner's
    // original checkout, not round 1's leftovers.
    giveShim();
    giveAgent({ venv: false });

    run({ installOk: false });
    const r = run({ installOk: false });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
    expect(fs.readdirSync(path.join(tmp, ".hermes")).filter((e) => e.includes(".broken"))).toEqual(
      [],
    );
  });

  it("a fetch failure is reported, not swallowed by the pipe", () => {
    // `curl … | bash` exits 0 when curl fails — bash just reads empty stdin —
    // so without `-o pipefail` this warning could never fire and a download
    // failure looked identical to a successful install.
    giveShim();
    giveAgent({ venv: false });

    const r = run({ fetchOk: false });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Hermes install failed \(non-fatal\)/);
    // …and the box is still whole.
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
  });
});

describe("setup-hermes-edition.sh does not repeat the shim-only check", () => {
  const SETUP_HERMES = readFileSync(path.join(REPO, "scripts/setup-hermes-edition.sh"), "utf-8");

  it("requires the venv interpreter, not just the shim", () => {
    // This script hard-fails when Hermes is missing — but it tested exactly
    // the file install.sh's old guard tested. On a factory-reset box the shim
    // was present and executable, so this check passed and the edition setup
    // continued on a device with no agent behind it.
    expect(SETUP_HERMES).toContain(
      'HERMES_VENV_PYTHON="$CLAWBOX_HOME/.hermes/hermes-agent/venv/bin/python"',
    );
    const guard = SETUP_HERMES.split(NL).find((l) => l.includes('[ ! -x "$HERMES_BIN" ]'));
    expect(guard).toBeDefined();
    expect(guard).toContain('[ ! -x "$HERMES_VENV_PYTHON" ]');
  });
});
