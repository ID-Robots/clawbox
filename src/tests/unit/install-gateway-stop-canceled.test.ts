import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * install.sh's `stop_gateway_unit` (TASK-2200): a stop another job REPLACED is
 * not a stop that failed.
 *
 * systemd keeps one job per unit, and a `start` or `restart` queued while a
 * stop runs takes its place: `systemctl stop` prints "Job for
 * clawbox-gateway.service canceled." and exits 1, whatever the unit does next.
 * The updater's own stop said exactly that on a box updating from an old beta,
 * and "Applying system fixups" ended before it ran a fixup — over a gateway
 * that was down a moment later all the same. install.sh stops the gateway on
 * the update path too (the legacy handover, under the maintenance guard; the
 * build's memory pause and the legacy-state quarantine, without it), so the
 * same sentence is judged there the same way: by the unit once its queue is
 * empty.
 *
 * Driven against a stubbed `systemctl`, cut from the shipped install.sh with
 * install.sh's own shell options.
 */

// Starts a real bash process: vitest's 5 s default is not enough on a loaded
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = fs.readFileSync(INSTALL_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${NL}${name}() {`);
  if (start < 0) throw new Error(`install.sh has no ${name}()`);
  return INSTALL_SH.slice(start + 1, INSTALL_SH.indexOf(`${NL}}`, start) + 2);
}

describe("stop_gateway_unit judges a canceled stop by the unit", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-stop-canceled-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    // STOPS: one word per `systemctl stop`, in order —
    //   canceled:<state>  another job replaced the stop; the unit is <state>
    //                     once that job is gone, which takes PENDING reads
    //   ok                the stop stopped it
    //   denied            a real failure (exit 4)
    fs.writeFileSync(
      path.join(tmp, "bin", "systemctl"),
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
        'case " $* " in',
        '  *" stop clawbox-gateway.service "*)',
        '    n=$(cat "$T/stops"); printf %s "$((n + 1))" > "$T/stops"',
        "    read -r -a outcomes <<< \"$STOPS\"",
        '    outcome="${outcomes[$n]:-ok}"',
        '    case "$outcome" in',
        "      canceled:*)",
        '        printf %s "${outcome#canceled:}" > "$T/state"; printf %s "${PENDING:-0}" > "$T/pending"',
        '        echo "Job for clawbox-gateway.service canceled." >&2; exit 1 ;;',
        '      denied) echo "Failed to stop clawbox-gateway.service: Access denied" >&2; exit 4 ;;',
        '      *) printf inactive > "$T/state"; exit 0 ;;',
        "    esac ;;",
        '  *" -p Job "*)',
        // JOB_UNANSWERED: that many Job queries fail before any is answered.
        '    u=$(cat "$T/unanswered"); if [ "$u" -gt 0 ]; then printf %s "$((u - 1))" > "$T/unanswered"; exit 1; fi',
        '    p=$(cat "$T/pending"); if [ "$p" -gt 0 ]; then printf %s "$((p - 1))" > "$T/pending"; echo 4242; fi',
        "    exit 0 ;;",
        '  *" -p ActiveState "*) cat "$T/state"; echo; exit 0 ;;',
        "esac",
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(tmp, "bin", "sleep"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(stops: string, pending = 0, unanswered = 0) {
    const log = path.join(tmp, "systemctl.log");
    fs.writeFileSync(log, "");
    fs.writeFileSync(path.join(tmp, "stops"), "0");
    fs.writeFileSync(path.join(tmp, "state"), "active");
    fs.writeFileSync(path.join(tmp, "pending"), "0");
    fs.writeFileSync(path.join(tmp, "unanswered"), String(unanswered));
    const script = [
      "set -euo pipefail",
      `export PATH="${tmp}/bin:$PATH"`,
      // The wait-note knobs are top-level assignments; cut them like the
      // functions so a test cannot pass by declaring them.
      `grep -E '^(WAIT_NOTE_EVERY_S|WAIT_NOTE_LAST)=' "$1" > "${tmp}/fns.sh"`,
      ...["wait_note", "stop_gateway_unit"].map((f) => `sed -n '/^${f}() {/,/^}/p' "$1" >> "${tmp}/fns.sh"`),
      `. "${tmp}/fns.sh"`,
      "set +e",
      "stop_gateway_unit 2>&1",
      "rc=$?",
      "set -e",
      'echo "RC=$rc"',
    ].join(NL);
    const out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SYSTEMCTL_LOG: log, T: tmp, STOPS: stops, PENDING: String(pending) },
    });
    const calls = fs.readFileSync(log, "utf8").split(NL).filter(Boolean);
    return {
      out,
      rc: Number(/RC=(\d+)/.exec(out)?.[1] ?? NaN),
      stops: calls.filter((c) => c === "stop clawbox-gateway.service").length,
      jobReads: calls.filter((c) => c.includes("-p Job")).length,
    };
  }

  it("stops a gateway in one call when nothing races it", () => {
    const r = run("ok");
    expect(r.rc).toBe(0);
    expect(r.stops).toBe(1);
    expect(r.jobReads).toBe(0);
  });

  it("counts a canceled stop that left the unit down as the stop it was", () => {
    const r = run("canceled:inactive", 3);
    expect(r.rc).toBe(0);
    expect(r.stops).toBe(1);
    expect(r.out).toContain("Job for clawbox-gateway.service canceled.");
    expect(r.out).toMatch(/replaced its stop; the unit is inactive, which is what the stop was for/);
    // The job that replaced the stop was waited out before the unit was read.
    expect(r.jobReads).toBe(4);
  });

  it("asks again when the job query goes unanswered, instead of reading it as no job", () => {
    // "Could not look" is not "done": two failed queries, then the job still
    // queued for two reads, then gone.
    const r = run("canceled:inactive", 2, 2);
    expect(r.rc).toBe(0);
    expect(r.stops).toBe(1);
    expect(r.jobReads).toBe(5);
  });

  it("counts a unit that ended failed as stopped too", () => {
    const r = run("canceled:failed");
    expect(r.rc).toBe(0);
    expect(r.stops).toBe(1);
  });

  it("stops it again when the job that replaced the stop left it up", () => {
    const r = run("canceled:active ok");
    expect(r.rc).toBe(0);
    expect(r.stops).toBe(2);
    expect(r.out).toMatch(/canceled its stop and it is active; stopping it again \(2\/3\)/);
  });

  it("fails as the stop failed when every stop is replaced and the unit stays up", () => {
    const r = run("canceled:active canceled:active canceled:activating ok");
    expect(r.rc).toBe(1);
    expect(r.stops).toBe(3);
    expect(r.out).toMatch(/Warning: another start of the gateway canceled its stop 3 times and it is activating/);
  });

  it("returns any other failure of the stop at once, with its own status", () => {
    const r = run("denied ok");
    expect(r.rc).toBe(4);
    expect(r.stops).toBe(1);
    expect(r.jobReads).toBe(0);
    expect(r.out).toContain("Access denied");
  });
});

describe("the update path stops the gateway through stop_gateway_unit", () => {
  it("in the legacy handover, under the maintenance guard, keeping the stop's status", () => {
    const body = shellFunction("handover_legacy_updater");
    expect(body).toContain("stop_gateway_unit || rc=$?");
    expect(body).not.toMatch(/systemctl stop clawbox-gateway/);
  });

  it("in the legacy-state quarantine, which runs without the guard and moves no file beside a live gateway", () => {
    const body = shellFunction("step_gateway_legacy_state_recovery");
    const stop = body.indexOf("if ! stop_gateway_unit; then");
    expect(stop).toBeGreaterThan(0);
    expect(body.slice(stop, body.indexOf(`${NL}  fi${NL}`, stop))).toContain("return 1");
    expect(stop).toBeLessThan(body.indexOf('mv -v "$f" "$qdir/"'));
    expect(body).not.toMatch(/systemctl stop clawbox-gateway/);
  });

  it("in the build's memory pause, which runs without the guard", () => {
    const body = shellFunction("pause_engine_unit");
    expect(body).toMatch(/if \[ "\$unit" = "clawbox-gateway\.service" \]; then\s+#[^\n]*\n(?:\s+#[^\n]*\n)*\s+stop_gateway_unit \|\|/);
  });

  it("stops a Hermes gateway once more after the mask, where nothing can start it again", () => {
    const body = shellFunction("step_edition_gateway_state");
    const mask = body.indexOf('systemctl mask "$unit"');
    const second = body.indexOf('systemctl stop "$unit"', mask);
    expect(mask).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(mask);

    const hermes = fs.readFileSync(path.join(REPO, "scripts", "setup-hermes-edition.sh"), "utf-8");
    const masked = hermes.indexOf("systemctl mask clawbox-gateway.service");
    expect(hermes.indexOf("systemctl stop clawbox-gateway.service", masked)).toBeGreaterThan(masked);
  });
});
