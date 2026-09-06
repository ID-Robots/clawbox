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

describe("root units execute root-owned copies, and updates deliver them", () => {
  // Security scan #21. clawbox-ap.service, clawbox-ap-watchdog.service and
  // clawbox-firstboot-vnc.service run as root (no User=) and used to ExecStart
  // the tree copies under /home/clawbox/clawbox/scripts — clawbox-owned after
  // every `chown -R`, so a clawbox foothold was root inside the watchdog's
  // twenty-second tick. The fix is the TASK-445 mechanism: install_root_libexec
  // copies them under /usr/local/libexec/clawbox and the units name the copies.
  // Both halves are pinned here, plus the order that keeps a live timer from
  // running the new unit against a copy that is not there yet.

  /** The `for src in …; do` lists of a function, backslash continuations joined. */
  function forLists(fn: string): string[] {
    const joined = fn.replace(/\\\n\s*/g, " ");
    return [...joined.matchAll(/for src in ([^;]*); do/g)].map((m) => m[1]);
  }

  const ROOT_RUN_SCRIPTS = ["start-ap.sh", "stop-ap.sh", "ap-watchdog.sh", "ensure-vnc-on-first-boot.sh"];

  it("install_root_libexec copies every script a root unit ExecStarts", () => {
    const lists = forLists(extractShellFunction("install_root_libexec"));
    expect(lists.length).toBeGreaterThan(0);
    const scriptsList = lists.find((l) => l.includes("gateway-restart-when-online.sh"));
    expect(scriptsList, "the scripts/ copy loop of install_root_libexec").toBeDefined();
    for (const name of ROOT_RUN_SCRIPTS) {
      expect(scriptsList!.split(/\s+/), `${name} is not installed root-owned`).toContain(name);
    }
  });

  it("installs the root-owned copies BEFORE the unit files that name them", () => {
    // On the first in-app update carrying the new units the watchdog timer is
    // already firing every 20 s; cp + daemon-reload ahead of the copy would run
    // the new ExecStart against a path that does not exist yet.
    const step = extractShellFunction("step_systemd_services");
    const libexecAt = step.indexOf("install_root_libexec");
    const cpAt = step.indexOf('cp "$src" /etc/systemd/system/');
    const reloadAt = step.indexOf("systemctl daemon-reload");
    expect(libexecAt, "install_root_libexec must be called by step_systemd_services").toBeGreaterThan(-1);
    expect(cpAt, "step_systemd_services must copy the unit files").toBeGreaterThan(-1);
    expect(reloadAt).toBeGreaterThan(-1);
    expect(libexecAt, "install_root_libexec must run before the unit cp loop").toBeLessThan(cpAt);
    expect(libexecAt, "install_root_libexec must run before daemon-reload").toBeLessThan(reloadAt);
  });

  it("delivers the copies to an updated box through post_update", () => {
    // step_systemd_services is on post_update's list (pinned above), and it is
    // now the step that installs the copies — so an updated box gets both the
    // new units and the files they name in the same run.
    expect(extractShellFunction("step_post_update")).toContain("step_systemd_services");
    expect(extractShellFunction("step_systemd_services")).toContain("install_root_libexec");
  });

  it("points the AP units at the copies it installs, not at the tree", () => {
    for (const unit of ["clawbox-ap.service", "clawbox-ap-watchdog.service"]) {
      const text = readFileSync(path.join(REPO, "config", unit), "utf-8");
      expect(text).not.toMatch(/^User=/m);
      for (const m of text.matchAll(/^Exec(?:Start|Stop)=(.+)$/gm)) {
        expect(m[1].startsWith("/usr/local/libexec/clawbox/"), `${unit}: ${m[0]}`).toBe(true);
        expect(ROOT_RUN_SCRIPTS, `${unit} names a script install_root_libexec does not install`)
          .toContain(path.basename(m[1]));
      }
    }
  });

  it("repoints an already-installed first-boot VNC unit on update", () => {
    // step_vnc_refresh is the update-path subset of step_vnc_install. A box
    // whose first-boot marker never cleared still runs that unit as root at
    // every boot, and it names the tree copy; only an update can fix it.
    const refresh = extractShellFunction("step_vnc_refresh");
    expect(refresh).toContain("clawbox-firstboot-vnc.service");
    expect(refresh).toContain("$ROOT_LIBEXEC_DIR/ensure-vnc-on-first-boot.sh");
    expect(extractShellFunction("step_post_update")).toContain("step_vnc_refresh");
    // The repoint must not depend on post_update's ordering: the step makes
    // sure of the libexec copy itself, the way step_vnc_install does, or a
    // reorder would leave its `[ -x ]` guard skipping the repoint for another
    // update cycle with root still running the tree copy at every boot.
    // Not as `[ -x … ] || install_root_libexec` any more: in an OR-list a copy
    // that failed inside the function came back as 0 and was never reported,
    // so the call keeps its own status (root-steps.test.ts pins the rest).
    expect(refresh).toMatch(/\[ ! -x "\$ROOT_LIBEXEC_DIR\/ensure-vnc-on-first-boot\.sh" \]; then\n\s*install_root_libexec \|\| firstboot_rc=1/);
    // ...and the repoint itself is gated on the copy being THERE, so a unit
    // is never pointed at a file that did not land.
    const repointAt = refresh.indexOf("sed -i \"s#^ExecStart=$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh");
    expect(repointAt).toBeGreaterThan(-1);
    const gate = refresh.lastIndexOf('if [ -x "$ROOT_LIBEXEC_DIR/ensure-vnc-on-first-boot.sh" ]; then', repointAt);
    expect(gate, "the repoint sits inside an `[ -x ]` test of the copy").toBeGreaterThan(-1);
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
