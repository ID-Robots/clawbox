import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The unified image's lock value, `unselected` (TASK-1149,
 * reports/clawbox/unified-image-design-2026-09.md §6/§8 PR 1): both harnesses
 * on disk, neither running, until the owner picks one in the setup wizard.
 *
 * Driven against install.sh's own text — the resolution chain, the refusal
 * matrix, the installs-vs-runs predicates, the service registry and the lock
 * writer — with the two absolute lock paths rewritten into a temp dir, the
 * way install-edition-switch-refusal.test.ts runs the same block.
 */

// Real bash per case; see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

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

/** Resolution + hint + refusal + the predicates, as install.sh parses them. */
const EDITION_BLOCK = slice(
  'CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"',
  "# CLAWBOX_TEST_MODE=1 skips hardware-only steps",
);

/** The unit registry that consumes the predicates. */
const REGISTRY_BLOCK = slice(
  "EXPECTED_ACTIVE_SERVICES=(",
  "# Read one KEY=VALUE out of a file this script does NOT trust.",
);

let tmp: string;
let lockPath: string;
let dropinPath: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-unselected-"));
  lockPath = path.join(tmp, "edition.env");
  dropinPath = path.join(tmp, "edition.conf");
  projectDir = path.join(tmp, "project");
  fs.mkdirSync(path.join(projectDir, "config"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeLock(body: string): void {
  fs.writeFileSync(lockPath, `# ClawBox edition lock — written by install.sh (step_edition_lock).\n${body}`);
}

interface Parsed {
  status: number;
  out: string;
  vars: Record<string, string>;
}

/**
 * Parse the edition the way install.sh does at the top of every run, then
 * print what each predicate and unit list says. Never inherits process.env.
 */
function parse(env: Record<string, string> = {}): Parsed {
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    'SRC_DIR="$PROJECT_DIR"',
    EDITION_BLOCK.replace('"/etc/clawbox/edition.env"', JSON.stringify(lockPath)).replace(
      '"/etc/systemd/system/clawbox-setup.service.d/edition.conf"',
      JSON.stringify(dropinPath),
    ),
    REGISTRY_BLOCK,
    'yn() { if "$@"; then echo yes; else echo no; fi; }',
    'printf "EDITION=%s\\n" "$CLAWBOX_EDITION"',
    'printf "RECORDED=%s\\n" "$CLAWBOX_RECORDED_EDITION"',
    'printf "HINT=%s\\n" "$CLAWBOX_EDITION_HINT"',
    'printf "RUNS_HERMES=%s\\n" "$(yn has_hermes_harness)"',
    'printf "RUNS_OPENCLAW=%s\\n" "$(yn has_openclaw_harness)"',
    'printf "INSTALLS_HERMES=%s\\n" "$(yn installs_hermes_harness)"',
    'printf "INSTALLS_OPENCLAW=%s\\n" "$(yn installs_openclaw_harness)"',
    'printf "UNSELECTED=%s\\n" "$(yn is_unselected_edition)"',
    'printf "ACTIVE=%s\\n" "${EXPECTED_ACTIVE_SERVICES[*]}"',
    'printf "FOREIGN=%s\\n" "${FOREIGN_EDITION_UNITS[*]:-}"',
    'printf "FOREIGN_USER=%s\\n" "${FOREIGN_EDITION_USER_UNITS[*]:-}"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 20_000,
  });
  const vars: Record<string, string> = {};
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, vars };
}

d("`unselected` is a first-class edition", () => {
  it("is accepted as a flash-time request, without the 'unrecognised' warning", () => {
    const r = parse({ CLAWBOX_EDITION: "unselected" });
    expect(r.status, r.out).toBe(0);
    expect(r.vars.EDITION).toBe("unselected");
    expect(r.out).not.toMatch(/unrecognised edition/);
  });

  it("is read back from the lock as itself, never collapsed to openclaw", () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    const r = parse();
    expect(r.status, r.out).toBe(0);
    expect(r.vars.EDITION).toBe("unselected");
    expect(r.vars.RECORDED).toBe("unselected");
  });

  it("INSTALLS both harnesses and RUNS neither", () => {
    const r = parse({ CLAWBOX_EDITION: "unselected" });
    expect(r.vars).toMatchObject({
      UNSELECTED: "yes",
      INSTALLS_HERMES: "yes",
      INSTALLS_OPENCLAW: "yes",
      RUNS_HERMES: "no",
      RUNS_OPENCLAW: "no",
    });
  });

  it("expects no harness unit up, and lists every harness unit as one to keep down", () => {
    const r = parse({ CLAWBOX_EDITION: "unselected" });
    const active = r.vars.ACTIVE.split(" ");
    expect(active).toContain("clawbox-setup.service");
    for (const unit of ["clawbox-gateway.service", "clawbox-hermes-dashboard.service", "clawbox-hermes-dashboard-proxy.service"]) {
      expect(active).not.toContain(unit);
    }
    const foreign = r.vars.FOREIGN.split(" ");
    for (const unit of [
      "clawbox-gateway.service",
      "clawbox-hermes-dashboard.service",
      "clawbox-hermes-dashboard-proxy.service",
      "hermes-gateway.service",
    ]) {
      expect(foreign).toContain(unit);
    }
    expect(r.vars.FOREIGN_USER).toBe("hermes-gateway.service");
  });

  it.each([
    // edition, installs/runs hermes, installs/runs openclaw — the three
    // shipped editions answer exactly what they did before the split.
    ["openclaw", "no", "no", "yes", "yes"],
    ["hermes", "yes", "yes", "no", "no"],
    ["dual", "yes", "yes", "yes", "yes"],
  ])("leaves %s exactly as it was", (edition, installsH, runsH, installsO, runsO) => {
    const r = parse({ CLAWBOX_EDITION: edition });
    expect(r.status, r.out).toBe(0);
    expect(r.vars).toMatchObject({
      UNSELECTED: "no",
      INSTALLS_HERMES: installsH,
      RUNS_HERMES: runsH,
      INSTALLS_OPENCLAW: installsO,
      RUNS_OPENCLAW: runsO,
    });
  });

  it("keeps the gateway in the active set on openclaw and dual only", () => {
    expect(parse({ CLAWBOX_EDITION: "openclaw" }).vars.ACTIVE).toContain("clawbox-gateway.service");
    expect(parse({ CLAWBOX_EDITION: "dual" }).vars.ACTIVE).toContain("clawbox-gateway.service");
    expect(parse({ CLAWBOX_EDITION: "hermes" }).vars.ACTIVE).not.toContain("clawbox-gateway.service");
  });
});

d("the refusal matrix around `unselected`", () => {
  it.each(["openclaw", "hermes", "dual"])(
    "refuses %s -> unselected, even with CLAWBOX_ALLOW_EDITION_CHANGE=1",
    (recorded) => {
      writeLock(`CLAWBOX_EDITION=${recorded}\n`);
      for (const allow of ["0", "1"]) {
        const r = parse({ CLAWBOX_EDITION: "unselected", CLAWBOX_ALLOW_EDITION_CHANGE: allow });
        expect(r.status, r.out).toBe(1);
        expect(r.out).toMatch(new RegExp(`already the '${recorded}' edition; it cannot go back to 'unselected'`));
        expect(r.out).not.toMatch(/^EDITION=/m);
        expect(fs.readFileSync(lockPath, "utf-8")).toContain(`CLAWBOX_EDITION=${recorded}`);
      }
    },
  );

  it("refuses unselected -> dual, even with CLAWBOX_ALLOW_EDITION_CHANGE=1", () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    for (const allow of ["0", "1"]) {
      const r = parse({ CLAWBOX_EDITION: "dual", CLAWBOX_ALLOW_EDITION_CHANGE: allow });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/cannot become the 'dual' edition/);
    }
  });

  it.each(["openclaw", "hermes"])(
    "refuses unselected -> %s without the flag, and says what the box is waiting for",
    (target) => {
      writeLock("CLAWBOX_EDITION=unselected\n");
      const r = parse({ CLAWBOX_EDITION: target });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/waiting for its owner to choose/);
      expect(r.out).toMatch(/--step edition_select/);
    },
  );

  it.each(["openclaw", "hermes"])(
    "lets the choice itself through: unselected -> %s with the flag and the step's reason",
    (target) => {
      writeLock("CLAWBOX_EDITION=unselected\n");
      const r = parse({
        CLAWBOX_EDITION: target,
        CLAWBOX_ALLOW_EDITION_CHANGE: "1",
        CLAWBOX_EDITION_CHANGE_REASON: "the owner chose it in the setup wizard (install.sh --step edition_select)",
      });
      expect(r.status, r.out).toBe(0);
      expect(r.vars.EDITION).toBe(target);
      expect(r.out).toMatch(new RegExp(`installing '${target}' over 'unselected' — the owner chose it`));
    },
  );

  it("is a no-op for a plain re-run on an unselected box (the updater's own runs)", () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    const r = parse({ CLAWBOX_EDITION: "unselected" });
    expect(r.status, r.out).toBe(0);
    expect(r.vars.EDITION).toBe("unselected");
  });
});

d("the order hint", () => {
  it("comes from the environment, normalised", () => {
    const r = parse({ CLAWBOX_EDITION: "unselected", CLAWBOX_EDITION_HINT: " Hermes " });
    expect(r.vars.HINT).toBe("hermes");
  });

  it("falls back to the one already in the lock", () => {
    writeLock("CLAWBOX_EDITION=unselected\nCLAWBOX_EDITION_HINT=hermes\n");
    expect(parse().vars.HINT).toBe("hermes");
  });

  it("is ignored, loudly, when it is not an agent", () => {
    const r = parse({ CLAWBOX_EDITION: "unselected", CLAWBOX_EDITION_HINT: "dual" });
    expect(r.status, r.out).toBe(0);
    expect(r.vars.HINT).toBe("");
    expect(r.out).toMatch(/unrecognised edition hint 'dual'/);
  });

  it("never reads as the edition itself", () => {
    // The hint line must not be picked up by the CLAWBOX_EDITION parsers.
    writeLock("CLAWBOX_EDITION=unselected\nCLAWBOX_EDITION_HINT=hermes\n");
    expect(parse().vars.EDITION).toBe("unselected");
  });
});

d("step_edition_lock writes the hint on the unified image only", () => {
  function runLock(env: Record<string, string>): { out: string; lock: string } {
    const published = path.join(tmp, "published.env");
    const program = [
      ...Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
      `CLAWBOX_EDITION_FILE=${JSON.stringify(lockPath)}`,
      `LEGACY_EDITION_DROPIN=${JSON.stringify(dropinPath)}`,
      slice("is_hermes_edition() {", "\n# Editions that RUN the Hermes harness"),
      "install() { :; }",
      "systemctl() { :; }",
      "step_edition_gateway_state() { :; }",
      "step_edition_foreign_teardown() { :; }",
      `install_root_file() { if [ "$2" = ${JSON.stringify(lockPath)} ]; then cp "$1" ${JSON.stringify(published)}; fi; return 0; }`,
      extractShellFunction("step_edition_lock"),
      "step_edition_lock",
    ].join("\n");
    const r = spawnSync("bash", ["-c", program], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" }, timeout: 20_000 });
    return {
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      lock: fs.existsSync(published) ? fs.readFileSync(published, "utf-8") : "",
    };
  }

  it("adds CLAWBOX_EDITION_HINT beside unselected", () => {
    const { lock, out } = runLock({ CLAWBOX_EDITION: "unselected", CLAWBOX_EDITION_HINT: "hermes" });
    expect(lock, out).toMatch(/^CLAWBOX_EDITION=unselected$/m);
    expect(lock).toMatch(/^CLAWBOX_EDITION_HINT=hermes$/m);
  });

  it("writes no hint line when there is none", () => {
    const { lock } = runLock({ CLAWBOX_EDITION: "unselected", CLAWBOX_EDITION_HINT: "" });
    expect(lock).toMatch(/^CLAWBOX_EDITION=unselected$/m);
    expect(lock).not.toMatch(/HINT/);
  });

  it("drops the hint the moment the box is locked to an agent — byte-for-byte a factory lock", () => {
    const chosen = runLock({ CLAWBOX_EDITION: "hermes", CLAWBOX_EDITION_HINT: "hermes" }).lock;
    const factory = runLock({ CLAWBOX_EDITION: "hermes", CLAWBOX_EDITION_HINT: "" }).lock;
    expect(chosen).toBe(factory);
    expect(chosen).not.toMatch(/HINT/);
  });
});

describe("the gates that keep an undecided box from running an agent", () => {
  it("gateway_setup skips while no agent is chosen", () => {
    expect(extractShellFunction("step_gateway_setup")).toMatch(
      /is_unselected_edition && \{ echo "  \[no agent chosen yet\] skipping OpenClaw gateway setup"; return 0; \}/,
    );
  });

  it("the gateway's legacy-state recovery skips while no agent is chosen", () => {
    expect(extractShellFunction("step_gateway_legacy_state_recovery")).toContain(
      'is_unselected_edition && { echo "  [no agent chosen yet] skipping gateway recovery"; return 0; }',
    );
  });

  it("Hermes provisioning stays on the editions that RUN Hermes", () => {
    expect(extractShellFunction("step_hermes_edition")).toContain("has_hermes_harness || return 0");
  });

  it("a unified full install proves BOTH agents run before its verdict", () => {
    const block = slice("if is_unselected_edition; then\n  echo \"\"\n  echo \"  Unified image", 'log "Validating services..."');
    expect(block).toContain("harness_swap_openclaw_runnable");
    expect(block).toContain("record_provision_failure openclaw_install");
    expect(block).toContain("harness_swap_hermes_runnable");
    expect(block).toContain("record_provision_failure hermes_install");
  });

  it("documents the unified image in the installer's own usage header", () => {
    const header = INSTALL_SH.slice(0, INSTALL_SH.indexOf("set -euo pipefail"));
    expect(header).toContain("sudo CLAWBOX_EDITION=unselected bash install.sh");
    expect(header).toContain("CLAWBOX_EDITION_HINT=hermes");
  });
});
