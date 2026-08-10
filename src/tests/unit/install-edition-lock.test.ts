import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// These pin the install-time invariants of the single-harness edition lock.
// Every one of them describes a bug that shipped: a drift guard that hard-exit
// 1'd on both SKUs, a Hermes appliance that kept an unauthenticated OpenClaw
// gateway on 0.0.0.0:18789, an "edition lock" that a customer could override
// from a file they own, and step functions that called a `log` helper defined
// hundreds of lines below the dispatch block that invokes them.

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const SETUP_UNIT = readFileSync(path.join(REPO, "config/clawbox-setup.service"), "utf-8");
const UPDATE_UNIT = readFileSync(path.join(REPO, "config/clawbox-root-update@.service"), "utf-8");
const HERMES_EDITION_SH = readFileSync(path.join(REPO, "scripts/setup-hermes-edition.sh"), "utf-8");

/** Contents of a bash array literal `NAME=( … )`, as trimmed entries. */
function bashArray(name: string): string[] {
  const start = INSTALL_SH.indexOf(`${name}=(`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n)", start);
  if (end < 0) throw new Error(`${name} has no closing paren`);
  return INSTALL_SH.slice(start + `${name}=(`.length, end)
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

describe("service drift guard is edition-aware (C2)", () => {
  const shippedUnits = readdirSync(path.join(REPO, "config"))
    .filter((f) => f.endsWith(".service") || f.endsWith(".timer"));

  it("every unit shipped in config/ is registered somewhere", () => {
    const registered = new Set([
      ...bashArray("EXPECTED_ACTIVE_SERVICES"),
      ...bashArray("EXPECTED_INSTALLED_SERVICES"),
      ...bashArray("EDITION_SCOPED_UNITS"),
    ]);
    // The guard's whole job: a new config/*.service that nobody wired up must
    // be an error, not a silent no-op on fresh devices.
    for (const unit of shippedUnits) expect(registered.has(unit)).toBe(true);
  });

  it("the guard checks the edition-aware registry, not the install list", () => {
    // Checking ALL_SERVICES made install.sh `exit 1` on EVERY edition: openclaw
    // has no Hermes units in its lists, hermes has no gateway in its lists.
    // Both paths run from step_system_config on a fresh install AND from
    // post_update on the in-app updater.
    const fn = extractShellFunction("step_systemd_services");
    expect(fn).toContain('for svc in "${KNOWN_UNITS[@]}"');
    expect(fn).toContain('KNOWN_UNITS=("${ALL_SERVICES[@]}" "${EDITION_SCOPED_UNITS[@]}")');
  });

  it("edition-scoped units stay OUT of the cp/enable lists", () => {
    // step_systemd_services cp's and `systemctl enable`s every entry of
    // ALL_SERVICES. Registering the Hermes units there to satisfy the guard
    // would crash-loop them on every OpenClaw box in the field (Restart=always
    // against a hermes binary that isn't installed), and registering the
    // gateway there would re-enable it on Hermes.
    const installed = new Set(bashArray("EXPECTED_INSTALLED_SERVICES"));
    for (const unit of bashArray("EDITION_SCOPED_UNITS")) {
      expect(installed.has(unit)).toBe(false);
    }
  });
});

describe("Hermes SKU removes the OpenClaw gateway (H1)", () => {
  it("stops, disables AND masks it — disable alone is defeatable", () => {
    // config/clawbox-sudoers grants the clawbox user NOPASSWD
    // `systemctl start clawbox-gateway`, reachable from the in-UI terminal,
    // SSH and the agent's run_command. Only a mask blocks that.
    const fn = extractShellFunction("step_edition_gateway_state");
    expect(fn).toMatch(/systemctl stop "\$unit"/);
    expect(fn).toMatch(/systemctl disable "\$unit"/);
    expect(fn).toMatch(/systemctl mask "\$unit"/);
    // `mask` refuses while a real unit file exists in /etc/systemd/system.
    expect(fn).toMatch(/rm -f "\/etc\/systemd\/system\/\$unit"/);
    // Non-hermes re-install must clear the mask, or the later cp would write
    // the unit straight into /dev/null.
    expect(fn).toMatch(/systemctl unmask "\$unit"/);
  });

  it("is re-asserted by the standalone provisioning script too", () => {
    expect(HERMES_EDITION_SH).toContain("systemctl mask clawbox-gateway.service");
  });

  it("install-time validation asserts the gateway is gone", () => {
    // The only automated guard that H1 stays fixed.
    const fn = extractShellFunction("step_validate_services");
    expect(fn).toContain("clawbox-gateway.service is ACTIVE");
  });
});

describe("edition persistence (H7 / H9)", () => {
  it("is written to a root-owned file, for all three editions", () => {
    const fn = extractShellFunction("step_edition_lock");
    expect(fn).toContain('install -d -o root -g root -m 0755 /etc/clawbox');
    expect(fn).toContain('chown root:root "$CLAWBOX_EDITION_FILE"');
    // No `case … dual) return 0`: dual used to bake nothing at all, so the
    // premium SKU silently ran as openclaw and could not be provisioned.
    expect(fn).not.toMatch(/case "\$CLAWBOX_EDITION"/);
  });

  it("clawbox-setup.service loads it AFTER the clawbox-writable .env", () => {
    const lines = SETUP_UNIT.split("\n").map((l) => l.trim());
    const userEnv = lines.indexOf("EnvironmentFile=-/home/clawbox/clawbox/.env");
    const rootEnv = lines.indexOf("EnvironmentFile=-/etc/clawbox/edition.env");
    expect(userEnv).toBeGreaterThan(-1);
    expect(rootEnv).toBeGreaterThan(-1);
    // systemd: later EnvironmentFile= wins, and EnvironmentFile= overrides
    // Environment=. Order the other way round and the "lock" is overridable by
    // anyone who can write .env — which is the clawbox user, i.e. the customer.
    expect(rootEnv).toBeGreaterThan(userEnv);
  });

  it("the updater unit loads it too", () => {
    // Without this (and without install.sh reading the file itself) every
    // updater-run step saw edition=openclaw, and UPDATE_STEPS includes
    // gateway_setup — so an update reinstalled OpenClaw on a Hermes box.
    expect(UPDATE_UNIT).toContain("EnvironmentFile=-/etc/clawbox/edition.env");
  });

  it("install.sh resolves the edition from the root-owned file, with a legacy fallback", () => {
    expect(INSTALL_SH).toContain('CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"');
    // Boxes provisioned before edition.env existed carry the SKU only in the
    // drop-in; without this fallback their first update runs edition-blind.
    expect(INSTALL_SH).toContain(
      'LEGACY_EDITION_DROPIN="/etc/systemd/system/clawbox-setup.service.d/edition.conf"',
    );
  });

  it("edition steps are dispatchable by the updater", () => {
    const dispatch = INSTALL_SH.slice(
      INSTALL_SH.indexOf("DISPATCH_STEPS=("),
      INSTALL_SH.indexOf("\n)", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
    );
    for (const step of ["edition_lock", "hermes_install", "hermes_edition"]) {
      expect(dispatch).toContain(step);
    }
  });
});

describe("dual SKU is actually provisionable (H8)", () => {
  it("installs the Hermes harness on hermes AND dual", () => {
    expect(extractShellFunction("step_hermes_install")).toContain("has_hermes_harness || return 0");
  });

  it("expects the Hermes dashboard units on hermes AND dual", () => {
    expect(INSTALL_SH).toContain("if has_hermes_harness; then\n  EXPECTED_ACTIVE_SERVICES+=(");
  });

  it("keeps the gateway on dual and drops it only on hermes", () => {
    expect(extractShellFunction("step_start_services")).toContain("if has_openclaw_harness; then");
    expect(INSTALL_SH).toContain('has_openclaw_harness() { [ "$CLAWBOX_EDITION" != "hermes" ]; }');
  });
});

describe("no step function calls log() before it is defined (M10)", () => {
  it("every `log` call sits after the log() definition", () => {
    // log() is defined at the very bottom, and the `--step` dispatch block
    // exits before reaching it — so `log` inside a step function is a 127 on
    // every updater-driven run, and under `set -e` an AND-list ending in one
    // takes the whole shell down.
    const definedAt = INSTALL_SH.indexOf("\nlog() {");
    expect(definedAt).toBeGreaterThan(0);
    const offenders: string[] = [];
    let offset = 0;
    for (const line of INSTALL_SH.split("\n")) {
      if (/^\s+log\s+"/.test(line) || /\{\s*log\s+"/.test(line)) {
        if (offset < definedAt) offenders.push(line.trim());
      }
      offset += line.length + 1;
    }
    expect(offenders).toEqual([]);
  });
});
