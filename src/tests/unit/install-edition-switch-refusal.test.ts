import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// A device installed as one edition and then re-installed as another completed
// all 26 steps and printed "All N checks healthy" — on a box that was broken.
// install.sh installs an edition; it has never migrated one. It has no step
// that stops, disables or masks the harness a device is LEAVING, and the AI
// provider sign-in lives in each harness's own config file, so it does not move
// across. The result was two harnesses running at once (duplicate Telegram
// pollers on one bot token, both dashboards bound), an incoming harness with an
// empty provider registry so every chat turn failed to resolve its model, and
// setup_complete carried over so the wizard step that would have repaired it
// never ran again.
//
// Two fixes are pinned here:
//   1. install.sh REFUSES the transition, before it changes anything.
//   2. step_validate_services can see units belonging to another edition, so
//      "All N checks healthy" is no longer printable on a two-harness box.
//
// Making the switch actually work is a separate feature and deliberately not
// attempted — changing edition is a reflash.

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const HERMES_EDITION_SH = fs.readFileSync(
  path.join(REPO, "scripts/setup-hermes-edition.sh"),
  "utf-8",
);

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

/** Source text between two literal markers, `end` exclusive. */
function sliceOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`marker not found: ${endMarker}`);
  return source.slice(start, end);
}

const slice = (startMarker: string, endMarker: string) =>
  sliceOf(INSTALL_SH, startMarker, endMarker);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

// ── The edition-resolution + refusal block, run for real ─────────────────────
// Everything from the lock-file constants down to (not including) the edition
// predicates: the resolution chain, the normalisation, and the refusal. The two
// absolute paths are rewritten to a temp dir so the real code can be executed
// unprivileged; nothing else is altered, so this exercises the shipped text.

const REFUSAL_BLOCK = slice(
  'CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"',
  "# The Hermes SKU: Hermes is the ONLY harness",
);

/** Just the refusal, without the resolution chain that precedes it. */
const REFUSAL_ONLY = slice(
  "# ── Refuse to change the edition of an already-provisioned device",
  "# The Hermes SKU: Hermes is the ONLY harness",
);

let tmp: string;
let lockPath: string;
let dropinPath: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-edition-"));
  lockPath = path.join(tmp, "edition.env");
  dropinPath = path.join(tmp, "edition.conf");
  projectDir = path.join(tmp, "project");
  fs.mkdirSync(path.join(projectDir, "config"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write the root-owned lock the way step_edition_lock does. */
function writeLock(edition: string): void {
  fs.writeFileSync(
    lockPath,
    `# ClawBox edition lock — written by install.sh (step_edition_lock).\nCLAWBOX_EDITION=${edition}\n`,
  );
}

/** Write the legacy systemd drop-in — the only record on pre-edition.env boxes. */
function writeLegacyDropin(edition: string): void {
  fs.writeFileSync(dropinPath, `[Service]\nEnvironment=CLAWBOX_EDITION=${edition}\n`);
}

function runRefusal(env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    REFUSAL_BLOCK.replace('"/etc/clawbox/edition.env"', JSON.stringify(lockPath)).replace(
      '"/etc/systemd/system/clawbox-setup.service.d/edition.conf"',
      JSON.stringify(dropinPath),
    ),
    'printf "RESOLVED=%s\\n" "$CLAWBOX_EDITION"',
  ].join("\n");

  // Deliberately NOT inheriting process.env: a CLAWBOX_EDITION already exported
  // in the developer's shell would silently rewrite what these cases are asking.
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

d("install.sh refuses to change a provisioned device's edition", () => {
  it("refuses when the lock says one edition and the environment asks for another", () => {
    writeLock("hermes");
    const r = runRefusal({ CLAWBOX_EDITION: "openclaw" });

    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("RESOLVED=");
    // The operator must be told what the device IS, what was ASKED for, and
    // that the supported route is a reflash. A bare "refused" sends them
    // straight to the escape hatch.
    expect(r.stderr).toContain("already installed as the 'hermes' edition");
    expect(r.stderr).toMatch(/Recorded edition:\s+hermes/);
    expect(r.stderr).toMatch(/Requested edition:\s+openclaw/);
    expect(r.stderr).toMatch(/REFLASH/i);
    // The escape hatch has to be named, or the message is a dead end...
    expect(r.stderr).toContain("CLAWBOX_ALLOW_EDITION_CHANGE=1");
    // ...as does the way back to a normal re-install of what it already is.
    expect(r.stderr).toContain("CLAWBOX_EDITION=hermes");
  });

  it("changes nothing on the way out", () => {
    writeLock("hermes");
    const before = fs.readFileSync(lockPath, "utf-8");
    const filesBefore = fs.readdirSync(tmp).sort();

    const r = runRefusal({ CLAWBOX_EDITION: "openclaw" });

    expect(r.status).toBe(1);
    // The refusal is worthless if it fires after the lock has been rewritten or
    // the gateway unmasked, so it must reach the exit having written nothing.
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(before);
    expect(fs.existsSync(dropinPath)).toBe(false);
    expect(fs.readdirSync(tmp).sort()).toEqual(filesBefore);
    expect(r.stderr).toContain("Nothing has been changed");
  });

  it("refuses on the legacy drop-in too — that is the only record on older boxes", () => {
    // Boxes provisioned before /etc/clawbox/edition.env existed carry the SKU
    // only in the systemd drop-in. Reading just the new file would leave that
    // whole part of the fleet switchable.
    writeLegacyDropin("hermes");
    const r = runRefusal({ CLAWBOX_EDITION: "openclaw" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already installed as the 'hermes' edition");
  });

  it("permits the switch with the explicit escape hatch", () => {
    writeLock("hermes");
    const r = runRefusal({ CLAWBOX_EDITION: "openclaw", CLAWBOX_ALLOW_EDITION_CHANGE: "1" });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=openclaw");
    // Permitted, but never quiet: the operator owns the teardown and the
    // credentials that the installer will not move for them.
    expect(r.stderr).toContain("WARNING");
    expect(r.stderr).toContain("CLAWBOX_ALLOW_EDITION_CHANGE=1");
  });

  it("takes only an explicit 1 as the escape hatch", () => {
    // A truthy-looking value must not open the gate by accident.
    writeLock("hermes");
    for (const value of ["0", "yes", "true", "", "2"]) {
      const r = runRefusal({ CLAWBOX_EDITION: "openclaw", CLAWBOX_ALLOW_EDITION_CHANGE: value });
      expect(r.status, `CLAWBOX_ALLOW_EDITION_CHANGE=${value}`).toBe(1);
    }
  });
});

d("the paths that must stay unaffected", () => {
  it("a fresh install with no lock installs whatever was asked for", () => {
    const r = runRefusal({ CLAWBOX_EDITION: "hermes" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=hermes");
    expect(r.stderr).toBe("");
  });

  it("a same-edition re-install is untouched", () => {
    writeLock("hermes");
    const r = runRefusal({ CLAWBOX_EDITION: "hermes" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=hermes");
    expect(r.stderr).toBe("");
  });

  it("the updater's path is untouched — no env var, edition read from the lock", () => {
    // post_update re-runs provisioning on EVERY update via
    // `install.sh --step`, whose unit exports CLAWBOX_EDITION from the lock
    // file. Requested and recorded are the same value by construction, so the
    // refusal must never fire on an update.
    writeLock("hermes");
    const r = runRefusal();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=hermes");
    expect(r.stderr).toBe("");
  });

  it("matches case-insensitively, like every other edition consumer", () => {
    // src/lib/edition-source.ts lower-cases; a lock reading "Hermes" is the
    // same device, not a switch.
    writeLock("Hermes");
    const r = runRefusal({ CLAWBOX_EDITION: "hermes" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=hermes");
  });

  it("normalises whitespace the same way on both sides of the comparison", () => {
    // The recorded value is whitespace-stripped by _normalise_edition. If the
    // resolution rule did not strip it too, a padded CLAWBOX_EDITION resolved to
    // openclaw (unrecognised → warn → openclaw) while the lock still read
    // hermes — a refusal on a device nobody was trying to change, reporting a
    // requested edition the operator never typed.
    writeLock("hermes");
    const r = runRefusal({ CLAWBOX_EDITION: "  hermes  " });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=hermes");
    expect(r.stderr).toBe("");
  });

  it("still refuses a padded value that IS a different edition", () => {
    // Whitespace tolerance must not blunt the check itself.
    writeLock("hermes");
    const r = runRefusal({ CLAWBOX_EDITION: " openclaw " });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Requested edition:\s+openclaw/);
  });

  it("does not refuse over an unrecognised recorded value", () => {
    // An unrecognised edition resolves to openclaw everywhere else, so a typo'd
    // lock describes an openclaw box. Refusing here would brick its updates.
    writeLock("openclw");
    const r = runRefusal({ CLAWBOX_EDITION: "openclaw" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=openclaw");
  });

  it("does not treat config/edition.txt as a record", () => {
    // edition.txt is a first-flash seed in a tree the customer owns. Reading it
    // as a lock would let anyone with write access to $PROJECT_DIR manufacture
    // a refusal — and would refuse genuine first installs.
    fs.writeFileSync(path.join(projectDir, "config", "edition.txt"), "hermes\n");
    const r = runRefusal({ CLAWBOX_EDITION: "openclaw" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("RESOLVED=openclaw");
  });
});

d("dual is a distinct edition, in both directions", () => {
  // Both directions into and out of dual are switches. dual is its own SKU
  // (both harnesses plus a licence-gated runtime switcher), and the ADDITIVE
  // direction fails exactly like the destructive one: the harness being added
  // comes up with an empty provider registry and no credentials, while
  // setup_complete suppresses the wizard step that would supply them. The lock
  // exists so the SKU cannot be flipped from the environment, so "upgrading" to
  // premium by exporting a variable is precisely what it has to refuse.
  const pairs: Array<[string, string]> = [
    ["openclaw", "dual"],
    ["hermes", "dual"],
    ["dual", "openclaw"],
    ["dual", "hermes"],
    ["openclaw", "hermes"],
    ["hermes", "openclaw"],
  ];

  for (const [recorded, requested] of pairs) {
    it(`refuses ${recorded} -> ${requested}`, () => {
      writeLock(recorded);
      const r = runRefusal({ CLAWBOX_EDITION: requested });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`already installed as the '${recorded}' edition`);
    });
  }

  for (const edition of ["openclaw", "hermes", "dual"]) {
    it(`allows a plain ${edition} re-install`, () => {
      writeLock(edition);
      const r = runRefusal({ CLAWBOX_EDITION: edition });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`RESOLVED=${edition}`);
    });
  }
});

describe("the refusal runs before anything can be changed", () => {
  it("sits at the top level, before any step function is even defined", () => {
    // Placement is the whole fix. It has to precede step_edition_lock (which
    // rewrites the lock and the drop-in) and step_edition_gateway_state (which
    // unmasks the gateway). Being ahead of the FIRST step definition is the
    // strong form of that: no step exists yet, on any entry path.
    const refusal = INSTALL_SH.indexOf("already installed as the");
    expect(refusal).toBeGreaterThan(0);
    const firstStepDefinition = INSTALL_SH.search(/^step_[a-z_]+\(\) \{/m);
    expect(firstStepDefinition).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(firstStepDefinition);
  });

  it("precedes both entry paths — full install and --step dispatch", () => {
    const refusal = INSTALL_SH.indexOf("already installed as the");
    expect(refusal).toBeLessThan(INSTALL_SH.indexOf("DISPATCH_STEPS=("));
    expect(refusal).toBeLessThan(INSTALL_SH.indexOf('echo "=== ClawBox Installer ==="'));
  });

  it("is a hard exit, not a warning", () => {
    expect(REFUSAL_ONLY).toContain("exit 1");
    expect(REFUSAL_ONLY).toContain(
      'CLAWBOX_ALLOW_EDITION_CHANGE="${CLAWBOX_ALLOW_EDITION_CHANGE:-0}"',
    );
  });

  it("does not implement edition switching", () => {
    // Explicitly out of scope: migrating credentials, tearing down the other
    // harness and re-running the AI step is a feature, not a bug fix. If a
    // teardown ever appears, this test should be deleted along with the
    // refusal — not silently left passing next to a half-migration.
    expect(REFUSAL_ONLY).not.toMatch(/systemctl\s+(stop|disable|mask|unmask)/);
    expect(REFUSAL_ONLY).not.toMatch(/\brm\s+-[rf]/);
  });
});

// ── The validator's blind spot ──────────────────────────────────────────────
// step_validate_services only ever appended the Hermes units to
// EXPECTED_ACTIVE_SERVICES inside `if has_hermes_harness`, so on the openclaw
// edition a fully running Hermes stack was not merely tolerated — it was
// invisible, and the installer printed a clean bill of health for a device
// running two agent harnesses.

const SERVICE_REGISTRY = slice(
  "# The Hermes SKU: Hermes is the ONLY harness",
  "# Load persisted WiFi interface if available",
);

/** Just the FOREIGN_EDITION_UNITS construction, out of the registry above. */
const FOREIGN_REGISTRY = SERVICE_REGISTRY.slice(
  SERVICE_REGISTRY.indexOf("FOREIGN_EDITION_UNITS=()"),
);

/** A fake `systemctl` over a table of `unit -> "<enabled>:<active>"`. */
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
    *) : ;;
  esac
  return 0
}
`;
}

function runValidator(
  edition: string,
  units: Record<string, string>,
): { status: number; stdout: string } {
  // The on-device TTS verdict is stubbed healthy for the same reason systemctl
  // and curl are: this file's subject is the edition checks, and a validator
  // that also reads the TTS verdict would otherwise fail every case here for a
  // reason that has nothing to do with editions.
  const ttsStatus = path.join(tmp, "tts-status");
  fs.writeFileSync(ttsStatus, "KOKORO=ready\n");

  const script = [
    "set -uo pipefail",
    `CLAWBOX_EDITION=${edition}`,
    `TTS_STATUS_FILE=${JSON.stringify(ttsStatus)}`,
    "CLAWBOX_TEST_MODE=1",
    "PROJECT_DIR=/nonexistent",
    "CLAWBOX_HOME=/nonexistent",
    'IFACE_ENV="/nonexistent/network.env"',
    SERVICE_REGISTRY,
    // The poll loop reads `date +%s` twice per pass and gives up after 30s. A
    // clock that jumps 100s per read makes a failing run break after ONE pass
    // instead of polling for half a minute. It has to be file-backed: `date` is
    // called inside command substitution, so a shell variable would be
    // incremented in a subshell and the parent would never see the deadline
    // pass — an infinite loop, not a slow test.
    `_CLOCK=${JSON.stringify(path.join(tmp, "clock"))}`,
    'echo 1000 > "$_CLOCK"',
    'date() { local n; n=$(( $(cat "$_CLOCK") + 100 )); echo "$n" > "$_CLOCK"; printf \'%s\' "$n"; }',
    "sleep() { :; }",
    "curl() { printf '200'; }",
    "gateway_port_listening() { return 1; }",
    systemctlStub(units),
    extractShellFunction("step_validate_services"),
    "step_validate_services",
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    // NODE_ENV is not read by any shell here; it is carried only because this
    // repo's ProcessEnv typing makes it required on an env literal.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV },
  });
  return { status: r.status ?? -1, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Every unit an openclaw device is supposed to have, all healthy. */
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

d("step_validate_services sees units belonging to another edition", () => {
  it("still passes a clean openclaw device", () => {
    const r = runValidator("openclaw", healthyOpenclaw());
    expect(r.stdout).toContain("checks healthy");
    expect(r.status).toBe(0);
  });

  it("fails an openclaw device that is still running the Hermes stack", () => {
    // The exact device state that reported "All 15 checks healthy": every
    // openclaw unit up, and every Hermes unit left active and enabled.
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "clawbox-hermes-dashboard.service": "enabled:active",
      "clawbox-hermes-dashboard-proxy.service": "enabled:active",
      "hermes-gateway.service": "enabled:active",
    });

    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("checks healthy");
    expect(r.stdout).toContain("clawbox-hermes-dashboard.service");
    expect(r.stdout).toContain("clawbox-hermes-dashboard-proxy.service");
    // The unit holding the Telegram bot token, hence the conflict loop.
    expect(r.stdout).toContain("hermes-gateway.service");
    expect(r.stdout).toContain("another edition");
  });

  it("fails on a foreign unit that is merely enabled — one reboot from active", () => {
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "hermes-gateway.service": "enabled:inactive",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/hermes-gateway\.service is enabled/);
  });

  it("ignores a foreign unit that is installed but disabled and stopped", () => {
    const r = runValidator("openclaw", {
      ...healthyOpenclaw(),
      "hermes-gateway.service": "disabled:inactive",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("checks healthy");
  });

  it("fails a hermes device that is still running the OpenClaw gateway", () => {
    const hermes: Record<string, string> = {
      "clawbox-setup.service": "enabled:active",
      "clawbox-heartbeat.timer": "enabled:active",
      "clawbox-ap-watchdog.timer": "enabled:active",
      "clawbox-codex-auth-sync.timer": "enabled:active",
      "clawbox-hermes-dashboard.service": "enabled:active",
      "clawbox-hermes-dashboard-proxy.service": "enabled:active",
      "clawbox-heartbeat.service": "static:inactive",
      "clawbox-browser.service": "disabled:inactive",
      "clawbox-tunnel.service": "disabled:inactive",
      "clawbox-root-update@.service": "static:inactive",
      "clawbox-ap-watchdog.service": "static:inactive",
      "clawbox-codex-auth-sync.service": "static:inactive",
      "clawbox-gateway.service": "enabled:active",
    };
    const r = runValidator("hermes", hermes);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("clawbox-gateway.service");
  });

  it("counts the foreign checks in the total, so the healthy line moves with them", () => {
    // Reporting "All N healthy" while silently not running some of the checks
    // is how the blind spot read as health in the first place.
    const withoutHermes = runValidator("openclaw", healthyOpenclaw());
    const total = /All (\d+) checks healthy/.exec(withoutHermes.stdout)?.[1];
    expect(total).toBeDefined();
    // 5 active (test mode drops clawbox-ap + clawbox-performance) + 6 installed
    // + 1 probe (test mode drops the WiFi probe) + 1 on-device TTS verdict
    // (openclaw only — Hermes has no TTS step) + 3 foreign-unit checks.
    expect(Number(total)).toBe(16);
  });
});

// ── The second writer of the lock ───────────────────────────────────────────
// scripts/setup-hermes-edition.sh also rewrites /etc/clawbox/edition.env (and
// the legacy drop-in). Guarding only install.sh would leave a documented
// standalone command that flips the lock — and worse, LAUNDERS the change: once
// the lock reads the new edition, a later plain install.sh sees recorded ==
// requested, finds no mismatch, and provisions the new harness on top.

const HERMES_EDITION_STEP_0 = sliceOf(
  HERMES_EDITION_SH,
  "# ── 0. Which edition are we?",
  "# ── 1. Sanity: Hermes must be present",
);

function runHermesEditionStep0(env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const script = [
    "set -euo pipefail",
    `EDITION_FILE=${JSON.stringify(lockPath)}`,
    `EDITION_DROPIN=${JSON.stringify(dropinPath)}`,
    'log() { echo "[hermes-edition] $*"; }',
    HERMES_EDITION_STEP_0,
    'printf "EDITION=%s\\n" "$EDITION"',
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

d("scripts/setup-hermes-edition.sh refuses the same transition", () => {
  it("refuses when the environment disagrees with the recorded lock", () => {
    writeLock("hermes");
    const r = runHermesEditionStep0({ CLAWBOX_EDITION: "dual" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already installed as the 'hermes' edition");
    expect(r.stderr).toContain("CLAWBOX_ALLOW_EDITION_CHANGE=1");
    // Must not reach the provisioning that rewrites the lock.
    expect(r.stdout).not.toContain("EDITION=");
    expect(fs.readFileSync(lockPath, "utf-8")).toContain("CLAWBOX_EDITION=hermes");
  });

  it("refuses the hermes -> openclaw direction by simply having nothing to do", () => {
    // openclaw never reaches the lock-writing code at all: the SKU gate exits 0.
    writeLock("hermes");
    const r = runHermesEditionStep0({ CLAWBOX_EDITION: "openclaw" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already installed as the 'hermes' edition");
  });

  it("refuses on the legacy drop-in too", () => {
    // Reading only /etc/clawbox/edition.env left every device provisioned before
    // that file existed able to walk straight past the refusal — the drop-in is
    // their only durable record.
    writeLegacyDropin("hermes");
    const r = runHermesEditionStep0({ CLAWBOX_EDITION: "dual" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already installed as the 'hermes' edition");
  });

  it("treats an unrecognised recorded value as openclaw, not as absent", () => {
    // Matching install.sh's rule. Reading it as "absent" would clear the
    // refusal and let a typo'd lock be provisioned straight over.
    writeLock("openclw");
    const refused = runHermesEditionStep0({ CLAWBOX_EDITION: "hermes" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("already installed as the 'openclaw' edition");

    // ...and with no request it is simply an openclaw box: nothing to do.
    const bare = runHermesEditionStep0();
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain("nothing to do");
  });

  it("permits the switch with the same escape hatch", () => {
    writeLock("hermes");
    const r = runHermesEditionStep0({
      CLAWBOX_EDITION: "dual",
      CLAWBOX_ALLOW_EDITION_CHANGE: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("EDITION=dual");
    expect(r.stdout).toContain("WARNING");
  });

  it("leaves install.sh's own call untouched", () => {
    // step_edition_lock runs before step_hermes_edition, so by the time this
    // script is invoked the lock and $CLAWBOX_EDITION always agree.
    for (const edition of ["hermes", "dual"]) {
      writeLock(edition);
      const r = runHermesEditionStep0({ CLAWBOX_EDITION: edition });
      expect(r.status, edition).toBe(0);
      expect(r.stdout).toContain(`EDITION=${edition}`);
    }
  });

  it("leaves a standalone repair run untouched — lock, no environment", () => {
    writeLock("hermes");
    const r = runHermesEditionStep0();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("EDITION=hermes");
  });

  it("leaves a first flash untouched — environment, no lock yet", () => {
    const r = runHermesEditionStep0({ CLAWBOX_EDITION: "dual" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("EDITION=dual");
  });

  it("keeps the historical default when neither is present", () => {
    const r = runHermesEditionStep0();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("EDITION=hermes");
  });

  it("still does nothing at all on an openclaw device", () => {
    writeLock("openclaw");
    const r = runHermesEditionStep0();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to do");
    expect(r.stdout).not.toContain("EDITION=openclaw");
  });

  it("reads the lock before the environment, like every other consumer", () => {
    // The old order was env-first, which made this the one place where an
    // environment variable outranked the root-owned lock — and the one place
    // that then rewrote it.
    expect(HERMES_EDITION_STEP_0.indexOf("RECORDED_EDITION=")).toBeLessThan(
      HERMES_EDITION_STEP_0.indexOf("REQUESTED_EDITION="),
    );
    expect(HERMES_EDITION_STEP_0).toContain("exit 1");
  });
});

describe("the foreign-unit registry", () => {
  it("covers the whole Hermes harness on editions that do not run it", () => {
    expect(FOREIGN_REGISTRY).toContain("if ! has_hermes_harness; then");
    for (const unit of [
      "clawbox-hermes-dashboard.service",
      "clawbox-hermes-dashboard-proxy.service",
      // Written by the upstream Hermes installer, not by config/. No ClawBox
      // code path stops it, and it is the one holding the Telegram bot token.
      "hermes-gateway.service",
    ]) {
      expect(FOREIGN_REGISTRY).toContain(unit);
    }
  });

  it("covers the OpenClaw gateway on editions that do not run it", () => {
    expect(FOREIGN_REGISTRY).toContain("if ! has_openclaw_harness; then");
    expect(FOREIGN_REGISTRY).toContain("FOREIGN_EDITION_UNITS+=(clawbox-gateway.service)");
  });

  it("leaves dual alone — it is the edition that legitimately runs both", () => {
    // Both guards are negations of the has_*_harness predicates, and dual
    // satisfies both, so dual accumulates nothing.
    expect(FOREIGN_REGISTRY).not.toContain("is_hermes_edition");
    expect(INSTALL_SH).toContain('has_hermes_harness() { [ "$CLAWBOX_EDITION" = "hermes" ] || [ "$CLAWBOX_EDITION" = "dual" ]; }');
    expect(INSTALL_SH).toContain('has_openclaw_harness() { [ "$CLAWBOX_EDITION" != "hermes" ]; }');
  });

  it("every ClawBox-shipped harness unit is claimed by exactly one edition", () => {
    // EDITION_SCOPED_UNITS lists the units that exist in config/ but are only
    // installed on some SKUs. Each of them must also be recognisable as foreign
    // somewhere, or the validator keeps a blind spot for it.
    const scoped = slice("EDITION_SCOPED_UNITS=(", "\n)")
      .split("\n")
      .slice(1)
      // Strip trailing comments, then the quotes some entries carry
      // (`"clawbox-root-update@.service"` in the sibling arrays).
      .map((l) => l.replace(/#.*$/, "").trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(scoped.length).toBeGreaterThan(0);
    for (const unit of scoped) expect(FOREIGN_REGISTRY).toContain(unit);
  });
});
