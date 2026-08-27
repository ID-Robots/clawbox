import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// A device converted in place from hermes to openclaw came up with the OpenClaw
// gateway healthy AND the whole Hermes stack still running — clawbox-gateway,
// clawbox-hermes-dashboard, clawbox-hermes-dashboard-proxy and hermes-gateway
// all active at once. Both harnesses long-poll getUpdates on the same Telegram
// bot token, so each terminated the other's request ("Conflict: terminated by
// other getUpdates request", then "Polling stall detected … forcing restart"),
// and the box could not receive a message for hours.
//
// install.sh could already SEE that state (FOREIGN_EDITION_UNITS, pinned in
// install-edition-switch-refusal.test.ts) but did nothing about it, so the
// install finished loudly broken and waited for an operator who knew which
// units to name. step_edition_foreign_teardown closes that: it brings the other
// harness down, conservatively and out loud.
//
// The mechanism is not new — step_edition_gateway_state has always stopped,
// disabled, removed and masked clawbox-gateway on hermes. Only the
// openclaw/dual direction was missing.

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const SUDOERS = fs.readFileSync(path.join(REPO, "config/clawbox-sudoers"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

/** Source text between two literal markers, `end` exclusive. */
function slice(startMarker: string, endMarker: string): string {
  const start = INSTALL_SH.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = INSTALL_SH.indexOf(endMarker, start);
  if (end < 0) throw new Error(`marker not found: ${endMarker}`);
  return INSTALL_SH.slice(start, end);
}

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

// The edition predicates through the service registry — the block that builds
// FOREIGN_EDITION_UNITS. Sourced verbatim so the list under test is the list
// that ships, not a copy of it.
const SERVICE_REGISTRY = slice(
  "# The Hermes SKU: Hermes is the ONLY harness",
  "# Load persisted WiFi interface if available",
);

const TEARDOWN_FN = extractShellFunction("step_edition_foreign_teardown");
const VALIDATE_FN = extractShellFunction("step_validate_services");

let tmp: string;
let actionsLog: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-teardown-"));
  actionsLog = path.join(tmp, "systemctl-calls");
  fs.writeFileSync(actionsLog, "");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A fake `systemctl` over a table of `unit -> "<enabled>:<active>"`, which
 * APPENDS every state-changing verb to a file. install.sh sends those calls to
 * /dev/null, so a file is the only way to observe that stop/disable were the
 * only things done — and, just as importantly, that mask and rm were not.
 */
function systemctlStub(units: Record<string, string>): string {
  const arms = Object.entries(units)
    .map(([unit, state]) => `    ${unit}) printf '%s' '${state}' ;;`)
    .join("\n");
  return `
_unit_state() {
  case "$1" in
${arms}
    *) return 1 ;;
  esac
}
systemctl() {
  local verb="$1"; shift
  local unit="\${1:-}"
  local st
  case "$verb" in
    cat) _unit_state "$unit" >/dev/null 2>&1 || return 1 ;;
    is-enabled) st="$(_unit_state "$unit")" || return 1; printf '%s' "\${st%%:*}" ;;
    is-active) st="$(_unit_state "$unit")" || { printf 'inactive'; return 1; }; printf '%s' "\${st##*:}" ;;
    status) printf 'stub status for %s\\n' "$unit" ;;
    *) printf '%s %s\\n' "$verb" "$unit" >> ${JSON.stringify(actionsLog)} ;;
  esac
  return 0
}
`;
}

function runTeardown(
  edition: string,
  units: Record<string, string>,
  env: Record<string, string> = {},
): { status: number; stdout: string; calls: string[] } {
  const script = [
    "set -euo pipefail",
    `CLAWBOX_EDITION=${edition}`,
    "CLAWBOX_TEST_MODE=1",
    "PROJECT_DIR=/nonexistent",
    "CLAWBOX_HOME=/nonexistent",
    'IFACE_ENV="/nonexistent/network.env"',
    SERVICE_REGISTRY,
    systemctlStub(units),
    TEARDOWN_FN,
    "step_edition_foreign_teardown",
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    // Deliberately NOT inheriting process.env: a CLAWBOX_EDITION or
    // CLAWBOX_KEEP_FOREIGN_UNITS already exported in the developer's shell
    // would silently rewrite what these cases are asking.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV, ...env },
  });
  const calls = fs
    .readFileSync(actionsLog, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { status: r.status ?? -1, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls };
}

/** The exact device state that was observed: openclaw box, Hermes stack up. */
function hermesStackUp(): Record<string, string> {
  return {
    "clawbox-hermes-dashboard.service": "enabled:active",
    "clawbox-hermes-dashboard-proxy.service": "enabled:active",
    "hermes-gateway.service": "enabled:active",
  };
}

d("step_edition_foreign_teardown brings the other harness down", () => {
  it("stops and disables the whole Hermes stack on an openclaw device", () => {
    const r = runTeardown("openclaw", hermesStackUp());

    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      "stop clawbox-hermes-dashboard.service",
      "disable clawbox-hermes-dashboard.service",
      "stop clawbox-hermes-dashboard-proxy.service",
      "disable clawbox-hermes-dashboard-proxy.service",
      // The unit holding the Telegram bot token, hence the conflict loop.
      "stop hermes-gateway.service",
      "disable hermes-gateway.service",
    ]);
  });

  it("does not mask, unmask, or remove anything", () => {
    // The whole point of preferring stop+disable: every unit here comes back
    // with one command. A mask (or a deleted unit file) is a different, much
    // less reversible decision, and it is not this step's to make.
    const r = runTeardown("openclaw", hermesStackUp());
    for (const verb of ["mask", "unmask", "daemon-reload"]) {
      expect(r.calls.join("\n")).not.toContain(verb);
    }
    expect(TEARDOWN_FN).not.toMatch(/systemctl\s+(--runtime\s+)?u?n?mask/);
    expect(TEARDOWN_FN).not.toMatch(/\brm\b/);
  });

  it("names every unit it brought down, with the state it was in", () => {
    // Silently stopping a service an operator may be watching is the hazard
    // this step has to answer for. It answers by narrating.
    const r = runTeardown("openclaw", hermesStackUp());
    for (const unit of Object.keys(hermesStackUp())) {
      expect(r.stdout).toContain(unit);
    }
    expect(r.stdout).toContain("another edition");
    expect(r.stdout).toContain("this device is 'openclaw'");
    expect(r.stdout).toMatch(/was active=active enabled=enabled/);
  });

  it("prints the command that puts a unit back", () => {
    const r = runTeardown("openclaw", hermesStackUp());
    expect(r.stdout).toContain("systemctl enable --now");
    expect(r.stdout).toContain("CLAWBOX_KEEP_FOREIGN_UNITS=1");
  });

  it("says why, so the teardown is not just an assertion of authority", () => {
    const r = runTeardown("openclaw", hermesStackUp());
    expect(r.stdout).toContain("Telegram");
  });
});

d("it touches nothing it does not have to", () => {
  it("leaves dual completely alone — that edition runs both harnesses", () => {
    // Not a special case in the step: FOREIGN_EDITION_UNITS is built by negating
    // BOTH has_*_harness predicates, and dual satisfies both, so the list is
    // empty and the loop has no body. This is the test that must never go red.
    const r = runTeardown("dual", {
      ...hermesStackUp(),
      "clawbox-gateway.service": "enabled:active",
    });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout.trim()).toBe("");
  });

  it("does nothing when the other harness was never installed", () => {
    const r = runTeardown("openclaw", {});
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout.trim()).toBe("");
  });

  it("does nothing to a foreign unit already stopped and disabled", () => {
    const r = runTeardown("openclaw", {
      "clawbox-hermes-dashboard.service": "disabled:inactive",
      "hermes-gateway.service": "disabled:inactive",
    });
    expect(r.calls).toEqual([]);
    expect(r.stdout.trim()).toBe("");
  });

  it("is idempotent — the second run over its own result is a no-op", () => {
    runTeardown("openclaw", hermesStackUp());
    fs.writeFileSync(actionsLog, "");
    const again = runTeardown("openclaw", {
      "clawbox-hermes-dashboard.service": "disabled:inactive",
      "clawbox-hermes-dashboard-proxy.service": "disabled:inactive",
      "hermes-gateway.service": "disabled:inactive",
    });
    expect(again.calls).toEqual([]);
  });

  it("says nothing on hermes, where step_edition_gateway_state already acted", () => {
    // step_edition_lock runs the gateway state FIRST, so by the time the
    // teardown looks, clawbox-gateway is stopped and masked. Reporting it a
    // second time would be noise about work already done.
    const r = runTeardown("hermes", { "clawbox-gateway.service": "masked:inactive" });
    expect(r.calls).toEqual([]);
    expect(r.stdout.trim()).toBe("");
  });

  it("still backstops hermes if the gateway somehow survived that step", () => {
    const r = runTeardown("hermes", { "clawbox-gateway.service": "enabled:active" });
    expect(r.calls).toEqual([
      "stop clawbox-gateway.service",
      "disable clawbox-gateway.service",
    ]);
  });
});

d("the states that are easy to miss", () => {
  it("disables a foreign unit that is enabled but not yet running", () => {
    // One reboot from being the second poller. Not stopped — it isn't running.
    const r = runTeardown("openclaw", { "hermes-gateway.service": "enabled:inactive" });
    expect(r.calls).toEqual(["disable hermes-gateway.service"]);
    expect(r.stdout).toContain("hermes-gateway.service");
  });

  it("stops a foreign unit that is masked but still running", () => {
    // Masking does not stop a running unit. `is-enabled` says masked, so there
    // is nothing to disable — but the process is still on the token.
    const r = runTeardown("openclaw", { "hermes-gateway.service": "masked:active" });
    expect(r.calls).toEqual(["stop hermes-gateway.service"]);
  });

  it("treats activating and reloading as running", () => {
    // A unit caught mid-start or mid-reload is on its way to holding the token.
    for (const state of ["activating", "reloading"]) {
      fs.writeFileSync(actionsLog, "");
      const r = runTeardown("openclaw", { "hermes-gateway.service": `disabled:${state}` });
      expect(r.calls, state).toEqual(["stop hermes-gateway.service"]);
    }
  });
});

d("CLAWBOX_KEEP_FOREIGN_UNITS is the way out", () => {
  it("leaves everything running when set to 1, and says so per unit", () => {
    const r = runTeardown("openclaw", hermesStackUp(), {
      CLAWBOX_KEEP_FOREIGN_UNITS: "1",
    });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain("CLAWBOX_KEEP_FOREIGN_UNITS=1");
    expect(r.stdout).toContain("left as-is");
    for (const unit of Object.keys(hermesStackUp())) {
      expect(r.stdout).toContain(unit);
    }
  });

  it("takes only an explicit 1 — not 'true', 'yes' or 0", () => {
    for (const value of ["0", "true", "yes", ""]) {
      fs.writeFileSync(actionsLog, "");
      const r = runTeardown("openclaw", hermesStackUp(), {
        CLAWBOX_KEEP_FOREIGN_UNITS: value,
      });
      expect(r.calls.length, `CLAWBOX_KEEP_FOREIGN_UNITS=${value}`).toBe(6);
    }
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────
// A teardown nothing calls is a teardown that does not exist.

describe("the teardown is wired into both entry paths", () => {
  it("runs from step_edition_lock, after the gateway state", () => {
    const lock = extractShellFunction("step_edition_lock");
    expect(lock).toContain("step_edition_foreign_teardown");
    expect(lock.indexOf("step_edition_gateway_state")).toBeLessThan(
      lock.indexOf("step_edition_foreign_teardown"),
    );
  });

  it("reaches the in-app updater, which dispatches edition_lock", () => {
    const postUpdate = extractShellFunction("step_post_update");
    expect(postUpdate).toContain("step_edition_lock");
  });

  it("is dispatchable on its own, so the printed repair command is real", () => {
    const dispatch = slice("DISPATCH_STEPS=(", "\n)");
    expect(dispatch).toContain("edition_foreign_teardown");
    expect(INSTALL_SH).toContain("step_edition_foreign_teardown() {");
    expect(INSTALL_SH).toContain(
      "install.sh --step edition_foreign_teardown",
    );
  });

  it("runs before any unit of this edition is installed or started", () => {
    // step_edition_lock is called before step_system_config and
    // step_start_services, so the other harness is down before ours comes up.
    const mainFlow = INSTALL_SH.slice(INSTALL_SH.indexOf('log "Installing NVIDIA JetPack'));
    expect(mainFlow.indexOf("step_edition_lock")).toBeLessThan(
      mainFlow.indexOf("step_system_config"),
    );
    expect(mainFlow.indexOf("step_edition_lock")).toBeLessThan(
      mainFlow.indexOf("step_start_services"),
    );
  });

  it("cannot run on a refused edition change — the refusal exits first", () => {
    // #377's refusal is a top-level `exit 1` during constant parsing, so a
    // device whose transition is refused never reaches any step function at
    // all. "Nothing has been changed" has to stay literally true.
    expect(INSTALL_SH.indexOf("ERROR: this device is already installed as the")).toBeLessThan(
      INSTALL_SH.indexOf("step_edition_foreign_teardown() {"),
    );
    expect(INSTALL_SH).toContain(
      "Nothing has been changed. No unit was stopped, started or masked",
    );
  });

  it("drives the shipped registry, not a second copy of the unit list", () => {
    // Two lists would drift, and the drift would be invisible: the validator
    // would keep reporting a unit the teardown had stopped listing.
    expect(TEARDOWN_FN).toContain('"${FOREIGN_EDITION_UNITS[@]}"');
    expect(TEARDOWN_FN).not.toContain("hermes-gateway.service");
    expect(TEARDOWN_FN).not.toContain("clawbox-hermes-dashboard");
  });
});

describe("stop+disable is the right amount of force", () => {
  it("the gateway's mask is justified by a sudoers grant no Hermes unit has", () => {
    // step_edition_gateway_state masks clawbox-gateway because a plain disable
    // is undone from the in-UI terminal. If an equivalent grant ever appears
    // for a Hermes unit, this test fails and the teardown needs revisiting.
    const grants = SUDOERS.split("\n").filter(
      (l) => l.startsWith("clawbox ") && l.includes("systemctl"),
    );
    expect(grants.some((l) => /\bstart\s+clawbox-gateway/.test(l))).toBe(true);
    for (const unit of ["hermes-dashboard", "hermes-gateway"]) {
      expect(grants.some((l) => l.includes(unit))).toBe(false);
    }
  });

  it("hermes-gateway.service is not ours to delete", () => {
    // Written by the upstream Hermes installer; nothing in config/ ships it, so
    // removing the file would make a deliberate return to hermes a reinstall.
    expect(fs.existsSync(path.join(REPO, "config/hermes-gateway.service"))).toBe(false);
  });
});

// ── Detection stays, and now tells the operator what to run ─────────────────
// Bringing the units down does not replace the check: a unit can come back
// under its own Restart=, and CLAWBOX_KEEP_FOREIGN_UNITS=1 skips the teardown
// entirely. Both leave the validator as the last line of defence.

function runValidator(
  edition: string,
  units: Record<string, string>,
): { status: number; stdout: string } {
  // Stubbed healthy for the same reason systemctl and curl are: this file's
  // subject is the foreign-unit checks, and a validator that also reads the
  // on-device TTS verdict would otherwise fail every case here for a reason
  // that has nothing to do with editions.
  const ttsStatus = path.join(tmp, "tts-status");
  fs.writeFileSync(ttsStatus, "KOKORO=ready\n");

  const script = [
    "set -uo pipefail",
    `CLAWBOX_EDITION=${edition}`,
    "CLAWBOX_TEST_MODE=1",
    "PROJECT_DIR=/home/clawbox/clawbox",
    "CLAWBOX_HOME=/nonexistent",
    'IFACE_ENV="/nonexistent/network.env"',
    SERVICE_REGISTRY,
    // The poll loop reads `date +%s` twice per pass and gives up after 30s. A
    // file-backed clock that jumps 100s per read makes a failing run break
    // after one pass instead of polling for half a minute.
    `_CLOCK=${JSON.stringify(path.join(tmp, "clock"))}`,
    'echo 1000 > "$_CLOCK"',
    'date() { local n; n=$(( $(cat "$_CLOCK") + 100 )); echo "$n" > "$_CLOCK"; printf \'%s\' "$n"; }',
    "sleep() { :; }",
    "curl() { printf '200'; }",
    "gateway_port_listening() { return 1; }",
    systemctlStub(units),
    VALIDATE_FN,
    "step_validate_services",
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    // TTS_STATUS_FILE travels as an environment variable rather than as an
    // interpolated shell assignment: JSON quoting is not shell quoting, and a
    // path is data, not script.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV, TTS_STATUS_FILE: ttsStatus },
  });
  return { status: r.status ?? -1, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function healthyOpenclaw(): Record<string, string> {
  return {
    "clawbox-setup.service": "enabled:active",
    "clawbox-gateway.service": "enabled:active",
    "clawbox-heartbeat.timer": "enabled:active",
    "clawbox-ap-watchdog.timer": "enabled:active",
    "clawbox-codex-auth-sync.timer": "enabled:active",
    "clawbox-heartbeat.service": "static:inactive",
    "clawbox-browser.service": "disabled:inactive",
    "clawbox-tunnel.service": "disabled:inactive",
    "clawbox-root-update@.service": "static:inactive",
    "clawbox-ap-watchdog.service": "static:inactive",
    "clawbox-codex-auth-sync.service": "static:inactive",
  };
}

d("the validator now says what to run, not just what is wrong", () => {
  it("names the per-unit fix on a foreign unit that is running", () => {
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "hermes-gateway.service": "enabled:active",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("sudo systemctl disable --now hermes-gateway.service");
  });

  it("names the per-unit fix on a foreign unit that is merely enabled", () => {
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "hermes-gateway.service": "enabled:inactive",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("sudo systemctl disable hermes-gateway.service");
  });

  it("offers the one command that redoes the whole teardown", () => {
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "clawbox-hermes-dashboard.service": "enabled:active",
      "hermes-gateway.service": "enabled:active",
    });
    expect(r.stdout).toContain(
      "sudo bash /home/clawbox/clawbox/install.sh --step edition_foreign_teardown",
    );
  });

  it("does not offer it for failures that have nothing to do with editions", () => {
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "clawbox-gateway.service": "enabled:failed",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("--step edition_foreign_teardown");
  });

  it("still passes a clean openclaw device, with the count unchanged", () => {
    // The teardown adds no checks — the healthy line must not move.
    const r = runValidator("openclaw", healthyOpenclaw());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/All 16 checks healthy/);
  });
});
