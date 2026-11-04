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
  const BOOT_FILES = ["Image", "initrd", "extlinux/extlinux.conf", "dtb/kernel_tegra234-p3768.dtb"];
  // The files' ctime is the moment the test writes them, and cannot be set:
  // the boot is placed after it (nothing new) or before it (all new).
  const NOW = Math.floor(Date.now() / 1000);
  let boot: string;
  let modules: string;
  let procStat: string;
  let flag: string;
  let marker: string;

  const bootedAt = (secs: number) => fs.writeFileSync(procStat, `cpu  1 2 3 4\nbtime ${secs}\nprocesses 42\n`);

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
    // dpkg gives an unpacked file the archive's mtime, the package's build
    // date: old, whenever it was installed.
    for (const f of BOOT_FILES) {
      const p = path.join(boot, f);
      fs.writeFileSync(p, "x");
      fs.utimesSync(p, NOW - 86_400 * 90, NOW - 86_400 * 90);
    }
    // Every kernel/boot file installed before this boot: nothing to report.
    bootedAt(NOW + 3600);
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

  it.each(BOOT_FILES)(
    "names /boot/%s when it was installed since this boot, by ctime, whatever its mtime",
    (file) => {
      for (const other of BOOT_FILES.filter((f) => f !== file)) fs.rmSync(path.join(boot, other));
      bootedAt(NOW - 3600);
      const r = reasons();
      expect(r.status).toBe(0);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toContain(file);
    },
  );

  it("never calls a boot file new when the boot time cannot be read", () => {
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
    bootedAt(NOW - 3600);
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
    /** Running clawbox-* services, as `list-units --state=active` lists them. */
    active: string[];
    /** Enabled clawbox-* services, as `list-unit-files --state=enabled` lists them. */
    enabled?: string[];
    /** Unit → systemd Type (default simple). */
    types?: Record<string, string>;
    /** Units whose restart or start does not take. */
    failing?: string[];
    /** ap_sources_changed's answer: 0 changed, 1 unchanged, 2 unknown. */
    apChanged?: 0 | 1 | 2;
    hermes?: boolean;
    hermesOut?: string;
    /** A relay file an earlier run left behind. */
    staleRelay?: string;
    /** The engines do_rebuild's resume_paused_engines could not bring back. */
    engines?: string[];
    /** Units that come up, then die before the settle look (a Type=simple fork). */
    flaky?: string[];
    /** Units whose restart takes one look longer to show. */
    slow?: string[];
    /** CLAWBOX_RESTART_WAIT_S: how many one-second looks. */
    looks?: number;
    /** Units whose restart never takes: still active on the old invocation. */
    stuck?: string[];
    /** ENGINE_SETTLE_S (the fake default is 0). */
    settle?: number;
    /** Units that are active on a NEW invocation at every look: a crash loop. */
    bouncy?: string[];
    /** Units still "activating" for their first two looks after the restart. */
    late?: string[];
    /** Unit → how many of its first InvocationID reads answer nothing. */
    noInvocation?: Record<string, number>;
    /** Unit → how many of its first is-active queries answer nothing. */
    noState?: Record<string, number>;
  }

  function run(box: Box): { status: number | null; events: string[]; out: string; relay: string } {
    const events = path.join(tmp, "events");
    const state = path.join(tmp, "state");
    const relay = path.join(tmp, "run", "clawbox", "update-restart-warnings");
    fs.rmSync(events, { force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(relay, { force: true });
    fs.mkdirSync(state, { recursive: true });
    if (box.staleRelay) {
      fs.mkdirSync(path.dirname(relay), { recursive: true });
      fs.writeFileSync(relay, box.staleRelay);
    }
    // A running unit has an invocation; one that is not running has none yet.
    for (const u of box.active) fs.writeFileSync(path.join(state, `${u}.inv`), "inv-boot");
    for (const [u, k] of Object.entries(box.noInvocation ?? {})) fs.writeFileSync(path.join(state, `${u}.noinv`), String(k));
    for (const [u, k] of Object.entries(box.noState ?? {})) fs.writeFileSync(path.join(state, `${u}.nostate`), String(k));
    const types = Object.entries(box.types ?? {}).map(([u, t]) => `${u}) echo ${t} ;;`).join(" ");
    const failing = (box.failing ?? []).join(" ");
    const flaky = (box.flaky ?? []).join(" ");
    const slow = (box.slow ?? []).join(" ");
    const stuck = (box.stuck ?? []).join(" ");
    const bouncy = (box.bouncy ?? []).join(" ");
    const late = (box.late ?? []).join(" ");
    const apMarker = path.join(tmp, "run", "clawbox", "update-ap-restart");
    fs.rmSync(apMarker, { force: true });
    const lines = (units: string[], rest: string) =>
      units.length ? `printf '%s ${rest}\\n' ${units.map((u) => JSON.stringify(u)).join(" ")}` : ":";
    const script = [
      "set -euo pipefail",
      `ENGINE_SETTLE_S=${box.settle ?? 0}`,
      `EV=${JSON.stringify(events)}; ST=${JSON.stringify(state)}`,
      "sleep() { echo \"sleep $*\" >> \"$EV\"; }",
      // A late unit answers "activating" for its first N looks after its restart.
      // A unit whose state query fails answers nothing for its first N looks.
      "unit_state() { local n; if [ -f \"$ST/$1.nostate\" ]; then n=$(cat \"$ST/$1.nostate\"); if [ \"$n\" -gt 0 ]; then echo $((n - 1)) > \"$ST/$1.nostate\"; echo; return; fi; fi; if [ -f \"$ST/$1.late\" ]; then n=$(cat \"$ST/$1.late\"); if [ \"$n\" -gt 0 ]; then echo $((n - 1)) > \"$ST/$1.late\"; echo activating; return; fi; fi; if [ -f \"$ST/$1.dead\" ]; then echo failed; elif [ -f \"$ST/$1.inv\" ]; then echo active; else echo inactive; fi; }",
      "systemctl() {",
      "  echo \"systemctl $*\" >> \"$EV\"",
      "  case \"$1\" in",
      `    list-units) ${lines(box.active, "loaded active running ClawBox")} ;;`,
      `    list-unit-files) ${lines(box.enabled ?? [], "enabled enabled")} ;;`,
      "    show)",
      "      case \"$4\" in",
      `        Type) case \"$2\" in ${types} *) echo simple ;; esac ;;`,
      "        InvocationID)",
      "          if [ -f \"$ST/$2.noinv\" ] && [ \"$(cat \"$ST/$2.noinv\")\" -gt 0 ]; then echo $(( $(cat \"$ST/$2.noinv\") - 1 )) > \"$ST/$2.noinv\"; return 0; fi",
      // A slow unit shows its old invocation once more; a flaky one dies on
      // its second look, as a unit that forked and then exited would.
      "          if [ -f \"$ST/$2.wait\" ]; then rm -f \"$ST/$2.wait\";",
      "          elif [ -f \"$ST/$2.next\" ]; then mv \"$ST/$2.next\" \"$ST/$2.inv\"; fi",
      `          case " ${bouncy} " in *" $2 "*) [ -f "$ST/$2.restarted" ] && echo "inv-$RANDOM$RANDOM" > "$ST/$2.inv" ;; esac`,
      "          if [ -f \"$ST/$2.flaky\" ]; then echo x >> \"$ST/$2.flaky\"; [ \"$(wc -l < \"$ST/$2.flaky\")\" -ge 2 ] && touch \"$ST/$2.dead\"; fi",
      "          cat \"$ST/$2.inv\" 2>/dev/null || true ;;",
      "      esac ;;",
      "    is-active)",
      "      if [ \"$2\" = --quiet ]; then [ \"$(unit_state \"$3\")\" = active ]; return; fi",
      "      local st; st=$(unit_state \"$2\"); echo \"$st\"; [ \"$st\" = active ] ;;",
      "    restart|start)",
      "      shift; local u rc=0",
      "      for u in \"$@\"; do",
      "        case \"$u\" in -*) continue ;; esac",
      // A start that fails is still a new invocation, as in systemd.
      `        case " ${failing} " in *" $u "*) echo "inv-$RANDOM$RANDOM" > "$ST/$u.inv"; touch "$ST/$u.dead"; rc=1; continue ;; esac`,
      `        case " ${stuck} " in *" $u "*) continue ;; esac`,
      `        case " ${slow} " in *" $u "*) echo "inv-$RANDOM$RANDOM" > "$ST/$u.next"; touch "$ST/$u.wait"; continue ;; esac`,
      "        echo \"inv-$RANDOM$RANDOM\" > \"$ST/$u.inv\"",
      `        case " ${flaky} " in *" $u "*) : > "$ST/$u.flaky" ;; esac`,
      "        touch \"$ST/$u.restarted\"",
      `        case " ${late} " in *" $u "*) echo 2 > "$ST/$u.late" ;; esac`,
      "      done; return $rc ;;",
      "    *) return 0 ;;",
      "  esac",
      "}",
      `ap_sources_changed() { echo "ap_sources_changed $*" >> "$EV"; return ${box.apChanged ?? 1}; }`,
      `has_hermes_harness() { return ${box.hermes ? 0 : 1}; }`,
      `hermes_gateway_refresh_after_install() { echo "hermes_gateway_refresh_after_install $*" >> "$EV"; printf '%s' ${JSON.stringify(box.hermesOut ?? "")}; }`,
      `ENGINE_NOT_RESUMED=(${(box.engines ?? []).map((w) => JSON.stringify(w)).join(" ")})`,
      fn("restart_services_after_update"),
      "restart_services_after_update 0123456789abcdef0123456789abcdef01234567",
    ].join("\n");
    const r = bash(script, {
      CLAWBOX_UPDATE_RESTART_RELAY: relay,
      CLAWBOX_UPDATE_AP_RESTART: apMarker,
      CLAWBOX_RESTART_WAIT_S: String(box.looks ?? 0),
    });
    const ev = fs.existsSync(events) ? fs.readFileSync(events, "utf-8").split("\n").filter(Boolean) : [];
    return { status: r.status, events: ev, out: r.out, relay: fs.existsSync(relay) ? fs.readFileSync(relay, "utf-8") : "" };
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
    "clawbox-build-heal.service": "oneshot",
    "clawbox-firstboot-vnc.service": "oneshot",
    "clawbox-nvme-boot-order.service": "oneshot",
    "clawbox-performance.service": "oneshot",
    "clawbox-root-update@rebuild_reboot.service": "oneshot",
  };

  const calls = (events: string[], verb: string) => events.filter((e) => e.startsWith(`systemctl ${verb} `));
  const unitsOf = (call: string) => call.split(" ").slice(2).filter((w) => !w.startsWith("-")).sort();

  it("restarts every running service in ONE call without blocking, and clawbox-setup last", () => {
    const r = run({ active: BOX, types: TYPES });
    expect(r.status).toBe(0);
    const restarts = calls(r.events, "restart");
    expect(restarts).toHaveLength(2);
    // Queued, never waited on: a start that hangs must not keep the dashboard down.
    expect(restarts[0]).toContain("--no-block");
    // One call: clawbox-browser Requires= clawbox-vnc, so separate restarts
    // would bounce the browser twice.
    expect(unitsOf(restarts[0])).toEqual([
      "clawbox-browser.service",
      "clawbox-performance.service",
      "clawbox-vnc.service",
      "clawbox-websockify.service",
    ]);
    expect(restarts[1]).toBe("systemctl restart clawbox-setup.service");
    const reset = r.events.indexOf("systemctl reset-failed clawbox-setup.service");
    expect(reset).toBeGreaterThan(r.events.indexOf(restarts[0]));
    expect(reset).toBeLessThan(r.events.indexOf(restarts[1]));
    expect(r.events.indexOf("systemctl daemon-reload")).toBeLessThan(r.events.indexOf(restarts[0]));
    expect(r.out).toContain("[ok] clawbox-vnc.service");
    expect(r.relay).toBe("");
  });

  it("never restarts the gateway (post_update and gateway_verify do), its own root step, or a boot-time one-shot", () => {
    const r = run({ active: BOX, types: TYPES });
    const touched = [...calls(r.events, "restart"), ...calls(r.events, "start")].join(" ");
    expect(touched).not.toContain("clawbox-gateway.service");
    expect(touched).not.toContain("clawbox-root-update@");
    expect(touched).not.toContain("clawbox-nvme-boot-order.service");
    expect(r.out).toContain("clawbox-gateway.service");
  });

  it("starts what is enabled and not running, as the boot did — but no boot-time one-shot, gateway or hotspot", () => {
    const r = run({
      active: BOX,
      types: TYPES,
      enabled: [
        "clawbox-ap.service",
        "clawbox-build-heal.service",
        "clawbox-firstboot-vnc.service",
        "clawbox-gateway.service",
        "clawbox-nvme-boot-order.service",
        "clawbox-setup.service",
        "clawbox-tunnel.service",
        "clawbox-vnc.service",
      ],
    });
    expect(r.status).toBe(0);
    const starts = calls(r.events, "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("--no-block");
    expect(unitsOf(starts[0])).toEqual(["clawbox-tunnel.service"]);
    // Listed twice (running and enabled), restarted once.
    expect(unitsOf(calls(r.events, "restart")[0]).filter((u) => u === "clawbox-vnc.service")).toHaveLength(1);
    expect(r.out).toContain("[ok] clawbox-tunnel.service");
  });

  it("bounces the hotspot only when it is up and its unit or scripts changed, and only after the dashboard", () => {
    expect(calls(run({ active: BOX, types: TYPES, apChanged: 1 }).events, "restart").join(" ")).not.toContain("clawbox-ap.service");
    expect(calls(run({ active: BOX, types: TYPES, apChanged: 2 }).events, "restart").join(" ")).not.toContain("clawbox-ap.service");
    const changed = run({ active: BOX, types: TYPES, apChanged: 0 });
    const restarts = calls(changed.events, "restart");
    expect(changed.events).toContain("ap_sources_changed 0123456789abcdef0123456789abcdef01234567");
    // clawbox-setup is After= clawbox-ap: a hotspot restart queued first would
    // hold the dashboard for the whole of start-ap.sh.
    expect(restarts[0]).not.toContain("clawbox-ap.service");
    expect(restarts.at(-2)).toBe("systemctl restart clawbox-setup.service");
    expect(restarts.at(-1)).toBe("systemctl restart --no-block clawbox-ap.service");
    // A hotspot that is down is its watchdog's to bring up, changed or not.
    const down = run({ active: BOX.filter((u) => u !== "clawbox-ap.service"), enabled: ["clawbox-ap.service"], types: TYPES, apChanged: 0 });
    expect([...calls(down.events, "restart"), ...calls(down.events, "start")].join(" ")).not.toContain("clawbox-ap.service");
  });

  it("names EVERY unit that did not come back, on one warning kept for post_update", () => {
    // The updater keeps one card per code, so two lines would show one unit.
    const r = run({
      active: [...BOX, "clawbox-tunnel.service"],
      types: TYPES,
      failing: ["clawbox-vnc.service", "clawbox-tunnel.service"],
    });
    expect(r.status).toBe(0);
    const warns = r.out.split("\n").filter((l) => l.startsWith("CLAWBOX-WARN[service-not-restarted]"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("vnc (failed)");
    expect(warns[0]).toContain("tunnel (failed)");
    expect(warns[0]).not.toContain("browser (");
    expect(r.relay.trim()).toBe(warns[0]);
    // The dashboard comes back whatever happened to the rest.
    expect(calls(r.events, "restart").at(-1)).toBe("systemctl restart clawbox-setup.service");
  });

  it("keeps the rebuild's engines for post_update too, on ONE line under a code post_update's own does not mask", () => {
    const r = run({ active: BOX, types: TYPES, engines: ["ollama.service", "kokoro-server.service"] });
    const lines = r.relay.split("\n").filter((l) => l.startsWith("CLAWBOX-WARN[engine-not-resumed:rebuild]: "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ollama.service, kokoro-server.service");
    expect(r.relay).not.toMatch(/^CLAWBOX-WARN\[engine-not-resumed\]:/m);
  });

  it("never calls a unit back that came up and died before the settle look (false success)", () => {
    // systemd calls a Type=simple unit active the moment it forks.
    const r = run({ active: BOX, types: TYPES, flaky: ["clawbox-vnc.service"] });
    expect(r.out).not.toContain("[ok] clawbox-vnc.service");
    expect(r.relay).toMatch(/^CLAWBOX-WARN\[service-not-restarted\]: .*: vnc \(failed\)/m);
  });

  it("waits, within its bound, for a unit that comes up on a later look (no false failure)", () => {
    const r = run({ active: BOX, types: TYPES, slow: ["clawbox-websockify.service"], looks: 2 });
    expect(r.out).toContain("[ok] clawbox-websockify.service");
    expect(r.relay).toBe("");
  });

  it("settle-checks every unit on a stop because the rest have failed, not only when all pass", () => {
    // RED on c778d5d: the settle ran only on the all-pass exit, so a unit that
    // forked and died beside one that failed outright was reported [ok].
    const r = run({
      active: [...BOX, "clawbox-tunnel.service"],
      types: TYPES,
      failing: ["clawbox-tunnel.service"],
      flaky: ["clawbox-websockify.service"],
      looks: 30,
    });
    expect(r.out).not.toContain("[ok] clawbox-websockify.service");
    expect(r.relay).toContain("websockify (failed)");
    expect(r.relay).toContain("tunnel (failed)");
  });

  it("settle-checks every unit when the bound runs out, and names a restart that never took", () => {
    // RED on c778d5d: the same, at the bound.
    const r = run({
      active: BOX,
      types: TYPES,
      stuck: ["clawbox-performance.service"],
      flaky: ["clawbox-websockify.service"],
      looks: 0,
    });
    expect(r.out).not.toContain("[ok] clawbox-websockify.service");
    expect(r.relay).toContain("websockify (failed)");
    // Active on its boot-time invocation is not "running again".
    expect(r.relay).toContain("performance (old process)");
    expect(r.relay).not.toContain("(active)");
  });

  it("counts the settle in the wait it states", () => {
    const r = run({ active: BOX, types: TYPES, stuck: ["clawbox-vnc.service"], looks: 0, settle: 1 });
    expect(r.relay).toContain("not back 1 s after");
    expect(r.events).toContain("sleep 1");
  });

  it("keeps a six-unit warning under the updater's 300-character cap", () => {
    const six = ["clawbox-vnc.service", "clawbox-browser.service", "clawbox-websockify.service", "clawbox-tunnel.service",
      "clawbox-hermes-dashboard.service", "clawbox-hermes-dashboard-proxy.service"];
    const r = run({ active: six, failing: six, looks: 0 });
    const line = r.relay.split("\n").find((l) => l.startsWith("CLAWBOX-WARN[service-not-restarted]: ")) ?? "";
    const message = line.replace("CLAWBOX-WARN[service-not-restarted]: ", "");
    expect(message.length).toBeLessThanOrEqual(300);
    // The count first: a card the cap cuts still says how many.
    expect(message).toContain("6 clawbox-* services not back");
    for (const u of six) expect(message).toContain(`${u.replace(/^clawbox-/, "").replace(/\.service$/, "")} (failed)`);
  });

  it("never counts a restart back when the unit's invocation could not be read", () => {
    const r = run({ active: BOX, types: TYPES, stuck: ["clawbox-vnc.service"], noInvocation: { "clawbox-vnc.service": 2 }, looks: 0 });
    expect(r.out).not.toContain("[ok] clawbox-vnc.service");
    // Its own clause, not counted among the units that are down.
    expect(r.relay).toContain("Not checked (systemd did not answer): vnc.");
    expect(r.relay).not.toMatch(/\d+ clawbox-\* services not back/);
  });

  it("asks once more when the first read of an invocation comes back empty", () => {
    // RED on 84cafe0: an empty pre-restart invocation differed from any later one, so the stuck unit was [ok].
    const r = run({ active: BOX, types: TYPES, stuck: ["clawbox-vnc.service"], noInvocation: { "clawbox-vnc.service": 1 }, looks: 0 });
    expect(r.relay).toContain("vnc (old process)");
  });

  it("never sends a running unit to `start` because its state query failed", () => {
    // RED on b4ddb2a: an empty is-active read as "not running", and `start`
    // on a running unit kept its old process under an [ok].
    const r = run({
      active: BOX,
      types: TYPES,
      stuck: ["clawbox-vnc.service"],
      noState: { "clawbox-vnc.service": 2 },
      noInvocation: { "clawbox-vnc.service": 1 },
      looks: 0,
    });
    expect(r.out).not.toContain("[ok] clawbox-vnc.service");
    expect(r.relay).toContain("Not checked (systemd did not answer): vnc.");
    expect(calls(r.events, "start").join(" ")).not.toContain("clawbox-vnc.service");
  });

  it("asks once more when the first state query comes back empty", () => {
    const r = run({ active: BOX, types: TYPES, stuck: ["clawbox-vnc.service"], noState: { "clawbox-vnc.service": 1 }, looks: 0 });
    expect(calls(r.events, "restart")[0]).toContain("clawbox-vnc.service");
    expect(r.relay).toContain("vnc (old process)");
  });

  it("calls a unit that came up only after the wait late, never crashed", () => {
    // RED on 84cafe0: it was labelled "crashed and restarted".
    const r = run({ active: BOX, types: TYPES, late: ["clawbox-browser.service"], looks: 0 });
    expect(r.relay).toContain("browser (up late)");
    expect(r.relay).not.toContain("crashed");
  });

  it("names a unit that died and came back during the settle as such, never as plain active", () => {
    const r = run({ active: BOX, types: TYPES, bouncy: ["clawbox-vnc.service"], looks: 0 });
    expect(r.out).not.toContain("[ok] clawbox-vnc.service");
    expect(r.relay).toContain("vnc (crashed and restarted)");
    expect(r.relay).not.toContain("(active)");
  });

  it("leaves the hotspot restart a marker post_update proves it by", () => {
    const r = run({ active: BOX, types: TYPES, apChanged: 0 });
    const marker = fs.readFileSync(path.join(tmp, "run", "clawbox", "update-ap-restart"), "utf-8");
    expect(marker.trim()).toBe("inv-boot");
    expect(r.events.indexOf("systemctl restart --no-block clawbox-ap.service"))
      .toBeGreaterThan(r.events.indexOf("systemctl restart clawbox-setup.service"));
  });

  it("stops waiting once every unit still down has failed again", () => {
    const r = run({ active: BOX, types: TYPES, failing: ["clawbox-vnc.service"], looks: 30 });
    expect(r.relay).toContain("not back 0 s after");
  });

  it("drops the warnings an earlier run left behind, so post_update states only this run's", () => {
    const stale = "CLAWBOX-WARN[service-not-restarted]: clawbox-tunnel.service did not come back\n";
    expect(run({ active: BOX, types: TYPES, staleRelay: stale }).relay).toBe("");
    const r = run({ active: BOX, types: TYPES, staleRelay: stale, failing: ["clawbox-vnc.service"] });
    expect(r.relay).not.toContain("tunnel (");
    expect(r.relay).toContain("vnc (failed)");
  });

  it("never writes the kept warnings through a symlink", () => {
    // The function removes the relay first; a link that appears after that is
    // refused rather than followed. Modelled by a `rm` that leaves it in place.
    const target = path.join(tmp, "elsewhere");
    fs.writeFileSync(target, "");
    const relayDir = path.join(tmp, "run", "clawbox");
    fs.mkdirSync(relayDir, { recursive: true });
    const relay = path.join(relayDir, "update-restart-warnings");
    fs.rmSync(relay, { force: true });
    fs.symlinkSync(target, relay);
    const script = [
      "set -euo pipefail",
      "ENGINE_SETTLE_S=0",
      "rm() { :; }",
      "sleep() { :; }",
      "systemctl() { case \"$1\" in is-active) [ \"$2\" = --quiet ] || echo failed; return 1 ;; list-units) echo clawbox-vnc.service loaded active running x ;; show) echo inv ;; esac; return 0; }",
      "ap_sources_changed() { return 1; }",
      "has_hermes_harness() { return 1; }",
      fn("restart_services_after_update"),
      "restart_services_after_update ''",
    ].join("\n");
    const r = bash(script, { CLAWBOX_UPDATE_RESTART_RELAY: relay, CLAWBOX_RESTART_WAIT_S: "0" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("CLAWBOX-WARN[service-not-restarted]");
    expect(fs.readFileSync(target, "utf-8")).toBe("");
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
    expect(calls(r.events, "restart")).toEqual(["systemctl restart clawbox-setup.service"]);
    expect(calls(r.events, "start")).toEqual([]);
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

// ── 5. The late hotspot restart, proved by post_update ─────────────────────

d("report_update_ap_restart: post_update proves the hotspot restart the update queued", () => {
  function report(states: string[], inv: string, marker = "inv-boot", newline = true): { out: string; events: string[]; markerLeft: boolean } {
    const m = path.join(tmp, "update-ap-restart");
    const events = path.join(tmp, "events");
    const seq = path.join(tmp, "seq");
    fs.rmSync(events, { force: true });
    if (marker) fs.writeFileSync(m, newline ? `${marker}\n` : marker); else fs.rmSync(m, { force: true });
    fs.writeFileSync(seq, states.join("\n") + "\n");
    const script = [
      "set -euo pipefail",
      `EV=${JSON.stringify(events)}; SEQ=${JSON.stringify(seq)}`,
      "sleep() { echo \"sleep $*\" >> \"$EV\"; }",
      // Each is-active answers the next state; the last one sticks.
      "next_state() { local s; s=$(head -n 1 \"$SEQ\"); if [ \"$(wc -l < \"$SEQ\")\" -gt 1 ]; then sed -i 1d \"$SEQ\"; fi; echo \"$s\"; }",
      "systemctl() {",
      "  echo \"systemctl $*\" >> \"$EV\"",
      "  case \"$1\" in",
      `    show) echo ${JSON.stringify(inv)} ;;`,
      "    is-active) local s; s=$(next_state); [ \"$2\" = --quiet ] || echo \"$s\"; [ \"$s\" = active ] ;;",
      "  esac",
      "}",
      fn("report_update_ap_restart"),
      "report_update_ap_restart",
    ].join("\n");
    const r = bash(script, { CLAWBOX_UPDATE_AP_RESTART: m, CLAWBOX_AP_RESTART_WAIT_S: "5" });
    expect(r.status).toBe(0);
    const ev = fs.existsSync(events) ? fs.readFileSync(events, "utf-8").split("\n").filter(Boolean) : [];
    return { out: r.out, events: ev, markerLeft: fs.existsSync(m) };
  }

  it("says nothing, and asks nothing, when the update restarted no hotspot", () => {
    const r = report(["active"], "inv-new", "");
    expect(r.out).toBe("");
    expect(r.events).toEqual([]);
  });

  it("confirms a hotspot back on a new invocation, and clears the marker", () => {
    const r = report(["activating", "activating", "active"], "inv-new");
    expect(r.out).not.toContain("CLAWBOX-WARN");
    expect(r.out).toContain("clawbox-ap.service");
    expect(r.markerLeft).toBe(false);
  });

  it("warns when the restarted hotspot failed — nothing retries it after setup", () => {
    const r = report(["failed"], "inv-new");
    expect(r.out).toMatch(/^CLAWBOX-WARN\[ap-not-restarted\]: .*failed/m);
    expect(r.markerLeft).toBe(false);
  });

  it("says a hotspot still starting at the end of its wait is still starting, not down", () => {
    const r = report(["activating"], "inv-new");
    expect(r.out).toMatch(/^CLAWBOX-WARN\[ap-not-restarted\]: .*still activating/m);
    expect(r.out).not.toContain("nothing retries it");
  });

  it("says a hotspot caught stopping is stopping, not starting", () => {
    const r = report(["deactivating"], "inv-new");
    expect(r.out).toMatch(/^CLAWBOX-WARN\[ap-not-restarted\]: .*still deactivating/m);
  });

  it("never calls the hotspot restarted without a record of the run it replaced", () => {
    const r = report(["active"], "inv-new", "none");
    expect(r.out).toMatch(/^CLAWBOX-WARN\[ap-not-restarted\]: .*unknown/m);
    expect(r.out).not.toContain("is back on");
  });

  it("reads a record with no trailing newline", () => {
    // `read` fails on it, but has read it: the old invocation still counts.
    const r = report(["active"], "inv-boot", "inv-boot", false);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[ap-not-restarted\]: .*previous run/m);
    expect(r.out).not.toContain("is back on");
  });

  it("warns when the queued restart never ran (the same invocation)", () => {
    const r = report(["active"], "inv-boot");
    expect(r.out).toMatch(/^CLAWBOX-WARN\[ap-not-restarted\]:/m);
  });

  it("is called by step_post_update", () => {
    expect(fn("step_post_update")).toContain("report_update_ap_restart");
  });
});

// ── 6. A warning the restart arm kept reaches the owner through post_update ──

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
