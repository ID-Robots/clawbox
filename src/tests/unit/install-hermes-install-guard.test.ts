import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
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

  it("clears the stale agent husk before reinstalling", () => {
    expect(HERMES_CODE).toMatch(/rm -rf "\$agent_dir"/);
  });

  it("verifies the install afterwards instead of assuming it worked", () => {
    // The upstream installer is fetched over the network and its failure is
    // non-fatal, so the step has to check.
    const afterInstall = HERMES_CODE.slice(HERMES_CODE.indexOf("hermes-agent.nousresearch.com"));
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
      if (!line.includes("$shim")) continue;
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
