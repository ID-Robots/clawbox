import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

const DISPATCH_STEPS = INSTALL_SH.slice(
  INSTALL_SH.indexOf("DISPATCH_STEPS=("),
  INSTALL_SH.indexOf(")", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
);

describe("hermes_edition is the updater's own step", () => {
  it("is dispatchable, so the updater can run it as a root step", () => {
    expect(DISPATCH_STEPS).toContain("hermes_edition");
  });

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

  it("verifies stored credentials before minting new ones", () => {
    const auth = readFileSync(
      path.join(REPO, "scripts/setup-hermes-dashboard-auth.sh"),
      "utf-8",
    );
    // The early exit must come before any generation, or a box that already
    // works would get a fresh password on every single update.
    const guard = auth.indexOf("if creds_are_consistent; then");
    const mint = auth.indexOf("secrets.token_urlsafe(24)");
    expect(guard).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(mint);
    expect(auth.slice(guard, mint)).toContain("exit 0");
  });
});
