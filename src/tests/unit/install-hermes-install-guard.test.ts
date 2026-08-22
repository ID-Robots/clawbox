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

/**
 * The Hermes pin lives at the top of install.sh next to OPENCLAW_VERSION —
 * one constant for the whole file. Read it from there so the behavioural
 * harness below drives the value the fleet actually ships, instead of a copy
 * in this file that would quietly rot at the next bump.
 */
const PIN_LINE = INSTALL_SH.split(NL).find((l) => l.startsWith("HERMES_PIN_COMMIT="));
if (!PIN_LINE) throw new Error("HERMES_PIN_COMMIT not found in install.sh");
const PIN = (PIN_LINE.match(/[0-9a-f]{40}/) ?? [""])[0];
/** A well-formed commit that is not the pin: what an unpinned box looks like. */
const OTHER_COMMIT = "0".repeat(39) + "1";

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

describe("step_hermes_install installs one pinned Hermes release", () => {
  it("keeps the pin in a single constant next to OPENCLAW_VERSION", () => {
    const lines = INSTALL_SH.split(NL);
    const pinIdx = lines.findIndex((l) => l.startsWith("HERMES_PIN_COMMIT="));
    const openclawIdx = lines.findIndex((l) => l.startsWith("OPENCLAW_VERSION="));
    expect(pinIdx).toBeGreaterThan(-1);
    expect(openclawIdx).toBeGreaterThan(-1);
    // Same block of top-level constants as the OpenClaw pin, not buried in a
    // function halfway down the file where the next bump would not find it.
    expect(pinIdx - openclawIdx).toBeLessThan(40);
    expect(PIN).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lets QA override the pin without editing the file, like the OpenClaw pin", () => {
    expect(PIN_LINE).toContain('"${HERMES_PIN_COMMIT:-');
  });

  it("carries no SHA of its own inside the step", () => {
    // Two copies of a pin is one too many: the installer URL and the
    // --commit argument have to be the same value by construction.
    expect(HERMES_CODE).not.toMatch(/[0-9a-f]{40}/);
    expect(HERMES_CODE).toContain('pin="$HERMES_PIN_COMMIT"');
  });

  it("refuses a pin that is not a commit SHA before building any URL", () => {
    // The pin is spliced into a URL whose contents are piped into bash, so a
    // tag name or a path fragment must never reach that string.
    const validateIdx = HERMES_CODE.indexOf("[0-9a-fA-F]{40}");
    const urlIdx = HERMES_CODE.indexOf("installer_url=");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeLessThan(urlIdx);
  });

  it("fetches the installer from the pinned tree, not from a moving branch", () => {
    // The vanity host serves main's installer and can change its flags under
    // us; the copy at the pinned commit is the one those flags belong to.
    const urlLine = HERMES_CODE.split(NL).find((l) => l.includes("installer_url="));
    expect(urlLine).toBeDefined();
    expect(urlLine).toContain("$pin");
    expect(urlLine).not.toContain("/main/");
  });

  it("passes --commit AND --force-commit, with the pin as an argument", () => {
    const installLine = HERMES_CODE.split(NL).find((l) => l.includes("curl -fsSL"));
    expect(installLine).toBeDefined();
    // `bash -s --` is what carries flags through the pipe to the script.
    expect(installLine).toContain("bash -s --");
    expect(installLine).toContain('--commit "$2"');
    // Without --force-commit the upstream installer fast-forwards main FIRST
    // and then skips the pin as "already newer" — a tag is always older than
    // the main it was cut from, so the pin would silently do nothing.
    expect(installLine).toContain("--force-commit");
    expect(installLine).toContain('"$installer_url" "$pin"');
    // Never spliced into the `bash -c` string — same rule the URL follows.
    expect(installLine).not.toMatch(/'[^']*\$pin[^']*'/);
  });

  it("decides pinned-or-not from HEAD, never from the version string", () => {
    // `hermes --version` prints the same v0.20.5 for the tag and for every
    // untagged commit after it — hundreds a week — so a version comparison
    // could never see the difference. Only HEAD can.
    expect(HERMES_CODE).toMatch(/git -C "\$agent_dir" rev-parse HEAD/);
    expect(HERMES_CODE).toMatch(/\[ "\$at_commit" = "\$pin" \]/);
  });
});

describe("step_hermes_install's log does not contradict itself", () => {
  it("never calls the agent it moved aside unusable", () => {
    // The move block is shared by two devices that have nothing in common: an
    // agent that will not run, and an agent that runs fine and is merely on the
    // wrong commit. Hardcoding the noun in it meant a healthy box being
    // upgraded printed "Moving the working agent aside" and then "Moved the
    // unusable agent to …/hermes-agent.broken" — an owner reading that has
    // every reason to believe the update found a fault on their device.
    //
    // Read as text rather than driven, because the message that is left is the
    // one the behavioural harness cannot reach: it only prints when `mv` itself
    // fails, which needs a filesystem the fake HOME does not have.
    for (const line of HERMES_CODE.split(NL).filter((l) => l.includes("echo"))) {
      expect(line, `the moved agent must not be named inline: ${line}`).not.toContain(
        "unusable agent",
      );
    }
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
  /** Upstream's WhatsApp bridge, inside the agent checkout the step replaces. */
  const bridgeDir = () => path.join(agentDir(), "scripts", "whatsapp-bridge");
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

  /** The commit a fake checkout claims to be on, or null when it is not a repo. */
  const headOf = (dir: string) => {
    const f = path.join(dir, ".fake-head");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  };

  /**
   * An agent checkout, with or without the venv the shim execs, and with or
   * without a HEAD — `head` omitted stands for a tree the stubbed `git`
   * cannot read a commit out of at all.
   */
  function giveAgent({ venv, head }: { venv: boolean; head?: string }) {
    fs.mkdirSync(agentDir(), { recursive: true });
    // Marks THIS checkout, so we can tell "moved aside" from "recreated".
    fs.writeFileSync(path.join(agentDir(), "SENTINEL"), "original");
    if (head) fs.writeFileSync(path.join(agentDir(), ".fake-head"), head);
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
  function run({
    reachable = true,
    installOk = true,
    fetchOk = true,
    // What HEAD the stubbed installer leaves behind — the pin on the happy
    // path, something else when upstream ignores `--commit`.
    installHead = PIN,
    // The value of the shipped constant, overridable the way QA overrides it.
    pin = PIN,
    // What the fresh checkout the installer lays down contains at
    // scripts/whatsapp-bridge: "none" for a release that has no bridge at all,
    // "fresh" for the real shape of a clone (tracked sources, NO node_modules),
    // "warm" for a tree whose dependencies are somehow already there.
    bridge = "none" as "none" | "fresh" | "warm",
    // Whether the stubbed npm succeeds. A registry that is down must cost the
    // owner a warning and nothing else.
    npmOk = true,
  } = {}) {
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
        // The real installer's `--commit` leaves the checkout detached at that
        // commit; this is the only part of that the step can observe.
        '  if [ -n "$INSTALL_HEAD" ]; then printf %s "$INSTALL_HEAD" > "$AGENT_DIR/.fake-head"; fi',
        // A clone carries the bridge's SOURCES and never its node_modules —
        // that directory is untracked upstream, which is the whole reason the
        // warm-up exists.
        '  if [ "$BRIDGE" != "none" ]; then',
        '    mkdir -p "$AGENT_DIR/scripts/whatsapp-bridge"',
        '    echo "{}" > "$AGENT_DIR/scripts/whatsapp-bridge/package.json"',
        '    if [ "$BRIDGE" = "warm" ]; then',
        '      mkdir -p "$AGENT_DIR/scripts/whatsapp-bridge/node_modules"',
        "    fi",
        "  fi",
        "fi",
        'echo ":"',
        "",
      ].join(NL),
      { mode: 0o755 },
    );
    // npm has to be a real executable on PATH for the same reason curl does:
    // the warm-up reaches it through `env`, which only ever does a PATH lookup.
    // The marker is written to the process's CWD rather than to a fixed path,
    // so WHERE it lands is the assertion that the install ran in the bridge
    // directory — no path-shape comparison, which would not survive the two
    // separator conventions this suite runs under.
    fs.writeFileSync(
      path.join(tmp, "bin", "npm"),
      ["#!/bin/sh", 'printf "%s\\n" "$*" > npm-ran', 'exit "$NPM_RC"', ""].join(NL),
      { mode: 0o755 },
    );
    // `git -C <dir> rev-parse HEAD` is the only git the step runs, and it runs
    // it through `env`, which does a PATH lookup — so, like curl, it has to be
    // a real executable and not a shell function.
    fs.writeFileSync(
      path.join(tmp, "bin", "git"),
      [
        "#!/bin/sh",
        '[ "$1" = "-C" ] || exit 128',
        '[ -f "$2/.fake-head" ] || exit 128',
        'cat "$2/.fake-head"',
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
      'export INSTALL_HEAD="$6"',
      // Stands in for the top-level constant: the extracted function reads it
      // from the environment exactly as `${HERMES_PIN_COMMIT:-…}` resolves it.
      'export HERMES_PIN_COMMIT="$7"',
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
    let code = 0;
    let out: string;
    try {
      out = execFileSync(
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
          installHead,
          pin,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, BRIDGE: bridge, NPM_RC: npmOk ? "0" : "1" },
        },
      );
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    const npmMarker = path.join(bridgeDir(), "npm-ran");
    return {
      code,
      out,
      installerRan: exists(path.join(tmp, "installer-ran")),
      // Read out of the BRIDGE directory, so a non-null value is already proof
      // that npm ran with the bridge as its working directory.
      npmArgs: exists(npmMarker) ? fs.readFileSync(npmMarker, "utf8").trim() : null,
    };
  }

  it("a healthy install on the pin is a no-op — nothing touched, nothing fetched", () => {
    giveShim();
    giveAgent({ venv: true, head: PIN });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already installed at the pinned commit \(Hermes 9\.9\.9\)/);
    // Why the reachability precheck sits AFTER the probe: a healthy box makes
    // no network call at all, on every single update.
    expect(r.installerRan).toBe(false);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
  });

  it("an interrupted earlier repair left a husk — the husk (the original) wins, the partial tree goes", () => {
    // State after a power cut or unit timeout between the move and the restore:
    // ~/.hermes/hermes-agent holds whatever the interrupted installer managed
    // to write (no venv), and ~/.hermes/hermes-agent.broken is the owner's
    // original, working checkout.
    giveShim({ answers: false });
    giveAgent({ venv: false });
    const husk = `${agentDir()}.broken`;
    fs.mkdirSync(path.join(husk, "venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(husk, "SENTINEL"), "husk-original");
    fs.copyFileSync(path.join(tmp, "fake-py"), path.join(husk, "venv", "bin", "python"));
    fs.chmodSync(path.join(husk, "venv", "bin", "python"), 0o755);

    // The reinstall fails too — so the restore must bring back the HUSK, not
    // the partial tree. (The old code deleted the husk first and restored the
    // partial tree: the original was gone for good.)
    const r = run({ installOk: false });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Kept the earlier husk/);
    expect(r.out).toMatch(/Restored the previous agent/);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("husk-original");
    expect(exists(husk)).toBe(false);
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

  it("a healthy agent on the wrong commit is upgraded, through the same reversible path", () => {
    // The fleet case: the agent works, it just is not the build we ship. It
    // has to be moved aside first like any other reinstall, so a half-finished
    // upgrade can still be undone.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not on the pinned commit/);
    expect(r.out).toContain(OTHER_COMMIT);
    expect(r.out).toContain(PIN);
    expect(r.out).toMatch(/Moving the working agent aside/);
    expect(r.installerRan).toBe(true);
    expect(headOf(agentDir())).toBe(PIN);
    expect(r.out).toMatch(/Hermes installed \(Hermes 9\.9\.9\) at the pinned commit/);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("a failed pinned upgrade puts the working agent back on its old commit", () => {
    // The reason the upgrade reuses the husk path at all: an agent that was
    // merely out of date must never end up as no agent.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run({ installOk: false });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Restored the previous agent/);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
    expect(headOf(agentDir())).toBe(OTHER_COMMIT);
    expect(exists(path.join(agentDir(), "venv", "bin", "python"))).toBe(true);
    expect(exists(shimPath())).toBe(true);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("an unreachable installer leaves an unpinned but working agent alone", () => {
    // post_update drives this step on every update on every hermes box, so
    // "wrong version" plus "no internet" must cost the owner nothing.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run({ reachable: false });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cannot reach the Hermes installer/);
    expect(r.installerRan).toBe(false);
    expect(headOf(agentDir())).toBe(OTHER_COMMIT);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("an install that lands off the pin is reported, not rolled back", () => {
    // What upstream dropping --force-commit would look like from here. The
    // agent runs, so restoring the copy we moved aside — unpinned too — would
    // only cost the owner the newer tree. Say so loudly instead.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run({ installHead: OTHER_COMMIT });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/but HEAD is/);
    expect(r.out).not.toMatch(/Restored the previous agent/);
    expect(exists(path.join(agentDir(), "venv", "bin", "python"))).toBe(true);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("an agent whose HEAD cannot be read counts as unpinned", () => {
    // A checkout that is not a git repository (or a git that refuses it) can
    // never be shown to be the pinned build, so it is treated as not being it.
    // It converges: the pinned install leaves a readable HEAD behind.
    giveShim();
    giveAgent({ venv: true });

    const r = run();

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/have: unknown \(not a git checkout\)/);
    expect(r.installerRan).toBe(true);
    expect(headOf(agentDir())).toBe(PIN);
  });

  it("a malformed pin installs nothing at all", () => {
    // `--branch v2026.8.19`-style values, truncated SHAs, anything with a
    // slash in it: the URL is never built and the device is never touched.
    giveShim();
    giveAgent({ venv: false });

    const r = run({ pin: "v2026.8.19" });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not a 40-char commit SHA/);
    expect(r.installerRan).toBe(false);
    expect(fs.readFileSync(path.join(agentDir(), "SENTINEL"), "utf8")).toBe("original");
    expect(exists(`${agentDir()}.broken`)).toBe(false);
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

  it("a healthy agent moved aside for an upgrade is not called unusable", () => {
    // Both messages come out of the same move block, and it used to hardcode
    // the noun: a box whose agent works fine was told, one line after "Moving
    // the working agent aside", that its agent was unusable. Nothing is broken
    // on this device — it is simply not on the build we ship.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run();

    expect(r.code).toBe(0);
    const moveLine = r.out.split(NL).find((l) => l.includes("hermes-agent.broken"));
    expect(moveLine).toMatch(/Moved the working agent to .*hermes-agent\.broken/);
    // Scoped to the line that names it, so an unrelated future message using
    // the word does not fail this.
    expect(moveLine).not.toContain("unusable");
    // A release with no bridge asks nothing of npm — the default every other
    // run in this file uses.
    expect(r.npmArgs).toBeNull();
  });

  it("a pinned upgrade warms up the WhatsApp bridge the fresh clone deleted", () => {
    // The upgrade is a move-aside plus a fresh clone, and the bridge's ~80 MB
    // node_modules is untracked, so it does not come back with the checkout.
    // ClawBox does self-heal — the pairing manager runs this same install the
    // first time a QR is asked for, observed on hardware — but that puts the
    // whole install in front of an owner who has just clicked Pair, and an
    // OFFLINE box at that moment fails to pair where it would have paired
    // before the upgrade. So the updater pays for it, while it has the network.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run({ bridge: "fresh" });

    expect(r.code).toBe(0);
    expect(r.installerRan).toBe(true);
    expect(r.out).toMatch(/Warming up the WhatsApp bridge/);
    // npmArgs is read out of the bridge directory itself, so a non-null value
    // is already proof the install ran there and not in some inherited cwd.
    expect(r.npmArgs).not.toBeNull();
    // The flags the pairing manager uses, so the warm cache is the one the
    // on-demand path would have built.
    expect(r.npmArgs).toContain("install");
    expect(r.npmArgs).toContain("--no-fund");
    expect(r.npmArgs).toContain("--no-audit");
    expect(r.npmArgs).toContain("--progress=false");
    // …and the step still reports what it is actually for.
    expect(r.out).toMatch(/Hermes installed \(Hermes 9\.9\.9\) at the pinned commit/);
  });

  it("a warm-up that fails is a warning — the install still counts as a success", () => {
    // A down registry, a proxy, an npm that dies on a low-memory device. The
    // on-demand path still works, so this must not turn a good Hermes install
    // into a failed step: step_post_update reports any non-zero return as a
    // failed update step, on every hermes box on every update.
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run({ bridge: "fresh", npmOk: false });

    expect(r.code).toBe(0);
    expect(r.npmArgs).not.toBeNull();
    expect(r.out).toMatch(/WhatsApp bridge warm-up failed \(non-fatal\)/);
    // The agent install itself is untouched by the bridge's bad luck.
    expect(r.out).toMatch(/Hermes installed \(Hermes 9\.9\.9\) at the pinned commit/);
    expect(headOf(agentDir())).toBe(PIN);
    expect(exists(`${agentDir()}.broken`)).toBe(false);
  });

  it("a bridge that already has its node_modules is left alone", () => {
    // The warm-up is repair, not routine work: node_modules that survived must
    // not be reinstalled on top of itself. (The release-with-no-bridge case is
    // the `bridge: "none"` default every other run in this file already uses,
    // and is asserted on the upgrade above.)
    giveShim();
    giveAgent({ venv: true, head: OTHER_COMMIT });

    const r = run({ bridge: "warm" });

    expect(r.code).toBe(0);
    expect(r.npmArgs).toBeNull();
    expect(r.out).not.toMatch(/Warming up the WhatsApp bridge/);
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
