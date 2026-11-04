import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";

/**
 * An in-app update ends in a reboot only when something needs a boot.
 *
 * `step_rebuild_reboot` ended every update with a bare `reboot`, and that
 * reboot once left a box dark for twelve hours. Now the step asks first —
 * Ubuntu's /var/run/reboot-required (which the L4T kernel, initrd and
 * bootloader packages set on a JetPack upgrade), a kernel or boot file written
 * since this boot, a running kernel whose modules are gone, or a ClawBox marker
 * — and with no reason it restarts the ClawBox services instead.
 *
 * These run the shipped functions, sliced out of install.sh, against fake
 * paths and a fake `systemctl`.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function fn(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return INSTALL_SH.slice(start + 1, end + 2);
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "update-reboot-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function bash(script: string, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, ...env }),
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// ── 1. The decision ─────────────────────────────────────────────────────────

d("update_reboot_reasons: the signals a boot is needed", () => {
  const BOOT_SECS = 1_800_000_000;
  let boot: string;
  let modules: string;
  let procStat: string;
  let flag: string;
  let marker: string;

  beforeEach(() => {
    boot = path.join(tmp, "boot");
    modules = path.join(tmp, "modules");
    procStat = path.join(tmp, "stat");
    flag = path.join(tmp, "run", "reboot-required");
    marker = path.join(tmp, "run", "clawbox", "reboot-required");
    fs.mkdirSync(path.join(boot, "extlinux"), { recursive: true });
    fs.mkdirSync(path.join(boot, "dtb"), { recursive: true });
    fs.mkdirSync(path.join(modules, "5.15.185-tegra"), { recursive: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(procStat, `cpu  1 2 3 4\nbtime ${BOOT_SECS}\nprocesses 42\n`);
    // Every kernel/boot file written before this boot: nothing to report.
    for (const f of ["Image", "initrd", "extlinux/extlinux.conf", "dtb/kernel_tegra234-p3768.dtb"]) {
      const p = path.join(boot, f);
      fs.writeFileSync(p, "x");
      fs.utimesSync(p, BOOT_SECS - 3600, BOOT_SECS - 3600);
    }
  });

  function reasons(): { status: number | null; lines: string[]; err: string } {
    const r = bash(["set -euo pipefail", fn("update_reboot_reasons"), "update_reboot_reasons"].join("\n"), {
      CLAWBOX_REBOOT_REQUIRED_FLAG: flag,
      CLAWBOX_REBOOT_MARKER: marker,
      CLAWBOX_BOOT_DIR: boot,
      CLAWBOX_MODULES_DIR: modules,
      CLAWBOX_PROC_STAT: procStat,
      CLAWBOX_KERNEL_RELEASE: "5.15.185-tegra",
    });
    return { status: r.status, lines: r.out.split("\n").filter(Boolean), err: r.err };
  }

  it("says nothing when nothing needs a boot", () => {
    const r = reasons();
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("names Ubuntu's reboot-required flag and the packages that set it", () => {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, "*** System restart required ***\n");
    fs.writeFileSync(`${flag}.pkgs`, "nvidia-l4t-kernel\nlibc6\nnvidia-l4t-kernel\n");
    const r = reasons();
    expect(r.status).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(flag);
    expect(r.lines[0]).toContain("nvidia-l4t-kernel");
    expect(r.lines[0]).toContain("libc6");
    // Each package once, however many postinsts asked.
    expect(r.lines[0].match(/nvidia-l4t-kernel/g)).toHaveLength(1);
  });

  it("takes the flag alone when no package list came with it", () => {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, "");
    const r = reasons();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(flag);
  });

  it.each(["Image", "initrd", "extlinux/extlinux.conf", "dtb/kernel_tegra234-p3768.dtb"])(
    "names /boot/%s when it was written since this boot",
    (file) => {
      fs.utimesSync(path.join(boot, file), BOOT_SECS + 600, BOOT_SECS + 600);
      const r = reasons();
      expect(r.status).toBe(0);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toContain(file);
    },
  );

  it("never calls a boot file new when the boot time cannot be read", () => {
    fs.utimesSync(path.join(boot, "Image"), BOOT_SECS + 600, BOOT_SECS + 600);
    fs.writeFileSync(procStat, "cpu  1 2 3 4\n");
    expect(reasons().lines).toEqual([]);
  });

  it("names a running kernel whose modules are gone", () => {
    fs.rmSync(path.join(modules, "5.15.185-tegra"), { recursive: true });
    const r = reasons();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("5.15.185-tegra");
  });

  it("passes on every reason a ClawBox step left in its marker, one per line", () => {
    fs.writeFileSync(marker, "first reason\n\nsecond reason");
    expect(reasons().lines).toEqual(["first reason", "second reason"]);
  });

  it("reports every signal at once", () => {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, "");
    fs.utimesSync(path.join(boot, "Image"), BOOT_SECS + 1, BOOT_SECS + 1);
    fs.writeFileSync(marker, "a step needs a boot\n");
    expect(reasons().lines).toHaveLength(3);
  });
});

// ── 2. Which end the step takes ─────────────────────────────────────────────

d("step_rebuild_reboot: reboots only for a reason, otherwise restarts", () => {
  /**
   * The step with every root-side step stubbed. `reasons` is what each call of
   * update_reboot_reasons answers, in order (the step asks before the rebuild
   * and, on the restart arm, once more after it).
   */
  function runStep(opts: { testMode: boolean; reasons: string[] }): { status: number | null; events: string[]; out: string } {
    const events = path.join(tmp, "events");
    const calls = path.join(tmp, "reason-calls");
    const answers = opts.reasons.map((a, i) => `${i}) printf '%s' ${JSON.stringify(a)} ;;`).join(" ");
    const log = (name: string) => `${name}() { echo "${name} $*" >> ${JSON.stringify(events)}; }`;
    const script = [
      "set -euo pipefail",
      ...["step_directories_permissions", "step_systemd_services", "step_ollama_install", "step_openclaw_patch",
        "step_openclaw_config", "step_clawkeep_install", "step_polkit_rules", "reboot", "do_rebuild",
        "restart_services_after_update"].map(log),
      `systemctl() { echo "systemctl $*" >> ${JSON.stringify(events)}; }`,
      `is_test_mode() { return ${opts.testMode ? 0 : 1}; }`,
      "served_build_commit() { printf '%s' 0123456789abcdef0123456789abcdef01234567; }",
      `update_reboot_reasons() {`,
      `  local n; n=$(cat ${JSON.stringify(calls)} 2>/dev/null || echo 0)`,
      `  echo $((n + 1)) > ${JSON.stringify(calls)}`,
      `  echo update_reboot_reasons >> ${JSON.stringify(events)}`,
      `  case "$n" in ${answers} *) ;; esac`,
      `}`,
      "arm_rebuild_checkout_guard() { :; }",
      "disarm_rebuild_checkout_guard() { :; }",
      fn("step_rebuild_reboot"),
      "step_rebuild_reboot",
    ].join("\n");
    const r = bash(script);
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf-8").split("\n").filter(Boolean) : [];
    return { status: r.status, events: lines, out: r.out };
  }

  const at = (events: string[], e: string) => events.findIndex((l) => l.startsWith(e));

  it("reboots, on the reboot-follows rebuild, when a reason is there before the build", () => {
    const r = runStep({ testMode: false, reasons: ["kernel changed"] });
    expect(r.status).toBe(0);
    expect(r.events).toContain("do_rebuild --reboot-follows");
    expect(at(r.events, "reboot")).toBeGreaterThan(at(r.events, "step_polkit_rules"));
    expect(at(r.events, "restart_services_after_update")).toBe(-1);
    expect(r.out).toContain("Rebooting: kernel changed");
  });

  it("restarts the services instead, with no reboot, when nothing needs a boot", () => {
    const r = runStep({ testMode: false, reasons: [] });
    expect(r.status).toBe(0);
    // The rebuild that gives back what it stopped: no flag.
    expect(r.events).toContain("do_rebuild ");
    expect(r.events).not.toContain("do_rebuild --reboot-follows");
    expect(r.events.some((e) => e.startsWith("reboot"))).toBe(false);
    const restart = at(r.events, "restart_services_after_update");
    expect(restart).toBeGreaterThan(at(r.events, "step_polkit_rules"));
    // The build the update replaced, so the hotspot is bounced only when its scripts changed.
    expect(r.events[restart]).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(r.out).toContain("Restarting ClawBox services — no reboot needed");
  });

  it("decides before the rebuild, after the redeploy that may leave a marker", () => {
    const r = runStep({ testMode: false, reasons: [] });
    const first = at(r.events, "update_reboot_reasons");
    expect(first).toBeGreaterThan(at(r.events, "step_clawkeep_install"));
    expect(first).toBeLessThan(at(r.events, "do_rebuild"));
  });

  it("still reboots when a reason appears while the rebuild runs", () => {
    // unattended-upgrades does not wait for an update: a kernel it installs
    // during the build is a reason the first look could not see.
    const r = runStep({ testMode: false, reasons: ["", "unattended kernel"] });
    expect(r.status).toBe(0);
    expect(r.events).toContain("do_rebuild ");
    expect(at(r.events, "reboot")).toBeGreaterThan(at(r.events, "do_rebuild"));
    expect(at(r.events, "restart_services_after_update")).toBe(-1);
    expect(r.out).toContain("Rebooting: unattended kernel");
  });

  it("leaves test mode exactly as it was: no decision, the setup restart, never a reboot", () => {
    const r = runStep({ testMode: true, reasons: ["would reboot"] });
    expect(r.status).toBe(0);
    expect(r.events).not.toContain("update_reboot_reasons");
    expect(r.events).toContain("do_rebuild ");
    expect(r.events.some((e) => e.startsWith("reboot"))).toBe(false);
    expect(at(r.events, "restart_services_after_update")).toBe(-1);
    expect(at(r.events, "systemctl restart clawbox-setup.service")).toBeGreaterThan(at(r.events, "step_polkit_rules"));
  });

  it("neither reboots nor restarts when the rebuild fails", () => {
    const events = path.join(tmp, "events");
    const script = [
      "set -euo pipefail",
      ...["step_directories_permissions", "step_systemd_services", "step_ollama_install", "step_openclaw_patch",
        "step_openclaw_config", "step_clawkeep_install", "step_polkit_rules", "reboot",
        "restart_services_after_update"].map((n) => `${n}() { echo "${n}" >> ${JSON.stringify(events)}; }`),
      "do_rebuild() { return 137; }",
      "is_test_mode() { return 1; }",
      "served_build_commit() { :; }",
      "update_reboot_reasons() { :; }",
      "arm_rebuild_checkout_guard() { :; }",
      "disarm_rebuild_checkout_guard() { :; }",
      fn("step_rebuild_reboot"),
      "step_rebuild_reboot",
    ].join("\n");
    const r = bash(script);
    expect(r.status).toBe(137);
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf-8") : "";
    expect(lines).not.toContain("reboot");
    expect(lines).not.toContain("restart_services_after_update");
  });
});

// ── 3. The restart arm ──────────────────────────────────────────────────────

d("restart_services_after_update: what the reboot used to restart", () => {
  interface Box {
    /** Active clawbox-* services as systemd lists them. */
    active: string[];
    /** Unit → systemd Type (default simple). */
    types?: Record<string, string>;
    /** Units whose restart does not take. */
    failing?: string[];
    /** ap_sources_changed's answer: 0 changed, 1 unchanged, 2 unknown. */
    apChanged?: 0 | 1 | 2;
    hermes?: boolean;
    hermesOut?: string;
  }

  function run(box: Box): { status: number | null; events: string[]; out: string; relay: string } {
    const events = path.join(tmp, "events");
    const state = path.join(tmp, "state");
    const relay = path.join(tmp, "run", "clawbox", "update-restart-warnings");
    fs.mkdirSync(state, { recursive: true });
    for (const u of box.active) fs.writeFileSync(path.join(state, `${u}.inv`), "inv-boot");
    const types = Object.entries(box.types ?? {}).map(([u, t]) => `${u}) echo ${t} ;;`).join(" ");
    const failing = (box.failing ?? []).join(" ");
    const script = [
      "set -euo pipefail",
      "ENGINE_SETTLE_S=0",
      `EV=${JSON.stringify(events)}; ST=${JSON.stringify(state)}`,
      "systemctl() {",
      "  echo \"systemctl $*\" >> \"$EV\"",
      "  case \"$1\" in",
      box.active.length
        ? `    list-units) printf '%s loaded active running ClawBox\\n' ${box.active.map((u) => JSON.stringify(u)).join(" ")} ;;`
        : "    list-units) ;;",
      "    show)",
      "      case \"$4\" in",
      `        Type) case \"$2\" in ${types} *) echo simple ;; esac ;;`,
      "        InvocationID) cat \"$ST/$2.inv\" 2>/dev/null || true ;;",
      "      esac ;;",
      "    is-active) shift; [ \"$1\" = --quiet ] && shift; [ -f \"$ST/$1.inv\" ] && [ ! -f \"$ST/$1.dead\" ] ;;",
      "    restart)",
      "      shift; local u rc=0",
      "      for u in \"$@\"; do",
      `        case " ${failing} " in *" $u "*) touch "$ST/$u.dead"; rc=1 ;; *) echo "inv-$RANDOM$RANDOM" > "$ST/$u.inv" ;; esac`,
      "      done; return $rc ;;",
      "    *) return 0 ;;",
      "  esac",
      "}",
      `ap_sources_changed() { echo "ap_sources_changed $*" >> "$EV"; return ${box.apChanged ?? 1}; }`,
      `has_hermes_harness() { return ${box.hermes ? 0 : 1}; }`,
      `hermes_gateway_refresh_after_install() { echo "hermes_gateway_refresh_after_install $*" >> "$EV"; printf '%s' ${JSON.stringify(box.hermesOut ?? "")}; }`,
      fn("restart_services_after_update"),
      "restart_services_after_update 0123456789abcdef0123456789abcdef01234567",
    ].join("\n");
    const r = bash(script, { CLAWBOX_UPDATE_RESTART_RELAY: relay });
    const lines = fs.existsSync(events) ? fs.readFileSync(events, "utf-8").split("\n").filter(Boolean) : [];
    return { status: r.status, events: lines, out: r.out, relay: fs.existsSync(relay) ? fs.readFileSync(relay, "utf-8") : "" };
  }

  // What `systemctl list-units 'clawbox-*'` showed on the OpenClaw box mid-update.
  const BOX = [
    "clawbox-ap.service",
    "clawbox-browser.service",
    "clawbox-gateway.service",
    "clawbox-nvme-boot-order.service",
    "clawbox-performance.service",
    "clawbox-root-update@rebuild_reboot.service",
    "clawbox-vnc.service",
    "clawbox-websockify.service",
  ];
  const TYPES = {
    "clawbox-ap.service": "oneshot",
    "clawbox-nvme-boot-order.service": "oneshot",
    "clawbox-performance.service": "oneshot",
    "clawbox-root-update@rebuild_reboot.service": "oneshot",
  };

  const restartCalls = (events: string[]) => events.filter((e) => e.startsWith("systemctl restart "));

  it("restarts every running service in ONE call, and clawbox-setup last", () => {
    const r = run({ active: BOX, types: TYPES });
    expect(r.status).toBe(0);
    const calls = restartCalls(r.events);
    expect(calls).toHaveLength(2);
    // One transaction: clawbox-browser Requires= clawbox-vnc, so separate
    // restarts would bounce the browser twice.
    const units = calls[0].replace("systemctl restart ", "").split(" ").sort();
    expect(units).toEqual([
      "clawbox-browser.service",
      "clawbox-performance.service",
      "clawbox-vnc.service",
      "clawbox-websockify.service",
    ]);
    expect(calls[1]).toBe("systemctl restart clawbox-setup.service");
    const reset = r.events.indexOf("systemctl reset-failed clawbox-setup.service");
    expect(reset).toBeGreaterThan(r.events.indexOf(calls[0]));
    expect(reset).toBeLessThan(r.events.indexOf(calls[1]));
    expect(r.events.indexOf("systemctl daemon-reload")).toBeLessThan(r.events.indexOf(calls[0]));
    expect(r.out).toContain("[ok] clawbox-vnc.service");
    expect(r.relay).toBe("");
  });

  it("never restarts the gateway (post_update and gateway_verify do), its own root step, or a boot-time one-shot", () => {
    const r = run({ active: BOX, types: TYPES });
    const restarted = restartCalls(r.events).join(" ");
    expect(restarted).not.toContain("clawbox-gateway.service");
    expect(restarted).not.toContain("clawbox-root-update@");
    expect(restarted).not.toContain("clawbox-nvme-boot-order.service");
    expect(r.out).toContain("clawbox-gateway.service");
  });

  it("bounces the hotspot only when its unit or scripts changed", () => {
    expect(restartCalls(run({ active: BOX, types: TYPES, apChanged: 1 }).events)[0]).not.toContain("clawbox-ap.service");
    fs.rmSync(path.join(tmp, "events"), { force: true });
    expect(restartCalls(run({ active: BOX, types: TYPES, apChanged: 2 }).events)[0]).not.toContain("clawbox-ap.service");
    fs.rmSync(path.join(tmp, "events"), { force: true });
    const changed = run({ active: BOX, types: TYPES, apChanged: 0 });
    expect(restartCalls(changed.events)[0]).toContain("clawbox-ap.service");
    expect(changed.events).toContain("ap_sources_changed 0123456789abcdef0123456789abcdef01234567");
  });

  it("warns, and keeps the warning for post_update, when a service does not come back", () => {
    const r = run({ active: BOX, types: TYPES, failing: ["clawbox-vnc.service"] });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[service-not-restarted\]: clawbox-vnc\.service/m);
    expect(r.relay).toMatch(/^CLAWBOX-WARN\[service-not-restarted\]: clawbox-vnc\.service/m);
    // The dashboard comes back whatever happened to the rest.
    expect(restartCalls(r.events).at(-1)).toBe("systemctl restart clawbox-setup.service");
  });

  it("restarts the Hermes gateway through Hermes, before clawbox-setup, and keeps its warning", () => {
    const warn = "CLAWBOX-WARN[hermes-gateway-not-restarted]: hermes-gateway.service did not stay up";
    const r = run({ active: ["clawbox-hermes-dashboard.service"], hermes: true, hermesOut: `${warn}\n` });
    const hermes = r.events.indexOf("hermes_gateway_refresh_after_install 1");
    expect(hermes).toBeGreaterThan(-1);
    expect(hermes).toBeLessThan(r.events.indexOf("systemctl restart clawbox-setup.service"));
    expect(r.relay).toContain(warn);
  });

  it("leaves the Hermes gateway alone on an edition without it", () => {
    const r = run({ active: BOX, types: TYPES, hermes: false });
    expect(r.events.some((e) => e.startsWith("hermes_gateway_refresh_after_install"))).toBe(false);
  });

  it("still restarts clawbox-setup when nothing else is running", () => {
    const r = run({ active: [] });
    expect(r.status).toBe(0);
    expect(restartCalls(r.events)).toEqual(["systemctl restart clawbox-setup.service"]);
  });
});

// ── 4. The hotspot's sources, by git ────────────────────────────────────────

d("ap_sources_changed: did this update change what clawbox-ap runs", () => {
  let proj: string;
  function git(...args: string[]): string {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: proj,
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  function changed(from: string): number | null {
    return bash([
      `PROJECT_DIR=${JSON.stringify(proj)}`,
      "as_clawbox() { \"$@\"; }",
      fn("ap_sources_changed"),
      `ap_sources_changed ${JSON.stringify(from)}`,
    ].join("\n"), { GIT_CONFIG_NOSYSTEM: "1" }).status;
  }

  beforeEach(() => {
    proj = path.join(tmp, "proj");
    fs.mkdirSync(path.join(proj, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(proj, "config"), { recursive: true });
    git("init", "-q");
    fs.writeFileSync(path.join(proj, "scripts", "start-ap.sh"), "echo start\n");
    fs.writeFileSync(path.join(proj, "README.md"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
  });

  it("answers unchanged (1) for an update that touched other files", () => {
    const from = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(proj, "README.md"), "two\n");
    git("commit", "-qam", "two");
    expect(changed(from)).toBe(1);
  });

  it("answers changed (0) for an update that touched the hotspot's script", () => {
    const from = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(proj, "scripts", "start-ap.sh"), "echo start v2\n");
    git("commit", "-qam", "ap");
    expect(changed(from)).toBe(0);
  });

  it("answers unknown (2) with no stamp, or a commit git does not have", () => {
    expect(changed("")).toBe(2);
    expect(changed("not-a-sha")).toBe(2);
    expect(changed("0123456789abcdef0123456789abcdef01234567")).toBe(2);
  });
});

// ── 5. A warning the restart arm kept reaches the owner through post_update ──

d("relay_update_restart_warnings: post_update re-states the restart arm's warnings", () => {
  it("prints every kept warning once and clears the file", () => {
    const relay = path.join(tmp, "relay");
    fs.writeFileSync(relay, "CLAWBOX-WARN[service-not-restarted]: clawbox-vnc.service did not come back\nnot a marker\n");
    const script = ["set -euo pipefail", fn("relay_update_restart_warnings"), "relay_update_restart_warnings"].join("\n");
    const r = bash(script, { CLAWBOX_UPDATE_RESTART_RELAY: relay });
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe("CLAWBOX-WARN[service-not-restarted]: clawbox-vnc.service did not come back");
    expect(fs.existsSync(relay)).toBe(false);
    expect(bash(script, { CLAWBOX_UPDATE_RESTART_RELAY: relay }).out).toBe("");
  });

  it("is called by step_post_update, whose warnings the updater collects", () => {
    expect(fn("step_post_update")).toContain("relay_update_restart_warnings");
  });
});
