import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Unit files live in config/ but only reach a device when step_systemd_services
// copies them into /etc/systemd/system and daemon-reloads. Fresh installs run
// that step; the in-app updater's step list does NOT, so for a long time an
// updated box kept running whatever unit file it shipped with and every unit
// change was silently a fresh-install-only fix.
//
// That swallowed the llamacpp_install TimeoutStartSec raise: systemd killed
// the Gemma 4 build at 30 minutes, so "Provisioning offline Gemma 4" hung and
// then died on any box that updated rather than reinstalled. These tests pin
// the delivery path and the timeout relationship so neither can silently
// regress.

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const ROOT_UPDATE_UNIT = readFileSync(
  path.join(REPO, "config/clawbox-root-update@.service"),
  "utf-8",
);
const LLAMACPP_ROUTE = readFileSync(
  path.join(REPO, "src/app/setup-api/llamacpp/install/route.ts"),
  "utf-8",
);
const GATEWAY_UNIT = readFileSync(
  path.join(REPO, "config/clawbox-gateway.service"),
  "utf-8",
);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

/** Evaluate a numeric literal expression like `2 * 60 * 60 * 1000`. */
function evalArithmetic(expression: string): number {
  if (!/^[\d\s*+]+$/.test(expression)) {
    throw new Error(`refusing to evaluate non-arithmetic expression: ${expression}`);
  }
  return Function(`"use strict"; return (${expression});`)() as number;
}

describe("in-app update delivers unit-file changes", () => {
  it("post_update reinstalls systemd units", () => {
    // Without this call, config/*.service edits never land on an updated box.
    expect(extractShellFunction("step_post_update")).toContain("step_systemd_services");
  });

  it("systemd_services is dispatchable so post_update can call it", () => {
    const dispatch = INSTALL_SH.slice(
      INSTALL_SH.indexOf("DISPATCH_STEPS=("),
      INSTALL_SH.indexOf(")", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
    );
    expect(dispatch).toContain("systemd_services");
  });
});

describe("gateway restart breaker", () => {
  const intervalSec = Number(/^StartLimitIntervalSec=(\d+)$/m.exec(GATEWAY_UNIT)?.[1]);
  const burst = Number(/^StartLimitBurst=(\d+)$/m.exec(GATEWAY_UNIT)?.[1]);
  const timeoutSec = Number(/^TimeoutStartSec=(\d+)$/m.exec(GATEWAY_UNIT)?.[1]);
  const restartSec = Number(/^RestartSec=(\d+)$/m.exec(GATEWAY_UNIT)?.[1]);

  function acceptedStarts(failureDurationSec: number, attempts: number): number[] {
    const accepted: number[] = [];
    for (let attempt = 0, at = 0; attempt < attempts; attempt += 1, at += failureDurationSec + restartSec) {
      const inWindow = accepted.filter((startedAt) => at - startedAt <= intervalSec);
      if (inWindow.length >= burst) break;
      accepted.push(at);
    }
    return accepted;
  }

  // The failure cycle that motivated the 3600s window (issue #284): a rejected
  // startup that takes about twelve seconds to fail, which slipped straight
  // through systemd's inherited 10-second limiter window.
  const SLOW_FAILURE_SEC = 12;

  it("restarts on a clean exit, because that is how OpenClaw asks to be restarted", () => {
    // OpenClaw services a restart request by exiting 0 and handing off to its
    // supervisor. Under Restart=on-failure that exit was final, so every skill
    // install took the gateway down permanently. Restart=always is what
    // OpenClaw's own `openclaw daemon` systemd template writes.
    expect(GATEWAY_UNIT).toMatch(/^Restart=always$/m);
    // ...but not into a loop when the gateway reports its config is unusable,
    // and not marked failed when it is stopped with SIGTERM.
    expect(GATEWAY_UNIT).toMatch(/^RestartPreventExitStatus=78$/m);
    expect(GATEWAY_UNIT).toMatch(/^SuccessExitStatus=0 143$/m);
  });

  it("leaves headroom for deliberate restarts without losing the window", () => {
    expect(intervalSec).toBe(3_600);
    // Restart=always means operator-driven restarts (model changes, updates)
    // now count against the limiter too, so five is no longer enough headroom
    // for an hour of setting up a box. The window must still contain a full
    // burst of the slow-failure cycle, or the limiter could never trip.
    expect(burst).toBeGreaterThanOrEqual(10);
    expect(intervalSec).toBeGreaterThan(burst * (SLOW_FAILURE_SEC + restartSec));
    // The start timeout is a ceiling for a slow cold boot, not a failure cycle:
    // the risky pre-start step is time-boxed inside the script.
    expect(timeoutSec).toBeGreaterThan(SLOW_FAILURE_SEC);
  });

  it("breaks a permanent failure whose 12-second cycles defeated the old 10-second window", () => {
    expect(acceptedStarts(SLOW_FAILURE_SEC, burst + 2)).toHaveLength(burst);
  });

  it("allows a transient first failure to recover on the next start", () => {
    expect(acceptedStarts(12, 2)).toHaveLength(2);
  });

  it("is regenerated on both fresh install and update from the canonical unit", () => {
    expect(extractShellFunction("step_gateway_setup")).toContain(
      'cp "$PROJECT_DIR/config/clawbox-gateway.service" /etc/systemd/system/',
    );
    expect(extractShellFunction("step_post_update")).toContain("step_systemd_services");
  });
});

describe("llamacpp install timeouts", () => {
  const unitTimeoutSec = Number(/^TimeoutStartSec=(\d+)$/m.exec(ROOT_UPDATE_UNIT)?.[1]);
  const routeTimeoutMs = evalArithmetic(
    /const LLAMACPP_INSTALL_TIMEOUT_MS = ([^;]+);/.exec(LLAMACPP_ROUTE)?.[1]?.trim() ?? "0",
  );

  it("gives a cold Jetson build more than the old 30 minutes", () => {
    // Building llama.cpp from source with CUDA on a 6-core Orin plus a
    // multi-GB GGUF download does not fit in 1800s.
    expect(unitTimeoutSec).toBeGreaterThan(1800);
  });

  it("lets systemd own the kill, not the HTTP route", () => {
    // If the route gave up first it would report failure while the unit kept
    // installing in the background, and a retry would collide with it.
    expect(routeTimeoutMs).toBeGreaterThanOrEqual(unitTimeoutSec * 1000);
  });
});
