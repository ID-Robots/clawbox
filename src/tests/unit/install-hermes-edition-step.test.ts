import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Hermes provisioning — dashboard + proxy units, dashboard auth, shared
 * identity, MCP registration, gateway removal — used to run inside
 * `step_post_update`, wrapped in `|| echo "Warning: … (non-fatal)"`. A device
 * that failed to provision its entire edition still finished the update green,
 * with the failure buried in the journal.
 *
 * The in-app updater now dispatches `hermes_edition` as its own visible step
 * (see UPDATE_STEPS in src/lib/updater.ts), so it runs exactly once and a
 * failure is reported as one. These tests pin both halves of that contract:
 * the step must stay dispatchable, and post_update must not silently take the
 * work back.
 */
const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const UPDATER_TS = readFileSync(path.join(REPO, "src/lib/updater.ts"), "utf-8");
const HERMES_SETUP = readFileSync(
  path.join(REPO, "scripts/setup-hermes-edition.sh"),
  "utf-8",
);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

// `hermes_edition` being in DISPATCH_STEPS is already pinned by
// install-edition-lock.test.ts ("edition steps are dispatchable by the
// updater") — not repeated here.

describe("hermes_edition is the updater's own step", () => {
  it("the updater lists it", () => {
    expect(UPDATER_TS).toContain('id: "hermes_edition"');
  });

  it("post_update no longer calls it — that would run provisioning twice", () => {
    // Two dashboard/proxy restarts per update, and the swallowed copy would
    // still be the one that ran first.
    expect(extractShellFunction("step_post_update")).not.toMatch(
      /^\s*step_hermes_edition\b/m,
    );
  });

  it("the full install still provisions directly, not via post_update", () => {
    // step_post_update has only ever had one caller (the updater), so removing
    // its call must not have cost fresh installs their provisioning.
    const fullInstallTail = INSTALL_SH.slice(INSTALL_SH.indexOf("step_start_services\n"));
    expect(fullInstallTail).toContain("step_hermes_edition");
  });
});

describe("provisioning stays safe to re-run on every update", () => {
  it("passes HOME explicitly to every runuser call", () => {
    // All three scripts resolve their state from `${HOME:-/home/clawbox}`. This
    // script runs as root (HOME=/root), so relying on runuser to reset HOME
    // would make setup-hermes-dashboard-auth read the wrong config, find no
    // credentials to verify, and mint a password the proxy does not have.
    const runuserCalls = HERMES_SETUP.match(/runuser -u "\$CLAWBOX_USER" --[^\n]*(\n[^\n]*)?/g) ?? [];
    expect(runuserCalls.length).toBeGreaterThan(0);
    for (const call of runuserCalls) {
      expect(call, `runuser call must pass HOME: ${call}`).toContain('HOME="$CLAWBOX_HOME"');
    }
  });

  // The "already-provisioned box is not re-minted on every update" property is
  // tested behaviourally, by running the script twice, in
  // hermes-dashboard-auth-yaml.test.ts — which owns that script.
});

/**
 * src/lib/edition-source.ts's `hasHermesHarness()` states that it mirrors
 * install.sh's `has_hermes_harness()`. The updater uses it to decide whether to
 * dispatch `hermes_edition`, and the step itself re-checks the shell version —
 * so if the two ever disagree, a device either skips its own provisioning or
 * runs a step that immediately returns. Nothing else pins them together.
 */
describe("the TS and shell harness predicates agree", () => {
  it("both treat hermes and dual as the Hermes-harness editions", () => {
    expect(INSTALL_SH).toContain(
      'has_hermes_harness() { [ "$CLAWBOX_EDITION" = "hermes" ] || [ "$CLAWBOX_EDITION" = "dual" ]; }',
    );
    const ts = readFileSync(path.join(REPO, "src/lib/edition-source.ts"), "utf-8");
    const body = ts.slice(ts.indexOf("export function hasHermesHarness()"));
    expect(body).toContain('edition === "hermes" || edition === "dual"');
  });

  it("the provisioning step guards on the shell predicate too", () => {
    // Belt and braces: the updater filters the step out, and dispatching it
    // manually on an openclaw box still does nothing.
    expect(extractShellFunction("step_hermes_edition")).toContain(
      "has_hermes_harness || return 0",
    );
  });
});

/**
 * The updater dropping a step is NOT a substitute for install.sh's own edition
 * guards, and this is the trap: once `applies()` filters `gateway_setup` out on
 * hermes, the `is_hermes_edition` guard inside step_gateway_setup looks dead and
 * invites deletion. It is not dead. step_post_update has no `applies()` — it
 * runs on every SKU — and calls step_gateway_setup itself, so deleting that
 * guard would reinstall and enable an OpenClaw gateway on a Hermes box midway
 * through its own update. `install.sh --step gateway_setup` by hand is the same
 * hole. These pin both ends so the trap fails loudly instead of shipping.
 */
/**
 * Propagation. A full install keeps `step_hermes_edition` NON-FATAL — a
 * half-provisioned box should still finish and come up reachable — but two real
 * provisions proved that "non-fatal" had become "invisible": install.sh printed
 * "Hermes provisioning FAILED", then "All 20 checks healthy", then the flash
 * host printed "Setup: 1/1 succeeded". A failed step must reach the operator's
 * summary AND the exit status, or a broken box ships as healthy.
 */
describe("a failed provisioning step is not reportable as success", () => {
  it("records the hermes_edition failure instead of only warning", () => {
    // The non-fatal `|| { ... }` block must record the failure, not just echo a
    // banner that scrolls off screen.
    const tail = INSTALL_SH.slice(INSTALL_SH.indexOf("Provisioning Hermes"));
    const block = tail.slice(0, tail.indexOf("\nfi\n"));
    expect(block).toContain("record_provision_failure hermes_edition");
  });

  it("folds provisioning failures AND a failed validation into one honest exit", () => {
    // Validation is captured (not left to abort via set -e) so the summary still
    // prints, then a single FINAL_RC reflects BOTH signals, and the script exits
    // with it. Without this, install.sh exited 0 whenever validation self-healed.
    expect(INSTALL_SH).toContain("VALIDATE_RC=0");
    expect(INSTALL_SH).toContain("step_validate_services || VALIDATE_RC=$?");
    expect(INSTALL_SH).toContain("FINAL_RC=1");
    // FINAL_RC rises from EITHER a recorded provisioning failure OR a failed
    // validation — both signals feed the one exit code.
    expect(INSTALL_SH).toContain('"${#PROVISION_FAILURES[@]}" -gt 0');
    expect(INSTALL_SH).toContain('"${VALIDATE_RC:-0}" -ne 0');
    expect(INSTALL_SH).toContain('exit "$FINAL_RC"');
  });

  it("prints an INCOMPLETE summary and a machine-readable status for the flash host", () => {
    expect(INSTALL_SH).toContain("PROVISIONING INCOMPLETE");
    // A sentinel line for a caller that greps stdout, and a marker file for one
    // that reads a file — both must agree with the exit code.
    expect(INSTALL_SH).toContain("[provision-status] INCOMPLETE");
    expect(INSTALL_SH).toContain("[provision-status] OK");
    expect(INSTALL_SH).toContain("write_provision_status incomplete");
    expect(INSTALL_SH).toContain("write_provision_status ok");
  });

  it("defines the accumulator and marker writer", () => {
    expect(INSTALL_SH).toContain("record_provision_failure()");
    expect(INSTALL_SH).toContain("write_provision_status()");
    expect(INSTALL_SH).toContain("PROVISION_FAILURES=()");
  });

  /**
   * The exit code, the [provision-status] line and the marker file are three
   * signals that must agree. If the marker cannot be rewritten, the PREVIOUS
   * run's content survives — so a box that installed cleanly once and fails
   * later would keep STATUS=ok on disk while the other two report the failure,
   * and a flash host reading the file would ship it. A marker that cannot be
   * refreshed must not be left behind pretending to describe this run.
   */
  describe.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "a marker that cannot be written is not left stale",
    () => {
      // Run install.sh's own function body, so the test exercises the shipped
      // code rather than a paraphrase of it.
      const runWriter = (statusFile: string, status: string) => {
        const body = `${extractShellFunction("write_provision_status")}\n}`;
        const script = `
          PROVISION_STATUS_FILE="${statusFile}"
          ${body}
          write_provision_status ${status} ""
        `;
        return spawnSync("bash", ["-c", script], { encoding: "utf-8" });
      };

      it("removes a stale STATUS=ok rather than let it contradict the exit code", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-marker-"));
        const marker = path.join(dir, "provision-status");
        fs.writeFileSync(marker, "STATUS=ok\nFAILED_STEPS=\n");
        // Unwritable FILE inside a writable dir: the rewrite fails, the removal
        // succeeds.
        fs.chmodSync(marker, 0o400);

        const proc = runWriter(marker, "incomplete");

        expect(proc.stdout).toMatch(/could not write/i);
        expect(fs.existsSync(marker), "the stale marker must not survive").toBe(false);
      });

      it("says the marker is stale when it can be neither written nor removed", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-marker-ro-"));
        const marker = path.join(dir, "provision-status");
        fs.writeFileSync(marker, "STATUS=ok\nFAILED_STEPS=\n");
        fs.chmodSync(marker, 0o400);
        fs.chmodSync(dir, 0o500); // removal needs write on the DIRECTORY

        let proc;
        try {
          proc = runWriter(marker, "incomplete");
        } finally {
          fs.chmodSync(dir, 0o700);
        }

        expect(proc.stdout).toMatch(/STALE/);
        expect(proc.stdout).toMatch(/does NOT describe this run/i);
      });
    },
  );
});

/**
 * Validation must include the thing that failed. Right after dashboard auth
 * failed, the 26/26 step reported every check healthy — because its only Hermes
 * auth probe hit the proxy and whitelisted the failure (a 401 was "healthy"),
 * and the proxy answers an un-cookied request with a 302 whether or not the auth
 * provider works. The validator now verifies the provider directly, reusing the
 * auth script's own `--check` classifier so both agree on "healthy".
 */
describe("service validation checks the dashboard auth provider", () => {
  it("runs the auth script's --check on hermes AND dual", () => {
    const fn = extractShellFunction("step_validate_services");
    expect(fn).toContain('bash "$auth_script" --check');
    // Guarded by has_hermes_harness (hermes + dual), not is_hermes_edition.
    // Both markers are located before slicing: a missing one would otherwise
    // slice from -1 and quietly assert against the wrong region.
    const probeAt = fn.indexOf("dashboard auth PROVIDER");
    expect(probeAt, "the auth-provider probe comment must be present").toBeGreaterThan(-1);
    const probe = fn.slice(probeAt);
    const caseAt = probe.indexOf("case");
    expect(caseAt, "the probe must classify --check's exit code").toBeGreaterThan(-1);
    expect(probe.slice(0, caseAt)).toContain("has_hermes_harness");
  });

  it("counts the new probe in the healthy total", () => {
    const fn = extractShellFunction("step_validate_services");
    expect(fn).toMatch(/has_hermes_harness; then probe_count=\$\(\( probe_count \+ 1 \)\)/);
  });

  it("no longer counts a proxy 401 as healthy on hermes", () => {
    // 401 is the desynced-SSO symptom (see hermes-dashboard-proxy.js); a healthy
    // browserless probe gets a 302/403, so a 401 must fail the check. Assert the
    // case pattern precisely — the word "401" still appears in the DESYNCED
    // message, and that is correct.
    const fn = extractShellFunction("step_validate_services");
    expect(fn).toContain("2*|3*|403) ;;");
    expect(fn).not.toContain("2*|3*|401|403");
  });

  it("maps --check's classes to distinct operator messages", () => {
    const fn = extractShellFunction("step_validate_services");
    expect(fn).toContain("DESYNCED");
    expect(fn).toContain("no usable dashboard auth provider");
  });
});

describe("install.sh keeps its own edition guards", () => {
  it("post_update still calls gateway_setup on every edition", () => {
    expect(extractShellFunction("step_post_update")).toContain("step_gateway_setup");
  });

  it("gateway_setup refuses on hermes regardless of how it was reached", () => {
    expect(extractShellFunction("step_gateway_setup")).toContain("is_hermes_edition &&");
  });

  it("the OpenClaw steps refuse on hermes too", () => {
    for (const step of ["step_openclaw_install", "step_openclaw_patch"]) {
      expect(extractShellFunction(step), `${step} needs its own guard`).toContain(
        "is_hermes_edition &&",
      );
    }
  });
});
